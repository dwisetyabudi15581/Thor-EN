/**
 * Anti-Spam & Auto-Mod Manager.
 *
 * File: data/automod.json
 * {
 *   "<guildId>": {
 *     "spamThreshold": 5,           // number of messages in the window that counts as spam
 *     "spamWindowMs": 10000,        // 10-second window
 *     "spamAction": "mute_10m",     // "warn" | "mute_10m" | "mute_1h" | "kick" | "delete_only"
 *     "blockLinks": false,          // delete messages that contain a URL
 *     "linkAllowedChannels": [],    // channel IDs where links are allowed
 *     "linkAllowedRoles": [],       // role IDs allowed to post links
 *     "blockWords": [],             // LEGACY (v3.9.22) — auto-migrated to wordRules at load
 *     "wordRules": [               // v3.9.23: blocked words + action per word
 *       { "word": "word", "action": "mute_10m"|null, "addedBy": "userId", "addedAt": 123 }
 *     ],
 *     "exemptWords": [],            // v3.9.23: exempt words (anti false-positive)
 *     "wordMatchMode": "whole_word", // v3.9.23: "whole_word" | "substring"
 *     "wordAction": "delete_only", // fallback action for words without a specific action
 *     "maxMentions": 5,             // max mentions per message
 *     "mentionAction": "warn",      // "delete_only" | "warn" | "mute_10m"
 *     "enabled": true,
 *     "createdAt": ...,
 *     "updatedAt": ...
 *   }
 * }
 *
 * v3.9.23 WORD FLEX:
 *   - /add-word → add words ONE BY ONE (append, doesn't replace the old list)
 *   - /remove-word → remove a specific word
 *   - /list-words → view all words + their actions
 *   - Whole-word matching (default): "asu" does NOT match inside "asus" (anti false-positive)
 *   - Exempt words: safe words that cancel a blocklist word match
 *     (e.g. block "asu" + exempt "asus" → a message containing "asus" is not flagged)
 *   - Action per word: mild words just get deleted, severe words get an immediate mute/kick
 *
 * In-memory spam tracker: Map<userId, number[]> (timestamps of recent messages)
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');
// v3.9.40: hoist the discord.js require to the top — PermissionFlagsBits was
// previously required INSIDE isUserWhitelisted()/isLinkAllowed(), which run per
// message (hot path). The module cache keeps it cheap, but hoisting is cleaner
// and avoids repeated lookups on every message.
const { PermissionFlagsBits } = require('discord.js');

const filePath = path.join(__dirname, '..', '..', 'data', 'automod.json');

// v3.9.23: valid actions for per-word rules (same as those used by the spam/word hook).
const WORD_ACTIONS = ['delete_only', 'warn', 'mute_10m', 'mute_1h', 'kick'];

// In-memory spam tracker: { guildId: { userId: [ts1, ts2, ...] } }
const spamTracker = new Map();

// v3.9.26: read-through cache (panelManager pattern). getGuildConfig is read
// in messageCreate PER MESSAGE — before, that was 1 sync readFileSync per message
// even when automod was off. 15s TTL cache + update-on-save; manual invalidation
// via invalidateCache() (backup restore / test cleanup).
// Note: getGuildConfig mutates the loaded object (normalizeWordConfig lazy
// migration) — since the cache returns the same object reference, that
// normalization is idempotent & deterministic; there is no risk of disk divergence.
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
        // v3.9.26: quarantine the corrupt file BEFORE falling back (see safeWrite.js).
        quarantineCorruptFile(filePath);
        _cache = { data: {}, at: Date.now() };
        return _cache.data;
    }
}

function save(data) {
    safeWriteJSON(filePath, data);
    // v3.9.26: update the cache so the next read is consistent with what was just written
    _cache = { data, at: Date.now() };
}

/** v3.9.26: force a fresh read next time (backup restore / test). */
function invalidateCache() {
    _cache = null;
}

function getGuildConfig(guildId) {
    const all = load();
    const cfg = all[guildId];
    if (!cfg) return null;
    // Backward compat: old configs may have the value 'delete' (not 'delete_only').
    // Now everything uses 'delete_only' for consistency.
    if (cfg.wordAction === 'delete') cfg.wordAction = 'delete_only';
    if (cfg.mentionAction === 'delete') cfg.mentionAction = 'delete_only';
    // v3.9.23: normalize word config (migrate legacy blockWords → wordRules, etc).
    normalizeWordConfig(cfg);
    return cfg;
}

/**
 * v3.9.23: Normalize word config into the new structure.
 * Idempotent — safe to call repeatedly:
 *   1. Ensure wordRules/exemptWords/wordMatchMode exist (defaults).
 *   2. Migrate legacy flat blockWords (string array) → wordRules (object array).
 *      Old entries become rules without an action (fall back to the global wordAction).
 *      blockWords is emptied after the move so nothing is double-counted.
 *      Persisting to disk happens on the next save() (lazy migration).
 */
function normalizeWordConfig(cfg) {
    if (!cfg) return;
    if (!Array.isArray(cfg.wordRules)) cfg.wordRules = [];
    if (!Array.isArray(cfg.exemptWords)) cfg.exemptWords = [];
    if (cfg.wordMatchMode !== 'whole_word' && cfg.wordMatchMode !== 'substring') {
        cfg.wordMatchMode = 'whole_word';
    }
    // Migrate legacy blockWords → wordRules (once; dedupe by word).
    if (Array.isArray(cfg.blockWords) && cfg.blockWords.length > 0) {
        for (const w of cfg.blockWords) {
            if (!w) continue;
            const word = String(w).trim().toLowerCase();
            if (!word) continue;
            if (!cfg.wordRules.some(r => r && r.word === word)) {
                cfg.wordRules.push({ word, action: null, addedBy: 'migrated', addedAt: Date.now() });
            }
        }
        cfg.blockWords = [];
    }
}

function getDefaultConfig() {
    return {
        spamThreshold: 5,
        spamWindowMs: 10000,
        spamAction: 'mute_10m',
        blockLinks: false,
        linkAllowedChannels: [],
        linkAllowedRoles: [],
        blockWords: [], // LEGACY — emptied by normalization after migration
        wordRules: [],
        exemptWords: [],
        wordMatchMode: 'whole_word',
        wordAction: 'delete_only',
        maxMentions: 5,
        mentionAction: 'warn',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
}

function setGuildConfig(guildId, updates) {
    const all = load();
    const current = all[guildId] || getDefaultConfig();
    normalizeWordConfig(current); // migrate legacy before merging
    all[guildId] = {
        ...current,
        ...updates,
        updatedAt: Date.now()
    };
    normalizeWordConfig(all[guildId]); // re-normalize the merge result (e.g. updates still using old fields)
    save(all);
    return all[guildId];
}

function enableAutoMod(guildId, enabled) {
    return setGuildConfig(guildId, { enabled: !!enabled });
}

/**
 * Check whether a user is spamming (too many messages within the window).
 * Updates the internal tracker. Returns true if considered spam.
 */
function checkSpam(guildId, userId, config) {
    if (!config || !config.enabled || !config.spamThreshold) return false;

    if (!spamTracker.has(guildId)) spamTracker.set(guildId, new Map());
    const guildMap = spamTracker.get(guildId);
    const now = Date.now();
    const window = config.spamWindowMs || 10000;
    const threshold = config.spamThreshold || 5;

    if (!guildMap.has(userId)) guildMap.set(userId, []);
    let timestamps = guildMap.get(userId);

    // Drop timestamps outside the window
    timestamps = timestamps.filter(ts => now - ts < window);
    timestamps.push(now);
    guildMap.set(userId, timestamps);

    return timestamps.length > threshold;
}

/**
 * Reset the spam tracker for a user (called after a mute/warn).
 */
function resetSpamTracker(guildId, userId) {
    if (spamTracker.has(guildId)) {
        spamTracker.get(guildId).delete(userId);
    }
}

/**
 * Periodic cleanup — remove old entries from the spam tracker so memory doesn't leak.
 * Uses 5 minutes to stay safe for servers that set spamWindowMs > 60s.
 */
function cleanupSpamTracker() {
    const now = Date.now();
    const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes — enough for the majority of spamWindowMs configs
    for (const [guildId, guildMap] of spamTracker) {
        for (const [userId, timestamps] of guildMap) {
            const filtered = timestamps.filter(ts => now - ts < MAX_AGE_MS);
            if (filtered.length === 0) {
                guildMap.delete(userId);
            } else {
                guildMap.set(userId, filtered);
            }
        }
        if (guildMap.size === 0) spamTracker.delete(guildId);
    }
}

// Run cleanup every 1 minute
setInterval(cleanupSpamTracker, 60 * 1000).unref?.();

// v3.9.38 FIX: match plain domains (discord.gg/xxx, t.me/x, example.com) —
// the most common invite/scam format previously slipped through because it lacks a scheme/www.
const LINK_RE = /(https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|net|org|gg|io|me|id|co|xyz|info|link|tv|to|shop|store|app|dev|online|site|space|live|life|biz|pro|wiki|edu|gov|ai|in|us|uk|de|fr|ru|jp|cn|kr|au|nz|ca|br|mx|es|it|nl|se|no|fi|dk|pl|pt|ch|at|cz|hu|ro|gr|tr|il|sa|ae|eg|za|ng|ke|th|vn|ph|my|sg|hk|tw)\b)/i;

/**
 * Check whether a message contains a link.
 * Pattern: http://, https://, www., or a plain domain with a common TLD
 * (discord.gg/xxx, t.me/x, example.com — without scheme/www).
 * The TLD list is curated so ordinary Indonesian chat ("3.5rb", "gitu deh",
 * "b aja") doesn't false-positive — it must look like `label.TLD` + word boundary.
 */
function containsLink(content) {
    if (!content) return false;
    return LINK_RE.test(content);
}

/**
 * Check whether a message contains a blocked word.
 *
 * LEGACY (v3.9.22): substring matching with a flat string array.
 * Kept for backward compat (used by old unit tests).
 * The production hook (messageCreate) now uses `findViolatedWord` —
 * which supports whole-word, the exempt list, and per-word actions.
 */
function containsBlockedWord(content, blockWords) {
    if (!content || !blockWords || blockWords.length === 0) return null;
    const lower = content.toLowerCase();
    for (const word of blockWords) {
        if (word && lower.includes(word.toLowerCase())) {
            return word;
        }
    }
    return null;
}

// ============================================================
// v3.9.23: WORD FLEX — matching, CRUD, exempt, per-word action
// ============================================================

/**
 * Escape special regex characters so a user word is safe to use in a RegExp.
 */
function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * v3.9.23: Check a word match with the mode.
 *   - 'whole_word' (default): the word must stand alone (separated by spaces/punctuation/
 *     string boundaries). "asu" does NOT match inside "asus" — anti false-positive.
 *   - 'substring': match anywhere (old v3.9.22 behavior).
 *
 * Unicode-aware boundary (v3.9.38): `[^\p{L}\p{N}_]` + the `u` flag. Before,
 * the `[a-z0-9_]` class treated non-Latin letters (Cyrillic/CJK) as boundaries
 * — so whole_word STILL matched substrings (e.g. "кот" matched inside "коты").
 */
function matchWord(content, word, mode) {
    if (!content || !word) return false;
    const lower = String(content).toLowerCase();
    const w = String(word).trim().toLowerCase();
    if (!w) return false;
    if (mode === 'substring') return lower.includes(w);
    // v3.9.38 FIX: unicode-aware boundary — before, non-Latin letters were treated
    // as boundaries, so whole_word still matched substrings (e.g. "кот" matched "коты").
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(w)}([^\\p{L}\\p{N}_]|$)`, 'u');
    return re.test(lower);
}

/**
 * v3.9.38 FIX: mask (replace with same-length spaces) every occurrence of exempt
 * words in the content BEFORE blocked-word detection. The regex is built with the
 * same boundary semantics as matchWord (whole_word: unicode-aware non-consuming
 * lookaround so adjacent occurrences get masked too; substring: plain
 * contains). Same-length spaces keep the positions of other words from shifting.
 *
 * @param {string} content - message text (any case)
 * @param {string[]} exemptWords - exempt word list (already lowercase)
 * @param {'whole_word'|'substring'} mode - match mode (same as wordMatchMode)
 * @returns {string} content with exempt words neutralized
 */
function maskExemptWords(content, exemptWords, mode) {
    if (!content || !exemptWords || exemptWords.length === 0) return content;
    let masked = String(content);
    for (const ex of exemptWords) {
        if (!ex) continue;
        const w = String(ex).trim().toLowerCase();
        if (!w) continue;
        const re = mode === 'substring'
            ? new RegExp(escapeRegExp(w), 'gi')
            : new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(w)}(?![\\p{L}\\p{N}_])`, 'giu');
        masked = masked.replace(re, m => ' '.repeat(m.length));
    }
    return masked;
}

/**
 * v3.9.23: Find the blocked word violated in the content.
 *
 * Returns { word, action } | null:
 *   - word  = the word that matched
 *   - action = the per-word action (may be null → the caller falls back to config.wordAction)
 *
 * Exempt logic (v3.9.38 FIX): exempt words are MASKED from the content first
 * (maskExemptWords), then blocked words are detected in the remaining text.
 * Before, it used the short-circuit "content contains an exempt word that
 * covers the blocklist word → skip ALL violations" — so the message "asus asu
 * banget" (block "asu" + exempt "asus") passed entirely even though "asu"
 * stood alone. Now only the exempt part is neutralized: "asus baru" is not
 * flagged, "asus asu banget" still is.
 */
function findViolatedWord(content, config) {
    if (!content || !config) return null;
    const rules = Array.isArray(config.wordRules) ? config.wordRules : [];
    if (rules.length === 0) return null;
    const mode = config.wordMatchMode === 'substring' ? 'substring' : 'whole_word';

    const exempt = Array.isArray(config.exemptWords)
        ? config.exemptWords.map(w => String(w).trim().toLowerCase()).filter(Boolean)
        : [];

    // v3.9.38 FIX: mask exempt words first — an exempt occurrence anywhere no
    // longer covers up blocked-word violations standing alone in other parts.
    const masked = maskExemptWords(content, exempt, mode);

    for (const rule of rules) {
        if (!rule || !rule.word) continue;
        if (!matchWord(masked, rule.word, mode)) continue;
        return { word: rule.word, action: rule.action || null };
    }
    return null;
}

/**
 * Parse input "word1, word2, word3" → a clean word array (lowercase, deduped).
 */
function parseWordList(words) {
    const list = Array.isArray(words) ? words : String(words).split(',');
    const seen = new Set();
    const result = [];
    for (const raw of list) {
        const word = String(raw).trim().toLowerCase();
        if (!word || seen.has(word)) continue;
        seen.add(word);
        result.push(word);
    }
    return result;
}

/**
 * v3.9.23: Add words to the blocklist (APPEND — doesn't replace the old list).
 *
 * @param {string} guildId
 * @param {string|string[]} words - "word1,word2" or an array
 * @param {string|null} action - per-word action (null = fall back to the global wordAction)
 * @param {string|null} addedBy - the userId who added them (for audit)
 * @returns {{ added: string[], skipped: string[], error?: string }}
 */
function addWords(guildId, words, action, addedBy) {
    if (action && !WORD_ACTIONS.includes(action)) {
        return { added: [], skipped: [], error: `invalid action: ${action}` };
    }
    const all = load();
    const current = all[guildId] || getDefaultConfig();
    normalizeWordConfig(current);

    const added = [];
    const skipped = [];
    for (const word of parseWordList(words)) {
        if (current.wordRules.some(r => r.word === word)) {
            skipped.push(word); // already exists — don't duplicate
            continue;
        }
        current.wordRules.push({
            word,
            action: action || null,
            addedBy: addedBy || null,
            addedAt: Date.now()
        });
        added.push(word);
    }
    all[guildId] = { ...current, updatedAt: Date.now() };
    save(all);
    return { added, skipped };
}

/**
 * v3.9.23: Remove ONE word from the blocklist.
 * @returns {{ ok: boolean, removed: string|null, error?: string }}
 */
function removeWord(guildId, word) {
    const target = String(word || '')
        .trim()
        .toLowerCase();
    if (!target) return { ok: false, removed: null, error: 'word is empty' };
    const all = load();
    const current = all[guildId] || getDefaultConfig();
    normalizeWordConfig(current);
    const before = current.wordRules.length;
    current.wordRules = current.wordRules.filter(r => r.word !== target);
    const removed = current.wordRules.length < before ? target : null;
    all[guildId] = { ...current, updatedAt: Date.now() };
    save(all);
    return { ok: removed !== null, removed };
}

/**
 * v3.9.23: Add words to the exempt list (APPEND).
 * The same word must not be double-registered in the blocklist and exempt list at once.
 * @returns {{ added: string[], skipped: string[], error?: string }}
 */
function addExemptWords(guildId, words) {
    const all = load();
    const current = all[guildId] || getDefaultConfig();
    normalizeWordConfig(current);

    const added = [];
    const skipped = [];
    for (const word of parseWordList(words)) {
        if (current.exemptWords.includes(word)) {
            skipped.push(word);
            continue;
        }
        current.exemptWords.push(word);
        added.push(word);
    }
    all[guildId] = { ...current, updatedAt: Date.now() };
    save(all);
    return { added, skipped };
}

/**
 * v3.9.23: Remove ONE word from the exempt list.
 * @returns {{ ok: boolean, removed: string|null, error?: string }}
 */
function removeExemptWord(guildId, word) {
    const target = String(word || '')
        .trim()
        .toLowerCase();
    if (!target) return { ok: false, removed: null, error: 'word is empty' };
    const all = load();
    const current = all[guildId] || getDefaultConfig();
    normalizeWordConfig(current);
    const before = current.exemptWords.length;
    current.exemptWords = current.exemptWords.filter(w => w !== target);
    const removed = current.exemptWords.length < before ? target : null;
    all[guildId] = { ...current, updatedAt: Date.now() };
    save(all);
    return { ok: removed !== null, removed };
}

/**
 * Count the number of mentions in a message.
 */
function countMentions(message) {
    if (!message) return 0;
    let count = 0;
    if (message.mentions?.users) count += message.mentions.users.size;
    if (message.mentions?.roles) count += message.mentions.roles.size;
    if (message.mentions?.everyone) count += 1;
    return count;
}

/**
 * Check whether a user is exempt from ALL auto-mod checks (spam, blocked words,
 * mass-mention, including links).
 *
 * v3.9.38 FIX: before, this function also returned true for roles in
 * `config.linkAllowedRoles` — the effect was hookAutoMod returning early, and that
 * member bypassed ALL checks. But that field (set via /add-link-whitelist)
 * was only ever meant to exempt LINKS. Now this function is ONLY for admins
 * (Administrator/ManageGuild); link whitelist roles are checked separately via
 * isLinkAllowed(). The `whitelistRoles`/`whitelistedRoles` fields (global role
 * whitelist) don't exist in the config schema yet — read defensively in case
 * they're added later, but NEVER linked to linkAllowedRoles.
 */
function isUserWhitelisted(member, config) {
    if (!member) return false;
    // Admins (Administrator/ManageGuild) are always whitelisted from all checks
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    // GLOBAL (non-link) role whitelist — the field doesn't exist in the config schema yet.
    const globalWhitelist = config?.whitelistRoles || config?.whitelistedRoles;
    if (Array.isArray(globalWhitelist) && globalWhitelist.length > 0) {
        for (const rid of globalWhitelist) {
            if (member.roles?.cache?.has(rid)) return true;
        }
    }
    return false;
}

/**
 * v3.9.38 FIX: check whether a member may post LINKS — roles in
 * `config.linkAllowedRoles` (set via /add-link-whitelist role:...).
 * IMPORTANT: this does NOT exempt spam/blocked words/mass-mentions — a member
 * with this role still hits all other checks. Want a total bypass? Grant the
 * Administrator/ManageGuild permission (see isUserWhitelisted).
 * Channel whitelist (`linkAllowedChannels`) is NOT checked here — it needs the
 * channel id, not the member, so the caller (hookAutoMod) still checks it inline.
 */
function isLinkAllowed(member, config) {
    if (!member || !config) return false;
    // Admins may always post links — consistent with the global guard (admins are
    // returned early by hookAutoMod, so this check is purely belt-and-suspenders).
    if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
    if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    // Link whitelist roles
    if (config.linkAllowedRoles && config.linkAllowedRoles.length > 0) {
        for (const rid of config.linkAllowedRoles) {
            if (member.roles?.cache?.has(rid)) return true;
        }
    }
    return false;
}

module.exports = {
    getGuildConfig,
    setGuildConfig,
    enableAutoMod,
    getDefaultConfig,
    checkSpam,
    resetSpamTracker,
    containsLink,
    containsBlockedWord,
    countMentions,
    isUserWhitelisted,
    // v3.9.38 FIX: link-specific exempt (split from isUserWhitelisted)
    isLinkAllowed,
    // v3.9.23: word flex
    WORD_ACTIONS,
    matchWord,
    findViolatedWord,
    maskExemptWords,
    addWords,
    removeWord,
    addExemptWords,
    removeExemptWord,
    // v3.9.26
    invalidateCache
};
