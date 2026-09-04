/**
 * AFK Manager — track user yang lagi AFK + auto-reply saat di-mention.
 *
 * File: data/afk.json
 * {
 *   "<guildId>:<userId>": {
 *     "reason": "Makan dulu",
 *     "since": 1735689600000,
 *     "guildId": "...",
 *     "userId": "..."
 *   }
 * }
 *
 * Composite key supaya AFK scoped per guild (user bisa AFK di guild A tapi aktif di guild B).
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'afk.json');

// v3.9.26: read-through cache (pola panelManager). messageCreate membaca
// afk.json per pesan + per mention — sebelumnya itu 1+N readFileSync sync
// per pesan. Cache 15s TTL + update-on-save; invalidasi manual via
// invalidateCache() (dipakai restore backup & test cleanup).
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
        // v3.9.26: karantina file korup SEBELUM fallback — tanpa ini, save()
        // berikutnya menimpa isi file korup dengan state kosong (data hilang permanen).
        quarantineCorruptFile(filePath);
        _cache = { data: {}, at: Date.now() };
        return _cache.data;
    }
}

function save(data) {
    safeWriteJSON(filePath, data);
    // v3.9.26: update cache supaya read berikutnya konsisten dengan yang baru di-write
    _cache = { data, at: Date.now() };
}

/** v3.9.26: paksa read fresh berikutnya (restore backup / test). */
function invalidateCache() {
    _cache = null;
}

function keyFor(guildId, userId) {
    return `${guildId}:${userId}`;
}

function setAFK(guildId, userId, reason) {
    const all = load();
    const k = keyFor(guildId, userId);
    all[k] = {
        reason: reason || 'AFK',
        since: Date.now(),
        guildId,
        userId
    };
    save(all);
    return all[k];
}

function clearAFK(guildId, userId) {
    const all = load();
    const k = keyFor(guildId, userId);
    if (!all[k]) return false;
    delete all[k];
    save(all);
    return true;
}

function getAFK(guildId, userId) {
    const all = load();
    return all[keyFor(guildId, userId)] || null;
}

function isAFK(guildId, userId) {
    return getAFK(guildId, userId) !== null;
}

/**
 * v3.9.26: Batch check AFK untuk banyak user SEKALI load.
 * messageCreate dulu manggil getAFK() per mention (1+N read per pesan yang
 * ada mention). Sekarang satu load → semua mention ke-cover.
 *
 * @param {string} guildId
 * @param {string[]} userIds
 * @returns {Object<string, {reason, since, guildId, userId}>} map userId → data AFK (hanya yang AFK)
 */
function getAFKBatch(guildId, userIds) {
    if (!Array.isArray(userIds) || userIds.length === 0) return {};
    const all = load();
    const result = {};
    for (const uid of userIds) {
        const entry = all[keyFor(guildId, uid)];
        if (entry) result[uid] = entry;
    }
    return result;
}

/**
 * Format duration AFK (mis. "5 menit lalu", "2 jam lalu", "1 hari lalu").
 */
function formatDuration(since, now = Date.now()) {
    const diff = now - since;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} hari lalu`;
    if (hours > 0) return `${hours} jam lalu`;
    if (minutes > 0) return `${minutes} menit lalu`;
    return `${seconds} detik lalu`;
}

/**
 * List semua user AFK di guild tertentu, sorted by since (paling baru duluan).
 * v3.9.17: tambah supaya /afk-list tidak perlu baca afk.json langsung.
 *
 * @param {string} guildId
 * @returns {Array<{userId, reason, since, guildId}>}
 */
function listGuildAFK(guildId) {
    const all = load();
    return Object.values(all)
        .filter(data => data && data.guildId === guildId)
        .sort((a, b) => b.since - a.since);
}

/**
 * v3.9.38 FIX (GC): hapus entry AFK yang lebih tua dari `maxAgeMs`.
 * afk.json sebelumnya TIDAK PERNAH di-GC — user yang leave guild / lupa clear
 * tetap tercatat AFK selamanya (auto-reply terus menyebut user yang sudah lama
 * pergi + file tumbuh pelan tanpa batas). Entry lama TANPA field `since`
 * (format pra-v3.9.x) di-keep — umurnya tidak bisa ditentukan, jangan di-break.
 * Dipanggil scheduler harian (pruneStaleData di schedulerTasks.js).
 * Return jumlah entry yang dihapus.
 */
function pruneOldAFK(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    const all = load();
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [k, entry] of Object.entries(all)) {
        if (!entry || typeof entry !== 'object') continue;
        // Entry tanpa `since` (bukan number) → keep, jangan break data lama.
        if (typeof entry.since !== 'number' || Number.isNaN(entry.since)) continue;
        if (entry.since < cutoff) {
            delete all[k];
            removed++;
        }
    }
    if (removed > 0) save(all);
    return removed;
}

module.exports = {
    setAFK,
    clearAFK,
    getAFK,
    isAFK,
    getAFKBatch,
    formatDuration,
    listGuildAFK,
    invalidateCache,
    // v3.9.38
    pruneOldAFK
};
