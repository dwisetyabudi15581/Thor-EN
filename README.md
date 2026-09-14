# 🤖 Thor — All-in-One Discord Community Bot

A versatile Discord bot for any community — shop servers, gaming, content creators, and general communities alike. Everything is configured directly from Discord via slash commands, with no files to edit.

> **v3.20.0** · 93 slash commands (+ unlimited custom commands from the web) · 693 unit tests · discord.js v14 · Node.js 20+ · single-server / public mode (Dyno-style) · **100% FREE — every feature unlocked** · **+ web dashboard INSIDE THIS REPO**
>
> 📖 **[Complete Admin Guide](./docs/ADMIN_GUIDE.md)** — setup, daily operations, troubleshooting
> 📜 **[Changelog](./CHANGELOG.md)** — history of every version

---

## ✨ Key Features

### 🌐 Web Dashboard (Dyno-style) — v3.21.0: Quick Start + Custom Commands + Embed Builder + 20 Modules

- **The web dashboard now lives INSIDE THIS REPO** (the `dashboard/` folder — Next.js 16 + Prisma SQLite, slimmed to 12 runtime packages). Clone once → `./setup.sh` → `./start.sh` — the bot and the web run together, no separate repository.
- **Two ways to configure the bot**: directly via **slash commands** in Discord, or via the **web dashboard** — both write to ONE shared data source (`data/config/<guildId>.json`), so they can never conflict.
- **🧩 Command Manager, Dyno-style (v3.19.0)** — enable/disable **each slash command per server** from the web (search + groups + bulk actions) or from Discord (`/commands list|toggle|enable-all`). Disabled commands are rejected with a clear message; `/commands` itself is disable-proof so admins can never lock themselves out.
- **🪄 Custom Commands, Dyno-style (v3.20.0)** — **build your own slash command on the web**: name, description, text + embed reply, ephemeral option. Once saved the command is **automatically registered on Discord** and every member can use it (max 20 per server). Temporarily disable via the Command Manager, delete anytime — automatic two-way sync.
- **✏️ Full Embed Builder (v3.20.0)** — complete parity with `/embed-builder`: outer text, author, fields (inline/full + reorder), thumbnail, image, footer, timestamp — with a **Discord-style live preview** before sending to any channel.
- **🚀 Quick Start from the web (v3.21.0)** — mirrors the 🚀 category in `/help`: a 6-step server setup checklist right in the dashboard (admin & verified roles — **pick from the list or paste the ID into a text field**, categories & products + quick product add, install ticket & verification panels to a channel, log channel). Every form is applied by the bot to the server instantly; X/6 progress bar; unconfigured servers auto-land on this module.
- **20 dashboard modules** (v3.21.0, up from 11): + **Quick Start**, **Command Manager**, **Custom Command**, **Backup** (create/restore from the web), **Moderation** (warn + moderator action history), **VIP Keys** (grant product keys + auto-expiry), **Giveaway** (start from the web), **Embed** (full builder + preview), **Poll** (interactive polling).
- **Built-in DASH API** (`src/infra/dashServer.js`): a small HTTP API on `127.0.0.1:8788` with a secret token (`DASH_API_TOKEN`) — read/written by the web dashboard for all the modules above.
- **Access is enforced by Discord**: users only see servers where they hold the **Manage Server** permission; every write is validated by the bot (section whitelist + prototype-pollution guard) and the acting user is recorded.
- **100% FREE bot** (v3.17.0): every feature is open to everyone — no tiers, no subscription, no bot activation key.

```bash
./setup.sh   # install bot + dashboard + prepare both .env files
./start.sh   # production: bot + dashboard in one run (Ctrl+C stops both)
./dev.sh     # development: nodemon (bot) + next dev (web) hot-reload
```

> 📱 **Android phone (Termux)?** The bot + dashboard run fully on a phone — the build automatically switches to Webpack and user storage to JSON. Full steps: see the **"Running on an Android phone (Termux)"** section in [DEPLOY.md](DEPLOY.md).

Full details (Discord OAuth login, pm2, domain + HTTPS): **[DEPLOY.md](./DEPLOY.md)** · dashboard docs: **[dashboard/README.md](./dashboard/README.md)**

### 🎫 Tickets & Transactions

- **Multi-category & multi-panel ticket panels** — categories and products can be added, updated, and deleted entirely from Discord (full CRUD, no code edits).
- **Safe automatic custom categories** — any category id (`akun_ml`, `lisensi_key`, `jasa`, `topup`, ...) is automatically classified as a TRANSACTION; only `help`/`report` become SUPPORT.
- **Two transaction flows**: key-based products (**🔑 Set Key**) and non-key products such as accounts or services (**📦 Deliver Order** — order details are sent to the buyer via DM).
- **Automatic invoice** to the testimonial channel (once per ticket) + **automatic transcript** saved before the ticket channel is deleted.
- **🤝 Midman / Escrow — 3-party escrow deal** (known as _rekber_ in Indonesia) — buyer, seller, and middleman in a single deal channel with a **Deal Board** (the source-of-truth embed) and a **state machine**: funds received (confirmed by the middleman) → goods delivered (confirmed by the buyer) → release (middleman). A dispute freezes the deal, and only an admin can resolve it. **Anyone can open a deal** (the buyer, the seller, or a helper) through a **3-step form** (item + price → pick the buyer → pick the seller, all via searchable dropdowns), and **terms are locked only after both the buyer and the seller agree**. The **👥 Add Member / ➖ Remove Member** buttons manage extra members inside the deal channel (they can only view & chat; they cannot move the deal forward). **The fee is added on top of the price** (the seller always receives the full price; the buyer pays price + fee), every button click is recorded in the deal history, and invoice/transcript/audit log are fully integrated.

### 🔑 Products & VIP (Key-Driven)

- Products with a category, a price, and a `requires_key` flag (inherited from the category down to the product).
- Key-driven VIP roles using the **MAX EXTEND** model — the role follows the key with the most time remaining; auto-expire is scheduled.
- A successful Set Key → store the key, grant the role, DM the member, send the invoice, record stats — all automatic.
- Keys are always **masked** in the audit log (the value never leaks).

### 🛡️ Anti-Spam & Auto-Mod

- Spam detection (N messages within a window → action) + mass-mention blocking.
- Link blocking with a channel/role whitelist.
- **Flexible word filter**: add words one at a time (`/add-word`), per-word actions, exempt words, and **whole-word** matching ("asu" does not match "asus").

### ⚔️ Direct Moderation

- **`/timeout` `/untimeout`** — temporary mute (minutes → max 28 days) with a reason DM to the member.
- **`/purge`** — bulk delete 1–100 messages (per-user filter, >14-day-old messages skipped automatically per the API limit).
- **`/kick` `/ban` `/unban`** — heavy actions recorded in the user's history (`/warn-list`), without double punishment.
- **Two-way hierarchy guards** — the moderator's & bot's roles must be higher than the target's; commands can be granted to non-admin moderators (Discord permissions, least privilege).
- **Server Log** — message delete/edit (content + by whom), bulk purge, join/leave (account age, kicks detected), ban/unban (including manual ones from the Discord UI), role & nickname changes → a separate `server-log` channel.

### 💬 Auto-Responder & AFK

- Keyword triggers (`beli`, `!sosmed`, ...) → automatic reply as plain text or an embed, with a per-user cooldown. Two match modes (v3.9.47): **contains** (default — the trigger matches as a whole word anywhere in the message, e.g. `beli` answers "bagaimana cara beli") or **exact** (the message must start with the trigger).
- AFK system: auto-reply when mentioned, auto-clear when the user returns, `/afk-list` for admins.

### 📊 Leveling & Stats

- XP per message (anti-spam cooldown) + role rewards per level + `/rank` + `/leaderboard-level`.
- Server stats: live member count, boosts, open tickets (straight from Discord) + tracked activity & transactions. **Live counter channels** (`/serverstats`) — the channel names themselves are auto-updating counters (members, bots, boosts, roles, channels — **pick which ones to show** via boolean options), rate-limit safe. Leaderboards by messages/purchases/spending/wins; `/my-stats` shows the real join date. **`/help` category views are full per-command guides** — syntax, behavior + the answers to the most common questions, so members stop asking.
- **Server Boosters:** boost add/remove notifications to a dedicated booster channel + offline catch-up + public `/boosters` list (live roster + recent boost history) + **`/test-booster`** — simulate a boost add/remove to test the notification chain end-to-end (pure simulation, nothing recorded) + **booster auto role** — `/set-role booster @role` grants the role automatically when a member boosts (applied retroactively to existing boosters) and removes it when the boost ends.

### 🎭 And More

- **Verification** — customizable button (label, emoji, style), automatic Unverified → Verified role swap.
- **Self-Role** — button/select panels, exclusive/multi mode, tiered prerequisite roles.
- **Temp Voice** — automatic private voice channel + control panel (rename, kick, limit, lock, transfer).
- **Giveaway** — required role, multiple winners, reroll, per-user lock against double-joining.
- **Poll** — live bar chart, single/multi choice, vote toggle.
- **Announce** — quick embed, scheduled (one-shot & recurring daily/weekly/monthly), plus an interactive embed builder with live preview.
- **Warn system** — automatic actions: 3 warnings → 1-hour mute, 5 → 24-hour mute, 7 → kick.
- **Backup** — automatic every 24 hours and on startup, max 7 backups, restore with 2-step confirmation + safety backup.
- **Audit log** — every admin action is logged to a dedicated channel (63 action types, automatic retry).

---

## 📁 Project Structure

```
Thor/
├── index.js                      # Entry point
├── .github/workflows/ci.yml      # GitHub Actions: lint + test (Node 18/20/22)
├── src/
│   ├── bot/events/               # Discord event handlers
│   ├── commands/                 # Slash command handlers (per-domain)
│   ├── interactions/             # Button/select/modal handlers (per-domain)
│   ├── data/                     # JSON persistence layer (18 managers)
│   ├── services/                 # Business logic (scheduler, etc.)
│   ├── ui/                       # Embed/panel builders
│   └── infra/                    # safeWrite, safeReply, userLock, permissions, auditLog
├── data/                         # Runtime JSON files (gitignored)
├── docs/                         # ADMIN_GUIDE + document index
├── tests/unit/                   # 693 unit tests (node:test)
├── dashboard/                    # 🌐 Next.js web dashboard (v3.20.0 — one repo)
├── setup.sh · start.sh · dev.sh  # Install & run the bot + web together
├── ecosystem.config.cjs          # pm2: thor-bot + thor-dash 24/7
├── CHANGELOG.md                  # Version history
├── .env.example
├── eslint.config.js
└── .prettierrc.json
```

---

## 🚀 Setup

### Prerequisites

- Node.js v20+ (the bot alone runs on 18+, but the bundled web dashboard requires 20+)
- A Discord bot token ([how to get one](https://discord.com/developers/applications))
- **3 Privileged Intents** enabled in the Discord Developer Portal (**Bot** tab → _Privileged Gateway Intents_):
    - ✅ **Server Members Intent** — for welcome/goodbye messages and auto-role
    - ✅ **Message Content Intent** — **REQUIRED** for the auto-responder, word/link anti-spam, and AFK mention replies. Without this intent, `message.content` is always empty and those features will not work.
    - ✅ Presence Intent — optional
- The bot invited to the target server with these permissions: `Manage Roles`, `Manage Channels`, `Send Messages`, `Embed Links`, `View Audit Log`, `Moderate Members`, `Move Members`
- The bot's role placed **above** every role it manages

### Installation

```bash
# 1. Clone the repo (bot + web dashboard in ONE repo)
git clone https://github.com/dwisetyabudi15581/Thor-EN.git
cd Thor-EN

# 2. Install EVERYTHING (bot + dashboard + both .env files from examples)
./setup.sh

# 3. Fill in the environment
nano .env             # DISCORD_TOKEN + GUILD_ID (empty = public Dyno-style mode) + DASH_API_TOKEN
nano dashboard/.env   # Discord OAuth + DASH_API_TOKEN (the SAME as the bot's .env)

# 4. Run the bot + dashboard together
./start.sh            # or ./dev.sh for development
```

Slash commands register instantly to the guild set in `GUILD_ID`. When `GUILD_ID` is left empty, the bot runs in **public Dyno-style mode**: commands are registered globally and appear automatically in every server that invites the bot (~1 hour propagation) — no manual guild id anywhere. For development with auto-restart: `npm run dev`.

### Initial Configuration (once the bot is online)

1. `/set-role admin @role` — the bot's admin role
2. `/set-role verified @role` — the verified member role
3. `/set-role unverified @role` — the default role for new members
4. `/set-channel welcome #channel` — the welcome channel
5. `/set-channel goodbye #channel` — the goodbye channel
6. `/test-welcome tipe:welcome` — verify the welcome works (diagnostics + live preview)
7. `/set-channel invoice #channel` — the invoice/testimonial channel
8. `/set-channel audit-log #channel` — the audit log channel
9. `/set-channel transcript #channel` — the ticket transcript archive channel (optional)
10. `/set-channel server-booster #channel` — boost notifications (optional — `/boosters` works without it)
11. `/set-role booster @Booster` — booster auto role: granted while boosting, removed when the boost ends (optional — applied right away to existing boosters; `/test-booster` can check the chain)
12. `/serverstats setup` — live counter channels (optional — `👥 Members: 123` style counters at the top of the channel list, auto-updating; pick which counters to show via the `members`/`bots`/`boosts`/`roles`/`channels` boolean options)
13. `/setup-verify` — install the verification panel
14. `/setup-ticket` — install the ticket panel
15. `/config-show` — verify all settings

The complete guide — including product examples, custom categories, and daily operations — is here: **[docs/ADMIN_GUIDE.md](./docs/ADMIN_GUIDE.md)**.

---

## 🧪 Development

| Script             | Description                                        |
| ------------------ | -------------------------------------------------- |
| `npm start`        | Run the bot                                        |
| `npm run dev`      | Run with nodemon (auto-restart)                    |
| `npm test`         | Run all unit tests (693 tests)                     |
| `npm run lint`     | ESLint check                                       |
| `npm run format`   | Prettier format all files                          |
| `./setup.sh`       | Install bot + dashboard + prepare both .env files  |
| `./start.sh`       | Production: bot + web dashboard together           |
| `./dev.sh`         | Development: nodemon + next dev together           |
| `npm run dash:dev` | Web dashboard only (next dev :3000)                |
| `npm run dash:mock`| Dashboard + a mock DASH API (demo data, no bot)    |

Tests use the `node:test` runner built into Node.js — no extra dependencies needed. All tests run in a sandbox (snapshot/restore), so they are safe to run on a live server. CI (GitHub Actions) runs lint + tests on every push for Node 18/20/22.

---

## 🛡️ Security

- **Discord token** lives only in `.env` (gitignored) — never commit it.
- **Atomic writes** — every JSON file is written through `safeWriteJSON` (tmp+rename), preventing corruption on crash or power loss.
- **Corrupt file quarantine** — data files that fail to parse are renamed to `.corrupt-<ts>` and never silently overwritten.
- **TOCTOU guard** — `userLock` prevents double-processing when a user double-clicks.
- **Audit log** — keys are always masked; every admin action is recorded.
- **Single-server / public mode — ONE `GUILD_ID` variable (v3.12.0)** — `GUILD_ID` set: instant commands + events from other servers ignored (insurance in case the bot is accidentally invited). `GUILD_ID` empty: **public Dyno-style mode** — global commands appear automatically in every server that invites the bot, and configs are isolated per-server (`data/config/<guildId>.json`) so server A's admin can never overwrite server B's settings. Guide to opening the bot to the public: [docs/ADMIN_GUIDE.md → Public Mode](./docs/ADMIN_GUIDE.md).

---

## 🆘 Troubleshooting

### The bot won't come online

Check `DISCORD_TOKEN` in `.env` and make sure the bot has been invited to the server whose ID is `GUILD_ID`.

### Slash commands don't appear

Make sure `GUILD_ID` is correct (the server ID, not a user ID) and that the bot is a member of that guild. Restart the bot — re-registration is instant. Note: when `GUILD_ID` is empty (public mode), GLOBAL registration needs ~1 hour of Discord propagation — commands are not instant there, which is normal.

### Permission errors

The bot's role must be **above** the roles it manages, and the bot needs the permissions listed in the Prerequisites section.

### Auto-responder / anti-spam / AFK not working

The most common cause: the **Message Content Intent** is not enabled.

1. Open https://discord.com/developers/applications → select the bot
2. **Bot** tab → _Privileged Gateway Intents_
3. Enable **MESSAGE CONTENT INTENT** (and SERVER MEMBERS INTENT if it isn't already)
4. Save Changes → restart the bot

If the bot console shows a warning like `⚠️ [HINT] Message from ... has empty content`, the intent is indeed not active yet.

### Welcome / goodbye message doesn't appear

Run **`/test-welcome tipe:welcome`** — it diagnoses every link in the chain (channel configured? channel still exists? bot permissions in it?) and sends a live preview. Since v3.9.48 the bot also **says why** in the console on every join that gets skipped (channel not set / not found / send failed), and checks the configuration at startup. The GuildMembers intent is not the cause here — an online bot proves it is ON (a disabled privileged intent crashes the login).

### Total revenue doesn't move when I sell

**The aggregate "Total Revenue" line was REMOVED from `/stats` in v3.9.51** (user request — it was never going to match manual bookkeeping). Personal spending per member is still tracked and visible in `/my-stats` ("Total Spent") and `/leaderboard` ("Top Spender"). Since v3.9.49/50 the price parsers understand Indonesian suffixes (`25rb` = 25.000, `2jt`/`2juta` = 2.000.000) and dual-currency (`3$ USD | Rp. 25.000` records **Rp 25.000 per sale**); since **v3.9.54 prices are currency-AGNOSTIC** — ANY marker works (`$3`, `€25`, `¥1000`, `₩25,000`, `25 usd`, `IDR 30.000`…), USD-only is no longer rejected, and `/add-product` **rejects** only genuinely unreadable strings (with the accepted-format list) — so what IS tracked is recorded correctly. Since **v3.9.55 decimal prices keep their cents** — with a non-Rp marker `$2.5` / `$2.50` → 2.5 and `$9.99` → 9.99 — and since **v3.9.57 MARKER-LESS decimals are valid too** (`5.88` → 5.88, `5,88` → 5.88; "5.88" used to read as 588), while a 3-digit dot group stays thousands (`50.000` → 50.000); escrow deal amounts remain whole-numbers-only by design. Stats and escrow show plain locale numbers (no hardcoded `Rp`). Personal spending counts ticket orders + escrow completions (price + fee) processed **through the bot** — manual sales outside tickets/deals are not tracked.

For full troubleshooting (tickets, roles, stats, backups, etc.): **[docs/ADMIN_GUIDE.md → Section 9](./docs/ADMIN_GUIDE.md)**.

---

## 📝 License

MIT — free to use, modify, and distribute. See [LICENSE](./LICENSE).
