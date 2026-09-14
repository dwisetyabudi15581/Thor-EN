# 🚀 Deployment Guide — Thor Bot + Web Dashboard (ONE REPO)

Since v3.18.0, the bot and the web dashboard live in **one repository** —
clone once, run `./setup.sh` once, and you're done. The bot is 100% free
(single-server mode or public Dyno-style mode).

Target production architecture (everything on **one VPS**):

```
                        Internet
                           │
                    domain.com :443
                    (Caddy — automatic HTTPS)
                           │
                    Next.js Dashboard :3000
                    (dashboard/ folder, Discord OAuth2 login)
                           │  http://127.0.0.1:8788 (DASH_API_TOKEN)
                           ▼
                    Thor bot (node index.js, repo root)
                    └─ DASH API :8788 (localhost only)
                    └─ data/config/<guildId>.json  ← ONE data source
```

- **The bot and the web write configuration to the same files** through the
  DASH API — Discord slash commands and the web dashboard never conflict.
- The dashboard can run **without the bot** (a "Bot offline" banner appears)
  — but to save changes, the bot must be running.

---

## 0. What you need

| Requirement | Example | Cost |
| --- | --- | --- |
| VPS 1 vCPU / 1 GB / Node.js 20+ | Hetzner/Vultr/DO or a local provider | ~$5 / month |
| Domain | `thor.yourdomain.com` | ~$10–15/year |
| Discord application (already have one) | Client ID + Client Secret + bot token | free |

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

## 2. Clone + install (ONE repo, one command)

```bash
cd ~
git clone https://github.com/dwisetyabudi15581/Thor-EN.git
cd Thor-EN
./setup.sh        # installs bot + dashboard + creates both .env files from examples
```

## 3. Fill in both .env files

Generate one random token shared by both sides (the bot ⇄ web bridge):

```bash
openssl rand -hex 32   # save the output — it's used in TWO places
```

**`.env` (bot — repo root):**

```ini
DISCORD_TOKEN=bot_token_from_the_developer_portal
GUILD_ID=                          # EMPTY = public Dyno-style mode

DASH_API_HOST=127.0.0.1
DASH_API_PORT=8788
DASH_API_TOKEN=THE-OPENSSL-RAND-HEX-32-RESULT-ABOVE
```

**`dashboard/.env` (web):**

```ini
DATABASE_URL=file:db/custom.db
SESSION_SECRET=A-NEW-OPENSSL-RAND-HEX-32-RESULT    # a NEW secret, not the DASH one
DEMO_MODE=false
DISCORD_CLIENT_ID=1548297613969985546
DISCORD_CLIENT_SECRET=client_secret_from_the_portal
PUBLIC_ORIGIN=https://thor.yourdomain.com
ADMIN_DISCORD_IDS=1290700587373039619

DASH_API_URL=http://127.0.0.1:8788
DASH_API_TOKEN=THE-OPENSSL-RAND-HEX-32-RESULT-ABOVE  # EXACTLY the same as the bot's .env
```

> ⚠️ The most common mistake: `DASH_API_TOKEN` differing between the two .env
> files → the dashboard shows "Bot offline" and saves have no effect. Make
> them match, then restart both processes.

## 4. Test first, then run 24/7

```bash
npm test                    # all 639 bot unit tests must pass

# quick check (both components alive):
./start.sh                  # Ctrl+C to stop

# 24/7 production via pm2:
(cd dashboard && npm run build)
pm2 start ecosystem.config.cjs
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
2. **Bot** → *Privileged Gateway Intents* → enable:
   - ✅ SERVER MEMBERS INTENT
   - ✅ MESSAGE CONTENT INTENT
3. **OAuth2** → *Redirects* → add:
   ```
   https://thor.yourdomain.com/api/auth/discord/callback
   ```
   (the dashboard also shows this exact URI in the landing footer — copy it from there)
4. Save.

## 7. End-to-end verification (5 minutes)

1. Open `https://thor.yourdomain.com` → the landing page appears
2. **Login with Discord** → authorize → the server list opens
3. Pick a server where the bot has been invited → the 11-module dashboard opens
4. Change one setting (e.g. the **General** module → Save) → check in Discord
   with `/config-show` → the values must match (proof that slash commands and
   the web share one source)
5. `pm2 logs thor-bot` → DASH API requests are logged

## 8. Daily operations

```bash
pm2 status                 # thor-bot + thor-dash must be online
pm2 logs thor-bot          # bot logs
pm2 logs thor-dash         # dashboard logs
pm2 restart all            # restart both

# update to a new version:
cd ~/Thor-EN && git pull
./setup.sh                 # reinstall deps if changed
npm test
(cd dashboard && npm run build)
pm2 restart all

# back up ALL bot data: just the data/ folder
rsync -av thor@YOUR_VPS_IP:~/Thor-EN/data/ ./backup-thor/
# back up the dashboard (login users): the dashboard/db/custom.db file
```

## Quick troubleshooting

| Symptom | Common cause | Fix |
| --- | --- | --- |
| Bot not online | wrong DISCORD_TOKEN / intents off | check token + 2 intents, `pm2 logs thor-bot` |
| Slash commands missing | wrong GUILD_ID / global propagation ±1 hour | empty GUILD_ID for public mode, wait 1 hour |
| Discord login fails | redirect URI mismatch / wrong client secret | match exactly what the dashboard shows |
| Server list empty | OAuth login predates the `guilds` scope | log out → log back in |
| "Bot offline" in the dashboard | DASH_API_TOKEN mismatch / bot down | match tokens, `pm2 status` |
| Web saves have no effect | token mismatch (writes rejected) | same as above — check `pm2 logs` |
| `npm install` fails in dashboard/ | Node < 20 | upgrade Node (setup.sh checks it) |
