import type { Severity } from '../changeset/types.js';
import type { Finding, ImpactReport } from './impact.js';

/** Cap the call sites listed per finding so a big repo still produces a readable report. */
const SITES_PER_FINDING = 8;

const COLORS = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  grey: '\u001b[90m',
};

export function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  return process.stdout.isTTY === true;
}

function makePaint(enabled: boolean) {
  return (text: string, ...styles: Array<keyof typeof COLORS>): string => {
    if (!enabled) return text;
    return `${styles.map((s) => COLORS[s]).join('')}${text}${COLORS.reset}`;
  };
}

const SEVERITY_LABEL: Record<Severity, string> = {
  breaking: 'BREAKING',
  deprecating: 'DEPRECATED',
  additive: 'ADDED',
};

function severityStyle(severity: Severity): Array<keyof typeof COLORS> {
  if (severity === 'breaking') return ['red', 'bold'];
  if (severity === 'deprecating') return ['yellow'];
  return ['green'];
}

function versionLine(report: ImpactReport): string {
  if (report.currentVersion === null) {
    return 'current version: unknown (no apiVersion pin and no installed SDK found)';
  }
  const how =
    report.currentVersionSource === 'pinned'
      ? 'pinned in code'
      : 'the installed SDK default — no explicit apiVersion pin';
  return `current version: ${report.currentVersion} (${how})`;
}

export function renderTerminal(report: ImpactReport, options: { color?: boolean } = {}): string {
  const paint = makePaint(options.color ?? supportsColor());
  const out: string[] = [];

  out.push(paint('apiwatcher · Stripe', 'bold'));
  out.push(paint(versionLine(report), 'grey'));
  out.push(paint(`target version:  ${report.targetVersion}`, 'grey'));
  out.push(paint(`scanned ${report.filesScanned} file(s) under ${report.root}`, 'grey'));
  out.push('');

  if (report.findings.length === 0) {
    out.push(paint('✓ Nothing in this repo is affected by changes in that range.', 'green', 'bold'));
    if (report.unaffectedChanges > 0) {
      out.push(paint(`  (${report.unaffectedChanges} change(s) in range touch code you do not use)`, 'grey'));
    }
    out.push(...renderWarnings(report, paint));
    return `${out.join('\n')}\n`;
  }

  const summary = [
    report.totals.breaking > 0
      ? paint(`${report.totals.breaking} breaking`, ...severityStyle('breaking'))
      : null,
    report.totals.deprecating > 0
      ? paint(`${report.totals.deprecating} deprecating`, ...severityStyle('deprecating'))
      : null,
    report.totals.additive > 0 ? paint(`${report.totals.additive} additive`, 'green') : null,
  ].filter((s): s is string => s !== null);
  out.push(`${paint('Impact:', 'bold')} ${summary.join(paint(' · ', 'grey'))}`);
  out.push('');

  for (const finding of report.findings) {
    out.push(renderFindingTerminal(finding, paint));
    out.push('');
  }

  if (report.unaffectedChanges > 0) {
    out.push(paint(`${report.unaffectedChanges} other change(s) in range do not touch this repo.`, 'grey'));
  }
  out.push(...renderWarnings(report, paint));
  return `${out.join('\n')}\n`;
}

function renderWarnings(report: ImpactReport, paint: ReturnType<typeof makePaint>): string[] {
  if (report.warnings.length === 0) return [];
  const out = ['', paint('Notes:', 'dim')];
  for (const w of report.warnings) out.push(paint(`  · ${w}`, 'grey'));
  return out;
}

function renderFindingTerminal(finding: Finding, paint: ReturnType<typeof makePaint>): string {
  const { change, sites } = finding;
  const lines: string[] = [];

  const tag = paint(SEVERITY_LABEL[finding.severity], ...severityStyle(finding.severity));
  const where = change.path
    ? `${String(change.method ?? '').toUpperCase()} ${change.path}`
    : (change.event ?? '');
  lines.push(`${tag} ${paint(where, 'cyan')}  ${paint(change.id, 'grey')}`);
  lines.push(`  ${change.note}`);
  lines.push(`  ${paint('→', 'bold')} ${finding.suggestion}`);

  if (finding.confidence < 0.9) {
    lines.push(paint(`  confidence ${finding.confidence.toFixed(2)} — verify before changing`, 'yellow'));
  }

  const shown = sites.slice(0, SITES_PER_FINDING);
  for (const site of shown) {
    lines.push(
      `    ${paint(`${site.evidence.file}:${site.evidence.line}:${site.evidence.column}`, 'dim')}  ${site.evidence.snippet}`,
    );
  }
  if (sites.length > shown.length) {
    lines.push(paint(`    … and ${sites.length - shown.length} more call site(s)`, 'grey'));
  }
  if (change.docsUrl) lines.push(paint(`    docs: ${change.docsUrl}`, 'grey'));

  return lines.join('\n');
}

// --------------------------------------------------------------------------

export function renderMarkdown(report: ImpactReport): string {
  const out: string[] = [];

  out.push('# Stripe API impact report');
  out.push('');
  out.push(`- **${versionLine(report).replace('current version: ', 'Current version:** ')}`);
  out.push(`- **Target version:** ${report.targetVersion}`);
  out.push(`- **Files scanned:** ${report.filesScanned}`);
  out.push(`- **Generated:** ${report.scannedAt}`);
  out.push('');

  if (report.findings.length === 0) {
    out.push('Nothing in this repo is affected by changes in that range.');
    if (report.unaffectedChanges > 0) {
      out.push('');
      out.push(`${report.unaffectedChanges} change(s) in range touch code this repo does not use.`);
    }
    out.push(...markdownWarnings(report));
    return `${out.join('\n')}\n`;
  }

  out.push(
    `**${report.totals.breaking} breaking**, ${report.totals.deprecating} deprecating, ${report.totals.additive} additive.`,
  );
  out.push('');
  out.push('| Severity | Change | Where | Sites |');
  out.push('| --- | --- | --- | --- |');
  for (const f of report.findings) {
    const where = f.change.path
      ? `\`${String(f.change.method ?? '').toUpperCase()} ${f.change.path}\``
      : `\`${f.change.event ?? ''}\``;
    out.push(
      `| ${SEVERITY_LABEL[f.severity]} | ${escapePipes(f.change.note)} | ${where} | ${f.sites.length} |`,
    );
  }
  out.push('');

  for (const group of ['breaking', 'deprecating', 'additive'] as const) {
    const findings = report.findings.filter((f) => f.severity === group);
    if (findings.length === 0) continue;
    out.push(`## ${group === 'breaking' ? 'Breaking' : group === 'deprecating' ? 'Deprecated' : 'Additive'}`);
    out.push('');
    for (const f of findings) out.push(...markdownFinding(f));
  }

  if (report.unaffectedChanges > 0) {
    out.push(`<sub>${report.unaffectedChanges} other change(s) in range do not touch this repo.</sub>`);
    out.push('');
  }
  out.push(...markdownWarnings(report));
  return `${out.join('\n')}\n`;
}

function markdownFinding(finding: Finding): string[] {
  const { change, sites } = finding;
  const out: string[] = [];
  const where = change.path
    ? `${String(change.method ?? '').toUpperCase()} ${change.path}`
    : (change.event ?? '');

  out.push(`### \`${where}\` — ${change.note}`);
  out.push('');
  out.push(`**Fix:** ${finding.suggestion}`);
  out.push('');
  if (finding.confidence < 0.9) {
    out.push(
      `> Confidence ${finding.confidence.toFixed(2)}. The call site was matched by shape rather than a resolved client binding — verify before changing.`,
    );
    out.push('');
  }

  const shown = sites.slice(0, SITES_PER_FINDING);
  for (const site of shown) {
    out.push(`- \`${site.evidence.file}:${site.evidence.line}\``);
    out.push('  ```ts');
    out.push(`  ${site.evidence.snippet}`);
    out.push('  ```');
  }
  if (sites.length > shown.length) {
    out.push(`- … and ${sites.length - shown.length} more call site(s)`);
  }
  out.push('');
  const meta = [`id: \`${change.id}\``];
  if (change.docsUrl) meta.push(`[docs](${change.docsUrl})`);
  out.push(`<sub>${meta.join(' · ')}</sub>`);
  out.push('');
  return out;
}

function markdownWarnings(report: ImpactReport): string[] {
  if (report.warnings.length === 0) return [];
  const out = ['## Notes', ''];
  for (const w of report.warnings) out.push(`- ${w}`);
  out.push('');
  return out;
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** Machine-readable output, for the GitHub App and for piping into other tools. */
export function renderJson(report: ImpactReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
