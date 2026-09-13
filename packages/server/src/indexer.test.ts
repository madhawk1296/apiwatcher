import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickWorkspaceManifests, readStripeRange } from './indexer.js';

test('readStripeRange finds stripe in any dependency section', () => {
  assert.equal(readStripeRange(JSON.stringify({ dependencies: { stripe: '^22.0.0' } })), '^22.0.0');
  assert.equal(readStripeRange(JSON.stringify({ devDependencies: { stripe: '22.4.1' } })), '22.4.1');
  assert.equal(readStripeRange(JSON.stringify({ dependencies: { express: '^4' } })), null);
  assert.equal(readStripeRange('not json'), null);
});

test('pickWorkspaceManifests prefers shallow packages and skips node_modules', () => {
  const picked = pickWorkspaceManifests([
    'package.json',
    'README.md',
    'apps/web/src/deep/nested/thing/package.json',
    'packages/lib/package.json',
    'node_modules/stripe/package.json',
    'apps/web/package.json',
    'packages/lib/node_modules/x/package.json',
  ]);
  assert.deepEqual(picked, ['apps/web/package.json', 'packages/lib/package.json', 'apps/web/src/deep/nested/thing/package.json']);
});

test('pickWorkspaceManifests is capped so a huge monorepo cannot burn the rate limit', () => {
  const many = Array.from({ length: 200 }, (_, i) => `packages/p${i}/package.json`);
  assert.equal(pickWorkspaceManifests(many).length, 25);
});
