# apimigrate

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

## Try it

```bash
npx apimigrate scan
```

No account, no API key, no network call. The scan reads your files, compares
them against a changeset that ships inside the package, and prints a report.
Exit code is `1` when something breaks, so it drops into CI as-is.

```bash
npx apimigrate scan ./services/api --target 2026-08-26.dahlia --format md --out report.md
```

## How it works

Two loops that never touch each other.

**The spec watcher** runs on a cron in this repo. It pulls Stripe's OpenAPI spec,
diffs it against the last version it published, and commits a changeset —
a machine-readable list of what broke, with a docs link and a one-line
explanation each. GitHub Actions on a public repo is free, and the job exits in
seconds on the overwhelming majority of runs where nothing changed.

**The scanner** runs on your machine or your CI runner. It finds every Stripe
call site, resolves each to an endpoint, and intersects that with the changeset
for your version range.

The [GitHub App](docs/github-app.md) is what connects them: when a new version
lands, it looks up which installed repos are behind and asks each one's own
workflow to re-scan itself. Repos that are unaffected are never touched.

```
stripe/openapi ──cron──▶ changeset ──┐
                                     ├──▶ GitHub App ──dispatch──▶ your Actions ──▶ issue
your repo ──────scan───▶ call sites ─┘
```

Your code never leaves your infrastructure. The App reads two files per repo —
`package.json` and your config — to decide whether you use Stripe at all.

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

Optional. Drop `.apimigrate.json` at your repo root:

```json
{
  "target": "latest",
  "ignorePaths": ["src/generated"],
  "ignoreChanges": ["stripe-2026-08-26.dahlia-0042"],
  "failOn": "breaking",
  "alerts": true
}
```

`ignoreChanges` is the escape hatch for a false positive — every finding prints
its id.

## Commands

| Command | What it does |
| --- | --- |
| `apimigrate scan [dir]` | Scan a repo and print an impact report |
| `apimigrate spec-diff` | Diff two Stripe spec versions into a changeset |
| `apimigrate watch` | Diff Stripe's current spec forward (the cron entry point) |
| `apimigrate build-method-map` | Regenerate the SDK-call → endpoint map |
| `apimigrate list-changesets` | Show known changesets |
| `apimigrate index-changesets` | Regenerate the changeset manifest |

Run `apimigrate --help` for flags.

## Repo layout

```
packages/apimigrate/     the CLI: changesets, spec diff, scanner, report
packages/github-app/     Cloudflare Worker: webhooks, repo index, alert fan-out
changesets/stripe/       published changesets + index.json
templates/apimigrate.yml the workflow customers copy into their repo
.github/workflows/       CI, the spec watcher, the reusable scan workflow
```

## Development

```bash
npm install
npm run build --workspace apimigrate
node --test "packages/apimigrate/dist/**/*.test.js"
```

Bootstrapping a changeset from scratch:

```bash
node packages/apimigrate/dist/cli/index.js build-method-map
node packages/apimigrate/dist/cli/index.js spec-diff --from-ref <old-sha> --to-ref master
node packages/apimigrate/dist/cli/index.js index-changesets
```

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
