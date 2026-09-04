/**
 * Domain: stats
 * Slash commands: /stats, /leaderboard, /my-stats
 *
 * Dipisah dari handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: statistik server + leaderboard + statistik pribadi.
 *
 * v3.9.4: scoped per guild — sebelumnya tidak terfilter.
 *
 * Catatan: permission check untuk /leaderboard & /my-stats (public command)
 *          ada di router (src/commands/index.js). Domain file ini tidak perlu
 *          repeat check tersebut.
 */

const {
    EmbedBuilder,
    MessageFlags,
    getUserStats,
    getTopUsersStats,
    getServerStatsAll,
    safeEditReply
} = require('./_shared');

module.exports = async function (interaction) {
    // ====================================================
    // === /stats ===
    // ====================================================
    if (interaction.commandName === 'stats') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        // v3.9.4: scoped per guild — sebelumnya getServerStats() tidak terfilter.
        const stats = getServerStatsAll(interaction.guild.id);
        const embed = new EmbedBuilder()
            .setTitle('📊 STATISTIK SERVER')
            .setDescription('Statistik agregat seluruh aktivitas member.')
            .setColor(0x5865f2)
            .addFields(
                { name: '👥 Total Member Tracked', value: `${stats.totalUsers}`, inline: true },
                { name: '💬 Total Pesan', value: `${stats.totalMessages.toLocaleString('id-ID')}`, inline: true },
                { name: '🛒 Total Pembelian VIP', value: `${stats.totalPurchases}`, inline: true },
                { name: '💰 Total Revenue', value: `Rp ${stats.totalRevenue.toLocaleString('id-ID')}`, inline: true },
                { name: '🎉 Total Giveaway Won', value: `${stats.totalGiveawaysWon}`, inline: true },
                {
                    name: '📈 Avg Messages/User',
                    value: stats.totalUsers > 0 ? `${Math.round(stats.totalMessages / stats.totalUsers)}` : '0',
                    inline: true
                }
            )
            .setFooter({ text: 'Data dari stats.json — tracking dimulai sejak bot v3.2' })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /leaderboard ===
    // ====================================================
    if (interaction.commandName === 'leaderboard') {
        await interaction.deferReply();
        const metric = interaction.options.getString('metric') || 'messages';
        // v3.9.4: scoped per guild — sebelumnya getTopUsers() tidak terfilter.
        const top = getTopUsersStats(interaction.guild.id, metric, 10);
        if (top.length === 0) {
            return safeEditReply(interaction, { content: '📭 Belum ada data leaderboard untuk metric ini.' });
        }

        const metricLabels = {
            messages: '💬 Pesan Terbanyak',
            vipPurchases: '🛒 Top Buyer (jumlah transaksi)',
            totalSpent: '💰 Top Spender (total belanja)',
            giveawaysWon: '🎉 Top Winner (giveaway)'
        };
        const metricFormat = {
            messages: v => `${v.toLocaleString('id-ID')} pesan`,
            vipPurchases: v => `${v} transaksi`,
            totalSpent: v => `Rp ${v.toLocaleString('id-ID')}`,
            giveawaysWon: v => `${v} menang`
        };

        const medals = ['🥇', '🥈', '🥉'];
        const lines = top
            .map((u, i) => {
                const medal = medals[i] || `**${i + 1}.**`;
                return `${medal} <@${u.userId}> — ${metricFormat[metric](u.value)}`;
            })
            .join('\n');

        const embed = new EmbedBuilder()
            .setTitle(`🏆 LEADERBOARD — ${metricLabels[metric]}`)
            .setDescription(`Top ${top.length} member berdasarkan **${metricLabels[metric]}**.\n\n${lines}`)
            .setColor(0xf1c40f)
            .setFooter({ text: 'Tracking sejak bot v3.2 | Update tiap aktivitas' })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /my-stats ===
    // ====================================================
    if (interaction.commandName === 'my-stats') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        // v3.9.4: scoped per guild — sebelumnya getStats() tidak terfilter.
        const stats = getUserStats(interaction.guild.id, interaction.user.id);
        const embed = new EmbedBuilder()
            .setTitle(`📊 STATS — ${interaction.user.tag}`)
            .setDescription('Statistik aktivitas kamu di server ini.')
            .setColor(0x57f287)
            .addFields(
                { name: '💬 Pesan', value: `${stats.messages.toLocaleString('id-ID')}`, inline: true },
                { name: '🛒 Pembelian VIP', value: `${stats.vipPurchases}`, inline: true },
                { name: '💰 Total Belanja', value: `Rp ${stats.totalSpent.toLocaleString('id-ID')}`, inline: true },
                { name: '🎉 Giveaway Won', value: `${stats.giveawaysWon}`, inline: true },
                {
                    name: '📅 Joined Tracking',
                    value: stats.joinedAt ? `<t:${Math.floor(stats.joinedAt / 1000)}:R>` : 'belum tercatat',
                    inline: true
                },
                {
                    name: '🕐 Pesan Terakhir',
                    value: stats.lastMessageAt ? `<t:${Math.floor(stats.lastMessageAt / 1000)}:R>` : 'belum pernah',
                    inline: true
                }
            )
            .setFooter({ text: 'Cek posisi di leaderboard pakai /leaderboard' })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }
};
