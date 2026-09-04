const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const selfRolesPath = path.join(__dirname, '..', '..', 'data', 'selfRoles.json');

/**
 * File structure: selfRoles.json
 * [
 *   {
 *     "id": "sr_a1b2c3",
 *     "guildId": "...",
 *     "channelId": "...",
 *     "messageId": "...",
 *     "title": "🎭 Pilih Role Kamu",
 *     "description": "Klik tombol untuk ambil / lepas role.",
 *     "type": "button",           // "button" atau "select"
 *     "exclusive": false,         // true = hanya boleh 1 role pada satu waktu
 *     "roles": [
 *       {
 *         "roleId": "...",
 *         "label": "Notif",
 *         "emoji": "🔔",
 *         "description": "Dapatkan ping untuk pengumuman"
 *       }
 *     ],
 *     "createdAt": 1735000000000
 *   }
 * ]
 *
 * === SELF-ROLE FLEKSIBEL ===
 * - Admin bisa bikin banyak panel (tiap channel bisa beda panel)
 * - Tipe: button (≤25 role, 1 row = 5 button) atau select menu (≤25 role)
 * - Mode: multi (boleh ambil banyak) atau exclusive (cuma 1 role pada satu waktu)
 * - Member klik tombol / pilih dropdown → toggle role
 */

function loadPanels() {
    try {
        if (!fs.existsSync(selfRolesPath)) return [];
        return JSON.parse(fs.readFileSync(selfRolesPath, 'utf8'));
    } catch (err) {
        console.error('Error load selfRoles.json:', err.message);
        // v3.9.26: karantina file korup sebelum fallback (lihat safeWrite.js).
        quarantineCorruptFile(selfRolesPath);
        return [];
    }
}

// v3.9.0 FIX: atomic write via safeWriteJSON (tmp+rename) to prevent corruption on crash
function savePanels(list) {
    safeWriteJSON(selfRolesPath, list);
}

function genId() {
    // v3.9.8 FIX: tambah Date.now() untuk kurangi collision risk.
    // Sebelumnya cuma 6 char base36 (~31 bit entropy → ~46k panels untuk 50% collision chance).
    // Sekarang: timestamp + 6 char random, aman untuk puluhan ribu panel.
    return `sr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Buat panel baru (belum ada roles, akan diisi via addRoleToPanel).
 */
function createPanel(data) {
    const list = loadPanels();
    const now = Date.now();
    const panel = {
        id: genId(),
        guildId: data.guildId,
        channelId: data.channelId,
        messageId: data.messageId || null,
        title: data.title || '🎭 Self Role',
        description: data.description || 'Klik untuk ambil / lepas role.',
        type: data.type === 'select' ? 'select' : 'button',
        exclusive: !!data.exclusive,
        roles: [],
        createdAt: now
    };
    list.push(panel);
    savePanels(list);
    return panel;
}

/**
 * Update messageId (setelah panel message dikirim ke Discord).
 */
function setMessageId(panelId, messageId) {
    const list = loadPanels();
    const panel = list.find(p => p.id === panelId);
    if (!panel) return false;
    panel.messageId = messageId;
    savePanels(list);
    return true;
}

/**
 * Tambah role ke panel.
 * - Maks 25 role per panel (batas Discord).
 * - roleId harus unik per panel.
 *
 * @returns {{ ok: boolean, panel?: Object, error?: string }}
 */
function addRoleToPanel(panelId, roleData) {
    const list = loadPanels();
    const panel = list.find(p => p.id === panelId);
    if (!panel) return { ok: false, error: 'Panel tidak ditemukan.' };

    if (panel.roles.length >= 25) {
        return { ok: false, error: 'Maksimal 25 role per panel (batas Discord).' };
    }
    if (panel.roles.some(r => r.roleId === roleData.roleId)) {
        return { ok: false, error: 'Role sudah ada di panel ini.' };
    }

    panel.roles.push({
        roleId: roleData.roleId,
        label: (roleData.label || 'Role').slice(0, 80),
        emoji: roleData.emoji || '',
        description: (roleData.description || '').slice(0, 100),
        // v3.9.11 Phase 3: per-role button style customization.
        style: ['Primary', 'Secondary', 'Success', 'Danger'].includes(roleData.style) ? roleData.style : 'Secondary',
        // v3.9.11 Phase 3: conditional role — hanya muncul kalau user sudah punya role ini.
        // Kalau null/undefined, role tersedia untuk semua user.
        requiresRoleId: roleData.requiresRoleId || null
    });
    savePanels(list);
    return { ok: true, panel };
}

/**
 * Hapus role dari panel.
 */
function removeRoleFromPanel(panelId, roleId) {
    const list = loadPanels();
    const panel = list.find(p => p.id === panelId);
    if (!panel) return { ok: false, error: 'Panel tidak ditemukan.' };

    const before = panel.roles.length;
    panel.roles = panel.roles.filter(r => r.roleId !== roleId);
    if (panel.roles.length === before) {
        return { ok: false, error: 'Role tidak ada di panel ini.' };
    }
    savePanels(list);
    return { ok: true, panel };
}

/**
 * Ambil panel berdasarkan ID.
 */
function getPanel(panelId) {
    const list = loadPanels();
    return list.find(p => p.id === panelId) || null;
}

/**
 * Ambil semua panel di guild tertentu.
 */
function getPanelsByGuild(guildId) {
    const list = loadPanels();
    return list.filter(p => p.guildId === guildId);
}

/**
 * Ambil panel berdasarkan messageId (untuk handle button/select interaction).
 */
function getPanelByMessage(messageId) {
    const list = loadPanels();
    return list.find(p => p.messageId === messageId) || null;
}

/**
 * Update title/description/exclusive panel.
 */
function updatePanel(panelId, updates) {
    const list = loadPanels();
    const panel = list.find(p => p.id === panelId);
    if (!panel) return null;
    if (updates.title !== undefined) panel.title = updates.title;
    if (updates.description !== undefined) panel.description = updates.description;
    if (updates.exclusive !== undefined) panel.exclusive = !!updates.exclusive;
    savePanels(list);
    return panel;
}

/**
 * Hapus panel.
 */
function deletePanel(panelId) {
    const list = loadPanels();
    const filtered = list.filter(p => p.id !== panelId);
    const removed = list.length - filtered.length;
    if (removed > 0) savePanels(filtered);
    return removed > 0;
}

module.exports = {
    createPanel,
    setMessageId,
    addRoleToPanel,
    removeRoleFromPanel,
    getPanel,
    getPanelsByGuild,
    getPanelByMessage,
    updatePanel,
    deletePanel
};
