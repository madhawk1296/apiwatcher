import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { RepoRef } from './github.js';

const execFileAsync = promisify(execFile);

/** A shallow clone should never take this long; something is wrong if it does. */
const GIT_TIMEOUT_MS = 120_000;

export interface Checkout {
  dir: string;
  /** Delete the clone. Always call this, including on failure. */
  cleanup: () => Promise<void>;
}

/**
 * Fetch exactly one commit of a repo into a fresh temp directory.
 *
 * The installation token travels in an environment-variable git config, not on
 * the command line, so it never shows up in `ps` or in an error message that
 * echoes the command. This is the same technique actions/checkout uses.
 *
 * `--depth 1` plus fetching the SHA directly means the clone is the working tree
 * and nothing else — no history, no other branches — which keeps it fast and
 * keeps the amount of customer code on disk to the minimum the scan needs.
 */
export async function checkoutCommit(
  token: string,
  ref: RepoRef,
  sha: string,
  tmpRoot: string,
): Promise<Checkout> {
  const dir = await mkdtemp(join(tmpRoot, 'scan-'));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  };

  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
  const url = `https://github.com/${ref.owner}/${ref.repo}.git`;

  const git = async (...args: string[]): Promise<void> => {
    try {
      await execFileAsync('git', args, { cwd: dir, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      const message = (err as { stderr?: string; message: string }).stderr || (err as Error).message;
      throw new Error(`git ${args[0]} failed: ${message.trim().split('\n').slice(-2).join(' ')}`);
    }
  };

  try {
    await git('init', '--quiet');
    await git('remote', 'add', 'origin', url);
    await git('fetch', '--quiet', '--depth', '1', '--no-tags', 'origin', sha);
    await git('checkout', '--quiet', '--detach', 'FETCH_HEAD');
    return { dir, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** Confirm git exists before the first scan needs it. */
export async function assertGitAvailable(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { timeout: 10_000 });
    return stdout.trim();
  } catch {
    throw new Error('git is not installed or not on PATH; the server cannot clone repositories');
  }
}
