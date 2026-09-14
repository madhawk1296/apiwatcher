import type { Metadata } from "next";
import Link from "next/link";

import { Footer, TopBar } from "@/components/chrome";
import { versionSummaries } from "@/lib/changesets";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Stripe API changelog",
  description: "Every Stripe API version diffed from the OpenAPI spec: what was removed, renamed, or changed, and where.",
};

export default async function Changelog() {
  const versions = await versionSummaries();
  const trains = new Map<string, typeof versions>();
  for (const v of versions) {
    const list = trains.get(v.train) ?? [];
    list.push(v);
    trains.set(v.train, list);
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-6 py-16">
        <h1 className="text-5xl font-light">Stripe API changelog</h1>
        <p className="mt-4 max-w-2xl leading-relaxed text-ink-2">
          Diffed from Stripe&rsquo;s own OpenAPI spec, one entry per version. Stripe ships breaking changes only in
          the first version of a release train; monthly versions inside a train are additive. The counts here
          are what actually breaks code, after that noise is removed.
        </p>

        {[...trains.entries()].map(([train, list]) => (
          <section key={train} className="mt-14">
            <h2 className="display text-2xl capitalize">{train}</h2>
            <ol className="ledger mt-4 border-y border-rule">
              {list.map((v) => (
                <li key={v.version} className="grid items-baseline gap-4 py-3 md:grid-cols-[14rem_1fr_auto]">
                  <Link href={`/changelog/${v.version}`} className="mono text-sm hover:text-accent-ink">
                    {v.version}
                  </Link>
                  <span className="text-sm text-ink-3">
                    {v.boundary ? "release boundary — breaking changes land here" : `from ${v.from}`}
                  </span>
                  <span className="mono text-sm">
                    {v.breaking === 0 ? (
                      <span className="text-ok">clean</span>
                    ) : (
                      <span className="text-breaking">{v.breaking} breaking</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </main>
      <Footer />
    </>
  );
}
