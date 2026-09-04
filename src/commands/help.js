/**
 * Domain: help
 * Slash commands: /help
 *
 * v3.9.12: Comprehensive update — reflect all new commands from Phase 1+2+3
 * + modal editor for message config + ticket body template variables.
 * v3.9.37: Auto-Split updated to 3 categories (added 🤝 REKBER), added a
 * Midman/Rekber section, and the embed version is now dynamic from package.json (anti-stale).
 * v3.9.38: the /help embed total characters are measured (Discord limit 6000) — if
 * over 5800 (200 buffer), fields are split into 2 embeds (reply + followUp) so that
 * adding the next command doesn't make /help throw/choke the API.
 */

const { EmbedBuilder, MessageFlags } = require('./_shared');

// v3.9.37: version is taken dynamically from package.json (single source of truth)
// so /help never goes stale again (previously hardcoded "v3.9.26" even though
// the bot was already much newer).
const { version: BOT_VERSION } = require('../../package.json');

module.exports = async function (interaction) {
    // v3.9.38 FIX: the /help embed is currently ~5419/6000 chars (audited) — more
    // commands, more chars. If total > 5800, EmbedBuilder + the Discord API
    // will reject it (embed > 6000) → /help dies silently. Solution: measure the total
    // (title + description + fields + footer); if over budget, split the
    // trailing fields into a second embed sent as a followUp (ephemeral
    // visibility same as the first reply).
    const HELP_TOTAL_SPLIT_THRESHOLD = 5800;

    /**
     * Count the embed's total characters the way Discord counts the 6000 limit:
     * title + description + fields (name+value) + footer.text + author.name.
     * @param {EmbedBuilder} embed
     * @returns {number}
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

    /**
     * Build the /help embed from field chunks. `part` is filled in if this is a
     * continuation embed (2/2) so the display flows for the user.
     * @param {Array} fields - array of field objects for addFields
     * @param {string|null} part - null for the main embed, '2/2' for the continuation
     * @returns {EmbedBuilder}
     */
    function buildHelpEmbed(fields, part = null) {
        const embed = new EmbedBuilder()
            .setTitle(part ? `🤖 COMMUNITY BOT — HELP (${part})` : '🤖 COMMUNITY BOT — HELP')
            .setDescription(
                part
                    ? `_Continuation of the command list (v${BOT_VERSION})._`
                    : `Hello ${interaction.user}! You are verified as **Admin/Staff**.\n` +
                          `Here is the full list of available commands (v${BOT_VERSION}).`
            )
            .setColor(0x5865f2);
        if (fields.length > 0) embed.addFields(fields);
        embed
            .setFooter({
                text: `${interaction.client.user.username} v${BOT_VERSION} — All-in-One Community Bot`,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return embed;
    }

    const helpFields = [
            {
                name: '📋 Information',
                value: [
                    '• `/help` — show this help message',
                    '• `/list-products` — view all products',
                    '• `/list-categories` — view all ticket categories',
                    '• `/list-messages` — view all embed message texts',
                    '• `/config-show` — view all bot configuration'
                ].join('\n'),
                inline: false
            },

            {
                name: '🏗️ Ticket Panels (Multi-Panel)',
                value: [
                    '• `/setup-verify` — install the verification panel',
                    '• `/setup-ticket` — install the ticket panel (legacy)',
                    '• `/setup-ticket-panel` — full multi-panel setup:',
                    '   options: `title` `body` `color:#ff5733` `image` `thumbnail` `footer` `categories` `channel` `use_dropdown`',
                    '• `/list-panels` `/update-panel` `/refresh-panel` `/delete-panel`',
                    '• `/set-verify-button` — customize the verification button',
                    '💡 Multi-panel = each panel has its own customization. Saved to panels.json.'
                ].join('\n'),
                inline: false
            },

            {
                name: '🎫 Ticket Categories (CRUD)',
                value: [
                    '• `/add-category id:jasa label:"Jasa" emoji:🎮 style:Success requires_key:false`',
                    '• `/update-category id:jasa label:"Jasa Premium" emoji:"🛠️"` — edit without deleting',
                    '• `/list-categories` — view all categories',
                    '• `/remove-category id:jasa` — delete a category (defaults are protected)',
                    '💡 v3.9.19: flexible behavior — category with products → dropdown, category without products → opens a ticket directly.'
                ].join('\n'),
                inline: false
            },

            {
                name: '💬 Auto-Responder',
                value: [
                    '• `/add-responder` `/list-responder` `/remove-responder`',
                    '💡 Member sends a trigger → bot auto-replies. Great for FAQs.'
                ].join('\n'),
                inline: false
            },

            {
                name: '🛡️ Anti-Spam & Auto-Mod',
                value: [
                    '• `/set-automod` `/automod-show` `/automod-toggle`',
                    '• `/add-word words:word1,word2 action:mute_10m` — add words (append)',
                    '• `/remove-word word:word` `/list-words` — delete/view words',
                    '• `/add-word words:Exempt_(allowed_word)` — whitelist a word against false positives',
                    '• `/add-link-whitelist` `/remove-link-whitelist`',
                    '💡 v3.9.23: per-word actions + whole-word matching ("asu" won\'t match "asus")'
                ].join('\n'),
                inline: false
            },

            {
                name: '💤 AFK System',
                value: ['• `/afk` `/afk-clear` `/afk-list`', '💡 The bot auto-replies when an AFK user is mentioned.'].join('\n'),
                inline: false
            },

            {
                name: '📊 Leveling System',
                value: [
                    '• `/setup-leveling` `/add-level-role` `/list-level-roles` `/remove-level-role`',
                    '• `/rank` `/leaderboard-level` (public)',
                    '💡 XP per message, level up → role auto-assigned.'
                ].join('\n'),
                inline: false
            },

            {
                name: '🎭 Role Settings',
                value: [
                    '• `/set-role verified @role` — set a role (verified/unverified/admin/**midman**)',
                    '• `/remove-role verified` — remove the role from config'
                ].join('\n'),
                inline: false
            },

            {
                name: '📢 Channel Settings & Ticket Auto-Split',
                value: [
                    '• `/set-channel welcome #ch` — set a channel (welcome/goodbye/invoice/audit-log/**transcript**)',
                    '• `/remove-channel welcome` — remove the channel from config',
                    '• `/set-channel transcript #ch` — auto-save ticket transcripts before close',
                    '',
                    '**🎫 Auto-Split:** the bot splits tickets into 3 categories automatically:',
                    '• **`🎫 TRANSACTIONS`** — all product tickets: with key (🔑 Set Key) OR non-key (📦 Deliver Order)',
                    '• **`🎫 SUPPORT`** — tickets in categories without products (help/report/claim_giveaway)',
                    '• **`🤝 ESCROW`** — middleman escrow deal channel (created when an escrow deal is opened)',
                    'Want custom names? Edit `data/config.json`: `ticketCategoryKey`, `ticketCategoryNoKey`, `midman.category`'
                ].join('\n'),
                inline: false
            },

            {
                name: '✏️ Embed Message Settings',
                value: [
                    '• `/set-message ticketBody text...` (quick, 1-line)',
                    '• `/edit-message type:"Ticket Body"` → opens a multi-line modal editor',
                    '• `/reset-message ticketBody` / `/reset-message ALL`',
                    '',
                    '**Template vars:** `{server}` `{price_header}` `{price_list}` `{price_list:cat}` `{categories_list}`'
                ].join('\n'),
                inline: false
            },

            {
                name: '📦 Products & Auto-Role',
                value: [
                    '• `/add-product` `/remove-product` `/list-products`',
                    '• `/update-product value:vip30 label:"VIP 30 Hari" price:"Rp 30.000"` — edit without deleting',
                    '• `/set-product-role` `/remove-product-role` `/list-product-roles`',
                    '💡 VIP role + auto-expire (days). You can mix key & non-key products (services).',
                    '💡 Non-key products (accounts, services)? `/add-product ... requires_key:false` → the ticket gets a **📦 Deliver Order** button (details sent via DM to the buyer + auto-role + invoice + stats).'
                ].join('\n'),
                inline: false
            },

            {
                name: '🔑 Key Manager',
                value: [
                    '• `/set-key user:@user value:vip30 key:ABCDE-12345`',
                    '• `/list-keys user:@user`',
                    '• `/clear-schedule user:@user clear_keys:true`'
                ].join('\n'),
                inline: false
            },

            {
                name: '🤝 Midman / Escrow',
                value: [
                    '• `/set-role midman @role` — must be set before any deal can be opened',
                    '• `/set-midman-fee mode:percent value:5` — automatic fee per deal (percent / flat, 0 = free)',
                    '• `/midman-deals` — view all active escrow deals on the server',
                    '💡 3-party escrow deal (buyer ⇄ seller + a middleman holds the funds). Anyone can open one via the **🤝 Escrow** button on the panel — 3 steps: item & price → pick the buyer → pick the seller, then both parties click **Agree to Deal**.'
                ].join('\n'),
                inline: false
            },

            {
                name: '🎭 Self-Role Panel',
                value: [
                    '• `/setup-selfrole title:... type:button exclusive:false`',
                    '• `/selfrole-add` `/selfrole-remove` `/selfrole-list` `/selfrole-delete`',
                    '💡 `requires_role:@Verified` — conditional role'
                ].join('\n'),
                inline: false
            },

            {
                name: '🎤 Temp Voice',
                value: [
                    '• `/setup-tempvoice` / `/tempvoice-remove`',
                    '💡 Member joins the trigger channel → a private voice channel is created automatically'
                ].join('\n'),
                inline: false
            },

            {
                name: '📢 Announce, Embed & Backup',
                value: [
                    '• `/announce channel:#ch title:... description:...`',
                    '• `/send-message` `/embed-builder` `/embed-list` `/embed-cancel`',
                    '• `/backup-now` `/backup-list` `/restore-backup` (auto 24h, max 7)'
                ].join('\n'),
                inline: false
            },

            {
                name: '🎉 Giveaway & Poll',
                value: [
                    '• `/giveaway create channel:#ch prize:... winners:1 duration:60`',
                    '• `/giveaway list` `/giveaway end` `/giveaway reroll`',
                    '• `/poll create` `/poll list` `/poll close`'
                ].join('\n'),
                inline: false
            },

            {
                name: '⏰ Scheduled Announce & Warn',
                value: [
                    '• `/announce-schedule channel:#ch at:30m recurring?:daily`',
                    '• `/announce-list` `/announce-cancel`',
                    '• `/warn` `/warn-list` `/warn-remove` `/warn-clear` (3=mute1h, 5=mute1d, 7=kick)'
                ].join('\n'),
                inline: false
            },

            {
                name: '📊 Stats & More',
                value: [
                    '• `/stats` `/leaderboard metric:messages|vipPurchases|totalSpent` `/my-stats`',
                    '• `/set-channel audit-log #ch` — log admin actions',
                    '• `/reset-config` — ⚠️ DELETES ALL settings (2-step confirmation)'
                ].join('\n'),
                inline: false
            }
    ];

    // v3.9.38 FIX: measure first — only split if over budget (the current embed is
    // 5419 → still 1 embed, no behavior change for the user).
    let firstFields = helpFields;
    const secondFields = [];
    while (firstFields.length > 1 && embedTotalChars(buildHelpEmbed(firstFields)) > HELP_TOTAL_SPLIT_THRESHOLD) {
        // Move the LAST field to the second embed (repeat until it fits).
        secondFields.unshift(firstFields[firstFields.length - 1]);
        firstFields = firstFields.slice(0, -1);
    }

    if (secondFields.length > 0) {
        // Over budget → send 2 embeds in a row with the same visibility.
        await interaction.reply({ embeds: [buildHelpEmbed(firstFields)], flags: MessageFlags.Ephemeral });
        return interaction.followUp({ embeds: [buildHelpEmbed(secondFields, '2/2')], flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({ embeds: [buildHelpEmbed(helpFields)], flags: MessageFlags.Ephemeral });
};
