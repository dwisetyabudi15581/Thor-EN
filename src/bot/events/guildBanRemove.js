/**
 * Event: guildBanRemove — log ban revocations (v3.9.43).
 *
 * Catches unbans from the bot's /unban AND manual unbans via Server Settings
 * → Bans. Important for auditing: "who gave this scammer a second chance?"
 */

const { Events, AuditLogEvent } = require('discord.js');
const { logServerEvent, findAuditExecutor, snip } = require('../../infra/serverLog');
// v3.11.0: multi-guild allowlist guard (phase 2).
const { isGuildAllowed } = require('../../infra/guild');

async function onEvent(ban) {
    try {
        const { guild, user } = ban;
        if (!guild?.id) return;
        // v3.11.0: allowlist guard — guilds outside ALLOWED_GUILD_IDS (fallback
        // GUILD_ID) are ignored; an empty list = open mode (every guild processed).
        if (!isGuildAllowed(guild.id)) return;

        let executorLine = '❔ Unknown';
        let reason = null;
        try {
            const audit = await guild.fetchAuditLogs({ type: AuditLogEvent.Unban, limit: 5 });
            const { entry } = findAuditExecutor({
                entries: [...audit.entries.values()],
                targetId: user.id,
                windowMs: 60000
            });
            if (entry) {
                if (entry.executorId) executorLine = `👮 <@${entry.executorId}>`;
                if (entry.reason) reason = entry.reason;
            }
        } catch (_) {
            // No ViewAuditLog — keep the default.
        }

        await logServerEvent(guild.client, {
            type: 'BAN_REMOVE',
            guildId: guild.id,
            fields: [
                { name: '👤 User', value: `<@${user.id}> (\`${user.tag}\`)`, inline: true },
                { name: '♻️ By', value: executorLine, inline: true },
                { name: '📝 Reason', value: reason ? snip(reason, 500) : '_(no reason given)_', inline: true }
            ],
            footer: `User ID: ${user.id}`
        });
    } catch (err) {
        console.error('GuildBanRemove log error:', err.message);
    }
}

module.exports = {
    name: Events.GuildBanRemove,
    execute: onEvent
};
