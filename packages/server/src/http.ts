import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { alertAffectedRepos } from './alert.js';
import type { ChangesetSync } from './changesets.js';
import type { Config } from './config.js';
import { verifyWebhookSignature } from './crypto.js';
import type { Store } from './db.js';
import { getInstallationForRepo, parseFullName } from './github.js';
import type { Indexer } from './indexer.js';
import { flushDigests, pollOnce } from './poller.js';
import { resendTransport } from './digest.js';
import type { ScanQueue } from './queue.js';
import { handleWebhook } from './webhook.js';
import * as log from './log.js';

/** GitHub's largest webhook payloads are well under this. */
const MAX_BODY = 1_048_576;

export interface HttpDeps {
  config: Config;
  store: Store;
  changesets: ChangesetSync;
  indexer: Indexer;
  queue: ScanQueue;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Constant-time compare for the admin token. */
function authorizedAdmin(req: IncomingMessage, token: string | null): boolean {
  if (!token) return false;
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (provided.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export function createHttpServer(deps: HttpDeps): Server {
  const { config, store, changesets, indexer, queue } = deps;
  const creds = { appId: config.appId, privateKey: config.appPrivateKey };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    try {
      if (path === '/' || path === '/health') {
        send(res, 200, {
          name: 'apiwatcher-server',
          status: 'ok',
          repos: store.listRepos().length,
          queue: { size: queue.size, inFlight: queue.inFlight },
          changesets: { latest: await changesets.latest() },
        });
        return;
      }

      if (path === '/webhooks/github') {
        if (req.method !== 'POST') return send(res, 405, 'Method not allowed');

        // Raw bytes first; the signature covers them exactly.
        const raw = await readBody(req);
        const valid = await verifyWebhookSignature(
          config.webhookSecret,
          raw,
          (req.headers['x-hub-signature-256'] as string | undefined) ?? null,
        );
        if (!valid) return send(res, 401, 'Invalid signature');

        const event = (req.headers['x-github-event'] as string | undefined) ?? 'unknown';
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return send(res, 400, 'Invalid JSON');
        }

        try {
          const handled = await handleWebhook(
            { creds, store, indexer, queue },
            event,
            payload as Parameters<typeof handleWebhook>[2],
          );
          log.info(`webhook ${event}${handled.action ? `.${handled.action}` : ''}: ${handled.summary}`);
          return send(res, 200, handled);
        } catch (err) {
          log.error(`webhook ${event} failed: ${(err as Error).message}`);
          // 500 makes GitHub retry; the delivery log keeps the detail.
          return send(res, 500, { event, error: (err as Error).message });
        }
      }

      if (path.startsWith('/admin/')) {
        if (!authorizedAdmin(req, config.adminToken)) return send(res, 401, 'Unauthorized');

        if (path === '/admin/repos' && req.method === 'GET') {
          return send(res, 200, {
            count: store.listRepos().length,
            lastKnownVersion: store.getMeta('lastKnownVersion'),
            repos: store.listRepos(),
          });
        }

        if (path === '/admin/scans' && req.method === 'GET') {
          const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500);
          return send(res, 200, { scans: store.recentScans(limit) });
        }

        const scanMatch = /^\/admin\/scans\/(\d+)$/.exec(path);
        if (scanMatch && req.method === 'GET') {
          const scan = store.getScan(Number(scanMatch[1]));
          if (!scan) return send(res, 404, 'No such scan');
          return send(res, 200, {
            ...scan,
            report: scan.reportJson ? (JSON.parse(scan.reportJson) as unknown) : null,
            reportJson: undefined,
          });
        }

        // Re-index an installation, by id or by any repo it covers. The repo form
        // exists because only the App can list its own installations — an
        // operator with a user token cannot look the id up.
        if (path === '/admin/backfill' && req.method === 'POST') {
          let installationId = Number(url.searchParams.get('installation_id'));
          const repoName = url.searchParams.get('repo');
          if (repoName) {
            const ref = parseFullName(repoName);
            if (!ref) return send(res, 400, { error: 'repo must be owner/name' });
            const found = await getInstallationForRepo(creds, ref);
            if (found === null) return send(res, 404, { error: `the App is not installed on ${repoName}` });
            installationId = found;
          }
          if (!Number.isInteger(installationId) || installationId <= 0) {
            return send(res, 400, { error: 'installation_id or repo query parameter is required' });
          }
          return send(res, 200, { installationId, outcomes: await indexer.indexInstallation(installationId) });
        }

        if (path === '/admin/alert' && req.method === 'POST') {
          const version = url.searchParams.get('version');
          if (!version) return send(res, 400, { error: 'version query parameter is required' });
          const dryRun = url.searchParams.get('dry_run') === '1';
          return send(res, 200, alertAffectedRepos(store, queue, version, { dryRun }));
        }

        // Scan one repo now. The go-to way to test the pipeline end to end.
        if (path === '/admin/scan' && req.method === 'POST') {
          const fullName = url.searchParams.get('repo');
          const ref = fullName ? parseFullName(fullName) : null;
          if (!fullName || !ref) return send(res, 400, { error: 'repo=owner/name is required' });

          const record = store.getRepo(fullName);
          const installationId = record?.installationId ?? (await getInstallationForRepo(creds, ref));
          if (installationId === null) return send(res, 404, { error: `the App is not installed on ${fullName}` });

          const post = url.searchParams.get('post') === '1';
          const outcome = queue.enqueue({
            fullName,
            installationId,
            sha: url.searchParams.get('sha') ?? (undefined as unknown as string),
            trigger: 'manual',
            targetVersion: url.searchParams.get('target') ?? record?.target ?? 'latest',
            updateIssue: post,
            postCheck: post,
            requestedAt: new Date().toISOString(),
          });
          return send(res, 202, { queued: outcome, repo: fullName, post, hint: 'GET /admin/scans to see the result' });
        }

        // Send (or re-evaluate) digests for a version now. Idempotent.
        if (path === '/admin/digest' && req.method === 'POST') {
          const version = url.searchParams.get('version');
          if (!version) return send(res, 400, { error: 'version query parameter is required' });
          store.setMeta('digestPendingVersion', version);
          await flushDigests({
            store,
            changesets,
            queue,
            intervalMinutes: config.pollIntervalMinutes,
            reportRetentionDays: config.reportRetentionDays,
            digest: { transport: resendTransport(config.resendApiKey, config.emailFrom), publicUrl: config.publicUrl },
          });
          return send(res, 200, { version, pending: store.getMeta('digestPendingVersion') || null });
        }

        if (path === '/admin/sync' && req.method === 'POST') {
          await pollOnce({
            store,
            changesets,
            queue,
            intervalMinutes: config.pollIntervalMinutes,
            reportRetentionDays: config.reportRetentionDays,
          });
          return send(res, 200, { latest: await changesets.latest(), lastKnownVersion: store.getMeta('lastKnownVersion') });
        }

        return send(res, 404, 'Not found');
      }

      return send(res, 404, 'Not found');
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (status >= 500) log.error(`${req.method} ${path}: ${(err as Error).message}`);
      return send(res, status, { error: (err as Error).message });
    }
  });
}
