import Link from "next/link";

import { Footer, Severity, TopBar } from "@/components/chrome";
import { versionSummaries } from "@/lib/changesets";
import { appSlug } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * The landing page's hero is the product's real output — the fixture finding,
 * exactly as the CLI prints it — because a sentence about the product is less
 * convincing than the thing itself.
 */
export default async function Home() {
  const versions = await versionSummaries();
  const latest = versions[0];
  const totalBreaking = versions.reduce((n, v) => n + v.breaking, 0);

  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-6">
        <section className="grid gap-12 py-16 md:grid-cols-[1.15fr_0.85fr] md:py-24">
          <div>
            <h1 className="rise rise-1 max-w-xl text-5xl font-light leading-[1.02] md:text-6xl">
              Stripe changed.
              <br />
              <em className="font-normal not-italic text-accent-ink">Here&rsquo;s line 22.</em>
            </h1>
            <p className="rise rise-2 mt-8 max-w-lg text-lg leading-relaxed text-ink-2">
              Dependabot tells you a version number moved. apiwatcher tells you that{" "}
              <code className="text-base">tipping.bgn</code> no longer exists and that line 22 of your checkout
              route is the place that breaks — on every pull request, and the day Stripe ships something new.
            </p>
            <div className="rise rise-3 mt-10 flex flex-wrap items-center gap-4">
              <a
                href={`https://github.com/apps/${appSlug()}`}
                className="rounded-sm bg-ink px-5 py-3 text-paper hover:bg-accent-ink"
              >
                Install the GitHub App
              </a>
              <code className="rounded-sm border border-rule bg-paper-2 px-3 py-2 text-sm">
                npx apiwatcher-cli scan
              </code>
            </div>
            <p className="rise rise-3 mt-4 text-sm text-ink-3">
              No account for the CLI. Nothing leaves your machine. Exit code 1 when something breaks.
            </p>
          </div>

          {/* The hero: an actual finding, set as a ledger entry. */}
          <figure className="rise rise-2 self-start rounded-sm border border-rule bg-paper-2 shadow-[0_1px_0_var(--rule),0_24px_48px_-32px_rgba(22,19,17,0.35)]">
            <figcaption className="flex items-baseline justify-between border-b border-rule px-4 py-2">
              <span className="stamp text-ink-3">src/routes/checkout.ts</span>
              <Severity level="breaking" />
            </figcaption>
            <pre className="overflow-x-auto px-4 py-4 text-[13px] leading-relaxed">
              <span className="text-breaking">BREAKING</span> POST /v1/terminal/configurations/{"{configuration}"}
              {"\n"}
              <span className="text-ink-3">stripe-2026-01-28.clover-0005</span>
              {"\n\n"}
              Request parameter <span className="text-ink">&quot;tipping.bgn&quot;</span> was removed.
              {"\n"}
              <span className="text-accent-ink">→</span> Stop using <span className="text-ink">tipping.bgn</span> — it is gone in the
              target version.
              {"\n\n"}
              <span className="text-ink-3">22:16</span>  tipping: {"{"} bgn: {"{"} fixed_amounts: [100] {"}"} {"}"},
            </pre>
            <div className="border-t border-rule px-4 py-2 text-xs text-ink-3">
              Introduced in 2026-01-28.clover — the month Bulgaria adopted the euro.
            </div>
          </figure>
        </section>

        <section className="rise rise-4 grid gap-10 border-t border-rule py-16 md:grid-cols-3">
          <Step n="01" title="Install, and only that">
            One click on GitHub. Repos that use Stripe get scanned within a minute; repos that don&rsquo;t are never
            touched. No workflow file, no config.
          </Step>
          <Step n="02" title="A check on every pull request">
            Code that breaks on your target Stripe version fails the check, with the file and line. Docs-only
            changes are skipped before anything is cloned.
          </Step>
          <Step n="03" title="One issue when Stripe ships">
            A new API version means one tracking issue per affected repo, updated in place, closed when it&rsquo;s
            clean. Silence when nothing is affected.
          </Step>
        </section>

        <section className="border-t border-rule py-16">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <h2 className="text-3xl font-light">Every Stripe version, diffed.</h2>
            <Link href="/changelog" className="text-sm hover:text-accent-ink">
              The full changelog →
            </Link>
          </div>
          <p className="mt-3 max-w-2xl text-ink-2">
            {versions.length} versions from Stripe&rsquo;s own OpenAPI spec, {totalBreaking} breaking changes, each one
            traced to the version that introduced it. Breaking changes ship at release-train boundaries; the rest is
            the monthly noise, kept out of your way.
          </p>
          <ol className="ledger mt-8 border-y border-rule">
            {versions.slice(0, 6).map((v) => (
              <li key={v.version} className="grid grid-cols-[1fr_auto] items-baseline gap-4 py-3 md:grid-cols-[14rem_1fr_auto]">
                <Link href={`/changelog/${v.version}`} className="mono text-sm hover:text-accent-ink">
                  {v.version}
                </Link>
                <span className="hidden text-sm text-ink-3 md:block">
                  {v.boundary ? `first ${v.train} release` : `${v.train} monthly`}
                </span>
                <span className="mono text-sm">
                  {v.breaking === 0 ? (
                    <span className="text-ok">no breaking changes</span>
                  ) : (
                    <span className="text-breaking">
                      {v.breaking} breaking
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
          {latest ? (
            <p className="mt-3 text-xs text-ink-3">Latest: {latest.version}. Updated automatically when Stripe publishes.</p>
          ) : null}
        </section>

        <section className="border-t border-rule py-16">
          <h2 className="text-3xl font-light">What it will not do.</h2>
          <ul className="mt-6 grid gap-4 text-ink-2 md:grid-cols-2">
            <li>It reads your code to scan it and deletes the clone seconds later. It keeps the report — file, line, the offending source line — for thirty days.</li>
            <li>It does not change your code. Reports only, until you ask otherwise.</li>
            <li>It cannot see changes an OpenAPI diff cannot: rate limits, ordering, error codes.</li>
            <li>It covers Stripe and TypeScript. Other APIs and languages are the roadmap, not the product.</li>
          </ul>
        </section>
      </main>
      <Footer />
    </>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="stamp text-accent">{n}</span>
      <h3 className="mt-2 text-2xl font-normal">{title}</h3>
      <p className="mt-3 leading-relaxed text-ink-2">{children}</p>
    </div>
  );
}
