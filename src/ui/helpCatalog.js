/**
 * Help Catalog — single source of truth for /help content (v3.9.39).
 *
 * v3.9.39 REDESIGN: /help used to be ONE giant embed (~5,400 chars) → admins
 * had to scroll forever to find a command. It is now an interactive
 * navigator:
 *   - 🏠 Home     : category index + 📂 dropdown (19 categories) + buttons
 *   - 📂 Category : command details per category (small embed, easy to scan)
 *   - 🔍 Search   : keyword modal OR /help search:<keyword> → instant results
 *   - 📖 All      : the full list (classic view, still available)
 * Every view is rendered into ONE ephemeral message (interaction.update) —
 * no new-message spam while switching categories.
 *
 * This module is shared by:
 *   - src/commands/help.js      (slash /help + search option)
 *   - src/interactions/help.js  (dropdown/button/modal navigation)
 *
 * Discord contracts enforced (unit-tested in tests/unit/helpNav.test.js):
 *   - StringSelectMenu max 25 options (currently 19 categories — guard test).
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

// v3.9.37: version is taken dynamically from package.json (single source of
// truth) so /help never goes stale again.
const { version: BOT_VERSION } = require('../../package.json');

// === Custom IDs (stable — old /help messages stay clickable after restart) ===
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
 * Help category catalog. `lines` = the category detail content (command lines).
 * `short` = short description for the dropdown option (≤100 chars, guard-tested).
 */
const HELP_CATEGORIES = [
    {
        id: 'info',
        emoji: '📋',
        name: 'Information',
        short: 'Help, product/category/message lists & configuration',
        lines: [
            '• `/help` — open this help center (or `/help search:keyword`)',
            '• `/list-products` — view all products',
            '• `/list-categories` — view all ticket categories',
            '• `/list-messages` — view all embed message texts',
            '• `/config-show` — view all bot configuration'
        ]
    },
    {
        id: 'panels',
        emoji: '🏗️',
        name: 'Ticket Panels (Multi-Panel)',
        short: 'Verification panel & multi-panel ticket setup',
        lines: [
            '• `/setup-verify` — install the verification panel',
            '• `/setup-ticket` — install the ticket panel (legacy)',
            '• `/setup-ticket-panel` — full multi-panel setup:',
            '   options: `title` `body` `color:#ff5733` `image` `thumbnail` `footer` `categories` `channel` `use_dropdown`',
            '• `/list-panels` `/update-panel` `/refresh-panel` `/delete-panel`',
            '• `/set-verify-button` — customize the verification button',
            '💡 Multi-panel = each panel has its own customization. Saved to panels.json.'
        ]
    },
    {
        id: 'categories',
        emoji: '🎫',
        name: 'Ticket Categories (CRUD)',
        short: 'Add / edit / delete ticket categories',
        lines: [
            '• `/add-category id:jasa label:"Jasa" emoji:🎮 style:Success requires_key:false`',
            '• `/update-category id:jasa label:"Jasa Premium" emoji:"🛠️"` — edit without deleting',
            '• `/list-categories` — view all categories',
            '• `/remove-category id:jasa` — delete a category (defaults are protected)',
            '💡 v3.9.19: flexible behavior — category with products → dropdown, category without products → opens a ticket directly.'
        ]
    },
    {
        id: 'responder',
        emoji: '💬',
        name: 'Auto-Responder',
        short: 'FAQ auto-reply when members send a trigger',
        lines: [
            '• `/add-responder` `/list-responder` `/remove-responder`',
            '💡 Member sends a trigger → bot auto-replies. Great for FAQs.'
        ]
    },
    {
        id: 'automod',
        emoji: '🛡️',
        name: 'Anti-Spam & Auto-Mod',
        short: 'Word blocklist, link whitelist, automatic actions',
        lines: [
            '• `/set-automod` `/automod-show` `/automod-toggle`',
            '• `/add-word words:word1,word2 action:mute_10m` — add words (append)',
            '• `/remove-word word:word` `/list-words` — delete/view words',
            '• `/add-word words:Exempt_(allowed_word)` — whitelist a word against false positives',
            '• `/add-link-whitelist` `/remove-link-whitelist`',
            '💡 v3.9.23: per-word actions + whole-word matching ("asu" won\'t match "asus")'
        ]
    },
    {
        id: 'afk',
        emoji: '💤',
        name: 'AFK System',
        short: 'Auto-reply when an AFK user is mentioned',
        lines: ['• `/afk` `/afk-clear` `/afk-list`', '💡 The bot auto-replies when an AFK user is mentioned.']
    },
    {
        id: 'leveling',
        emoji: '📊',
        name: 'Leveling System',
        short: 'XP per message, auto-role on level up',
        lines: [
            '• `/setup-leveling` `/add-level-role` `/list-level-roles` `/remove-level-role`',
            '• `/rank` `/leaderboard-level` (public)',
            '💡 XP per message, level up → role auto-assigned.'
        ]
    },
    {
        id: 'roles',
        emoji: '🎭',
        name: 'Role Settings',
        short: 'Set verified / admin / midman roles in config',
        lines: [
            '• `/set-role verified @role` — set a role (verified/unverified/admin/**midman**)',
            '• `/remove-role verified` — remove the role from config'
        ]
    },
    {
        id: 'channels',
        emoji: '📢',
        name: 'Channel Settings & Ticket Auto-Split',
        short: 'Set channels & the 3-way ticket auto-split',
        lines: [
            '• `/set-channel welcome #ch` — set a channel (welcome/goodbye/invoice/audit-log/**transcript**)',
            '• `/remove-channel welcome` — remove the channel from config',
            '• `/set-channel transcript #ch` — auto-save ticket transcripts before close',
            '',
            '**🎫 Auto-Split:** the bot splits tickets into 3 categories automatically:',
            '• **`🎫 TRANSACTIONS`** — all product tickets: with key (🔑 Set Key) OR non-key (📦 Deliver Order)',
            '• **`🎫 SUPPORT`** — tickets in categories without products (help/report/claim_giveaway)',
            '• **`🤝 ESCROW`** — middleman escrow deal channel (created when an escrow deal is opened)',
            'Want custom names? Edit `data/config.json`: `ticketCategoryKey`, `ticketCategoryNoKey`, `midman.category`'
        ]
    },
    {
        id: 'messages',
        emoji: '✏️',
        name: 'Embed Message Settings',
        short: 'Edit welcome/goodbye/ticket texts + template vars',
        lines: [
            '• `/set-message ticketBody text...` (quick, 1-line)',
            '• `/edit-message type:"Ticket Body"` → opens a multi-line modal editor',
            '• `/reset-message ticketBody` / `/reset-message ALL`',
            '',
            '**Template vars:** `{server}` `{price_header}` `{price_list}` `{price_list:cat}` `{categories_list}`'
        ]
    },
    {
        id: 'products',
        emoji: '📦',
        name: 'Products & Auto-Role',
        short: 'Product CRUD, auto-assigned roles + expiry',
        lines: [
            '• `/add-product` `/remove-product` `/list-products`',
            '• `/update-product value:vip30 label:"VIP 30 Hari" price:"Rp 30.000"` — edit without deleting',
            '• `/set-product-role` `/remove-product-role` `/list-product-roles`',
            '💡 VIP role + auto-expire (days). You can mix key & non-key products (services).',
            '💡 Non-key products (accounts, services)? `/add-product ... requires_key:false` → the ticket gets a **📦 Deliver Order** button (details sent via DM to the buyer + auto-role + invoice + stats).'
        ]
    },
    {
        id: 'keys',
        emoji: '🔑',
        name: 'Key Manager',
        short: 'Set product keys, list & clear user schedules',
        lines: [
            '• `/set-key user:@user value:vip30 key:ABCDE-12345`',
            '• `/list-keys user:@user`',
            '• `/clear-schedule user:@user clear_keys:true`'
        ]
    },
    {
        id: 'midman',
        emoji: '🤝',
        name: 'Midman / Escrow',
        short: '3-party escrow deals + automatic fees',
        lines: [
            '• `/set-role midman @role` — must be set before any deal can be opened',
            '• `/set-midman-fee mode:percent value:5` — automatic fee per deal (percent / flat, 0 = free)',
            '• `/midman-deals` — view all active escrow deals on the server',
            '💡 3-party escrow deal (buyer ⇄ seller + a middleman holds the funds). Anyone can open one via the **🤝 Escrow** button on the panel — 3 steps: item & price → pick the buyer → pick the seller, then both parties click **Agree to Deal**.'
        ]
    },
    {
        id: 'selfrole',
        emoji: '🎭',
        name: 'Self-Role Panel',
        short: 'Member-selectable role panels',
        lines: [
            '• `/setup-selfrole title:... type:button exclusive:false`',
            '• `/selfrole-add` `/selfrole-remove` `/selfrole-list` `/selfrole-delete`',
            '💡 `requires_role:@Verified` — conditional role'
        ]
    },
    {
        id: 'tempvoice',
        emoji: '🎤',
        name: 'Temp Voice',
        short: 'Automatic private voice on trigger-channel join',
        lines: [
            '• `/setup-tempvoice` / `/tempvoice-remove`',
            '💡 Member joins the trigger channel → a private voice channel is created automatically'
        ]
    },
    {
        id: 'announce',
        emoji: '📢',
        name: 'Announce, Embed & Backup',
        short: 'Announcements, embed builder, data backups',
        lines: [
            '• `/announce channel:#ch title:... description:...`',
            '• `/send-message` `/embed-builder` `/embed-list` `/embed-cancel`',
            '• `/backup-now` `/backup-list` `/restore-backup` (auto 24h, max 7)'
        ]
    },
    {
        id: 'giveaway',
        emoji: '🎉',
        name: 'Giveaway & Poll',
        short: 'Create / manage giveaways & polls',
        lines: [
            '• `/giveaway create channel:#ch prize:... winners:1 duration:60`',
            '• `/giveaway list` `/giveaway end` `/giveaway reroll`',
            '• `/poll create` `/poll list` `/poll close`'
        ]
    },
    {
        id: 'schedule',
        emoji: '⏰',
        name: 'Scheduled Announce & Warn',
        short: 'Scheduled announcements & the warn system',
        lines: [
            '• `/announce-schedule channel:#ch at:30m recurring?:daily`',
            '• `/announce-list` `/announce-cancel`',
            '• `/warn` `/warn-list` `/warn-remove` `/warn-clear` (3=mute1h, 5=mute1d, 7=kick)'
        ]
    },
    {
        id: 'stats',
        emoji: '📊',
        name: 'Stats & More',
        short: 'Server/user stats, audit log, config reset',
        lines: [
            '• `/stats` `/leaderboard metric:messages|vipPurchases|totalSpent` `/my-stats`',
            '• `/set-channel audit-log #ch` — log admin actions',
            '• `/reset-config` — ⚠️ DELETES ALL settings (2-step confirmation)'
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
 * Count the embed's total characters the way Discord counts the 6000 limit
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
 * 🏠 Home — compact category index (no command listing).
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
            `Hello ${mention}! You are verified as **Admin/Staff** (v${BOT_VERSION}).\n` +
                `**${HELP_CATEGORIES.length} command categories** available.\n\n` +
                `**Find a command fast:**\n` +
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
 * 📖 All — the full command list (classic view).
 * Returns an array with 1 EmbedBuilder (array contract kept).
 *
 * v3.9.40 REWRITE: within ONE message, the TOTAL of all embeds = 6000 chars —
 * the v3.9.39 "auto-split into 2 embeds" added NO budget at all (that path
 * was dead code — current content is 5.5K < 5.800 — and if the catalog grew,
 * splitting could actually make the total overshoot + embed 1/2 got the wrong
 * "Continuation" description). Now one embed with a guaranteed fit:
 *   - Guard 1: each field value is capped at 1024 (surrogate-safe truncation + note).
 *   - Guard 2: max 25 fields (Discord; currently 19 categories).
 *   - Guard 3: if the total > budget (5.800), trailing categories are dropped
 *     and replaced with a note pointing to the 📂 dropdown / 🔍 Search — the
 *     message total NEVER exceeds 6.000, whatever the catalog size.
 */
function buildAllEmbeds() {
    // Guard 1: field value ≤ 1024 — leave room for the truncation note.
    const capField = lines => {
        const text = lines.join('\n');
        if (text.length <= EMBED_LIMITS.FIELD_VALUE) return text;
        return truncateUtf8Safe(text, EMBED_LIMITS.FIELD_VALUE - 45) + '\n… +more lines not shown.';
    };
    // Guard 2: slice to 25 — categories 26+ never reach addFields.
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
            .setDescription(`_Full command list (v${BOT_VERSION})._${extra || ''}`)
            .addFields(fs);

    // Budget for ALL embeds in ONE message = 6.000 — 200 slack for note
    // overhead + embedTotalChars accounting (title/footer are counted).
    const BUDGET = EMBED_LIMITS.TOTAL_CHARS - 200;
    let dropped = 0;
    let embed = build(fields, '');
    // Guard 3: drop trailing categories until the total fits (min 1 field).
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
 * lines (options/indent) so that when a command matches, its option lines
 * are shown too.
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
 * Search commands across all categories. Matching: case-insensitive substring
 * on command lines, or on category name/id/description (if the category NAME
 * matches, the WHOLE category is shown).
 * Returns { query, groups: [{ cat, blocks }], totalBlocks, truncated, emptyQuery }
 */
function searchHelp(rawQuery) {
    // v3.9.40 FIX: cap the input at 100 chars before processing. The slash
    // registry option now also has max_length:100, but this builder serves
    // TWO entry points (slash + modal) and old messages/modals can still come
    // through — a single defensive cap closes every route. Without the cap, a
    // multi-thousand-char query is echoed into the results embed
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
            // Guard: Discord max 25 options per select (currently 19 — if the
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
