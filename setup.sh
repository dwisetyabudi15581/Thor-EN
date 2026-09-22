#!/usr/bin/env bash
# setup.sh — install ALL Thor dependencies (bot + web dashboard) in one run.
#
# Usage:  ./setup.sh        (run from the repo root, right after cloning)
#
# What it does:
#   1. Checks Node.js (needs >= 20; the bot runs on 18+, the dashboard needs 20+)
#   2. npm install for the BOT (bot/ folder — its own package.json)
#   3. npm install + prisma generate for the DASHBOARD (dashboard/ folder)
#   4. Creates bot/.env and dashboard/.env from the example files if missing
#
# v4.0.0: the two modules are fully independent (separation of concerns) —
# each folder has its own package.json and can be lifted into its own repo
# as-is. They are connected ONLY by the DASH API (HTTP + shared token).
set -euo pipefail
cd "$(dirname "$0")"

echo "==> [1/4] Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
  echo "!! Node.js is not installed. Install it first (needs >= 20):"
  echo "   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  echo "   sudo apt install -y nodejs"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "!! Your Node.js is v$(node -v) — the web dashboard needs >= 20. Please upgrade."
  exit 1
fi
echo "    Node $(node -v) OK"

echo "==> [2/4] Installing BOT dependencies (bot/)..."
(cd bot && npm install --no-audit --no-fund)

echo "==> [3/4] Installing WEB DASHBOARD dependencies (dashboard/)..."
(cd dashboard && npm install --no-audit --no-fund && npx prisma generate)

echo "==> [4/4] Preparing .env files..."
if [ ! -f bot/.env ]; then
  cp bot/.env.example bot/.env
  echo "    bot/.env created from the example — DON'T FORGET to fill it in (DISCORD_TOKEN, DASH_API_TOKEN, ...)"
fi
if [ ! -f dashboard/.env ]; then
  cp dashboard/.env.example dashboard/.env
  echo "    dashboard/.env created from the example — fill in DISCORD_CLIENT_ID/SECRET"
  echo "    + DASH_API_TOKEN (MUST be exactly the same as in bot/.env)"
fi

echo
echo "Done! Next steps:"
echo "  1. Fill in bot/.env          (bot token + DASH_API_TOKEN)"
echo "  2. Fill in dashboard/.env    (Discord OAuth + the same DASH_API_TOKEN)"
echo "  3. ./start.sh                (production: bot + dashboard in one run)"
echo "     ./dev.sh                  (development: nodemon + next dev)"
echo ""
echo "Each module also runs standalone:"
echo "  cd bot && npm start          (Discord bot only)"
echo "  cd dashboard && npm start    (web dashboard only)"
echo ""
echo "See DEPLOY.md for the full guide (VPS + domain + HTTPS + pm2)."
