/**
 * Stats Manager — track user activity for leaderboards & stats.
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
 *   Before, the key was only `userId` → stats from Guild A leaked into Guild B.
 *   Now key = `${guildId}:${userId}` (composite, same as warns.json).
 *   Backward compat: legacy entries (keys without `:`) are migrated to the first
 *   guild registered via `init()` (called from index.js ClientReady).
 *
 * Tracking:
 *   - messages: count of user messages (updated by the messageCreate event)
 *   - vipPurchases: count of VIP purchases (updated by the set-key flow)
 *   - totalSpent: total money spent (extracted from the product price)
 *   - giveawaysWon: count of giveaways won
 *
 * === P0-1 FIX: In-memory cache + periodic flush ===
 * Before: every `incrementMessages` loaded+saved the JSON file synchronously
 * → blocking the event loop on every message → bot lag on active servers.
 * Now: uses an in-memory cache, flushed to disk every 30 seconds or
 * when a non-message change happens (purchase/win/join).
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'stats.json');
const FLUSH_INTERVAL_MS = 30 * 1000; // 30 seconds

// === In-memory cache ===
let cache = null; // null = not loaded yet
let dirty = false; // does the cache have un-flushed changes?
let flushTimer = null; // periodic flush timer
let defaultGuildId = null; // v3.9.4: for migrating legacy entries

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
 * v3.9.4: Init with the default guild ID for migrating legacy entries.
 * Called from index.js ClientReady. If the bot is in 1 guild, all legacy
 * entries get assigned to that guild. If the bot is multi-guild,
 * legacy entries are assigned to the first guild (good enough for most cases).
 *
 * @param {string} guildId
 */
function init(guildId) {
    if (!guildId) return;
    defaultGuildId = guildId;
    // If the cache is already loaded, trigger the migration now.
    if (cache !== null) migrateLegacyEntries();
}

/**
 * v3.9.4: Migrate legacy entries (keys without `:`) to the composite key
 * `${defaultGuildId}:${userId}`. Idempotent — already-composite entries are untouched.
 */
function migrateLegacyEntries() {
    if (!defaultGuildId || cache === null) return;
    let migrated = 0;
    const newCache = {};
    for (const [k, v] of Object.entries(cache)) {
        if (k.includes(':')) {
            // Already composite — keep as-is, backfill guildId/userId fields if missing.
            if (!v.guildId || !v.userId) {
                const [gid, uid] = k.split(':');
                if (!v.guildId) v.guildId = gid;
                if (!v.userId) v.userId = uid;
            }
            newCache[k] = v;
        } else {
            // Legacy entry — k is a plain userId. Re-key to composite.
            const newKey = keyFor(defaultGuildId, k);
            if (!v.guildId) v.guildId = defaultGuildId;
            if (!v.userId) v.userId = k;
            // If a composite entry already exists for this user (race condition case),
            // merge: sum the counters, take the earliest timestamps.
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
        console.log(`🔄 stats.json: ${migrated} legacy entries migrated to guild ${defaultGuildId}.`);
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
        console.warn('⚠️ stats.json is corrupted:', err.message);
        // v3.9.26: quarantine the corrupt file before falling back (see safeWrite.js).
        quarantineCorruptFile(filePath);
        cache = {};
    }
    // v3.9.4: run the legacy migration if defaultGuildId is already set.
    if (defaultGuildId) migrateLegacyEntries();
    return cache;
}

/**
 * Flush the cache to disk if dirty. Doesn't throw — just logs errors.
 */
// v3.9.0 FIX: atomic write via safeWriteJSON (tmp+rename) to prevent corruption on crash
function flush() {
    if (!dirty || cache === null) return;
    try {
        safeWriteJSON(filePath, cache);
        dirty = false;
    } catch (err) {
        console.error('⚠️ Failed to flush stats.json:', err.message);
    }
}

/**
 * Start the periodic flush timer. Called once when the bot starts (in index.js ready).
 */
function startAutoFlush() {
    if (flushTimer) return; // already started
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    // Don't block process exit
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Force flush + stop the timer. Called at graceful shutdown.
 */
function shutdown() {
    flush();
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
}

/**
 * v3.9.1: Invalidate the cache + reload from disk. Called after restoreBackup
 * so the in-memory cache (which may hold old data) doesn't overwrite the
 * restored data at the next flush.
 *
 * Scenario before the fix:
 *   1. Bot running, stats.json cache holds { userA: 5 messages }
 *   2. Admin restores an old backup (stats.json holds { userA: 3 messages })
 *   3. User sends a message → incrementMessages updates the cache to { userA: 6 }
 *      (should be 4, since the restored data has 3)
 *   4. Periodic flush writes { userA: 6 } to stats.json → restored data lost
 *
 * Fix: set cache = null so load() re-reads from disk.
 */
function reload() {
    // Don't flush the old cache — it's exactly the stale data we want to discard.
    dirty = false;
    cache = null;
    load();
}

/**
 * v3.9.4: Get a user's stats scoped to the guild.
 * @param {string} guildId
 * @param {string} userId
 */
function getStats(guildId, userId) {
    const all = load();
    return all[keyFor(guildId, userId)] || defaultUserStats();
}

/**
 * Increment the message count — P0-1 fix: uses the cache, NO sync file I/O.
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
    // No immediate flush — periodic flush every 30 seconds.
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
    flush(); // important — don't lose the transaction if the bot crashes
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
 * Get the top N users by metric, scoped to the guild.
 * v3.9.4: only counts entries belonging to this guild.
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
        // v3.9.31 FIX: ...stats FIRST, override AFTER. The old pattern put userId
        // before the spread — an explicitly undefined property in stats could
        // override the k.split(':')[1] fallback with undefined, and a legacy key
        // without ':' would produce userId undefined.
        .map(([k, stats]) => ({ ...stats, userId: stats.userId || k.split(':')[1], value: stats[metric] || 0 }))
        .filter(e => e.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, limit);
}

/**
 * Get aggregate stats for a guild.
 * v3.9.4: only counts entries belonging to this guild.
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
 * Parse a price string into a number. Handles "Rp 25.000", "25000", "25.000", "25k", "2.5M"
 *
 * P2-13 FIX: before, `.replace(/\./g, '').replace(/,/g, '.')` was ambiguous:
 *   - "25,000" (US thousands) → "25.000" → parseFloat → 25 (WRONG, should be 25000)
 *   - "Rp. 50.000" (ID thousands) → 50000 → OK
 *   - "2,5M" (ID decimal) → "2.5M" → 2.5 × 1000000 = OK
 * Now: detect the format based on the presence of both dot & comma.
 */
function parsePrice(priceStr) {
    // v3.9.38 FIX: negative numeric input is also clamped — a price must not
    // be negative (totalSpent/revenue could go negative via the product price).
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
        // Both present → use the last position to decide the decimal.
        // E.g. "1,234.56" (US) → comma=thousands, dot=decimal
        // E.g. "1.234,56" (EU/ID) → dot=thousands, comma=decimal
        if (s.lastIndexOf('.') > s.lastIndexOf(',')) {
            // US: dot=decimal, comma=thousands → remove commas, keep the dot
            s = s.replace(/,/g, '');
        } else {
            // EU/ID: dot=thousands, comma=decimal → remove dots, turn commas into dots
            s = s.replace(/\./g, '').replace(/,/g, '.');
        }
    } else if (hasComma) {
        // Only a comma. Assumption: thousands separator (more common in ID).
        // E.g. "25,000" → 25000
        // But "2,5" → ambiguous, treat as decimal (2.5).
        const parts = s.split(',');
        if (parts.length === 2 && parts[1].length <= 2) {
            // Comma as decimal (e.g. "2,5")
            s = s.replace(/,/g, '.');
        } else {
            // Comma as thousands separator
            s = s.replace(/,/g, '');
        }
    } else if (hasDot) {
        // Only a dot. Assumption: thousands separator (ID format).
        // E.g. "50.000" → 50000
        //
        // v3.9.8 FIX: the old `parts[1].length <= 2` heuristic treated it as a decimal,
        // making "1.50" (ID = 150) wrongly 1.5, and "100.00" (ID = 10000) wrongly 100.
        //
        // v3.9.9 FIX: stricter heuristic. For Rupiah (an integer currency),
        // a thousands separator is far more common than a decimal. Only treat it as
        // a decimal when it's VERY clear (int part < 10 AND a 1-digit fraction).
        // E.g. "2.5" → 2.5 (decimal), "9.9" → 9.9 (decimal).
        // But "1.50" → 150 (thousands), "10.50" → 1050 (thousands), "2.50" → 250 (thousands).
        //
        // v3.9.17 FIX: for the Rupiah currency (an integer currency), a dot is ALWAYS
        // a thousands separator. "1.5" as 1.5 Rupiah makes no sense — the admin most
        // likely means 15 or 1500. But for backward compat, we keep the
        // v3.9.9 heuristic for small numbers (< 10) so old tests don't break.
        // Documentation: if an admin wants a price below 10 Rupiah with a decimal
        // (very rare), just use the format "0.5" or "5".
        const parts = s.split('.');
        if (parts.length === 2 && parts[0] !== '' && parts[1].length > 0) {
            const intPart = parseInt(parts[0], 10);
            // Treat as a decimal ONLY if:
            //   - int part < 10 (very small — Rupiah prices are rarely < 10)
            //   - the fractional part is exactly 1 digit (not the ambiguous 2)
            //   - not "0" (e.g. "1.0" → 10, not 1.0)
            if (!isNaN(intPart) && intPart < 10 && parts[1].length === 1 && parts[1] !== '0') {
                // Dot as decimal (e.g. "2.5", "9.9")
                // keep it
            } else {
                // Dot as thousands separator
                s = s.replace(/\./g, '');
            }
        } else {
            // Multiple dots (e.g. "1.234.567") → thousands separators
            s = s.replace(/\./g, '');
        }
    }

    const n = parseFloat(s);
    // v3.9.38 FIX: negative results are clamped to 0 — a price string "-5000" /
    // "Rp -25k" must not turn totalSpent/revenue negative.
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
