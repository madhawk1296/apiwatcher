/**
 * The install index.
 *
 * This is what makes the new-version alert cheap and quiet: when a Stripe
 * version lands we consult the index instead of scanning every installation, and
 * only repos that actually use Stripe at an older version get touched. Repos
 * that are unaffected never hear from us.
 */

export interface RepoRecord {
  /** `owner/repo`. */
  fullName: string;
  installationId: number;
  defaultBranch: string;
  private: boolean;
  /** Declared `stripe` range from package.json, if any. */
  stripeRange?: string;
  /** Pinned API version, if the repo's config or client sets one. */
  apiVersion?: string;
  /** Target from the repo's apimigrate config; `latest` when unset. */
  target: string;
  /** Whether this repo wants new-version issues. */
  alerts: boolean;
  /** Last version we alerted about, so we do not repeat ourselves. */
  lastAlertedVersion?: string;
  updatedAt: string;
}

const REPO_PREFIX = 'repo:';
const LAST_VERSION_KEY = 'meta:lastKnownVersion';

export interface Env {
  STATE: KVNamespace;
  APP_ID: string;
  APP_PRIVATE_KEY: string;
  WEBHOOK_SECRET: string;
  /** Optional shared secret guarding the admin endpoints. */
  ADMIN_TOKEN?: string;
}

function repoKey(fullName: string): string {
  return `${REPO_PREFIX}${fullName.toLowerCase()}`;
}

export async function putRepo(env: Env, record: RepoRecord): Promise<void> {
  await env.STATE.put(repoKey(record.fullName), JSON.stringify(record));
}

export async function getRepoRecord(env: Env, fullName: string): Promise<RepoRecord | null> {
  return env.STATE.get<RepoRecord>(repoKey(fullName), 'json');
}

export async function deleteRepo(env: Env, fullName: string): Promise<void> {
  await env.STATE.delete(repoKey(fullName));
}

/** Drop every repo belonging to an installation, e.g. on uninstall. */
export async function deleteInstallation(env: Env, installationId: number): Promise<number> {
  let removed = 0;
  for await (const record of iterateRepos(env)) {
    if (record.installationId !== installationId) continue;
    await deleteRepo(env, record.fullName);
    removed += 1;
  }
  return removed;
}

/** Walk the whole index. KV lists 1000 keys per page. */
export async function* iterateRepos(env: Env): AsyncGenerator<RepoRecord> {
  let cursor: string | undefined;
  for (;;) {
    const page = await env.STATE.list({ prefix: REPO_PREFIX, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      const record = await env.STATE.get<RepoRecord>(key.name, 'json');
      if (record) yield record;
    }
    if (page.list_complete) return;
    cursor = page.cursor;
  }
}

export async function getLastKnownVersion(env: Env): Promise<string | null> {
  return env.STATE.get(LAST_VERSION_KEY, 'text');
}

export async function setLastKnownVersion(env: Env, version: string): Promise<void> {
  await env.STATE.put(LAST_VERSION_KEY, version);
}
