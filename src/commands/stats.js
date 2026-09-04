/**
 * Domain: stats
 * Slash commands: /stats, /leaderboard, /my-stats
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: server stats + leaderboard + personal stats.
 *
 * v3.9.4: scoped per guild — previously unfiltered.
 *
 * Note: the permission check for /leaderboard & /my-stats (public commands)
 *          lives in the router (src/commands/index.js). This domain file doesn't
 *          need to repeat that check.
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
        // v3.9.4: scoped per guild — previously getServerStats() was unfiltered.
        const stats = getServerStatsAll(interaction.guild.id);
        const embed = new EmbedBuilder()
            .setTitle('📊 SERVER STATS')
            .setDescription('Aggregate stats of all member activity.')
            .setColor(0x5865f2)
            .addFields(
                { name: '👥 Total Member Tracked', value: `${stats.totalUsers}`, inline: true },
                { name: '💬 Total Messages', value: `${stats.totalMessages.toLocaleString('en-US')}`, inline: true },
                { name: '🛒 Total VIP Purchases', value: `${stats.totalPurchases}`, inline: true },
                { name: '💰 Total Revenue', value: `Rp ${stats.totalRevenue.toLocaleString('en-US')}`, inline: true },
                { name: '🎉 Total Giveaway Won', value: `${stats.totalGiveawaysWon}`, inline: true },
                {
                    name: '📈 Avg Messages/User',
                    value: stats.totalUsers > 0 ? `${Math.round(stats.totalMessages / stats.totalUsers)}` : '0',
                    inline: true
                }
            )
            .setFooter({ text: 'Data from stats.json — tracking since bot v3.2' })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /leaderboard ===
    // ====================================================
    if (interaction.commandName === 'leaderboard') {
        await interaction.deferReply();
        const metric = interaction.options.getString('metric') || 'messages';
        // v3.9.4: scoped per guild — previously getTopUsers() was unfiltered.
        const top = getTopUsersStats(interaction.guild.id, metric, 10);
        if (top.length === 0) {
            return safeEditReply(interaction, { content: '📭 No leaderboard data for this metric yet.' });
        }

        const metricLabels = {
            messages: '💬 Most Messages',
            vipPurchases: '🛒 Top Buyer (transaction count)',
            totalSpent: '💰 Top Spender (total spent)',
            giveawaysWon: '🎉 Top Winner (giveaways)'
        };
        const metricFormat = {
            messages: v => `${v.toLocaleString('en-US')} messages`,
            vipPurchases: v => `${v} transactions`,
            totalSpent: v => `Rp ${v.toLocaleString('en-US')}`,
            giveawaysWon: v => `${v} wins`
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
            .setDescription(`Top ${top.length} members by **${metricLabels[metric]}**.\n\n${lines}`)
            .setColor(0xf1c40f)
            .setFooter({ text: 'Tracking since bot v3.2 | Updated on every activity' })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /my-stats ===
    // ====================================================
    if (interaction.commandName === 'my-stats') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        // v3.9.4: scoped per guild — previously getStats() was unfiltered.
        const stats = getUserStats(interaction.guild.id, interaction.user.id);
        const embed = new EmbedBuilder()
            .setTitle(`📊 STATS — ${interaction.user.tag}`)
            .setDescription('Your activity stats on this server.')
            .setColor(0x57f287)
            .addFields(
                { name: '💬 Messages', value: `${stats.messages.toLocaleString('en-US')}`, inline: true },
                { name: '🛒 VIP Purchases', value: `${stats.vipPurchases}`, inline: true },
                { name: '💰 Total Spent', value: `Rp ${stats.totalSpent.toLocaleString('en-US')}`, inline: true },
                { name: '🎉 Giveaway Won', value: `${stats.giveawaysWon}`, inline: true },
                {
                    name: '📅 Joined Tracking',
                    value: stats.joinedAt ? `<t:${Math.floor(stats.joinedAt / 1000)}:R>` : 'not recorded',
                    inline: true
                },
                {
                    name: '🕐 Last Message',
                    value: stats.lastMessageAt ? `<t:${Math.floor(stats.lastMessageAt / 1000)}:R>` : 'never',
                    inline: true
                }
            )
            .setFooter({ text: 'Check your leaderboard position with /leaderboard' })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }
};
