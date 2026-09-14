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

# The web build wants ~2 GB; a swapfile keeps a small box from OOM-killing it.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
# git pull and npm ci ran as root; hand the tree to the service user *before*
# building the web app as that user, or .next cannot be created.
chown -R apiwatcher:apiwatcher "$APP_DIR"
sudo -u apiwatcher -H env AUTH_SECRET=build AUTH_GITHUB_ID=build AUTH_GITHUB_SECRET=build \
  npm run build --workspace @apiwatcher/web --silent

systemctl restart apiwatcher
[ -f /etc/systemd/system/apiwatcher-web.service ] && systemctl restart apiwatcher-web
sleep 2
echo "$before -> $after; apiwatcher is $(systemctl is-active apiwatcher); web is $(systemctl is-active apiwatcher-web 2>/dev/null || echo not-installed)"
journalctl -u apiwatcher -n 3 --no-pager
journalctl -u apiwatcher-web -n 3 --no-pager 2>/dev/null || true
