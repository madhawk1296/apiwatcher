"use client";

import { useActionState } from "react";

import { scanNow } from "@/app/app/actions";

/** The one interactive control on the page. */
export function ScanNowButton({ fullName }: { fullName: string }) {
  const [state, action, pending] = useActionState(
    async () => scanNow(fullName),
    null as { ok: boolean; message: string } | null,
  );
  return (
    <form action={action} className="flex items-baseline gap-3">
      {state ? <span className={`text-sm ${state.ok ? "text-ok" : "text-breaking"}`}>{state.message}</span> : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-sm border border-ink px-4 py-2 text-sm hover:bg-ink hover:text-paper disabled:opacity-50"
      >
        {pending ? "Queuing…" : "Scan now"}
      </button>
    </form>
  );
}
