import Link from "next/link";
import { redirect } from "next/navigation";

import { currentUser } from "@/auth";
import { Footer, Severity, TopBar } from "@/components/chrome";
import { latestVersion } from "@/lib/changesets";
import { store } from "@/lib/db";
import { appSlug } from "@/lib/env";
import { serverHealth } from "@/lib/server-api";

export const dynamic = "force-dynamic";

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export default async function Repos() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/app");

  const db = store();
  const installs = db.userInstallations(user.githubId);
  const repos = db.reposForUser(user.githubId);
  const latest = db.latestScansFor(repos.map((r) => r.fullName));
  const [health, newest] = await Promise.all([serverHealth(), latestVersion()]);

  const affected = repos.filter((r) => (latest.get(r.fullName.toLowerCase())?.breaking ?? 0) > 0).length;

  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-6 py-14">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <h1 className="text-4xl font-light">Your repositories</h1>
          <p className="mono text-sm text-ink-3">
            {repos.length} tracked · {affected} affected · target {newest ?? "—"}
            {health.ok ? "" : " · scanner offline"}
          </p>
        </div>

        {installs.length === 0 ? (
          <Empty title="No installations yet.">
            Install the App on an account you can access and it will index every repository that uses Stripe.{" "}
            <a className="underline hover:text-accent-ink" href={`https://github.com/apps/${appSlug()}`}>
              Install it.
            </a>
          </Empty>
        ) : repos.length === 0 ? (
          <Empty title="Installed, nothing tracked.">
            None of the repositories in {installs.map((i) => i.accountLogin).join(", ")} declare a{" "}
            <code>stripe</code> dependency. Add the App to a repo that does and it will appear here within a minute.
          </Empty>
        ) : (
          <ol className="ledger mt-10 border-y border-rule">
            {repos.map((r) => {
              const s = latest.get(r.fullName.toLowerCase());
              const level = !s ? "additive" : s.error ? "deprecating" : s.breaking > 0 ? "breaking" : "ok";
              return (
                <li key={r.fullName} className="grid items-baseline gap-3 py-4 md:grid-cols-[1fr_9rem_10rem_8rem]">
                  <div>
                    <Link href={`/app/repos/${r.fullName}`} className="mono hover:text-accent-ink">
                      {r.fullName}
                    </Link>
                    <p className="mt-1 text-xs text-ink-3">
                      pinned {r.apiVersion ?? "unknown"} · stripe {r.stripeRange ?? "?"}
                      {r.scanOnPush ? "" : " · push scans off"}
                      {r.alerts ? "" : " · alerts off"}
                    </p>
                  </div>
                  <div>
                    {!s ? (
                      <Severity level="additive">not scanned</Severity>
                    ) : s.error ? (
                      <Severity level="deprecating">scan failed</Severity>
                    ) : s.breaking > 0 ? (
                      <Severity level="breaking">{s.breaking} breaking</Severity>
                    ) : (
                      <Severity level="ok" />
                    )}
                  </div>
                  <span className="mono text-xs text-ink-3">{s ? `${ago(s.createdAt)} · ${s.trigger}` : "—"}</span>
                  <span className="mono text-xs text-ink-3">{s ? `@${s.sha.slice(0, 7)}` : ""}</span>
                </li>
              );
            })}
          </ol>
        )}
      </main>
      <Footer />
    </>
  );
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-10 max-w-xl rounded-sm border border-rule bg-paper-2 p-6">
      <h2 className="text-2xl font-normal">{title}</h2>
      <p className="mt-2 leading-relaxed text-ink-2">{children}</p>
    </div>
  );
}
