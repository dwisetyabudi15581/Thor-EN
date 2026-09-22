#!/usr/bin/env bash
# start.sh — run the Thor Discord bot (production mode).
#
# Usage:  ./start.sh
#
# - Ctrl+C stops the bot.
# - For a 24/7 production server, prefer pm2 (more reliable + auto-restart):
#     pm2 start ecosystem.config.cjs && pm2 save
#   See DEPLOY.md.
#
# v4.1.0: this repository is the BOT ONLY — the web dashboard runs from its
# own repository (Thor-EN-Dashboard) and is started there separately.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "!! .env not found — run ./setup.sh first (or: cp .env.example .env)."
  exit 1
fi

exec npm start
