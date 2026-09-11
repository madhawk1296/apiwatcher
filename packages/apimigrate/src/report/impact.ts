import type { Severity, SpecChange } from '../changeset/types.js';
import { normalizePath } from '../specdiff/methodmap.js';
import type { ScanResult, Usage } from '../scanner/types.js';

export interface Finding {
  change: SpecChange;
  /** Call sites this change reaches, most confident first. */
  sites: Usage[];
  severity: Severity;
  /** Highest confidence among the matched sites. */
  confidence: number;
  /** One line telling the reader what to do. */
  suggestion: string;
}

export interface ImpactReport {
  api: 'stripe';
  /** Version the repo is on today, and how we concluded that. */
  currentVersion: string | null;
  currentVersionSource: 'pinned' | 'sdkDefault' | 'unknown';
  targetVersion: string;
  scannedAt: string;
  root: string;
  filesScanned: number;
  findings: Finding[];
  /** Changes in range that touch nothing in this repo. Counted, not listed. */
  unaffectedChanges: number;
  totals: Record<Severity, number>;
  warnings: string[];
}

export interface BuildReportInput {
  scan: ScanResult;
  changes: readonly SpecChange[];
  targetVersion: string;
  /** Change ids to suppress, from config. */
  ignoreIds?: readonly string[];
  /** Drop findings whose best site is below this confidence. */
  minConfidence?: number;
}

export function buildReport(input: BuildReportInput): ImpactReport {
  const { scan, targetVersion } = input;
  const ignore = new Set(input.ignoreIds ?? []);
  const minConfidence = input.minConfidence ?? 0.4;

  const index = indexUsages(scan.usages);
  const findings: Finding[] = [];
  let unaffectedChanges = 0;

  for (const change of input.changes) {
    if (ignore.has(change.id)) continue;

    const sites = dedupeSites(matchUsages(change, index).filter((u) => u.confidence >= minConfidence));
    if (sites.length === 0) {
      unaffectedChanges += 1;
      continue;
    }
    sites.sort(
      (a, b) =>
        b.confidence - a.confidence ||
        a.evidence.file.localeCompare(b.evidence.file) ||
        a.evidence.line - b.evidence.line,
    );
    findings.push({
      change,
      sites,
      severity: change.severity,
      confidence: sites[0]?.confidence ?? 0,
      suggestion: suggest(change),
    });
  }

  findings.sort(
    (a, b) =>
      rank(a.severity) - rank(b.severity) ||
      b.sites.length - a.sites.length ||
      a.change.id.localeCompare(b.change.id),
  );

  const totals: Record<Severity, number> = { breaking: 0, deprecating: 0, additive: 0 };
  for (const f of findings) totals[f.severity] += 1;

  const { version } = scan;
  const currentVersion = version.apiVersion ?? version.sdkDefaultApiVersion ?? null;
  const currentVersionSource = version.apiVersion
    ? ('pinned' as const)
    : version.sdkDefaultApiVersion
      ? ('sdkDefault' as const)
      : ('unknown' as const);

  return {
    api: 'stripe',
    currentVersion,
    currentVersionSource,
    targetVersion,
    scannedAt: new Date().toISOString(),
    root: scan.root,
    filesScanned: scan.filesScanned,
    findings,
    unaffectedChanges,
    totals,
    warnings: scan.warnings,
  };
}

// --------------------------------------------------------------------------

interface UsageIndex {
  /** `"post /v1/x"` (params normalized) -> sdkCall/rawUrl usages. */
  byEndpoint: Map<string, Usage[]>;
  /** Endpoint key -> requestParam usages. */
  requestParams: Map<string, Usage[]>;
  /** Endpoint key -> responseField usages. */
  responseFields: Map<string, Usage[]>;
  /** Event type -> webhookEvent usages. */
  events: Map<string, Usage[]>;
  /** callId -> the set of request param field paths that call passes. */
  paramsByCall: Map<string, Set<string>>;
}

function key(method: string | undefined, path: string | undefined): string | null {
  if (!path) return null;
  return `${(method ?? 'get').toLowerCase()} ${normalizePath(path)}`;
}

function push<K>(map: Map<K, Usage[]>, k: K, usage: Usage): void {
  let bucket = map.get(k);
  if (!bucket) {
    bucket = [];
    map.set(k, bucket);
  }
  bucket.push(usage);
}

function indexUsages(usages: readonly Usage[]): UsageIndex {
  const index: UsageIndex = {
    byEndpoint: new Map(),
    requestParams: new Map(),
    responseFields: new Map(),
    events: new Map(),
    paramsByCall: new Map(),
  };

  for (const usage of usages) {
    const k = key(usage.httpMethod, usage.path);

    switch (usage.kind) {
      case 'sdkCall':
      case 'rawUrl':
        if (k) push(index.byEndpoint, k, usage);
        break;
      case 'requestParam':
        if (k) push(index.requestParams, k, usage);
        if (usage.callId && usage.field) {
          let set = index.paramsByCall.get(usage.callId);
          if (!set) {
            set = new Set();
            index.paramsByCall.set(usage.callId, set);
          }
          set.add(usage.field);
        }
        break;
      case 'responseField':
        if (k) push(index.responseFields, k, usage);
        break;
      case 'webhookEvent':
        if (usage.event) push(index.events, usage.event, usage);
        break;
      case 'clientInit':
        break;
    }
  }
  return index;
}

/**
 * One source line should appear once per finding.
 *
 * A nested object literal puts several matching param paths on the same line
 * (`tipping: { bgn: { fixed_amounts: [...] } }` matches a `tipping.bgn` removal
 * twice over). The reader needs the line, not every path within it. Keeps the
 * highest-confidence usage per line.
 */
function dedupeSites(usages: readonly Usage[]): Usage[] {
  const best = new Map<string, Usage>();
  for (const usage of usages) {
    const k = `${usage.evidence.file}:${usage.evidence.line}`;
    const existing = best.get(k);
    if (!existing || usage.confidence > existing.confidence) best.set(k, usage);
  }
  return [...best.values()];
}

/** Every (method, path) a change touches: its own, plus attributed endpoints. */
function changeEndpoints(change: SpecChange): Array<{ method: string | undefined; path: string }> {
  const out: Array<{ method: string | undefined; path: string }> = [];
  if (change.path) out.push({ method: change.method, path: change.path });
  for (const ep of change.endpoints ?? []) {
    if (!out.some((e) => e.path === ep.path && e.method === ep.method)) out.push(ep);
  }
  return out;
}

/**
 * A raw URL usage has no reliable HTTP verb, so endpoint lookups also try the
 * path alone. Better to over-report a raw `fetch` than to miss it.
 */
function endpointUsages(index: UsageIndex, change: SpecChange): Usage[] {
  const out: Usage[] = [];
  const seen = new Set<Usage>();

  const take = (usage: Usage): void => {
    if (seen.has(usage)) return;
    seen.add(usage);
    out.push(usage);
  };

  for (const { method, path } of changeEndpoints(change)) {
    for (const usage of index.byEndpoint.get(key(method, path) as string) ?? []) take(usage);

    // A raw `fetch` whose verb we could not read still matches on path alone.
    const wantPath = normalizePath(path);
    for (const [k, list] of index.byEndpoint) {
      if (k.slice(k.indexOf(' ') + 1) !== wantPath) continue;
      for (const usage of list) {
        if (usage.kind === 'rawUrl' && usage.httpMethod === undefined) take(usage);
      }
    }
  }
  return out;
}

/**
 * Does a usage's field path touch the changed field?
 *
 * Only the field itself or something below it counts. Matching an *ancestor*
 * would mean flagging `line_items: [{ price, quantity }]` because some unrelated
 * `line_items[].dynamic_tax_rates` was removed — code that never sent the field
 * is not affected by it disappearing. The scanner records nested param paths, so
 * a caller who really does pass the field still produces an exact match.
 *
 * Array markers are dropped so `lines.data[].amount` matches `lines.data.amount`.
 */
function fieldTouches(usageField: string | undefined, changeField: string): boolean {
  if (!usageField) return false;
  const a = usageField.replace(/\[\]/g, '');
  const b = changeField.replace(/\[\]/g, '');
  return a === b || a.startsWith(`${b}.`);
}

/**
 * Field paths a response change can appear as at a call site.
 *
 * Response changes are diffed against the owning resource, so `field` is
 * relative to that resource while `fieldPaths` holds the paths a caller actually
 * reads. Match against both: the bare field covers code that destructured the
 * resource directly.
 */
function candidateFields(change: SpecChange): string[] {
  const out = new Set<string>();
  if (change.field) out.add(change.field);
  for (const p of change.fieldPaths ?? []) out.add(p);
  return [...out];
}

function matchUsages(change: SpecChange, index: UsageIndex): Usage[] {
  if (change.location === 'event') {
    return change.event ? [...(index.events.get(change.event) ?? [])] : [];
  }

  if (change.location === 'operation') {
    return endpointUsages(index, change);
  }

  if (change.location === 'response') {
    if (!change.field) return endpointUsages(index, change);
    const fields = candidateFields(change);
    const out: Usage[] = [];
    const seen = new Set<Usage>();

    for (const { method, path } of changeEndpoints(change)) {
      const k = key(method, path);
      if (!k) continue;
      for (const usage of index.responseFields.get(k) ?? []) {
        if (seen.has(usage)) continue;
        if (!fields.some((f) => fieldTouches(usage.field, f))) continue;
        seen.add(usage);
        out.push(usage);
      }
    }
    return out;
  }

  // requestBody / queryParam / pathParam — always scoped to one operation.
  const k = key(change.method, change.path);
  if (!k) return [];

  if (change.kind === 'required') {
    const calls = endpointUsages(index, change).filter((u) => u.kind === 'sdkCall');
    const field = change.field;
    if (!field) return calls;

    // A nested required field only binds callers who send its parent object, so
    // flag a call only when it reaches the field's parent but omits the field.
    const idx = field.lastIndexOf('.');
    const parent = idx === -1 ? null : field.slice(0, idx);

    return calls.filter((call) => {
      // No params object we could read: cannot rule it out, so report it.
      if (!call.callId) return true;
      const passed = index.paramsByCall.get(call.callId);
      if (!passed) return parent === null;
      if (passed.has(field)) return false; // already supplies it
      if (parent === null) return true; // top-level: every call needs it
      return reachesParent(passed, parent);
    });
  }

  if (!change.field) return endpointUsages(index, change);
  return (index.requestParams.get(k) ?? []).filter((u) =>
    fieldTouches(u.field, change.field as string),
  );
}

/**
 * Does a call site pass the object a nested required field lives in?
 *
 * Exact evidence wins: if the call passes `a.b` (or anything inside it), a field
 * required under `a.b` applies. Otherwise fall back on what the scanner could
 * see. It only descends a couple of levels into object literals, so a recorded
 * ancestor with no recorded children means "we did not look inside" — stay safe
 * and report. But when the children *were* enumerated and the wanted branch is
 * not among them, the call demonstrably does not pass it, and reporting would be
 * a false alarm.
 */
function reachesParent(passed: ReadonlySet<string>, parent: string): boolean {
  const want = parent.replace(/\[\]/g, '');
  const have = [...passed].map((p) => p.replace(/\[\]/g, ''));

  for (const p of have) {
    if (p === want || p.startsWith(`${want}.`)) return true;
  }

  // Deepest recorded ancestor of the wanted path.
  let deepest: string | null = null;
  for (const p of have) {
    if (!want.startsWith(`${p}.`)) continue;
    if (deepest === null || p.length > deepest.length) deepest = p;
  }
  if (deepest === null) return false;

  const enumeratedChildren = have.some((p) => p.startsWith(`${deepest as string}.`));
  // Children listed and ours absent -> not passed. Nothing listed -> unknown.
  return !enumeratedChildren;
}

function suggest(change: SpecChange): string {
  const field = change.field ?? change.event ?? '';
  switch (change.kind) {
    case 'renamed':
      return `Rename \`${field}\` to \`${change.replacement ?? '?'}\`.`;
    case 'removed':
      if (change.location === 'operation') {
        return `Replace this call — ${String(change.method).toUpperCase()} ${change.path} no longer exists.`;
      }
      if (change.location === 'event') return `Remove the handler for \`${field}\`.`;
      return change.replacement
        ? `Stop reading \`${field}\`; use \`${change.replacement}\` instead.`
        : `Stop using \`${field}\` — it is gone in ${change.severity === 'breaking' ? 'the target version' : 'a later version'}.`;
    case 'required':
      return `Pass \`${field}\` in this call; it is now required.`;
    case 'typeChanged':
      return `\`${field}\` is now \`${change.toType ?? '?'}\` (was \`${change.fromType ?? '?'}\`). Update the code that reads it.`;
    case 'deprecated':
      return change.location === 'operation'
        ? 'Plan a migration off this endpoint before it is removed.'
        : `Plan to stop using \`${field}\` before it is removed.`;
    case 'added':
      return change.location === 'operation'
        ? 'New endpoint available; no action needed.'
        : `New field \`${field}\` available; no action needed.`;
  }
}

function rank(severity: Severity): number {
  return severity === 'breaking' ? 0 : severity === 'deprecating' ? 1 : 2;
}

/** Exit code contract: non-zero only when something is actually breaking. */
export function exitCodeFor(report: ImpactReport, failOn: Severity | 'never' = 'breaking'): number {
  if (failOn === 'never') return 0;
  const thresholds: Severity[] =
    failOn === 'breaking' ? ['breaking'] : failOn === 'deprecating' ? ['breaking', 'deprecating'] : ['breaking', 'deprecating', 'additive'];
  return thresholds.some((s) => report.totals[s] > 0) ? 1 : 0;
}
