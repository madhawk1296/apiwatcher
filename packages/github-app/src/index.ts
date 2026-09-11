import { alertAffectedRepos } from './alert.js';
import { verifyWebhookSignature } from './crypto.js';
import { indexInstallation } from './indexer.js';
import { getLastKnownVersion, iterateRepos, type Env } from './store.js';
import { handleWebhook } from './webhook.js';

/**
 * The apimigrate GitHub App.
 *
 * Report-only. It holds two GitHub permissions — read metadata/contents to see
 * whether a repo uses Stripe, and write issues so a scan can report back — and
 * it never runs a scan itself. Scans execute in the customer's own Actions via
 * `repository_dispatch`, so their code never leaves their infrastructure and the
 * compute is free to us.
 */

const CHANGESET_URL =
  'https://raw.githubusercontent.com/apimigrate/apimigrate/main/changesets/stripe/index.json';

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** Admin endpoints are gated on a shared secret, compared in constant time. */
function authorizedAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (provided.length !== env.ADMIN_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ env.ADMIN_TOKEN.charCodeAt(i);
  return diff === 0;
}

function missingConfig(env: Env): string[] {
  const missing: string[] = [];
  if (!env.APP_ID) missing.push('APP_ID');
  if (!env.APP_PRIVATE_KEY) missing.push('APP_PRIVATE_KEY');
  if (!env.WEBHOOK_SECRET) missing.push('WEBHOOK_SECRET');
  return missing;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      const missing = missingConfig(env);
      return json({
        name: 'apimigrate-github-app',
        status: missing.length === 0 ? 'ok' : 'misconfigured',
        ...(missing.length > 0 ? { missing } : {}),
      });
    }

    if (url.pathname === '/webhooks/github') {
      if (request.method !== 'POST') return text('Method not allowed', 405);

      const missing = missingConfig(env);
      if (missing.length > 0) return json({ error: `missing config: ${missing.join(', ')}` }, 500);

      // Read the raw body first: the signature covers exact bytes, so parsing
      // before verifying would mean trusting unverified input.
      const raw = await request.text();
      const valid = await verifyWebhookSignature(
        env.WEBHOOK_SECRET,
        raw,
        request.headers.get('x-hub-signature-256'),
      );
      if (!valid) return text('Invalid signature', 401);

      const event = request.headers.get('x-github-event') ?? 'unknown';
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return text('Invalid JSON', 400);
      }

      try {
        const handled = await handleWebhook(env, event, payload as Parameters<typeof handleWebhook>[2]);
        return json(handled);
      } catch (err) {
        // Return 500 so GitHub retries; the delivery log keeps the detail.
        return json({ event, error: (err as Error).message }, 500);
      }
    }

    // --- admin ------------------------------------------------------------
    if (url.pathname.startsWith('/admin/')) {
      if (!authorizedAdmin(request, env)) return text('Unauthorized', 401);

      if (url.pathname === '/admin/repos') {
        const repos = [];
        for await (const record of iterateRepos(env)) repos.push(record);
        return json({ count: repos.length, lastKnownVersion: await getLastKnownVersion(env), repos });
      }

      if (url.pathname === '/admin/backfill' && request.method === 'POST') {
        const installationId = Number(url.searchParams.get('installation_id'));
        if (!Number.isInteger(installationId) || installationId <= 0) {
          return json({ error: 'installation_id query parameter is required' }, 400);
        }
        return json({ outcomes: await indexInstallation(env, installationId) });
      }

      if (url.pathname === '/admin/alert' && request.method === 'POST') {
        const version = url.searchParams.get('version');
        if (!version) return json({ error: 'version query parameter is required' }, 400);
        const dryRun = url.searchParams.get('dry_run') === '1';
        return json(await alertAffectedRepos(env, version, { dryRun }));
      }

      return text('Not found', 404);
    }

    return text('Not found', 404);
  },

  /**
   * Cron: notice a new Stripe version and fan it out.
   *
   * The changeset index is published by the spec watcher in this repo, so the
   * worker only needs to read one small file rather than diff specs itself.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const res = await fetch(CHANGESET_URL, {
          headers: { 'user-agent': 'apimigrate-github-app' },
        });
        if (!res.ok) return;

        const index = (await res.json()) as { latest?: string };
        const latest = index.latest;
        if (!latest) return;

        const known = await getLastKnownVersion(env);
        if (known === latest) return; // nothing new

        await alertAffectedRepos(env, latest);
      })(),
    );
  },
};
