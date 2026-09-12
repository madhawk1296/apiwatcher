# The GitHub App

Report-only. It holds two permissions, never clones your code, and never runs a
scan itself.

## What it actually does

Three jobs, all small:

1. **Keeps an index.** On install and on pushes that touch `package.json` or your
   apiwatcher config, it reads those two files to record whether the repo uses
   Stripe and at what version. Repos with no `stripe` dependency are dropped from
   the index and never heard from again.
2. **Fans out new versions.** When the spec watcher publishes a changeset, the
   App looks up which indexed repos are behind and sends each one a
   `repository_dispatch`. Repos that are already current, pinned ahead, or have
   alerts off are skipped.
3. **Nothing else.** The scan runs in your Actions, on your runner, with your
   token. The report is posted by your workflow, not by us.

That last point is the design: your source never reaches our infrastructure, and
the compute is free to us, so the App can stay on a scale-to-zero worker that
costs pennies at idle.

## Permissions

| Permission | Level | Why |
| --- | --- | --- |
| Metadata | Read | Required by GitHub for any app |
| Contents | Read | Read `package.json` and `.apiwatcher.json` — nothing else |
| Issues | Write | So a scan can open or update its tracking issue |

Subscribed events: `installation`, `installation_repositories`, `push`,
`repository`.

Contents-read does grant more than the App uses. If that is not acceptable, skip
the App entirely and run `npx apiwatcher-cli scan` in CI — the report is identical.

## Install

### 1. Add the workflow to your repo

`repository_dispatch` only triggers workflows that already exist on your default
branch, so this file has to live in your repo. Copy
[`templates/apiwatcher.yml`](../templates/apiwatcher.yml) to
`.github/workflows/apiwatcher.yml`.

It scans on push and on pull requests, weekly as a backstop, and whenever the App
says a new Stripe version landed.

### 2. Install the App

Grant it only the repositories you want watched.

### 3. Optional config

`.apiwatcher.json` at the repo root:

```json
{
  "target": "latest",
  "alerts": true,
  "ignorePaths": ["src/generated"],
  "ignoreChanges": []
}
```

Set `alerts: false` to stay in the index but never receive dispatches — useful
for a repo where you want PR checks but not version nags.

## What you get

On a push or PR, a failing check with the report in the job summary.

On a new Stripe version, one issue titled *"Stripe API changes affect this
repository"*, updated in place on later runs rather than reopened. It closes
itself when nothing is affected any more. Unaffected repos get nothing at all —
silence is the design, not an oversight.

## Self-hosting

The worker has no dependencies and runs on Cloudflare Workers.

```bash
cd packages/github-app
npx wrangler kv namespace create STATE     # put the id in wrangler.toml
npx wrangler secret put APP_ID
npx wrangler secret put APP_PRIVATE_KEY    # paste the .pem verbatim, newlines included
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_TOKEN        # optional; gates /admin/*
npx wrangler deploy
```

Point the App's webhook URL at `https://<worker>/webhooks/github` and use the
same value for `WEBHOOK_SECRET`.

Both PEM formats work. GitHub hands out PKCS#1 (`BEGIN RSA PRIVATE KEY`) while
Web Crypto only imports PKCS#8; the worker converts, so there is no `openssl`
step.

### Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Reports `ok`, or which secrets are missing |
| `POST /webhooks/github` | Signed webhook receiver |
| `GET /admin/repos` | The current index |
| `POST /admin/backfill?installation_id=N` | Re-index an installation |
| `POST /admin/alert?version=X&dry_run=1` | Preview or trigger a fan-out |

Admin routes need `Authorization: Bearer $ADMIN_TOKEN` and are disabled when that
secret is unset.

Always dry-run a fan-out first:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://<worker>/admin/alert?version=2026-08-26.dahlia&dry_run=1"
```

## Operational notes

- **Signatures are verified before parsing.** The raw body is checked against
  `X-Hub-Signature-256` with a constant-time compare; unverified JSON is never
  parsed.
- **Installation tokens are cached** in KV and refreshed a few minutes early, so
  a burst of webhooks does not mint one per request.
- **A fan-out records what it sent.** `lastAlertedVersion` per repo means a retry
  of the cron cannot double-notify.
- **A 404 on dispatch** almost always means the workflow file is missing from the
  repo's default branch. The alert result says so explicitly.
- **Webhooks that fail return 500** so GitHub retries them; the delivery log keeps
  the detail.
