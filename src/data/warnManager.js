/**
 * Warn Manager — track member warnings + auto-actions based on thresholds.
 *
 * File: warns.json
 * {
 *   "<guildId>:<userId>": [
 *     {
 *       id: "warn_<timestamp>_<rand>",
 *       reason: "Spam in #general",
 *       warnedBy: "adminId",
 *       warnedByTag: "Admin#1234",
 *       guildId: "...",
 *       userId: "...",
 *       createdAt: 1735689600000,
 *       actionTaken: null | "mute_1h" | "mute_1d" | "kick"
 *     }
 *   ]
 * }
 *
 * Default thresholds:
 *   3 warnings → 1 hour mute
 *   5 warnings → 1 day mute
 *   7 warnings → kick
 *
 * v3.9.0 FIX: key changed from `userId` (global) → `${guildId}:${userId}` (composite).
 *   Previously, if the bot was deployed multi-guild, warnings in Guild A also
 *   counted toward the kick threshold in Guild B. Now scoped per guild.
 *   Backward compat: if load() finds an old key (without `:`), it auto-migrates
 *   using the guildId field inside the entry.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'warns.json');

const DEFAULT_THRESHOLDS = {
    mute1h: 3, // 3 warnings → 1 hour mute
    mute1d: 5, // 5 warnings → 1 day mute
    kick: 7 // 7 warnings → kick
};

/**
 * Composite key helper.
 */
function keyFor(guildId, userId) {
    return `${guildId}:${userId}`;
}

/**
 * Load warns.json. Auto-migrate from old format (key=userId only) to new format
 * (key=`guildId:userId`). Migration is one-shot — once migrated, file is saved
 * in new format and next load is fast.
 */
function load() {
    let raw = {};
    try {
        if (!fs.existsSync(filePath)) return {};
        raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.warn('⚠️ warns.json is corrupt:', err.message);
        // v3.9.26: quarantine the corrupt file before falling back (see safeWrite.js).
        quarantineCorruptFile(filePath);
        return {};
    }

    // v3.9.0: detect old format (key is plain userId, no `:`) and migrate.
    // Old keys look like "1234567890" (just digits). New keys have `:`.
    // v3.9.17 FIX: don't drop entries without a guildId. Previously, orphan
    // entries were skipped + deleted from the file on save. Now: assign them to
    // a default guild so the data isn't lost (an admin can investigate manually).
    let needsMigration = false;
    const migrated = {};
    const DEFAULT_GUILD_ID = 'legacy'; // placeholder guild for orphan entries
    for (const [k, warns] of Object.entries(raw)) {
        if (k.includes(':')) {
            // New format — keep as-is.
            migrated[k] = warns;
        } else {
            // Old format — k is userId, need to re-key using guildId from each warn entry.
            needsMigration = true;
            if (!Array.isArray(warns)) continue;
            for (const w of warns) {
                if (!w.guildId) {
                    // v3.9.17: assign to the default 'legacy' guild so the entry isn't lost.
                    console.warn(
                        `⚠️ Warn entry ${w.id} for user ${k} has no guildId, assigning to guild 'legacy'.`
                    );
                    w.guildId = DEFAULT_GUILD_ID;
                }
                const newKey = keyFor(w.guildId, k);
                if (!migrated[newKey]) migrated[newKey] = [];
                // Backfill userId into entry (new field added in v3.9.0).
                if (!w.userId) w.userId = k;
                migrated[newKey].push(w);
            }
        }
    }

    if (needsMigration) {
        console.log('🔄 warns.json migrated from the old format (userId key) to the new format (guildId:userId key).');
        try {
            safeWriteJSON(filePath, migrated);
        } catch (err) {
            console.warn('⚠️ Failed to save the warns.json migration result:', err.message);
        }
    }

    return migrated;
}

// v3.9.0 FIX: atomic write via safeWriteJSON (tmp+rename) to prevent corruption on crash
function save(data) {
    safeWriteJSON(filePath, data);
}

function genId() {
    return `warn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Add a warning to a user (scoped to a guild).
 *
 * @param {string} guildId - ID of the guild where the warning was issued (REQUIRED)
 * @param {string} userId - ID of the user being warned
 * @param {Object} data - { reason, warnedBy, warnedByTag }
 * @returns {Object} { warnEntry, count, actionToTake, actionAlreadyTaken }
 */
function addWarn(guildId, userId, data) {
    const all = load();
    const k = keyFor(guildId, userId);
    if (!all[k]) all[k] = [];
    const entry = {
        id: genId(),
        reason: data.reason,
        warnedBy: data.warnedBy,
        warnedByTag: data.warnedByTag,
        guildId,
        userId,
        createdAt: Date.now(),
        actionTaken: null
    };
    all[k].push(entry);
    save(all);

    const count = all[k].length;

    // Determine the action based on the thresholds
    let actionToTake = null;
    if (count >= DEFAULT_THRESHOLDS.kick) actionToTake = 'kick';
    else if (count >= DEFAULT_THRESHOLDS.mute1d) actionToTake = 'mute_1d';
    else if (count >= DEFAULT_THRESHOLDS.mute1h) actionToTake = 'mute_1h';

    // P1-7 FIX: check whether the same action has already been taken before.
    let actionAlreadyTaken = false;
    if (actionToTake && actionToTake !== 'kick') {
        const previouslyTookSameAction = all[k].some(w => w.id !== entry.id && w.actionTaken === actionToTake);
        if (previouslyTookSameAction) {
            actionAlreadyTaken = true;
            actionToTake = null;
        }
    }

    return { warnEntry: entry, count, actionToTake, actionAlreadyTaken };
}

/**
 * Get all warnings for a user in a given guild.
 */
function getWarns(guildId, userId) {
    const all = load();
    return all[keyFor(guildId, userId)] || [];
}

function getWarnCount(guildId, userId) {
    return getWarns(guildId, userId).length;
}

function removeWarn(guildId, userId, warnId) {
    const all = load();
    const k = keyFor(guildId, userId);
    if (!all[k]) return false;
    const before = all[k].length;
    all[k] = all[k].filter(w => w.id !== warnId);
    if (all[k].length === 0) delete all[k];
    else if (all[k].length === before) return false;
    save(all);
    return true;
}

function clearWarns(guildId, userId) {
    const all = load();
    const k = keyFor(guildId, userId);
    if (!all[k]) return 0;
    const count = all[k].length;
    delete all[k];
    save(all);
    return count;
}

/**
 * Mark a specific warning as having triggered a specific action.
 * v3.9.0 FIX: returns a boolean so the caller knows if the mark succeeded.
 */
function markActionTaken(guildId, userId, warnId, action) {
    const all = load();
    const k = keyFor(guildId, userId);
    if (!all[k]) return false;
    const w = all[k].find(x => x.id === warnId);
    if (!w) return false;
    w.actionTaken = action;
    save(all);
    return true;
}

module.exports = {
    addWarn,
    getWarns,
    getWarnCount,
    removeWarn,
    clearWarns,
    markActionTaken,
    DEFAULT_THRESHOLDS
};
