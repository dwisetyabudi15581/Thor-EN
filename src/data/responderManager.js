/**
 * Auto-Responder Manager — keyword trigger → auto reply.
 *
 * File: data/responders.json
 * {
 *   "<guildId>": [
 *     {
 *       "id": "resp_<timestamp>_<rand>",
 *       "trigger": "!sosmed",           // case-insensitive, exact match at the start of the message
 *       "reply": "Instagram: @chronos\nTikTok: @chronos",
 *       "replyType": "text",            // "text" | "embed"
 *       "createdBy": "userId",
 *       "createdByTag": "User#1234",
 *       "createdAt": 1735689600000,
 *       "useCount": 0,
 *       "lastUsedAt": null,
 *       "cooldownMs": 3000,             // delay between the same trigger per user (3 second default)
 *       "lastFiredAt": null,            // legacy: last global timestamp used (no longer used, but kept just in case)
 *       "userCooldowns": {}             // per-user timestamps: { "userId": timestamp }
 *     }
 *   ]
 * }
 *
 * v3.9.13: generic community bot feature.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'responders.json');

// v3.9.26: read-through cache (panelManager pattern). findMatch is called in
// messageCreate PER MESSAGE — previously 1 sync readFileSync per message even
// with no responders at all. 15s TTL cache + update-on-save.
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

function genId() {
    return `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getGuildResponders(guildId) {
    const all = load();
    return all[guildId] || [];
}

function addResponder(guildId, data) {
    const all = load();
    if (!all[guildId]) all[guildId] = [];

    // Validate trigger: must not be empty, max 50 chars, no duplicates
    const trigger = data.trigger.trim();
    if (!trigger || trigger.length > 50) {
        return { ok: false, error: 'Invalid trigger (1-50 chars).' };
    }
    if (all[guildId].some(r => r.trigger.toLowerCase() === trigger.toLowerCase())) {
        return { ok: false, error: `Trigger "${trigger}" already exists. Use /remove-responder first.` };
    }

    // Max 50 responders per guild
    if (all[guildId].length >= 50) {
        return { ok: false, error: 'Maximum 50 responders per guild.' };
    }

    const entry = {
        id: genId(),
        trigger,
        reply: data.reply,
        replyType: data.replyType === 'embed' ? 'embed' : 'text',
        createdBy: data.createdBy,
        createdByTag: data.createdByTag,
        createdAt: Date.now(),
        useCount: 0,
        lastUsedAt: null,
        // v3.9.38 FIX: cooldownMs 0 = cooldown OFF (per the registry docs). `||`
        // swallowed 0 → silently became 3000; nullish coalescing keeps 0 as 0.
        cooldownMs: data.cooldownMs ?? 3000,
        lastFiredAt: null, // legacy — no longer used, kept for backward compat
        userCooldowns: {} // per-user cooldown map
    };
    all[guildId].push(entry);
    save(all);
    return { ok: true, responder: entry };
}

function removeResponder(guildId, trigger) {
    const all = load();
    if (!all[guildId]) return { ok: false, error: 'Trigger not found.' };

    const before = all[guildId].length;
    all[guildId] = all[guildId].filter(r => r.trigger.toLowerCase() !== trigger.toLowerCase());
    if (all[guildId].length === before) {
        return { ok: false, error: `Trigger "${trigger}" not found.` };
    }
    save(all);
    return { ok: true };
}

/**
 * Find the responder that matches a message.
 * Matches when the message starts with the trigger (case-insensitive).
 *
 * Per-user cooldown: user A who just triggered doesn't block user B from
 * getting a reply.
 *
 * @param {string} guildId
 * @param {string} messageContent
 * @param {string} [userId]  pass userId for a per-user cooldown (recommended)
 * @returns {Object|null} responder entry, or null if no match / on cooldown
 */
function findMatch(guildId, messageContent, userId) {
    const responders = getGuildResponders(guildId);
    if (responders.length === 0) return null;

    const lower = messageContent.toLowerCase();
    const now = Date.now();

    for (const r of responders) {
        const trig = r.trigger.toLowerCase();
        // Match when the message == trigger, OR the trigger is followed by a
        // space/newline (e.g. "!sosmed" matches "!sosmed hello")
        if (lower === trig || lower.startsWith(trig + ' ') || lower.startsWith(trig + '\n')) {
            // Check the per-user cooldown. cooldownMs = 0 means the cooldown is off.
            // v3.9.38 FIX: `??` (not `||`) so 0 stays 0 — previously 0 silently
            // became 3000, so the "disable cooldown" option never worked.
            const cooldownMs = r.cooldownMs ?? 3000;
            if (cooldownMs > 0 && userId && r.userCooldowns && r.userCooldowns[userId]) {
                const lastFired = r.userCooldowns[userId];
                if (now - lastFired < cooldownMs) {
                    return null; // this user is still on cooldown, skip
                }
            } else if (cooldownMs > 0 && !userId && r.lastFiredAt) {
                // Fallback: if the caller doesn't pass userId, use the old global cooldown
                if (now - r.lastFiredAt < cooldownMs) {
                    return null;
                }
            }
            return r;
        }
    }
    return null;
}

/**
 * Mark a responder as used (updates useCount + records the cooldown timestamp).
 * Pass userId for a per-user cooldown.
 */
function markUsed(guildId, responderId, userId) {
    const all = load();
    if (!all[guildId]) return;
    const r = all[guildId].find(x => x.id === responderId);
    if (!r) return;
    r.useCount = (r.useCount || 0) + 1;
    r.lastUsedAt = Date.now();
    r.lastFiredAt = Date.now(); // legacy — still filled in just in case
    // Record the per-user cooldown
    if (userId) {
        if (!r.userCooldowns || typeof r.userCooldowns !== 'object') r.userCooldowns = {};
        r.userCooldowns[userId] = Date.now();
        // Cleanup: keep only the last 100 users so the file doesn't bloat
        const entries = Object.entries(r.userCooldowns);
        if (entries.length > 100) {
            entries.sort((a, b) => b[1] - a[1]);
            r.userCooldowns = Object.fromEntries(entries.slice(0, 100));
        }
    }
    save(all);
}

module.exports = {
    getGuildResponders,
    addResponder,
    removeResponder,
    findMatch,
    markUsed,
    invalidateCache
};
