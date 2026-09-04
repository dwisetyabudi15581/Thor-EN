/**
 * Scheduled Announcements — send an embed to a channel at a specific time.
 *
 * File: scheduledAnnouncements.json
 * [
 *   {
 *     id: "sa_<timestamp>_<rand>",
 *     guildId: "...",
 *     channelId: "...",
 *     sendAt: 1735689600000,    // timestamp ms
 *     sent: false,
 *     sentAt: null,
 *     data: {
 *       title, description, color, image, thumbnail, mention,
 *       authorId, authorTag
 *     },
 *     recurring: null | 'daily' | 'weekly' | 'monthly',
 *     createdAt: ...
 *   }
 * ]
 *
 * Recurring:
 *   - daily: sendAt is updated to next day, same time
 *   - weekly: sendAt is updated to next week, same time
 *   - monthly: sendAt is updated to next month, same day+time
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

// v3.9.38 FIX: absolute times are parsed with an explicit offset (default WITA +8,
// matching the /announce-schedule help text) — not the host timezone. A UTC VPS
// previously made every absolute announcement 8 hours late. Configurable via
// env TZ_OFFSET_HOURS (valid -12..14, outside range → fallback 8).
const DEFAULT_TZ_OFFSET_HOURS = 8;
function getTzOffsetHours() {
    const n = parseInt(process.env.TZ_OFFSET_HOURS ?? String(DEFAULT_TZ_OFFSET_HOURS), 10);
    return Number.isFinite(n) && n >= -12 && n <= 14 ? n : DEFAULT_TZ_OFFSET_HOURS;
}

const filePath = path.join(__dirname, '..', '..', 'data', 'scheduledAnnouncements.json');

function load() {
    try {
        if (!fs.existsSync(filePath)) return [];
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.warn('⚠️ scheduledAnnouncements.json is corrupt:', err.message);
        // v3.9.26: quarantine the corrupt file before falling back (see safeWrite.js).
        quarantineCorruptFile(filePath);
        return [];
    }
}

// v3.9.0 FIX: atomic write via safeWriteJSON (tmp+rename) to prevent corruption on crash
function save(list) {
    safeWriteJSON(filePath, list);
}

function genId() {
    return `sa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function create(data) {
    const list = load();
    const entry = {
        id: genId(),
        guildId: data.guildId,
        channelId: data.channelId,
        sendAt: data.sendAt,
        sent: false,
        sentAt: null,
        data: {
            title: data.title,
            description: data.description,
            color: data.color || 0x5865f2,
            image: data.image || null,
            thumbnail: data.thumbnail || null,
            mention: data.mention || null,
            authorId: data.authorId,
            authorTag: data.authorTag
        },
        recurring: data.recurring || null,
        createdAt: Date.now()
    };
    list.push(entry);
    save(list);
    return entry;
}

function get(id) {
    return load().find(e => e.id === id);
}

function getByGuild(guildId) {
    return load().filter(e => e.guildId === guildId);
}

function getPending(now = Date.now()) {
    return load().filter(e => !e.sent && e.sendAt <= now);
}

function markSent(id) {
    const list = load();
    const entry = list.find(e => e.id === id);
    if (!entry) return null;
    entry.sent = true;
    entry.sentAt = Date.now();

    // If recurring, create a new entry for the next cycle
    // v3.9.17 FIX: catch-up loop. Previously, if the bot was offline for a long
    // time (e.g. 30 days for a daily recurring), nextSendAt would still be in
    // the past → the next scheduler tick (60s) fires again → creates another
    // new entry → spamming 1 announce per minute until catching up to now.
    // Now: while-loop nextSendAt until > now, so the new entry is always in
    // the future. But cap it at 365 iterations max (defense-in-depth in case
    // computeNextRecurring has a bug and returns a stale timestamp).
    if (entry.recurring) {
        let nextSendAt = computeNextRecurring(entry.sendAt, entry.recurring);
        const now = Date.now();
        let iter = 0;
        const MAX_ITER = 366; // 1 year cycle maximum
        while (nextSendAt && nextSendAt <= now && iter < MAX_ITER) {
            nextSendAt = computeNextRecurring(nextSendAt, entry.recurring);
            iter++;
        }
        if (nextSendAt) {
            const newEntry = {
                ...entry,
                id: genId(),
                sendAt: nextSendAt,
                sent: false,
                sentAt: null,
                createdAt: Date.now()
            };
            list.push(newEntry);
        }
    }

    save(list);
    return entry;
}

function remove(id) {
    const list = load();
    const filtered = list.filter(e => e.id !== id);
    if (filtered.length !== list.length) {
        save(filtered);
        return true;
    }
    return false;
}

/**
 * Compute next recurring timestamp.
 * @param {number} fromTs - reference timestamp
 * @param {string} type - 'daily' | 'weekly' | 'monthly'
 * @returns {number|null} next timestamp, or null if invalid
 */
function computeNextRecurring(fromTs, type) {
    const d = new Date(fromTs);
    switch (type) {
        case 'daily':
            d.setDate(d.getDate() + 1);
            return d.getTime();
        case 'weekly':
            d.setDate(d.getDate() + 7);
            return d.getTime();
        case 'monthly':
            d.setMonth(d.getMonth() + 1);
            return d.getTime();
        default:
            return null;
    }
}

/**
 * Parse a natural language time string into a timestamp.
 * Supported formats:
 *   - ISO: "2026-01-15 20:00" → assumed to be in the bot's timezone (default
 *     WITA/UTC+8, v3.9.38 — previously the host timezone, causing an 8 hour
 *     offset on UTC VPSes)
 *   - Relative: "30m", "2h", "1d" → now + duration
 *
 * v3.9.1 FIX: added range validation so admins can't schedule an announce
 *   1000000 days into the future (which would keep creating ghost recurring
 *   entries forever).
 *   - Relative: max 365 days (8760 hours)
 *   - Absolute: max 5 years into the future
 *   - Past time: null (also rejected by the caller, but set here too)
 *
 * @returns {number|null} timestamp in ms, or null if invalid
 */
function parseTime(input) {
    if (!input) return null;
    const trimmed = input.trim().toLowerCase();
    const now = Date.now();
    const MAX_RELATIVE_DAYS = 365;
    const MAX_ABSOLUTE_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000; // 5 years

    // Relative: 30m, 2h, 1d, 1h30m
    const relMatch = trimmed.match(/^(\d+)([mhd])$/);
    if (relMatch) {
        const num = parseInt(relMatch[1]);
        const unit = relMatch[2];
        // v3.9.1: range check — a number that's too large is invalid.
        if (num <= 0 || num > 1000000) return null;

        let deltaMs;
        if (unit === 'm') deltaMs = num * 60000;
        else if (unit === 'h') deltaMs = num * 3600000;
        else if (unit === 'd') deltaMs = num * 86400000;
        else return null;

        // Check the upper bound (max 365 days)
        if (deltaMs > MAX_RELATIVE_DAYS * 86400000) return null;

        return now + deltaMs;
    }

    // ISO-like: "2026-01-15 20:00" or "2026-01-15T20:00"
    const isoMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (isoMatch) {
        const [, y, mo, d, h, mi, s] = isoMatch;
        const yearNum = parseInt(y, 10);
        const monthNum = parseInt(mo, 10);
        const dayNum = parseInt(d, 10);
        const hourNum = parseInt(h, 10);
        const minNum = parseInt(mi, 10);
        const secNum = s ? parseInt(s, 10) : 0;
        // v3.9.38 FIX: build from the input components as pure UTC first — used
        // for rollover validation (and free from the host timezone).
        // v3.9.8 FIX: the Date constructor auto-rolls invalid components (e.g.
        // month 13 → January next year, day 40 → 9th of next month). Previously,
        // "2026-13-40 99:99" silently became a valid date in 2027. Now: verify
        // components match.
        const wall = new Date(Date.UTC(yearNum, monthNum - 1, dayNum, hourNum, minNum, secNum));
        if (isNaN(wall.getTime())) return null;
        if (
            wall.getUTCFullYear() !== yearNum ||
            wall.getUTCMonth() !== monthNum - 1 ||
            wall.getUTCDate() !== dayNum ||
            wall.getUTCHours() !== hourNum ||
            wall.getUTCMinutes() !== minNum
        ) {
            return null;
        }

        // v3.9.38 FIX: convert the wall-clock (bot timezone, default WITA +8) →
        // an absolute UTC timestamp with an explicit offset. Previously used
        // `new Date(y, mo, d, ...)` (host timezone) → on a UTC VPS every absolute
        // announcement was 8 hours later than promised by the help text.
        const ts = wall.getTime() - getTzOffsetHours() * 3600 * 1000;
        // v3.9.1: reject if in the past OR more than 5 years into the future.
        if (ts < now) return null;
        if (ts > now + MAX_ABSOLUTE_FUTURE_MS) return null;
        return ts;
    }

    return null;
}

/**
 * v3.9.26 (GC): delete announcement entries that were sent more than
 * `olderThanMs` ago. Sent entries used to be kept forever + every recurring
 * cycle created a NEW entry → 365 entries/year per daily announce.
 * Called by the daily scheduler. Returns the number of entries removed.
 */
function pruneSentOlderThan(olderThanMs) {
    const list = load();
    const cutoff = Date.now() - olderThanMs;
    const keep = list.filter(e => {
        if (!e) return false;
        if (!e.sent) return true; // pending entries are never touched
        const sentAt = e.sentAt || e.sendAt || 0;
        return sentAt > cutoff;
    });
    const removedCount = list.length - keep.length;
    if (removedCount > 0) save(keep);
    return removedCount;
}

module.exports = {
    create,
    get,
    getByGuild,
    getPending,
    markSent,
    remove,
    computeNextRecurring,
    parseTime,
    // v3.9.26
    pruneSentOlderThan,
    // v3.9.38: absolute timezone offset (default WITA +8) — for tests & help text
    getTzOffsetHours
};
