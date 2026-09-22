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
 * and — since v3.9.54 — ANY currency marker: "$3", "€25", "¥1000", "₩25,000", "25 usd",
 * "IDR 30.000"... The bot is currency-AGNOSTIC: it records the numeric amount
 * in whatever currency the admin prices their products. Dual-currency strings
 * ("3$ USD | Rp. 25.000") still record the Rupiah half (v3.9.50 behavior).
 *
 * v3.9.55 FIX (user question: "does it support decimals like $2.5 USD?"):
 * international currencies USE cents, so when a NON-Rp currency marker is
 * present a single dot with a 1-2 digit fraction is now a DECIMAL ("$2.5" → 2.5,
 * "$2.50" → 2.5, "$9.99" → 9.99, "$12.99" → 12.99 — the Rp heuristic used to
 * read those as thousands: 250 / 999 / 1299, a silent 100x error), while a
 * 3-digit fraction stays a thousands group ("$50.000" German style → 50000,
 * "$1.234.567" → 1234567). Cents are PRESERVED in the result (rounded to at
 * most 2 decimals) instead of Math.round to a whole number ("$1,234.56" →
 * 1234.56, not 1235). The Rp branch and marker-less legacy inputs are unchanged.
 * Escrow (midmanManager.parsePriceNumber) keeps its whole-amount strictness —
 * "$2.5" is rejected there on purpose (deal-safety, see its own docs).
 *
 * v3.9.57 FIX (user request: "make the /add-product price support decimals,
 * e.g. 5.88"): the v3.9.55 decimal rule above now applies to MARKER-LESS
 * inputs too, not just currency-marked ones — "5.88" → 5.88 (used to read as
 * 588, a silent 100x error), "9.99" → 9.99, "0.99" → 0.99. Why it's safe: a
 * VALID Indonesian thousands group is always 3 digits ("50.000"), so a single
 * dot with a 1-2 digit fraction cannot be a correct Rupiah format — it's far
 * more likely the admin is writing a decimal (any cents-using currency; the
 * bot is currency-agnostic since v3.9.54). A 3-digit fraction ("50.000",
 * "5.880") and multi-dot ("1.234.567") stay THOUSANDS — the Rupiah format is
 * untouched. Deliberate consequences: "1.50" is now 1.5 (was 150) and
 * "100.00" is now 100 (was 10000) — write those thousands as "150" /
 * "10.000"; suffix+decimal now matches the comma version ("1.50rb" → 1500,
 * was 150,000; "9.99jt" → 9,990,000, was 999,000,000 — both used to explode
 * 100x).
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
    let s = String(priceStr).toLowerCase().trim();
    // v3.9.50 FIX (user report: price entered as "3$ USD | Rp. 25.000" — the
    // actual product price format). parseFloat stops at the '$', so the dual
    // price recorded **Rp 3** per sale and the revenue looked frozen AGAIN.
    // Stats are denominated in Rupiah: when an 'rp' marker exists, read the
    // amount attached to it directly (pipe, separators and the USD half are
    // ignored).
    if (/rp/.test(s)) {
        const m = s.match(/rp\.?\s*([0-9][0-9.,]*\s*(?:juta|jt|rb|k|m)?)/);
        if (m) {
            s = m[1];
        } else {
            // Marker AFTER the amount ("25.000 rp") or stray noise — old behavior:
            // strip the marker and parse what remains.
            s = s.replace(/rp\.?/g, '');
        }
    } else if (/[|$€£¥₩₱₹₫฿]|\b(?:usd|eur|gbp|jpy|krw|php|inr|vnd|thb|myr|sgd|idr|aud|cad|chf)\b/.test(s)) {
        // v3.9.54 (user request: "the bot will be used by people outside
        // Indonesia too — make it work for everyone"): ANY currency marker is
        // now accepted, not just Rp. The bot records the NUMERIC amount in
        // whatever currency the admin prices their products (no conversion).
        // Markers are stripped and the FIRST amount wins ("$3 | €2" → 3);
        // Rp keeps its dedicated branch above so dual-currency strings still
        // record the Rupiah half (v3.9.50 behavior, unchanged).
        s = s
            .replace(/[|$€£¥₩₱₹₫฿]/g, ' ')
            .replace(/\b(?:usd|eur|gbp|jpy|krw|php|inr|vnd|thb|myr|sgd|idr|aud|cad|chf)\b/g, ' ');
        // First amount (k/m suffix must be ATTACHED to avoid grabbing a word:
        // "buy 3 monkeys for $5" → 3, not "3 m" → 3000).
        const m = s.match(/[0-9][0-9.,]*(?:\s*(?:juta|jt|rb)|[km])?/);
        if (!m) return 0; // a marker with no amount ("usd") → unparseable
        s = m[0];
        // (v3.9.57: the `intl` flag is no longer needed — one decimal rule
        // for every input, see the hasDot branch below.)
    }
    s = s.replace(/\s/g, '');
    let multiplier = 1;
    // v3.9.49 FIX (user report: "total revenue doesn't update"): Indonesian
    // suffixes were SILENTLY mis-parsed — "25rb" kept the trailing 'rb', and
    // parseFloat picked up only the leading digits → 25 recorded instead of
    // 25.000, so every sale added a near-invisible amount to the revenue.
    // Order matters: 'juta' before 'jt' (longest first).
    if (s.endsWith('juta')) {
        multiplier = 1000000;
        s = s.slice(0, -4);
    } else if (s.endsWith('jt')) {
        multiplier = 1000000;
        s = s.slice(0, -2);
    } else if (s.endsWith('rb')) {
        multiplier = 1000;
        s = s.slice(0, -2);
    } else if (s.endsWith('k')) {
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
        // Only a dot (no comma). Two possibilities: a THOUSANDS group (ID
        // format, e.g. "50.000" → 50000) or a DECIMAL (international, "5.88").
        //
        // v3.9.8/9/17 (Rupiah-centric era): a marker-less dot was ALWAYS
        // thousands — only int < 10 + a 1-digit fraction ("2.5") read as a
        // decimal, so "5.88" read as 588 and "9.99" as 999 (a silent 100x
        // error).
        //
        // v3.9.55: with a non-Rp currency marker, a 1-2 digit fraction is a
        // decimal ("$9.99" → 9.99); a 3-digit fraction stays thousands.
        //
        // v3.9.57 FIX (user request: "make the /add-product price support
        // decimals, e.g. 5.88"): the v3.9.55 rule now applies to MARKER-LESS
        // inputs too — the `intl` flag is gone, one rule for every marker. The
        // safety separator: a VALID Indonesian thousands group is always 3
        // digits ("50.000"), so a single dot with a 1-2 digit fraction
        // ("5.88", "9.99", "0.99") is not a correct Rupiah format — the most
        // sensible reading is a decimal (currency-agnostic v3.9.54: the
        // admin's currency can be anything, most use cents). Suffix+decimal
        // now matches the comma version: "1.50rb" → 1.5 × 1000 = 1500 (was
        // 150,000), "9.99jt" → 9.99 × 1,000,000 (was 999 million — both used
        // to explode 100x).
        const parts = s.split('.');
        if (parts.length === 2 && parts[0] !== '' && parts[1].length > 0 && parts[1].length <= 2) {
            // One dot, 1-2 digit fraction → DECIMAL — keep the dot for parseFloat
            // ("5.88", "2.50", "9.99", "0.99", "12.99")
        } else {
            // 3-digit fraction ("50.000", "5.880") or multi-dot ("1.234.567")
            // → thousands groups: strip all dots
            s = s.replace(/\./g, '');
        }
    }

    const n = parseFloat(s);
    // v3.9.38 FIX: negative results are clamped to 0 — a price string "-5000" /
    // "Rp -25k" must not turn totalSpent/revenue negative.
    // v3.9.55 FIX: stats are currency-AGNOSTIC (v3.9.54), so cents are now
    // PRESERVED — round to at most 2 decimals instead of to a whole number
    // ("$2.5" → 2.5, not 3; "$1,234.56" → 1234.56, not 1235). Integer inputs
    // (every Rp price) produce identical results to before.
    return isNaN(n) ? 0 : Math.max(0, Math.round(n * multiplier * 100) / 100);
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
