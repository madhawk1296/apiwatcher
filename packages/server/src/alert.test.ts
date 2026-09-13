import assert from 'node:assert/strict';
import { test } from 'node:test';

import { alertAffectedRepos, shouldAlert } from './alert.js';
import { Store, type RepoRecord } from './db.js';
import { ScanQueue } from './queue.js';

function record(overrides: Partial<RepoRecord> = {}): RepoRecord {
  return {
    fullName: 'acme/shop',
    installationId: 1,
    defaultBranch: 'main',
    private: false,
    stripeRange: '^22',
    apiVersion: null,
    target: 'latest',
    alerts: true,
    scanOnPush: true,
    lastAlertedVersion: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const V = '2026-08-26.dahlia';

test('a tracked repo behind the new version is alerted', () => {
  assert.equal(shouldAlert(record(), V).alert, true);
});

test('alerts off in config means silence', () => {
  assert.equal(shouldAlert(record({ alerts: false }), V).alert, false);
});

test('a repo already told about this version is not told twice', () => {
  assert.equal(shouldAlert(record({ lastAlertedVersion: V }), V).alert, false);
});

test('a repo pinned to an older target does not care about newer versions', () => {
  const verdict = shouldAlert(record({ target: '2025-09-30.clover' }), V);
  assert.equal(verdict.alert, false);
  assert.match(verdict.reason, /pinned/);
});

test('a repo whose last scan showed it already on the version is skipped', () => {
  // apiVersion is learned from scans, which is what makes this filter real.
  assert.equal(shouldAlert(record({ apiVersion: '2026-08-26.dahlia' }), V).alert, false);
  assert.equal(shouldAlert(record({ apiVersion: '2025-09-30.clover' }), V).alert, true);
});

test('fan-out queues one scan per affected repo and marks it alerted', async () => {
  const store = new Store(':memory:');
  store.putRepo({ ...record({ fullName: 'a/behind' }) });
  store.putRepo({ ...record({ fullName: 'b/quiet', alerts: false }) });
  store.putRepo({ ...record({ fullName: 'c/current', apiVersion: V }) });

  const ran: string[] = [];
  const queue = new ScanQueue(async (r) => {
    ran.push(r.fullName);
  }, 2);

  const result = alertAffectedRepos(store, queue, V);
  await queue.drain();

  assert.deepEqual(result.queued, ['a/behind']);
  assert.equal(result.skipped.length, 2);
  assert.deepEqual(ran, ['a/behind']);
  assert.equal(store.getRepo('a/behind')?.lastAlertedVersion, V);

  // Second fan-out for the same version is a no-op.
  const again = alertAffectedRepos(store, queue, V);
  assert.deepEqual(again.queued, []);
});

test('dry run reports without queueing or marking', async () => {
  const store = new Store(':memory:');
  store.putRepo(record());
  const ran: string[] = [];
  const queue = new ScanQueue(async (r) => {
    ran.push(r.fullName);
  }, 1);

  const result = alertAffectedRepos(store, queue, V, { dryRun: true });
  await queue.drain();

  assert.deepEqual(result.queued, ['acme/shop']);
  assert.deepEqual(ran, []);
  assert.equal(store.getRepo('acme/shop')?.lastAlertedVersion, null);
});
