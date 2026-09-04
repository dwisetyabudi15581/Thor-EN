/**
 * AFK Manager — track users who are AFK + auto-reply when mentioned.
 *
 * File: data/afk.json
 * {
 *   "<guildId>:<userId>": {
 *     "reason": "Grabbing food",
 *     "since": 1735689600000,
 *     "guildId": "...",
 *     "userId": "..."
 *   }
 * }
 *
 * Composite key so AFK is scoped per guild (a user can be AFK in guild A but
 * active in guild B).
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'afk.json');

// v3.9.26: read-through cache (panelManager pattern). messageCreate reads
// afk.json per message + per mention — previously that was 1+N sync
// readFileSync calls per message. 15s TTL cache + update-on-save; manual
// invalidation via invalidateCache() (used by backup restore & test cleanup).
const CACHE_TTL_MS = 15 * 1000;
let _cache = null; // { data, at }

function load() {
    try {
        if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data;
        if (!fs.existsSync(filePath)) {
            _cache = { data: {}, at: Date.now() };
            return _cache.data;
        }
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        _cache = { data, at: Date.now() };
        return data;
    } catch (_err) {
        // v3.9.26: quarantine the corrupt file BEFORE falling back — without
        // this, the next save() overwrites the corrupt file with empty state
        // (data lost permanently).
        quarantineCorruptFile(filePath);
        _cache = { data: {}, at: Date.now() };
        return _cache.data;
    }
}

function save(data) {
    safeWriteJSON(filePath, data);
    // v3.9.26: update the cache so the next read is consistent with what was just written
    _cache = { data, at: Date.now() };
}

/** v3.9.26: force the next read to be fresh (backup restore / tests). */
function invalidateCache() {
    _cache = null;
}

function keyFor(guildId, userId) {
    return `${guildId}:${userId}`;
}

function setAFK(guildId, userId, reason) {
    const all = load();
    const k = keyFor(guildId, userId);
    all[k] = {
        reason: reason || 'AFK',
        since: Date.now(),
        guildId,
        userId
    };
    save(all);
    return all[k];
}

function clearAFK(guildId, userId) {
    const all = load();
    const k = keyFor(guildId, userId);
    if (!all[k]) return false;
    delete all[k];
    save(all);
    return true;
}

function getAFK(guildId, userId) {
    const all = load();
    return all[keyFor(guildId, userId)] || null;
}

function isAFK(guildId, userId) {
    return getAFK(guildId, userId) !== null;
}

/**
 * v3.9.26: Batch-check AFK for many users with a SINGLE load.
 * messageCreate used to call getAFK() per mention (1+N reads per message
 * containing mentions). Now one load covers all mentions.
 *
 * @param {string} guildId
 * @param {string[]} userIds
 * @returns {Object<string, {reason, since, guildId, userId}>} map of userId → AFK data (only those who are AFK)
 */
function getAFKBatch(guildId, userIds) {
    if (!Array.isArray(userIds) || userIds.length === 0) return {};
    const all = load();
    const result = {};
    for (const uid of userIds) {
        const entry = all[keyFor(guildId, uid)];
        if (entry) result[uid] = entry;
    }
    return result;
}

/**
 * Format the AFK duration (e.g. "5 minutes ago", "2 hours ago", "1 day ago").
 */
function formatDuration(since, now = Date.now()) {
    const diff = now - since;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
}

/**
 * List all AFK users in a given guild, sorted by since (most recent first).
 * v3.9.17: added so /afk-list doesn't need to read afk.json directly.
 *
 * @param {string} guildId
 * @returns {Array<{userId, reason, since, guildId}>}
 */
function listGuildAFK(guildId) {
    const all = load();
    return Object.values(all)
        .filter(data => data && data.guildId === guildId)
        .sort((a, b) => b.since - a.since);
}

/**
 * v3.9.38 FIX (GC): delete AFK entries older than `maxAgeMs`.
 * afk.json was previously NEVER garbage-collected — users who left the guild /
 * forgot to clear stayed marked AFK forever (auto-replies kept mentioning
 * long-gone users + the file grew slowly without bound). Old entries WITHOUT
 * a `since` field (pre-v3.9.x format) are kept — their age can't be determined,
 * don't break them.
 * Called by the daily scheduler (pruneStaleData in schedulerTasks.js).
 * Returns the number of entries removed.
 */
function pruneOldAFK(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    const all = load();
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [k, entry] of Object.entries(all)) {
        if (!entry || typeof entry !== 'object') continue;
        // Entry without `since` (not a number) → keep, don't break old data.
        if (typeof entry.since !== 'number' || Number.isNaN(entry.since)) continue;
        if (entry.since < cutoff) {
            delete all[k];
            removed++;
        }
    }
    if (removed > 0) save(all);
    return removed;
}

module.exports = {
    setAFK,
    clearAFK,
    getAFK,
    isAFK,
    getAFKBatch,
    formatDuration,
    listGuildAFK,
    invalidateCache,
    // v3.9.38
    pruneOldAFK
};
