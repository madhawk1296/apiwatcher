import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanRepo } from './scan.js';
import { loadPathAliases, loadWorkspacePackages, expandAlias } from './paths.js';
import type { ScanResult, Usage } from './types.js';
import type { MethodMap } from '../specdiff/methodmap.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '../../test/fixtures/wrapper-app');

const MAP: MethodMap = {
  sdkVersion: 'test',
  generatedAt: new Date(0).toISOString(),
  byEndpoint: {},
  byCall: {
    'products.list': { method: 'get', path: '/v1/products' },
    'refunds.create': { method: 'post', path: '/v1/refunds' },
    'subscriptions.cancel': { method: 'delete', path: '/v1/subscriptions/{id}' },
  },
};

/**
 * Every call in this fixture is reached through indirection a naive scanner
 * would miss. They are all full confidence or the detection has regressed —
 * these are the shapes real repositories actually use.
 */
let scan: ScanResult;
before(async () => {
  scan = await scanRepo(FIXTURE, { methodMap: MAP });
});

function call(namespace: string, method: string): Usage | undefined {
  return scan.usages.find((u) => u.kind === 'sdkCall' && u.namespace === namespace && u.method === method);
}

test('a client built inside a conditional is still resolved', () => {
  // `export const stripeClient = env.KEY ? new Stripe(...) : null`
  const usage = call('products', 'list');
  assert.ok(usage, 'expected products.list to be found');
  assert.equal(usage?.confidence, 1, 'env-guarded construction should not cost confidence');
});

test('a client imported by workspace package name is resolved', () => {
  // billing.ts imports from `@wrapper/core/src/client`.
  assert.ok(
    scan.clients.some((c) => c.file === 'src/services/billing.ts' && c.name === 'stripeClient'),
    `expected a resolved client in billing.ts, got ${JSON.stringify(scan.clients)}`,
  );
});

test('a locally aliased client keeps full confidence', () => {
  // `const client = stripeClient` — the call site says nothing about Stripe.
  const usage = call('products', 'list');
  assert.equal(usage?.via, 'client');
  assert.equal(usage?.confidence, 1);
});

test('a client arriving as a typed parameter is recognised', () => {
  // `async function refundCharge(stripe: Stripe, ...)` — the annotation is the
  // only evidence available, and it is definitive.
  const usage = call('refunds', 'create');
  assert.ok(usage, 'expected refunds.create to be found');
  assert.equal(usage?.confidence, 1);
});

test('a client returned by a factory function is recognised', () => {
  // `const sdk = getStripeClient()`
  const usage = call('subscriptions', 'cancel');
  assert.ok(usage, 'expected subscriptions.cancel to be found');
  assert.equal(usage?.via, 'sdk');
  assert.equal(usage?.confidence, 1);
});

test('the pinned version is read from a constant behind a path alias', () => {
  // `apiVersion: STRIPE_API_VERSION`, imported via `@/config/constants`.
  assert.equal(scan.version.apiVersion, '2025-09-30.clover');
});

test('the stripe dependency is found in a workspace package', () => {
  // Declared in packages/core, not at the repo root.
  assert.equal(scan.version.sdkRange, '^22.0.0');
});

test('fields read through a list iteration carry the right path', () => {
  const fields = scan.usages
    .filter((u) => u.kind === 'responseField' && u.namespace === 'products')
    .map((u) => u.field);
  assert.ok(
    fields.includes('data[].default_price'),
    `expected data[].default_price, got ${JSON.stringify(fields)}`,
  );
});

// --- resolution units ------------------------------------------------------

test('tsconfig paths are read, comments and all', async () => {
  const aliases = await loadPathAliases(FIXTURE);
  assert.ok(aliases, 'expected aliases from a tsconfig containing comments');
  assert.deepEqual(expandAlias(aliases, FIXTURE, '@/config/constants'), ['src/config/constants']);
  assert.deepEqual(expandAlias(aliases, FIXTURE, 'stripe'), [], 'package imports are not aliases');
});

test('workspace packages map names to directories', async () => {
  const workspaces = await loadWorkspacePackages(FIXTURE);
  assert.equal(workspaces.get('@wrapper/core'), 'packages/core');
});

test('a test mock does not override the real version constant', async () => {
  // formbricks pins 2026-02-25 in constants.ts and a different value in its
  // vitest setup; the declaration must win over the mock.
  const result = await scanRepo(FIXTURE, { methodMap: MAP });
  assert.equal(result.version.apiVersion, '2025-09-30.clover');
});
