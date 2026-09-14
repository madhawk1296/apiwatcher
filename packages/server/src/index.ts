import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { ChangesetSync } from './changesets.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { assertGitAvailable } from './git.js';
import { createHttpServer } from './http.js';
import { createIndexer } from './indexer.js';
import { flushDigests, startPoller } from './poller.js';
import { resendTransport } from './digest.js';
import { ScanQueue } from './queue.js';
import { runScan } from './scan-job.js';
import * as log from './log.js';

/**
 * The apiwatcher server. One process, one box.
 *
 * Boot order matters: every dependency is checked before the port opens, so a
 * misconfigured deploy fails in the first second with a clear message rather
 * than on the first webhook.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const creds = { appId: config.appId, privateKey: config.appPrivateKey };

  await mkdir(join(config.dataDir, 'tmp'), { recursive: true });
  // Clones abandoned by a crash are never useful; start clean.
  await rm(join(config.dataDir, 'tmp'), { recursive: true, force: true });
  await mkdir(join(config.dataDir, 'tmp'), { recursive: true });

  log.info(`git: ${await assertGitAvailable()}`);

  const store = new Store(join(config.dataDir, 'apiwatcher.sqlite'));
  const changesets = new ChangesetSync(config.dataDir, config.changesetIndexUrl);
  await changesets.seed();
  log.info(`changesets: ${(await changesets.latest()) ?? 'none'} (bundled seed)`);

  const indexer = createIndexer(creds, store);
  const pollerDeps = {
    store,
    changesets,
    intervalMinutes: config.pollIntervalMinutes,
    reportRetentionDays: config.reportRetentionDays,
    digest: { transport: resendTransport(config.resendApiKey, config.emailFrom), publicUrl: config.publicUrl },
  };

  // After the last scan of a fan-out finishes, the digest is owed. Debounced so a
  // burst of completions triggers one check once the queue is quiet.
  let digestTimer: NodeJS.Timeout | null = null;
  const queue: ScanQueue = new ScanQueue(
    async (request) => {
      await runScan({ creds, store, changesets, dataDir: config.dataDir, appSlug: config.appSlug }, request);
      if (request.trigger === 'new_version') {
        if (digestTimer) clearTimeout(digestTimer);
        digestTimer = setTimeout(() => {
          void flushDigests({ ...pollerDeps, queue }).catch((err: Error) => log.warn(`digest flush failed: ${err.message}`));
        }, 15_000);
      }
    },
    config.scanConcurrency,
    log.warn,
  );

  const stopPoller = startPoller({ ...pollerDeps, queue });

  const server = createHttpServer({ config, store, changesets, indexer, queue });
  server.listen(config.port, config.host, () => {
    log.info(`listening on ${config.host}:${config.port} (data in ${config.dataDir}, concurrency ${config.scanConcurrency})`);
    if (!config.adminToken) log.warn('ADMIN_TOKEN is not set; /admin/* is disabled');
  });

  // Let in-flight scans finish before exit; systemd gives us 90s by default.
  const shutdown = (signal: string): void => {
    log.info(`${signal}: shutting down`);
    stopPoller();
    queue.stop();
    server.close();
    const deadline = setTimeout(() => {
      log.warn('drain timed out; exiting with scans in flight');
      process.exit(1);
    }, 60_000);
    void queue.drain().then(() => {
      clearTimeout(deadline);
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: Error) => {
  log.error(`fatal: ${err.message}`);
  process.exit(1);
});
