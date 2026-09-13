import {
  getFileContent,
  getInstallationToken,
  listInstallationRepos,
  parseFullName,
  type AppCredentials,
  type RepoRef,
  type RepoSummary,
} from './github.js';
import type { Store } from './db.js';

/**
 * Decides whether a repo is worth tracking and records what we know about it.
 *
 * Two API reads — `package.json` and the apiwatcher config — so indexing a repo
 * costs nothing and needs no clone. Repos without a `stripe` dependency are
 * skipped entirely and never contacted again.
 */

const CONFIG_PATHS = ['.apiwatcher.json', 'apiwatcher.config.json', '.github/apiwatcher.json'];

interface ParsedConfig {
  target?: string;
  alerts?: boolean;
  scanOnPush?: boolean;
}

export function readStripeRange(packageJson: string): string | null {
  let pkg: Record<string, Record<string, string> | undefined>;
  try {
    pkg = JSON.parse(packageJson) as Record<string, Record<string, string> | undefined>;
  } catch {
    return null;
  }
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const range = pkg[section]?.stripe;
    if (typeof range === 'string') return range;
  }
  return null;
}

async function readConfig(token: string, ref: RepoRef, gitRef?: string): Promise<ParsedConfig> {
  for (const path of CONFIG_PATHS) {
    const text = await getFileContent(token, ref, path, gitRef);
    if (text === null) continue;
    try {
      const parsed = JSON.parse(text) as ParsedConfig;
      return {
        ...(typeof parsed.target === 'string' ? { target: parsed.target } : {}),
        ...(typeof parsed.alerts === 'boolean' ? { alerts: parsed.alerts } : {}),
        ...(typeof parsed.scanOnPush === 'boolean' ? { scanOnPush: parsed.scanOnPush } : {}),
      };
    } catch {
      // A malformed config should not take the indexer down; treat as absent.
      return {};
    }
  }
  return {};
}

export interface IndexOutcome {
  fullName: string;
  tracked: boolean;
  reason: string;
}

export interface Indexer {
  indexRepo(installationId: number, summary: RepoSummary): Promise<IndexOutcome>;
  indexInstallation(installationId: number): Promise<IndexOutcome[]>;
}

export function createIndexer(creds: AppCredentials, store: Store): Indexer {
  async function indexRepo(installationId: number, summary: RepoSummary): Promise<IndexOutcome> {
    const ref = parseFullName(summary.full_name);
    if (!ref) return { fullName: summary.full_name, tracked: false, reason: 'unparseable name' };
    if (summary.archived) {
      store.deleteRepo(summary.full_name);
      return { fullName: summary.full_name, tracked: false, reason: 'archived' };
    }

    const token = await getInstallationToken(creds, installationId);
    const packageJson = await getFileContent(token, ref, 'package.json', summary.default_branch);
    if (packageJson === null) {
      store.deleteRepo(summary.full_name);
      return { fullName: summary.full_name, tracked: false, reason: 'no package.json' };
    }

    const stripeRange = readStripeRange(packageJson);
    if (stripeRange === null) {
      // Not a Stripe consumer today. Nothing to watch, nothing to notify.
      store.deleteRepo(summary.full_name);
      return { fullName: summary.full_name, tracked: false, reason: 'no stripe dependency' };
    }

    const config = await readConfig(token, ref, summary.default_branch);
    const existing = store.getRepo(summary.full_name);

    store.putRepo({
      fullName: summary.full_name,
      installationId,
      defaultBranch: summary.default_branch,
      private: summary.private,
      stripeRange,
      apiVersion: existing?.apiVersion ?? null,
      target: config.target ?? 'latest',
      alerts: config.alerts ?? true,
      scanOnPush: config.scanOnPush ?? true,
      lastAlertedVersion: existing?.lastAlertedVersion ?? null,
    });
    return { fullName: summary.full_name, tracked: true, reason: `stripe ${stripeRange}` };
  }

  async function indexInstallation(installationId: number): Promise<IndexOutcome[]> {
    const token = await getInstallationToken(creds, installationId);
    const repos = await listInstallationRepos(token);
    const outcomes: IndexOutcome[] = [];
    for (const repo of repos) {
      try {
        outcomes.push(await indexRepo(installationId, repo));
      } catch (err) {
        outcomes.push({ fullName: repo.full_name, tracked: false, reason: `error: ${(err as Error).message}` });
      }
    }
    return outcomes;
  }

  return { indexRepo, indexInstallation };
}
