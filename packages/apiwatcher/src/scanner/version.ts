import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { DetectedVersion } from './types.js';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function rangeFrom(pkg: PackageJson): string | null {
  for (const section of [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ]) {
    const range = section?.stripe;
    if (typeof range === 'string') return range;
  }
  return null;
}

async function readManifest(file: string): Promise<PackageJson | null> {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * The declared `stripe` range, from the root manifest or any workspace package.
 *
 * Monorepos usually declare Stripe in one package rather than at the root, so
 * checking only the root would report "no Stripe dependency" for a repo that
 * plainly has one — and that flag feeds every confidence score.
 */
export async function readStripeRange(root: string): Promise<string | null> {
  const rootPkg = await readManifest(join(root, 'package.json'));
  if (rootPkg) {
    const direct = rangeFrom(rootPkg);
    if (direct) return direct;
  }

  const { loadWorkspacePackages } = await import('./paths.js');
  const workspaces = await loadWorkspacePackages(root);
  for (const dir of workspaces.values()) {
    const pkg = await readManifest(join(root, dir, 'package.json'));
    const range = pkg ? rangeFrom(pkg) : null;
    if (range) return range;
  }
  return null;
}

/**
 * Exact installed version, preferring the lockfile over node_modules so the scan
 * works in CI before `npm install` runs.
 */
export async function readInstalledStripeVersion(root: string): Promise<string | null> {
  const fromLock = await readFromNpmLock(root);
  if (fromLock) return fromLock;

  const fromYarn = await readFromYarnLock(root);
  if (fromYarn) return fromYarn;

  const fromPnpm = await readFromPnpmLock(root);
  if (fromPnpm) return fromPnpm;

  const installed = join(root, 'node_modules', 'stripe', 'package.json');
  if (existsSync(installed)) {
    try {
      return (JSON.parse(await readFile(installed, 'utf8')) as { version?: string }).version ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

async function readFromNpmLock(root: string): Promise<string | null> {
  const file = join(root, 'package-lock.json');
  if (!existsSync(file)) return null;
  try {
    const lock = JSON.parse(await readFile(file, 'utf8')) as {
      packages?: Record<string, { version?: string }>;
      dependencies?: Record<string, { version?: string }>;
    };
    const v1 = lock.packages?.['node_modules/stripe']?.version;
    if (v1) return v1;
    return lock.dependencies?.stripe?.version ?? null;
  } catch {
    return null;
  }
}

async function readFromYarnLock(root: string): Promise<string | null> {
  const file = join(root, 'yarn.lock');
  if (!existsSync(file)) return null;
  try {
    const text = await readFile(file, 'utf8');
    // Classic: `stripe@^18.0.0:\n  version "18.2.1"`. Berry: `"stripe@npm:^18.0.0":`.
    const m = /^"?stripe@[^\n]*:\n(?:\s+[^\n]*\n)*?\s+version:?\s+"?([0-9][^"\s]*)"?/m.exec(text);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readFromPnpmLock(root: string): Promise<string | null> {
  const file = join(root, 'pnpm-lock.yaml');
  if (!existsSync(file)) return null;
  try {
    const text = await readFile(file, 'utf8');
    const m = /^\s+stripe:\n(?:\s+[^\n]*\n)*?\s+version:\s+([0-9][^\s(]*)/m.exec(text);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The API version the installed SDK pins by default.
 *
 * stripe-node hardcodes this in `apiVersion.js`; when a repo does not pass
 * `apiVersion` explicitly, this is the version their calls actually run against.
 */
export async function readSdkDefaultApiVersion(root: string): Promise<string | null> {
  for (const candidate of [
    join(root, 'node_modules', 'stripe', 'cjs', 'apiVersion.js'),
    join(root, 'node_modules', 'stripe', 'esm', 'apiVersion.js'),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      const text = await readFile(candidate, 'utf8');
      const m = /ApiVersion\s*=\s*['"]([^'"]+)['"]/.exec(text);
      if (m?.[1]) return m[1];
    } catch {
      // fall through
    }
  }
  return null;
}

export async function detectVersion(root: string): Promise<DetectedVersion> {
  const [sdkRange, sdkInstalled, sdkDefaultApiVersion] = await Promise.all([
    readStripeRange(root),
    readInstalledStripeVersion(root),
    readSdkDefaultApiVersion(root),
  ]);
  return {
    ...(sdkRange ? { sdkRange } : {}),
    ...(sdkInstalled ? { sdkInstalled } : {}),
    ...(sdkDefaultApiVersion ? { sdkDefaultApiVersion } : {}),
  };
}
