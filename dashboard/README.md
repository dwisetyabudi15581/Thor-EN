# Thor Dashboard — Manage Your Discord Bot from the Web (Dyno-style)

> This folder is part of the **Thor** repository (bot + dashboard in ONE repo).
> The full deployment guide lives in [../DEPLOY.md](../DEPLOY.md) (repo root).

The web dashboard for the **Thor** Discord bot — configure every bot feature
straight from your browser, no commands needed. **The bot is 100% free for
everyone** — no keys, no subscriptions. Built with Next.js 16, TypeScript,
Tailwind CSS 4, shadcn/ui, and Prisma (SQLite).

## How It Works

```
Browser ──> Next.js Dashboard (Discord OAuth2 login)
                │  guard: login + Manage Guild permission (live from Discord)
                ▼
           Thor bot DASH API (http://127.0.0.1:8788, secret token)
                │  business validation stays inside the bot
                ▼
           data/config/<guildId>.json + bot managers
```

- **Two ways to control the bot**: slash commands right inside Discord **or**
  this web dashboard — both write to the SAME single data source, so they
  never conflict.
- **Access is enforced by Discord**: users only see servers where they hold
  the Owner / **Manage Server** permission, and the bot must be in that server.
- **Every write is validated by the bot** (section whitelist + types + anti
  prototype pollution) and records who the actor was (audit).

## Features

- **Discord login (OAuth2)** — sign in with your Discord account, no password
- **Server picker** — the list of servers you manage + bot status (active/not yet)
- **11 configuration modules**: Overview, General, Tickets & Products, AutoMod,
  Leveling, Middleman, Auto-Responder, Self-Roles, Announcements (scheduled),
  Temp Voice, Server Stats (live channel counters)
- **Direct CRUD** — add/remove responders, self-role panels, and scheduled
  announcements without restarting the bot
- **Bot invite** — invite button with least-privilege permissions

## Running

The easiest way — from the **repo root**:

```bash
./setup.sh     # once: install bot + dashboard + prepare .env files
./start.sh     # production: bot + dashboard together
./dev.sh       # development: nodemon (bot) + next dev (dashboard)
```

Or manually from this folder:

```bash
npm install
npx prisma generate
cp .env.example .env      # then fill it in (see the table below)
npm run build
npm run start             # :3000
```

> Without the bot running, the dashboard still works but shows a "Bot offline"
> banner. To try the UI without the bot: `npm run mock` (a fake DASH API with
> demo data on 127.0.0.1:8788).

### Important variables (`.env`)

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | SQLite, e.g. `file:db/custom.db` |
| `SESSION_SECRET` | Random string (`openssl rand -hex 32`) |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | OAuth2 from the Developer Portal |
| `PUBLIC_ORIGIN` | Production domain, e.g. `https://thor.yourdomain.com` |
| `ADMIN_DISCORD_IDS` | Discord IDs (comma-separated) that become admins |
| `DASH_API_URL` / `DASH_API_TOKEN` | Must MATCH the Thor bot's `.env` |

The OAuth redirect URI to register in the Developer Portal:
`https://<dashboard-domain>/api/auth/discord/callback`
