#!/usr/bin/env bash
# start.sh — run the bot + web dashboard TOGETHER (production mode).
#
# Usage:  ./start.sh
#
# - The dashboard is built first if needed (once, ~1 minute).
# - Ctrl+C stops both at the same time.
# - For a 24/7 production server, prefer pm2 (more reliable + auto-restart):
#     pm2 start ecosystem.config.cjs && pm2 save
#   See DEPLOY.md.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f dashboard/.next/standalone/server.js ]; then
  echo "==> Building the dashboard (once)..."
  (cd dashboard && npm run build)
fi

pids=()
cleanup() {
  echo
  echo "Stopping the bot + dashboard..."
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup EXIT INT TERM

echo "==> Starting the Thor bot..."
node index.js & pids+=("$!")

echo "==> Starting the web dashboard (http://localhost:3000)..."
(cd dashboard && npm run start) & pids+=("$!")

echo
echo "Thor is running: Discord bot + dashboard at http://localhost:3000"
echo "Press Ctrl+C to stop both."
wait -n
