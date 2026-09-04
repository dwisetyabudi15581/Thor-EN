const { PermissionFlagsBits } = require('discord.js');
const { getConfig } = require('../data/configManager');

/**
 * Check whether a member is a bot admin/staff.
 * A member is considered admin if:
 *   1. They have the Admin role (set via /set-role admin), OR
 *   2. They have the Discord ManageGuild permission, OR
 *   3. They have the Discord Administrator permission (Discord super admin)
 *
 * v3.9.2 OPTIMIZATION: cache the admin role ID from config for 30 seconds.
 * Previously, every incoming interaction called getConfig() which reads
 * config.json from disk synchronously. For an active server with lots of slash
 * commands, that could be 50-100 unnecessary disk reads per second (config rarely changes).
 *
 * The cache is invalidated automatically after 30 seconds, so when an admin
 * newly sets the admin role, it takes effect within at most 30 seconds.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */

const CACHE_TTL_MS = 30 * 1000; // 30 seconds
let cachedAdminRoleId = undefined; // undefined = not checked yet; null = not set
let cacheExpiresAt = 0;

function getAdminRoleId() {
    const now = Date.now();
    if (now < cacheExpiresAt) {
        return cachedAdminRoleId;
    }
    // Cache expired — re-read from config
    try {
        const config = getConfig();
        cachedAdminRoleId = config.roles?.admin || null;
    } catch (_err) {
        // Defensive: if getConfig throws (e.g. corrupt config), assume there is no admin role
        cachedAdminRoleId = null;
    }
    cacheExpiresAt = now + CACHE_TTL_MS;
    return cachedAdminRoleId;
}

/**
 * Manually invalidate the cache. Called when the admin role is set/unset via /set-role
 * so the change takes effect immediately without waiting for the TTL.
 */
function invalidateAdminRoleCache() {
    cachedAdminRoleId = undefined;
    cacheExpiresAt = 0;
}

function isAdmin(member) {
    if (!member) return false;

    // Check Discord permissions directly (most reliable, no cache needed)
    if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;

    // Check the config admin role (cached)
    const adminRoleId = getAdminRoleId();
    if (adminRoleId && member.roles?.cache?.has(adminRoleId)) return true;

    return false;
}

module.exports = { isAdmin, invalidateAdminRoleCache };
