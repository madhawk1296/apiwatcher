import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Store, type ScanRecord } from './db.js';
import { assembleDigest, renderEmail, renderSlack, sendDigests, wantsDigest, type Transport } from './digest.js';

const V = '2026-09-30.dahlia';

function scan(fullName: string, breaking: number, deprecating = 0, error: string | null = null): ScanRecord {
  return {
    id: 0,
    fullName,
    sha: 'abc1234def',
    trigger: 'new_version',
    targetVersion: V,
    currentVersion: '2026-02-25.clover',
    breaking,
    deprecating,
    additive: 0,
    filesScanned: 10,
    reportJson: null,
    error,
    createdAt: new Date().toISOString(),
  };
}

test('assembleDigest sorts affected repos worst first and counts the rest', () => {
  const d = assembleDigest(V, 7, [scan('a/clean', 0), scan('b/two', 2), scan('c/five', 5), scan('d/dep', 0, 1), scan('e/err', 0, 0, 'boom')]);
  assert.deepEqual(d.affected.map((r) => r.fullName), ['c/five', 'b/two', 'd/dep']);
  assert.equal(d.clean, 1);
  assert.equal(d.failed, 1);
  assert.equal(d.total, 5);
});

test('wantsDigest respects each recipient threshold', () => {
  const breaking = assembleDigest(V, 1, [scan('a/x', 1)]);
  const depOnly = assembleDigest(V, 1, [scan('a/x', 0, 2)]);
  assert.equal(wantsDigest('breaking', breaking), true);
  assert.equal(wantsDigest('breaking', depOnly), false, 'breaking-only subscribers stay quiet for deprecations');
  assert.equal(wantsDigest('deprecating', depOnly), true);
  assert.equal(wantsDigest('never', breaking), false);
});

test('email and slack renderings carry the essentials', () => {
  const d = assembleDigest(V, 1, [scan('acme/shop', 3), scan('acme/site', 0)]);
  const email = renderEmail(d, 'https://app.example.com/');
  assert.equal(email.subject, `Stripe ${V}: 1 of 2 repositories affected`);
  assert.match(email.text, /acme\/shop — 3 breaking/);
  assert.match(email.text, /https:\/\/app\.example\.com\/changelog\/2026-09-30\.dahlia/);
  assert.match(email.html, /acme\/shop/);
  assert.doesNotMatch(email.html, /<script/i);
  const slack = renderSlack(d, 'https://app.example.com');
  assert.match(slack.text, /acme\/shop.*3 breaking/);
});

function harness() {
  const store = new Store(':memory:');
  const base = { defaultBranch: 'main', private: false, stripeRange: '^22', apiVersion: null, target: 'latest', alerts: true, scanOnPush: true, lastAlertedVersion: null };
  store.putRepo({ ...base, fullName: 'acme/shop', installationId: 7 });
  store.putRepo({ ...base, fullName: 'acme/site', installationId: 7 });
  store.putRepo({ ...base, fullName: 'other/app', installationId: 9 });
  for (const s of [scan('acme/shop', 2), scan('acme/site', 0), scan('other/app', 0)]) {
    store.recordScan({ ...s });
  }
  store.upsertUser({ githubId: 1, login: 'ann', name: null, email: 'ann@acme.io', avatarUrl: null });
  store.upsertUser({ githubId: 2, login: 'bob', name: null, email: 'bob@other.io', avatarUrl: null });
  store.setUserInstallations(1, [{ id: 7, accountLogin: 'acme' }]);
  store.setUserInstallations(2, [{ id: 9, accountLogin: 'other' }]);
  store.setPrefs({ githubId: 1, email: 'ann@acme.io', notifyOn: 'breaking', slackWebhook: 'https://hooks.slack.com/x' });
  store.setPrefs({ githubId: 2, email: 'bob@other.io', notifyOn: 'breaking', slackWebhook: null });

  const sent: string[] = [];
  const transport: Transport = {
    async email(to, msg) {
      sent.push(`email:${to}:${msg.subject}`);
    },
    async slack(webhook) {
      sent.push(`slack:${webhook}`);
    },
  };
  return { store, sent, transport };
}

test('sendDigests messages only affected installations, once', async () => {
  const h = harness();
  const first = await sendDigests({ store: h.store, transport: h.transport, publicUrl: 'https://app.example.com' }, V);

  assert.deepEqual(first.sent, [{ installationId: 7, emails: 1, slacks: 1 }]);
  assert.deepEqual(first.skipped, [{ installationId: 9, reason: 'nothing affected' }], 'bob hears nothing: nothing of his is affected');
  assert.deepEqual(h.sent.sort(), [`email:ann@acme.io:Stripe ${V}: 1 of 2 repositories affected`, 'slack:https://hooks.slack.com/x']);

  const again = await sendDigests({ store: h.store, transport: h.transport, publicUrl: 'https://app.example.com' }, V);
  assert.equal(again.sent.length, 0);
  assert.equal(h.sent.length, 2, 'a second run sends nothing');
});

test('a failing provider does not block the other recipient channels', async () => {
  const h = harness();
  const flaky: Transport = {
    async email() {
      throw new Error('Resend 500');
    },
    slack: h.transport.slack,
  };
  const result = await sendDigests({ store: h.store, transport: flaky, publicUrl: 'https://app.example.com' }, V);
  assert.deepEqual(result.sent, [{ installationId: 7, emails: 0, slacks: 1 }]);
  assert.equal(h.store.digestAlreadySent(V, 7), true);
});
