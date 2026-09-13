# The GitHub App

Install it, and every repo that uses Stripe gets scanned — on push, on pull
request, and whenever Stripe ships a new API version. No workflow file, no CI
changes, nothing to run.

## Install

[github.com/apps/apiwatcher-app](https://github.com/apps/apiwatcher-app) — grant
it only the repositories you want watched.

Repos without a `stripe` dependency are ignored entirely. Repos with one get a
first scan within a minute of install, and a tracking issue if anything is
affected.

## What you get

**On every pull request** that touches TypeScript, JavaScript, or your
dependencies: a check run named `apiwatcher / stripe`. It fails when the change
introduces or keeps a call that breaks at your target Stripe version, and passes
otherwise. Docs-only PRs are skipped.

**On every push to your default branch**: the same check, plus your tracking
issue is brought up to date — or closed if nothing is affected any more.

**When Stripe ships a new API version**: your repo is scanned against it. If
anything breaks, one issue titled *"Stripe API changes affect this repository"*
is opened or updated in place, with every affected file and line and what to
change. If nothing breaks, you hear nothing.

## Permissions

| Permission | Level | Why |
| --- | --- | --- |
| Contents | Read | Clone the commit being scanned |
| Issues | Read and write | The tracking issue |
| Checks | Read and write | The PR check |
| Pull requests | Read | Read a PR's file list, so docs-only PRs are skipped without a clone |
| Metadata | Read | Required by GitHub for any app |

The App clones your repository to scan it. The clone lives on the scanning
server for the seconds the scan takes and is deleted when it finishes; what is
kept is the report — file paths, line numbers, the source line for each finding
— for 30 days, so the check and issue can link to it. If any of that is not
acceptable, the same scanner runs entirely on your own machine or CI as
`npx apiwatcher-cli scan`, with no App involved.

## Config

Optional. `.apiwatcher.json` at your repo root:

```json
{
  "target": "latest",
  "alerts": true,
  "scanOnPush": true,
  "ignorePaths": ["src/generated"],
  "ignoreChanges": []
}
```

- `target` — a Stripe version to check against, or `latest`.
- `alerts: false` — stay installed, never get version issues.
- `scanOnPush: false` — keep version issues, drop the PR and push checks.
- `ignoreChanges` — change ids to suppress; every finding prints its id. The
  escape hatch for a false positive.

## Self-hosting

The whole backend is one Node process. See [server.md](server.md).
