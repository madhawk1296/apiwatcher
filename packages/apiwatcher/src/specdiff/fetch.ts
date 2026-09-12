import { readFile } from 'node:fs/promises';

import type { OpenApiSpec } from './openapi.js';

export const STRIPE_SPEC_REPO = 'stripe/openapi';
/** The `.sdk.` variant carries `x-stripeOperations`, which the plain spec omits. */
export const STRIPE_SPEC_PATH = 'openapi/spec3.sdk.json';

export interface SpecCommit {
  sha: string;
  date: string;
}

function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'apiwatcher-spec-watcher',
  };
  // Unauthenticated GitHub allows 60 requests/hour, which is plenty for a cron
  // but not for local iteration. Honour a token when one is present.
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function ghJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} ${res.statusText} for ${url}`);
  }
  return (await res.json()) as T;
}

/** Commits that touched the spec, newest first. */
export async function listSpecCommits(options: { perPage?: number; until?: string } = {}): Promise<
  SpecCommit[]
> {
  const params = new URLSearchParams({
    path: STRIPE_SPEC_PATH,
    per_page: String(options.perPage ?? 30),
  });
  if (options.until) params.set('until', options.until);

  const commits = await ghJson<Array<{ sha: string; commit: { committer: { date: string } } }>>(
    `https://api.github.com/repos/${STRIPE_SPEC_REPO}/commits?${params.toString()}`,
  );
  return commits.map((c) => ({ sha: c.sha, date: c.commit.committer.date }));
}

/**
 * Resolve a ref to the commit that last touched the spec.
 *
 * The watcher records where it stopped so the next run can diff forward from
 * there. Recording a branch name instead of a SHA would mean diffing a moving
 * target against itself and silently finding nothing, so always pin.
 */
export async function resolveSpecCommit(ref: string): Promise<string> {
  const params = new URLSearchParams({ path: STRIPE_SPEC_PATH, sha: ref, per_page: '1' });
  const commits = await ghJson<Array<{ sha: string }>>(
    `https://api.github.com/repos/${STRIPE_SPEC_REPO}/commits?${params.toString()}`,
  );
  const sha = commits[0]?.sha;
  if (!sha) throw new Error(`Could not resolve ${STRIPE_SPEC_REPO}@${ref} to a commit`);
  return sha;
}

/** Fetch the spec at a git ref. ~10MB, so callers should cache. */
export async function fetchSpecAt(ref: string): Promise<OpenApiSpec> {
  const url = `https://raw.githubusercontent.com/${STRIPE_SPEC_REPO}/${ref}/${STRIPE_SPEC_PATH}`;
  const res = await fetch(url, { headers: { 'user-agent': 'apiwatcher-spec-watcher' } });
  if (!res.ok) throw new Error(`Failed to fetch spec at ${ref}: ${res.status} ${res.statusText}`);
  return (await res.json()) as OpenApiSpec;
}

export async function readSpecFile(file: string): Promise<OpenApiSpec> {
  return JSON.parse(await readFile(file, 'utf8')) as OpenApiSpec;
}

/** `"2026-08-26.dahlia"` -> a safe filename segment. */
export function versionSlug(version: string): string {
  return version.replace(/[^a-z0-9.-]/gi, '_');
}

export function changesetFilename(from: string, to: string): string {
  return `${versionSlug(from)}__${versionSlug(to)}.json`;
}
