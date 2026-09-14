import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanRepo } from './scan.js';
import { resolveCall, extractStripePath } from './ast.js';
import { matchesIgnore } from './walk.js';
import { loadMethodMap, type MethodMap } from '../specdiff/methodmap.js';
import type { Usage } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '../../test/fixtures/sample-app');

/** Hand-built map so the scanner tests do not depend on a generated artifact. */
const MAP: MethodMap = {
  sdkVersion: 'test',
  generatedAt: new Date(0).toISOString(),
  byEndpoint: {
    'post /v1/payment_intents': [{ namespace: 'paymentIntents', method: 'create' }],
    'post /v1/checkout/sessions': [{ namespace: 'checkout.sessions', method: 'create' }],
    'get /v1/refunds': [{ namespace: 'refunds', method: 'list' }],
    'post /v1/terminal/configurations/{id}': [
      { namespace: 'terminal.configurations', method: 'update' },
    ],
  },
  byCall: {
    'paymentIntents.create': { method: 'post', path: '/v1/payment_intents' },
    'checkout.sessions.create': { method: 'post', path: '/v1/checkout/sessions' },
    'refunds.list': { method: 'get', path: '/v1/refunds' },
    'terminal.configurations.update': { method: 'post', path: '/v1/terminal/configurations/{id}' },
  },
};

function find(usages: readonly Usage[], kind: Usage['kind'], predicate: (u: Usage) => boolean): Usage[] {
  return usages.filter((u) => u.kind === kind && predicate(u));
}

test('resolveCall matches the longest namespace suffix', () => {
  assert.deepEqual(resolveCall(MAP, ['paymentIntents', 'create'])?.namespace, 'paymentIntents');
  assert.deepEqual(resolveCall(MAP, ['checkout', 'sessions', 'create'])?.namespace, 'checkout.sessions');
});

test('resolveCall sees through a wrapper prefix', () => {
  // `payments.client.checkout.sessions.create(...)` still resolves.
  const resolved = resolveCall(MAP, ['client', 'checkout', 'sessions', 'create']);
  assert.equal(resolved?.namespace, 'checkout.sessions');
  assert.equal(resolved?.droppedPrefix, 1);
  assert.equal(resolved?.path, '/v1/checkout/sessions');
});

test('resolveCall rejects a chain that is not a Stripe call', () => {
  assert.equal(resolveCall(MAP, ['orders', 'create']), null);
  assert.equal(resolveCall(MAP, ['create']), null);
});

test('extractStripePath reads full URLs and bare v1 paths', () => {
  assert.deepEqual(extractStripePath('https://api.stripe.com/v1/charges'), {
    path: '/v1/charges',
    viaHost: true,
  });
  // Query strings are not part of the endpoint.
  assert.equal(extractStripePath('https://api.stripe.com/v1/charges?limit=3')?.path, '/v1/charges');
  assert.deepEqual(extractStripePath('/v1/customers'), { path: '/v1/customers', viaHost: false });
  assert.equal(extractStripePath('https://example.com/v1/charges'), null);
  assert.equal(extractStripePath('just a string'), null);
});

test('matchesIgnore handles bare names, globs and double-star', () => {
  assert.equal(matchesIgnore('src/generated/api.ts', ['generated']), true);
  assert.equal(matchesIgnore('src/a/b/c.ts', ['src/**']), true);
  assert.equal(matchesIgnore('src/a.ts', ['src/*.ts']), true);
  assert.equal(matchesIgnore('src/a/b.ts', ['src/*.ts']), false);
  assert.equal(matchesIgnore('lib/x.ts', ['generated']), false);
});

// --- end-to-end over the fixture repo --------------------------------------

test('the scanner resolves a client imported through a barrel re-export', async () => {
  const scan = await scanRepo(FIXTURE, { methodMap: MAP });

  // `new Stripe(...)` lives in lib/payments.ts; routes import it via lib/index.ts.
  const calls = find(scan.usages, 'sdkCall', (u) => u.namespace === 'checkout.sessions');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.confidence, 1, 'a resolved client binding should be full confidence');
  assert.equal(calls[0]?.evidence.file, 'src/routes/checkout.ts');
});

test('the scanner reads the pinned apiVersion and the declared SDK range', async () => {
  const scan = await scanRepo(FIXTURE, { methodMap: MAP });
  assert.equal(scan.version.apiVersion, '2025-09-30.clover');
  assert.equal(scan.version.sdkRange, '^22.0.0');
  assert.equal(scan.version.apiVersionEvidence?.file, 'src/lib/payments.ts');
});

test('the scanner records request parameters with their nested paths', async () => {
  const scan = await scanRepo(FIXTURE, { methodMap: MAP });
  const fields = find(scan.usages, 'requestParam', (u) => u.namespace === 'terminal.configurations').map(
    (u) => u.field,
  );
  assert.ok(fields.includes('tipping'), 'top-level key');
  assert.ok(fields.includes('tipping.bgn'), 'nested key');
});

test('the scanner attributes fields read inside a .map callback', async () => {
  const scan = await scanRepo(FIXTURE, { methodMap: MAP });
  const fields = find(scan.usages, 'responseField', (u) => u.namespace === 'refunds').map((u) => u.field);

  // `refunds.data.map((r) => r.destination_details)` — the array marker must sit
  // on `data`, or the path will not line up with a spec path of `data[].x`.
  assert.ok(
    fields.includes('data[].destination_details'),
    `expected data[].destination_details, got ${JSON.stringify(fields)}`,
  );
});

test('the scanner finds a raw REST call written as a template literal', async () => {
  const scan = await scanRepo(FIXTURE, { methodMap: MAP });
  const raw = find(scan.usages, 'rawUrl', () => true);
  assert.equal(raw.length, 1);
  assert.equal(raw[0]?.path, '/v1/payment_intents/{}/cancel');
  assert.equal(raw[0]?.httpMethod, 'post', 'verb should come from the fetch options');
  assert.equal(raw[0]?.confidence, 1, 'an api.stripe.com URL is unambiguous');
});

test('the scanner finds webhook event types in switch cases', async () => {
  const scan = await scanRepo(FIXTURE, {
    methodMap: MAP,
    knownEvents: new Set(['invoice.payment_failed', 'customer.subscription.deleted']),
  });
  const events = find(scan.usages, 'webhookEvent', () => true).map((u) => u.event);
  assert.deepEqual(events.sort(), ['customer.subscription.deleted', 'invoice.payment_failed']);
  assert.ok(
    find(scan.usages, 'webhookEvent', () => true).every((u) => u.confidence === 1),
    'known events should be full confidence',
  );
});

test('a known-event list suppresses unrelated dotted strings', async () => {
  const scan = await scanRepo(FIXTURE, { methodMap: MAP, knownEvents: new Set(['nothing.matches']) });
  assert.equal(find(scan.usages, 'webhookEvent', () => true).length, 0);
});

test('ignore patterns keep files out of the scan', async () => {
  const all = await scanRepo(FIXTURE, { methodMap: MAP });
  const partial = await scanRepo(FIXTURE, { methodMap: MAP, ignore: ['src/routes'] });
  assert.ok(partial.filesScanned < all.filesScanned);
  assert.equal(find(partial.usages, 'sdkCall', (u) => u.namespace === 'checkout.sessions').length, 0);
});

test('the generated method map covers well-known Stripe calls', async () => {
  const map = await loadMethodMap(join(HERE, '../../data/stripe/method-map.json'));
  // Guards against the stripe package layout changing and the generator silently
  // producing an empty map.
  assert.ok(Object.keys(map.byCall).length > 300, 'expected a populated method map');
  assert.deepEqual(map.byCall['paymentIntents.create'], { method: 'post', path: '/v1/payment_intents' });
  assert.deepEqual(map.byCall['checkout.sessions.create'], {
    method: 'post',
    path: '/v1/checkout/sessions',
  });
  // Three-level namespace, to prove nested containers are walked.
  assert.ok(map.byCall['testHelpers.issuing.authorizations.capture']);
});

test('the scanner looks inside arrays of objects in request params', async () => {
  const scan = await scanRepo(FIXTURE, { methodMap: MAP });
  const fields = find(scan.usages, 'requestParam', (u) => u.namespace === 'checkout.sessions').map((u) => u.field);
  // `line_items: [{ price, quantity }]` — without this, a change to a nested
  // line-item field could never be ruled out and had to be reported.
  assert.ok(fields.includes('line_items[].price'), JSON.stringify(fields));
  assert.ok(fields.includes('line_items[].quantity'));
});
