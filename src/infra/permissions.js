const { PermissionFlagsBits } = require('discord.js');
const { getConfig } = require('../data/configManager');

/**
 * Check whether a member is a bot admin/staff.
 * A member is considered an admin if:
 *   1. They have the Admin role (set via /set-role admin), OR
 *   2. They have the Discord ManageGuild permission, OR
 *   3. They have the Discord Administrator permission (Discord super admin)
 *
 * v3.9.2 OPTIMIZATION: cache the admin role ID from config for 30 seconds.
 * Previously, every incoming interaction called getConfig(), which reads
 * config.json from disk synchronously. For an active server with many slash
 * commands that could be 50-100 unnecessary disk reads per second (config
 * rarely changes).
 *
 * The cache is invalidated automatically after 30 seconds, so if an admin
 * sets a new admin role, it is picked up within 30 seconds at most.
 *
 * v3.10.0 MULTI-GUILD: the cache is now PER-GUILD (Map<guildId, entry>).
 * Previously a single global variable meant server A's admin role was read
 * by server B (when the bot is in 2+ servers). Per-guild entries are tiny
 * (2 fields), a realistic guild count (thousands max) puts no memory
 * pressure; stale entries are overwritten on TTL expiry, not accumulated.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */

const CACHE_TTL_MS = 30 * 1000; // 30 seconds
// v3.10.0: Map guildId -> { roleId, expiresAt }. A null roleId means
// "already checked, not set" (different from "not checked yet" = no entry).
const adminRoleCache = new Map();

function getAdminRoleId(guildId) {
    // Without guild context (e.g. a test mock without guild, a DM) there is
    // no admin role to check; the caller can still pass via the direct
    // Discord permissions (ManageGuild/Administrator) below.
    if (!guildId) return null;

    const now = Date.now();
    const hit = adminRoleCache.get(guildId);
    if (hit && now < hit.expiresAt) {
        return hit.roleId;
    }
    // Cache expired — re-read from this guild's config
    let roleId = null;
    try {
        const config = getConfig(guildId);
        roleId = config.roles?.admin || null;
    } catch (_err) {
        // Defensive: if getConfig throws (e.g. corrupt config), assume there is no admin role
        roleId = null;
    }
    adminRoleCache.set(guildId, { roleId, expiresAt: now + CACHE_TTL_MS });
    return roleId;
}

/**
 * Manually invalidate the cache. Called when the admin role is set/unset via /set-role
 * so the change takes effect immediately without waiting for the TTL.
 * v3.10.0: clears ALL guilds (invalidateAdminRoleCache() takes no argument,
 * consistent with the call sites in configManager.setField and
 * backupManager post-restore — neither knows which guild changed).
 */
function invalidateAdminRoleCache() {
    adminRoleCache.clear();
}

function isAdmin(member) {
    if (!member) return false;

    // Check Discord permissions directly (most reliable, no cache needed)
    if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;

    // Check the admin role from the member's guild config (cached per-guild)
    const adminRoleId = member.guild?.id ? getAdminRoleId(member.guild.id) : null;
    if (adminRoleId && member.roles?.cache?.has(adminRoleId)) return true;

    return false;
}

module.exports = { isAdmin, invalidateAdminRoleCache };
