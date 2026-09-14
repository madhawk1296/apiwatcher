"use client";

import { useActionState } from "react";

import { savePrefs } from "@/app/app/actions";

export function PrefsForm({ defaults }: { defaults: { email: string; notifyOn: string; slackWebhook: string } }) {
  const [state, action, pending] = useActionState(
    async (_prev: { ok: boolean; message: string } | null, formData: FormData) => savePrefs(formData),
    null as { ok: boolean; message: string } | null,
  );

  const field = "mt-1 w-full rounded-sm border border-rule bg-paper px-3 py-2 text-sm focus:border-ink";

  return (
    <form action={action} className="space-y-6">
      <label className="block text-sm">
        <span className="stamp text-ink-3">Email</span>
        <input name="email" type="email" defaultValue={defaults.email} placeholder="you@company.com" className={field} />
      </label>

      <fieldset className="text-sm">
        <legend className="stamp text-ink-3">Notify on</legend>
        <div className="mt-2 space-y-2">
          {[
            ["breaking", "Breaking changes only", "The default. A version that breaks nothing of yours is silent."],
            ["deprecating", "Breaking and deprecations", "Also hear about things that still work but will stop."],
            ["never", "Never", "Stay tracked, keep the issues and checks, send nothing."],
          ].map(([value, label, help]) => (
            <label key={value} className="flex items-start gap-3">
              <input type="radio" name="notifyOn" value={value} defaultChecked={defaults.notifyOn === value} className="mt-1 accent-[var(--accent)]" />
              <span>
                {label}
                <span className="block text-xs text-ink-3">{help}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block text-sm">
        <span className="stamp text-ink-3">Slack webhook (optional)</span>
        <input name="slackWebhook" type="url" defaultValue={defaults.slackWebhook} placeholder="https://hooks.slack.com/services/…" className={`${field} mono`} />
      </label>

      <div className="flex items-baseline gap-3">
        <button type="submit" disabled={pending} className="rounded-sm bg-ink px-4 py-2 text-sm text-paper hover:bg-accent-ink disabled:opacity-50">
          {pending ? "Saving…" : "Save"}
        </button>
        {state ? <span className={`text-sm ${state.ok ? "text-ok" : "text-breaking"}`}>{state.message}</span> : null}
      </div>
    </form>
  );
}
