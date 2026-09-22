#!/usr/bin/env bash
# setup.sh — install the Thor BOT's dependencies (THIS repository only).
#
# Usage:  ./setup.sh        (run from the repo root, right after cloning)
#
# v4.1.0: THIS REPOSITORY IS THE BOT ONLY. The web dashboard is a SEPARATE
# repository — Thor-EN-Dashboard — with its own setup.sh:
#   https://github.com/dwisetyabudi15581/Thor-EN-Dashboard
# The two connect ONLY through the DASH API (HTTP + the shared
# DASH_API_TOKEN — see .env.example in both repositories).
set -euo pipefail
cd "$(dirname "$0")"

echo "==> [1/3] Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
  echo "!! Node.js is not installed. Install it first (needs >= 18):"
  echo "   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  echo "   sudo apt install -y nodejs"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "!! Your Node.js is v$(node -v) — the bot needs >= 18. Please upgrade."
  exit 1
fi
echo "    Node $(node -v) OK"

echo "==> [2/3] Installing BOT dependencies..."
npm install --no-audit --no-fund

echo "==> [3/3] Preparing .env..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    .env created from the example — DON'T FORGET to fill it in (DISCORD_TOKEN, DASH_API_TOKEN, ...)"
fi

echo
echo "Done! Next steps:"
echo "  1. Fill in .env      (bot token + DASH_API_TOKEN)"
echo "  2. npm start         (or ./start.sh)"
echo ""
echo "  Web dashboard? It is a SEPARATE repository now (v4.1.0):"
echo "    git clone https://github.com/dwisetyabudi15581/Thor-EN-Dashboard.git"
echo "    cd Thor-EN-Dashboard && ./setup.sh"
echo "    (its .env needs the SAME DASH_API_TOKEN as this repo's .env)"
echo ""
echo "See DEPLOY.md for the full production guide (VPS + pm2 + domain + HTTPS)."
