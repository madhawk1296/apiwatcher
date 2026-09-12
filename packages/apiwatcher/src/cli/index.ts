#!/usr/bin/env node
import { appendFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { flagBool, flagList, flagNumber, flagString, parseArgs } from './args.js';
import { changesBetween, latestKnownVersion, loadChangesets } from '../changeset/load.js';
import { buildIndex, writeIndex } from '../changeset/index-file.js';
import { compareApiVersions, isApiVersion } from '../changeset/version.js';
import type { Severity } from '../changeset/types.js';
import { DEFAULT_CONFIG, loadConfig } from '../config.js';
import { scanRepo } from '../scanner/scan.js';
import { loadEventCatalog, loadMethodMap } from '../specdiff/methodmap.js';
import { buildMethodMap, writeMethodMap } from '../specdiff/build-method-map.js';
import { buildReport, exitCodeFor } from '../report/impact.js';
import { renderJson, renderMarkdown, renderTerminal } from '../report/render.js';
import { diffSpecs } from '../specdiff/diff.js';
import {
  changesetFilename,
  fetchSpecAt,
  listSpecCommits,
  readSpecFile,
  resolveSpecCommit,
  STRIPE_SPEC_REPO,
} from '../specdiff/fetch.js';
import { eventTypes } from '../specdiff/openapi.js';

const USAGE = `apiwatcher — find every call site a breaking Stripe API change affects

Usage
  apiwatcher scan [dir] [options]          Scan a repo and print an impact report
  apiwatcher spec-diff [options]           Diff two Stripe spec versions into a changeset
  apiwatcher build-method-map [options]    Regenerate the SDK call -> endpoint map
  apiwatcher list-changesets               Show known changesets
  apiwatcher index-changesets              Regenerate changesets/stripe/index.json
  apiwatcher watch                         Diff Stripe's current spec forward (cron entry point)

scan options
  --target <version|latest>   Version to check against         (default: latest known)
  --from <version>            Override the detected current version
  --format <pretty|md|json>   Output format                    (default: pretty)
  --out <file>                Also write the report to a file
  --fail-on <breaking|deprecating|additive|never>              (default: breaking)
  --min-confidence <0..1>     Drop weaker matches              (default: 0.4)
  --ignore <a,b>              Extra paths to skip
  --changesets <dir>          Changeset directory
  --no-color                  Disable ANSI colour

spec-diff options
  --from-ref <git ref>        Spec commit to diff from (stripe/openapi)
  --to-ref <git ref>          Spec commit to diff to            (default: master)
  --from-file <path>          Use a local spec file instead
  --to-file <path>            Use a local spec file instead
  --out-dir <dir>             Where to write the changeset      (default: ./changesets/stripe)
  --include-additive          Record additive changes too
  --max-depth <n>             Field nesting depth to compare    (default: 3)
  --stdout                    Print the changeset instead of writing it
  --events-out <file>         Event catalogue path (default: packages/apiwatcher/data/stripe/events.json)

build-method-map options
  --out <file>                Output path (default: packages/apiwatcher/data/stripe/method-map.json)

Nothing leaves your machine during a scan. No account, no API keys.
`;

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.flags.has('help') || args.flags.has('h') || args.command === 'help' || args.command === null) {
    process.stdout.write(USAGE);
    return args.command === null && !args.flags.has('help') && !args.flags.has('h') ? 1 : 0;
  }
  if (args.flags.has('version') || args.flags.has('v')) {
    process.stdout.write('apiwatcher 0.1.0\n');
    return 0;
  }

  switch (args.command) {
    case 'scan':
      return runScan(args);
    case 'spec-diff':
      return runSpecDiff(args);
    case 'build-method-map':
      return runBuildMethodMap(args);
    case 'list-changesets':
      return runListChangesets(args);
    case 'index-changesets':
      return runIndexChangesets(args);
    case 'watch':
      return runWatch(args);
    default:
      process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}`);
      return 1;
  }
}

async function runScan(args: ReturnType<typeof parseArgs>): Promise<number> {
  const root = resolve(args.positionals[0] ?? '.');
  const { config, file: configFile } = await loadConfig(root);

  const changesetDir = flagString(args, 'changesets');
  const changesets = await loadChangesets(changesetDir);
  if (changesets.length === 0) {
    process.stderr.write(
      'No changesets found. Run `apiwatcher spec-diff` first, or pass --changesets <dir>.\n',
    );
    return 2;
  }

  const latest = latestKnownVersion(changesets);
  if (latest === null) {
    process.stderr.write('Changesets are present but none declare a target version.\n');
    return 2;
  }

  const requestedTarget = flagString(args, 'target') ?? config.target ?? DEFAULT_CONFIG.target;
  const target = requestedTarget === 'latest' ? latest : requestedTarget;
  if (!isApiVersion(target)) {
    process.stderr.write(`--target must be a Stripe version or "latest", got "${target}".\n`);
    return 2;
  }

  const methodMap = await loadMethodMap();
  const knownEvents = await loadEventCatalog();

  const minConfidence =
    flagNumber(args, 'min-confidence') ?? config.minConfidence ?? DEFAULT_CONFIG.minConfidence;

  const scan = await scanRepo(root, {
    methodMap,
    minConfidence,
    ...(knownEvents ? { knownEvents } : {}),
    ignore: [...(config.ignorePaths ?? []), ...(flagList(args, 'ignore') ?? [])],
  });

  // Current version: explicit override, then the pin, then the SDK default.
  const override = flagString(args, 'from');
  if (override !== undefined) {
    if (!isApiVersion(override)) {
      process.stderr.write(`--from must be a Stripe version, got "${override}".\n`);
      return 2;
    }
    scan.version.apiVersion = override;
    delete scan.version.apiVersionEvidence;
  }

  const current = scan.version.apiVersion ?? scan.version.sdkDefaultApiVersion ?? null;
  if (current === null) {
    scan.warnings.push(
      'Could not determine the current API version (no apiVersion pin, no installed SDK). Comparing against the full changeset history — pass --from to narrow it.',
    );
  } else if (compareApiVersions(current, target) >= 0) {
    scan.warnings.push(
      `Detected current version ${current} is not older than the target ${target}; there is nothing to migrate.`,
    );
  }

  const oldestFrom = changesets[0]?.from ?? target;
  const changes = changesBetween(changesets, current ?? oldestFrom, target);

  const report = buildReport({
    scan,
    changes,
    targetVersion: target,
    minConfidence,
    ...(config.ignoreChanges ? { ignoreIds: config.ignoreChanges } : {}),
  });
  if (configFile) report.warnings.push(`Using config from ${configFile}`);

  const format = flagString(args, 'format') ?? 'pretty';
  const colorFlag = flagBool(args, 'color');
  const rendered =
    format === 'json'
      ? renderJson(report)
      : format === 'md' || format === 'markdown'
        ? renderMarkdown(report)
        : renderTerminal(report, colorFlag === undefined ? {} : { color: colorFlag });

  if (format !== 'pretty' && format !== 'json' && format !== 'md' && format !== 'markdown') {
    process.stderr.write(`Unknown --format "${format}". Use pretty, md, or json.\n`);
    return 2;
  }

  process.stdout.write(rendered);

  const outFile = flagString(args, 'out');
  if (outFile) {
    // Default the file's format from its extension so `--out report.md` behaves.
    const body = outFile.endsWith('.json')
      ? renderJson(report)
      : outFile.endsWith('.md')
        ? renderMarkdown(report)
        : rendered;
    await mkdir(dirname(resolve(outFile)), { recursive: true });
    await writeFile(resolve(outFile), body, 'utf8');
    process.stderr.write(`Wrote ${outFile}\n`);
  }

  const failOn = (flagString(args, 'fail-on') ?? config.failOn ?? DEFAULT_CONFIG.failOn) as
    | Severity
    | 'never';
  return exitCodeFor(report, failOn);
}

async function runSpecDiff(args: ReturnType<typeof parseArgs>): Promise<number> {
  const fromFile = flagString(args, 'from-file');
  const toFile = flagString(args, 'to-file');
  const fromRef = flagString(args, 'from-ref');
  const toRef = flagString(args, 'to-ref') ?? 'master';

  if (!fromFile && !fromRef) {
    process.stderr.write(
      'spec-diff needs a starting point: --from-file <path> or --from-ref <git ref>.\n' +
        'Tip: `apiwatcher spec-diff --from-ref <sha>` diffs against stripe/openapi at that commit.\n',
    );
    return 2;
  }

  process.stderr.write('Loading specs…\n');
  const [oldSpec, newSpec] = await Promise.all([
    fromFile ? readSpecFile(fromFile) : fetchSpecAt(fromRef as string),
    toFile ? readSpecFile(toFile) : fetchSpecAt(toRef),
  ]);

  const methodMap = await loadMethodMap();
  const maxDepth = flagNumber(args, 'max-depth') ?? 3;

  process.stderr.write(
    `Diffing ${oldSpec.info?.version ?? '?'} -> ${newSpec.info?.version ?? '?'} (depth ${maxDepth})…\n`,
  );

  const changeset = diffSpecs(oldSpec, newSpec, {
    methodMap,
    maxDepth,
    includeAdditive: flagBool(args, 'include-additive') === true,
    ...(fromFile || toFile
      ? {}
      : {
          source: {
            repo: STRIPE_SPEC_REPO,
            fromRef: fromRef as string,
            // Pinned, so `apiwatcher watch` has a fixed point to diff forward from.
            toRef: await resolveSpecCommit(toRef),
          },
        }),
  });

  const body = `${JSON.stringify(changeset, null, 2)}\n`;

  if (flagBool(args, 'stdout') === true) {
    process.stdout.write(body);
  } else {
    const outDir = resolve(flagString(args, 'out-dir') ?? 'changesets/stripe');
    await mkdir(outDir, { recursive: true });
    const outFile = resolve(outDir, changesetFilename(changeset.from, changeset.to));
    await writeFile(outFile, body, 'utf8');
    process.stdout.write(`${outFile}\n`);

    // The event catalogue lets the scanner recognise webhook event strings
    // exactly rather than inferring them from surrounding code.
    const catalogFile = resolve(
      flagString(args, 'events-out') ?? 'packages/apiwatcher/data/stripe/events.json',
    );
    await mkdir(dirname(catalogFile), { recursive: true });
    await writeFile(
      catalogFile,
      `${JSON.stringify(
        {
          apiVersion: changeset.to,
          generatedAt: changeset.generatedAt,
          events: [...eventTypes(newSpec).keys()].sort(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  const breaking = changeset.changes.filter((c) => c.severity === 'breaking').length;
  process.stderr.write(`${changeset.changes.length} change(s), ${breaking} breaking.\n`);
  return 0;
}

async function runBuildMethodMap(args: ReturnType<typeof parseArgs>): Promise<number> {
  const out = resolve(flagString(args, 'out') ?? 'packages/apiwatcher/data/stripe/method-map.json');
  const map = await buildMethodMap();
  await writeMethodMap(map, out);
  process.stdout.write(
    `${out}\n${Object.keys(map.byCall).length} SDK methods across ${Object.keys(map.byEndpoint).length} endpoints (stripe@${map.sdkVersion}).\n`,
  );
  return 0;
}

async function runListChangesets(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sets = await loadChangesets(flagString(args, 'changesets'));
  if (sets.length === 0) {
    process.stdout.write('No changesets found.\n');
    return 0;
  }
  for (const cs of sets) {
    const breaking = cs.changes.filter((c) => c.severity === 'breaking').length;
    process.stdout.write(
      `${cs.from} -> ${cs.to}  ${String(cs.changes.length).padStart(5)} change(s)  ${String(breaking).padStart(5)} breaking\n`,
    );
  }
  return 0;
}

async function runIndexChangesets(args: ReturnType<typeof parseArgs>): Promise<number> {
  const dir = resolve(flagString(args, 'changesets') ?? 'changesets', 'stripe');
  const sets = await loadChangesets(flagString(args, 'changesets'));
  const withFiles = sets.map((changeset) => ({
    changeset,
    file: changesetFilename(changeset.from, changeset.to),
  }));
  const file = await writeIndex(buildIndex(withFiles), dir);
  process.stdout.write(`${file}\n`);
  return 0;
}

/**
 * The spec watcher.
 *
 * Diffs Stripe's current spec against the point the last changeset stopped at. If
 * the API version has not moved, it exits 0 having written nothing, so a daily
 * cron is a no-op on almost every run.
 */
async function runWatch(args: ReturnType<typeof parseArgs>): Promise<number> {
  const changesetRoot = flagString(args, 'changesets');
  const sets = await loadChangesets(changesetRoot);
  const newest = sets[sets.length - 1];

  if (!newest) {
    process.stderr.write(
      'No existing changeset to continue from. Bootstrap one first:\n' +
        '  apiwatcher spec-diff --from-ref <old spec sha> --to-ref master\n',
    );
    return 2;
  }
  const fromRef = newest.source?.toRef;
  if (!fromRef) {
    process.stderr.write(
      `Changeset ${newest.from} -> ${newest.to} has no source.toRef, so the watcher cannot diff forward.\n` +
        'Regenerate it with --from-ref/--to-ref so provenance is recorded.\n',
    );
    return 2;
  }

  // Pin the branch to a commit up front: the recorded ref becomes the next
  // run's starting point, and a branch name there would move under us.
  const requestedRef = flagString(args, 'to-ref') ?? 'master';
  const toRef = await resolveSpecCommit(requestedRef);
  process.stderr.write(`Checking ${STRIPE_SPEC_REPO}@${requestedRef} (${toRef.slice(0, 8)}) against ${newest.to}…\n`);

  const newSpec = await fetchSpecAt(toRef);
  const incoming = newSpec.info?.version;
  if (!incoming) {
    process.stderr.write('Fetched spec does not declare info.version.\n');
    return 2;
  }

  if (compareApiVersions(incoming, newest.to) <= 0) {
    process.stdout.write(`No new Stripe version (still ${newest.to}).\n`);
    return 0;
  }

  process.stderr.write(`New version ${incoming}; diffing from ${newest.to}…\n`);
  const oldSpec = await fetchSpecAt(fromRef);
  const methodMap = await loadMethodMap();

  const changeset = diffSpecs(oldSpec, newSpec, {
    methodMap,
    maxDepth: flagNumber(args, 'max-depth') ?? 3,
    includeAdditive: flagBool(args, 'include-additive') === true,
    source: { repo: STRIPE_SPEC_REPO, fromRef, toRef },
  });

  const outDir = resolve(flagString(args, 'out-dir') ?? 'changesets/stripe');
  await mkdir(outDir, { recursive: true });
  const outFile = resolve(outDir, changesetFilename(changeset.from, changeset.to));
  await writeFile(outFile, `${JSON.stringify(changeset, null, 2)}\n`, 'utf8');

  const catalogFile = resolve(
    flagString(args, 'events-out') ?? 'packages/apiwatcher/data/stripe/events.json',
  );
  await mkdir(dirname(catalogFile), { recursive: true });
  await writeFile(
    catalogFile,
    `${JSON.stringify(
      {
        apiVersion: changeset.to,
        generatedAt: changeset.generatedAt,
        events: [...eventTypes(newSpec).keys()].sort(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // Refresh the manifest so the GitHub App notices the new version.
  const refreshed = await loadChangesets(changesetRoot);
  await writeIndex(
    buildIndex(refreshed.map((cs) => ({ changeset: cs, file: changesetFilename(cs.from, cs.to) }))),
    outDir,
  );

  const breaking = changeset.changes.filter((c) => c.severity === 'breaking').length;
  process.stdout.write(
    `${changeset.from} -> ${changeset.to}: ${changeset.changes.length} change(s), ${breaking} breaking\n`,
  );

  // Let the workflow branch on the result without parsing stdout.
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    await appendFile(
      githubOutput,
      `new_version=${changeset.to}\nbreaking=${breaking}\nchangeset=${outFile}\n`,
      'utf8',
    );
  }
  return 0;
}

/** Useful for the spec watcher: which spec commits exist. */
export { listSpecCommits };

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`apiwatcher: ${message}\n`);
    process.exitCode = 2;
  });
