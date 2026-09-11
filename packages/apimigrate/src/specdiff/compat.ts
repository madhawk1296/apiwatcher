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

const SET_SIG = /^(enum|union)\(([^)]*)\)$/;

function setMembers(sig: string): { kind: 'enum' | 'union'; members: Set<string> } | null {
  const m = SET_SIG.exec(sig);
  if (!m) return null;
  const kind = m[1] as 'enum' | 'union';
  const body = m[2] ?? '';
  return { kind, members: new Set(body === '' ? [] : body.split('|')) };
}

function list(values: readonly string[], max = 6): string {
  if (values.length <= max) return values.join(', ');
  return `${values.slice(0, max).join(', ')} and ${values.length - max} more`;
}

export function classifyTypeChange(
  fromSig: string,
  toSig: string,
  direction: Direction,
): TypeVerdict {
  if (fromSig === toSig) return { changed: false, severity: 'additive', detail: '' };

  const before = setMembers(fromSig);
  const after = setMembers(toSig);

  if (before && after && before.kind === after.kind) {
    const removed = [...before.members].filter((v) => !after.members.has(v)).sort();
    const added = [...after.members].filter((v) => !before.members.has(v)).sort();

    if (removed.length === 0 && added.length === 0) {
      return { changed: false, severity: 'additive', detail: '' };
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
