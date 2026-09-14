import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Everything the server needs from its environment, validated once at boot.
 *
 * Fail loudly at startup rather than on the first webhook: a missing secret
 * discovered at 3am by a 500 to GitHub is the worst way to learn about it.
 */
export interface Config {
  port: number;
  /** Interface to listen on. Caddy proxies from localhost; nothing else should reach the port. */
  host: string;
  /** Where SQLite, cloned repos, and synced changesets live. */
  dataDir: string;
  appId: string;
  appPrivateKey: string;
  webhookSecret: string;
  /** Gates /admin/*. Absent means admin routes are disabled. */
  adminToken: string | null;
  /** Parallel scans. Two is plenty for a small box; clones are I/O bound. */
  scanConcurrency: number;
  /** Where the spec watcher publishes changesets. */
  changesetIndexUrl: string;
  /** How often to look for a new Stripe version, in minutes. */
  pollIntervalMinutes: number;
  /** Drop stored reports older than this. Summaries are kept. */
  reportRetentionDays: number;
  /** The GitHub App slug, for links in issues. */
  appSlug: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

/**
 * The private key can be given inline or as a file path. The file form is
 * what a systemd unit will use; inline is convenient for local runs.
 */
function privateKey(): string {
  const file = process.env.APP_PRIVATE_KEY_FILE;
  if (file && file.trim() !== '') {
    const path = resolve(file);
    if (!existsSync(path)) throw new Error(`APP_PRIVATE_KEY_FILE points at ${path}, which does not exist`);
    return readFileSync(path, 'utf8');
  }
  // Allow the PEM's newlines to arrive as literal "\n" from a .env file.
  return required('APP_PRIVATE_KEY').replace(/\\n/g, '\n');
}

export function loadConfig(): Config {
  return {
    port: integer('PORT', 8787),
    host: optional('HOST', '127.0.0.1'),
    dataDir: resolve(optional('DATA_DIR', './data')),
    appId: required('APP_ID'),
    appPrivateKey: privateKey(),
    webhookSecret: required('WEBHOOK_SECRET'),
    adminToken: optional('ADMIN_TOKEN', '') || null,
    scanConcurrency: integer('SCAN_CONCURRENCY', 2),
    changesetIndexUrl: optional(
      'CHANGESET_INDEX_URL',
      'https://raw.githubusercontent.com/madhawk1296/apiwatcher/main/changesets/stripe/index.json',
    ),
    pollIntervalMinutes: integer('POLL_INTERVAL_MINUTES', 60),
    reportRetentionDays: integer('REPORT_RETENTION_DAYS', 30),
    appSlug: optional('APP_SLUG', 'apiwatcher-app'),
  };
}
