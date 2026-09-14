import type { NotifyOn, ScanRecord, Store } from './db.js';
import * as log from './log.js';

/**
 * The version digest.
 *
 * When Stripe ships a version, the fan-out scans every tracked repo. Once those
 * scans have settled, each account gets *one* message: the repositories affected,
 * worst first, each linked to its tracking issue. Nothing is sent to an account
 * where nothing is affected — silence is the product's promise, not a gap.
 *
 * Sending is idempotent per (version, installation): a restart or a second tick
 * cannot send it twice.
 */

export interface DigestRepo {
  fullName: string;
  breaking: number;
  deprecating: number;
  issueUrl: string;
  sha: string;
}

export interface Digest {
  version: string;
  installationId: number;
  affected: DigestRepo[];
  clean: number;
  failed: number;
  total: number;
}

export function assembleDigest(version: string, installationId: number, scans: readonly ScanRecord[]): Digest {
  const affected: DigestRepo[] = [];
  let clean = 0;
  let failed = 0;
  for (const s of scans) {
    if (s.error) {
      failed += 1;
      continue;
    }
    if (s.breaking === 0 && s.deprecating === 0) {
      clean += 1;
      continue;
    }
    affected.push({
      fullName: s.fullName,
      breaking: s.breaking,
      deprecating: s.deprecating,
      issueUrl: `https://github.com/${s.fullName}/issues?q=is%3Aissue+label%3Aapiwatcher`,
      sha: s.sha,
    });
  }
  affected.sort((a, b) => b.breaking - a.breaking || b.deprecating - a.deprecating || a.fullName.localeCompare(b.fullName));
  return { version, installationId, affected, clean, failed, total: scans.length };
}

/** Does this recipient's threshold match what the digest contains? */
export function wantsDigest(notifyOn: NotifyOn, digest: Digest): boolean {
  if (notifyOn === 'never') return false;
  const breaking = digest.affected.some((r) => r.breaking > 0);
  if (notifyOn === 'breaking') return breaking;
  return breaking || digest.affected.some((r) => r.deprecating > 0);
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function counts(r: DigestRepo): string {
  const parts: string[] = [];
  if (r.breaking > 0) parts.push(`${r.breaking} breaking`);
  if (r.deprecating > 0) parts.push(`${r.deprecating} deprecating`);
  return parts.join(', ');
}

export function renderEmail(digest: Digest, publicUrl: string): RenderedEmail {
  const n = digest.affected.length;
  const subject = `Stripe ${digest.version}: ${n} of ${digest.total} repositories affected`;
  const dashboard = `${publicUrl.replace(/\/$/, '')}/app`;
  const changelog = `${publicUrl.replace(/\/$/, '')}/changelog/${digest.version}`;

  const textLines = [
    `Stripe shipped ${digest.version}.`,
    `${n} of your ${digest.total} tracked repositories are affected; ${digest.clean} are clean.`,
    '',
    ...digest.affected.map((r) => `  ${r.fullName} — ${counts(r)}\n    ${r.issueUrl}`),
    '',
    `What changed in this version: ${changelog}`,
    `Your repositories: ${dashboard}`,
    '',
    'Each affected repository has a tracking issue with every file and line. Nothing has been changed in your code.',
    digest.failed > 0 ? `\n${digest.failed} repositor${digest.failed === 1 ? 'y' : 'ies'} could not be scanned; see the dashboard.` : '',
  ];

  const rows = digest.affected
    .map(
      (r) =>
        `<tr>
  <td style="padding:10px 0;border-top:1px solid #d7cdbb;font-family:'IBM Plex Mono',Menlo,monospace;font-size:14px">
    <a href="${esc(r.issueUrl)}" style="color:#161311;text-decoration:none">${esc(r.fullName)}</a>
  </td>
  <td style="padding:10px 0;border-top:1px solid #d7cdbb;text-align:right;font-family:'IBM Plex Mono',Menlo,monospace;font-size:13px;color:${r.breaking > 0 ? '#a8321f' : '#8a6a10'}">${esc(counts(r))}</td>
</tr>`,
    )
    .join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;background:#f4efe6;color:#161311;font-family:'IBM Plex Sans',-apple-system,Segoe UI,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:40px 24px">
  <p style="font-family:Georgia,serif;font-size:28px;line-height:1.15;margin:0 0 8px">Stripe shipped <span style="font-family:'IBM Plex Mono',Menlo,monospace;font-size:24px">${esc(digest.version)}</span>.</p>
  <p style="margin:0 0 24px;color:#4a423b">${n} of your ${digest.total} tracked repositories are affected; ${digest.clean} are clean.</p>
  <table style="width:100%;border-collapse:collapse;border-bottom:1px solid #d7cdbb">${rows}</table>
  <p style="margin:24px 0 0"><a href="${esc(changelog)}" style="color:#7a3510">What changed in this version</a> · <a href="${esc(dashboard)}" style="color:#7a3510">Your repositories</a></p>
  <p style="margin:24px 0 0;font-size:13px;color:#857a6f">Each affected repository has a tracking issue with every file and line. Nothing has been changed in your code.${
    digest.failed > 0 ? ` ${digest.failed} could not be scanned; see the dashboard.` : ''
  }</p>
  <p style="margin:32px 0 0;font-size:12px;color:#857a6f">You get one of these per Stripe version because you asked to in apiwatcher settings. Change that at <a href="${esc(dashboard)}/settings" style="color:#857a6f">${esc(dashboard)}/settings</a>.</p>
</div></body></html>`;

  return { subject, text: textLines.filter((l) => l !== undefined).join('\n'), html };
}

export function renderSlack(digest: Digest, publicUrl: string): { text: string } {
  const n = digest.affected.length;
  const lines = [
    `*Stripe ${digest.version}*: ${n} of ${digest.total} tracked repositories affected.`,
    ...digest.affected.map((r) => `• <${r.issueUrl}|${r.fullName}> — ${counts(r)}`),
    `<${publicUrl.replace(/\/$/, '')}/changelog/${digest.version}|What changed> · <${publicUrl.replace(/\/$/, '')}/app|Your repositories>`,
  ];
  return { text: lines.join('\n') };
}

// --- transport ------------------------------------------------------------------

export interface Transport {
  /** Send one email. Resolves on acceptance by the provider. */
  email(to: string, msg: RenderedEmail): Promise<void>;
  slack(webhook: string, payload: { text: string }): Promise<void>;
}

/** Resend over HTTPS; no SMTP, which most VPS providers block on port 25. */
export function resendTransport(apiKey: string | null, from: string): Transport {
  return {
    async email(to, msg) {
      if (!apiKey) {
        log.warn(`digest: RESEND_API_KEY not set; would have emailed ${to}: ${msg.subject}`);
        return;
      }
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject: msg.subject, text: msg.text, html: msg.html }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
    async slack(webhook, payload) {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Slack ${res.status}`);
    },
  };
}

export interface DigestDeps {
  store: Store;
  transport: Transport;
  publicUrl: string;
}

export interface DigestResult {
  version: string;
  sent: Array<{ installationId: number; emails: number; slacks: number }>;
  skipped: Array<{ installationId: number; reason: string }>;
}

/**
 * Send every digest owed for a version. Safe to call repeatedly; each
 * (version, installation) goes out once.
 */
export async function sendDigests(deps: DigestDeps, version: string): Promise<DigestResult> {
  const result: DigestResult = { version, sent: [], skipped: [] };
  const byInstallation = deps.store.versionScansByInstallation(version);

  for (const [installationId, scans] of byInstallation) {
    if (deps.store.digestAlreadySent(version, installationId)) {
      result.skipped.push({ installationId, reason: 'already sent' });
      continue;
    }
    const digest = assembleDigest(version, installationId, scans);
    if (digest.affected.length === 0) {
      // Nothing affected: mark it so we do not re-evaluate, and stay silent.
      deps.store.markDigestSent(version, installationId, 0);
      result.skipped.push({ installationId, reason: 'nothing affected' });
      continue;
    }

    const recipients = deps.store.digestRecipients(installationId).filter((r) => wantsDigest(r.notifyOn, digest));
    if (recipients.length === 0) {
      deps.store.markDigestSent(version, installationId, 0);
      result.skipped.push({ installationId, reason: 'no recipients' });
      continue;
    }

    const email = renderEmail(digest, deps.publicUrl);
    const slack = renderSlack(digest, deps.publicUrl);
    let emails = 0;
    let slacks = 0;
    const webhooksDone = new Set<string>();

    for (const r of recipients) {
      if (r.email) {
        try {
          await deps.transport.email(r.email, email);
          emails += 1;
        } catch (err) {
          log.warn(`digest ${version} → ${r.login}: email failed: ${(err as Error).message}`);
        }
      }
      if (r.slackWebhook && !webhooksDone.has(r.slackWebhook)) {
        webhooksDone.add(r.slackWebhook);
        try {
          await deps.transport.slack(r.slackWebhook, slack);
          slacks += 1;
        } catch (err) {
          log.warn(`digest ${version} → ${r.login}: slack failed: ${(err as Error).message}`);
        }
      }
    }

    deps.store.markDigestSent(version, installationId, emails + slacks);
    result.sent.push({ installationId, emails, slacks });
    log.info(`digest ${version}: installation ${installationId} — ${digest.affected.length} affected, ${emails} email(s), ${slacks} slack(s)`);
  }
  return result;
}
