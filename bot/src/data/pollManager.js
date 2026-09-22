/**
 * Poll Manager — store polls with vote tracking.
 *
 * File: polls.json
 * [
 *   {
 *     id: "poll_<timestamp>_<rand>",
 *     guildId, channelId, messageId,
 *     question: "Event this weekend?",
 *     options: [
 *       { label: "Rank Push", emoji: "🎮", votes: ["userId1", "userId2"] },
 *       { label: "Custom Room", emoji: "🏠", votes: ["userId3"] }
 *     ],
 *     multiple: false,      // true = multiple choices allowed
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
        console.warn('⚠️ polls.json is corrupt:', err.message);
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
    return `poll_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// === v3.9.1: In-memory poll session store ===
// Used to pass data from the /poll create command → the modal submit handler.
// Previously, data (channelId, multiple, question) was encoded into the modal
// customId, which could overflow Discord's 100-char customId limit for long
// questions (especially after encodeURIComponent — spaces became %20, etc.).
// Now: data is stored in a Map, the customId only holds a short session id.
const POLL_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes (the modal must be submitted quickly)
const pollSessions = new Map();

// Clean up expired sessions every 5 minutes so memory doesn't leak.
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
        console.log(`🧹 Poll sessions: ${cleaned} expired removed.`);
    }
}, POLL_SESSION_TTL_MS).unref?.();

function genSessionId() {
    return `ps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a new poll session (called by /poll create when showing the modal).
 * @param {Object} data - { userId, channelId, multiple, question }
 * @returns {string} sessionId (short, safe to use in a Discord customId)
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
 * Get a poll session by id. Auto-expires once past the TTL.
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
 * Delete a poll session after the modal is submitted (success or failure).
 */
function deletePollSession(id) {
    return pollSessions.delete(id);
}

function create(data) {
    const list = load();
    const poll = {
        // v3.9.26: the caller may supply its own id (interactions/poll.js builds
        // the buttons with the id BEFORE persisting — render-first so the entry
        // doesn't become a zombie if embed building throws). Without an id,
        // generate as usual.
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
 * Vote for an option (toggle). If multiple=false, all other options are
 * automatically unvoted first. If the user already voted for the same option,
 * unvote (toggle) — applies to BOTH single and multi mode.
 *
 * Consistent return shape: always returns the poll object (or null if the poll
 * doesn't exist). Callers can check result.closed to see the poll status.
 *
 * @returns {Object|null} poll object (check .closed for status), or null if the poll doesn't exist
 */
function vote(id, userId, optionIndex) {
    const list = load();
    const poll = list.find(p => p.id === id);
    if (!poll) return null;
    if (poll.closed) return poll; // return the full poll object, not { closed: true }
    // Number.isInteger check — NaN must not slip through (it used to pass because (NaN<0)=false, (NaN>=length)=false).
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) return null;

    const option = poll.options[optionIndex];
    const alreadyVoted = option.votes.includes(userId);

    // v3.9.38 FIX: real toggle — clicking an already-voted option = UNVOTE,
    // in both single and multi mode. Previously: the strip only ran when
    // !multiple and the push only ran when !alreadyVoted → for multiple=true +
    // alreadyVoted, NOTHING happened (silent no-op) even though the embed/UI
    // promised "Click the buttons below to vote (toggle)".
    if (!poll.multiple) {
        // Remove the user's vote from every option first
        for (const opt of poll.options) {
            opt.votes = opt.votes.filter(u => u !== userId);
        }
    }
    if (alreadyVoted) {
        // unvote (in single-mode, the strip above already removed this vote →
        // the filter is a safe no-op; net effect = vote removed = correct toggle)
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
    // For non-multiple, total voters = unique voters
    const unique = new Set();
    for (const opt of poll.options) {
        for (const u of opt.votes) unique.add(u);
    }
    return unique.size;
}

/**
 * v3.9.26 (GC): delete polls that were closed more than `olderThanMs` ago.
 * Closed polls were never deleted before → polls.json grew without bound.
 * Called by the daily scheduler. Returns the number of entries removed.
 */
function pruneClosedOlderThan(olderThanMs) {
    const list = load();
    const cutoff = Date.now() - olderThanMs;
    const keep = list.filter(p => {
        if (!p) return false;
        if (!p.closed) return true; // active polls are never touched
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
