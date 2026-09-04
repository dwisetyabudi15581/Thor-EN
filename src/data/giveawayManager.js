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
 *     prize: "VIP 30 Days",
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
        console.warn('⚠️ giveaways.json is corrupt, starting from an empty array:', err.message);
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
    // v3.9.8 FIX: made idempotent. Previously, if end() was called twice (e.g.
    // manual /giveaway end after the scheduler had already ended it), winnerIds
    // was overwritten with the default [] → all previous winners were wiped.
    if (gw.ended && gw.winnerIds && gw.winnerIds.length > 0 && (!winnerIds || winnerIds.length === 0)) {
        // Already ended with winners — don't overwrite with empty.
        return gw;
    }
    gw.ended = true;
    // v3.9.38 FIX: record endedAt when marking ended — the prune GC reads
    // `g.endedAt || g.endsAt`; without this a giveaway ended EARLY by an admin
    // was kept until endsAt+30h (too long, since endsAt is still far away).
    gw.endedAt = Date.now();
    gw.winnerIds = winnerIds;
    save(list);
    return gw;
}

/**
 * Reroll — pick 1 new winner from the participants (excluding existing winners).
 * Persists the new winner to gw.winnerIds. Returns { winnerId, gw } or null on failure.
 *
 * P0-4 FIX: previously it only returned a winnerId without persisting & without dedup.
 */
function reroll(id) {
    const list = load();
    const gw = list.find(g => g.id === id);
    if (!gw || !gw.ended) return null;

    // Exclude participants who have already won
    const existingWinners = new Set(gw.winnerIds || []);
    const pool = gw.participantIds.filter(uid => !existingWinners.has(uid));

    if (pool.length === 0) {
        // If every participant has already won, fallback: pick from all participants
        if (gw.participantIds.length === 0) return { winnerId: null, gw };
        const fallbackIdx = Math.floor(Math.random() * gw.participantIds.length);
        const winnerId = gw.participantIds[fallbackIdx];
        // v3.9.8 FIX: persist the reused winner too, so /stats doesn't double-count
        // when an admin rerolls repeatedly (previously the reused winner wasn't in
        // winnerIds → the next reroll could pick the same person again).
        if (!gw.winnerIds) gw.winnerIds = [];
        if (!gw.winnerIds.includes(winnerId)) {
            gw.winnerIds.push(winnerId);
            save(list);
        }
        return { winnerId, gw, reused: true };
    }

    const idx = Math.floor(Math.random() * pool.length);
    const winnerId = pool[idx];

    // Persist to gw.winnerIds
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
 * Fisher-Yates shuffle — uniform distribution, NOT biased like sort(random).
 * P1-9 FIX: previously used `[...arr].sort(() => Math.random() - 0.5)`
 * whose distribution is NOT uniform on modern V8 engines.
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
 * Pick winners randomly from the participant list.
 * Returns an array of (unique) userIds.
 */
function pickWinners(participantIds, count) {
    if (!participantIds || participantIds.length === 0) return [];
    const shuffled = shuffle(participantIds);
    return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * v3.9.26 (GC): delete giveaways that ended more than `olderThanMs` ago.
 * Ended giveaways were NEVER deleted before → giveaways.json grew without
 * bound (1 entry+/giveaway, forever) → /giveaway list getting heavier every
 * month. Called by the daily scheduler (schedulerTasks.js). Returns the number
 * of entries removed.
 */
function pruneEndedOlderThan(olderThanMs) {
    const list = load();
    const cutoff = Date.now() - olderThanMs;
    const keep = list.filter(g => {
        if (!g) return false;
        if (!g.ended) return true; // active ones are never touched
        // endedAt doesn't always exist — fall back to endsAt (an ended giveaway
        // is definitely past endsAt).
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
