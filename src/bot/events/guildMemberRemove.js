/**
 * GuildMemberRemove handler — delegates to handlers/memberHandler.js (legacy)
 * + server log leave (v3.9.43).
 *
 * GuildMemberRemove fires for regular leaves AND kicks (a kick IS a remove
 * event). The kick executor can be detected via the audit log — if found,
 * the label becomes "kick" instead of "leave". This complements the bot's
 * /kick: manual kicks from the Discord UI also become visible.
 */

const { Events, AuditLogEvent } = require('discord.js');
const { onMemberRemove } = require('../memberHandler');
const { logServerEvent, findAuditExecutor } = require('../../infra/serverLog');

async function onEvent(member) {
    try {
        // v3.9.26 (single-guild hardening): ignore members from other guilds.
        if (process.env.GUILD_ID && member.guild?.id && member.guild.id !== process.env.GUILD_ID) return;
        await onMemberRemove(member);

        // v3.9.43: server log leave/kick (best effort).
        if (member.user?.bot) return;

        // Kick detection: MemberKick audit entry with this user as target.
        let leaveKind = '📤 Leave (left on their own)';
        try {
            const audit = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 5 });
            const { executorId, entry } = findAuditExecutor({
                entries: [...audit.entries.values()],
                targetId: member.user.id,
                windowMs: 60000
            });
            if (executorId) {
                leaveKind = `👢 Kick by <@${executorId}>${entry?.reason ? ` — reason: ${entry.reason}` : ''}`;
            }
        } catch (_) {
            // No ViewAuditLog — treat as a normal leave.
        }

        await logServerEvent(member.client, {
            type: 'MEMBER_LEAVE',
            guildId: member.guild.id,
            fields: [
                { name: '👤 Member', value: `<@${member.user.id}> (\`${member.user.tag}\`)`, inline: true },
                { name: '🚪 Status', value: leaveKind, inline: true },
                { name: '👥 Total members', value: `**${member.guild.memberCount}**`, inline: true }
            ],
            footer: `User ID: ${member.user.id}`
        });
    } catch (err) {
        console.error('GuildMemberRemove Error:', err);
    }
}

module.exports = {
    name: Events.GuildMemberRemove,
    execute: onEvent
};
