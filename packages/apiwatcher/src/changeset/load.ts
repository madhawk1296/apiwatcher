import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Changeset, SpecChange } from './types.js';
import { SCHEMA_VERSION } from './types.js';
import { compareApiVersions, isApiVersion } from './version.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Changesets ship inside the package, but during development they live at the
 * repo root. Walk up until we find a `changesets/` directory so both work.
 */
export function defaultChangesetDir(): string {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'changesets');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate a changesets/ directory. Pass --changesets <dir>.');
}

/** Narrow, explicit validation. A malformed changeset should fail loudly at load. */
export function validateChangeset(raw: unknown, origin: string): Changeset {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${origin}: changeset is not an object`);
  }
  const cs = raw as Partial<Changeset>;
  if (cs.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `${origin}: unsupported schemaVersion ${String(cs.schemaVersion)} (this build reads ${SCHEMA_VERSION})`,
    );
  }
  if (cs.api !== 'stripe') throw new Error(`${origin}: unsupported api ${String(cs.api)}`);
  for (const key of ['from', 'to'] as const) {
    const v = cs[key];
    if (typeof v !== 'string' || !isApiVersion(v)) {
      throw new Error(`${origin}: invalid "${key}" version: ${String(v)}`);
    }
  }
  if (!Array.isArray(cs.changes)) throw new Error(`${origin}: "changes" must be an array`);

  const seen = new Set<string>();
  for (const ch of cs.changes as SpecChange[]) {
    if (!ch || typeof ch.id !== 'string' || ch.id === '') {
      throw new Error(`${origin}: a change is missing an id`);
    }
    if (seen.has(ch.id)) throw new Error(`${origin}: duplicate change id ${ch.id}`);
    seen.add(ch.id);
    if (typeof ch.note !== 'string' || ch.note === '') {
      throw new Error(`${origin}: change ${ch.id} is missing a note`);
    }
  }
  return cs as Changeset;
}

export async function loadChangeset(file: string): Promise<Changeset> {
  const text = await readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: invalid JSON (${(err as Error).message})`);
  }
  return validateChangeset(parsed, file);
}

/** Files that live beside changesets but are not changesets. */
const NON_CHANGESET_FILES = new Set(['index.json']);

/** Every changeset for one API, oldest `to` version first. */
export async function loadChangesets(dir?: string, api = 'stripe'): Promise<Changeset[]> {
  const root = resolve(dir ?? defaultChangesetDir(), api);
  if (!existsSync(root)) return [];
  const names = (await readdir(root)).filter(
    (n) => n.endsWith('.json') && !NON_CHANGESET_FILES.has(n),
  );
  const sets = await Promise.all(names.map((n) => loadChangeset(join(root, n))));
  return sets.sort((a, b) => compareApiVersions(a.to, b.to));
}

/**
 * Flatten every change that sits strictly after `from` and at or before `to`.
 *
 * Changesets are per-version-pair, so upgrading across three releases means
 * unioning three changesets. Ids are globally unique, which makes dedupe free.
 */
export function changesBetween(sets: Changeset[], from: string, to: string): SpecChange[] {
  const out: SpecChange[] = [];
  const seen = new Set<string>();
  for (const cs of sets) {
    // Include a changeset when its window overlaps (from, to].
    if (compareApiVersions(cs.to, from) <= 0) continue;
    if (compareApiVersions(cs.from, to) >= 0) continue;
    for (const ch of cs.changes) {
      if (seen.has(ch.id)) continue;
      seen.add(ch.id);
      out.push(ch);
    }
  }
  return out;
}

/**
 * The oldest version any changeset starts from — the edge of what we can see.
 *
 * A repo pinned before this has changes between its version and here that no
 * changeset covers. Reporting "nothing affected" for it would be a lie of
 * omission, so callers surface this as the report's coverage floor.
 */
export function oldestCoveredVersion(sets: Changeset[]): string | null {
  let oldest: string | null = null;
  for (const cs of sets) {
    if (oldest === null || compareApiVersions(cs.from, oldest) < 0) oldest = cs.from;
  }
  return oldest;
}

/** The newest `to` version across all known changesets — i.e. "latest we know about". */
export function latestKnownVersion(sets: Changeset[]): string | null {
  let latest: string | null = null;
  for (const cs of sets) {
    if (latest === null || compareApiVersions(cs.to, latest) > 0) latest = cs.to;
  }
  return latest;
}
