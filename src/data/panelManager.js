/**
 * panelManager.js — Persistent ticket panel metadata (v3.9.14).
 *
 * WHY THIS EXISTS
 * ---------------
 * Sebelum v3.9.14, /setup-ticket-panel cuma kirim embed + button ke channel,
 * tapi TIDAK nyimpen metadata panel ke file. Konsekuensinya:
 *   1. Bot restart / mau update panel → tidak bisa re-render panel lama.
 *      Kalau ada produk baru, panel lama tidak auto-update. Harus delete manual
 *      dan setup ulang.
 *   2. Tidak ada cara list / delete panel via command. Admin harus cari manual
 *      di channel mana panel dipasang.
 *   3. Tidak ada cara edit panel (title/body/color) tanpa delete + setup ulang.
 *
 * Sekarang: tiap panel yang dibuat lewat /setup-ticket-panel disimpan ke
 * panels.json (keyed by panelId). Panel bisa di-list, edit, delete, refresh.
 *
 * File layout (panels.json):
 * {
 *   "tp_<nanoid>": {
 *     "id": "tp_xxx",
 *     "guildId": "123",
 *     "channelId": "456",
 *     "messageId": "789",
 *     "title": "Beli Key",
 *     "body": null,             // null = pakai config.messages.ticketBody
 *     "color": null,            // null = pakai default 0xe67e22
 *     "imageUrl": null,         // null = no image
 *     "thumbnailUrl": null,     // null = no thumbnail
 *     "footerText": null,       // null = pakai bot username
 *     "categoryIds": ["transaction"],   // kategori yang ditampilkan
 *     "useDropdown": false,     // false = buttons, true = select menu
 *     "createdAt": 1700000000000,
 *     "createdBy": "999",
 *     "updatedAt": null,
 *     "updatedBy": null
 *   }
 * }
 *
 * Backward compat:
 *   - Panel lama (sebelum v3.9.14) tidak ada di panels.json. Tetap jalan,
 *     tapi gak bisa di-list/delete/update via command. Admin bisa setup ulang
 *     untuk migrasi ke sistem baru.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const panelsPath = path.join(__dirname, '..', '..', 'data', 'panels.json');

// In-memory cache — read file on first access, keep in sync after write.
// Why cache? /list-panels bisa dipanggil sering, dan read-file-per-call bikin
// disk I/O berat kalau panels.json gede. Cache simple, invalidates on save.
let _cache = null;
let _cacheLoadedAt = 0;

const CACHE_TTL_MS = 30 * 1000; // 30 detik — singkat cukup untuk handle
// external edit (admin edit panels.json manual), tapi tetap mengurangi disk I/O.

/**
 * Load panels.json. Kalau file belum ada / rusak, return {}.
 * Pakai cache 30 detik supaya tidak baca file terus-menerus.
 */
function loadPanels() {
    const now = Date.now();
    if (_cache && now - _cacheLoadedAt < CACHE_TTL_MS) {
        return _cache;
    }
    try {
        if (!fs.existsSync(panelsPath)) {
            _cache = {};
            _cacheLoadedAt = now;
            return _cache;
        }
        const raw = fs.readFileSync(panelsPath, 'utf8');
        _cache = JSON.parse(raw);
        if (!_cache || typeof _cache !== 'object' || Array.isArray(_cache)) {
            console.warn('⚠️ panels.json format invalid (bukan object), reset ke {}.');
            // v3.9.26: karantina sebelum reset — isinya valid JSON tapi struktur
            // salah; simpan bekasnya supaya admin bisa pulihkan manual.
            quarantineCorruptFile(panelsPath);
            _cache = {};
        }
        _cacheLoadedAt = now;
        return _cache;
    } catch (err) {
        console.warn('⚠️ panels.json rusak:', err.message);
        // v3.9.26: karantina file korup sebelum fallback (lihat safeWrite.js).
        quarantineCorruptFile(panelsPath);
        _cache = {};
        _cacheLoadedAt = now;
        return _cache;
    }
}

/**
 * Save panels.json (atomic via safeWriteJSON) + update cache.
 */
function savePanels(data) {
    safeWriteJSON(panelsPath, data);
    _cache = data;
    _cacheLoadedAt = Date.now();
}

/**
 * Generate panel ID. Format: tp_<timestamp_base36>_<random>.
 * Unik enough untuk 1 guild punya ratusan panel tanpa collision.
 */
function generatePanelId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `tp_${ts}_${rand}`;
}

/**
 * Simpan metadata panel baru (atau update yang sudah ada kalau id sama).
 * @param {Object} panel - lihat schema di file header.
 * @returns {Object} panel yang sudah disimpan (dengan id di-generate kalau belum ada).
 */
function upsertPanel(panel) {
    if (!panel || typeof panel !== 'object') {
        throw new Error('upsertPanel: panel must be object');
    }
    const all = loadPanels();
    const id = panel.id || generatePanelId();
    const existing = all[id];

    const merged = {
        id,
        guildId: panel.guildId || existing?.guildId || null,
        channelId: panel.channelId || existing?.channelId || null,
        messageId: panel.messageId ?? existing?.messageId ?? null,
        title: panel.title ?? existing?.title ?? null,
        body: panel.body ?? existing?.body ?? null,
        color: panel.color ?? existing?.color ?? null,
        imageUrl: panel.imageUrl ?? existing?.imageUrl ?? null,
        thumbnailUrl: panel.thumbnailUrl ?? existing?.thumbnailUrl ?? null,
        footerText: panel.footerText ?? existing?.footerText ?? null,
        categoryIds: Array.isArray(panel.categoryIds) ? panel.categoryIds : existing?.categoryIds || [],
        useDropdown: panel.useDropdown ?? existing?.useDropdown ?? false,
        createdAt: existing?.createdAt || panel.createdAt || Date.now(),
        createdBy: existing?.createdBy || panel.createdBy || null,
        updatedAt: Date.now(),
        updatedBy: panel.updatedBy ?? existing?.updatedBy ?? null
    };
    all[id] = merged;
    savePanels(all);
    return merged;
}

/**
 * Update sebagian field panel (partial update).
 * Hanya field yang di-define akan di-update.
 */
function patchPanel(id, patch) {
    const all = loadPanels();
    if (!all[id]) return null;
    const updated = {
        ...all[id],
        ...patch,
        id, // jangan override id
        updatedAt: Date.now()
    };
    all[id] = updated;
    savePanels(all);
    return updated;
}

/**
 * Set messageId untuk panel (dipanggil setelah bot kirim message ke channel).
 */
function setPanelMessageId(id, messageId) {
    return patchPanel(id, { messageId });
}

/**
 * Ambil 1 panel by id.
 */
function getPanel(id) {
    return loadPanels()[id] || null;
}

/**
 * List semua panel di guild tertentu.
 */
function getPanelsByGuild(guildId) {
    const all = loadPanels();
    return Object.values(all).filter(p => p.guildId === guildId);
}

/**
 * Hapus panel by id.
 * @returns {boolean} true kalau berhasil dihapus, false kalau tidak ketemu.
 */
function deletePanel(id) {
    const all = loadPanels();
    if (!all[id]) return false;
    delete all[id];
    savePanels(all);
    return true;
}

/**
 * Hapus semua panel di guild tertentu (dipakai saat guild leave / reset).
 */
function deletePanelsByGuild(guildId) {
    const all = loadPanels();
    let count = 0;
    for (const [id, p] of Object.entries(all)) {
        if (p.guildId === guildId) {
            delete all[id];
            count++;
        }
    }
    if (count > 0) savePanels(all);
    return count;
}

/**
 * Invalidate cache (force re-read dari disk pada next load).
 * Dipakai kalau ada operasi yang modify file di luar manager ini.
 */
function invalidateCache() {
    _cache = null;
    _cacheLoadedAt = 0;
}

module.exports = {
    loadPanels,
    savePanels,
    generatePanelId,
    upsertPanel,
    patchPanel,
    setPanelMessageId,
    getPanel,
    getPanelsByGuild,
    deletePanel,
    deletePanelsByGuild,
    invalidateCache,
    panelsPath
};
