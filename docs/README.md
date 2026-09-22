# 📚 Documentation — Thor-EN (the Discord Bot repository)

The official documentation set for **Thor-EN — the All-in-One Discord Community Bot** (v4.1.0). The web dashboard is a **separate repository**: [Thor-EN-Dashboard](https://github.com/dwisetyabudi15581/Thor-EN-Dashboard).

| Document                                                        | Contents                                                                                                                                      |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [README.md](../README.md)                                       | Bot repository overview: the two-repository architecture, features, installation, development, basic troubleshooting                            |
| [ADMIN_GUIDE.md](./ADMIN_GUIDE.md)                              | Complete admin guide: server setup, product & VIP management, daily operations, moderation, backup & restore, troubleshooting, best practices |
| [CHANGELOG.md](../CHANGELOG.md)                                 | Full history of every version (v3.9.0 – v4.1.0) — including the dashboard's, up to the v4.1.0 repository split                                |
| [../DEPLOY.md](../DEPLOY.md)                                    | Production deployment: VPS + pm2 + domain/HTTPS + OAuth + end-to-end verification + migration to the v4.1.0 layout + Termux                    |
| [Thor-EN-Dashboard](https://github.com/dwisetyabudi15581/Thor-EN-Dashboard) | The web dashboard repository — its own README documents OAuth login, modules, env variables, and its own deployment                            |

## Quick Start

- **New admin?** Read [ADMIN_GUIDE → Section 1 (5-Minute Quick Start)](./ADMIN_GUIDE.md#1-quick-start-5-minutes), then follow [Section 2 (Initial Server Setup)](./ADMIN_GUIDE.md#2-initial-server-setup) step by step.
- **Selling things (key products / accounts / services)?** Focus on [Section 2 Step 6](./ADMIN_GUIDE.md#step-6-install-the-ticket-panel) (ticket panels & categories) and [Section 4](./ADMIN_GUIDE.md#4-daily-operations-tickets-announce-embed) (the daily transaction flow).
- **Bot misbehaving?** Start with [README → Troubleshooting](../README.md) for common cases, or [ADMIN_GUIDE → Section 9](./ADMIN_GUIDE.md#9-troubleshooting) for the full list.
- **Curious what changed?** See the [CHANGELOG](../CHANGELOG.md), or the summary of the last 3 versions in [ADMIN_GUIDE → Section 11](./ADMIN_GUIDE.md#11-version-history).
- **Migrating from the v3.x/v4.0.x layout (Termux → VPS)?** See [DEPLOY.md → Migrating to the v4.1.0 layout](../DEPLOY.md#-migrating-to-the-v410-layout-termux--old-clone).

## Project Statistics

- **93 slash commands** — every feature is configurable from Discord OR the web dashboard, no file editing
- **897 unit tests** — `node:test`, sandboxed (safe to run on a live server)
- **discord.js v14** · Node.js 18+ (the bot) / 20+ (the dashboard repo) · single-server / public mode — one `GUILD_ID` variable
- **CI/CD** — GitHub Actions runs bot lint + tests (Node 18/20/22) on every push; the dashboard repo has its own production-build CI
- **Two separate repositories** (v4.1.0) — Thor-EN (this bot repo) and Thor-EN-Dashboard (the web); connected only by the DASH API

## Contributors / Developers

The code structure, per-domain architecture, and development guide are in [README.md → Project Structure](../README.md). Run `npm test` (from this repo's root) before committing — CI will reject code that fails the tests.
