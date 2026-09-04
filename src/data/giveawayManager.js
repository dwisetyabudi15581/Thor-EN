/**
 * Giveaway Manager — store & manage giveaways.
 *
 * File: giveaways.json
 * [
 *   {
 *     id: "gw_<timestamp>_<rand>",
 *     guildId: "...",
 *     channelId: "...",
 *     messageId: "...",
 *     prize: "VIP 30 Hari",
 *     winnersCount: 1,
 *     endsAt: 1735689600000,
 *     ended: false,
 *     winnerIds: [],
 *     participantIds: [],
 *     hostId: "...",
 *     hostTag: "Admin#1234",
 *     requiredRoleId: null,  // optional
 *     createdAt: ...
 *   }
 * ]
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'giveaways.json');

function load() {
    try {
        if (!fs.existsSync(filePath)) return [];
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.warn('⚠️ giveaways.json rusak, mulai dari array kosong:', err.message);
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
    return `gw_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function create(data) {
    const list = load();
    const gw = {
        id: genId(),
        guildId: data.guildId,
        channelId: data.channelId,
        messageId: null,
        prize: data.prize,
        winnersCount: Math.max(1, parseInt(data.winnersCount) || 1),
        endsAt: data.endsAt,
        ended: false,
        winnerIds: [],
        participantIds: [],
        hostId: data.hostId,
        hostTag: data.hostTag,
        requiredRoleId: data.requiredRoleId || null,
        createdAt: Date.now()
    };
    list.push(gw);
    save(list);
    return gw;
}

function setMessageId(id, messageId) {
    const list = load();
    const gw = list.find(g => g.id === id);
    if (gw) {
        gw.messageId = messageId;
        save(list);
    }
    return gw;
}

function get(id) {
    return load().find(g => g.id === id);
}

function getByMessage(messageId) {
    return load().find(g => g.messageId === messageId);
}

function getByGuild(guildId) {
    return load().filter(g => g.guildId === guildId);
}

function getActive() {
    return load().filter(g => !g.ended);
}

function getEnding(now = Date.now()) {
    return load().filter(g => !g.ended && g.endsAt <= now);
}

function addParticipant(id, userId) {
    const list = load();
    const gw = list.find(g => g.id === id);
    if (!gw) return null;
    if (!gw.participantIds.includes(userId)) {
        gw.participantIds.push(userId);
        save(list);
    }
    return gw;
}

function removeParticipant(id, userId) {
    const list = load();
    const gw = list.find(g => g.id === id);
    if (!gw) return null;
    gw.participantIds = gw.participantIds.filter(u => u !== userId);
    save(list);
    return gw;
}

function end(id, winnerIds = []) {
    const list = load();
    const gw = list.find(g => g.id === id);
    if (!gw) return null;
    // v3.9.8 FIX: jadi idempotent. Sebelumnya, kalau end() dipanggil 2x (mis.
    // manual /giveaway end setelah scheduler sudah end), winnerIds ditimpa dengan
    // default [] → semua winner sebelumnya ter-wipe.
    if (gw.ended && gw.winnerIds && gw.winnerIds.length > 0 && (!winnerIds || winnerIds.length === 0)) {
        // Sudah ended dengan winner — jangan overwrite dengan empty.
        return gw;
    }
    gw.ended = true;
    // v3.9.38 FIX: catat endedAt saat mark ended — prune GC membaca
    // `g.endedAt || g.endsAt`; tanpa ini giveaway yang di-end DINI oleh admin
    // dipertahankan sampai endsAt+30h (terlalu lama, karena endsAt masih jauh).
    gw.endedAt = Date.now();
    gw.winnerIds = winnerIds;
    save(list);
    return gw;
}

/**
 * Reroll — pilih 1 winner baru dari participant (exclude winner yang sudah ada).
 * Persist winner baru ke gw.winnerIds. Return { winnerId, gw } atau null kalau gagal.
 *
 * P0-4 FIX: sebelumnya cuma return winnerId tanpa persist & tanpa dedup.
 */
function reroll(id) {
    const list = load();
    const gw = list.find(g => g.id === id);
    if (!gw || !gw.ended) return null;

    // Exclude participant yang sudah pernah menang
    const existingWinners = new Set(gw.winnerIds || []);
    const pool = gw.participantIds.filter(uid => !existingWinners.has(uid));

    if (pool.length === 0) {
        // Kalau semua participant sudah pernah menang, fallback: pick dari semua participant
        if (gw.participantIds.length === 0) return { winnerId: null, gw };
        const fallbackIdx = Math.floor(Math.random() * gw.participantIds.length);
        const winnerId = gw.participantIds[fallbackIdx];
        // v3.9.8 FIX: persist reused winner juga supaya /stats tidak double-count
        // kalau admin reroll berkali-kali (sebelumnya reused winner gak masuk
        // winnerIds → next reroll bisa pick orang yang sama lagi).
        if (!gw.winnerIds) gw.winnerIds = [];
        if (!gw.winnerIds.includes(winnerId)) {
            gw.winnerIds.push(winnerId);
            save(list);
        }
        return { winnerId, gw, reused: true };
    }

    const idx = Math.floor(Math.random() * pool.length);
    const winnerId = pool[idx];

    // Persist ke gw.winnerIds
    if (!gw.winnerIds) gw.winnerIds = [];
    gw.winnerIds.push(winnerId);
    save(list);

    return { winnerId, gw, reused: false };
}

function remove(id) {
    const list = load();
    const filtered = list.filter(g => g.id !== id);
    if (filtered.length !== list.length) {
        save(filtered);
        return true;
    }
    return false;
}

/**
 * Fisher-Yates shuffle — distribusi uniform, TIDAK biased seperti sort(random).
 * P1-9 FIX: sebelumnya pakai `[...arr].sort(() => Math.random() - 0.5)`
 * yang distribusinya TIDAK uniform di engine V8 modern.
 */
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Pick winners secara random dari participant list.
 * Returns array of userId (unique).
 */
function pickWinners(participantIds, count) {
    if (!participantIds || participantIds.length === 0) return [];
    const shuffled = shuffle(participantIds);
    return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * v3.9.26 (GC): hapus giveaway yang sudah ended lebih dari `olderThanMs` lalu.
 * Giveaway ended TIDAK PERNAH dihapus sebelumnya → giveaways.json tumbuh tanpa
 * batas (1 entry+/giveaway, selamanya) → /giveaway list makin berat tiap bulan.
 * Dipanggil scheduler harian (schedulerTasks.js). Return jumlah entry yang dihapus.
 */
function pruneEndedOlderThan(olderThanMs) {
    const list = load();
    const cutoff = Date.now() - olderThanMs;
    const keep = list.filter(g => {
        if (!g) return false;
        if (!g.ended) return true; // aktif tidak pernah di-touch
        // endedAt tidak selalu ada — fallback ke endsAt (giveaway ended pasti
        // lewat endsAt).
        const endedAt = g.endedAt || g.endsAt || 0;
        return endedAt > cutoff;
    });
    const removedCount = list.length - keep.length;
    if (removedCount > 0) save(keep);
    return removedCount;
}

module.exports = {
    create,
    setMessageId,
    get,
    getByMessage,
    getByGuild,
    getActive,
    getEnding,
    addParticipant,
    removeParticipant,
    end,
    reroll,
    remove,
    pickWinners,
    shuffle,
    // v3.9.26
    pruneEndedOlderThan
};
