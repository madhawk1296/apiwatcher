import Link from "next/link";

import { currentUser, signOut } from "@/auth";

/**
 * The top rule of every page: wordmark left, a few links right. Signed-in
 * pages get the user; public pages get the install button.
 */
export async function TopBar() {
  const user = await currentUser();
  return (
    <header className="border-b border-rule">
      <div className="mx-auto flex max-w-6xl items-baseline justify-between px-6 py-4">
        <Link href="/" className="display text-xl font-medium tracking-tight">
          apiwatcher
        </Link>
        <nav className="flex items-baseline gap-6 text-sm">
          <Link href="/changelog" className="hover:text-accent-ink">
            Stripe changelog
          </Link>
          {user ? (
            <>
              <Link href="/app" className="hover:text-accent-ink">
                Your repos
              </Link>
              <Link href="/app/settings" className="hover:text-accent-ink">
                Settings
              </Link>
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/" });
                }}
              >
                <button className="stamp text-ink-3 hover:text-ink" type="submit">
                  {user.login} · sign out
                </button>
              </form>
            </>
          ) : (
            <Link
              href="/login"
              className="rounded-sm border border-ink px-3 py-1.5 text-sm hover:bg-ink hover:text-paper"
            >
              Sign in with GitHub
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mt-auto border-t border-rule">
      <div className="mx-auto flex max-w-6xl flex-wrap items-baseline justify-between gap-4 px-6 py-6 text-xs text-ink-3">
        <span>
          apiwatcher · Stripe and TypeScript, for now. Reports only; nothing is changed without you.
        </span>
        <span className="flex gap-4">
          <a className="hover:text-ink" href="https://github.com/madhawk1296/apiwatcher">
            Source
          </a>
          <a className="hover:text-ink" href="https://www.npmjs.com/package/apiwatcher-cli">
            CLI on npm
          </a>
        </span>
      </div>
    </footer>
  );
}

export function Severity({ level, children }: { level: "breaking" | "deprecating" | "ok" | "additive"; children?: React.ReactNode }) {
  const cls =
    level === "breaking"
      ? "bg-breaking-bg text-breaking"
      : level === "deprecating"
        ? "bg-deprecating-bg text-deprecating"
        : level === "ok"
          ? "bg-ok-bg text-ok"
          : "bg-paper-2 text-ink-2";
  const label = children ?? (level === "ok" ? "clean" : level);
  return <span className={`stamp rounded-sm px-1.5 py-0.5 ${cls}`}>{label}</span>;
}
