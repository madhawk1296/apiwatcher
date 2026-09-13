import type { Store } from './db.js';
import { getInstallationToken, listPullRequestFiles, parseFullName, type AppCredentials } from './github.js';
import type { Indexer } from './indexer.js';
import type { ScanQueue } from './queue.js';

/**
 * Webhook routing.
 *
 * Index maintenance stays cheap and synchronous. Anything that needs a clone is
 * handed to the queue and the webhook returns immediately — GitHub gives us ten
 * seconds to respond, and a scan can take longer than that.
 */

interface RepoPayload {
  full_name: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
}

interface WebhookPayload {
  action?: string;
  installation?: { id: number };
  repository?: RepoPayload;
  repositories_added?: RepoPayload[];
  repositories_removed?: Array<{ full_name: string }>;
  ref?: string;
  after?: string;
  deleted?: boolean;
  commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
  pull_request?: {
    number: number;
    draft?: boolean;
    head: { sha: string; repo?: { full_name: string } | null };
  };
}

/** Files that change what the index records about a repo. */
const INDEXED_FILES = new Set([
  'package.json',
  '.apiwatcher.json',
  'apiwatcher.config.json',
  '.github/apiwatcher.json',
]);

/** Files whose change could change a scan's result. */
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const MANIFESTS = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'jsconfig.json',
  '.apiwatcher.json',
  'apiwatcher.config.json',
  '.github/apiwatcher.json',
]);

export function isScanRelevant(paths: Iterable<string>): boolean {
  for (const path of paths) {
    if (SOURCE_EXT.test(path)) return true;
    const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
    if (MANIFESTS.has(base) || MANIFESTS.has(path)) return true;
  }
  return false;
}

const NULL_SHA = '0000000000000000000000000000000000000000';

export interface HandledEvent {
  event: string;
  action?: string;
  summary: string;
}

export interface WebhookDeps {
  creds: AppCredentials;
  store: Store;
  indexer: Indexer;
  queue: ScanQueue;
}

export async function handleWebhook(deps: WebhookDeps, event: string, payload: WebhookPayload): Promise<HandledEvent> {
  const { store, indexer, queue } = deps;
  const installationId = payload.installation?.id;
  const withAction = (summary: string): HandledEvent => ({
    event,
    ...(payload.action ? { action: payload.action } : {}),
    summary,
  });

  switch (event) {
    case 'installation': {
      if (!installationId) return withAction('ignored: no installation id');

      if (payload.action === 'created' || payload.action === 'unsuspend') {
        const outcomes = await indexer.indexInstallation(installationId);
        const tracked = outcomes.filter((o) => o.tracked);
        // First-time scan of everything tracked, so a new install sees value at once.
        for (const o of tracked) {
          const record = store.getRepo(o.fullName);
          if (!record) continue;
          queue.enqueue({
            fullName: o.fullName,
            installationId,
            sha: undefined as unknown as string,
            trigger: 'backfill',
            targetVersion: record.target,
            updateIssue: true,
            postCheck: false,
            requestedAt: new Date().toISOString(),
          });
        }
        return withAction(`indexed ${outcomes.length} repo(s), tracking ${tracked.length}, queued ${tracked.length} scan(s)`);
      }

      if (payload.action === 'deleted' || payload.action === 'suspend') {
        const removed = store.deleteInstallation(installationId);
        return withAction(`removed ${removed} repo(s) from the index`);
      }
      return withAction('no action needed');
    }

    case 'installation_repositories': {
      if (!installationId) return withAction('ignored: no installation id');
      let added = 0;
      for (const repo of payload.repositories_added ?? []) {
        const outcome = await indexer.indexRepo(installationId, repo);
        if (!outcome.tracked) continue;
        added += 1;
        const record = store.getRepo(repo.full_name);
        if (record) {
          queue.enqueue({
            fullName: repo.full_name,
            installationId,
            sha: undefined as unknown as string,
            trigger: 'backfill',
            targetVersion: record.target,
            updateIssue: true,
            postCheck: false,
            requestedAt: new Date().toISOString(),
          });
        }
      }
      for (const repo of payload.repositories_removed ?? []) store.deleteRepo(repo.full_name);
      return withAction(`added ${added} tracked repo(s), removed ${(payload.repositories_removed ?? []).length}`);
    }

    case 'push': {
      const repo = payload.repository;
      if (!installationId || !repo) return withAction('ignored: missing repository');
      if (payload.deleted || !payload.after || payload.after === NULL_SHA) return withAction('ignored: branch deleted');

      // Only the default branch defines what the repo "is". PRs cover the rest.
      if (payload.ref !== `refs/heads/${repo.default_branch}`) return withAction('ignored: not the default branch');

      const touched = new Set<string>();
      for (const commit of payload.commits ?? []) {
        for (const p of [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])]) touched.add(p);
      }

      let note = '';
      if ([...touched].some((p) => INDEXED_FILES.has(p))) {
        const outcome = await indexer.indexRepo(installationId, repo);
        note = outcome.tracked ? `re-indexed (${outcome.reason}); ` : `untracked (${outcome.reason})`;
        if (!outcome.tracked) return withAction(note);
      }

      const record = store.getRepo(repo.full_name);
      if (!record) return withAction(`${note}ignored: not tracked`);
      if (!record.scanOnPush) return withAction(`${note}ignored: scanOnPush is off`);
      // Force pushes and merges of many commits can exceed the 20-commit payload
      // cap; when the list is empty we cannot rule relevance out, so scan.
      if (touched.size > 0 && !isScanRelevant(touched)) return withAction(`${note}ignored: no relevant file changed`);

      const outcome = queue.enqueue({
        fullName: repo.full_name,
        installationId,
        sha: payload.after,
        trigger: 'push',
        targetVersion: record.target,
        updateIssue: true,
        postCheck: true,
        requestedAt: new Date().toISOString(),
      });
      return withAction(`${note}scan ${outcome} for ${payload.after.slice(0, 7)}`);
    }

    case 'pull_request': {
      const repo = payload.repository;
      const pr = payload.pull_request;
      if (!installationId || !repo || !pr) return withAction('ignored: missing pull request');
      if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(payload.action ?? '')) {
        return withAction('no action needed');
      }

      const record = store.getRepo(repo.full_name);
      if (!record) return withAction('ignored: not tracked');
      if (!record.scanOnPush) return withAction('ignored: scanOnPush is off');

      // One API call to avoid a clone for PRs that only touch docs.
      const ref = parseFullName(repo.full_name);
      if (ref) {
        const token = await getInstallationToken(deps.creds, installationId);
        const files = await listPullRequestFiles(token, ref, pr.number);
        if (files.length > 0 && !isScanRelevant(files)) return withAction('ignored: no relevant file changed');
      }

      const outcome = queue.enqueue({
        fullName: repo.full_name,
        installationId,
        sha: pr.head.sha,
        trigger: 'pull_request',
        targetVersion: record.target,
        prNumber: pr.number,
        updateIssue: false,
        postCheck: true,
        requestedAt: new Date().toISOString(),
      });
      return withAction(`scan ${outcome} for PR #${pr.number} @ ${pr.head.sha.slice(0, 7)}`);
    }

    case 'repository': {
      const repo = payload.repository;
      if (!repo) return withAction('ignored: missing repository');
      if (payload.action === 'deleted' || payload.action === 'archived') {
        store.deleteRepo(repo.full_name);
        return withAction('removed from the index');
      }
      if (installationId && (payload.action === 'unarchived' || payload.action === 'renamed')) {
        const outcome = await indexer.indexRepo(installationId, repo);
        return withAction(`re-indexed (${outcome.reason})`);
      }
      return withAction('no action needed');
    }

    default:
      return withAction('not subscribed');
  }
}
