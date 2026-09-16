/**
 * Text helpers for user input from Discord (v3.9.24).
 *
 * PROBLEM: slash command input in Discord (PC) CANNOT use Enter — the Enter key
 * submits the form immediately, so users can't create multi-line text. On mobile,
 * finding the enter key on the Discord keyboard is also hard.
 *
 * SOLUTION: users type a literal `\n` escape (backslash + n) in the command input,
 * and this helper converts it into a REAL newline before the text is used / validated.
 * Supported escapes: `\n`, `\r\n`, `\r` (literal, not actual control characters).
 * Real newlines already present in the input are preserved.
 *
 * Applied to multi-line inputs where it matters:
 *   - /send-message message        (since v3.9.5 — now goes through this helper)
 *   - /announce description
 *   - /announce-schedule description
 *   - /setup-ticket-panel body
 *   - /add-responder reply
 *   - /set-message teks            (v3.9.25 — Body type only; *Title types are
 *                                   deliberately skipped because Discord embed titles reject newlines)
 *   - /afk reason                  (v3.9.25)
 *   - /warn reason                 (v3.9.25)
 *   - /setup-selfrole description  (v3.9.25)
 *   - /selfrole-add description    (v3.9.25)
 *
 * Note: modal TextInputStyle.Paragraph input does NOT use this helper — in modals,
 * Enter actually produces a real newline (it doesn't submit), so it isn't needed.
 *
 * Length note: the normalized result is ALWAYS <= the input length (each 2-character
 * escape is replaced by 1 newline character), so length validation after
 * normalization cannot overflow.
 */

const LITERAL_NEWLINE_RE = /\\r\\n|\\n|\\r/g;

/**
 * v3.9.26: Validate emoji input from users (slash command / config).
 *
 * PROBLEM: /set-verify-button, /add-category, /update-category accept arbitrary
 * strings as emoji. A long / non-emoji string stored in config →
 * ButtonBuilder.setEmoji() throws when the panel is rendered → /setup-verify and
 * all ticket panels break until an admin fixes it manually (poison persists).
 *
 * Discord accepts 2 forms of emoji:
 *   1. Unicode emoji (including ZWJ sequences & modifiers): "✅", "👍🏽", "👨‍👩‍👧"
 *   2. Custom emoji: "<:name:id>" or "name:id" (animated "a" prefix also ok)
 *
 * @param {string} input - emoji from interaction.options.getString(...)
 * @returns {boolean} true if the format is safe to pass to setEmoji()
 */
// Custom emoji: <:name:123> / <a:name:123> / :name:123 / a:name:123
const CUSTOM_EMOJI_RE = /^<?a?:[A-Za-z0-9_~]{1,32}:[0-9]{5,25}>?$/;
// Keycap sequences: "1️⃣" = digit/#/* + U+FE0F + U+20E3 (valid for setEmoji(),
// used as the default poll option emoji). Plain digits WITHOUT the combining
// keycap (e.g. "123") stay rejected.
const KEYCAP_RE = /^[0-9#*]\uFE0F?\u20E3$/;
// Unicode emoji: non-ASCII characters (match 1-12 code units — enough for ZWJ sequences)
function isUnicodeEmoji(s) {
    if (s.length === 0 || s.length > 12) return false;
    if (KEYCAP_RE.test(s)) return true; // v3.24.1: keycap sequences are valid emoji
    for (const ch of s) {
        if (ch.codePointAt(0) < 0x80) return false; // ASCII is not an emoji
    }
    return true;
}
function isValidEmoji(input) {
    if (typeof input !== 'string') return false;
    const s = input.trim();
    if (!s) return false;
    return CUSTOM_EMOJI_RE.test(s) || isUnicodeEmoji(s);
}

/**
 * Convert literal newline escape sequences (`\n`, `\r\n`, `\r`) into real newlines.
 * Non-string input is passed through as-is (defensive).
 * @param {string} input - text from interaction.options.getString(...)
 * @returns {string} text with real newlines
 */
function normalizeNewlines(input) {
    if (typeof input !== 'string') return input;
    return input.replace(LITERAL_NEWLINE_RE, '\n');
}

/**
 * v3.9.38 FIX: code-point-aware truncation — a plain slice() can cut an emoji
 * surrogate pair into broken characters (Discord can reject with 50035).
 *
 * Example: a text full of "👍" emoji (2 code units each) sliced at (0, 500) can
 * end mid surrogate pair → the last char becomes a lone surrogate
 * (0xD800-0xDFFF) → the embed/message gets rejected by the API or renders as a
 * replacement-box character.
 *
 * This helper truncates per CODE POINT (for..of string iteration), but the
 * maxLen limit is still counted in CODE UNITS (Discord limits 256/1024/4096 are
 * counted in code units). The total result length is ALWAYS <= maxLen + 1 (the
 * 1-code-unit ellipsis).
 *
 * @param {string} str - text to truncate
 * @param {number} maxLen - maximum content length in code units
 * @returns {string} truncated text (+ '…' if actually truncated)
 */
function truncateUtf8Safe(str, maxLen) {
    if (typeof str !== 'string' || str.length <= maxLen) return str ?? '';
    let out = '';
    // for..of iterates per code point — surrogate pairs are never split.
    for (const ch of str) {
        if (out.length + ch.length > maxLen) break;
        out += ch;
    }
    return out + '…';
}

/**
 * v3.24.1: Build a joined list capped to `maxLen` characters — renders entries
 * one by one and stops BEFORE the budget is exceeded, appending a "+N more"
 * suffix instead. Fixes the /list-products /list-responder /selfrole-list
 * class of crashes (unbounded embed descriptions > 4096 chars →
 * EmbedBuilder.setDescription throws → the command is dead until data is
 * removed manually).
 *
 * @param {Array} items
 * @param {(item: any, index: number) => string} renderEntry
 * @param {number} [maxLen=4000] — target budget (keep a margin under Discord's 4096)
 * @param {string} [separator='\n']
 * @param {(hidden: number) => string} [moreText]
 * @returns {string}
 */
function joinCappedLines(items, renderEntry, maxLen = 4000, separator = '\n', moreText) {
    if (!Array.isArray(items) || items.length === 0) return '';
    const suffixOf = moreText || ((hidden) => `… +${hidden} more`);
    const parts = [];
    let used = 0;
    for (let i = 0; i < items.length; i++) {
        const line = String(renderEntry(items[i], i) ?? '');
        const sepLen = i > 0 ? separator.length : 0;
        // Reserve room for a possible "+N more" suffix while entries remain.
        const reserve = 40;
        if (used + sepLen + line.length + reserve > maxLen) {
            const hidden = items.length - i;
            // First entry alone exceeds the budget → hard-truncate it (per code point).
            if (i === 0) {
                return truncateUtf8Safe(line, Math.max(50, maxLen - reserve)) + separator + suffixOf(hidden);
            }
            return parts.join(separator) + separator + suffixOf(hidden);
        }
        parts.push(line);
        used += sepLen + line.length;
    }
    return parts.join(separator);
}

module.exports = { normalizeNewlines, isValidEmoji, truncateUtf8Safe, joinCappedLines };
