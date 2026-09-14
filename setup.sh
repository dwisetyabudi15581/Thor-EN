#!/usr/bin/env bash
# setup.sh — install ALL Thor dependencies (bot + web dashboard) in one run.
#
# Usage:  ./setup.sh        (run from the repo root, right after cloning)
#
# What it does:
#   1. Checks Node.js (needs >= 20; the bot runs on 18+, the dashboard needs 20+)
#   2. npm install for the bot (repo root)
#   3. npm install + prisma generate for the dashboard (dashboard/ folder)
#   4. Creates .env (bot) and dashboard/.env (web) from the example files if missing
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

echo "==> [2/4] Installing bot dependencies..."
npm install --no-audit --no-fund

echo "==> [3/4] Installing web dashboard dependencies..."
(cd dashboard && npm install --no-audit --no-fund && npx prisma generate)

echo "==> [4/4] Preparing .env files..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    .env created from the example — DON'T FORGET to fill it in (DISCORD_TOKEN, DASH_API_TOKEN, ...)"
fi
if [ ! -f dashboard/.env ]; then
  cp dashboard/.env.example dashboard/.env
  echo "    dashboard/.env created from the example — fill in DISCORD_CLIENT_ID/SECRET"
  echo "    + DASH_API_TOKEN (MUST be exactly the same as in the bot's .env)"
fi

echo
echo "Done! Next steps:"
echo "  1. Fill in .env            (bot token + DASH_API_TOKEN)"
echo "  2. Fill in dashboard/.env  (Discord OAuth + the same DASH_API_TOKEN)"
echo "  3. ./start.sh              (production: bot + dashboard in one run)"
echo "     ./dev.sh                (development: nodemon + next dev)"
echo ""
echo "See DEPLOY.md for the full guide (VPS + domain + HTTPS + pm2)."
