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
`;

type Row = Record<string, unknown>;

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
