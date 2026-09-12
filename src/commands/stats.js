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
 * shows.
 *
 * v3.9.51 (user request: "just delete the total revenue feature — I don't
 * really use it"): the "Total Revenue" field is REMOVED from /stats. The
 * aggregate revenue number caused repeated confusion (v3.9.47/49/50 were all
 * about it not matching) and the user doesn't use it — /stats now shows the
 * live server data + tracked activity WITHOUT any revenue line. Personal
 * spending stats stay available where they are per-user and unambiguous:
 * /my-stats "Total Spent" and /leaderboard "Top Spender".
 *
 * v3.9.54 (user request: "the bot will be used by people outside Indonesia
 * too"): spending amounts are now shown WITHOUT the hardcoded "Rp" prefix —
 * the bot is currency-AGNOSTIC and records the numeric amount in whatever
 * currency each server's admin prices their products (see
 * statsManager.parsePrice). Use ONE currency consistently per server.
 *
 * Note: the permission check for /leaderboard & /my-stats (public commands)
 *          lives in the router (src/commands/index.js). This domain file doesn't
 *          need to repeat that check.
 */

const {
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    getUserStats,
    getTopUsersStats,
    getServerStatsAll,
    getConfig,
    safeEditReply
} = require('./_shared');

// v3.9.47: live "open tickets" counter for the /stats overview.
const { getActiveTicketCount } = require('../data/ticketManager');

// v3.9.49: /boosters — live booster list + tracked history. The embed is built
// in boostHandler (single source of truth — same builders the live event uses).
// v3.9.58: /test-booster previews those SAME add/remove builders (no drift).
const { buildBoostersEmbed, buildBoostAddEmbed, buildBoostRemoveEmbed } = require('../bot/boostHandler');
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
                // Row 3 — tracked transactions (ticket orders + escrow deals).
                // v3.9.51: Total Revenue REMOVED (user request — not used).
                { name: '🛒 Transactions', value: `${stats.totalPurchases}`, inline: true }
            )
            .setFooter({
                text: 'Members/boosts/tickets = live from Discord • messages & transactions tracked since v3.2'
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
    // === /test-booster (v3.9.58) ===
    // ====================================================
    // The boost feature's /test-welcome: admins CANNOT simulate a real boost
    // (it costs real money), so this command proves the whole chain works —
    // config → channel exists → bot permissions — and sends a LIVE PREVIEW of
    // the exact embed a real boost sends (the SAME buildBoostAddEmbed /
    // buildBoostRemoveEmbed the live event uses — no drift possible).
    // PURE SIMULATION: nothing is recorded — boost history (/boosters), the
    // server log and the live counters stay untouched, so it is safe to run
    // any time. Optional `live:true` ALSO delivers the preview to the REAL
    // server-booster channel (full end-to-end delivery test).
    if (interaction.commandName === 'test-booster') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe'); // 'add' | 'remove'
        const live = interaction.options.getBoolean('live') === true;
        const guild = interaction.guild;
        const config = getConfig();
        const configuredId = config.channels['server-booster'];
        const me = guild.members.me;

        // --- diagnose every link in the chain (v3.9.48 pattern) ---
        const lines = [];
        let channel = null;
        if (!configuredId) {
            lines.push(`❌ **server-booster channel: not set** → fix with \`/set-channel server-booster #channel\``);
        } else {
            channel = guild.channels.cache.get(configuredId);
            if (!channel) {
                lines.push(
                    `❌ **server-booster channel: not found** (ID \`${configuredId}\`) — deleted, or the ID belongs to another server → re-set with \`/set-channel server-booster #channel\``
                );
            } else {
                lines.push(`✅ **server-booster channel:** ${channel} (\`${channel.id}\`)`);
                if (me) {
                    const perms = channel.permissionsFor(me);
                    const canSend = perms?.has?.(PermissionFlagsBits.SendMessages) ?? false;
                    const canEmbed = perms?.has?.(PermissionFlagsBits.EmbedLinks) ?? false;
                    const canView = perms?.has?.(PermissionFlagsBits.ViewChannel) ?? true;
                    lines.push(
                        `${canView ? '✅' : '❌'} View Channel · ${canSend ? '✅' : '❌'} Send Messages · ${canEmbed ? '✅' : '❌'} Embed Links (bot permissions in that channel)`
                    );
                    if (!canSend || !canEmbed) {
                        lines.push('→ fix: Server Settings → that channel → add the bot → enable **Send Messages** + **Embed Links**');
                    }
                }
            }
        }
        // Boost detection = the guildMemberUpdate premium_since diff (Discord
        // fires no dedicated boost event) — an online bot proves the
        // GuildMembers intent is ON (a disabled privileged intent crashes the
        // login, it never runs silently).
        lines.push('ℹ️ Boost detection: ✅ active (guildMemberUpdate premium_since diff — the bot is online with the GuildMembers intent)');
        // Current live boost state — what a REAL boost would change.
        const boostCount = guild.premiumSubscriptionCount ?? 0;
        lines.push(`ℹ️ Server now: Level ${guild.premiumTier ?? 0} · ${boostCount} boost(s)`);

        // --- v3.9.59: BOOSTER AUTO ROLE chain diagnostics (optional — but when
        // set it must actually be assignable). Diagnosis only: the role is
        // NEVER touched here (the simulation stays pure). ---
        const boosterRoleId = config.roles && config.roles.booster;
        if (!boosterRoleId) {
            lines.push('ℹ️ Booster role: not set (optional) → `/set-role booster @role` so boosting members automatically get a role');
        } else {
            const boosterRole = guild.roles.cache.get(boosterRoleId);
            if (!boosterRole) {
                lines.push(
                    `❌ **booster role: not found** (ID \`${boosterRoleId}\`) — deleted, or the ID belongs to another server → set it again with \`/set-role booster @role\``
                );
            } else {
                lines.push(`✅ **booster role:** ${boosterRole} — granted automatically when a member boosts, removed when the boost ends`);
                if (me) {
                    const botPos = me.roles?.highest?.position;
                    if (typeof botPos === 'number' && (boosterRole.position ?? 0) >= botPos) {
                        lines.push(
                            '❌ the booster role is positioned ABOVE the bot\'s highest role — the bot cannot assign it → move the booster role BELOW the bot role (Server Settings → Roles)'
                        );
                    }
                    const canManageRoles =
                        typeof me.permissions?.has === 'function' ? me.permissions.has(PermissionFlagsBits.ManageRoles) : null;
                    if (canManageRoles === false) {
                        lines.push('❌ the bot lacks the **Manage Roles** permission → enable it in Server Settings → Roles → bot');
                    }
                }
            }
        }

        // --- live preview: the EXACT embed a real boost sends ---
        // interaction.member plays the role of "the booster". For the remove
        // preview, the streak start is the admin's real boost date when they
        // are boosting, else a plausible simulated one (3 days ago).
        const simulatedSince = interaction.member?.premiumSinceTimestamp || Date.now() - 3 * 86400000;
        const embed =
            tipe === 'add'
                ? buildBoostAddEmbed(interaction.member)
                : buildBoostRemoveEmbed(interaction.member, simulatedSince);
        let previewNote;
        try {
            await interaction.channel.send({
                content: tipe === 'add' ? `<@${interaction.user.id}>` : undefined,
                embeds: [embed]
            });
            previewNote = `🧪 Preview sent to **this channel** — the real ${tipe === 'add' ? 'boost notification' : 'boost-ended notice'} goes to ${channel ? channel : 'the server-booster channel you set'}. It uses your own data as "the booster".`;
        } catch (sendErr) {
            previewNote = `⚠️ Preview could NOT be sent to this channel: ${sendErr.message}\nCheck the bot's Send Messages + Embed Links permissions HERE too — the server-booster channel likely has the same problem.`;
        }

        // --- optional live delivery: the REAL channel, still a simulation ---
        if (live) {
            if (channel) {
                try {
                    await channel.send({
                        content: tipe === 'add' ? `<@${interaction.user.id}>` : undefined,
                        embeds: [embed]
                    });
                    lines.push(`🧪 Live delivery: ✅ also sent to the REAL server-booster channel — the full chain works end-to-end.`);
                } catch (err) {
                    lines.push(`🧪 Live delivery: ❌ failed in the server-booster channel: ${err.message} — check the bot's Send Messages + Embed Links permissions there.`);
                }
            } else {
                lines.push('🧪 Live delivery: skipped — the server-booster channel is not set (or was deleted). Fix it above first.');
            }
        }

        return safeEditReply(interaction, {
            content: `${lines.join('\n')}\n\n${previewNote}\n\n🧪 **Simulation only** — nothing is recorded: boost history (\`/boosters\`), the server log and the live counters stay untouched, the booster role is never touched.`
        });
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
            // v3.9.54: plain number — currency-agnostic (no hardcoded "Rp").
            totalSpent: v => v.toLocaleString('en-US'),
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
                // v3.9.54: plain number — currency-agnostic (no hardcoded "Rp").
                { name: '💰 Total Spent', value: stats.totalSpent.toLocaleString('en-US'), inline: true },
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
