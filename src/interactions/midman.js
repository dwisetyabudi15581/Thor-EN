/**
 * Midman (Escrow) domain handler — all customIds related to 3-party escrow deals.
 * v3.9.34.
 *
 * CustomIds handled:
 *   - ticket_cat:midman  (button)       → open the create-deal modal (from the ticket panel)
 *   - modal_mm_create    (modal)        → validate item+price → store temporarily
 *                                        → show the BUYER selection dropdown
 *   - mm_pick_buyer      (user select)  → pick the buyer (v3.9.34 — a deal can
 *                                        be opened by anyone, so the roles are
 *                                        chosen explicitly in the form)
 *   - mm_pick_seller     (user select)  → pick the seller → create the deal
 *                                        channel + Deal Board (both searchable —
 *                                        NO need to copy IDs / mention)
 *   - mm_add_member      (button)       → midman/admin: add an extra member
 *                                        (observer) to the deal channel
 *   - mm_pick_member     (user select)  → pick the user to add
 *   - mm_remove_member   (button)       → midman/admin: remove an extra
 *                                        member from the deal channel
 *   - mm_remove_pick     (string select)→ pick the observer to remove
 *   - mm_join            (button)  → buyer & seller agree to the deal — terms
 *                                   are locked ONLY after BOTH of them agree
 *   - mm_cancel          (button)  → cancel the deal (only before funds are received)
 *   - mm_fundin          (button)  → middleman confirms funds received
 *   - mm_received        (button)  → buyer confirms goods delivered
 *   - mm_release         (button)  → middleman releases the funds → invoice + close
 *   - mm_dispute         (button)  → freeze the deal (deal participants / admin)
 *   - mm_resolve_release (button)  → admin: resolve the dispute → release funds
 *   - mm_resolve_refund  (button)  → admin: resolve the dispute → refund
 *
 * Router (src/interactions/index.js) already applies:
 *   - dedup (checkAndMark), replied/deferred guards, interaction type filter.
 *
 * Deal Board = the bot embed that is the ONE AND ONLY source of truth for
 * the deal (item, price, fee, status, who must act). The channel chat is
 * only a place for evidence (transfer screenshots, proof of delivery).
 * Every state transition:
 *   1. is checked for valid ORDER (midmanManager.canTransition)
 *   2. is checked that the ACTOR is authorized (midmanManager.actorAllowed)
 *   3. is recorded in the deal history + audit log
 *   4. updates the Deal Board (the embed is edited — users can't tamper with it)
 */

const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder,
    ChannelType,
    PermissionFlagsBits,
    // v3.9.33: seller selection dropdown (Discord's native member picker —
    // searchable, with avatars; solves "hard-to-type names / can't copy IDs").
    UserSelectMenuBuilder,
    // v3.9.34: dropdown for picking the extra member to remove
    // (string select — the options are the current observers).
    StringSelectMenuBuilder
} = require('discord.js');
const { getConfig, safeEditReply, logAudit, checkIsAdmin } = require('../commands/_shared');
const mm = require('../data/midmanManager');
const { sendInvoice, saveTranscript, findActiveTicketFor } = require('../data/ticketManager');
const { recordPurchase } = require('../data/statsManager');

// Delay before the deal channel is deleted after completion (ms) — gives
// participants time to read the history summary before the channel disappears.
const DELETE_DELAY_MS = 5000;

/**
 * v3.9.17 pattern (copied from ticket.js, same policy): if a verified role
 * is set, users must be verified before creating a deal.
 */
function passesVerifiedCheck(interaction, config) {
    if (!interaction.member?.roles?.cache) return false;
    if (!config.roles.verified) return true;
    return interaction.member.roles.cache.has(config.roles.verified);
}

// ====================================================
// === DEAL BOARD RENDER ===
// ====================================================

const STATE_DESCRIPTIONS = {
    // v3.9.34: two-party consent — the dynamic description shows who has /
    // hasn't agreed yet, so the Deal Board always makes it clear whose turn it is.
    WAITING_AGREE: deal =>
        `🛒 Buyer — ${deal.buyerAgreed ? '✅ agreed' : '⏳ **click 🤝 Agree to Deal**'}\n` +
        `🏷️ Seller — ${deal.sellerAgreed ? '✅ agreed' : '⏳ **click 🤝 Agree to Deal**'}\n` +
        'Both must agree — after that the item & price are **LOCKED** (to change them = cancel & create a new deal).\n' +
        'Cancelling now is safe (funds have not moved yet).',
    WAITING_PAYMENT: deal =>
        '**🛒 Buyer** — transfer the **Total Payment** to the middleman, then post the transfer proof in this channel.\n' +
        `💳 Total: **${mm.formatRupiah(deal.priceNum + deal.fee)}** (price ${mm.formatRupiah(deal.priceNum)} + fee ${mm.formatRupiah(deal.fee)}).\n` +
        '**🛡️ Middleman** — verify the funds have actually arrived, then click **✅ Funds Received**.\n' +
        'Only after this may the seller send the goods.',
    WAITING_DELIVERY:
        '**🏷️ Seller** — send the goods now (chat in this channel as proof).\n' +
        '**🛒 Buyer** — check the goods; once they match, click **✅ Goods Delivered**.',
    WAITING_RELEASE: deal =>
        '**🛡️ Middleman** — transfer the **FULL** amount to the seller (do NOT deduct anything), then click **💸 Release to Seller**.\n' +
        `🏷️ Seller receives: **${mm.formatRupiah(deal.priceNum)}** • 🧾 Middleman fee (left in your hands): **${mm.formatRupiah(deal.fee)}**.\n` +
        'The invoice & transcript are saved automatically when the deal closes.',
    DISPUTE:
        '**🚨 Deal FROZEN** — no funds or goods may change hands.\n' +
        'Only **server admins** can resolve it: release to the seller or refund the buyer.\n' +
        'Every click is recorded and saved in the transcript.',
    COMPLETED: '✅ Deal complete — funds have been released to the seller. The channel will be closed automatically.',
    REFUNDED: '↩️ Deal complete — funds have been returned to the buyer. The channel will be closed automatically.',
    CANCELLED: '❌ Deal cancelled (funds not yet received). The channel will be closed automatically.'
};

function boardEmbed(deal, config) {
    // v3.9.33: the state description can be a string OR a function (for
    // dynamic amounts — transfer & payout totals shown right in the description).
    const rawDesc = STATE_DESCRIPTIONS[deal.state];
    const desc = typeof rawDesc === 'function' ? rawDesc(deal) : rawDesc || '';
    // v3.9.33: the fee is ADDITIVE — the buyer pays price + fee, the seller
    // receives the FULL price (not reduced by the fee). calcTotals = single source of the math.
    const totals = mm.calcTotals(deal.priceNum, deal.fee);
    const feeLabel =
        deal.feeMode === 'percent'
            ? `${mm.formatRupiah(deal.fee)} (${deal.feeValue}%)`
            : mm.formatRupiah(deal.fee);
    return new EmbedBuilder()
        .setTitle('🤝 DEAL BOARD — ESCROW')
        .setDescription(desc)
        .setColor(mm.STATES[deal.state]?.color || 0x2ecc71)
        .addFields(
            { name: '📦 Item', value: String(deal.item).slice(0, 1000), inline: false },
            { name: '💰 Deal Price', value: mm.formatRupiah(deal.priceNum), inline: true },
            { name: '🧾 Middleman Fee', value: feeLabel, inline: true },
            { name: '💳 Total Paid by Buyer', value: `**${mm.formatRupiah(totals.buyerPays)}** (price + fee)`, inline: true },
            { name: '🏷️ Received by Seller', value: `${mm.formatRupiah(totals.sellerGets)} — full amount, no deductions`, inline: true },
            { name: '🛒 Buyer', value: `<@${deal.buyerId}>`, inline: true },
            { name: '🏷️ Seller', value: `<@${deal.sellerId}>`, inline: true },
            { name: '🛡️ Middleman', value: config.roles.midman ? `<@&${config.roles.midman}>` : '_not set_', inline: true },
            // v3.9.34: extra members (observers) — everyone in the channel
            // immediately knows who the guests are, and admins know who can
            // be removed via the ➖ button.
            {
                name: '👀 Extra Members',
                value:
                    deal.observers && deal.observers.length > 0
                        ? deal.observers.map(id => `<@${id}>`).join(', ').slice(0, 1000)
                        : '—',
                inline: false
            },
            { name: '📍 Status', value: `${mm.STATES[deal.state]?.label || deal.state}`, inline: false }
        )
        .setFooter({ text: `Deal ID: ${deal.channelId} • Terms locked • Chat = evidence, Board = agreement` })
        .setTimestamp();
}

function mkButton(customId, label, emoji, style) {
    return new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(style);
}

/**
 * Buttons per state — ONLY the actions valid from that state are rendered.
 * Discord still delivers stale clicks (a user can click an old button on a
 * client that hasn't refreshed) → caught by the canTransition guard in handleEvent.
 */
function boardComponents(deal) {
    let buttons = [];
    switch (deal.state) {
        case 'WAITING_AGREE':
            buttons = [
                mkButton('mm_join', 'Agree to Deal', '🤝', ButtonStyle.Success),
                mkButton('mm_cancel', 'Cancel', '❌', ButtonStyle.Danger)
            ];
            break;
        case 'WAITING_PAYMENT':
            buttons = [
                mkButton('mm_fundin', 'Funds Received', '✅', ButtonStyle.Success),
                mkButton('mm_cancel', 'Cancel', '❌', ButtonStyle.Danger)
            ];
            break;
        case 'WAITING_DELIVERY':
            buttons = [
                mkButton('mm_received', 'Goods Delivered', '✅', ButtonStyle.Success),
                mkButton('mm_dispute', 'Report a Problem', '⚠️', ButtonStyle.Danger)
            ];
            break;
        case 'WAITING_RELEASE':
            buttons = [
                mkButton('mm_release', 'Release to Seller', '💸', ButtonStyle.Success),
                mkButton('mm_dispute', 'Report a Problem', '⚠️', ButtonStyle.Danger)
            ];
            break;
        case 'DISPUTE':
            buttons = [
                mkButton('mm_resolve_release', 'Resolve: Release', '⚖️', ButtonStyle.Success),
                mkButton('mm_resolve_refund', 'Resolve: Refund', '↩️', ButtonStyle.Secondary)
            ];
            break;
        default:
            break; // terminal state → no buttons
    }
    if (mm.TERMINAL_STATES.has(deal.state)) return [];

    // v3.9.34: row 2 — manage extra members (add/remove observers).
    // The buttons are visible to everyone, but the actor guard (midman/admin)
    // runs when clicked — buyers/sellers/observers get rejected with a clear message.
    const rows = [];
    if (buttons.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(...buttons));
    }
    rows.push(
        new ActionRowBuilder().addComponents(
            mkButton('mm_add_member', 'Add Member', '👥', ButtonStyle.Secondary),
            mkButton('mm_remove_member', 'Remove Member', '➖', ButtonStyle.Secondary)
        )
    );
    return rows;
}

function boardPing(deal, config) {
    const parts = [];
    if (config.roles.midman) parts.push(`<@&${config.roles.midman}>`);
    parts.push(`<@${deal.buyerId}>`, `<@${deal.sellerId}>`);
    return parts.join(' | ');
}

/**
 * Update the Deal Board in the channel. Self-healing: if an admin deleted
 * the board, send a new one & save the new boardMessageId.
 */
async function refreshBoard(channel, deal, config) {
    if (!deal.boardMessageId || !channel) return;
    const payload = { embeds: [boardEmbed(deal, config)], components: boardComponents(deal) };
    try {
        await channel.messages.edit(deal.boardMessageId, payload);
    } catch (editErr) {
        console.warn(`⚠️ Deal Board ${deal.channelId} failed to edit (${editErr.message}) — trying to resend.`);
        try {
            const sent = await channel.send({ content: boardPing(deal, config), ...payload });
            deal.boardMessageId = sent.id;
            mm.setDeal(deal.channelId, deal);
        } catch (sendErr) {
            console.warn(`⚠️ Failed to resend the Deal Board: ${sendErr.message}`);
        }
    }
}

// ====================================================
// === ACTOR & GUARDS ===
// ====================================================

/**
 * The clicking user's role relative to this deal.
 * Anti self-dealing: a deal's buyer/seller is NOT counted as midman/admin
 * on their own deal (a middleman must not simultaneously hold the deal as a participant).
 */
function resolveActor(deal, interaction, config) {
    const uid = interaction.user.id;
    const isBuyer = uid === deal.buyerId;
    const isSeller = uid === deal.sellerId;
    const hasMidmanRole =
        Boolean(config.roles.midman) && Boolean(interaction.member?.roles?.cache?.has(config.roles.midman));
    const isMidman = hasMidmanRole && !isBuyer && !isSeller;
    const isAdmin = !isBuyer && !isSeller && Boolean(checkIsAdmin(interaction.member));
    return { isBuyer, isSeller, isMidman, isAdmin };
}

const ACTOR_HINT = {
    join: '❌ Only the deal\'s **buyer** or **seller** can agree to the deal.',
    cancel: '❌ A deal can only be cancelled by the buyer, the seller, or an admin — and only before the funds are received.',
    fundin: '❌ Only the **middleman** can confirm the funds were received.',
    received: '❌ Only the **buyer** can confirm the goods were delivered.',
    release: '❌ Only the **middleman** can release the funds.',
    dispute: '❌ Only deal participants (buyer / seller / middleman) can open a dispute.',
    resolve_release: '❌ Only **server admins** can resolve a dispute.',
    resolve_refund: '❌ Only **server admins** can resolve a dispute.'
};

const CONFIRM_MSG = {
    join: '✅ Both parties have agreed — the terms are **locked**. Buyer, please transfer to the middleman.',
    cancel: '❌ Deal cancelled. The channel will be closed automatically.',
    fundin: '✅ Funds confirmed received. The seller may now send the goods.',
    received: '✅ Goods confirmed delivered. The middleman can now release the funds to the seller.',
    release: '💸 Funds released! Deal complete — invoice & transcript saved automatically.',
    dispute: '🚨 Dispute opened. The deal is **frozen** — only admins can resolve it.',
    resolve_release: '⚖️ Dispute resolved — decision: RELEASE to the seller. The channel will be closed.',
    resolve_refund: '⚖️ Dispute resolved — decision: REFUND to the buyer. The channel will be closed.'
};

// ====================================================
// === CREATE DEAL (modal) ===
// ====================================================

/**
 * Entry point from the ticket panel: the `midman` category button (routed to
 * this domain by the router via the `ticket_cat:midman` prefix) or the category
 * dropdown (redirected from ticket.js). Shows the deal input modal.
 */
async function openCreateModal(interaction) {
    const config = getConfig();

    if (!passesVerifiedCheck(interaction, config)) {
        return interaction.reply({ content: '❌ Please verify first!', flags: MessageFlags.Ephemeral });
    }
    if (!config.roles.midman) {
        return interaction.reply({
            content: '❌ The Midman role is not set yet. An admin must run `/set-role midman @role` first.',
            flags: MessageFlags.Ephemeral
        });
    }

    const modal = new ModalBuilder()
        .setCustomId('modal_mm_create')
        .setTitle('Create Escrow Deal — Item & Price')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('mm_field_item')
                    .setLabel('Item being sold')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(100)
                    .setPlaceholder('Example: Mythic ML account with all heroes')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('mm_field_price')
                    .setLabel('Price (e.g. 100000 / 100k)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(20)
                    .setPlaceholder('100000')
            )
            // v3.9.33: the "seller" field was REMOVED from the modal — the seller
            // is picked via the member dropdown (mm_pick_seller) after the modal
            // is submitted, so users never need to mention or copy a user ID.
        );
    return interaction.showModal(modal);
}

// ====================================================
// === CREATE DEAL — 3-STEP FORM (v3.9.34) ===
// ===  Step 1 (modal)   : item + price           ===
// ===  Step 2 (dropdown): pick the BUYER         ===
// ===  Step 3 (dropdown): pick the SELLER        ===
// ====================================================
// A deal can be opened by ANYONE — the buyer, the seller, or a helping
// third party (e.g. a middleman/staff member). What matters is a clear
// form: item, price, who the buyer is, who the seller is — roles are no
// longer guessed from whoever clicked the button. Since the creator can be
// anyone, the terms are locked ONLY after BOTH the buyer & seller click
// Agree to Deal (state WAITING_AGREE).
//
// Dropdown (User Select Menu) = Discord's built-in member list with a search
// field + avatars + names — users just TYPE a name/username, no need to
// know how to mention or copy a user ID. Step 1+2 data is stored temporarily
// (in-memory) until the seller is picked.

// TTL 15 minutes — aligned with the lifetime of ephemeral messages & interaction tokens.
const PENDING_TTL_MS = 15 * 60 * 1000;
// key: `${guildId}:${userId}` → { item, priceNum, buyerId, ts }
const pendingDeals = new Map();

function setPendingDeal(guildId, userId, data) {
    // Prune expired entries so the Map can't grow without bound.
    const now = Date.now();
    for (const [key, val] of pendingDeals) {
        if (now - val.ts > PENDING_TTL_MS) pendingDeals.delete(key);
    }
    pendingDeals.set(`${guildId}:${userId}`, {
        item: data.item,
        priceNum: data.priceNum,
        // v3.9.34: the buyer is picked in step 2 (null until chosen).
        buyerId: data.buyerId || null,
        ts: now
    });
}

function getPendingDeal(guildId, userId) {
    const key = `${guildId}:${userId}`;
    const pending = pendingDeals.get(key);
    if (!pending) return null;
    if (Date.now() - pending.ts > PENDING_TTL_MS) {
        pendingDeals.delete(key);
        return null;
    }
    return pending;
}

/** Step 2 dropdown — pick the buyer (re-renderable when validation fails). */
function buyerSelectRow() {
    return [
        new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
                .setCustomId('mm_pick_buyer')
                .setPlaceholder('🔍 Type the BUYER\'s name here…')
                .setMinValues(1)
                .setMaxValues(1)
        )
    ];
}

/** Step 3 dropdown — pick the seller (re-renderable when validation fails). */
function sellerSelectRow() {
    return [
        new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
                .setCustomId('mm_pick_seller')
                .setPlaceholder('🔍 Type the SELLER\'s name here…')
                .setMinValues(1)
                .setMaxValues(1)
        )
    ];
}

/** Extra-member add dropdown — pick a user (re-renderable). */
function memberSelectRow() {
    return [
        new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
                .setCustomId('mm_pick_member')
                .setPlaceholder('🔍 Type the name of the member to add…')
                .setMinValues(1)
                .setMaxValues(1)
        )
    ];
}

/** Item+price summary for the ephemeral message header of each step. */
function pendingSummary(pending) {
    const buyerPart = pending.buyerId ? `\n🛒 Buyer: **<@${pending.buyerId}>**` : '';
    return `🧾 Item: **${pending.item}** • 💰 Price: **${mm.formatRupiah(pending.priceNum)}**${buyerPart}`;
}

/**
 * Step 1 — modal submit (item + price): validate input & config, store
 * temporarily, then show the BUYER selection dropdown (ephemeral). The deal
 * channel is NOT created in this step.
 *
 * v3.9.34: the creator can be anyone — the "user has an active deal/ticket"
 * check no longer runs on the creator, but on the buyer & seller when they
 * are picked (steps 2 & 3). A third-party creator (e.g. a middleman helping
 * out) may still create a deal for someone else.
 */
async function handleCreateDeal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const config = getConfig();
    const guild = interaction.guild;
    const creator = interaction.user;

    // Validate config
    if (!config.roles.admin) {
        return safeEditReply(interaction, { content: '❌ The Admin role is not set yet. Run `/set-role admin @role` first.' });
    }
    if (!config.roles.midman) {
        return safeEditReply(interaction, { content: '❌ The Midman role is not set yet. Run `/set-role midman @role` first.' });
    }

    // Validate modal input
    const item = (interaction.fields.getTextInputValue('mm_field_item') || '').trim();
    const priceRaw = (interaction.fields.getTextInputValue('mm_field_price') || '').trim();

    if (item.length < 3) {
        return safeEditReply(interaction, { content: '❌ The item name must be at least 3 characters.' });
    }
    const priceNum = mm.parsePriceNumber(priceRaw);
    if (priceNum <= 0) {
        return safeEditReply(interaction, { content: '❌ Invalid price. Examples: `100000`, `100.000`, or `100k`.' });
    }

    setPendingDeal(guild.id, creator.id, { item, priceNum });

    return safeEditReply(interaction, {
        content:
            `${pendingSummary({ item, priceNum })}\n\n` +
            '👉 **Step 2/3 — pick the 🛒 BUYER** from the member list below — just **type their name in the search field** (no mention or user ID copy needed).\n' +
            '⏳ Valid for 15 minutes — if this message disappears, click the 🤝 Escrow button again.',
        components: buyerSelectRow()
    });
}

/**
 * Step 2 — the buyer is picked from the member dropdown (v3.9.34): validate
 * the buyer (exists on the server, not a bot, not holding an active deal/ticket),
 * save to pending, then show the seller selection dropdown.
 *
 * Validation failure → error message + the dropdown is RE-RENDERED on the
 * same message (the user doesn't have to refill the modal).
 */
async function handlePickBuyer(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const creator = interaction.user;

    const pending = getPendingDeal(guild.id, creator.id);
    if (!pending) {
        return safeEditReply(interaction, {
            content: '❌ Deal creation session expired / not found. Click the 🤝 Escrow button on the panel again.'
        });
    }

    const buyerId = interaction.values && interaction.values[0];
    if (!buyerId) {
        return safeEditReply(interaction, { content: '❌ No buyer selected. Please try again.', components: buyerSelectRow() });
    }

    // Resolve the buyer — they must actually exist on the server.
    let buyerMember = interaction.members?.get(buyerId) || guild.members.cache.get(buyerId);
    if (!buyerMember) buyerMember = await guild.members.fetch(buyerId).catch(() => null);
    if (!buyerMember) {
        return safeEditReply(interaction, {
            content: '❌ Buyer not found on this server. Please pick again:',
            components: buyerSelectRow()
        });
    }
    if (buyerMember.user?.bot) {
        return safeEditReply(interaction, {
            content: '❌ The buyer cannot be a bot. Please pick again:',
            components: buyerSelectRow()
        });
    }

    // The buyer must not be involved in another still-active deal.
    if (mm.hasActiveDealFor(guild.id, buyerId)) {
        return safeEditReply(interaction, {
            content: `❌ <@${buyerId}> still has an **active** escrow deal. Finish that one before creating a new deal. Please pick another buyer:`,
            components: buyerSelectRow()
        });
    }
    // The buyer must not have an active regular ticket at the same time (the
    // 1 active channel per user policy — consistent with createTicket).
    // v3.9.40 FIX: catch TICKET_VERIFY_TRANSIENT — don't treat a failed check
    // as "no ticket" (a deal could slip through while the buyer has a live ticket).
    let activeTicket;
    try {
        activeTicket = await findActiveTicketFor(guild, buyerId);
    } catch (verifyErr) {
        if (verifyErr?.code === 'TICKET_VERIFY_TRANSIENT') {
            return safeEditReply(interaction, {
                content: '⚠️ Could not verify the active ticket (the Discord network is busy). Please pick the buyer again in a few seconds.',
                components: buyerSelectRow()
            });
        }
        throw verifyErr;
    }
    if (activeTicket) {
        return safeEditReply(interaction, {
            content: `❌ <@${buyerId}> still has an active ticket in ${activeTicket}. Close it before creating an escrow deal. Please pick another buyer:`,
            components: buyerSelectRow()
        });
    }

    // Save the buyer to the pending session (item & price are carried over).
    setPendingDeal(guild.id, creator.id, { item: pending.item, priceNum: pending.priceNum, buyerId });

    return safeEditReply(interaction, {
        content:
            `${pendingSummary({ item: pending.item, priceNum: pending.priceNum, buyerId })}\n\n` +
            '👉 **Step 3/3 — pick the 🏷️ SELLER** — type their name in the search field.\n' +
            '⏳ Valid for 15 minutes — if this message disappears, click the 🤝 Escrow button again.',
        components: sellerSelectRow()
    });
}

/**
 * Step 3 — the seller is picked from the member dropdown: validate the seller,
 * re-check the buyer & seller (things may have changed since steps 1-2),
 * create the 3-party channel → send the Deal Board → save deals.json.
 */
async function handlePickSeller(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const config = getConfig();
    const guild = interaction.guild;
    const creator = interaction.user;

    const pending = getPendingDeal(guild.id, creator.id);
    if (!pending) {
        return safeEditReply(interaction, {
            content: '❌ Deal creation session expired / not found. Click the 🤝 Escrow button on the panel again.'
        });
    }
    // v3.9.34: the buyer must already be picked in step 2 — if not, this
    // session is from an old/invalid flow; ask them to start over.
    if (!pending.buyerId) {
        return safeEditReply(interaction, {
            content: '❌ Incomplete session (no buyer picked yet). Click the 🤝 Escrow button on the panel again.'
        });
    }
    const buyerId = pending.buyerId;

    const sellerId = interaction.values && interaction.values[0];
    if (!sellerId) {
        return safeEditReply(interaction, { content: '❌ No seller selected. Please pick again from the list.', components: sellerSelectRow() });
    }
    if (sellerId === buyerId) {
        return safeEditReply(interaction, {
            content: '❌ The seller cannot be the same person as the buyer. Please pick another seller:',
            components: sellerSelectRow()
        });
    }

    const item = pending.item;
    const priceNum = pending.priceNum;

    // Resolve the seller — they must actually exist on the server (resolved
    // select-menu data first, then cache → fetch fallback — the old pattern).
    let sellerMember = interaction.members?.get(sellerId) || guild.members.cache.get(sellerId);
    if (!sellerMember) sellerMember = await guild.members.fetch(sellerId).catch(() => null);
    if (!sellerMember) {
        return safeEditReply(interaction, {
            content: '❌ Seller not found on this server. Please pick again:',
            components: sellerSelectRow()
        });
    }
    if (sellerMember.user?.bot) {
        return safeEditReply(interaction, {
            content: '❌ The seller cannot be a bot. Please pick again:',
            components: sellerSelectRow()
        });
    }

    // Anti-bypass (re-check — things may have changed since steps 1-2):
    // the buyer & seller must not be involved in another still-active deal.
    if (mm.hasActiveDealFor(guild.id, buyerId)) {
        return safeEditReply(interaction, {
            content: `❌ <@${buyerId}> turns out to already have an **active** escrow deal. Finish that deal first.`
        });
    }
    if (mm.hasActiveDealFor(guild.id, sellerId)) {
        return safeEditReply(interaction, {
            content: `❌ <@${sellerId}> still has an active escrow deal. Finish that deal first. Please pick another seller:`,
            components: sellerSelectRow()
        });
    }
    // The buyer must not have an active regular ticket at the same time (the
    // 1 active channel per user policy — consistent with createTicket).
    // v3.9.40 FIX: catch TICKET_VERIFY_TRANSIENT — a failed check ≠ "no
    // ticket"; abort so no deal is created for a user with a live ticket.
    let activeTicket;
    try {
        activeTicket = await findActiveTicketFor(guild, buyerId);
    } catch (verifyErr) {
        if (verifyErr?.code === 'TICKET_VERIFY_TRANSIENT') {
            return safeEditReply(interaction, {
                content: '⚠️ Could not verify the buyer’s active ticket (the Discord network is busy). Please try again in a few seconds.'
            });
        }
        throw verifyErr;
    }
    if (activeTicket) {
        return safeEditReply(interaction, {
            content: `❌ <@${buyerId}> turns out to already have an active ticket in ${activeTicket}. Close it before creating an escrow deal.`
        });
    }
    // v3.9.37: the seller must not have an active regular ticket either — previously
    // only the buyer was checked, so a user with an open ticket could still become
    // a seller (asymmetric with the 1-channel-per-user policy that applies in the
    // 3 other directions: creating a ticket, being a deal buyer, being a deal seller).
    let sellerTicket;
    try {
        sellerTicket = await findActiveTicketFor(guild, sellerId);
    } catch (verifyErr) {
        if (verifyErr?.code === 'TICKET_VERIFY_TRANSIENT') {
            return safeEditReply(interaction, {
                content: '⚠️ Could not verify the seller’s active ticket (the Discord network is busy). Please try again in a few seconds.'
            });
        }
        throw verifyErr;
    }
    if (sellerTicket) {
        return safeEditReply(interaction, {
            content: `❌ <@${sellerId}> still has an active ticket in ${sellerTicket}. Please pick another seller:`,
            components: sellerSelectRow()
        });
    }

    // v3.9.38 FIX (anti double-submit/TOCTOU): the pending session is deleted NOW —
    // before the channel/board creation awaits. A second submit (the user double-
    // clicking the seller dropdown while creation is still running) won't find the
    // session → rejected as expired, so a duplicate deal for the same buyer/seller
    // pair cannot be formed. All session data has already been copied to the
    // local variables (item/priceNum/buyerId/sellerId) above.
    pendingDeals.delete(`${guild.id}:${creator.id}`);

    // Deal channel category (v3.9.16 ticketManager pattern: find → create → clear error)
    const categoryName = config.midman?.category || '🤝 ESCROW';
    let category = guild.channels.cache.find(
        c => c.name === categoryName && c.type === ChannelType.GuildCategory
    );
    if (!category) {
        try {
            category = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
            console.log(`📁 Escrow category created: ${categoryName}`);
        } catch (catErr) {
            console.error(`Failed to create category ${categoryName}:`, catErr.message);
            return safeEditReply(interaction, {
                content: `❌ Failed to create category "${categoryName}". Check the bot's Manage Channels permission.`
            });
        }
    }

    // The fee is computed from config — NOT from manual input (anti-tampering).
    // v3.9.33: the fee is ADDED on top of the price (the buyer pays price+fee,
    // the seller receives the FULL price). Mode+value are snapshotted into the
    // deal so the Deal Board & deal history DON'T change even if an admin
    // edits the config mid-deal.
    const feeMode = config.midman?.feeMode || 'percent';
    const feeValue = config.midman?.feeValue !== undefined ? config.midman.feeValue : 5;
    const fee = mm.calcFee(priceNum, feeMode, feeValue);

    const deal = {
        channelId: null, // set once the channel is created
        guildId: guild.id,
        // v3.9.34: explicit roles from the form — anyone may create the deal
        // (creator), but buyer/seller are determined by the step 2-3 picks.
        buyerId,
        sellerId,
        // v3.9.34: dual consent — the terms are locked only after BOTH the
        // buyer & seller click Agree to Deal (state WAITING_AGREE).
        buyerAgreed: false,
        sellerAgreed: false,
        // v3.9.34: extra members (observers) — managed by the 👥/➖ buttons on the board.
        observers: [],
        item,
        priceNum,
        priceText: mm.formatRupiah(priceNum),
        fee,
        // v3.9.33: fee snapshot at deal creation (board display & history
        // consistency — config changes don't affect a running deal).
        feeMode,
        feeValue,
        state: 'WAITING_AGREE',
        boardMessageId: null,
        createdBy: creator.id,
        createdAt: Date.now(),
        history: []
    };

    const channelName = `escrow-${buyerId}`.toLowerCase().slice(0, 50);

    // v3.9.34: overwrites are built conditionally — a third-party creator
    // (not the buyer/seller, e.g. a middleman/staff member helping out) still
    // gets access to the channel they created. If creator = buyer/seller, the
    // creator overwrite is skipped (already covered above).
    const participantAllow = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles
    ];
    const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: buyerId, allow: participantAllow },
        { id: sellerId, allow: participantAllow }
    ];
    if (creator.id !== buyerId && creator.id !== sellerId) {
        overwrites.push({ id: creator.id, allow: participantAllow });
        // v3.9.38 FIX: third-party creators are also recorded as the deal's
        // first observer — previously they got channel access but were NOT
        // in deal.observers, so they couldn't be removed via the ➖ button (an
        // admin had to revoke the permission manually). Added at deal creation,
        // so it only takes 1 of the 10 observer slots (canAddObserver still
        // works normally for other members).
        deal.observers.push(creator.id);
    }
    overwrites.push(
        {
            // Everyone with the midman role can see & handle the deal (the
            // same pattern as the admin role in tickets). Whoever CLICKS is
            // recorded in the deal history.
            id: config.roles.midman,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.ManageMessages
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
    );

    let dealChannel;
    try {
        dealChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category.id,
            topic: `Escrow Deal | Buyer: ${buyerId} | Seller: ${sellerId} | Item: ${item}`.slice(0, 1024),
            permissionOverwrites: overwrites
        });
    } catch (chErr) {
        console.error('Failed to create the deal channel:', chErr);
        return safeEditReply(interaction, { content: '❌ Failed to create the deal channel. Check the bot\'s permissions!' });
    }

    deal.channelId = dealChannel.id;

    // Send the Deal Board (source of truth) + save meta
    let board;
    try {
        board = await dealChannel.send({
            content: boardPing(deal, config),
            embeds: [boardEmbed(deal, config)],
            components: boardComponents(deal)
        });
    } catch (sendErr) {
        console.error('Failed to send the Deal Board:', sendErr);
        await dealChannel.delete().catch(() => {});
        return safeEditReply(interaction, { content: '❌ Failed to send the Deal Board. Check the bot\'s permissions!' });
    }

    deal.boardMessageId = board.id;

    // v3.9.38 FIX (atomic re-check before commit): the "active deal" check runs
    // AGAIN right before the meta is saved — during the channel create & board
    // send awaits above, another deal for the same buyer/seller may already
    // have been committed (TOCTOU). If so, the newly created channel is cleaned
    // up (best-effort) and this deal is not saved.
    if (mm.hasActiveDealFor(guild.id, buyerId) || mm.hasActiveDealFor(guild.id, sellerId)) {
        await dealChannel.delete().catch(() => {});
        return safeEditReply(interaction, {
            content: '❌ Sorry, this deal\'s buyer/seller turns out to already be involved in another active deal that was just created. This deal is cancelled — please try again if it\'s still needed.'
        });
    }
    mm.setDeal(dealChannel.id, deal);

    await logAudit(interaction.client, {
        action: 'MIDMAN_CREATE',
        actorId: creator.id,
        actorTag: creator.tag,
        details:
            `Escrow deal created by <@${creator.id}> — Item: **${item}** • Price: ${mm.formatRupiah(priceNum)} • Fee: ${mm.formatRupiah(fee)} • Total paid by buyer: ${mm.formatRupiah(priceNum + fee)} • Buyer: <@${buyerId}> • Seller: <@${sellerId}>`,
        guildId: guild.id
    });

    // Note: the pending session was already deleted before the channel
    // creation awaits (v3.9.38 FIX anti double-submit) — no further cleanup here.

    return safeEditReply(interaction, {
        content:
            `✅ Escrow deal created: 🛒 <@${buyerId}> ⇄ 🏷️ <@${sellerId}> — ${dealChannel}\n` +
            '🤝 **Buyer & seller** must BOTH click **Agree to Deal** on the Deal Board to lock the terms.'
    });
}

// ====================================================
// === FINALIZATION (terminal state) ===
// ====================================================

/**
 * Finalize the deal: history summary (regular message → captured in the
 * transcript), transcript, invoice + stats (COMPLETED only), delete channel + meta.
 *
 * closeTicket v3.9.31 pattern: deals.json meta is only deleted if the channel
 * is REALLY gone — never leave an orphan channel without meta (if deletion
 * fails, an admin can resolve it again later).
 */
async function finalizeDeal(channel, deal, closer, endState, config) {
    // 1. History summary — sent as a regular message so it gets captured
    //    by saveTranscript (audit evidence of "who clicked what when").
    try {
        const histLines = (deal.history || [])
            .map(
                h =>
                    `• [${new Date(h.ts).toLocaleString('en-US')}] **${h.event}** by <@${h.actorId}> (${h.actorTag}) → ${mm.STATES[h.toState]?.label || h.toState}`
            )
            .join('\n');
        await channel.send({
            content: `📋 **DEAL HISTORY**\n${histLines.slice(0, 1800)}\n\n📍 Final status: **${mm.STATES[endState]?.label || endState}**`
        });
    } catch (_) {}

    // 2. Transcript (if a transcript channel is set via /set-channel type:transcript)
    if (config.channels?.transcript) {
        try {
            await saveTranscript(
                channel,
                {
                    userId: deal.buyerId,
                    productName: `🤝 Escrow: ${deal.item}`,
                    // v3.9.33: the additive fee breakdown is recorded in the transcript too.
                    price: `${mm.formatRupiah(deal.priceNum + deal.fee)} (price ${mm.formatRupiah(
                        deal.priceNum
                    )} + fee ${mm.formatRupiah(deal.fee)})`,
                    category: 'midman'
                },
                closer,
                endState === 'COMPLETED'
            );
        } catch (transcriptErr) {
            console.warn(`⚠️ Failed to save the deal transcript ${deal.channelId}:`, transcriptErr.message);
        }
    }

    // 3. Invoice + stats — COMPLETED deals only (funds released to the seller).
    //    v3.9.33: what gets recorded = the buyer's REAL spending (price + fee).
    if (endState === 'COMPLETED') {
        try {
            await sendInvoice(
                channel,
                deal.buyerId,
                `🤝 Escrow: ${deal.item}`,
                mm.formatRupiah(deal.priceNum + deal.fee),
                closer
            );
        } catch (invoiceErr) {
            console.warn(`⚠️ Failed to send the deal invoice ${deal.channelId}:`, invoiceErr.message);
        }
        try {
            recordPurchase(deal.guildId, deal.buyerId, deal.priceNum + deal.fee);
        } catch (statsErr) {
            console.warn('⚠️ Failed to record the purchase stats:', statsErr.message);
        }
    }

    // 4. Delete the channel — add a delay so participants can read the summary.
    await new Promise(resolve => setTimeout(resolve, DELETE_DELAY_MS));
    let channelGone = false;
    try {
        await channel.delete();
        channelGone = true;
    } catch (deleteErr) {
        if (deleteErr.code === 10003) {
            channelGone = true; // Unknown Channel — already deleted by someone else
        } else {
            console.warn(`⚠️ Failed to delete the deal channel ${deal.channelId}:`, deleteErr.message);
        }
    }
    if (channelGone) {
        mm.removeDeal(deal.channelId);
    }
}

// ====================================================
// === HANDLE EVENT (state transitions via buttons) ===
// ====================================================

/**
 * The state machine core: a single gate for ALL transition buttons.
 * Layered guards: valid channel → deal exists → not being processed (lock) →
 * valid transition (order) → authorized actor (role). Illegal actions are
 * rejected by the bot with a clear message — not just a written rule.
 */
async function handleEvent(interaction, event) {
    const config = getConfig();
    const channel = interaction.channel;

    if (!channel) {
        return interaction
            .reply({ content: '❌ Channel unavailable (it may have already been deleted).', flags: MessageFlags.Ephemeral })
            .catch(() => {});
    }

    // v3.9.38 FIX: deferReply AT THE START — previously the ephemeral confirmation
    // was sent as a reply AFTER 3-4 API awaits (channel announcement, Deal Board
    // refresh, audit log) → could exceed Discord's 3-second ack window →
    // "interaction failed" even though the transition had been saved. All
    // replies after this go through safeEditReply (edits the deferred reply).
    // The defer is deliberately placed BEFORE getDeal+lock check so the
    // read→validate→lock sequence stays synchronized (atomic on the event
    // loop — inserting an await in the middle would open a double-transition race).
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

    const deal = mm.getDeal(channel.id);
    if (!deal) {
        return safeEditReply(interaction, { content: '❌ This channel is not an escrow deal channel.' });
    }
    if (mm.transitionLocks.has(channel.id)) {
        return safeEditReply(interaction, { content: '⏳ The deal is being processed, please wait a moment...' });
    }

    // Guard 1: step order — the state must allow this event.
    // (Catches stale button clicks: a user clicking an old button on a client
    // that hasn't refreshed after a state change.)
    const next = mm.nextState(deal.state, event);
    if (!next) {
        return safeEditReply(interaction, {
            content: `❌ This action cannot be performed right now.\n📍 Deal status: **${mm.STATES[deal.state]?.label || deal.state}**.`
        });
    }

    // Guard 2: role — only authorized parties.
    const actor = resolveActor(deal, interaction, config);
    if (!mm.actorAllowed(event, actor)) {
        return safeEditReply(interaction, { content: ACTOR_HINT[event] || '❌ You are not allowed to perform this action.' });
    }

    mm.transitionLocks.add(channel.id);
    try {
        // v3.9.34: join = consent PER PARTY. The transition to WAITING_PAYMENT
        // only happens once BOTH the buyer & seller have agreed — the first
        // click is recorded as partial consent (history + board update + ping
        // of the party who hasn't agreed), without moving the state.
        if (event === 'join') {
            const res = mm.applyAgreement(deal, interaction.user.id);
            if (!res.ok) {
                // Guard 2 already ensures the actor = buyer/seller, so the only
                // failure cause: that party ALREADY agreed (double-click / stale
                // button on a client that hasn't refreshed).
                return safeEditReply(interaction, {
                    content: '✅ You have already agreed to this deal — waiting for the other party.'
                });
            }
            if (!res.both) {
                // Partial consent — record it, update the board, ping the party
                // who hasn't agreed. The state does NOT change (stays WAITING_AGREE).
                deal.history = Array.isArray(deal.history) ? deal.history : [];
                deal.history.push({
                    ts: Date.now(),
                    event: `${res.role === 'buyer' ? '🛒 Buyer' : '🏷️ Seller'} agreed to the deal (waiting for the other party)`,
                    fromState: deal.state,
                    toState: deal.state,
                    actorId: interaction.user.id,
                    actorTag: interaction.user.tag
                });
                mm.setDeal(channel.id, deal);
                await refreshBoard(channel, deal, config);
                const waitingId = res.role === 'buyer' ? deal.sellerId : deal.buyerId;
                const waitingLabel = res.role === 'buyer' ? '🏷️ Seller' : '🛒 Buyer';
                await channel
                    .send(`⏳ ${res.role === 'buyer' ? '🛒 Buyer' : '🏷️ Seller'} has agreed. ${waitingLabel} <@${waitingId}> — it's your turn to click **🤝 Agree to Deal** so the terms get locked.`)
                    .catch(() => {});
                await logAudit(interaction.client, {
                    action: 'MIDMAN_AGREE',
                    actorId: interaction.user.id,
                    actorTag: interaction.user.tag,
                    details: `Deal <#${deal.channelId}> — ${res.role === 'buyer' ? 'buyer' : 'seller'} agreed (waiting for the other party)`,
                    guildId: deal.guildId
                }).catch(() => {});
                return safeEditReply(interaction, {
                    content: '✅ Your agreement is recorded — waiting for the other party to agree to the deal.'
                });
            }
            // Both parties agreed → continue to recordTransition('join') below
            // (terms locked, state → WAITING_PAYMENT).
        }

        // Apply the transition + record history.
        if (!mm.recordTransition(deal, event, interaction.user)) {
            return safeEditReply(interaction, { content: '❌ Transition failed (the state just changed). Please try again.' });
        }
        mm.setDeal(channel.id, deal);

        // Per-event side effects — channel announcements (captured in the transcript).
        try {
            if (event === 'join') {
                await channel.send(
                    '🤝 **Buyer & seller have BOTH agreed** — item & price are **LOCKED**.\n' +
                        `🛒 <@${deal.buyerId}> — transfer **${mm.formatRupiah(deal.priceNum + deal.fee)}** to the middleman, then post the transfer proof in this channel.`
                );
            }
            if (event === 'fundin') {
                await channel.send(
                    `💰 Funds **${mm.formatRupiah(deal.priceNum + deal.fee)}** (price + fee) confirmed received by **${interaction.user.tag}**.\n🏷️ <@${deal.sellerId}>, please send the goods. Chat in this channel serves as proof of delivery.`
                );
            }
            if (event === 'release') {
                await channel.send(
                    `💸 **${interaction.user.tag}** released **${mm.formatRupiah(deal.priceNum)}** to <@${deal.sellerId}> (full amount, no deductions).\n🧾 The middleman fee **${mm.formatRupiah(deal.fee)}** stays with the middleman.`
                );
            }
            if (event === 'received') {
                await channel.send(`✅ <@${deal.buyerId}> confirmed the goods were **delivered & as described**.`);
            }
            if (event === 'dispute') {
                // v3.9.37: empty admin role guard (mirrors the boardEmbed guard
                // for the midman role) — without it, the mention becomes a literal "<@&undefined>".
                const adminPing = config.roles?.admin ? `<@&${config.roles.admin}>` : '**Admin**';
                await channel.send(
                    `🚨 ${adminPing} — **DISPUTE** opened by **${interaction.user.tag}**.\n` +
                        'All deal processes are **frozen** until an admin resolves it (release / refund). Do not send goods/funds anymore.'
                );
            }
        } catch (announceErr) {
            console.warn('⚠️ Failed to send the deal announcement:', announceErr.message);
        }

        // Update the Deal Board (the source-of-truth embed).
        await refreshBoard(channel, deal, config);

        // Confirmation to the actor (ephemeral) — via safeEditReply (v3.9.38 FIX:
        // the deferred reply is edited, not a new reply after several awaits).
        await safeEditReply(interaction, { content: CONFIRM_MSG[event] || '✅ Success.' });

        // Audit log — every click is recorded.
        await logAudit(interaction.client, {
            action: `MIDMAN_${event.toUpperCase()}`,
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Deal <#${deal.channelId}> (${deal.item} — ${mm.formatRupiah(deal.priceNum)}) → ${mm.STATES[deal.state]?.label || deal.state}`,
            guildId: deal.guildId
        }).catch(() => {});

        // Terminal state → finalize (transcript, invoice, close channel).
        if (mm.TERMINAL_STATES.has(deal.state)) {
            await finalizeDeal(channel, deal, interaction.user, deal.state, config);
        }
    } catch (err) {
        console.error(`[midman] Error on event ${event}:`, err);
        await safeEditReply(interaction, { content: '❌ An error occurred while processing the action. Please try again.' }).catch(() => {});
    } finally {
        mm.transitionLocks.delete(channel.id);
    }
}

// ====================================================
// === EXTRA MEMBERS (observer) v3.9.34 ===
// ====================================================

/**
 * Shared guard for member management: the deal exists, is not terminal, and
 * the actor is midman/admin. (resolveActor automatically rejects a deal's
 * buyer/seller as "midman/admin" — anti self-dealing; an observer without
 * the midman role is also rejected here.)
 */
function memberGuard(deal, interaction, config) {
    if (!deal) return '❌ This channel is not an escrow deal channel.';
    if (mm.TERMINAL_STATES.has(deal.state)) return '❌ The deal is already complete — members cannot be changed.';
    const actor = resolveActor(deal, interaction, config);
    if (!actor.isMidman && !actor.isAdmin) {
        return '❌ Only **midman/admin** can manage extra members.';
    }
    return null; // guard passed
}

/**
 * 👥 Add Member button (Deal Board row 2) → shows the member dropdown
 * (searchable). Only midman/admin can get here.
 */
async function showAddMemberSelect(interaction) {
    const config = getConfig();
    const deal = mm.getDeal(interaction.channel?.id);
    const blocked = memberGuard(deal, interaction, config);
    if (blocked) {
        return interaction.reply({ content: blocked, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return interaction
        .reply({
            content:
                '👥 **Add a member to this deal channel** — type their name in the search field.\n' +
                'Extra members can only **view & chat** — they CANNOT move the deal forward (transitions remain the right of the buyer/seller/midman/admin).',
            components: memberSelectRow(),
            flags: MessageFlags.Ephemeral
        })
        .catch(() => {});
}

/**
 * mm_pick_member dropdown submit: validate the target (exists, not a bot,
 * not a participant, not already added, not full) → grant channel
 * permission → record in the deal history + audit log → refresh the Deal Board.
 */
async function handlePickMember(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const config = getConfig();
    const channel = interaction.channel;
    const guild = interaction.guild;

    const deal = mm.getDeal(channel?.id);
    const blocked = memberGuard(deal, interaction, config);
    if (blocked) {
        return safeEditReply(interaction, { content: blocked });
    }

    // v3.9.38 FIX: observer add/remove used to write deals.json WITHOUT a lock
    // (getDeal → await permissionOverwrites → setDeal). A handleEvent processing
    // a transition in the same channel would get overwritten by that stale
    // snapshot (state rolled back / history lost / dispute unfrozen). This
    // flow now uses the SAME transitionLocks as handleEvent.
    if (mm.transitionLocks.has(channel.id)) {
        return safeEditReply(interaction, { content: '⏳ The deal is being processed, please try again shortly.' });
    }

    const userId = interaction.values && interaction.values[0];
    if (!userId) {
        return safeEditReply(interaction, { content: '❌ No member selected. Please try again.', components: memberSelectRow() });
    }

    mm.transitionLocks.add(channel.id);
    try {
        let member = interaction.members?.get(userId) || guild.members.cache.get(userId);
        if (!member) member = await guild.members.fetch(userId).catch(() => null);
        if (!member) {
            return safeEditReply(interaction, {
                content: '❌ User not found on this server. Please pick again:',
                components: memberSelectRow()
            });
        }
        if (member.user?.bot) {
            return safeEditReply(interaction, {
                content: '❌ Bots cannot be added as extra members. Please pick again:',
                components: memberSelectRow()
            });
        }

        const check = mm.canAddObserver(deal, userId);
        if (!check.ok) {
            const hint =
                check.reason === 'principal'
                    ? '❌ They are already a deal participant (buyer/seller) — no need to add them.'
                    : check.reason === 'duplicate'
                      ? '❌ They are already an extra member on this deal.'
                      : `❌ Maximum **${mm.MAX_OBSERVERS}** extra members per deal.`;
            return safeEditReply(interaction, { content: hint, components: memberSelectRow() });
        }

        // Grant channel access (view + chat + attach + read history).
        try {
            await channel.permissionOverwrites.edit(userId, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
                AttachFiles: true
            });
        } catch (permErr) {
            console.warn(`⚠️ Failed to grant extra member access ${userId}:`, permErr.message);
            return safeEditReply(interaction, { content: '❌ Failed to add the member. Check the bot\'s permissions (Manage Channels).' });
        }

        // v3.9.38 FIX: RE-READ the fresh deal from disk AFTER the permission
        // await — a state transition (fundin/dispute/etc.) may have been saved
        // during that await. Mutation + setDeal are done on the FRESH object,
        // not the initial snapshot, so a validated transition isn't reverted
        // by a stale write.
        // v3.9.40 FIX: if the fresh-check FAILS after permissionOverwrites.edit
        // succeeded, the user's channel access must be REVOKED best-effort —
        // otherwise the user can enter the channel (permission granted) but is
        // never recorded in deal.observers → a "ghost member": invisible on the
        // Deal Board and impossible to remove via the ➖ button.
        const fresh = mm.getDeal(channel.id);
        if (!fresh || mm.TERMINAL_STATES.has(fresh.state)) {
            await channel.permissionOverwrites.delete(userId).catch(() => {});
            return safeEditReply(interaction, { content: '❌ The deal is already complete — members cannot be changed.' });
        }
        const freshCheck = mm.canAddObserver(fresh, userId);
        if (!freshCheck.ok) {
            const hint =
                freshCheck.reason === 'principal'
                    ? '❌ They are already a deal participant (buyer/seller) — no need to add them.'
                    : freshCheck.reason === 'duplicate'
                      ? '❌ They are already an extra member on this deal.'
                      : `❌ Maximum **${mm.MAX_OBSERVERS}** extra members per deal.`;
            await channel.permissionOverwrites.delete(userId).catch(() => {});
            return safeEditReply(interaction, { content: hint, components: memberSelectRow() });
        }

        mm.addObserver(fresh, userId);
        fresh.history = Array.isArray(fresh.history) ? fresh.history : [];
        fresh.history.push({
            ts: Date.now(),
            event: `👥 Member added: <@${userId}>`,
            fromState: fresh.state,
            toState: fresh.state,
            actorId: interaction.user.id,
            actorTag: interaction.user.tag
        });
        mm.setDeal(channel.id, fresh);

        await refreshBoard(channel, fresh, config);
        await channel
            .send(`👥 <@${userId}> was added to the deal channel by **${interaction.user.tag}** as an **extra member** — view & chat only.`)
            .catch(() => {});
        await logAudit(interaction.client, {
            action: 'MIDMAN_MEMBER_ADD',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Deal <#${fresh.channelId}> — extra member added: <@${userId}>`,
            guildId: fresh.guildId
        }).catch(() => {});

        return safeEditReply(interaction, { content: `✅ <@${userId}> was added to the deal channel as an extra member.` });
    } finally {
        mm.transitionLocks.delete(channel.id);
    }
}

/**
 * ➖ Remove Member button (Deal Board row 2) → shows a dropdown listing the
 * current extra members. The buyer/seller do NOT appear in the list (they
 * can't be removed — their way out is cancel/dispute).
 */
async function showRemoveMemberSelect(interaction) {
    const config = getConfig();
    const deal = mm.getDeal(interaction.channel?.id);
    const blocked = memberGuard(deal, interaction, config);
    if (blocked) {
        return interaction.reply({ content: blocked, flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    const observers = Array.isArray(deal.observers) ? deal.observers : [];
    if (observers.length === 0) {
        return interaction
            .reply({ content: 'ℹ️ There are no extra members on this deal.', flags: MessageFlags.Ephemeral })
            .catch(() => {});
    }

    const options = observers.slice(0, 25).map(id => {
        const m = interaction.guild?.members?.cache?.get(id);
        const label = m ? (m.displayName || m.user?.username || id) : `Member ${id}`;
        const option = { label: String(label).slice(0, 100), value: id };
        if (!m) option.description = 'no longer on this server';
        return option;
    });
    const select = new StringSelectMenuBuilder()
        .setCustomId('mm_remove_pick')
        .setPlaceholder('Select the member to remove…')
        .addOptions(options);

    return interaction
        .reply({
            content: '➖ Select the **extra member** to remove from the deal channel (the buyer/seller cannot be removed):',
            components: [new ActionRowBuilder().addComponents(select)],
            flags: MessageFlags.Ephemeral
        })
        .catch(() => {});
}

/**
 * mm_remove_pick dropdown submit: defensive re-check (the target is not a
 * participant and is actually an observer) → delete the permission overwrite →
 * record history + audit → refresh the Deal Board.
 */
async function handleRemovePick(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const config = getConfig();
    const channel = interaction.channel;

    const deal = mm.getDeal(channel?.id);
    const blocked = memberGuard(deal, interaction, config);
    if (blocked) {
        return safeEditReply(interaction, { content: blocked });
    }

    // v3.9.38 FIX: the same per-deal lock as handleEvent (mirrors
    // handlePickMember) — without it, a stale observer write could overwrite
    // a state transition saved during the permissionOverwrites await.
    if (mm.transitionLocks.has(channel.id)) {
        return safeEditReply(interaction, { content: '⏳ The deal is being processed, please try again shortly.' });
    }

    const userId = interaction.values && interaction.values[0];
    if (!userId) {
        return safeEditReply(interaction, { content: '❌ No member selected. Please try again.' });
    }
    // Defensive: the dropdown value comes from the observer list, but the guard
    // still re-runs (customIds can be forged / data may have changed since the
    // dropdown was rendered).
    if (userId === deal.buyerId || userId === deal.sellerId) {
        return safeEditReply(interaction, {
            content: '❌ The buyer/seller cannot be removed — their way out is cancelling the deal / opening a dispute.'
        });
    }
    if (!(Array.isArray(deal.observers) ? deal.observers : []).includes(userId)) {
        return safeEditReply(interaction, { content: '❌ That user is not an extra member on this deal.' });
    }

    mm.transitionLocks.add(channel.id);
    try {
        // Delete their access overwrite (if the overwrite is missing → the
        // error is ignored, the meta stays clean).
        try {
            await channel.permissionOverwrites.delete(userId);
        } catch (_) {}

        // v3.9.38 FIX: RE-READ the fresh deal from disk AFTER the permission await —
        // mutate + setDeal on the FRESH object so a state transition saved during
        // the await isn't reverted by a stale write (mirrors handlePickMember).
        const fresh = mm.getDeal(channel.id);
        if (!fresh || mm.TERMINAL_STATES.has(fresh.state)) {
            return safeEditReply(interaction, { content: '❌ The deal is already complete — members cannot be changed.' });
        }
        if (userId === fresh.buyerId || userId === fresh.sellerId) {
            return safeEditReply(interaction, {
                content: '❌ The buyer/seller cannot be removed — their way out is cancelling the deal / opening a dispute.'
            });
        }
        if (!mm.removeObserver(fresh, userId)) {
            return safeEditReply(interaction, { content: '❌ That user is not an extra member on this deal.' });
        }

        // v3.9.37: corrupted history guard (mirrors the event handler & add-member
        // guard — a manually edited deals.json may lack the history array).
        fresh.history = Array.isArray(fresh.history) ? fresh.history : [];
        fresh.history.push({
            ts: Date.now(),
            event: `👋 Member removed: <@${userId}>`,
            fromState: fresh.state,
            toState: fresh.state,
            actorId: interaction.user.id,
            actorTag: interaction.user.tag
        });
        mm.setDeal(channel.id, fresh);

        await refreshBoard(channel, fresh, config);
        await channel
            .send(`👋 <@${userId}> was removed from the deal channel by **${interaction.user.tag}**.`)
            .catch(() => {});
        await logAudit(interaction.client, {
            action: 'MIDMAN_MEMBER_REMOVE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Deal <#${fresh.channelId}> — extra member removed: <@${userId}>`,
            guildId: fresh.guildId
        }).catch(() => {});

        return safeEditReply(interaction, { content: `✅ <@${userId}> was removed from the deal channel.` });
    } finally {
        mm.transitionLocks.delete(channel.id);
    }
}

// ====================================================
// === DOMAIN HANDLER ENTRY (called by the router) ===
// ====================================================

module.exports = async function midmanDomain(interaction) {
    // Ticket panel → midman category button → open the create-deal modal.
    if (interaction.isButton() && interaction.customId === 'ticket_cat:midman') {
        return openCreateModal(interaction);
    }

    // Create-deal modal submit (step 1: item + price).
    if (interaction.isModalSubmit() && interaction.customId === 'modal_mm_create') {
        return handleCreateDeal(interaction);
    }

    // Step 2: pick the buyer (user select menu — searchable).
    if (interaction.isUserSelectMenu() && interaction.customId === 'mm_pick_buyer') {
        return handlePickBuyer(interaction);
    }

    // Step 3: pick the seller (user select menu — searchable) → create the deal.
    if (interaction.isUserSelectMenu() && interaction.customId === 'mm_pick_seller') {
        return handlePickSeller(interaction);
    }

    // v3.9.34: manage extra members inside the deal channel.
    if (interaction.isButton() && interaction.customId === 'mm_add_member') {
        return showAddMemberSelect(interaction);
    }
    if (interaction.isButton() && interaction.customId === 'mm_remove_member') {
        return showRemoveMemberSelect(interaction);
    }
    if (interaction.isUserSelectMenu() && interaction.customId === 'mm_pick_member') {
        return handlePickMember(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'mm_remove_pick') {
        return handleRemovePick(interaction);
    }

    // All state transition buttons.
    if (interaction.isButton()) {
        const eventMap = {
            mm_join: 'join',
            mm_cancel: 'cancel',
            mm_fundin: 'fundin',
            mm_received: 'received',
            mm_release: 'release',
            mm_dispute: 'dispute',
            mm_resolve_release: 'resolve_release',
            mm_resolve_refund: 'resolve_refund'
        };
        const event = eventMap[interaction.customId];
        if (event) return handleEvent(interaction, event);
    }

    // Fallback: unhandled mm_* customIds (defensive observability).
    console.warn(`[midman] Unrecognized customId: ${interaction.customId}`);
};

// Used by ticket.js when the user picks the "midman" category via the panel
// dropdown (ticket_cat_select sends the category value; the router can't
// intercept it).
module.exports.openCreateModal = openCreateModal;

