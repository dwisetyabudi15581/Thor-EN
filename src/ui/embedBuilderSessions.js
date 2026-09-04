/**
 * In-memory session manager for the interactive Embed Builder.
 *
 * Sessions are lost when the bot restarts (acceptable for builder UX).
 * If a user clicks a stale draft button after a restart → reply "session expired".
 *
 * Session structure:
 * {
 *   id: 'emb_<timestamp>_<rand>',
 *   ownerId: '<discord user id>',
 *   channelId: '<channel where draft message lives>',
 *   messageId: '<draft message id>',
 *   data: {
 *     title, description, color (number), image {url}, thumbnail {url},
 *     footer {text, iconURL?}, author {name, iconURL?},
 *     fields: [{name, value, inline}], timestamp (boolean),
 *     content: string | null  // v3.9.6: plain text message sent along with the embed
 *   },
 *   createdAt: timestamp
 * }
 */

const sessions = new Map();

// v3.9.38: truncate text per code point (emoji/surrogate pair safe).
const { truncateUtf8Safe } = require('../infra/text');

// P3-4 FIX: TTL so sessions abandoned by users don't become a memory leak.
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // cleanup every 10 minutes

setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, s] of sessions) {
        if (now - s.createdAt > SESSION_TTL_MS) {
            sessions.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Embed builder: removed ${cleaned} expired session(s).`);
    }
}, CLEANUP_INTERVAL_MS).unref?.();

function genId() {
    // v3.9.8 FIX: increase the random suffix from 4 chars to 8 chars.
    // Previously only 4 base36 chars (~20 bits) — collision risk if 2 sessions
    // are created in the same ms. Now 8 chars (~41 bits) + timestamp, very safe.
    return `emb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createDefaultData() {
    return {
        title: null,
        description: null,
        color: 0x5865f2, // default blurple
        image: null,
        thumbnail: null,
        footer: null,
        author: null,
        fields: [],
        timestamp: true,
        content: null // v3.9.6: plain text message sent along with the embed (outside the embed)
    };
}

function createSession(ownerId, channelId) {
    const id = genId();
    const session = {
        id,
        ownerId,
        channelId,
        messageId: null,
        data: createDefaultData(),
        createdAt: Date.now()
    };
    sessions.set(id, session);
    return session;
}

function getSession(id) {
    const s = sessions.get(id);
    if (!s) return null;
    // P3-4 FIX: lazy expiry on access
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
        sessions.delete(id);
        return null;
    }
    return s;
}

function getSessionByMessage(messageId) {
    for (const s of sessions.values()) {
        if (s.messageId === messageId) return s;
    }
    return null;
}

function deleteSession(id) {
    return sessions.delete(id);
}

/**
 * v3.9.17: parseColor is deprecated. Now delegates to the shared helper in
 * infra/colors.js so the logic isn't duplicated. This function is kept for
 * backward compatibility (exported via _shared.js and used in several files).
 *
 * @deprecated Use `parseColor` from `infra/colors.js` instead.
 */
const { parseColor: _sharedParseColor } = require('../infra/colors');
function parseColor(input) {
    return _sharedParseColor(input);
}

/**
 * Build a Discord EmbedBuilder from session data.
 *
 * Note: the Discord API requires an embed to have at least one of:
 * title, description, fields, image, thumbnail, author, footer.
 * If the session is in an empty state (freshly created), we use a placeholder
 * description to avoid the BASE_TYPE_REQUIRED error.
 */
function buildEmbed(session) {
    // Lazy require so this file can be loaded without discord.js (for testing)
    const { EmbedBuilder } = require('discord.js');
    const d = session.data;
    const embed = new EmbedBuilder();

    // Detect empty state: no title, description, fields, image,
    // thumbnail, author, or footer. If empty, use a placeholder.
    const hasContent =
        d.title ||
        d.description ||
        (d.fields && d.fields.length > 0) ||
        d.image ||
        d.thumbnail ||
        (d.footer && d.footer.text) ||
        (d.author && d.author.name);

    if (!hasContent) {
        embed.setDescription('*(No content yet — use the dropdown below to start editing the embed.)*');
    } else {
        if (d.title) embed.setTitle(d.title);
        if (d.description) embed.setDescription(d.description);
        if (d.image) embed.setImage(d.image.url);
        if (d.thumbnail) embed.setThumbnail(d.thumbnail.url);
        if (d.footer && d.footer.text) {
            const f = { text: d.footer.text };
            if (d.footer.iconURL) f.iconURL = d.footer.iconURL;
            embed.setFooter(f);
        }
        if (d.author && d.author.name) {
            const a = { name: d.author.name };
            if (d.author.iconURL) a.iconURL = d.author.iconURL;
            embed.setAuthor(a);
        }
        // Defensive validation — Discord limits: max 25 fields, name max 256, value max 1024.
        // If a session somehow accumulates >25 fields, addFields would throw a RangeError
        // → the draft render fails → the user sees a broken panel.
        if (d.fields && d.fields.length > 0) {
            const safeFields = d.fields.slice(0, 25).map(f => ({
                // v3.9.38 FIX: truncate per code point (a plain slice() could cut an
                // emoji surrogate pair into a lone surrogate → the embed gets rejected by the API).
                // maxLen is reduced by 1 so the total WITH the '…' ellipsis stays ≤ 256/1024.
                name: truncateUtf8Safe(String(f.name || '\u200B'), 255),
                value: truncateUtf8Safe(String(f.value || '\u200B'), 1023),
                inline: !!f.inline
            }));
            embed.addFields(safeFields);
        }
    }

    if (d.color !== null && d.color !== undefined) embed.setColor(d.color);
    if (d.timestamp) embed.setTimestamp();
    return embed;
}

/**
 * Build a status text for display in the control panel (optional).
 * Useful for debugging or quick info.
 */
function getStatusText(session) {
    const d = session.data;
    const lines = [];
    lines.push(`Title: ${d.title ? '✅' : '❌'}`);
    lines.push(`Description: ${d.description ? '✅' : '❌'}`);
    lines.push(`Color: ${d.color !== null ? '✅ #' + d.color.toString(16).padStart(6, '0') : 'default'}`);
    lines.push(`Image: ${d.image ? '✅' : '❌'}`);
    lines.push(`Thumbnail: ${d.thumbnail ? '✅' : '❌'}`);
    lines.push(`Footer: ${d.footer ? '✅' : '❌'}`);
    lines.push(`Author: ${d.author ? '✅' : '❌'}`);
    lines.push(`Fields: ${d.fields.length}/25`);
    lines.push(`Timestamp: ${d.timestamp ? '✅' : '❌'}`);
    // v3.9.6: show the plain text message status (outside the embed)
    lines.push(`Message: ${d.content ? `✅ (${d.content.length} char)` : '❌'}`);
    return lines.join('\n');
}

/**
 * List all sessions belonging to a specific user (sorted newest first).
 * Used by the /embed-list command.
 */
function getSessionsByUser(userId) {
    const result = [];
    for (const s of sessions.values()) {
        if (s.ownerId === userId) result.push(s);
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Delete a user's session by ID.
 * Used by the /embed-cancel command (for sessions whose draft was already deleted).
 * Returns: the deleted session, or null if not found / not owned by the user.
 */
function deleteSessionByOwner(sessionId, userId) {
    const s = sessions.get(sessionId);
    if (!s || s.ownerId !== userId) return null;
    sessions.delete(sessionId);
    return s;
}

module.exports = {
    createSession,
    getSession,
    getSessionByMessage,
    getSessionsByUser,
    deleteSession,
    deleteSessionByOwner,
    buildEmbed,
    parseColor,
    getStatusText
};
