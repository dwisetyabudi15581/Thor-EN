/**
 * Ticket domain handler — all ticket-related customIds.
 *
 * Extracted from handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior preserved as-is — only moved to its own file.
 *
 * CustomIds handled:
 *   - ticket_trade                (button)  → show the product dropdown
 *   - select_product              (select)  → create a product ticket
 *   - ticket_help / ticket_report(button)  → create a help/report ticket
 *   - ticket_close                (button)  → show the confirmation buttons
 *   - ticket_close_abort / _abort2(button) → cancel close (don't close the channel)
 *   - ticket_close_success        (button)  → close a help/report ticket (successful)
 *   - ticket_close_cancel_trans   (button)  → close a transaction ticket without a key
 *   - ticket_close_cancel         (button)  → v3.9.35: close a help/report/
 *                                             claim/giveaway ticket WITHOUT
 *                                             completing (label: "❌ Close Without Completing")
 *   - ticket_set_key              (button)  → open the Set Key modal
 *   - modal_set_key:<value>       (modal)   → full Set Key flow
 *   - ticket_deliver              (button)  → v3.9.27: open the deliver order modal
 *                                             (non-key transaction products: accounts/services)
 *   - modal_deliver_order:<value> (modal)   → v3.9.27: full deliver order flow
 *
 * Router (src/interactions/index.js) already applies:
 *   - dedup (checkAndMark)
 *   - `replied/deferred` guard
 *   - interaction type check (button/select/modal)
 * So the domain handler focuses on its logic only.
 */

const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const { getConfig, safeEditReply, logAudit, checkIsAdmin } = require('../commands/_shared');
const {
    createTicket,
    closeTicket,
    sendInvoice,
    getTicketMeta,
    patchTicketMeta,
    resolveTicketType,
    // v3.9.38 FIX (FIX 3): a single product-by-meta lookup helper (stable value
    // first, label fallback) — used by every product lookup site in this file.
    resolveProduct
} = require('../data/ticketManager');
const { addKey, getActiveKeysByUserAndRole, formatRemaining } = require('../data/keyManager');
const { recordPurchase, parsePrice } = require('../data/statsManager');
const { scheduleRoleRemoval } = require('../data/roleScheduler');
// v3.9.32: redirect the midman/escrow category (dropdown) to the midman domain.
const midmanDomain = require('./midman');

// v3.9.38 FIX (FIX 2c/4): per-channel completion lock — prevents 2 admins from
// processing the completion flow (Set Key / Deliver Order / ✅ Order Successful)
// for the same ticket channel at the same time. The router dedup is only per
// interaction.id — 2 clicks/2 admins are NOT deduped, and the isCompleted gate
// only becomes effective AFTER the meta patch runs. This set closes that race
// window: atomic check-and-acquire at the start of the handler, release in finally.
// (Mirrors ticketLocks/closeTicketLocks in ticketManager.js.)
const completionLocks = new Set();

/**
 * v3.9.17 FIX: helper to check the verified role — consistent across all handlers.
 * Policy: if config.roles.verified is not set yet, ALLOW through (don't lock
 * out admins who haven't finished setting up). If it is set, the user must
 * have that role. Previously, 2 handlers used `if (!config.roles.verified || ...)`
 * (block when unset), 2 other handlers used `if (config.roles.verified && ...)`
 * (allow when unset). That inconsistency made the UX confusing.
 *
 * @returns {boolean} true if the user PASSES the check (may proceed), false if rejected.
 */
function passesVerifiedCheck(interaction, config) {
    // If member.roles is missing (partial member / user left), treat as rejected.
    if (!interaction.member?.roles?.cache) return false;
    // If the verified role is not set in the config, allow through.
    if (!config.roles.verified) return true;
    // If it is set, the user must have that role.
    return interaction.member.roles.cache.has(config.roles.verified);
}

module.exports = async function (interaction) {
    const config = getConfig();

    // ====================================================
    // === v3.9.14: TICKET CATEGORY SELECT MENU (DROPDOWN PANEL) ===
    // === customId: ticket_cat_select (exact match)          ===
    // ====================================================
    // When the panel uses use_dropdown=true, categories are rendered as a select menu.
    // The user picks a category in the dropdown → this handler runs.
    // v3.9.19: Behavior based on "has products or not" (flexible):
    //   - Category with products → show the product dropdown
    //   - Category without products → create the ticket directly (help/report/claim_giveaway/etc)
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_cat_select') {
        const categoryId = interaction.values && interaction.values[0];
        if (!categoryId) {
            return interaction.reply({
                content: '❌ No category selected.',
                flags: MessageFlags.Ephemeral
            });
        }
        const categories = config.ticketCategories || [];
        const catConfig = categories.find(c => c.id === categoryId);

        if (!catConfig) {
            return interaction.reply({
                content: `❌ Category \`${categoryId}\` not found in the config.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.17: use the passesVerifiedCheck helper (consistent across all handlers).
        if (!passesVerifiedCheck(interaction, config)) {
            return interaction.reply({ content: '❌ Please verify first!', flags: MessageFlags.Ephemeral });
        }

        // v3.9.32: midman/escrow category → open the escrow deal modal, NOT a ticket.
        // (The `ticket_cat:midman` button is already intercepted by the router → midman
        // domain; this redirect is specifically for the dropdown path whose value
        // can't be routed.)
        if (categoryId === 'midman') {
            return midmanDomain.openCreateModal(interaction);
        }

        // v3.9.19 FLEXIBILITY FIX: the logic is now based on "has products or not",
        // not requiresKey. This is more intuitive & flexible:
        //   - Category with products (transaction, jasa, etc)   → show the product
        //     dropdown. Can mix key & non-key products.
        //   - Category without products (help, report, claim_giveaway) → create
        //     the ticket directly without a product. Uses catConfig.label as the label.
        //
        // Previously (v3.9.18): used requiresKey=false to skip the dropdown. But
        // that made a "jasa" category with several non-key products skip the
        // dropdown → users couldn't choose which service they wanted. Bug fixed now.
        const productsInCat = (config.products || []).filter(p => {
            const pCat = p.category || 'transaction';
            return pCat === categoryId;
        });

        if (productsInCat.length === 0) {
            // No products in this category → create the ticket directly.
            const product = {
                label: catConfig.label || 'Support',
                duration: '-',
                price: '-',
                isHelp: true,
                category: categoryId,
                // v3.9.19: requiresKey=false so the Set Key button doesn't appear.
                requiresKey: false
            };
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return createTicket(interaction, product);
        }

        // Has products → show the product dropdown filtered by category
        // v3.9.26: label/price sliced to 100 (Discord select option limit).
        // v3.9.27: per-product emoji — 📦 non-key (account/service) vs 🔑 uses a key,
        // so buyers immediately know which product needs a key.
        const selectMenu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_product')
                .setPlaceholder(`Select a product — ${catConfig.label}...`.slice(0, 100))
                .addOptions(
                    productsInCat.map(p => ({
                        label: String(p.label || 'Product').slice(0, 100),
                        description: String(p.price || '-').slice(0, 100),
                        value: p.value,
                        emoji: p.requiresKey === false ? '📦' : '🔑'
                    }))
                )
        );
        return interaction.reply({
            content: `Please select a product in the **${catConfig.label}** category ${catConfig.emoji || ''}:`,
            components: [selectMenu],
            flags: MessageFlags.Ephemeral
        });
    }

    // ====================================================
    // === v3.9.11 Phase 2: TICKET CATEGORY BUTTON → FILTERED PRODUCT DROPDOWN ===
    // === customId: ticket_cat:<categoryId>                ===
    // ====================================================
    // v3.9.19: When a user clicks a category button on the dynamic ticket panel:
    //   - If the category has products → show the filtered product dropdown.
    //   - If the category has no products → create the ticket directly (help/report/custom).
    // Key & non-key products can be mixed in 1 category (e.g. "Jasa" with
    // a non-key "Joki" + a key-based "Booster").
    if (interaction.isButton() && interaction.customId.startsWith('ticket_cat:')) {
        const categoryId = interaction.customId.split(':')[1];
        const categories = config.ticketCategories || [];
        const catConfig = categories.find(c => c.id === categoryId);

        if (!catConfig) {
            return interaction.reply({
                content: `❌ Category \`${categoryId}\` not found in the config.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.17: use the passesVerifiedCheck helper (consistent across all handlers).
        if (!passesVerifiedCheck(interaction, config)) {
            return interaction.reply({ content: '❌ Please verify first!', flags: MessageFlags.Ephemeral });
        }

        // v3.9.19 FLEXIBILITY FIX: same logic as ticket_cat_select above.
        //   - Has products in the category → show the product dropdown.
        //   - No products              → create the ticket directly (help/report/custom).
        // Key & non-key products can be mixed in 1 category (e.g. "Jasa" with
        // a non-key "Joki" + a key-based "Booster").
        const productsInCat = (config.products || []).filter(p => {
            const pCat = p.category || 'transaction';
            return pCat === categoryId;
        });

        if (productsInCat.length === 0) {
            // No products → create the ticket directly with label = catConfig.label.
            const product = {
                label: catConfig.label || 'Support',
                duration: '-',
                price: '-',
                isHelp: true,
                category: categoryId,
                requiresKey: false
            };
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return createTicket(interaction, product);
        }

        // Has products → show the product dropdown filtered by category
        // v3.9.26: label/price sliced to 100 (Discord select option limit) — old/restored
        // data can exceed the limit → addOptions throws → this ticket category flow
        // dies completely until the product is fixed.
        // v3.9.27: per-product emoji 📦/🔑 (see ticket_cat_select above).
        const selectMenu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_product')
                .setPlaceholder(`Select a product — ${catConfig.label}...`.slice(0, 100))
                .addOptions(
                    productsInCat.map(p => ({
                        label: String(p.label || 'Product').slice(0, 100),
                        description: String(p.price || '-').slice(0, 100),
                        value: p.value,
                        emoji: p.requiresKey === false ? '📦' : '🔑'
                    }))
                )
        );
        return interaction.reply({
            content: `Please select a product in the **${catConfig.label}** category ${catConfig.emoji || ''}:`,
            components: [selectMenu],
            flags: MessageFlags.Ephemeral
        });
    }

    // ====================================================
    // === TICKET: TRANSACTION BUTTON → PRODUCT DROPDOWN (LEGACY) ===
    // ====================================================
    if (interaction.isButton() && interaction.customId === 'ticket_trade') {
        // v3.9.17: use the passesVerifiedCheck helper (consistent across all handlers).
        if (!passesVerifiedCheck(interaction, config)) {
            return interaction.reply({ content: '❌ Please verify first!', flags: MessageFlags.Ephemeral });
        }
        if (!config.products || config.products.length === 0) {
            return interaction.reply({ content: '❌ No products yet.', flags: MessageFlags.Ephemeral });
        }
        const selectMenu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_product')
                .setPlaceholder('Select the product you want to buy...')
                .addOptions(
                    // v3.9.26: slice to 100 (Discord select option limit) — see ticket_cat:.
                    // v3.9.27: per-product emoji 📦/🔑 + generic text (previously
                    // "key package" even though the dropdown could contain non-key products).
                    config.products.map(p => ({
                        label: String(p.label || 'Product').slice(0, 100),
                        description: String(p.price || '-').slice(0, 100),
                        value: p.value,
                        emoji: p.requiresKey === false ? '📦' : '🔑'
                    }))
                )
        );
        return interaction.reply({
            content: 'Please select a product below:',
            components: [selectMenu],
            flags: MessageFlags.Ephemeral
        });
    }

    // ====================================================
    // === TICKET: PICK PRODUCT / HELP / REPORT → CREATE TICKET ===
    // ====================================================
    if (
        (interaction.isStringSelectMenu() && interaction.customId === 'select_product') ||
        (interaction.isButton() && (interaction.customId === 'ticket_help' || interaction.customId === 'ticket_report'))
    ) {
        // v3.9.17: use the passesVerifiedCheck helper (consistent across all handlers).
        if (!passesVerifiedCheck(interaction, config)) {
            return interaction.reply({ content: '❌ Please verify first!', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let product;
        if (interaction.customId === 'select_product') {
            const selectedValue = interaction.values[0];
            product = config.products.find(p => p.value === selectedValue);
            if (!product) return safeEditReply(interaction, { content: '❌ Product not found.' });
        } else if (interaction.customId === 'ticket_help') {
            // v3.9.18: label updated from "Bantuan Staff" → "Help" (per the new default).
            product = { label: 'Help', duration: '-', price: '-', isHelp: true, category: 'help' };
        } else if (interaction.customId === 'ticket_report') {
            // v3.9.18: label updated from "Laporkan Member" → "Report" (per the new default).
            product = { label: 'Report', duration: '-', price: '-', isHelp: true, category: 'report' };
        } else {
            // v3.9.11 Phase 3: multi-panel ticket — customId `ticket_cat:<categoryId>`
            // will be handled here. For now, fall back to help.
            product = { label: 'Help', duration: '-', price: '-', isHelp: true, category: 'help' };
        }
        return createTicket(interaction, product);
    }

    // ====================================================
    // === TICKET: CLOSE TICKET (ADMIN) ===
    // ====================================================
    if (interaction.isButton() && interaction.customId === 'ticket_close') {
        const isAdmin = checkIsAdmin(interaction.member);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only Admin/Staff can close this ticket!',
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.31 FIX (pattern P1-8): guard that the channel still exists. Previously
        // `interaction.channel.id` below had no `?.` — if the channel was deleted
        // right before the admin clicked the button (partial/uncached), it threw a
        // TypeError swallowed by the global handler as a generic error with no clear message.
        if (!interaction.channel) {
            return interaction.reply({
                content: '❌ The ticket channel no longer exists (another admin may have already closed it).',
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.4 FIX: use getTicketMeta (the primary tickets.json source), not direct topic parsing.
        const meta = getTicketMeta(interaction.channel.id, interaction.channel?.topic || '');
        // v3.9.27 FIX (user-reported bug): non-key products (selling ML accounts,
        // services, etc) used to be treated as HELP tickets here because isTransaction
        // was derived from meta.requiresKey. As a result, the "✅ Order Successful /
        // ❌ Purchase Cancelled" buttons never appeared for products without a key.
        // Now: resolveTicketType() reads the explicit isTransaction flag
        // (saved at createTicket since v3.9.27+) — non-key transactions finally
        // get the correct close buttons.
        const type = resolveTicketType(meta);
        const isTransaction = type.isTransaction;
        const requiresKey = type.requiresKey;

        // v3.9.20: check whether Set Key / Deliver Order was already done. If so,
        // the transaction is already successful → the close buttons only offer "Done" (skip "Purchase Cancelled").
        const isCompleted = type.isCompleted;

        // 5 close-confirmation button scenarios:
        // - Key transaction + Set Key already DONE (isCompleted=true):
        //     • ✅ Done (close successful — send invoice & transcript)
        //     • ⏏️ Cancel Close
        //
        // - Key transaction + Set Key NOT done (requiresKey=true, isCompleted=false):
        //     • ❌ Purchase Cancelled (close without invoice)
        //     • ⏏️ Cancel Close
        //   (success is marked via Set Key, so no success button needed here)
        //
        // - Non-key transaction + order already DELIVERED (isCompleted=true) — v3.9.27:
        //     • ✅ Done (close + transcript; the invoice was already sent at Deliver Order)
        //     • ⏏️ Cancel Close
        //
        // - Non-key transaction + not delivered (requiresKey=false, isCompleted=false):
        //     • ✅ Order Successful (close + send invoice/testimonial + role + stats)
        //     • ❌ Purchase Cancelled (close without invoice)
        //     • ⏏️ Cancel Close
        //
        // - Help / Report / Claim / Giveaway (isTransaction=false):
        //     • ✅ Done (close successful — transcript marked complete)
        //     • ❌ Close Without Completing (close WITHOUT completing — transcript
        //       marked not complete; the channel is still deleted)
        //     • ⏏️ Cancel Close (don't close the channel)
        //
        // v3.9.35 FIX (user-reported bug): the "❌ Close Without Completing" button
        // previously used the wrong customId `ticket_close_abort` — the same as
        // "⏏️ Cancel Close". As a result, BOTH buttons only cancelled the closing;
        // help/report/claim/giveaway tickets couldn't be closed without completing.
        // Now that button uses the `ticket_close_cancel` customId, which actually
        // closes the ticket.
        const confirmRow = new ActionRowBuilder();
        if (isTransaction && requiresKey && isCompleted) {
            // v3.9.20: Set Key already done → the transaction is already successful.
            // Only show "Done" + "Cancel Close" (no "Purchase Cancelled" because
            // the key was already sent & the role already granted).
            confirmRow.addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_close_success')
                    .setLabel('✅ Done')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('ticket_close_abort')
                    .setLabel('⏏️ Cancel Close')
                    .setStyle(ButtonStyle.Secondary)
            );
        } else if (isTransaction && !requiresKey && isCompleted) {
            // v3.9.27: Deliver Order / Order Successful already done for a non-key
            // product → mirrors the Set Key branch: only "Done" + "Cancel Close".
            confirmRow.addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_close_success')
                    .setLabel('✅ Done')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('ticket_close_abort')
                    .setLabel('⏏️ Cancel Close')
                    .setStyle(ButtonStyle.Secondary)
            );
        } else if (isTransaction && requiresKey) {
            // Key transaction — success comes via Set Key; here it's only cancel/abort
            confirmRow.addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_close_cancel_trans')
                    .setLabel('❌ Purchase Cancelled')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('ticket_close_abort')
                    .setLabel('⏏️ Cancel Close')
                    .setStyle(ButtonStyle.Secondary)
            );
        } else if (isTransaction && !requiresKey) {
            // Non-key transaction — needs a success button to send the invoice
            confirmRow.addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_close_success')
                    .setLabel('✅ Order Successful')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('ticket_close_cancel_trans')
                    .setLabel('❌ Purchase Cancelled')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('ticket_close_abort')
                    .setLabel('⏏️ Cancel Close')
                    .setStyle(ButtonStyle.Secondary)
            );
        } else {
            // Help / Report / Claim / Giveaway (non-transaction).
            // v3.9.35 FIX: "Close Without Completing" uses the
            // `ticket_close_cancel` customId (previously the wrong `ticket_close_abort`
            // → both buttons only cancelled). "Cancel Close" now consistently
            // uses `ticket_close_abort` like the other branches
            // (`_abort2` is still handled for old ephemerals).
            confirmRow.addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_close_success')
                    .setLabel('✅ Done')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('ticket_close_cancel')
                    .setLabel('❌ Close Without Completing')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('ticket_close_abort')
                    .setLabel('⏏️ Cancel Close')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        // v3.9.20: different confirmation message for the 5 scenarios.
        let msg;
        if (isTransaction && requiresKey && isCompleted) {
            // Set Key already done → transaction successful → close + save transcript.
            msg =
                '✅ The transaction is already successful (Set Key was done).\nClick **✅ Done** to close the ticket & save the transcript.';
        } else if (isTransaction && !requiresKey && isCompleted) {
            // v3.9.27: the non-key order was already delivered → mirrors Set Key.
            msg =
                '✅ The order has already been delivered to the buyer.\nClick **✅ Done** to close the ticket & save the transcript.';
        } else if (isTransaction && requiresKey) {
            msg = '⚠️ Close the ticket without providing the key? Click **❌ Purchase Cancelled**.';
        } else if (isTransaction && !requiresKey) {
            msg =
                '⚠️ Close this transaction ticket?\n' +
                '• **✅ Order Successful** — transaction successful, send invoice/testimonial\n' +
                '• **❌ Purchase Cancelled** — cancelled, no invoice';
        } else {
            // v3.9.35: help/report confirmation message — broken down per button
            // (the same pattern as the non-key transaction branch above).
            msg =
                '⚠️ Close this ticket?\n' +
                '• **✅ Done** — completed, transcript marked successful\n' +
                '• **❌ Close Without Completing** — close the ticket now, transcript marked not completed';
        }
        return interaction.reply({ content: msg, components: [confirmRow], flags: MessageFlags.Ephemeral });
    }

    if (
        interaction.isButton() &&
        (interaction.customId === 'ticket_close_abort' || interaction.customId === 'ticket_close_abort2')
    ) {
        // Wrap interaction.update in a try/catch. If the ephemeral was dismissed (10008)
        // or the token expired (10062), fall back to an ephemeral reply.
        try {
            return await interaction.update({ content: '❌ Ticket closing cancelled.', embeds: [], components: [] });
        } catch (err) {
            if (err.code === 10008 || err.code === 10062) {
                return interaction
                    .reply({ content: '❌ Ticket closing cancelled.', flags: MessageFlags.Ephemeral })
                    .catch(() => {});
            }
            console.warn('ticket_close_abort update error:', err.message);
            if (!interaction.replied) {
                return interaction
                    .reply({ content: '❌ Ticket closing cancelled.', flags: MessageFlags.Ephemeral })
                    .catch(() => {});
            }
        }
    }

    if (interaction.isButton() && interaction.customId === 'ticket_close_success') {
        // For help/report tickets (completed) OR non-key transactions (order successful).
        // isSuccess=true → closeTicket will send the invoice to the invoice channel (if set).
        //
        // v3.9.24 FIX: re-check admin + validate the channel is a registered ticket.
        // Previously this confirmation button went straight to closeTicket WITHOUT any
        // check (safe only because the row was ephemeral — not because of a server-side
        // check). closeTicket deletes whatever channel it is given, so a forged/legacy
        // customId could delete a non-ticket channel.
        if (!checkIsAdmin(interaction.member)) {
            return interaction.reply({
                content: '❌ Only Admin/Staff can close tickets!',
                flags: MessageFlags.Ephemeral
            });
        }
        const closeMeta = getTicketMeta(interaction.channel?.id, interaction.channel?.topic || '');
        if (!closeMeta) {
            return interaction.reply({
                content: '❌ This channel is not a registered ticket (another admin may have already closed it).',
                flags: MessageFlags.Ephemeral
            });
        }
        try {
            await interaction.deferUpdate();
        } catch (err) {
            if (err.code !== 10008 && err.code !== 10062) {
                console.warn('ticket_close_success deferUpdate error:', err.message);
            }
        }

        // v3.9.27: NON-KEY transactions closed as "✅ Order Successful"
        // WITHOUT going through 📦 Deliver Order → run the side effects here:
        // auto-role (the long-standing unfulfilled /set-product-role promise for
        // non-key products), record the purchase to stats, mark isCompleted.
        // The invoice is still handled by closeTicket (isSuccess=true + isTransaction).
        // If already isCompleted (via Deliver Order), skip — don't double up.
        const closeType = resolveTicketType(closeMeta);
        if (closeType.isTransaction && !closeType.requiresKey && !closeType.isCompleted) {
            // v3.9.38 FIX (FIX 4): "✅ Order Successful" double-click race — 2 clicks
            // (or 2 admins) before the first click's isCompleted patch runs →
            // completeNonKeyOrder runs twice (recordPurchase 2x, auto-role 2x). Uses
            // completionLocks (FIX 2): check-and-acquire the channel lock before the
            // side effects, release in finally. The first click wins; a second click
            // that happens to arrive AFTER the release is still safe — the meta is
            // re-read under the lock so the first click's isCompleted is visible.
            const closeChId = interaction.channel.id;
            if (completionLocks.has(closeChId)) {
                await interaction
                    .followUp({ content: '⏳ The ticket is being processed by another admin.', flags: MessageFlags.Ephemeral })
                    .catch(() => {});
                return;
            }
            completionLocks.add(closeChId);
            try {
                // v3.9.38 FIX (FIX 4): re-read the meta UNDER THE LOCK — closeMeta above
                // may be stale (read before deferUpdate). If another admin just
                // completed the ticket, isCompleted is now visible → skip the double.
                const freshMeta = getTicketMeta(closeChId, interaction.channel?.topic || '');
                const freshType = resolveTicketType(freshMeta);
                if (freshType.isTransaction && !freshType.requiresKey && !freshType.isCompleted) {
                    const warnings = await completeNonKeyOrder(interaction, freshMeta);
                    if (warnings.length > 0) {
                        // The ticket is still closed (the admin's intent is clear), but
                        // report the issues so they can be followed up manually (ephemeral
                        // — still visible even after the channel is deleted).
                        await interaction
                            .followUp({
                                content: `⚠️ The ticket was closed as **Order Successful**, but there were issues:\n• ${warnings.join('\n• ')}`,
                                flags: MessageFlags.Ephemeral
                            })
                            .catch(() => {});
                    }
                }
            } finally {
                // v3.9.38 FIX (FIX 4): make sure the lock is released even on error.
                completionLocks.delete(closeChId);
            }
        }
        await closeTicket(interaction.channel, interaction.user, true);
        return;
    }

    if (
        interaction.isButton() &&
        (interaction.customId === 'ticket_close_cancel_trans' || interaction.customId === 'ticket_close_cancel')
    ) {
        // Close the ticket WITHOUT success — two doors, one behavior:
        //   - ticket_close_cancel_trans ("❌ Purchase Cancelled") → a TRANSACTION
        //     ticket that was cancelled (no invoice).
        //   - ticket_close_cancel ("❌ Close Without Completing")   → v3.9.35: a
        //     help/report/claim/giveaway ticket closed without being resolved.
        //     This button was previously miswired to `ticket_close_abort` (a
        //     user-reported bug: "close without completing" only cancelled the closing).
        // v3.9.24 FIX: re-check admin + validate the ticket (same as ticket_close_success).
        if (!checkIsAdmin(interaction.member)) {
            return interaction.reply({
                content: '❌ Only Admin/Staff can close tickets!',
                flags: MessageFlags.Ephemeral
            });
        }
        if (!getTicketMeta(interaction.channel?.id, interaction.channel?.topic || '')) {
            return interaction.reply({
                content: '❌ This channel is not a registered ticket (another admin may have already closed it).',
                flags: MessageFlags.Ephemeral
            });
        }
        try {
            await interaction.deferUpdate();
        } catch (err) {
            if (err.code !== 10008 && err.code !== 10062) {
                console.warn('ticket_close_cancel_trans deferUpdate error:', err.message);
            }
        }
        await closeTicket(interaction.channel, interaction.user, false);
        return;
    }

    // ====================================================
    // === TICKET: SET KEY BUTTON (ADMIN) → MODAL ===
    // ====================================================
    if (interaction.isButton() && interaction.customId === 'ticket_set_key') {
        const isAdmin = checkIsAdmin(interaction.member);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only Admin/Staff can set a key!',
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.31 FIX (pattern P1-8): guard that the channel still exists — consistent
        // with the existing guard in the Set Key modal (line ~654). `interaction.channel.id`
        // below without `?.` could throw a TypeError if the channel was deleted right
        // before the admin clicked (partial/uncached).
        if (!interaction.channel) {
            return interaction.reply({
                content: '❌ The ticket channel no longer exists (another admin may have already closed it).',
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.4 FIX: use getTicketMeta (the primary tickets.json source), not direct topic parsing.
        const meta = getTicketMeta(interaction.channel.id, interaction.channel?.topic || '');
        const productName = meta?.productName || null;
        // v3.9.27: use resolveTicketType (one source of truth) — Set Key is only
        // for transaction tickets that actually use a key.
        const setType = resolveTicketType(meta);
        // v3.9.38 FIX (FIX 2a): isCompleted gate — a Set Key button that has already
        // been used (Set Key / Deliver Order / Order Successful) must not open
        // the modal again. Previously this gate only existed on the deliver & close
        // flows — the Set Key flow leaked: duplicate invoice, duplicate stats,
        // buyer gets 2 keys. (Layer 1 of 3 — see the modal handler for layers 2-3.)
        if (setType.isCompleted) {
            return interaction.reply({
                content: 'ℹ️ The key for this ticket has already been set. The ticket is already complete.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (!productName || !setType.isTransaction) {
            return interaction.reply({
                content: '❌ The Set Key button is only for transaction tickets.',
                flags: MessageFlags.Ephemeral
            });
        }
        // v3.9.16: reject non-key products (requiresKey=false).
        // The Set Key button should never appear for non-key products, but this is defense-in-depth
        // in case an admin somehow clicks via an old customId / an old not-yet-updated message.
        // (v3.9.27: non-key products now have their own button — 📦 Deliver Order.)
        if (!setType.requiresKey) {
            return interaction.reply({
                content:
                    '❌ This product does not require a key. Use the **📦 Deliver Order** button to send the order details to the buyer.',
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.26 FIX: look up by value FIRST, label as fallback. Previously
        // it was label-only — renaming a product via /update-product made the Set Key
        // button fail with "Product not found" on all old tickets (ticket meta
        // stores the frozen label from when the ticket was created). value = stable ID.
        // v3.9.38 FIX (FIX 3b): use resolveProduct() — the same single helper at
        // every lookup site (v3.9.38+ tickets resolve by productValue in the meta,
        // legacy tickets still fall back by label).
        const product = resolveProduct(config, meta);
        if (!product) {
            return interaction.reply({
                content: `❌ Product "${productName}" not found in the config (it may have been renamed/deleted). Check /list-products.`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (!product.roleId) {
            return interaction.reply({
                content: `❌ Product **${product.label}** has no auto-role yet. Run \`/set-product-role\` first.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Open the key input modal
        // v3.9.27 FIX: slice the title to 45 chars — the Discord ModalBuilder limit.
        // A product label can be 80 chars (the /add-product limit) → "Set Key — <label>"
        // can exceed 45 → showModal throws → the Set Key button dies silently.
        const modal = new ModalBuilder()
            .setCustomId(`modal_set_key:${product.value}`)
            .setTitle(`Set Key — ${product.label}`.slice(0, 45));

        const keyInput = new TextInputBuilder()
            .setCustomId('key_value')
            .setLabel('Key to send to the buyer')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder('Example: ABCDE-12345-FGHIJ-67890')
            .setMinLength(1)
            .setMaxLength(500);

        modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
        return interaction.showModal(modal);
    }

    // ====================================================
    // === MODAL SET KEY SUBMIT — FULL FLOW ===
    // ====================================================
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_set_key:')) {
        // v3.9.24 FIX: re-check admin on modal submit (defense-in-depth — same
        // as backup.js). Previously the admin check only existed on the ticket_set_key
        // button; the modal could be submitted by another user if it somehow got
        // opened (forged customId / weird client state).
        if (!checkIsAdmin(interaction.member)) {
            return interaction
                .reply({
                    content: '❌ Only Admin/Staff can set a key!',
                    flags: MessageFlags.Ephemeral
                })
                .catch(() => {});
        }
        // v3.9.38 FIX (FIX 2c): per-channel completion lock (defense-in-depth
        // layer 3). The isCompleted gate on the button (layer 1) + the meta
        // re-check in the modal (layer 2) don't close the 2-admins-submitting-
        // simultaneously race — both submits pass the check BEFORE the first
        // side effect finishes. The lock is check-and-acquired atomically on
        // the event loop; released in finally.
        const lockChId = interaction.channel?.id || null;
        if (lockChId && completionLocks.has(lockChId)) {
            return interaction
                .reply({ content: '⏳ The ticket is being processed by another admin, please wait a moment.', flags: MessageFlags.Ephemeral })
                .catch(() => {});
        }
        if (lockChId) completionLocks.add(lockChId);
        try {
            // v3.9.7: log deferReply failures (same as the embed builder modal)
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(err => {
                console.warn(`[Set Key Modal] deferReply failed for ${interaction.customId}: ${err.message}`);
            });

            const productValue = interaction.customId.split(':')[1];
            const keyValue = interaction.components[0]?.components?.[0]?.value?.trim() || '';
            // v3.9.38 FIX (FIX 5a): empty/whitespace keys are rejected BEFORE any
            // side effect. Modal required=true + minLength=1 usually prevents it,
            // but whitespace-only input passes Discord's validation (trim → empty)
            // and used to still be saved as a blank key by addKey.
            if (!keyValue) {
                return safeEditReply(interaction, { content: '❌ The key cannot be empty.' });
            }

            // P1-8 FIX: validate that interaction.channel still exists (not deleted by another admin).
            // Previously: if the channel was already deleted when the admin submitted the modal,
            // `interaction.channel.topic` threw a TypeError → generic error.
            if (!interaction.channel) {
                return safeEditReply(interaction, {
                    content: '❌ The ticket channel no longer exists (another admin may have already closed it).'
                }).catch(() => {});
            }

            // v3.9.1: read the ticket metadata from tickets.json (source of truth).
            // Fallback to topic parsing for old tickets created before v3.9.1.
            const topic = interaction.channel.topic || '';
            const meta = getTicketMeta(interaction.channel.id, topic);
            const userId = meta?.userId || null;
            const price = meta?.price || 'Unknown';

            if (!userId) {
                return safeEditReply(interaction, {
                    content: '❌ Failed to get the ticket metadata (this channel may not be a valid ticket).'
                });
            }

            // v3.9.38 FIX (FIX 2b, layer 2): re-check isCompleted under the lock —
            // another admin may have completed this ticket (Set Key / Deliver Order /
            // ✅ Order Successful) between the modal opening and being submitted.
            // Without the re-check, the invoice + stats + key get sent TWICE.
            if (resolveTicketType(meta).isCompleted) {
                return safeEditReply(interaction, {
                    content: 'ℹ️ This ticket has already been processed by another admin.'
                });
            }

            // v3.9.38 FIX (FIX 3b): resolve the product from the META (stable
            // productValue first, label fallback) — rename-proof. Last fallback is
            // the value in the customId (legacy v3.9.26 behavior: the button resolved
            // the product then embedded its value into the modal customId).
            const product = resolveProduct(config, meta) || config.products.find(p => p.value === productValue);
            if (!product) {
                return safeEditReply(interaction, { content: `❌ Product value \`${productValue}\` not found.` });
            }
            if (!product.roleId) {
                return safeEditReply(interaction, { content: `❌ Product **${product.label}** has no auto-role yet.` });
            }

            const guild = interaction.guild;
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
                return safeEditReply(interaction, { content: `❌ Member <@${userId}> is no longer on the server.` });
            }
            const role = guild.roles.cache.get(product.roleId);
            if (!role) {
                return safeEditReply(interaction, {
                    content: `❌ Role ID \`${product.roleId}\` not found in the guild.`
                });
            }

            // === 1. Save the new key (independent expireAt) ===
            // v3.9.17 FIX: wrap addKey in a try/catch. Previously, a duplicate key
            // made addKey throw "Key already exists" → propagated to the global handler
            // → the admin saw the generic "An error occurred, try again" without
            // knowing the cause. Now: a specific catch with a clear reply.
            let keyEntry;
            try {
                keyEntry = addKey({
                    key: keyValue,
                    userId: member.id,
                    username: member.user.tag,
                    roleId: role.id,
                    productName: product.label,
                    days: product.days || 0,
                    guildId: interaction.guild.id // v3.9.3: save the guildId so cross-guild wipes are accurate
                });
            } catch (keyErr) {
                // v3.9.38 FIX (FIX 6): log only the key length — the duplicate error
                // from keyManager no longer includes the key value (console log leak).
                console.warn(`⚠️ Failed to save the key (possibly a duplicate) — key (len=${keyValue.length}):`, keyErr.message);
                return safeEditReply(interaction, {
                    content: `❌ Failed to save the key: ${keyErr.message}\n\n💡 Try a different key, or delete the old one via \`/list-keys\` first.`
                });
            }

            // === 2. Schedule role removal (MAX EXTEND) — v3.9.17: moved BEFORE addRole ===
            // v3.9.17 FIX: reorder. Previously: addKey → addRole → scheduleRoleRemoval.
            // If the bot crashed after addRole but before scheduling, the role stuck without
            // auto-expire. Now: addKey → scheduleRoleRemoval → addRole.
            // If it crashes after scheduling but before addRole: an orphan schedule entry
            // (roleId scheduled but the user doesn't have the role) — the scheduler tick
            // will detect "member doesn't have the role" and skip; safer than a permanent role.
            let scheduleResult;
            try {
                scheduleResult = scheduleRoleRemoval({
                    userId: member.id,
                    roleId: role.id,
                    guildId: guild.id,
                    days: product.days || 0,
                    expireAt: keyEntry.expireAt,
                    productName: product.label
                });
            } catch (schedErr) {
                console.error(
                    `⚠️ Failed to scheduleRoleRemoval during set-key (the key is saved, the role was NOT granted): ${schedErr.message}`
                );
                // Note: the just-added key is saved without an auto-expire schedule.
                // There is no targeted removal API for a single key in keyManager (only
                // removeAllKeysByUser, which is too broad). An admin can remove it manually
                // via /list-keys if needed. Log a warning so it's visible.
                console.warn(
                    // v3.9.38 FIX (FIX 6): don't leak the raw key value to the console
                    // log — the length is enough (the /set-key audit log pattern from v3.9.1).
                    `⚠️ Schedule failed — key (len=${keyValue.length}) saved without auto-expire. An admin needs to remove it manually via /list-keys if needed.`
                );
                return safeEditReply(interaction, {
                    content: `❌ Failed to schedule the role auto-expire: ${schedErr.message}\n\nThe key has been saved but the role has NOT been granted yet. Try Set Key again, or contact the dev.`
                });
            }

            // === 3. Grant the role to the member ===
            try {
                if (!member.roles.cache.has(role.id)) {
                    await member.roles.add(role);
                }
            } catch (err) {
                console.error('Failed to add the role during set key:', err.message);
                return safeEditReply(interaction, {
                    content: `❌ Failed to grant the role ${role}. Make sure the bot's role is ABOVE that role.\n\nKey + schedule are already saved. Contact an admin to add the role manually.`
                });
            }

            // === 4. DM the member ===
            // v3.9.22: DM format per the user template — with emojis so it feels
            // livelier & less empty. The role uses the role name (role.name), not
            // a mention (`${role}`), because role mentions don't resolve in DMs
            // (they render as "unknown role" or a raw @role).
            let dmSent = false;
            try {
                let expireInfo;
                if (keyEntry.expireAt === null) {
                    expireInfo = 'permanent (never expires)';
                } else {
                    const days = Math.ceil((keyEntry.expireAt - Date.now()) / 86400000);
                    expireInfo = `in ${days} days`;
                }

                // Check all active keys for extra info
                // v3.9.31: pass guildId (optional) so it's guild-scoped, consistent with the other patterns.
                const activeKeys = getActiveKeysByUserAndRole(member.id, role.id, Date.now(), guild.id);
                // v3.9.26 FIX: bound the key list in the DM. Keys can be 200 chars; 4+ long keys
                // make the DM exceed 2000 chars → member.send throws → dmSent=false even though
                // the key/role/schedule already succeeded. Now at most the top 5 keys + a summary.
                const MAX_KEYS_IN_DM = 5;
                const shownKeys = activeKeys.slice(0, MAX_KEYS_IN_DM);
                const hiddenKeys = activeKeys.length - shownKeys.length;
                const keyList =
                    shownKeys
                        .map((k, i) => {
                            const rem = formatRemaining(k);
                            return `${i + 1}. \`${k.key}\` (${rem} left)`;
                        })
                        .join('\n') + (hiddenKeys > 0 ? `\n... +${hiddenKeys} more keys (ask an admin)` : '');
                const keyListStr = activeKeys.length > 0 ? keyList : '_(none yet)_';

                // v3.9.17 FIX: sanitize backticks in keyValue. If the key contains
                // backticks, the inline code can break. Replace them with single quotes.
                const safeKey = keyValue.replace(/`/g, "'");

                await member.send({
                    content:
                        `Hi ${member.user.username}! Your transaction is complete 🎉\n\n` +
                        `📦 Product: ${product.label}\n` +
                        `🌐 Server: ${guild.name}\n\n` +
                        `🔑 KEY:\n` +
                        `\`${safeKey}\`\n\n` +
                        `🎭 Role: ${role.name}\n` +
                        `⏰ Expires: ${expireInfo}\n\n` +
                        `📋 Your active keys for this role:\n${keyListStr}\n\n` +
                        `💡 Keep your key safe. If the role suddenly disappears while your key is still active, contact an admin.`
                });
                dmSent = true;
            } catch (_dmErr) {
                console.log(`ℹ️ Could not send a DM to ${member.user.tag} (DMs may be closed).`);
            }

            // === 5. Send the invoice to the invoice channel ===
            // v3.9.8 FIX: wrap sendInvoice in a try/catch. Previously, when sendInvoice
            // threw (invoice channel deleted / bot missing SendMessages), the outer catch
            // masked the error. Yet the key + role + schedule + DM had already run.
            // The admin saw the error → clicked "Set Key" again → addKey ran 2x (duplicate key).
            // v3.9.27: record isInvoiceSent — the invoice sent at Set Key is NOT sent AGAIN
            // when closing with "Done" (previously sent twice: 1x here + 1x in closeTicket).
            let invoiceOk = false;
            try {
                invoiceOk = await sendInvoice(interaction.channel, userId, product.label, price, interaction.user);
            } catch (invoiceErr) {
                console.warn(`⚠️ Failed to send the invoice during set-key (the key is still saved): ${invoiceErr.message}`);
            }

            // === 5.5. Track the purchase for stats/leaderboard ===
            try {
                // v3.9.4: scoped per guild
                recordPurchase(interaction.guild.id, userId, parsePrice(price));
            } catch (_) {}

            // === 5.6. P1-10 FIX: audit log for SET_KEY via the ticket modal ===
            try {
                await logAudit(interaction.client, {
                    action: 'SET_KEY',
                    actorId: interaction.user.id,
                    actorTag: interaction.user.tag,
                    details: `Set key (ticket) for <@${member.id}> — product: **${product.label}**, role: ${role.name}`,
                    guildId: interaction.guild.id
                });
            } catch (_) {}

            // v3.9.8 FIX: reply ephemeral BEFORE deleting the channel. Previously, the
            // comment said "the channel is already deleted, so no editReply needed" — that was
            // WRONG. An ephemeral reply is tied to the interaction token (not the channel),
            // so it stays valid after the channel is deleted. Without editReply, the admin
            // stared at "Thinking..." for 15 minutes until the token expired.
            try {
                await safeEditReply(interaction, {
                    content: `✅ Set Key successful!\n\n👤 Member: <@${userId}>\n📦 Product: ${product.label}\n🎭 Role: ${role.name}\n${dmSent ? '📬 DM sent.' : '⚠️ DM failed.'}`
                });
            } catch (_) {}

            // === v3.9.21: Don't show a new embed/panel in the channel. ===
            // Just send a simple text message saying "the key was sent via DM".
            // The Close Ticket button from the initial createTicket message is still
            // there — the admin can click it once the Q&A with the member is done.
            try {
                patchTicketMeta(interaction.channel.id, {
                    isCompleted: true,
                    keySetAt: Date.now(),
                    keySetBy: interaction.user.id,
                    // v3.9.27: anti double-invoice on close (if the invoice was sent successfully).
                    ...(invoiceOk ? { isInvoiceSent: true } : {})
                });
            } catch (patchErr) {
                console.warn('⚠️ Failed to patch meta (isCompleted):', patchErr.message);
            }

            try {
                // v3.9.22: The channel notice is NOT for the admin — it's for the user.
                // Just let them know the key was sent via DM. Short & clear.
                // If the DM failed, fall back to telling the admin to send it manually.
                const noticeMsg = dmSent
                    ? `Hi <@${userId}>! 🔑 Your key has been sent via DM, check it 📬`
                    : `⚠️ <@${userId}> — failed to send a DM (DMs may be closed). An admin will send you the key manually.`;

                await interaction.channel.send({
                    content: noticeMsg
                });
            } catch (sendErr) {
                console.warn('⚠️ Failed to send the "key sent" notice to the channel:', sendErr.message);
            }

            // === 7. Success log (channel NOT deleted — an admin closes it manually) ===
            console.log(
                `✅ Set Key successful: ${member.user.tag} | product=${product.label} | role=${role.name} | extend=${scheduleResult.extended} | permanent=${scheduleResult.permanent} | dm=${dmSent} | invoice=${invoiceOk} | channel NOT deleted (waiting for an admin to close manually)`
            );
            return;
        } finally {
            // v3.9.38 FIX (FIX 2c): make sure the lock is released even if the handler throws.
            if (lockChId) completionLocks.delete(lockChId);
        }
    }

    // ====================================================
    // === v3.9.27: DELIVER ORDER BUTTON (ADMIN) → MODAL ===
    // === customId: ticket_deliver (button)             ===
    // ====================================================
    // Mirror of Set Key, specifically for NON-KEY transaction products (selling
    // ML accounts, services, etc). Previously non-key products only had the Close
    // Ticket button — the order details (account/password) only existed in the
    // ticket chat, which gets DELETED on close. Now: the admin clicks the button
    // → fills in the details in the modal → the bot DMs the details to the buyer
    // + auto-role (if set) + stats + invoice.
    if (interaction.isButton() && interaction.customId === 'ticket_deliver') {
        if (!checkIsAdmin(interaction.member)) {
            return interaction.reply({
                content: '❌ Only Admin/Staff can deliver orders!',
                flags: MessageFlags.Ephemeral
            });
        }

        const meta = getTicketMeta(interaction.channel?.id, interaction.channel?.topic || '');
        if (!meta) {
            return interaction.reply({
                content: '❌ This channel is not a registered ticket (another admin may have already closed it).',
                flags: MessageFlags.Ephemeral
            });
        }
        const deliverType = resolveTicketType(meta);
        if (!deliverType.isTransaction) {
            return interaction.reply({
                content: '❌ The Deliver Order button is only for transaction tickets.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (deliverType.requiresKey) {
            // Product uses a key → use Set Key (not this).
            return interaction.reply({
                content: '❌ This product uses a key — use the **🔑 Set Key** button.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (deliverType.isCompleted) {
            return interaction.reply({
                content: 'ℹ️ This ticket\'s order has already been delivered/completed. Just close the ticket (✅ Done).',
                flags: MessageFlags.Ephemeral
            });
        }

        // Product lookup: by value first, label fallback (the v3.9.26 pattern).
        // v3.9.38 FIX (FIX 3b): use resolveProduct() — lookup by productValue
        // in the meta (stable, rename-proof), label fallback for legacy tickets.
        const productName = meta?.productName || null;
        const product = resolveProduct(config, meta);
        if (!product) {
            return interaction.reply({
                content: `❌ Product "${productName}" not found in the config (it may have been renamed/deleted). Check /list-products.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Open the order details input modal.
        // v3.9.27 FIX: title sliced to 45 chars (ModalBuilder limit — see Set Key).
        const modal = new ModalBuilder()
            .setCustomId(`modal_deliver_order:${product.value}`)
            .setTitle(`Deliver Order — ${product.label}`.slice(0, 45));

        const detailsInput = new TextInputBuilder()
            .setCustomId('delivery_details')
            .setLabel('Order details for the buyer')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            // In a modal, Enter produces a REAL newline — fits multi-line
            // details (username/password/note). No \n conversion needed.
            .setPlaceholder('Example: Username: account123 | Password: secret | Note: ...')
            .setMinLength(1)
            .setMaxLength(1500);

        modal.addComponents(new ActionRowBuilder().addComponents(detailsInput));
        return interaction.showModal(modal);
    }

    // ====================================================
    // === v3.9.27: DELIVER ORDER MODAL SUBMIT — FULL FLOW ===
    // === customId: modal_deliver_order:<value> (modal)   ===
    // ====================================================
    // Order (mirrors Set Key): role-schedule → role → DM details → invoice →
    // stats → audit → admin reply → meta patch → channel notice.
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_deliver_order:')) {
        // v3.9.24-style: re-check admin on modal submit (defense-in-depth).
        if (!checkIsAdmin(interaction.member)) {
            return interaction
                .reply({
                    content: '❌ Only Admin/Staff can deliver orders!',
                    flags: MessageFlags.Ephemeral
                })
                .catch(() => {});
        }
        // v3.9.38 FIX (FIX 2c): per-channel completion lock (defense-in-depth
        // layer 3). The isCompleted gate on the button (layer 1) + the meta
        // re-check in the modal (layer 2) don't close the 2-admins-submitting-
        // simultaneously race — both submits pass the check BEFORE the first
        // side effect finishes. The lock is check-and-acquired atomically on
        // the event loop; released in finally.
        const lockChId = interaction.channel?.id || null;
        if (lockChId && completionLocks.has(lockChId)) {
            return interaction
                .reply({ content: '⏳ The ticket is being processed by another admin, please wait a moment.', flags: MessageFlags.Ephemeral })
                .catch(() => {});
        }
        if (lockChId) completionLocks.add(lockChId);
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(err => {
                console.warn(`[Deliver Order Modal] deferReply failed for ${interaction.customId}: ${err.message}`);
            });

            // P1-8-style FIX: validate the channel still exists (not deleted by another admin).
            if (!interaction.channel) {
                return safeEditReply(interaction, {
                    content: '❌ The ticket channel no longer exists (another admin may have already closed it).'
                }).catch(() => {});
            }

            const productValue = interaction.customId.split(':')[1];
            const details = interaction.components[0]?.components?.[0]?.value?.trim() || '';
            if (!details) {
                return safeEditReply(interaction, { content: '❌ The order details are empty.' });
            }

            const meta = getTicketMeta(interaction.channel.id, interaction.channel.topic || '');
            const userId = meta?.userId || null;
            const price = meta?.price || 'Unknown';
            if (!userId) {
                return safeEditReply(interaction, {
                    content: '❌ Failed to get the ticket metadata (this channel may not be a valid ticket).'
                });
            }

            // v3.9.38 FIX (FIX 2b, layer 2): re-check isCompleted under the lock —
            // another admin may have completed this ticket between the modal
            // opening and being submitted. Without the re-check, the invoice +
            // stats + role get sent TWICE.
            if (resolveTicketType(meta).isCompleted) {
                return safeEditReply(interaction, {
                    content: 'ℹ️ This ticket has already been processed by another admin.'
                });
            }

            // v3.9.38 FIX (FIX 3b): resolve the product from the META (stable
            // productValue first, label fallback) — rename-proof. Last fallback is
            // the value in the customId (legacy v3.9.27 behavior).
            const product = resolveProduct(config, meta) || config.products.find(p => p.value === productValue);
            if (!product) {
                return safeEditReply(interaction, {
                    content: `❌ Product value \`${productValue}\` not found (it may have been deleted). Check /list-products.`
                });
            }

            const guild = interaction.guild;
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
                return safeEditReply(interaction, { content: `❌ Member <@${userId}> is no longer on the server.` });
            }

            // === 1. Auto-role (if set) — schedule BEFORE add (the v3.9.17 pattern) ===
            let roleInfo = null;
            let expireInfo = null;
            if (product.roleId) {
                const role = guild.roles.cache.get(product.roleId);
                if (!role) {
                    return safeEditReply(interaction, {
                        content: `❌ Role ID \`${product.roleId}\` not found in the guild. Check /set-product-role.`
                    });
                }
                if ((product.days || 0) > 0) {
                    try {
                        scheduleRoleRemoval({
                            userId: member.id,
                            roleId: role.id,
                            guildId: guild.id,
                            days: product.days,
                            productName: product.label
                        });
                    } catch (schedErr) {
                        console.error(
                            `⚠️ Failed to scheduleRoleRemoval during deliver order (the role was NOT granted): ${schedErr.message}`
                        );
                        return safeEditReply(interaction, {
                            content: `❌ Failed to schedule the role auto-expire: ${schedErr.message}\n\nThe role has not been granted. Try again or contact the dev.`
                        });
                    }
                }
                try {
                    if (!member.roles.cache.has(role.id)) {
                        await member.roles.add(role);
                    }
                    roleInfo = role.name;
                    expireInfo = (product.days || 0) > 0 ? `in ${product.days} days` : 'permanent';
                } catch (roleErr) {
                    console.error('Failed to add the role during deliver order:', roleErr.message);
                    return safeEditReply(interaction, {
                        content: `❌ Failed to grant the role ${role}. Make sure the bot's role is ABOVE that role.\n\nTry Deliver Order again, or add the role manually.`
                    });
                }
            }

            // === 2. DM the order details to the buyer ===
            // The details are sent AS-IS (no sanitization) — they can be a password;
            // altering the content would break the buyer's credentials.
            let dmSent = false;
            try {
                await member.send({
                    content:
                        `Hi ${member.user.username}! Your order has been delivered 🎉\n\n` +
                        `📦 Product: ${product.label}\n` +
                        `🌐 Server: ${guild.name}\n\n` +
                        `📋 ORDER DETAILS:\n${details}\n\n` +
                        (roleInfo ? `🎭 Role: ${roleInfo}\n⏰ Expires: ${expireInfo}\n\n` : '') +
                        `💡 Keep these details safe. If there's a problem with the order, contact an admin.`
                });
                dmSent = true;
            } catch (_dmErr) {
                console.log(`ℹ️ Could not send a DM to ${member.user.tag} (DMs may be closed).`);
            }

            // === 3. Invoice to the invoice channel ===
            let invoiceOk = false;
            try {
                invoiceOk = await sendInvoice(interaction.channel, userId, product.label, price, interaction.user);
            } catch (invoiceErr) {
                console.warn(`⚠️ Failed to send the invoice during deliver order (the order is still recorded): ${invoiceErr.message}`);
            }

            // === 4. Track the purchase for stats/leaderboard ===
            // Before v3.9.27: only recorded via Set Key — sales of non-key products
            // (ML accounts, services) NEVER made it into stats/leaderboard.
            try {
                recordPurchase(guild.id, userId, parsePrice(price));
            } catch (_) {}

            // === 5. Audit log ===
            try {
                await logAudit(interaction.client, {
                    action: 'ORDER_DELIVERED',
                    actorId: interaction.user.id,
                    actorTag: interaction.user.tag,
                    details: `Deliver order (ticket) for <@${member.id}> — product: **${product.label}**${roleInfo ? `, role: ${roleInfo}` : ''}`,
                    guildId: interaction.guild.id
                });
            } catch (_) {}

            // === 6. Reply to the admin ===
            try {
                await safeEditReply(interaction, {
                    content:
                        `✅ Order delivered!\n\n👤 Member: <@${userId}>\n📦 Product: ${product.label}\n` +
                        (roleInfo ? `🎭 Role: ${roleInfo}\n` : '') +
                        `${invoiceOk ? '🧾 Invoice sent.\n' : ''}` +
                        (dmSent ? '📬 DM sent.' : '⚠️ DM failed — send the details to the member manually (check the ticket chat).')
                });
            } catch (_) {}

            // === 7. Patch meta: isCompleted + anti double-invoice ===
            try {
                patchTicketMeta(interaction.channel.id, {
                    isCompleted: true,
                    deliveredAt: Date.now(),
                    deliveredBy: interaction.user.id,
                    ...(invoiceOk ? { isInvoiceSent: true } : {})
                });
            } catch (patchErr) {
                console.warn('⚠️ Failed to patch meta (isCompleted):', patchErr.message);
            }

            // === 8. Channel notice for the buyer ===
            try {
                const noticeMsg = dmSent
                    ? `Hi <@${userId}>! 📦 Your order details have been sent via DM, check it 📬`
                    : `⚠️ <@${userId}> — failed to send a DM (DMs may be closed). An admin will send you the order details manually.`;
                await interaction.channel.send({ content: noticeMsg });
            } catch (sendErr) {
                console.warn('⚠️ Failed to send the "order delivered" notice to the channel:', sendErr.message);
            }

            console.log(
                `✅ Deliver Order successful: ${member.user.tag} | product=${product.label} | role=${roleInfo || '-'} | dm=${dmSent} | invoice=${invoiceOk} | channel NOT deleted (waiting for an admin to close manually)`
            );
            return;
        } finally {
            // v3.9.38 FIX (FIX 2c): make sure the lock is released even if the handler throws.
            if (lockChId) completionLocks.delete(lockChId);
        }
    }
};

/**
 * v3.9.27: "✅ Order Successful" side effects for non-key transactions closed
 * WITHOUT going through 📦 Deliver Order: auto-role + stats + mark isCompleted.
 * Called from ticket_close_success BEFORE closeTicket (the invoice is handled
 * by closeTicket). Non-blocking per step — issues are collected as warnings,
 * the ticket is still closed (the admin's intent is clear; the role can be
 * added manually).
 *
 * @param {Interaction} interaction - the ticket_close_success button interaction
 * @param {Object} meta - ticket metadata (from tickets.json)
 * @returns {Promise<string[]>} list of issues (empty = everything went smoothly)
 */
async function completeNonKeyOrder(interaction, meta) {
    const warnings = [];
    const config = getConfig();
    const userId = meta?.userId;

    // 1. Auto-role (if the product has a roleId — the /set-product-role promise).
    // v3.9.38 FIX (FIX 3b): use resolveProduct() — lookup by productValue in
    // the meta (stable, rename-proof), label fallback for legacy tickets.
    const product = resolveProduct(config, meta);
    if (product && product.roleId) {
        try {
            const guild = interaction.guild;
            const member = userId ? await guild.members.fetch(userId).catch(() => null) : null;
            const role = guild.roles.cache.get(product.roleId);
            if (!member) {
                warnings.push(`member <@${userId}> has left — role **${product.label}** not granted`);
            } else if (!role) {
                warnings.push(`role ID \`${product.roleId}\` (product **${product.label}**) not found in the guild`);
            } else {
                if ((product.days || 0) > 0) {
                    try {
                        scheduleRoleRemoval({
                            userId: member.id,
                            roleId: role.id,
                            guildId: guild.id,
                            days: product.days,
                            productName: product.label
                        });
                    } catch (schedErr) {
                        warnings.push(`failed to schedule the auto-expire of role ${role.name}: ${schedErr.message}`);
                    }
                }
                try {
                    if (!member.roles.cache.has(role.id)) {
                        await member.roles.add(role);
                    }
                } catch (roleErr) {
                    warnings.push(`failed to grant the role ${role.name}: ${roleErr.message} (add it manually)`);
                }
            }
        } catch (err) {
            warnings.push(`failed to process the auto-role: ${err.message}`);
        }
    } else if (product && !product.roleId) {
        // Product without an auto-role — not an issue, it simply isn't set.
    } else {
        warnings.push(`product "${meta?.productName}" not found in the config — auto-role not processed`);
    }

    // 2. Record the purchase to stats/leaderboard (previously only via Set Key).
    try {
        recordPurchase(interaction.guild.id, userId, parsePrice(meta?.price));
    } catch (_) {}

    // 3. Mark isCompleted — prevents duplicate side effects + the transcript records success.
    // (The invoice is NOT flagged here — closeTicket sends it.)
    try {
        patchTicketMeta(interaction.channel.id, {
            isCompleted: true,
            completedAt: Date.now(),
            completedBy: interaction.user.id
        });
    } catch (patchErr) {
        console.warn('⚠️ Failed to patch meta (isCompleted) during Order Successful:', patchErr.message);
    }

    return warnings;
}
