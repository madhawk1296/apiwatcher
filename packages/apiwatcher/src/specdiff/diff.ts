import type { Changeset, EndpointRef, Location, SdkMethodRef, SpecChange } from '../changeset/types.js';
import { SCHEMA_VERSION } from '../changeset/types.js';
import {
  buildReadSites,
  deref,
  eventTypes,
  flattenOwnFields,
  operations,
  requestSchema,
  responseSchema,
  typeSignature,
  type FieldInfo,
  type HttpMethod,
  type OpenApiSpec,
  type OperationNode,
  type ParameterNode,
  type ReadSite,
} from './openapi.js';
import { classifyTypeChange, type Direction } from './compat.js';
import { lookupSdkMethods, type MethodMap } from './methodmap.js';

export interface DiffOptions {
  methodMap?: MethodMap;
  /** Nesting depth to compare within a schema. Refs are always boundaries. */
  maxDepth?: number;
  /** Include `additive` entries. Off by default: they never break anything. */
  includeAdditive?: boolean;
  /** Cap on endpoints/paths cited per resource change, to keep changesets small. */
  maxAttribution?: number;
  source?: Changeset['source'];
}

const UPGRADE_GUIDE = 'https://docs.stripe.com/upgrades';
const DOCS_BASE = 'https://docs.stripe.com/api';
const EVENTS_DOCS = 'https://docs.stripe.com/api/events/types';

/**
 * Diffs two Stripe OpenAPI specs into a changeset.
 *
 * Requests are diffed per operation, because Stripe inlines request shapes.
 * Responses are diffed per component schema with `$ref` as a boundary, then
 * attributed to the endpoints that return them — expanding refs per endpoint
 * produces unstable field sets and duplicates one real change across hundreds of
 * paths.
 *
 * The only inference is rename detection, kept deliberately conservative: a
 * wrong `replacement` sends someone to the wrong field, which is worse than
 * reporting a removal and an addition separately.
 */
export function diffSpecs(oldSpec: OpenApiSpec, newSpec: OpenApiSpec, options: DiffOptions = {}): Changeset {
  const from = oldSpec.info?.version;
  const to = newSpec.info?.version;
  if (!from || !to) throw new Error('Both specs must declare info.version');

  const maxDepth = options.maxDepth ?? 3;
  const maxAttribution = options.maxAttribution ?? 12;
  const changes: SpecChange[] = [];
  const ids = new IdAllocator(to);

  const oldOps = indexOperations(oldSpec);
  const newOps = indexOperations(newSpec);

  // --- endpoints that disappeared or arrived -------------------------------
  for (const [key, entry] of oldOps) {
    if (newOps.has(key)) continue;
    changes.push({
      id: ids.next(),
      kind: 'removed',
      severity: 'breaking',
      location: 'operation',
      path: entry.path,
      method: entry.method,
      note: `Endpoint ${entry.method.toUpperCase()} ${entry.path} no longer exists.`,
      docsUrl: UPGRADE_GUIDE,
      ...withSdk(options.methodMap, entry.method, entry.path),
    });
  }

  if (options.includeAdditive) {
    for (const [key, entry] of newOps) {
      if (oldOps.has(key)) continue;
      changes.push({
        id: ids.next(),
        kind: 'added',
        severity: 'additive',
        location: 'operation',
        path: entry.path,
        method: entry.method,
        note: `New endpoint ${entry.method.toUpperCase()} ${entry.path}.`,
        docsUrl: DOCS_BASE,
        ...withSdk(options.methodMap, entry.method, entry.path),
      });
    }
  }

  // --- requests, per operation --------------------------------------------
  for (const [key, oldEntry] of oldOps) {
    const newEntry = newOps.get(key);
    if (!newEntry) continue;

    const sdk = withSdk(options.methodMap, oldEntry.method, oldEntry.path);

    if (oldEntry.op.deprecated !== true && newEntry.op.deprecated === true) {
      changes.push({
        id: ids.next(),
        kind: 'deprecated',
        severity: 'deprecating',
        location: 'operation',
        path: oldEntry.path,
        method: oldEntry.method,
        note: `Endpoint ${oldEntry.method.toUpperCase()} ${oldEntry.path} is now deprecated.`,
        docsUrl: UPGRADE_GUIDE,
        ...sdk,
      });
    }

    diffFields(
      {
        before: flattenOwnFields(oldSpec, requestSchema(oldSpec, oldEntry.op), { maxDepth }),
        after: flattenOwnFields(newSpec, requestSchema(newSpec, newEntry.op), { maxDepth }),
        location: 'requestBody',
        direction: 'request',
        path: oldEntry.path,
        method: oldEntry.method,
        extra: sdk,
      },
      changes,
      ids,
      options,
    );

    diffFields(
      {
        before: parameterFields(oldSpec, oldEntry.op, 'query'),
        after: parameterFields(newSpec, newEntry.op, 'query'),
        location: 'queryParam',
        direction: 'request',
        path: oldEntry.path,
        method: oldEntry.method,
        extra: sdk,
      },
      changes,
      ids,
      options,
    );
  }

  // --- responses, per component schema ------------------------------------
  const readSites = buildReadSites(newSpec, maxDepth);
  const oldSchemas = oldSpec.components?.schemas ?? {};
  const newSchemas = newSpec.components?.schemas ?? {};

  for (const name of Object.keys(oldSchemas)) {
    const oldSchema = oldSchemas[name];
    const newSchema = newSchemas[name];
    // A schema that vanished entirely is reported through whatever referenced
    // it (an endpoint removal or a type change), not as its own entry.
    if (!oldSchema || !newSchema) continue;

    const sites = readSites.get(name) ?? [];
    if (sites.length === 0) continue; // unreachable from any response

    const attribution = attributeSites(sites, options.methodMap, maxAttribution);

    diffFields(
      {
        before: flattenOwnFields(oldSpec, oldSchema, { maxDepth }),
        after: flattenOwnFields(newSpec, newSchema, { maxDepth }),
        location: 'response',
        direction: 'response',
        resource: name,
        sites,
        maxAttribution,
        extra: attribution,
      },
      changes,
      ids,
      options,
    );
  }

  // --- webhook events ------------------------------------------------------
  const oldEvents = eventTypes(oldSpec);
  const newEvents = eventTypes(newSpec);
  for (const event of oldEvents.keys()) {
    if (newEvents.has(event)) continue;
    changes.push({
      id: ids.next(),
      kind: 'removed',
      severity: 'breaking',
      location: 'event',
      event,
      note: `Webhook event "${event}" is no longer sent.`,
      docsUrl: EVENTS_DOCS,
    });
  }
  if (options.includeAdditive) {
    for (const event of newEvents.keys()) {
      if (oldEvents.has(event)) continue;
      changes.push({
        id: ids.next(),
        kind: 'added',
        severity: 'additive',
        location: 'event',
        event,
        note: `New webhook event "${event}".`,
        docsUrl: EVENTS_DOCS,
      });
    }
  }

  changes.sort(byImpact);

  return {
    schemaVersion: SCHEMA_VERSION,
    api: 'stripe',
    from,
    to,
    generatedAt: new Date().toISOString(),
    ...(options.source ? { source: options.source } : {}),
    changes,
  };
}

// --------------------------------------------------------------------------

interface OpEntry {
  path: string;
  method: HttpMethod;
  op: OperationNode;
}

function indexOperations(spec: OpenApiSpec): Map<string, OpEntry> {
  const out = new Map<string, OpEntry>();
  for (const { path, method, op } of operations(spec)) {
    out.set(`${method} ${path}`, { path, method, op });
  }
  return out;
}

type Attribution = Pick<SpecChange, 'sdkMethods' | 'endpoints'>;

function withSdk(map: MethodMap | undefined, method: string, path: string): Attribution {
  if (!map) return {};
  const refs = lookupSdkMethods(map, method, path);
  return refs.length > 0 ? { sdkMethods: refs } : {};
}

/** Collapse read sites into a capped list of endpoints plus their SDK calls. */
function attributeSites(
  sites: readonly ReadSite[],
  map: MethodMap | undefined,
  maxAttribution: number,
): Attribution {
  const endpoints: EndpointRef[] = [];
  const sdkMethods: SdkMethodRef[] = [];
  const seenEndpoint = new Set<string>();
  const seenCall = new Set<string>();

  for (const site of sites) {
    const key = `${site.method} ${site.path}`;
    if (seenEndpoint.has(key)) continue;
    seenEndpoint.add(key);
    if (endpoints.length < maxAttribution) endpoints.push({ method: site.method, path: site.path });

    for (const ref of map ? lookupSdkMethods(map, site.method, site.path) : []) {
      const callKeyStr = `${ref.namespace}.${ref.method}`;
      if (seenCall.has(callKeyStr)) continue;
      seenCall.add(callKeyStr);
      if (sdkMethods.length < maxAttribution) sdkMethods.push(ref);
    }
  }

  return {
    ...(endpoints.length > 0 ? { endpoints } : {}),
    ...(sdkMethods.length > 0 ? { sdkMethods } : {}),
  };
}

/** The dotted paths a caller reads `field` through, across all read sites. */
function readPathsFor(sites: readonly ReadSite[], field: string, max: number): string[] {
  const out = new Set<string>();
  for (const site of sites) {
    out.add(site.prefix === '' ? field : `${site.prefix}.${field}`);
    if (out.size >= max) break;
  }
  return [...out];
}

/** Query/path parameters, shaped like flattened fields so one differ handles both. */
function parameterFields(
  spec: OpenApiSpec,
  op: OperationNode,
  where: NonNullable<ParameterNode['in']>,
): Map<string, FieldInfo> {
  const out = new Map<string, FieldInfo>();
  for (const param of op.parameters ?? []) {
    if (param.in !== where || !param.name) continue;
    out.set(param.name, {
      path: param.name,
      typeSig: typeSignature(spec, param.schema ?? deref(spec, param.schema)),
      required: param.required === true,
      // Query parameters sit at the top level, so required means required.
      requiredPath: param.required === true,
      deprecated: param.deprecated === true,
    });
  }
  return out;
}

interface FieldDiffInput {
  before: Map<string, FieldInfo>;
  after: Map<string, FieldInfo>;
  location: Location;
  direction: Direction;
  path?: string;
  method?: string;
  resource?: string;
  /** Response diffs carry their read sites so field paths can be cited. */
  sites?: readonly ReadSite[];
  maxAttribution?: number;
  extra: Attribution;
}

function diffFields(
  input: FieldDiffInput,
  out: SpecChange[],
  ids: IdAllocator,
  options: DiffOptions,
): void {
  const { before, after, location, direction } = input;

  const base = (): Pick<SpecChange, 'path' | 'method' | 'resource'> => ({
    ...(input.path ? { path: input.path } : {}),
    ...(input.method ? { method: input.method } : {}),
    ...(input.resource ? { resource: input.resource } : {}),
  });

  const paths = (field: string): Pick<SpecChange, 'fieldPaths'> => {
    if (!input.sites) return {};
    const cited = readPathsFor(input.sites, field, input.maxAttribution ?? 12);
    return cited.length > 0 ? { fieldPaths: cited } : {};
  };

  const subject = input.resource ? `${input.resource}.` : '';

  const removed = [...before.keys()].filter((k) => !after.has(k));
  const added = [...after.keys()].filter((k) => !before.has(k));
  const renames = detectRenames(removed, added, before, after);
  const renamedTargets = new Set(renames.values());

  // When `tipping.bgn` goes, so do all its children. Reporting each one
  // separately turns a single removal into five findings on the same line.
  const removedSet = new Set(removed);
  const topLevelRemovals = removed.filter((key) => !hasRemovedAncestor(key, removedSet));

  for (const key of topLevelRemovals) {
    if (!before.get(key)) continue;
    const replacement = renames.get(key);

    out.push({
      id: ids.next(),
      kind: replacement === undefined ? 'removed' : 'renamed',
      severity: 'breaking',
      location,
      ...base(),
      field: key,
      ...(replacement === undefined ? {} : { replacement }),
      note:
        replacement === undefined
          ? `${describe(location)} "${subject}${key}" was removed.`
          : `${describe(location)} "${subject}${key}" was renamed to "${replacement}".`,
      docsUrl: UPGRADE_GUIDE,
      ...paths(key),
      ...input.extra,
    });
  }

  const addedSet = new Set(added);

  for (const key of added) {
    const field = after.get(key);
    if (!field || renamedTargets.has(key)) continue;

    // A newly required request field breaks existing calls — but only those that
    // reach it. A required field inside an optional object binds conditionally,
    // and one inside a parent that is *itself* new cannot break anyone: nobody
    // was sending a parameter that did not exist. That is a new feature, not a
    // new obligation.
    if (field.required && direction === 'request' && !hasRemovedAncestor(key, addedSet)) {
      out.push({
        id: ids.next(),
        kind: 'required',
        severity: 'breaking',
        location,
        ...base(),
        field: key,
        note: requiredNote(describe(location), `${subject}${key}`, field.requiredPath, key, true),
        docsUrl: UPGRADE_GUIDE,
        ...input.extra,
      });
      continue;
    }

    if (options.includeAdditive) {
      out.push({
        id: ids.next(),
        kind: 'added',
        severity: 'additive',
        location,
        ...base(),
        field: key,
        note: `${describe(location)} "${subject}${key}" was added.`,
        docsUrl: DOCS_BASE,
        ...paths(key),
        ...input.extra,
      });
    }
  }

  for (const [key, oldField] of before) {
    const newField = after.get(key);
    if (!newField) continue;

    const verdict = classifyTypeChange(oldField.typeSig, newField.typeSig, direction);
    if (verdict.changed && (verdict.severity === 'breaking' || options.includeAdditive)) {
      out.push({
        id: ids.next(),
        kind: 'typeChanged',
        severity: verdict.severity,
        location,
        ...base(),
        field: key,
        fromType: oldField.typeSig,
        toType: newField.typeSig,
        note: `${describe(location)} "${subject}${key}" ${verdict.detail}.`,
        docsUrl: UPGRADE_GUIDE,
        ...paths(key),
        ...input.extra,
      });
    }

    if (!oldField.required && newField.required && direction === 'request') {
      out.push({
        id: ids.next(),
        kind: 'required',
        severity: 'breaking',
        location,
        ...base(),
        field: key,
        note: requiredNote(describe(location), `${subject}${key}`, newField.requiredPath, key, false),
        docsUrl: UPGRADE_GUIDE,
        ...input.extra,
      });
    }

    if (!oldField.deprecated && newField.deprecated) {
      out.push({
        id: ids.next(),
        kind: 'deprecated',
        severity: 'deprecating',
        location,
        ...base(),
        field: key,
        note: `${describe(location)} "${subject}${key}" is now deprecated.`,
        docsUrl: UPGRADE_GUIDE,
        ...paths(key),
        ...input.extra,
      });
    }
  }
}

/**
 * Pair a removed field with an added one when the evidence is strong.
 *
 * Strong means: same parent object, identical type signature, and no competing
 * candidate. Anything less is reported as a removal plus an addition.
 */
function detectRenames(
  removed: readonly string[],
  added: readonly string[],
  before: Map<string, FieldInfo>,
  after: Map<string, FieldInfo>,
): Map<string, string> {
  const out = new Map<string, string>();
  if (removed.length === 0 || added.length === 0) return out;

  const byParent = (keys: readonly string[]): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const key of keys) {
      const idx = key.lastIndexOf('.');
      const parent = idx === -1 ? '' : key.slice(0, idx);
      let bucket = m.get(parent);
      if (!bucket) {
        bucket = [];
        m.set(parent, bucket);
      }
      bucket.push(key);
    }
    return m;
  };

  const removedByParent = byParent(removed);
  const addedByParent = byParent(added);
  const claimed = new Set<string>();

  for (const [parent, gone] of removedByParent) {
    const arrived = addedByParent.get(parent);
    if (!arrived) continue;

    for (const from of gone) {
      const fromInfo = before.get(from);
      if (!fromInfo) continue;
      const matches = arrived.filter((to) => {
        if (claimed.has(to)) return false;
        const toInfo = after.get(to);
        if (toInfo === undefined || toInfo.typeSig !== fromInfo.typeSig) return false;
        return namesLookRelated(leaf(from), leaf(to));
      });
      // One type-compatible candidate, and the swap is unambiguous at this
      // parent — otherwise we would be guessing which field became which.
      if (matches.length === 1 && (gone.length === 1 || arrived.length === 1)) {
        const to = matches[0] as string;
        out.set(from, to);
        claimed.add(to);
      }
    }
  }
  return out;
}

/**
 * Phrase a "now required" note honestly.
 *
 * Most newly-required Stripe parameters live inside an optional object, so they
 * are only mandatory for callers who send that object. Saying "is now required"
 * flat out would be a false alarm for everyone else; naming the condition lets
 * the reader tell instantly whether it applies to them.
 */
function requiredNote(
  label: string,
  display: string,
  requiredPath: boolean,
  fieldPath: string,
  isNew: boolean,
): string {
  const verb = isNew ? 'is new and required' : 'is now required';
  if (requiredPath) return `${label} "${display}" ${verb}.`;

  const idx = fieldPath.lastIndexOf('.');
  const parent = idx === -1 ? null : fieldPath.slice(0, idx).replace(/\[\]$/, '');
  return parent === null
    ? `${label} "${display}" ${verb}.`
    : `${label} "${display}" ${verb} whenever "${parent}" is provided.`;
}

/**
 * True when some ancestor of `path` is in the set. Used both for removals (a
 * removed parent makes its children's removal redundant) and additions (an added
 * parent makes its children's required-ness additive).
 */
function hasRemovedAncestor(path: string, removed: ReadonlySet<string>): boolean {
  let cursor = path;
  for (;;) {
    const idx = cursor.lastIndexOf('.');
    if (idx === -1) return false;
    cursor = cursor.slice(0, idx);
    // A parent may be recorded with or without its array marker.
    if (removed.has(cursor) || removed.has(cursor.replace(/\[\]$/, ''))) return true;
  }
}

function leaf(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Guard against pairing two unrelated fields that merely share a type.
 *
 * Without this, a tipping config dropping the `bgn` currency and adding `gip`
 * reads as "rename bgn to gip", which is nonsense and would send someone to the
 * wrong field. A real rename keeps most of the name: either one contains the
 * other (`risk_level` -> `level`) or they differ by a small edit.
 */
function namesLookRelated(a: string, b: string): boolean {
  if (a === b) return true;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.includes(y) || y.includes(x)) return true;

  // Shared token, e.g. `card_expiry_year` -> `expiry_year_card`.
  const tokens = (s: string): Set<string> => new Set(s.split(/[._-]/).filter((t) => t.length > 2));
  const ta = tokens(x);
  const tb = tokens(y);
  for (const t of ta) if (tb.has(t)) return true;

  const longer = Math.max(x.length, y.length);
  if (longer < 5) return false; // too short for edit distance to mean anything
  return editDistance(x, y) / longer <= 0.34;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (row[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = row;
  }
  return prev[b.length] as number;
}

function describe(location: Location): string {
  switch (location) {
    case 'requestBody':
      return 'Request parameter';
    case 'queryParam':
      return 'Query parameter';
    case 'pathParam':
      return 'Path parameter';
    case 'response':
      return 'Response field';
    case 'event':
      return 'Webhook event';
    case 'operation':
      return 'Endpoint';
  }
}

function byImpact(a: SpecChange, b: SpecChange): number {
  const rank = { breaking: 0, deprecating: 1, additive: 2 } as const;
  if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
  const aKey = a.path ?? a.resource ?? a.event ?? '';
  const bKey = b.path ?? b.resource ?? b.event ?? '';
  return aKey.localeCompare(bKey) || (a.field ?? '').localeCompare(b.field ?? '');
}

/** Sequential, stable ids scoped to the target version. */
class IdAllocator {
  private n = 0;
  constructor(private readonly version: string) {}
  next(): string {
    this.n += 1;
    return `stripe-${this.version}-${String(this.n).padStart(4, '0')}`;
  }
}
