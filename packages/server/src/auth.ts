import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Sign-in is GitHub's OAuth, through the App's own client credentials.
 *
 * We never hold a password. After the code exchange we ask GitHub which App
 * installations this user can access — that list is their authorization, and it
 * is GitHub's to decide, not ours. The user token is used once for that lookup
 * (and the email), then discarded; a signed session cookie carries the rest.
 */

const GITHUB = 'https://github.com';
const API = 'https://api.github.com';
const UA = 'apiwatcher-server';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Externally reachable origin, e.g. https://app.example.com */
  publicUrl: string;
}

export function callbackUrl(cfg: OAuthConfig): string {
  return `${cfg.publicUrl.replace(/\/$/, '')}/auth/callback`;
}

/** Where to send the browser to start sign-in. `state` guards against CSRF. */
export function authorizeUrl(cfg: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: callbackUrl(cfg),
    state,
  });
  return `${GITHUB}/login/oauth/authorize?${params.toString()}`;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string;
}

export interface UserInstallation {
  id: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
}

async function ghJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': UA,
      authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** Trade the callback `code` for a user access token. */
export async function exchangeCode(cfg: OAuthConfig, code: string): Promise<string> {
  const res = await fetch(`${GITHUB}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: callbackUrl(cfg),
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!body.access_token) throw new Error(`token exchange failed: ${body.error_description ?? body.error ?? 'no token'}`);
  return body.access_token;
}

/** Who signed in. Email is the primary verified one when GitHub exposes it. */
export async function fetchUser(userToken: string): Promise<GitHubUser> {
  const u = await ghJson<{ id: number; login: string; name: string | null; email: string | null; avatar_url: string }>(
    `${API}/user`,
    userToken,
  );
  let email = u.email;
  if (!email) {
    try {
      const emails = await ghJson<Array<{ email: string; primary: boolean; verified: boolean }>>(
        `${API}/user/emails`,
        userToken,
      );
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
    } catch {
      email = null; // scope not granted; settings will ask for one
    }
  }
  return { id: u.id, login: u.login, name: u.name, email, avatarUrl: u.avatar_url };
}

/** Installations of *this* App that the signed-in user can access. */
export async function fetchUserInstallations(userToken: string): Promise<UserInstallation[]> {
  const out: UserInstallation[] = [];
  for (let page = 1; page <= 5; page++) {
    const body = await ghJson<{
      installations: Array<{ id: number; account: { login: string; type: 'User' | 'Organization' } }>;
    }>(`${API}/user/installations?per_page=100&page=${page}`, userToken);
    out.push(...body.installations.map((i) => ({ id: i.id, accountLogin: i.account.login, accountType: i.account.type })));
    if (body.installations.length < 100) break;
  }
  return out;
}

// --- sessions ------------------------------------------------------------------

/**
 * A session is an opaque id in a cookie, HMAC-signed so a forged or tampered
 * cookie is rejected before touching the database. The id maps to a row that
 * knows the user and when it expires.
 */
export const SESSION_COOKIE = 'apiwatcher_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function newState(): string {
  return randomBytes(16).toString('base64url');
}

function sign(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function sealCookie(secret: string, sessionId: string): string {
  return `${sessionId}.${sign(secret, sessionId)}`;
}

export function openCookie(secret: string, sealed: string | undefined): string | null {
  if (!sealed) return null;
  const dot = sealed.lastIndexOf('.');
  if (dot === -1) return null;
  const id = sealed.slice(0, dot);
  const mac = sealed.slice(dot + 1);
  const expected = sign(secret, id);
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return id;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return out;
}

export function cookieHeader(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookieHeader(name: string, secure: boolean): string {
  return cookieHeader(name, '', 0, secure);
}
