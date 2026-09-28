#!/usr/bin/env bash
# Starts the Kitchen QR app (API + web UI) on http://localhost:3000
set -e
cd "$(dirname "$0")/server"
if [ ! -f .env ]; then
  echo "No server/.env found — running seed first..."
  npm run seed
fi
if [ ! -d ../client/dist ]; then
  echo "Client not built — building..."
  (cd ../client && npm run build)
fi
npm start
