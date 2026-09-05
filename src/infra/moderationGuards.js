/**
 * Moderation Guards — pure rules & helpers for the v3.9.43 moderation pack.
 *
 * Pure functions (no I/O) so they can be fully unit-tested:
 *   - validateModerationTarget : role hierarchy + self/bot target bans
 *   - validateTimeoutDuration  : Discord timeout limit (1 minute to 28 days)
 *   - validatePurgeAmount      : bulk delete per call limit (1–100)
 *   - filterBulkDeletable      : messages older than 14 days cannot be bulk-deleted (API limit)
 *   - formatDurationMinutes    : 90 → "1 hour 30 minutes" (for replies & DMs)
 *
 * Why a separate file from src/commands/moderation.js:
 *   1. Domain handlers receive `interaction` (hard to mock) — pure guards
 *      can be tested directly without Discord.
 *   2. The same guard is used by several commands (timeout/kick/ban) —
 *      single source of truth, no copy-pasted rules that can drift.
 *
 * Hierarchy contract (Discord):
 *   - The moderator's HIGHEST role must be STRICTLY higher than the target's.
 *     (`>=` is rejected — same level is rejected, consistent with /warn v3.9.8)
 *   - The bot must also be higher than the target, otherwise the API throws
 *     "Missing Permissions" — we reject early with a clear message instead.
 */

// === Discord hard limits (API) ===
const TIMEOUT_MAX_MINUTES = 28 * 24 * 60; // 28 days = 40,320 minutes (API timeout limit)
const TIMEOUT_MIN_MINUTES = 1;
const PURGE_MIN = 1;
const PURGE_MAX = 100; // bulk delete per call limit
// Bulk delete API only works for messages younger than 14 days (no premium perk).
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const BAN_DELETE_DAYS_MAX = 7; // deleteMessageSeconds limit: 7 days
const USER_ID_PATTERN = /^\d{17,20}$/; // Discord snowflake

/**
 * Validate a moderation target (timeout/kick/ban/untimeout).
 * @param {Object} p
 * @param {import('discord.js').GuildMember} p.moderatorMember member running the command
 * @param {import('discord.js').GuildMember} p.targetMember member being actioned
 * @param {import('discord.js').GuildMember|null} p.botMember bot member (guild.members.me)
 * @param {boolean} [p.rejectBots=true] reject bot targets (consistent with /warn)
 * @returns {{ok: boolean, error?: string}} error = stable code for message mapping
 */
function validateModerationTarget({ moderatorMember, targetMember, botMember, rejectBots = true }) {
    if (!targetMember) return { ok: false, error: 'not-in-guild' };
    if (moderatorMember.id === targetMember.id) return { ok: false, error: 'self' };
    if (botMember && targetMember.id === botMember.id) return { ok: false, error: 'bot-self' };
    if (rejectBots && targetMember.user?.bot) return { ok: false, error: 'target-bot' };

    // Moderator vs target hierarchy — must be STRICTLY higher (same level = reject).
    const modTop = moderatorMember.roles?.highest?.position ?? 0;
    const tgtTop = targetMember.roles?.highest?.position ?? 0;
    if (tgtTop >= modTop) return { ok: false, error: 'hierarchy' };

    // Bot vs target hierarchy — if the bot is lower, the API will throw.
    if (botMember) {
        const botTop = botMember.roles?.highest?.position ?? 0;
        if (tgtTop >= botTop) return { ok: false, error: 'bot-hierarchy' };
    }

    return { ok: true };
}

/**
 * Validate timeout duration (minutes).
 * The type must be a real number — slash command INTEGER options are always
 * numbers; a string input means a caller bug (Number() coercion only hides it).
 * @returns {{ok: boolean, error?: string, ms?: number}}
 */
function validateTimeoutDuration(minutes) {
    if (typeof minutes !== 'number' || !Number.isInteger(minutes)) return { ok: false, error: 'not-integer' };
    if (minutes < TIMEOUT_MIN_MINUTES) return { ok: false, error: 'too-short' };
    if (minutes > TIMEOUT_MAX_MINUTES) return { ok: false, error: 'too-long' };
    return { ok: true, ms: minutes * 60 * 1000 };
}

/**
 * Validate purge amount.
 * @returns {{ok: boolean, error?: string}}
 */
function validatePurgeAmount(amount) {
    if (typeof amount !== 'number' || !Number.isInteger(amount)) return { ok: false, error: 'not-integer' };
    if (amount < PURGE_MIN) return { ok: false, error: 'too-small' };
    if (amount > PURGE_MAX) return { ok: false, error: 'too-large' };
    return { ok: true };
}

/**
 * Filter messages that may be bulk-deleted (age ≤ 14 days).
 * Older messages must be deleted one by one via m.delete() — the bulk API refuses.
 * @param {Array<import('discord.js').Message>} messages
 * @param {number} [now=Date.now()]
 * @returns {Array<import('discord.js').Message>}
 */
function filterBulkDeletable(messages, now = Date.now()) {
    if (!Array.isArray(messages)) return [];
    return messages.filter(m => {
        const ts = m.createdTimestamp;
        // Partial/unknown timestamp → treat as non-bulk-deletable (fail-safe).
        if (typeof ts !== 'number' || Number.isNaN(ts)) return false;
        return now - ts <= BULK_DELETE_MAX_AGE_MS;
    });
}

/**
 * Format minutes → human text (English).
 * 90 → "1 hour 30 minutes" · 2880 → "2 days" · 45 → "45 minutes"
 */
function formatDurationMinutes(totalMinutes) {
    const n = Math.max(0, Math.floor(Number(totalMinutes) || 0));
    const days = Math.floor(n / 1440);
    const hours = Math.floor((n % 1440) / 60);
    const minutes = n % 60;
    const parts = [];
    if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
    if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
    return parts.join(' ');
}

/**
 * Validate user ID format (snowflake) — for /unban (user is not in the guild).
 */
function isValidUserId(id) {
    return typeof id === 'string' && USER_ID_PATTERN.test(id.trim());
}

module.exports = {
    TIMEOUT_MAX_MINUTES,
    TIMEOUT_MIN_MINUTES,
    PURGE_MIN,
    PURGE_MAX,
    BULK_DELETE_MAX_AGE_MS,
    BAN_DELETE_DAYS_MAX,
    validateModerationTarget,
    validateTimeoutDuration,
    validatePurgeAmount,
    filterBulkDeletable,
    formatDurationMinutes,
    isValidUserId
};
