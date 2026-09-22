/**
 * configOrphans.js — v3.29.0 "TAHAP 1" sync audit helper.
 *
 * WHAT THIS DOES
 * --------------
 * When Discord-side reality changes (a channel or a role is deleted), the
 * guild's stored settings may still POINT at the now-deleted ID. Those
 * "orphaned references" are the #1 source of silent breakage:
 *   - config.channels.welcome → a deleted channel = welcome embeds silently stop
 *   - roles.admin / roles.booster / roles.verified → a deleted role = guards fail
 *   - automod allow-lists, autorole join roles, levelRoles, product auto-roles,
 *     temp voice, ticket/self-role panels, scheduled announcements …
 *
 * This module SCANS every store and returns human-readable labels for each
 * orphaned reference, so the event handlers (channelDelete / guildRoleDelete)
 * can warn the admin immediately (console + the server-log channel) instead of
 * failing silently for weeks.
 *
 * DESIGN RULES
 * ------------
 * - READ-ONLY. This scanner never mutates a single byte of stored data — the
 *   decision to clear an orphaned reference belongs to the admin (the web
 *   dashboard renders them as explicit "Deleted …" ghost options, and with the
 *   v3.29.0 dashboard auto-refresh those ghosts appear within seconds of the
 *   deletion happening on Discord).
 * - Best-effort per source: each store is wrapped in its own try/catch, so a
 *   corrupt/missing file or a manager refactor can never break the event
 *   handler that calls this. An unreadable source simply contributes nothing.
 * - No caching: called once per channel/role DELETION (rare), so a fresh read
 *   per call is the correct, race-free choice.
 */

const { getConfig } = require('../data/configManager');

/** Safely resolve a module + method; returns null instead of throwing. */
function safeCall(modPath, method, ...args) {
    try {
        const mod = require(modPath);
        const fn = mod && mod[method];
        if (typeof fn !== 'function') return null;
        const out = fn(...args);
        return out === undefined ? null : out;
    } catch (_) {
        return null;
    }
}

/**
 * Find every stored setting that still points at a (now deleted) channel ID.
 * @param {string} guildId
 * @param {string} channelId - the deleted channel's ID
 * @returns {string[]} human-readable labels, e.g. "config channels.welcome"
 */
function findChannelRefs(guildId, channelId) {
    if (!guildId || !channelId) return [];
    const refs = [];
    const id = String(channelId);

    // 1. Guild config — channels map + leveling level-up channel.
    try {
        const config = getConfig(guildId);
        if (config && typeof config === 'object') {
            if (config.channels && typeof config.channels === 'object') {
                for (const [key, value] of Object.entries(config.channels)) {
                    if (value === id) refs.push(`General → ${key} channel`);
                }
            }
            if (config.leveling && config.leveling.levelUpChannel === id) {
                refs.push('Leveling → level-up announcement channel');
            }
        }
    } catch (_) {
        /* unreadable config — skip this source */
    }

    // 2. AutoMod link allow-list.
    try {
        const automod = safeCall('../data/automodManager', 'getGuildConfig', guildId);
        if (automod && Array.isArray(automod.linkAllowedChannels) && automod.linkAllowedChannels.includes(id)) {
            refs.push('AutoMod → allowed-links channel list');
        }
    } catch (_) {
        /* skip */
    }

    // 3. Temp voice setup (creator channel / category).
    try {
        const tv = safeCall('../data/tempVoiceManager', 'getGuildConfig', guildId);
        if (tv && typeof tv === 'object') {
            if (tv.creatorChannelId === id) refs.push('Temp Voice → creator (join-to-create) channel');
            if (tv.categoryId === id) refs.push('Temp Voice → channel category');
        }
    } catch (_) {
        /* skip */
    }

    // 4. Installed ticket panels (the panel message lives in that channel).
    try {
        const panels = safeCall('../data/panelManager', 'getPanelsByGuild', guildId);
        if (Array.isArray(panels)) {
            for (const p of panels) {
                if (p && p.channelId === id) refs.push(`Ticket panel "${p.title || p.id}" (message is gone)`);
            }
        }
    } catch (_) {
        /* skip */
    }

    // 5. Self-role / verification panels (same: message unreachable).
    try {
        const panels = safeCall('../data/selfRoleManager', 'getPanelsByGuild', guildId);
        if (Array.isArray(panels)) {
            for (const p of panels) {
                if (p && p.channelId === id) {
                    refs.push(`Self-role panel "${p.title || p.id}" (message is gone)`);
                }
            }
        }
    } catch (_) {
        /* skip */
    }

    // 6. Pending scheduled announcements (the scheduler drops them on its next
    //    tick — this warning explains WHY they vanished).
    try {
        const anns = safeCall('../data/scheduledAnnouncements', 'getByGuild', guildId);
        if (Array.isArray(anns)) {
            for (const a of anns) {
                if (a && !a.sent && a.channelId === id) {
                    refs.push(`Scheduled announcement ${a.id || '(unnamed)'} (will be dropped)`);
                }
            }
        }
    } catch (_) {
        /* skip */
    }

    return refs;
}

/**
 * Find every stored setting that still points at a (now deleted) role ID.
 * @param {string} guildId
 * @param {string} roleId - the deleted role's ID
 * @returns {string[]} human-readable labels
 */
function findRoleRefs(guildId, roleId) {
    if (!guildId || !roleId) return [];
    const refs = [];
    const id = String(roleId);

    // 1. Guild config — the named roles (admin, booster, verified, …).
    try {
        const config = getConfig(guildId);
        if (config && typeof config === 'object') {
            if (config.roles && typeof config.roles === 'object') {
                for (const [key, value] of Object.entries(config.roles)) {
                    if (value === id) refs.push(`General → ${key} role`);
                }
            }
            // 2. Auto-role join list.
            if (config.autorole && Array.isArray(config.autorole.roleIds) && config.autorole.roleIds.includes(id)) {
                refs.push('Auto-Role → join role list');
            }
            // 3. Leveling reward roles.
            if (Array.isArray(config.levelRoles)) {
                for (const lr of config.levelRoles) {
                    if (lr && lr.roleId === id) refs.push(`Leveling → level ${lr.level} reward role`);
                }
            }
            // 4. Product auto-roles (set via /set-product-role).
            if (Array.isArray(config.products)) {
                for (const p of config.products) {
                    if (p && p.roleId === id) refs.push(`Product "${p.label || p.value}" auto-role`);
                }
            }
        }
    } catch (_) {
        /* unreadable config — skip this source */
    }

    // 5. AutoMod exempt role list.
    try {
        const automod = safeCall('../data/automodManager', 'getGuildConfig', guildId);
        if (automod && Array.isArray(automod.linkAllowedRoles) && automod.linkAllowedRoles.includes(id)) {
            refs.push('AutoMod → allowed-links role list');
        }
    } catch (_) {
        /* skip */
    }

    // 6. Self-role / verification panel roles (buttons keep pointing at the
    //    deleted role → clicking them errors until the panel is edited).
    try {
        const panels = safeCall('../data/selfRoleManager', 'getPanelsByGuild', guildId);
        if (Array.isArray(panels)) {
            for (const p of panels) {
                if (!p || !Array.isArray(p.roles)) continue;
                for (const r of p.roles) {
                    if (r && r.roleId === id) {
                        refs.push(`Self-role panel "${p.title || p.id}" → button "${r.label || r.roleId}"`);
                    }
                    // v3.26.0 conditional-role gate (requiresRoleId).
                    if (r && r.requiresRoleId === id) {
                        refs.push(`Self-role panel "${p.title || p.id}" → visibility gate "${r.label || r.roleId}"`);
                    }
                }
            }
        }
    } catch (_) {
        /* skip */
    }

    return refs;
}

module.exports = { findChannelRefs, findRoleRefs };
