/**
 * Midman/Rekber command domain — admin slash commands for the escrow feature.
 * v3.9.33.
 *
 * Commands:
 *   - /set-midman-fee : set the escrow fee (a percentage of the deal price or a flat amount)
 *   - /midman-deals   : view all active escrow deals on the server
 *
 * The fee is stored in config (midman.feeMode + midman.feeValue) and computed
 * AUTOMATICALLY when a deal is created — a middleman can't set arbitrary
 * per-deal fees (anti-manipulation). /set-midman-fee is admin-only.
 *
 * v3.9.33 — ADDITIVE fee model: the fee is ADDED on top of the price, not deducted
 * from the seller's funds. Example: price 100.000 + 5% fee (5.000) → the buyer
 * transfers 105.000, the seller receives the FULL 100.000, the middleman keeps 5.000.
 */

const { MessageFlags, EmbedBuilder } = require('discord.js');
const { setField, safeEditReply, logAudit } = require('./_shared');
const mm = require('../data/midmanManager');

module.exports = async function (interaction) {
    // === SET MIDMAN FEE ===
    if (interaction.commandName === 'set-midman-fee') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const mode = interaction.options.getString('mode');
        const value = interaction.options.getNumber('value');

        // Validation: percentage fee max 90% (sanity — so the buyer's total
        // doesn't balloon wildly from a typo); flat fee is free-form
        // but cannot be negative. 0 = free (promo).
        if (value === null || value < 0) {
            return safeEditReply(interaction, { content: '❌ Fee cannot be negative.' });
        }
        if (mode === 'percent' && value > 90) {
            return safeEditReply(interaction, {
                content: '❌ Percentage fee is capped at **90%** of the deal price (sanity guard — double-check the value).'
            });
        }
        if (mode === 'flat' && value > 1000000000000) {
            return safeEditReply(interaction, { content: '❌ That fee amount is unreasonable.' });
        }

        setField('midman.feeMode', mode);
        setField('midman.feeValue', value);

        await logAudit(interaction.client, {
            action: 'SET_MIDMAN_FEE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Escrow fee changed: mode **${mode}**, value **${value}**`,
            guildId: interaction.guild.id
        });

        // An example so the admin can immediately picture the outcome (v3.9.33: additive fee)
        const examplePrice = 100000;
        const exampleFee = mm.calcFee(examplePrice, mode, value);
        const exampleTotals = mm.calcTotals(examplePrice, exampleFee);
        const feeLabel = mode === 'percent' ? `**${value}%** of the deal price` : `**${mm.formatRupiah(value)}** flat per deal`;
        return safeEditReply(interaction, {
            content:
                `✅ Escrow fee set: ${feeLabel} — the fee is **ADDED on top of the price** (not deducted from the seller's funds).\n` +
                `💡 Example: a **${mm.formatRupiah(examplePrice)}** deal → fee **${mm.formatRupiah(exampleTotals.midmanKeeps)}** → the buyer transfers **${mm.formatRupiah(exampleTotals.buyerPays)}**, the seller receives **${mm.formatRupiah(exampleTotals.sellerGets)}** (in full).\n` +
                `The fee applies to NEW deals (in-flight deals keep the fee from when they were created).`
        });
    }

    // === MIDMAN DEALS (list active) ===
    if (interaction.commandName === 'midman-deals') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const deals = mm.getActiveDealsByGuild(interaction.guild.id);
        if (deals.length === 0) {
            return safeEditReply(interaction, { content: '✅ No active escrow deals on this server.' });
        }

        const lines = deals.slice(0, 25).map(d => {
            const stateLabel = mm.STATES[d.state]?.label || d.state;
            const age = d.createdAt ? Math.floor((Date.now() - d.createdAt) / 3600000) : 0; // hours
            // v3.9.33: show the total the buyer pays (price + fee).
            const totals = mm.calcTotals(d.priceNum, d.fee);
            return (
                `<#${d.channelId}> — **${stateLabel}**\n` +
                `┣ 🛒 <@${d.buyerId}> ⇄ 🏷️ <@${d.sellerId}>\n` +
                `┗ 📦 ${String(d.item).slice(0, 60)} • ${mm.formatRupiah(totals.buyerPays)} (price ${mm.formatRupiah(totals.sellerGets)} + fee ${mm.formatRupiah(totals.midmanKeeps)}) • ${age}h ago`
            );
        });

        const embed = new EmbedBuilder()
            .setTitle(`🤝 Active Escrow Deals — ${deals.length} deal(s)`)
            .setDescription(lines.join('\n\n').slice(0, 4000))
            .setColor(0x2ecc71)
            .setFooter({ text: `Source: data/deals.json • ${interaction.client.user.username}` })
            .setTimestamp();

        return safeEditReply(interaction, {
            content: deals.length > 25 ? '⚠️ Showing the first 25 deals (there are more).' : undefined,
            embeds: [embed]
        });
    }
};
