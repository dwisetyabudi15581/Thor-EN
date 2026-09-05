/**
 * Event: messageDelete — log deleted messages to the server-log channel.
 *
 * Why it matters: this is the only way to know what a deleted message said
 * (scam evidence deleted, ad spam cleaned up, toxic messages removed by
 * their own author). Discord's native audit log does NOT keep message
 * content.
 *
 * Executor detection (v3.9.43): fetch the MessageDelete audit action →
 * if found, show who deleted it (a moderator). If not found (missing
 * ViewAuditLog permission / entry not indexed yet / the author deleted
 * it themselves) → show "unknown / deleted by author".
 *
 * Guards:
 *   - DMs (no guild) → skip.
 *   - Single-guild: GUILD_ID mismatch → skip (v3.9.26 pattern).
 *   - Bot messages → skip (the log would drown in the bot's own embeds —
 *     including panel/announce messages that are deleted by design).
 *   - Partial messages → content may be empty: still logged with a note
 *     "(message not cached)".
 *   - Audit log fetch failure (permissions) → continue without executor.
 *   - logServerEvent never throws (serverLog.js contract).
 */

const { Events, AuditLogEvent } = require('discord.js');
const { logServerEvent, findAuditExecutor, snip } = require('../../infra/serverLog');

async function onEvent(message) {
    try {
        if (!message.guild?.id) return; // DM
        if (process.env.GUILD_ID && message.guild.id !== process.env.GUILD_ID) return;
        if (message.author?.bot) return; // never log bot messages (self spam)

        // Executor: who deleted it? (try/catch — permission may be absent)
        let executorLine = '❔ Unknown (possibly deleted by the author)';
        try {
            const audit = await message.guild.fetchAuditLogs({
                type: AuditLogEvent.MessageDelete,
                limit: 5
            });
            const { executorId } = findAuditExecutor({
                entries: [...audit.entries.values()],
                targetId: message.author?.id || null,
                channelId: message.channel?.id || null,
                windowMs: 60000
            });
            if (executorId && executorId !== message.author?.id) {
                executorLine = `👮 <@${executorId}>`;
            } else if (executorId) {
                executorLine = `✍️ <@${executorId}> (the author themselves)`;
            }
        } catch (_) {
            // Bot lacks ViewAuditLog — leave as "unknown".
        }

        const content = message.content
            ? snip(message.content)
            : '_(message not cached / no text — embed/attachment)_';

        await logServerEvent(message.client, {
            type: 'MSG_DELETE',
            guildId: message.guild.id,
            fields: [
                { name: '✍️ Author', value: message.author ? `<@${message.author.id}> (\`${message.author.tag}\`)` : '❔ unknown', inline: true },
                { name: '📍 Channel', value: `<#${message.channel.id}> (\`#${message.channel.name || '?'}\`)`, inline: true },
                { name: '🗑️ Deleted by', value: executorLine, inline: true },
                { name: '📄 Content', value: content }
            ],
            footer: `Author ID: ${message.author?.id || '?'} | Channel ID: ${message.channel?.id || '?'}`
        });
    } catch (err) {
        console.error('MessageDelete log error:', err.message);
    }
}

module.exports = {
    name: Events.MessageDelete,
    execute: onEvent
};
