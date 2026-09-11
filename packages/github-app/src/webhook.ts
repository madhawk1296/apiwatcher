import { indexInstallation, indexRepo } from './indexer.js';
import { deleteInstallation, deleteRepo, type Env } from './store.js';

/**
 * Webhook routing.
 *
 * Everything here is index maintenance. The app never scans code in response to a
 * webhook — scans run in the customer's own Actions — so these handlers stay
 * fast and cannot be made to do expensive work by a noisy repo.
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
  repositories?: RepoPayload[];
  repositories_added?: RepoPayload[];
  repositories_removed?: Array<{ full_name: string }>;
  ref?: string;
  commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
}

/** Files whose change can alter what we have indexed. */
const WATCHED_FILES = [
  'package.json',
  '.apimigrate.json',
  'apimigrate.config.json',
  '.github/apimigrate.json',
];

export interface HandledEvent {
  event: string;
  action?: string;
  summary: string;
}

export async function handleWebhook(
  env: Env,
  event: string,
  payload: WebhookPayload,
): Promise<HandledEvent> {
  const installationId = payload.installation?.id;

  switch (event) {
    case 'installation': {
      if (!installationId) return { event, summary: 'ignored: no installation id' };

      if (payload.action === 'created') {
        const outcomes = await indexInstallation(env, installationId);
        const tracked = outcomes.filter((o) => o.tracked).length;
        return {
          event,
          ...(payload.action ? { action: payload.action } : {}),
          summary: `indexed ${outcomes.length} repo(s), tracking ${tracked}`,
        };
      }

      if (payload.action === 'deleted') {
        const removed = await deleteInstallation(env, installationId);
        return { event, action: payload.action, summary: `removed ${removed} repo(s) from the index` };
      }

      // suspend/unsuspend/new_permissions_accepted: re-index to stay honest.
      if (payload.action === 'unsuspend') {
        const outcomes = await indexInstallation(env, installationId);
        return { event, action: payload.action, summary: `re-indexed ${outcomes.length} repo(s)` };
      }
      if (payload.action === 'suspend') {
        const removed = await deleteInstallation(env, installationId);
        return { event, action: payload.action, summary: `suspended, dropped ${removed} repo(s)` };
      }
      return { event, ...(payload.action ? { action: payload.action } : {}), summary: 'no action needed' };
    }

    case 'installation_repositories': {
      if (!installationId) return { event, summary: 'ignored: no installation id' };
      let added = 0;
      for (const repo of payload.repositories_added ?? []) {
        const outcome = await indexRepo(env, installationId, repo);
        if (outcome.tracked) added += 1;
      }
      for (const repo of payload.repositories_removed ?? []) {
        await deleteRepo(env, repo.full_name);
      }
      return {
        event,
        ...(payload.action ? { action: payload.action } : {}),
        summary: `added ${added} tracked repo(s), removed ${(payload.repositories_removed ?? []).length}`,
      };
    }

    case 'push': {
      const repo = payload.repository;
      if (!installationId || !repo) return { event, summary: 'ignored: missing repository' };

      // Only the default branch defines what the repo "is".
      if (payload.ref !== `refs/heads/${repo.default_branch}`) {
        return { event, summary: 'ignored: not the default branch' };
      }

      // Re-index only when something we read actually changed.
      const touched = new Set<string>();
      for (const commit of payload.commits ?? []) {
        for (const path of [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])]) {
          touched.add(path);
        }
      }
      const relevant = WATCHED_FILES.some((f) => touched.has(f));
      if (!relevant) return { event, summary: 'ignored: no indexed file changed' };

      const outcome = await indexRepo(env, installationId, repo);
      if (!outcome.tracked) {
        await deleteRepo(env, repo.full_name);
        return { event, summary: `untracked (${outcome.reason})` };
      }
      return { event, summary: `re-indexed (${outcome.reason})` };
    }

    case 'repository': {
      const repo = payload.repository;
      if (!repo) return { event, summary: 'ignored: missing repository' };
      if (payload.action === 'deleted' || payload.action === 'archived') {
        await deleteRepo(env, repo.full_name);
        return { event, action: payload.action, summary: 'removed from the index' };
      }
      if (installationId && (payload.action === 'unarchived' || payload.action === 'renamed')) {
        // A rename arrives under the new name; the stale key ages out on the
        // next full backfill.
        const outcome = await indexRepo(env, installationId, repo);
        return { event, action: payload.action, summary: `re-indexed (${outcome.reason})` };
      }
      return { event, ...(payload.action ? { action: payload.action } : {}), summary: 'no action needed' };
    }

    default:
      return { event, summary: 'not subscribed' };
  }
}
