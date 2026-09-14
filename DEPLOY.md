# 🚀 Deployment Guide — Thor Bot (v3.17.0)

A 100% free Discord bot, single-server or public mode (Dyno-style) + the
DASH API for the web dashboard. The complete guide for bot + dashboard +
domain + HTTPS lives in the dashboard repo:
**[thor-dashboard/DEPLOY.md](https://github.com/dwisetyabudi15581/thor-dashboard)**.

This document focuses on deploying **the bot alone** (without the dashboard).

---

## 1. Prerequisites

| Requirement | Minimum | Notes |
| --- | --- | --- |
| VPS / Node.js hosting | 1 vCPU · 1 GB RAM · 10 GB disk | Node.js **18+** (20/22 recommended). Local Indonesian VPS ±Rp 50–100k/mo; international (Hetzner/Vultr/DO) ±$4–6/mo |
| Discord bot token | — | https://discord.com/developers/applications → your app → **Bot** → Reset Token |
| 2 Privileged Intents | — | **Bot** tab → enable **SERVER MEMBERS INTENT** + **MESSAGE CONTENT INTENT** (without these, login fails / features break) |

> The bot can also run without a VPS on Node.js hosting (Railway, Render,
> free Pterodactyl) — what matters is that the process **runs 24/7**, not
> serverless/functions (data is stored in the `data/` files).

## 2. Install on a VPS

```bash
# SSH into the VPS as a regular user (not root)
sudo apt update && sudo apt install -y nodejs npm git   # or NodeSource for Node 20/22
node -v   # must be >= 18

git clone https://github.com/dwisetyabudi15581/Thor-EN.git
cd Thor-EN
npm install
cp .env.example .env
nano .env
```

### Fill in `.env`

```ini
DISCORD_TOKEN=bot_token_from_the_developer_portal

# SERVER MODE — the single variable that decides the behavior:
#  FILLED  = single-server mode: instant commands, events from other
#            servers are ignored
#  EMPTY   = PUBLIC Dyno-style mode: global commands, they appear
#            automatically in every server that invites the bot
#            (~1 hour propagation)
GUILD_ID=

# DASH API (REQUIRED only if the web dashboard is used; without it the
# internal API server does not run — the bot still works fine via slash
# commands):
DASH_API_HOST=127.0.0.1
DASH_API_PORT=8788
DASH_API_TOKEN=result-of-openssl-rand-hex-32
```

Generate a random token: `openssl rand -hex 32`.

## 3. Test first, then run 24/7 (pm2)

```bash
npm test          # all 639 unit tests must pass
npm start         # manual check: the bot comes online, /help works

# then use pm2 (auto-restart + start on boot)
sudo npm install -g pm2
pm2 start index.js --name thor-bot
pm2 save
pm2 startup        # run the command it prints once
```

Logs: `pm2 logs thor-bot`. Restart: `pm2 restart thor-bot`.

## 4. Invite the bot to a server

Use this URL (least-privilege permissions, change `CLIENT_ID` if needed):

```
https://discord.com/oauth2/authorize?client_id=1548297613969985546&permissions=1099800112150&scope=bot+applications.commands
```

Once the bot is in:
1. The bot's role must be **above** every role it manages (drag it in Server Settings → Roles)
2. `/set-role admin @role` → set the bot admin role
3. `/setup-verify` → the verification panel
4. `/setup-ticket` → the ticket panel
5. `/config-show` → review all settings

The complete admin guide: **[docs/ADMIN_GUIDE.md](./docs/ADMIN_GUIDE.md)**.

## 5. Public bot (Dyno-style) — checklist

- [ ] `GUILD_ID=` **empty** in `.env`
- [ ] Both Privileged Intents enabled
- [ ] Global commands appear ~1 hour after restart (normal, Discord propagation)
- [ ] `data/config/<guildId>.json` is separated per server automatically — server A's admins can never overwrite server B
- [ ] Discord requires bot verification after **100 servers** (form + owner info in the Developer Portal)

## 6. Backup & update

```bash
# all important data lives in the data/ folder — an rsync is enough:
rsync -av user@vps:Thor-EN/data/ ./backup-thor-data/

# update to a new version:
cd Thor-EN && git pull && npm install && npm test && pm2 restart thor-bot
```

The internal automatic backup (max 7 snapshots, every 24 hours + on start)
keeps running on its own via `/backup-now` — the `data/` folder is the
source of truth.
