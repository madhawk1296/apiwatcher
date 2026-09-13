import type { RepoRecord, Store } from './db.js';
import type { ScanQueue } from './queue.js';

/**
 * Fan a new Stripe version out to the repos it could affect.
 *
 * Quiet by design: a repo is scanned only when it is tracked, has alerts on, is
 * not already known to be on or past the new version, and has not already been
 * told about it. Unaffected repos never hear from us.
 */

export interface AlertResult {
  version: string;
  considered: number;
  queued: string[];
  skipped: Array<{ fullName: string; reason: string }>;
}

function versionDate(version: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(version.trim());
  return m?.[1] ?? null;
}

export function shouldAlert(record: RepoRecord, version: string): { alert: boolean; reason: string } {
  if (!record.alerts) return { alert: false, reason: 'alerts disabled in config' };
  if (record.lastAlertedVersion === version) return { alert: false, reason: 'already alerted' };

  const incoming = versionDate(version);

  if (record.target !== 'latest') {
    const target = versionDate(record.target);
    if (target && incoming && target < incoming) return { alert: false, reason: `pinned to ${record.target}` };
  }

  // Learned from the last scan, so this filter actually works now.
  if (record.apiVersion) {
    const current = versionDate(record.apiVersion);
    if (current && incoming && current >= incoming) return { alert: false, reason: `already on ${record.apiVersion}` };
  }

  return { alert: true, reason: 'tracked and behind' };
}

export function alertAffectedRepos(
  store: Store,
  queue: ScanQueue,
  version: string,
  options: { dryRun?: boolean } = {},
): AlertResult {
  const result: AlertResult = { version, considered: 0, queued: [], skipped: [] };

  for (const record of store.listRepos()) {
    result.considered += 1;
    const verdict = shouldAlert(record, version);
    if (!verdict.alert) {
      result.skipped.push({ fullName: record.fullName, reason: verdict.reason });
      continue;
    }
    if (!options.dryRun) {
      queue.enqueue({
        fullName: record.fullName,
        installationId: record.installationId,
        sha: undefined as unknown as string, // resolved to the default branch at run time
        trigger: 'new_version',
        targetVersion: record.target === 'latest' ? version : record.target,
        updateIssue: true,
        postCheck: false,
        requestedAt: new Date().toISOString(),
      });
      // Recorded on enqueue so a restart mid-fan-out does not double-notify.
      store.setLastAlerted(record.fullName, version);
    }
    result.queued.push(record.fullName);
  }
  return result;
}
