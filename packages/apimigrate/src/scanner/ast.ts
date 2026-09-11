import ts from 'typescript';

import type { ClientBinding, Evidence, Usage } from './types.js';
import { callKey, normalizePath, type MethodMap } from '../specdiff/methodmap.js';
import type { SourceFile } from './walk.js';

const SNIPPET_MAX = 160;

/** Names that read as a Stripe client even when we cannot prove the binding. */
const CLIENT_NAME_HINT = /^(stripe|stripeClient|stripeApi|stripeSdk|_stripe)$/i;

const STRIPE_HOSTS = ['api.stripe.com', 'files.stripe.com'];

/** `invoice.payment_failed`, `customer.subscription.deleted`, ... */
const EVENT_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;

/**
 * What a module hands out.
 *
 * Values and factories need different treatment at the import site: a value
 * *is* the client, a factory *returns* one. Lazy `getStripeClient()` init is the
 * recommended pattern in serverless frameworks, so both are common.
 */
export interface ClientExports {
  /** Exported names bound directly to a client. */
  values: ReadonlySet<string>;
  /** Exported functions that return a client. */
  factories: ReadonlySet<string>;
}

export interface FileScanInput {
  file: SourceFile;
  methodMap: MethodMap;
  /**
   * Given an import specifier as written in `file`, return what that module
   * exports — or undefined if it exports no Stripe client. Resolution lives in
   * the caller because it needs the whole file list and the tsconfig paths.
   */
  resolveClientExports: (specifier: string) => ClientExports | undefined;
  /** Known Stripe webhook event types, used to filter event-shaped strings. */
  knownEvents?: ReadonlySet<string>;
  /** True when package.json declares a stripe dependency. Raises confidence. */
  stripeInManifest: boolean;
  /**
   * Repo-wide constants whose value is a Stripe API version, e.g.
   * `STRIPE_API_VERSION` -> `2026-02-25.clover`. Lets `apiVersion:
   * STRIPE_API_VERSION` resolve, which is how most repos pin it.
   */
  versionConstants?: ReadonlyMap<string, string>;
}

export interface FileScanOutput {
  usages: Usage[];
  clients: ClientBinding[];
  /** Names this file exports that are bound to a Stripe client. */
  exportedClients: Set<string>;
  /** Exported functions in this file that return a Stripe client. */
  exportedClientFactories: Set<string>;
  /** True when this file imports the `stripe` package. */
  importsStripePackage: boolean;
}

export function parseSource(file: SourceFile): ts.SourceFile {
  const jsx = file.relative.endsWith('x');
  return ts.createSourceFile(
    file.relative,
    file.text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function evidenceAt(sf: ts.SourceFile, file: SourceFile, node: ts.Node): Evidence {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const lines = file.text.split('\n');
  const raw = (lines[line] ?? '').trim();
  return {
    file: file.relative,
    line: line + 1,
    column: character + 1,
    snippet: raw.length > SNIPPET_MAX ? `${raw.slice(0, SNIPPET_MAX - 1)}…` : raw,
  };
}

/** Unwrap `await x`, `(x)`, `x!`, `x as T` to reach the interesting expression. */
function unwrap(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    if (ts.isAwaitExpression(current)) current = current.expression;
    else if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
    else return current;
  }
}

interface Chain {
  root: ts.Identifier | ts.ThisExpression;
  rootName: string;
  /** Property names after the root, in order. */
  segments: string[];
}

/** Decompose `a.b.c.d` (or `this.b.c`) into root + segments. */
function memberChain(expr: ts.Expression): Chain | null {
  const segments: string[] = [];
  let current: ts.Node = unwrap(expr);

  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      segments.unshift(current.name.text);
      current = unwrap(current.expression);
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      const arg = current.argumentExpression;
      if (arg && ts.isStringLiteral(arg)) {
        segments.unshift(arg.text);
        current = unwrap(current.expression);
        continue;
      }
      return null;
    }
    break;
  }

  if (ts.isIdentifier(current)) return { root: current, rootName: current.text, segments };
  if (current.kind === ts.SyntaxKind.ThisKeyword) {
    return { root: current as ts.ThisExpression, rootName: 'this', segments };
  }
  return null;
}

export interface ResolvedCall {
  namespace: string;
  method: string;
  httpMethod: string;
  path: string;
  /** How many leading chain segments were consumed as a wrapper prefix. */
  droppedPrefix: number;
}

/** A local variable standing in for part of a response payload. */
interface ResponseBinding {
  call: ResolvedCall;
  /** Dotted path segments from the response root; `[]` marks an array element. */
  prefix: string[];
  callId?: string;
}

/** Array methods whose callback receives one element of the collection. */
const ITERATOR_METHODS = new Set([
  'map',
  'forEach',
  'filter',
  'find',
  'flatMap',
  'some',
  'every',
  'sort',
]);

/**
 * Match a call chain against the method map.
 *
 * Tries the longest namespace first and walks inward, so `payments.client.
 * checkout.sessions.create` still resolves to `checkout.sessions.create`. The
 * map is the oracle here: a chain that matches a real Stripe endpoint is strong
 * evidence on its own, which is how wrapped clients get unmasked without
 * needing a model.
 */
export function resolveCall(map: MethodMap, segments: readonly string[]): ResolvedCall | null {
  if (segments.length < 2) return null;
  const method = segments[segments.length - 1];
  if (method === undefined) return null;

  for (let start = 0; start < segments.length - 1; start++) {
    const namespace = segments.slice(start, -1).join('.');
    const hit = map.byCall[callKey(namespace, method)];
    if (hit) {
      return { namespace, method, httpMethod: hit.method, path: hit.path, droppedPrefix: start };
    }
  }
  return null;
}

/**
 * How much to trust an SDK call we matched by shape.
 *
 * A resolved client binding is proof. Without one, a multi-segment namespace
 * (`checkout.sessions`) is distinctive enough to be near-certain, while a bare
 * `customers.list` could plausibly be someone's ORM.
 */
function callConfidence(
  resolved: ResolvedCall,
  isKnownClient: boolean,
  nameHint: boolean,
  stripeInManifest: boolean,
): number {
  if (isKnownClient) return 1;
  if (nameHint && stripeInManifest) return 0.95;
  const distinctive = resolved.namespace.includes('.');
  if (distinctive) return stripeInManifest ? 0.85 : 0.7;
  return stripeInManifest ? 0.6 : 0.4;
}

export function scanFile(input: FileScanInput, parsed?: ts.SourceFile): FileScanOutput {
  const { file, methodMap, resolveClientExports, stripeInManifest } = input;
  const sf = parsed ?? parseSource(file);

  const usages: Usage[] = [];
  const clients: ClientBinding[] = [];
  const exportedClients = new Set<string>();
  const exportedClientFactories = new Set<string>();
  /** Local identifiers that return a client when called. */
  const factoryNames = new Set<string>();

  /** Identifiers in this file that hold a Stripe client. */
  const clientNames = new Set<string>();
  /** Identifiers bound to the `stripe` package's default export (the constructor). */
  const constructorNames = new Set<string>();
  /**
   * Variable name -> what it holds. `prefix` is the dotted path from the
   * response root, so a `.map` callback parameter can carry `['data', '[]']`
   * and have its field reads reported at the right depth.
   */
  const responseBindings = new Map<string, ResponseBinding>();

  let importsStripePackage = false;

  // --- pass 1: imports and client construction -----------------------------
  const collectBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;

      if (spec === 'stripe') {
        importsStripePackage = true;
        if (clause?.name) constructorNames.add(clause.name.text);
        const named = clause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) constructorNames.add(named.name.text);
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            if (el.propertyName?.text === 'Stripe' || el.name.text === 'Stripe') {
              constructorNames.add(el.name.text);
            }
          }
        }
      }

      const exported = resolveClientExports(spec);
      if (exported) {
        if (clause?.name && exported.values.has('default')) clientNames.add(clause.name.text);
        if (clause?.name && exported.factories.has('default')) factoryNames.add(clause.name.text);

        const named = clause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            const original = el.propertyName?.text ?? el.name.text;
            if (exported.values.has(original)) {
              clientNames.add(el.name.text);
              clients.push({
                name: el.name.text,
                file: file.relative,
                line: evidenceAt(sf, file, el).line,
                reason: 'importedDefault',
              });
            } else if (exported.factories.has(original)) {
              // `const stripe = getStripeClient()` binds on call, below.
              factoryNames.add(el.name.text);
            }
          }
        }
      }
    }

    // const Stripe = require('stripe') / const { stripe } = require('./lib')
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'require' &&
        init.arguments.length === 1
      ) {
        const arg = init.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          if (arg.text === 'stripe') {
            importsStripePackage = true;
            if (ts.isIdentifier(node.name)) constructorNames.add(node.name.text);
          }
          const exported = resolveClientExports(arg.text);
          if (exported) {
            if (ts.isIdentifier(node.name)) clientNames.add(node.name.text);
            else if (ts.isObjectBindingPattern(node.name)) {
              for (const el of node.name.elements) {
                const original =
                  el.propertyName && ts.isIdentifier(el.propertyName)
                    ? el.propertyName.text
                    : ts.isIdentifier(el.name)
                      ? el.name.text
                      : null;
                if (!original || !ts.isIdentifier(el.name)) continue;
                if (exported.values.has(original)) clientNames.add(el.name.text);
                else if (exported.factories.has(original)) factoryNames.add(el.name.text);
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sf);

  // `new Stripe(...)` — record the client and any pinned apiVersion.
  const collectConstructions = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const chain = memberChain(node.expression);
      const calleeName = chain
        ? chain.segments.length > 0
          ? (chain.segments[chain.segments.length - 1] as string)
          : chain.rootName
        : null;

      const isStripeCtor =
        calleeName !== null &&
        (constructorNames.has(calleeName) ||
          (calleeName === 'Stripe' && (importsStripePackage || stripeInManifest)));

      if (isStripeCtor) {
        const ev = evidenceAt(sf, file, node);
        const apiVersion = readApiVersionArg(node, input.versionConstants);
        usages.push({
          kind: 'clientInit',
          evidence: ev,
          confidence: 1,
          ...(apiVersion ? { field: 'apiVersion', event: apiVersion } : {}),
        });

        // Bind the variable (or class property) it is assigned to.
        const owner = assignmentTarget(node);
        if (owner) {
          clientNames.add(owner.name);
          clients.push({ name: owner.name, file: file.relative, line: ev.line, reason: 'newStripe' });
          if (owner.exported) exportedClients.add(owner.exportName ?? owner.name);
        }
      }
    }
    ts.forEachChild(node, collectConstructions);
  };
  collectConstructions(sf);

  // A binding annotated `Stripe` is a client by declaration — the strongest
  // signal available, and the only thing that identifies a client arriving as a
  // function parameter.
  collectTypedClients(sf, constructorNames, clientNames, clients, (node) => evidenceAt(sf, file, node).line, file.relative);

  // Functions that hand back a client, e.g. `export const getStripeClient = () =>
  // new Stripe(key)`. Recommended practice in serverless frameworks, so worth
  // resolving rather than guessing by name.
  collectClientFactories(sf, clientNames, factoryNames, exportedClientFactories);

  // `const stripe = getStripeClient()` — bind the result to a client.
  bindFactoryCalls(sf, factoryNames, clientNames, clients, (node) => evidenceAt(sf, file, node).line, file.relative);

  // `const client = stripeClient` — follow plain aliases so a local rename does
  // not drop every call site behind it to a name-based guess.
  propagateAliases(sf, clientNames);

  // --- pass 2: usages ------------------------------------------------------
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      handleCall(node);
      // Must run before descending, so the callback parameter is bound by the
      // time its body is visited.
      handleIteratorCallback(node);
    }
    if (ts.isStringLiteralLike(node)) {
      handleString(node, node.text);
    }
    // `fetch(\`https://api.stripe.com/v1/payment_intents/${id}/cancel\`)` — the
    // usual shape for a hand-rolled REST call, so interpolation must be handled.
    if (ts.isTemplateExpression(node)) {
      handleString(node, templateToPath(node));
    }
    if (ts.isPropertyAccessExpression(node)) {
      handleResponseFieldAccess(node);
    }
    ts.forEachChild(node, visit);
  };

  function handleCall(node: ts.CallExpression): void {
    const chain = memberChain(node.expression);
    if (!chain) return;

    const resolved = resolveCall(methodMap, chain.segments);
    if (!resolved) return;

    const isKnownClient =
      clientNames.has(chain.rootName) ||
      // `this.stripe.customers.create` inside a wrapper class.
      (chain.rootName === 'this' && resolved.droppedPrefix > 0);
    const nameHint =
      CLIENT_NAME_HINT.test(chain.rootName) ||
      chain.segments.slice(0, resolved.droppedPrefix).some((s) => CLIENT_NAME_HINT.test(s));

    const confidence = callConfidence(resolved, isKnownClient, nameHint, stripeInManifest);
    // Below this, a match is more likely to be someone's ORM than Stripe.
    if (confidence < 0.4) return;

    const via = [chain.rootName, ...chain.segments.slice(0, resolved.droppedPrefix)].join('.');
    const ev = evidenceAt(sf, file, node.expression);
    const callId = `${ev.file}:${ev.line}:${ev.column}`;

    usages.push({
      kind: 'sdkCall',
      evidence: ev,
      confidence,
      namespace: resolved.namespace,
      method: resolved.method,
      httpMethod: resolved.httpMethod,
      path: resolved.path,
      via,
      callId,
    });

    recordRequestParams(node, resolved, confidence, callId);
    bindResponse(node, resolved, callId);
  }

  /** Top-level and one-level-nested keys of the params object literal. */
  function recordRequestParams(
    node: ts.CallExpression,
    resolved: ResolvedCall,
    confidence: number,
    callId: string,
  ): void {
    const objectArg = node.arguments.find((a) => ts.isObjectLiteralExpression(unwrap(a)));
    if (!objectArg) return;
    const obj = unwrap(objectArg);
    if (!ts.isObjectLiteralExpression(obj)) return;

    const walkObject = (literal: ts.ObjectLiteralExpression, prefix: string, depth: number): void => {
      if (depth > 2) return;
      for (const prop of literal.properties) {
        const name =
          prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
            ? prop.name.text
            : null;
        if (name === null) continue;
        const fieldPath = prefix === '' ? name : `${prefix}.${name}`;

        usages.push({
          kind: 'requestParam',
          evidence: evidenceAt(sf, file, prop),
          confidence,
          namespace: resolved.namespace,
          method: resolved.method,
          httpMethod: resolved.httpMethod,
          path: resolved.path,
          field: fieldPath,
          callId,
        });

        if (ts.isPropertyAssignment(prop)) {
          const value = unwrap(prop.initializer);
          if (ts.isObjectLiteralExpression(value)) walkObject(value, fieldPath, depth + 1);
        }
      }
    };
    walkObject(obj, '', 0);
  }

  /** Remember which variable holds this call's response, plus destructured fields. */
  function bindResponse(node: ts.CallExpression, resolved: ResolvedCall, callId: string): void {
    const decl = enclosingVariableDeclaration(node);
    if (!decl) return;

    if (ts.isIdentifier(decl.name)) {
      responseBindings.set(decl.name.text, { call: resolved, prefix: [], callId });
      return;
    }
    if (ts.isObjectBindingPattern(decl.name)) {
      for (const el of decl.name.elements) {
        const original =
          el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName))
            ? el.propertyName.text
            : ts.isIdentifier(el.name)
              ? el.name.text
              : null;
        if (original === null) continue;
        usages.push({
          kind: 'responseField',
          evidence: evidenceAt(sf, file, el),
          confidence: 0.95,
          namespace: resolved.namespace,
          method: resolved.method,
          httpMethod: resolved.httpMethod,
          path: resolved.path,
          field: original,
          callId,
        });
      }
    }
  }

  function handleResponseFieldAccess(node: ts.PropertyAccessExpression): void {
    const chain = memberChain(node);
    if (!chain || chain.segments.length === 0) return;
    const binding = responseBindings.get(chain.rootName);
    if (!binding) return;
    // Skip the chain that is itself a call expression target (handled elsewhere).
    if (node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) return;

    const field = [...binding.prefix, ...chain.segments].join('.');

    usages.push({
      kind: 'responseField',
      evidence: evidenceAt(sf, file, node),
      confidence: 0.9,
      namespace: binding.call.namespace,
      method: binding.call.method,
      httpMethod: binding.call.httpMethod,
      path: binding.call.path,
      field,
      via: chain.rootName,
      ...(binding.callId ? { callId: binding.callId } : {}),
    });
  }

  /**
   * `page.data.map((item) => item.amount)` — bind the callback parameter to the
   * element it iterates, so fields read inside the callback are attributed to the
   * right endpoint. List iteration is how most Stripe collections get consumed,
   * so without this the response side misses the common case.
   */
  function handleIteratorCallback(node: ts.CallExpression): void {
    const chain = memberChain(node.expression);
    if (!chain || chain.segments.length === 0) return;

    const methodName = chain.segments[chain.segments.length - 1];
    if (methodName === undefined || !ITERATOR_METHODS.has(methodName)) return;

    const binding = responseBindings.get(chain.rootName);
    if (!binding) return;

    // The property path being iterated, e.g. `data` in `page.data.map(...)`.
    const iterated = chain.segments.slice(0, -1);
    if (iterated.length === 0) return;

    const callback = node.arguments.find((a) => {
      const fn = unwrap(a);
      return ts.isArrowFunction(fn) || ts.isFunctionExpression(fn);
    });
    if (!callback) return;
    const fn = unwrap(callback);
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return;

    const param = fn.parameters[0];
    if (!param) return;

    // The array marker belongs on the iterated segment (`data[]`), not as a
    // segment of its own — `data.[]` would not match a spec path of `data[]`.
    const segments = [...binding.prefix, ...iterated];
    const last = segments[segments.length - 1];
    if (last === undefined) return;
    const elementPrefix = [...segments.slice(0, -1), `${last}[]`];

    if (ts.isIdentifier(param.name)) {
      responseBindings.set(param.name.text, {
        call: binding.call,
        prefix: elementPrefix,
        ...(binding.callId ? { callId: binding.callId } : {}),
      });
      return;
    }

    // `.map(({ id, amount }) => ...)` reads those fields directly.
    if (ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        const original =
          el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName))
            ? el.propertyName.text
            : ts.isIdentifier(el.name)
              ? el.name.text
              : null;
        if (original === null) continue;
        usages.push({
          kind: 'responseField',
          evidence: evidenceAt(sf, file, el),
          confidence: 0.9,
          namespace: binding.call.namespace,
          method: binding.call.method,
          httpMethod: binding.call.httpMethod,
          path: binding.call.path,
          field: [...elementPrefix, original].join('.'),
          ...(binding.callId ? { callId: binding.callId } : {}),
        });
      }
    }
  }

  function handleString(node: ts.Node, text: string): void {
    // Raw REST calls: full URL or a bare /v1/ path.
    const pathMatch = extractStripePath(text);
    if (pathMatch) {
      const verb = inferHttpMethod(node);
      usages.push({
        kind: 'rawUrl',
        evidence: evidenceAt(sf, file, node),
        confidence: pathMatch.viaHost ? 1 : stripeInManifest ? 0.8 : 0.5,
        path: pathMatch.path,
        ...(verb ? { httpMethod: verb } : {}),
      });
      return;
    }

    // Webhook event types.
    if (EVENT_SHAPE.test(text) && looksLikeEventContext(node, input.knownEvents, text)) {
      usages.push({
        kind: 'webhookEvent',
        evidence: evidenceAt(sf, file, node),
        confidence: input.knownEvents?.has(text) ? 1 : 0.6,
        event: text,
      });
    }
  }

  visit(sf);

  // A file that constructs a client and exports it via `export { stripe }`.
  collectNamedExports(sf, clientNames, exportedClients);

  return { usages, clients, exportedClients, exportedClientFactories, importsStripePackage };
}

// --------------------------------------------------------------------------

/**
 * Read the pinned `apiVersion` out of a `new Stripe(...)` call.
 *
 * Accepts a literal or a constant reference — `apiVersion: STRIPE_API_VERSION` is
 * how most repos do it, and the pinned version decides which changesets apply, so
 * failing to read it is the difference between a targeted report and a guess.
 */
function readApiVersionArg(
  node: ts.NewExpression,
  versionConstants?: ReadonlyMap<string, string>,
): string | null {
  for (const arg of node.arguments ?? []) {
    const obj = unwrap(arg);
    if (!ts.isObjectLiteralExpression(obj)) continue;
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
      if (name !== 'apiVersion') continue;

      const value = unwrap(prop.initializer);
      if (ts.isStringLiteralLike(value)) return value.text;
      if (ts.isIdentifier(value)) return versionConstants?.get(value.text) ?? null;
      // `STRIPE_API_VERSION as Stripe.LatestApiVersion` is unwrapped already; a
      // property access like `constants.STRIPE_API_VERSION` resolves by leaf name.
      if (ts.isPropertyAccessExpression(value)) {
        return versionConstants?.get(value.name.text) ?? null;
      }
    }
  }
  return null;
}

interface AssignTarget {
  name: string;
  exported: boolean;
  exportName?: string;
}

/**
 * Find what a `new Stripe(...)` expression is assigned to.
 *
 * Climbs through expression forms that pass the value along, including the
 * env-guarded shapes that show up constantly in real code:
 *
 *   const stripe = key ? new Stripe(key) : null
 *   const stripe = cached ?? (cached = new Stripe(key))
 *
 * Stopping at the conditional would leave the client unbound and drop every call
 * site in the repo to a name-based guess.
 */
function assignmentTarget(node: ts.NewExpression): AssignTarget | null {
  let current: ts.Node | undefined = node.parent;
  let previous: ts.Node = node;

  while (current) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
      previous = current;
      current = current.parent;
      continue;
    }
    // `cond ? new Stripe() : null` — only the branches carry the value.
    if (ts.isConditionalExpression(current) && current.condition !== previous) {
      previous = current;
      current = current.parent;
      continue;
    }
    // `x ?? new Stripe()`, `x || new Stripe()`, `x && new Stripe()`
    if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      previous = current;
      current = current.parent;
      continue;
    }
    break;
  }
  if (!current) return null;

  if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
    const statement = current.parent?.parent;
    const exported =
      statement !== undefined &&
      ts.isVariableStatement(statement) &&
      (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    return { name: current.name.text, exported };
  }

  if (ts.isPropertyDeclaration(current) && ts.isIdentifier(current.name)) {
    return { name: current.name.text, exported: false };
  }

  // `this.stripe = new Stripe(...)` / `module.exports = new Stripe(...)`
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const chain = memberChain(current.left);
    if (chain) {
      const last = chain.segments[chain.segments.length - 1];
      const name = last ?? chain.rootName;
      const isModuleExports = chain.rootName === 'module' && chain.segments[0] === 'exports';
      return {
        name,
        exported: isModuleExports || chain.rootName === 'exports',
        ...(isModuleExports ? { exportName: 'default' } : {}),
      };
    }
  }

  if (ts.isExportAssignment(current)) return { name: 'default', exported: true, exportName: 'default' };

  return null;
}

function enclosingVariableDeclaration(node: ts.Node): ts.VariableDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  // Only climb through wrappers that preserve the value.
  while (
    current &&
    (ts.isAwaitExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current))
  ) {
    current = current.parent;
  }
  if (current && ts.isVariableDeclaration(current)) return current;
  return null;
}

/**
 * Bindings whose declared type is `Stripe`.
 *
 * A wrapper that takes the client as an argument — `async function handle(stripe:
 * Stripe, event: Stripe.Event)` — gives no other way to know what `stripe` is.
 * The annotation is a declaration, not a heuristic, so these are full confidence.
 */
function collectTypedClients(
  sf: ts.SourceFile,
  constructorNames: ReadonlySet<string>,
  clientNames: Set<string>,
  clients: ClientBinding[],
  lineOf: (node: ts.Node) => number,
  file: string,
): void {
  if (constructorNames.size === 0) return;

  /** Is this type annotation the Stripe client type? */
  const isClientType = (type: ts.TypeNode | undefined): boolean => {
    if (!type) return false;
    // `Stripe | null`, `Stripe | undefined`
    if (ts.isUnionTypeNode(type)) return type.types.some(isClientType);
    if (!ts.isTypeReferenceNode(type)) return false;

    const name = type.typeName;
    if (ts.isIdentifier(name)) return constructorNames.has(name.text);
    // `Stripe.Stripe` — the namespace re-export of the client class.
    if (ts.isQualifiedName(name) && ts.isIdentifier(name.left)) {
      return constructorNames.has(name.left.text) && name.right.text === 'Stripe';
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      isClientType(node.type)
    ) {
      clientNames.add(node.name.text);
      clients.push({ name: node.name.text, file, line: lineOf(node), reason: 'wrapperProperty' });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * Follow plain aliases: `const client = stripeClient`.
 *
 * Iterated to a fixed point because an alias can be assigned before the name it
 * copies has itself been recognised. The bound is small; chains longer than a few
 * hops do not occur in practice.
 */
function propagateAliases(sf: ts.SourceFile, clientNames: Set<string>): void {
  const pairs: Array<{ target: string; source: string }> = [];

  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isIdentifier(init)) pairs.push({ target: node.name.text, source: init.text });
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const init = unwrap(node.right);
      if (ts.isIdentifier(init)) pairs.push({ target: node.left.name.text, source: init.text });
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  if (pairs.length === 0) return;

  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const { target, source } of pairs) {
      if (clientNames.has(source) && !clientNames.has(target)) {
        clientNames.add(target);
        changed = true;
      }
    }
    if (!changed) return;
  }
}

/**
 * Find functions that hand back a Stripe client.
 *
 * Lazy init behind a getter is the recommended pattern wherever module-level env
 * access is a problem (Next.js, Workers, Lambda), so a repo can have every call
 * site go through `getStripeClient()` and never name Stripe at the call site.
 */
function collectClientFactories(
  sf: ts.SourceFile,
  clientNames: ReadonlySet<string>,
  factoryNames: Set<string>,
  exportedFactories: Set<string>,
): void {
  /** Does this function body return something we know is a client? */
  const returnsClient = (body: ts.Node): boolean => {
    let found = false;
    const walk = (node: ts.Node): void => {
      if (found) return;
      // Do not descend into nested functions: their returns are not ours.
      if (node !== body && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))) return;

      if (ts.isReturnStatement(node) && node.expression) {
        if (expressionIsClient(node.expression, clientNames, factoryNames)) found = true;
      }
      ts.forEachChild(node, walk);
    };
    // A concise arrow body is itself the returned expression.
    if (ts.isExpression(body)) return expressionIsClient(body, clientNames, factoryNames);
    walk(body);
    return found;
  };

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body && returnsClient(node.body)) {
      factoryNames.add(node.name.text);
      if (isExported(node)) exportedFactories.add(node.name.text);
    }

    if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = unwrap(decl.initializer);
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue;
        if (!returnsClient(init.body)) continue;
        factoryNames.add(decl.name.text);
        if (exported) exportedFactories.add(decl.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Is this expression (possibly guarded) a known client or factory call? */
function expressionIsClient(
  expr: ts.Expression,
  clientNames: ReadonlySet<string>,
  factoryNames: ReadonlySet<string>,
): boolean {
  const node = unwrap(expr);

  if (ts.isIdentifier(node)) return clientNames.has(node.text);
  if (ts.isNewExpression(node)) {
    const chain = memberChain(node.expression);
    const name = chain?.segments[chain.segments.length - 1] ?? chain?.rootName;
    return name === 'Stripe';
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    return factoryNames.has(node.expression.text);
  }
  // `key ? new Stripe(key) : null`, `cached ?? new Stripe(key)`
  if (ts.isConditionalExpression(node)) {
    return (
      expressionIsClient(node.whenTrue, clientNames, factoryNames) ||
      expressionIsClient(node.whenFalse, clientNames, factoryNames)
    );
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return (
      expressionIsClient(node.left, clientNames, factoryNames) ||
      expressionIsClient(node.right, clientNames, factoryNames)
    );
  }
  return false;
}

/** `const stripe = getStripeClient()` — the result is a client. */
function bindFactoryCalls(
  sf: ts.SourceFile,
  factoryNames: ReadonlySet<string>,
  clientNames: Set<string>,
  clients: ClientBinding[],
  lineOf: (node: ts.Node) => number,
  file: string,
): void {
  if (factoryNames.size === 0) return;

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && factoryNames.has(init.expression.text)) {
        clientNames.add(node.name.text);
        clients.push({ name: node.name.text, file, line: lineOf(node), reason: 'wrapperProperty' });
      }
    }
    // `this.stripe = getStripeClient()` inside a service class.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const init = unwrap(node.right);
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && factoryNames.has(init.expression.text)) {
        clientNames.add(node.left.name.text);
        clients.push({ name: node.left.name.text, file, line: lineOf(node), reason: 'wrapperProperty' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function collectNamedExports(
  sf: ts.SourceFile,
  clientNames: ReadonlySet<string>,
  out: Set<string>,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        const local = el.propertyName?.text ?? el.name.text;
        if (clientNames.has(local)) out.add(el.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * Render a template literal as a path, with each interpolation as `{}`.
 *
 * That is the same normalized form `normalizePath` produces for spec paths, so
 * `/v1/payment_intents/${id}/cancel` lines up with
 * `/v1/payment_intents/{intent}/cancel`.
 */
function templateToPath(node: ts.TemplateExpression): string {
  let out = node.head.text;
  for (const span of node.templateSpans) {
    out += `{}${span.literal.text}`;
  }
  return out;
}

/** Pull a Stripe REST path out of a string, whether it is a full URL or not. */
export function extractStripePath(text: string): { path: string; viaHost: boolean } | null {
  for (const host of STRIPE_HOSTS) {
    const idx = text.indexOf(host);
    if (idx !== -1) {
      const rest = text.slice(idx + host.length);
      const m = /^(\/v\d+\/[A-Za-z0-9_\-./{}$:]*)/.exec(rest);
      return { path: m?.[1] ? trimPath(m[1]) : '/', viaHost: true };
    }
  }
  // A bare `/v1/...` path only counts if it looks like a Stripe resource path.
  const bare = /^\/v1\/[a-z][a-z0-9_]*(\/[A-Za-z0-9_\-.{}$:]*)*$/.exec(text);
  if (bare) return { path: trimPath(text), viaHost: false };
  return null;
}

function trimPath(path: string): string {
  const clean = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

/** Best-effort HTTP verb for a raw URL, read from a nearby `method:` property. */
function inferHttpMethod(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  for (let i = 0; i < 4 && current; i++) {
    if (ts.isCallExpression(current)) {
      for (const arg of current.arguments) {
        const obj = unwrap(arg);
        if (!ts.isObjectLiteralExpression(obj)) continue;
        for (const prop of obj.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
          if (name !== 'method') continue;
          const value = unwrap(prop.initializer);
          if (ts.isStringLiteralLike(value)) return value.text.toLowerCase();
        }
      }
      const chain = memberChain(current.expression);
      const last = chain?.segments[chain.segments.length - 1];
      if (last && ['get', 'post', 'put', 'patch', 'delete'].includes(last.toLowerCase())) {
        return last.toLowerCase();
      }
    }
    current = current.parent;
  }
  return null;
}

/**
 * Decide whether an event-shaped string is really a webhook event type.
 *
 * Known-event membership is the strongest signal. Failing that, require the
 * literal to sit somewhere events actually appear: a comparison against a
 * `.type` property, a `switch` case, or an array of event names.
 */
function looksLikeEventContext(
  node: ts.Node,
  knownEvents: ReadonlySet<string> | undefined,
  text: string,
): boolean {
  if (knownEvents && knownEvents.has(text)) return true;
  if (knownEvents && knownEvents.size > 0) return false;

  let current: ts.Node | undefined = node.parent;
  for (let i = 0; i < 4 && current; i++) {
    if (ts.isCaseClause(current)) return true;
    if (ts.isBinaryExpression(current)) {
      const other = current.left === node ? current.right : current.left;
      const chain = ts.isExpression(other) ? memberChain(other) : null;
      if (chain && chain.segments[chain.segments.length - 1] === 'type') return true;
    }
    if (ts.isArrayLiteralExpression(current)) return true;
    current = current.parent;
  }
  return false;
}

export { normalizePath };
