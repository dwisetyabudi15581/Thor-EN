#!/usr/bin/env bash
# dev.sh — DEVELOPMENT mode: bot (nodemon, auto-restart on code changes)
# + web dashboard (next dev, hot-reload) running together.
#
# Usage:  ./dev.sh
#
# v4.0.0: bot code lives in bot/, the dashboard in dashboard/ — this script
# only orchestrates the two. Each module can also be developed standalone:
#   cd bot && npm run dev          # bot only
#   cd dashboard && npm run dev    # dashboard only
set -euo pipefail
cd "$(dirname "$0")"

[ -f bot/.env ] || { echo "!! bot/.env not found — run ./setup.sh first."; exit 1; }
[ -f dashboard/.env ] || cp dashboard/.env.example dashboard/.env

pids=()
cleanup() {
  echo
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup EXIT INT TERM

echo "==> Dashboard dev (next dev) at http://localhost:3000..."
(cd dashboard && npm run dev) & pids+=("$!")

echo "==> Bot dev (nodemon, bot/)..."
(cd bot && npm run dev) & pids+=("$!")

echo
echo "Development mode running — press Ctrl+C to stop."
echo "Tip: without the bot running, the dashboard shows a 'Bot offline' banner."
echo "     For UI with demo data: (cd dashboard && npm run mock) in another terminal."
wait -n
