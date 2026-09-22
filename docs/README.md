# 📚 Documentation — Thor-EN

The official documentation set for **Thor-EN — All-in-One Discord Community Bot + Web Dashboard** (v4.0.0).

| Document                                      | Contents                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [README.md](../README.md)                     | Project overview: the two-module architecture (bot/ + dashboard/), features, installation, development, basic troubleshooting                 |
| [bot/README.md](../bot/README.md)             | **Bot module docs** — features, standalone run, env variables, DASH API role, tests & development                                             |
| [dashboard/README.md](../dashboard/README.md) | **Dashboard module docs** — OAuth login, modules, standalone run, env variables                                                               |
| [ADMIN_GUIDE.md](./ADMIN_GUIDE.md)            | Complete admin guide: server setup, product & VIP management, daily operations, moderation, backup & restore, troubleshooting, best practices |
| [CHANGELOG.md](../CHANGELOG.md)               | Full history of every version (v3.9.0 – v4.0.0)                                                                                               |
| [../DEPLOY.md](../DEPLOY.md)                  | Production deployment: VPS + pm2 + domain/HTTPS + OAuth + end-to-end verification + migration from the v3.x layout + Termux                   |

## Quick Start

- **New admin?** Read [ADMIN_GUIDE → Section 1 (5-Minute Quick Start)](./ADMIN_GUIDE.md#1-quick-start-5-minutes), then follow [Section 2 (Initial Server Setup)](./ADMIN_GUIDE.md#2-initial-server-setup) step by step.
- **Selling things (key products / accounts / services)?** Focus on [Section 2 Step 6](./ADMIN_GUIDE.md#step-6-install-the-ticket-panel) (ticket panels & categories) and [Section 4](./ADMIN_GUIDE.md#4-daily-operations-tickets-announce-embed) (the daily transaction flow).
- **Bot misbehaving?** Start with [README → Troubleshooting](../README.md) for common cases, or [ADMIN_GUIDE → Section 9](./ADMIN_GUIDE.md#9-troubleshooting) for the full list.
- **Curious what changed?** See the [CHANGELOG](../CHANGELOG.md), or the summary of the last 3 versions in [ADMIN_GUIDE → Section 11](./ADMIN_GUIDE.md#11-version-history).
- **Migrating from the v3.x layout (Termux → VPS)?** See [DEPLOY.md → Migrating from the v3.x layout](../DEPLOY.md#-migrating-from-the-v3x-layout-termux--old-clone).

## Project Statistics

- **93 slash commands** — every feature is configurable from Discord OR the web dashboard, no file editing
- **897 unit tests** — `node:test`, sandboxed (safe to run on a live server)
- **discord.js v14** · Node.js 18+ (bot) / 20+ (dashboard) · single-server / public mode — one `GUILD_ID` variable
- **CI/CD** — GitHub Actions runs bot lint + tests (Node 18/20/22) and the dashboard production build on every push
- **Two independent modules** (v4.0.0) — `bot/` and `dashboard/` each have their own package.json; connected only by the DASH API

## Contributors / Developers

The code structure, per-domain architecture, and development guide are in [README.md → Project Structure](../README.md) plus each module's README. Run `npm run bot:test` (or `cd bot && npm test`) before committing — CI will reject code that fails the tests.
