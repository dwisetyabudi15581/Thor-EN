/**
 * Event: messageBulkDelete — log mass deletions to the server-log channel.
 *
 * Event sources: the bot's /purge, manual bulk delete through the Discord UI
 * (right-click channel → Delete Messages), or AutoMod actions. The MOD_PURGE
 * audit entry only covers purges done via the bot — this event catches ALL
 * sources plus the exact count.
 *
 * Executor: MessageBulkDelete audit entry → entry.extra carries count + channel.
 */

const { Events, AuditLogEvent } = require('discord.js');
const { logServerEvent, findAuditExecutor } = require('../../infra/serverLog');

async function onEvent(messages) {
    try {
        // v14 may pass a Collection or MessageBulkDeleteOptions ({channel, messages}).
        const coll = messages?.messages || messages;
        const channel = messages?.channel || coll?.first()?.channel;
        const guild = channel?.guild || coll?.first()?.guild;
        if (!guild?.id) return;
        if (process.env.GUILD_ID && guild.id !== process.env.GUILD_ID) return;

        const count = typeof coll?.size === 'number' ? coll.size : 0;
        if (count === 0) return;

        // Executor from the audit log (best effort).
        let executorLine = '❔ Unknown';
        try {
            const audit = await guild.fetchAuditLogs({
                type: AuditLogEvent.MessageBulkDelete,
                limit: 3
            });
            const { executorId } = findAuditExecutor({
                entries: [...audit.entries.values()],
                channelId: channel.id,
                windowMs: 60000
            });
            if (executorId) executorLine = `👮 <@${executorId}>`;
        } catch (_) {
            // No ViewAuditLog — keep the default.
        }

        await logServerEvent(guild.client, {
            type: 'MSG_BULK',
            guildId: guild.id,
            fields: [
                { name: '📍 Channel', value: `<#${channel.id}> (\`#${channel.name || '?'}\`)`, inline: true },
                { name: '#️⃣ Count', value: `**${count}** messages`, inline: true },
                { name: '🧹 By', value: executorLine, inline: true }
            ],
            footer: `Channel ID: ${channel.id}`
        });
    } catch (err) {
        console.error('MessageBulkDelete log error:', err.message);
    }
}

module.exports = {
    name: Events.MessageBulkDelete,
    execute: onEvent
};
