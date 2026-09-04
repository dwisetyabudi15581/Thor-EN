# 🤖 Thor — All-in-One Discord Community Bot

A versatile Discord bot for any community — shop servers, gaming, content creators, and general communities alike. Everything is configured directly from Discord via slash commands, with no files to edit.

> **v3.9.41** · 82 slash commands · 433 unit tests · discord.js v14 · Node.js 18+ · single-guild
>
> 📖 **[Complete Admin Guide](./docs/ADMIN_GUIDE.md)** — setup, daily operations, troubleshooting
> 📜 **[Changelog](./CHANGELOG.md)** — history of every version

---

## ✨ Key Features

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

### 💬 Auto-Responder & AFK

- Keyword triggers (`!sosmed`, `!jadwal`, ...) → automatic reply as plain text or an embed, with a per-user cooldown.
- AFK system: auto-reply when mentioned, auto-clear when the user returns, `/afk-list` for admins.

### 📊 Leveling & Stats

- XP per message (anti-spam cooldown) + role rewards per level + `/rank` + `/leaderboard-level`.
- Server stats & leaderboards: messages, purchases, totalSpent, giveawaysWon.

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
├── tests/unit/                   # 433 unit tests (node:test)
├── CHANGELOG.md                  # Version history
├── .env.example
├── eslint.config.js
└── .prettierrc.json
```

---

## 🚀 Setup

### Prerequisites

- Node.js v18+ (v20+ recommended)
- A Discord bot token ([how to get one](https://discord.com/developers/applications))
- **3 Privileged Intents** enabled in the Discord Developer Portal (**Bot** tab → _Privileged Gateway Intents_):
    - ✅ **Server Members Intent** — for welcome/goodbye messages and auto-role
    - ✅ **Message Content Intent** — **REQUIRED** for the auto-responder, word/link anti-spam, and AFK mention replies. Without this intent, `message.content` is always empty and those features will not work.
    - ✅ Presence Intent — optional
- The bot invited to the target server with these permissions: `Manage Roles`, `Manage Channels`, `Send Messages`, `Embed Links`, `View Audit Log`, `Moderate Members`, `Move Members`
- The bot's role placed **above** every role it manages

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/dwisetyabudi15581/Thor.git
cd Thor

# 2. Install dependencies
npm install

# 3. Set up the environment
cp .env.example .env
# Fill in .env:
#   DISCORD_TOKEN=your_bot_token
#   GUILD_ID=your_discord_server_id

# 4. Run the bot
npm start
```

Slash commands register instantly to the guild set in `GUILD_ID`. For development with auto-restart: `npm run dev`.

### Initial Configuration (once the bot is online)

1. `/set-role admin @role` — the bot's admin role
2. `/set-role verified @role` — the verified member role
3. `/set-role unverified @role` — the default role for new members
4. `/set-channel welcome #channel` — the welcome channel
5. `/set-channel goodbye #channel` — the goodbye channel
6. `/set-channel invoice #channel` — the invoice/testimonial channel
7. `/set-channel audit-log #channel` — the audit log channel
8. `/set-channel transcript #channel` — the ticket transcript archive channel (optional)
9. `/setup-verify` — install the verification panel
10. `/setup-ticket` — install the ticket panel
11. `/config-show` — verify all settings

The complete guide — including product examples, custom categories, and daily operations — is here: **[docs/ADMIN_GUIDE.md](./docs/ADMIN_GUIDE.md)**.

---

## 🧪 Development

| Script           | Description                     |
| ---------------- | ------------------------------- |
| `npm start`      | Run the bot                     |
| `npm run dev`    | Run with nodemon (auto-restart) |
| `npm test`       | Run all unit tests (433 tests)  |
| `npm run lint`   | ESLint check                    |
| `npm run format` | Prettier format all files       |

Tests use the `node:test` runner built into Node.js v18+ — no extra dependencies needed. All tests run in a sandbox (snapshot/restore), so they are safe to run on a live server. CI (GitHub Actions) runs lint + tests on every push for Node 18/20/22.

---

## 🛡️ Security

- **Discord token** lives only in `.env` (gitignored) — never commit it.
- **Atomic writes** — every JSON file is written through `safeWriteJSON` (tmp+rename), preventing corruption on crash or power loss.
- **Corrupt file quarantine** — data files that fail to parse are renamed to `.corrupt-<ts>` and never silently overwritten.
- **TOCTOU guard** — `userLock` prevents double-processing when a user double-clicks.
- **Audit log** — keys are always masked; every admin action is recorded.
- **Guild-scoped data** — keys, warnings, stats, and config are scoped per guild (single-guild bot, with a `GUILD_ID` guard on every event).

---

## 🆘 Troubleshooting

### The bot won't come online

Check `DISCORD_TOKEN` in `.env` and make sure the bot has been invited to the server whose ID is `GUILD_ID`.

### Slash commands don't appear

Make sure `GUILD_ID` is correct (the server ID, not a user ID) and that the bot is a member of that guild. Restart the bot — re-registration is instant.

### Permission errors

The bot's role must be **above** the roles it manages, and the bot needs the permissions listed in the Prerequisites section.

### Auto-responder / anti-spam / AFK not working

The most common cause: the **Message Content Intent** is not enabled.

1. Open https://discord.com/developers/applications → select the bot
2. **Bot** tab → _Privileged Gateway Intents_
3. Enable **MESSAGE CONTENT INTENT** (and SERVER MEMBERS INTENT if it isn't already)
4. Save Changes → restart the bot

If the bot console shows a warning like `⚠️ [HINT] Message from ... has empty content`, the intent is indeed not active yet.

For full troubleshooting (tickets, roles, stats, backups, etc.): **[docs/ADMIN_GUIDE.md → Section 9](./docs/ADMIN_GUIDE.md)**.

---

## 📝 License

MIT — free to use, modify, and distribute. See [LICENSE](./LICENSE).
