#!/usr/bin/env bash
# deploy.sh — Build and deploy octopus-influx-sync to the Pi via SSH
#
# Usage:
#   ./deploy.sh
#
# Prerequisites:
#   - SSH key-based auth set up for pi@homebridge.local
#   - Docker installed on the Pi
#   - .env file created at ~/octopus-influx-sync/.env on the Pi
#     (copy .env.example and fill in real values)
#
# This script:
#   1. Rsyncs source files to the Pi (excluding secrets and node_modules)
#   2. Builds the Docker image directly on the Pi (arm64 native — no cross-compile)
#   3. Restarts the container with docker compose

set -euo pipefail

REMOTE="pi@homebridge.local"
REMOTE_DIR="~/octopus-influx-sync"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Deploying octopus-influx-sync → Pi"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Ensure remote directory exists ────────────────────────────────────────
echo "→ Preparing remote directory..."
ssh "$REMOTE" "mkdir -p $REMOTE_DIR"

# ── 2. Sync source files (never sync .env or node_modules) ───────────────────
echo "→ Syncing files..."
rsync -avz --progress \
  --exclude '.env' \
  --exclude 'node_modules/' \
  --exclude '.git/' \
  --exclude '*.log' \
  . "$REMOTE:$REMOTE_DIR/"

# ── 3. Check .env exists on Pi ───────────────────────────────────────────────
echo "→ Checking .env on Pi..."
if ! ssh "$REMOTE" "test -f $REMOTE_DIR/.env"; then
  echo ""
  echo "⚠️  No .env file found at $REMOTE_DIR/.env on the Pi."
  echo "   Copy .env.example to $REMOTE_DIR/.env and fill in your credentials:"
  echo ""
  echo "   ssh $REMOTE"
  echo "   cp $REMOTE_DIR/.env.example $REMOTE_DIR/.env"
  echo "   nano $REMOTE_DIR/.env"
  echo ""
  exit 1
fi

# ── 4. Build and restart on the Pi ───────────────────────────────────────────
echo "→ Building and restarting container on Pi..."
ssh "$REMOTE" "
  set -e
  cd $REMOTE_DIR
  docker compose down --remove-orphans 2>/dev/null || true
  docker compose build --no-cache
  docker compose up -d
  echo ''
  echo 'Container status:'
  docker compose ps
  echo ''
  echo 'Last 30 log lines:'
  docker compose logs --tail=30
"

echo ""
echo "✓ Deployment complete!"
echo ""
echo "To follow live logs:"
echo "  ssh $REMOTE 'docker compose -f $REMOTE_DIR/docker-compose.yml logs -f'"
