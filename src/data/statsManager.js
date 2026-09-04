/**
 * Stats Manager — track aktivitas user untuk leaderboard & stats.
 *
 * File: stats.json
 * {
 *   "<guildId>:<userId>": {
 *     "messages": 123,
 *     "lastMessageAt": 1735689600000,
 *     "vipPurchases": 2,
 *     "totalSpent": 80000,
 *     "joinedAt": 1735000000000,
 *     "giveawaysWon": 0,
 *     "guildId": "...",   // v3.9.4: backfilled for filtering
 *     "userId": "..."     // v3.9.4: backfilled for filtering
 *   }
 * }
 *
 * v3.9.4 FIX: cross-guild data isolation.
 *   Sebelumnya key cuma `userId` → stats dari Guild A bocor ke Guild B.
 *   Sekarang key = `${guildId}:${userId}` (composite, sama seperti warns.json).
 *   Backward compat: legacy entries (key tanpa `:`) di-migrate ke guild pertama
 *   yang didaftarkan via `init()` (dipanggil dari index.js ClientReady).
 *
 * Tracking:
 *   - messages: count pesan user (updated by messageCreate event)
 *   - vipPurchases: count pembelian VIP (updated by set-key flow)
 *   - totalSpent: total uang dihabiskan (extracted dari price produk)
 *   - giveawaysWon: count menang giveaway
 *
 * === P0-1 FIX: In-memory cache + periodic flush ===
 * Sebelumnya: tiap `incrementMessages` load+save file JSON synchronously
 * → memblock event loop pada setiap pesan → bot lag di server aktif.
 * Sekarang: pakai in-memory cache, flush ke disk tiap 30 detik atau
 * kalau ada perubahan non-message (purchase/win/join).
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'stats.json');
const FLUSH_INTERVAL_MS = 30 * 1000; // 30 detik

// === In-memory cache ===
let cache = null; // null = belum di-load
let dirty = false; // apakah cache ada perubahan yang belum di-flush?
let flushTimer = null; // timer periodic flush
let defaultGuildId = null; // v3.9.4: untuk migrasi legacy entries

function defaultUserStats() {
    return {
        messages: 0,
        lastMessageAt: null,
        vipPurchases: 0,
        totalSpent: 0,
        joinedAt: null,
        giveawaysWon: 0
    };
}

/**
 * Composite key helper.
 */
function keyFor(guildId, userId) {
    return `${guildId}:${userId}`;
}

/**
 * v3.9.4: Init dengan default guild ID untuk migrasi legacy entries.
 * Dipanggil dari index.js ClientReady. Kalau bot di 1 guild, semua legacy
 * entries akan di-assign ke guild tersebut. Kalau bot di multi-guild,
 * legacy entries di-assign ke guild pertama (cukup untuk mayoritas case).
 *
 * @param {string} guildId
 */
function init(guildId) {
    if (!guildId) return;
    defaultGuildId = guildId;
    // Kalau cache sudah di-load, trigger migrasi sekarang.
    if (cache !== null) migrateLegacyEntries();
}

/**
 * v3.9.4: Migrate legacy entries (key tanpa `:`) ke composite key
 * `${defaultGuildId}:${userId}`. Idempotent — entry yang sudah composite tidak diubah.
 */
function migrateLegacyEntries() {
    if (!defaultGuildId || cache === null) return;
    let migrated = 0;
    const newCache = {};
    for (const [k, v] of Object.entries(cache)) {
        if (k.includes(':')) {
            // Sudah composite — keep as-is, backfill guildId/userId fields kalau belum ada.
            if (!v.guildId || !v.userId) {
                const [gid, uid] = k.split(':');
                if (!v.guildId) v.guildId = gid;
                if (!v.userId) v.userId = uid;
            }
            newCache[k] = v;
        } else {
            // Legacy entry — k adalah userId plain. Re-key ke composite.
            const newKey = keyFor(defaultGuildId, k);
            if (!v.guildId) v.guildId = defaultGuildId;
            if (!v.userId) v.userId = k;
            // Kalau sudah ada entry composite untuk user ini (kasus race condition),
            // merge: jumlahkan counters, ambil timestamps paling awal.
            if (newCache[newKey]) {
                const existing = newCache[newKey];
                existing.messages = (existing.messages || 0) + (v.messages || 0);
                existing.vipPurchases = (existing.vipPurchases || 0) + (v.vipPurchases || 0);
                existing.totalSpent = (existing.totalSpent || 0) + (v.totalSpent || 0);
                existing.giveawaysWon = (existing.giveawaysWon || 0) + (v.giveawaysWon || 0);
                if (v.joinedAt && (!existing.joinedAt || v.joinedAt < existing.joinedAt)) {
                    existing.joinedAt = v.joinedAt;
                }
                if (v.lastMessageAt && (!existing.lastMessageAt || v.lastMessageAt > existing.lastMessageAt)) {
                    existing.lastMessageAt = v.lastMessageAt;
                }
            } else {
                newCache[newKey] = v;
            }
            migrated++;
        }
    }
    if (migrated > 0) {
        cache = newCache;
        dirty = true;
        console.log(`🔄 stats.json: ${migrated} legacy entry di-migrate ke guild ${defaultGuildId}.`);
        flush();
    }
}

function load() {
    if (cache !== null) return cache;
    try {
        if (!fs.existsSync(filePath)) {
            cache = {};
        } else {
            cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (err) {
        console.warn('⚠️ stats.json rusak:', err.message);
        // v3.9.26: karantina file korup sebelum fallback (lihat safeWrite.js).
        quarantineCorruptFile(filePath);
        cache = {};
    }
    // v3.9.4: jalankan migrasi legacy kalau defaultGuildId sudah di-set.
    if (defaultGuildId) migrateLegacyEntries();
    return cache;
}

/**
 * Flush cache ke disk kalau dirty. Tidak throw — log error saja.
 */
// v3.9.0 FIX: atomic write via safeWriteJSON (tmp+rename) to prevent corruption on crash
function flush() {
    if (!dirty || cache === null) return;
    try {
        safeWriteJSON(filePath, cache);
        dirty = false;
    } catch (err) {
        console.error('⚠️ Gagal flush stats.json:', err.message);
    }
}

/**
 * Mulai periodic flush timer. Dipanggil sekali saat bot start (di index.js ready).
 */
function startAutoFlush() {
    if (flushTimer) return; // sudah start
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    // Jangan block process exit
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Force flush + stop timer. Dipanggil saat graceful shutdown.
 */
function shutdown() {
    flush();
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
}

/**
 * v3.9.1: Invalidate cache + reload dari disk. Dipanggil setelah restoreBackup
 * supaya in-memory cache (yang mungkin berisi data lama) tidak menimpa
 * data hasil restore saat flush berikutnya.
 *
 * Skenario sebelum fix:
 *   1. Bot jalan, cache stats.json berisi { userA: 5 messages }
 *   2. Admin restore backup lama (stats.json berisi { userA: 3 messages })
 *   3. User kirim pesan → incrementMessages update cache jadi { userA: 6 }
 *      (seharusnya 4, karena data restore punya 3)
 *   4. Periodic flush tulis { userA: 6 } ke stats.json → data restore hilang
 *
 * Fix: set cache = null supaya load() baca ulang dari disk.
 */
function reload() {
    // Jangan flush cache lama — itu justru data basi yang mau kita buang.
    dirty = false;
    cache = null;
    load();
}

/**
 * v3.9.4: Get stats user scoped ke guild.
 * @param {string} guildId
 * @param {string} userId
 */
function getStats(guildId, userId) {
    const all = load();
    return all[keyFor(guildId, userId)] || defaultUserStats();
}

/**
 * Increment message count — P0-1 fix: pakai cache, TIDAK sync file I/O.
 * v3.9.4: scoped per guild.
 *
 * @param {string} guildId
 * @param {string} userId
 */
function incrementMessages(guildId, userId) {
    const all = load();
    const k = keyFor(guildId, userId);
    if (!all[k]) {
        all[k] = defaultUserStats();
        all[k].guildId = guildId;
        all[k].userId = userId;
    }
    all[k].messages = (all[k].messages || 0) + 1;
    all[k].lastMessageAt = Date.now();
    dirty = true;
    // Tidak langsung flush — flush periodik tiap 30 detik.
}

/**
 * v3.9.4: scoped per guild.
 */
function recordPurchase(guildId, userId, priceNum) {
    const all = load();
    const k = keyFor(guildId, userId);
    if (!all[k]) {
        all[k] = defaultUserStats();
        all[k].guildId = guildId;
        all[k].userId = userId;
    }
    all[k].vipPurchases = (all[k].vipPurchases || 0) + 1;
    all[k].totalSpent = (all[k].totalSpent || 0) + (priceNum || 0);
    dirty = true;
    flush(); // penting, jangan sampai transaksi hilang kalau bot crash
}

/**
 * v3.9.4: scoped per guild.
 */
function recordGiveawayWin(guildId, userId) {
    const all = load();
    const k = keyFor(guildId, userId);
    if (!all[k]) {
        all[k] = defaultUserStats();
        all[k].guildId = guildId;
        all[k].userId = userId;
    }
    all[k].giveawaysWon = (all[k].giveawaysWon || 0) + 1;
    dirty = true;
    flush();
}

/**
 * v3.9.4: scoped per guild.
 */
function recordJoin(guildId, userId) {
    const all = load();
    const k = keyFor(guildId, userId);
    if (!all[k]) {
        all[k] = defaultUserStats();
        all[k].guildId = guildId;
        all[k].userId = userId;
    }
    if (!all[k].joinedAt) all[k].joinedAt = Date.now();
    dirty = true;
    flush();
}

/**
 * Get top N users berdasarkan metric, scoped ke guild.
 * v3.9.4: hanya hitung entry milik guild ini.
 *
 * @param {string} guildId
 * @param {string} metric - 'messages' | 'vipPurchases' | 'totalSpent' | 'giveawaysWon'
 * @param {number} limit
 * @returns {Array} [{ userId, value, ...otherStats }]
 */
function getTopUsers(guildId, metric, limit = 10) {
    const all = load();
    const prefix = `${guildId}:`;
    return Object.entries(all)
        .filter(([k]) => k.startsWith(prefix))
        // v3.9.31 FIX: ...stats DULU, override SETELAHNYA. Pola lama taruh userId
        // sebelum spread — properti eksplisit undefined di stats bisa menimpa
        // fallback k.split(':')[1] dengan undefined, dan key legacy tanpa ':'
        // menghasilkan userId undefined.
        .map(([k, stats]) => ({ ...stats, userId: stats.userId || k.split(':')[1], value: stats[metric] || 0 }))
        .filter(e => e.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, limit);
}

/**
 * Get agregat stats untuk sebuah guild.
 * v3.9.4: hanya hitung entry milik guild ini.
 *
 * @param {string} guildId
 */
function getServerStats(guildId) {
    const all = load();
    const prefix = `${guildId}:`;
    let totalUsers = 0;
    let totalMessages = 0;
    let totalPurchases = 0;
    let totalRevenue = 0;
    let totalGiveawaysWon = 0;
    for (const [k, s] of Object.entries(all)) {
        if (!k.startsWith(prefix)) continue;
        totalUsers++;
        totalMessages += s.messages || 0;
        totalPurchases += s.vipPurchases || 0;
        totalRevenue += s.totalSpent || 0;
        totalGiveawaysWon += s.giveawaysWon || 0;
    }
    return {
        totalUsers,
        totalMessages,
        totalPurchases,
        totalRevenue,
        totalGiveawaysWon
    };
}

/**
 * Parse price string ke number. Handle "Rp 25.000", "25000", "25.000", "25k", "2.5M"
 *
 * P2-13 FIX: sebelumnya `.replace(/\./g, '').replace(/,/g, '.')` ambigu:
 *   - "25,000" (US thousand) → "25.000" → parseFloat → 25 (SALAH, harusnya 25000)
 *   - "Rp. 50.000" (ID thousand) → 50000 → OK
 *   - "2,5M" (ID decimal) → "2.5M" → 2.5 × 1000000 = OK
 * Sekarang: deteksi format berdasarkan keberadaan dot & comma bersamaan.
 */
function parsePrice(priceStr) {
    // v3.9.38 FIX: input number negatif juga di-clamp — harga tidak boleh
    // minus (totalSpent/revenue bisa jadi negatif lewat harga produk).
    if (typeof priceStr === 'number') return isNaN(priceStr) ? 0 : Math.max(0, priceStr);
    if (!priceStr) return 0;
    let s = String(priceStr).toLowerCase().replace(/rp\.?/g, '').replace(/\s/g, '');
    let multiplier = 1;
    if (s.endsWith('k')) {
        multiplier = 1000;
        s = s.slice(0, -1);
    } else if (s.endsWith('m')) {
        multiplier = 1000000;
        s = s.slice(0, -1);
    }

    const hasDot = s.includes('.');
    const hasComma = s.includes(',');

    if (hasDot && hasComma) {
        // Ada keduanya → pakai posisi terakhir untuk tentukan decimal.
        // Mis. "1,234.56" (US) → comma=thousand, dot=decimal
        // Mis. "1.234,56" (EU/ID) → dot=thousand, comma=decimal
        if (s.lastIndexOf('.') > s.lastIndexOf(',')) {
            // US: dot=decimal, comma=thousand → hapus comma, biarkan dot
            s = s.replace(/,/g, '');
        } else {
            // EU/ID: dot=thousand, comma=decimal → hapus dot, ganti comma jadi dot
            s = s.replace(/\./g, '').replace(/,/g, '.');
        }
    } else if (hasComma) {
        // Hanya comma. Asumsi: thousand separator (lebih umum di ID).
        // Mis. "25,000" → 25000
        // Tapi "2,5" → ambiguous, treat as decimal (2.5).
        const parts = s.split(',');
        if (parts.length === 2 && parts[1].length <= 2) {
            // Comma sebagai decimal (mis. "2,5")
            s = s.replace(/,/g, '.');
        } else {
            // Comma sebagai thousand separator
            s = s.replace(/,/g, '');
        }
    } else if (hasDot) {
        // Hanya dot. Asumsi: thousand separator (format ID).
        // Mis. "50.000" → 50000
        //
        // v3.9.8 FIX: heuristic lama `parts[1].length <= 2` treat sebagai decimal,
        // bikin "1.50" (ID = 150) salah jadi 1.5, dan "100.00" (ID = 10000) salah jadi 100.
        //
        // v3.9.9 FIX: heuristic lebih ketat. Untuk Rupiah (integer currency),
        // thousand separator jauh lebih umum daripada decimal. Hanya treat sebagai
        // decimal kalau SANGAT jelas (int part < 10 DAN fractional 1 digit).
        // Mis. "2.5" → 2.5 (decimal), "9.9" → 9.9 (decimal).
        // Tapi "1.50" → 150 (thousand), "10.50" → 1050 (thousand), "2.50" → 250 (thousand).
        //
        // v3.9.17 FIX: untuk currency Rupiah (integer currency), dot SELALU
        // thousand separator. "1.5" sebagai 1.5 Rupiah tidak masuk akal — kemungkinan
        // besar admin maksudnya 15 atau 1500. Tapi untuk backward compat, kita keep
        // heuristic v3.9.9 untuk angka kecil (< 10) supaya test lama gak break.
        // Dokumentasi: kalau admin mau input harga < 10 Rupiah dengan decimal
        // (sangat jarang), pakai format "0.5" atau "5" saja.
        const parts = s.split('.');
        if (parts.length === 2 && parts[0] !== '' && parts[1].length > 0) {
            const intPart = parseInt(parts[0], 10);
            // Treat sebagai decimal HANYA kalau:
            //   - int part < 10 (sangat kecil — harga Rupiah jarang < 10)
            //   - fractional part exactly 1 digit (bukan 2 yang bisa ambiguous)
            //   - bukan "0" (mis. "1.0" → 10, bukan 1.0)
            if (!isNaN(intPart) && intPart < 10 && parts[1].length === 1 && parts[1] !== '0') {
                // Dot sebagai decimal (mis. "2.5", "9.9")
                // biarkan
            } else {
                // Dot sebagai thousand separator
                s = s.replace(/\./g, '');
            }
        } else {
            // Multiple dots (mis. "1.234.567") → thousand separator
            s = s.replace(/\./g, '');
        }
    }

    const n = parseFloat(s);
    // v3.9.38 FIX: hasil negatif di-clamp ke 0 — string harga "-5000" /
    // "Rp -25k" tidak boleh bikin totalSpent/revenue jadi minus.
    return isNaN(n) ? 0 : Math.max(0, Math.round(n * multiplier));
}

module.exports = {
    init,
    getStats,
    incrementMessages,
    recordPurchase,
    recordGiveawayWin,
    recordJoin,
    getTopUsers,
    getServerStats,
    parsePrice,
    startAutoFlush,
    shutdown,
    flush,
    reload
};
