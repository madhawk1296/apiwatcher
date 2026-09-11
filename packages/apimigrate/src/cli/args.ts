/**
 * A tiny flag parser. The CLI surface is small and stable, so a dependency
 * would cost more than it saves — and `npx apimigrate` should install fast.
 */

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (token === '--') {
      positionals.push(...argv.slice(i + 1).filter((t): t is string => t !== undefined));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (body.startsWith('no-')) {
        flags.set(body.slice(3), false);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags.set(body, next);
        i += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      // Short flags are only used for -h and -v.
      flags.set(token.slice(1), true);
      continue;
    }

    if (command === null) command = token;
    else positionals.push(token);
  }

  return { command, positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean | undefined {
  const value = args.flags.get(name);
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`--${name} must be a number, got "${value}"`);
  return n;
}

export function flagList(args: ParsedArgs, name: string): string[] | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
