/**
 * panelManager.js — Persistent ticket panel metadata (v3.9.14).
 *
 * WHY THIS EXISTS
 * ---------------
 * Before v3.9.14, /setup-ticket-panel only sent an embed + button to a channel,
 * but did NOT save the panel metadata to file. The consequences:
 *   1. Bot restart / panel update → old panels couldn't be re-rendered.
 *      With a new product, old panels didn't auto-update. You had to manually
 *      delete and set up again.
 *   2. There was no way to list / delete panels via command. Admins had to
 *      manually find which channel a panel was posted in.
 *   3. There was no way to edit a panel (title/body/color) without deleting +
 *      setting it up again.
 *
 * Now: every panel created via /setup-ticket-panel is saved to panels.json
 * (keyed by panelId). Panels can be listed, edited, deleted, refreshed.
 *
 * File layout (panels.json):
 * {
 *   "tp_<nanoid>": {
 *     "id": "tp_xxx",
 *     "guildId": "123",
 *     "channelId": "456",
 *     "messageId": "789",
 *     "title": "Buy Key",
 *     "body": null,             // null = use config.messages.ticketBody
 *     "color": null,            // null = use default 0xe67e22
 *     "imageUrl": null,         // null = no image
 *     "thumbnailUrl": null,     // null = no thumbnail
 *     "footerText": null,       // null = use bot username
 *     "categoryIds": ["transaction"],   // categories to display
 *     "useDropdown": false,     // false = buttons, true = select menu
 *     "createdAt": 1700000000000,
 *     "createdBy": "999",
 *     "updatedAt": null,
 *     "updatedBy": null
 *   }
 * }
 *
 * Backward compat:
 *   - Old panels (before v3.9.14) aren't in panels.json. They still work,
 *     but can't be listed/deleted/updated via command. Admins can set them up
 *     again to migrate to the new system.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const panelsPath = path.join(__dirname, '..', '..', 'data', 'panels.json');

// In-memory cache — read file on first access, keep in sync after write.
// Why cache? /list-panels can be called often, and read-file-per-call makes
// for heavy disk I/O when panels.json is big. Simple cache, invalidates on save.
let _cache = null;
let _cacheLoadedAt = 0;

const CACHE_TTL_MS = 30 * 1000; // 30 seconds — short enough to handle
// external edits (admin edits panels.json manually), but still cuts disk I/O.

/**
 * Load panels.json. If the file doesn't exist / is corrupt, return {}.
 * Uses a 30 second cache so the file isn't read over and over.
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
            console.warn('⚠️ panels.json format invalid (not an object), resetting to {}.');
            // v3.9.26: quarantine before reset — the content is valid JSON but
            // the structure is wrong; keep a copy so an admin can recover manually.
            quarantineCorruptFile(panelsPath);
            _cache = {};
        }
        _cacheLoadedAt = now;
        return _cache;
    } catch (err) {
        console.warn('⚠️ panels.json is corrupt:', err.message);
        // v3.9.26: quarantine the corrupt file before falling back (see safeWrite.js).
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
 * Generate a panel ID. Format: tp_<timestamp_base36>_<random>.
 * Unique enough for 1 guild to have hundreds of panels without collisions.
 */
function generatePanelId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `tp_${ts}_${rand}`;
}

/**
 * Save new panel metadata (or update an existing one if the id matches).
 * @param {Object} panel - see the schema in the file header.
 * @returns {Object} the saved panel (with an id generated if it didn't have one).
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
 * Update some panel fields (partial update).
 * Only defined fields are updated.
 */
function patchPanel(id, patch) {
    const all = loadPanels();
    if (!all[id]) return null;
    const updated = {
        ...all[id],
        ...patch,
        id, // never override the id
        updatedAt: Date.now()
    };
    all[id] = updated;
    savePanels(all);
    return updated;
}

/**
 * Set the messageId for a panel (called after the bot sends the message to a channel).
 */
function setPanelMessageId(id, messageId) {
    return patchPanel(id, { messageId });
}

/**
 * Get a single panel by id.
 */
function getPanel(id) {
    return loadPanels()[id] || null;
}

/**
 * List all panels in a given guild.
 */
function getPanelsByGuild(guildId) {
    const all = loadPanels();
    return Object.values(all).filter(p => p.guildId === guildId);
}

/**
 * Delete a panel by id.
 * @returns {boolean} true if deleted, false if not found.
 */
function deletePanel(id) {
    const all = loadPanels();
    if (!all[id]) return false;
    delete all[id];
    savePanels(all);
    return true;
}

/**
 * Delete all panels in a given guild (used on guild leave / reset).
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
 * Invalidate the cache (force a re-read from disk on the next load).
 * Used when an operation modifies the file outside this manager.
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
