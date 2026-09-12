import {
  getFileContent,
  getInstallationToken,
  listInstallationRepos,
  parseFullName,
  type RepoRef,
  type RepoSummary,
} from './github.js';
import { putRepo, type Env, type RepoRecord } from './store.js';

/**
 * Decides whether a repo is worth tracking and records what we know about it.
 *
 * Only two files are read — `package.json` and the apiwatcher config — so
 * indexing is two API calls per repo and the app never pulls source code. Repos
 * without a `stripe` dependency are skipped entirely.
 */

const CONFIG_PATHS = ['.apiwatcher.json', 'apiwatcher.config.json', '.github/apiwatcher.json'];

interface ParsedConfig {
  target?: string;
  alerts?: boolean;
}

function readStripeRange(packageJson: string): string | null {
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

export async function indexRepo(
  env: Env,
  installationId: number,
  summary: Pick<RepoSummary, 'full_name' | 'default_branch' | 'private' | 'archived'>,
): Promise<IndexOutcome> {
  const ref = parseFullName(summary.full_name);
  if (!ref) return { fullName: summary.full_name, tracked: false, reason: 'unparseable name' };
  if (summary.archived) {
    return { fullName: summary.full_name, tracked: false, reason: 'archived' };
  }

  const token = await getInstallationToken(env, installationId);
  const packageJson = await getFileContent(token, ref, 'package.json', summary.default_branch);
  if (packageJson === null) {
    return { fullName: summary.full_name, tracked: false, reason: 'no package.json' };
  }

  const stripeRange = readStripeRange(packageJson);
  if (stripeRange === null) {
    // Not a Stripe consumer today. Nothing to watch, nothing to notify.
    return { fullName: summary.full_name, tracked: false, reason: 'no stripe dependency' };
  }

  const config = await readConfig(token, ref, summary.default_branch);

  const record: RepoRecord = {
    fullName: summary.full_name,
    installationId,
    defaultBranch: summary.default_branch,
    private: summary.private,
    stripeRange,
    target: config.target ?? 'latest',
    alerts: config.alerts ?? true,
    updatedAt: new Date().toISOString(),
  };
  await putRepo(env, record);
  return { fullName: summary.full_name, tracked: true, reason: `stripe ${stripeRange}` };
}

/** Index every repo an installation can see. Used on install and on backfill. */
export async function indexInstallation(env: Env, installationId: number): Promise<IndexOutcome[]> {
  const token = await getInstallationToken(env, installationId);
  const repos = await listInstallationRepos(token);
  const outcomes: IndexOutcome[] = [];
  for (const repo of repos) {
    try {
      outcomes.push(await indexRepo(env, installationId, repo));
    } catch (err) {
      outcomes.push({
        fullName: repo.full_name,
        tracked: false,
        reason: `error: ${(err as Error).message}`,
      });
    }
  }
  return outcomes;
}
