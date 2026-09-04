/**
 * Domain: config
 * Slash commands: /setup-verify, /setup-ticket, /set-role, /set-channel,
 *                 /set-message, /remove-role, /remove-channel, /list-messages,
 *                 /reset-message, /reset-config, /config-show
 *
 * Split from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: manage bot config (roles, channels, messages) + set up verification/ticket panels.
 * v3.9.30: /set-transcript-channel (panels) merged into /set-channel tipe:transcript.
 */

const {
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    MessageFlags,
    getConfig,
    saveConfig,
    setField,
    DEFAULTS,
    Embeds,
    logAudit,
    safeEditReply,
    invalidateAdminRoleCache,
    getKeyStatsByGuild,
    getScheduledActiveByGuild,
    getPanelsByGuild,
    getSessionsByUser,
    EMBED_LIMITS
} = require('./_shared');

// v3.9.12: ModalBuilder for /edit-message
// v3.9.30: ChannelType for /set-channel validation (all types need a text channel)
const { ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType } = require('discord.js');

// v3.9.25: convert literal \n → real newline (multi-line PC feature)
// v3.9.38: truncateUtf8Safe — trims text per code point (emoji safe)
const { normalizeNewlines, truncateUtf8Safe } = require('../infra/text');

module.exports = async function (interaction) {
    const embeds = new Embeds(interaction.client);
    const config = getConfig();

    // === SETUP VERIFY ===
    if (interaction.commandName === 'setup-verify') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // If the verified role isn't set yet, ask the admin to set it first
        if (!config.roles.verified) {
            return safeEditReply(interaction, {
                content: '❌ The Verified role is not set yet. Use `/set-role verified @role` first.'
            });
        }

        const embed = new EmbedBuilder()
            .setTitle(config.messages.verifyTitle)
            .setDescription(config.messages.verifyBody.replace(/\{server\}/g, interaction.guild.name))
            .setColor(0x2ecc71)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();

        // v3.9.11 Phase 1: verify button configurable (label/emoji/style from config.verifyButton).
        const btnConfig = config.verifyButton || {};
        const styleMap = {
            Primary: ButtonStyle.Primary,
            Secondary: ButtonStyle.Secondary,
            Success: ButtonStyle.Success,
            Danger: ButtonStyle.Danger
        };
        const btnStyle = styleMap[btnConfig.style] || ButtonStyle.Success;
        const btnEmoji = btnConfig.emoji || '✅';
        const btnLabel = btnConfig.label || 'Verify Me';

        const verifyBtn = new ButtonBuilder()
            .setCustomId('btn_verify')
            .setLabel(btnLabel.slice(0, 80))
            .setEmoji(btnEmoji)
            .setStyle(btnStyle);

        // v3.9.11 Phase 1: emoji can be a custom emoji ID (<:name:id>) or unicode.
        // Discord ButtonBuilder.setEmoji handles both automatically.
        const row = new ActionRowBuilder().addComponents(verifyBtn);

        // Send the panel to the channel. If that fails (usually permissions), reply with a clear error
        // so the admin knows what to fix.
        try {
            await interaction.channel.send({ embeds: [embed], components: [row] });
        } catch (sendErr) {
            return safeEditReply(interaction, {
                content: `❌ Failed to send the verification panel: ${sendErr.message}\n\nMake sure the bot has **Send Messages** and **Embed Links** permissions in this channel.`
            });
        }
        return safeEditReply(interaction, { content: '✅ Verification panel installed!' });
    }

    // === SETUP TICKET ===
    if (interaction.commandName === 'setup-ticket') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // v3.9.17 FIX: validate roles.admin up front. Before, the panel got installed
        // without a check — when a user clicked a category button, createTicket returned the error
        // "Admin role is not set yet" → the admin had no idea until a user reported it.
        if (!config.roles.admin) {
            return safeEditReply(interaction, {
                content: '❌ Admin role not set yet. Use `/set-role admin @role` first before setting up the ticket panel.'
            });
        }

        // v3.9.11 Phase 2: auto-migrate old products (add category & default requiresKey).
        // Done in configManager getConfig(), but we double-check here too.
        const productsWithCategory = (config.products || []).map(p => ({
            ...p,
            category: p.category || 'transaction',
            requiresKey: p.requiresKey !== undefined ? p.requiresKey : true
        }));

        // v3.9.11 Phase 2: use config.ticketCategories to render dynamic buttons.
        // If no categories exist yet (old config), use the default 3 buttons (legacy behavior).
        const categories = config.ticketCategories || [];
        const styleMap = {
            Primary: ButtonStyle.Primary,
            Secondary: ButtonStyle.Secondary,
            Success: ButtonStyle.Success,
            Danger: ButtonStyle.Danger
        };

        // v3.9.12: use fillTemplate with ticket-specific variables.
        // Variables available for ticketBody:
        //   {server}            → guild name
        //   {price_list}        → all products (auto-generated)
        //   {price_list:<cat>}  → products filtered by category
        //   {price_header}      → config.messages.ticketPriceHeader
        //   {categories_list}   → category list (for multi-panel info)
        const { fillTemplate } = require('../data/configManager');

        // Build price list per category
        const priceListByCategory = {};
        for (const cat of categories) {
            const prods = productsWithCategory.filter(p => (p.category || 'transaction') === cat.id);
            priceListByCategory[cat.id] =
                prods.length > 0 ? prods.map(p => `• **${p.label}** — ${p.price}`).join('\n') : `_(no products yet)_`;
        }

        // All-products price list (all categories combined)
        const fullPriceList =
            productsWithCategory.length > 0
                ? productsWithCategory.map(p => `• **${p.label}** — ${p.price}`).join('\n')
                : '_(no products yet — use `/add-product`)_';

        // Categories list (for multi-panel info)
        const categoriesListStr =
            categories.length > 0
                ? categories.map(c => `${c.emoji} **${c.label}** (\`${c.id}\`)`).join(' • ')
                : '_(no categories yet)_';

        const priceHeader = config.messages?.ticketPriceHeader || '💰 PRICE LIST 💰';

        const renderedBody = fillTemplate(config.messages.ticketBody, {
            server: interaction.guild.name,
            priceList: fullPriceList,
            priceHeader,
            categoriesList: categoriesListStr,
            priceListByCategory
        });

        // v3.9.38 FIX: validate length AFTER {price_list} template expansion —
        // previously only the raw text was validated (/set-message), so a
        // 500 char body + 40 products (±120 char/product) passed validation but
        // setDescription(renderedBody) threw RangeError >4096 when the panel was installed
        // (the ticket panel went completely dead until the body was shortened). Pre-validate, not
        // try/catch, so the error message stays clear for the admin.
        if ((config.messages.ticketTitle || '').length > EMBED_LIMITS.TITLE) {
            return safeEditReply(interaction, {
                content: `❌ Ticket Title is too long (${config.messages.ticketTitle.length} char, max ${EMBED_LIMITS.TITLE}). Shorten it via \`/set-message ticketTitle\`.`
            });
        }
        if (renderedBody.length > EMBED_LIMITS.DESCRIPTION) {
            return safeEditReply(interaction, {
                content:
                    `❌ Ticket body is too long AFTER {price_list} expansion: **${renderedBody.length}/${EMBED_LIMITS.DESCRIPTION}** char.\n\n` +
                    `💡 Shorten the ticket body (\`/set-message ticketBody\`), reduce the number of products, or use \`{price_list:<category>}\` to show only a specific category.`
            });
        }

        const embed = new EmbedBuilder()
            .setTitle(config.messages.ticketTitle)
            .setDescription(renderedBody)
            .setColor(0xe67e22)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();

        // v3.9.11 Phase 2: render buttons from config.ticketCategories.
        // Discord limit: 5 buttons per ActionRow, max 5 rows (25 buttons total).
        // If there are more than 5 categories, split them across multiple rows.
        const rows = [];
        let currentRow = new ActionRowBuilder();
        let btnCount = 0;

        for (const cat of categories.slice(0, 25)) {
            if (btnCount === 5) {
                rows.push(currentRow);
                currentRow = new ActionRowBuilder();
                btnCount = 0;
            }
            const btnStyle = styleMap[cat.style] || ButtonStyle.Primary;
            const btn = new ButtonBuilder()
                .setCustomId(`ticket_cat:${cat.id}`)
                .setLabel((cat.label || cat.id).slice(0, 80))
                .setEmoji(cat.emoji || '🎫')
                .setStyle(btnStyle);
            currentRow.addComponents(btn);
            btnCount++;
        }
        if (btnCount > 0) rows.push(currentRow);

        // Fallback when categories are empty: use the legacy buttons (ticket_trade, ticket_help, ticket_report)
        // v3.9.18: labels updated to "Help" & "Report" (previously "Bantuan Staff" & "Laporkan Member").
        if (rows.length === 0) {
            const fallbackRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_trade')
                    .setLabel('Buy Key / Transaction')
                    .setEmoji('🛒')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('ticket_help')
                    .setLabel('Help')
                    .setEmoji('📞')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('ticket_report')
                    .setLabel('Report')
                    .setEmoji('⚠️')
                    .setStyle(ButtonStyle.Danger)
            );
            rows.push(fallbackRow);
        }

        // Send the panel to the channel. Wrap in try/catch so the error message stays clear for the admin.
        try {
            await interaction.channel.send({ embeds: [embed], components: rows });
        } catch (sendErr) {
            return safeEditReply(interaction, {
                content: `❌ Failed to send the ticket panel: ${sendErr.message}\n\nMake sure the bot has **Send Messages** and **Embed Links** permissions in this channel.`
            });
        }
        return safeEditReply(interaction, {
            content: `✅ Ticket panel installed! (${categories.length} active categories)`
        });
    }

    // === SET ROLE ===
    if (interaction.commandName === 'set-role') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');
        const role = interaction.options.getRole('role');

        // v3.9.38 FIX: validate that the bot can actually assign the role — previously managed/
        // @everyone/roles positioned above the bot passed validation → got saved to config,
        // then auto-role silently failed on every member join/verify (no
        // error until the admin checked manually).
        if (role.id === interaction.guild.id) {
            return safeEditReply(interaction, {
                content: '❌ @everyone cannot be used. Pick a regular role.'
            });
        }
        if (role.managed) {
            return safeEditReply(interaction, {
                content: '❌ This role is managed by another integration/bot — it cannot be assigned by the bot.'
            });
        }
        // Null-guard: guild.members.me can be null in a partial state — fall back to 0
        // (strict max; the admin is told to move the bot role up first).
        const botHighestPos = interaction.guild.members.me?.roles?.highest?.position ?? 0;
        if ((role.position ?? 0) >= botHighestPos) {
            return safeEditReply(interaction, {
                content:
                    '❌ This role is positioned ABOVE the bot highest role — the bot cannot assign it. ' +
                    'Move the bot role up in Server Settings → Roles, or pick another role.'
            });
        }

        setField(`roles.${tipe}`, role.id);
        await logAudit(interaction.client, {
            action: 'SET_ROLE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Role **${tipe}** set to ${role.name} (\`${role.id}\`)`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, { content: `✅ Role **${tipe}** set to ${role} (\`${role.id}\`)` });
    }

    // === SET CHANNEL ===
    // v3.9.30: the former /set-transcript-channel merged into here — one command
    // for all channels (invoice/welcome/goodbye/audit-log/transcript).
    if (interaction.commandName === 'set-channel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');
        const channel = interaction.options.getChannel('channel');

        // Validate the channel type: every purpose here needs a text channel
        // (the bot sends embeds/text — voice/category/announcement-forum will not work).
        if (!channel || channel.type !== ChannelType.GuildText) {
            return safeEditReply(interaction, { content: '❌ The channel must be a text channel.' });
        }

        setField(`channels.${tipe}`, channel.id);
        await logAudit(interaction.client, {
            action: 'SET_CHANNEL',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Channel **${tipe}** set to #${channel.name} (\`${channel.id}\`)`,
            guildId: interaction.guild.id
        });

        // v3.9.30 (moved from the former /set-transcript-channel): transcript-specific tip.
        const transcriptTip =
            tipe === 'transcript'
                ? '\n\n💡 Every ticket that gets closed will auto-save its chat history to this channel as proof of the transaction.'
                : '';
        return safeEditReply(interaction, {
            content: `✅ Channel **${tipe}** set to ${channel} (\`${channel.id}\`)${transcriptTip}`
        });
    }

    // === EDIT MESSAGE (v3.9.12: modal editor — more flexible than /set-message) ===
    // Opens a modal with a textarea pre-filled with the current text.
    // The admin can comfortably edit multi-line and preview before applying.
    if (interaction.commandName === 'edit-message') {
        const tipe = interaction.options.getString('tipe');
        const currentValue = config.messages[tipe] || '';

        const isTitle = tipe.endsWith('Title');
        const maxLength = isTitle ? EMBED_LIMITS.TITLE : EMBED_LIMITS.DESCRIPTION;

        const modal = new ModalBuilder().setCustomId(`modal_edit_message:${tipe}`).setTitle(`Edit ${tipe}`);

        const input = new TextInputBuilder()
            .setCustomId('message_text')
            .setLabel(`${tipe} text (max ${maxLength} char)`)
            .setStyle(isTitle ? TextInputStyle.Short : TextInputStyle.Paragraph)
            .setValue(currentValue.slice(0, 4000))
            .setMinLength(1)
            .setMaxLength(Math.min(maxLength, 4000))
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
    }

    // === SET MESSAGE ===
    if (interaction.commandName === 'set-message') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');
        const rawTeks = interaction.options.getString('teks');

        // P2-10 FIX: validate length against Discord embed limits.
        // Previously: an admin could set text of any length → when the embed was sent,
        // `setTitle` / `setDescription` threw an error → silent failure.
        const isTitle = tipe.endsWith('Title');
        // v3.9.25: literal \n → real newline for Body types (slash command input
        // on PC/mobile cannot press Enter). *Title types are deliberately NOT converted:
        // Discord embed titles reject newlines — if converted, the verification/
        // welcome panel would fail to send during setup.
        const teks = isTitle ? rawTeks : normalizeNewlines(rawTeks);
        const limit = isTitle ? EMBED_LIMITS.TITLE : EMBED_LIMITS.DESCRIPTION;
        const limitLabel = isTitle ? 'title (max 256)' : 'body (max 4096)';
        if (teks.length > limit) {
            return safeEditReply(interaction, {
                content: `❌ Text too long for **${tipe}**.\n\n📏 Length: **${teks.length}** char\n🎯 Limit: **${limit}** char (${limitLabel})\n💡 Trim ${teks.length - limit} more char.`
            });
        }
        setField(`messages.${tipe}`, teks);
        await logAudit(interaction.client, {
            action: 'SET_MESSAGE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Set message **${tipe}** (${teks.length} char)`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Message **${tipe}** updated.\n\nPreview:\n\`\`\`\n${teks}\n\`\`\`\nAvailable variables: \`{user}\` \`{username}\` \`{server}\` \`{count}\` \`{action}\``
        });
    }

    // === CONFIG SHOW (v3.1 — comprehensive view) ===
    if (interaction.commandName === 'config-show') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const fmt = (id, type) => (id ? `<${type}:${id}> (\`${id}\`)` : '❌ not set yet');

        // v3.9.38 FIX: defense-in-depth — ALL field values are capped at 1024 char
        // (the Discord limit). If a joined value is too long, trim it (per code
        // point, emoji safe) + note; the budget is reduced by note + ellipsis so the
        // total (content + '…' + note) still fits <= 1024 code units.
        const DIPOTONG_NOTE = '\n… (truncated — 1024 char Discord field limit)';
        const capFieldValue = value => {
            if (typeof value !== 'string' || value.length <= EMBED_LIMITS.FIELD_VALUE) return value;
            return truncateUtf8Safe(value, EMBED_LIMITS.FIELD_VALUE - DIPOTONG_NOTE.length - 1) + DIPOTONG_NOTE;
        };

        // v3.9.38 FIX: capped list — max the first `maxShown` entries + a
        // "+N more" suffix. If the combined entries + suffix (+ header prefix) still
        // don't fit in the field (1024 char), reduce the entry count one by
        // one so the suffix stays intact at the end (instead of getting cut mid-text).
        const buildCappedList = (items, maxShown, renderEntry, moreSuffix, emptyText, prefix = '') => {
            if (items.length === 0) return `${prefix}${emptyText}`;
            for (let n = Math.min(maxShown, items.length); n >= 1; n--) {
                const hidden = items.length - n;
                const value =
                    prefix + items.slice(0, n).map(renderEntry).join('\n') + (hidden > 0 ? moreSuffix(hidden) : '');
                if (value.length <= EMBED_LIMITS.FIELD_VALUE) return value;
            }
            // A single super-long entry (practically impossible) → trim per code point.
            return capFieldValue(prefix + items.slice(0, 1).map(renderEntry).join('\n'));
        };

        // --- Stats: VIP Keys ---
        // v3.9.4: scoped per guild — previously getKeyStats() returned a global count.
        const keyStats = getKeyStatsByGuild(interaction.guild.id);
        const keyLines = [
            `• Total keys stored: **${keyStats.total}**`,
            `• Active: **${keyStats.active}**${keyStats.permanent > 0 ? ` (including ${keyStats.permanent} permanent)` : ''}`,
            keyStats.expired > 0
                ? `• ⚠️ Expired (waiting for the scheduler to clean up): **${keyStats.expired}**`
                : `• Expired: **0** ✅`
        ];

        // --- Stats: Scheduled Role Removals ---
        // v3.9.4: scoped per guild — previously getAllScheduledActive() returned a global list.
        const scheduled = getScheduledActiveByGuild(interaction.guild.id);
        let nextDueStr = '—';
        if (scheduled.length > 0) {
            const next = scheduled.reduce((a, b) => (a.expireAt < b.expireAt ? a : b));
            const msLeft = next.expireAt - Date.now();
            if (msLeft > 0) {
                const days = Math.floor(msLeft / 86400000);
                const hours = Math.floor((msLeft % 86400000) / 3600000);
                nextDueStr = days > 0 ? `${days}d ${hours}h left` : `${hours}h left`;
            } else {
                nextDueStr = 'runs on the next loop';
            }
        }
        const schedLines = [
            `• Total active schedules: **${scheduled.length}**`,
            `• Next execution: **${nextDueStr}**`,
            `• Scheduler loop: every 60 seconds`
        ];

        // --- Stats: Self-Role Panels (this guild) ---
        // v3.9.38 FIX: cap the panels shown (15) + suffix — previously
        // panelSummary was unbounded → field value > 1024 char at ~17 panels →
        // addFields threw RangeError (the /config-show command went completely dead until
        // panels were removed).
        const panels = getPanelsByGuild(interaction.guild.id);
        const panelSummary = buildCappedList(
            panels,
            15,
            p =>
                `  • **${p.title}** — ${p.type === 'button' ? '🔘 Button' : '📋 Select'} | ${p.exclusive ? '🔒 Exclusive' : '✅ Multi'} | ${p.roles.length} role`,
            hidden => `\n… +${hidden} more panel`,
            '_(no panels yet — use `/setup-selfrole`)_',
            `${panels.length} panels registered in this guild:\n`
        );

        // --- Stats: Embed Builder Sessions (owned by this user) ---
        const mySessions = getSessionsByUser(interaction.user.id);
        const sessionLine =
            mySessions.length > 0
                ? `**${mySessions.length} active session** (owned by you) — use \`/embed-list\` to see the details`
                : '_(no active session — use `/embed-builder` to start)_';

        // --- Products detail (with role + days mapping) ---
        // v3.9.38 FIX: cap the products shown (10) + suffix — previously
        // productLines was unbounded → field value > 1024 char at ~12 products →
        // addFields threw RangeError (the /config-show command always errored
        // until products were reduced).
        const productLines = buildCappedList(
            config.products,
            10,
            p => {
                const roleStr = p.roleId ? `<@&${p.roleId}>` : '❌ not mapped yet';
                const daysStr = p.days === 0 || !p.days ? '♾️ permanent' : `${p.days} days`;
                return `• **${p.label}** (\`${p.value}\`) — ${p.price}\n  → Role: ${roleStr} | Duration: ${daysStr}`;
            },
            hidden => `\n\n… +${hidden} more products — use /list-products`,
            '_(no products yet — use `/add-product`)_'
        );

        const embed = embeds
            .info(
                '⚙️ BOT CONFIGURATION',
                'Here is the current bot setup (v3.1 — key-driven VIP + self-role + embed builder):'
            )
            .addFields(
                {
                    name: '🎭 Roles',
                    value: capFieldValue(
                        [
                            `• Verified: ${fmt(config.roles.verified, '@&')}`,
                            `• Unverified: ${fmt(config.roles.unverified, '@&')}`,
                            `• Admin: ${fmt(config.roles.admin, '@&')}`,
                            `• Midman (Escrow): ${fmt(config.roles.midman, '@&')}`
                        ].join('\n')
                    ),
                    inline: false
                },
                {
                    name: '🤝 Escrow (v3.9.32)',
                    value: capFieldValue(
                        [
                            `• Fee: ${
                                config.midman?.feeMode === 'flat'
                                    ? `${config.midman?.feeValue ?? 0} flat per deal`
                                    : `${config.midman?.feeValue ?? 5}% of the deal price`
                            }`,
                            `• Channel category: ${config.midman?.category || '🤝 ESCROW'}`,
                            '• View active deals: `/midman-deals`'
                        ].join('\n')
                    ),
                    inline: false
                },
                {
                    name: '📢 Channels',
                    value: capFieldValue(
                        [
                            `• Welcome: ${fmt(config.channels.welcome, '#')}`,
                            `• Goodbye: ${fmt(config.channels.goodbye, '#')}`,
                            `• Invoice: ${fmt(config.channels.invoice, '#')}`,
                            `• Audit Log: ${fmt(config.channels['audit-log'], '#')}`,
                            `• Ticket Transcript: ${fmt(config.channels.transcript, '#')}`
                        ].join('\n')
                    ),
                    inline: false
                },
                { name: `📦 Products (${config.products.length})`, value: capFieldValue(productLines), inline: false },
                {
                    name: '🔑 VIP Keys (Key-Driven Model)',
                    value: capFieldValue(keyLines.join('\n')),
                    inline: false
                },
                { name: '⏰ Scheduled Role Removals', value: capFieldValue(schedLines.join('\n')), inline: false },
                { name: `🎭 Self-Role Panels (${panels.length})`, value: capFieldValue(panelSummary), inline: false },
                { name: '🛠️ Embed Builder Sessions', value: capFieldValue(sessionLine), inline: false }
            );
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === REMOVE ROLE ===
    if (interaction.commandName === 'remove-role') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');
        const current = config.roles[tipe];
        if (!current) {
            return safeEditReply(interaction, {
                content: `ℹ️ The **${tipe}** role isn't set anyway — nothing to remove.`
            });
        }
        delete config.roles[tipe];
        saveConfig(config);
        // v3.9.2: invalidate the permissions cache when the admin role is removed
        if (tipe === 'admin') {
            try {
                invalidateAdminRoleCache();
            } catch (_) {}
        }
        await logAudit(interaction.client, {
            action: 'REMOVE_ROLE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Removed role **${tipe}** from config (previously: <@&${current}>)`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Role **${tipe}** removed from config.\n\n💡 To set it again, use: \`/set-role ${tipe} @role\``
        });
    }

    // === REMOVE CHANNEL ===
    if (interaction.commandName === 'remove-channel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');
        const current = config.channels[tipe];
        if (!current) {
            return safeEditReply(interaction, {
                content: `ℹ️ The **${tipe}** channel isn't set anyway — nothing to remove.`
            });
        }
        delete config.channels[tipe];
        saveConfig(config);
        await logAudit(interaction.client, {
            action: 'REMOVE_CHANNEL',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Removed channel **${tipe}** from config (previously: <#${current}>)`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Channel **${tipe}** removed from config.\n\n💡 To set it again, use: \`/set-channel ${tipe} #channel\``
        });
    }

    // === LIST MESSAGES ===
    if (interaction.commandName === 'list-messages') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const fields = [];
        const labels = {
            welcomeTitle: '👋 Welcome Title',
            welcomeBody: '👋 Welcome Body',
            goodbyeTitle: '👋 Goodbye Title',
            goodbyeBody: '👋 Goodbye Body',
            verifyTitle: '✅ Verify Title',
            verifyBody: '✅ Verify Body',
            ticketTitle: '🎫 Ticket Title',
            ticketBody: '🎫 Ticket Body',
            // v3.9.11 Phase 1: ticket price header configurable
            ticketPriceHeader: '🎫 Ticket Price Header'
        };
        for (const [key, label] of Object.entries(labels)) {
            const val = config.messages[key] || '(empty)';
            // Trim long text so it fits in a Discord field (1024 char).
            // v3.9.38 FIX: trim per code point — plain slice() can cut
            // an emoji surrogate pair into a lone surrogate (embed rejected by Discord).
            const truncated = truncateUtf8Safe(val, 500);
            fields.push({ name: label, value: '```\n' + truncated + '\n```', inline: false });
        }
        const embed = embeds
            .info(
                '📝 EMBED MESSAGE LIST',
                'Here is all the current message text. Use `/set-message` to change it, `/reset-message` to restore defaults.'
            )
            .addFields(fields);
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === RESET MESSAGE ===
    if (interaction.commandName === 'reset-message') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');

        if (tipe === 'ALL') {
            config.messages = { ...DEFAULTS.messages };
            saveConfig(config);
            await logAudit(interaction.client, {
                action: 'RESET_MESSAGE',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Reset ALL messages to default`,
                guildId: interaction.guild.id
            });
            return safeEditReply(interaction, { content: '✅ **ALL messages** reset to default.' });
        }

        const before = config.messages[tipe];
        config.messages[tipe] = DEFAULTS.messages[tipe];
        saveConfig(config);
        await logAudit(interaction.client, {
            action: 'RESET_MESSAGE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Reset message **${tipe}** to default`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Message **${tipe}** reset to default.\n\n**Before:**\n\`\`\`\n${before}\n\`\`\`\n**Now:**\n\`\`\`\n${config.messages[tipe]}\n\`\`\``
        });
    }

    // === RESET CONFIG (delete everything) — v3.9.0: with a 2-step confirmation button ===
    // Previously: one click of /reset-config → all config gone, no undo.
    // Now: show a confirmation button first; the admin must click "Yes, Reset"
    // to actually reset. Prevents fat-finger / misclick.
    if (interaction.commandName === 'reset-config') {
        const confirmBtn = new ButtonBuilder()
            .setCustomId('reset_config_confirm')
            .setLabel('⚠️ Yes, Full Reset')
            .setStyle(ButtonStyle.Danger);
        const cancelBtn = new ButtonBuilder()
            .setCustomId('reset_config_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);

        return interaction.reply({
            content:
                '🚨 **RESET CONFIG CONFIRMATION**\n\n' +
                'Warning: this will delete **ALL** settings (roles, channels, products, messages).\n' +
                'This cannot be undone!\n\n' +
                'Click the button below to confirm:',
            components: [row],
            flags: MessageFlags.Ephemeral
        });
    }
};
