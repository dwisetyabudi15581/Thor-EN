/**
 * Member Handler — welcome/goodbye + auto-role unverified.
 *
 * Called by:
 *   - src/bot/events/guildMemberAdd.js
 *   - src/bot/events/guildMemberRemove.js
 *
 * Logic:
 *   - onMemberAdd: grant the Unverified role + send a welcome embed to the welcome channel.
 *   - onMemberRemove: check the audit log (kick/ban vs voluntary leave) + send a goodbye embed.
 *
 * v3.9.0 FIX: skip bot accounts.
 * v3.9.8 FIX: AuditLogEvent enum (not magic number 20/22), 10s window (was 5s),
 *   separate fetchAuditLogs for kick & ban (more accurate, less data).
 */

const { EmbedBuilder, AuditLogEvent } = require('discord.js');
const { getConfig, fillTemplate } = require('../data/configManager');

async function onMemberAdd(member) {
    const { guild, user } = member;

    if (user.bot) return;

    const config = getConfig();

    try {
        const { recordJoin } = require('../data/statsManager');
        recordJoin(guild.id, user.id);
    } catch (_) {}

    if (config.roles.unverified) {
        const unverifiedRole = guild.roles.cache.get(config.roles.unverified);
        if (unverifiedRole) {
            try {
                await member.roles.add(unverifiedRole);
                console.log(`✅ Unverified role granted to ${user.tag}`);
            } catch (err) {
                console.error(`❌ Failed to add unverified role for ${user.tag}:`, err.message);
            }
        } else {
            console.warn(`⚠️ Unverified role (ID: ${config.roles.unverified}) not found.`);
        }
    }

    if (config.channels.welcome) {
        const welcomeChannel = guild.channels.cache.get(config.channels.welcome);
        if (welcomeChannel) {
            const vars = {
                user: `<@${user.id}>`,
                username: user.tag,
                server: guild.name,
                count: guild.memberCount
            };

            const embed = new EmbedBuilder()
                .setTitle(fillTemplate(config.messages.welcomeTitle, vars))
                .setDescription(fillTemplate(config.messages.welcomeBody, vars))
                .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
                .setColor(0x2ecc71)
                .setFooter({ text: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
                .setTimestamp();

            try {
                await welcomeChannel.send({ content: `<@${user.id}>`, embeds: [embed] });
            } catch (err) {
                console.error('❌ Failed to send welcome message:', err.message);
            }
        } else {
            console.warn(`⚠️ Welcome channel (ID: ${config.channels.welcome}) not found.`);
        }
    }
}

async function onMemberRemove(member) {
    const { guild, user } = member;

    if (user.bot) return;

    const config = getConfig();

    if (!config.channels.goodbye) return;
    const goodbyeChannel = guild.channels.cache.get(config.channels.goodbye);
    if (!goodbyeChannel) {
        console.warn(`⚠️ Goodbye channel (ID: ${config.channels.goodbye}) not found.`);
        return;
    }

    let action = 'left';
    const AUDIT_WINDOW_MS = 10 * 1000;
    try {
        const audits = await guild.fetchAuditLogs({
            type: AuditLogEvent.MemberKick,
            limit: 5
        });
        const kickEntry = audits.entries.find(
            e => e.target?.id === user.id && Date.now() - e.createdTimestamp < AUDIT_WINDOW_MS
        );
        if (kickEntry) {
            action = 'kicked';
        } else {
            const banAudits = await guild.fetchAuditLogs({
                type: AuditLogEvent.MemberBanAdd,
                limit: 5
            });
            const banEntry = banAudits.entries.find(
                e => e.target?.id === user.id && Date.now() - e.createdTimestamp < AUDIT_WINDOW_MS
            );
            if (banEntry) {
                action = 'banned';
            }
        }
    } catch (err) {
        console.warn(
            `⚠️ Could not access the audit log for <@${user.id}>'s goodbye message: ${err.message?.slice(0, 80)}. ` +
                `Make sure the bot has the View Audit Log permission.`
        );
    }

    const vars = {
        user: `<@${user.id}>`,
        username: user.tag,
        server: guild.name,
        count: guild.memberCount,
        action
    };

    const embed = new EmbedBuilder()
        .setTitle(fillTemplate(config.messages.goodbyeTitle, vars))
        .setDescription(fillTemplate(config.messages.goodbyeBody, vars))
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setColor(0xe74c3c)
        .setFooter({ text: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
        .setTimestamp();

    try {
        await goodbyeChannel.send({ embeds: [embed] });
    } catch (err) {
        console.error('❌ Failed to send goodbye message:', err.message);
    }
}

module.exports = { onMemberAdd, onMemberRemove };
