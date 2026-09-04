const { PermissionFlagsBits } = require('discord.js');
const { getConfig } = require('../data/configManager');

/**
 * Cek apakah seorang member adalah admin/staff bot.
 * Member dianggap admin kalau:
 *   1. Punya role Admin (yang sudah di-set via /set-role admin), ATAU
 *   2. Punya Discord permission ManageGuild, ATAU
 *   3. Punya Discord permission Administrator (super admin Discord)
 *
 * v3.9.2 OPTIMIZATION: cache admin role ID dari config selama 30 detik.
 * Sebelumnya, setiap interaction masuk manggil getConfig() yang baca
 * config.json dari disk secara sync. Untuk server aktif dengan banyak
 * slash command, ini bisa 50-100 disk read/detik yang sebenarnya tidak
 * perlu (config jarang berubah).
 *
 * Cache di-invalidate otomatis setelah 30 detik, jadi kalau admin baru
 * set role admin, maks 30 detik sudah terbaca.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */

const CACHE_TTL_MS = 30 * 1000; // 30 detik
let cachedAdminRoleId = undefined; // undefined = belum dicek; null = tidak di-set
let cacheExpiresAt = 0;

function getAdminRoleId() {
    const now = Date.now();
    if (now < cacheExpiresAt) {
        return cachedAdminRoleId;
    }
    // Cache expired — baca ulang dari config
    try {
        const config = getConfig();
        cachedAdminRoleId = config.roles?.admin || null;
    } catch (_err) {
        // Defensive: kalau getConfig throw (mis. config rusak), anggap tidak ada admin role
        cachedAdminRoleId = null;
    }
    cacheExpiresAt = now + CACHE_TTL_MS;
    return cachedAdminRoleId;
}

/**
 * Invalidate cache manual. Dipanggil saat admin role di-set/unset via /set-role
 * supaya perubahan langsung efektif tanpa nunggu TTL.
 */
function invalidateAdminRoleCache() {
    cachedAdminRoleId = undefined;
    cacheExpiresAt = 0;
}

function isAdmin(member) {
    if (!member) return false;

    // Cek Discord permission langsung (paling andal, tidak butuh cache)
    if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;

    // Cek role admin dari config (cached)
    const adminRoleId = getAdminRoleId();
    if (adminRoleId && member.roles?.cache?.has(adminRoleId)) return true;

    return false;
}

module.exports = { isAdmin, invalidateAdminRoleCache };
