#!/usr/bin/env node
/**
 * Copy the published data artefacts into the package before packing.
 *
 * Changesets live at the repo root because they are the project's public data —
 * the spec watcher commits there and the changelog site will read from there —
 * but `npx apimigrate` has to carry them, since a scan must work with no network
 * and no account. `defaultChangesetDir()` walks up from the compiled module, so a
 * copy at the package root is what it finds once installed.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pkgRoot = join(repoRoot, 'packages', 'apimigrate');

const source = join(repoRoot, 'changesets');
const target = join(pkgRoot, 'changesets');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(source))) {
  console.error(`No changesets at ${source}. Run \`apimigrate spec-diff\` first.`);
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
console.log(`Staged changesets -> ${target}`);
