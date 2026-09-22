# ⚡ Thor-EN — Discord Bot + Web Dashboard (ONE system, TWO independent modules)

An All-in-One Discord community bot **and** its web dashboard — configured from Discord via slash commands, from the browser via the dashboard, or both (they write to **one shared data source** and can never conflict). Built for shop servers, gaming, content creators, and general communities alike.

> **v4.0.0** — the repo is now organized as **two fully independent modules** (separation of concerns): [`bot/`](./bot/README.md) (the Discord bot) and [`dashboard/`](./dashboard/README.md) (the Next.js web app). Each has its own `package.json`, its own `.env`, and can be lifted into its own repository as-is. They are connected **only** through the bot's DASH API (HTTP + shared token) — a UI change can never break the bot's process, and vice versa.
>
> 93 slash commands (+ unlimited custom commands from the web) · 897 unit tests · discord.js v14 · Next.js 16 + Prisma · Node.js 20+ · single-server / public mode · **100% FREE — every feature unlocked**
>
> 📖 **[Complete Admin Guide](./docs/ADMIN_GUIDE.md)** · 🤖 **[Bot module docs](./bot/README.md)** · 🌐 **[Dashboard module docs](./dashboard/README.md)** · 🚀 **[Deployment guide (production)](./DEPLOY.md)** · 📜 **[Changelog](./CHANGELOG.md)**

---

## 🏗️ Architecture (v4.0.0)

```
                     Internet
                        │
                 domain.com :443
                 (Caddy — automatic HTTPS)
                        │
                 Next.js Dashboard :3000          ← dashboard/ (own package.json)
                 (Discord OAuth2 login,           · frontend UI + API routes
                  3-tier RBAC: Admin/Staff/Member) · Prisma SQLite (dashboard users)
                        │  http://127.0.0.1:8788 + DASH_API_TOKEN
                        │  (the ONLY coupling point between the modules)
                        ▼
                 Thor bot (node index.js)         ← bot/ (own package.json)
                 └─ DASH API :8788 (localhost)     · discord.js client
                 └─ bot/data/ ← ONE data source    · 93 slash commands, 20 events
                    (config/<guildId>.json,        · JSON persistence (22 managers)
                     tickets, warns, levels, …)    · SAME 3-tier RBAC resolver
```

- **Two ways to configure the bot** — slash commands in Discord **or** the web dashboard — both validated by the bot against the same data source.
- **Live two-way sync (v3.29.0)** — the dashboard auto-refreshes every 15 s; Discord events (member joins, channel/role deletions, guild lifecycle) surface on the web without a manual refresh.
- **One access system (v3.30.0)** — the same 3-tier resolver (Super Admin / Moderator-Staff / Member) guards slash commands, ticket buttons, and every dashboard route.
- **Instant hot-apply** — every config change from the web applies to the running bot without a restart.

---

## 🚀 Quick start

```bash
# 1. Clone the repo
git clone https://github.com/dwisetyabudi15581/Thor-EN-v2.git
cd Thor-EN-v2

# 2. Install BOTH modules (bot/ + dashboard/ + both .env files from examples)
./setup.sh

# 3. Fill in the environment — each module has its OWN .env
nano bot/.env          # DISCORD_TOKEN + GUILD_ID + DASH_API_TOKEN
nano dashboard/.env    # Discord OAuth + SESSION_SECRET + the SAME DASH_API_TOKEN

# 4. Run the whole system
./start.sh             # production: bot + dashboard in one run (Ctrl+C stops both)
./dev.sh               # development: nodemon (bot) + next dev (dashboard)
```

> 📱 **Android phone (Termux)?** The whole system runs on a phone too — see the Termux section in [DEPLOY.md](./DEPLOY.md). For a 24/7 production server, a VPS is recommended (the main DEPLOY.md flow).

Each module also runs **standalone** (useful when developing only one side):

```bash
cd bot && npm start            # the Discord bot only
cd dashboard && npm start      # the web dashboard only (shows "Bot offline" without the bot)
```

---

## 📁 Project structure

```
Thor-EN-v2/
├── bot/                          # 🤖 MODULE 1 — Discord Bot (independent)
│   ├── index.js                  #   entry point (event-driven)
│   ├── src/                      #   commands · interactions · data · services · ui · infra
│   │   └── infra/dashServer.js   #   the DASH API (the bridge to the dashboard)
│   ├── data/                     #   runtime JSON persistence (gitignored)
│   ├── tests/unit/               #   897 unit tests (node:test)
│   ├── package.json              #   ONLY bot deps (discord.js, dotenv)
│   └── .env.example              #   DISCORD_TOKEN · GUILD_ID · DASH_API_*
├── dashboard/                    # 🌐 MODULE 2 — Web Dashboard (independent)
│   ├── src/                      #   Next.js app (pages, API routes, components)
│   ├── prisma/                   #   dashboard user DB schema (SQLite)
│   ├── db/                       #   SQLite database file (gitignored)
│   ├── package.json              #   ONLY web deps (next, react, tailwind, prisma, …)
│   └── .env.example              #   DATABASE_URL · SESSION_SECRET · DISCORD_CLIENT_* · DASH_API_*
├── docs/                         # shared documentation (ADMIN_GUIDE + index)
├── setup.sh · start.sh · dev.sh  # orchestration: install & run BOTH modules
├── ecosystem.config.cjs          # pm2: thor-bot (bot/) + thor-dash (dashboard/) 24/7
├── .github/workflows/ci.yml      # CI: bot lint+tests (18/20/22) + dashboard build
├── package.json                  # root orchestrator (no deps — convenience scripts)
├── DEPLOY.md · CHANGELOG.md · LICENSE
└── .gitignore
```

**Ready to split into two repos** — `bot/` and `dashboard/` are self-contained (dependencies, env templates, scripts, tests). Copy either folder out and it works; the only contract to preserve is the matching `DASH_API_*` pair.

---

## 🔐 Environment variables — who needs what

| Variable                                      | Module       | Notes                                                                                                    |
| --------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`                               | 🤖 bot       | The bot's credential (Developer Portal → Bot)                                                            |
| `GUILD_ID`                                    | 🤖 bot       | One line = one server. Empty = public mode                                                               |
| `DASH_API_HOST` / `DASH_API_PORT`             | 🤖 bot       | DASH API bind address (default `127.0.0.1:8788`)                                                         |
| `DASH_API_URL`                                | 🌐 dashboard | Where to find the bot's DASH API (`http://127.0.0.1:8788`)                                               |
| `DASH_API_TOKEN`                              | 🤖 **+** 🌐  | **MUST be identical in both .env files** — the bridge secret (`openssl rand -hex 32`)                    |
| `DATABASE_URL`                                | 🌐 dashboard | SQLite for dashboard users (`file:db/custom.db`) — the bot's data is NOT here (see architecture)         |
| `SESSION_SECRET`                              | 🌐 dashboard | Login cookie signing key (`openssl rand -hex 32`, separate value)                                        |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | 🌐 dashboard | OAuth2 credentials (same application as the bot)                                                         |
| `PUBLIC_ORIGIN`                               | 🌐 dashboard | Production domain; the OAuth callback URL is built from it: `https://<domain>/api/auth/discord/callback` |
| `ADMIN_DISCORD_IDS`                           | 🌐 dashboard | Discord IDs that become dashboard admins                                                                 |
| `DEMO_MODE` / `NEXT_PUBLIC_INVITE_URL`        | 🌐 dashboard | Demo login toggle / invite link override                                                                 |

Annotated templates: [`bot/.env.example`](./bot/.env.example) · [`dashboard/.env.example`](./dashboard/.env.example)

---

## ✨ Feature highlights

**Web dashboard** ([details](./dashboard/README.md)) — Discord-style dark UI with live bot status header (online/ping/guilds), server switcher, Overview with summary cards + **instant module quick-toggles**, pixel-honest welcome/embed live previews, Access Control table (3-tier RBAC), 22 configuration modules, custom command builder, embed builder, backups, moderation with history, and a member profile view — all live-synced every 15 s.

**Tickets & transactions** — multi-category ticket panels with full CRUD, key-based and deliver-order flows, automatic invoices + transcripts, and **midman/escrow** 3-party deals with a state machine and dual consent.

**Moderation & safety** — timeout/purge/kick/ban/warn with hierarchy guards and warn escalation, anti-spam (spam, mass-mention, links, per-word filter), full server log, 63-action audit log with masked keys.

**Engagement** — leveling with role rewards, live counter channels, boosters with auto-role, auto-responder (contains/exact), AFK, self-role panels, temp voice, giveaways, polls, scheduled announcements, verification.

Full feature list with per-feature details: [bot/README.md](./bot/README.md).

---

## 🧪 Development

From the repo root (orchestrator scripts):

| Script               | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `./setup.sh`         | Install bot + dashboard + prepare both .env files       |
| `./start.sh`         | Production: bot + dashboard together                    |
| `./dev.sh`           | Development: nodemon + next dev together                |
| `npm run bot:test`   | Bot unit tests (897, sandboxed — safe on a live server) |
| `npm run bot:lint`   | Bot ESLint check                                        |
| `npm run dash:build` | Dashboard production build                              |
| `npm run dash:mock`  | Dashboard + a mock DASH API (demo data, no bot needed)  |

Or work inside each module like any standalone project (`cd bot && npm test` / `cd dashboard && npm run build`). CI runs bot lint + tests (Node 18/20/22) **and** the dashboard production build on every push.

---

## 🛡️ Security

- **Secrets only in `.env`** — both files are gitignored; the token is never committed.
- **The DASH API is localhost-only and off by default** — it does not start without `DASH_API_TOKEN`.
- **Every dashboard write is validated inside the bot** — section whitelist, type checks, anti-prototype-pollution, actor recorded; privilege-escalation guards protect the access lists themselves.
- **Atomic writes + corrupt-file quarantine** — no data loss on crash or power loss.
- **Public-mode isolation** — per-guild config files mean one server's admin can never touch another's settings.

---

## 🆘 Troubleshooting (quick)

| Symptom                         | Fix                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| Bot won't come online           | Check `DISCORD_TOKEN` in `bot/.env`; the bot must be invited to the `GUILD_ID` server |
| Slash commands missing          | Wrong `GUILD_ID` (server ID, not user ID); empty = global, ~1 h propagation — normal  |
| "Bot offline" in the dashboard  | `DASH_API_TOKEN` mismatch between `bot/.env` and `dashboard/.env`, or the bot is down |
| Web saves have no effect        | Same token-mismatch cause — the bot rejects unauthenticated writes                    |
| Auto-responder / anti-spam dead | **Message Content Intent** not enabled in the Developer Portal                        |
| Welcome message not appearing   | Run `/test-welcome tipe:welcome` — it diagnoses every link in the chain               |

Full guides: [docs/ADMIN_GUIDE.md → Section 9](./docs/ADMIN_GUIDE.md) · [DEPLOY.md → troubleshooting](./DEPLOY.md).

---

## 📝 License

MIT — free to use, modify, and distribute. See [LICENSE](./LICENSE).
