# 📖 Admin Guide — Thor Bot v3.9.38

The complete guide for Discord server admins running this bot — suitable both for new admins doing their first setup and for experienced admins as a daily reference.

> 📜 Full history of all versions: [CHANGELOG.md](../CHANGELOG.md) · A summary of the latest versions is in [Section 11](#11-version-history).

---

## 🎯 Table of Contents

1. [Quick Start (5 minutes)](#1-quick-start-5-minutes)
2. [Initial Server Setup](#2-initial-server-setup)
3. [Product & VIP Management](#3-product--vip-management)
4. [Daily Operations (Tickets, Announce, Embed)](#4-daily-operations-tickets-announce-embed)
5. [Moderation (Warn System)](#5-moderation-warn-system)
6. [Engagement (Giveaway & Poll)](#6-engagement-giveaway--poll)
7. [Advanced Community Features](#7-advanced-community-features)
8. [Backup & Restore](#8-backup--restore)
9. [Troubleshooting](#9-troubleshooting)
10. [Best Practices](#10-best-practices)
11. [Version History](#11-version-history)

---

## 1. Quick Start (5 minutes)

### Prerequisites

- Node.js 18+ (the `engines` field in package.json requires >= 18)
- The bot has already been invited to the server with the permissions: **Manage Roles, Manage Channels, Send Messages, Embed Links, View Audit Log, Moderate Members, Move Members**
- **3 Privileged Intents** enabled in the Discord Developer Portal (https://discord.com/developers/applications → select the bot → **Bot** tab → scroll down to _Privileged Gateway Intents_):
    - ✅ **Server Members Intent** — for welcome/goodbye, auto-role, member sync
    - ✅ **Message Content Intent** — **REQUIRED** for the auto-responder, word/link anti-spam, and AFK mention replies. Without it, `message.content` is always empty → those features will not work.
    - ✅ Presence Intent — optional (not used yet)
- **The bot's role sits ABOVE** every role it will manage (Verified, Unverified, VIP, etc.)

### Install

```bash
npm install
cp .env.example .env
# Edit .env, fill in DISCORD_TOKEN and GUILD_ID
npm start
```

### Verify

- The console shows: `✅ Bot online as YourBot`
- The console shows: `✅ Slash Commands registered to guild: Your Server (instant!)`
- In Discord, type `/` — all **82 slash commands** must appear
- If a command doesn't show up, make sure `GUILD_ID` in `.env` is correct

---

## 2. Initial Server Setup

The order below is a **recommendation** for a new server. Skip any step you have already configured.

### Step 1: Set Roles

```
/set-role verified @Verified
/set-role unverified @Unverified
/set-role admin @Staff
```

**Explanation:**

- `verified` — the role a member receives after pressing the verification button
- `unverified` — the default role for new members (removed after verification)
- `admin` — the staff role that gets access to ticket channels + the admin panel
- Admin role changes take effect immediately (the cache is invalidated automatically)

### Step 2: Set Channels

```
/set-channel welcome #welcome
/set-channel goodbye #goodbye
/set-channel invoice #testimonials
/set-channel audit-log #audit-log
/set-channel transcript #transcript
```

**Explanation:**

- `welcome` — the channel where the bot posts the welcome message when a member joins
- `goodbye` — the channel where the bot posts the goodbye message when a member leaves / is kicked / is banned
- `invoice` — the transaction testimonial channel (filled in automatically on every Set Key / Deliver Order / Order Successful — **once per ticket**, never duplicated)
- `audit-log` — the channel where the bot records ALL admin actions (50 action types; automatically retried once if delivery fails due to rate limits/network)
- `transcript` — the ticket transcript archive channel (chat history is saved automatically every time a ticket is closed)

> 💡 Since v3.9.30 every channel is configured through **one command**, `/set-channel` — including transcript (previously a separate command, `/set-transcript-channel`). Remove one with `/remove-channel <type>`.

### Step 3: Install the Verification Panel

```
/setup-verify
```

The bot sends an embed + a "Verify Me" button to the channel where the command was run. A new member presses the button → they receive the Verified role + the Unverified role is removed.

**Recommendation:** install it in the `#information` or `#rules` channel, then pin the message.

### Step 4: Add Products to the Price List

```
/add-product label:"7 Days" value:7d price:"Rp. 25.000" duration:"7 Days"
/add-product label:"30 Days" value:30d price:"Rp. 80.000" duration:"30 Days"
/add-product label:"Permanent" value:perm price:"Rp. 250.000" duration:"Permanent"
```

**Rules:**

- `label` — the name shown to members
- `value` — unique ID (no spaces, e.g. `7d`, `30d`, `perm`)
- `price` — free-form string; can use the Indonesian format (`Rp. 50.000`) or a plain number
- `duration` — optional, informational only (it does not automatically become the role's expiry duration)
- Maximum of 25 products (Discord dropdown limit)

### Step 5: Set the Auto-Role for Each Product

For each product, define the role buyers will receive + the expiry duration:

```
/set-product-role value:7d role:@VIP 7 Days days:7
/set-product-role value:30d role:@VIP 30 Days days:30
/set-product-role value:perm role:@VIP Permanent days:0
```

**Rules:**

- `days:0` = permanent (the role is never removed automatically)
- `days:7` = the role is removed automatically after 7 days
- The bot's role must sit ABOVE the VIP role in the server settings

### Step 6: Install the Ticket Panel

```
/setup-ticket
```

The bot sends an embed + the 5 default buttons (Buy Key / Transaction, Help, Report, Claim Giveaway, 🤝 Midman / Escrow) to the channel where the command was run. The 🤝 Midman / Escrow button opens the escrow deal form (not a ticket — see the Midman / Escrow section). A member presses a button → the bot creates a private ticket channel.

**Recommendation:** install it in `#information` or a dedicated `#order-here` channel, then pin the message.

#### Custom Ticket Buttons & Categories

All ticket buttons are **100% dynamic** — they can be added, changed, and removed from Discord without touching code:

```
# View all categories
/list-categories

# Add a new category (example: a "Partnership" button)
/add-category id:partnership label:"Partnership" emoji:"🤝" style:"Primary" requires_key:false

# Update a category without delete + re-add
/update-category id:partnership label:"Kerjasama" emoji:"💼" style:"Success"

# Remove a category (except the defaults: transaction, help, report)
/remove-category id:claim_giveaway

# After changing categories, refresh the panels that are already installed:
/refresh-panel id:<panel-id>
```

**What `requires_key` means:**

- `requires_key: true` → products in this category use keys by default (product dropdown, 🔑 **Set Key** button). Examples: `transaction`, `lisensi_key`.
- `requires_key: false` → products in this category are keyless by default (product dropdown, 📦 **Deliver Order** button). Examples: `jasa`, `akun_ml`, `help`, `report`, `partnership`.

> **Classification rule (v3.9.28):** `requires_key` only decides the **button package** (Set Key vs Deliver Order). Channel routing **TRANSACTIONS vs SUPPORT** is decided by "whether the category has products", not by `requires_key`. Adding a new category (`akun_ml`, `lisensi_key`, `topup_diamond`, ...) is **automatically safe** — only the `help` / `report` categories and products flagged `isHelp` go to SUPPORT; every other category id is automatically TRANSACTIONS. Category ids are free-form as long as they match `[a-zA-Z0-9_-]{1,30}`. Verified by 14 dedicated unit tests (`tests/unit/newCategorySafety.test.js`).
>
> ⚠️ **Important:** transaction products that **do not carry** the `requires_key` flag (e.g. legacy products) are treated as **key-based** (Set Key button). For account/service products, make sure `requires_key:false` — the easiest way: set it on the **category**; every new product in that category inherits it automatically.

**Ticket behavior matrix:**

| Category scenario                       | Products in category   | Behavior                                                         |
| ---------------------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `transaction` (requires_key: true)       | Key-based products      | 🔑 dropdown → Set Key                                            |
| `transaction` (requires_key: true)       | Mixed key & non-key     | 🔑/📦 dropdown → Set Key for key products, Deliver Order for non-key |
| `jual_akun` (requires_key: false)        | Account/service products | 📦 dropdown → Deliver Order (no Set Key)                        |
| `akun_ml` (requires_key: false)          | Has products            | 📦 dropdown → Deliver Order                                      |
| `lisensi_key` (requires_key: true)       | Has products            | 🔑 dropdown → Set Key                                            |
| `help` / `report` / `partnership` etc.   | Empty                   | Ticket created directly (SUPPORT)                                |

> **Safety-net (v3.9.29):** `/setup-ticket-panel` & `/refresh-panel` show a **warning** if any category on the panel has no products yet — clicking an empty category button opens a SUPPORT ticket, not a transaction. Add at least 1 product via `/add-product` if the category is actually for selling. The `help`/`report` categories are not warned about (they are quick-actions by design); neither is `midman` (v3.9.37 — its button opens an escrow deal, not a ticket, so "no products" is not a problem).

**Example setup for a new category (verified safe by unit tests):**

```
# Selling ML accounts — keyless products (📦 Deliver Order button)
/add-category id:akun_ml label:"Akun ML" emoji:🎮 requires_key:false
/add-product label:"Akun ML Mythic" value:ml_mythic price:"Rp 150.000" category:akun_ml
#  ↑ requires_key left blank → inherits false from the category

# License keys — key-based products (🔑 Set Key button)
/add-category id:lisensi_key label:"Lisensi Key" emoji:🔑 requires_key:true
/add-product label:"Windows 11 Pro OEM" value:win11_pro price:"Rp 150.000" category:lisensi_key

# Refresh the panel so the new category shows up:
/refresh-panel id:<panel-id>
```

**Three setup approaches — pick whichever fits:**

- **Option 1 (simple):** all products (key + non-key) in the `transaction` category. Members choose from a single dropdown.
- **Option 2 (separate):** create a dedicated category (e.g. `jasa`, `akun_ml`) and fill it with its products. Members pick the category first → the product dropdown appears.
- **Option 3 (quick action):** a category without products (e.g. `claim_giveaway`, `partnership`) for quick access without product selection.

**Update an existing product:**

```
# Edit without delete + re-add — only the fields you fill in change
/update-product value:vip30 label:"VIP 30 Hari Promo" price:"Rp 40.000"

# Move a product to another category
/update-product value:joki category:jasa

# Change requires_key (from key-based to keyless, or the other way around)
/update-product value:joki requires_key:false
```

The Set Key button on old tickets keeps working after a rename (product lookup uses the stable `value`, not the label).

**Automatic migrations on bot start:**

- Label `"Bantuan Staff"` → `"Help"` (only if not customized)
- Label `"Laporkan Member"` → `"Report"` (only if not customized)
- The `claim_giveaway` category is added if it doesn't exist yet. If an admin removed it via `/remove-category`, the bot sets the `claimGiveawayDismissed` flag and **does not add it back**.

### Step 7: (Optional) Install a Self-Role Panel

For members who want to pick up roles on their own (e.g. game notification roles):

```
/setup-selfrole title:"Pick Your Game Notifications" description:"Click the role you want" type:button exclusive:false
/selfrole-add panel_id:sr_xxx role:@ML Notif label:"ML Notif" emoji:"🎮" style:Primary
/selfrole-add panel_id:sr_xxx role:@PUBG Notif label:"PUBG Notif" emoji:"🔫" style:Success
```

**Advanced `/selfrole-add` options:**

- `style` — button color: Primary (blurple), Secondary (gray), Success (green), Danger (red)
- `requires_role` — prerequisite role: the new role can only be picked up after the member already holds another role (useful for tiered roles)
- `type:select` on `/setup-selfrole` — uses a dropdown (neater for many roles)

### Step 8: Check the Configuration

```
/config-show
```

Shows an embed with the entire current setup: roles, channels, products, key stats, schedule stats, self-role panels.

---

## 3. Product & VIP Management

### Add a New Product

```
/add-product label:"60 Days" value:60d price:"Rp. 150.000" duration:"60 Days"
/set-product-role value:60d role:@VIP 60 Days days:60
```

### Update a Product (label / price / duration / category)

```
/update-product value:60d price:"Rp. 175.000"
/update-product value:60d label:"60 Days+" duration:"60 Days" category:transaction
```

All fields are optional — only the ones you fill in change. The Set Key button on old tickets keeps working after a rename (lookup uses the stable `value`).

### View All Products

```
/list-products
/list-product-roles
```

### Give a Key Manually (without a ticket)

For members who already paid via DM / a direct transfer:

```
/set-key user:@member value:30d key:ABCDE-12345-FGHIJ
```

The bot automatically:

1. Saves the key to `keys.json` (scoped per guild)
2. Grants the VIP role
3. Schedules the auto-removal (MAX EXTEND model)
4. DMs the member with the key + expiry info
5. Sends an invoice to the invoice channel
6. Records the purchase in stats
7. Writes the `SET_KEY` audit log — **the key is masked** (only `***` + length; the key value never leaks)

### View a Member's Keys

```
/list-keys user:@member
```

Shows all of the member's keys (active & expired) + the remaining time of each.

### Reset a Member's VIP (Full Reset)

For reset / refund cases:

```
/clear-schedule user:@member clear_keys:true
```

The bot will:

- Delete all of the user's role schedules (in this guild only)
- Delete ALL of the user's keys from `keys.json` (in this guild only)
- Remove all VIP roles tied to products

**Careful:** this cannot be undone. Use `clear_keys:false` if you only want to remove the schedules without deleting the keys.

---

## 4. Daily Operations (Tickets, Announce, Embed)

### Transaction Ticket Flow (the most used)

#### A. Key-based products (e.g. 30-day VIP)

1. The member presses **🛒 Buy Key / Transaction** on the ticket panel → picks a product (🔑)
2. The bot creates the private ticket channel `#ticket-{user-id}`
3. The member sends payment proof
4. An admin confirms → presses **🔑 Set Key** in the ticket
5. A modal appears → the admin types the key → submits
6. The bot automatically: saves the key, grants the role, schedules the expiry, DMs the member, sends the invoice
7. The ticket channel **stays open** (not deleted automatically) — the bot posts a short message saying "the key has been sent via DM". Admin & member can still ask questions first (e.g. how to use the key)
8. When everything is done, the admin presses **🔒 Close Ticket** → picks **✅ Done** → the bot saves the transcript to the transcript channel automatically, then deletes the channel

#### B. Keyless products (selling ML accounts, services, etc.)

1. Add the product with `requires_key:false`:

    ```
    /add-product label:"Akun ML Mythic" value:akun_ml price:"Rp 150.000" category:transaction requires_key:false
    ```

    (optional: `/set-product-role value:akun_ml role:@Customer days:0` for an auto-role)

2. The member picks the product (📦) in the dropdown → a TRANSACTION ticket is created with the **📦 Deliver Order** button
3. The member sends payment proof
4. An admin confirms → presses **📦 Deliver Order** → a modal appears → the admin types the order details (username/password/note — Enter = new line, max 1500 characters)
5. The bot automatically: **DMs the order details to the buyer** (the ticket channel is deleted at close — the DM becomes the buyer's only permanent copy), auto-role (+ auto-expire if `days` is set), records the purchase in stats/leaderboard, sends the invoice, writes the `ORDER_DELIVERED` audit log
6. The Close Ticket button becomes **✅ Done** → transcript + channel deletion

> **Alternative without Deliver Order:** the admin simply presses **🔒 Close Ticket → ✅ Order Successful** — role + stats + invoice still run automatically. Handy when the order is handed over in chat / isn't digital.

### DM Format & Ticket Notifications

The bot DMs the buyer in a mobile-friendly format — the key is written as inline code (a long-press in Discord mobile instantly brings up the **Copy** menu), using emojis and the role name (not a mention, because role mentions don't render in DMs).

**Example DM sent to the member:**

```
Hi thor064747! Your transaction is complete 🎉

📦 Product: 3 DAYS
🌐 Server: Chronos

🔑 KEY:
`Abgs-1828`

🎭 Role: VIP 3 Days
⏰ Expires: in 3 days

📋 Your active keys for this role:
1. `Test-1233` (3 days left)
2. `12345` (3 days left)
3. `Test-2910` (3 days left)
4. `Abgs-1828` (3 days left)

💡 Keep your key safe. If the role suddenly disappears while your key is still active, contact an admin.
```

**Example notification in the ticket channel (for the member, not admins):**

```
Hi @user! 🔑 Your key has been sent via DM, check it 📬
```

If the DM cannot be delivered (the member's DMs may be closed):

```
⚠️ @user — failed to send a DM (DMs may be closed). An admin will send you the key manually.
```

**Ticket operations tips:**

- Before pressing Set Key / Deliver Order, make sure the payment has actually arrived
- A key can be any free-form string, e.g. `ABCDE-12345-FGHIJ-67890`
- Order details are sent to the DM **exactly as typed** (unmodified) — passwords are not changed
- The invoice is sent automatically to the invoice channel — **once per ticket** (never duplicated)
- The transcript is saved automatically to the transcript channel when the ticket is closed
- Ticket metadata (userId, productName, price, isTransaction, requiresKey, isCompleted) is stored in `tickets.json` — not in the channel topic (anti spoof/edit)
- After a successful Set Key → the channel **stays open**; since `isCompleted=true`, closing the ticket shows only the "✅ Done" button (no "Purchase Cancelled")

### Closing a Ticket Without a Transaction

Press **🔒 Close Ticket** → pick **❌ Purchase Cancelled** → the ticket closes without any key/role.

### Quick Announce

```
/announce channel:#announcements title:"Maintenance Tomorrow" description:"Server maintenance at 03:00 WIB" color:#FF0000 mention:@everyone
```

**Valid mention formats:**

- `@everyone` or `everyone`
- `@here` or `here`
- `<@&ROLE_ID>` — role mention (copied from Discord)
- `<@USER_ID>` or `<@!USER_ID>` — user mention

Anything else is rejected with an error message — prevents admins from accidentally pinging everyone because of a typo.

### Interactive Embed Builder (for complex embeds)

```
/embed-builder
```

The bot sends a draft + dropdown. Click the dropdown → pick a section (Title/Description/Color/Image/etc.) → an input modal appears → the embed updates automatically (live preview). When you're done, click **📤 Send** → enter the target channel → send.

**Tips:**

- Embeds that have already been sent cannot be edited via the builder — delete manually and recreate
- Sessions are lost when the bot restarts; 1-hour TTL (auto-cleanup against memory leaks)
- Use `/embed-list` to see active sessions, `/embed-cancel` to cancel one
- Length validation: title (256), description (4096), field name (256), field value (1024) — anything over is rejected with a clear message

### Scheduled Announcement

```
/announce-schedule channel:#announcements title:"Weekend Event" description:"Starts 19:00 WIB" at:"2h" mention:@here
/announce-schedule channel:#info title:"Monthly Reset" description:"Top 10 get rewards" at:"2026-02-01 09:00" recurring:monthly
```

**`at` formats:**

- `30m` — 30 minutes from now
- `2h` — 2 hours from now
- `1d` — 1 day from now (max 365 days)
- `2026-01-15 20:00` — a specific date & time (format `YYYY-MM-DD HH:mm`, WIB; up to 5 years in the future)

**Recurring:** `daily`, `weekly`, `monthly` — the bot reschedules automatically after each send.

### View & Cancel Scheduled Announcements

```
/announce-list
/announce-cancel id:ann_xxx
```

### 🤝 Midman / Escrow (3-Party Escrow Deals)

A middleman service for member-to-member transactions: **buyer + seller + middleman** in one deal channel. The core of its security: the **Deal Board** (a bot embed) is the source of truth — chat is only the place for evidence (transfer screenshots, proof of delivery), and every step can only be moved by the party entitled to move it, via buttons.

**One-time setup (any order — all required before members can use it):**

```
/set-role midman @Midman          ← dedicated role for the escrow team (anyone holding this role can handle deals)
/set-midman-fee mode:percent value:5   ← 5% fee of the deal price (or mode:flat value:5000 for a fixed amount)
                                       the fee is ADDED on top of the price: a 100k deal + 5k fee → the buyer pays 105k, the seller receives the FULL 100k
/set-channel tipe:invoice #testimonials     ← successful deal invoices go here automatically (already set? skip)
/set-channel tipe:transcript #log           ← deal transcripts go here automatically (already set? skip)
/setup-ticket                          ← reinstall the panel — the 🤝 Midman / Escrow button appears automatically
```

**The deal flow (story version):**

1. **Anyone** (buyer, seller, or a helper — e.g. middleman/staff) clicks 🤝 Midman / Escrow on the panel → fills in the **3-step form**: (1) an item + price modal, (2) **pick the 🛒 buyer** from the member dropdown, (3) **pick the 🏷️ seller** — everyone just types the name into the search box (no need to copy IDs/mentions) → the bot creates a channel in the `🤝 ESCROW` category + the Deal Board.
2. **Buyer & seller** BOTH click **🤝 Agree to Deal** → only then are the item & price **LOCKED**. The board always shows who has agreed and who hasn't. Want changes = cancel and create a new deal.
3. The **buyer** transfers the **Total Payment** (price + fee — the amount is shown on the board) to the middleman, and posts proof in the channel. The **middleman** checks the account → clicks **✅ Funds Received**.
4. The **seller** sends the goods. The **buyer** checks them → clicks **✅ Goods Delivered**.
5. The **middleman** transfers the **FULL** amount to the seller as shown on the board (the fee stays with the middleman — nothing is deducted from the seller's funds) → clicks **💸 Release to Seller** → invoice + transcript + stats happen automatically, the channel closes.

**Adding / removing people in the deal channel (e.g. someone was added by mistake, or you need a witness):**

- The **👥 Add Member** button (Deal Board row 2 — middleman/admin only) → pick a user from the dropdown → they get view & chat access as an **extra member**. Observers CANNOT move the deal at all (transitions stay the right of buyer/seller/middleman/admin) — so it's safe for witnesses or staff in training.
- The **➖ Remove Member** button → the dropdown lists the current extra members → pick one → their access is removed. The buyer/seller **cannot** be removed this way (their involvement only ends via canceling the deal / a dispute).
- Every add/remove is recorded in the deal history (shown in the history summary at close), in the audit log, and in the **👀 Extra Members** field on the Deal Board — everyone in the channel knows who the guests are.

**If something goes wrong:** any participant clicks **⚠️ Report a Problem** → the deal is **FROZEN** (all buttons dead, admins pinged). An admin resolves it: **⚖️ Resolve: Release** (deal succeeds) or **↩️ Resolve: Refund** (funds go back to the buyer — the middleman must refund manually).

**Monitoring:** `/midman-deals` (lists all active deals + status), `/config-show` (the midman role + fee in place).

**What the bot enforces structurally (cannot be gamed):**

- Releasing before the goods are delivered → rejected. The buyer clicking "Funds Received" → rejected (not the middleman).
- Terms are locked ONLY after the buyer & seller agree **both** — no matter who created the deal, no single person can lock the terms alone.
- Every action during a dispute → dead. Only admins resolve.
- The fee comes from the config, not from typing — a middleman can't set arbitrary fees. The fee is added on top of the price (additive): the seller ALWAYS receives the full price; the buyer pays price + fee.
- Extra members (observers) cannot move the deal; the buyer/seller cannot be removed from their own deal.
- Every click is recorded: who, when, which event (deal history + audit log + summary before close).
- 1 active deal per person; a user with an active deal cannot open a regular ticket (anti-bypass).

**Don't want the escrow feature?** `/remove-category midman` — the button disappears from the panel and never comes back.

**Important note:** the bot does NOT hold the money — transfers stay manual, done by the middleman. The bot = ledger + sequence keeper + evidence recorder. Choose middlemen you trust; the bot makes sure every action they take is recorded.

---

## 5. Moderation (Warn System)

### Issue a Warning

```
/warn user:@member reason:"Spam in #general"
```

The bot will:

- Add the warning to `warns.json` (scoped per guild)
- DM the member with the reason + total warning count
- Take auto-action when a threshold is reached:
    - **3 warnings** → 1-hour mute (timeout)
    - **5 warnings** → 1-day mute (timeout)
    - **7 warnings** → kick from the server

**Note:** auto-actions are not repeated. If a member receives a 4th warning (after the 1-hour mute at the 3rd), the bot does not mute again — only the new thresholds (5, 7) trigger new actions.

### View Warning History

```
/warn-list user:@member
```

### Remove 1 Warning

```
/warn-remove user:@member warn_id:warn_xxx
```

### Remove ALL Warnings

```
/warn-clear user:@member
```

### Hierarchy Check

The bot rejects `/warn` if:

- An admin tries to warn themselves
- An admin tries to warn the bot
- An admin tries to warn a member whose role is at or above their own

---

## 6. Engagement (Giveaway & Poll)

### Create a Giveaway

```
/giveaway create channel:#giveaway prize:"VIP 30 Hari" duration:60 winners:1 required_role:@Verified
```

**Rules:**

- `duration` is in **minutes** (min 1)
- `winners` 1–20
- `required_role` optional — only members with that role can enter
- **Does NOT automatically ping `@everyone`** — if you want a ping, use a separate `/announce` or edit the giveaway message after it's created

The bot sends a giveaway embed + 🎉 Join / 🚪 Leave buttons. When it ends:

- The bot picks the winners (Fisher-Yates shuffle, uniform distribution)
- Edits the message to "ENDED"
- Announces the winners in the channel + DMs the winners
- Records everything in stats (Top Winner leaderboard)

**Anti double-join:** clicking Join too fast (a double-click < 100 ms) is rejected with a "Hold on, you are clicking too fast" message — prevents a participant from being registered twice.

### End a Giveaway Early

```
/giveaway end id:gw_xxx
```

The bot picks winners + updates the message + announces + DMs + records stats (same as auto-end). Guarded by a user lock — a double invoke won't produce duplicate announcements.

### Reroll a Winner

```
/giveaway reroll id:gw_xxx
```

The bot picks 1 new winner (excluding the old one), persists, announces, DMs, records stats.

### Create a Poll

```
/poll create channel:#polls question:"Event this weekend?" multiple:false
```

A modal appears → enter the options (1 per line, min 2, max 10). The bot sends a poll embed with one button per option. Members click → vote (toggle). The bar chart updates live.

**Modes:**

- `multiple:false` — single choice (picking another option automatically moves your vote)
- `multiple:true` — multi choice

**Anti double-vote:** clicks that are too fast are rejected (same as giveaways) so a double toggle can't wipe your vote.

### Close a Poll

```
/poll close id:poll_xxx
```

The bot disables all the buttons + shows the final results.

---

## 7. Advanced Community Features

### Auto-Responder

The bot replies automatically when a member types a trigger at the start of a message (case-insensitive).

```
/add-responder trigger:"!sosmed" reply:"Instagram: ig.com/ourserver\nYouTube: yt.com/@ourserver" reply_type:embed
/list-responder
/remove-responder trigger:"!sosmed"
```

- `reply_type`: `text` (plain) or `embed`
- Supports `\n` for multi-line
- Default 3-second per-user cooldown (configurable per responder, `0` = disabled)
- Max 50 responders per guild
- Anti mass-ping: mentions inside the reply don't trigger pings (`allowedMentions` locked down)

### Anti-Spam & Auto-Mod

```
/set-automod spam_action:mute_10m word_action:delete_only mention_action:warn
/automod-toggle enabled:true
/automod-show
/add-word words:"word1 word2" tipe:blocklist action:mute_10m
/remove-word word:word1
/list-words
/add-link-whitelist channel:#share-link
/remove-link-whitelist channel:#share-link
```

- **Spam**: N messages within a window (default 5/10 seconds) → action
- **Word filter**: add words one at a time, per-word action, exempt words, **whole-word** matching ("asu" doesn't match "asus")
- **Link block** + channel/role whitelist
- **Mass-mention** (default > 5 mentions/message)
- Actions: `delete_only`, `warn`, `mute_10m`, `mute_1h`, `kick`
- Admins & whitelisted users are automatically immune

### AFK System

```
/afk reason:"Sleeping\nDo not disturb"
/afk-clear
/afk-list
```

- When mentioned, the bot auto-replies with the reason + AFK duration (auto-deletes after 30 seconds)
- AFK auto-clears when the user sends another message (the bot greets them "welcome back")
- The reason supports multi-line `\n` and cannot mass-ping

### Leveling System

```
/setup-leveling enabled:true xp_per_message:15 cooldown:60 announce_levelup:true
/add-level-role level:10 role:@Active Member
/list-level-roles
/remove-level-role level:10
/rank
/leaderboard-level
```

- XP per message with a per-user cooldown (chat anti-spam)
- Automatic role rewards on level up (can be tiered)
- `/rank` shows a personal level card, `/leaderboard-level` the top 10

### Temp Voice

```
/setup-tempvoice channel:#Join For Voice
/tempvoice-remove
```

- A member joins the trigger channel → the bot creates a private voice channel (they automatically become the owner)
- Controls via panel: rename, lock, user limit, transfer ownership, delete
- Empty channels are deleted automatically; if the owner leaves → auto-transfer to the most senior member

### Multi-Panel Tickets + Customization

```
/setup-ticket-panel channel:#tickets title:"Click to order" body:"Prices:\n{price_list}" color:#ff5733
/list-panels
/update-panel id:tp_xxx field:thumbnail
/refresh-panel id:tp_xxx
/delete-panel id:tp_xxx
/set-channel transcript #transcript
```

- Multiple different panels in different channels, each one can filter categories (`categories:transaction,help`)
- Every field is customizable: title, body (supports the `{server}`, `{price_list}`, `{price_list:<category>}` templates + `\n`), color, image, thumbnail, footer, buttons/dropdown
- Registered panels persist in `data/panels.json` (included in backups)
- Ticket transcripts are saved automatically to the transcript channel before close

**Editing image/thumbnail via `/update-panel`:** enter the image URL in the modal that appears — the limit is **2048 characters** (the Discord embed URL limit; signed Discord CDN URLs are usually 300–450 characters). Leave the input empty to go back to the default. This also applies to `field:image`, `field:footer`, `field:title`, `field:body`, `field:color`.

**Empty-category safety-net:** `/setup-ticket-panel` & `/refresh-panel` show a warning if any category on the panel has no products yet — clicking its button opens a SUPPORT ticket, not a transaction. Add products via `/add-product` if the category is actually for selling.

### Editing Message Text (modal + newline)

```
/set-message tipe:welcomeBody teks:"Hello {user}\nWelcome to {server}"
/edit-message tipe:ticketBody
/list-messages
/reset-message tipe:welcomeBody
```

- Slash command inputs on PC **can't use Enter** (Enter = submit the form) — write `\n` for a new line
- `\n` is supported in: send-message, announce, announce-schedule, set-message (Body types), setup-ticket-panel, responder, afk, warn, selfrole
- In a **modal** (popup form), Enter produces a real new line — no `\n` needed
- ⚠️ **Title** types are intentionally not converted — Discord embed titles reject newlines (writing `\n` in a Title shows up literally)

---

## 8. Backup & Restore

### Manual Backup

```
/backup-now
```

The bot creates a `backups/YYYY-MM-DD_HH-mm-ss/` folder containing copies of **all 16 data files** from the `data/` folder: config, keys, scheduledRoles, selfRoles, giveaways, polls, warns, stats, scheduledAnns, tempVoice, tickets, automod, levels, responders, afk, panels.

### Auto-Backup

- On bot start: automatic backup
- Every 24 hours: automatic backup
- The 7 most recent backups are kept (older ones are auto-cleaned)

### View the Backup List

```
/backup-list
```

Shows all backups, including the `pre-restore_*` safety backups (if you have ever restored).

### Restore a Backup

```
/restore-backup name:2026-01-15_20-00-00
```

**Flow:**

1. The bot sends a confirmation embed with 2 buttons: **⚠️ Yes, Restore Now** and **❌ Cancel**
2. An admin presses the button → the restore runs
3. The bot automatically creates a `pre-restore_*` safety backup before overwriting (protection against restoring the wrong one)
4. After the restore finishes, every in-memory cache is reloaded automatically (stats, panels, permissions, automod, afk, responders, levels)
5. **Restarting the bot** (`Ctrl+C` then `npm start`) is still recommended for full consistency

**Protections:**

- 2-step confirmation — no more accidental restores from a typo
- Restore lock — if 2 admins press restore at the same time, only 1 runs
- Path traversal guard — backup names are validated (must not contain `..`, `/`, `\`)
- Pre-restore backups can be restored too

---

## 9. Troubleshooting

### Bot won't come online

- Check that `DISCORD_TOKEN` in `.env` is correct
- Check your internet connection
- Check the console for error messages

### Slash commands don't appear

- Check that `GUILD_ID` in `.env` is correct (the server ID, not a user ID)
- Check that the bot was invited to that server
- Wait 1–2 minutes for propagation
- If they still don't appear, fall back to global commands (clear `GUILD_ID`, wait ± 1 hour)

### Member doesn't get the role after Set Key

- Check that **the bot's role sits ABOVE** the VIP role in the server settings (drag the bot's role up)
- Check that the bot has the `Manage Roles` permission
- Check the console for a "Failed to add the role" error

### Welcome/Goodbye not sent

- Check that `config.channels.welcome` / `config.channels.goodbye` are set (via `/config-show`)
- Check that the bot has `Send Messages` + `Embed Links` in that channel
- Check that the channel still exists (not deleted)

### Auto-responder / anti-spam / AFK mention reply not working

**Most common cause: the Message Content Intent is not enabled.**

The bot needs access to `message.content`. Without that intent, Discord delivers the content as an **empty string** → triggers never match.

**How to fix:**

1. Open https://discord.com/developers/applications
2. Select your bot
3. **Bot** tab
4. Scroll down to the _Privileged Gateway Intents_ section
5. Enable all three intents:
    - ✅ PRESENCE INTENT
    - ✅ SERVER MEMBERS INTENT
    - ✅ **MESSAGE CONTENT INTENT** ← most important for these features
6. Click **Save Changes**
7. **Restart the bot** (`npm start`)

Also check `/list-responder` to make sure the responder is registered. Triggers are case-insensitive and must sit at the start of the message (`!sosmed` matches `!sosmed hello`, but not `hello !sosmed`).

### The auto-responder cooldown feels long

Default is 3 seconds per user. To change it:

```
/add-responder trigger:"!sosmed" reply:"..." cooldown:0    # 0 = disable the cooldown
/add-responder trigger:"!sosmed" reply:"..." cooldown:10   # 10 seconds
```

The cooldown is **per-user** — user A triggering it doesn't affect user B.

### Audit log not delivered

- Check that `config.channels['audit-log']` is set via `/set-channel audit-log #channel`
- Check that the bot has `Send Messages` + `Embed Links` + `View Audit Log` in that channel
- The audit log is automatically retried once if delivery fails due to rate limits/network

### Stats not updating

- Stats are cached in memory and flushed every 30 seconds — wait a moment, then check again
- If the bot just restarted, old stats are still in `stats.json`
- After a backup restore, the stats cache is reloaded automatically
- Check `/stats` for server-wide aggregates, `/my-stats` for personal ones

### Tickets can't be created

- Check that `config.roles.admin` is set via `/set-role admin @role`
- Check that the bot has the `Manage Channels` permission
- Check that the "🎫 TICKETS" category can be created (the server hasn't hit the 500-channel limit)
- A member can only have 1 active ticket at a time

### Giveaway doesn't auto-end

- The scheduler runs every 60 seconds — wait up to 1 minute past `endsAt`
- Check `giveaways.json` that the entry exists with `ended: false`
- Use `/giveaway end id:gw_xxx` for a manual force-end

### After a restore, the data is still old

- Caches are invalidated automatically after a restore; the other managers read from disk with a 15-second cache
- For full consistency, **restarting the bot** is still recommended

### "Hold on, you are clicking too fast" message

- Appears when a user double-clicks a button (giveaway/poll) within < 100 ms
- The lock releases automatically after 5 seconds — try clicking once more after 1 second

---

## 10. Best Practices

### Security

1. **Never share `DISCORD_TOKEN`** — anyone holding the token can control the bot
2. **Never commit `.env`** to git (already in `.gitignore`)
3. Don't commit the `backups/` folder either (it contains sensitive data)
4. Rotate the token periodically (every 1–2 months) in the Discord Developer Portal
5. Keep the admin role limited to people you trust
6. Check `#audit-log` regularly to detect abuse

### Performance

1. Don't add more than 100 products (slows down `/config-show` and the dropdowns)
2. Don't add more than 10 self-role panels (memory + complexity)
3. Take a manual backup before big maintenance: `/backup-now`
4. If the server has more than 10,000 members, consider migrating from JSON to SQLite

### Operations

1. **Always back up before** big config changes (`/backup-now`)
2. **Test on a small server** first when changing roles/channels
3. **Watch the audit log** — check `#audit-log` regularly
4. **Communicate to members** before maintenance: `/announce` or `/announce-schedule`
5. **Use `/config-show`** before troubleshooting — often the problem is an unset config

### Moderation

1. **Don't kick/ban right away** — use `/warn` first so there's a track record
2. **Give a clear reason** in `/warn reason:` — members need to know what they did wrong
3. **Check `/warn-list`** before escalating — the member may have old warnings that can be removed
4. **Automatic kick at threshold 7** — make sure members know the warning system before they get kicked

### Member Engagement

1. **Use `/leaderboard`** to highlight active members in announcements
2. **Run giveaways regularly** (weekly/monthly) to boost engagement
3. **Poll before big decisions** (events, rule changes) — members are more engaged
4. **Self-role panels** for personalization — members love picking their own roles

---

## 11. Version History

The full history of all versions (v3.9.0 – v3.9.39) is available in **[CHANGELOG.md](../CHANGELOG.md)**.

A summary of the latest versions:

- **v3.9.39** (2026-09-04) — 🚀 **/help redesigned into an interactive navigator** (user request: "find commands easily, no scrolling"): 🏠 compact home + 📂 dropdown with 19 categories + 🔍 **Search Commands** (button → keyword modal, or `/help search:<keyword>` directly) + 📖 All Commands (the old full list remains); all navigation edits ONE ephemeral message (no spam), stable customIds (old messages stay clickable after a restart); help content now has a single source of truth in `src/ui/helpCatalog.js` — add a category = 1 entry, dropdown/search/all follow automatically; +26 unit tests (82 commands, 412 unit tests).
- **v3.9.38** (2026-09-04) — 🛡️ full audit v3: **34 bugs/issues fixed across every domain** (escrow, tickets, data layer, automod, router). Highlights: escrow observer add/remove now respects the transition locks (no more stale-snapshot reverts), double-submit race on the 3-step deal form, ticket self-healing no longer deletes meta on transient errors, Set Key / Deliver Order / Order Success are now guarded by per-channel locks (no more double invoice/stats/keys), giveaway double-end fixed, `linkAllowedRoles` no longer whitelists the whole automod, `parsePriceNumber("1.5m")` no longer inflates 10×, ticket meta stores `productValue` (rename-safe), poll multi-choice unvote works, cooldown 0 = off for responder & leveling, bare-domain link detection (`discord.gg/xxx`), exempt words masked per occurrence, `/config-show` & `/announce-list` no longer crash on long lists, explicit timezone offset for `/announce-schedule` (env `TZ_OFFSET_HOURS`), transcripts paginate up to 1000 messages, `/set-role` validates assignable roles, `/help` auto-splits into 2 embeds above 5800 chars. +62 unit tests (82 commands, 386 unit tests).
- **v3.9.37** (2026-09-02) — 🐛 fixed **/help** (Auto-Split now 3 categories TRANSACTIONS/SUPPORT/ESCROW — user-reported bug "still 2"), Midman/Escrow section added, the embed version is now dynamic from package.json (no more stale); 🩹 full audit v2: **restore-backup no longer breaks escrow deals** (deals.json was missing from FILES_TO_BACKUP), **zombie deals are reconciled automatically** (channel deleted manually → buyer/seller freed from the lock, at startup + daily), the router's `ticket_cat:midman` is now an exact match (custom `midman_*` categories no longer die), deal sellers are now also checked for active tickets, the escrow panel dropdown descriptions & warnings are no longer misleading, MIDMAN_* audit labels, +12 unit tests (82 commands, 324 unit tests).
- **v3.9.36** (2026-09-02) — 🧹 code cleanup from the full audit: all 37 lint warnings cleaned to **0 errors 0 warnings**, dead code removed (duplicate formatTimeLeft, findOwnerVoiceChannel, the legacy save()), redundant variables/imports/requires tidied up, a warning-message typo fixed — no behavior changes, the 312 unit tests stayed green (82 commands, 312 unit tests).
- **v3.9.35** (2026-09-02) — 🐛 fixed the close-confirmation buttons for non-transaction tickets (support/help/report/claim/giveaway): the **❌ Close Without Completing** button was previously mis-wired to the same customId as **⏏️ Cancel Close** — so both buttons only canceled the close, and a ticket could never be closed as incomplete. That button now actually closes the ticket (transcript marked incomplete, channel deleted, meta cleaned up); "Cancel Close" consistently uses the same customId in every scenario; the old ephemeral confirmation buttons stay compatible (82 commands, 312 unit tests).
- **v3.9.34** (2026-09-02) — 🤝 escrow flow redesign: a deal can be opened by **anyone** (buyer/seller/helper) via a **3-step form** (item+price → pick buyer → pick seller, all through searchable dropdowns), **dual consent** (WAITING_AGREE state — buyer & seller both click Agree to Deal before the terms lock; old deals migrated automatically), **👥 Add Member / ➖ Remove Member** buttons on the Deal Board (middleman/admin; observers can only view & chat; the buyer/seller can't be removed; max 10), a new Deal Board field 👀 Extra Members, add/remove recorded in history + audit (82 commands, 305 unit tests).
- **v3.9.33** (2026-09-02) — 🤝 escrow revision: the seller is picked via a **member dropdown** (searchable — no copying IDs/mentions; creating a deal becomes 2 steps), **additive fee** (added on top of the price — the seller always receives the full price, e.g. 100k + 5% = the buyer pays 105k), the Deal Board shows `Total Paid by Buyer` + `Received by Seller` (full amount), invoice/stats record the buyer's real spending (price+fee), the fee is snapshotted into the deal (config changes don't affect running deals), `parseSellerInput` removed (82 commands, 291 unit tests).
- **v3.9.32** (2026-09-02) — 🤝 new **Midman/Escrow** feature: 3-party escrow deals with a Deal Board + state machine (dual gates for funds/goods), dispute & admin resolve, automatic fee from the config, integrated invoice/transcript/audit, `/set-midman-fee` + `/midman-deals`, automatic panel category (82 commands, 289 unit tests).
- **v3.9.31** (2026-09-01) — hardening from a code review: orphan meta on close, channel null-safety, a clear-schedule snapshot, +10 unit tests.
- **v3.9.30** (2026-09-01) — `/set-transcript-channel` merged into `/set-channel tipe:transcript` — one command for all channels (80 commands total); `/remove-channel` & `/config-show` now support transcript too.
- **v3.9.28** (2026-09-01) — new categories are automatically safe (`classifyProduct()`): every category id other than `help`/`report` is automatically TRANSACTIONS; fixed the mixed-category dropdown description.

---

## 📞 Support

If you hit a problem that isn't in Troubleshooting:

1. **Check the bot's console output** — error messages are usually there
2. **Check `/config-show`** — make sure all settings are correct
3. **Check `#audit-log`** — look at the last action that may have caused the problem
4. **Check the JSON files** in the `data/` folder — whether the format is valid (they open in any text editor). If you find a `*.corrupt-<timestamp>` file, that's a file that failed to parse and was automatically quarantined by the bot — its contents can be inspected/recovered manually before you rename it back.
5. **Back up first** (`/backup-now`) before debugging further

---

**Document version:** v3.9.38
**Last updated:** September 4, 2026
**Bot version:** 3.9.38 · 82 slash commands · 386 unit tests
