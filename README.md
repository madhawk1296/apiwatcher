# apiwatcher

Dependabot for API changes.

When an API provider ships a breaking change, this finds every affected call site
in your repo and tells you what to fix. Today it covers **Stripe** and
**TypeScript**, and it reports — it does not open fix-up PRs.

```
BREAKING POST /v1/terminal/configurations/{configuration}  stripe-2026-08-26.dahlia-0137
  Request parameter "tipping.bgn" was removed.
  → Stop using `tipping.bgn` — it is gone in the target version.
    src/routes/checkout.ts:22:16  tipping: { bgn: { fixed_amounts: [100] } },
    docs: https://docs.stripe.com/upgrades
```

Dependabot tells you a version number moved. It cannot tell you that
`tipping.bgn` no longer exists and that line 22 of your checkout route is the
place that breaks. That gap is the whole product.

## Two ways to use it

**Install the [GitHub App](docs/github-app.md).** Every repo that uses Stripe
gets a check on each pull request, an updated tracking issue on each push to
your default branch, and a scan against every new Stripe API version the day it
ships. Nothing to configure, no workflow file.

**Or run the CLI.** No account, no API key, no network call:

```bash
npx apiwatcher-cli scan
```

It reads your files, compares them against a changeset that ships inside the
package, and prints the report. Exit code is `1` when something breaks, so it
drops into CI as-is.

```bash
npx apiwatcher-cli scan ./services/api --target 2026-08-26.dahlia --format md --out report.md
```

Same scanner either way; the App just runs it for you and knows when Stripe
ships something.

## How it works

Two loops.

**The spec watcher** runs on a cron in this repo. It pulls Stripe's OpenAPI spec,
diffs it against the last version it published, and commits a changeset — a
machine-readable list of what broke, each with a docs link and a one-line
explanation. One changeset per Stripe version, monthly back to 2024-06-20, so a
finding names the exact version that introduced it. Free on public-repo
Actions, and a no-op almost every day.

**The server** ([docs/server.md](docs/server.md)) receives the GitHub App's
webhooks, keeps an index of which installed repos use Stripe, and scans them:
shallow-clone the commit, run the scanner, post a check or issue, delete the
clone. When the spec watcher publishes a new version, the server scans every
tracked repo that is behind. Repos already current, or that do not use Stripe,
are never touched.

```
stripe/openapi ──cron──▶ changesets ──▶ server ──▶ clone → scan → check / issue
                                          ▲
GitHub webhooks (install, push, PR) ──────┘
```

One Node process on one small box. Customer code is on disk for the seconds a
scan takes and nowhere else.

## What it detects

Detection is deterministic. There is no model in the loop, and no token spend.

The trick is that the SDK-method-to-endpoint map is itself the oracle: a call
chain that matches a real Stripe endpoint is strong evidence, whatever the
variable is called. That map is generated from the `stripe` package's own
generated resource files, so `checkout.sessions.create` → `POST
/v1/checkout/sessions` is ground truth rather than a guess at Stripe's
pluralization rules.

On top of that, the scanner resolves the indirection real code actually uses:

| Pattern | Example |
| --- | --- |
| Direct calls | `stripe.paymentIntents.create({ ... })` |
| Wrapper modules | client defined in `lib/stripe.ts`, used everywhere else |
| Barrel re-exports | `export { stripe } from './stripe'` |
| Path aliases | `import { stripe } from '@/lib/stripe'` |
| Workspace packages | `import { stripe } from '@acme/core/client'` |
| Factory functions | `const stripe = getStripeClient()` |
| Env-guarded init | `const stripe = KEY ? new Stripe(KEY) : null` |
| Local aliases | `const client = stripeClient` |
| Typed parameters | `function handle(stripe: Stripe, ...)` |
| List iteration | `page.data.map((r) => r.destination_details)` |
| Raw REST | ``fetch(`https://api.stripe.com/v1/charges/${id}`)`` |
| Webhook events | `case 'invoice.payment_failed':` |
| Version pins | `apiVersion: STRIPE_API_VERSION` (constant resolved) |

Every finding carries a file, line, and the source line itself. Anything matched
by shape rather than a resolved binding is reported with a confidence score and
flagged for review — a report you cannot verify is a report you will not act on.

Measured on two real repositories:

| Repo | Files | Time | Stripe calls found | Resolved to a client |
| --- | --- | --- | --- | --- |
| formbricks (`apps/web`) | 2,179 | 1.8s | 46 | 46 |
| documenso | 1,967 | 1.2s | 15 | 15 |

## Configuration

Optional. Drop `.apiwatcher.json` at your repo root:

```json
{
  "target": "latest",
  "alerts": true,
  "scanOnPush": true,
  "ignorePaths": ["src/generated"],
  "ignoreChanges": ["stripe-2026-08-26.dahlia-0042"],
  "failOn": "breaking"
}
```

`ignoreChanges` is the escape hatch for a false positive — every finding prints
its id. `scanOnPush: false` keeps the version alerts and drops the PR checks.

## CLI commands

| Command | What it does |
| --- | --- |
| `apiwatcher scan [dir]` | Scan a repo and print an impact report |
| `apiwatcher spec-diff` | Diff two Stripe spec versions into a changeset |
| `apiwatcher watch` | Diff Stripe's current spec forward (the cron entry point) |
| `apiwatcher backfill --since <date>` | Build one changeset per Stripe version from spec history |
| `apiwatcher build-method-map` | Regenerate the SDK-call → endpoint map |
| `apiwatcher list-changesets` | Show known changesets |
| `apiwatcher index-changesets` | Regenerate the changeset manifest |

Run `apiwatcher --help` for flags.

## Repo layout

```
packages/apiwatcher/   the scanner, differ, and CLI — published as apiwatcher-cli
packages/server/       the backend: webhooks, index, scan queue, posting
changesets/stripe/     published changesets + index.json
deploy/                systemd unit, Caddyfile, setup script for a fresh box
.github/workflows/     CI and the spec watcher cron
```

## Development

```bash
npm install
npm run build --workspace apiwatcher-cli
npm run build --workspace @apiwatcher/server
npm test --workspaces
```

Bootstrapping a changeset from scratch:

```bash
node packages/apiwatcher/dist/cli/index.js build-method-map
node packages/apiwatcher/dist/cli/index.js spec-diff --from-ref <old-sha> --to-ref master
node packages/apiwatcher/dist/cli/index.js index-changesets
```

Running the server locally needs `APP_ID`, `APP_PRIVATE_KEY_FILE`, and
`WEBHOOK_SECRET` in the environment; see [docs/server.md](docs/server.md).

## Status and limits

Early. Worth knowing before you trust it:

- **One API, one language.** Stripe and TypeScript.
- **Changesets are generated, not hand-verified.** Rename detection is a
  heuristic — conservative by design, but the spec watcher opens a review issue
  for each new version rather than trusting itself.
- **Spec-visible changes only.** Rate limits, ordering guarantees, and error-code
  changes are real breakage that an OpenAPI diff cannot see.
- **Response-field recall is partial.** Fields read through a variable the
  scanner cannot follow are missed. Misses are quiet; false positives are the
  thing actively defended against.
- **No auto-fix.** Reports only.
