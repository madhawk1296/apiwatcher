import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite, one file, no ORM.
 *
 * The whole state of the service is the repo index plus a history of scans.
 * Both fit comfortably in a single-writer database; the built-in driver means
 * no native dependency to compile on the box.
 */

export interface RepoRecord {
  fullName: string;
  installationId: number;
  defaultBranch: string;
  private: boolean;
  stripeRange: string | null;
  /** Pinned API version, learned from the most recent scan. */
  apiVersion: string | null;
  /** Target from the repo's config; `latest` when unset. */
  target: string;
  alerts: boolean;
  scanOnPush: boolean;
  lastAlertedVersion: string | null;
  updatedAt: string;
}

export type ScanTrigger = 'push' | 'pull_request' | 'new_version' | 'manual' | 'backfill';

export interface ScanRecord {
  id: number;
  fullName: string;
  sha: string;
  trigger: ScanTrigger;
  targetVersion: string;
  currentVersion: string | null;
  breaking: number;
  deprecating: number;
  additive: number;
  filesScanned: number;
  /** Full report JSON; pruned after the retention window. */
  reportJson: string | null;
  error: string | null;
  createdAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  full_name            TEXT PRIMARY KEY,
  installation_id      INTEGER NOT NULL,
  default_branch       TEXT NOT NULL,
  private              INTEGER NOT NULL,
  stripe_range         TEXT,
  api_version          TEXT,
  target               TEXT NOT NULL DEFAULT 'latest',
  alerts               INTEGER NOT NULL DEFAULT 1,
  scan_on_push         INTEGER NOT NULL DEFAULT 1,
  last_alerted_version TEXT,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS repos_installation ON repos(installation_id);

CREATE TABLE IF NOT EXISTS scans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name       TEXT NOT NULL,
  sha             TEXT NOT NULL,
  trigger         TEXT NOT NULL,
  target_version  TEXT NOT NULL,
  current_version TEXT,
  breaking        INTEGER NOT NULL DEFAULT 0,
  deprecating     INTEGER NOT NULL DEFAULT 0,
  additive        INTEGER NOT NULL DEFAULT 0,
  files_scanned   INTEGER NOT NULL DEFAULT 0,
  report_json     TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scans_repo_time ON scans(full_name, created_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Dashboard users. Identity is GitHub's; we keep what the UI and the digest need.
CREATE TABLE IF NOT EXISTS users (
  github_id     INTEGER PRIMARY KEY,
  login         TEXT NOT NULL,
  name          TEXT,
  email         TEXT,
  avatar_url    TEXT,
  created_at    TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

-- Which installations a user may see; refreshed on every sign-in from GitHub.
CREATE TABLE IF NOT EXISTS user_installations (
  github_id       INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  account_login   TEXT NOT NULL,
  refreshed_at    TEXT NOT NULL,
  PRIMARY KEY (github_id, installation_id)
);

CREATE TABLE IF NOT EXISTS notification_prefs (
  github_id     INTEGER PRIMARY KEY,
  email         TEXT,
  notify_on     TEXT NOT NULL DEFAULT 'breaking',
  slack_webhook TEXT,
  updated_at    TEXT NOT NULL
);

-- One digest per (version, installation); a retry cannot send it twice.
CREATE TABLE IF NOT EXISTS digests_sent (
  version         TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  sent_at         TEXT NOT NULL,
  recipients      INTEGER NOT NULL,
  PRIMARY KEY (version, installation_id)
);
`;

export interface UserRecord {
  githubId: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string;
}

export type NotifyOn = 'breaking' | 'deprecating' | 'never';

export interface NotificationPrefs {
  githubId: number;
  email: string | null;
  notifyOn: NotifyOn;
  slackWebhook: string | null;
}

type Row = Record<string, unknown>;

function toUser(row: Row): UserRecord {
  return {
    githubId: row.github_id as number,
    login: row.login as string,
    name: (row.name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    createdAt: row.created_at as string,
    lastLoginAt: row.last_login_at as string,
  };
}

function toPrefs(row: Row): NotificationPrefs {
  return {
    githubId: row.github_id as number,
    email: (row.email as string | null) ?? null,
    notifyOn: row.notify_on as NotifyOn,
    slackWebhook: (row.slack_webhook as string | null) ?? null,
  };
}

function toRepo(row: Row): RepoRecord {
  return {
    fullName: row.full_name as string,
    installationId: row.installation_id as number,
    defaultBranch: row.default_branch as string,
    private: row.private === 1,
    stripeRange: (row.stripe_range as string | null) ?? null,
    apiVersion: (row.api_version as string | null) ?? null,
    target: row.target as string,
    alerts: row.alerts === 1,
    scanOnPush: row.scan_on_push === 1,
    lastAlertedVersion: (row.last_alerted_version as string | null) ?? null,
    updatedAt: row.updated_at as string,
  };
}

function toScan(row: Row): ScanRecord {
  return {
    id: row.id as number,
    fullName: row.full_name as string,
    sha: row.sha as string,
    trigger: row.trigger as ScanTrigger,
    targetVersion: row.target_version as string,
    currentVersion: (row.current_version as string | null) ?? null,
    breaking: row.breaking as number,
    deprecating: row.deprecating as number,
    additive: row.additive as number,
    filesScanned: row.files_scanned as number,
    reportJson: (row.report_json as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL lets the HTTP handler read while a scan writes.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- repos ------------------------------------------------------------------

  putRepo(record: Omit<RepoRecord, 'updatedAt'> & { updatedAt?: string }): void {
    this.db
      .prepare(
        `INSERT INTO repos (full_name, installation_id, default_branch, private, stripe_range, api_version,
                            target, alerts, scan_on_push, last_alerted_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(full_name) DO UPDATE SET
           installation_id = excluded.installation_id,
           default_branch = excluded.default_branch,
           private = excluded.private,
           stripe_range = excluded.stripe_range,
           api_version = COALESCE(excluded.api_version, repos.api_version),
           target = excluded.target,
           alerts = excluded.alerts,
           scan_on_push = excluded.scan_on_push,
           last_alerted_version = COALESCE(excluded.last_alerted_version, repos.last_alerted_version),
           updated_at = excluded.updated_at`,
      )
      .run(
        record.fullName,
        record.installationId,
        record.defaultBranch,
        record.private ? 1 : 0,
        record.stripeRange,
        record.apiVersion,
        record.target,
        record.alerts ? 1 : 0,
        record.scanOnPush ? 1 : 0,
        record.lastAlertedVersion,
        record.updatedAt ?? new Date().toISOString(),
      );
  }

  getRepo(fullName: string): RepoRecord | null {
    const row = this.db.prepare('SELECT * FROM repos WHERE full_name = ? COLLATE NOCASE').get(fullName) as
      | Row
      | undefined;
    return row ? toRepo(row) : null;
  }

  listRepos(): RepoRecord[] {
    return (this.db.prepare('SELECT * FROM repos ORDER BY full_name').all() as Row[]).map(toRepo);
  }

  deleteRepo(fullName: string): void {
    this.db.prepare('DELETE FROM repos WHERE full_name = ? COLLATE NOCASE').run(fullName);
  }

  deleteInstallation(installationId: number): number {
    const result = this.db.prepare('DELETE FROM repos WHERE installation_id = ?').run(installationId);
    return Number(result.changes);
  }

  /** What the last scan told us about the repo's pinned version. */
  setRepoApiVersion(fullName: string, apiVersion: string | null): void {
    this.db
      .prepare('UPDATE repos SET api_version = ?, updated_at = ? WHERE full_name = ? COLLATE NOCASE')
      .run(apiVersion, new Date().toISOString(), fullName);
  }

  setLastAlerted(fullName: string, version: string): void {
    this.db
      .prepare('UPDATE repos SET last_alerted_version = ?, updated_at = ? WHERE full_name = ? COLLATE NOCASE')
      .run(version, new Date().toISOString(), fullName);
  }

  // --- scans ------------------------------------------------------------------

  recordScan(scan: Omit<ScanRecord, 'id' | 'createdAt'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO scans (full_name, sha, trigger, target_version, current_version, breaking, deprecating,
                            additive, files_scanned, report_json, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scan.fullName,
        scan.sha,
        scan.trigger,
        scan.targetVersion,
        scan.currentVersion,
        scan.breaking,
        scan.deprecating,
        scan.additive,
        scan.filesScanned,
        scan.reportJson,
        scan.error,
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  latestScan(fullName: string): ScanRecord | null {
    const row = this.db
      .prepare('SELECT * FROM scans WHERE full_name = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1')
      .get(fullName) as Row | undefined;
    return row ? toScan(row) : null;
  }

  recentScans(limit = 50): ScanRecord[] {
    return (
      this.db
        .prepare(
          `SELECT id, full_name, sha, trigger, target_version, current_version, breaking, deprecating, additive,
                  files_scanned, NULL AS report_json, error, created_at
           FROM scans ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as Row[]
    ).map(toScan);
  }

  getScan(id: number): ScanRecord | null {
    const row = this.db.prepare('SELECT * FROM scans WHERE id = ?').get(id) as Row | undefined;
    return row ? toScan(row) : null;
  }

  /** Drop stored report bodies past the retention window; the summary row stays. */
  pruneReports(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const result = this.db
      .prepare('UPDATE scans SET report_json = NULL WHERE report_json IS NOT NULL AND created_at < ?')
      .run(cutoff);
    return Number(result.changes);
  }

  // --- users / dashboard --------------------------------------------------------

  upsertUser(user: { githubId: number; login: string; name: string | null; email: string | null; avatarUrl: string | null }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO users (github_id, login, name, email, avatar_url, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET
           login = excluded.login, name = excluded.name,
           email = COALESCE(excluded.email, users.email),
           avatar_url = excluded.avatar_url, last_login_at = excluded.last_login_at`,
      )
      .run(user.githubId, user.login, user.name, user.email, user.avatarUrl, now, now);
  }

  getUser(githubId: number): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as Row | undefined;
    return row ? toUser(row) : null;
  }

  /** Replace the user's installation list with what GitHub says today. */
  setUserInstallations(githubId: number, installations: Array<{ id: number; accountLogin: string }>): void {
    const now = new Date().toISOString();
    const del = this.db.prepare('DELETE FROM user_installations WHERE github_id = ?');
    const ins = this.db.prepare(
      'INSERT INTO user_installations (github_id, installation_id, account_login, refreshed_at) VALUES (?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      del.run(githubId);
      for (const i of installations) ins.run(githubId, i.id, i.accountLogin, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  userInstallations(githubId: number): Array<{ installationId: number; accountLogin: string }> {
    return (
      this.db
        .prepare('SELECT installation_id, account_login FROM user_installations WHERE github_id = ? ORDER BY account_login')
        .all(githubId) as Row[]
    ).map((r) => ({ installationId: r.installation_id as number, accountLogin: r.account_login as string }));
  }

  /** Repos across every installation the user can see. */
  reposForUser(githubId: number): RepoRecord[] {
    return (
      this.db
        .prepare(
          `SELECT r.* FROM repos r
           JOIN user_installations ui ON ui.installation_id = r.installation_id
           WHERE ui.github_id = ? ORDER BY r.full_name`,
        )
        .all(githubId) as Row[]
    ).map(toRepo);
  }

  userCanSeeRepo(githubId: number, fullName: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM repos r JOIN user_installations ui ON ui.installation_id = r.installation_id
         WHERE ui.github_id = ? AND r.full_name = ? COLLATE NOCASE LIMIT 1`,
      )
      .get(githubId, fullName);
    return row !== undefined;
  }

  /** Latest scan per repo, for a list view. Report bodies are not included. */
  latestScansFor(fullNames: readonly string[]): Map<string, ScanRecord> {
    const out = new Map<string, ScanRecord>();
    const stmt = this.db.prepare(
      `SELECT id, full_name, sha, trigger, target_version, current_version, breaking, deprecating, additive,
              files_scanned, NULL AS report_json, error, created_at
       FROM scans WHERE full_name = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1`,
    );
    for (const name of fullNames) {
      const row = stmt.get(name) as Row | undefined;
      if (row) out.set(name.toLowerCase(), toScan(row));
    }
    return out;
  }

  scansForRepo(fullName: string, limit = 20): ScanRecord[] {
    return (
      this.db
        .prepare(
          `SELECT id, full_name, sha, trigger, target_version, current_version, breaking, deprecating, additive,
                  files_scanned, NULL AS report_json, error, created_at
           FROM scans WHERE full_name = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT ?`,
        )
        .all(fullName, limit) as Row[]
    ).map(toScan);
  }

  getPrefs(githubId: number): NotificationPrefs | null {
    const row = this.db.prepare('SELECT * FROM notification_prefs WHERE github_id = ?').get(githubId) as Row | undefined;
    return row ? toPrefs(row) : null;
  }

  setPrefs(prefs: NotificationPrefs): void {
    this.db
      .prepare(
        `INSERT INTO notification_prefs (github_id, email, notify_on, slack_webhook, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET
           email = excluded.email, notify_on = excluded.notify_on,
           slack_webhook = excluded.slack_webhook, updated_at = excluded.updated_at`,
      )
      .run(prefs.githubId, prefs.email, prefs.notifyOn, prefs.slackWebhook, new Date().toISOString());
  }

  /** Everyone who wants to hear about a version for repos in this installation. */
  digestRecipients(installationId: number): Array<NotificationPrefs & { login: string }> {
    return (
      this.db
        .prepare(
          `SELECT p.*, u.login FROM notification_prefs p
           JOIN users u ON u.github_id = p.github_id
           JOIN user_installations ui ON ui.github_id = p.github_id
           WHERE ui.installation_id = ? AND p.notify_on != 'never'`,
        )
        .all(installationId) as Row[]
    ).map((r) => ({ ...toPrefs(r), login: r.login as string }));
  }

  digestAlreadySent(version: string, installationId: number): boolean {
    return (
      this.db.prepare('SELECT 1 FROM digests_sent WHERE version = ? AND installation_id = ?').get(version, installationId) !==
      undefined
    );
  }

  markDigestSent(version: string, installationId: number, recipients: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO digests_sent (version, installation_id, sent_at, recipients) VALUES (?, ?, ?, ?)')
      .run(version, installationId, new Date().toISOString(), recipients);
  }

  /** Scans for a version fan-out, grouped so a digest can be assembled per installation. */
  versionScansByInstallation(version: string): Map<number, ScanRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.full_name, s.sha, s.trigger, s.target_version, s.current_version, s.breaking, s.deprecating,
                s.additive, s.files_scanned, NULL AS report_json, s.error, s.created_at, r.installation_id
         FROM scans s JOIN repos r ON r.full_name = s.full_name
         WHERE s.trigger = 'new_version' AND s.target_version = ?
         ORDER BY s.created_at DESC`,
      )
      .all(version) as Row[];
    const out = new Map<number, ScanRecord[]>();
    const seen = new Set<string>();
    for (const row of rows) {
      const key = (row.full_name as string).toLowerCase();
      if (seen.has(key)) continue; // newest scan per repo only
      seen.add(key);
      const inst = row.installation_id as number;
      const list = out.get(inst) ?? [];
      list.push(toScan(row));
      out.set(inst, list);
    }
    return out;
  }

  // --- meta -------------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return row ? (row.value as string) : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}
