/**
 * Midman/Rekber command domain — slash commands admin untuk fitur rekber.
 * v3.9.33.
 *
 * Commands:
 *   - /set-midman-fee : atur fee rekber (persen dari harga deal atau nominal flat)
 *   - /midman-deals   : lihat semua deal rekber aktif di server
 *
 * Fee disimpan di config (midman.feeMode + midman.feeValue) dan dihitung
 * OTOMATIS saat deal dibuat — midman tidak bisa memasang fee sembarangan
 * per deal (anti manipulasi). /set-midman-fee hanya bisa dipakai admin.
 *
 * v3.9.33 — model fee ADDITIVE: fee DITAMBAH di atas harga, bukan dipotong
 * dari dana penjual. Contoh: harga 100.000 + fee 5% (5.000) → pembeli
 * transfer 105.000, penjual menerima 100.000 PENUH, midman menyimpan 5.000.
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

        // Validasi: fee persen maks 90% (sanity — biar total yang dibayar
        // pembeli tidak membengkak gila karena salah ketik), fee flat bebas
        // tapi tidak boleh negatif. 0 = gratis (promo).
        if (value === null || value < 0) {
            return safeEditReply(interaction, { content: '❌ Fee tidak boleh negatif.' });
        }
        if (mode === 'percent' && value > 90) {
            return safeEditReply(interaction, {
                content: '❌ Fee persen maksimal **90%** dari harga deal (sanity guard — cek lagi nilainya).'
            });
        }
        if (mode === 'flat' && value > 1000000000000) {
            return safeEditReply(interaction, { content: '❌ Nominal fee tidak masuk akal.' });
        }

        setField('midman.feeMode', mode);
        setField('midman.feeValue', value);

        await logAudit(interaction.client, {
            action: 'SET_MIDMAN_FEE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Fee rekber diubah: mode **${mode}**, nilai **${value}**`,
            guildId: interaction.guild.id
        });

        // Contoh biar admin langsung kebayang hasilnya (v3.9.33: fee additive)
        const examplePrice = 100000;
        const exampleFee = mm.calcFee(examplePrice, mode, value);
        const exampleTotals = mm.calcTotals(examplePrice, exampleFee);
        const feeLabel = mode === 'percent' ? `**${value}%** dari harga deal` : `**${mm.formatRupiah(value)}** flat per deal`;
        return safeEditReply(interaction, {
            content:
                `✅ Fee rekber diatur: ${feeLabel} — fee **DITAMBAH di atas harga** (tidak dipotong dari dana penjual).\n` +
                `💡 Contoh: deal **${mm.formatRupiah(examplePrice)}** → fee **${mm.formatRupiah(exampleTotals.midmanKeeps)}** → pembeli transfer **${mm.formatRupiah(exampleTotals.buyerPays)}**, penjual menerima **${mm.formatRupiah(exampleTotals.sellerGets)}** (penuh).\n` +
                `Fee berlaku untuk deal BARU (deal berjalan tetap pakai fee saat deal dibuat).`
        });
    }

    // === MIDMAN DEALS (list aktif) ===
    if (interaction.commandName === 'midman-deals') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const deals = mm.getActiveDealsByGuild(interaction.guild.id);
        if (deals.length === 0) {
            return safeEditReply(interaction, { content: '✅ Tidak ada deal rekber aktif di server ini.' });
        }

        const lines = deals.slice(0, 25).map(d => {
            const stateLabel = mm.STATES[d.state]?.label || d.state;
            const age = d.createdAt ? Math.floor((Date.now() - d.createdAt) / 3600000) : 0; // jam
            // v3.9.33: tampil total yang dibayar pembeli (harga + fee).
            const totals = mm.calcTotals(d.priceNum, d.fee);
            return (
                `<#${d.channelId}> — **${stateLabel}**\n` +
                `┣ 🛒 <@${d.buyerId}> ⇄ 🏷️ <@${d.sellerId}>\n` +
                `┗ 📦 ${String(d.item).slice(0, 60)} • ${mm.formatRupiah(totals.buyerPays)} (harga ${mm.formatRupiah(totals.sellerGets)} + fee ${mm.formatRupiah(totals.midmanKeeps)}) • ${age} jam lalu`
            );
        });

        const embed = new EmbedBuilder()
            .setTitle(`🤝 Deal Rekber Aktif — ${deals.length} deal`)
            .setDescription(lines.join('\n\n').slice(0, 4000))
            .setColor(0x2ecc71)
            .setFooter({ text: `Sumber: data/deals.json • ${interaction.client.user.username}` })
            .setTimestamp();

        return safeEditReply(interaction, {
            content: deals.length > 25 ? '⚠️ Menampilkan 25 deal pertama (ada lebih banyak).' : undefined,
            embeds: [embed]
        });
    }
};
