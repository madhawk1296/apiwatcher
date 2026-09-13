import { alertAffectedRepos } from './alert.js';
import type { ChangesetSync } from './changesets.js';
import type { Store } from './db.js';
import type { ScanQueue } from './queue.js';
import * as log from './log.js';

const LAST_KNOWN = 'lastKnownVersion';

/**
 * Notice a new Stripe version and fan it out.
 *
 * The spec watcher commits changesets to the repo; this just pulls them down on
 * an interval and compares the newest against what it last acted on. On the very
 * first boot it records a baseline without alerting — otherwise a fresh server
 * would notify every repo about a version that is not news to anyone.
 */
export interface PollerDeps {
  store: Store;
  changesets: ChangesetSync;
  queue: ScanQueue;
  intervalMinutes: number;
  reportRetentionDays: number;
}

export async function pollOnce(deps: PollerDeps): Promise<void> {
  const { latest, added } = await deps.changesets.sync();
  if (added.length > 0) log.info(`changesets: fetched ${added.join(', ')}`);
  if (!latest) return;

  const known = deps.store.getMeta(LAST_KNOWN);
  if (known === null) {
    deps.store.setMeta(LAST_KNOWN, latest);
    log.info(`changesets: baseline ${latest}`);
    return;
  }
  if (known === latest) return;

  log.info(`new Stripe version ${latest} (was ${known}); fanning out`);
  const result = alertAffectedRepos(deps.store, deps.queue, latest);
  deps.store.setMeta(LAST_KNOWN, latest);
  log.info(`fan-out ${latest}: queued ${result.queued.length}, skipped ${result.skipped.length} of ${result.considered}`);

  const pruned = deps.store.pruneReports(deps.reportRetentionDays);
  if (pruned > 0) log.info(`pruned ${pruned} stored report(s) older than ${deps.reportRetentionDays} days`);
}

export function startPoller(deps: PollerDeps): () => void {
  const tick = async (): Promise<void> => {
    try {
      await pollOnce(deps);
    } catch (err) {
      // The next tick retries; a flaky fetch should not take the process down.
      log.warn(`poll failed: ${(err as Error).message}`);
    }
  };
  void tick();
  const timer = setInterval(tick, deps.intervalMinutes * 60_000);
  return () => clearInterval(timer);
}
