import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReport, exitCodeFor } from './impact.js';
import { renderMarkdown, renderTerminal } from './render.js';
import type { SpecChange } from '../changeset/types.js';
import type { ScanResult, Usage } from '../scanner/types.js';

let seq = 0;
function usage(partial: Partial<Usage> & Pick<Usage, 'kind'>): Usage {
  seq += 1;
  return {
    confidence: 1,
    evidence: { file: 'src/a.ts', line: seq, column: 1, snippet: 'code' },
    ...partial,
  };
}

function scanOf(usages: Usage[], apiVersion = '2025-01-01'): ScanResult {
  return {
    root: '/repo',
    filesScanned: 1,
    usages,
    version: { apiVersion, sdkRange: '^22.0.0' },
    clients: [],
    warnings: [],
  };
}

function change(partial: Partial<SpecChange>): SpecChange {
  return {
    id: 'c1',
    kind: 'removed',
    severity: 'breaking',
    location: 'requestBody',
    note: 'note',
    ...partial,
  } as SpecChange;
}

const TARGET = '2025-06-01';

test('a removed request parameter matches the call that passes it', () => {
  const report = buildReport({
    scan: scanOf([
      usage({ kind: 'sdkCall', httpMethod: 'post', path: '/v1/x', callId: 'k1' }),
      usage({ kind: 'requestParam', httpMethod: 'post', path: '/v1/x', field: 'gone', callId: 'k1' }),
    ]),
    changes: [change({ method: 'post', path: '/v1/x', field: 'gone' })],
    targetVersion: TARGET,
  });

  assert.equal(report.findings.length, 1);
  assert.equal(report.totals.breaking, 1);
});

test('passing only an ancestor is not affected by a child being removed', () => {
  // `line_items: [{ price, quantity }]` must not be flagged because some
  // unrelated `line_items[].dynamic_tax_rates` disappeared.
  const report = buildReport({
    scan: scanOf([
      usage({ kind: 'sdkCall', httpMethod: 'post', path: '/v1/x', callId: 'k1' }),
      usage({ kind: 'requestParam', httpMethod: 'post', path: '/v1/x', field: 'line_items', callId: 'k1' }),
    ]),
    changes: [change({ method: 'post', path: '/v1/x', field: 'line_items[].dynamic_tax_rates' })],
    targetVersion: TARGET,
  });

  assert.equal(report.findings.length, 0);
  assert.equal(report.unaffectedChanges, 1);
});

test('a newly required top-level parameter flags calls that omit it', () => {
  const omitting = buildReport({
    scan: scanOf([
      usage({ kind: 'sdkCall', httpMethod: 'post', path: '/v1/x', callId: 'k1' }),
      usage({ kind: 'requestParam', httpMethod: 'post', path: '/v1/x', field: 'other', callId: 'k1' }),
    ]),
    changes: [change({ kind: 'required', method: 'post', path: '/v1/x', field: 'currency' })],
    targetVersion: TARGET,
  });
  assert.equal(omitting.findings.length, 1);

  const supplying = buildReport({
    scan: scanOf([
      usage({ kind: 'sdkCall', httpMethod: 'post', path: '/v1/x', callId: 'k2' }),
      usage({ kind: 'requestParam', httpMethod: 'post', path: '/v1/x', field: 'currency', callId: 'k2' }),
    ]),
    changes: [change({ kind: 'required', method: 'post', path: '/v1/x', field: 'currency' })],
    targetVersion: TARGET,
  });
  assert.equal(supplying.findings.length, 0, 'a call already passing the field is fine');
});

test('a conditionally required field only flags calls that reach its parent', () => {
  const field = 'cfg.anchor.day';

  // Passes `cfg.other` — we enumerated cfg's children and `anchor` is absent.
  const unrelated = buildReport({
    scan: scanOf([
      usage({ kind: 'sdkCall', httpMethod: 'post', path: '/v1/x', callId: 'k1' }),
      usage({ kind: 'requestParam', httpMethod: 'post', path: '/v1/x', field: 'cfg', callId: 'k1' }),
      usage({ kind: 'requestParam', httpMethod: 'post', path: '/v1/x', field: 'cfg.other', callId: 'k1' }),
    ]),
    changes: [change({ kind: 'required', method: 'post', path: '/v1/x', field })],
    targetVersion: TARGET,
  });
  assert.equal(unrelated.findings.length, 0, 'cfg.anchor demonstrably not passed');

  // Passes `cfg.anchor` but not the newly required `day` inside it.
  const affected = buildReport({
    scan: scanOf([
      usage({ kind: 'sdkCall', httpMethod: 'post', path: '/v1/x', callId: 'k2' }),
      usage({ kind: 'requestParam', httpMethod: 'post', path: '/v1/x', field: 'cfg', callId: 'k2' }),
      usage({ kind: 'requestParam', httpMethod: 'post', path: '/v1/x', field: 'cfg.anchor', callId: 'k2' }),
    ]),
    changes: [change({ kind: 'required', method: 'post', path: '/v1/x', field })],
    targetVersion: TARGET,
  });
  assert.equal(affected.findings.length, 1);
});

test('a conditionally required field is reported when we could not look inside', () => {
  // `cfg` recorded with no children means the scanner did not descend, so we
  // cannot rule it out and should say so rather than stay silent.
  const report = buildReport({
    scan: scanOf([
      usage({ kind: 'sdkCall', httpMethod: 'post', path: '/v1/x', callId: 'k1' }),
      usage({ kind: 'requestParam', httpMethod: 'post', path: '/v1/x', field: 'cfg', callId: 'k1' }),
    ]),
    changes: [change({ kind: 'required', method: 'post', path: '/v1/x', field: 'cfg.anchor.day' })],
    targetVersion: TARGET,
  });
  assert.equal(report.findings.length, 1);
});

test('a response change matches through its attributed endpoint and field path', () => {
  const report = buildReport({
    scan: scanOf([
      usage({
        kind: 'responseField',
        httpMethod: 'get',
        path: '/v1/parents',
        field: 'items[].legacy',
      }),
    ]),
    changes: [
      change({
        location: 'response',
        resource: 'item',
        field: 'legacy',
        endpoints: [{ method: 'get', path: '/v1/parents' }],
        fieldPaths: ['items[].legacy'],
      }),
    ],
    targetVersion: TARGET,
  });

  assert.equal(report.findings.length, 1);
});

test('a raw URL with no verb still matches an endpoint change', () => {
  const report = buildReport({
    scan: scanOf([usage({ kind: 'rawUrl', path: '/v1/payment_intents/{}/cancel', confidence: 1 })]),
    changes: [
      change({
        location: 'operation',
        method: 'post',
        path: '/v1/payment_intents/{intent}/cancel',
      }),
    ],
    targetVersion: TARGET,
  });

  assert.equal(report.findings.length, 1, 'parameter names should not prevent the match');
});

test('several matching paths on one line are cited once', () => {
  const report = buildReport({
    scan: scanOf([
      usage({ kind: 'sdkCall', httpMethod: 'post', path: '/v1/x', callId: 'k1' }),
      {
        kind: 'requestParam',
        confidence: 1,
        httpMethod: 'post',
        path: '/v1/x',
        field: 'tipping.bgn',
        callId: 'k1',
        evidence: { file: 'src/a.ts', line: 22, column: 16, snippet: 'tipping: { bgn: {...} }' },
      },
      {
        kind: 'requestParam',
        confidence: 1,
        httpMethod: 'post',
        path: '/v1/x',
        field: 'tipping.bgn.amount',
        callId: 'k1',
        evidence: { file: 'src/a.ts', line: 22, column: 23, snippet: 'tipping: { bgn: {...} }' },
      },
    ]),
    changes: [change({ method: 'post', path: '/v1/x', field: 'tipping.bgn' })],
    targetVersion: TARGET,
  });

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.sites.length, 1, 'one line, one citation');
});

test('ignored change ids are suppressed', () => {
  const scan = scanOf([
    usage({ kind: 'sdkCall', httpMethod: 'post', path: '/v1/x', callId: 'k1' }),
    usage({ kind: 'requestParam', httpMethod: 'post', path: '/v1/x', field: 'gone', callId: 'k1' }),
  ]);
  const changes = [change({ id: 'noisy', method: 'post', path: '/v1/x', field: 'gone' })];

  assert.equal(buildReport({ scan, changes, targetVersion: TARGET }).findings.length, 1);
  assert.equal(
    buildReport({ scan, changes, targetVersion: TARGET, ignoreIds: ['noisy'] }).findings.length,
    0,
  );
});

test('low-confidence matches are dropped by minConfidence', () => {
  const scan = scanOf([
    usage({ kind: 'sdkCall', httpMethod: 'post', path: '/v1/x', callId: 'k1', confidence: 0.5 }),
    usage({
      kind: 'requestParam',
      httpMethod: 'post',
      path: '/v1/x',
      field: 'gone',
      callId: 'k1',
      confidence: 0.5,
    }),
  ]);
  const changes = [change({ method: 'post', path: '/v1/x', field: 'gone' })];

  assert.equal(buildReport({ scan, changes, targetVersion: TARGET, minConfidence: 0.4 }).findings.length, 1);
  assert.equal(buildReport({ scan, changes, targetVersion: TARGET, minConfidence: 0.9 }).findings.length, 0);
});

test('exit code reflects the configured failure threshold', () => {
  const report = buildReport({
    scan: scanOf([
      usage({ kind: 'sdkCall', httpMethod: 'post', path: '/v1/x', callId: 'k1' }),
      usage({ kind: 'requestParam', httpMethod: 'post', path: '/v1/x', field: 'old', callId: 'k1' }),
    ]),
    changes: [
      change({ id: 'd1', kind: 'deprecated', severity: 'deprecating', method: 'post', path: '/v1/x', field: 'old' }),
    ],
    targetVersion: TARGET,
  });

  assert.equal(report.totals.deprecating, 1);
  assert.equal(exitCodeFor(report, 'breaking'), 0, 'deprecations alone should not fail a build');
  assert.equal(exitCodeFor(report, 'deprecating'), 1);
  assert.equal(exitCodeFor(report, 'never'), 0);
});

test('renderers produce readable output for an empty report', () => {
  const report = buildReport({ scan: scanOf([]), changes: [], targetVersion: TARGET });
  const pretty = renderTerminal(report, { color: false });
  assert.match(pretty, /Nothing in this repo is affected/);
  assert.doesNotMatch(pretty, /\[/, 'color:false should emit no ANSI codes');
  assert.match(renderMarkdown(report), /# Stripe API impact report/);
});

test('markdown output lists findings with their evidence', () => {
  const report = buildReport({
    scan: scanOf([
      usage({ kind: 'sdkCall', httpMethod: 'post', path: '/v1/x', callId: 'k1' }),
      usage({ kind: 'requestParam', httpMethod: 'post', path: '/v1/x', field: 'gone', callId: 'k1' }),
    ]),
    changes: [change({ method: 'post', path: '/v1/x', field: 'gone', note: 'Field gone was removed.' })],
    targetVersion: TARGET,
  });

  const md = renderMarkdown(report);
  assert.match(md, /## Breaking/);
  assert.match(md, /Field gone was removed\./);
  assert.match(md, /src\/a\.ts:/);
});
