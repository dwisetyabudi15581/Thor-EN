/**
 * Leveling Manager — XP per message + level + auto-role on level up.
 *
 * File: data/levels.json
 * {
 *   "<guildId>:<userId>": {
 *     "xp": 1250,
 *     "level": 5,
 *     "lastMessageAt": 1735689600000,    // for the anti-spam XP cooldown
 *     "totalXp": 1250,                   // total XP ever earned (never decreases)
 *     "guildId": "...",
 *     "userId": "..."
 *   }
 * }
 *
 * Level config in config.json (config.leveling):
 * {
 *   "leveling": {
 *     "enabled": true,
 *     "xpPerMessage": 15,
 *     "cooldownMs": 60000,               // 1 minute between XP gains
 *     "announceLevelUp": true,           // ping the user in chat on level up
 *     "levelUpChannel": null             // null = channel where the user chatted. ID = specific channel
 *   },
 *   "levelRoles": [                      // auto-assigned role at level cap
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

// v3.9.26: read-through cache (panelManager pattern). addXp does a read +
// full-file rewrite in messageCreate PER MESSAGE that earns XP (with leveling
// on) — previously that was readFileSync + writeFileSync O(total users) per
// grant. A 15s TTL cache + update-on-save still writes per grant (durability),
// but reads are cheap; biggest effect: messages without an XP grant (cooldown
// active) no longer hit the disk.
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
        // v3.9.26: quarantine the corrupt file BEFORE falling back (see safeWrite.js).
        quarantineCorruptFile(filePath);
        _cache = { data: {}, at: Date.now() };
        return _cache.data;
    }
}

function save(data) {
    safeWriteJSON(filePath, data);
    // v3.9.26: update the cache so the next read is consistent with what was just written
    _cache = { data, at: Date.now() };
}

/** v3.9.26: force the next read to be fresh (backup restore / tests). */
function invalidateCache() {
    _cache = null;
}

function keyFor(guildId, userId) {
    return `${guildId}:${userId}`;
}

/**
 * Calculate the XP required to reach a given level.
 * Total cumulative XP from level 0 to level N.
 */
function xpForLevel(level) {
    return 50 * level * (level + 1);
}

/**
 * Calculate the level from total XP.
 * Inverse of xpForLevel: 50 * L * (L+1) = totalXp
 * L^2 + L - 2*totalXp/50 = 0  →  L = (-1 + sqrt(1 + 4*totalXp/50)) / 2
 */
function levelFromXp(totalXp) {
    if (totalXp < 100) return 0; // quick check: < 100 XP = level 0
    const level = Math.floor((-1 + Math.sqrt(1 + (4 * totalXp) / 50)) / 2);
    return Math.max(0, level);
}

/**
 * XP required to go from the current level to the next level.
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
            xp: 0, // XP at the current level (reset on every level up)
            level: 0,
            lastMessageAt: null,
            totalXp: 0,
            guildId,
            userId
        }
    );
}

/**
 * Add XP to a user. Returns { leveledUp: boolean, newLevel: number, oldLevel: number }.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {number} xpGain - XP to add
 * @param {Object} config - config.leveling (for the cooldown check)
 * @returns {{ leveledUp, newLevel, oldLevel, user }}
 */
function addXp(guildId, userId, xpGain, config) {
    const all = load();
    const k = keyFor(guildId, userId);
    const now = Date.now();
    // v3.9.38 FIX: cooldownMs 0 = XP on EVERY message (per the config docs).
    // `||` swallowed 0 → silently became 60000; nullish coalescing keeps 0 as 0.
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

    // Cooldown check — if still on cooldown, skip the XP gain.
    // v3.9.38 FIX: `cooldownMs > 0` gate so 0 = no cooldown (explicit, and also
    // safe if clock skew makes lastMessageAt > now) — previously 0 was already
    // turned into 60000 by `||`, so this option could never be used.
    if (cooldownMs > 0 && user.lastMessageAt && now - user.lastMessageAt < cooldownMs) {
        return { leveledUp: false, newLevel: user.level, oldLevel: user.level, user, onCooldown: true };
    }

    const oldLevel = user.level;
    user.totalXp = (user.totalXp || 0) + xpGain;
    user.xp = user.totalXp - xpForLevel(oldLevel);
    user.lastMessageAt = now;

    // Check for level up
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
 * Get level roles from the config (for auto-assignment).
 */
function getLevelRoles(config) {
    return config?.levelRoles || [];
}

/**
 * Check which roles should be given to a user who reached a given level.
 * Returns an array of roleIds (all roles whose level is ≤ the user's level).
 * Supports stacking — a level 50 user gets the level 10, 20, and 50 roles all
 * at once.
 *
 * @param {number} level
 * @param {Object} config
 * @returns {string[]} array of roleIds (empty if none match)
 */
function getRoleForLevel(level, config) {
    const roles = getLevelRoles(config);
    // Take all roles with level <= user level, sorted ascending by level
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
