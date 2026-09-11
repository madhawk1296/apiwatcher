/**
 * Stripe API versions are dated, optionally with a release-train name:
 *   `2025-09-30.clover`, `2026-08-26.dahlia`, or bare `2024-06-20`.
 *
 * The date is what orders them; the name is cosmetic. Comparing the date
 * lexicographically is correct because it is zero-padded ISO.
 */

const VERSION_RE = /^(\d{4})-(\d{2})-(\d{2})(?:\.([a-z0-9_]+))?$/i;

export interface ParsedVersion {
  raw: string;
  date: string;
  train?: string;
}

export function parseApiVersion(raw: string): ParsedVersion | null {
  const m = VERSION_RE.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, train] = m;
  return { raw: raw.trim(), date: `${y}-${mo}-${d}`, ...(train ? { train } : {}) };
}

/** Negative if `a` is older. Throws on unparseable input so bad config is loud. */
export function compareApiVersions(a: string, b: string): number {
  const pa = parseApiVersion(a);
  const pb = parseApiVersion(b);
  if (!pa) throw new Error(`Unrecognized Stripe API version: ${a}`);
  if (!pb) throw new Error(`Unrecognized Stripe API version: ${b}`);
  if (pa.date < pb.date) return -1;
  if (pa.date > pb.date) return 1;
  return 0;
}

export function isApiVersion(raw: string): boolean {
  return parseApiVersion(raw) !== null;
}
