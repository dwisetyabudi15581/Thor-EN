/**
 * Mod Log Manager — per-user moderation action history (v3.9.43).
 *
 * File: data/modlogs.json
 * {
 *   "<guildId>:<userId>": [
 *     {
 *       id: "mod_<timestamp>_<rand>",
 *       type: "timeout" | "untimeout" | "kick" | "ban" | "unban",
 *       reason: "Ad spam",
 *       durationMs: 3600000 | null,          // timeout only
 *       moderatorId: "...",
 *       moderatorTag: "Admin#1234",
 *       guildId: "...",
 *       userId: "...",
 *       createdAt: 1735689600000
 *     }
 *   ]
 * }
 *
 * Why NOT merged into warns.json:
 *   1. Warn entries count toward auto-action thresholds (3=mute 1h, etc.).
 *      If /timeout were recorded as a warn, 3 timeouts → an EXTRA auto
 *      1-hour mute stacked on top of the manual timeouts — confusing
 *      double punishment.
 *   2. Different semantics: warn = violation; modlog = action. Merged,
 *      /warn-remove becomes ambiguous (remove a violation or remove an
 *      admin's action record?).
 *   Integration still exists: /warn-list renders the modlog as a
 *   "Moderation History" section — one view, two data sources, no
 *   threshold side effects.
 *
 * Pattern: same as warnManager — composite key `${guildId}:${userId}`,
 * safeWriteJSON + corrupt file quarantine, scoped per guild.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'modlogs.json');

/** @type {Object<string, Array<Object>>} in-memory cache */
let store = null;

function keyFor(guildId, userId) {
    return `${guildId}:${userId}`;
}

function load() {
    if (store) return store;
    try {
        if (!fs.existsSync(filePath)) {
            store = {};
            return store;
        }
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        store = raw && typeof raw === 'object' ? raw : {};
    } catch (err) {
        console.warn('⚠️ modlogs.json is corrupt:', err.message);
        // v3.9.26 pattern: quarantine the corrupt file before the empty fallback.
        quarantineCorruptFile(filePath);
        store = {};
    }
    return store;
}

function save() {
    try {
        safeWriteJSON(filePath, store);
    } catch (err) {
        console.error('❌ Failed to save modlogs.json:', err.message);
    }
}

/**
 * Record a moderation action.
 * @param {string} guildId
 * @param {string} userId
 * @param {{type: string, reason?: string, durationMs?: number|null, moderatorId: string, moderatorTag: string}} entry
 * @returns {Object} the newly created record (with id & createdAt)
 */
function addModLog(guildId, userId, entry) {
    const store = load();
    const key = keyFor(guildId, userId);
    if (!Array.isArray(store[key])) store[key] = [];

    const record = {
        id: `mod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: entry.type,
        reason: entry.reason || '(no reason given)',
        durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : null,
        moderatorId: entry.moderatorId,
        moderatorTag: entry.moderatorTag || entry.moderatorId,
        guildId,
        userId,
        createdAt: Date.now()
    };
    store[key].push(record);
    save();
    return record;
}

/**
 * Get a user's moderation history (guild-scoped).
 * @returns {Array<Object>}
 */
function getModLogs(guildId, userId) {
    const store = load();
    return store[keyFor(guildId, userId)] || [];
}

/**
 * Count of a user's moderation actions (without loading the array to the caller).
 */
function getModLogCount(guildId, userId) {
    return getModLogs(guildId, userId).length;
}

/**
 * Action type label (used by /warn-list & DMs).
 */
function modLogTypeLabel(type) {
    switch (type) {
        case 'timeout':
            return '🔇 Timeout';
        case 'untimeout':
            return '🔊 Timeout Removed';
        case 'kick':
            return '👢 Kick';
        case 'ban':
            return '🔨 Ban';
        case 'unban':
            return '♻️ Unban';
        default:
            return type;
    }
}

module.exports = {
    addModLog,
    getModLogs,
    getModLogCount,
    modLogTypeLabel,
    _filePath: filePath,
    _resetForTests() {
        store = null;
    }
};
