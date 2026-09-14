# The server

One Node process on one box. It receives the GitHub App's webhooks, keeps the
index of which repos use Stripe, clones and scans them, and posts the results.
There is no other backend.

## What it does

```
GitHub webhook ──▶ index (SQLite) ──▶ scan queue ──▶ clone → scan → post → delete clone
                                          ▲
spec watcher (cron in this repo) ──▶ poller: new version? ──▶ fan out to repos that are behind
```

**On install**, every repo the installation covers is indexed by reading its
`package.json` (and, for monorepos, the workspace packages' manifests) plus
`.apiwatcher.json` over the API — no clone — and every tracked one gets a first
scan, so a new install sees a result within a minute.

**On push to the default branch**, if the commit touched TypeScript/JavaScript,
a manifest, or the config, the commit is scanned. A check run appears on it and
the repo's tracking issue is updated or closed. Pushes that only touch docs are
ignored before any clone happens.

**On pull request** open/update, the head commit is scanned and a check run is
posted. The PR's file list is read first so a docs-only PR costs one API call
and no clone.

**On a new Stripe version**, the poller notices the spec watcher's new changeset
and queues one scan per tracked repo that is behind and has alerts on. Repos
already on the new version — known from their last scan — are skipped.

Every scan is the same operation: shallow-clone the exact commit, run the same
`scanRepo()` the CLI uses, build the report, post it, delete the clone. Customer
code is on disk for the seconds the scan takes and nowhere else.

## Results

| Trigger | Check run on the commit | Tracking issue |
| --- | --- | --- |
| push to default branch | yes | updated, or closed if clean |
| pull request | yes | no |
| new Stripe version | no | updated, or closed if clean |
| install / backfill | no | updated, or closed if clean |

A check **fails** only when the repo's `failOn` threshold is met (default:
breaking). Deprecations alone produce `neutral`. If the scan itself could not run
— clone failed, no changesets — the check is `neutral` with the reason; our
failure never blocks someone's PR.

One issue per repo, labelled `apiwatcher`, edited in place. It closes itself when
a scan finds nothing affected.

## Repo config

`.apiwatcher.json` at the customer's repo root, all optional:

```json
{
  "target": "latest",
  "alerts": true,
  "scanOnPush": true,
  "ignorePaths": ["src/generated"],
  "ignoreChanges": ["stripe-2026-08-26.dahlia-0042"],
  "failOn": "breaking",
  "minConfidence": 0.4
}
```

`scanOnPush: false` keeps version alerts and drops the per-push and per-PR
checks, for teams who find a red check on every PR to be nagging.

## Running it

See [`deploy/`](../deploy). On a fresh Ubuntu 24.04 box:

```bash
DOMAIN=app.example.com sudo -E bash deploy/setup.sh
```

That installs Node 22, git and Caddy, creates the `apiwatcher` user, clones and
builds, and installs the systemd unit. It stops before starting the service and
tells you which secrets to put in `/etc/apiwatcher/env`. Then:

```bash
sudo systemctl start apiwatcher && journalctl -u apiwatcher -f
```

Point the GitHub App's webhook at `https://app.example.com/webhooks/github` and
check `/health`.

To redeploy after a change lands on `main`:

```bash
sudo bash /opt/apiwatcher/deploy/update.sh
```

### Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `APP_ID` | yes | | GitHub App ID |
| `APP_PRIVATE_KEY_FILE` | yes* | | Path to the App's `.pem` (`APP_PRIVATE_KEY` inline also works) |
| `WEBHOOK_SECRET` | yes | | Same value as on the App |
| `ADMIN_TOKEN` | no | unset | Enables `/admin/*`; `openssl rand -hex 32` |
| `PORT` | no | 8787 | |
| `HOST` | no | `127.0.0.1` | Bind address; only Caddy on localhost should reach it |
| `DATA_DIR` | no | `./data` | SQLite, clones, synced changesets |
| `SCAN_CONCURRENCY` | no | 2 | Parallel scans |
| `POLL_INTERVAL_MINUTES` | no | 60 | How often to check for a new Stripe version |
| `REPORT_RETENTION_DAYS` | no | 30 | Stored report bodies older than this are dropped |
| `APP_SLUG` | no | `apiwatcher-app` | For links in issues |
| `CHANGESET_INDEX_URL` | no | this repo's `index.json` | Where changesets are published |

### GitHub App permissions

| Permission | Level |
| --- | --- |
| Contents | Read |
| Issues | Read and write |
| Checks | Read and write |
| Pull requests | Read |
| Metadata | Read (automatic) |

Events: **Push**, **Pull request**, **Repository** (installation events are
always delivered).

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Status, repo count, queue depth, newest changeset |
| `POST /webhooks/github` | Signed webhook receiver |
| `GET /admin/repos` | The index |
| `GET /admin/scans?limit=50` | Recent scans (summaries) |
| `GET /admin/scans/:id` | One scan with its full report |
| `POST /admin/scan?repo=owner/name[&sha=…][&post=1]` | Scan a repo now. `post=1` also posts the check/issue |
| `POST /admin/backfill?repo=owner/name` (or `installation_id=N`) | Re-index the installation covering that repo |
| `POST /admin/alert?version=X[&dry_run=1]` | Preview or run a version fan-out |
| `POST /admin/sync` | Fetch new changesets now |

Admin routes need `Authorization: Bearer $ADMIN_TOKEN`.

The first thing to run after deploying is a manual scan of a real repo the App is
installed on:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://app.example.com/admin/scan?repo=owner/name"
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://app.example.com/admin/scans
```

## Operating notes

- **Logs are the observability.** `journalctl -u apiwatcher -f` shows one line
  per webhook with what was concluded, and one per scan with counts and timing.
- **Restarts lose queued scans, and that is fine.** Every trigger is recoverable:
  the next push re-triggers, and the poller re-fans-out anything not yet marked
  as alerted. Nothing is lost that cannot be regenerated.
- **`lastAlertedVersion` is set on enqueue**, so a crash mid-fan-out cannot
  double-notify when it comes back.
- **First boot records a baseline** version without alerting, so a fresh server
  does not tell every repo about a version that is not news.
- **Tokens never touch the command line.** The installation token reaches `git`
  through an environment-variable config, the same way `actions/checkout` does,
  so it is not in `ps` or in error output.
- **The systemd unit is sandboxed.** The process can write to `DATA_DIR` and
  reach the network; the rest of the filesystem is read-only to it.
- **Disk is the thing to watch.** Clones are deleted on completion, including on
  failure, and abandoned ones are cleared at boot. Stored reports are pruned by
  age. If disk grows, something is wrong.
