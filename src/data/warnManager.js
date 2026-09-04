/**
 * Warn Manager — track warning member + auto-action berdasarkan threshold.
 *
 * File: warns.json
 * {
 *   "<guildId>:<userId>": [
 *     {
 *       id: "warn_<timestamp>_<rand>",
 *       reason: "Spam di #general",
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
 * Threshold default:
 *   3 warn → mute 1 jam
 *   5 warn → mute 1 hari
 *   7 warn → kick
 *
 * v3.9.0 FIX: key diganti dari `userId` (global) → `${guildId}:${userId}` (composite).
 *   Sebelumnya, kalau bot di-deploy multi-guild, warn di Guild A ikut dihitung
 *   untuk threshold kick di Guild B. Sekarang scoped per guild.
 *   Backward compat: kalau load() nemu key lama (tanpa `:`), auto-migrate pakai
 *   guildId dari field `guildId` di dalam entry.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'warns.json');

const DEFAULT_THRESHOLDS = {
    mute1h: 3, // 3 warnings → mute 1 jam
    mute1d: 5, // 5 warnings → mute 1 hari
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
        console.warn('⚠️ warns.json rusak:', err.message);
        // v3.9.26: karantina file korup sebelum fallback (lihat safeWrite.js).
        quarantineCorruptFile(filePath);
        return {};
    }

    // v3.9.0: detect old format (key is plain userId, no `:`) and migrate.
    // Old keys look like "1234567890" (just digits). New keys have `:`.
    // v3.9.17 FIX: entry tanpa guildId jangan di-drop. Sebelumnya, entry orphan
    // di-skip + dihapus dari file saat save. Sekarang: assign ke default guild
    // supaya data tidak hilang (admin bisa investigasi manual).
    let needsMigration = false;
    const migrated = {};
    const DEFAULT_GUILD_ID = 'legacy'; // placeholder guild untuk entry orphan
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
                    // v3.9.17: assign ke default guild 'legacy' supaya entry tidak hilang.
                    console.warn(
                        `⚠️ Warn entry ${w.id} untuk user ${k} tidak punya guildId, assign ke guild 'legacy'.`
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
        console.log('🔄 warns.json di-migrate dari format lama (userId key) ke format baru (guildId:userId key).');
        try {
            safeWriteJSON(filePath, migrated);
        } catch (err) {
            console.warn('⚠️ Gagal save hasil migrasi warns.json:', err.message);
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
 * Tambah warn ke user (scoped to guild).
 *
 * @param {string} guildId - ID guild tempat warn terjadi (WAJIB)
 * @param {string} userId - ID user yang di-warn
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

    // Tentukan action berdasarkan threshold
    let actionToTake = null;
    if (count >= DEFAULT_THRESHOLDS.kick) actionToTake = 'kick';
    else if (count >= DEFAULT_THRESHOLDS.mute1d) actionToTake = 'mute_1d';
    else if (count >= DEFAULT_THRESHOLDS.mute1h) actionToTake = 'mute_1h';

    // P1-7 FIX: cek apakah action yang sama sudah pernah diambil sebelumnya.
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
 * Ambil semua warn user di guild tertentu.
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
 * Tandai warn tertentu sudah menyebabkan action tertentu.
 * v3.9.0 FIX: return boolean supaya caller tahu apakah mark berhasil.
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
