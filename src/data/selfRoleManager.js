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
 *     "title": "🎭 Pick Your Role",
 *     "description": "Click a button to get / remove a role.",
 *     "type": "button",           // "button" or "select"
 *     "exclusive": false,         // true = only 1 role at a time
 *     "roles": [
 *       {
 *         "roleId": "...",
 *         "label": "Notif",
 *         "emoji": "🔔",
 *         "description": "Get pinged for announcements"
 *       }
 *     ],
 *     "createdAt": 1735000000000
 *   }
 * ]
 *
 * === FLEXIBLE SELF-ROLES ===
 * - Admins can create multiple panels (each channel can have a different panel)
 * - Type: button (≤25 roles, 1 row = 5 buttons) or select menu (≤25 roles)
 * - Mode: multi (can take many) or exclusive (only 1 role at a time)
 * - Member clicks a button / picks from the dropdown → toggles the role
 */

function loadPanels() {
    try {
        if (!fs.existsSync(selfRolesPath)) return [];
        return JSON.parse(fs.readFileSync(selfRolesPath, 'utf8'));
    } catch (err) {
        console.error('Error loading selfRoles.json:', err.message);
        // v3.9.26: quarantine the corrupt file before falling back (see safeWrite.js).
        quarantineCorruptFile(selfRolesPath);
        return [];
    }
}

// v3.9.0 FIX: atomic write via safeWriteJSON (tmp+rename) to prevent corruption on crash
function savePanels(list) {
    safeWriteJSON(selfRolesPath, list);
}

function genId() {
    // v3.9.8 FIX: add Date.now() to reduce collision risk.
    // Previously only 6 base36 chars (~31 bits of entropy → ~46k panels for a
    // 50% collision chance). Now: timestamp + 6 random chars, safe for tens of
    // thousands of panels.
    return `sr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a new panel (no roles yet, they're added via addRoleToPanel).
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
        description: data.description || 'Click to get / remove a role.',
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
 * Update messageId (after the panel message is sent to Discord).
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
 * Add a role to a panel.
 * - Max 25 roles per panel (Discord limit).
 * - roleId must be unique per panel.
 *
 * @returns {{ ok: boolean, panel?: Object, error?: string }}
 */
function addRoleToPanel(panelId, roleData) {
    const list = loadPanels();
    const panel = list.find(p => p.id === panelId);
    if (!panel) return { ok: false, error: 'Panel not found.' };

    if (panel.roles.length >= 25) {
        return { ok: false, error: 'Maximum 25 roles per panel (Discord limit).' };
    }
    if (panel.roles.some(r => r.roleId === roleData.roleId)) {
        return { ok: false, error: 'This role is already on the panel.' };
    }

    panel.roles.push({
        roleId: roleData.roleId,
        label: (roleData.label || 'Role').slice(0, 80),
        emoji: roleData.emoji || '',
        description: (roleData.description || '').slice(0, 100),
        // v3.9.11 Phase 3: per-role button style customization.
        style: ['Primary', 'Secondary', 'Success', 'Danger'].includes(roleData.style) ? roleData.style : 'Secondary',
        // v3.9.11 Phase 3: conditional role — only shows if the user already
        // has this role. If null/undefined, the role is available to everyone.
        requiresRoleId: roleData.requiresRoleId || null
    });
    savePanels(list);
    return { ok: true, panel };
}

/**
 * Remove a role from a panel.
 */
function removeRoleFromPanel(panelId, roleId) {
    const list = loadPanels();
    const panel = list.find(p => p.id === panelId);
    if (!panel) return { ok: false, error: 'Panel not found.' };

    const before = panel.roles.length;
    panel.roles = panel.roles.filter(r => r.roleId !== roleId);
    if (panel.roles.length === before) {
        return { ok: false, error: 'This role is not on the panel.' };
    }
    savePanels(list);
    return { ok: true, panel };
}

/**
 * Get a panel by ID.
 */
function getPanel(panelId) {
    const list = loadPanels();
    return list.find(p => p.id === panelId) || null;
}

/**
 * Get all panels in a given guild.
 */
function getPanelsByGuild(guildId) {
    const list = loadPanels();
    return list.filter(p => p.guildId === guildId);
}

/**
 * Get a panel by messageId (for handling button/select interactions).
 */
function getPanelByMessage(messageId) {
    const list = loadPanels();
    return list.find(p => p.messageId === messageId) || null;
}

/**
 * Update a panel's title/description/exclusive.
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
 * Delete a panel.
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
