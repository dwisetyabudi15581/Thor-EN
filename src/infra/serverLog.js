/**
 * Server Log — record server events (message delete/edit, join/leave, bans,
 * role changes) to a dedicated channel (v3.9.43).
 *
 * Difference from auditLog.js:
 *   - auditLog  = ADMIN actions performed through the bot (SET_PRODUCT,
 *                 WARN_ADD, etc.) — channel config.channels['audit-log'].
 *   - serverLog = SERVER activity including things that happen OUTSIDE the
 *                 bot (admin deletes a message via native Discord, user edits
 *                 a message, manual bans from the Discord UI, etc.) — a
 *                 separate channel config.channels['server-log'] so admins
 *                 can choose a different channel (event logs are high-volume).
 *
 * Used by the event handlers in src/bot/events/:
 *   messageDelete, messageUpdate, messageBulkDelete, guildBanAdd,
 *   guildBanRemove, guildMemberUpdate + join/leave logging from
 *   guildMemberAdd/guildMemberRemove.
 *
 * Contracts (unit-tested in serverLog.test.js):
 *   - Channel not configured → return false (silent skip, same as audit).
 *   - Field values truncated to ≤ 1024 (Discord limit) + newlines collapsed.
 *   - Send failure (permission/rate-limit) → return false, WITHOUT throwing —
 *     an event handler must never crash just because a log failed.
 *   - No retry: server logs are high-volume; retries would pile up a backlog.
 *     (audit logs are low-volume and retried — deliberately different policy.)
 */

const { EmbedBuilder } = require('discord.js');
const { EMBED_LIMITS } = require('./constants');

// Consistent colors per event (easy to visually scan the log channel).
const SERVER_LOG_EVENTS = {
    MSG_DELETE: { color: 0xed4245, title: '🗑️ Message Deleted' },
    MSG_EDIT: { color: 0x5865f2, title: '✏️ Message Edited' },
    MSG_BULK: { color: 0xe67e22, title: '🧹 Messages Bulk-Deleted' },
    MEMBER_JOIN: { color: 0x57f287, title: '📥 Member Joined' },
    MEMBER_LEAVE: { color: 0xe67e22, title: '📤 Member Left' },
    BAN_ADD: { color: 0xed4245, title: '🔨 Member Banned' },
    BAN_REMOVE: { color: 0x57f287, title: '♻️ Ban Revoked' },
    ROLE_UPDATE: { color: 0xfee75c, title: '🎭 Member Roles Changed' },
    NICK_UPDATE: { color: 0x992d22, title: '📝 Nickname Changed' }
};

/**
 * Message content snippet for an embed field: collapse newlines, safe truncate.
 * @param {string} text
 * @param {number} [max=1000]
 */
function snip(text, max = 1000) {
    if (text === null || text === undefined) return '';
    let t = String(text).replace(/\s*\n\s*/g, ' ').trim();
    if (t.length === 0) return '_(empty)_';
    if (t.length > max) t = t.slice(0, max - 1) + '…';
    return t;
}

/**
 * Send one server log entry.
 * @param {Client} client
 * @param {Object} data
 *   - type      : SERVER_LOG_EVENTS key (required)
 *   - guildId   : string (footer)
 *   - fields    : [{ name, value, inline? }] — already strings (caller formats)
 *   - footer    : extra footer text (optional)
 *   - content   : optional mention line outside the embed (rare)
 * @returns {Promise<boolean>} delivered or not
 */
async function logServerEvent(client, data) {
    const conf = SERVER_LOG_EVENTS[data.type];
    if (!conf || !data.guildId) return false;

    let channelId;
    try {
        const { getConfig } = require('../data/configManager');
        const config = getConfig();
        channelId = config.channels && config.channels['server-log'];
    } catch (_err) {
        return false; // config broken — skip
    }
    if (!channelId) return false; // not configured — silent skip (auditLog contract)

    let channel;
    try {
        channel =
            client.channels.cache.get(channelId) ||
            (await client.channels.fetch(channelId).catch(() => null));
    } catch (_err) {
        return false;
    }
    if (!channel || typeof channel.send !== 'function') return false;

    try {
        // Limit guards: every field value ≤ 1024 + field names ≤ 256.
        const fields = (Array.isArray(data.fields) ? data.fields : [])
            .filter(f => f && f.name && f.value !== undefined)
            .map(f => ({
                name: String(f.name).slice(0, EMBED_LIMITS.FIELD_NAME - 1),
                value: String(f.value).slice(0, EMBED_LIMITS.FIELD_VALUE - 1) || '_(empty)_',
                inline: !!f.inline
            }))
            .slice(0, EMBED_LIMITS.FIELDS_COUNT);

        const embed = new EmbedBuilder()
            .setTitle(conf.title.slice(0, EMBED_LIMITS.TITLE - 1))
            .setColor(conf.color)
            .setTimestamp();

        if (fields.length > 0) embed.addFields(...fields);
        if (data.footer) embed.setFooter({ text: String(data.footer).slice(0, EMBED_LIMITS.FOOTER_TEXT - 1) });

        await channel.send({ content: data.content || undefined, embeds: [embed] });
        return true;
    } catch (err) {
        // NEVER throw — event handlers stay safe. One light log line.
        console.warn(`⚠️ Server log [${data.type}] failed to send: ${err.message || err}`);
        return false;
    }
}

/**
 * Find the executor in Discord's audit log (who deleted/banned).
 * Split out as a pure function so it can be unit-tested without the API.
 *
 * @param {Object} p
 * @param {string|null} p.targetId user that got actioned (null = take the latest)
 * @param {string|null} [p.channelId] channel filter (MessageDelete entries carry entry.extra.channel)
 * @param {number} [p.windowMs=60000] max audit entry age (default 60 seconds)
 * @param {number} [p.now=Date.now()]
 * @param {Array<{id: string, actionType: number, targetId?: string, executorId?: string|null, createdTimestamp?: number, extra?: {channelId?: string, channel?: {id: string}}}>} p.entries
 * @returns {{executorId: string|null, entry: Object|null}} executorId=null → not found
 */
function findAuditExecutor({ entries, targetId, channelId, windowMs = 60000, now = Date.now() }) {
    if (!Array.isArray(entries) || entries.length === 0) return { executorId: null, entry: null };

    const candidates = entries
        .map(e => {
            const ts = typeof e.createdTimestamp === 'number' ? e.createdTimestamp : 0;
            const extraCh =
                (e.extra && (e.extra.channelId || (e.extra.channel && e.extra.channel.id))) || null;
            return {
                executorId: e.executorId || null,
                targetId: e.targetId || null,
                channelId: extraCh,
                ts,
                entry: e
            };
        })
        .filter(c => {
            if (now - c.ts > windowMs) return false; // too old — not this action
            if (targetId && c.targetId && c.targetId !== targetId) return false;
            if (channelId && c.channelId && c.channelId !== channelId) return false;
            return true;
        })
        // Most recent first (audit entries are usually ordered, but don't rely on it).
        .sort((a, b) => b.ts - a.ts);

    const hit = candidates.find(c => c.executorId) || null;
    return hit ? { executorId: hit.executorId, entry: hit.entry } : { executorId: null, entry: null };
}

module.exports = { logServerEvent, findAuditExecutor, snip, SERVER_LOG_EVENTS };
