import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ImpactReport } from "apiwatcher-cli";

import { currentUser } from "@/auth";
import { Footer, Severity, TopBar } from "@/components/chrome";
import { store } from "@/lib/db";
import { ScanNowButton } from "./scan-now";

export const dynamic = "force-dynamic";

export default async function Repo({ params }: PageProps<"/app/repos/[owner]/[repo]">) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;

  const db = store();
  if (!db.userCanSeeRepo(user.githubId, fullName)) notFound();
  const record = db.getRepo(fullName);
  if (!record) notFound();

  const history = db.scansForRepo(fullName, 25);
  const latestId = history[0]?.id;
  const latest = latestId !== undefined ? db.getScan(latestId) : null;
  const report = latest?.reportJson ? (JSON.parse(latest.reportJson) as ImpactReport) : null;

  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-6 py-14">
        <Link href="/app" className="text-sm text-ink-3 hover:text-ink">
          ← Your repositories
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="mono text-3xl md:text-4xl">{record.fullName}</h1>
            <p className="mt-2 text-sm text-ink-3">
              pinned {record.apiVersion ?? "unknown"} · stripe {record.stripeRange ?? "?"} · target {record.target} ·{" "}
              <a className="underline hover:text-ink" href={`https://github.com/${record.fullName}/issues?q=label%3Aapiwatcher`}>
                tracking issue
              </a>
            </p>
          </div>
          <ScanNowButton fullName={record.fullName} />
        </div>

        {!latest ? (
          <p className="mt-12 text-ink-2">No scan yet. One is queued on install; or run one now.</p>
        ) : latest.error ? (
          <div className="mt-10 rounded-sm border border-rule bg-deprecating-bg p-5">
            <Severity level="deprecating">scan failed</Severity>
            <p className="mono mt-3 text-sm">{latest.error}</p>
          </div>
        ) : report ? (
          <Report report={report} sha={latest.sha} fullName={record.fullName} />
        ) : (
          <div className="mt-10 text-ink-2">
            Last scan ({latest.createdAt.slice(0, 10)}): {latest.breaking} breaking, {latest.deprecating} deprecating.
            The full report has aged out; run a scan to regenerate it.
          </div>
        )}

        <section className="mt-16">
          <h2 className="text-2xl font-light">History</h2>
          <ol className="ledger mt-4 border-y border-rule">
            {history.map((s) => (
              <li key={s.id} className="grid items-baseline gap-3 py-2.5 text-sm md:grid-cols-[10rem_7rem_8rem_1fr]">
                <span className="mono text-ink-3">{s.createdAt.slice(0, 16).replace("T", " ")}</span>
                <span className="stamp text-ink-3">{s.trigger.replace("_", " ")}</span>
                <a className="mono text-ink-3 hover:text-ink" href={`https://github.com/${record.fullName}/commit/${s.sha}`}>
                  @{s.sha.slice(0, 7)}
                </a>
                <span className="mono">
                  {s.error ? (
                    <span className="text-deprecating">failed</span>
                  ) : s.breaking > 0 ? (
                    <span className="text-breaking">{s.breaking} breaking</span>
                  ) : (
                    <span className="text-ok">clean</span>
                  )}
                  <span className="text-ink-3"> · {s.filesScanned} files · target {s.targetVersion}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </main>
      <Footer />
    </>
  );
}

function Report({ report, sha, fullName }: { report: ImpactReport; sha: string; fullName: string }) {
  const blob = (file: string, line: number) => `https://github.com/${fullName}/blob/${sha}/${file}#L${line}`;

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm text-ink-2">
        <span>
          <span className="mono">{report.coveredFrom ?? "?"}</span> → <span className="mono">{report.targetVersion}</span>
        </span>
        <span>{report.filesScanned} files</span>
        <span>{report.unaffectedChanges} changes in range touch nothing here</span>
      </div>
      {report.coverageGap ? (
        <p className="mt-3 rounded-sm border border-rule bg-deprecating-bg px-4 py-2 text-sm text-deprecating">
          Changes before {report.coveredFrom} were not examined — this repo pins {report.currentVersion}, older than any
          changeset. Treat this as a lower bound.
        </p>
      ) : null}

      {report.findings.length === 0 ? (
        <div className="mt-8 rounded-sm border border-rule bg-ok-bg p-6">
          <Severity level="ok" />
          <p className="mt-3 text-lg">Nothing in this repository is affected.</p>
        </div>
      ) : (
        <ol className="ledger mt-8 border-y border-rule">
          {report.findings.map((f) => (
            <li key={f.change.id} className="py-6">
              <div className="flex flex-wrap items-center gap-2">
                <Severity level={f.severity === "breaking" ? "breaking" : f.severity === "deprecating" ? "deprecating" : "additive"} />
                <span className="mono text-sm">
                  {f.change.path
                    ? `${(f.change.method ?? "").toUpperCase()} ${f.change.path}`
                    : (f.change.event ?? f.change.resource ?? "")}
                </span>
                {f.confidence < 0.9 ? (
                  <span className="stamp text-deprecating">confidence {f.confidence.toFixed(2)} — verify</span>
                ) : null}
              </div>
              <p className="mt-2">{f.change.note}</p>
              <p className="mt-1 text-ink-2">
                <span className="text-accent-ink">→</span> {f.suggestion}
              </p>
              <ol className="mt-3 space-y-1.5">
                {f.sites.map((s) => (
                  <li key={`${s.evidence.file}:${s.evidence.line}`} className="mono text-[13px]">
                    <a className="text-ink-3 hover:text-accent-ink" href={blob(s.evidence.file, s.evidence.line)}>
                      {s.evidence.file}:{s.evidence.line}
                    </a>
                    <span className="text-ink-3">  </span>
                    <span className="text-ink">{s.evidence.snippet}</span>
                  </li>
                ))}
              </ol>
              <p className="mono mt-3 text-xs text-ink-3">
                {f.change.id}
                {f.change.docsUrl ? (
                  <>
                    {" · "}
                    <a className="underline hover:text-ink" href={f.change.docsUrl}>
                      docs
                    </a>
                  </>
                ) : null}
                {" · silence with "}
                <code>ignoreChanges: [&quot;{f.change.id}&quot;]</code>
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
