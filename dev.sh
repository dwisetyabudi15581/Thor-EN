#!/usr/bin/env bash
# dev.sh — DEVELOPMENT mode: the bot with nodemon (auto-restart on changes).
#
# Usage:  ./dev.sh
#
# v4.1.0: this repository is the BOT ONLY. The dashboard dev server
# (next dev) runs from its own repository:
#   cd Thor-EN-Dashboard && npm run dev
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "!! .env not found — run ./setup.sh first."; exit 1; }

exec npm run dev
