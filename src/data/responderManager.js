/**
 * Auto-Responder Manager — keyword trigger → auto reply.
 *
 * File: data/responders.json
 * {
 *   "<guildId>": [
 *     {
 *       "id": "resp_<timestamp>_<rand>",
 *       "trigger": "beli",              // case-insensitive
 *       "matchMode": "contains",        // v3.9.47: "contains" | "exact"
 *                                        //   contains (DEFAULT, incl. legacy entries): the trigger
 *                                        //     matches as a WHOLE WORD anywhere in the message —
 *                                        //     "beli" matches "bagaimana cara beli", NOT "belian"
 *                                        //   exact (legacy behavior): the message must START with
 *                                        //     the trigger ("!sosmed" matches "!sosmed halo")
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
 *
 * v3.9.47: match modes (user request). Old behavior: a trigger only fired when
 * the message STARTED with it — trigger "beli" never matched "bagimana cara beli".
 * Now every responder has a matchMode:
 *   - "contains" (default, also applied to legacy entries without the field —
 *      this is the behavior the admin asked for): whole-word match anywhere in
 *      the message. Word boundaries are letter/digit aware (\p{L}\p{N}), so
 *      "beli" matches "bagaimana cara beli" / "mau beli?" but NOT "belian"/
 *      "membeli" — no false alarms from longer words that merely CONTAIN the
 *      trigger as a substring.
 *   - "exact": the legacy prefix behavior — message == trigger, or trigger
 *      followed by a space/newline ("!sosmed" matches "!sosmed halo").
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'responders.json');

// v3.9.47: escape all regex metacharacters so triggers like "!sos.med" are
// treated as literal text when the contains mode builds its word-boundary regex.
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * v3.9.47: pure matcher — does this message match this trigger under this mode?
 * Exported for unit tests. Inputs are lowercased INTERNALLY so the helper is
 * safe for any caller (case-insensitive by contract).
 *
 * @param {string} message      the message content (any case)
 * @param {string} trig         the trigger (any case)
 * @param {string} [matchMode]  'contains' (default) | 'exact'
 * @returns {boolean}
 */
function messageMatchesTrigger(message, trig, matchMode) {
    if (typeof message !== 'string' || typeof trig !== 'string' || !trig) return false;

    const lowerMessage = message.toLowerCase();
    const lowerTrig = trig.toLowerCase();

    if (matchMode === 'exact') {
        // Legacy behavior: the message must START with the trigger.
        return (
            lowerMessage === lowerTrig ||
            lowerMessage.startsWith(lowerTrig + ' ') ||
            lowerMessage.startsWith(lowerTrig + '\n')
        );
    }

    // contains (default): the trigger appears as a WHOLE WORD anywhere.
    // Whitespace is collapsed so multi-word triggers ("cara beli") also match
    // messages with doubled spaces. A "word" boundary is anything that is not
    // a letter/digit/underscore — punctuation ("beli?", "beli!") counts as a
    // boundary, while glued letters ("belian", "membeli") do NOT match.
    const normalizedMsg = lowerMessage.trim().replace(/\s+/g, ' ');
    const normalizedTrig = lowerTrig.trim().replace(/\s+/g, ' ');
    const re = new RegExp(
        `(^|[^\\p{L}\\p{N}_])${escapeRegExp(normalizedTrig)}([^\\p{L}\\p{N}_]|$)`,
        'u'
    );
    return re.test(normalizedMsg);
}

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
        // v3.9.47: match mode — 'contains' (default: whole word anywhere in the
        // message) or 'exact' (message must start with the trigger). Explicitly
        // normalized: anything that isn't 'exact' is stored as 'contains'.
        matchMode: data.matchMode === 'exact' ? 'exact' : 'contains',
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
 * v3.9.47: matching honors each responder's matchMode —
 *   - 'exact'    : the message starts with the trigger (legacy behavior)
 *   - 'contains' : the trigger appears as a whole word anywhere in the message
 *     (default, including legacy entries stored before v3.9.47)
 *
 * Per-user cooldown: user A who just triggered doesn't block user B from
 * getting a reply. v3.9.47: a responder on cooldown no longer aborts the scan
 * (previously `return null`) — the loop CONTINUES so an overlapping second
 * trigger (e.g. "beli" + "cara beli") can still reply.
 *
 * @param {string} guildId
 * @param {string} messageContent
 * @param {string} [userId]  pass userId for a per-user cooldown (recommended)
 * @returns {Object|null} responder entry, or null if no match / on cooldown
 */
function findMatch(guildId, messageContent, userId) {
    const responders = getGuildResponders(guildId);
    if (responders.length === 0) return null;

    const lower = String(messageContent || '').toLowerCase();
    const now = Date.now();

    for (const r of responders) {
        const trig = r.trigger.toLowerCase();
        if (!messageMatchesTrigger(lower, trig, r.matchMode)) continue;

        // Check the per-user cooldown. cooldownMs = 0 means the cooldown is off.
        // v3.9.38 FIX: `??` (not `||`) so 0 stays 0 — previously 0 silently
        // became 3000, so the "disable cooldown" option never worked.
        const cooldownMs = r.cooldownMs ?? 3000;
        if (cooldownMs > 0) {
            const lastFired = userId
                ? r.userCooldowns?.[userId]
                : r.lastFiredAt; // fallback: old global cooldown when no userId
            if (lastFired && now - lastFired < cooldownMs) {
                continue; // this user is still on cooldown — try the next responder
            }
        }
        return r;
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
    invalidateCache,
    // v3.9.47: pure matcher exported for unit tests
    messageMatchesTrigger
};
