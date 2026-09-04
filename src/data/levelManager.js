/**
 * Leveling Manager — XP per message + level + auto-role on level up.
 *
 * File: data/levels.json
 * {
 *   "<guildId>:<userId>": {
 *     "xp": 1250,
 *     "level": 5,
 *     "lastMessageAt": 1735689600000,    // untuk cooldown anti-spam XP
 *     "totalXp": 1250,                   // total XP yang pernah didapat (tidak berkurang)
 *     "guildId": "...",
 *     "userId": "..."
 *   }
 * }
 *
 * Level config di config.json (config.leveling):
 * {
 *   "leveling": {
 *     "enabled": true,
 *     "xpPerMessage": 15,
 *     "cooldownMs": 60000,               // 1 menit antara XP gain
 *     "announceLevelUp": true,           // ping user di channel saat level up
 *     "levelUpChannel": null             // null = channel tempat user chat. ID = specific channel
 *   },
 *   "levelRoles": [                      // auto-assign role saat cap level
 *     { "level": 10, "roleId": "123" },
 *     { "level": 50, "roleId": "456" }
 *   ]
 * }
 *
 * Level formula: level N requires totalXp = 100 * N * (N+1) / 2 = 50 * N * (N+1)
 *   Level 1: 100 XP
 *   Level 2: 300 XP
 *   Level 5: 1500 XP
 *   Level 10: 5500 XP
 *   Level 50: 127500 XP
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'levels.json');

// v3.9.26: read-through cache (pola panelManager). addXp dibaca + full-file
// rewrite di messageCreate PER PESAN dengan XP (leveling on) — sebelumnya itu
// readFileSync + writeFileSync O(total user) per grant. Cache 15s TTL +
// update-on-save tetap nge-write per grant (durability), tapi read-nya murah;
// efek terbesar: pesan tanpa XP (cooldown aktif) tidak lagi baca disk.
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
        // v3.9.26: karantina file korup SEBELUM fallback (lihat safeWrite.js).
        quarantineCorruptFile(filePath);
        _cache = { data: {}, at: Date.now() };
        return _cache.data;
    }
}

function save(data) {
    safeWriteJSON(filePath, data);
    // v3.9.26: update cache supaya read berikutnya konsisten dengan yang baru di-write
    _cache = { data, at: Date.now() };
}

/** v3.9.26: paksa read fresh berikutnya (restore backup / test). */
function invalidateCache() {
    _cache = null;
}

function keyFor(guildId, userId) {
    return `${guildId}:${userId}`;
}

/**
 * Hitung XP yang dibutuhkan untuk mencapai level tertentu.
 * Total XP cumulative dari level 0 ke level N.
 */
function xpForLevel(level) {
    return 50 * level * (level + 1);
}

/**
 * Hitung level dari total XP.
 * Inverse of xpForLevel: 50 * L * (L+1) = totalXp
 * L^2 + L - 2*totalXp/50 = 0  →  L = (-1 + sqrt(1 + 4*totalXp/50)) / 2
 */
function levelFromXp(totalXp) {
    if (totalXp < 100) return 0; // quick check: < 100 XP = level 0
    const level = Math.floor((-1 + Math.sqrt(1 + (4 * totalXp) / 50)) / 2);
    return Math.max(0, level);
}

/**
 * XP yang dibutuhkan untuk naik dari level saat ini ke level berikutnya.
 */
function xpToNextLevel(currentLevel) {
    return xpForLevel(currentLevel + 1) - xpForLevel(currentLevel);
}

/**
 * Get user level data.
 */
function getUser(guildId, userId) {
    const all = load();
    const k = keyFor(guildId, userId);
    return (
        all[k] || {
            xp: 0, // XP di level saat ini (reset tiap level up)
            level: 0,
            lastMessageAt: null,
            totalXp: 0,
            guildId,
            userId
        }
    );
}

/**
 * Tambah XP ke user. Return { leveledUp: boolean, newLevel: number, oldLevel: number }.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {number} xpGain - XP yang akan ditambahkan
 * @param {Object} config - config.leveling (untuk cek cooldown)
 * @returns {{ leveledUp, newLevel, oldLevel, user }}
 */
function addXp(guildId, userId, xpGain, config) {
    const all = load();
    const k = keyFor(guildId, userId);
    const now = Date.now();
    // v3.9.38 FIX: cooldownMs 0 = XP di TIAP pesan (sesuai dokumentasi config).
    // `||` menelan 0 → diam-diam jadi 60000; nullish coalescing menjaga 0 tetap 0.
    const cooldownMs = config?.cooldownMs ?? 60000;

    if (!all[k]) {
        all[k] = {
            xp: 0,
            level: 0,
            lastMessageAt: null,
            totalXp: 0,
            guildId,
            userId
        };
    }

    const user = all[k];

    // Cooldown check — kalau masih dalam cooldown, skip XP gain.
    // v3.9.38 FIX: gate `cooldownMs > 0` supaya 0 = tanpa cooldown (explicit,
    // juga aman kalau clock-skew bikin lastMessageAt > now) — sebelumnya 0
    // sudah diubah jadi 60000 oleh `||`, jadi opsi ini gak pernah bisa dipakai.
    if (cooldownMs > 0 && user.lastMessageAt && now - user.lastMessageAt < cooldownMs) {
        return { leveledUp: false, newLevel: user.level, oldLevel: user.level, user, onCooldown: true };
    }

    const oldLevel = user.level;
    user.totalXp = (user.totalXp || 0) + xpGain;
    user.xp = user.totalXp - xpForLevel(oldLevel);
    user.lastMessageAt = now;

    // Cek level up
    const newLevel = levelFromXp(user.totalXp);
    user.level = newLevel;
    const leveledUp = newLevel > oldLevel;

    if (leveledUp) {
        user.xp = user.totalXp - xpForLevel(newLevel);
    }

    save(all);

    return { leveledUp, newLevel, oldLevel, user, onCooldown: false };
}

/**
 * Get top N users by level/XP.
 */
function getTopUsers(guildId, limit = 10) {
    const all = load();
    const prefix = `${guildId}:`;
    return Object.entries(all)
        .filter(([k]) => k.startsWith(prefix))
        .map(([, data]) => ({ userId: data.userId, level: data.level, totalXp: data.totalXp || 0, xp: data.xp || 0 }))
        .sort((a, b) => b.totalXp - a.totalXp)
        .slice(0, limit);
}

/**
 * Get level roles dari config (untuk auto-assign).
 */
function getLevelRoles(config) {
    return config?.levelRoles || [];
}

/**
 * Cek role mana yang harus dikasih ke user yang cap level tertentu.
 * Return array of roleIds (semua role yang level-nya ≤ user level).
 * Support stacking — user level 50 dapet role level 10, 20, 50 sekaligus.
 *
 * @param {number} level
 * @param {Object} config
 * @returns {string[]} array of roleIds (kosong kalau gak ada yang match)
 */
function getRoleForLevel(level, config) {
    const roles = getLevelRoles(config);
    // Ambil semua role dengan level <= user level, urut ascending by level
    return roles
        .filter(r => r.level <= level)
        .sort((a, b) => a.level - b.level)
        .map(r => r.roleId);
}

module.exports = {
    getUser,
    addXp,
    getTopUsers,
    getLevelRoles,
    getRoleForLevel,
    xpForLevel,
    levelFromXp,
    xpToNextLevel,
    invalidateCache
};
