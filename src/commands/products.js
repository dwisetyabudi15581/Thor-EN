/**
 * Domain: products
 * Slash commands: /add-product, /remove-product, /list-products,
 *                 /set-product-role, /remove-product-role, /list-product-roles
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: manage products + auto-role mapping per product.
 */

const { MessageFlags, getConfig, saveConfig, Embeds, logAudit, safeEditReply, parsePriceNum } = require('./_shared');

/**
 * v3.9.49 (user report: "total revenue doesn't update"): validate a product
 * price BEFORE it is saved. A price string the bot cannot parse (e.g. "murah",
 * "negosiasi", "25rp2") used to be accepted silently — every later sale then
 * recorded parsePrice(price) = 0 into stats/leaderboard, and the revenue
 * never moved. Returns null when valid (free prices "0"/"free"/"gratis" are
 * allowed), or an error message string when invalid.
 *
 * v3.9.50 (user report: "I set the price as 3$ USD | Rp. 25.000"): dual-currency
 * prices are VALID — the Rupiah half is what gets recorded.
 *
 * v3.9.54 (user request: "the bot will be used by people outside Indonesia
 * too"): ANY currency is accepted ("$3", "€25", "¥1000", "25 usd"...) — the
 * bot is currency-AGNOSTIC and records the numeric amount in whatever
 * currency the admin prices their products. USD-only is no longer rejected.
 * Dual-currency strings still record the Rp half (v3.9.50, unchanged).
 * v3.9.55 (user question: "does it support decimals like $2.5 USD?"):
 * DECIMAL prices with a non-Rp marker are valid ("$2.5", "$2.50", "€9.99") —
 * cents are recorded in the stats (2.5, not 3).
 * Exported for unit tests (tests/unit/parsePrice.test.js).
 */
function priceValidationError(price) {
    const raw = String(price || '').trim();
    const FREE = ['0', 'free', 'gratis'];
    if (FREE.includes(raw.toLowerCase())) return null; // explicitly free — OK
    if (parsePriceNum(raw) > 0) return null; // parses to a positive amount — OK
    return (
        `❌ The price \`${raw}\` cannot be read as an amount — it would record **0** into the stats on every sale.\n` +
        `✅ Accepted formats: \`25000\` · \`25.000\` · \`25,000\` · \`$3\` · \`$2.50\` · \`€25\` · \`Rp 30.000\` · \`30rb\` · \`3jt\` · \`3$ USD | Rp 25.000\` (the Rp part is recorded) · \`free\``
    );
}

module.exports = async function (interaction) {
    const embeds = new Embeds(interaction.client);
    const config = getConfig();

    // === ADD PRODUCT ===
    if (interaction.commandName === 'add-product') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const label = interaction.options.getString('label');
        const value = interaction.options.getString('value');
        const price = interaction.options.getString('price');
        // duration is optional - if not filled in, it is NOT stored at all
        const duration = interaction.options.getString('duration');
        // v3.9.11 Phase 2: category & requires_key
        const category = interaction.options.getString('category');
        const requiresKeyOpt = interaction.options.getBoolean('requires_key');

        // v3.9.8 FIX: validate `value` — used in the modal_set_key:${value} customId
        if (!value || !/^[a-zA-Z0-9_-]{1,50}$/.test(value)) {
            return safeEditReply(interaction, {
                content: '❌ `value` may only contain letters/numbers/_/-, max 50 characters, no spaces/commas/colons.'
            });
        }

        // v3.9.26 FIX: cap label/price in the handler (consistent with /update-product
        // which already slices to 80). The registry has max_length, but OLD data or
        // restored backup data can still be long — the ticket dropdown slices
        // defensively, and the saved config is capped too so it stays tidy.
        const safeLabel = label.slice(0, 80);
        const safePrice = price.slice(0, 100);

        // v3.9.49 FIX: reject a price that would silently record Rp 0 revenue.
        const priceErr = priceValidationError(safePrice);
        if (priceErr) return safeEditReply(interaction, { content: priceErr });

        if (config.products.some(p => p.value === value)) {
            return safeEditReply(interaction, { content: `❌ A product with value \`${value}\` already exists.` });
        }
        if (config.products.length >= 25) {
            return safeEditReply(interaction, { content: '❌ Maximum of 25 products (Discord dropdown limit).' });
        }

        // v3.9.11 Phase 2: validate category exists (if specified)
        const finalCategory = category || 'transaction';
        const categories = config.ticketCategories || [];
        const categoryExists = categories.some(c => c.id === finalCategory);
        if (!categoryExists && category) {
            // If the admin specifies a category that doesn't exist, reject it.
            return safeEditReply(interaction, {
                content: `❌ Category \`${category}\` not found. Use /list-categories to see the list, or /add-category to create a new one.`
            });
        }

        // v3.9.11 Phase 2: determine requiresKey
        // - If explicitly set via the option, use that.
        // - Otherwise, default based on the category config (if the category has a requiresKey field).
        let finalRequiresKey;
        if (requiresKeyOpt !== null) {
            finalRequiresKey = requiresKeyOpt;
        } else {
            const catConfig = categories.find(c => c.id === finalCategory);
            finalRequiresKey = catConfig?.requiresKey !== undefined ? catConfig.requiresKey : true;
        }

        // Only store duration if filled in
        const newProduct = { label: safeLabel, value, price: safePrice };
        if (duration) newProduct.duration = duration;
        newProduct.category = finalCategory;
        newProduct.requiresKey = finalRequiresKey;

        config.products.push(newProduct);
        saveConfig(config);

        const durationInfo = duration ? ` (duration: ${duration})` : ' (no duration)';
        const catInfo = ` | category: ${finalCategory} | requiresKey: ${finalRequiresKey ? 'yes' : 'no'}`;
        await logAudit(interaction.client, {
            action: 'ADD_PRODUCT',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Add product: **${label}** (\`${value}\`) — ${price}${durationInfo}${catInfo}`,
            guildId: interaction.guild.id
        });
        // v3.9.49: show how the price will be counted in /stats — so a
        // format mistake is visible at setup time, not after N invisible sales.
        // v3.9.54: no "Rp" prefix — the bot is currency-agnostic and records
        // the numeric amount in the admin's own pricing currency.
        const priceNum = parsePriceNum(safePrice);
        const revenueNote =
            priceNum > 0
                ? `\n💰 Counted in stats as: **${priceNum.toLocaleString('en-US')}** per sale (ticket + escrow transactions)`
                : '';
        return safeEditReply(interaction, {
            content: `✅ Product added: **${label}** — ${price}${durationInfo}${revenueNote}\n📦 Category: \`${finalCategory}\` | 🔑 Requires Key: ${finalRequiresKey ? 'Yes' : 'No'}`
        });
    }

    // === REMOVE PRODUCT ===
    if (interaction.commandName === 'remove-product') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const value = interaction.options.getString('value');
        const idx = config.products.findIndex(p => p.value === value);
        if (idx === -1) return safeEditReply(interaction, { content: `❌ Product \`${value}\` not found.` });
        const [removed] = config.products.splice(idx, 1);
        saveConfig(config);
        await logAudit(interaction.client, {
            action: 'REMOVE_PRODUCT',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Remove product: **${removed.label}** (\`${removed.value}\`) — ${removed.price}`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, { content: `✅ Product deleted: **${removed.label}**` });
    }

    // === LIST PRODUCTS ===
    if (interaction.commandName === 'list-products') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (config.products.length === 0) {
            return safeEditReply(interaction, { content: '📭 No products yet.' });
        }
        const list = config.products
            .map((p, i) => {
                let line = `\`${i + 1}.\` **${p.label}** — ${p.price}\n   └ value: \`${p.value}\``;
                if (p.duration) line += ` | duration: ${p.duration}`;
                return line;
            })
            .join('\n');
        const embed = embeds.info('📋 PRODUCT LIST', list);
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === SET PRODUCT ROLE (auto-role + auto-expire) ===
    if (interaction.commandName === 'set-product-role') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const value = interaction.options.getString('value');
        const role = interaction.options.getRole('role');
        const days = interaction.options.getInteger('days');

        // v3.9.8 FIX: validate days >= 0. Previously not validated — an admin could
        // input days: -5 → scheduleRoleRemoval computes expireAt = now + (-5)*86400000
        // = 5 days ago → the scheduler processes it immediately → the member gets the
        // role and has it removed within 60 seconds.
        if (days == null || days < 0 || days > 3650) {
            return safeEditReply(interaction, {
                content: '❌ `days` must be between 0 and 3650. (0 = permanent, >0 = duration in days).'
            });
        }

        const product = config.products.find(p => p.value === value);
        if (!product) {
            return safeEditReply(interaction, {
                content: `❌ Product with value \`${value}\` not found. Use \`/list-products\` to see the list.`
            });
        }

        product.roleId = role.id;
        product.days = days;
        saveConfig(config);
        await logAudit(interaction.client, {
            action: 'EDIT_PRODUCT',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Set product auto-role **${product.label}** → ${role.name} (${days > 0 ? days + ' days' : 'permanent'})`,
            guildId: interaction.guild.id
        });

        const expireInfo =
            days > 0 ? `auto-removed after **${days} days**` : '**permanent** (will not be auto-removed)';
        return safeEditReply(interaction, {
            content: `✅ Auto-role for product **${product.label}** set!\n\n🎁 Role: ${role}\n⏰ Expiry: ${expireInfo}\n\n💡 The role is automatically granted when an admin clicks **🔑 Set Key** / **📦 Deliver Order** / **✅ Order Success** in the ticket.`
        });
    }

    // === REMOVE PRODUCT ROLE ===
    if (interaction.commandName === 'remove-product-role') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const value = interaction.options.getString('value');

        const product = config.products.find(p => p.value === value);
        if (!product) {
            return safeEditReply(interaction, { content: `❌ Product with value \`${value}\` not found.` });
        }
        if (!product.roleId) {
            return safeEditReply(interaction, {
                content: `ℹ️ Product **${product.label}** doesn't have an auto-role yet.`
            });
        }

        delete product.roleId;
        delete product.days;
        saveConfig(config);
        await logAudit(interaction.client, {
            action: 'EDIT_PRODUCT',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Remove product auto-role **${product.label}**`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Auto-role for product **${product.label}** successfully removed.`
        });
    }

    // === LIST PRODUCT ROLES ===
    if (interaction.commandName === 'list-product-roles') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const withRoles = config.products.filter(p => p.roleId);
        if (withRoles.length === 0) {
            return safeEditReply(interaction, {
                content: '📭 No products have an auto-role yet. Use `/set-product-role` to set one up.'
            });
        }
        const list = withRoles
            .map(p => {
                const roleMention = `<@&${p.roleId}>`;
                const expire = p.days > 0 ? `${p.days} days` : 'permanent';
                return `• **${p.label}** (\`${p.value}\`) → ${roleMention} — expire: ${expire}`;
            })
            .join('\n');
        const embed = embeds.info('🎁 AUTO-ROLE PER PRODUCT', list);
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === UPDATE PRODUCT (v3.9.19) ===
    // Edit an existing product without having to delete + re-add it.
    // All fields are optional (except `value` as the identifier).
    // Note: `value` itself CANNOT be changed because it's used as the customId
    // in modal_set_key:${value} — changing value would break active tickets.
    if (interaction.commandName === 'update-product') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const value = interaction.options.getString('value');
        const newLabel = interaction.options.getString('label');
        const newPrice = interaction.options.getString('price');
        const newDuration = interaction.options.getString('duration');
        const newCategory = interaction.options.getString('category');
        const newRequiresKey = interaction.options.getBoolean('requires_key');

        const product = config.products.find(p => p.value === value);
        if (!product) {
            return safeEditReply(interaction, {
                content: `❌ Product with value \`${value}\` not found. Use \`/list-products\` to see the list.`
            });
        }

        // Validate category if filled in
        if (newCategory !== null) {
            const categories = config.ticketCategories || [];
            const categoryExists = categories.some(c => c.id === newCategory);
            if (!categoryExists) {
                return safeEditReply(interaction, {
                    content: `❌ Category \`${newCategory}\` not found. Use /list-categories to see the list.`
                });
            }
        }

        const before = { ...product };
        const changes = [];

        if (newLabel !== null) {
            product.label = newLabel.slice(0, 80);
            changes.push(`label: \`${before.label}\` → \`${product.label}\``);
        }
        if (newPrice !== null) {
            // v3.9.49 FIX: same guard as /add-product — reject unparseable prices.
            const priceErr = priceValidationError(newPrice);
            if (priceErr) return safeEditReply(interaction, { content: priceErr });
            product.price = newPrice;
            changes.push(`price: \`${before.price}\` → \`${newPrice}\``);
            // v3.9.50: same visibility as /add-product — show how the NEW price
            // will be counted, so a dual-currency typo is caught at update time.
            const newPriceNum = parsePriceNum(newPrice);
            if (newPriceNum > 0) {
                changes.push(`💰 counted in stats: **${newPriceNum.toLocaleString('en-US')}** per sale`);
            }
        }
        if (newDuration !== null) {
            // Empty string → delete the duration field
            if (newDuration === '') {
                if (product.duration !== undefined) {
                    delete product.duration;
                    changes.push(`duration: \`${before.duration || '-'}\` → (deleted)`);
                }
            } else {
                product.duration = newDuration;
                changes.push(`duration: \`${before.duration || '-'}\` → \`${newDuration}\``);
            }
        }
        if (newCategory !== null) {
            product.category = newCategory;
            changes.push(`category: \`${before.category || 'transaction'}\` → \`${newCategory}\``);
        }
        if (newRequiresKey !== null) {
            product.requiresKey = newRequiresKey;
            changes.push(`requiresKey: ${before.requiresKey} → ${newRequiresKey}`);
        }

        if (changes.length === 0) {
            return safeEditReply(interaction, {
                content:
                    `ℹ️ No changes were made. Provide at least 1 field to update (label/price/duration/category/requires_key).\n\n` +
                    `Product **${before.label}** (\`${before.value}\`) stays as it was.`
            });
        }

        saveConfig(config);
        await logAudit(interaction.client, {
            action: 'EDIT_PRODUCT',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Update product: **${before.label}** (\`${before.value}\`) — ${changes.join('; ')}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ Product **${product.label}** (\`${product.value}\`) successfully updated!\n\n` +
                `📝 Changes:\n${changes.map(c => `• ${c}`).join('\n')}\n\n` +
                `💡 Use \`/refresh-panel <id>\` to re-render installed panels.`
        });
    }
};

// v3.9.50: expose the price validator for unit tests (attached after the
// handler assignment above so it isn't overwritten).
module.exports.priceValidationError = priceValidationError;
