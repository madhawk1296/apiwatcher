#!/usr/bin/env bash
# Redeploy: pull main, rebuild, restart. Run as root on the box.
#
#   sudo bash /opt/apiwatcher/deploy/update.sh
#
# The restart waits for in-flight scans to finish (the unit allows 90s), so a
# redeploy during a fan-out loses nothing that is not recoverable anyway.
set -euo pipefail

APP_DIR=/opt/apiwatcher
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

# The checkout is owned by the service user; tell root's git that is expected.
git config --global --add safe.directory "$APP_DIR" >/dev/null 2>&1 || true

cd "$APP_DIR"
before=$(git rev-parse --short HEAD)
git pull -q --ff-only
after=$(git rev-parse --short HEAD)

npm ci --silent
npm run build --workspace apiwatcher-cli --silent
npm run build --workspace @apiwatcher/server --silent
chown -R apiwatcher:apiwatcher "$APP_DIR"

systemctl restart apiwatcher
sleep 2
echo "$before -> $after; apiwatcher is $(systemctl is-active apiwatcher)"
journalctl -u apiwatcher -n 5 --no-pager
