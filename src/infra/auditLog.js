/**
 * Audit Log — records all admin actions to a dedicated channel.
 *
 * How to use:
 *   const { logAudit } = require('../utils/auditLog');
 *   await logAudit(client, {
 *     action: 'ADD_PRODUCT',
 *     actorId: interaction.user.id,
 *     actorTag: interaction.user.tag,
 *     details: `Add product: ${label} (${value}) — ${price}`,
 *     guildId: interaction.guild.id
 *   });
 *
 * The target channel is taken from config.channels['audit-log'].
 * If it isn't set, the log is skipped (silent fail).
 *
 * v3.9.2: added a 1x retry with a 500ms delay if the first send fails
 * (e.g. due to a Discord rate-limit or network blip). Previously, a single
 * transient error would lose the audit log entry. Now there are at least 2 attempts.
 *
 * No JSON file — logs are sent straight to the Discord channel.
 */

const { EmbedBuilder } = require('discord.js');

const ACTION_LABELS = {
    // Products
    ADD_PRODUCT: '➕ Add Product',
    REMOVE_PRODUCT: '❌ Remove Product',
    EDIT_PRODUCT: '✏️ Edit Product',
    // Roles & Channels
    SET_ROLE: '🎭 Set Role',
    REMOVE_ROLE: '🚫 Remove Role from Config',
    SET_CHANNEL: '📢 Set Channel',
    REMOVE_CHANNEL: '🚫 Remove Channel from Config',
    // Messages
    SET_MESSAGE: '✏️ Set Message',
    RESET_MESSAGE: '🔄 Reset Message to Default',
    // Self-Role
    SETUP_SELFROLE: '🎭 Create Self-Role Panel',
    SELFROLE_ADD: '➕ Add Role to Panel',
    SELFROLE_REMOVE: '❌ Remove Role from Panel',
    SELFROLE_DELETE: '🗑️ Delete Self-Role Panel',
    // Embed Builder & Announce
    ANNOUNCE_SEND: '📢 Send Announcement',
    EMBED_BUILDER_SEND: '📤 Send Embed (Builder)',
    // VIP / Keys
    SET_KEY: '🔑 Set Key (Ticket)',
    ORDER_DELIVERED: '📦 Deliver Order (Ticket)',
    CLEAR_SCHEDULE: '🧹 Clear Schedule',
    // Config
    RESET_CONFIG: '⚠️ FULL CONFIG RESET',
    // Backup
    BACKUP_NOW: '💾 Manual Backup',
    RESTORE_BACKUP: '♻️ Restore Backup',
    // Giveaway
    GIVEAWAY_CREATE: '🎉 Create Giveaway',
    GIVEAWAY_END: '🛑 End Giveaway',
    GIVEAWAY_REROLL: '🎲 Reroll Giveaway',
    // Scheduled Announce
    ANNOUNCE_SCHEDULE: '⏰ Schedule Announcement',
    ANNOUNCE_CANCEL: '❌ Cancel Scheduled Announcement',
    // Warn
    WARN_ADD: '⚠️ Warn Member',
    WARN_REMOVE: '✅ Remove Warning',
    WARN_CLEAR_ALL: '🧹 Clear All Warnings',
    // Poll
    POLL_CREATE: '📊 Create Poll',
    POLL_CLOSE: '🔒 Close Poll',
    // v3.9.4: added labels that previously fell back to the raw action string.
    SETUP_TEMPVOICE: '🎤 Setup Temp Voice',
    TEMPVOICE_REMOVE: '🗑️ Remove Temp Voice Setup',
    // v3.9.17 FIX: added 15 labels that previously fell back to the raw action string.
    // Leveling
    SETUP_LEVELING: '📊 Setup Leveling',
    ADD_LEVEL_ROLE: '➕ Add Level Role',
    REMOVE_LEVEL_ROLE: '❌ Remove Level Role',
    // Auto-Responder
    ADD_RESPONDER: '➕ Add Auto-Responder',
    REMOVE_RESPONDER: '❌ Remove Auto-Responder',
    // Auto-Mod
    SET_AUTOMOD: '🛡️ Set Auto-Mod Config',
    TOGGLE_AUTOMOD: '🔄 Toggle Auto-Mod',
    AUTOMOD_WHITELIST: '✅ Whitelist Channel/Role for Links',
    // v3.9.23: word flex
    AUTOMOD_WORD: '📝 Manage Auto-Mod Words (Add/Remove)',
    // Categories
    ADD_CATEGORY: '🎫 Add Ticket Category',
    REMOVE_CATEGORY: '🗑️ Remove Ticket Category',
    // Send Message
    SEND_MESSAGE: '📤 Send Message (Custom)',
    // Panels (verify + ticket panel)
    SET_VERIFY_BUTTON: '✏️ Set Verify Button',
    SETUP_TICKET_PANEL: '🎫 Setup Ticket Panel (Multi-Panel)',
    // Panel management (v3.9.14+)
    DELETE_PANEL: '🗑️ Delete Ticket Panel',
    REFRESH_PANEL: '🔄 Refresh Ticket Panel',
    UPDATE_PANEL: '✏️ Update Panel Field',
    // Midman / Escrow (v3.9.32; labels added v3.9.37 — previously fell back
    // to the raw action string, consistent with the label cleanup v3.9.4/v3.9.17)
    SET_MIDMAN_FEE: '💰 Set Escrow Fee',
    MIDMAN_CREATE: '🤝 Create Escrow Deal',
    MIDMAN_AGREE: '✅ Agree to Deal (partial)',
    MIDMAN_JOIN: '✅ Agree to Deal (locked)',
    MIDMAN_CANCEL: '🚫 Cancel Escrow Deal',
    MIDMAN_FUNDIN: '💰 Funds Received (Escrow)',
    MIDMAN_RECEIVED: '📦 Goods Delivered (Escrow)',
    MIDMAN_RELEASE: '💸 Release Funds (Escrow)',
    MIDMAN_DISPUTE: '🚨 Escrow Dispute',
    MIDMAN_RESOLVE_RELEASE: '⚖️ Resolve Dispute — Release',
    MIDMAN_RESOLVE_REFUND: '⚖️ Resolve Dispute — Refund',
    MIDMAN_MEMBER_ADD: '➕ Add Deal Member',
    MIDMAN_MEMBER_REMOVE: '➖ Remove Deal Member'
};

const RETRY_DELAY_MS = 500;
const MAX_ATTEMPTS = 2;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send an audit log entry to the configured channel.
 * @param {Client} client - Discord client
 * @param {Object} data - { action, actorId, actorTag, details, guildId }
 * @returns {Promise<boolean>} true if sent successfully, false on failure/skip
 */
async function logAudit(client, data) {
    let auditChannelId;
    try {
        const { getConfig } = require('../data/configManager');
        const config = getConfig();
        auditChannelId = config.channels['audit-log'];
    } catch (_err) {
        // config broken — skip
        return false;
    }
    if (!auditChannelId) return false; // not set, silent skip

    // Resolve the channel (cache first, fallback fetch)
    let channel;
    try {
        channel =
            client.channels.cache.get(auditChannelId) ||
            (await client.channels.fetch(auditChannelId).catch(() => null));
    } catch (err) {
        console.warn('⚠️ Audit log: failed to resolve channel:', err.message);
        return false;
    }
    if (!channel) return false;

    const label = ACTION_LABELS[data.action] || data.action;
    // v3.9.26 FIX: truncate details to 1024 (embed field value limit). Previously,
    // long details (e.g. a 20-mention winner list) made addFields throw
    // BEFORE the retry try/catch → callers that don't wrap (backup.js, panels-mgmt)
    // treated the operation as failed even though it had already succeeded.
    const detailsText =
        typeof data.details === 'string' && data.details.length > 1024
            ? data.details.slice(0, 1010) + '…(truncated)'
            : data.details || '_(no details)_';
    const embed = new EmbedBuilder()
        .setTitle(`🔧 AUDIT: ${label}`.slice(0, 256))
        .setColor(0x2c2f33)
        .addFields(
            {
                name: '👤 Admin',
                value: `<@${data.actorId}> (\`${data.actorTag || data.actorId}\`)`.slice(0, 1024),
                inline: true
            },
            { name: '🕐 Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
            { name: '📋 Details', value: detailsText }
        )
        .setFooter({ text: `Action: ${data.action}`.slice(0, 2048) })
        .setTimestamp();

    if (data.guildId) embed.addFields({ name: '🏠 Guild', value: `\`${data.guildId}\``, inline: true });

    // v3.9.2: retry once if the send fails due to a transient error (rate limit,
    // network blip, etc). Non-retryable errors (permission, 4xx) are not retried.
    // v3.9.8 FIX: previously `code === 0` (a catch-all for errors without code/status)
    // was also retried. That was wrong — TypeError/ReferenceError (programming bugs)
    // won't succeed on retry, they just waste 500ms. Now: only retry if the
    // code/status indicates a network/Discord transient error.
    const TRANSIENT_ERROR_NAMES = new Set([
        'ConnectTimeoutError',
        'WebSocketClosedError',
        'FetchError' // undici fetch errors (network)
    ]);
    const TRANSIENT_ERROR_CODES = new Set([
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'EAI_AGAIN',
        'ENOTFOUND',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET'
    ]);
    function isRetryableAuditError(err) {
        const code = err.code || err.status || 0;
        // Discord 5xx (server error) — retry
        if (code >= 500 && code < 600) return true;
        // Rate limit — retry
        if (code === 429) return true;
        // Known network error codes (Node.js / undici) — retry
        if (typeof err.code === 'string' && TRANSIENT_ERROR_CODES.has(err.code)) return true;
        // Known network error names — retry
        if (TRANSIENT_ERROR_NAMES.has(err.name)) return true;
        return false;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            await channel.send({ embeds: [embed] });
            return true;
        } catch (err) {
            const code = err.code || err.status || 0;
            const isRetryable = isRetryableAuditError(err);
            if (attempt < MAX_ATTEMPTS && isRetryable) {
                console.warn(
                    `⚠️ Audit log attempt ${attempt} failed (code ${code}, ${err.name || 'unknown'}), retrying in ${RETRY_DELAY_MS}ms...`
                );
                await sleep(RETRY_DELAY_MS);
                continue;
            }
            console.warn(
                `⚠️ Audit log failed to send (attempt ${attempt}/${MAX_ATTEMPTS}, code ${code}):`,
                err.message
            );
            return false;
        }
    }
    return false;
}

module.exports = { logAudit, ACTION_LABELS };
