import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

import type { SdkMethodRef } from '../changeset/types.js';
import { callKey, endpointKey, type MethodMap } from './methodmap.js';

/**
 * Builds the endpoint <-> stripe-node call map by reading the stripe package's
 * own generated CommonJS output.
 *
 * Two shapes cover the entire SDK surface:
 *
 *   container:  class X { constructor(stripe) { this.sessions = new Alias.SessionResource(stripe) } }
 *   leaf:       class SessionResource extends StripeResource {
 *                 create(p, o) { return this._makeRequest('POST', '/v1/checkout/sessions', ...) }
 *               }
 *
 * So one recursive walk from the root `Stripe` class reaches every method. No
 * pluralization guessing, no spec heuristics.
 */

interface FileFacts {
  /** local require alias -> absolute file path */
  aliases: Map<string, string>;
  /** exported/declared class name -> class declaration */
  classes: Map<string, ts.ClassDeclaration>;
}

const factsCache = new Map<string, FileFacts>();

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
}

function resolveRequire(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) return candidate;
  }
  return null;
}

async function factsFor(file: string): Promise<FileFacts> {
  const cached = factsCache.get(file);
  if (cached) return cached;

  const sf = parse(file, await readFile(file, 'utf8'));
  const aliases = new Map<string, string>();
  const classes = new Map<string, ts.ClassDeclaration>();

  const visit = (node: ts.Node): void => {
    // const Alias_js_1 = require("./Foo.js")
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if (
          ts.isCallExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === 'require' &&
          init.arguments.length === 1
        ) {
          const arg = init.arguments[0];
          if (arg && ts.isStringLiteral(arg)) {
            const target = resolveRequire(file, arg.text);
            if (target) aliases.set(decl.name.text, target);
          }
        }
      }
    }
    if (ts.isClassDeclaration(node) && node.name) classes.set(node.name.text, node);
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const facts: FileFacts = { aliases, classes };
  factsCache.set(file, facts);
  return facts;
}

/** `'/v1/payment_intents/' + encodeURIComponent(id) + '/confirm'` -> `/v1/payment_intents/{id}/confirm` */
function pathFromExpression(expr: ts.Expression): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;

  if (ts.isTemplateExpression(expr)) {
    let out = expr.head.text;
    for (const span of expr.templateSpans) {
      out += `{${placeholderName(span.expression)}}`;
      out += span.literal.text;
    }
    return out;
  }

  // String concatenation, used by some older generated output.
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = pathFromExpression(expr.left);
    const right = pathFromExpression(expr.right);
    if (left === null && right === null) return null;
    return `${left ?? `{${placeholderName(expr.left)}}`}${right ?? `{${placeholderName(expr.right)}}`}`;
  }
  return null;
}

/** Recover the parameter name from `encodeURIComponent(id)` so paths read well. */
function placeholderName(expr: ts.Expression): string {
  let inner: ts.Expression = expr;
  while (ts.isCallExpression(inner) && inner.arguments.length >= 1) {
    const first = inner.arguments[0];
    if (!first) break;
    inner = first;
  }
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  return 'id';
}

interface Leaf {
  namespace: string;
  method: string;
  httpMethod: string;
  path: string;
}

/** Pull every `this._makeRequest('GET', '/v1/...')` out of a resource class. */
function leafMethods(cls: ts.ClassDeclaration, namespace: string): Leaf[] {
  const out: Leaf[] = [];
  for (const member of cls.members) {
    if (!ts.isMethodDeclaration(member) || !member.name) continue;
    const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
    if (!name || name.startsWith('_')) continue;

    let found: Leaf | null = null;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === '_makeRequest' &&
        node.arguments.length >= 2
      ) {
        const [verb, pathArg] = node.arguments;
        if (verb && pathArg && ts.isStringLiteral(verb)) {
          const path = pathFromExpression(pathArg);
          if (path) found = { namespace, method: name, httpMethod: verb.text.toLowerCase(), path };
        }
      }
      ts.forEachChild(node, visit);
    };
    if (member.body) visit(member.body);
    if (found) out.push(found);
  }
  return out;
}

/** `this.paymentIntents = new PaymentIntents_js_1.PaymentIntentResource(this)` */
interface ChildRef {
  accessor: string;
  alias: string;
  className: string;
}

function containerChildren(cls: ts.ClassDeclaration): ChildRef[] {
  const out: ChildRef[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const { left, right } = node.expression;
      if (
        ts.isPropertyAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isNewExpression(right) &&
        ts.isPropertyAccessExpression(right.expression) &&
        ts.isIdentifier(right.expression.expression)
      ) {
        out.push({
          accessor: left.name.text,
          alias: right.expression.expression.text,
          className: right.expression.name.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const member of cls.members) {
    if (ts.isConstructorDeclaration(member) && member.body) visit(member.body);
  }
  return out;
}

async function walk(
  file: string,
  className: string,
  prefix: string,
  out: Leaf[],
  seen: Set<string>,
  depth: number,
): Promise<void> {
  if (depth > 5) return;
  const guard = `${file}#${className}#${prefix}`;
  if (seen.has(guard)) return;
  seen.add(guard);

  const facts = await factsFor(file);
  const cls = facts.classes.get(className);
  if (!cls) return;

  const methods = leafMethods(cls, prefix);
  if (methods.length > 0) {
    out.push(...methods);
    // A resource can still expose nested sub-resources, so keep walking.
  }

  for (const child of containerChildren(cls)) {
    const target = facts.aliases.get(child.alias);
    if (!target) continue;
    const nextPrefix = prefix === '' ? child.accessor : `${prefix}.${child.accessor}`;
    await walk(target, child.className, nextPrefix, out, seen, depth + 1);
  }
}

/** Find the installed stripe package's CJS entry point. */
export function findStripeCore(searchFrom: string = process.cwd()): string {
  let dir = resolve(searchFrom);
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'node_modules', 'stripe', 'cjs', 'stripe.core.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not find node_modules/stripe/cjs/stripe.core.js. Install the stripe package first (npm i stripe).',
  );
}

async function stripeVersion(coreFile: string): Promise<string> {
  // package.json sits two levels up from cjs/stripe.core.js and is not exported,
  // so read it off disk rather than through require().
  const pkg = join(dirname(dirname(coreFile)), 'package.json');
  try {
    return (JSON.parse(await readFile(pkg, 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function buildMethodMap(coreFile?: string): Promise<MethodMap> {
  const core = coreFile ?? findStripeCore();
  factsCache.clear();

  const leaves: Leaf[] = [];
  await walk(core, 'Stripe', '', leaves, new Set(), 0);

  if (leaves.length === 0) {
    throw new Error(`No SDK methods found in ${core}. The stripe package layout may have changed.`);
  }

  const byEndpoint: Record<string, SdkMethodRef[]> = {};
  const byCall: Record<string, { method: string; path: string }> = {};

  for (const leaf of leaves.sort((a, b) =>
    `${a.namespace}.${a.method}`.localeCompare(`${b.namespace}.${b.method}`),
  )) {
    const key = endpointKey(leaf.httpMethod, leaf.path);
    const refs = (byEndpoint[key] ??= []);
    if (!refs.some((r) => r.namespace === leaf.namespace && r.method === leaf.method)) {
      refs.push({ namespace: leaf.namespace, method: leaf.method });
    }
    byCall[callKey(leaf.namespace, leaf.method)] = { method: leaf.httpMethod, path: leaf.path };
  }

  return {
    sdkVersion: await stripeVersion(core),
    generatedAt: new Date().toISOString(),
    byEndpoint,
    byCall,
  };
}

export async function writeMethodMap(map: MethodMap, outFile: string): Promise<void> {
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}
