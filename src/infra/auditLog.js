/**
 * Audit Log — catat semua admin action ke channel khusus.
 *
 * Cara pakai:
 *   const { logAudit } = require('../utils/auditLog');
 *   await logAudit(client, {
 *     action: 'ADD_PRODUCT',
 *     actorId: interaction.user.id,
 *     actorTag: interaction.user.tag,
 *     details: `Tambah produk: ${label} (${value}) — ${price}`,
 *     guildId: interaction.guild.id
 *   });
 *
 * Channel tujuan diambil dari config.channels['audit-log'].
 * Kalau belum di-set, log di-skip (silent fail).
 *
 * v3.9.2: tambah retry 1x dengan delay 500ms kalau pengiriman pertama gagal
 * (mis. karena rate-limit Discord atau network blip). Sebelumnya, satu error
 * transient langsung bikin audit log hilang. Sekarang setidaknya ada 2 percobaan.
 *
 * Tidak ada file JSON — log dikirim langsung ke channel Discord.
 */

const { EmbedBuilder } = require('discord.js');

const ACTION_LABELS = {
    // Products
    ADD_PRODUCT: '➕ Tambah Produk',
    REMOVE_PRODUCT: '❌ Hapus Produk',
    EDIT_PRODUCT: '✏️ Edit Produk',
    // Roles & Channels
    SET_ROLE: '🎭 Set Role',
    REMOVE_ROLE: '🚫 Hapus Role dari Config',
    SET_CHANNEL: '📢 Set Channel',
    REMOVE_CHANNEL: '🚫 Hapus Channel dari Config',
    // Messages
    SET_MESSAGE: '✏️ Set Pesan',
    RESET_MESSAGE: '🔄 Reset Pesan ke Default',
    // Self-Role
    SETUP_SELFROLE: '🎭 Buat Panel Self-Role',
    SELFROLE_ADD: '➕ Tambah Role ke Panel',
    SELFROLE_REMOVE: '❌ Hapus Role dari Panel',
    SELFROLE_DELETE: '🗑️ Hapus Panel Self-Role',
    // Embed Builder & Announce
    ANNOUNCE_SEND: '📢 Kirim Announce',
    EMBED_BUILDER_SEND: '📤 Kirim Embed (Builder)',
    // VIP / Keys
    SET_KEY: '🔑 Set Key (Ticket)',
    ORDER_DELIVERED: '📦 Kirim Pesanan (Ticket)',
    CLEAR_SCHEDULE: '🧹 Clear Schedule',
    // Config
    RESET_CONFIG: '⚠️ RESET CONFIG TOTAL',
    // Backup
    BACKUP_NOW: '💾 Backup Manual',
    RESTORE_BACKUP: '♻️ Restore Backup',
    // Giveaway
    GIVEAWAY_CREATE: '🎉 Buat Giveaway',
    GIVEAWAY_END: '🛑 End Giveaway',
    GIVEAWAY_REROLL: '🎲 Reroll Giveaway',
    // Scheduled Announce
    ANNOUNCE_SCHEDULE: '⏰ Schedule Announce',
    ANNOUNCE_CANCEL: '❌ Cancel Scheduled Announce',
    // Warn
    WARN_ADD: '⚠️ Warn Member',
    WARN_REMOVE: '✅ Hapus Warn',
    WARN_CLEAR_ALL: '🧹 Clear Semua Warn',
    // Poll
    POLL_CREATE: '📊 Buat Poll',
    POLL_CLOSE: '🔒 Tutup Poll',
    // v3.9.4: tambah label yang sebelumnya fallback ke raw action string.
    SETUP_TEMPVOICE: '🎤 Setup Temp Voice',
    TEMPVOICE_REMOVE: '🗑️ Hapus Setup Temp Voice',
    // v3.9.17 FIX: tambah 15 label yang sebelumnya fallback ke raw action string.
    // Leveling
    SETUP_LEVELING: '📊 Setup Leveling',
    ADD_LEVEL_ROLE: '➕ Tambah Level Role',
    REMOVE_LEVEL_ROLE: '❌ Hapus Level Role',
    // Auto-Responder
    ADD_RESPONDER: '➕ Tambah Auto-Responder',
    REMOVE_RESPONDER: '❌ Hapus Auto-Responder',
    // Auto-Mod
    SET_AUTOMOD: '🛡️ Set Auto-Mod Config',
    TOGGLE_AUTOMOD: '🔄 Toggle Auto-Mod',
    AUTOMOD_WHITELIST: '✅ Whitelist Channel/Role untuk Link',
    // v3.9.23: word flex
    AUTOMOD_WORD: '📝 Kelola Kata Auto-Mod (Add/Remove)',
    // Categories
    ADD_CATEGORY: '🎫 Tambah Kategori Tiket',
    REMOVE_CATEGORY: '🗑️ Hapus Kategori Tiket',
    // Send Message
    SEND_MESSAGE: '📤 Kirim Pesan (Custom)',
    // Panels (verify + ticket panel)
    SET_VERIFY_BUTTON: '✏️ Set Verify Button',
    SETUP_TICKET_PANEL: '🎫 Setup Panel Tiket (Multi-Panel)',
    // Panel management (v3.9.14+)
    DELETE_PANEL: '🗑️ Hapus Panel Tiket',
    REFRESH_PANEL: '🔄 Refresh Panel Tiket',
    UPDATE_PANEL: '✏️ Update Field Panel',
    // Midman / Rekber (v3.9.32; label ditambah v3.9.37 — sebelumnya fallback
    // ke raw action string, konsisten dengan cleanup label v3.9.4/v3.9.17)
    SET_MIDMAN_FEE: '💰 Set Fee Rekber',
    MIDMAN_CREATE: '🤝 Buat Deal Rekber',
    MIDMAN_AGREE: '✅ Setuju Deal (parsial)',
    MIDMAN_JOIN: '✅ Setuju Deal (terkunci)',
    MIDMAN_CANCEL: '🚫 Batal Deal Rekber',
    MIDMAN_FUNDIN: '💰 Dana Masuk (Rekber)',
    MIDMAN_RECEIVED: '📦 Barang Diterima (Rekber)',
    MIDMAN_RELEASE: '💸 Cairkan Dana (Rekber)',
    MIDMAN_DISPUTE: '🚨 Dispute Rekber',
    MIDMAN_RESOLVE_RELEASE: '⚖️ Resolve Dispute — Cairkan',
    MIDMAN_RESOLVE_REFUND: '⚖️ Resolve Dispute — Refund',
    MIDMAN_MEMBER_ADD: '➕ Tambah Member Deal',
    MIDMAN_MEMBER_REMOVE: '➖ Keluarkan Member Deal'
};

const RETRY_DELAY_MS = 500;
const MAX_ATTEMPTS = 2;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Kirim entry audit log ke channel yang sudah di-set.
 * @param {Client} client - Discord client
 * @param {Object} data - { action, actorId, actorTag, details, guildId }
 * @returns {Promise<boolean>} true kalau berhasil terkirim, false kalau gagal/skip
 */
async function logAudit(client, data) {
    let auditChannelId;
    try {
        const { getConfig } = require('../data/configManager');
        const config = getConfig();
        auditChannelId = config.channels['audit-log'];
    } catch (_err) {
        // config rusak — skip
        return false;
    }
    if (!auditChannelId) return false; // belum di-set, silent skip

    // Resolve channel (cache dulu, fallback fetch)
    let channel;
    try {
        channel =
            client.channels.cache.get(auditChannelId) ||
            (await client.channels.fetch(auditChannelId).catch(() => null));
    } catch (err) {
        console.warn('⚠️ Audit log: gagal resolve channel:', err.message);
        return false;
    }
    if (!channel) return false;

    const label = ACTION_LABELS[data.action] || data.action;
    // v3.9.26 FIX: truncate detail ke 1024 (limit embed field value). Sebelumnya,
    // details panjang (mis. daftar winner 20 mention) bikin addFields throw
    // SEBELUM retry try/catch → caller yang tidak wrap (backup.js, panels-mgmt)
    // menganggap operasi gagal padahal sudah sukses.
    const detailsText =
        typeof data.details === 'string' && data.details.length > 1024
            ? data.details.slice(0, 1010) + '…(dipotong)'
            : data.details || '_(tidak ada detail)_';
    const embed = new EmbedBuilder()
        .setTitle(`🔧 AUDIT: ${label}`.slice(0, 256))
        .setColor(0x2c2f33)
        .addFields(
            {
                name: '👤 Admin',
                value: `<@${data.actorId}> (\`${data.actorTag || data.actorId}\`)`.slice(0, 1024),
                inline: true
            },
            { name: '🕐 Waktu', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
            { name: '📋 Detail', value: detailsText }
        )
        .setFooter({ text: `Action: ${data.action}`.slice(0, 2048) })
        .setTimestamp();

    if (data.guildId) embed.addFields({ name: '🏠 Guild', value: `\`${data.guildId}\``, inline: true });

    // v3.9.2: retry sekali kalau send gagal karena transient error (rate limit,
    // network blip, dll). Error non-retryable (permission, 4xx) tidak di-retry.
    // v3.9.8 FIX: sebelumnya `code === 0` (catch-all untuk error tanpa code/status)
    // juga di-retry. Ini salah — TypeError/ReferenceError (programming bug) gak
    // akan berhasil di-retry, hanya buang waktu 500ms. Sekarang: hanya retry
    // kalau code/status mengindikasikan network/Discord transient error.
    const TRANSIENT_ERROR_NAMES = new Set([
        'ConnectTimeoutError',
        'WebSocketClosedError',
        'FetchError' // undici fetch errors (network)
    ]);
    const TRANSIENT_ERROR_CODES = new Set([
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'EAI_AGAIN',
        'ENOTFOUND',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET'
    ]);
    function isRetryableAuditError(err) {
        const code = err.code || err.status || 0;
        // Discord 5xx (server error) — retry
        if (code >= 500 && code < 600) return true;
        // Rate limit — retry
        if (code === 429) return true;
        // Known network error codes (Node.js / undici) — retry
        if (typeof err.code === 'string' && TRANSIENT_ERROR_CODES.has(err.code)) return true;
        // Known network error names — retry
        if (TRANSIENT_ERROR_NAMES.has(err.name)) return true;
        return false;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            await channel.send({ embeds: [embed] });
            return true;
        } catch (err) {
            const code = err.code || err.status || 0;
            const isRetryable = isRetryableAuditError(err);
            if (attempt < MAX_ATTEMPTS && isRetryable) {
                console.warn(
                    `⚠️ Audit log attempt ${attempt} gagal (code ${code}, ${err.name || 'unknown'}), retry dalam ${RETRY_DELAY_MS}ms...`
                );
                await sleep(RETRY_DELAY_MS);
                continue;
            }
            console.warn(
                `⚠️ Audit log gagal terkirim (attempt ${attempt}/${MAX_ATTEMPTS}, code ${code}):`,
                err.message
            );
            return false;
        }
    }
    return false;
}

module.exports = { logAudit, ACTION_LABELS };
