/**
 * Temp Voice Manager — track temporary voice channels yang dibuat member.
 *
 * File: tempVoice.json
 * {
 *   "guildId": {
 *     "creatorChannelId": "123",   // voice channel trigger (member join → bikin baru)
 *     "categoryId": "456",         // kategori tempat channel baru dibuat
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
 * Cara kerja:
 *   1. Admin setup via /setup-tempvoice → bot buat kategori + trigger channel + control panel
 *   2. Member join trigger channel "🔊 Buat Voice" → bot bikin voice channel private untuk member
 *   3. Member jadi owner, otomatis dipindah ke channel baru
 *   4. Panel global di control channel menampilkan semua voice aktif + button kontrol
 *   5. Owner pakai button: rename, kick, limit, lock, transfer, delete, info room
 *   6. Saat owner leave dan channel kosong → bot hapus channel otomatis
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
        console.warn('⚠️ tempVoice.json rusak:', err.message);
        // v3.9.26: karantina file korup sebelum fallback (lihat safeWrite.js).
        quarantineCorruptFile(filePath);
        return {};
    }
}

// v3.9.0 FIX: atomic write via safeWriteJSON (tmp+rename) to prevent corruption on crash
function save(data) {
    safeWriteJSON(filePath, data);
}

/**
 * Setup temp voice untuk guild: simpan trigger channel + category + control channel.
 *
 * @param {string} guildId
 * @param {string} creatorChannelId - voice channel trigger (member join → bikin baru)
 * @param {string} categoryId - kategori tempat channel baru dibuat
 * @param {string} controlChannelId - text channel tempat panel kontrol global dipasang
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
 * Simpan controlMessageId (pesan panel global yang sudah dipasang).
 * Dipakai untuk edit panel yang sama (refresh) saat ada perubahan.
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
 * v3.8.2: Set owner yang sedang fokus di panel global.
 * Dipakai saat owner pilih channel mereka via switch select menu.
 * Panel global akan menampilkan channel milik focusedOwnerId.
 *
 * @param {string} guildId
 * @param {string} ownerId - userId owner yang sedang fokus (null = reset ke default terbaru)
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
    // Auto-expire setelah 5 menit kalau owner tidak ada di voice lagi
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
 * Hapus setup temp voice untuk guild.
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
 * Daftarkan channel voice baru milik user.
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
 * Hapus channel dari registry (saat channel dihapus).
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
 * Update field channel (locked, limit, name, ownerId).
 * v3.9.8 FIX: whitelist field yang boleh di-update. Sebelumnya pakai Object.assign
 * yang blindly merge any key — caller bisa overwrite createdAt, inject field aneh,
 * atau (kalau ada bug di caller) corrupt struktur entry.
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
 * Transfer ownership ke member baru.
 */
function transferOwnership(guildId, channelId, newOwnerId, newOwnerTag) {
    return updateChannel(guildId, channelId, {
        ownerId: newOwnerId,
        ownerTag: newOwnerTag
    });
}

/**
 * Cek apakah user adalah owner channel tertentu.
 */
function isOwner(guildId, channelId, userId) {
    const ch = getChannel(guildId, channelId);
    return ch?.ownerId === userId;
}

/**
 * Cari channel temp voice milik user tertentu di guild.
 * Returns channelId atau null.
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
 * v3.9.8: Reconcile registry dengan real state di Discord.
 *
 * Kenapa ini perlu:
 *   - Bot crash setelah guild.channels.create tapi sebelum registerChannel →
 *     channel Discord ada, tapi gak ada di tempVoice.json → orphan selamanya.
 *   - Admin hapus channel manual tanpa via bot → entry registry tetap ada
 *     (zombie) → refreshGlobalControlPanel tampil entry untuk channel hilang.
 *   - Channel dipindahkan keluar dari category temp voice oleh admin →
 *     bukan orphan tapi perlu di-unregister supaya panel bersih.
 *
 * Logic:
 *   - Untuk tiap entry di registry: kalau channel tidak ada di guild (cache),
 *     unregister (zombie cleanup).
 *   - Untuk tiap voice channel di category temp voice yang TIDAK ada di
 *     registry: skip (jangan auto-register — kita gak tau siapa ownernya).
 *     Hanya log warning supaya admin sadar ada channel orphan.
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

    // 1. Cleanup zombie entries (channel udah gak ada di Discord).
    // Batch delete biar cuma 1 load + 1 save per reconcile. Dulu unregisterChannel
    // dipanggil per zombie → N load+save cycles. Buat bot yang offline lama + banyak
    // channel terhapus, ini lambat & boros I/O.
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
            console.log(`🧹 tempVoice reconcile: zombie entry ${id} dihapus (channel tidak ada).`);
        }
    }

    // 2. Detect orphan channels (voice channel di category tapi gak ada di registry)
    if (cfg.categoryId) {
        const knownChannelIds = new Set(Object.keys(getGuildConfig(guildId)?.channels || {}));
        const category = guild.channels.cache.get(cfg.categoryId);
        if (category) {
            for (const [, ch] of category.children?.cache || []) {
                if (ch.type === 2 /* GuildVoice */ && !knownChannelIds.has(ch.id)) {
                    // Skip kalau ini creator channel (trigger)
                    if (ch.id === cfg.creatorChannelId) continue;
                    result.orphansDetected++;
                    console.warn(
                        `⚠️ tempVoice reconcile: orphan voice channel ${ch.name} (${ch.id}) terdeteksi di category temp voice — tidak ada owner. Hapus manual atau via /tempvoice-remove.`
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
