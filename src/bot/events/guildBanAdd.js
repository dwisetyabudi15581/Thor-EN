/**
 * Event: guildBanAdd — log EVERY ban that happens in the server (v3.9.43).
 *
 * Added value over the bot's /ban: this also catches manual bans done through
 * the Discord UI (right-click user → Ban) — without this event, manual bans
 * are invisible in the bot's logs entirely. Executor + reason come from the
 * audit log entry.
 */

const { Events, AuditLogEvent } = require('discord.js');
const { logServerEvent, findAuditExecutor, snip } = require('../../infra/serverLog');

async function onEvent(ban) {
    try {
        const { guild, user, reason } = ban;
        if (!guild?.id) return;
        if (process.env.GUILD_ID && guild.id !== process.env.GUILD_ID) return;

        // Executor + official reason from the audit log (the event's reason
        // parameter is often null for manual UI bans — the audit log is fuller).
        let executorLine = '❔ Unknown';
        let auditReason = reason || null;
        try {
            const audit = await guild.fetchAuditLogs({ type: AuditLogEvent.Ban, limit: 5 });
            const { entry } = findAuditExecutor({
                entries: [...audit.entries.values()],
                targetId: user.id,
                windowMs: 60000
            });
            if (entry) {
                if (entry.executorId) executorLine = `👮 <@${entry.executorId}>`;
                if (entry.reason) auditReason = entry.reason;
            }
        } catch (_) {
            // No ViewAuditLog — keep the default.
        }

        await logServerEvent(guild.client, {
            type: 'BAN_ADD',
            guildId: guild.id,
            fields: [
                { name: '👤 User', value: `<@${user.id}> (\`${user.tag}\`)`, inline: true },
                { name: '🔨 By', value: executorLine, inline: true },
                { name: '📝 Reason', value: auditReason ? snip(auditReason, 500) : '_(no reason given)_' }
            ],
            footer: `User ID: ${user.id}`
        });
    } catch (err) {
        console.error('GuildBanAdd log error:', err.message);
    }
}

module.exports = {
    name: Events.GuildBanAdd,
    execute: onEvent
};
