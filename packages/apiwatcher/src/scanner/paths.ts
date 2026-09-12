import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * tsconfig `paths` support.
 *
 * Alias imports (`@/lib/stripe`) are the norm in Next.js and most modern
 * TypeScript setups. Without this, the client defined in an aliased module never
 * links to its call sites, and every one of them falls back to a name-based
 * guess at lower confidence.
 */

export interface PathAliases {
  /** Absolute directory that non-relative paths resolve against. */
  baseUrl: string;
  /** Pattern -> candidate substitutions, both as written in tsconfig. */
  paths: Array<{ prefix: string; suffix: string; targets: string[] }>;
}

interface TsConfigShape {
  extends?: string;
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

/**
 * tsconfig is JSONC — comments and trailing commas are legal.
 *
 * TypeScript is already a dependency and its own parser is the authority here, so
 * use it rather than trying to strip comments with regexes.
 */
function parseJsonc(fileName: string, text: string): TsConfigShape | null {
  const { config, error } = ts.parseConfigFileTextToJson(fileName, text);
  if (error || typeof config !== 'object' || config === null) return null;
  return config as TsConfigShape;
}

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];

/**
 * Read path aliases for a scan root, following a single `extends` hop.
 *
 * Deliberately shallow: deep config inheritance chains are rare and a wrong
 * alias only costs us a lower-confidence match, never a wrong one.
 */
export async function loadPathAliases(root: string): Promise<PathAliases | null> {
  for (const name of CONFIG_NAMES) {
    const file = join(root, name);
    if (!existsSync(file)) continue;

    let config: TsConfigShape | null;
    try {
      config = parseJsonc(file, await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!config) continue;

    let options = config.compilerOptions ?? {};

    // One `extends` hop, for the common "extends ../../tsconfig.base.json" case.
    if (config.extends && config.extends.startsWith('.')) {
      const parentPath = resolve(dirname(file), config.extends);
      for (const candidate of [parentPath, `${parentPath}.json`]) {
        if (!existsSync(candidate)) continue;
        try {
          const parent = parseJsonc(candidate, await readFile(candidate, 'utf8'));
          if (parent?.compilerOptions) {
            options = { ...parent.compilerOptions, ...options };
            if (parent.compilerOptions.paths && !config.compilerOptions?.paths) {
              options.paths = parent.compilerOptions.paths;
            }
          }
        } catch {
          // A broken parent config is not fatal.
        }
        break;
      }
    }

    if (!options.paths || Object.keys(options.paths).length === 0) continue;

    const baseUrl = resolve(dirname(file), options.baseUrl ?? '.');
    const paths: PathAliases['paths'] = [];
    for (const [pattern, targets] of Object.entries(options.paths)) {
      if (!Array.isArray(targets)) continue;
      const star = pattern.indexOf('*');
      paths.push(
        star === -1
          ? { prefix: pattern, suffix: '', targets }
          : { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), targets },
      );
    }
    // Longest prefix first, mirroring how TypeScript picks a match.
    paths.sort((a, b) => b.prefix.length - a.prefix.length);
    return { baseUrl, paths };
  }
  return null;
}

/**
 * Map workspace package names to their directories.
 *
 * In a monorepo the Stripe client usually lives in one package and is imported by
 * name (`@acme/lib/server-only/stripe`) from several others. Without this the
 * client never links to those call sites, which is most of them.
 *
 * Globs are handled shallowly — one `*` level, which covers `packages/*` and
 * `apps/*` — because that is what workspace layouts actually use.
 */
export async function loadWorkspacePackages(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rootPkg = join(root, 'package.json');
  if (!existsSync(rootPkg)) return out;

  let patterns: string[] = [];
  try {
    const parsed = JSON.parse(await readFile(rootPkg, 'utf8')) as {
      workspaces?: string[] | { packages?: string[] };
      name?: string;
    };
    const ws = parsed.workspaces;
    patterns = Array.isArray(ws) ? ws : (ws?.packages ?? []);
  } catch {
    return out;
  }

  // pnpm keeps its globs in a separate file.
  const pnpmFile = join(root, 'pnpm-workspace.yaml');
  if (patterns.length === 0 && existsSync(pnpmFile)) {
    try {
      const text = await readFile(pnpmFile, 'utf8');
      for (const line of text.split('\n')) {
        const m = /^\s*-\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
        if (m?.[1]) patterns.push(m[1]);
      }
    } catch {
      // fall through
    }
  }
  if (patterns.length === 0) return out;

  const { readdir } = await import('node:fs/promises');

  const dirsFor = async (pattern: string): Promise<string[]> => {
    const clean = pattern.replace(/\/$/, '');
    const star = clean.indexOf('*');
    if (star === -1) return [clean];
    const parent = clean.slice(0, star).replace(/\/$/, '');
    try {
      const entries = await readdir(join(root, parent), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => `${parent}/${e.name}`);
    } catch {
      return [];
    }
  };

  for (const pattern of patterns) {
    for (const dir of await dirsFor(pattern)) {
      const pkgFile = join(root, dir, 'package.json');
      if (!existsSync(pkgFile)) continue;
      try {
        const { name } = JSON.parse(await readFile(pkgFile, 'utf8')) as { name?: string };
        if (typeof name === 'string' && name !== '') out.set(name, dir);
      } catch {
        // A package without a readable manifest is not addressable by name.
      }
    }
  }
  return out;
}

/**
 * Expand an alias import into candidate repo-relative paths (no extension).
 * Returns an empty array when the specifier matches no alias.
 */
export function expandAlias(aliases: PathAliases | null, root: string, specifier: string): string[] {
  if (!aliases) return [];

  const out: string[] = [];
  for (const { prefix, suffix, targets } of aliases.paths) {
    if (!specifier.startsWith(prefix)) continue;
    if (suffix !== '' && !specifier.endsWith(suffix)) continue;

    const middle = specifier.slice(prefix.length, suffix === '' ? undefined : specifier.length - suffix.length);

    for (const target of targets) {
      const substituted = target.includes('*') ? target.replace('*', middle) : target;
      const absolute = resolve(aliases.baseUrl, substituted);
      const rel = relative(root, absolute).split(sep).join('/');
      // Outside the scan root: not something we can match to a scanned file.
      if (rel.startsWith('..')) continue;
      out.push(rel);
    }
    if (out.length > 0) return out;
  }
  return out;
}
