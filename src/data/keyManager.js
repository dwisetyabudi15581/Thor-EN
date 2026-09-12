const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const keysPath = path.join(__dirname, '..', '..', 'data', 'keys.json');

/**
 * File structure: keys.json
 * [
 *   {
 *     "id": "key_<timestamp>_<rand>",
 *     "key": "XXXXX-XXXXX-XXXXX",
 *     "userId": "123456",
 *     "username": "User#1234",
 *     "roleId": "789012",
 *     "productName": "30 Days",
 *     "days": 30,           // 0 = permanent
 *     "expireAt": 1735689600000,  // timestamp ms. null = permanent
 *     "createdAt": 1735000000000
 *   }
 * ]
 *
 * === KEY-DRIVEN MODEL ===
 * Every purchase = 1 new key with an INDEPENDENT expireAt (not stacked).
 * The VIP role follows the key with the MOST time remaining (max of all active keys).
 * Expired keys are automatically removed from keys.json.
 */

function loadKeys() {
    try {
        if (!fs.existsSync(keysPath)) return [];
        return JSON.parse(fs.readFileSync(keysPath, 'utf8'));
    } catch (err) {
        console.error('Error loading keys.json:', err.message);
        // v3.9.26: quarantine the corrupt file BEFORE returning [] — without this the
        // next save() would overwrite the corrupt file with an empty state → ALL VIP
        // keys permanently lost. (keys.json = the most critical data in this bot.)
        quarantineCorruptFile(keysPath);
        return [];
    }
}

/**
 * v3.9.0 FIX: uses safeWriteJSON (atomic tmp+rename) so a mid-write crash
 * doesn't corrupt keys.json (which could wipe all VIP keys).
 */
function saveKeys(list) {
    safeWriteJSON(keysPath, list);
}

function genId() {
    return `key_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Add a new key.
 *
 * @param {Object} data - { key, userId, username, roleId, productName, days, guildId }
 *   - days: 0 = permanent, >0 = duration in days
 *   - expireAt is computed automatically (now + days * 86400000), or null if permanent
 *   - guildId: the guild ID where this key was given (v3.9.3 — previously not stored,
 *     which broke removeAllKeysByUser(userId, guildId) because the filter never matched)
 * @returns {Object} the newly stored entry
 */
function addKey(data) {
    const list = loadKeys();
    const now = Date.now();
    const days = Number(data.days) || 0;
    const expireAt = days > 0 ? now + days * 24 * 60 * 60 * 1000 : null;

    // v3.9.38 FIX (FIX 5c): hardened data layer — empty/whitespace keys are REJECTED.
    // Before, the dup-check only did a truthy check `data.key &&` → "   " slipped
    // through and got stored as a blank key (buyers couldn't redeem anything). The
    // key is trimmed first, and the trimmed version is stored so the dup-check is accurate.
    const key = typeof data.key === 'string' ? data.key.trim() : '';
    if (!key) {
        throw new Error('Key cannot be empty');
    }

    // v3.9.8 FIX: check key uniqueness. Before there was no check → an admin typo
    // / copy-paste could create 2 entries with the same key, and getActiveKeysByUserAndRole
    // would double-count (though max() is idempotent, still UX confusion + could let
    // a member redeem 2x if the redemption logic uses find-by-key).
    // v3.9.38 FIX (FIX 6c): the error message NO LONGER includes the key value —
    // this error flows to the handler's console log (ticket.js/keys.js) → the raw key
    // would leak into logs. The admin already knows the key they just typed.
    if (list.some(k => k.key === key)) {
        throw new Error('Key already exists in the database (duplicate).');
    }

    const entry = {
        id: genId(),
        key,
        userId: data.userId,
        username: data.username || '',
        roleId: data.roleId,
        productName: data.productName || 'Unknown',
        days,
        expireAt,
        guildId: data.guildId || null, // v3.9.3: store guildId so cross-guild wipes can be accurate
        createdAt: now
    };
    list.push(entry);
    saveKeys(list);
    return entry;
}

/**
 * Get ALL keys owned by a specific user (no expired filter).
 * v3.9.8: added an optional guildId filter so /list-keys doesn't leak cross-guild.
 */
function findAllByUser(userId, guildId) {
    const list = loadKeys();
    if (guildId) {
        // Filter this user's keys in this guild.
        // Keys without a guildId (old schema, pre-v3.9.3) are included too (backward compat).
        return list.filter(k => k.userId === userId && (k.guildId === guildId || !k.guildId));
    }
    return list.filter(k => k.userId === userId);
}

/**
 * Get the active (not expired) keys owned by a user for a specific role.
 * Permanent keys (expireAt = null) always count as active.
 *
 * @param {string} userId
 * @param {string} roleId
 * @param {number} [now=Date.now()] - timestamp ms
 * @param {string|null} [guildId=null] - v3.9.31: optional guild filter (consistency
 *        with the findAllByUser pattern). Legacy keys without a guildId still count
 *        (backward compat). roleId is actually unique per guild (snowflake), so
 *        this is purely consistency, not a real leak fix.
 * @returns {Array} list of active keys
 */
function getActiveKeysByUserAndRole(userId, roleId, now = Date.now(), guildId = null) {
    const list = loadKeys();
    return list.filter(
        k =>
            k.userId === userId &&
            k.roleId === roleId &&
            (k.expireAt === null || k.expireAt > now) &&
            (!guildId || !k.guildId || k.guildId === guildId)
    );
}

/**
 * Does the user have a PERMANENT key for a specific role?
 */
function hasPermanentKey(userId, roleId) {
    const list = loadKeys();
    return list.some(k => k.userId === userId && k.roleId === roleId && k.expireAt === null);
}

/**
 * Get the LARGEST expireAt across all of a user+role's active keys.
 * - If a permanent key exists → return null (permanent)
 * - If active keys exist → return max(expireAt)
 * - If no active keys → return null (but the caller must check first)
 *
 * @returns {number|null} timestamp ms, or null if permanent / none
 */
function getMaxExpireAtByUserAndRole(userId, roleId, now = Date.now()) {
    const actives = getActiveKeysByUserAndRole(userId, roleId, now);
    if (actives.length === 0) return null;
    if (actives.some(k => k.expireAt === null)) return null; // a permanent one exists
    // v3.9.1 FIX: use reduce, not Math.max(...spread). If a user has
    // hundreds of active keys (extreme case), the spread can hit the call stack
    // limit and throw RangeError "Maximum call stack size exceeded".
    let max = -Infinity;
    for (const k of actives) {
        if (k.expireAt > max) max = k.expireAt;
    }
    return max === -Infinity ? null : max;
}

/**
 * Get all keys that have ALREADY expired (expireAt !== null && expireAt <= now).
 * Permanent keys will NEVER end up here.
 */
function getExpiredKeys(now = Date.now()) {
    const list = loadKeys();
    return list.filter(k => k.expireAt !== null && k.expireAt <= now);
}

/**
 * Get ALL keys in keys.json (for stats/debug purposes).
 */
function getAllKeys() {
    return loadKeys();
}

/**
 * Compute key statistics for /config-show.
 * Returns: { total, active, expired, permanent }
 *  - total: all keys in the file
 *  - active: expireAt > now OR permanent
 *  - expired: expireAt <= now (cleaned up by the scheduler)
 *  - permanent: days=0 or expireAt=null
 */
function getStats(now = Date.now()) {
    const list = loadKeys();
    let active = 0,
        expired = 0,
        permanent = 0;
    for (const k of list) {
        if (k.expireAt === null || k.days === 0) {
            permanent++;
            active++; // permanent is always active
        } else if (k.expireAt > now) {
            active++;
        } else {
            expired++;
        }
    }
    return { total: list.length, active, expired, permanent };
}

/**
 * v3.9.4: Guild-scoped variant of getStats.
 * Only counts keys belonging to this guild (or legacy keys without a guildId, treated as the calling guild's).
 *
 * @param {string} guildId
 * @param {number} now
 * @returns {{total, active, expired, permanent}}
 */
function getStatsByGuild(guildId, now = Date.now()) {
    if (!guildId) return getStats(now);
    const list = loadKeys().filter(k => !k.guildId || k.guildId === guildId);
    let active = 0,
        expired = 0,
        permanent = 0;
    for (const k of list) {
        if (k.expireAt === null || k.days === 0) {
            permanent++;
            active++;
        } else if (k.expireAt > now) {
            active++;
        } else {
            expired++;
        }
    }
    return { total: list.length, active, expired, permanent };
}

/**
 * Remove ALL expired keys from keys.json.
 * @returns {number} number of keys removed
 */
function removeExpiredKeys(now = Date.now()) {
    const list = loadKeys();
    const filtered = list.filter(k => k.expireAt === null || k.expireAt > now);
    const removed = list.length - filtered.length;
    if (removed > 0) saveKeys(filtered);
    return removed;
}

/**
 * Remove ALL keys owned by a specific user (used by /clear-schedule --clear_keys).
 * v3.9.0 FIX: added the guildId parameter so no cross-guild wipe happens.
 *   - If guildId is given: only remove keys matching userId AND guildId.
 *   - If guildId is undefined/null: old behavior (remove all of the user's keys — backward compat).
 *
 * v3.9.3 FIX: before, when guildId was passed but a key had no guildId field
 *   (old schema, pre-v3.9.3), the filter `k.guildId === guildId` NEVER matched
 *   because k.guildId was undefined. As a result, /clear-schedule clear_keys:true
 *   silently removed 0 keys while the admin believed VIP had been reset.
 *   Now: keys without a guildId (old schema) are treated as belonging to the calling
 *   guild (assumption: the bot was previously single-guild). New keys (v3.9.3+) have an explicit guildId.
 *
 * @param {string} userId
 * @param {string} [guildId] - optional, filter by guild when given
 * @returns {number} number of keys removed
 */
function removeAllKeysByUser(userId, guildId) {
    const list = loadKeys();
    let filtered;
    if (guildId) {
        // Remove this user's keys in this guild.
        // Keys without a guildId (old schema, pre-v3.9.3) are also removed since
        // they're assumed to belong to the first calling guild (backward compat).
        filtered = list.filter(
            k => !(k.userId === userId && (k.guildId === guildId || k.guildId === undefined || k.guildId === null))
        );
    } else {
        // Old behavior: remove all of the user's keys (backward compat for single-guild).
        filtered = list.filter(k => k.userId !== userId);
    }
    const removed = list.length - filtered.length;
    if (removed > 0) saveKeys(filtered);
    return removed;
}

/**
 * Remove ALL keys owned by a user for a specific role.
 * @returns {number} number of keys removed
 */
function removeAllKeysByUserAndRole(userId, roleId) {
    const list = loadKeys();
    const filtered = list.filter(k => !(k.userId === userId && k.roleId === roleId));
    const removed = list.length - filtered.length;
    if (removed > 0) saveKeys(filtered);
    return removed;
}

/**
 * Compute the remaining days of a key (can be negative if expired, Infinity if permanent).
 */
function getRemainingDays(key, now = Date.now()) {
    if (key.expireAt === null) return Infinity;
    return (key.expireAt - now) / (24 * 60 * 60 * 1000);
}

/**
 * Format the remaining-time display for a single key.
 */
function formatRemaining(key, now = Date.now()) {
    if (key.expireAt === null) return 'Permanent';
    const days = getRemainingDays(key, now);
    if (days <= 0) return 'Expired';
    if (days < 1) {
        const hours = Math.ceil(days * 24);
        return `${hours} hours left`;
    }
    return `${Math.ceil(days)} days left`;
}

/**
 * Format a key list for display to a user/admin.
 * Only shows active keys.
 */
function formatKeysForUser(keys, now = Date.now()) {
    if (keys.length === 0) return '(no keys)';
    return keys
        .map((k, i) => {
            const remaining = formatRemaining(k, now);
            return `\`${i + 1}.\` \`${k.key}\` — ${k.productName} — ${remaining}`;
        })
        .join('\n');
}

module.exports = {
    addKey,
    findAllByUser,
    getActiveKeysByUserAndRole,
    hasPermanentKey,
    getMaxExpireAtByUserAndRole,
    getExpiredKeys,
    getAllKeys,
    getStats,
    getStatsByGuild,
    removeExpiredKeys,
    removeAllKeysByUser,
    removeAllKeysByUserAndRole,
    getRemainingDays,
    formatRemaining,
    formatKeysForUser
};
