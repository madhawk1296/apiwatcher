import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Store } from './db.js';
import type { Indexer } from './indexer.js';
import { ScanQueue, type ScanRequest } from './queue.js';
import { handleWebhook, isScanRelevant } from './webhook.js';

const CREDS = { appId: '1', privateKey: 'unused' };

function harness(opts: { tracked?: boolean; scanOnPush?: boolean } = {}) {
  const store = new Store(':memory:');
  if (opts.tracked !== false) {
    store.putRepo({
      fullName: 'acme/shop',
      installationId: 42,
      defaultBranch: 'main',
      private: false,
      stripeRange: '^22.0.0',
      apiVersion: null,
      target: 'latest',
      alerts: true,
      scanOnPush: opts.scanOnPush ?? true,
      lastAlertedVersion: null,
    });
  }
  const queued: ScanRequest[] = [];
  // Capture requests without running anything.
  const queue = new ScanQueue(async () => {}, 1);
  const realEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = (r) => {
    queued.push(r);
    return realEnqueue(r);
  };
  const indexed: string[] = [];
  const indexer: Indexer = {
    async indexRepo(_id, summary) {
      indexed.push(summary.full_name);
      return { fullName: summary.full_name, tracked: true, reason: 'stripe ^22' };
    },
    async indexInstallation() {
      return [];
    },
  };
  return { store, queue, queued, indexer, indexed, deps: { creds: CREDS, store, indexer, queue } };
}

const repo = { full_name: 'acme/shop', default_branch: 'main', private: false, archived: false };

test('isScanRelevant: source and manifests yes, everything else no', () => {
  assert.equal(isScanRelevant(['src/billing.ts']), true);
  assert.equal(isScanRelevant(['apps/web/lib/x.tsx']), true);
  assert.equal(isScanRelevant(['package.json']), true);
  assert.equal(isScanRelevant(['packages/core/package.json']), true);
  assert.equal(isScanRelevant(['pnpm-lock.yaml']), true);
  assert.equal(isScanRelevant(['.apiwatcher.json']), true);
  assert.equal(isScanRelevant(['README.md', 'docs/a.md', 'styles.css', '.github/workflows/ci.yml']), false);
  assert.equal(isScanRelevant([]), false);
});

test('a default-branch push touching source queues a scan with check + issue', async () => {
  const h = harness();
  const out = await handleWebhook(h.deps, 'push', {
    installation: { id: 42 },
    repository: repo,
    ref: 'refs/heads/main',
    after: 'abc1234def',
    commits: [{ modified: ['src/checkout.ts'] }],
  });
  assert.match(out.summary, /scan queued/);
  assert.equal(h.queued.length, 1);
  assert.equal(h.queued[0]?.sha, 'abc1234def');
  assert.equal(h.queued[0]?.trigger, 'push');
  assert.equal(h.queued[0]?.postCheck, true);
  assert.equal(h.queued[0]?.updateIssue, true);
});

test('a push touching only docs is ignored without a clone', async () => {
  const h = harness();
  const out = await handleWebhook(h.deps, 'push', {
    installation: { id: 42 },
    repository: repo,
    ref: 'refs/heads/main',
    after: 'abc1234def',
    commits: [{ modified: ['README.md'] }],
  });
  assert.match(out.summary, /no relevant file/);
  assert.equal(h.queued.length, 0);
});

test('a push to a non-default branch is ignored', async () => {
  const h = harness();
  const out = await handleWebhook(h.deps, 'push', {
    installation: { id: 42 },
    repository: repo,
    ref: 'refs/heads/feature',
    after: 'abc1234def',
    commits: [{ modified: ['src/checkout.ts'] }],
  });
  assert.match(out.summary, /not the default branch/);
  assert.equal(h.queued.length, 0);
});

test('a push that changes package.json re-indexes and then scans', async () => {
  const h = harness();
  await handleWebhook(h.deps, 'push', {
    installation: { id: 42 },
    repository: repo,
    ref: 'refs/heads/main',
    after: 'abc1234def',
    commits: [{ modified: ['package.json'] }],
  });
  assert.deepEqual(h.indexed, ['acme/shop']);
  assert.equal(h.queued.length, 1, 'a dependency change can change the report');
});

test('an untracked repo is never scanned on push', async () => {
  const h = harness({ tracked: false });
  const out = await handleWebhook(h.deps, 'push', {
    installation: { id: 42 },
    repository: repo,
    ref: 'refs/heads/main',
    after: 'abc1234def',
    commits: [{ modified: ['src/x.ts'] }],
  });
  assert.match(out.summary, /not tracked/);
  assert.equal(h.queued.length, 0);
});

test('scanOnPush: false keeps the repo tracked but skips push scans', async () => {
  const h = harness({ scanOnPush: false });
  const out = await handleWebhook(h.deps, 'push', {
    installation: { id: 42 },
    repository: repo,
    ref: 'refs/heads/main',
    after: 'abc1234def',
    commits: [{ modified: ['src/x.ts'] }],
  });
  assert.match(out.summary, /scanOnPush is off/);
  assert.equal(h.queued.length, 0);
  assert.ok(h.store.getRepo('acme/shop'), 'still indexed for version alerts');
});

test('a branch deletion is ignored', async () => {
  const h = harness();
  const out = await handleWebhook(h.deps, 'push', {
    installation: { id: 42 },
    repository: repo,
    ref: 'refs/heads/main',
    deleted: true,
    after: '0000000000000000000000000000000000000000',
  });
  assert.match(out.summary, /branch deleted/);
  assert.equal(h.queued.length, 0);
});

test('a repo removed from the installation leaves the index', async () => {
  const h = harness();
  await handleWebhook(h.deps, 'installation_repositories', {
    installation: { id: 42 },
    repositories_removed: [{ full_name: 'acme/shop' }],
  });
  assert.equal(h.store.getRepo('acme/shop'), null);
});

test('uninstall drops every repo of that installation', async () => {
  const h = harness();
  h.store.putRepo({
    fullName: 'other/one',
    installationId: 99,
    defaultBranch: 'main',
    private: false,
    stripeRange: '^1',
    apiVersion: null,
    target: 'latest',
    alerts: true,
    scanOnPush: true,
    lastAlertedVersion: null,
  });
  const out = await handleWebhook(h.deps, 'installation', { action: 'deleted', installation: { id: 42 } });
  assert.match(out.summary, /removed 1 repo/);
  assert.equal(h.store.getRepo('acme/shop'), null);
  assert.ok(h.store.getRepo('other/one'), 'a different installation is untouched');
});

test('unsubscribed events are acknowledged, not errors', async () => {
  const h = harness();
  const out = await handleWebhook(h.deps, 'star', { action: 'created' });
  assert.equal(out.summary, 'not subscribed');
});
