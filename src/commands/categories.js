/**
 * Domain: categories
 * Slash commands: /add-category, /list-categories, /remove-category
 *
 * v3.9.11 Phase 2: Ticket category management.
 * Admins can CRUD ticket categories from Discord. Categories are used by /setup-ticket
 * to render dynamic buttons.
 */

const { EmbedBuilder, MessageFlags, getConfig, saveConfig, logAudit, safeEditReply } = require('./_shared');
const { isValidEmoji } = require('../infra/text');

const CATEGORY_ID_REGEX = /^[a-zA-Z0-9_-]{1,30}$/;

module.exports = async function (interaction) {
    const config = getConfig();

    // === ADD CATEGORY ===
    if (interaction.commandName === 'add-category') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const id = interaction.options.getString('id');
        const label = interaction.options.getString('label');
        const emoji = interaction.options.getString('emoji') || '🎫';
        const style = interaction.options.getString('style') || 'Primary';
        const requiresKey = interaction.options.getBoolean('requires_key');

        // Validate id format
        if (!CATEGORY_ID_REGEX.test(id)) {
            return safeEditReply(interaction, {
                content: '❌ `id` may only contain letters/numbers/_/-, max 30 characters.'
            });
        }

        // Validate style
        const validStyles = ['Primary', 'Secondary', 'Success', 'Danger'];
        if (!validStyles.includes(style)) {
            return safeEditReply(interaction, { content: '❌ `style` is not valid.' });
        }

        // v3.9.26: validate emoji BEFORE saving. An invalid emoji (a long string /
        // not an emoji) stored in config → ButtonBuilder.setEmoji() throws when
        // the panel renders → /setup-ticket & /refresh-panel dead until the config
        // is fixed manually (persistent poison).
        if (!isValidEmoji(emoji)) {
            return safeEditReply(interaction, {
                content: '❌ `emoji` is not valid. Use a unicode emoji (e.g. 🎫) or a custom emoji in the format `<:name:id>`.'
            });
        }

        // Check duplicate
        const categories = config.ticketCategories || [];
        if (categories.some(c => c.id === id)) {
            return safeEditReply(interaction, {
                content: `❌ A category with ID \`${id}\` already exists. Use /remove-category first if you want to replace it.`
            });
        }

        // Check max 25 categories (Discord button limit per message)
        if (categories.length >= 25) {
            return safeEditReply(interaction, {
                content: '❌ Maximum of 25 categories (Discord limit: 25 buttons per message).'
            });
        }

        // Add new category
        const newCategory = {
            id,
            label: label.slice(0, 80),
            emoji,
            style,
            requiresKey: requiresKey !== null ? requiresKey : true,
            isDefault: false
        };
        categories.push(newCategory);
        config.ticketCategories = categories;
        saveConfig(config);

        await logAudit(interaction.client, {
            action: 'ADD_CATEGORY',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Add ticket category: **${label}** (\`${id}\`) — emoji: ${emoji}, style: ${style}, requiresKey: ${newCategory.requiresKey}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ Category added!\n\n` +
                `🎫 ID: \`${id}\`\n` +
                `📝 Label: **${label}**\n` +
                `${emoji} Emoji: ${emoji}\n` +
                `🎨 Style: ${style}\n` +
                `🔑 Requires Key: ${newCategory.requiresKey ? 'Yes' : 'No'}\n\n` +
                `💡 Use \`/setup-ticket\` (or \`/refresh-panel <id>\` if the panel already exists) to apply the new category.`
        });
    }

    // === LIST CATEGORIES ===
    if (interaction.commandName === 'list-categories') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const categories = config.ticketCategories || [];
        if (categories.length === 0) {
            return safeEditReply(interaction, {
                content:
                    '📭 No categories yet. The 5 default categories (transaction, help, report, claim_giveaway, midman) are used when the config is empty.'
            });
        }

        const lines = categories
            .map((c, i) => {
                const keyFlag = c.requiresKey ? '🔑' : '📋';
                const defaultFlag = c.isDefault ? ' *(default)*' : '';
                return `\`${i + 1}.\` ${c.emoji} **${c.label}** (\`${c.id}\`) — ${c.style} ${keyFlag}${defaultFlag}`;
            })
            .join('\n');

        const embed = new EmbedBuilder()
            .setTitle('🎫 TICKET CATEGORY LIST')
            .setDescription(lines)
            .setColor(0x5865f2)
            .setFooter({ text: `${categories.length}/25 categories used` })
            .setTimestamp();

        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === REMOVE CATEGORY ===
    if (interaction.commandName === 'remove-category') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const id = interaction.options.getString('id');
        const categories = config.ticketCategories || [];
        const idx = categories.findIndex(c => c.id === id);

        if (idx === -1) {
            return safeEditReply(interaction, {
                content: `❌ Category \`${id}\` not found. Use /list-categories to see the list.`
            });
        }

        // v3.9.11: don't delete default categories (transaction, help, report) — too risky.
        if (categories[idx].isDefault) {
            return safeEditReply(interaction, {
                content:
                    `❌ Category \`${id}\` is a default category and cannot be deleted.\n` +
                    `To disable it, set \`requiresKey: false\` or edit the label directly in the config.`
            });
        }

        const [removed] = categories.splice(idx, 1);
        config.ticketCategories = categories;

        // v3.9.26 FIX: mark as dismissed so the claim_giveaway migration in
        // configManager does NOT re-add this category on the next getConfig()
        // (before: the category silently "came back to life" on the next run
        // because the migration re-added it without checking any flag).
        if (removed.id === 'claim_giveaway') {
            config.claimGiveawayDismissed = true;
        }
        // v3.9.32: same for the midman/escrow category — the flag prevents the
        // configManager migration from re-adding this category on the next getConfig().
        if (removed.id === 'midman') {
            config.midmanCategoryDismissed = true;
        }

        // v3.9.17 FIX: implement the actual fallback. Previously, the message said
        // "products will fall back to transaction" but no code updated
        // product.category → products became orphans (not shown in any panel).
        // Now: iterate products and set category='transaction' for products
        // whose category === the deleted category's id.
        const removedId = removed.id;
        let migratedCount = 0;
        if (Array.isArray(config.products)) {
            config.products = config.products.map(p => {
                if (p && p.category === removedId) {
                    migratedCount++;
                    return { ...p, category: 'transaction' };
                }
                return p;
            });
        }

        saveConfig(config);

        await logAudit(interaction.client, {
            action: 'REMOVE_CATEGORY',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Remove ticket category: **${removed.label}** (\`${removed.id}\`) — ${migratedCount} products migrated to \`transaction\``,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ Category **${removed.label}** (\`${removed.id}\`) successfully deleted.\n\n` +
                (migratedCount > 0
                    ? `📦 ${migratedCount} products using this category were automatically moved to the \`transaction\` category.`
                    : `ℹ️ No products were using this category.`)
        });
    }

    // === UPDATE CATEGORY (v3.9.19) ===
    // Edit an existing category without having to delete + re-add it.
    // All fields are optional — only filled-in fields get updated.
    if (interaction.commandName === 'update-category') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const id = interaction.options.getString('id');
        const newLabel = interaction.options.getString('label');
        const newEmoji = interaction.options.getString('emoji');
        const newStyle = interaction.options.getString('style');
        const newRequiresKey = interaction.options.getBoolean('requires_key');

        const categories = config.ticketCategories || [];
        const idx = categories.findIndex(c => c.id === id);

        if (idx === -1) {
            return safeEditReply(interaction, {
                content: `❌ Category \`${id}\` not found. Use /list-categories to see the list.`
            });
        }

        // Validate style if filled in
        if (newStyle !== null) {
            const validStyles = ['Primary', 'Secondary', 'Success', 'Danger'];
            if (!validStyles.includes(newStyle)) {
                return safeEditReply(interaction, { content: '❌ `style` is not valid.' });
            }
        }

        // v3.9.26: validate emoji if filled in (anti config poison — see add-category)
        if (newEmoji !== null && !isValidEmoji(newEmoji)) {
            return safeEditReply(interaction, {
                content: '❌ `emoji` is not valid. Use a unicode emoji (e.g. 🎫) or a custom emoji in the format `<:name:id>`.'
            });
        }

        const before = { ...categories[idx] };
        const changes = [];

        if (newLabel !== null) {
            categories[idx].label = newLabel.slice(0, 80);
            changes.push(`label: \`${before.label}\` → \`${categories[idx].label}\``);
        }
        if (newEmoji !== null) {
            categories[idx].emoji = newEmoji;
            changes.push(`emoji: ${before.emoji} → ${newEmoji}`);
        }
        if (newStyle !== null) {
            categories[idx].style = newStyle;
            changes.push(`style: ${before.style} → ${newStyle}`);
        }
        if (newRequiresKey !== null) {
            categories[idx].requiresKey = newRequiresKey;
            changes.push(`requiresKey: ${before.requiresKey} → ${newRequiresKey}`);
        }

        if (changes.length === 0) {
            return safeEditReply(interaction, {
                content:
                    `ℹ️ No changes were made. Provide at least 1 field to update (label/emoji/style/requires_key).\n\n` +
                    `Category **${before.label}** (\`${before.id}\`) stays as it was.`
            });
        }

        config.ticketCategories = categories;
        saveConfig(config);

        await logAudit(interaction.client, {
            action: 'UPDATE_CATEGORY',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Update ticket category: **${before.label}** (\`${before.id}\`) — ${changes.join('; ')}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ Category **${categories[idx].label}** (\`${categories[idx].id}\`) successfully updated!\n\n` +
                `📝 Changes:\n${changes.map(c => `• ${c}`).join('\n')}\n\n` +
                `💡 Use \`/refresh-panel <id>\` to re-render installed panels.`
        });
    }
};
