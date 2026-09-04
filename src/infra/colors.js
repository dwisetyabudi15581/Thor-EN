/**
 * colors.js — Shared color parsing utility (v3.9.17).
 *
 * WHY THIS EXISTS
 * ---------------
 * Sebelum v3.9.17, ada 2 function `parseColor` dengan nama sama tapi behavior beda:
 *   - src/ui/embedBuilderSessions.js:106 — return `null` kalau invalid
 *   - src/commands/panels.js:47 — THROW kalau invalid
 *
 * Konsumen masing-masing sudah handle dengan benar (cek null vs try/catch), tapi
 * kalau ada dev baru yang pakai parseColor dari import yang salah, bisa bug.
 * Sekarang: satu function di sini, return `null` untuk invalid (functional style,
 * gak throw). Caller yang butuh pesan error jelas bisa pakai `parseColorOrError`.
 *
 * Contract:
 *   - parseColor(input) → number | null
 *   - parseColorOrError(input) → { ok: true, color: number } | { ok: false, error: string }
 */

/**
 * Parse hex color string ke number.
 * Accept: "#FF0000", "FF0000", "0xFF0000", "#f00" (3-digit expanded), decimal number
 * Returns: number atau null kalau invalid.
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
 * Parse color, return result object dengan error message jelas.
 * Dipakai caller yang butuh pesan error user-friendly.
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
        return { ok: false, error: `Format color tidak valid: ${typeof input}` };
    }
    if (typeof input !== 'string') {
        return { ok: false, error: `Format color tidak dikenali: ${typeof input}` };
    }
    const trimmed = input.trim().replace(/^#/, '').replace(/^0x/i, '');
    // Hex 3-digit (#fff) atau 6-digit (#ffffff)
    if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
        const r = trimmed[0] + trimmed[0];
        const g = trimmed[1] + trimmed[1];
        const b = trimmed[2] + trimmed[2];
        return { ok: true, color: parseInt(r + g + b, 16) };
    }
    if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
        return { ok: true, color: parseInt(trimmed, 16) };
    }
    return { ok: false, error: `Format color tidak valid: "${input}". Pakai hex (#ff5733 atau #fff).` };
}

module.exports = { parseColor, parseColorOrError };
