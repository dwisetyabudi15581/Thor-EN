/**
 * VoiceStateUpdate handler — manage temp voice channels.
 *
 * Logic:
 *   1. Member join trigger channel "🔊 Buat Voice" → bikin voice baru, pindahkan member.
 *   2. Member join/leave channel temp voice → refresh panel global.
 *   3. Member leave channel temp voice:
 *      a. Kalau owner leave & masih ada member lain → auto-transfer ownership.
 *      b. Kalau channel kosong → hapus + refresh panel.
 *
 * v3.9.8 FIX:
 *   - Skip bot account (sebelumnya music bot trigger orphan voice channel).
 *   - GRANT owner baru DULU, baru REVOKE owner lama (anti ownerless channel).
 *   - registerChannel di-wrap try/catch (anti orphan Discord channel on file write fail).
 *   - setChannel failure → cleanup orphan channel.
 *
 * v3.9.38 FIX:
 *   - Event dari BOT tidak lagi di-skip total. Sebelumnya early-return di awal
 *     bikin channel temp voice yang kosong TIDAK pernah di-cleanup kalau music
 *     bot keluar TERAKHIR (owner sudah pergi duluan, transfer di-skip karena
 *     member tersisa cuma bot) → channel orphan + entry menempel selamanya di
 *     tempVoice.json. Path bot: skip create/transfer/panel, tapi tetap jalankan
 *     cleanup channel kosong untuk oldChannel (lihat handleBotLeaveTempVoice).
 */

const { Events, PermissionFlagsBits, ChannelType } = require('discord.js');
const tempVoiceManager = require('../../data/tempVoiceManager');

async function onVoiceStateUpdate(oldState, newState) {
    try {
        if (!newState.guild) return;
        // v3.9.26 (single-guild hardening): abaikan voice event dari guild lain —
        // tanpa ini, member guild kedua yang join trigger channel akan bikin temp
        // voice ter-register ke tempVoice.json guild kedua (data nyasar).
        if (process.env.GUILD_ID && newState.guild.id !== process.env.GUILD_ID) return;

        const guildId = newState.guild.id;
        const userId = newState.id;

        // v3.9.38 FIX: event BOT tidak lagi di-skip mentah-mentah. Bot skip
        // create/transfer/panel logic, TAPI cleanup channel kosong tetap jalan
        // untuk oldChannel — music bot yang keluar terakhir tidak lagi meninggalkan
        // channel orphan yang terdaftar selamanya di tempVoice.json.
        if (newState.member?.user?.bot) {
            await handleBotLeaveTempVoice(oldState, newState, guildId);
            return;
        }

        const creatorChannelId = tempVoiceManager.getCreatorChannelId(guildId);
        if (!creatorChannelId) return;

        const oldChannelId = oldState.channelId;
        const newChannelId = newState.channelId;

        // CASE 1: Member join trigger channel → bikin voice baru
        if (newChannelId === creatorChannelId && oldChannelId !== creatorChannelId) {
            await handleCreateTempVoice(newState);
            return;
        }

        // CASE 2: Member join/leave channel temp voice → refresh panel global
        if (oldChannelId !== newChannelId) {
            const involvedTempVoice =
                (oldChannelId && tempVoiceManager.getChannel(guildId, oldChannelId)) ||
                (newChannelId && tempVoiceManager.getChannel(guildId, newChannelId));
            if (involvedTempVoice) {
                await refreshGlobalControlPanel(newState.client, guildId);
            }
        }

        // CASE 3: Member leave channel temp voice
        if (oldChannelId && oldChannelId !== newChannelId) {
            const channelInfo = tempVoiceManager.getChannel(guildId, oldChannelId);
            if (channelInfo) {
                const oldChannel = newState.guild.channels.cache.get(oldChannelId);

                if (channelInfo.ownerId === userId && oldChannel && oldChannel.members.size > 0) {
                    await handleAutoTransferOwnership(
                        newState.client,
                        guildId,
                        oldChannelId,
                        channelInfo,
                        oldChannel,
                        userId
                    );
                }

                // v3.9.38 FIX: blok "hapus channel kosong" di-extract ke
                // cleanupEmptyTempChannel supaya bisa dipakai juga oleh path BOT
                // (handleBotLeaveTempVoice) — logika identik dengan kode lama.
                await cleanupEmptyTempChannel(newState.guild, guildId, oldChannelId);
                await refreshGlobalControlPanel(newState.client, guildId);
            }
        }
    } catch (err) {
        console.error('VoiceStateUpdate Error:', err.message);
    }
}

/**
 * v3.9.38 FIX: path khusus event BOT (mis. music bot disconnect/leave).
 * Mirror dari CASE 3 path human, TANPA transfer ownership (bot tidak pernah
 * jadi owner): kalau oldChannel terdaftar di tempVoiceManager dan sekarang
 * benar-benar kosong → hapus channel + unregister + refresh panel.
 * Skenario yang difix: owner keluar duluan (transfer di-skip — tinggal bot),
 * music bot keluar terakhir → channel kosong tidak pernah kehapus.
 */
async function handleBotLeaveTempVoice(oldState, newState, guildId) {
    const oldChannelId = oldState.channelId;
    if (!oldChannelId || oldChannelId === newState.channelId) return;
    const channelInfo = tempVoiceManager.getChannel(guildId, oldChannelId);
    if (!channelInfo) return;
    await cleanupEmptyTempChannel(newState.guild, guildId, oldChannelId);
    await refreshGlobalControlPanel(newState.client, guildId);
}

/**
 * v3.9.38 FIX: extract blok "hapus channel temp voice kalau kosong" dari CASE 3
 * jadi helper — dipakai path human DAN path BOT (handleBotLeaveTempVoice).
 * Semantik identik dengan kode lama: channel harus ada di cache guild &
 * members.size === 0. Error handling Discord-code aware tetap sama.
 */
async function cleanupEmptyTempChannel(guild, guildId, channelId) {
    const oldChannel = guild.channels.cache.get(channelId);
    if (!oldChannel || oldChannel.members.size !== 0) return;
    try {
        await oldChannel.delete('Temp voice kosong');
        tempVoiceManager.unregisterChannel(guildId, channelId);
        console.log(`🎤 Temp voice ${channelId} dihapus (kosong).`);
    } catch (err) {
        // Bedain Discord error (numeric code) vs non-Discord error.
        // err.code undefined = non-Discord error (TypeError, RangeError, dll)
        if (err.code === 10003) {
            // Unknown Channel — udah ke-delete sebelumnya, aman buat unregister
            tempVoiceManager.unregisterChannel(guildId, channelId);
        } else if (typeof err.code === 'number') {
            // Discord error lain (50013 Missing Permissions, 50001 Missing Access, dst).
            // Channel masih ada di Discord tapi bot gak bisa hapus. JANGAN unregister —
            // nanti bisa di-retry. Log warning biar admin tau ada channel stuck.
            console.warn(
                `⚠️ Gagal hapus temp voice ${channelId} (Discord code ${err.code}). Channel masih ada, bot gak punya permission. Entry tetap dipertahankan buat retry.`
            );
        } else {
            console.error(`❌ Non-Discord error saat hapus temp voice ${channelId}:`, err);
            // Untuk non-Discord error, uninstall juga biar gak stuck loop
            tempVoiceManager.unregisterChannel(guildId, channelId);
        }
    }
}

/**
 * Auto-transfer ownership saat owner leave voice channel.
 * Pilih member dengan joinedAt paling lama (paling senior).
 */
async function handleAutoTransferOwnership(client, guildId, channelId, channelInfo, voiceChannel, oldOwnerId) {
    try {
        const otherMembers = voiceChannel.members.filter(m => m.id !== oldOwnerId && !m.user.bot);
        if (otherMembers.size === 0) return;

        const sorted = [...otherMembers.values()].sort((a, b) => {
            const aTime = a.voice?.joinedTimestamp || a.joinedTimestamp || 0;
            const bTime = b.voice?.joinedTimestamp || b.joinedTimestamp || 0;
            return aTime - bTime;
        });
        const newOwner = sorted[0];
        if (!newOwner) return;

        // v3.9.8: GRANT owner baru DULU, baru REVOKE owner lama.
        try {
            await voiceChannel.permissionOverwrites.edit(newOwner.id, {
                [PermissionFlagsBits.ViewChannel]: true,
                [PermissionFlagsBits.Connect]: true,
                [PermissionFlagsBits.ManageChannels]: true,
                [PermissionFlagsBits.MoveMembers]: true,
                [PermissionFlagsBits.MuteMembers]: true,
                [PermissionFlagsBits.DeafenMembers]: true
            });
            await voiceChannel.permissionOverwrites.edit(oldOwnerId, {
                [PermissionFlagsBits.ManageChannels]: false,
                [PermissionFlagsBits.MoveMembers]: false,
                [PermissionFlagsBits.MuteMembers]: false,
                [PermissionFlagsBits.DeafenMembers]: false
            });
        } catch (err) {
            console.warn(`⚠️ Gagal update permission saat auto-transfer: ${err.message}`);
            return;
        }

        tempVoiceManager.transferOwnership(guildId, channelId, newOwner.id, newOwner.user.tag);

        try {
            await newOwner.send(
                `🎁 **Kamu sekarang owner voice channel: ${voiceChannel.name}**\n\n` +
                    `Ownership otomatis dipindahkan ke kamu karena owner sebelumnya (<@${oldOwnerId}>) keluar dari voice.\n\n` +
                    `🎛️ Kamu bisa kontrol channel ini lewat panel global temp voice di server.`
            );
        } catch (_) {}

        console.log(
            `🔄 Auto-transfer ownership channel ${channelId}: ${oldOwnerId} → ${newOwner.id} (${newOwner.user.tag})`
        );
    } catch (err) {
        console.error('Error auto-transfer ownership:', err.message);
    }
}

/**
 * Handle member join trigger channel → bikin voice baru.
 *
 * v3.9.17 FIX: tambah per-user lock. Sebelumnya, network jitter/Gateway retry
 * bisa fire 2 voiceStateUpdate event untuk user yang sama dalam <100ms. Kedua
 * event lolos `findChannelByOwner` (return null karena channel belum terdaftar)
 * → kedua-nya `guild.channels.create` → 2 channel terbuat, 1 jadi orphan.
 * Sekarang: lock per-(guildId,userId) di awal, release di finally.
 */
const tempVoiceCreateLocks = new Map();

async function handleCreateTempVoice(newState) {
    const guild = newState.guild;
    const member = newState.member;
    const lockKey = `${guild.id}:${member.id}`;

    // v3.9.17: cek lock dulu — kalau sedang diproses, skip.
    if (tempVoiceCreateLocks.has(lockKey)) {
        return;
    }
    tempVoiceCreateLocks.set(lockKey, true);

    try {
        const config = tempVoiceManager.getGuildConfig(guild.id);
        if (!config?.categoryId) {
            console.warn('⚠️ Temp voice config tidak ada categoryId.');
            return;
        }

        const existingChannelId = tempVoiceManager.findChannelByOwner(guild.id, member.id);
        if (existingChannelId) {
            const existingChannel = guild.channels.cache.get(existingChannelId);
            if (existingChannel) {
                try {
                    await member.voice.setChannel(existingChannelId);
                    return;
                } catch (_) {}
            } else {
                tempVoiceManager.unregisterChannel(guild.id, existingChannelId);
                console.log(`🧹 Temp voice orphan ${existingChannelId} dihapus (channel tidak ada).`);
            }
        }

        const channelName = `🔊 ${member.user.username}'s Room`;
        const newChannel = await guild.channels.create({
            name: channelName.slice(0, 100),
            type: ChannelType.GuildVoice,
            parent: config.categoryId,
            bitrate: 64000,
            permissionOverwrites: [
                { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
                {
                    id: member.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.Connect,
                        PermissionFlagsBits.ManageChannels,
                        PermissionFlagsBits.MoveMembers,
                        PermissionFlagsBits.MuteMembers,
                        PermissionFlagsBits.DeafenMembers
                    ]
                }
            ]
        });

        try {
            tempVoiceManager.registerChannel(guild.id, newChannel.id, member.id, member.user.tag, newChannel.name);
        } catch (regErr) {
            console.error(
                `❌ Gagal register temp voice ${newChannel.id}, hapus channel untuk cegah orphan:`,
                regErr.message
            );
            try {
                await newChannel.delete('Register failed — cleanup orphan');
            } catch (_) {}
            return;
        }

        try {
            await member.voice.setChannel(newChannel.id);
        } catch (err) {
            console.warn(`⚠️ Gagal pindahkan member ke channel baru: ${err.message}. Cleanup orphan channel.`);
            try {
                await newChannel.delete('SetChannel failed — cleanup orphan');
            } catch (_) {}
            try {
                tempVoiceManager.unregisterChannel(guild.id, newChannel.id);
            } catch (_) {}
            return;
        }

        await refreshGlobalControlPanel(newState.client, guild.id);
        console.log(`🎤 Temp voice dibuat: ${newChannel.name} (${newChannel.id}) oleh ${member.user.tag}`);
    } catch (err) {
        console.error('Error create temp voice:', err);
    } finally {
        // v3.9.17: pastikan lock dilepas walau ada error.
        tempVoiceCreateLocks.delete(lockKey);
    }
}

/**
 * Refresh panel kontrol global di control channel.
 */
async function refreshGlobalControlPanel(client, guildId) {
    try {
        const config = tempVoiceManager.getGuildConfig(guildId);
        if (!config?.controlChannelId || !config?.controlMessageId) return;

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;

        const controlChannel = guild.channels.cache.get(config.controlChannelId);
        if (!controlChannel) return;

        const panelMsg = await controlChannel.messages.fetch(config.controlMessageId).catch(() => null);
        if (!panelMsg) {
            console.warn(
                `⚠️ Panel global temp voice untuk guild ${guildId} tidak ditemukan. Jalankan /setup-tempvoice lagi.`
            );
            return;
        }

        const activeOwners = [];
        if (config.channels) {
            for (const [channelId, channelInfo] of Object.entries(config.channels)) {
                const voiceChannel = guild.channels.cache.get(channelId);
                if (voiceChannel) {
                    activeOwners.push({ channelId, channelInfo, voiceChannel });
                }
            }
            activeOwners.sort((a, b) => (b.channelInfo.createdAt || 0) - (a.channelInfo.createdAt || 0));
        }

        const { buildGlobalControlPanel } = require('../../ui/tempVoiceControlPanel');
        const { embed, components } = buildGlobalControlPanel({ activeOwners, guildName: guild.name });

        await panelMsg.edit({ embeds: [embed], components }).catch(err => {
            console.warn(`⚠️ Gagal refresh panel global temp voice: ${err.message}`);
        });
    } catch (err) {
        console.warn('Gagal refresh panel global:', err.message);
    }
}

module.exports = {
    name: Events.VoiceStateUpdate,
    execute: onVoiceStateUpdate,
    // Export refreshGlobalControlPanel supaya interactionHandler bisa panggil.
    refreshGlobalControlPanel
};
