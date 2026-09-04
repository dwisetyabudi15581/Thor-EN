/**
 * Poll Manager — store polls with vote tracking.
 *
 * File: polls.json
 * [
 *   {
 *     id: "poll_<timestamp>_<rand>",
 *     guildId, channelId, messageId,
 *     question: "Event weekend ini?",
 *     options: [
 *       { label: "Rank Push", emoji: "🎮", votes: ["userId1", "userId2"] },
 *       { label: "Custom Room", emoji: "🏠", votes: ["userId3"] }
 *     ],
 *     multiple: false,      // true = boleh pilih banyak
 *     closed: false,
 *     createdAt, closedAt: null,
 *     creatorId, creatorTag
 *   }
 * ]
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'polls.json');

function load() {
    try {
        if (!fs.existsSync(filePath)) return [];
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.warn('⚠️ polls.json rusak:', err.message);
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
    return `poll_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// === v3.9.1: In-memory poll session store ===
// Dipakai untuk passing data dari /poll create command → modal submit handler.
// Sebelumnya, data (channelId, multiple, question) di-encode ke customId modal,
// yang bisa overflow 100-char Discord customId limit kalau question panjang
// (apalagi setelah encodeURIComponent — spasi jadi %20, dll).
// Sekarang: data disimpan di Map, customId hanya berisi short session id.
const POLL_SESSION_TTL_MS = 5 * 60 * 1000; // 5 menit (modal harus di-submit cepat)
const pollSessions = new Map();

// Cleanup expired sessions tiap 5 menit supaya memory tidak bocor.
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, s] of pollSessions) {
        if (now - s.createdAt > POLL_SESSION_TTL_MS) {
            pollSessions.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Poll sessions: ${cleaned} expired dihapus.`);
    }
}, POLL_SESSION_TTL_MS).unref?.();

function genSessionId() {
    return `ps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Buat poll session baru (dipanggil /poll create saat menampilkan modal).
 * @param {Object} data - { userId, channelId, multiple, question }
 * @returns {string} sessionId (pendek, aman dipakai di customId Discord)
 */
function createPollSession(data) {
    const id = genSessionId();
    pollSessions.set(id, {
        userId: data.userId,
        channelId: data.channelId,
        multiple: !!data.multiple,
        question: data.question,
        createdAt: Date.now()
    });
    return id;
}

/**
 * Ambil poll session by id. Auto-expire kalau sudah lewat TTL.
 * @returns {Object|null}
 */
function getPollSession(id) {
    const s = pollSessions.get(id);
    if (!s) return null;
    if (Date.now() - s.createdAt > POLL_SESSION_TTL_MS) {
        pollSessions.delete(id);
        return null;
    }
    return s;
}

/**
 * Hapus poll session setelah modal di-submit (sukses atau gagal).
 */
function deletePollSession(id) {
    return pollSessions.delete(id);
}

function create(data) {
    const list = load();
    const poll = {
        // v3.9.26: caller boleh supply id sendiri (interactions/poll.js membangun
        // tombol dengan id SEBELUM persist — render-first supaya entry tidak
        // jadi zombie kalau embed build throw). Tanpa id, generate seperti biasa.
        id: data.id || genId(),
        guildId: data.guildId,
        channelId: data.channelId,
        messageId: null,
        question: data.question,
        options: data.options.map((opt, i) => ({
            label: opt.label,
            emoji: opt.emoji || `${i + 1}️⃣`,
            votes: []
        })),
        multiple: data.multiple || false,
        closed: false,
        createdAt: Date.now(),
        closedAt: null,
        creatorId: data.creatorId,
        creatorTag: data.creatorTag
    };
    list.push(poll);
    save(list);
    return poll;
}

function setMessageId(id, messageId) {
    const list = load();
    const poll = list.find(p => p.id === id);
    if (poll) {
        poll.messageId = messageId;
        save(list);
    }
    return poll;
}

function get(id) {
    return load().find(p => p.id === id);
}

function getByMessage(messageId) {
    return load().find(p => p.messageId === messageId);
}

function getByGuild(guildId) {
    return load().filter(p => p.guildId === guildId);
}

/**
 * Vote option (toggle). Kalau multiple=false, otomatis unvote option lain dulu.
 * Kalau user sudah vote option yang sama, unvote (toggle) — BERLAKU untuk
 * single maupun multi mode.
 *
 * Return shape konsisten: selalu return poll object (atau null kalau poll gak ada).
 * Caller bisa cek result.closed untuk lihat status poll.
 *
 * @returns {Object|null} poll object (cek .closed untuk lihat status), atau null kalau poll tidak ada
 */
function vote(id, userId, optionIndex) {
    const list = load();
    const poll = list.find(p => p.id === id);
    if (!poll) return null;
    if (poll.closed) return poll; // kembalikan poll object utuh, bukan { closed: true }
    // Number.isInteger check — NaN gak boleh lolos (dulu lolos soalnya (NaN<0)=false, (NaN>=length)=false).
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) return null;

    const option = poll.options[optionIndex];
    const alreadyVoted = option.votes.includes(userId);

    // v3.9.38 FIX: toggle beneran — klik opsi yang sudah di-vote = UNVOTE,
    // baik single maupun multi. Sebelumnya: strip hanya jalan saat !multiple
    // dan push hanya jalan saat !alreadyVoted → untuk multiple=true +
    // alreadyVoted, TIDAK ADA yang terjadi (silent no-op) padahal embed/UI
    // menjanjikan "Klik tombol di bawah untuk vote (toggle)".
    if (!poll.multiple) {
        // Hapus vote user dari semua option dulu
        for (const opt of poll.options) {
            opt.votes = opt.votes.filter(u => u !== userId);
        }
    }
    if (alreadyVoted) {
        // unvote (di single-mode, strip di atas sudah menghapus vote ini →
        // filter jadi no-op yang aman; efek net = vote terhapus = toggle benar)
        option.votes = option.votes.filter(u => u !== userId);
    } else {
        option.votes.push(userId);
    }

    save(list);
    return poll;
}

function close(id) {
    const list = load();
    const poll = list.find(p => p.id === id);
    if (!poll) return null;
    poll.closed = true;
    poll.closedAt = Date.now();
    save(list);
    return poll;
}

function remove(id) {
    const list = load();
    const filtered = list.filter(p => p.id !== id);
    if (filtered.length !== list.length) {
        save(filtered);
        return true;
    }
    return false;
}

function getTotalVotes(poll) {
    if (!poll) return 0;
    if (poll.multiple) {
        return poll.options.reduce((sum, opt) => sum + opt.votes.length, 0);
    }
    // Untuk non-multiple, total voter = unique voters
    const unique = new Set();
    for (const opt of poll.options) {
        for (const u of opt.votes) unique.add(u);
    }
    return unique.size;
}

/**
 * v3.9.26 (GC): hapus poll yang sudah closed lebih dari `olderThanMs` lalu.
 * Poll closed tidak pernah dihapus sebelumnya → polls.json tumbuh tanpa batas.
 * Dipanggil scheduler harian. Return jumlah entry yang dihapus.
 */
function pruneClosedOlderThan(olderThanMs) {
    const list = load();
    const cutoff = Date.now() - olderThanMs;
    const keep = list.filter(p => {
        if (!p) return false;
        if (!p.closed) return true; // aktif tidak di-touch
        const closedAt = p.closedAt || p.createdAt || 0;
        return closedAt > cutoff;
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
    vote,
    close,
    remove,
    getTotalVotes,
    // v3.9.1: poll session (in-memory, for modal customId safety)
    createPollSession,
    getPollSession,
    deletePollSession,
    // v3.9.26
    pruneClosedOlderThan
};
