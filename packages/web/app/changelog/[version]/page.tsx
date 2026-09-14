import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Footer, Severity, TopBar } from "@/components/chrome";
import { changeSubject, changesetFor, locationLabel, trainOf } from "@/lib/changesets";
import { appSlug } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/changelog/[version]">): Promise<Metadata> {
  const { version } = await params;
  const cs = await changesetFor(version);
  if (!cs) return { title: "Not found" };
  const breaking = cs.changes.filter((c) => c.severity === "breaking").length;
  return {
    title: `Stripe ${version}`,
    description: `${breaking} breaking change${breaking === 1 ? "" : "s"} in Stripe API version ${version}, diffed from the OpenAPI spec.`,
  };
}

export default async function Version({ params }: PageProps<"/changelog/[version]">) {
  const { version } = await params;
  const cs = await changesetFor(version);
  if (!cs) notFound();

  const boundary = trainOf(cs.to) !== trainOf(cs.from);
  const groups = new Map<string, typeof cs.changes>();
  for (const c of cs.changes) {
    const key = changeSubject(c);
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-6 py-16">
        <Link href="/changelog" className="text-sm text-ink-3 hover:text-ink">
          ← All versions
        </Link>
        <h1 className="mono mt-4 text-4xl md:text-5xl">{cs.to}</h1>
        <p className="mt-3 text-ink-2">
          {boundary ? `First release of ${trainOf(cs.to)} — where Stripe ships breaking changes. ` : ""}
          Compared against {cs.from}. {cs.changes.length} change{cs.changes.length === 1 ? "" : "s"} that can break
          existing code.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3 rounded-sm border border-rule bg-paper-2 px-4 py-3 text-sm">
          <span>Which of these hit your repo?</span>
          <a href={`https://github.com/apps/${appSlug()}`} className="underline hover:text-accent-ink">
            Install the App
          </a>
          <span className="text-ink-3">or</span>
          <code className="text-xs">npx apiwatcher-cli scan --target {cs.to}</code>
        </div>

        {cs.changes.length === 0 ? (
          <p className="mt-12 text-ink-2">Nothing in this version breaks existing code.</p>
        ) : (
          [...groups.entries()].map(([subject, changes]) => (
            <section key={subject} className="mt-12">
              <h2 className="mono text-lg">{subject}</h2>
              <ol className="ledger mt-3 border-y border-rule">
                {changes.map((c) => (
                  <li key={c.id} className="grid gap-2 py-4 md:grid-cols-[7rem_1fr]">
                    <div className="flex items-start gap-2">
                      <Severity level={c.severity === "breaking" ? "breaking" : c.severity === "deprecating" ? "deprecating" : "additive"} />
                      <span className="stamp text-ink-3">{locationLabel(c)}</span>
                    </div>
                    <div>
                      <p>{c.note}</p>
                      <p className="mono mt-1 text-xs text-ink-3">
                        {c.id}
                        {c.sdkMethods?.length ? ` · ${c.sdkMethods.map((m) => `${m.namespace}.${m.method}`).join(", ")}` : ""}
                        {c.docsUrl ? (
                          <>
                            {" · "}
                            <a className="underline hover:text-ink" href={c.docsUrl}>
                              docs
                            </a>
                          </>
                        ) : null}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))
        )}
      </main>
      <Footer />
    </>
  );
}
