# ⚡ Thor-EN — Discord Bot (bot-only repository)

An All-in-One Discord **community bot** — 93 slash commands covering tickets, shop transactions, moderation, anti-spam, leveling, giveaways, and much more — for shop servers, gaming, content creators, and general communities. Everything is configured directly from Discord via slash commands, **or** from the web dashboard (the separate [Thor-EN-Dashboard](https://github.com/dwisetyabudi15581/Thor-EN-Dashboard) repository) — both write to **one shared data source**, so they can never conflict.

> **v4.1.0 — REPOSITORY SPLIT.** This repository contains the **Discord bot ONLY**: the entry point, command handlers, event listeners, the JSON persistence layer (`data/`), and the built-in DASH API server. The web dashboard was **cut & moved** into its own repository: **[Thor-EN-Dashboard](https://github.com/dwisetyabudi15581/Thor-EN-Dashboard)** (Next.js + OAuth2 + `DATABASE_URL`). The two connect **only** through the DASH API (HTTP + shared token) — a UI change can never break the bot's process, and vice versa. Full history of both halves (v3.x – v4.1.0) stays in this repo's [CHANGELOG](./CHANGELOG.md).
>
> 93 slash commands (+ unlimited custom commands made on the web) · 897 unit tests · discord.js v14 · Node.js 18+ · single-server / public mode · **100% FREE — every feature unlocked**
>
> 📖 **[Complete Admin Guide](./docs/ADMIN_GUIDE.md)** · 🌐 **[Web dashboard repository](https://github.com/dwisetyabudi15581/Thor-EN-Dashboard)** · 🚀 **[Deployment guide (production)](./DEPLOY.md)** · 📜 **[Changelog](./CHANGELOG.md)**

---

## 🏗️ Architecture (v4.1.0 — two repositories, one system)

```
 Thor-EN  (THIS repo — the bot)          Thor-EN-Dashboard  (separate repo — the web)
 ──────────────────────────────          ─────────────────────────────────────────────
 node index.js                           Next.js :3000 (Discord OAuth2 login)
 ├─ discord.js client                    ├─ 3-tier RBAC: Admin/Staff/Member
 ├─ 93 slash commands, 20 events         ├─ Prisma SQLite (dashboard users — DATABASE_URL)
 ├─ data/  ← ONE data source             │
 │  (config/<guildId>.json,              │
 │   tickets, warns, levels, …)          │
 └─ DASH API :8788 (localhost)  ◄────────┘  http://127.0.0.1:8788 + DASH_API_TOKEN
                                           (the ONLY coupling point between the repos)
```

- **Two ways to configure the bot** — slash commands in Discord **or** the web dashboard — both validated by the bot against the same data source (the bot's `data/` folder, reached through the DASH API).
- **Live two-way sync (v3.29.0)** — the dashboard auto-refreshes every 15 s; Discord events (member joins, channel/role deletions, guild lifecycle) surface on the web without a manual refresh.
- **One access system (v3.30.0)** — the same 3-tier resolver (Super Admin / Moderator-Staff / Member) guards slash commands, ticket buttons, and every dashboard route.
- **Instant hot-apply** — every config change from the web applies to the running bot without a restart.

---

## ✨ Key Features

- **🎫 Tickets & Transactions** — multi-category & multi-panel ticket panels (full CRUD from Discord), automatic custom categories, key-based products (**🔑 Set Key**) and non-key products (**📦 Deliver Order**), automatic invoice + transcript.
- **🤝 Midman / Escrow** — 3-party escrow deals (_rekber_) with a Deal Board state machine, 3-step creation form, dual consent, member management, additive fee.
- **🔑 Products & VIP** — key-driven VIP roles using the MAX EXTEND model, auto-expiry scheduled, keys always masked in the audit log.
- **🛡️ Anti-Spam & Auto-Mod** — spam detection, mass-mention blocking, link blocking with whitelists, flexible per-word filter with whole-word matching.
- **⚔️ Moderation** — `/timeout` `/purge` `/kick` `/ban` `/warn` with two-way hierarchy guards, warn escalation (3→1h mute, 5→24h, 7→kick), full server log, 3-tier RBAC (Super Admin / Staff / Member).
- **💬 Auto-Responder & AFK** — keyword triggers (contains/exact match modes), per-user cooldown, AFK auto-reply & auto-clear.
- **📊 Leveling & Stats** — XP + role rewards, live counter channels (`/serverstats`), leaderboards, boosters with auto role.
- **🎭 And more** — verification, self-role panels, temp voice with control panel, giveaways, polls, scheduled announcements, embed builder, backups, 63-action audit log.

---

## 🚀 Quick start (the bot)

```bash
# 1. Clone THIS repository
git clone https://github.com/dwisetyabudi15581/Thor-EN.git
cd Thor-EN

# 2. Install + prepare .env
./setup.sh

# 3. Fill in the environment
nano .env            # DISCORD_TOKEN + GUILD_ID (+ DASH_API_TOKEN for the dashboard)

# 4. Run the bot
npm start            # or: ./start.sh   (dev mode: ./dev.sh or npm run dev)
```

**Want the web dashboard too?** It is a separate repository (v4.1.0):

```bash
git clone https://github.com/dwisetyabudi15581/Thor-EN-Dashboard.git
cd Thor-EN-Dashboard && ./setup.sh     # then fill its .env (DATABASE_URL, OAuth, ...)
```

> The **only** value that must match between the two `.env` files is the `DASH_API_TOKEN` pair — see [How the two repositories connect](#-how-the-two-repositories-connect) below.

### Prerequisites

- Node.js v18+ (v20+ if you also run the dashboard)
- A Discord bot token ([how to get one](https://discord.com/developers/applications))
- **2 Privileged Intents** enabled in the Developer Portal (**Bot** tab):
    - ✅ **Server Members Intent** — welcome/goodbye + the Unverified role on join
    - ✅ **Message Content Intent** — **REQUIRED** for auto-responder, word/link anti-spam, AFK replies
- The bot invited with: `Manage Roles`, `Manage Channels`, `Send Messages`, `Embed Links`, `View Audit Log`, `Moderate Members`, `Move Members` — and its role placed **above** every role it manages

### Environment (`.env`)

| Variable                          | Required | Description                                                                                                                                                                        |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`                   | ✅       | The bot token from the Developer Portal                                                                                                                                            |
| `GUILD_ID`                        | —        | One server = one line. **Set** = single-server mode (instant commands, other servers ignored). **Empty** = public mode (global commands, per-server configs at `data/config/<guildId>.json`) |
| `DASH_API_HOST` / `DASH_API_PORT` | —        | The DASH API bind address (default `127.0.0.1:8788`) — only needed when the web dashboard is used                                                                                  |
| `DASH_API_TOKEN`                  | —        | Shared secret for the DASH API — **must match** `DASH_API_TOKEN` in the Thor-EN-Dashboard repository's `.env`                                                                       |

Full annotated template: [`.env.example`](./.env.example).

---

## 🔌 How the two repositories connect

```
Thor-EN-Dashboard repo (Next.js, its own package.json & DATABASE_URL)
    │  HTTP + DASH_API_TOKEN (the ONLY coupling point)
    ▼
Thor-EN repo ── DASH API (src/infra/dashServer.js, 127.0.0.1:8788)
    │             reads/writes the JSON persistence below + live gateway cache
    └── data/  ← ONE data source (config/<guildId>.json, tickets, warns, …)
```

- **Where the data lives:** all server configuration & runtime data (tickets, warns, levels, products, …) is stored by the bot in `data/` (JSON persistence, atomic writes). The dashboard's own `DATABASE_URL` (SQLite in the Thor-EN-Dashboard repo) stores only its login users — the two can never conflict.
- The dashboard never touches the bot's `data/` files directly — **every** read/write is validated by the bot (section whitelist, type checks, anti-prototype-pollution) and the acting user is recorded (audit).
- Both sides of the bridge are documented in each repository's `.env.example`; the **only** values that must match are `DASH_API_*`.
- UI changes in the dashboard repo can never break the bot's process — and vice versa: each repository deploys/restarts on its own.

---

## 📁 Project structure

```
Thor-EN/                      # 🤖 THE BOT REPOSITORY (v4.1.0 — flat, bot-only)
├── index.js                  #   entry point (event-driven, slim)
├── src/
│   ├── bot/events/           #   Discord event handlers (20 events)
│   ├── commands/             #   slash command handlers (per-domain)
│   ├── interactions/         #   button/select/modal handlers (per-domain)
│   ├── data/                 #   JSON persistence layer — the "database models" (22 managers)
│   ├── services/             #   business logic (scheduler, role engine, …)
│   ├── ui/                   #   embed/panel builders, help catalog
│   └── infra/                #   dashServer (DASH API), safeWrite, permissions
│                             #    (3-tier RBAC resolver), auditLog, configOrphans
├── data/                     #   runtime JSON files (gitignored — server data)
├── tests/unit/               #   897 unit tests (node:test, sandboxed)
├── scripts/                  #   dev tools (registry validation, embed measures)
├── docs/                     #   ADMIN_GUIDE.md + docs index
├── setup.sh · start.sh · dev.sh · ecosystem.config.cjs (pm2)
├── .github/workflows/ci.yml  #   lint + tests (Node 18/20/22)
└── package.json              #   ONLY bot dependencies (discord.js, dotenv)
```

---

## 🧪 Development

| Script           | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| `npm start`      | Run the bot                                                 |
| `npm run dev`    | Run with nodemon (auto-restart)                             |
| `npm test`       | Run all unit tests (897, sandboxed — safe on a live server) |
| `npm run lint`   | ESLint check                                                |
| `npm run format` | Prettier format                                             |

Tests use the `node:test` runner built into Node.js — no extra dependencies. CI (GitHub Actions) runs lint + tests on every push for Node 18/20/22.

---

## 🛡️ Security notes

- **Discord token** lives only in `.env` (gitignored).
- **Atomic writes** — every JSON file goes through `safeWriteJSON` (tmp+rename); corrupt files are quarantined as `.corrupt-<ts>`, never silently overwritten.
- **Public mode isolation** — per-guild configs mean server A's admin can never overwrite server B's settings.

Full admin guide: [docs/ADMIN_GUIDE.md](./docs/ADMIN_GUIDE.md) · Deployment: [DEPLOY.md](./DEPLOY.md) · Web dashboard: [Thor-EN-Dashboard](https://github.com/dwisetyabudi15581/Thor-EN-Dashboard) · License: [LICENSE](./LICENSE)
