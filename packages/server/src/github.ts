import { createAppJwt } from './crypto.js';

/**
 * The slice of GitHub's REST API the server needs.
 *
 * A dozen endpoints; a hand-rolled client keeps dependencies at zero and the
 * permission footprint obvious at a glance.
 */

const API = 'https://api.github.com';
const UA = 'apiwatcher-server';

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`GitHub ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = 'GitHubError';
  }
}

async function request<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': UA,
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) throw new GitHubError(res.status, url, await res.text());
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface AppCredentials {
  appId: string;
  privateKey: string;
}

/**
 * Installation tokens last an hour. Cache them in memory, refreshed a few
 * minutes early so one cannot expire mid-scan.
 */
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

export async function getInstallationToken(creds: AppCredentials, installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;

  const jwt = await createAppJwt(creds.appId, creds.privateKey);
  const result = await request<{ token: string; expires_at: string }>(
    `${API}/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: 'POST' },
  );
  tokenCache.set(installationId, { token: result.token, expiresAt: Date.parse(result.expires_at) });
  return result.token;
}

/** Which installation covers a repo. Needed when a scan is requested by name. */
export async function getInstallationForRepo(creds: AppCredentials, ref: RepoRef): Promise<number | null> {
  const jwt = await createAppJwt(creds.appId, creds.privateKey);
  try {
    const body = await request<{ id: number }>(`${API}/repos/${ref.owner}/${ref.repo}/installation`, jwt);
    return body.id;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface RepoSummary {
  full_name: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
}

export async function getRepo(token: string, ref: RepoRef): Promise<RepoSummary> {
  return request<RepoSummary>(`${API}/repos/${ref.owner}/${ref.repo}`, token);
}

/** Resolve a branch to its current commit. */
export async function getBranchSha(token: string, ref: RepoRef, branch: string): Promise<string> {
  const body = await request<{ commit: { sha: string } }>(
    `${API}/repos/${ref.owner}/${ref.repo}/branches/${encodeURIComponent(branch)}`,
    token,
  );
  return body.commit.sha;
}

/**
 * Read a file at a ref. Returns null for 404 so callers can treat "no config"
 * and "no package.json" as ordinary outcomes rather than errors.
 */
export async function getFileContent(
  token: string,
  ref: RepoRef,
  path: string,
  gitRef?: string,
): Promise<string | null> {
  const query = gitRef ? `?ref=${encodeURIComponent(gitRef)}` : '';
  try {
    const body = await request<{ content?: string; encoding?: string }>(
      `${API}/repos/${ref.owner}/${ref.repo}/contents/${path}${query}`,
      token,
    );
    if (!body.content) return null;
    if (body.encoding !== 'base64') return body.content;
    return Buffer.from(body.content.replace(/\n/g, ''), 'base64').toString('utf8');
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

/** Files touched by a pull request, capped so a giant PR cannot stall us. */
export async function listPullRequestFiles(
  token: string,
  ref: RepoRef,
  number: number,
  maxPages = 5,
): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const files = await request<Array<{ filename: string; previous_filename?: string }>>(
      `${API}/repos/${ref.owner}/${ref.repo}/pulls/${number}/files?per_page=100&page=${page}`,
      token,
    );
    for (const f of files) {
      out.push(f.filename);
      if (f.previous_filename) out.push(f.previous_filename);
    }
    if (files.length < 100) break;
  }
  return out;
}

// --- check runs -------------------------------------------------------------

export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'action_required';

export interface CheckRunInput {
  name: string;
  head_sha: string;
  status?: 'queued' | 'in_progress' | 'completed';
  conclusion?: CheckConclusion;
  details_url?: string;
  external_id?: string;
  output?: { title: string; summary: string; text?: string };
}

export async function createCheckRun(token: string, ref: RepoRef, input: CheckRunInput): Promise<number> {
  const body = await request<{ id: number }>(`${API}/repos/${ref.owner}/${ref.repo}/check-runs`, token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return body.id;
}

export async function updateCheckRun(
  token: string,
  ref: RepoRef,
  id: number,
  patch: Partial<CheckRunInput>,
): Promise<void> {
  await request<unknown>(`${API}/repos/${ref.owner}/${ref.repo}/check-runs/${id}`, token, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// --- issues -----------------------------------------------------------------

export interface IssueRef {
  number: number;
  title: string;
  state: string;
  html_url: string;
}

export async function findOpenIssueByLabel(token: string, ref: RepoRef, label: string): Promise<IssueRef | null> {
  const issues = await request<IssueRef[]>(
    `${API}/repos/${ref.owner}/${ref.repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`,
    token,
  );
  return issues[0] ?? null;
}

export async function ensureLabel(
  token: string,
  ref: RepoRef,
  label: { name: string; description: string; color: string },
): Promise<void> {
  try {
    await request<unknown>(`${API}/repos/${ref.owner}/${ref.repo}/labels/${encodeURIComponent(label.name)}`, token);
  } catch (err) {
    if (!(err instanceof GitHubError) || err.status !== 404) throw err;
    await request<unknown>(`${API}/repos/${ref.owner}/${ref.repo}/labels`, token, {
      method: 'POST',
      body: JSON.stringify(label),
    });
  }
}

export async function createIssue(
  token: string,
  ref: RepoRef,
  issue: { title: string; body: string; labels?: string[] },
): Promise<IssueRef> {
  return request<IssueRef>(`${API}/repos/${ref.owner}/${ref.repo}/issues`, token, {
    method: 'POST',
    body: JSON.stringify(issue),
  });
}

export async function updateIssue(
  token: string,
  ref: RepoRef,
  number: number,
  patch: { title?: string; body?: string; state?: 'open' | 'closed' },
): Promise<void> {
  await request<unknown>(`${API}/repos/${ref.owner}/${ref.repo}/issues/${number}`, token, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function commentOnIssue(token: string, ref: RepoRef, number: number, body: string): Promise<void> {
  await request<unknown>(`${API}/repos/${ref.owner}/${ref.repo}/issues/${number}/comments`, token, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

// --- installations ----------------------------------------------------------

export async function listInstallationRepos(token: string): Promise<RepoSummary[]> {
  const out: RepoSummary[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = await request<{ repositories: RepoSummary[] }>(
      `${API}/installation/repositories?per_page=100&page=${page}`,
      token,
    );
    out.push(...body.repositories);
    if (body.repositories.length < 100) break;
  }
  return out;
}

export function parseFullName(fullName: string): RepoRef | null {
  const [owner, repo] = fullName.split('/');
  return owner && repo ? { owner, repo } : null;
}
