/**
 * colors.js — Shared color parsing utility (v3.9.17).
 *
 * WHY THIS EXISTS
 * ---------------
 * Before v3.9.17, there were 2 `parseColor` functions with the same name but different behavior:
 *   - src/ui/embedBuilderSessions.js:106 — returns `null` for invalid input
 *   - src/commands/panels.js:47 — THROWS for invalid input
 *
 * Each caller already handled this correctly (null check vs try/catch), but if
 * a new dev imported parseColor from the wrong place, it could cause bugs.
 * Now: a single function here that returns `null` for invalid input (functional
 * style, no throwing). Callers that need a clear error message can use
 * `parseColorOrError`.
 *
 * Contract:
 *   - parseColor(input) → number | null
 *   - parseColorOrError(input) → { ok: true, color: number } | { ok: false, error: string }
 */

/**
 * Parse a hex color string into a number.
 * Accepts: "#FF0000", "FF0000", "0xFF0000", "#f00" (3-digit expanded), decimal number
 * Returns: the number, or null if invalid.
 *
 * @param {string|number|null|undefined} input
 * @returns {number|null}
 */
function parseColor(input) {
    if (input === null || input === undefined || input === '') return null;
    if (typeof input === 'number') {
        return Number.isFinite(input) ? input : null;
    }
    if (typeof input !== 'string') return null;
    let hex = input.trim().replace(/^#/, '').replace(/^0x/i, '');
    if (hex.length === 3) {
        // Expand 3-digit: "f00" → "ff0000"
        hex = hex
            .split('')
            .map(c => c + c)
            .join('');
    }
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return parseInt(hex, 16);
}

/**
 * Parse a color and return a result object with a clear error message.
 * Used by callers that need a user-friendly error message.
 *
 * @param {string|number|null|undefined} input
 * @returns {{ok: true, color: number} | {ok: false, error: string}}
 */
function parseColorOrError(input) {
    if (input === null || input === undefined || input === '') {
        return { ok: true, color: null };
    }
    if (typeof input === 'number') {
        if (Number.isFinite(input)) return { ok: true, color: input };
        return { ok: false, error: `Invalid color format: ${typeof input}` };
    }
    if (typeof input !== 'string') {
        return { ok: false, error: `Unrecognized color format: ${typeof input}` };
    }
    const trimmed = input.trim().replace(/^#/, '').replace(/^0x/i, '');
    // 3-digit (#fff) or 6-digit (#ffffff) hex
    if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
        const r = trimmed[0] + trimmed[0];
        const g = trimmed[1] + trimmed[1];
        const b = trimmed[2] + trimmed[2];
        return { ok: true, color: parseInt(r + g + b, 16) };
    }
    if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
        return { ok: true, color: parseInt(trimmed, 16) };
    }
    return { ok: false, error: `Invalid color format: "${input}". Use hex (#ff5733 or #fff).` };
}

module.exports = { parseColor, parseColorOrError };
