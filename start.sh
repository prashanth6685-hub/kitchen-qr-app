#!/usr/bin/env bash
# Starts the Kitchen QR app (API + web UI) on http://localhost:3000
# The web UI needs no build step — it is plain HTML/CSS/JS served as-is.
set -e
cd "$(dirname "$0")/server"
if [ ! -f .env ]; then
  echo "No server/.env found — running seed first..."
  npm run seed
fi
npm start
