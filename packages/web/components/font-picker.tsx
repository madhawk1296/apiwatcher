"use client";

import { useState } from "react";

import type { FontOption } from "@/lib/fonts";

/**
 * A design-time tool: switch the headline and body fonts live, site-wide.
 *
 * Changing a select sets the root CSS variables the whole site reads, so the
 * page updates in place, and writes a cookie so the server renders the same
 * choice on the next load. Remove `<FontPicker />` from the page to retire it.
 */
export function FontPicker({
  options,
  initial,
}: {
  options: FontOption[];
  initial: { heading: string; body: string; brand: string };
}) {
  const [open, setOpen] = useState(false);
  const [heading, setHeading] = useState(initial.heading);
  const [body, setBody] = useState(initial.body);
  const [brand, setBrand] = useState(initial.brand);

  function apply(nextHeading: string, nextBody: string, nextBrand: string) {
    const h = options.find((o) => o.id === nextHeading);
    const b = options.find((o) => o.id === nextBody);
    const br = options.find((o) => o.id === nextBrand);
    if (!h || !b || !br) return;
    const root = document.documentElement.style;
    root.setProperty("--font-heading", `var(${h.variable})`);
    root.setProperty("--font-body", `var(${b.variable})`);
    root.setProperty("--font-brand", `var(${br.variable})`);
    document.cookie = `aw_fonts=${nextHeading}:${nextBody}:${nextBrand}; Path=/; Max-Age=31536000; SameSite=Lax`;
    setHeading(nextHeading);
    setBody(nextBody);
    setBrand(nextBrand);
  }

  const select = "mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm";

  return (
    <div className="fixed bottom-5 right-5 z-50 font-sans text-neutral-900">
      {open ? (
        <div className="w-72 rounded-lg border border-neutral-200 bg-white p-4 shadow-xl">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Fonts</span>
            <button onClick={() => setOpen(false)} className="text-sm text-neutral-500 hover:text-neutral-900">
              close
            </button>
          </div>

          <label className="mt-3 block text-xs text-neutral-500">
            Brand (the APIWatcher wordmark)
            <select value={brand} onChange={(e) => apply(heading, body, e.target.value)} className={select}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label} · {o.kind}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-3 block text-xs text-neutral-500">
            Headline
            <select value={heading} onChange={(e) => apply(e.target.value, body, brand)} className={select}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label} · {o.kind}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-3 block text-xs text-neutral-500">
            Body
            <select value={body} onChange={(e) => apply(heading, e.target.value, brand)} className={select}>
              {options
                .filter((o) => o.kind === "sans")
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
            </select>
          </label>

          <p className="mt-3 text-[11px] leading-snug text-neutral-500">
            Applies site-wide and sticks across reloads on this browser. Tell Claude the pair you like and it becomes
            the default.
          </p>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          title="Change fonts"
          className="rounded-full border border-neutral-300 bg-white px-3 py-2 text-sm font-semibold shadow-md hover:bg-neutral-50"
        >
          Aa
        </button>
      )}
    </div>
  );
}
