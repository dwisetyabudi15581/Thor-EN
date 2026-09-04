/**
 * Scheduled Announcements — kirim embed ke channel pada waktu tertentu.
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
 *   - daily: sendAt di-update ke next day, same time
 *   - weekly: sendAt di-update ke next week, same time
 *   - monthly: sendAt di-update ke next month, same day+time
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

// v3.9.38 FIX: absolute time diparse dengan offset eksplisit (default WITA +8,
// sesuai teks bantuan /announce-schedule) — bukan timezone host. VPS UTC
// sebelumnya bikin semua announcement absolute telat 8 jam. Configurable via
// env TZ_OFFSET_HOURS (valid -12..14, di luar range → fallback 8).
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
        console.warn('⚠️ scheduledAnnouncements.json rusak:', err.message);
        // v3.9.26: karantina file korup sebelum fallback (lihat safeWrite.js).
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

    // Kalau recurring, bikin entry baru untuk next cycle
    // v3.9.17 FIX: catch-up loop. Sebelumnya, kalau bot offline lama (mis. 30 hari
    // untuk daily recurring), nextSendAt masih di masa lalu → scheduler tick
    // berikutnya (60s) fires lagi → bikin entry baru lagi → spam 1 announce per
    // menit sampai catch up ke now.
    // Sekarang: while-loop nextSendAt sampai > now, supaya entry baru selalu
    // di masa depan. Tapi batasi maks 365 iterasi (defense-in-depth kalau ada
    // bug di computeNextRecurring yang return timestamp tetap).
    if (entry.recurring) {
        let nextSendAt = computeNextRecurring(entry.sendAt, entry.recurring);
        const now = Date.now();
        let iter = 0;
        const MAX_ITER = 366; // 1 tahun cycle maximum
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
 * @param {number} fromTs - timestamp referensi
 * @param {string} type - 'daily' | 'weekly' | 'monthly'
 * @returns {number|null} next timestamp, atau null kalau invalid
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
 * Parse natural language time string ke timestamp.
 * Format yang didukung:
 *   - ISO: "2026-01-15 20:00" → di-asumsikan zona waktu bot (default WITA/UTC+8,
 *     v3.9.38 — sebelumnya timezone host, bikin offset 8 jam di VPS UTC)
 *   - Relative: "30m", "2h", "1d" → now + duration
 *
 * v3.9.1 FIX: tambah range validation supaya admin tidak schedule announce
 *   1000000 hari ke depan (yang akan bikin recurring ghost entries forever).
 *   - Relative: maks 365 hari (8760 jam)
 *   - Absolute: maks 5 tahun ke depan
 *   - Past time: null (akan di-reject oleh caller juga, tapi set di sini juga)
 *
 * @returns {number|null} timestamp ms, atau null kalau invalid
 */
function parseTime(input) {
    if (!input) return null;
    const trimmed = input.trim().toLowerCase();
    const now = Date.now();
    const MAX_RELATIVE_DAYS = 365;
    const MAX_ABSOLUTE_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000; // 5 tahun

    // Relative: 30m, 2h, 1d, 1h30m
    const relMatch = trimmed.match(/^(\d+)([mhd])$/);
    if (relMatch) {
        const num = parseInt(relMatch[1]);
        const unit = relMatch[2];
        // v3.9.1: range check — angka terlalu besar = invalid.
        if (num <= 0 || num > 1000000) return null;

        let deltaMs;
        if (unit === 'm') deltaMs = num * 60000;
        else if (unit === 'h') deltaMs = num * 3600000;
        else if (unit === 'd') deltaMs = num * 86400000;
        else return null;

        // Cek batas atas (maks 365 hari)
        if (deltaMs > MAX_RELATIVE_DAYS * 86400000) return null;

        return now + deltaMs;
    }

    // ISO-like: "2026-01-15 20:00" atau "2026-01-15T20:00"
    const isoMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (isoMatch) {
        const [, y, mo, d, h, mi, s] = isoMatch;
        const yearNum = parseInt(y, 10);
        const monthNum = parseInt(mo, 10);
        const dayNum = parseInt(d, 10);
        const hourNum = parseInt(h, 10);
        const minNum = parseInt(mi, 10);
        const secNum = s ? parseInt(s, 10) : 0;
        // v3.9.38 FIX: bangun dari komponen input sebagai UTC murni dulu —
        // dipakai untuk validasi rollover (dan bebas dari timezone host).
        // v3.9.8 FIX: Date constructor auto-rolls invalid components (mis. month 13
        // → January next year, day 40 → 9th of next month). Sebelumnya, "2026-13-40 99:99"
        // silently menjadi valid date di tahun 2027. Sekarang: verify components match.
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

        // v3.9.38 FIX: konversi wall-clock (zona bot, default WITA +8) → timestamp
        // UTC absolut dengan offset eksplisit. Sebelumnya pakai `new Date(y, mo, d,
        // ...)` (timezone host) → di VPS UTC semua absolute announcement telat
        // 8 jam dari yang dijanjikan teks bantuan.
        const ts = wall.getTime() - getTzOffsetHours() * 3600 * 1000;
        // v3.9.1: reject kalau di masa lalu ATAU lebih dari 5 tahun ke depan.
        if (ts < now) return null;
        if (ts > now + MAX_ABSOLUTE_FUTURE_MS) return null;
        return ts;
    }

    return null;
}

/**
 * v3.9.26 (GC): hapus entry announcement yang sudah terkirim lebih dari
 * `olderThanMs` lalu. Entry sent dipertahankan selamanya sebelumnya + setiap
 * cycle recurring bikin entry BARU → 365 entry/tahun per announce harian.
 * Dipanggil scheduler harian. Return jumlah entry yang dihapus.
 */
function pruneSentOlderThan(olderThanMs) {
    const list = load();
    const cutoff = Date.now() - olderThanMs;
    const keep = list.filter(e => {
        if (!e) return false;
        if (!e.sent) return true; // pending tidak pernah di-touch
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
    // v3.9.38: offset zona waktu absolut (default WITA +8) — untuk test & help text
    getTzOffsetHours
};
