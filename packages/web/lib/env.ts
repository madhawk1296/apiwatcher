import { join } from "node:path";

/**
 * Runtime configuration. Read lazily so `next build` never needs the real
 * values — only the running server does.
 */
export function dataDir(): string {
  return process.env.DATA_DIR ?? join(process.cwd(), "..", "..", "data");
}

export function sqlitePath(): string {
  return join(dataDir(), "apiwatcher.sqlite");
}

export function changesetsDir(): string {
  return join(dataDir(), "changesets");
}

/** The scan server, on the same box. */
export function serverUrl(): string {
  return process.env.SERVER_URL ?? "http://127.0.0.1:8787";
}

export function adminToken(): string | null {
  return process.env.ADMIN_TOKEN ?? null;
}

export function appSlug(): string {
  return process.env.APP_SLUG ?? "apiwatcher-app";
}

export function publicUrl(): string {
  return process.env.AUTH_URL ?? "http://localhost:3000";
}
