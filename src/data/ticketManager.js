const {
    ChannelType,
    PermissionFlagsBits,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder
} = require('discord.js');
const { getConfig } = require('./configManager');
// v3.9.32: check for an active escrow deal — a user still involved in an escrow
// deal may not open a regular ticket (prevents bypassing the escrow flow via a regular ticket).
const { hasActiveDealFor } = require('./midmanManager');
const { safeEditReply } = require('../infra/safeReply');
const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

// P2-2 FIX: per-user lock so a user can't open 2 tickets simultaneously (race condition).
// Before: 2 button clicks <100ms apart → both interactions passed the existing-ticket
// check (channel not created yet) → 2 tickets created. Now: lock per userId until done.
//
// v3.9.8 FIX: the lock is scoped per `${guildId}:${userId}`. Before, the key was only `userId`,
// so a user in 2 guilds of the bot couldn't create a ticket in both guilds at the same time.
const ticketLocks = new Map();

// FIX v3.7.1: per-channel close lock — prevents a double-close race condition.
// Scenario: admin clicks "Close Ticket" → network is slow → admin clicks again →
// 2 closeTicket calls run concurrently → one of them gets "Unknown Channel".
// This lock ensures only 1 closeTicket per channel at a time.
const closeTicketLocks = new Set();

// === v3.9.1: tickets.json — persistent ticket metadata ===
// Previously, ticket metadata (userId, productName, price) was stored in the channel
// topic with the format "Ticket UserID: 123 | Product: Foo | Price: Rp 50.000".
// Problems:
//   1. A channel topic can be edited by admins → metadata could break / be spoofed.
//   2. Channel topics are limited to 1024 chars — could get truncated with long product names.
//   3. Regex parsing is prone to false positives if a product name contains " | ".
//
// Now: primary metadata lives in tickets.json (keyed by channelId). The channel
// topic is still set for human-readable info, but it is not used as the
// source of truth. Backward compat: if channelId is not in tickets.json,
// fall back to topic parsing (for old tickets created before v3.9.1).
const ticketsPath = path.join(__dirname, '..', '..', 'data', 'tickets.json');

function loadTickets() {
    try {
        if (!fs.existsSync(ticketsPath)) return {};
        return JSON.parse(fs.readFileSync(ticketsPath, 'utf8'));
    } catch (err) {
        console.warn('⚠️ tickets.json is corrupted:', err.message);
        // v3.9.26: quarantine the corrupt file before falling back (see safeWrite.js).
        quarantineCorruptFile(ticketsPath);
        return {};
    }
}

function saveTickets(data) {
    safeWriteJSON(ticketsPath, data);
}

/**
 * v3.9.27: Classify ticket type from metadata — ONE source of truth.
 *
 * BEFORE (bug v3.9.16–v3.9.26): the close & invoice handlers used
 * `meta.requiresKey` as a proxy for "is this a transaction?". As a result, NON-KEY
 * products (ML account sales, services, etc — requiresKey=false) were treated as support tickets:
 *   - the close button used the help style (no "Order Successful")
 *   - invoice/testimonial was never sent
 *   - purchase stats were not recorded
 *
 * NOW: `isTransaction` (is it a sales ticket?) and `requiresKey` (does the
 * product use a key?) are two SEPARATE concepts:
 *   - Transaction + requiresKey=true  → 🔑 Set Key button (key products)
 *   - Transaction + requiresKey=false → 📦 Deliver Order button (accounts/services)
 *   - Support (help/report/custom without a product) → no special buttons
 *
 * Source priority:
 *   1. explicit meta.isTransaction (tickets created v3.9.27+)
 *   2. meta.requiresKey (legacy tickets v3.9.16–26 — old behavior kept
 *      to avoid regressions; old tickets will be closed over time)
 *   3. Category + magic-string (ancient tickets pre-v3.9.11, without requiresKey)
 *
 * @param {Object|null} meta - ticket metadata from tickets.json
 * @returns {{isTransaction: boolean, requiresKey: boolean, isCompleted: boolean}}
 */
function resolveTicketType(meta) {
    if (!meta) return { isTransaction: false, requiresKey: false, isCompleted: false };

    const isCompleted = meta.isCompleted === true;

    let isTransaction;
    if (meta.isTransaction !== undefined && meta.isTransaction !== null) {
        // v3.9.27+: explicit flag — the source of truth.
        isTransaction = meta.isTransaction === true;
    } else if (meta.requiresKey !== undefined && meta.requiresKey !== null) {
        // Legacy v3.9.16–26: requiresKey used as a proxy (the old bug is kept
        // for tickets still open — no regression).
        isTransaction = meta.requiresKey === true;
    } else {
        // Ancient tickets (pre-v3.9.11): fall back to category + magic-string.
        isTransaction = !(
            meta.category === 'help' ||
            meta.category === 'report' ||
            meta.productName === 'Bantuan Staff' ||
            meta.productName === 'Laporkan Member' ||
            meta.productName === 'Bantuan/Lapor'
        );
    }

    const requiresKey = meta.requiresKey !== undefined && meta.requiresKey !== null ? meta.requiresKey : isTransaction;

    return { isTransaction, requiresKey, isCompleted };
}

/**
 * Store new ticket metadata.
 * @param {string} channelId
 * @param {Object} meta - { userId, productName, price, guildId, createdAt, category?, requiresKey?, deliveryFields? }
 */
function setTicketMeta(channelId, meta) {
    const all = loadTickets();
    all[channelId] = {
        userId: meta.userId,
        productName: meta.productName,
        // v3.9.38 FIX (FIX 3): productValue = the product's stable ID (rename-proof).
        // null for old tickets / synthetic products from a category without products.
        productValue: meta.productValue || null,
        price: meta.price,
        guildId: meta.guildId,
        createdAt: meta.createdAt || Date.now(),
        // v3.9.11 Phase 2: store category for dispatch in the interaction handler.
        category: meta.category || null,
        // v3.9.11 Phase 2: requiresKey flag (if true, the ticket shows a Set Key button).
        requiresKey: meta.requiresKey !== undefined ? meta.requiresKey : null,
        // v3.9.11 Phase 3: deliveryFields — the data the user filled in the modal form.
        deliveryFields: meta.deliveryFields || null,
        // v3.9.20: flag that Set Key has been performed. Used by ticket_close
        // to show the "Done" button (instead of "No Longer Buying") because
        // the transaction already succeeded. Also used so the transcript records
        // the success status when an admin closes a ticket that already had Set Key.
        isCompleted: meta.isCompleted || false,
        keySetAt: meta.keySetAt || null,
        keySetBy: meta.keySetBy || null,
        // v3.9.27: EXPLICIT isTransaction — separated from requiresKey.
        // true  = sales ticket (key OR non-key product: accounts, services, etc)
        // false = support ticket (help/report/category without a product)
        isTransaction: meta.isTransaction !== undefined ? meta.isTransaction : null,
        // v3.9.27: anti-double invoice — checked at close so a key
        // transaction (invoice sent at Set Key) isn't sent AGAIN at close.
        isInvoiceSent: meta.isInvoiceSent || false,
        // v3.9.27: trail of "Deliver Order" (non-key product) — mirrors keySetAt/By.
        deliveredAt: meta.deliveredAt || null,
        deliveredBy: meta.deliveredBy || null
    };
    saveTickets(all);
}

/**
 * Get ticket metadata by channelId. Falls back to topic parsing if absent
 * (for old tickets created before v3.9.1).
 */
function getTicketMeta(channelId, topicFallback) {
    const all = loadTickets();
    if (all[channelId]) return all[channelId];

    // Backward compat: parse from the channel topic (old tickets).
    if (topicFallback) {
        const userIdMatch = topicFallback.match(/UserID: (\d+)/);
        const productMatch = topicFallback.match(/Product:\s*([^|]+?)\s*\|/);
        const priceMatch = topicFallback.match(/Price:\s*(.+)$/);
        if (userIdMatch) {
            return {
                userId: userIdMatch[1],
                productName: productMatch ? productMatch[1].trim() : 'Unknown',
                price: priceMatch ? priceMatch[1].trim() : 'Unknown',
                guildId: null,
                createdAt: null,
                _legacy: true
            };
        }
    }
    return null;
}

/**
 * Delete ticket metadata (called when the ticket is closed).
 */
function removeTicketMeta(channelId) {
    const all = loadTickets();
    if (!all[channelId]) return false;
    delete all[channelId];
    saveTickets(all);
    return true;
}

/**
 * v3.9.20: Patch (partial update) ticket metadata — doesn't overwrite other fields.
 * Used on successful Set Key: updates isCompleted=true, keySetAt, keySetBy
 * without having to re-set every field (userId, productName, etc).
 */
function patchTicketMeta(channelId, patch) {
    const all = loadTickets();
    if (!all[channelId]) return false;
    all[channelId] = { ...all[channelId], ...patch };
    saveTickets(all);
    return true;
}

/**
 * v3.9.28: Classify a product → ticket type (pure function, extracted from
 * createTicket so it can be unit-tested — answers "is it safe to add a new
 * category like akun_ml / lisensi_key?").
 *
 * Classification rules (BACKWARD-COMPATIBLE — old createTicket behavior):
 *   - isTransaction = FALSE only for an explicit help/report product:
 *       product.isHelp === true, OR category === 'help' / 'report'
 *   - ALL other categories (transaction, akun_ml, lisensi_key, jasa, any
 *     custom) → isTransaction = true → goes to 🎫 TRANSACTIONS, not Support.
 *   - requiresKey: use the product flag if present; otherwise default =
 *     isTransaction (a transaction product without a flag is assumed to use a key).
 *
 * Meaning: adding a NEW category requires no code changes at all —
 * classification is automatically correct as long as the category id isn't 'help'/'report'.
 *
 * @param {Object} product - product object from config.products (or a
 *   synthetic object from a category without products: { label, isHelp: true, category })
 * @returns {{isTransaction: boolean, requiresKey: boolean}}
 */
function classifyProduct(product) {
    if (!product) return { isTransaction: false, requiresKey: false };
    const isTransaction = !(product.isHelp === true || product.category === 'help' || product.category === 'report');
    const requiresKey = product.requiresKey !== undefined ? product.requiresKey : isTransaction;
    return { isTransaction, requiresKey };
}

/**
 * v3.9.32: find a user's active ticket (from tickets.json — the source of truth).
 * Extracted from createTicket so escrow deals can use it too
 * (interactions/midman.js: a buyer must not have an active ticket & deal
 * at the same time — one active channel per user policy).
 *
 * Includes self-healing: zombie metadata (channel no longer exists) is removed.
 *
 * @param {Guild} guild
 * @param {string} userId
 * @returns {Promise<GuildChannel|null>} the active ticket channel, or null.
 */
async function findActiveTicketFor(guild, userId) {
    const ticketsData = loadTickets();
    for (const [chId, meta] of Object.entries(ticketsData)) {
        if (meta.userId === userId && meta.guildId === guild.id) {
            const ch = guild.channels.cache.get(chId);
            if (ch) return ch;
            // v3.9.8: channel not cached, but metadata exists. Fetch from the API —
            // if it's really gone, clean up the zombie metadata.
            // v3.9.38 FIX: guild.channels.fetch THROWS on Unknown Channel
            // (10003), it doesn't return null. The old `.catch(() => null)` pattern turned
            // ALL errors (429 rate-limit, 5xx, network blip) into null → still-LIVE ticket
            // metadata got deleted too → the user could open a 2nd ticket and the
            // invoice/completion guards were lost. Now it mirrors the reconcileZombieDeals
            // pattern (services/schedulerTasks.js): only 10003 counts as a channel
            // truly deleted; other errors = transient, metadata is kept.
            //
            // v3.9.40 FIX: transient errors now THROW (code
            // TICKET_VERIFY_TRANSIENT) instead of falling through to return null.
            // Before: the metadata was correctly kept on disk, BUT the function
            // still returned null → createTicket / escrow deal validation read
            // "no active ticket" → a SECOND ticket/channel was created for the
            // same user — 2 live metas, the invoice/completion guards split
            // across 2 channels. Callers (createTicket + midman pick buyer/seller)
            // catch this error and ask the user to retry in a few seconds.
            try {
                const fetched = await guild.channels.fetch(chId);
                if (fetched) return fetched;
            } catch (err) {
                // 10003 = Unknown Channel — the channel is truly deleted.
                if (err?.code === 10003) {
                    removeTicketMeta(chId);
                } else {
                    // Other errors (5xx/network/rate-limit) = TRANSIENT — don't
                    // delete the meta and don't treat it as "no ticket": THROW so
                    // the caller knows verification FAILED and can abort safely.
                    console.warn(`⚠️ Failed to fetch ticket channel ${chId} (transient): ${err?.message ?? err}`);
                    const ex = new Error(
                        `Failed to verify active ticket for user ${userId} (transient: ${err?.message ?? err})`
                    );
                    ex.code = 'TICKET_VERIFY_TRANSIENT';
                    throw ex;
                }
            }
        }
    }
    return null;
}

/**
 * Create a new ticket channel.
 * Transaction tickets show "Set Key" + "Close Ticket" buttons.
 * Help/report tickets show only a "Close Ticket" button.
 */
async function createTicket(interaction, product) {
    const guild = interaction.guild;
    const user = interaction.user;
    const config = getConfig();

    // P2-2 FIX: check the lock first — if creation is already in progress, reject.
    // v3.9.8: the lock is scoped per guild so users in a multi-guild bot don't block each other.
    const lockKey = `${guild.id}:${user.id}`;
    if (ticketLocks.has(lockKey)) {
        return interaction.editReply({ content: '⏳ Your ticket is already being created, please wait a moment...' }).catch(() => {});
    }
    ticketLocks.set(lockKey, true);

    try {
        // Check whether the user already has an active ticket.
        // v3.9.1: check tickets.json (source of truth), fall back to a topic scan
        // for old tickets created before v3.9.1.
        //
        // v3.9.8 FIX:
        //   1. Use tickets.json metadata as the source of truth — even if the
        //      channel isn't cached (bot just started), it still counts as active.
        //      Before, a `cache.get(chId)` miss → duplicate ticket for the same user.
        //   2. Fix the `startsWith` false-positive — added a ` |` separator so a
        //      user ID that is a prefix of another user ID can't false-match.
        // v3.9.32: the tickets.json loop below is extracted into findActiveTicketFor()
        //      (reused by escrow deals) — identical behavior.
        let existingTicket;
        try {
            existingTicket = await findActiveTicketFor(guild, user.id);
        } catch (verifyErr) {
            // v3.9.40 FIX: active-ticket verification FAILED (429/5xx/network) —
            // do NOT continue creating a ticket (the old null return created a
            // duplicate ticket for users with a live one). Abort + ask to retry.
            if (verifyErr?.code === 'TICKET_VERIFY_TRANSIENT') {
                return safeEditReply(interaction, {
                    content: '⚠️ Could not verify your active ticket (the Discord network is busy right now). Please try again in a few seconds.'
                });
            }
            throw verifyErr;
        }
        // Fallback: scan channel topics (old tickets)
        if (!existingTicket) {
            // v3.9.8: added ` |` so an ID that is a prefix of another ID can't false-match.
            existingTicket = guild.channels.cache.find(
                c => c.topic && c.topic.startsWith(`Ticket UserID: ${user.id} |`)
            );
        }
        if (existingTicket) {
            return safeEditReply(interaction, { content: `❌ You already have an active ticket in ${existingTicket}!` });
        }

        // v3.9.32: a user still involved in an active escrow deal (as buyer OR
        // seller) may not open a regular ticket — prevents bypassing the escrow
        // flow via a regular ticket (the deal must be resolved first).
        if (hasActiveDealFor(guild.id, user.id)) {
            return safeEditReply(interaction, {
                content: '❌ You still have an **active escrow deal**. Finish your deal first before opening a new ticket.'
            });
        }

        // The admin role must be set first
        if (!config.roles.admin) {
            return safeEditReply(interaction, {
                content: '❌ The Admin role is not set yet. Use `/set-role admin @role` first.'
            });
        }

        // v3.9.11 Phase 1: removed the 'Bantuan/Lapor' magic string.
        // Uses the `category` field on the product (Phase 2) or the `isHelp: true` flag fallback.
        // v3.9.28: logic extracted into classifyProduct() (pure, testable) —
        // identical behavior. Every category other than help/report (including any
        // NEW category: akun_ml, lisensi_key, jasa, ...) is automatically treated as a transaction.
        const { isTransaction, requiresKey } = classifyProduct(product);

        // v3.9.16: Channel categories are split by TICKET TYPE (transaction vs support),
        // NOT by whether a key is used. So:
        // - isTransaction=true  → "🎫 TRANSACTIONS" (key or not — both are transactions)
        // - isTransaction=false → "🎫 SUPPORT"      (help/report)
        //
        // The Set Key button is checked separately via requiresKey:
        // - requiresKey=true  → the Set Key button appears
        // - requiresKey=false → no Set Key button (only Close Ticket)
        //
        // Example cases:
        //   - Product "VIP 30 Hari" (requiresKey=true) → 🎫 TRANSACTIONS + Set Key button
        //   - Product "Jasa Joki" (requiresKey=false)  → 🎫 TRANSACTIONS + no Set Key (Close only)
        //   - Help / Report                          → 🎫 SUPPORT + no Set Key
        const transactionCategoryName = config.ticketCategoryKey || '🎫 TRANSACTIONS';
        const helpCategoryName = config.ticketCategoryNoKey || '🎫 SUPPORT';
        const targetCategoryName = isTransaction ? transactionCategoryName : helpCategoryName;

        // Find the target category. If it doesn't exist, create it.
        let category = guild.channels.cache.find(
            c => c.name === targetCategoryName && c.type === ChannelType.GuildCategory
        );
        if (!category) {
            try {
                category = await guild.channels.create({
                    name: targetCategoryName,
                    type: ChannelType.GuildCategory
                });
                console.log(`📁 New ticket category created: ${targetCategoryName}`);
            } catch (catErr) {
                console.error(`Failed to create category ${targetCategoryName}:`, catErr.message);
                // Fallback: use the old "🎫 TICKETS" category if it exists (backward compat)
                category = guild.channels.cache.find(
                    c => c.name === '🎫 TICKETS' && c.type === ChannelType.GuildCategory
                );
                if (!category) {
                    throw new Error(
                        `Failed to create ticket category "${targetCategoryName}". Check the Manage Channels permission.`
                    );
                }
            }
        }

        const channelName = `ticket-${user.id}`.toLowerCase().slice(0, 50);

        const ticketChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category.id,
            // The topic is still set for human-readable info, but it's not the source of truth.
            topic: `Ticket UserID: ${user.id} | Product: ${product.label} | Price: ${product.price}`,
            permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                {
                    id: user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AttachFiles
                    ]
                },
                {
                    id: config.roles.admin,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.ManageMessages
                    ]
                },
                {
                    id: guild.client.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.EmbedLinks,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.ManageChannels
                    ]
                }
            ]
        });

        // v3.9.1: save ticket metadata to tickets.json (source of truth).
        // v3.9.11 Phase 2: save category & requiresKey too.
        // v3.9.27: save EXPLICIT isTransaction — the close flow & invoice no
        // longer misclassify non-key products (accounts/services) as support tickets.
        // v3.9.38 FIX (FIX 3): save productValue (stable ID) ALONGSIDE
        // productName (label — still stored for display & backward compat).
        // Before, meta only stored the label → an admin renaming a product via
        // /update-product made the product lookup miss for all active tickets
        // ("Product not found"), and duplicate labels resolved to the wrong product.
        setTicketMeta(ticketChannel.id, {
            userId: user.id,
            productName: product.label,
            productValue: product.value || null,
            price: product.price,
            guildId: guild.id,
            createdAt: Date.now(),
            category: product.category || (isTransaction ? 'transaction' : 'help'),
            requiresKey,
            isTransaction
        });

        // v3.9.16: The embed message uses isTransaction (transaction vs support).
        // The Set Key button uses requiresKey (uses a key or not).
        // So, 3 scenarios:
        //   1. Transaction + requiresKey=true  → "TRANSACTION TICKET" + Set Key + Close buttons
        //   2. Transaction + requiresKey=false → "TRANSACTION TICKET" + Close button only (services, etc)
        //   3. Help / Report                   → "SUPPORT TICKET" + Close button only
        const ticketEmbed = new EmbedBuilder()
            .setTitle(isTransaction ? '🛒 TRANSACTION TICKET' : '🎫 SUPPORT TICKET')
            .setDescription(
                `Hello <@${user.id}>!\n\n` +
                    (isTransaction
                        ? `You ordered the **${product.label}** package for **${product.price}**.\n\n` +
                          `Please make the payment and send your payment proof here.\n` +
                          `An admin <@&${config.roles.admin}> will process your order.\n\n` +
                          (requiresKey
                              ? `💡 Once your payment is confirmed, an admin clicks the **🔑 Set Key** button to give you the key + role.`
                              : `💡 Once your payment is confirmed, an admin clicks the **📦 Deliver Order** button — the order details will be sent to you via DM.`)
                        : `Please describe what you need in this channel.\n` +
                          `An admin <@&${config.roles.admin}> will assist you shortly.`)
            )
            .setColor(isTransaction ? 0x3498db : 0xe67e22)
            .addFields(
                isTransaction
                    ? [
                          {
                              name: '📦 Product',
                              value: `${product.label}${product.duration ? ` (${product.duration})` : ''}`,
                              inline: true
                          },
                          { name: '💰 Price', value: product.price, inline: true }
                      ]
                    : [{ name: '📋 Type', value: product.label, inline: false }]
            )
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();

        // Buttons: Set Key (key) / Deliver Order (non-key) + Close Ticket.
        // v3.9.27: NON-KEY transaction products (accounts, services, etc) get a
        // "Deliver Order" button — mirror of Set Key: the admin fills in the order
        // details in a modal, the bot DMs the buyer + auto-role + stats + invoice. Before,
        // non-key products only had Close Ticket, so the order details only lived
        // in the ticket chat which gets DELETED at close — the buyer lost their data.
        const components = [];
        if (requiresKey) {
            components.push(
                new ButtonBuilder()
                    .setCustomId('ticket_set_key')
                    .setLabel('Set Key')
                    .setEmoji('🔑')
                    .setStyle(ButtonStyle.Success)
            );
        } else if (isTransaction) {
            components.push(
                new ButtonBuilder()
                    .setCustomId('ticket_deliver')
                    .setLabel('Deliver Order')
                    .setEmoji('📦')
                    .setStyle(ButtonStyle.Success)
            );
        }
        components.push(
            new ButtonBuilder()
                .setCustomId('ticket_close')
                .setLabel('Close Ticket')
                .setEmoji('🔒')
                .setStyle(ButtonStyle.Danger)
        );
        const closeRow = new ActionRowBuilder().addComponents(...components);

        await ticketChannel.send({
            content: `<@&${config.roles.admin}> | <@${user.id}>`,
            embeds: [ticketEmbed],
            components: [closeRow]
        });
        await safeEditReply(interaction, { content: `✅ Ticket created successfully: ${ticketChannel}` });
    } catch (err) {
        console.error('Error creating ticket:', err);
        await interaction.editReply({ content: '❌ An error occurred while creating the ticket. Check the bot permissions!' }).catch(() => {});
    } finally {
        // P2-2 FIX: make sure the lock is released even on error.
        // v3.9.8: use the guild-scoped lockKey.
        ticketLocks.delete(`${guild.id}:${user.id}`);
    }
}

/**
 * Send an invoice to the invoice channel (testimonial).
 * Used by the Set Key flow & closeTicket.
 */
async function sendInvoice(channel, userId, productName, price, closer) {
    const config = getConfig();
    if (!config.channels.invoice) return false;
    // v3.9.11 Phase 1: removed the 'Bantuan/Lapor' magic string.
    // Now: send an invoice for all transaction products (not help/report).
    // The caller is responsible for skipping sendInvoice for non-transaction tickets.
    if (!productName || productName === 'Unknown') return false;

    const invoiceChannel = channel.guild.channels.cache.get(config.channels.invoice);
    if (!invoiceChannel) return false;

    const orderId = `INV-${Date.now().toString().slice(-6)}`;
    const invoiceEmbed = new EmbedBuilder()
        .setTitle('🧾 TRANSACTION PROOF / TESTIMONIAL')
        .setColor(0x2ecc71)
        .addFields(
            { name: '🆔 Order ID', value: orderId, inline: false },
            { name: '👤 Buyer', value: `<@${userId}>`, inline: false },
            { name: '📦 Product', value: productName, inline: true },
            { name: '💰 Price', value: price, inline: true },
            { name: '🕒 Date', value: new Date().toLocaleString('en-US'), inline: false }
        )
        .setFooter({ text: `Processed by ${closer.tag}`, iconURL: closer.displayAvatarURL({ dynamic: true }) })
        .setTimestamp();

    await invoiceChannel.send({ content: `✅ Successful transaction by <@${userId}>!`, embeds: [invoiceEmbed] });
    return true;
}

/**
 * v3.9.38 FIX (FIX 3): ONE product lookup helper from ticket meta.
 *
 * Meta has stored the label (productName) since v3.9.1 — a label can be renamed
 * by an admin ("VIP 30 Hari" → "VIP 1 Bulan") → lookup by label misses. Since
 * v3.9.38 meta also stores productValue (stable ID). Priority:
 *   1. by value: p.value === (meta.productValue || meta.productName)
 *      (meta.productName is used as the value-query first so legacy tickets
 *      that happen to store a value still match — v3.9.26 pattern)
 *   2. by label: p.label === meta.productName (legacy tickets, fallback)
 *   3. null (product deleted → the caller uses meta.productName for display)
 *
 * @param {Object} config - bot config (config.products)
 * @param {Object|null} meta - ticket metadata from tickets.json
 * @returns {Object|null} the product object from config, or null
 */
function resolveProduct(config, meta) {
    if (!meta) return null;
    const products = config?.products || [];
    return (
        products.find(p => p.value === (meta.productValue || meta.productName)) ||
        products.find(p => p.label === meta.productName) ||
        null
    );
}

/**
 * v3.9.11 Phase 3: Save the ticket transcript to the transcript channel.
 *
 * Fetches all messages in the ticket channel, formats them as text, and sends them
 * to the transcript channel set via /set-channel type:transcript (v3.9.30,
 * previously a separate command /set-transcript-channel).
 *
 * Discord limit: 1 message = 2000 chars. If the transcript is > 2000 chars,
 * split it into multiple messages.
 *
 * @param {Channel} ticketChannel - the ticket channel being closed
 * @param {Object} meta - ticket metadata from tickets.json
 * @param {User} closer - the admin closing the ticket
 * @param {boolean} isSuccess - true if the transaction succeeded
 */
async function saveTranscript(ticketChannel, meta, closer, isSuccess) {
    const config = getConfig();
    const transcriptChannelId = config.channels?.transcript;
    if (!transcriptChannelId) return false;

    const transcriptChannel = ticketChannel.guild?.channels?.cache?.get(transcriptChannelId);
    if (!transcriptChannel) return false;

    // v3.9.38 FIX (FIX 7): fetch ALL messages paginated, not just the last 100.
    // Payment proof is sent at the START of a ticket — with a 100-message limit,
    // long-ticket transcripts lost the early messages, precisely the most
    // important ones. Loop using `before: <oldestId>` until an empty/partial page,
    // with a hard cap MAX_TRANSCRIPT_MESSAGES to protect the rate limit.
    // (The API returns batches newest→oldest; snowflake IDs increase over
    // time, so the SMALLEST id in a batch = the oldest message = the `before` cursor.)
    const MAX_TRANSCRIPT_MESSAGES = 1000;
    const collected = [];
    let capped = false;
    let messages;
    try {
        let oldestId = null;
        for (;;) {
            const fetchOpts = { limit: 100 };
            if (oldestId) fetchOpts.before = oldestId;
            const batch = await ticketChannel.messages.fetch(fetchOpts);
            if (batch.size === 0) break;
            for (const m of batch.values()) collected.push(m);
            for (const id of batch.keys()) {
                if (oldestId === null || BigInt(id) < BigInt(oldestId)) oldestId = id;
            }
            if (batch.size < 100) break; // last page — no older messages
            if (collected.length >= MAX_TRANSCRIPT_MESSAGES) {
                capped = true; // older messages remain, but the cap is reached
                break;
            }
        }
        messages = collected;
    } catch (err) {
        console.warn(`⚠️ Failed to fetch messages for transcript: ${err.message}`);
        return false;
    }

    // Sort oldest-first so the transcript reads chronologically
    const sorted = [...messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    // Build transcript text
    const lines = [];
    lines.push(`╔═══════════════════════════════════════════`);
    lines.push(`║ 🎫 TICKET TRANSCRIPT`);
    lines.push(`╠═══════════════════════════════════════════`);
    lines.push(`║ 📌 Channel: #${ticketChannel.name} (\`${ticketChannel.id}\`)`);
    lines.push(`║ 👤 User: <@${meta?.userId || 'unknown'}> (${meta?.userId || 'unknown'})`);
    lines.push(`║ 📦 Product: ${meta?.productName || 'unknown'}`);
    lines.push(`║ 💰 Price: ${meta?.price || 'unknown'}`);
    lines.push(`║ 🏷️ Category: ${meta?.category || 'unknown'}`);
    lines.push(`║ ✅ Status: ${isSuccess ? 'Success' : 'Cancelled'}`);
    lines.push(`║ 🔒 Closed by: ${closer?.tag || 'unknown'} (\`${closer?.id || 'unknown'}\`)`);
    lines.push(`║ 📅 Created: ${meta?.createdAt ? new Date(meta.createdAt).toLocaleString('en-US') : 'unknown'}`);
    lines.push(`║ 📅 Closed: ${new Date().toLocaleString('en-US')}`);
    lines.push(`╚═══════════════════════════════════════════`);
    // v3.9.38 FIX (FIX 7): marker that the transcript was truncated by the hard cap.
    if (capped) {
        lines.push(`║ ⚠️ NOTE: this channel has more than ${MAX_TRANSCRIPT_MESSAGES} messages — only the ${MAX_TRANSCRIPT_MESSAGES} NEWEST messages were archived (rate-limit protection).`);
    }
    lines.push('');
    lines.push('--- CHAT HISTORY ---');

    for (const msg of sorted) {
        // Skip bot messages that are only panel embeds (long & not relevant)
        if (msg.author.bot && msg.embeds.length > 0 && msg.content === '') continue;

        const time = new Date(msg.createdTimestamp).toLocaleString('en-US');
        const author = msg.author?.tag || 'unknown';
        const content = msg.content || '_(embed/attachment — not shown)_';
        lines.push(`[${time}] ${author}: ${content}`);
    }

    lines.push('--- END OF TRANSCRIPT ---');

    // Send as an embed summary + multiple text chunks if needed
    const transcriptText = lines.join('\n');
    const CHUNK_SIZE = 1900; // slightly below 2000 for safety

    const embed = new EmbedBuilder()
        .setTitle(`🎫 Ticket Transcript — ${meta?.productName || 'Unknown'}`)
        .setColor(isSuccess ? 0x57f287 : 0xed4245)
        .addFields(
            { name: '👤 User', value: `<@${meta?.userId || 'unknown'}>`, inline: true },
            { name: '📦 Product', value: meta?.productName || 'unknown', inline: true },
            { name: '💰 Price', value: meta?.price || 'unknown', inline: true },
            { name: '🏷️ Category', value: meta?.category || 'unknown', inline: true },
            { name: '🔒 Closed by', value: closer?.tag || 'unknown', inline: true },
            { name: '✅ Status', value: isSuccess ? 'Success' : 'Cancelled', inline: true }
        )
        .setFooter({ text: `Channel: ${ticketChannel.name} | ${new Date().toLocaleString('en-US')}` })
        .setTimestamp();

    await transcriptChannel.send({ embeds: [embed] });

    // Send the transcript text in code blocks (chunked if needed)
    const chunks = [];
    if (transcriptText.length <= CHUNK_SIZE) {
        chunks.push(transcriptText);
    } else {
        // Split per line, join until close to CHUNK_SIZE
        let current = '';
        for (const line of lines) {
            // v3.9.26 FIX: hard-split lines that are by themselves > CHUNK_SIZE. A
            // single user message can be 2000 chars → a single "line" > 1900 → a chunk
            // over the limit → send throws → the ENTIRE transcript text is lost (the
            // catch in closeTicket swallows it). Now long lines are force-split.
            let l = line;
            while (l.length > CHUNK_SIZE) {
                if (current) {
                    chunks.push(current);
                    current = '';
                }
                chunks.push(l.slice(0, CHUNK_SIZE));
                l = l.slice(CHUNK_SIZE);
            }
            // v3.9.37 FIX: `current` can be empty when a hard-split line is exactly
            // CHUNK_SIZE long → an empty chunk would be sent as a blank code
            // block. Only push when it has content.
            if ((current + '\n' + l).length > CHUNK_SIZE) {
                if (current) chunks.push(current);
                current = l;
            } else {
                current = current ? current + '\n' + l : l;
            }
        }
        if (current) chunks.push(current);
    }

    for (let i = 0; i < chunks.length; i++) {
        const header = chunks.length > 1 ? `\n[Part ${i + 1}/${chunks.length}]\n` : '';
        // v3.9.40 FIX: user message content can contain ``` → it would close
        // the transcript code fence early (the rest of the chunk renders as
        // broken markdown). Triple backticks are escaped with zero-width
        // spaces — the fence stays intact and the text remains readable.
        const safeChunk = String(chunks[i]).replace(/```/g, '`\u200b`\u200b`');
        await transcriptChannel.send({
            content: `${header}\`\`\`\n${safeChunk}\n\`\`\``
        });
    }

    return true;
}

/**
 * Close a ticket — ONLY deletes the channel + sends the invoice (if successful).
 * Role granting & key delivery are now handled by the Set Key button.
 *
 * FIX v3.7.1:
 *   - Per-channel lock prevents a double-close race condition
 *   - Treat DiscordAPIError 10003 (Unknown Channel) as success —
 *     the channel is already gone, which means the close goal is already met
 *     (maybe deleted by another admin, or a previous close succeeded but its
 *     reply timed out).
 *   - Invoice failure doesn't block the close (just log a warning)
 *
 * @param {Channel} channel - ticket channel
 * @param {User} closer - the admin closing the ticket
 * @param {boolean} isSuccess - true if the transaction succeeded (send invoice), false if cancelled
 */
async function closeTicket(channel, closer, isSuccess) {
    const channelId = channel?.id;

    // FIX v3.7.1: skip if the channel is already gone (partial/deleted)
    if (!channelId) {
        console.log('ℹ️ closeTicket called without a valid channel — skipping.');
        return;
    }

    // FIX v3.7.1: prevent double-close — if this channel is already being closed, skip.
    if (closeTicketLocks.has(channelId)) {
        console.log(`⏭️ Channel ${channelId} is already being closed, skipping double-close.`);
        return;
    }
    closeTicketLocks.add(channelId);

    try {
        // v3.9.1: read metadata from tickets.json (source of truth), fall back to
        // topic parsing for old tickets created before v3.9.1.
        const topic = channel.topic || '';
        const meta = getTicketMeta(channelId, topic);
        const userId = meta?.userId || null;
        const productName = meta?.productName || 'Unknown';
        const price = meta?.price || 'Unknown';

        // v3.9.20: if Set Key was already performed (meta.isCompleted=true),
        // treat isSuccess=true so the transcript & invoice record the success status.
        // The admin can close without clicking "Done" — the meta is what matters.
        if (meta?.isCompleted === true) {
            isSuccess = true;
        }

        // v3.9.11 Phase 3: auto-save the transcript to the transcript channel (if set).
        // Done BEFORE deleting the channel so messages can still be fetched.
        // Failure doesn't block the close — just log a warning.
        const config = getConfig();
        const transcriptChannelId = config.channels?.transcript;
        if (transcriptChannelId) {
            try {
                await saveTranscript(channel, meta, closer, isSuccess);
            } catch (transcriptErr) {
                console.warn(`⚠️ Failed to save transcript for ticket ${channelId}:`, transcriptErr.message);
            }
        }

        // Send an invoice for a successful TRANSACTION ticket (not help/report).
        // v3.9.16: bug fix — before, help/report tickets closed via "Done" also got an invoice
        // even though they weren't sales. Now the category is checked first.
        // v3.9.18: generalized — uses meta.requiresKey as the source of truth.
        //   - meta.requiresKey === false            → skip invoice (non-transaction category)
        //   - meta.requiresKey === true             → send invoice if successful
        //   - meta.requiresKey undefined (old ticket) → fall back to the category & magic-string check
        //     for backward compat with tickets created before v3.9.16.
        // v3.9.27 FIX (user-reported bug): non-key products are REAL TRANSACTIONS
        // (ML account sales, services, etc). requiresKey===false is no longer treated as
        // "support" — resolveTicketType() now reads the explicit
        // isTransaction flag. The invoice/testimonial is finally sent for
        // non-key products closed as "Order Successful".
        //
        // v3.9.27 FIX #2 (double invoice): a key transaction that already had Set Key
        // used to get the invoice TWICE (at Set Key + at close via "Done").
        // Now: the isInvoiceSent flag is checked — if the invoice was already
        // sent (Set Key / Deliver Order), close doesn't send it again.
        const ticketType = resolveTicketType(meta);
        const invoiceAlreadySent =
            meta?.isInvoiceSent === true ||
            // Legacy: a key ticket (v3.9.20–26) with isCompleted means Set Key was
            // already performed — the invoice was surely sent then (the old flow always sent it).
            (meta?.isInvoiceSent === undefined && meta?.isCompleted === true && ticketType.requiresKey === true);

        if (isSuccess && userId && ticketType.isTransaction && !invoiceAlreadySent) {
            try {
                // v3.9.38 FIX (FIX 3e): show the LATEST product label on the invoice —
                // meta stores the frozen label from when the ticket was created; resolve by
                // productValue (stable) first, fall back to the meta label if the product
                // was deleted.
                const invoiceLabel = resolveProduct(config, meta)?.label || productName;
                await sendInvoice(channel, userId, invoiceLabel, price, closer);
            } catch (invoiceErr) {
                console.warn(`⚠️ Failed to send invoice while closing ticket ${channelId}:`, invoiceErr.message);
            }
        }

        // Delete the channel
        // FIX v3.7.1: treat 10003 (Unknown Channel) as success.
        // v3.9.31 FIX: track whether the channel is REALLY gone.
        let channelGone = false;
        try {
            await channel.delete();
            channelGone = true;
        } catch (deleteErr) {
            // DiscordAPIError code 10003 = Unknown Channel — already deleted.
            // Treat as success because the close goal is already met.
            if (deleteErr.code === 10003) {
                console.log(
                    `ℹ️ Channel ${channelId} no longer exists (likely deleted by another admin or a previous close). Treating as success.`
                );
                channelGone = true;
            } else {
                // Other errors (permission, network) — log but don't crash
                console.warn(`⚠️ Failed to delete channel ${channelId}:`, deleteErr.message);
                // The channel STILL EXISTS — DO NOT delete the metadata (see guard below).
            }
        }

        // v3.9.1: remove ticket metadata from tickets.json (cleanup).
        // Done after the channel is successfully/assumed-successfully deleted so
        // there's no zombie metadata for a channel that still exists.
        //
        // v3.9.31 FIX (orphan meta): before, removeTicketMeta ALWAYS RAN
        // even when channel.delete() failed for non-10003 reasons (Missing
        // Permissions, network). Result: the channel was still alive but its meta
        // was already gone → the next close fell into the topic-parsing fallback
        // which LOSES the isCompleted/isInvoiceSent/isTransaction flags → the invoice
        // was sent twice + wrong close-button scenarios. Now: meta is only
        // deleted if the channel is truly gone. Trade-off: meta can be a
        // temporary "zombie" if delete fails — that's safe & self-healing
        // (the admin just clicks close again once the permission issue is resolved).
        if (channelGone) {
            try {
                removeTicketMeta(channelId);
            } catch (cleanupErr) {
                console.warn(`⚠️ Failed to delete ticket meta ${channelId}:`, cleanupErr.message);
            }
        } else {
            console.warn(
                `⚠️ Ticket metadata ${channelId} NOT deleted (channel still exists — delete failed). Click close again after the issue is resolved.`
            );
        }
    } catch (err) {
        // Error while parsing the topic or during another operation — log but don't crash
        console.error('Error closing ticket:', err.message);
    } finally {
        // FIX v3.7.1: make sure the lock is released even on error.
        closeTicketLocks.delete(channelId);
    }
}

module.exports = {
    createTicket,
    closeTicket,
    sendInvoice,
    saveTranscript,
    findActiveTicketFor,
    getTicketMeta,
    setTicketMeta,
    patchTicketMeta,
    removeTicketMeta,
    resolveTicketType,
    classifyProduct,
    // v3.9.38 FIX (FIX 3): product lookup helper by meta (used by ticket.js
    // + closeTicket, and the hardeningV38Ticket unit test).
    resolveProduct
};
