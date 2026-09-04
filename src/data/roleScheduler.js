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
 *     "expireAt": 1735689600000,  // timestamp ms. null = permanen
 *     "productName": "30 Days",
 *     "createdAt": 1735000000000
 *   }
 * ]
 *
 * === MODEL KEY-DRIVEN — MAX EXTEND ===
 * Schedule expireAt di-update ke max(existing.expireAt, newKey.expireAt).
 * Tidak pernah dipendekkan. Dipakai oleh Set Key button & /set-key command.
 *
 * Saat schedule fires (di index.js processExpiredRole), scheduler akan:
 *   1. Cek getActiveKeysByUserAndRole(userId, roleId)
 *   2. Kalau ada key PERMANEN → hapus schedule, role tetap
 *   3. Kalau ada key aktif dengan expireAt > sekarang → updateExpireAt ke max, role tetap
 *   4. Kalau tidak ada key aktif → hapus role + hapus schedule
 */

function loadScheduled() {
    try {
        if (!fs.existsSync(scheduledPath)) return [];
        return JSON.parse(fs.readFileSync(scheduledPath, 'utf8'));
    } catch (err) {
        console.error('Error load scheduledRoles.json:', err.message);
        // v3.9.26: karantina file korup sebelum fallback (lihat safeWrite.js).
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
 * Hitung sisa hari dari sebuah schedule entry (bisa negatif kalau sudah expired).
 * Return Infinity kalau permanen (expireAt = null).
 */
function getRemainingDays(entry, now = Date.now()) {
    if (entry.expireAt === null) return Infinity;
    return (entry.expireAt - now) / (24 * 60 * 60 * 1000);
}

/**
 * Hapus SEMUA schedule aktif untuk userId + roleId tertentu.
 * Dipakai kalau user upgrade ke produk permanent (days=0) supaya role gak auto-remove.
 *
 * @param {string} userId
 * @param {string} roleId
 * @returns {number} jumlah entry yang dihapus
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
 * Schedule penghapusan role — MODE MAX EXTEND (key-driven).
 *
 * Logic:
 * 1. Kalau data.expireAt diberikan langsung, pakai itu.
 *    Kalau tidak, hitung dari data.days (now + days * 86400000).
 *    Kalau days <= 0 (atau expireAt = null) → permanen, hapus schedule lama.
 * 2. Cek apakah user sudah punya schedule aktif untuk role yang sama.
 * 3. Kalau ada:
 *    - existing.expireAt = null (permanen) → tidak ada yang perlu diubah, return.
 *    - Kalau newExpireAt = null (permanen) → update jadi permanen.
 *    - Kalau newExpireAt > existing.expireAt → UPDATE (extend).
 *    - Kalau newExpireAt <= existing.expireAt → TIDAK diubah (no shorten).
 * 4. Kalau belum ada: buat schedule baru.
 *
 * @param {Object} data - { userId, roleId, guildId, days?, expireAt?, productName? }
 * @returns {{
 *   entry: Object,
 *   extended: boolean,        // true kalau schedule di-extend
 *   previousExpireAt: number|null,
 *   newExpireAt: number|null,
 *   permanent: boolean        // true kalau jadi permanen
 * }}
 */
function scheduleRoleRemoval(data) {
    const list = loadScheduled();
    const now = Date.now();

    // Hitung newExpireAt
    let newExpireAt;
    let permanent = false;

    // expireAt <= 0 dianggap permanen (bukan timestamp valid).
    // Dulu, expireAt=0 lolos check (!== undefined && !== null) → newExpireAt = 0
    // → dianggap "sudah expire" → scheduler langsung hapus role dalam 60 detik.
    // Misal: produk dengan days=0 yang somehow resolve ke expireAt=0 → role VIP
    // dihapus otomatis segera setelah diberikan. Silent data loss.
    if (data.expireAt !== undefined && data.expireAt !== null && data.expireAt > 0) {
        // Langsung pakai expireAt yang diberikan
        newExpireAt = data.expireAt;
    } else {
        const days = Number(data.days) || 0;
        if (days <= 0) {
            // Permanen
            newExpireAt = null;
            permanent = true;
        } else {
            newExpireAt = now + days * 24 * 60 * 60 * 1000;
        }
    }

    if (newExpireAt === null) permanent = true;

    const existingIndex = list.findIndex(e => e.userId === data.userId && e.roleId === data.roleId);

    // === KASUS PERMANEN: hapus schedule lama, role jadi permanen ===
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

    // === KASUS NON-PERMANEN ===
    if (existingIndex !== -1) {
        const existing = list[existingIndex];
        const previousExpireAt = existing.expireAt;

        // Existing permanen → tidak perlu diubah
        if (existing.expireAt === null) {
            return {
                entry: existing,
                extended: false,
                previousExpireAt: null,
                newExpireAt: null,
                permanent: true
            };
        }

        // MAX EXTEND: hanya update kalau newExpireAt lebih besar
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
            // Tidak extend (newExpireAt <= existing) — keep existing
            return {
                entry: existing,
                extended: false,
                previousExpireAt,
                newExpireAt: existing.expireAt,
                permanent: false
            };
        }
    }

    // === BELUM ADA SCHEDULE → buat baru ===
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
 * Update expireAt dari sebuah schedule entry (dipakai saat scheduler recheck).
 * Dipakai oleh index.js processExpiredRole ketika key aktif masih ada dengan
 * expireAt yang lebih besar → reschedule ke max.
 * v3.9.0 FIX: skip write kalau nilai tidak berubah (hindari disk I/O + race window).
 *
 * @param {string} id - schedule entry id
 * @param {number} newExpireAt - timestamp ms baru
 * @returns {boolean} true kalau berhasil diupdate
 */
function updateExpireAt(id, newExpireAt) {
    const list = loadScheduled();
    const entry = list.find(e => e.id === id);
    if (!entry) return false;
    if (entry.expireAt === newExpireAt) return true; // tidak ada perubahan, skip write
    entry.expireAt = newExpireAt;
    saveScheduled(list);
    return true;
}

/**
 * Hapus entry dari scheduled list (biasanya setelah role berhasil di-remove).
 * v3.9.0 FIX: skip write kalau entry tidak ditemukan (hindari disk I/O).
 */
function removeEntry(id) {
    const list = loadScheduled();
    const filtered = list.filter(e => e.id !== id);
    if (filtered.length === list.length) return; // tidak ada yang dihapus, skip write
    saveScheduled(filtered);
}

/**
 * Ambil semua entry yang sudah expired (expireAt !== null && expireAt <= now).
 * Entry permanen (expireAt = null) TIDAK akan pernah masuk sini.
 */
function getExpired() {
    const list = loadScheduled();
    const now = Date.now();
    return list.filter(e => e.expireAt !== null && e.expireAt <= now);
}

/**
 * Ambil semua entry aktif (untuk dipakai saat re-schedule saat bot restart).
 */
function getAllActive() {
    return loadScheduled();
}

/**
 * v3.9.4: Guild-scoped variant of getAllActive.
 * Hanya return schedule milik guild ini.
 *
 * @param {string} guildId
 * @returns {Array}
 */
function getActiveByGuild(guildId) {
    if (!guildId) return loadScheduled();
    return loadScheduled().filter(e => e.guildId === guildId);
}

/**
 * Cari scheduled role aktif untuk user tertentu + role tertentu.
 */
function findActive(userId, roleId) {
    const list = loadScheduled();
    return list.find(e => e.userId === userId && e.roleId === roleId);
}

/**
 * Ambil semua schedule milik user tertentu (semua role).
 */
function findAllByUser(userId) {
    const list = loadScheduled();
    return list.filter(e => e.userId === userId);
}

/**
 * Hapus SEMUA schedule milik user tertentu.
 * v3.9.0 FIX: tambah parameter guildId supaya cross-guild wipe tidak terjadi
 * saat bot di-deploy multi-guild.
 *   - guildId diberikan → hanya hapus entry yang match userId DAN guildId.
 *   - guildId undefined → hapus semua entry user (backward compat).
 * @returns {number} jumlah yang dihapus
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
