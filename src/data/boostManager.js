/**
 * Boost Manager — server booster history & state (v3.9.49).
 *
 * File: data/boosts.json
 * {
 *   "<guildId>:<userId>": {
 *     guildId: "...",
 *     userId: "...",
 *     boostedAt: 1735689600000,   // start of the CURRENT boost streak (null = never)
 *     removedAt: 1736000000000,   // when the current boost ended (null = still boosting / never)
 *     totalBoosts: 3,             // how many times this user has STARTED boosting (all-time)
 *     lastEventAt: 1736000000000, // timestamp of the last add/remove we recorded
 *     lastEvent: "add" | "remove"
 *   }
 * }
 *
 * Why a data file when Discord already knows the live boosters?
 *   - premiumSinceTimestamp answers "who boosts NOW" but NOT "who boosted
 *     while the bot was offline" and NOT "how many boost events happened".
 *   - The event fires guildMemberUpdate with a PREMIUM_SINCE diff — Discord
 *     gives no dedicated boost event, so the bot derives add/remove itself
 *     and persists the history here.
 *
 * Pattern: same as modLogManager/warnManager — composite key
 * `${guildId}:${userId}`, safeWriteJSON + corrupt file quarantine, scoped
 * per guild.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'boosts.json');

/** @type {Object<string, Object>} in-memory cache */
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
        console.warn('⚠️ boosts.json is corrupt:', err.message);
        quarantineCorruptFile(filePath);
        store = {};
    }
    return store;
}

function save() {
    try {
        safeWriteJSON(filePath, store);
    } catch (err) {
        console.error('❌ Failed to save boosts.json:', err.message);
    }
}

/**
 * Record that a user STARTED boosting (premium_since went null → date).
 * Idempotent against duplicates (a second consecutive 'add' with no 'remove'
 * between is ignored — the guildMemberUpdate diff already guards this, this
 * is defense in depth for the startup reconcile).
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {number} [ts=Date.now()]
 * @returns {boolean} true when the state actually changed
 */
function recordBoostStart(guildId, userId, ts = Date.now()) {
    const all = load();
    const key = keyFor(guildId, userId);
    const entry = all[key] || { guildId, userId, boostedAt: null, removedAt: null, totalBoosts: 0 };
    entry.guildId = guildId;
    entry.userId = userId;
    if (entry.lastEvent === 'add') return false; // duplicate — no change
    entry.boostedAt = ts;
    entry.removedAt = null;
    entry.totalBoosts = (entry.totalBoosts || 0) + 1;
    entry.lastEvent = 'add';
    entry.lastEventAt = ts;
    all[key] = entry;
    save();
    return true;
}

/**
 * Record that a user STOPPED boosting (premium_since went date → null).
 * @param {string} guildId
 * @param {string} userId
 * @param {number} [ts=Date.now()]
 * @returns {boolean} true when the state actually changed
 */
function recordBoostEnd(guildId, userId, ts = Date.now()) {
    const all = load();
    const key = keyFor(guildId, userId);
    const entry = all[key] || { guildId, userId, boostedAt: null, removedAt: null, totalBoosts: 0 };
    entry.guildId = guildId;
    entry.userId = userId;
    if (entry.lastEvent === 'remove') return false; // duplicate — no change
    entry.removedAt = ts;
    entry.lastEvent = 'remove';
    entry.lastEventAt = ts;
    all[key] = entry;
    save();
    return true;
}

/**
 * All entries scoped to a guild (raw history records).
 * @param {string} guildId
 * @returns {Array<Object>}
 */
function getBoostHistory(guildId) {
    const all = load();
    return Object.values(all)
        .filter(e => e && e.guildId === guildId && String(e.userId || '').length > 0)
        .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
}

/**
 * Recent boost EVENTS (add/remove) for the /boosters "Recent Activity" section.
 * @param {string} guildId
 * @param {number} [limit=5]
 * @returns {Array<{userId, event, at, boostedAt}>}
 */
function getRecentEvents(guildId, limit = 5) {
    return getBoostHistory(guildId)
        .filter(e => e.lastEvent)
        .slice(0, limit)
        .map(e => ({ userId: e.userId, event: e.lastEvent, at: e.lastEventAt, boostedAt: e.boostedAt }));
}

/**
 * v3.9.49: startup/offline catch-up — diff the LIVE boosters (from the guild
 * member cache) against the stored state. Returns the changes so ready.js can
 * announce them (one consolidated embed) and the records stay in sync even
 * when boosts happened while the bot was offline.
 *
 * @param {Object} guild - a discord.js Guild (members cache may be partial)
 * @returns {{added: string[], removed: string[]}} changed userIds
 */
function reconcileBoosters(guild) {
    const added = [];
    const removed = [];
    if (!guild || !guild.id || !guild.members || !guild.members.cache) return { added, removed };

    const liveBoosters = new Map();
    for (const m of guild.members.cache.values()) {
        if (m.user?.bot) continue;
        // m.id is the canonical GuildMember id in discord.js; the .user?.id
        // fallback keeps stubs/mocks (and partials) working.
        const uid = m.id || m.user?.id;
        if (!uid) continue;
        if (m.premiumSinceTimestamp) liveBoosters.set(uid, m.premiumSinceTimestamp);
    }

    const history = getBoostHistory(guild.id);
    const storedActive = new Map(history.filter(e => e.lastEvent === 'add').map(e => [e.userId, e]));

    // Live boosters missing from the stored active set → they boosted while offline.
    for (const [userId, since] of liveBoosters) {
        const stored = storedActive.get(userId);
        if (!stored) {
            if (recordBoostStart(guild.id, userId, since)) added.push(userId);
        } else {
            // Streak restarted (boost lapsed & re-boosted) — refresh boostedAt
            // without inflating totalBoosts (the gap itself is not observable).
            if (stored.boostedAt !== since) {
                const all = load();
                const entry = all[keyFor(guild.id, userId)];
                if (entry) {
                    entry.boostedAt = since;
                    entry.lastEventAt = since;
                    save();
                }
            }
        }
    }

    // Stored active boosters no longer boosting live → they stopped while offline.
    for (const [userId] of storedActive) {
        if (!liveBoosters.has(userId)) {
            if (recordBoostEnd(guild.id, userId)) removed.push(userId);
        }
    }

    return { added, removed };
}

/**
 * Test/maintenance hook: reset the in-memory cache (reload from disk).
 */
function reload() {
    store = null;
    return load();
}

module.exports = {
    recordBoostStart,
    recordBoostEnd,
    getBoostHistory,
    getRecentEvents,
    reconcileBoosters,
    reload
};
