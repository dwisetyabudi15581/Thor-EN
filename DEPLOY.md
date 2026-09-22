# 🚀 Deployment Guide — Thor Bot (this repo) + Thor-EN-Dashboard (production)

Since **v4.1.0** the system lives in **two separate repositories**:

| Repository                                                          | Contains                                                                                      | Runs as                     |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------- |
| **Thor-EN** (this repo)                                             | the Discord bot — commands, events, `data/` JSON persistence, the DASH API server (:8788)     | `node index.js` / pm2 `thor-bot` |
| [Thor-EN-Dashboard](https://github.com/dwisetyabudi15581/Thor-EN-Dashboard) | the web dashboard — Next.js, Discord OAuth2 login, dashboard users (`DATABASE_URL`, SQLite) | `npm run start` / pm2 `thor-dash` |

They are connected **only** through the DASH API (HTTP + the shared
`DASH_API_TOKEN`). Each repository installs, updates, and restarts on its
own — a dashboard rebuild can never interrupt Discord events.

> Moving up from a **Termux test setup** or an older layout (v3.x / v4.0.x)?
> See [Migrating to the v4.1.0 layout](#-migrating-to-the-v410-layout-termux--old-clone)
> — it is a 5-minute data move.

Target production architecture (everything on **one VPS**):

```
                        Internet
                           │
                    domain.com :443
                    (Caddy — automatic HTTPS)
                           │
                    Next.js Dashboard :3000
                    (~/Thor-EN-Dashboard, Discord OAuth2 login)
                           │  http://127.0.0.1:8788 (DASH_API_TOKEN)
                           ▼
                    Thor bot (~/Thor-EN — node index.js)
                    └─ DASH API :8788 (localhost only)
                    └─ data/config/<guildId>.json  ← ONE data source
```

- **The bot and the web write configuration to the same data** through the
  DASH API — Discord slash commands and the web dashboard never conflict.
- The two processes are **independent**: restarting the dashboard never
  touches the bot.
- The dashboard can run **without the bot** (a "Bot offline" banner appears)
  — but to save changes, the bot must be running.

---

## 0. What you need

| Requirement                            | Example                               | Cost         |
| -------------------------------------- | ------------------------------------- | ------------ |
| VPS 1 vCPU / 1 GB / Node.js 20+        | Hetzner/Vultr/DO or a local provider  | ~$5 / month  |
| Domain                                 | `thor.yourdomain.com`                 | ~$10–15/year |
| Discord application (already have one) | Client ID + Client Secret + bot token | free         |

## 1. VPS setup (once)

```bash
ssh root@YOUR_VPS_IP

# daily user (don't run as root)
adduser thor && usermod -aG sudo thor
su - thor

# Node.js 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
sudo npm install -g pm2

# firewall — ports 3000 & 8788 do NOT need to be open (localhost only)
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443
sudo ufw enable
```

## 2. Clone + install (BOTH repositories)

```bash
cd ~

# the Discord bot (this repository)
git clone https://github.com/dwisetyabudi15581/Thor-EN.git
cd Thor-EN && ./setup.sh && cd ..

# the web dashboard (separate repository)
git clone https://github.com/dwisetyabudi15581/Thor-EN-Dashboard.git
cd Thor-EN-Dashboard && ./setup.sh && cd ..
```

`./setup.sh` in each repo is equivalent to running by hand:

```bash
(cd ~/Thor-EN          && npm install)                       # bot
(cd ~/Thor-EN-Dashboard && npm install && npx prisma generate)  # dashboard
```

## 3. Fill in BOTH .env files (one per repository)

Generate two random secrets — one shared bridge token, one session key:

```bash
openssl rand -hex 32   # → DASH_API_TOKEN (used in BOTH files)
openssl rand -hex 32   # → SESSION_SECRET (dashboard only)
```

**`~/Thor-EN/.env` (the bot — this repository):**

```ini
DISCORD_TOKEN=bot_token_from_the_developer_portal
GUILD_ID=                          # EMPTY = public mode

DASH_API_HOST=127.0.0.1
DASH_API_PORT=8788
DASH_API_TOKEN=THE-FIRST-RANDOM-HEX-32-RESULT
```

**`~/Thor-EN-Dashboard/.env` (the web — dashboard repository):**

```ini
DATABASE_URL=file:db/custom.db
SESSION_SECRET=THE-SECOND-RANDOM-HEX-32-RESULT   # a DIFFERENT secret
DEMO_MODE=false
DISCORD_CLIENT_ID=1548297613969985546
DISCORD_CLIENT_SECRET=client_secret_from_the_portal
PUBLIC_ORIGIN=https://thor.yourdomain.com
ADMIN_DISCORD_IDS=1290700587373039619

DASH_API_URL=http://127.0.0.1:8788
DASH_API_TOKEN=THE-FIRST-RANDOM-HEX-32-RESULT    # EXACTLY the same as ~/Thor-EN/.env
```

> ⚠️ The most common mistake: `DASH_API_TOKEN` differing between the two .env
> files → the dashboard shows "Bot offline" and saves have no effect. Make
> them match, then restart both services.

## 4. Test first, then run 24/7

```bash
(cd ~/Thor-EN && npm test)     # all 897 bot unit tests must pass

# quick check (both alive):
(cd ~/Thor-EN-Dashboard && npm run build && npm run start)   # terminal 1
(cd ~/Thor-EN && npm start)                                  # terminal 2
# → Ctrl+C both when done

# 24/7 production via pm2 (two independent services, one per repo):
(cd ~/Thor-EN           && pm2 start ecosystem.config.cjs)
(cd ~/Thor-EN-Dashboard && pm2 start ecosystem.config.cjs)
pm2 save && pm2 startup
pm2 logs thor-bot           # expect: bot online + DASH API listening on :8788
```

## 5. Domain + HTTPS (Caddy)

```bash
# Domain A record: thor.yourdomain.com → YOUR_VPS_IP
sudo apt install -y caddy
sudo nano /etc/caddy/Caddyfile
```

Contents (replace the domain):

```
thor.yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
# Caddy handles the HTTPS certificate (Let's Encrypt) automatically — wait ~30 seconds
```

## 6. Discord Developer Portal (important!)

1. https://discord.com/developers/applications → your bot application
2. **Bot** → _Privileged Gateway Intents_ → enable:
    - ✅ SERVER MEMBERS INTENT
    - ✅ MESSAGE CONTENT INTENT
3. **OAuth2** → _Redirects_ → add:
    ```
    https://thor.yourdomain.com/api/auth/discord/callback
    ```
    (built from `PUBLIC_ORIGIN`; the dashboard also shows this exact URI in the landing footer — copy it from there)
4. Save.

## 7. End-to-end verification (5 minutes)

1. Open `https://thor.yourdomain.com` → the landing page appears
2. **Login with Discord** → authorize → the server list opens (with Admin/Staff/Member badges)
3. Pick a server where the bot has been invited → the dashboard opens (live status header: ● Online, ping, guild count)
4. Flip a **Quick Toggle** on the Overview (e.g. Auto-Mod) → it must apply within the second; verify in Discord
5. Change one setting (e.g. the **General** module → Save) → check in Discord with `/config-show` → the values must match (proof that slash commands and the web share one source)
6. `pm2 logs thor-bot` → DASH API requests are logged

## 8. Daily operations

```bash
pm2 status                 # thor-bot + thor-dash must be online
pm2 logs thor-bot          # bot logs
pm2 logs thor-dash         # dashboard logs
pm2 restart all            # restart both (or pm2 restart thor-bot for the bot only)

# update to a new version (each repo independently):
cd ~/Thor-EN && git pull && npm install && npm test && pm2 restart thor-bot
cd ~/Thor-EN-Dashboard && git pull && npm install && npm run build && pm2 restart thor-dash

# back up ALL bot data (this repo): the data/ folder (configs, tickets, warns, …)
rsync -av thor@YOUR_VPS_IP:~/Thor-EN/data/ ./backup-thor-data/
# back up the dashboard (login users): the dashboard repo's db/custom.db file
rsync -av thor@YOUR_VPS_IP:~/Thor-EN-Dashboard/db/ ./backup-thor-dash/
```

---

## 🔄 Migrating to the v4.1.0 layout (Termux / old clone)

v4.1.0 split the old single repository into **two repositories**. Feature
logic, configs, and the DASH API contract are unchanged — only the layout
moved:

| Old layout (v3.x / v4.0.x)                | v4.1.0 (two repos)                                    |
| ----------------------------------------- | ----------------------------------------------------- |
| `index.js`, `src/`, `tests/`, `scripts/`  | **Thor-EN** repo root (flat — no more `bot/` folder)  |
| `data/` or `bot/data/` (all server data)  | `~/Thor-EN/data/`                                     |
| `.env` / `bot/.env` (bot)                 | `~/Thor-EN/.env`                                      |
| `dashboard/` (the whole web module)       | the **Thor-EN-Dashboard** repository                  |
| `dashboard/db/custom.db`                  | `~/Thor-EN-Dashboard/db/custom.db`                    |
| `dashboard/.env`                          | `~/Thor-EN-Dashboard/.env`                            |

On your old machine (e.g. Termux), stop the bot, then copy the data across:

```bash
# on the OLD machine — pack the live data (Termux: replace ~/Thor-EN with your path)
cd ~/Thor-EN && tar czf thor-data.tgz data/          # v3.x layout
# (v4.0.x layout: the same, the folder is already at bot/data/ — tar czf thor-data.tgz -C bot data/)

# transfer it to the VPS
scp thor-data.tgz thor@YOUR_VPS_IP:~/

# on the NEW machine — unpack into the Thor-EN repo's data/
cd ~/Thor-EN
rm -rf data/* && mkdir -p data
tar xzf ~/thor-data.tgz -C data --strip-components=1
```

Bring the dashboard's login database along too (optional — users just log in
again without it): copy `dashboard/db/custom.db` from the old clone to
`~/Thor-EN-Dashboard/db/custom.db` on the VPS. Then fill both `.env` files
(Step 3 — you can reuse the same `DASH_API_TOKEN` from the old setup) and
start as usual.

## Running on an Android phone (Termux) — free, no VPS

Thor runs fully on an Android phone via [Termux](https://termux.dev) since v3.21.1 — bot + web dashboard together; open the dashboard at `http://localhost:3000` (the phone's browser). Still supported in v4.1.0 (clone BOTH repositories).

```bash
# 1. Install Termux from F-Droid (the Play Store build is stale — don't use it),
#    then inside Termux:
pkg update && pkg install nodejs git
node -v                   # must be >= 20

# 2. Clone + setup BOTH repositories
git clone https://github.com/dwisetyabudi15581/Thor-EN.git
git clone https://github.com/dwisetyabudi15581/Thor-EN-Dashboard.git
cd ~/Thor-EN && ./setup.sh
cd ~/Thor-EN-Dashboard && ./setup.sh

# 3. Fill in both .env files (same as Step 3 above)
nano ~/Thor-EN/.env && nano ~/Thor-EN-Dashboard/.env

# 4. Run — the build automatically uses Webpack on Android
(cd ~/Thor-EN-Dashboard && npm run build && npm run start) &   # dashboard :3000
cd ~/Thor-EN && npm start                                      # the bot
```

Android-specific notes:

- **Slower builds** — Turbopack is unavailable on Android; the build automatically uses Webpack + SWC WASM. The first build can take 3–10 minutes depending on the phone; subsequent builds are faster.
- **Dashboard user storage automatically switches to JSON** (`db/custom-users.json`) — the Prisma database engine needs native binaries that don't exist on Android. Other dashboard features are unchanged (server config still flows through the bot's DASH API).
- **Keep it alive with the screen off:** run `termux-wake-lock`, then disable battery optimization for Termux (Settings → Apps → Termux → Battery → Unrestricted).
- **pm2 works** (`npm i -g pm2`) and is useful for auto-restart, but `pm2 startup` does not work (Android has no systemd). To auto-start after a phone reboot, use the [Termux:Boot](https://wiki.termux.com/wiki/Termux:Boot) app with a `~/.termux/boot/start-thor.sh` script that starts both repos.
- **The dashboard is reachable only from the phone itself** (localhost). To open it from outside, use a free tunnel, e.g.: `pkg install cloudflared && cloudflared tunnel --url http://localhost:3000`.
- For a stable 24/7 production setup (domain + HTTPS + uptime), a VPS is recommended (Steps 1–8 above).

## Quick troubleshooting

| Symptom                            | Common cause                                | Fix                                               |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| Bot not online                     | wrong DISCORD_TOKEN / intents off           | check `~/Thor-EN/.env` + 2 intents, `pm2 logs thor-bot` |
| Slash commands missing             | wrong GUILD_ID / global propagation ±1 hour | empty GUILD_ID for public mode, wait 1 hour       |
| Discord login fails                | redirect URI mismatch / wrong client secret | match exactly what the dashboard shows            |
| Server list empty                  | OAuth login predates the `guilds` scope     | log out → log back in                             |
| "Bot offline" in the dashboard     | DASH_API_TOKEN mismatch / bot down          | match tokens in BOTH repos' .env files, `pm2 status` |
| Web saves have no effect           | token mismatch (writes rejected)            | same as above — check `pm2 logs`                  |
| `npm install` fails in the dashboard repo | Node < 20                             | upgrade Node (its setup.sh checks it)             |
| Data missing after migrating       | old `data/` not unpacked into `~/Thor-EN/data/` | follow the migration section above            |
