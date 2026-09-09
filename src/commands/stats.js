/**
 * Domain: stats
 * Slash commands: /stats, /leaderboard, /my-stats
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: server stats + leaderboard + personal stats.
 *
 * v3.9.4: scoped per guild — previously unfiltered.
 *
 * v3.9.47 (user report: "stats don't match"): /stats used to show ONLY the
 * numbers accumulated in stats.json — "Total Member Tracked" (only members the
 * bot has recorded, ≠ the real member count), "Total VIP Purchases" (label said
 * VIP, but it counts ALL transactions: ticket orders + escrow deals), and no
 * live server data at all — so the embed rarely matched what the admin sees in
 * Discord. Now /stats leads with LIVE data straight from Discord (real member
 * count, boost tier + count, open tickets) followed by clearly-labeled tracked
 * activity, and /my-stats shows the REAL join date from the member object
 * (guildMemberAdd tracking only records joins since v3.2 — older members showed
 * "not recorded" even though Discord knows their join date).
 *
 * v3.9.49 (user report: "member tracked & member live — if they do the same
 * thing, make it one"): the duplicate member fields are GONE — ONE "Members"
 * field (the live count straight from Discord). "Avg Messages/Member" now
 * divides by the LIVE member count too, so the number matches what the embed
 * shows. v3.9.49 also fixes WHY "total revenue doesn't update": Indonesian
 * price suffixes ("25rb"/"2jt") were mis-parsed to near-zero amounts, and
 * unparseable product prices were accepted silently (see products.js +
 * statsManager.parsePrice).
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

// v3.9.47: live "open tickets" counter for the /stats overview.
const { getActiveTicketCount } = require('../data/ticketManager');

// v3.9.49: /boosters — live booster list + tracked history. The embed is built
// in boostHandler (single source of truth — same builders the live event uses).
const { buildBoostersEmbed } = require('../bot/boostHandler');
const { getRecentEvents: getRecentBoostEvents } = require('../data/boostManager');

module.exports = async function (interaction) {
    // ====================================================
    // === /stats ===
    // ====================================================
    if (interaction.commandName === 'stats') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        // v3.9.4: scoped per guild — previously getServerStats() was unfiltered.
        const stats = getServerStatsAll(interaction.guild.id);

        // v3.9.47: LIVE server data from the guild object (always current —
        // no cache, no tracking gaps). This is the part the admin can verify
        // against Discord itself: real member count, boosts, open tickets.
        const guild = interaction.guild;
        const liveMembers = guild.memberCount;
        const activeTickets = getActiveTicketCount(guild.id);
        const boostText =
            guild.premiumTier && guild.premiumTier > 0
                ? `Level ${guild.premiumTier} (${guild.premiumSubscriptionCount ?? 0} boosts)`
                : 'None';

        const embed = new EmbedBuilder()
            .setTitle(`📊 SERVER STATS — ${guild.name}`)
            .setDescription('Live server data from Discord + member activity tracked by the bot.')
            .setColor(0x5865f2)
            .addFields(
                // Row 1 — live data (verifiable in Discord at any moment)
                { name: '👥 Members', value: `${liveMembers}`, inline: true },
                { name: '🎫 Open Tickets', value: `${activeTickets}`, inline: true },
                { name: '🚀 Server Boosts', value: boostText, inline: true },
                // Row 2 — tracked activity (from stats.json, since v3.2)
                { name: '💬 Messages Tracked', value: `${stats.totalMessages.toLocaleString('en-US')}`, inline: true },
                {
                    name: '📈 Avg Messages/Member',
                    value: liveMembers > 0 ? `${Math.round(stats.totalMessages / liveMembers)}` : '0',
                    inline: true
                },
                { name: '🎁 Giveaways Won', value: `${stats.totalGiveawaysWon}`, inline: true },
                // Row 3 — tracked transactions (ticket orders + escrow deals)
                { name: '🛒 Transactions', value: `${stats.totalPurchases}`, inline: true },
                { name: '💰 Total Revenue', value: `Rp ${stats.totalRevenue.toLocaleString('en-US')}`, inline: true }
            )
            .setFooter({
                text: 'Members/boosts/tickets = live from Discord • messages & transactions tracked since v3.2 • revenue = ticket + escrow sales'
            })
            .setTimestamp();
        // v3.9.47: server icon when available (personal touch, null-safe).
        const icon = typeof guild.iconURL === 'function' ? guild.iconURL() : null;
        if (icon) embed.setThumbnail(icon);
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /boosters (v3.9.49) ===
    // ====================================================
    if (interaction.commandName === 'boosters') {
        await interaction.deferReply();
        const guild = interaction.guild;

        // Fetch the full member list so premiumSinceTimestamp is accurate for
        // EVERY member (the cache only holds members the bot has seen since the
        // last restart). GuildMembers intent is required — an online bot proves
        // it is enabled. Fallback: the cache (with a warning in the console).
        try {
            await guild.members.fetch();
        } catch (err) {
            console.warn(
                `⚠️ /boosters: could not fetch the full member list (${err.message}) — using the in-memory cache instead. `
            );
        }

        const boosters = [...guild.members.cache.values()]
            .filter(m => !m.user?.bot && m.premiumSinceTimestamp)
            .sort((a, b) => (a.premiumSinceTimestamp || 0) - (b.premiumSinceTimestamp || 0));

        const recent = getRecentBoostEvents(guild.id, 5);
        const embed = buildBoostersEmbed(guild, boosters, recent);
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

        // v3.9.47: the REAL join date comes from the Discord member object
        // (always accurate, works for members who joined before v3.2 tracking).
        // stats.joinedAt is only a fallback for exotic cases (e.g. partial member).
        const realJoinedTs = interaction.member?.joinedTimestamp ?? stats.joinedAt;

        const embed = new EmbedBuilder()
            .setTitle(`📊 STATS — ${interaction.user.tag}`)
            .setDescription('Your activity stats on this server.')
            .setColor(0x57f287)
            .addFields(
                { name: '💬 Messages', value: `${stats.messages.toLocaleString('en-US')}`, inline: true },
                { name: '🛒 Transactions', value: `${stats.vipPurchases}`, inline: true },
                { name: '💰 Total Spent', value: `Rp ${stats.totalSpent.toLocaleString('en-US')}`, inline: true },
                { name: '🎉 Giveaway Won', value: `${stats.giveawaysWon}`, inline: true },
                {
                    name: '📅 Joined This Server',
                    value: realJoinedTs ? `<t:${Math.floor(realJoinedTs / 1000)}:R>` : 'unknown',
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
