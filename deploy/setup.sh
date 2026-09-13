#!/usr/bin/env bash
# First-time setup of an Ubuntu 24.04 box as the apiwatcher server.
#
#   DOMAIN=app.example.com sudo -E bash deploy/setup.sh
#
# Installs Node 22, git and Caddy; creates the service user and directories;
# clones and builds the repo; installs the systemd unit. It stops short of
# starting the service, because the secrets in /etc/apiwatcher/env are yours to
# fill in — it tells you exactly what to do next.
#
# Safe to re-run: every step checks before it acts.
set -euo pipefail

: "${DOMAIN:?Set DOMAIN to the hostname that points at this box, e.g. DOMAIN=app.example.com}"
REPO_URL="${REPO_URL:-https://github.com/madhawk1296/apiwatcher.git}"
APP_DIR=/opt/apiwatcher
DATA_DIR=/var/lib/apiwatcher
ENV_DIR=/etc/apiwatcher

if [ "$(id -u)" -ne 0 ]; then echo "run as root (sudo -E)"; exit 1; fi

echo "==> packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node --version), git $(git --version | cut -d' ' -f3)"

if ! command -v caddy >/dev/null; then
  echo "==> caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "==> user and directories"
id -u apiwatcher >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin apiwatcher
mkdir -p "$DATA_DIR" "$ENV_DIR"
chown apiwatcher:apiwatcher "$DATA_DIR"
chmod 750 "$ENV_DIR"

echo "==> code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only --quiet
else
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --silent
npm run build --workspace apiwatcher-cli --silent
npm run build --workspace @apiwatcher/server --silent
chown -R apiwatcher:apiwatcher "$APP_DIR"

echo "==> config"
if [ ! -f "$ENV_DIR/env" ]; then
  cp deploy/env.example "$ENV_DIR/env"
  chmod 600 "$ENV_DIR/env"
fi

echo "==> systemd + caddy"
cp deploy/apiwatcher.service /etc/systemd/system/apiwatcher.service
systemctl daemon-reload
systemctl enable apiwatcher >/dev/null
sed "s/app\.example\.com/$DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

cat <<EOF

Done. Two things left, both yours:

1. Secrets. Edit $ENV_DIR/env and set APP_ID, WEBHOOK_SECRET, ADMIN_TOKEN, then
   copy the App's private key to $ENV_DIR/app-private-key.pem:

     chmod 600 $ENV_DIR/app-private-key.pem && chown root:apiwatcher $ENV_DIR/app-private-key.pem $ENV_DIR/env && chmod 640 $ENV_DIR/app-private-key.pem $ENV_DIR/env

2. Start it:

     systemctl start apiwatcher && journalctl -u apiwatcher -f

Then point the GitHub App's webhook URL at https://$DOMAIN/webhooks/github
and check https://$DOMAIN/health.
EOF
