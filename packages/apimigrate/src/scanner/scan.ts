import { dirname, resolve } from 'node:path';
import ts from 'typescript';

import { scanFile, parseSource, type ClientExports } from './ast.js';
import { collectSourceFiles, type SourceFile, type WalkOptions } from './walk.js';
import { detectVersion } from './version.js';
import { expandAlias, loadPathAliases, loadWorkspacePackages, type PathAliases } from './paths.js';
import type { ClientBinding, ScanResult, Usage } from './types.js';
import { loadMethodMap, type MethodMap } from '../specdiff/methodmap.js';

export interface ScanOptions extends WalkOptions {
  methodMap?: MethodMap;
  knownEvents?: ReadonlySet<string>;
  /** Drop usages below this confidence from the result. */
  minConfidence?: number;
}

/** Files that could possibly construct or re-export a Stripe client. */
const CLIENT_HINT = /\bnew\s+Stripe\s*\(|require\(\s*['"]stripe['"]|from\s*['"]stripe['"]/;

/**
 * `STRIPE_API_VERSION = "2026-02-25.clover"`, as a declaration or a property.
 *
 * Captures which form matched so a real declaration can outrank a value set
 * inside a test mock.
 */
const VERSION_CONSTANT =
  /(?:(const|let|var)\s+)?\b([A-Za-z_$][\w$]*)\s*([=:])\s*['"`](\d{4}-\d{2}-\d{2}(?:\.[a-z0-9_]+)?)['"`]/g;

/** Files whose constants describe a test environment, not the real one. */
const TEST_ISH = /(^|\/)(__mocks__|__tests__|tests?)\/|(^|\/)[\w.-]*(vitest|jest|test|spec)[\w.-]*\.[cm]?[jt]sx?$/i;

/**
 * How much to trust one occurrence as "the" value of a name.
 *
 * A `const X = "..."` declaration is the definition; `X: "..."` inside an object
 * is usually a mock overriding it. Test setup files lose either way — without
 * this, a repo whose vitest setup pins a different version reads as ambiguous and
 * the real pin is lost.
 */
function constantScore(keyword: string | undefined, operator: string, file: string): number {
  let score = keyword ? 3 : operator === '=' ? 2 : 1;
  if (TEST_ISH.test(file)) score -= 3;
  return score;
}

/**
 * Collect constants whose value is a Stripe API version.
 *
 * Repos almost always pin via a named constant rather than a literal at the
 * client, so resolving these is what makes the current version detectable. When
 * two occurrences of a name disagree the better-scoring one wins; a genuine tie
 * is dropped, since a wrong version silently selects the wrong changesets.
 */
function collectVersionConstants(files: readonly SourceFile[]): Map<string, string> {
  const best = new Map<string, { version: string; score: number; tied: boolean }>();

  for (const file of files) {
    VERSION_CONSTANT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = VERSION_CONSTANT.exec(file.text)) !== null) {
      const [, keyword, name, operator, version] = match;
      if (!name || !operator || !version) continue;

      const score = constantScore(keyword, operator, file.relative);
      const existing = best.get(name);
      if (!existing) {
        best.set(name, { version, score, tied: false });
        continue;
      }
      if (existing.version === version) {
        if (score > existing.score) existing.score = score;
        continue;
      }
      if (score > existing.score) best.set(name, { version, score, tied: false });
      else if (score === existing.score) existing.tied = true;
    }
  }

  const out = new Map<string, string>();
  for (const [name, entry] of best) {
    if (!entry.tied) out.set(name, entry.version);
  }
  return out;
}

const INDEX_BASENAMES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mts', 'index.mjs'];
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

type Resolver = (from: SourceFile, specifier: string) => SourceFile | null;

/**
 * Resolve an import specifier to a file in the scanned set.
 *
 * Handles relative paths and tsconfig `paths` aliases. Package imports are not
 * resolved: a client defined inside a dependency is not code we are scanning.
 * When resolution fails the method-map match still catches the call site, just at
 * lower confidence — so this improves precision rather than gating detection.
 */
function makeResolver(
  root: string,
  files: readonly SourceFile[],
  aliases: PathAliases | null,
  workspaces: ReadonlyMap<string, string>,
): Resolver {
  const byRelative = new Map<string, SourceFile>();
  for (const file of files) byRelative.set(file.relative, file);

  const tryCandidates = (base: string): SourceFile | null => {
    const candidates = [base, ...EXTENSIONS.map((e) => `${base}${e}`)];
    // A `.js` specifier in ESM TypeScript means the `.ts` source.
    if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
    candidates.push(...INDEX_BASENAMES.map((n) => `${base}/${n}`));

    for (const candidate of candidates) {
      const hit = byRelative.get(candidate);
      if (hit) return hit;
    }
    return null;
  };

  return (fromFile, specifier) => {
    if (specifier.startsWith('.')) {
      // Resolve within the repo-relative namespace, not the real filesystem.
      const base = resolve(`/${dirname(fromFile.relative)}`, specifier).slice(1);
      return tryCandidates(base);
    }
    for (const base of expandAlias(aliases, root, specifier)) {
      const hit = tryCandidates(base);
      if (hit) return hit;
    }

    // Workspace package: `@acme/lib/server-only/stripe` -> `packages/lib/...`
    for (const [name, dir] of workspaces) {
      if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
      const rest = specifier.slice(name.length).replace(/^\//, '');
      const hit = tryCandidates(rest === '' ? dir : `${dir}/${rest}`);
      if (hit) return hit;
      // Many workspace packages re-export everything through `src/`.
      const viaSrc = tryCandidates(rest === '' ? `${dir}/src` : `${dir}/src/${rest}`);
      if (viaSrc) return viaSrc;
    }
    return null;
  };
}

export async function scanRepo(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const absRoot = resolve(root);
  const methodMap = options.methodMap ?? (await loadMethodMap());
  const warnings: string[] = [];

  if (Object.keys(methodMap.byCall).length === 0) {
    warnings.push(
      'No Stripe method map available, so SDK calls cannot be resolved to endpoints. Run `apimigrate build-method-map`.',
    );
  }

  const [{ files, skipped }, version, aliases, workspaces] = await Promise.all([
    collectSourceFiles(absRoot, options),
    detectVersion(absRoot),
    loadPathAliases(absRoot),
    loadWorkspacePackages(absRoot),
  ]);
  for (const note of skipped.slice(0, 10)) warnings.push(`Skipped ${note}`);
  if (skipped.length > 10) warnings.push(`Skipped ${skipped.length - 10} more file(s).`);

  const stripeInManifest = version.sdkRange !== undefined;
  const resolveFile = makeResolver(absRoot, files, aliases, workspaces);
  const versionConstants = collectVersionConstants(files);

  // --- pass 1: which modules hand out a Stripe client? ---------------------
  // Only files mentioning the package can construct one, so the expensive parse
  // is limited to a handful of files in a typical repo.
  const exportsByFile = new Map<string, ClientExports>();
  const parsedCache = new Map<string, ts.SourceFile>();
  const seedFiles = files.filter((f) => CLIENT_HINT.test(f.text));

  const noClients = (): undefined => undefined;
  for (const file of seedFiles) {
    const sf = parseSource(file);
    parsedCache.set(file.relative, sf);
    const out = scanFile(
      { file, methodMap, resolveClientExports: noClients, stripeInManifest, versionConstants },
      sf,
    );
    if (out.exportedClients.size > 0 || out.exportedClientFactories.size > 0) {
      exportsByFile.set(file.relative, {
        values: out.exportedClients,
        factories: out.exportedClientFactories,
      });
    }
  }

  // Propagate one hop through barrels, so `import { stripe } from './lib'` works
  // when `./lib/index.ts` re-exports `./lib/stripe`.
  for (const file of files) {
    if (exportsByFile.has(file.relative)) continue;
    const reexported = findReexportedClients(file, resolveFile, exportsByFile, parsedCache);
    if (reexported) exportsByFile.set(file.relative, reexported);
  }

  // --- pass 2: every usage -------------------------------------------------
  const usages: Usage[] = [];
  const clients: ClientBinding[] = [];
  let filesScanned = 0;

  for (const file of files) {
    const resolveClientExports = (specifier: string): ClientExports | undefined => {
      const target = resolveFile(file, specifier);
      return target ? exportsByFile.get(target.relative) : undefined;
    };

    const out = scanFile(
      {
        file,
        methodMap,
        resolveClientExports,
        stripeInManifest,
        versionConstants,
        ...(options.knownEvents ? { knownEvents: options.knownEvents } : {}),
      },
      parsedCache.get(file.relative),
    );
    filesScanned += 1;
    usages.push(...out.usages);
    clients.push(...out.clients);

    // Free the cached AST; repos can be large.
    parsedCache.delete(file.relative);
  }

  const minConfidence = options.minConfidence ?? 0.4;
  const kept = usages.filter((u) => u.confidence >= minConfidence);

  // A pinned apiVersion is recorded as a clientInit usage during the AST pass.
  const pin = kept.find((u) => u.kind === 'clientInit' && u.event !== undefined);
  if (pin?.event) {
    version.apiVersion = pin.event;
    version.apiVersionEvidence = pin.evidence;
  }

  return {
    root: absRoot,
    filesScanned,
    usages: kept,
    version,
    clients: dedupeClients(clients),
    warnings,
  };
}

/** `export { stripe } from './stripe'` and `export * from './stripe'`. */
function findReexportedClients(
  file: SourceFile,
  resolveFile: Resolver,
  exportsByFile: ReadonlyMap<string, ClientExports>,
  parsedCache: Map<string, ts.SourceFile>,
): ClientExports | null {
  // Cheap prefilter: only parse files that re-export from somewhere.
  if (!/export\s+(?:\*|\{)/.test(file.text)) return null;

  let sf = parsedCache.get(file.relative);
  if (!sf) {
    sf = parseSource(file);
    parsedCache.set(file.relative, sf);
  }

  const values = new Set<string>();
  const factories = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveFile(file, node.moduleSpecifier.text);
      const exported = target ? exportsByFile.get(target.relative) : undefined;
      if (exported) {
        if (!node.exportClause) {
          for (const name of exported.values) values.add(name);
          for (const name of exported.factories) factories.add(name);
        } else if (ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            const original = el.propertyName?.text ?? el.name.text;
            if (exported.values.has(original)) values.add(el.name.text);
            else if (exported.factories.has(original)) factories.add(el.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (values.size === 0 && factories.size === 0) return null;
  return { values, factories };
}

function dedupeClients(clients: readonly ClientBinding[]): ClientBinding[] {
  const seen = new Set<string>();
  const out: ClientBinding[] = [];
  for (const c of clients) {
    const key = `${c.file}:${c.line}:${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
