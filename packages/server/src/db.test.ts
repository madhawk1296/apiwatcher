import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Store } from './db.js';

const base = {
  fullName: 'acme/shop',
  installationId: 7,
  defaultBranch: 'main',
  private: true,
  stripeRange: '^22.0.0',
  apiVersion: null,
  target: 'latest',
  alerts: true,
  scanOnPush: true,
  lastAlertedVersion: null,
};

test('repo upsert round-trips and is case-insensitive on lookup', () => {
  const store = new Store(':memory:');
  store.putRepo(base);
  const got = store.getRepo('ACME/Shop');
  assert.equal(got?.fullName, 'acme/shop');
  assert.equal(got?.private, true);
  assert.equal(got?.stripeRange, '^22.0.0');
  assert.equal(store.listRepos().length, 1);
});

test('re-indexing keeps what only a scan can know', () => {
  const store = new Store(':memory:');
  store.putRepo(base);
  store.setRepoApiVersion('acme/shop', '2025-09-30.clover');
  store.setLastAlerted('acme/shop', '2026-08-26.dahlia');

  // The indexer passes null for fields it cannot see; they must survive.
  store.putRepo({ ...base, stripeRange: '^23.0.0' });

  const got = store.getRepo('acme/shop');
  assert.equal(got?.stripeRange, '^23.0.0', 'indexed fields update');
  assert.equal(got?.apiVersion, '2025-09-30.clover', 'scan-learned field survives');
  assert.equal(got?.lastAlertedVersion, '2026-08-26.dahlia', 'alert state survives');
});

test('deleting an installation removes only its repos', () => {
  const store = new Store(':memory:');
  store.putRepo(base);
  store.putRepo({ ...base, fullName: 'acme/other', installationId: 8 });
  assert.equal(store.deleteInstallation(7), 1);
  assert.equal(store.getRepo('acme/shop'), null);
  assert.ok(store.getRepo('acme/other'));
});

test('scans are recorded, listed newest first, and reports pruned by age', async () => {
  const store = new Store(':memory:');
  const id = store.recordScan({
    fullName: 'acme/shop',
    sha: 'abc',
    trigger: 'push',
    targetVersion: '2026-08-26.dahlia',
    currentVersion: '2025-09-30.clover',
    breaking: 2,
    deprecating: 0,
    additive: 0,
    filesScanned: 40,
    reportJson: '{"ok":true}',
    error: null,
  });

  assert.equal(store.getScan(id)?.reportJson, '{"ok":true}');
  assert.equal(store.latestScan('acme/shop')?.id, id);
  // The listing omits bodies so it stays cheap.
  assert.equal(store.recentScans()[0]?.reportJson, null);

  assert.equal(store.pruneReports(30), 0, 'a fresh report is kept');
  // The cutoff is "strictly older than now"; give the clock a tick so the row
  // written a moment ago is not in the same millisecond.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(store.pruneReports(0), 1, 'zero-day retention prunes it');
  assert.equal(store.getScan(id)?.reportJson, null);
  assert.equal(store.getScan(id)?.breaking, 2, 'the summary row stays');
});

test('meta is a simple key/value', () => {
  const store = new Store(':memory:');
  assert.equal(store.getMeta('lastKnownVersion'), null);
  store.setMeta('lastKnownVersion', 'a');
  store.setMeta('lastKnownVersion', 'b');
  assert.equal(store.getMeta('lastKnownVersion'), 'b');
});

test('users, installations, and repo visibility', () => {
  const store = new Store(':memory:');
  store.putRepo({ ...base, fullName: 'acme/shop', installationId: 7 });
  store.putRepo({ ...base, fullName: 'other/app', installationId: 9 });
  store.upsertUser({ githubId: 1, login: 'cris', name: null, email: 'c@x.io', avatarUrl: null });
  store.setUserInstallations(1, [{ id: 7, accountLogin: 'acme' }]);

  assert.deepEqual(store.reposForUser(1).map((r) => r.fullName), ['acme/shop']);
  assert.equal(store.userCanSeeRepo(1, 'ACME/shop'), true);
  assert.equal(store.userCanSeeRepo(1, 'other/app'), false, 'a repo in an installation the user lacks is invisible');

  // Sign-in refreshes the list wholesale.
  store.setUserInstallations(1, [{ id: 9, accountLogin: 'other' }]);
  assert.deepEqual(store.reposForUser(1).map((r) => r.fullName), ['other/app']);

  // Email survives a later sign-in that reports none.
  store.upsertUser({ githubId: 1, login: 'cris', name: 'C', email: null, avatarUrl: null });
  assert.equal(store.getUser(1)?.email, 'c@x.io');
});

test('digest recipients and once-only sending', () => {
  const store = new Store(':memory:');
  store.putRepo({ ...base, fullName: 'acme/shop', installationId: 7 });
  store.upsertUser({ githubId: 1, login: 'a', name: null, email: 'a@x.io', avatarUrl: null });
  store.upsertUser({ githubId: 2, login: 'b', name: null, email: 'b@x.io', avatarUrl: null });
  store.setUserInstallations(1, [{ id: 7, accountLogin: 'acme' }]);
  store.setUserInstallations(2, [{ id: 7, accountLogin: 'acme' }]);
  store.setPrefs({ githubId: 1, email: 'a@x.io', notifyOn: 'breaking', slackWebhook: null });
  store.setPrefs({ githubId: 2, email: 'b@x.io', notifyOn: 'never', slackWebhook: null });

  assert.deepEqual(store.digestRecipients(7).map((r) => r.login), ['a'], 'never means never');
  assert.equal(store.digestAlreadySent('v', 7), false);
  store.markDigestSent('v', 7, 1);
  store.markDigestSent('v', 7, 1);
  assert.equal(store.digestAlreadySent('v', 7), true);
});
