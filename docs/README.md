# 📚 Documentation — Thor Bot

The official documentation set for **Thor — All-in-One Discord Community Bot** (v3.9.42).

| Document                           | Contents                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [README.md](../README.md)          | Project overview: features, installation, initial configuration, development, basic troubleshooting                                           |
| [ADMIN_GUIDE.md](./ADMIN_GUIDE.md) | Complete admin guide: server setup, product & VIP management, daily operations, moderation, backup & restore, troubleshooting, best practices |
| [CHANGELOG.md](../CHANGELOG.md)    | Full history of every version (v3.9.0 – v3.9.42)                                                                                              |

## Quick Start

- **New admin?** Read [ADMIN_GUIDE → Section 1 (5-Minute Quick Start)](./ADMIN_GUIDE.md#1-quick-start-5-minutes), then follow [Section 2 (Initial Server Setup)](./ADMIN_GUIDE.md#2-initial-server-setup) step by step.
- **Selling things (key products / accounts / services)?** Focus on [Section 2 Step 6](./ADMIN_GUIDE.md#step-6-install-the-ticket-panel) (ticket panels & categories) and [Section 4](./ADMIN_GUIDE.md#4-daily-operations-tickets-announce-embed) (the daily transaction flow).
- **Bot misbehaving?** Start with [README → Troubleshooting](../README.md) for common cases, or [ADMIN_GUIDE → Section 9](./ADMIN_GUIDE.md#9-troubleshooting) for the full list.
- **Curious what changed?** See the [CHANGELOG](../CHANGELOG.md), or the summary of the last 3 versions in [ADMIN_GUIDE → Section 11](./ADMIN_GUIDE.md#11-version-history).

## Project Statistics

- **82 slash commands** — every feature is configurable from Discord, no file editing
- **436 unit tests** — `node:test`, sandboxed (safe to run on a live server)
- **discord.js v14** · Node.js 18+ · single-guild
- **CI/CD** — GitHub Actions runs lint + tests on every push (Node 18/20/22)

## Contributors / Developers

The code structure, per-domain architecture, and development guide are in [README.md → Project Structure](../README.md). Run `npm test` before committing — CI will reject code that fails the tests.
