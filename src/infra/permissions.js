const { PermissionFlagsBits } = require('discord.js');
const { getConfig } = require('../data/configManager');

/**
 * v3.30.0 RBAC — three access tiers shared by the bot AND the web dashboard
 * (one source of truth: the guild's config file, resolved against the LIVE
 * gateway member state):
 *
 *   3  Super Admin / Owner  — everything, Discord commands + all dashboard
 *                            modules. Resolved from: Discord Administrator /
 *                            ManageGuild (live permissions), the guild owner,
 *                            config.roles.admin (legacy /set-role admin),
 *                            config.access.adminRoleIds, config.access.adminUserIds.
 *   2  Moderator / Staff    — daily moderation (timeout/kick/ban/purge/warn,
 *                            ticket management) on Discord AND the dashboard.
 *                            Resolved from: config.access.staffRoleIds,
 *                            config.access.staffUserIds, or holding any of the
 *                            Discord moderation bits (ModerateMembers,
 *                            BanMembers, KickMembers, ManageMessages) — the
 *                            pre-RBAC behavior, kept as backward compatibility.
 *   1  Member               — public commands only; on the dashboard they see
 *                            their own profile (stats/level/warns/tickets).
 *
 * Caching: the per-guild ACCESS CONFIG (role/user id lists) is cached for
 * 30 seconds (same TTL as the legacy admin-role cache) — member roles are
 * always read live from the gateway cache, so a role change reflects within
 * one cache refresh at most. setField()/the DASH API invalidate the cache
 * immediately when access.* or roles.admin changes (hot apply, no restart).
 */

const CACHE_TTL_MS = 30 * 1000; // 30 seconds

const TIER = Object.freeze({ MEMBER: 1, STAFF: 2, ADMIN: 3 });
const TIER_LABELS = Object.freeze({ 1: 'member', 2: 'staff', 3: 'admin' });

// v3.10.0: Map guildId -> { roleId, expiresAt }. A null roleId means
// "already checked, not set" (different from "not checked yet" = no entry).
const adminRoleCache = new Map();

// v3.30.0: Map guildId -> { access, expiresAt } — the parsed config.access
// lists (role/user ids per tier). Re-read after TTL or invalidation.
const accessConfigCache = new Map();

/** Discord permission bits that grant STAFF (tier 2) — mirrors MODERATION_COMMANDS. */
const STAFF_PERMISSION_BITS = [
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.ManageMessages
];

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

/** Normalize a snowflake list from config (defensive: unknown shapes -> []). */
function toIdList(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(id => typeof id === 'string' && /^\d{5,25}$/.test(id));
}

/**
 * The guild's access config (v3.30.0) — cached 30s per guild.
 * Legacy roles.admin is honored as an ADDITIONAL admin role (union), so
 * servers configured with /set-role admin before v3.30.0 keep working.
 */
function getAccessConfig(guildId) {
    if (!guildId) return { adminRoleIds: [], staffRoleIds: [], adminUserIds: [], staffUserIds: [] };

    const now = Date.now();
    const hit = accessConfigCache.get(guildId);
    if (hit && now < hit.expiresAt) return hit.access;

    let access = null;
    try {
        const config = getConfig(guildId);
        access = config.access && typeof config.access === 'object' ? config.access : null;
    } catch (_err) {
        access = null; // corrupt/missing config -> no custom access lists
    }
    const parsed = {
        adminRoleIds: toIdList(access?.adminRoleIds),
        staffRoleIds: toIdList(access?.staffRoleIds),
        adminUserIds: toIdList(access?.adminUserIds),
        staffUserIds: toIdList(access?.staffUserIds)
    };
    accessConfigCache.set(guildId, { access: parsed, expiresAt: now + CACHE_TTL_MS });
    return parsed;
}

/**
 * Manually invalidate the cache. Called when the admin role or the access
 * lists change (setField, the DASH API config route, backupManager restore)
 * so the change takes effect immediately without waiting for the TTL.
 * v3.30.0: clears BOTH caches (legacy admin role + access lists).
 */
function invalidateAdminRoleCache() {
    adminRoleCache.clear();
    accessConfigCache.clear();
}

/** @deprecated alias kept for clarity in new code — use invalidateAdminRoleCache(). */
function invalidateAccessCache() {
    invalidateAdminRoleCache();
}

/**
 * Resolve a member's access tier + the sources that granted it.
 * @param {import('discord.js').GuildMember} member
 * @returns {{ tier: 1|2|3, label: string, sources: string[] }}
 */
function resolveAccessTier(member) {
    const sources = [];

    if (member?.permissions?.has(PermissionFlagsBits.Administrator)) {
        sources.push('discord:Administrator');
    }
    if (member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        sources.push('discord:ManageGuild');
    }

    const guildId = member?.guild?.id || null;
    const access = getAccessConfig(guildId);

    if (guildId && member?.id) {
        if (access.adminUserIds.includes(member.id)) sources.push('access:adminUserIds');
        if (access.staffUserIds.includes(member.id)) sources.push('access:staffUserIds');
    }

    if (guildId && member?.roles?.cache) {
        const legacyAdminRoleId = getAdminRoleId(guildId);
        if (legacyAdminRoleId && member.roles.cache.has(legacyAdminRoleId)) sources.push('roles:admin (legacy)');
        for (const roleId of access.adminRoleIds) {
            if (member.roles.cache.has(roleId)) sources.push(`access:adminRoleIds(${roleId})`);
        }
        for (const roleId of access.staffRoleIds) {
            if (member.roles.cache.has(roleId)) sources.push(`access:staffRoleIds(${roleId})`);
        }
    }

    for (const bit of STAFF_PERMISSION_BITS) {
        if (member?.permissions?.has(bit)) {
            sources.push('discord:mod-permission');
            break; // one entry is enough context
        }
    }

    const admin = sources.some(
        s =>
            s.startsWith('discord:Administrator') ||
            s.startsWith('discord:ManageGuild') ||
            s.startsWith('roles:admin') ||
            s.startsWith('access:admin')
    );
    const staff = !admin && sources.some(s => s.startsWith('access:staff') || s.startsWith('discord:mod-permission'));

    const tier = admin ? TIER.ADMIN : staff ? TIER.STAFF : TIER.MEMBER;
    return { tier, label: TIER_LABELS[tier], sources };
}

/** Convenience: the numeric tier (1|2|3). */
function getAccessTier(member) {
    return resolveAccessTier(member).tier;
}

/**
 * Is this member STAFF or above (tier >= 2)? — the guard for daily
 * moderation actions (ticket close/set-key, etc.).
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
function isStaff(member) {
    return getAccessTier(member) >= TIER.STAFF;
}

/**
 * Is this member a bot admin (tier 3)? Same resolution as before v3.30.0
 * (Discord ManageGuild/Administrator, or the configured admin role) plus the
 * new access.adminRoleIds / access.adminUserIds lists.
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
function isAdmin(member) {
    if (!member) return false;

    // Check Discord permissions directly (most reliable, no cache needed)
    if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;

    // v3.30.0: explicit per-user admin grant (works even without roles)
    const guildId = member.guild?.id;
    if (guildId && member.id && getAccessConfig(guildId).adminUserIds.includes(member.id)) return true;

    // Check the admin roles from the member's guild config (cached per-guild)
    if (guildId && member.roles?.cache) {
        const legacyAdminRoleId = getAdminRoleId(guildId);
        if (legacyAdminRoleId && member.roles.cache.has(legacyAdminRoleId)) return true;
        const { adminRoleIds } = getAccessConfig(guildId);
        for (const roleId of adminRoleIds) {
            if (member.roles.cache.has(roleId)) return true;
        }
    }

    return false;
}

module.exports = {
    TIER,
    TIER_LABELS,
    isAdmin,
    isStaff,
    getAccessTier,
    resolveAccessTier,
    getAccessConfig,
    invalidateAdminRoleCache,
    invalidateAccessCache
};
