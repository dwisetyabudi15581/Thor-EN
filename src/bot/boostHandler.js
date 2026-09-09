/**
 * Boost Handler — server booster notifications (v3.9.49).
 *
 * Called by:
 *   - src/bot/events/guildMemberUpdate.js (live boost add/remove detection)
 *   - src/commands/stats.js (/boosters list — uses the same embed builders)
 *
 * Logic:
 *   - Boost ADD   (premium_since: null → date): pink celebration embed to the
 *     server-booster channel + a BOOST_ADD entry in the server log.
 *   - Boost REMOVE (premium_since: date → null): gray embed + BOOST_REMOVE
 *     server-log entry.
 *
 * v3.9.48 diagnosability pattern: every skip reason logs the cause + the fix
 * command, and send failures name the channel + the exact permissions to
 * check. A boost with no notification AND no log line must never happen.
 */

const { EmbedBuilder } = require('discord.js');
const { getConfig } = require('../data/configManager');
const { logServerEvent } = require('../infra/serverLog');

const BOOST_PINK = 0xf472b6;
const BOOST_GRAY = 0x95a5a6;

/**
 * Build the boost-started embed. Pure — no side effects, no send.
 * @param {Object} member - discord.js GuildMember
 */
function buildBoostAddEmbed(member) {
    const { guild, user } = member;
    const tierText =
        guild.premiumTier && guild.premiumTier > 0
            ? `Server Level **${guild.premiumTier}** · ${guild.premiumSubscriptionCount ?? 0} boost(s) total`
            : 'Server Level 0 (boosting toward Level 1!)';
    return new EmbedBuilder()
        .setTitle('🚀 NEW SERVER BOOST!')
        .setDescription(`**${user}** just boosted **${guild.name}**! Thank you for supporting the server 💖`)
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setColor(BOOST_PINK)
        .addFields(
            { name: '👤 Booster', value: `${user} (\`${user.tag}\`)`, inline: true },
            { name: '🚀 Boosting since', value: `<t:${Math.floor((member.premiumSinceTimestamp || Date.now()) / 1000)}:R>`, inline: true },
            { name: '📊 Server', value: tierText, inline: false }
        )
        .setFooter({ text: `${guild.name} — thank you!`, iconURL: guild.iconURL({ dynamic: true }) || undefined })
        .setTimestamp();
}

/**
 * Build the boost-ended embed. Pure — no side effects, no send.
 * @param {Object} member - the member AFTER the change (premiumSinceTimestamp
 *   already null — the handler passes the old streak via `sinceTs`)
 * @param {number|null} sinceTs - the premiumSinceTimestamp BEFORE the removal
 */
function buildBoostRemoveEmbed(member, sinceTs) {
    const { guild, user } = member;
    const since = sinceTs ? `\n\nThey had been boosting since <t:${Math.floor(sinceTs / 1000)}:D>.` : '';
    return new EmbedBuilder()
        .setTitle('💔 BOOST ENDED')
        .setDescription(`**${user}** is no longer boosting **${guild.name}**.${since}`)
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setColor(BOOST_GRAY)
        .addFields({ name: '👤 Booster', value: `${user} (\`${user.tag}\`)`, inline: true })
        .setFooter({ text: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
        .setTimestamp();
}

/**
 * Send the boost notification to the server-booster channel + record it in
 * the server log. Never throws — logs every failure with the fix (v3.9.48
 * silent-failure pattern).
 *
 * @param {Object} member - discord.js GuildMember (after the change)
 * @param {'add'|'remove'} action
 * @param {number|null} [oldSinceTs] - the premiumSinceTimestamp before the change
 */
async function onBoostChange(member, action, oldSinceTs = null) {
    const { guild, user } = member;
    const config = getConfig();

    // 1. Persist the history first (even if notifications fail, the data stays).
    try {
        const boostManager = require('../data/boostManager');
        if (action === 'add') boostManager.recordBoostStart(guild.id, user.id, member.premiumSinceTimestamp || Date.now());
        else boostManager.recordBoostEnd(guild.id, user.id);
    } catch (err) {
        console.warn(`⚠️ Failed to record the boost ${action} for ${user.tag}:`, err.message);
    }

    // 2. Server log entry (independent channel — the historical record).
    try {
        await logServerEvent(member.client, {
            type: action === 'add' ? 'BOOST_ADD' : 'BOOST_REMOVE',
            guildId: guild.id,
            fields: [
                { name: '👤 Booster', value: `<@${user.id}> (\`${user.tag}\`)`, inline: true },
                {
                    name: action === 'add' ? '🚀 Started' : '💔 Ended',
                    value:
                        action === 'add'
                            ? member.premiumSinceTimestamp
                                ? `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:R>`
                                : 'just now'
                            : oldSinceTs
                              ? `was since <t:${Math.floor(oldSinceTs / 1000)}:R>`
                              : 'unknown start'
                }
            ],
            footer: `User ID: ${user.id}`
        });
    } catch (_) {
        // logServerEvent never throws, but stay defensive.
    }

    // 3. The dedicated server-booster channel (the celebration embed).
    const channelId = config.channels['server-booster'];
    if (!channelId) {
        console.warn(
            `⚠️ ${user.tag} ${action === 'add' ? 'started' : 'stopped'} boosting, but the server-booster channel is NOT set — the boost notification was skipped. ` +
                `Fix: /set-channel server-booster #channel (the server log still records it if set)`
        );
        return;
    }
    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
        console.warn(
            `⚠️ Server-booster channel (ID: ${channelId}) not found — deleted, or the ID belongs to another server. ` +
                `Fix: /set-channel server-booster #channel`
        );
        return;
    }

    const embed = action === 'add' ? buildBoostAddEmbed(member) : buildBoostRemoveEmbed(member, oldSinceTs);

    try {
        const content = action === 'add' ? `<@${user.id}>` : undefined;
        await channel.send({ content, embeds: [embed] });
        console.log(`🚀 Boost ${action} notification sent for ${user.tag} in #${channel.name || channel.id}`);
    } catch (err) {
        console.error(
            `❌ Failed to send the boost ${action} notification in #${channel.name || channel.id}: ${err.message}\n` +
                `   Check the bot's Send Messages + Embed Links permissions in that channel.`
        );
    }
}

/**
 * Build the /boosters list embed. Pure — no side effects, no send.
 * @param {Object} guild - discord.js Guild
 * @param {Array<Object>} boosters - GuildMembers with premiumSinceTimestamp, sorted
 *   by boost date ASCENDING (earliest supporter first — caller sorts)
 * @param {Array<{userId, event, at, boostedAt}>} recentEvents - from boostManager.getRecentEvents
 */
function buildBoostersEmbed(guild, boosters, recentEvents = []) {
    const boostCount = guild.premiumSubscriptionCount ?? boosters.length;
    const tierText =
        guild.premiumTier && guild.premiumTier > 0 ? `Level ${guild.premiumTier}` : 'Level 0 (no boosts yet)';

    // Booster list — cap at 40 lines so the description always fits (4096 limit
    // with ~60 chars/line ≈ 2.400 + headroom; bigger boost rosters are unlikely
    // in community servers, but the guard stays).
    const MAX_LIST = 40;
    const lines = boosters.slice(0, MAX_LIST).map((m, i) => {
        const ts = Math.floor((m.premiumSinceTimestamp || 0) / 1000);
        return `${i + 1}. <@${m.user.id}> — since <t:${ts}:D> (<t:${ts}:R>)`;
    });
    const hidden = boosters.length - MAX_LIST;
    if (hidden > 0) lines.push(`… +${hidden} more booster(s) not shown`);

    const description =
        boosters.length === 0
            ? 'This server has no active boosters right now. 🌱\nBoosting the server unlocks perks for everyone — every boost counts!'
            : `These members are boosting **${guild.name}** right now 💖\n\n${lines.join('\n')}`;

    const recentLines = recentEvents
        .slice(0, 5)
        .map(e => `${e.event === 'add' ? '🚀' : '💔'} <@${e.userId}> — <t:${Math.floor((e.at || 0) / 1000)}:R>`)
        .join('\n');

    const embed = new EmbedBuilder()
        .setTitle(`🚀 SERVER BOOSTERS — ${guild.name}`)
        .setDescription(description)
        .setColor(BOOST_PINK)
        .addFields(
            { name: '📊 Server Level', value: `${tierText} (${boostCount} boost${boostCount === 1 ? '' : 's'})`, inline: true },
            { name: '⭐ Boosters Listed', value: `${boosters.length}`, inline: true }
        )
        .setFooter({ text: 'Booster list = live from Discord • boost history tracked by the bot' })
        .setTimestamp();

    if (recentLines) {
        embed.addFields({ name: '🕘 Recent Boost Activity', value: recentLines.slice(0, 1000) });
    }
    const icon = typeof guild.iconURL === 'function' ? guild.iconURL() : null;
    if (icon) embed.setThumbnail(icon);
    return embed;
}

module.exports = { onBoostChange, buildBoostAddEmbed, buildBoostRemoveEmbed, buildBoostersEmbed, BOOST_PINK, BOOST_GRAY };
