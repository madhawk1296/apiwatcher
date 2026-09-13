import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChangesetSync } from './changesets.js';
import { Store } from './db.js';
import { runScan } from './scan-job.js';
import type { ScanRequest } from './queue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '../../apiwatcher/test/fixtures/sample-app');

/**
 * The scan job end to end with git and GitHub swapped out: the "checkout" is the
 * fixture directory on disk, the token is a constant, and posting is off. What
 * remains is exactly what runs on the box — changeset loading, the scanner, the
 * report, and the database record.
 */
async function withDeps<T>(fn: (deps: Parameters<typeof runScan>[0], store: Store) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'apiwatcher-test-'));
  const store = new Store(':memory:');
  const changesets = new ChangesetSync(dataDir, 'https://example.invalid/changesets/stripe/index.json');
  await changesets.seed();
  try {
    return await fn(
      {
        creds: { appId: '1', privateKey: 'unused' },
        store,
        changesets,
        dataDir,
        appSlug: 'apiwatcher-app',
        getToken: async () => 'test-token',
        checkout: async () => ({ dir: FIXTURE, cleanup: async () => {} }),
        post: false,
      },
      store,
    );
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function request(extra: Partial<ScanRequest> = {}): ScanRequest {
  return {
    fullName: 'acme/shop',
    installationId: 1,
    sha: 'deadbeefcafe',
    trigger: 'manual',
    targetVersion: 'latest',
    updateIssue: false,
    postCheck: false,
    requestedAt: new Date().toISOString(),
    ...extra,
  };
}

test('seeds changesets from the bundled CLI package', async () => {
  await withDeps(async (deps) => {
    const latest = await deps.changesets.latest();
    assert.equal(latest, '2026-08-26.dahlia');
  });
});

test('scans the fixture and records the breaking change', async () => {
  await withDeps(async (deps, store) => {
    store.putRepo({
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
    });

    const outcome = await runScan(deps, request());

    assert.equal(outcome.error, null);
    assert.ok(outcome.report);
    assert.equal(outcome.report?.totals.breaking, 1);
    assert.equal(outcome.report?.currentVersion, '2025-09-30.clover');
    assert.equal(outcome.report?.targetVersion, '2026-08-26.dahlia');

    const saved = store.getScan(outcome.scanId);
    assert.equal(saved?.breaking, 1);
    assert.equal(saved?.trigger, 'manual');
    assert.equal(saved?.sha, 'deadbeefcafe');
    assert.ok(saved?.reportJson, 'the full report is stored for the admin API');

    // The pinned version learned from the scan feeds the alert filter.
    assert.equal(store.getRepo('acme/shop')?.apiVersion, '2025-09-30.clover');
  });
});

test('an explicit target version is honoured', async () => {
  await withDeps(async (deps) => {
    const outcome = await runScan(deps, request({ targetVersion: '2026-08-26.dahlia' }));
    assert.equal(outcome.report?.targetVersion, '2026-08-26.dahlia');
  });
});

test('a failed checkout is recorded as an error, never thrown', async () => {
  await withDeps(async (deps, store) => {
    const outcome = await runScan(
      { ...deps, checkout: async () => Promise.reject(new Error('git fetch failed: not found')) },
      request(),
    );
    assert.equal(outcome.report, null);
    assert.match(outcome.error ?? '', /git fetch failed/);
    assert.equal(store.getScan(outcome.scanId)?.error, outcome.error);
  });
});

test('the clone is cleaned up even when the scan fails', async () => {
  await withDeps(async (deps) => {
    let cleaned = false;
    await runScan(
      {
        ...deps,
        checkout: async () => ({
          dir: '/nonexistent/path/that/will/fail',
          cleanup: async () => {
            cleaned = true;
          },
        }),
      },
      request(),
    );
    assert.equal(cleaned, true);
  });
});
