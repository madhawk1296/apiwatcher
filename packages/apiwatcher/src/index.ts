export * from './changeset/types.js';
export * from './changeset/version.js';
export {
  loadChangeset,
  loadChangesets,
  changesBetween,
  latestKnownVersion,
  oldestCoveredVersion,
  validateChangeset,
  defaultChangesetDir,
} from './changeset/load.js';

export { diffSpecs, type DiffOptions } from './specdiff/diff.js';
export {
  fetchSpecAt,
  listSpecCommits,
  readSpecFile,
  changesetFilename,
  versionSlug,
  STRIPE_SPEC_PATH,
  STRIPE_SPEC_REPO,
} from './specdiff/fetch.js';
export {
  loadMethodMap,
  loadEventCatalog,
  defaultMethodMapPath,
  lookupSdkMethods,
  normalizePath,
  endpointKey,
  callKey,
  type MethodMap,
} from './specdiff/methodmap.js';
export { buildMethodMap, writeMethodMap, findStripeCore } from './specdiff/build-method-map.js';

export { scanRepo, type ScanOptions } from './scanner/scan.js';
export * from './scanner/types.js';
export { detectVersion } from './scanner/version.js';

export { buildReport, exitCodeFor, type ImpactReport, type Finding } from './report/impact.js';
export { renderTerminal, renderMarkdown, renderJson } from './report/render.js';

export {
  loadConfig,
  validateConfig,
  findConfigFile,
  DEFAULT_CONFIG,
  CONFIG_FILENAMES,
  type RepoConfig,
} from './config.js';
