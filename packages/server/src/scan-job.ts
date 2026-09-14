import { join } from 'node:path';

import {
  buildReport,
  changesBetween,
  DEFAULT_CONFIG,
  exitCodeFor,
  latestKnownVersion,
  loadConfig as loadRepoConfig,
  oldestCoveredVersion,
  loadEventCatalog,
  loadMethodMap,
  scanRepo,
  type ImpactReport,
  type RepoConfig,
} from 'apiwatcher-cli';

import type { ChangesetSync } from './changesets.js';
import type { Store } from './db.js';
import { checkoutCommit, type Checkout } from './git.js';
import { getBranchSha, getInstallationToken, parseFullName, type AppCredentials, type RepoRef } from './github.js';
import { closeTrackingIssue, completeCheck, failCheckNeutrally, openCheck, upsertTrackingIssue } from './post.js';
import type { ScanRequest } from './queue.js';
import * as log from './log.js';

/**
 * One scan, start to finish: clone the commit, run the same scanner the CLI
 * runs, post the result, record it, delete the clone.
 *
 * The checkout is injectable so tests can point the job at a directory on disk
 * and exercise everything except git.
 */
export interface ScanJobDeps {
  creds: AppCredentials;
  store: Store;
  changesets: ChangesetSync;
  dataDir: string;
  appSlug: string;
  checkout?: (token: string, ref: RepoRef, sha: string, tmpRoot: string) => Promise<Checkout>;
  /** Injectable for tests; defaults to minting a real installation token. */
  getToken?: (installationId: number) => Promise<string>;
  /** Set false in tests to skip talking to GitHub for posting. */
  post?: boolean;
}

export interface ScanOutcome {
  scanId: number;
  report: ImpactReport | null;
  error: string | null;
}

export async function runScan(deps: ScanJobDeps, request: ScanRequest): Promise<ScanOutcome> {
  const ref = parseFullName(request.fullName);
  if (!ref) throw new Error(`unparseable repo name ${request.fullName}`);

  const post = deps.post ?? true;
  const token = await (deps.getToken ?? ((id: number) => getInstallationToken(deps.creds, id)))(request.installationId);
  const ctx = { token, ref, appSlug: deps.appSlug };

  // A version alert does not know the commit; resolve the default branch now.
  let sha = request.sha;
  if (!sha) {
    const record = deps.store.getRepo(request.fullName);
    const branch = record?.defaultBranch ?? 'main';
    sha = await getBranchSha(token, ref, branch);
  }
  const short = sha.slice(0, 7);

  // Show "in progress" on the commit before the clone starts.
  let checkId: number | null = null;
  if (post && request.postCheck) {
    try {
      checkId = await openCheck(ctx, sha);
    } catch (err) {
      log.warn(`${request.fullName}@${short}: could not open check run: ${(err as Error).message}`);
    }
  }

  const sets = await deps.changesets.load();
  const latest = latestKnownVersion(sets);
  const target = request.targetVersion === 'latest' ? latest : request.targetVersion;

  if (!target || sets.length === 0) {
    const error = 'no changesets available';
    if (checkId !== null) await failCheckNeutrally(ctx, checkId, error).catch(() => {});
    const scanId = deps.store.recordScan(emptyRecord(request, sha, target ?? 'unknown', error));
    return { scanId, report: null, error };
  }

  const checkout = deps.checkout ?? checkoutCommit;
  let co: Checkout | null = null;
  const started = Date.now();

  try {
    co = await checkout(token, ref, sha, join(deps.dataDir, 'tmp'));

    // The repo's own config, if valid. Invalid config is a warning, not a failure.
    let repoConfig: RepoConfig = {};
    try {
      repoConfig = (await loadRepoConfig(co.dir)).config;
    } catch (err) {
      log.warn(`${request.fullName}@${short}: ignoring invalid .apiwatcher.json: ${(err as Error).message}`);
    }

    const [methodMap, knownEvents] = await Promise.all([loadMethodMap(), loadEventCatalog()]);
    const minConfidence = repoConfig.minConfidence ?? DEFAULT_CONFIG.minConfidence;

    const scan = await scanRepo(co.dir, {
      methodMap,
      minConfidence,
      ...(knownEvents ? { knownEvents } : {}),
      ignore: repoConfig.ignorePaths ?? [],
    });

    // A clone has no node_modules, so the SDK-default fallback never applies here.
    const current = scan.version.apiVersion ?? null;
    const oldestFrom = sets[0]?.from ?? target;
    const changes = changesBetween(sets, current ?? oldestFrom, target);

    const report = buildReport({
      scan,
      changes,
      targetVersion: target,
      minConfidence,
      oldestCovered: oldestCoveredVersion(sets),
      ...(repoConfig.ignoreChanges ? { ignoreIds: repoConfig.ignoreChanges } : {}),
    });
    if (current === null) {
      report.warnings.push(
        'No pinned apiVersion found; compared against the full changeset history. Pin `apiVersion` in your Stripe client to narrow this.',
      );
    }

    const failOn = repoConfig.failOn ?? DEFAULT_CONFIG.failOn;
    const failing = exitCodeFor(report, failOn) !== 0;

    deps.store.setRepoApiVersion(request.fullName, scan.version.apiVersion ?? null);
    const scanId = deps.store.recordScan({
      fullName: request.fullName,
      sha,
      trigger: request.trigger,
      targetVersion: target,
      currentVersion: current,
      breaking: report.totals.breaking,
      deprecating: report.totals.deprecating,
      additive: report.totals.additive,
      filesScanned: report.filesScanned,
      reportJson: JSON.stringify(report),
      error: null,
    });

    if (post) {
      if (checkId !== null) {
        await completeCheck(ctx, checkId, report, failing).catch((err: Error) =>
          log.warn(`${request.fullName}@${short}: could not complete check run: ${err.message}`),
        );
      }
      if (request.updateIssue) {
        try {
          if (failing) {
            const url = await upsertTrackingIssue(ctx, report);
            log.info(`${request.fullName}@${short}: issue ${url}`);
          } else if (await closeTrackingIssue(ctx)) {
            log.info(`${request.fullName}@${short}: closed tracking issue`);
          }
        } catch (err) {
          log.warn(`${request.fullName}@${short}: could not update issue: ${(err as Error).message}`);
        }
      }
    }

    log.info(
      `${request.fullName}@${short} [${request.trigger}] ${report.filesScanned} files, ` +
        `${report.totals.breaking} breaking, ${report.totals.deprecating} deprecating, ` +
        `${Date.now() - started}ms`,
    );
    return { scanId, report, error: null };
  } catch (err) {
    const message = (err as Error).message;
    log.error(`${request.fullName}@${short} [${request.trigger}] failed: ${message}`);
    if (checkId !== null) await failCheckNeutrally(ctx, checkId, message).catch(() => {});
    const scanId = deps.store.recordScan(emptyRecord(request, sha, target, message));
    return { scanId, report: null, error: message };
  } finally {
    // Customer code stays on disk only as long as the scan takes.
    if (co) await co.cleanup().catch(() => {});
  }
}

function emptyRecord(request: ScanRequest, sha: string, target: string, error: string) {
  return {
    fullName: request.fullName,
    sha,
    trigger: request.trigger,
    targetVersion: target,
    currentVersion: null,
    breaking: 0,
    deprecating: 0,
    additive: 0,
    filesScanned: 0,
    reportJson: null,
    error,
  };
}
