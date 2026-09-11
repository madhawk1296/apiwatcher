/**
 * What the scanner produces. Every finding carries evidence — file, line,
 * snippet — because a report a customer cannot verify is a report they will not
 * act on.
 */

export type UsageKind =
  | 'sdkCall' // stripe.paymentIntents.create(...)
  | 'rawUrl' // fetch('https://api.stripe.com/v1/charges')
  | 'responseField' // intent.amount_received
  | 'requestParam' // { amount: 1000 } passed to a known call
  | 'webhookEvent' // case 'invoice.payment_failed':
  | 'clientInit'; // new Stripe(key, { apiVersion })

export interface Evidence {
  /** Repo-relative path, POSIX separators. */
  file: string;
  /** 1-indexed. */
  line: number;
  column: number;
  /** The source line, trimmed. Truncated to keep reports readable. */
  snippet: string;
}

export interface Usage {
  kind: UsageKind;
  evidence: Evidence;
  /** 0..1. Deterministic matches are 1; inferred ones are lower. */
  confidence: number;

  /** For `sdkCall`: dotted accessor, e.g. `checkout.sessions`. */
  namespace?: string;
  /** For `sdkCall`: the method, e.g. `create`. */
  method?: string;
  /** Resolved endpoint, when known. */
  httpMethod?: string;
  path?: string;

  /** For `responseField` / `requestParam`: the dotted field path touched. */
  field?: string;
  /** For `webhookEvent`: the event type string. */
  event?: string;

  /**
   * How the Stripe client was reached, e.g. `stripe` or `payments.client`.
   * Useful when a repo wraps the SDK and the call site does not say "stripe".
   */
  via?: string;

  /**
   * Ties a `requestParam` or destructured `responseField` back to the
   * `sdkCall` it came from. Lets the report tell "this call already passes the
   * newly-required field" apart from "this call needs updating".
   */
  callId?: string;
}

export interface DetectedVersion {
  /** The pinned `apiVersion`, if the client config sets one. */
  apiVersion?: string;
  /** Where the pin was found. */
  apiVersionEvidence?: Evidence;
  /** Version range from package.json, e.g. `^18.0.0`. */
  sdkRange?: string;
  /** Exact installed version from the lockfile, when resolvable. */
  sdkInstalled?: string;
  /** The `apiVersion` the installed SDK defaults to, if we can read it. */
  sdkDefaultApiVersion?: string;
}

export interface ScanResult {
  root: string;
  /** Files actually parsed. */
  filesScanned: number;
  usages: Usage[];
  version: DetectedVersion;
  /** Client variables the scanner resolved, for transparency in the report. */
  clients: ClientBinding[];
  warnings: string[];
}

export interface ClientBinding {
  /** Local identifier bound to a Stripe client, e.g. `stripe`. */
  name: string;
  file: string;
  line: number;
  /** How we concluded it is a Stripe client. */
  reason: 'newStripe' | 'importedDefault' | 'reexport' | 'wrapperProperty';
}
