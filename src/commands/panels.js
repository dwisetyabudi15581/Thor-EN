/**
 * Domain: panels
 * Slash commands: /set-verify-button, /setup-ticket-panel
 *
 * v3.9.11 Phase 1: verify button customization
 * v3.9.11 Phase 3: multi-panel ticket + transcript channel (the command was
 *          merged into /set-channel tipe:transcript as of v3.9.30 — config domain)
 * v3.9.14: persistent panel storage (panels.json) + full customization per panel
 *          (title, body, color, image, thumbnail, footer, layout, channel target).
 *          New shared builder: buildTicketPanel(panel, ctx) so that
 *          /setup-ticket-panel & /refresh-panel can reuse the same code.
 */

const {
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ChannelType,
    MessageFlags,
    StringSelectMenuBuilder,
    getConfig,
    saveConfig,
    logAudit,
    safeEditReply
} = require('./_shared');

const { fillTemplate } = require('../data/configManager');
const { upsertPanel } = require('../data/panelManager');
// v3.9.17: shared parseColor + parseColorOrError for consistency across the whole codebase.
const { parseColorOrError } = require('../infra/colors');
// v3.9.24: normalize literal \n → real newline (command input on PC can't press Enter).
const { normalizeNewlines, isValidEmoji } = require('../infra/text');

const VALID_STYLES = ['Primary', 'Secondary', 'Success', 'Danger'];
const STYLE_MAP = {
    Primary: ButtonStyle.Primary,
    Secondary: ButtonStyle.Secondary,
    Success: ButtonStyle.Success,
    Danger: ButtonStyle.Danger
};

// Discord button limits
const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;

/**
 * v3.9.17: this local parseColor is kept for backward compat (used in
 * panels-mgmt.js and tests). Behavior stays the same: THROW when invalid.
 * But it now delegates to the shared `parseColorOrError` in infra/colors.js
 * so the logic isn't duplicated. New callers should use `parseColorOrError`
 * directly from `infra/colors.js`.
 *
 * @deprecated Use `parseColorOrError` from `infra/colors.js` instead.
 */
function parseColor(input) {
    const result = parseColorOrError(input);
    if (!result.ok) {
        throw new Error(result.error);
    }
    return result.color;
}

/**
 * Validate URL format (http/https). Returns null if invalid.
 */
function validateUrl(input) {
    if (input === null || input === undefined || input === '') return null;
    if (typeof input !== 'string') return null;
    try {
        const u = new URL(input);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return input;
    } catch (_) {
        return null;
    }
}

/**
 * v3.9.29: Safety net — detect categories in the panel that DON'T have products.
 *
 * Why it matters: a category without products → clicking its button opens a
 * SUPPORT ticket directly (not a transaction — not a bug, it's the "quick action" feature).
 * But if an admin just created a sales category (e.g. `akun_ml`) and forgot to
 * add products, buyer tickets silently become support tickets without the admin noticing.
 * This helper surfaces it in /refresh-panel & /setup-ticket-panel.
 *
 * The `help`/`report` categories are skipped — they're quick actions by design
 * (always empty, the warning would just be noise).
 * v3.9.37: the `midman` category is also skipped — clicking its button opens the
 * escrow deal modal (not a ticket), so "no products yet" isn't a problem at all
 * (products in the midman category will never even be shown — the click is
 * always routed to the deal flow).
 *
 * @param {Object} panel - panel metadata (categoryIds is used, mirrors the
 *   buildTicketPanel logic: empty = all categories)
 * @param {Object} config - global config (ticketCategories + products)
 * @returns {string[]} warning lines (empty = no issues)
 */
function findEmptyCategoryWarnings(panel, config) {
    const allCategories = config.ticketCategories || [];
    const categoryIds = Array.isArray(panel.categoryIds) ? panel.categoryIds : [];
    let categoriesToShow =
        categoryIds.length === 0 ? allCategories : allCategories.filter(c => categoryIds.includes(c.id));
    if (categoriesToShow.length === 0) categoriesToShow = allCategories;

    const products = config.products || [];
    const lines = [];
    for (const cat of categoriesToShow) {
        if (!cat || cat.id === 'help' || cat.id === 'report' || cat.id === 'midman') continue; // default quick-action / escrow deal
        const hasProducts = products.some(p => (p.category || 'transaction') === cat.id);
        if (hasProducts) continue;
        if (cat.requiresKey !== false) {
            lines.push(
                `⚠️ **${cat.label || cat.id}** (\`${cat.id}\`) — set to *use keys* but has no products yet. ` +
                    `Clicking its button opens a **SUPPORT** ticket (not a transaction). ` +
                    `Add products: \`/add-product category:${cat.id} requires_key:true\``
            );
        } else {
            lines.push(
                `ℹ️ **${cat.label || cat.id}** (\`${cat.id}\`) — no products, clicking its button opens a **SUPPORT** ticket directly. ` +
                    (cat.isDefault === false
                        ? `If this is a sales category, add products first: \`/add-product category:${cat.id} requires_key:false\``
                        : `Normal if it's meant to be a quick action.`)
            );
        }
    }
    return lines;
}

/**
 * Build the embed + components for a ticket panel.
 * Used by /setup-ticket-panel (create new) & /refresh-panel (re-render existing).
 *
 * @param {Object} panel - panel metadata (see the panelManager.js schema)
 * @param {Object} ctx - { guild, client, config } (guild is used for the {server} template)
 * @returns {{embed: EmbedBuilder, components: ActionRowBuilder[]}}
 */
function buildTicketPanel(panel, ctx) {
    const config = ctx.config || getConfig();
    const allCategories = config.ticketCategories || [];
    const categoryIds = Array.isArray(panel.categoryIds) ? panel.categoryIds : [];

    // Pick which categories to display.
    // - If categoryIds is empty → show all.
    // - If present → filter by id.
    let categoriesToShow;
    if (categoryIds.length === 0) {
        categoriesToShow = allCategories;
    } else {
        categoriesToShow = allCategories.filter(c => categoryIds.includes(c.id));
        // If the filter yields 0 (all ids invalid), fall back to all so the panel
        // isn't empty. The admin still sees the warning in the reply.
        if (categoriesToShow.length === 0) {
            categoriesToShow = allCategories;
        }
    }
    categoriesToShow = categoriesToShow.slice(0, 25);

    // === Build price list per category ===
    const categoryIdsSet = new Set(categoriesToShow.map(c => c.id));
    const productsInCategories = (config.products || []).filter(p => {
        const pCat = p.category || 'transaction';
        return categoryIdsSet.has(pCat);
    });

    const priceListByCategory = {};
    for (const cat of categoriesToShow) {
        const prods = productsInCategories.filter(p => (p.category || 'transaction') === cat.id);
        priceListByCategory[cat.id] =
            prods.length > 0
                ? prods.map(p => `• **${p.label}** — ${p.price}`).join('\n')
                : `_(no products in this category yet)_`;
    }

    const priceList =
        productsInCategories.length > 0
            ? productsInCategories.map(p => `• **${p.label}** — ${p.price}`).join('\n')
            : '_(no products yet — use `/add-product`)_';

    const categoriesListStr = categoriesToShow.map(c => `${c.emoji || '🎫'} **${c.label}**`).join(' • ');

    const priceHeader = config.messages?.ticketPriceHeader || '💰 PRICE LIST 💰';

    // Body: use panel.body if overridden, else config.messages.ticketBody.
    const bodyTemplate = panel.body != null && panel.body !== '' ? panel.body : config.messages.ticketBody;

    const renderedBody = fillTemplate(bodyTemplate, {
        server: ctx.guild?.name || 'Server',
        priceList,
        priceHeader,
        categoriesList: categoriesListStr,
        priceListByCategory
    });

    // Title: use panel.title if overridden, else the config default.
    const title = panel.title != null && panel.title !== '' ? panel.title : config.messages.ticketTitle;

    // Color: parse first (can be a hex string from JSON), fall back to the default orange.
    let color = 0xe67e22;
    if (panel.color != null) {
        try {
            const parsed = parseColor(panel.color);
            if (parsed !== null) color = parsed;
        } catch (_) {
            // ignore parse errors at build time, the default is used.
        }
    }

    const embed = new EmbedBuilder().setTitle(title).setDescription(renderedBody).setColor(color);

    // Optional image & thumbnail
    const imageUrl = validateUrl(panel.imageUrl);
    if (imageUrl) embed.setImage(imageUrl);
    const thumbUrl = validateUrl(panel.thumbnailUrl);
    if (thumbUrl) embed.setThumbnail(thumbUrl);

    // Footer: use panel.footerText if overridden, else the bot username.
    const footerText =
        panel.footerText != null && panel.footerText !== ''
            ? panel.footerText
            : ctx.client?.user?.username || 'Community Bot';
    embed.setFooter({
        text: footerText,
        iconURL: ctx.client?.user?.displayAvatarURL({ dynamic: true })
    });
    embed.setTimestamp();

    // === Build components: buttons (default) or dropdown select menu ===
    const components = [];
    if (panel.useDropdown) {
        // Select menu — 1 row, 1 menu, max 25 options.
        // v3.9.27 FIX (user-reported bug): option descriptions no longer use
        // requiresKey as a "transaction vs support" proxy — non-key categories
        // (account sales, services) used to be labeled "Support / non-transaction" even though
        // they're sales categories. Descriptions are now based on category CONTENT:
        //   - has products → "Transaction — N products (with/without keys)"
        //   - no products → "Support / open a ticket directly" (help/report/custom)
        // v3.9.28 FIX: count keys from the ACTUAL products, not the category flag —
        // categories can be mixed (e.g. "Akun ML" containing 2 non-key accounts + 1
        // key-based top-up). The category flag is only a fallback when no key/non-key
        // products can be inferred.
        // v3.9.37 FIX: the midman category is always an "escrow deal" — the old
        // "Support / open a ticket directly" description misled end users (clicking its
        // button opens the escrow deal form, not a support ticket).
        const options = categoriesToShow.map(cat => {
            const prods = productsInCategories.filter(p => (p.category || 'transaction') === cat.id);
            let desc;
            if (cat.id === 'midman') {
                desc = '3-party escrow deal';
            } else if (prods.length > 0) {
                const nonKeyCount = prods.filter(p => p.requiresKey === false).length;
                let keyInfo;
                if (nonKeyCount === 0) {
                    keyInfo = 'with keys';
                } else if (nonKeyCount === prods.length) {
                    keyInfo = 'without keys';
                } else {
                    keyInfo = `${nonKeyCount} without keys / ${prods.length - nonKeyCount} with keys`;
                }
                desc = `Transaction — ${prods.length} products (${keyInfo})`;
            } else {
                desc = 'Support / open a ticket directly';
            }
            return {
                label: (cat.label || cat.id).slice(0, 100),
                value: cat.id,
                description: desc.slice(0, 100),
                emoji: cat.emoji || '🎫'
            };
        });
        if (options.length === 0) {
            // No categories → fall back to a single disabled button so the
            // panel still has 1 component (Discord doesn't allow 0 components
            // once a message already has components set).
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_noop')
                    .setLabel('No categories')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );
            components.push(row);
        } else {
            const menu = new StringSelectMenuBuilder()
                .setCustomId('ticket_cat_select')
                .setPlaceholder('Select a ticket category...')
                .addOptions(options);
            components.push(new ActionRowBuilder().addComponents(menu));
        }
    } else {
        // Buttons — auto-wrap into a new row every 5 buttons.
        let currentRow = new ActionRowBuilder();
        let btnCount = 0;
        for (const cat of categoriesToShow) {
            if (btnCount === MAX_BUTTONS_PER_ROW) {
                components.push(currentRow);
                currentRow = new ActionRowBuilder();
                btnCount = 0;
                if (components.length >= MAX_ROWS) break;
            }
            const btnStyle = STYLE_MAP[cat.style] || ButtonStyle.Primary;
            const btn = new ButtonBuilder()
                .setCustomId(`ticket_cat:${cat.id}`)
                .setLabel((cat.label || cat.id).slice(0, 80))
                .setEmoji(cat.emoji || '🎫')
                .setStyle(btnStyle);
            currentRow.addComponents(btn);
            btnCount++;
        }
        if (btnCount > 0 && components.length < MAX_ROWS) {
            components.push(currentRow);
        }
    }

    return { embed, components };
}

module.exports = async function (interaction) {
    const config = getConfig();

    // === SET VERIFY BUTTON ===
    if (interaction.commandName === 'set-verify-button') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const label = interaction.options.getString('label');
        const emoji = interaction.options.getString('emoji');
        const style = interaction.options.getString('style');

        // Validate style
        if (style && !VALID_STYLES.includes(style)) {
            return safeEditReply(interaction, {
                content: '❌ Invalid `style`. Choose: Primary, Secondary, Success, Danger.'
            });
        }

        // v3.9.26: validate the emoji BEFORE saving (anti poison config). A free-form
        // emoji string that gets stored makes setEmoji() throw later in /setup-verify —
        // the verification panel stays dead until the config is fixed manually.
        if (emoji && !isValidEmoji(emoji)) {
            return safeEditReply(interaction, {
                content: '❌ Invalid `emoji`. Use a unicode emoji (e.g. ✅) or a custom emoji in the format `<:name:id>`.'
            });
        }

        // Build new verifyButton config
        const newVerifyBtn = {
            ...(config.verifyButton || {}),
            label: label.slice(0, 80)
        };
        if (emoji) newVerifyBtn.emoji = emoji;
        if (style) newVerifyBtn.style = style;

        config.verifyButton = newVerifyBtn;
        saveConfig(config);

        await logAudit(interaction.client, {
            action: 'SET_VERIFY_BUTTON',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Update verify button — label: "${newVerifyBtn.label}", emoji: ${newVerifyBtn.emoji}, style: ${newVerifyBtn.style}`,
            guildId: interaction.guild.id
        });

        // Preview button
        const previewBtn = new ButtonBuilder()
            .setCustomId('btn_verify_preview')
            .setLabel(newVerifyBtn.label)
            .setEmoji(newVerifyBtn.emoji || '✅')
            .setStyle(STYLE_MAP[newVerifyBtn.style] || ButtonStyle.Success)
            .setDisabled(true);
        const previewRow = new ActionRowBuilder().addComponents(previewBtn);

        return safeEditReply(interaction, {
            content: '✅ Verify button updated!\n\n**Preview:**',
            components: [previewRow]
        });
    }

    // === SETUP TICKET PANEL (multi-panel + full customization, v3.9.14) ===
    if (interaction.commandName === 'setup-ticket-panel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // v3.9.17 FIX: validate roles.admin up front (same as /setup-ticket).
        if (!config.roles.admin) {
            return safeEditReply(interaction, {
                content: '❌ Admin role not set yet. Use `/set-role admin @role` first before setting up the ticket panel.'
            });
        }

        const customTitle = interaction.options.getString('title');
        const categoriesFilter = interaction.options.getString('categories');
        // v3.9.24: support literal \n → real newline in the panel body (multi-line
        // price list / instructions). Footer stays 1 line (Discord renders footers flat).
        const customBody = normalizeNewlines(interaction.options.getString('body'));
        const colorInput = interaction.options.getString('color');
        const imageUrlInput = interaction.options.getString('image');
        const thumbnailInput = interaction.options.getString('thumbnail');
        const footerInput = interaction.options.getString('footer');
        const channelOption = interaction.options.getChannel('channel');
        const useDropdownOption = interaction.options.getBoolean('use_dropdown');

        const allCategories = config.ticketCategories || [];
        if (allCategories.length === 0) {
            return safeEditReply(interaction, {
                content:
                    '❌ No categories yet. Add one first with `/add-category`, or use `/setup-ticket` for the defaults.'
            });
        }

        // Filter categories by IDs (if specified), else use all
        let categoriesToShow = allCategories;
        const missingCategoryIds = [];
        if (categoriesFilter) {
            const requestedIds = categoriesFilter
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
            categoriesToShow = allCategories.filter(c => requestedIds.includes(c.id));
            if (categoriesToShow.length === 0) {
                return safeEditReply(interaction, {
                    content: `❌ No categories match: \`${categoriesFilter}\`. Use /list-categories to see the list.`
                });
            }
            // Warn if a requested id wasn't found
            for (const req of requestedIds) {
                if (!allCategories.find(c => c.id === req)) missingCategoryIds.push(req);
            }
        }

        // Validate color
        let parsedColor = null;
        if (colorInput) {
            try {
                parsedColor = parseColor(colorInput);
            } catch (colorErr) {
                return safeEditReply(interaction, { content: `❌ ${colorErr.message}` });
            }
        }

        // Validate image & thumbnail URLs
        const imageUrl = validateUrl(imageUrlInput);
        if (imageUrlInput && !imageUrl) {
            return safeEditReply(interaction, {
                content: '❌ Invalid image URL. Must be in http(s)://... format'
            });
        }
        const thumbnailUrl = validateUrl(thumbnailInput);
        if (thumbnailInput && !thumbnailUrl) {
            return safeEditReply(interaction, {
                content: '❌ Invalid thumbnail URL. Must be in http(s)://... format'
            });
        }
        // v3.9.29: 2048 length guard (the Discord embed URL limit) — without this,
        // long URLs only fail later at send time (with a vague 50035 error).
        if (imageUrl && imageUrl.length > 2048) {
            return safeEditReply(interaction, {
                content: `❌ Image URL is too long (${imageUrl.length} char, max 2048). Use a shorter link.`
            });
        }
        if (thumbnailUrl && thumbnailUrl.length > 2048) {
            return safeEditReply(interaction, {
                content: `❌ Thumbnail URL is too long (${thumbnailUrl.length} char, max 2048). Use a shorter link.`
            });
        }

        // Determine the target channel
        const targetChannel = channelOption || interaction.channel;
        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
            return safeEditReply(interaction, {
                content: '❌ The target channel must be a text channel.'
            });
        }

        // Build the panel metadata object (no messageId yet — set after sending)
        const panelMeta = {
            guildId: interaction.guild.id,
            channelId: targetChannel.id,
            title: customTitle || null,
            body: customBody || null,
            color: parsedColor,
            imageUrl: imageUrl || null,
            thumbnailUrl: thumbnailUrl || null,
            footerText: footerInput || null,
            categoryIds: categoriesToShow.map(c => c.id),
            useDropdown: useDropdownOption === true,
            createdBy: interaction.user.id
        };

        // Build embed + components via shared builder
        let build;
        try {
            build = buildTicketPanel(panelMeta, {
                guild: interaction.guild,
                client: interaction.client,
                config
            });
        } catch (buildErr) {
            return safeEditReply(interaction, {
                content: `❌ Failed to build the panel: ${buildErr.message}`
            });
        }

        // Send the panel to the target channel
        try {
            const sent = await targetChannel.send({
                embeds: [build.embed],
                components: build.components
            });

            // Save the panel to panels.json (with the new messageId)
            const saved = upsertPanel({
                ...panelMeta,
                messageId: sent.id
            });

            await logAudit(interaction.client, {
                action: 'SETUP_TICKET_PANEL',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Installed ticket panel \`${saved.id}\` in ${targetChannel} — ${categoriesToShow.length} categories, ${panelMeta.useDropdown ? 'dropdown' : 'buttons'}`,
                guildId: interaction.guild.id
            });

            const missing =
                missingCategoryIds.length > 0
                    ? `\n\n⚠️ Category IDs not found (ignored): \`${missingCategoryIds.join(', ')}\``
                    : '';

            // v3.9.29: safety net — a category without products = its button opens a
            // SUPPORT ticket. Tell the admin NOW, not after buyers
            // complain their order landed in the support category.
            const emptyWarnings = findEmptyCategoryWarnings(panelMeta, config);
            const emptyWarn =
                emptyWarnings.length > 0
                    ? `\n\n🔮 **Categories without products** (click = instant SUPPORT ticket):\n${emptyWarnings.map(l => `• ${l}`).join('\n')}`
                    : '';

            return safeEditReply(interaction, {
                content:
                    `✅ Ticket panel installed in ${targetChannel}!\n\n` +
                    `🆔 Panel ID: \`${saved.id}\` (save this for /update-panel, /delete-panel, /refresh-panel)\n` +
                    `🎫 Categories: ${categoriesToShow.map(c => `\`${c.id}\``).join(', ')} (${categoriesToShow.length})\n` +
                    `🎨 Layout: ${panelMeta.useDropdown ? 'Dropdown Select Menu' : 'Buttons'}${missing}${emptyWarn}`
            });
        } catch (sendErr) {
            return safeEditReply(interaction, {
                content: `❌ Failed to send the ticket panel to ${targetChannel}: ${sendErr.message}\n\nMake sure the bot has **Send Messages** and **Embed Links** permissions in that channel.`
            });
        }
    }
};

// Export the shared builder so /refresh-panel & /update-panel can reuse it.
module.exports.buildTicketPanel = buildTicketPanel;
module.exports.parseColor = parseColor;
module.exports.validateUrl = validateUrl;
// v3.9.29: empty-category safety net (used by panels-mgmt.js + unit test).
module.exports.findEmptyCategoryWarnings = findEmptyCategoryWarnings;
