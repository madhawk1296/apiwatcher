import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

import { store } from "@/lib/db";

/**
 * Sign-in is GitHub's. Authorization is GitHub's too: on every sign-in we ask
 * which installations of *this* App the user can access, and that list — not
 * anything we invent — decides which repos they see.
 *
 * The client credentials must be the GitHub App's own. A separate OAuth App's
 * token cannot list this App's installations, and the dashboard would be empty.
 */

interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

async function gh<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "apiwatcher-web",
      authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return (await res.json()) as T;
}

async function primaryEmail(token: string, fallback: string | null): Promise<string | null> {
  if (fallback) return fallback;
  try {
    const emails = await gh<Array<{ email: string; primary: boolean; verified: boolean }>>("/user/emails", token);
    return emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
  } catch {
    return null;
  }
}

async function installations(token: string): Promise<Array<{ id: number; accountLogin: string }>> {
  const out: Array<{ id: number; accountLogin: string }> = [];
  for (let page = 1; page <= 5; page++) {
    const body = await gh<{ installations: Array<{ id: number; account: { login: string } }> }>(
      `/user/installations?per_page=100&page=${page}`,
      token,
    );
    out.push(...body.installations.map((i) => ({ id: i.id, accountLogin: i.account.login })));
    if (body.installations.length < 100) break;
  }
  return out;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
      authorization: { params: { scope: "read:user user:email" } },
    }),
  ],
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/login" },
  callbacks: {
    async jwt({ token, account, profile }) {
      // Only on sign-in: `account` carries the user token, used once and dropped.
      if (account?.access_token && profile) {
        const p = profile as unknown as GitHubProfile;
        const githubId = Number(p.id);
        const [email, installs] = await Promise.all([
          primaryEmail(account.access_token, p.email),
          installations(account.access_token),
        ]);
        const db = store();
        db.upsertUser({ githubId, login: p.login, name: p.name, email, avatarUrl: p.avatar_url });
        db.setUserInstallations(githubId, installs);
        token.githubId = githubId;
        token.login = p.login;
      }
      return token;
    },
    session({ session, token }) {
      session.user.githubId = token.githubId as number;
      session.user.login = token.login as string;
      return session;
    },
  },
});

/** The signed-in user, or null. Pages and actions call this; never trust the URL. */
export async function currentUser(): Promise<{ githubId: number; login: string; name: string | null; image: string | null } | null> {
  let session;
  try {
    session = await auth();
  } catch {
    // Auth not configured yet (no secret / client id). Public pages still render.
    return null;
  }
  const u = session?.user;
  if (!u?.githubId) return null;
  return { githubId: u.githubId, login: u.login, name: u.name ?? null, image: u.image ?? null };
}
