#!/bin/bash
# Starts the Kitchen QR app inside a GitHub Codespace with a public URL.
set -e
cd /workspaces/kitchen-qr-app/server
export PUBLIC_BASE_URL="https://${CODESPACE_NAME}-3000.app.github.dev"
export PORT=3000
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
fi
if [ ! -f .env ]; then
  npm run seed
fi
# Make sure a stale server isn't already running
pkill -f "tsx src/server.ts" 2>/dev/null || true
nohup npm start > /tmp/kitchen-app.log 2>&1 &
echo "[codespace] app starting at ${PUBLIC_BASE_URL} (log: /tmp/kitchen-app.log)"
