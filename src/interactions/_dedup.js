/**
 * Interaction dedup helper — mencegah double-processing interaction yang sama.
 *
 * P1-6 FIX: track interaction yang sudah diproses untuk hindari double-processing.
 * Sebelumnya modal submit lewat guard `replied/deferred` → bisa double-reply.
 *
 * v3.9.8 FIX: ganti bulk-clear dengan per-entry TTL. Sebelumnya Set di-clear
 * semua tiap 5 menit, jadi window 5-15 menit (Discord interaction token valid
 * 15 menit) bisa proses ulang interaction yang sama (race duplicate key/DM).
 * Sekarang: simpan { id, ts }, prune entry yang lebih tua dari 15 menit.
 *
 * v3.9.9 refactor: dipindah dari handlers/interactionHandler.js ke sini supaya
 * dipakai bersama oleh router (src/interactions/index.js) dan semua domain
 * handler. Sebelumnya dedup Map hidup di dalam module lama, sekarang jadi
 * singleton shared lintas domain.
 */

const processedInteractions = new Map();
const PROCESSED_TTL_MS = 15 * 60 * 1000; // 15 menit — match Discord interaction token lifetime

// Periodic cleanup supaya Map tidak bengkak
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, ts] of processedInteractions) {
        if (now - ts > PROCESSED_TTL_MS) {
            processedInteractions.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0 && processedInteractions.size > 100) {
        // Log hanya kalau cleanup menghapus banyak (defensive)
        console.log(`🧹 processedInteractions: ${cleaned} entry di-prune.`);
    }
}, 60 * 1000).unref?.();

/**
 * Cek apakah interaction ID sudah diproses dalam window TTL.
 *
 * v3.9.38 FIX: split jadi `check` + `mark` (mark sekarang dipanggil router
 * SETELAH handler sukses — sebelumnya checkAndMark menandai SEBELUM handler
 * jalan, jadi kalau handler crash/error, replay gateway dari Discord untuk
 * interaction yang sama di-swallow → action user hilang diam-diam).
 *
 * @param {string} interactionId - interaction.id dari Discord
 * @returns {boolean} true kalau SUDAH diproses dalam TTL (pemanggil harus skip).
 */
function check(interactionId) {
    if (!interactionId) return false;
    const now = Date.now();
    const prevTs = processedInteractions.get(interactionId);
    return !!(prevTs && now - prevTs < PROCESSED_TTL_MS);
}

/**
 * Tandai interaction ID sebagai sudah diproses (sekarang, timestamp fresh).
 * Idempotent — mark 2x untuk id sama hanya refresh timestamp.
 * @param {string} interactionId - interaction.id dari Discord
 */
function mark(interactionId) {
    if (!interactionId) return;
    processedInteractions.set(interactionId, Date.now());
}

/**
 * Cek + tandai sekaligus (kombinasi check() lalu mark()).
 * Backward compat — dipertahankan untuk pemanggil luar router.
 *
 * @param {string} interactionId - interaction.id dari Discord
 * @returns {boolean} true kalau SUDAH diproses (pemanggil harus skip),
 *                    false kalau BELUM (dan sekarang ditandai).
 *
 * v3.9.8: kalau entry ada tapi udah lebih dari TTL, anggap belum diproses
 * (return false) dan overwrite timestamp-nya dengan `now`.
 */
function checkAndMark(interactionId) {
    if (check(interactionId)) {
        return true; // sudah diproses — skip
    }
    mark(interactionId);
    return false;
}

module.exports = {
    checkAndMark,
    // v3.9.38: granular — check tanpa mark, mark tanpa check
    check,
    mark,
    processedInteractions, // exposed untuk testing/debug
    PROCESSED_TTL_MS
};
