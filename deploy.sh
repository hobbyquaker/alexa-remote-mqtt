#!/usr/bin/env bash
set -euo pipefail

# Pack and deploy alexa-remote-mqtt to a remote host.
# Default target host is: mqtt-ifaces (user taken from ~/.ssh/config)
#
# Usage:
#   bash deploy.sh
#   bash deploy.sh myuser@myhost
#
# Optional env vars:
#   REMOTE_DIR   (default: /usr/local/lib/node_modules/alexa-remote-mqtt)
#   REMOTE_TMP   (default: /tmp)
#   SERVICE      (default: alexa-remote-mqtt)  systemd unit to restart, if it exists
#   SSH_KEY      (default: ~/.ssh/id_ed25519)  key loaded via keychain, if installed
#   REMOTE_NODE_DIR  Node.js installation to use on the remote host (e.g. /opt/node22),
#                    for hosts whose system Node is too old. Default: system node/npm.
#                    alexa-remote-mqtt needs Node >= 20.

REMOTE_HOST="${1:-mqtt-ifaces}"
REMOTE_DIR="${REMOTE_DIR:-/usr/local/lib/node_modules/alexa-remote-mqtt}"
REMOTE_TMP="${REMOTE_TMP:-/tmp}"
SERVICE="${SERVICE:-alexa-remote-mqtt}"
REMOTE_NODE_DIR="${REMOTE_NODE_DIR:-}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command '$1' not found." >&2
    exit 1
  fi
}

require_cmd npm
require_cmd scp
require_cmd ssh
require_cmd tar

load_ssh_key() {
  if command -v keychain >/dev/null 2>&1 && [[ -f "$SSH_KEY" ]]; then
    keychain -q --nogui "$SSH_KEY"
    # shellcheck disable=SC1090
    source "$HOME/.keychain/$(hostname)-sh"
  fi
}

cd "$(dirname "$0")"

echo "Running tests..."
npm test --silent

echo "Packing npm module..."
TGZ_FILE="$(npm pack --silent | tail -n 1)"

if [[ ! -f "$TGZ_FILE" ]]; then
  echo "Error: npm pack did not produce a tarball." >&2
  exit 1
fi

echo "Created tarball: $TGZ_FILE"

load_ssh_key

echo "Copying tarball to ${REMOTE_HOST}:${REMOTE_TMP}/..."
scp "$TGZ_FILE" "${REMOTE_HOST}:${REMOTE_TMP}/"

REMOTE_TGZ="${REMOTE_TMP}/$(basename "$TGZ_FILE")"

echo "Deploying on remote host..."
ssh "$REMOTE_HOST" "REMOTE_TGZ='$REMOTE_TGZ' REMOTE_DIR='$REMOTE_DIR' SERVICE='$SERVICE' REMOTE_NODE_DIR='$REMOTE_NODE_DIR' bash -s" <<'EOF'
set -euo pipefail

if [[ ! -f "$REMOTE_TGZ" ]]; then
  echo "Error: remote tarball not found: $REMOTE_TGZ" >&2
  exit 1
fi

if [[ -n "$REMOTE_NODE_DIR" ]]; then
  NODE_BIN="$REMOTE_NODE_DIR/bin/node"
  NPM_BIN="$REMOTE_NODE_DIR/bin/npm"
  [[ -x "$NODE_BIN" ]] || { echo "Error: $NODE_BIN not found on remote host" >&2; exit 1; }
else
  NODE_BIN="$(command -v node)"
  NPM_BIN="$(command -v npm)"
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  echo "Error: $NODE_BIN is Node $("$NODE_BIN" --version); alexa-remote-mqtt needs Node >= 20." >&2
  echo "       Install a newer Node (e.g. into /opt/node22) and pass REMOTE_NODE_DIR=/opt/node22." >&2
  exit 1
fi
echo "Using $NODE_BIN ($("$NODE_BIN" --version))"

sudo mkdir -p "$REMOTE_DIR"
sudo find "$REMOTE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
sudo tar -xzf "$REMOTE_TGZ" -C "$REMOTE_DIR" --strip-components=1
sudo env PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" install --omit=dev --no-audit --no-fund --prefix "$REMOTE_DIR"
sudo chmod +x "$REMOTE_DIR/bin/alexa-remote-mqtt.js"
# Wrapper instead of a symlink so the correct Node binary is used regardless of PATH.
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_BIN" "$REMOTE_DIR/bin/alexa-remote-mqtt.js" | sudo tee /usr/local/bin/alexa-remote-mqtt >/dev/null
sudo chmod +x /usr/local/bin/alexa-remote-mqtt
sudo rm -f "$REMOTE_TGZ"

if systemctl list-unit-files --type=service 2>/dev/null | grep -q "^${SERVICE}\.service"; then
  echo "Restarting ${SERVICE}.service..."
  sudo systemctl restart "$SERVICE"
  sleep 2
  sudo systemctl --no-pager --lines=5 status "$SERVICE" || true
else
  echo "Note: no systemd unit '${SERVICE}.service' found - not restarting anything."
  echo "      Install one with: sudo alexa-remote-mqtt --install --mqtt-url mqtt://broker ..."
fi
EOF

echo "Cleaning up local tarball..."
rm -f "$TGZ_FILE"

echo "Deployment complete."
