/**
 * Command Stats — per-guild slash-command execution counter (v3.31.0).
 *
 * Feeds the dashboard Overview "Commands Executed" summary card. Counted at
 * the router's dispatch points (domain handler + custom command) — i.e. only
 * commands that actually RAN (permission/deny replies are not executions).
 *
 * Storage: data/commandStats.json — { "<guildId>": <count> }
 * Durability model (same as statsManager): in-memory cache + periodic flush
 * every 30s, plus an immediate flush on read-after-long-idle is unnecessary
 * because reads come from the same cache the increments write to. A crash can
 * lose at most 30s of counts — acceptable for a dashboard statistic.
 *
 * Shape is deliberately tiny (one number per guild) so the payload stays slim.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'commandStats.json');
const FLUSH_INTERVAL_MS = 30 * 1000;

// === In-memory cache ===
let cache = null; // null = not loaded yet
let dirty = false;
let flushTimer = null;

function load() {
    if (cache !== null) return cache;
    try {
        if (!fs.existsSync(filePath)) {
            cache = {};
            return cache;
        }
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // Defensive: only keep numeric entries keyed by a guild id string.
        cache = {};
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [k, v] of Object.entries(raw)) {
                if (typeof k === 'string' && k.length > 0 && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
                    cache[k] = Math.floor(v);
                }
            }
        }
    } catch (err) {
        console.warn('⚠️ commandStats.json unreadable — starting a fresh counter:', err.message);
        try {
            quarantineCorruptFile(filePath);
        } catch (_) {
            /* quarantine is best-effort */
        }
        cache = {};
    }
    return cache;
}

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushSync();
    }, FLUSH_INTERVAL_MS);
    // Never keep the process alive just for a stats flush.
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function flushSync() {
    if (cache === null || !dirty) return;
    try {
        safeWriteJSON(filePath, cache);
        dirty = false;
    } catch (err) {
        console.warn('⚠️ commandStats flush failed (will retry on next flush):', err.message);
    }
}

/**
 * Count one executed command for a guild. Fire-and-forget — never throws.
 * @param {string} guildId
 */
function increment(guildId) {
    if (!guildId || typeof guildId !== 'string') return;
    const c = load();
    c[guildId] = (c[guildId] || 0) + 1;
    dirty = true;
    scheduleFlush();
}

/**
 * Current count for a guild (0 when never counted).
 * @param {string} guildId
 * @returns {number}
 */
function getCount(guildId) {
    if (!guildId || typeof guildId !== 'string') return 0;
    const c = load();
    return c[guildId] || 0;
}

/** Flush now (used on graceful shutdown). Never throws. */
function flush() {
    try {
        flushSync();
    } catch (_) {
        /* already logged inside flushSync */
    }
}

module.exports = { increment, getCount, flush };
