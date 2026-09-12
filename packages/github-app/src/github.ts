import { createAppJwt } from './crypto.js';

/**
 * The slice of GitHub's REST API this app needs.
 *
 * Octokit would work, but the app touches six endpoints and a hand-rolled client
 * keeps the worker dependency-free and the permissions obvious at a glance.
 */

const API = 'https://api.github.com';
const UA = 'apiwatcher-github-app';

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

async function request<T>(
  url: string,
  token: string,
  init: RequestInit & { tokenType?: 'Bearer' | 'token' } = {},
): Promise<T> {
  const { tokenType = 'Bearer', ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': UA,
      authorization: `${tokenType} ${token}`,
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) throw new GitHubError(res.status, url, await res.text());
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface InstallationToken {
  token: string;
  expires_at: string;
}

/**
 * Installation tokens last an hour; cache them in KV so a burst of webhooks does
 * not mint one per request.
 */
export async function getInstallationToken(
  env: { APP_ID: string; APP_PRIVATE_KEY: string; STATE: KVNamespace },
  installationId: number,
): Promise<string> {
  const cacheKey = `token:${installationId}`;
  const cached = await env.STATE.get<{ token: string; expiresAt: number }>(cacheKey, 'json');
  // Refresh a few minutes early so a token cannot expire mid-request.
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;

  const jwt = await createAppJwt(env.APP_ID, env.APP_PRIVATE_KEY);
  const result = await request<InstallationToken>(
    `${API}/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: 'POST' },
  );

  const expiresAt = Date.parse(result.expires_at);
  await env.STATE.put(cacheKey, JSON.stringify({ token: result.token, expiresAt }), {
    expirationTtl: 3600,
  });
  return result.token;
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
    const binary = atob(body.content.replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Ask the repo's own workflow to run a scan.
 *
 * Deliberately a `repository_dispatch`: the scan then runs on the customer's
 * runner with their token, so this app never needs to clone their code and the
 * compute costs us nothing.
 */
export async function dispatchScan(
  token: string,
  ref: RepoRef,
  payload: { targetVersion: string; reason: string },
): Promise<void> {
  await request<void>(`${API}/repos/${ref.owner}/${ref.repo}/dispatches`, token, {
    method: 'POST',
    body: JSON.stringify({ event_type: 'apiwatcher-scan', client_payload: payload }),
  });
}

export interface IssueRef {
  number: number;
  title: string;
  state: string;
  html_url: string;
}

/** Find an open issue this app previously opened, by its marker label. */
export async function findOpenIssueByLabel(
  token: string,
  ref: RepoRef,
  label: string,
): Promise<IssueRef | null> {
  const issues = await request<IssueRef[]>(
    `${API}/repos/${ref.owner}/${ref.repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`,
    token,
  );
  return issues[0] ?? null;
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

export interface InstallationRepos {
  repositories: RepoSummary[];
}

/** Every repo an installation can see, paginated. */
export async function listInstallationRepos(token: string): Promise<RepoSummary[]> {
  const out: RepoSummary[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = await request<InstallationRepos>(
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
