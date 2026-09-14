import type { Severity } from '../changeset/types.js';

/**
 * Whether a type change actually breaks anything depends on which way the data
 * flows.
 *
 * Adding a value to a request enum is additive — you could not have been sending
 * it before. Removing one is breaking, because a value you do send stops being
 * accepted. For responses it is the mirror image: a new variant is something
 * your `switch` may not handle, but it does not make correct code incorrect, so
 * it stays additive rather than crying wolf.
 */
export type Direction = 'request' | 'response';

export interface TypeVerdict {
  changed: boolean;
  severity: Severity;
  /** Short human phrase describing the change, e.g. "no longer accepts a, b". */
  detail: string;
}

const SET_SIG = /^(enum|union)\((.*)\)$/;
const ARRAY_SIG = /^array<(.*)>$/;

/** Split on `|` at depth zero only, so `union(array<enum(a|b)>|string)` has two members. */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(' || ch === '<') depth += 1;
    else if (ch === ')' || ch === '>') depth -= 1;
    if (ch === '|' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '' || out.length > 0) out.push(current);
  return out.filter((m) => m !== '');
}

function setMembers(sig: string): { kind: 'enum' | 'union'; members: Set<string> } | null {
  const m = SET_SIG.exec(sig);
  if (!m) return null;
  const kind = m[1] as 'enum' | 'union';
  return { kind, members: new Set(splitTopLevel(m[2] ?? '')) };
}

function list(values: readonly string[], max = 6): string {
  if (values.length <= max) return values.join(', ');
  return `${values.slice(0, max).join(', ')} and ${values.length - max} more`;
}

const UNCHANGED: TypeVerdict = { changed: false, severity: 'additive', detail: '' };

/** `string:currency` -> `string`. A format is documentation, not a wire type. */
function baseType(sig: string): string {
  return /^[a-z]+:[a-z0-9_-]+$/i.test(sig) ? (sig.split(':')[0] as string) : sig;
}

/**
 * What a member "is", ignoring its contents, so two versions of the same member
 * can be paired up: `array<enum(a|b)>` and `array<enum(a|b|c)>` are both
 * `array<enum>`; `object(x)` and `object(y)` are both `object`.
 */
function memberShape(sig: string): string {
  return sig
    .replace(/object\([^)]*\)/g, 'object')
    .replace(/enum\([^)]*\)/g, 'enum')
    .replace(/:[a-z0-9_-]+/gi, '');
}

export function classifyTypeChange(
  fromSig: string,
  toSig: string,
  direction: Direction,
): TypeVerdict {
  if (fromSig === toSig) return UNCHANGED;

  // Format annotations come and go (`string` -> `string:currency`); the wire
  // type did not change.
  if (baseType(fromSig) === baseType(toSig)) return UNCHANGED;

  // A free-form string becoming an enum restricts what a sender may pass, but
  // for a reader it only documents values that were always from that set.
  if (baseType(fromSig) === 'string' && /^enum\(/.test(toSig)) {
    return direction === 'request'
      ? { changed: true, severity: 'breaking', detail: `now restricted to ${toSig}` }
      : UNCHANGED;
  }

  // The old type is still one of the new type's members: pure widening, e.g. an
  // id string that can now also arrive expanded as an object.
  const toSet = setMembers(toSig);
  if (toSet && toSet.kind === 'union' && [...toSet.members].some((m) => baseType(m) === baseType(fromSig))) {
    return { changed: true, severity: 'additive', detail: `can now also be ${toSig}` };
  }

  // `array<enum(a|b)>` -> `array<enum(a|b|c)>`: the array is the same array;
  // what changed is its element type, so judge that. Without this, every
  // monthly growth of an enum-in-array (webhook events, payment method types)
  // read as a breaking type change.
  const fromArray = ARRAY_SIG.exec(fromSig);
  const toArray = ARRAY_SIG.exec(toSig);
  if (fromArray && toArray) {
    const inner = classifyTypeChange(fromArray[1] ?? '', toArray[1] ?? '', direction);
    return inner.changed ? { ...inner, detail: `items ${inner.detail}` } : inner;
  }

  const before = setMembers(fromSig);
  const after = setMembers(toSig);

  if (before && after && before.kind === after.kind) {
    let removed = [...before.members].filter((v) => !after.members.has(v)).sort();
    let added = [...after.members].filter((v) => !before.members.has(v)).sort();

    if (removed.length === 0 && added.length === 0) return UNCHANGED;

    // Union members that merely changed inside (`array<enum(a|b)>` ->
    // `array<enum(a|b|c)>`) are the same member, not a removal plus an
    // addition. Pair them by shape, judge each pair, and only what is left
    // unpaired counts as removed or added.
    if (before.kind === 'union') {
      let worst: TypeVerdict | null = null;
      const unpairedRemoved: string[] = [];
      for (const gone of removed) {
        const idx = added.findIndex((a) => memberShape(a) === memberShape(gone));
        if (idx === -1) {
          unpairedRemoved.push(gone);
          continue;
        }
        const partner = added[idx] as string;
        added = added.filter((_, i) => i !== idx);
        const verdict = classifyTypeChange(gone, partner, direction);
        if (verdict.changed && (worst === null || (verdict.severity === 'breaking' && worst.severity !== 'breaking'))) {
          worst = verdict;
        }
      }
      removed = unpairedRemoved;
      if (removed.length === 0 && added.length === 0) {
        return worst ?? UNCHANGED;
      }
      if (worst?.severity === 'breaking') return worst;
    }

    if (removed.length === 0) {
      // Pure widening.
      return direction === 'request'
        ? { changed: true, severity: 'additive', detail: `now also accepts ${list(added)}` }
        : { changed: true, severity: 'additive', detail: `can now also return ${list(added)}` };
    }

    if (direction === 'request') {
      return {
        changed: true,
        severity: 'breaking',
        detail:
          added.length > 0
            ? `no longer accepts ${list(removed)} (and now accepts ${list(added)})`
            : `no longer accepts ${list(removed)}`,
      };
    }

    // A response value that disappears only leaves a dead branch behind.
    return {
      changed: true,
      severity: 'additive',
      detail:
        added.length > 0
          ? `no longer returns ${list(removed)}; can now return ${list(added)}`
          : `no longer returns ${list(removed)}`,
    };
  }

  // Anything else — scalar swap, object becoming an array, a ref changing
  // identity — is a genuine incompatibility in both directions.
  return {
    changed: true,
    severity: 'breaking',
    detail: `changed from ${fromSig} to ${toSig}`,
  };
}
