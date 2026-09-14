import { redirect } from "next/navigation";

import { currentUser } from "@/auth";
import { Footer, TopBar } from "@/components/chrome";
import { store } from "@/lib/db";
import { PrefsForm } from "./prefs-form";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/app/settings");

  const db = store();
  const account = db.getUser(user.githubId);
  const prefs = db.getPrefs(user.githubId);
  const installs = db.userInstallations(user.githubId);

  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-6 py-14">
        <h1 className="text-4xl font-light">Settings</h1>

        <section className="mt-10 grid gap-10 md:grid-cols-[1fr_1.4fr]">
          <div>
            <h2 className="text-2xl font-normal">When Stripe ships a version</h2>
            <p className="mt-3 leading-relaxed text-ink-2">
              One message per account, once per version, listing the repositories affected — worst first, each
              linked to its issue. Nothing is sent when nothing is affected.
            </p>
            <p className="mt-3 text-sm text-ink-3">
              Covers {installs.length === 0 ? "no installations yet" : installs.map((i) => i.accountLogin).join(", ")}.
            </p>
          </div>
          <PrefsForm
            defaults={{
              email: prefs?.email ?? account?.email ?? "",
              notifyOn: prefs?.notifyOn ?? "breaking",
              slackWebhook: prefs?.slackWebhook ?? "",
            }}
          />
        </section>

        <section className="mt-16 border-t border-rule pt-10">
          <h2 className="text-2xl font-normal">Per-repository settings live in the repo</h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-ink-2">
            Target version, ignored paths, silenced change ids, and whether pull requests get a check are set in{" "}
            <code>.apiwatcher.json</code> at the repository root, so they travel with the code and go through review.
          </p>
          <pre className="mt-4 max-w-2xl rounded-sm border border-rule bg-paper-2 p-4 text-xs leading-relaxed">
{`{
  "target": "latest",
  "alerts": true,
  "scanOnPush": true,
  "ignorePaths": ["src/generated"],
  "ignoreChanges": ["stripe-2026-01-28.clover-0005"],
  "failOn": "breaking"
}`}
          </pre>
        </section>
      </main>
      <Footer />
    </>
  );
}
