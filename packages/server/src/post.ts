import {
  createCheckRun,
  createIssue,
  ensureLabel,
  findOpenIssueByLabel,
  updateCheckRun,
  updateIssue,
  type CheckConclusion,
  type RepoRef,
} from './github.js';
import { renderMarkdown, type ImpactReport } from 'apiwatcher-cli';

/**
 * Turning a report into something visible on GitHub.
 *
 * Two surfaces: a check run on the commit (what a PR shows), and one tracking
 * issue per repo that is updated in place (what a Stripe release produces). A
 * new issue per scan would be noise; a comment per scan buries the current state.
 */

export const ISSUE_LABEL = {
  name: 'apiwatcher',
  description: 'Opened by apiwatcher',
  color: 'ededed',
};

const ISSUE_TITLE = 'Stripe API changes affect this repository';
const CHECK_NAME = 'apiwatcher / stripe';

/** GitHub caps check-run text at 65535 characters. */
const CHECK_TEXT_MAX = 60_000;

export interface PostContext {
  token: string;
  ref: RepoRef;
  appSlug: string;
}

function footer(ctx: PostContext): string {
  return [
    '',
    '---',
    '',
    `Scanned by [apiwatcher](https://github.com/apps/${ctx.appSlug}). ` +
      'Silence a false positive by adding its `id` to `ignoreChanges` in `.apiwatcher.json`; ' +
      'set `"scanOnPush": false` there to keep version alerts but drop PR checks.',
  ].join('\n');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n_…truncated. The full report is in the tracking issue._`;
}

export function checkConclusion(report: ImpactReport, failing: boolean): CheckConclusion {
  if (failing) return 'failure';
  if (report.totals.deprecating > 0) return 'neutral';
  return 'success';
}

export function checkTitle(report: ImpactReport): string {
  const { breaking, deprecating } = report.totals;
  if (breaking === 0 && deprecating === 0) return `No Stripe changes affect this code (target ${report.targetVersion})`;
  const parts = [];
  if (breaking > 0) parts.push(`${breaking} breaking`);
  if (deprecating > 0) parts.push(`${deprecating} deprecating`);
  return `${parts.join(', ')} Stripe change(s) affect this code (target ${report.targetVersion})`;
}

/** Create a check run in the pending state, so a PR shows activity immediately. */
export async function openCheck(ctx: PostContext, sha: string): Promise<number> {
  return createCheckRun(ctx.token, ctx.ref, {
    name: CHECK_NAME,
    head_sha: sha,
    status: 'in_progress',
    output: { title: 'Scanning for Stripe API impact…', summary: '' },
  });
}

export async function completeCheck(
  ctx: PostContext,
  checkId: number,
  report: ImpactReport,
  failing: boolean,
): Promise<void> {
  await updateCheckRun(ctx.token, ctx.ref, checkId, {
    status: 'completed',
    conclusion: checkConclusion(report, failing),
    output: {
      title: checkTitle(report),
      summary:
        report.findings.length === 0
          ? `${report.unaffectedChanges} change(s) between ${report.currentVersion ?? 'your version'} and ${report.targetVersion} touch nothing this repo uses.`
          : `${report.totals.breaking} breaking, ${report.totals.deprecating} deprecating across ${report.findings.length} finding(s).`,
      text: truncate(renderMarkdown(report) + footer(ctx), CHECK_TEXT_MAX),
    },
  });
}

/**
 * Our own failure must never fail someone's pull request. A scan that could not
 * run is reported as neutral with the reason, and the customer can rerun it.
 */
export async function failCheckNeutrally(ctx: PostContext, checkId: number, reason: string): Promise<void> {
  await updateCheckRun(ctx.token, ctx.ref, checkId, {
    status: 'completed',
    conclusion: 'neutral',
    output: {
      title: 'apiwatcher could not scan this commit',
      summary: `The scan did not complete: ${reason}. This is not a problem with your code.`,
    },
  });
}

/** Open the tracking issue, or refresh the existing one in place. */
export async function upsertTrackingIssue(ctx: PostContext, report: ImpactReport): Promise<string> {
  await ensureLabel(ctx.token, ctx.ref, ISSUE_LABEL);
  const body = renderMarkdown(report) + footer(ctx);
  const existing = await findOpenIssueByLabel(ctx.token, ctx.ref, ISSUE_LABEL.name);

  if (existing) {
    await updateIssue(ctx.token, ctx.ref, existing.number, { title: ISSUE_TITLE, body });
    return existing.html_url;
  }
  const created = await createIssue(ctx.token, ctx.ref, {
    title: ISSUE_TITLE,
    body,
    labels: [ISSUE_LABEL.name],
  });
  return created.html_url;
}

/** Nothing is affected any more: close the issue if one is open. */
export async function closeTrackingIssue(ctx: PostContext): Promise<boolean> {
  const existing = await findOpenIssueByLabel(ctx.token, ctx.ref, ISSUE_LABEL.name);
  if (!existing) return false;
  await updateIssue(ctx.token, ctx.ref, existing.number, {
    state: 'closed',
    body: `No Stripe API changes affect this repository any more.${footer(ctx)}`,
  });
  return true;
}
