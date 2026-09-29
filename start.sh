#!/usr/bin/env bash
# Starts the Kitchen QR app (API + web UI) on http://localhost:3000
# The web UI is the prebuilt Angular app in client/dist/ (committed, so no
# install is needed to run it). Rebuild it with `npm run build` inside client/.
set -e
cd "$(dirname "$0")/server"
if [ ! -f .env ]; then
  echo "No server/.env found — running seed first..."
  npm run seed
fi
npm start
