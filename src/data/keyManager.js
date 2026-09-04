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
 *     "days": 30,           // 0 = permanen
 *     "expireAt": 1735689600000,  // timestamp ms. null = permanen
 *     "createdAt": 1735000000000
 *   }
 * ]
 *
 * === MODEL KEY-DRIVEN ===
 * Setiap pembelian = 1 key baru dengan expireAt INDEPENDEN (tidak ditumpuk).
 * Role VIP mengikuti key dengan sisa waktu TERBANYAK (max dari semua key aktif).
 * Key yang sudah expired akan dihapus otomatis dari keys.json.
 */

function loadKeys() {
    try {
        if (!fs.existsSync(keysPath)) return [];
        return JSON.parse(fs.readFileSync(keysPath, 'utf8'));
    } catch (err) {
        console.error('Error load keys.json:', err.message);
        // v3.9.26: karantina file korup SEBELUM return [] — tanpa ini save()
        // berikutnya menimpa file korup dengan state kosong → SEMUA VIP key
        // hilang permanen. (keys.json = data paling kritis di bot ini.)
        quarantineCorruptFile(keysPath);
        return [];
    }
}

/**
 * v3.9.0 FIX: pakai safeWriteJSON (atomic tmp+rename) supaya crash mid-write
 * tidak corrupt keys.json (yang bisa wipe semua VIP key).
 */
function saveKeys(list) {
    safeWriteJSON(keysPath, list);
}

function genId() {
    return `key_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Tambah key baru.
 *
 * @param {Object} data - { key, userId, username, roleId, productName, days, guildId }
 *   - days: 0 = permanen, >0 = durasi hari
 *   - expireAt akan dihitung otomatis (now + days * 86400000) atau null kalau permanen
 *   - guildId: ID guild tempat key ini diberikan (v3.9.3 — sebelumnya tidak disimpan,
 *     yang bikin removeAllKeysByUser(userId, guildId) broken karena filter tidak pernah match)
 * @returns {Object} entry yang baru disimpan
 */
function addKey(data) {
    const list = loadKeys();
    const now = Date.now();
    const days = Number(data.days) || 0;
    const expireAt = days > 0 ? now + days * 24 * 60 * 60 * 1000 : null;

    // v3.9.38 FIX (FIX 5c): harden data layer — key kosong/whitespace DITOLAK.
    // Sebelumnya hanya truthy-check `data.key &&` di dup-check → "   " lolos
    // tersimpan sebagai key blank (buyers tidak bisa redeem apa-apa). Key
    // di-trim dulu, dan versi ter-trim yang disimpan supaya dup-check akurat.
    const key = typeof data.key === 'string' ? data.key.trim() : '';
    if (!key) {
        throw new Error('Key tidak boleh kosong');
    }

    // v3.9.8 FIX: cek uniqueness key. Sebelumnya tidak ada cek → admin typo
    // / copy-paste bisa bikin 2 entry dengan key sama, dan getActiveKeysByUserAndRole
    // double-count (meski max() idempotent, tetap UX confusion + bisa bikin
    // member redeem 2x kalau redemption logic pakai find-by-key).
    // v3.9.38 FIX (FIX 6c): pesan error TIDAK lagi menyertakan nilai key —
    // error ini mengalir ke console log handler (ticket.js/keys.js) → raw key
    // bocor ke log. Admin sudah tahu key yang barusan dia ketik.
    if (list.some(k => k.key === key)) {
        throw new Error('Key sudah ada di database (duplicate).');
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
        guildId: data.guildId || null, // v3.9.3: simpan guildId supaya cross-guild wipe bisa akurat
        createdAt: now
    };
    list.push(entry);
    saveKeys(list);
    return entry;
}

/**
 * Ambil SEMUA key milik user tertentu (tanpa filter expired).
 * v3.9.8: tambah optional guildId filter supaya /list-keys tidak bocor cross-guild.
 */
function findAllByUser(userId, guildId) {
    const list = loadKeys();
    if (guildId) {
        // Filter key milik user ini di guild ini.
        // Key tanpa guildId (schema lama, pre-v3.9.3) juga diikutsertakan (backward compat).
        return list.filter(k => k.userId === userId && (k.guildId === guildId || !k.guildId));
    }
    return list.filter(k => k.userId === userId);
}

/**
 * Ambil key aktif (belum expired) milik user + role tertentu.
 * Key permanen (expireAt = null) selalu dihitung aktif.
 *
 * @param {string} userId
 * @param {string} roleId
 * @param {number} [now=Date.now()] - timestamp ms
 * @param {string|null} [guildId=null] - v3.9.31: optional guild filter (konsistensi
 *        pola dengan findAllByUser). Key legacy tanpa guildId tetap dihitung
 *        (backward compat). roleId sebenarnya unik per guild (snowflake), jadi
 *        ini murni konsistensi, bukan fix kebocoran nyata.
 * @returns {Array} daftar key aktif
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
 * Apakah user punya key PERMANEN untuk role tertentu?
 */
function hasPermanentKey(userId, roleId) {
    const list = loadKeys();
    return list.some(k => k.userId === userId && k.roleId === roleId && k.expireAt === null);
}

/**
 * Ambil expireAt TERBESAR dari semua key aktif milik user+role.
 * - Kalau ada key permanen → return null (permanen)
 * - Kalau ada key aktif → return max(expireAt)
 * - Kalau tidak ada key aktif → return null (tapi panggilan harus cek dulu)
 *
 * @returns {number|null} timestamp ms, atau null kalau permanen / tidak ada
 */
function getMaxExpireAtByUserAndRole(userId, roleId, now = Date.now()) {
    const actives = getActiveKeysByUserAndRole(userId, roleId, now);
    if (actives.length === 0) return null;
    if (actives.some(k => k.expireAt === null)) return null; // ada permanen
    // v3.9.1 FIX: pakai reduce, bukan Math.max(...spread). Kalau user punya
    // ratusan key aktif (kasus ekstrim), spread bisa kena call stack limit
    // dan throw RangeError "Maximum call stack size exceeded".
    let max = -Infinity;
    for (const k of actives) {
        if (k.expireAt > max) max = k.expireAt;
    }
    return max === -Infinity ? null : max;
}

/**
 * Ambil semua key yang SUDAH expired (expireAt !== null && expireAt <= now).
 * Key permanen TIDAK akan pernah masuk sini.
 */
function getExpiredKeys(now = Date.now()) {
    const list = loadKeys();
    return list.filter(k => k.expireAt !== null && k.expireAt <= now);
}

/**
 * Ambil SEMUA key di keys.json (untuk keperluan stats/debug).
 */
function getAllKeys() {
    return loadKeys();
}

/**
 * Hitung statistik key buat /config-show.
 * Returns: { total, active, expired, permanent }
 *  - total: semua key di file
 *  - active: expireAt > now ATAU permanen
 *  - expired: expireAt <= now (akan dibersihkan scheduler)
 *  - permanent: days=0 atau expireAt=null
 */
function getStats(now = Date.now()) {
    const list = loadKeys();
    let active = 0,
        expired = 0,
        permanent = 0;
    for (const k of list) {
        if (k.expireAt === null || k.days === 0) {
            permanent++;
            active++; // permanent selalu active
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
 * Hanya hitung key milik guild ini (atau key legacy tanpa guildId, yang dianggap milik guild pemanggil).
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
 * Hapus SEMUA key yang sudah expired dari keys.json.
 * @returns {number} jumlah key yang dihapus
 */
function removeExpiredKeys(now = Date.now()) {
    const list = loadKeys();
    const filtered = list.filter(k => k.expireAt === null || k.expireAt > now);
    const removed = list.length - filtered.length;
    if (removed > 0) saveKeys(filtered);
    return removed;
}

/**
 * Hapus SEMUA key milik user tertentu (dipakai /clear-schedule --clear_keys).
 * v3.9.0 FIX: tambah parameter guildId supaya cross-guild wipe tidak terjadi.
 *   - Kalau guildId diberikan: hanya hapus key yang match userId DAN guildId.
 *   - Kalau guildId undefined/null: behavior lama (hapus semua key user — backward compat).
 *
 * v3.9.3 FIX: sebelumnya, kalau guildId di-pass tapi key tidak punya field guildId
 *   (schema lama, sebelum v3.9.3), filter `k.guildId === guildId` TIDAK PERNAH match
 *   karena k.guildId = undefined. Akibatnya, /clear-schedule clear_keys:true
 *   silently menghapus 0 key padahal admin mengira VIP sudah di-reset.
 *   Sekarang: key tanpa guildId (schema lama) dianggap milik guild yang memanggil
 *   (asumsi: bot sebelumnya single-guild). Key baru (v3.9.3+) punya guildId eksplisit.
 *
 * @param {string} userId
 * @param {string} [guildId] - opsional, filter by guild kalau diberikan
 * @returns {number} jumlah key yang dihapus
 */
function removeAllKeysByUser(userId, guildId) {
    const list = loadKeys();
    let filtered;
    if (guildId) {
        // Hapus key milik user ini di guild ini.
        // Key tanpa guildId (schema lama, pre-v3.9.3) juga dihapus karena
        // diasumsikan milik guild pertama yang memanggil (backward compat).
        filtered = list.filter(
            k => !(k.userId === userId && (k.guildId === guildId || k.guildId === undefined || k.guildId === null))
        );
    } else {
        // Behavior lama: hapus semua key user (backward compat untuk single-guild).
        filtered = list.filter(k => k.userId !== userId);
    }
    const removed = list.length - filtered.length;
    if (removed > 0) saveKeys(filtered);
    return removed;
}

/**
 * Hapus SEMUA key milik user + role tertentu.
 * @returns {number} jumlah key yang dihapus
 */
function removeAllKeysByUserAndRole(userId, roleId) {
    const list = loadKeys();
    const filtered = list.filter(k => !(k.userId === userId && k.roleId === roleId));
    const removed = list.length - filtered.length;
    if (removed > 0) saveKeys(filtered);
    return removed;
}

/**
 * Hitung sisa hari dari sebuah key (bisa negatif kalau expired, Infinity kalau permanen).
 */
function getRemainingDays(key, now = Date.now()) {
    if (key.expireAt === null) return Infinity;
    return (key.expireAt - now) / (24 * 60 * 60 * 1000);
}

/**
 * Format tampilan sisa waktu untuk 1 key.
 */
function formatRemaining(key, now = Date.now()) {
    if (key.expireAt === null) return 'Permanen';
    const days = getRemainingDays(key, now);
    if (days <= 0) return 'Expired';
    if (days < 1) {
        const hours = Math.ceil(days * 24);
        return `${hours} jam lagi`;
    }
    return `${Math.ceil(days)} hari lagi`;
}

/**
 * Format daftar key untuk ditampilkan ke user/admin.
 * Hanya tampilkan key aktif.
 */
function formatKeysForUser(keys, now = Date.now()) {
    if (keys.length === 0) return '(tidak ada key)';
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
