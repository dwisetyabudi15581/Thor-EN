# Thor Dashboard — Manage Your Discord Bot from the Web

> The **web dashboard module** of **Thor-EN** (v4.0.0) — an independent
> folder with its own `package.json` and `.env`, ready to run standalone or
> to be lifted into its own repository. The bot lives in
> [../bot/](../bot/README.md); the deployment guide is
> [../DEPLOY.md](../DEPLOY.md).

The web dashboard for the **Thor** Discord bot — configure every bot feature
straight from your browser, no commands needed. **The bot is 100% free for
everyone** — no keys, no subscriptions. Built with Next.js 16, TypeScript,
Tailwind CSS 4, shadcn/ui, and Prisma (SQLite).

## How It Works

```
Browser ──> Next.js Dashboard (Discord OAuth2 login)
                │  3-tier access: Admin / Staff / Member (same resolver as the bot)
                ▼
           Thor bot DASH API (http://127.0.0.1:8788, secret token)
                │  business validation stays inside the bot
                ▼
           bot/data/config/<guildId>.json + bot managers  ← ONE data source
```

- **Two ways to control the bot**: slash commands right inside Discord **or**
  this web dashboard — both write to the SAME single data source, so they
  never conflict.
- **Live two-way sync** — the dashboard auto-refreshes every 15 s (member
  joins, channel/role deletions and guild changes surface automatically);
  every save applies to the running bot instantly (hot-apply, no restart).
- **Access is enforced by the same 3-tier resolver the bot uses** — Super
  Admin sees everything, Staff get the moderation pack, Members see their
  own read-only profile. Users only reach servers where they hold the Owner /
  **Manage Server** permission or a staff/member role granted by the bot.
- **Every write is validated by the bot** (section whitelist + types + anti
  prototype pollution) and records who the actor was (audit).

## Features

- **Discord login (OAuth2)** — sign in with your Discord account, no password
- **Server picker** — every server you can reach, with Admin/Staff/Member
  tier badges + bot status
- **Discord-style dark UI** — live status header (online/ping/guild count),
  sidebar server switcher + profile card, Overview with summary cards and
  **instant module quick-toggles** (Auto-Mod, Welcome, Economy, Auto-Role)
- **Pixel-honest live previews** — the welcome/goodbye embed and the embed
  builder render exactly as Discord will show them, before you save
- **22 configuration modules**: **Quick Start** (a 6-step server setup
  checklist), Overview, General, Tickets & Products, AutoMod, Leveling,
  Middleman, Auto-Responder, Self-Roles, Announcements, Temp Voice, Server
  Stats, Command Manager (enable/disable each slash command per server),
  **Custom Command** (build your own slash command on the web → automatically
  registered on Discord), **Embed Builder** (full builder + live preview),
  Backup, Moderation (warn + modlog), VIP Keys, Giveaway, Poll, **Access
  Control** (the 3-tier admin/staff grant table), and the member profile view
- **Direct CRUD** — add/remove responders, self-role panels, and scheduled
  announcements without restarting the bot
- **Bot invite** — invite button with least-privilege permissions

## Running

Standalone (this folder is self-contained):

```bash
npm install
npx prisma generate
cp .env.example .env      # then fill it in (see the table below)
npm run build
npm run start             # :3000
```

Or together with the bot, from the **repo root**:

```bash
./setup.sh     # once: install bot + dashboard + prepare both .env files
./start.sh     # production: bot + dashboard together
./dev.sh       # development: nodemon (bot) + next dev (dashboard)
```

> Without the bot running, the dashboard still works but shows a "Bot offline"
> banner. To try the UI without the bot: `npm run mock` (a fake DASH API with
> demo data on 127.0.0.1:8788).

### Important variables (`.env`)

| Variable                                      | Description                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                | SQLite, e.g. `file:db/custom.db` — dashboard users only (bot data lives in `../bot/data/`) |
| `SESSION_SECRET`                              | Random string (`openssl rand -hex 32`)                                                     |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | OAuth2 from the Developer Portal (same application as the bot)                             |
| `PUBLIC_ORIGIN`                               | Production domain, e.g. `https://thor.yourdomain.com`                                      |
| `ADMIN_DISCORD_IDS`                           | Discord IDs (comma-separated) that become admins                                           |
| `DASH_API_URL` / `DASH_API_TOKEN`             | Must MATCH `../bot/.env` — the only coupling point with the bot                            |

The OAuth redirect URI to register in the Developer Portal (built from
`PUBLIC_ORIGIN`):
`https://<dashboard-domain>/api/auth/discord/callback`
