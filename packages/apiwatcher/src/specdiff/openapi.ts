/**
 * Just enough OpenAPI to diff Stripe's spec. Deliberately not a general-purpose
 * OpenAPI library: Stripe's spec is consistent, so the narrow reader stays
 * small and fast over a 10MB document.
 */

export interface SchemaNode {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  enum?: unknown[];
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
  nullable?: boolean;
  deprecated?: boolean;
  format?: string;
  description?: string;
  additionalProperties?: boolean | SchemaNode;
  'x-expandableFields'?: string[];
  'x-resourceId'?: string;
  'x-stripeOperations'?: StripeOperation[];
  'x-stripeResource'?: { class_name?: string; in_package?: string };
  'x-stripeEvent'?: { type?: string };
}

export interface StripeOperation {
  method_name?: string;
  method_on?: string;
  method_type?: string;
  operation?: string;
  path?: string;
}

export interface ParameterNode {
  name?: string;
  in?: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  deprecated?: boolean;
  schema?: SchemaNode;
  description?: string;
}

export interface OperationNode {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: ParameterNode[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: SchemaNode }>;
  };
  responses?: Record<string, { content?: Record<string, { schema?: SchemaNode }> }>;
}

export interface OpenApiSpec {
  openapi?: string;
  info?: { version?: string; title?: string };
  paths: Record<string, Record<string, OperationNode | unknown>>;
  components?: { schemas?: Record<string, SchemaNode> };
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export function isHttpMethod(key: string): key is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(key);
}

/** Every (path, method, operation) triple in the spec. */
export function* operations(
  spec: OpenApiSpec,
): Generator<{ path: string; method: HttpMethod; op: OperationNode }> {
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const [key, value] of Object.entries(item)) {
      if (!isHttpMethod(key)) continue;
      if (!value || typeof value !== 'object') continue;
      yield { path, method: key, op: value as OperationNode };
    }
  }
}

export function refName(ref: string): string | null {
  const prefix = '#/components/schemas/';
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

export function deref(spec: OpenApiSpec, node: SchemaNode | undefined): SchemaNode | undefined {
  let current = node;
  // Chained refs are rare but cheap to guard against.
  for (let i = 0; current?.$ref && i < 10; i++) {
    const name = refName(current.$ref);
    if (name === null) return undefined;
    current = spec.components?.schemas?.[name];
  }
  return current;
}

/** Stripe uses form encoding for requests and JSON for responses. */
export function requestSchema(spec: OpenApiSpec, op: OperationNode): SchemaNode | undefined {
  const content = op.requestBody?.content;
  if (!content) return undefined;
  const media =
    content['application/x-www-form-urlencoded'] ??
    content['application/json'] ??
    content['multipart/form-data'] ??
    Object.values(content)[0];
  return deref(spec, media?.schema);
}

export function responseSchema(spec: OpenApiSpec, op: OperationNode): SchemaNode | undefined {
  const ok = op.responses?.['200'] ?? op.responses?.['201'] ?? op.responses?.['default'];
  const media = ok?.content?.['application/json'] ?? Object.values(ok?.content ?? {})[0];
  return deref(spec, media?.schema);
}

/**
 * A stable, comparable description of a schema's type.
 *
 * Two fields with equal signatures are wire-compatible for our purposes. Object
 * children are not inlined — the flattener emits them as their own entries — so
 * a nested rename shows up at its own path rather than as a type change on the
 * parent.
 */
export function typeSignature(
  spec: OpenApiSpec,
  node: SchemaNode | undefined,
  refStack: ReadonlySet<string> = new Set(),
  depth = 0,
): string {
  if (!node) return 'unknown';
  if (depth > 6) return 'deep';

  if (node.$ref) {
    const name = refName(node.$ref);
    if (name === null) return 'unknown';
    if (refStack.has(name)) return `ref(${name})`;
    const next = new Set(refStack);
    next.add(name);
    const target = spec.components?.schemas?.[name];
    // Name the ref rather than inlining it: a resource swapping identity is a
    // change we want to see, and inlining 1000 properties is pointless here.
    const inner = typeSignature(spec, target, next, depth + 1);
    return inner === 'object' ? `object(${name})` : inner;
  }

  const union = node.anyOf ?? node.oneOf;
  if (union && union.length > 0) {
    const parts = union.map((m) => typeSignature(spec, m, refStack, depth + 1)).sort();
    return parts.length === 1 ? (parts[0] as string) : `union(${[...new Set(parts)].join('|')})`;
  }

  if (node.allOf && node.allOf.length > 0) {
    const parts = node.allOf.map((m) => typeSignature(spec, m, refStack, depth + 1)).sort();
    return `all(${[...new Set(parts)].join('&')})`;
  }

  if (node.enum && node.enum.length > 0) {
    const values = node.enum.map((v) => String(v)).sort();
    return `enum(${values.join('|')})`;
  }

  const type = Array.isArray(node.type) ? node.type.slice().sort().join('|') : node.type;

  if (type === 'array') return `array<${typeSignature(spec, node.items, refStack, depth + 1)}>`;
  if (type === 'object' || node.properties) return 'object';
  if (type === undefined) return 'unknown';
  return node.format ? `${type}:${node.format}` : type;
}

export interface FieldInfo {
  /** Dotted path, e.g. `card.exp_year` or `lines.data[].amount`. */
  path: string;
  typeSig: string;
  /** Listed in its immediate parent's `required` array. */
  required: boolean;
  /**
   * Required *and* every ancestor is too — i.e. genuinely mandatory on every
   * request. A field marked required inside an optional object only binds when
   * the caller sends that object, which is a much weaker claim.
   */
  requiredPath: boolean;
  deprecated: boolean;
  /** Name of the resource schema the field was reached through, if any. */
  viaResource?: string;
}

export interface FlattenOptions {
  /** How deep to descend into nested objects. Stripe responses nest a long way. */
  maxDepth?: number;
  /** Hard cap so one pathological schema cannot stall a diff. */
  maxFields?: number;
}

/**
 * Flatten a schema into dotted field paths.
 *
 * Arrays contribute a `[]` segment so `lines.data[].amount` is distinguishable
 * from `lines.data.amount`. Recursion through a `$ref` already on the current
 * branch stops, which is what keeps Stripe's mutually recursive resources finite.
 */
export function flattenSchema(
  spec: OpenApiSpec,
  root: SchemaNode | undefined,
  options: FlattenOptions = {},
): Map<string, FieldInfo> {
  const maxDepth = options.maxDepth ?? 4;
  const maxFields = options.maxFields ?? 4000;
  const out = new Map<string, FieldInfo>();
  if (!root) return out;

  const visit = (
    node: SchemaNode | undefined,
    prefix: string,
    depth: number,
    refStack: ReadonlySet<string>,
    viaResource: string | undefined,
  ): void => {
    if (!node || depth > maxDepth || out.size >= maxFields) return;

    if (node.$ref) {
      const name = refName(node.$ref);
      if (name === null || refStack.has(name)) return;
      const next = new Set(refStack);
      next.add(name);
      visit(spec.components?.schemas?.[name], prefix, depth, next, viaResource ?? name);
      return;
    }

    for (const member of [...(node.allOf ?? []), ...(node.anyOf ?? []), ...(node.oneOf ?? [])]) {
      visit(member, prefix, depth, refStack, viaResource);
    }

    const itemType = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    if (itemType.includes('array') && node.items) {
      visit(node.items, `${prefix}[]`, depth, refStack, viaResource);
    }

    const props = node.properties;
    if (!props) return;
    const required = new Set(node.required ?? []);

    for (const [name, child] of Object.entries(props)) {
      if (out.size >= maxFields) return;
      const path = prefix === '' ? name : `${prefix}.${name}`;
      const resolved = child.$ref ? deref(spec, child) : child;

      if (!out.has(path)) {
        out.set(path, {
          path,
          typeSig: typeSignature(spec, child, refStack),
          required: required.has(name),
          requiredPath: required.has(name),
          deprecated: child.deprecated === true || resolved?.deprecated === true,
          ...(viaResource ? { viaResource } : {}),
        });
      }
      visit(child, path, depth + 1, refStack, viaResource);
    }
  };

  visit(root, '', 0, new Set(), root['x-resourceId']);
  return out;
}

/**
 * Flatten a schema treating every `$ref` as a boundary.
 *
 * This is what makes the diff stable. Expanding refs produces field sets that
 * depend on traversal order and on which refs happen to be on the current
 * branch, so two independently expanded trees disagree in thousands of places
 * for reasons that have nothing to do with the API changing. Stopping at refs
 * means every component schema is diffed exactly once, on its own terms, and a
 * nested resource's changes are reported against that resource.
 */
export function flattenOwnFields(
  spec: OpenApiSpec,
  root: SchemaNode | undefined,
  options: { maxDepth?: number } = {},
): Map<string, FieldInfo> {
  const maxDepth = options.maxDepth ?? 3;
  const out = new Map<string, FieldInfo>();
  if (!root) return out;

  const visit = (
    node: SchemaNode | undefined,
    prefix: string,
    depth: number,
    parentRequired: boolean,
  ): void => {
    if (!node || depth > maxDepth) return;

    // Only compose in-place members; a `$ref` child is someone else's schema.
    for (const member of [...(node.allOf ?? []), ...(node.anyOf ?? []), ...(node.oneOf ?? [])]) {
      if (member.$ref) continue;
      visit(member, prefix, depth, parentRequired);
    }

    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    if (types.includes('array') && node.items && !node.items.$ref) {
      visit(node.items, `${prefix}[]`, depth, parentRequired);
    }

    const props = node.properties;
    if (!props) return;
    const required = new Set(node.required ?? []);

    for (const [name, child] of Object.entries(props)) {
      const path = prefix === '' ? name : `${prefix}.${name}`;
      const requiredHere = required.has(name);
      if (!out.has(path)) {
        out.set(path, {
          path,
          typeSig: typeSignature(spec, child),
          required: requiredHere,
          requiredPath: parentRequired && requiredHere,
          deprecated: child.deprecated === true,
        });
      }
      if (!child.$ref) visit(child, path, depth + 1, parentRequired && requiredHere);
    }
  };

  visit(root, '', 0, true);
  return out;
}

/** A place in a response where some schema shows up. */
export interface ReadSite {
  method: HttpMethod;
  path: string;
  /** Dotted prefix from the response root, `''` when the schema is the root. */
  prefix: string;
}

/**
 * For every component schema, where a caller would read it from.
 *
 * Computed on a single spec — it is attribution metadata, never a diff input —
 * so it can follow refs freely without destabilising anything. This is what lets
 * "`refund.foo` was removed" cite `charge.refunds.data[].foo` at the call site
 * that actually reads it.
 */
export function buildReadSites(spec: OpenApiSpec, maxDepth = 3): Map<string, ReadSite[]> {
  const out = new Map<string, ReadSite[]>();

  const add = (schemaName: string, site: ReadSite): void => {
    let bucket = out.get(schemaName);
    if (!bucket) {
      bucket = [];
      out.set(schemaName, bucket);
    }
    // Many endpoints return the same resource at the same prefix; keep it small.
    if (bucket.length < 40) bucket.push(site);
  };

  for (const { path, method, op } of operations(spec)) {
    const rootNode = op.responses?.['200']?.content?.['application/json']?.schema;
    if (!rootNode) continue;

    const walk = (node: SchemaNode | undefined, prefix: string, depth: number, seen: ReadonlySet<string>): void => {
      if (!node || depth > maxDepth) return;

      if (node.$ref) {
        const name = refName(node.$ref);
        if (name === null || seen.has(name)) return;
        add(name, { method, path, prefix });
        const next = new Set(seen);
        next.add(name);
        walk(spec.components?.schemas?.[name], prefix, depth, next);
        return;
      }

      for (const member of [...(node.allOf ?? []), ...(node.anyOf ?? []), ...(node.oneOf ?? [])]) {
        walk(member, prefix, depth, seen);
      }

      const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
      if (types.includes('array') && node.items) walk(node.items, `${prefix}[]`, depth, seen);

      for (const [name, child] of Object.entries(node.properties ?? {})) {
        walk(child, prefix === '' ? name : `${prefix}.${name}`, depth + 1, seen);
      }
    };

    walk(rootNode, '', 0, new Set());
  }

  return out;
}

/**
 * Webhook event types -> the schema that declares them.
 *
 * In Stripe's SDK spec the schema name and the event type are the same string
 * (`invoice.payment_failed`), but read `x-stripeEvent.type` as the authority and
 * fall back to the key.
 */
export function eventTypes(spec: OpenApiSpec): Map<string, string> {
  const out = new Map<string, string>();
  const schemas = spec.components?.schemas ?? {};
  for (const [name, schema] of Object.entries(schemas)) {
    const ev = schema['x-stripeEvent'];
    if (!ev || typeof ev !== 'object') continue;
    const type = typeof ev.type === 'string' && ev.type !== '' ? ev.type : name;
    out.set(type, name);
  }
  return out;
}
