/**
 * Text helpers untuk input user dari Discord (v3.9.24).
 *
 * MASALAH: input slash command di Discord (PC) TIDAK BISA Enter — tombol Enter
 * langsung submit form, jadi user tidak bisa bikin teks multi-line. Di HP juga
 * susah cari tombol enter di keyboard Discord.
 *
 * SOLUSI: user nulis escape literal `\n` (backslash + n) di input command,
 * helper ini konversi jadi newline ASLI sebelum teks dipakai / di-validasi.
 * Escape yang didukung: `\n`, `\r\n`, `\r` (literal, bukan karakter asli).
 * Newline asli yang sudah ada di input tetap dipertahankan.
 *
 * Diterapkan ke input multi-line yang meaningful:
 *   - /send-message message        (sejak v3.9.5 — sekarang lewat helper ini)
 *   - /announce description
 *   - /announce-schedule description
 *   - /setup-ticket-panel body
 *   - /add-responder reply
 *   - /set-message teks            (v3.9.25 — hanya tipe Body; tipe *Title sengaja
 *                                   di-skip karena embed title Discord menolak newline)
 *   - /afk reason                  (v3.9.25)
 *   - /warn reason                 (v3.9.25)
 *   - /setup-selfrole description  (v3.9.25)
 *   - /selfrole-add description    (v3.9.25)
 *
 * Catatan: input modal TextInputStyle.Paragraph TIDAK pakai helper ini — di modal,
 * Enter memang menghasilkan newline asli (bukan submit), jadi tidak dibutuhkan.
 *
 * Catatan panjang: hasil normalisasi SELALU <= panjang input (tiap escape 2
 * karakter diganti 1 karakter newline), jadi validasi panjang setelah
 * normalisasi tidak bisa overflow.
 */

const LITERAL_NEWLINE_RE = /\\r\\n|\\n|\\r/g;

/**
 * v3.9.26: Validasi input emoji dari user (slash command / config).
 *
 * MASALAH: /set-verify-button, /add-category, /update-category menerima emoji
 * bebas string apa pun. String panjang / bukan emoji tersimpan ke config →
 * ButtonBuilder.setEmoji() throw saat panel dirender → /setup-verify dan semua
 * panel tiket mati sampai admin perbaiki manual (poison persist).
 *
 * Discord menerima 2 bentuk emoji:
 *   1. Unicode emoji (termasuk ZWJ sequence & modifier): "✅", "👍🏽", "👨‍👩‍👧"
 *   2. Custom emoji: "<:name:id>" atau "name:id" (animated "a" prefix juga ok)
 *
 * @param {string} input - emoji dari interaction.options.getString(...)
 * @returns {boolean} true kalau formatnya aman dipass ke setEmoji()
 */
// Custom emoji: <:name:123> / <a:name:123> / :name:123 / a:name:123
const CUSTOM_EMOJI_RE = /^<?a?:[A-Za-z0-9_~]{1,32}:[0-9]{5,25}>?$/;
// Unicode emoji: karakter non-ASCII (match 1-12 code unit — cukup untuk ZWJ sequence)
function isUnicodeEmoji(s) {
    if (s.length === 0 || s.length > 12) return false;
    for (const ch of s) {
        if (ch.codePointAt(0) < 0x80) return false; // ASCII bukan emoji
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
 * Konversi escape sequence newline literal (`\n`, `\r\n`, `\r`) jadi newline asli.
 * Input non-string di-pass through apa adanya (defensive).
 * @param {string} input - teks dari interaction.options.getString(...)
 * @returns {string} teks dengan newline asli
 */
function normalizeNewlines(input) {
    if (typeof input !== 'string') return input;
    return input.replace(LITERAL_NEWLINE_RE, '\n');
}

/**
 * v3.9.38 FIX: truncation code-point-aware — slice() biasa bisa motong
 * surrogate pair emoji jadi karakter rusak (Discord bisa reject 50035).
 *
 * Contoh: teks penuh emoji "👍" (2 code unit per emoji) di-slice(0, 500) bisa
 * berakhir di tengah pasangan surrogate → char terakhir jadi lone surrogate
 * (0xD800-0xDFFF) → embed/pesan ditolak API atau tampil sebagai karakter kotak.
 *
 * Helper ini memotong per CODE POINT (iterasi for..of string), tapi batas
 * maxLen tetap dihitung per CODE UNIT (limit Discord 256/1024/4096 dihitung
 * code unit). Total panjang hasil SELALU <= maxLen + 1 (ellipsis 1 code unit).
 *
 * @param {string} str - teks yang mau dipotong
 * @param {number} maxLen - panjang maksimum konten dalam code unit
 * @returns {string} teks terpotong (+ '…' kalau benar-benar terpotong)
 */
function truncateUtf8Safe(str, maxLen) {
    if (typeof str !== 'string' || str.length <= maxLen) return str ?? '';
    let out = '';
    // for..of iterasi per code point — pasangan surrogate tidak pernah terpisah.
    for (const ch of str) {
        if (out.length + ch.length > maxLen) break;
        out += ch;
    }
    return out + '…';
}

module.exports = { normalizeNewlines, isValidEmoji, truncateUtf8Safe };
