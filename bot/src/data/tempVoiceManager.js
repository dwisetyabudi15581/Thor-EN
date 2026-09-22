/**
 * Temp Voice Manager — tracks temporary voice channels created by members.
 *
 * File: tempVoice.json
 * {
 *   "guildId": {
 *     "creatorChannelId": "123",   // trigger voice channel (member joins → a new one is created)
 *     "categoryId": "456",         // the category where new channels are created
 *     "channels": {
 *       "channelId": {
 *         "ownerId": "userId",
 *         "ownerTag": "User#1234",
 *         "createdAt": 1735689600000,
 *         "locked": false,
 *         "limit": 0,              // 0 = unlimited
 *         "name": "🔊 User's Room"
 *       }
 *     }
 *   }
 * }
 *
 * How it works:
 *   1. An admin sets it up via /setup-tempvoice → the bot creates a category + trigger channel + control panel
 *   2. A member joins the trigger channel "🔊 Create Voice" → the bot creates a private voice channel for the member
 *   3. The member becomes the owner and is automatically moved to the new channel
 *   4. A global panel in the control channel shows all active voices + control buttons
 *   5. The owner uses buttons: rename, kick, limit, lock, transfer, delete, room info
 *   6. When the owner leaves and the channel is empty → the bot deletes the channel automatically
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'tempVoice.json');

function load() {
    try {
        if (!fs.existsSync(filePath)) return {};
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.warn('⚠️ tempVoice.json is corrupted:', err.message);
        // v3.9.26: quarantine the corrupt file before falling back (see safeWrite.js).
        quarantineCorruptFile(filePath);
        return {};
    }
}

// v3.9.0 FIX: atomic write via safeWriteJSON (tmp+rename) to prevent corruption on crash
function save(data) {
    safeWriteJSON(filePath, data);
}

/**
 * Set up temp voice for a guild: store the trigger channel + category + control channel.
 *
 * @param {string} guildId
 * @param {string} creatorChannelId - trigger voice channel (member joins → a new one is created)
 * @param {string} categoryId - the category where new channels are created
 * @param {string} controlChannelId - the text channel where the global control panel is posted
 */
function setupGuild(guildId, creatorChannelId, categoryId, controlChannelId) {
    const all = load();
    if (!all[guildId]) all[guildId] = { channels: {} };
    all[guildId].creatorChannelId = creatorChannelId;
    all[guildId].categoryId = categoryId;
    all[guildId].controlChannelId = controlChannelId;
    save(all);
    return all[guildId];
}

/**
 * Store controlMessageId (the posted global panel message).
 * Used to edit (refresh) the same panel when something changes.
 */
function setControlMessageId(guildId, messageId) {
    const all = load();
    if (!all[guildId]) all[guildId] = { channels: {} };
    all[guildId].controlMessageId = messageId;
    save(all);
    return all[guildId];
}

function getControlChannelId(guildId) {
    const cfg = getGuildConfig(guildId);
    return cfg?.controlChannelId || null;
}

function getControlMessageId(guildId) {
    const cfg = getGuildConfig(guildId);
    return cfg?.controlMessageId || null;
}

/**
 * v3.8.2: Set the owner currently focused in the global panel.
 * Used when an owner picks their channel via the switch select menu.
 * The global panel will show the channels owned by focusedOwnerId.
 *
 * @param {string} guildId
 * @param {string} ownerId - userId of the focused owner (null = reset to the most recent default)
 */
function setFocusedOwner(guildId, ownerId) {
    const all = load();
    if (!all[guildId]) all[guildId] = { channels: {} };
    all[guildId].focusedOwnerId = ownerId || null;
    all[guildId].focusedAt = Date.now();
    save(all);
    return all[guildId];
}

function getFocusedOwner(guildId) {
    const cfg = getGuildConfig(guildId);
    if (!cfg?.focusedOwnerId) return null;
    // Auto-expire after 5 minutes if the owner is no longer in voice
    if (cfg.focusedAt && Date.now() - cfg.focusedAt > 5 * 60 * 1000) {
        return null;
    }
    return cfg.focusedOwnerId;
}

function clearFocusedOwner(guildId) {
    const all = load();
    if (all[guildId]) {
        delete all[guildId].focusedOwnerId;
        delete all[guildId].focusedAt;
        save(all);
    }
}

/**
 * Remove the temp voice setup for a guild.
 */
function removeGuild(guildId) {
    const all = load();
    if (all[guildId]) {
        delete all[guildId];
        save(all);
        return true;
    }
    return false;
}

function getGuildConfig(guildId) {
    const all = load();
    return all[guildId] || null;
}

function getCreatorChannelId(guildId) {
    const cfg = getGuildConfig(guildId);
    return cfg?.creatorChannelId || null;
}

/**
 * Register a new voice channel owned by a user.
 */
function registerChannel(guildId, channelId, ownerId, ownerTag, name) {
    const all = load();
    if (!all[guildId]) all[guildId] = { channels: {} };
    if (!all[guildId].channels) all[guildId].channels = {};
    all[guildId].channels[channelId] = {
        ownerId,
        ownerTag,
        createdAt: Date.now(),
        locked: false,
        limit: 0,
        name
    };
    save(all);
    return all[guildId].channels[channelId];
}

/**
 * Remove a channel from the registry (when the channel is deleted).
 */
function unregisterChannel(guildId, channelId) {
    const all = load();
    if (!all[guildId] || !all[guildId].channels) return false;
    if (all[guildId].channels[channelId]) {
        delete all[guildId].channels[channelId];
        save(all);
        return true;
    }
    return false;
}

function getChannel(guildId, channelId) {
    const cfg = getGuildConfig(guildId);
    return cfg?.channels?.[channelId] || null;
}

/**
 * Update channel fields (locked, limit, name, ownerId).
 * v3.9.8 FIX: whitelist of fields that may be updated. Before it used Object.assign
 * which blindly merged any key — a caller could overwrite createdAt, inject odd fields,
 * or (with a caller bug) corrupt the entry structure.
 */
function updateChannel(guildId, channelId, updates) {
    const all = load();
    if (!all[guildId]?.channels?.[channelId]) return null;
    const ALLOWED_FIELDS = ['locked', 'limit', 'name', 'ownerId', 'ownerTag'];
    const target = all[guildId].channels[channelId];
    for (const k of ALLOWED_FIELDS) {
        if (k in updates) {
            target[k] = updates[k];
        }
    }
    save(all);
    return target;
}

/**
 * Transfer ownership to a new member.
 */
function transferOwnership(guildId, channelId, newOwnerId, newOwnerTag) {
    return updateChannel(guildId, channelId, {
        ownerId: newOwnerId,
        ownerTag: newOwnerTag
    });
}

/**
 * Check whether a user owns a specific channel.
 */
function isOwner(guildId, channelId, userId) {
    const ch = getChannel(guildId, channelId);
    return ch?.ownerId === userId;
}

/**
 * Find the temp voice channel owned by a specific user in a guild.
 * Returns the channelId or null.
 */
function findChannelByOwner(guildId, userId) {
    const cfg = getGuildConfig(guildId);
    if (!cfg?.channels) return null;
    for (const [channelId, info] of Object.entries(cfg.channels)) {
        if (info.ownerId === userId) return channelId;
    }
    return null;
}

/**
 * v3.9.8: Reconcile the registry with the real state in Discord.
 *
 * Why this is needed:
 *   - Bot crashes after guild.channels.create but before registerChannel →
 *     the Discord channel exists but isn't in tempVoice.json → an orphan forever.
 *   - An admin deletes a channel manually without the bot → the registry entry stays
 *     (zombie) → refreshGlobalControlPanel shows an entry for a missing channel.
 *   - A channel is moved out of the temp voice category by an admin →
 *     not an orphan, but it should be unregistered so the panel stays clean.
 *
 * Logic:
 *   - For every registry entry: if the channel doesn't exist in the guild (cache),
 *     unregister it (zombie cleanup).
 *   - For every voice channel in the temp voice category that is NOT in the
 *     registry: skip (don't auto-register — we don't know who the owner is).
 *     Just log a warning so the admin is aware of orphan channels.
 *
 * @param {Client} client
 * @param {string} guildId
 * @returns {{ zombiesRemoved: number, orphansDetected: number }}
 */
function reconcileGuild(client, guildId) {
    const result = { zombiesRemoved: 0, orphansDetected: 0 };
    const cfg = getGuildConfig(guildId);
    if (!cfg?.channels) return result;

    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) return result;

    // 1. Clean up zombie entries (the channel no longer exists in Discord).
    // Batch delete so there's only 1 load + 1 save per reconcile. Previously unregisterChannel
    // was called per zombie → N load+save cycles. For a bot that was offline a long time + many
    // deleted channels, that was slow & wasteful I/O.
    const zombieIds = [];
    for (const channelId of Object.keys(cfg.channels)) {
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            zombieIds.push(channelId);
        }
    }
    if (zombieIds.length > 0) {
        const all = load();
        if (all[guildId] && all[guildId].channels) {
            for (const id of zombieIds) {
                delete all[guildId].channels[id];
            }
            save(all);
        }
        result.zombiesRemoved = zombieIds.length;
        for (const id of zombieIds) {
            console.log(`🧹 tempVoice reconcile: zombie entry ${id} removed (channel no longer exists).`);
        }
    }

    // 2. Detect orphan channels (voice channel in the category but not in the registry)
    if (cfg.categoryId) {
        const knownChannelIds = new Set(Object.keys(getGuildConfig(guildId)?.channels || {}));
        const category = guild.channels.cache.get(cfg.categoryId);
        if (category) {
            for (const [, ch] of category.children?.cache || []) {
                if (ch.type === 2 /* GuildVoice */ && !knownChannelIds.has(ch.id)) {
                    // Skip if this is the creator (trigger) channel
                    if (ch.id === cfg.creatorChannelId) continue;
                    result.orphansDetected++;
                    console.warn(
                        `⚠️ tempVoice reconcile: orphan voice channel ${ch.name} (${ch.id}) detected in the temp voice category — no owner. Delete it manually or via /tempvoice-remove.`
                    );
                }
            }
        }
    }

    return result;
}

module.exports = {
    setupGuild,
    removeGuild,
    getGuildConfig,
    getCreatorChannelId,
    setControlMessageId,
    getControlChannelId,
    getControlMessageId,
    // v3.8.5: focused owner functions kept for backward compat (data migration) but no longer used
    setFocusedOwner,
    getFocusedOwner,
    clearFocusedOwner,
    registerChannel,
    unregisterChannel,
    getChannel,
    updateChannel,
    transferOwnership,
    isOwner,
    findChannelByOwner,
    reconcileGuild
};
