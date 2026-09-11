import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Changeset } from './types.js';
import { compareApiVersions } from './version.js';

/**
 * A tiny manifest of everything the spec watcher has published.
 *
 * The GitHub App reads only this file to learn whether a new Stripe version
 * exists, so the worker never has to download a 10MB spec or enumerate a
 * directory over the API.
 */
export interface ChangesetIndex {
  api: 'stripe';
  /** Newest `to` version across all changesets. */
  latest: string | null;
  generatedAt: string;
  entries: Array<{
    from: string;
    to: string;
    file: string;
    breaking: number;
    deprecating: number;
    additive: number;
    /** Spec commit this changeset ended at, so the watcher can diff forward. */
    toRef?: string;
  }>;
}

export function buildIndex(
  changesets: ReadonlyArray<{ changeset: Changeset; file: string }>,
): ChangesetIndex {
  const entries = changesets
    .map(({ changeset, file }) => {
      const count = (severity: string): number =>
        changeset.changes.filter((c) => c.severity === severity).length;
      return {
        from: changeset.from,
        to: changeset.to,
        file,
        breaking: count('breaking'),
        deprecating: count('deprecating'),
        additive: count('additive'),
        ...(changeset.source?.toRef ? { toRef: changeset.source.toRef } : {}),
      };
    })
    .sort((a, b) => compareApiVersions(a.to, b.to));

  const last = entries[entries.length - 1];
  return {
    api: 'stripe',
    latest: last?.to ?? null,
    generatedAt: new Date().toISOString(),
    entries,
  };
}

export async function writeIndex(index: ChangesetIndex, dir: string): Promise<string> {
  const target = resolve(dir);
  await mkdir(target, { recursive: true });
  const file = join(target, 'index.json');
  await writeFile(file, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return file;
}
