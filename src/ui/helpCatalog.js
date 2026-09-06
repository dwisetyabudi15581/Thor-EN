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
        ]
    },
    {
        id: 'products',
        emoji: '📦',
        name: 'Products & Auto-Role',
        short: 'Product CRUD + role granted on purchase',
        lines: [
            '• `/add-product value:vip30 label:"VIP 30 Days" price:"Rp 30.000"` — key product',
            '• `/add-product ... requires_key:false` — service/account (details DM-ed to buyer)',
            '• `/update-product value:vip30 label:"..."` — edit · `/remove-product` · `/list-products`',
            '• `/set-product-role` — role on purchase (+ expiry) · `/remove-product-role` `/list-product-roles`'
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
            '• `/setup-verify` — new-member verification · `/set-verify-button` — customize the button',
            '• `/setup-ticket` — legacy single-category panel'
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
        ]
    },
    {
        id: 'logging',
        emoji: '📜',
        name: 'Logging & Channels',
        short: 'Enable server-log, audit, transcript, welcome',
        lines: [
            '• `/set-channel server-log #ch` — message delete/edit, join/leave, bans, roles',
            '• `/set-channel audit-log #ch` — admin actions · `transcript #ch` — ticket archive',
            '• `/set-channel welcome/goodbye/invoice #ch` — greetings & invoices',
            '• `/remove-channel type` — turn one off',
            'ℹ️ Without `server-log`, server events are not recorded.'
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
            '• `/remove-word` `/list-words` · `/add-word type:Exempt_(word)` — whitelist',
            '• `/add-link-whitelist` `/remove-link-whitelist` — allowed links',
            '💡 Whole-word matching: "cat" does not match "category"'
        ]
    },
    {
        id: 'responder',
        emoji: '💬',
        name: 'Auto-Responder',
        short: 'Auto-reply FAQ when members send a trigger',
        lines: [
            '• `/add-responder trigger:hello reply:...` — set up an auto-reply (great for FAQ)',
            '• `/list-responder` · `/remove-responder` — view & delete'
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
            '• `/poll create` `/poll list` `/poll close` — quick polls'
        ]
    },
    {
        id: 'announce',
        emoji: '📢',
        name: 'Scheduled Announcements',
        short: 'Send announcements now or scheduled',
        lines: [
            '• `/announce channel:#ch title:... description:...` — send an announcement',
            '• `/announce-schedule at:30m recurring:daily` — scheduled (once/recurring)',
            '• `/announce-list` `/announce-cancel` — view & cancel schedules'
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
        ]
    },
    {
        id: 'stats',
        emoji: '📈',
        name: 'Statistics',
        short: 'Server stats, leaderboards, transactions',
        lines: [
            '• `/stats` — server statistics (members, tickets, transactions)',
            '• `/leaderboard metric:messages|vipPurchases|totalSpent` — rankings',
            '• `/my-stats` — your personal transaction stats'
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
    return baseEmbed()
        .setTitle(`${cat.emoji} ${cat.name}`)
        .setDescription(cat.lines.join('\n'))
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
