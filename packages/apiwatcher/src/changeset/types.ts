/**
 * The changeset is the contract between the spec watcher and the scanner.
 * Everything else in this repo either produces one of these or consumes one.
 *
 * Keep it boring and additive. A changeset committed today must still parse in
 * a year, because customers pin old versions of the CLI.
 */

export const SCHEMA_VERSION = 1 as const;

/** What kind of change happened in the spec. */
export type ChangeKind =
  | 'removed' // the thing is gone
  | 'renamed' // same thing, new name (has `replacement`)
  | 'typeChanged' // same name, incompatible type
  | 'required' // a param that used to be optional is now required
  | 'deprecated' // still works, will stop working
  | 'added'; // purely additive, informational

/**
 * How much the change can hurt.
 *
 * `breaking` means existing correct code becomes incorrect. `deprecating` means
 * it still works today. `additive` never breaks anything and is reported only
 * so the changelog is complete.
 */
export type Severity = 'breaking' | 'deprecating' | 'additive';

/** Where in the request/response the changed field lives. */
export type Location =
  | 'requestBody'
  | 'queryParam'
  | 'pathParam'
  | 'response'
  | 'operation' // the endpoint itself, not a field on it
  | 'event'; // a webhook event type

export interface SpecChange {
  /** Stable id: `<api>-<toVersion>-<nnn>`. Used to dedupe and to ignore. */
  id: string;
  kind: ChangeKind;
  severity: Severity;
  location: Location;

  /** Endpoint path, e.g. `/v1/customers/{customer}`. Absent for event changes. */
  path?: string;
  /** Lowercase HTTP method, e.g. `post`. Absent for event changes. */
  method?: string;
  /** Resource schema this change belongs to, e.g. `payment_intent`. */
  resource?: string;

  /**
   * Dotted field path within `location`, e.g. `card.exp_year`. Absent when the
   * change is to the operation itself.
   */
  field?: string;
  /** For `renamed`, the new name. For `removed`, a suggested stand-in if one exists. */
  replacement?: string;

  /** For `typeChanged`. Free-form OpenAPI type descriptions. */
  fromType?: string;
  toType?: string;

  /** Webhook event type, e.g. `invoice.payment_failed`. Only for `location: 'event'`. */
  event?: string;

  /** One line, human-readable. Shown verbatim in the report. */
  note: string;
  docsUrl?: string;

  /**
   * SDK call sites this change can reach, precomputed at diff time so the
   * scanner never has to resolve endpoints itself.
   */
  sdkMethods?: SdkMethodRef[];

  /**
   * Response changes are diffed once per resource schema, then attributed to
   * every endpoint that returns it. These are the endpoints affected.
   */
  endpoints?: EndpointRef[];

  /**
   * Dotted paths a caller would actually read the changed field through, e.g.
   * `refunds.data[].destination_details` for a change on the `refund` schema.
   * `field` stays relative to the owning resource; these are what call sites
   * look like.
   */
  fieldPaths?: string[];
}

export interface EndpointRef {
  /** Lowercase HTTP method. */
  method: string;
  path: string;
}

export interface SdkMethodRef {
  /** Dotted accessor on the client, e.g. `paymentIntents` or `checkout.sessions`. */
  namespace: string;
  /** Method name, e.g. `create`. */
  method: string;
}

export interface Changeset {
  schemaVersion: typeof SCHEMA_VERSION;
  api: 'stripe';
  /** Version the diff starts from, e.g. `2025-09-30.clover`. */
  from: string;
  /** Version the diff ends at. */
  to: string;
  /** ISO date the changeset was generated. */
  generatedAt: string;
  /** Provenance, so a suspicious entry can be traced back to a spec commit. */
  source?: {
    repo: string;
    fromRef: string;
    toRef: string;
  };
  changes: SpecChange[];
}

/** Ordering used everywhere a list of changes is displayed. */
export const SEVERITY_RANK: Record<Severity, number> = {
  breaking: 0,
  deprecating: 1,
  additive: 2,
};

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}
