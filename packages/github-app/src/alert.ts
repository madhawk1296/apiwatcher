import { dispatchScan, getInstallationToken, GitHubError, parseFullName } from './github.js';
import { iterateRepos, putRepo, setLastKnownVersion, type Env, type RepoRecord } from './store.js';

/**
 * Fan out a new Stripe version to the repos it could affect.
 *
 * The app does not decide what breaks — it asks each repo's own workflow to scan
 * itself and post the result. That keeps customer code on customer infrastructure
 * and means a noisy version costs us a handful of API calls instead of compute.
 *
 * Quiet by design: a repo is dispatched only when it is tracked, has alerts on,
 * and has not already been told about this version.
 */

export interface AlertResult {
  version: string;
  considered: number;
  dispatched: string[];
  skipped: Array<{ fullName: string; reason: string }>;
  failed: Array<{ fullName: string; error: string }>;
}

/** Date part of a Stripe version; what actually orders them. */
function versionDate(version: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(version.trim());
  return m?.[1] ?? null;
}

/**
 * Would this repo care about `version`?
 *
 * A repo pinned to a target at or beyond the new version has nothing to do, and
 * one we have already notified should not be nagged twice.
 */
export function shouldAlert(record: RepoRecord, version: string): { alert: boolean; reason: string } {
  if (!record.alerts) return { alert: false, reason: 'alerts disabled in config' };
  if (record.lastAlertedVersion === version) return { alert: false, reason: 'already alerted' };

  if (record.target !== 'latest') {
    const target = versionDate(record.target);
    const incoming = versionDate(version);
    if (target && incoming && target < incoming) {
      return { alert: false, reason: `pinned to ${record.target}` };
    }
  }

  if (record.apiVersion) {
    const current = versionDate(record.apiVersion);
    const incoming = versionDate(version);
    if (current && incoming && current >= incoming) {
      return { alert: false, reason: `already on ${record.apiVersion}` };
    }
  }

  return { alert: true, reason: 'tracked and behind' };
}

export async function alertAffectedRepos(
  env: Env,
  version: string,
  options: { dryRun?: boolean } = {},
): Promise<AlertResult> {
  const result: AlertResult = {
    version,
    considered: 0,
    dispatched: [],
    skipped: [],
    failed: [],
  };

  for await (const record of iterateRepos(env)) {
    result.considered += 1;

    const verdict = shouldAlert(record, version);
    if (!verdict.alert) {
      result.skipped.push({ fullName: record.fullName, reason: verdict.reason });
      continue;
    }

    const ref = parseFullName(record.fullName);
    if (!ref) {
      result.failed.push({ fullName: record.fullName, error: 'unparseable name' });
      continue;
    }

    if (options.dryRun) {
      result.dispatched.push(record.fullName);
      continue;
    }

    try {
      const token = await getInstallationToken(env, record.installationId);
      await dispatchScan(token, ref, {
        targetVersion: version,
        reason: `Stripe API version ${version} was released`,
      });
      // Record the attempt so a retry of this cron does not double-notify.
      await putRepo(env, { ...record, lastAlertedVersion: version, updatedAt: new Date().toISOString() });
      result.dispatched.push(record.fullName);
    } catch (err) {
      const message =
        err instanceof GitHubError
          ? // 404 on dispatch almost always means the workflow file is missing.
            `${err.status}${err.status === 404 ? ' (is .github/workflows/apimigrate.yml installed?)' : ''}`
          : (err as Error).message;
      result.failed.push({ fullName: record.fullName, error: message });
    }
  }

  if (!options.dryRun) await setLastKnownVersion(env, version);
  return result;
}
