/**
 * Help Catalog — single source of truth for /help content (v3.9.44).
 *
 * v3.9.44 REDESIGN (user request: "/warn lives under Scheduled Announce —
 * please read & sync every feature, reorganize so it is easy to
 * understand"):
 *   - /warn* MOVED to the Moderation category (it used to sit under
 *     "Scheduled Announce & Warn" — illogical). Moderation is now one
 *     place: warn → timeout → kick → ban + purge.
 *   - 20 categories ordered by how often they are used: 🚀 Quick Start
 *     (NEW — setup order for a fresh server) → Moderation → commerce
 *     (products, keys, panels, categories, escrow) → oversight (logging,
 *     auto-mod) → engagement (giveaways, leveling, roles) → utilities
 *     (messages, backup, stats).
 *   - Previously messy categories were reorganized: "Scheduled Announce &
 *     Warn" → pure Announcements; "Announce, Embed & Backup" → split into
 *     "Messages & Embed Builder" + "Backup & Maintenance"; "Stats & More"
 *     → pure Statistics (audit-log moved to Logging & Channels,
 *     reset-config moved to Backup); set-channel (previously scattered
 *     across 3 categories) now lives in one place: Logging & Channels.
 *   - Every command gets a one-phrase explanation — a new admin never has
 *     to guess a command's purpose from its name.
 *
 * Navigator architecture (unchanged from v3.9.39):
 *   - 🏠 Home   : category summary + common tasks + 📂 dropdown + buttons
 *   - 📂 Category: command details per category (small, readable embed)
 *   - 🔍 Search : keyword modal OR /help search:<keyword> → instant results
 *   - 📖 All    : full listing (with budget guards — see buildAllEmbeds)
 * Every view is rendered into ONE ephemeral message (interaction.update) —
 * no new-message spam when switching categories.
 *
 * Shared by:
 *   - src/commands/help.js      (slash /help + search option)
 *   - src/interactions/help.js  (dropdown/button/modal navigation)
 *
 * Discord contracts kept (unit-tested in tests/unit/helpNav.test.js):
 *   - StringSelectMenu max 25 options (currently 20 categories — guarded by a test).
 *   - Select options: label ≤ 100, description ≤ 100, value ≤ 100.
 *   - Embed description ≤ 4096; total of all embeds in one message ≤ 6000.
 */

const {
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
const { EMBED_LIMITS, DISCORD_LIMITS } = require('../infra/constants');
const { truncateUtf8Safe } = require('../infra/text');

// v3.9.37: version is read dynamically from package.json (single source of
// truth) so /help can never go stale.
const { version: BOT_VERSION } = require('../../package.json');

// === Custom IDs (stable — old help messages stay clickable after a restart) ===
const HELP_IDS = {
    SELECT: 'help_cat',
    SEARCH_BUTTON: 'help_search',
    SEARCH_MODAL: 'help_search_modal',
    SEARCH_INPUT: 'help_search_input',
    HOME_BUTTON: 'help_home',
    ALL_BUTTON: 'help_all'
};

const EMBED_COLOR = 0x5865f2;
const FOOTER_TEXT = `Community Bot v${BOT_VERSION} — All-in-One`;

// Safe cap on displayed search results before the "+N more" note.
const SEARCH_MAX_LINES = 20;

/**
 * Help category catalog (v3.9.44 — order = usage priority).
 * `lines` = the category detail content (command lines).
 * `short` = short description for the dropdown option (≤100 chars, guard-tested).
 */
const HELP_CATEGORIES = [
    {
        id: 'quickstart',
        emoji: '🚀',
        name: 'Quick Start',
        short: 'New to the bot? Server setup order from scratch',
        lines: [
            '**New to this bot? Follow this order:**',
            '1️⃣ `/set-role verified @Verified` — verified-member role',
            '2️⃣ `/add-category` + `/add-product` — prepare the catalog',
            '3️⃣ `/setup-ticket-panel` — mount the ticket panel',
            '4️⃣ `/setup-verify` — verification for new members',
            '5️⃣ `/set-channel server-log #log` — enable server log',
            '💡 Then explore the other categories via the 📂 dropdown.'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**New to this bot? Set the server up in this order (once):**',
            '1️⃣ `/set-role tipe:verified role:@Verified` — the role members receive after verifying',
            '2️⃣ `/add-category` + `/add-product` — prepare what you sell (see the Products category)',
            '3️⃣ `/setup-ticket-panel` — mount the order panel members click to buy',
            '4️⃣ `/setup-verify` — verification gate: new members click a button to get the verified role',
            '5️⃣ `/set-channel tipe:server-log channel:#log` — record joins, leaves, deletions, bans',
            '',
            '**Nice extras once the basics run (all optional):**',
            '• `/serverstats setup` — live member/boost counters at the top of the channel list (pick which counters to show)',
            '• `/set-channel tipe:server-booster channel:#boosts` — pink embed whenever someone boosts',
            '• `/setup-leveling` — XP per message + level-up roles',
            '• `/setup-tempvoice` — private voice channels members can create themselves',
            '• `/add-responder` — auto-reply to frequent questions',
            '',
            '💡 Nothing here is destructive, and **nothing is sent to members** until you mount a panel — you can safely explore. Every command is explained in its category via the 📂 dropdown.'
        ]
    },
    {
        id: 'moderation',
        emoji: '🛡️',
        name: 'Moderation',
        short: 'Warn, timeout, kick, ban, purge — one place',
        lines: [
            '**Violation history:**',
            '• `/warn user reason` — warning (3=mute 1h, 5=mute 1d, 7=kick)',
            '• `/warn-list user` — warn + sanction history · `/warn-remove` `/warn-clear`',
            '**Direct actions:**',
            '• `/timeout user minutes reason` — mute (max 40320 = 28 days) · `/untimeout`',
            '• `/kick` remove · `/ban` block · `/unban` unblock',
            '• `/purge amount:100 user?` — bulk delete messages (1-100)',
            '💡 Auto-logged to `/warn-list` + server log. Higher roles are immune.'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Warnings & history**',
            '• `/warn user reason` — issue a warning. Sanctions fire AUTOMATICALLY: 3 warns = 1h mute · 5 = 1-day mute · 7 = kick. The member is notified in DM when possible.',
            '• `/warn-list user` — one page: active warns + every past sanction (mute/kick/ban with dates + reasons).',
            '• `/warn-remove user warn_id` — delete a single warning (unfair warns vanish from the count). `/warn-clear user` — wipe them all.',
            '',
            '**Direct actions**',
            '• `/timeout user duration reason` — mute for 1–40320 minutes (max 28 days); `/untimeout user` lifts it early.',
            '• `/kick user reason` — remove from the server (they can re-join with a new invite).',
            '• `/ban user reason` — block permanently, optionally deleting their last messages (`delete_days` 0–7). `/unban user_id` — revoke by ID (works even if they already left).',
            '• `/purge amount user?` — bulk delete 1–100 recent messages in the CURRENT channel; add `user` to delete only that member\'s messages.',
            '',
            '❓ **Why can\'t I moderate a member?** Their role is HIGHER than the bot\'s — drag the bot\'s role up in Server Settings → Roles.',
            '❓ **Where does everything land?** In the server-log channel + the member\'s warn history — nothing is silent.'
        ]
    },
    {
        id: 'products',
        emoji: '📦',
        name: 'Products & Auto-Role',
        short: 'Product CRUD + role granted on purchase',
        lines: [
            '• `/add-product value:vip30 label:"VIP 30D" price:"Rp 30.000"` — key product',
            '• `/add-product ... requires_key:false` — service/account (details DM-ed to buyer)',
            '• `/update-product value:vip30 label:"..."` — edit · `/remove-product` · `/list-products`',
            '• `/set-product-role` — role on purchase (+ expiry) · `/remove-product-role` `/list-product-roles`'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Products = what you sell. Each has a `value` (unique ID), a `label` (what buyers see) and a `price`.**',
            '• `/add-product label value price` — add one, e.g. `/add-product value:vip30 label:"VIP 30D" price:"Rp 30.000"`. Optional `duration` (days), `category`, `requires_key`.',
            '• `requires_key:true` (default) — the buyer receives a product KEY they hand to your staff, who run `/set-key` to grant the role. Best for VIP-role products.',
            '• `requires_key:false` — a text/DM product: the panel collects the buyer\'s note, and details are delivered manually (accounts, services, gifts).',
            '• `/update-product value` — edit label/price/duration/category/requires_key of an existing product without delete+re-add. The confirmation shows the amount counted in stats per sale.',
            '• `/remove-product value` · `/list-products` — remove / view the catalog.',
            '',
            '**Auto-role on purchase**',
            '• `/set-product-role value role days` — the buyer\'s role is granted automatically when the deal closes, and auto-removed after `days` (leave empty = permanent).',
            '• `/remove-product-role value` — stop granting it · `/list-product-roles` — see all.',
            '',
            '❓ **Price format?** Rupiah, with or without dots/suffixes: `Rp 30.000`, `30000`, `30rb`. Dual-currency works (`3$ USD | Rp 25.000` — the Rp amount is what stats record). USD-only is rejected: stats are in Rupiah.',
            '❓ **Buyers see the price?** Yes — the ticket panel price list uses your `label` + `price` exactly.'
        ]
    },
    {
        id: 'keys',
        emoji: '🔑',
        name: 'Key Manager',
        short: 'Product key stock & member expiry schedule',
        lines: [
            '• `/set-key user:@user value:vip30 key:ABCDE-12345` — assign a product key',
            '• `/list-keys user:@user` — member keys · `/clear-schedule user clear_keys:true` — clean up'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Keys = proof of purchase. The buyer shows the key, staff verifies it once, the role + expiry schedule are handled automatically.**',
            '• `/set-key user value key` — register a key, e.g. `/set-key value:vip30 key:ABCDE-12345`. The buyer instantly gets the product role, and the expiry schedule is extended by the product\'s duration (never duplicated — MAX EXTEND).',
            '• `/list-keys user` — every key a member owns, active AND expired, with dates.',
            '• `/clear-schedule user` — remove all scheduled role expirations for a member; `clear_keys:true` also deletes their keys and removes the VIP role — the full cleanup for refunds/chargebacks.',
            '',
            '❓ **Key already used?** Each key can only be redeemed once — staff can see its status in `/list-keys`.',
            '❓ **Buyer lost the key?** `/list-keys user` shows it — no need to dig through DMs.'
        ]
    },
    {
        id: 'panels',
        emoji: '🎫',
        name: 'Ticket Panels & Verification',
        short: 'Mount ticket panels & member verification',
        lines: [
            '• `/setup-ticket-panel` — multi-category panel (options: `title` `body` `categories` `color` `image` `footer` `channel` `use_dropdown`)',
            '• `/list-panels` `/update-panel` `/refresh-panel` `/delete-panel` — manage panels',
            '• `/setup-verify` — new-member verification · `/set-verify-button` — button style',
            '• `/setup-ticket` — legacy single-category panel'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**The panel is the shop window: one embed with buttons — members click, a private ticket opens.**',
            '• `/setup-ticket-panel` — mount it. Full customization: `title`, `body`, `categories` (which ticket categories appear), `color`, `image`, `thumbnail`, `footer`, `channel`, `use_dropdown:true` (compact dropdown instead of buttons).',
            '• `/list-panels` — every panel + its ID · `/update-panel id field` — edit title/body/color/image/footer via modal (no re-setup).',
            '• `/refresh-panel id` — re-render with the LATEST categories/products (run this after adding products — the embed otherwise keeps the old list).',
            '• `/delete-panel id` — remove a panel (message + config).',
            '',
            '**Verification for new members**',
            '• `/setup-verify` — mount the verify panel: joining members click a button to get the verified role (and drop the unverified one).',
            '• `/set-verify-button label emoji style` — customize the button look.',
            '• `/setup-ticket` — the legacy single-category panel (kept for old setups; prefer `/setup-ticket-panel`).',
            '',
            '❓ **Panel shows old prices?** Run `/refresh-panel id` — or `/update-panel` for texts.',
            '❓ **Nothing happens when a member clicks?** Check the bot\'s permission to create channels + see the channel in the ticket category.'
        ]
    },
    {
        id: 'categories',
        emoji: '🗂️',
        name: 'Ticket Categories',
        short: 'Category CRUD + 3-category auto-split',
        lines: [
            '• `/add-category id:service label:"Service" emoji:🎮 style:Success requires_key:false`',
            '• `/update-category id:service label:...` — edit · `/remove-category` · `/list-categories`',
            '💡 With products → dropdown; without → creates a ticket directly.',
            '**Auto-Split** into 3 categories: 🎫 TRANSACTIONS (products) · 🎫 ASSISTANCE (help/report) · 🤝 ESCROW (deals). Custom names: `ticketCategoryKey` `ticketCategoryNoKey` `midman.category`'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Categories = the doors on the panel. Each has an `id`, a `label` (what members see), an `emoji` and a button `style` (color).**',
            '• `/add-category id label emoji style requires_key` — e.g. `/add-category id:service label:"Service" emoji:🎮 style:Success requires_key:false`.',
            '• `requires_key:true` — the category sells products: members get the product dropdown + price list. `requires_key:false` — a plain help/report ticket.',
            '• `/update-category id` — edit label/emoji/style/requires_key without delete+re-add · `/remove-category id` · `/list-categories`.',
            '💡 A category WITH products shows a dropdown; WITHOUT products, clicking creates the ticket directly.',
            '',
            '**Auto-Split (default): tickets are organized into 3 categories** — 🎫 TRANSACTIONS (product orders) · 🎫 ASSISTANCE (help/report) · 🤝 ESCROW (midman deals). Rename them via `/edit-message` types `ticketCategoryKey`, `ticketCategoryNoKey`, `midman.category`.',
            '❓ **Added a product but the dropdown is missing?** Run `/refresh-panel id` — the panel embed refreshes with the new list.'
        ]
    },
    {
        id: 'midman',
        emoji: '🤝',
        name: 'Midman / Escrow',
        short: '3-party escrow deals + automatic fees',
        lines: [
            '• `/set-role midman @role` — MUST be set before deals can open',
            '• `/set-midman-fee mode:Percent value:5` — fee per deal (percent/flat, 0=free)',
            '• `/midman-deals` — all active deals',
            '💡 3-party escrow: buyer ⇄ seller, the midman holds the funds. Open via the **🤝 Escrow** button on the panel — 3 steps until both sides **Agree Deal**.'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Escrow = the bot referees the deal: buyer and seller each confirm, the midman releases the funds, the fee is recorded automatically.**',
            '**Setup (once):**',
            '• `/set-role tipe:midman role:@Midman` — MANDATORY before any deal can open. Your staff with this role appear as the escrow officers.',
            '• `/set-midman-fee mode value` — the fee: `mode:Percent value:5` (5%) or `mode:Flat value:5000` (Rp 5.000). `0` = free.',
            '• `/midman-deals` — every active deal on one page (buyer, seller, midman, amount, status).',
            '',
            '**How a deal flows**',
            '1️⃣ A member clicks **🤝 Escrow** on the ticket panel and fills buyer/seller/price → a deal channel is created with all three inside.',
            '2️⃣ Buyer and seller each press **Agree** — the bot locks edits once both agree (3 steps total).',
            '3️⃣ The midman settles: **Complete** (funds released + fee recorded) or **Cancel** (everyone freed).',
            '❓ **Stuck deal?** `/midman-deals` shows the status; deals whose channel was deleted are reconciled automatically at startup + daily.',
            '❓ **Fee in stats?** Completed deals are recorded in the transaction stats (Rupiah).' 
        ]
    },
    {
        id: 'logging',
        emoji: '📜',
        name: 'Logging & Channels',
        short: 'Enable server-log, audit, transcript, welcome',
        lines: [
            '• `/set-channel server-log #ch` — deletes, edits, joins, bans',
            '• `audit-log #ch` — admin actions · `transcript #ch` — ticket archive',
            '• `/set-channel welcome/goodbye/invoice/server-booster #ch`',
            '• `/test-welcome` — diagnose welcome/goodbye + live preview',
            '• `/remove-channel type` — turn one off',
            'ℹ️ No `server-log` set = no event records.'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Every channel is optional — set only what you want. Same command for all types: `/set-channel tipe:... channel:#ch`.**',
            '• `tipe:server-log` — message deletes/edits, joins/leaves, bans, boost events — the server\'s black box.',
            '• `tipe:audit-log` — admin actions (config changes, products, moderation).',
            '• `tipe:transcript` — closed tickets are archived here as a text file.',
            '• `tipe:welcome` / `tipe:goodbye` — the join/leave embeds. Test + diagnose them with `/test-welcome tipe:welcome` (checks config, channel, permissions, and sends a live preview).',
            '• `tipe:invoice` — purchase invoices (one per completed order).',
            '• `tipe:server-booster` — 🚀 boost add/remove is auto-announced as a pink embed, and is ALWAYS recorded in the server log + boost history even when this channel is not set.',
            '• `/remove-channel tipe` — turn one off (the events keep flowing to the server log where applicable).',
            '❓ **Set a channel but nothing arrives?** Run `/test-welcome` for welcome/goodbye, or check the bot\'s View + Send + Embed permissions on that channel.',
            '❓ **Channel deleted?** Re-set it with `/set-channel` — a dead channel ID is detected and reported at startup.'
        ]
    },
    {
        id: 'automod',
        emoji: '🤖',
        name: 'Anti-Spam & Auto-Mod',
        short: 'Word blocklist, link whitelist, auto actions',
        lines: [
            '• `/set-automod` `/automod-show` `/automod-toggle` — enable & inspect',
            '• `/add-word words:word1,word2 action:Mute_10_minutes` — words + sanction',
            '• `/remove-word` `/list-words` · `/add-word tipe:Exempt_(word)` — whitelist',
            '• `/add-link-whitelist` `/remove-link-whitelist` — allowed links',
            '💡 Whole-word matching: "cat" does not match "category"'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Auto-mod watches every message and acts instantly — you choose the rules.**',
            '**Configure:**',
            '• `/set-automod` — the master switch: `spam_threshold` (messages/burst), `spam_action`, `block_links`, `block_words`, `word_action`, `max_mentions`, `mention_action`.',
            '• `/automod-show` — see the current rules · `/automod-toggle enabled:false|true` — on/off in one click.',
            '',
            '**Word blocklist:**',
            '• `/add-word words:kata1,kata2 action:Mute_10_minutes` — add words (comma-separated, APPENDED — never replaces) + the sanction. `tipe:Exempt_(word)` whitelists a word instead.',
            '• `/remove-word word tipe` — delete one · `/list-words` — see the blocklist, exemptions + per-word actions.',
            '',
            '**Links & exemptions:**',
            '• `/add-link-whitelist channel|#ch role|@role` — who may post links (channels or roles).',
            '• Matching is WHOLE-WORD: "cat" does not match "category" — no false alarms on longer words.',
            '❓ **Triggered but no action?** Check `/automod-show` — is the needed rule enabled, and is the bot\'s role above the member\'s?'
        ]
    },
    {
        id: 'responder',
        emoji: '💬',
        name: 'Auto-Responder',
        short: 'Auto-reply FAQ when a message contains a trigger',
        lines: [
            '• `/add-responder trigger:beli reply:...` — auto-reply to "beli" anywhere',
            '• `match_mode:contains|exact` — word anywhere, or message start',
            '• `/list-responder` · `/remove-responder` — view & delete'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Auto-responder = an FAQ machine: a message contains the trigger → the bot replies instantly.**',
            '• `/add-responder trigger reply` — e.g. `/add-responder trigger:beli reply:"Please open a ticket 🎫"` — fires when the message CONTAINS "beli" as a whole word, anywhere.',
            '• `match_mode:contains` (default) — whole word anywhere: "how do I buy" triggers "beli" — but "belian" does not. `match_mode:exact` — only when the message STARTS with the trigger (legacy `!sosmed` style).',
            '• `reply_type` — plain reply or embed · `cooldown` — seconds before the same trigger can fire again (`0` = always).',
            '• `/list-responder` — every trigger + reply + mode · `/remove-responder trigger` — delete one.',
            '❓ **Two triggers in one message?** Both reply — a trigger on cooldown does NOT block the scan (a second matching trigger still answers).',
            '❓ **Not firing?** Multi-word triggers work ("cara beli"); doubled spaces are collapsed; regex metacharacters are escaped (no errors).' 
        ]
    },
    {
        id: 'roles',
        emoji: '🎭',
        name: 'Roles & Self-Roles',
        short: 'System roles + member-choice role panels',
        lines: [
            '• `/set-role verified @role` — system roles (verified/unverified/admin/**midman**) · `/remove-role`',
            '• `/setup-selfrole title:... type:button` — member-choice role panel',
            '• `/selfrole-add` `/selfrole-remove` — manage list · `/selfrole-list` `/selfrole-delete`',
            '💡 `requires_role:@Verified` — conditionally locked role'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**System roles (bot logic)** — `/set-role tipe role`:',
            '• `tipe:verified` — granted after verification · `tipe:unverified` — held until then · `tipe:admin` — who may use admin commands · `tipe:midman` — escrow officers. `/remove-role tipe` clears one.',
            '',
            '**Self-role panels (member choice)** — members click to take/drop a role themselves:',
            '• `/setup-selfrole title description type:button|dropdown exclusive` — mount the panel. `exclusive:true` = only ONE role from the panel at a time.',
            '• `/selfrole-add panel_id role label emoji style requires_role` — add a role to the panel (button look + optional emoji). `requires_role:@Verified` — only members already holding that role can take it (gated perks).',
            '• `/selfrole-remove panel_id role` — take a role off · `/selfrole-list` — panels + roles · `/selfrole-delete panel_id` — remove a whole panel.',
            '❓ **Members can\'t take a role?** Check `requires_role` on that entry + the bot\'s role position (must be ABOVE the roles it manages).'
        ]
    },
    {
        id: 'leveling',
        emoji: '📊',
        name: 'Leveling',
        short: 'XP per message + roles granted on level-up',
        lines: [
            '• `/setup-leveling` — enable XP per message',
            '• `/add-level-role level:5 role:@VIP` — role on level-up · `/list-level-roles` `/remove-level-role`',
            '• `/rank` — your XP · `/leaderboard-level` — top members'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Leveling = activity XP: members earn XP per message, roles unlock at levels.**',
            '• `/setup-leveling enabled:true` — switch it on. Tuning: `xp_per_message`, `cooldown` (seconds between XP-earning messages — anti-spam), `announce_levelup` (post level-ups publicly or not).',
            '• `/add-level-role level role` — e.g. `/add-level-role level:5 role:@Active` — granted AUTOMATICALLY at level-up. `/list-level-roles` — all rewards · `/remove-level-role level` — remove one.',
            '• `/rank user?` — your (or another member\'s) level + XP (public command).',
            '• `/leaderboard-level` — top-10 members by level (public).',
            '❓ **XP not counting?** The cooldown applies — back-to-back messages in the same window earn nothing (anti-farm).',
            '❓ **Role not granted at level-up?** The bot\'s role must be ABOVE the reward role.'
        ]
    },
    {
        id: 'afk',
        emoji: '💤',
        name: 'AFK System',
        short: 'Auto-reply when an AFK user is mentioned',
        lines: [
            '• `/afk reason:...` — go AFK (bot auto-replies when mentioned)',
            '• `/afk-clear` — come back · `/afk-list` — who is AFK'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**AFK = "do not disturb": while you are AFK, anyone who mentions you gets an instant auto-reply with your reason.**',
            '• `/afk reason` — go AFK, e.g. `/afk reason:"studying, back at 8pm"`. Works for admins AND members (public command).',
            '• `/afk-clear` — you are back; mentions stop being answered.',
            '• `/afk-list` — everyone currently AFK + their reasons.',
            '❓ **Coming back automatically?** Clear it with `/afk-clear` — the status does not expire by itself.'
        ]
    },
    {
        id: 'giveaway',
        emoji: '🎉',
        name: 'Giveaways & Polls',
        short: 'Create / manage giveaways & polls',
        lines: [
            '• `/giveaway create channel:#ch prize:... winners:1 duration:60` — start',
            '• `/giveaway list` `/giveaway end` `/giveaway reroll` — manage',
            '• `/poll create` `/poll list` `/poll close` — polls'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Giveaways**',
            '• `/giveaway create channel prize duration winners required_role` — e.g. `/giveaway create channel:#events prize:"VIP 30D" winners:1 duration:60` (minutes). `required_role` — only members holding that role may enter.',
            '• `/giveaway list` — running giveaways + IDs · `/giveaway end id` — end now (winners drawn + announced) · `/giveaway reroll id` — draw new winners for a finished one.',
            '• Entries are the 🎉 reaction click — the bot tracks entries itself, prevents double-entries, and re-renders the embed at the end.',
            '',
            '**Polls**',
            '• `/poll create channel question multiple` — e.g. `/poll create channel:#general question:"Movie night?" multiple:true` (members may pick several options). Options are typed in the modal (2–10).',
            '• `/poll list` — running polls + IDs · `/poll close id` — lock voting + show the tallies.',
            '❓ **Wrong winner count?** Set `winners` in create; reroll draws exactly that many again.'
        ]
    },
    {
        id: 'announce',
        emoji: '📢',
        name: 'Scheduled Announcements',
        short: 'Send announcements now or scheduled',
        lines: [
            '• `/announce channel:#ch title:... description:...` — announcement',
            '• `/announce-schedule at:30m recurring:daily` — scheduled (once/recurring)',
            '• `/announce-list` `/announce-cancel` — view & cancel schedules'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Two ways to announce: right now, or scheduled.**',
            '• `/announce channel title description color image thumbnail mention` — sends one polished embed immediately. `mention` — ping a role/@everyone with it.',
            '• `/announce-schedule at recurring` — schedule it: `at:30m` (in 30 minutes) or `at:2026-12-25 09:00`, `recurring:daily|weekly|monthly` or once. Repeating announcements re-send themselves.',
            '• `/announce-list` — every pending schedule + its ID · `/announce-cancel id` — remove one before it fires.',
            '❓ **Time zone?** The bot uses the server\'s configured TZ offset — schedule a couple of minutes ahead first to verify.',
            '❓ **Edit a scheduled announcement?** Cancel + re-create — `/announce-list` shows the exact arguments to re-use.'
        ]
    },
    {
        id: 'messages',
        emoji: '✏️',
        name: 'Messages & Embed Builder',
        short: 'Edit system texts + send custom embeds',
        lines: [
            '**System texts:** `/set-message ticketBody text...` · `/edit-message` (modal) · `/reset-message` · `/list-messages`',
            '**Custom embeds:** `/send-message` (form) · `/embed-builder` · `/embed-list` `/embed-cancel`',
            '💡 Vars: `{server}` `{price_header}` `{price_list}` `{price_list:cat}` `{categories_list}`'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**System texts — every embed the bot sends (panel body, ticket opener, welcome…) can be reworded.**',
            '• `/edit-message tipe` — pick the text + edit it in a modal (multi-line friendly). `/list-messages` — see every customizable text + its current value.',
            '• `/reset-message tipe` — restore one to default. `/set-message` — the one-line variant.',
            '• Template variables auto-fill: `{server}` (server name), `{price_header}` + `{price_list}` / `{price_list:cat}` (live price list), `{categories_list}`.',
            '',
            '**Custom messages & embeds**',
            '• `/send-message channel message mention` — plain text (supports \n + mentions) — for rules, pings, quick notes.',
            '• `/announce` — one polished embed via form (title/description/color/image/thumbnail/mention).',
            '• `/embed-builder` — interactive builder with LIVE preview for complex embeds (multiple fields, author, footer). `/embed-list` — your sessions · `/embed-cancel session_id` — drop a stuck one.',
            '❓ **Price list empty in a text?** The variables only fill when products exist — add products first, then `/refresh-panel`.'
        ]
    },
    {
        id: 'tempvoice',
        emoji: '🎤',
        name: 'Private Voice',
        short: 'Auto voice channel when joining the trigger',
        lines: [
            '• `/setup-tempvoice` — mount the trigger channel · `/tempvoice-remove` — disable',
            '💡 Join trigger → private voice auto-created + control panel (rename, lock, transfer)'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Private voice = members get their own voice channel on demand.**',
            '• `/setup-tempvoice` — creates the category + a **Join to create** trigger channel. A member joins it → their own voice channel spawns instantly with a control panel inside.',
            '• Control panel buttons: **rename** the channel, **lock/unlock** it, **transfer** ownership, **claim** when the owner left, and it auto-deletes when the last person leaves (no zombie channels).',
            '• `/tempvoice-remove` — disable the feature (the category + related channels are deleted).',
            '❓ **Channel not created on join?** Check the bot\'s Manage Channels permission + that nobody deleted the trigger channel.',
            '❓ **Limits?** Discord caps channels per server; extremely large servers may need several trigger channels.'
        ]
    },
    {
        id: 'backup',
        emoji: '💾',
        name: 'Backup & Maintenance',
        short: 'Back up data, restore, reset configuration',
        lines: [
            '• `/backup-now` — back up now (auto every 24h, max 7 slots)',
            '• `/backup-list` `/restore-backup` — view & restore',
            '• `/reset-config` — ⚠️ DELETES ALL configuration (2-step confirm)'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**Backups protect your whole configuration: products, keys, panels, roles, channels, stats, server stats counters, boost history…**',
            '• `/backup-now` — one manual backup right now. A safety backup ALSO runs automatically every 24h.',
            '• `/backup-list` — the backup slots (max 7, oldest falls off) with names + timestamps.',
            '• `/restore-backup name` — restore everything from a slot. A fresh safety backup is taken BEFORE restoring, so you can always go back.',
            '• `/reset-config` — ⚠️ wipe ALL settings back to factory (roles, channels, products, messages). Two-step confirmation — take a `/backup-now` first!',
            '❓ **Restore resets live caches** — the bot reloads the restored data immediately, no restart needed.',
            '❓ **Where are the files?** `data/backups/` — do not edit by hand; use the commands.'
        ]
    },
    {
        id: 'stats',
        emoji: '📈',
        name: 'Statistics',
        short: 'Live stats, counter channels, boosters, leaderboards',
        // v3.9.51: + /serverstats (live counter channels). Lines compacted so
        // the All-Commands embed stays within the 5800 budget with all 20
        // categories intact (re-measured after every line change).
        lines: [
            '• `/stats` — live server stats + tracked activity',
            '• `/serverstats` — live counter channels (members/boosts)',
            '• `/boosters` — current boosters + history',
            '• `/leaderboard` — rankings (messages/spending/wins)',
            '• `/my-stats` — your messages & transactions'
        ],
        // v3.9.53: full self-contained guide (category view = detail only) —
        // now documents the setup counter-selection options.
        detail: [
            '**Live counter channels (like the ServerStats bots):**',
            '• `/serverstats setup` — creates the "📊 SERVER STATS" category at the TOP of the channel list. Voice channels whose NAMES are live counters — members see the numbers at a glance, nobody can join them.',
            '• **Pick which counters to show** (v3.9.53): `members bots boosts roles channels` — every one ON by default; set one to **False** to skip it, e.g. `/serverstats setup bots:false channels:false` creates only 👥 · 🚀 · 🎭. At least one must stay on.',
            '• `/serverstats remove` — delete everything · `/serverstats refresh` — force an update now. To CHANGE the selection: `remove` then `setup` again.',
            '• Updates are automatic: member join/leave, boost add/remove, channel & role create/delete. Rate-limit safe (Discord allows 2 renames per channel / 10 min — updates are throttled and self-heal every ~5 min). Deleted counters warn you; all gone → auto-disable.',
            '',
            '**Boost notifications:** a member starts/stops boosting → pink embed auto-sent to the server-booster channel (`/set-channel tipe:server-booster #ch`), always recorded in the server log + `/boosters` history.',
            '',
            '**Numbers & rankings**',
            '• `/stats` — server overview: live members, boosts, open tickets + tracked activity (messages, transactions). No revenue line — spending is personal.',
            '• `/boosters` — the live booster roster + recent history (public).',
            '• `/leaderboard metric` — top 10 by messages / spending / giveaway wins (public).',
            '• `/my-stats` — your own messages, transactions + total spent (public — only you see your page).' 
        ]
    },
    {
        id: 'info',
        emoji: '📋',
        name: 'Bot Information',
        short: 'Help center & view all configuration',
        lines: [
            '• `/help` — the help center (or `/help search:keyword`)',
            '• `/config-show` — view all bot configuration at once'
        ],
        // v3.9.53: full self-contained guide (category view = detail only).
        detail: [
            '**/help — the command center**',
            '• `/help` — this navigator: pick a category in the 📂 dropdown (every command explained), 🔍 **Search Commands** for a keyword, 📖 **All Commands** for the compact full list, or run `/help search:keyword` directly.',
            '• Every category view IS the full guide — syntax, behavior, and the answers to the most common questions.',
            '',
            '**/config-show — one page, everything set**',
            '• Roles, channels, products, responders, auto-mod, leveling… the whole configuration in one embed — check it after any big change to confirm everything landed.',
            '❓ **Command not appearing?** Slash commands register to the server at startup — restart the bot if you just pulled an update.',
            '❓ **Permissions?** Admin commands need the Manage Server permission; public commands (`/rank`, `/leaderboard`, `/my-stats`, `/boosters`, `/afk`) work for everyone.'
        ]
    }
];

// === Helpers ===

function findCategory(id) {
    return HELP_CATEGORIES.find(c => c.id === id) || null;
}

function baseEmbed() {
    return new EmbedBuilder().setColor(EMBED_COLOR).setFooter({ text: FOOTER_TEXT }).setTimestamp();
}

/**
 * Count total embed characters the way Discord counts the 6000 limit
 * (title + description + field name/value + footer + author).
 */
function embedTotalChars(embed) {
    const data = embed.data;
    let total = 0;
    if (data.title) total += data.title.length;
    if (data.description) total += data.description.length;
    for (const f of data.fields || []) {
        total += (f.name?.length || 0) + (f.value?.length || 0);
    }
    if (data.footer?.text) total += data.footer.text.length;
    if (data.author?.name) total += data.author.name.length;
    return total;
}

// === Embed builders ===

/**
 * 🏠 Home — category index + common tasks (compact, no command listing).
 */
function buildHomeEmbed(client, user) {
    const mention = user ? `${user}` : 'Admin';
    // Category names packed 3 per line so it fits one screen (no long scroll).
    const names = HELP_CATEGORIES.map(c => `${c.emoji} ${c.name}`);
    const rows = [];
    for (let i = 0; i < names.length; i += 3) {
        rows.push(names.slice(i, i + 3).join(' · '));
    }
    return baseEmbed()
        .setTitle('🤖 COMMUNITY BOT — HELP')
        .setDescription(
            `Hello ${mention}! You are **Admin/Staff** — this is the bot control center (v${BOT_VERSION}), **${HELP_CATEGORIES.length} command categories**.\n\n` +
                `**What do you need right now?**\n` +
                `> 🛡️ Trouble with a member? → **Moderation** (warn/timeout/kick/ban)\n` +
                `> 🛒 Setting up sales? → **Quick Start** · **Products** · **Midman/Escrow**\n` +
                `> 👀 Want oversight? → **Logging & Channels**\n` +
                `> 🎉 Quiet server? → **Giveaways & Polls** · **Leveling**\n\n` +
                `**How to use:**\n` +
                `> 1️⃣ Pick a category in the **📂** dropdown below\n` +
                `> 2️⃣ Click **🔍 Search Commands** — type a keyword (e.g. \`key\`, \`escrow\`)\n` +
                `> 3️⃣ Or run \`/help search:panel\` directly\n` +
                `> 4️⃣ Click **📖 All Commands** for the full list`
        )
        .addFields({ name: `📚 Categories (${HELP_CATEGORIES.length})`, value: rows.join('\n') });
}

/**
 * 📂 Category — command details for a single category (small embed).
 * Returns `null` for an unknown id (e.g. an old message after a bot update).
 */
function buildCategoryEmbed(client, categoryId) {
    const cat = findCategory(categoryId);
    if (!cat) return null;
    // v3.9.53 (user request: "rewrite /help so every category's slash
    // commands get explanations — members should not have to ask"): when a
    // category carries a `detail` guide, THAT is the category view — a
    // self-contained per-command explanation. The compact `lines` stay the
    // content of the budget-critical 📖 All Commands embed (5793/5800 — only
    // 7 chars of slack) and the 🔍 Search index; a category without `detail`
    // falls back to `lines` (identical to pre-v3.9.52 behavior).
    const description = (cat.detail || cat.lines).join('\n');
    return baseEmbed()
        .setTitle(`${cat.emoji} ${cat.name}`)
        .setDescription(description)
        .addFields({
            name: '↩️ Navigation',
            value: 'Switch categories via the 📂 dropdown · Click **🏠 Main Menu** to go back · **🔍 Search Commands** to search.'
        });
}

/**
 * 📖 All — full listing of ALL commands (classic view).
 * Returns an array of 1 EmbedBuilder (array contract preserved).
 *
 * v3.9.40 REWRITE: in ONE message, the TOTAL of all embeds = 6000 chars —
 * the v3.9.39 "auto-split into 2 embeds" added no budget at all (that path
 * was dead code — current content 5.4K < 5.800 — and if the catalog grew,
 * splitting could actually overshoot the total + give embed 1/2 a bogus
 * "continued" description). Now a single embed that ALWAYS fits:
 *   - Guard 1: every field value capped at 1024 (surrogate-safe truncate + note).
 *   - Guard 2: max 25 fields (Discord; currently 20 categories).
 *   - Guard 3: if the total > budget (5.800), categories at the end are
 *     dropped one by one + a replacement note pointing to the 📂 dropdown /
 *     🔍 Search — the message total NEVER exceeds 6.000, whatever the size
 *     of the catalog.
 */
function buildAllEmbeds() {
    // Guard 1: field value ≤ 1024 — leave room for the truncation note.
    const capField = lines => {
        const text = lines.join('\n');
        if (text.length <= EMBED_LIMITS.FIELD_VALUE) return text;
        return truncateUtf8Safe(text, EMBED_LIMITS.FIELD_VALUE - 45) + '\n… +more lines not shown.';
    };
    // Guard 2: slice 25 — the 26th+ category never reaches addFields.
    // (const: only mutated via pop, never reassigned.)
    const fields = HELP_CATEGORIES.slice(0, EMBED_LIMITS.FIELDS_COUNT).map(c => ({
        name: `${c.emoji} ${c.name}`,
        value: capField(c.lines),
        inline: false
    }));

    const droppedNote = n =>
        `\n\n… +${n} more categories not loaded (single-message size limit) — use the 📂 dropdown or 🔍 Search Commands.`;
    const build = (fs, extra) =>
        baseEmbed()
            .setTitle('🤖 ALL COMMANDS')
            .setDescription(`_Full list of all commands (v${BOT_VERSION})._${extra || ''}`)
            .addFields(fs);

    // Total budget of ALL embeds in one message = 6.000 — 200 slack for the
    // note overhead + the embedTotalChars accounting (title/footer included).
    const BUDGET = EMBED_LIMITS.TOTAL_CHARS - 200;
    let dropped = 0;
    let embed = build(fields, '');
    // Guard 3: drop categories from the back until the total fits (min 1 field).
    while (fields.length > 1 && embedTotalChars(embed) > BUDGET) {
        fields.pop();
        dropped++;
        embed = build(fields, droppedNote(dropped));
    }
    return [embed];
}

// === Search ===

/**
 * Split category lines into "blocks": a bullet (•) line + its continuation
 * lines (options/indents) so when a command matches, its options show too.
 */
function buildBlocks(lines) {
    const blocks = [];
    let current = null;
    for (const line of lines) {
        const isBullet = line.trimStart().startsWith('•');
        if (isBullet || !current) {
            current = [line];
            blocks.push(current);
        } else {
            current.push(line);
        }
    }
    return blocks;
}

/**
 * Search commands across all categories. Match: case-insensitive substring
 * in a command line, or the category name/id/description (when the category
 * name matches, the WHOLE category is shown).
 * Returns { query, groups: [{ cat, blocks }], totalBlocks, truncated, emptyQuery }
 */
function searchHelp(rawQuery) {
    // v3.9.40 FIX: cap input at 100 chars before processing. The registry
    // slash option now also has max_length:100, but this builder serves TWO
    // entry points (slash + modal) and old modals/messages can still slip
    // through — defensive at this single point closes every path. Without
    // the cap, a thousands-char query gets echoed into the result embed
    // → description > 4096 → EmbedBuilder.setDescription throws (uncaught).
    const query = String(rawQuery || '')
        .slice(0, 100)
        .trim()
        .toLowerCase();
    if (!query) return { query: '', groups: [], totalBlocks: 0, truncated: false, emptyQuery: true };

    const groups = [];
    let totalBlocks = 0;
    for (const cat of HELP_CATEGORIES) {
        const catText = `${cat.name} ${cat.short} ${cat.id}`.toLowerCase();
        const wholeCat = catText.includes(query);
        let blocks;
        if (wholeCat) {
            blocks = buildBlocks(cat.lines);
        } else {
            blocks = buildBlocks(cat.lines).filter(block => block.join('\n').toLowerCase().includes(query));
        }
        if (blocks.length > 0) {
            groups.push({ cat, blocks });
            totalBlocks += blocks.length;
        }
    }
    return { query, groups, totalBlocks, truncated: false, emptyQuery: false };
}

/**
 * 🔍 Search results.
 */
function buildSearchEmbed(rawQuery) {
    const result = searchHelp(rawQuery);
    const embed = baseEmbed().setTitle('🔍 Search Results');

    if (result.emptyQuery) {
        return embed.setDescription(
            'Empty keyword. Click **🔍 Search Commands** again and type a keyword (e.g. `panel`, `key`, `escrow`).'
        );
    }

    // Cap the displayed result lines so the embed stays small & scannable.
    const sections = [];
    let shown = 0;
    let truncated = false;
    for (const group of result.groups) {
        if (shown >= SEARCH_MAX_LINES) {
            truncated = true;
            break;
        }
        const lines = [];
        for (const block of group.blocks) {
            if (shown >= SEARCH_MAX_LINES) {
                truncated = true;
                break;
            }
            lines.push(block.join('\n'));
            shown++;
        }
        sections.push(`**${group.cat.emoji} ${group.cat.name}**\n${lines.join('\n')}`);
    }

    // v3.9.40 FIX: a backtick in the query could close the inline-code header
    // and restyle the rest of the embed — sanitize for display (matching still
    // uses the raw query, identical results).
    const safeQuery = result.query.replace(/`/g, "'");
    const header =
        `Keyword: \`${safeQuery}\` — ` +
        (result.totalBlocks > 0 ? `**${result.totalBlocks}** results found` : 'no matches') +
        `\n_Change the keyword via the 🔍 button · 🏠 Main Menu to go back._`;

    let body;
    if (sections.length === 0) {
        body =
            'No matching commands. Try another keyword — e.g. `ticket`, `product`, `role`, `announce`, `warn`, `giveaway`.';
    } else {
        body = sections.join('\n\n');
        if (truncated) {
            body += `\n\n… +more results not shown. Try a more specific keyword.`;
        }
    }
    return embed.setDescription(`${header}\n\n${body}`);
}

// === Components ===

/**
 * Category dropdown row — always present in every view (main navigation).
 */
function buildSelectRow() {
    const select = new StringSelectMenuBuilder()
        .setCustomId(HELP_IDS.SELECT)
        .setPlaceholder('📂 Pick a command category…')
        .addOptions(
            // Guard: Discord max 25 options per select (currently 20 — if the
            // catalog ever grows past 25, the helpNav test fails first).
            HELP_CATEGORIES.slice(0, DISCORD_LIMITS.SELECT_MENU_MAX_OPTIONS).map(
                c =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(c.name)
                        .setValue(c.id)
                        .setDescription(c.short)
                        .setEmoji(c.emoji)
            )
        );
    return new ActionRowBuilder().addComponents(select);
}

/**
 * Action button row. `view`: 'home' | category/search/all (anything else).
 * Home: 🔍 Search + 📖 All. Other views: also add 🏠 Main Menu.
 */
function buildButtonRow(view) {
    const buttons = [
        new ButtonBuilder().setCustomId(HELP_IDS.SEARCH_BUTTON).setLabel('🔍 Search Commands').setStyle(ButtonStyle.Primary)
    ];
    if (view !== 'home') {
        buttons.push(new ButtonBuilder().setCustomId(HELP_IDS.HOME_BUTTON).setLabel('🏠 Main Menu').setStyle(ButtonStyle.Secondary));
    }
    buttons.push(new ButtonBuilder().setCustomId(HELP_IDS.ALL_BUTTON).setLabel('📖 All Commands').setStyle(ButtonStyle.Secondary));
    return new ActionRowBuilder().addComponents(buttons);
}

/**
 * Full components for one /help view.
 */
function buildHelpComponents(view = 'home') {
    return [buildSelectRow(), buildButtonRow(view)];
}

module.exports = {
    HELP_CATEGORIES,
    HELP_IDS,
    SEARCH_MAX_LINES,
    buildHomeEmbed,
    buildCategoryEmbed,
    buildAllEmbeds,
    buildSearchEmbed,
    searchHelp,
    buildHelpComponents,
    buildSelectRow,
    buildButtonRow,
    embedTotalChars
};
