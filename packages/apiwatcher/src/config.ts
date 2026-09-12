import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Severity } from './changeset/types.js';
import { isApiVersion } from './changeset/version.js';

/** Per-repo config. Everything is optional; zero-config is the default path. */
export interface RepoConfig {
  /** Version to check against. `latest` means the newest changeset we know about. */
  target?: string | 'latest';
  /** Paths to skip, in addition to the built-in ignores. */
  ignorePaths?: string[];
  /** Change ids to suppress — the escape hatch for a false positive. */
  ignoreChanges?: string[];
  /** Whether the GitHub App should open issues for this repo. */
  alerts?: boolean;
  /** Severity that makes the CLI exit non-zero. */
  failOn?: Severity | 'never';
  /** Drop findings below this confidence. */
  minConfidence?: number;
}

export const CONFIG_FILENAMES = [
  '.apiwatcher.json',
  'apiwatcher.config.json',
  '.github/apiwatcher.json',
];

export const DEFAULT_CONFIG: Required<Pick<RepoConfig, 'target' | 'alerts' | 'failOn' | 'minConfidence'>> = {
  target: 'latest',
  alerts: true,
  failOn: 'breaking',
  minConfidence: 0.4,
};

export function findConfigFile(root: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Validate explicitly so a typo in config fails loudly instead of being ignored. */
export function validateConfig(raw: unknown, origin: string): RepoConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${origin}: config must be an object`);
  const cfg = raw as Record<string, unknown>;
  const out: RepoConfig = {};

  if (cfg.target !== undefined) {
    if (typeof cfg.target !== 'string' || (cfg.target !== 'latest' && !isApiVersion(cfg.target))) {
      throw new Error(`${origin}: "target" must be "latest" or a Stripe version like 2026-08-26.dahlia`);
    }
    out.target = cfg.target;
  }

  for (const key of ['ignorePaths', 'ignoreChanges'] as const) {
    const value = cfg[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new Error(`${origin}: "${key}" must be an array of strings`);
    }
    out[key] = value as string[];
  }

  if (cfg.alerts !== undefined) {
    if (typeof cfg.alerts !== 'boolean') throw new Error(`${origin}: "alerts" must be a boolean`);
    out.alerts = cfg.alerts;
  }

  if (cfg.failOn !== undefined) {
    const allowed = ['breaking', 'deprecating', 'additive', 'never'];
    if (typeof cfg.failOn !== 'string' || !allowed.includes(cfg.failOn)) {
      throw new Error(`${origin}: "failOn" must be one of ${allowed.join(', ')}`);
    }
    out.failOn = cfg.failOn as Severity | 'never';
  }

  if (cfg.minConfidence !== undefined) {
    if (typeof cfg.minConfidence !== 'number' || cfg.minConfidence < 0 || cfg.minConfidence > 1) {
      throw new Error(`${origin}: "minConfidence" must be a number between 0 and 1`);
    }
    out.minConfidence = cfg.minConfidence;
  }

  const known = new Set([
    'target',
    'ignorePaths',
    'ignoreChanges',
    'alerts',
    'failOn',
    'minConfidence',
    '$schema',
  ]);
  const unknown = Object.keys(cfg).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(`${origin}: unknown config key(s): ${unknown.join(', ')}`);
  }

  return out;
}

export async function loadConfig(root: string): Promise<{ config: RepoConfig; file: string | null }> {
  const file = findConfigFile(root);
  if (!file) return { config: {}, file: null };
  const text = await readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: invalid JSON (${(err as Error).message})`);
  }
  return { config: validateConfig(parsed, file), file };
}
