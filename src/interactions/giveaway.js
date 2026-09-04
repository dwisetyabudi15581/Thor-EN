/**
 * Giveaway domain handler — button `gw_join:*` & `gw_leave:*`.
 *
 * Di-ekstrak dari handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior dipertahankan apa adanya — hanya pindah file.
 *
 * Helper `handleGiveawayButton` dan `updateGiveawayMessage` jadi LOCAL
 * function di file ini.
 *
 * Router (src/interactions/index.js) sudah apply:
 *   - dedup (checkAndMark)
 *   - guard `replied/deferred`
 *   - cek tipe interaction (button/select/modal)
 *   - routing by customId prefix
 * Jadi domain handler fokus ke logic-nya saja.
 */

const { EmbedBuilder, MessageFlags } = require('discord.js');
const { withUserLock } = require('../commands/_shared');
// addParticipant / removeParticipant tidak di-export _shared, import langsung.
const {
    get: getGiveaway,
    addParticipant: gwAddParticipant,
    removeParticipant: gwRemoveParticipant
} = require('../data/giveawayManager');

module.exports = async function (interaction) {
    // ====================================================
    // === GIVEAWAY: JOIN / LEAVE BUTTONS ===
    // ====================================================
    if (
        interaction.isButton() &&
        (interaction.customId.startsWith('gw_join:') || interaction.customId.startsWith('gw_leave:'))
    ) {
        return handleGiveawayButton(interaction);
    }
};

// ====================================================
// === HELPER: GIVEAWAY JOIN / LEAVE BUTTON HANDLER ===
// ====================================================
async function handleGiveawayButton(interaction) {
    try {
        const [action, gwId] = interaction.customId.split(':');
        const gw = getGiveaway(gwId);
        if (!gw) {
            return interaction.reply({
                content: '❌ Giveaway tidak ditemukan (mungkin sudah dihapus).',
                flags: MessageFlags.Ephemeral
            });
        }
        if (gw.ended) {
            return interaction.reply({ content: '❌ Giveaway sudah berakhir.', flags: MessageFlags.Ephemeral });
        }
        if (gw.guildId !== interaction.guild.id) {
            return interaction.reply({
                content: '❌ Giveaway ini bukan dari guild ini.',
                flags: MessageFlags.Ephemeral
            });
        }

        // Cek required role — HANYA untuk join.
        // v3.9.24 FIX: sebelumnya cek ini juga berlaku untuk LEAVE, jadi member
        // yang kehilangan required role TIDAK BISA keluar dari giveaway (stuck).
        if (gw.requiredRoleId && action === 'gw_join') {
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            if (!member || !member.roles.cache.has(gw.requiredRoleId)) {
                const role = interaction.guild.roles.cache.get(gw.requiredRoleId);
                return interaction.reply({
                    content: `❌ Kamu harus punya role ${role || '`' + gw.requiredRoleId + '`'} untuk ikut giveaway ini.`,
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        // v3.9.2 FIX: wrap join/leave dalam per-user lock untuk mencegah
        // TOCTOU race condition. Sebelumnya, 2 klik cepat (<100ms) bisa
        // lolos cek `includes()` keduanya, lalu keduanya push userId →
        // participant dobel. Lock memaksa klik kedua nunggu klik pertama
        // selesai (di mana save() sudah menulis data terbaru ke disk).
        const lockResult = await withUserLock('gw', interaction.user.id, async () => {
            // Refresh gw dari disk di dalam lock supaya baca data terbaru
            const gwFresh = getGiveaway(gwId);
            if (!gwFresh) return { type: 'notfound' };
            if (gwFresh.ended) return { type: 'ended' };

            // JOIN
            if (action === 'gw_join') {
                if (gwFresh.participantIds.includes(interaction.user.id)) {
                    return { type: 'already_joined' };
                }
                const updated = gwAddParticipant(gwId, interaction.user.id);
                await updateGiveawayMessage(interaction, updated);
                return { type: 'joined', total: updated.participantIds.length };
            }

            // LEAVE
            if (action === 'gw_leave') {
                if (!gwFresh.participantIds.includes(interaction.user.id)) {
                    return { type: 'not_joined' };
                }
                const updated = gwRemoveParticipant(gwId, interaction.user.id);
                await updateGiveawayMessage(interaction, updated);
                return { type: 'left' };
            }
            return { type: 'noop' };
        });

        if (lockResult === null) {
            // Lock gagal acquire — user klik terlalu cepat
            return interaction.reply({
                content: '⏳ Tunggu sebentar, kamu lagi klik terlalu cepat. Coba lagi dalam 1 detik.',
                flags: MessageFlags.Ephemeral
            });
        }

        switch (lockResult.type) {
            case 'notfound':
                return interaction.reply({
                    content: '❌ Giveaway tidak ditemukan (mungkin sudah dihapus).',
                    flags: MessageFlags.Ephemeral
                });
            case 'ended':
                return interaction.reply({ content: '❌ Giveaway sudah berakhir.', flags: MessageFlags.Ephemeral });
            case 'already_joined':
                return interaction.reply({
                    content: 'ℹ️ Kamu sudah join giveaway ini.',
                    flags: MessageFlags.Ephemeral
                });
            case 'not_joined':
                return interaction.reply({
                    content: 'ℹ️ Kamu belum join giveaway ini.',
                    flags: MessageFlags.Ephemeral
                });
            case 'joined':
                return interaction.reply({
                    content: `✅ Kamu join giveaway **${gw.prize}**! 🎉\n👥 Total peserta: ${lockResult.total}`,
                    flags: MessageFlags.Ephemeral
                });
            case 'left':
                return interaction.reply({
                    content: `🚪 Kamu keluar dari giveaway **${gw.prize}**.`,
                    flags: MessageFlags.Ephemeral
                });
            default:
                return interaction.reply({
                    content: '❌ Tidak ada aksi yang dilakukan.',
                    flags: MessageFlags.Ephemeral
                });
        }
    } catch (err) {
        console.error('Giveaway button error:', err);
        if (interaction.isRepliable() && !interaction.replied) {
            await interaction.reply({ content: '❌ Terjadi error.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }
}

async function updateGiveawayMessage(interaction, gw) {
    try {
        const channel = interaction.guild.channels.cache.get(gw.channelId);
        if (!channel) return;
        const msg = await channel.messages.fetch(gw.messageId).catch(() => null);
        if (!msg) return;

        const timeLeft = gw.endsAt - Date.now();
        const embed = new EmbedBuilder()
            .setTitle('🎉 GIVEAWAY!')
            .setDescription(
                `🎁 **Prize:** ${gw.prize}\n\n` +
                    `👥 **Pemenang:** ${gw.winnersCount}\n` +
                    `⏰ **Berakhir:** <t:${Math.floor(gw.endsAt / 1000)}:R> (<t:${Math.floor(gw.endsAt / 1000)}:F>)\n` +
                    `🎟️ **Peserta:** ${gw.participantIds.length}\n` +
                    (gw.requiredRoleId ? `🔐 **Syarat:** <@&${gw.requiredRoleId}>\n` : '') +
                    `\n👇 Klik tombol **🎉 Join** di bawah untuk ikut!`
            )
            .setColor(timeLeft < 60000 ? 0xe67e22 : 0xf1c40f)
            .setFooter({ text: `Host: ${gw.hostTag} | ID: ${gw.id}` })
            .setTimestamp();
        await msg.edit({ embeds: [embed] });
    } catch (err) {
        console.warn('Gagal update giveaway message:', err.message);
    }
}
