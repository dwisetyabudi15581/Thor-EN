/**
 * In-memory session manager untuk Embed Builder interactive.
 *
 * Sessions hilang kalau bot restart (acceptable untuk UX builder).
 * Kalau user klik tombol draft lama setelah restart → reply "session expired".
 *
 * Session structure:
 * {
 *   id: 'emb_<timestamp>_<rand>',
 *   ownerId: '<discord user id>',
 *   channelId: '<channel where draft message lives>',
 *   messageId: '<draft message id>',
 *   data: {
 *     title, description, color (number), image {url}, thumbnail {url},
 *     footer {text, iconURL?}, author {name, iconURL?},
 *     fields: [{name, value, inline}], timestamp (boolean),
 *     content: string | null  // v3.9.6: plain text message yang dikirim bersama embed
 *   },
 *   createdAt: timestamp
 * }
 */

const sessions = new Map();

// v3.9.38: potong teks per code point (emoji/surrogate pair aman).
const { truncateUtf8Safe } = require('../infra/text');

// P3-4 FIX: TTL supaya session yang ditinggal user tidak menjadi memory leak.
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 jam
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // cleanup tiap 10 menit

setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, s] of sessions) {
        if (now - s.createdAt > SESSION_TTL_MS) {
            sessions.delete(id);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 Embed builder: ${cleaned} session expired dihapus.`);
    }
}, CLEANUP_INTERVAL_MS).unref?.();

function genId() {
    // v3.9.8 FIX: naikkan random suffix dari 4 char ke 8 char.
    // Sebelumnya cuma 4 char base36 (~20 bit) — collision risk kalau 2 session
    // dibuat di ms yang sama. Sekarang 8 char (~41 bit) + timestamp, sangat aman.
    return `emb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createDefaultData() {
    return {
        title: null,
        description: null,
        color: 0x5865f2, // default blurple
        image: null,
        thumbnail: null,
        footer: null,
        author: null,
        fields: [],
        timestamp: true,
        content: null // v3.9.6: plain text message yang dikirim bersama embed (di luar embed)
    };
}

function createSession(ownerId, channelId) {
    const id = genId();
    const session = {
        id,
        ownerId,
        channelId,
        messageId: null,
        data: createDefaultData(),
        createdAt: Date.now()
    };
    sessions.set(id, session);
    return session;
}

function getSession(id) {
    const s = sessions.get(id);
    if (!s) return null;
    // P3-4 FIX: lazy expiry saat akses
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
        sessions.delete(id);
        return null;
    }
    return s;
}

function getSessionByMessage(messageId) {
    for (const s of sessions.values()) {
        if (s.messageId === messageId) return s;
    }
    return null;
}

function deleteSession(id) {
    return sessions.delete(id);
}

/**
 * v3.9.17: parseColor di-deprecate. Sekarang delegate ke shared helper di
 * infra/colors.js supaya logic tidak duplikat. Function ini di-keep untuk
 * backward compat (di-export via _shared.js dan dipakai di beberapa file).
 *
 * @deprecated Use `parseColor` from `infra/colors.js` instead.
 */
const { parseColor: _sharedParseColor } = require('../infra/colors');
function parseColor(input) {
    return _sharedParseColor(input);
}

/**
 * Build Discord EmbedBuilder dari session data.
 *
 * Catatan: Discord API mewajibkan embed punya minimal salah satu dari:
 * title, description, fields, image, thumbnail, author, footer.
 * Kalau session dalam state kosong (baru dibuat), kita pakai placeholder
 * description supaya tidak kena error BASE_TYPE_REQUIRED.
 */
function buildEmbed(session) {
    // Lazy require supaya file ini bisa di-load tanpa discord.js (untuk testing)
    const { EmbedBuilder } = require('discord.js');
    const d = session.data;
    const embed = new EmbedBuilder();

    // Deteksi state kosong: tidak ada title, description, fields, image,
    // thumbnail, author, footer. Kalau kosong, pakai placeholder.
    const hasContent =
        d.title ||
        d.description ||
        (d.fields && d.fields.length > 0) ||
        d.image ||
        d.thumbnail ||
        (d.footer && d.footer.text) ||
        (d.author && d.author.name);

    if (!hasContent) {
        embed.setDescription('*(Belum ada konten — pakai dropdown di bawah untuk mulai mengedit embed.)*');
    } else {
        if (d.title) embed.setTitle(d.title);
        if (d.description) embed.setDescription(d.description);
        if (d.image) embed.setImage(d.image.url);
        if (d.thumbnail) embed.setThumbnail(d.thumbnail.url);
        if (d.footer && d.footer.text) {
            const f = { text: d.footer.text };
            if (d.footer.iconURL) f.iconURL = d.footer.iconURL;
            embed.setFooter(f);
        }
        if (d.author && d.author.name) {
            const a = { name: d.author.name };
            if (d.author.iconURL) a.iconURL = d.author.iconURL;
            embed.setAuthor(a);
        }
        // Defensive validation — Discord limit: max 25 fields, name max 256, value max 1024.
        // Kalau session somehow akumulasi >25 fields, addFields bakal throw RangeError
        // → render draft gagal → user lihat broken panel.
        if (d.fields && d.fields.length > 0) {
            const safeFields = d.fields.slice(0, 25).map(f => ({
                // v3.9.38 FIX: potong per code point (slice() biasa bisa motong
                // surrogate pair emoji jadi lone surrogate → embed ditolak API).
                // maxLen dikurangi 1 supaya total DENGAN ellipsis '…' tetap ≤ 256/1024.
                name: truncateUtf8Safe(String(f.name || '\u200B'), 255),
                value: truncateUtf8Safe(String(f.value || '\u200B'), 1023),
                inline: !!f.inline
            }));
            embed.addFields(safeFields);
        }
    }

    if (d.color !== null && d.color !== undefined) embed.setColor(d.color);
    if (d.timestamp) embed.setTimestamp();
    return embed;
}

/**
 * Build status text untuk ditampilkan di control panel (opsional).
 * Berguna untuk debugging atau info cepat.
 */
function getStatusText(session) {
    const d = session.data;
    const lines = [];
    lines.push(`Title: ${d.title ? '✅' : '❌'}`);
    lines.push(`Description: ${d.description ? '✅' : '❌'}`);
    lines.push(`Color: ${d.color !== null ? '✅ #' + d.color.toString(16).padStart(6, '0') : 'default'}`);
    lines.push(`Image: ${d.image ? '✅' : '❌'}`);
    lines.push(`Thumbnail: ${d.thumbnail ? '✅' : '❌'}`);
    lines.push(`Footer: ${d.footer ? '✅' : '❌'}`);
    lines.push(`Author: ${d.author ? '✅' : '❌'}`);
    lines.push(`Fields: ${d.fields.length}/25`);
    lines.push(`Timestamp: ${d.timestamp ? '✅' : '❌'}`);
    // v3.9.6: tampilkan status plain text message (di luar embed)
    lines.push(`Message: ${d.content ? `✅ (${d.content.length} char)` : '❌'}`);
    return lines.join('\n');
}

/**
 * List semua session milik user tertentu (diurutkan dari terbaru).
 * Dipakai oleh /embed-list command.
 */
function getSessionsByUser(userId) {
    const result = [];
    for (const s of sessions.values()) {
        if (s.ownerId === userId) result.push(s);
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Hapus session milik user berdasarkan ID.
 * Dipakai oleh /embed-cancel command (untuk session yang draft-nya sudah kehapus).
 * Returns: session yang dihapus, atau null kalau tidak ada / bukan milik user.
 */
function deleteSessionByOwner(sessionId, userId) {
    const s = sessions.get(sessionId);
    if (!s || s.ownerId !== userId) return null;
    sessions.delete(sessionId);
    return s;
}

module.exports = {
    createSession,
    getSession,
    getSessionByMessage,
    getSessionsByUser,
    deleteSession,
    deleteSessionByOwner,
    buildEmbed,
    parseColor,
    getStatusText
};
