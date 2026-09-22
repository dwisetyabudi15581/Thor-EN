# 🤖 Thor Bot — Discord Bot Module

The Discord bot half of **Thor-EN** — an All-in-One community bot (93 slash commands + unlimited web-made custom commands) for shop servers, gaming, content creators, and general communities. Everything is configured directly from Discord via slash commands, **or** from the [web dashboard](../dashboard/README.md) — both write to ONE shared data source, so they can never conflict.

> **v4.0.0** · 93 slash commands · 897 unit tests · discord.js v14 · Node.js 18+ · single-server / public mode · **100% FREE — every feature unlocked**

This folder is an **independent module** (separation of concerns, v4.0.0): it has its own `package.json` and can be lifted into its own repository as-is. It is connected to the dashboard **only** through the DASH API (HTTP + shared token) — see [How the two modules connect](#-how-the-two-modules-connect).

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

## 🚀 Run the bot (standalone)

```bash
cd bot
npm install
cp .env.example .env     # then fill in DISCORD_TOKEN (+ DASH_API_TOKEN for the dashboard)
npm start                # or: npm run dev (nodemon auto-restart)
```

> Running the bot + dashboard **together** (the usual setup)? Use the repo-root scripts: `./setup.sh` → `./start.sh`. See [../README.md](../README.md).

### Prerequisites

- Node.js v18+ (v20+ if you also run the dashboard)
- A Discord bot token ([how to get one](https://discord.com/developers/applications))
- **2 Privileged Intents** enabled in the Developer Portal (**Bot** tab):
    - ✅ **Server Members Intent** — welcome/goodbye + auto-role
    - ✅ **Message Content Intent** — **REQUIRED** for auto-responder, word/link anti-spam, AFK replies
- The bot invited with: `Manage Roles`, `Manage Channels`, `Send Messages`, `Embed Links`, `View Audit Log`, `Moderate Members`, `Move Members` — and its role placed **above** every role it manages

### Environment (`.env`)

| Variable                          | Required | Description                                                                                                                                                                                      |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DISCORD_TOKEN`                   | ✅       | The bot token from the Developer Portal                                                                                                                                                          |
| `GUILD_ID`                        | —        | One server = one line. **Set** = single-server mode (instant commands, other servers ignored). **Empty** = public mode (global commands, per-server configs at `bot/data/config/<guildId>.json`) |
| `DASH_API_HOST` / `DASH_API_PORT` | —        | The DASH API bind address (default `127.0.0.1:8788`) — only needed when the web dashboard is used                                                                                                |
| `DASH_API_TOKEN`                  | —        | Shared secret for the DASH API — **must match** `DASH_API_TOKEN` in `../dashboard/.env`                                                                                                          |

Full annotated template: [`.env.example`](./.env.example).

---

## 🔌 How the two modules connect

```
dashboard/ (Next.js, its own package.json)
    │  HTTP + DASH_API_TOKEN (the ONLY coupling point)
    ▼
bot/  ── DASH API (src/infra/dashServer.js, 127.0.0.1:8788)
    │         reads/writes the JSON persistence below + live gateway cache
    └── bot/data/  ← ONE data source (config/<guildId>.json, tickets, warns, …)
```

- The dashboard never touches `bot/data/` files directly — **every** read/write is validated by the bot (section whitelist, type checks, anti-prototype-pollution) and the acting user is recorded (audit).
- Both sides of the bridge are documented in each module's `.env.example`; the **only** values that must match are `DASH_API_*`.
- UI changes in `dashboard/` can never break the bot's process — and vice versa: each module deploys/restarts on its own.

---

## 📁 Module structure

```
bot/
├── index.js               # Entry point (event-driven, slim)
├── src/
│   ├── bot/events/        # Discord event handlers (20 events)
│   ├── commands/          # Slash command handlers (per-domain)
│   ├── interactions/      # Button/select/modal handlers (per-domain)
│   ├── data/              # JSON persistence layer (22 managers)
│   ├── services/          # Business logic (scheduler, role engine, …)
│   ├── ui/                # Embed/panel builders, help catalog
│   └── infra/             # dashServer (DASH API), safeWrite, permissions
│                          #  (3-tier RBAC resolver), auditLog, configOrphans
├── data/                  # Runtime JSON files (gitignored — server data)
├── tests/unit/            # 897 unit tests (node:test, sandboxed)
├── scripts/               # Dev tools (registry validation, embed measures)
├── eslint.config.js · .prettierrc.json
└── package.json           # ONLY bot dependencies (discord.js, dotenv)
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

- **Discord token** lives only in `bot/.env` (gitignored).
- **Atomic writes** — every JSON file goes through `safeWriteJSON` (tmp+rename); corrupt files are quarantined as `.corrupt-<ts>`, never silently overwritten.
- **Public mode isolation** — per-guild configs mean server A's admin can never overwrite server B's settings.

Full admin guide: [../docs/ADMIN_GUIDE.md](../docs/ADMIN_GUIDE.md) · Deployment: [../DEPLOY.md](../DEPLOY.md) · License: [../LICENSE](../LICENSE)
