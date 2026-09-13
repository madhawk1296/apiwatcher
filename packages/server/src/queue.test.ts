import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ScanQueue, type ScanRequest } from './queue.js';

function request(fullName: string, sha: string, extra: Partial<ScanRequest> = {}): ScanRequest {
  return {
    fullName,
    installationId: 1,
    sha,
    trigger: 'push',
    targetVersion: 'latest',
    updateIssue: false,
    postCheck: false,
    requestedAt: new Date().toISOString(),
    ...extra,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('runs jobs and reports each once', async () => {
  const ran: string[] = [];
  const q = new ScanQueue(async (r) => {
    ran.push(`${r.fullName}@${r.sha}`);
  }, 2);

  q.enqueue(request('a/x', '1'));
  q.enqueue(request('b/y', '2'));
  await q.drain();

  assert.deepEqual(ran.sort(), ['a/x@1', 'b/y@2']);
  assert.equal(q.size, 0);
});

test('pushes to one repo during a scan collapse into a single follow-up of the newest sha', async () => {
  const ran: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));

  const q = new ScanQueue(async (r) => {
    ran.push(r.sha);
    if (r.sha === '1') await gate; // hold the first scan open
  }, 1);

  q.enqueue(request('a/x', '1'));
  await sleep(10);
  assert.equal(q.enqueue(request('a/x', '2')), 'coalesced');
  assert.equal(q.enqueue(request('a/x', '3')), 'replaced');
  assert.equal(q.enqueue(request('a/x', '4')), 'replaced');

  release();
  await q.drain();

  // Three pushes during the scan -> exactly one follow-up, of the last sha.
  assert.deepEqual(ran, ['1', '4']);
});

test('coalescing keeps posting obligations from the request it replaced', async () => {
  const seen: ScanRequest[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));

  const q = new ScanQueue(async (r) => {
    seen.push(r);
    if (r.sha === '1') await gate;
  }, 1);

  q.enqueue(request('a/x', '1'));
  await sleep(10);
  q.enqueue(request('a/x', '2', { postCheck: true, updateIssue: false }));
  q.enqueue(request('a/x', '3', { postCheck: false, updateIssue: true }));
  release();
  await q.drain();

  const followUp = seen[1];
  assert.equal(followUp?.sha, '3');
  assert.equal(followUp?.postCheck, true, 'the PR check owed by sha 2 must not be dropped');
  assert.equal(followUp?.updateIssue, true);
});

test('concurrency is bounded', async () => {
  let active = 0;
  let peak = 0;
  const q = new ScanQueue(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(20);
    active -= 1;
  }, 2);

  for (let i = 0; i < 6; i++) q.enqueue(request(`r/${i}`, 's'));
  await q.drain();
  assert.equal(peak, 2);
});

test('a crashing runner does not wedge the queue', async () => {
  const ran: string[] = [];
  const logged: string[] = [];
  const q = new ScanQueue(
    async (r) => {
      if (r.fullName === 'bad/one') throw new Error('boom');
      ran.push(r.fullName);
    },
    1,
    (m) => logged.push(m),
  );

  q.enqueue(request('bad/one', '1'));
  q.enqueue(request('good/two', '2'));
  await q.drain();

  assert.deepEqual(ran, ['good/two']);
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? '', /crashed: boom/);
  assert.equal(q.inFlight, 0);
});
