const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const scheduledPath = path.join(__dirname, '..', '..', 'data', 'scheduledRoles.json');

/**
 * File structure: scheduledRoles.json
 * [
 *   {
 *     "id": "uuid",
 *     "userId": "123456",
 *     "roleId": "789012",
 *     "guildId": "345678",
 *     "expireAt": 1735689600000,  // timestamp ms. null = permanent
 *     "productName": "30 Days",
 *     "createdAt": 1735000000000
 *   }
 * ]
 *
 * === KEY-DRIVEN MODEL — MAX EXTEND ===
 * A schedule's expireAt is updated to max(existing.expireAt, newKey.expireAt).
 * It is never shortened. Used by the Set Key button & /set-key command.
 *
 * When a schedule fires (in index.js processExpiredRole), the scheduler will:
 *   1. Check getActiveKeysByUserAndRole(userId, roleId)
 *   2. If a PERMANENT key exists → delete the schedule, the role stays
 *   3. If an active key with expireAt > now exists → updateExpireAt to the max, the role stays
 *   4. If no active key exists → remove the role + delete the schedule
 */

function loadScheduled() {
    try {
        if (!fs.existsSync(scheduledPath)) return [];
        return JSON.parse(fs.readFileSync(scheduledPath, 'utf8'));
    } catch (err) {
        console.error('Error loading scheduledRoles.json:', err.message);
        // v3.9.26: quarantine the corrupt file before falling back (see safeWrite.js).
        quarantineCorruptFile(scheduledPath);
        return [];
    }
}

/**
 * v3.9.0 FIX: atomic write via safeWriteJSON (tmp + rename).
 */
function saveScheduled(list) {
    safeWriteJSON(scheduledPath, list);
}

/**
 * Compute the remaining days of a schedule entry (can be negative if already expired).
 * Returns Infinity if permanent (expireAt = null).
 */
function getRemainingDays(entry, now = Date.now()) {
    if (entry.expireAt === null) return Infinity;
    return (entry.expireAt - now) / (24 * 60 * 60 * 1000);
}

/**
 * Remove ALL active schedules for a specific userId + roleId.
 * Used when a user upgrades to a permanent product (days=0) so the role isn't auto-removed.
 *
 * @param {string} userId
 * @param {string} roleId
 * @returns {number} number of entries removed
 */
function removeActiveByUserAndRole(userId, roleId) {
    const list = loadScheduled();
    const before = list.length;
    const filtered = list.filter(e => !(e.userId === userId && e.roleId === roleId));
    const removed = before - filtered.length;
    if (removed > 0) saveScheduled(filtered);
    return removed;
}

/**
 * Schedule role removal — MAX EXTEND mode (key-driven).
 *
 * Logic:
 * 1. If data.expireAt is given directly, use it.
 *    Otherwise compute from data.days (now + days * 86400000).
 *    If days <= 0 (or expireAt = null) → permanent, delete the old schedule.
 * 2. Check whether the user already has an active schedule for the same role.
 * 3. If there is one:
 *    - existing.expireAt = null (permanent) → nothing to change, return.
 *    - If newExpireAt = null (permanent) → update to permanent.
 *    - If newExpireAt > existing.expireAt → UPDATE (extend).
 *    - If newExpireAt <= existing.expireAt → NOT changed (no shortening).
 * 4. If none exists yet: create a new schedule.
 *
 * @param {Object} data - { userId, roleId, guildId, days?, expireAt?, productName? }
 * @returns {{
 *   entry: Object,
 *   extended: boolean,        // true if the schedule was extended
 *   previousExpireAt: number|null,
 *   newExpireAt: number|null,
 *   permanent: boolean        // true if it became permanent
 * }}
 */
function scheduleRoleRemoval(data) {
    const list = loadScheduled();
    const now = Date.now();

    // Compute newExpireAt
    let newExpireAt;
    let permanent = false;

    // expireAt <= 0 is treated as permanent (not a valid timestamp).
    // Before, expireAt=0 passed the check (!== undefined && !== null) → newExpireAt = 0
    // → treated as "already expired" → the scheduler removed the role within 60 seconds.
    // Example: a product with days=0 that somehow resolved to expireAt=0 → the VIP
    // role was auto-removed right after being granted. Silent data loss.
    if (data.expireAt !== undefined && data.expireAt !== null && data.expireAt > 0) {
        // Use the given expireAt directly
        newExpireAt = data.expireAt;
    } else {
        const days = Number(data.days) || 0;
        if (days <= 0) {
            // Permanent
            newExpireAt = null;
            permanent = true;
        } else {
            newExpireAt = now + days * 24 * 60 * 60 * 1000;
        }
    }

    if (newExpireAt === null) permanent = true;

    const existingIndex = list.findIndex(e => e.userId === data.userId && e.roleId === data.roleId);

    // === PERMANENT CASE: delete the old schedule, the role becomes permanent ===
    if (permanent) {
        let previousExpireAt = null;
        if (existingIndex !== -1) {
            previousExpireAt = list[existingIndex].expireAt;
            list.splice(existingIndex, 1);
        }
        saveScheduled(list);
        return {
            entry: null,
            extended: false,
            previousExpireAt,
            newExpireAt: null,
            permanent: true
        };
    }

    // === NON-PERMANENT CASE ===
    if (existingIndex !== -1) {
        const existing = list[existingIndex];
        const previousExpireAt = existing.expireAt;

        // Existing is permanent → nothing to change
        if (existing.expireAt === null) {
            return {
                entry: existing,
                extended: false,
                previousExpireAt: null,
                newExpireAt: null,
                permanent: true
            };
        }

        // MAX EXTEND: only update if newExpireAt is larger
        if (newExpireAt > existing.expireAt) {
            existing.expireAt = newExpireAt;
            if (data.productName) existing.productName = data.productName;
            saveScheduled(list);
            return {
                entry: existing,
                extended: true,
                previousExpireAt,
                newExpireAt,
                permanent: false
            };
        } else {
            // No extension (newExpireAt <= existing) — keep existing
            return {
                entry: existing,
                extended: false,
                previousExpireAt,
                newExpireAt: existing.expireAt,
                permanent: false
            };
        }
    }

    // === NO SCHEDULE YET → create a new one ===
    const entry = {
        id: `${now}_${Math.random().toString(36).slice(2, 8)}`,
        userId: data.userId,
        roleId: data.roleId,
        guildId: data.guildId,
        expireAt: newExpireAt,
        productName: data.productName || 'Unknown',
        createdAt: now
    };
    list.push(entry);
    saveScheduled(list);

    return {
        entry,
        extended: false,
        previousExpireAt: null,
        newExpireAt,
        permanent: false
    };
}

/**
 * Update the expireAt of a schedule entry (used when the scheduler re-checks).
 * Used by index.js processExpiredRole when an active key still exists with a
 * larger expireAt → reschedule to the max.
 * v3.9.0 FIX: skip the write if the value is unchanged (avoids disk I/O + a race window).
 *
 * @param {string} id - schedule entry id
 * @param {number} newExpireAt - new timestamp ms
 * @returns {boolean} true if successfully updated
 */
function updateExpireAt(id, newExpireAt) {
    const list = loadScheduled();
    const entry = list.find(e => e.id === id);
    if (!entry) return false;
    if (entry.expireAt === newExpireAt) return true; // unchanged, skip the write
    entry.expireAt = newExpireAt;
    saveScheduled(list);
    return true;
}

/**
 * Remove an entry from the scheduled list (usually after the role was successfully removed).
 * v3.9.0 FIX: skip the write if the entry is not found (avoids disk I/O).
 */
function removeEntry(id) {
    const list = loadScheduled();
    const filtered = list.filter(e => e.id !== id);
    if (filtered.length === list.length) return; // nothing removed, skip the write
    saveScheduled(filtered);
}

/**
 * Get all entries that have already expired (expireAt !== null && expireAt <= now).
 * Permanent entries (expireAt = null) will NEVER end up here.
 */
function getExpired() {
    const list = loadScheduled();
    const now = Date.now();
    return list.filter(e => e.expireAt !== null && e.expireAt <= now);
}

/**
 * Get all active entries (used for re-scheduling when the bot restarts).
 */
function getAllActive() {
    return loadScheduled();
}

/**
 * v3.9.4: Guild-scoped variant of getAllActive.
 * Only returns schedules belonging to this guild.
 *
 * @param {string} guildId
 * @returns {Array}
 */
function getActiveByGuild(guildId) {
    if (!guildId) return loadScheduled();
    return loadScheduled().filter(e => e.guildId === guildId);
}

/**
 * Find the active scheduled role for a specific user + role.
 */
function findActive(userId, roleId) {
    const list = loadScheduled();
    return list.find(e => e.userId === userId && e.roleId === roleId);
}

/**
 * Get all schedules owned by a specific user (all roles).
 */
function findAllByUser(userId) {
    const list = loadScheduled();
    return list.filter(e => e.userId === userId);
}

/**
 * Remove ALL schedules owned by a specific user.
 * v3.9.0 FIX: added the guildId parameter so no cross-guild wipe happens
 * when the bot is deployed multi-guild.
 *   - guildId given → only remove entries matching userId AND guildId.
 *   - guildId undefined → remove all of the user's entries (backward compat).
 * @returns {number} number removed
 */
function removeAllByUser(userId, guildId) {
    const list = loadScheduled();
    let filtered;
    if (guildId) {
        filtered = list.filter(e => !(e.userId === userId && e.guildId === guildId));
    } else {
        filtered = list.filter(e => e.userId !== userId);
    }
    const removed = list.length - filtered.length;
    if (removed > 0) saveScheduled(filtered);
    return removed;
}

module.exports = {
    scheduleRoleRemoval,
    updateExpireAt,
    removeEntry,
    getExpired,
    getAllActive,
    getActiveByGuild,
    findActive,
    findAllByUser,
    removeAllByUser,
    removeActiveByUserAndRole,
    getRemainingDays
};
