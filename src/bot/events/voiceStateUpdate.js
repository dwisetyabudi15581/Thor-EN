/**
 * VoiceStateUpdate handler — manages temp voice channels.
 *
 * Logic:
 *   1. Member joins the "🔊 Create Voice" trigger channel → create a new voice channel, move the member there.
 *   2. Member joins/leaves a temp voice channel → refresh the global panel.
 *   3. Member leaves a temp voice channel:
 *      a. If the owner leaves & other members remain → auto-transfer ownership.
 *      b. If the channel is empty → delete it + refresh the panel.
 *
 * v3.9.8 FIX:
 *   - Skip bot accounts (previously a music bot could trigger orphan voice channels).
 *   - GRANT the new owner FIRST, then REVOKE the old owner (prevents ownerless channels).
 *   - registerChannel wrapped in try/catch (prevents orphan Discord channels on file write failure).
 *   - setChannel failure → clean up the orphan channel.
 *
 * v3.9.38 FIX:
 *   - Events from BOTS are no longer skipped entirely. Previously, the early return
 *     at the top meant an empty temp voice channel was NEVER cleaned up when a
 *     music bot left LAST (the owner had already gone, the transfer was skipped
 *     because the only remaining member was a bot) → orphan channel + an entry
 *     stuck forever in tempVoice.json. Bot path: skip create/transfer/panel, but
 *     still run the empty-channel cleanup for oldChannel (see handleBotLeaveTempVoice).
 */

const { Events, PermissionFlagsBits, ChannelType } = require('discord.js');
const tempVoiceManager = require('../../data/tempVoiceManager');

async function onVoiceStateUpdate(oldState, newState) {
    try {
        if (!newState.guild) return;
        // v3.9.26 (single-guild hardening): ignore voice events from other guilds —
        // without this, a member of a second guild joining the trigger channel would
        // register a temp voice into the second guild's tempVoice.json (stray data).
        if (process.env.GUILD_ID && newState.guild.id !== process.env.GUILD_ID) return;

        const guildId = newState.guild.id;
        const userId = newState.id;

        // v3.9.38 FIX: BOT events are no longer bluntly skipped. Bots skip the
        // create/transfer/panel logic, BUT the empty-channel cleanup still runs
        // for oldChannel — a music bot leaving last no longer leaves behind an
        // orphan channel registered forever in tempVoice.json.
        if (newState.member?.user?.bot) {
            await handleBotLeaveTempVoice(oldState, newState, guildId);
            return;
        }

        const creatorChannelId = tempVoiceManager.getCreatorChannelId(guildId);
        if (!creatorChannelId) return;

        const oldChannelId = oldState.channelId;
        const newChannelId = newState.channelId;

        // CASE 1: Member joins the trigger channel → create a new voice channel
        if (newChannelId === creatorChannelId && oldChannelId !== creatorChannelId) {
            await handleCreateTempVoice(newState);
            return;
        }

        // CASE 2: Member joins/leaves a temp voice channel → refresh the global panel
        if (oldChannelId !== newChannelId) {
            const involvedTempVoice =
                (oldChannelId && tempVoiceManager.getChannel(guildId, oldChannelId)) ||
                (newChannelId && tempVoiceManager.getChannel(guildId, newChannelId));
            if (involvedTempVoice) {
                await refreshGlobalControlPanel(newState.client, guildId);
            }
        }

        // CASE 3: Member leaves a temp voice channel
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

                // v3.9.38 FIX: the "delete empty channel" block was extracted
                // into cleanupEmptyTempChannel so it can also be used by the BOT
                // path (handleBotLeaveTempVoice) — identical logic to the old code.
                await cleanupEmptyTempChannel(newState.guild, guildId, oldChannelId);
                await refreshGlobalControlPanel(newState.client, guildId);
            }
        }
    } catch (err) {
        console.error('VoiceStateUpdate Error:', err.message);
    }
}

/**
 * v3.9.38 FIX: dedicated path for BOT events (e.g. music bot disconnect/leave).
 * Mirror of the human CASE 3 path, WITHOUT ownership transfer (bots never become
 * the owner): if oldChannel is registered in tempVoiceManager and is now
 * truly empty → delete the channel + unregister + refresh the panel.
 * Fixed scenario: the owner leaves first (transfer skipped — only a bot left),
 * the music bot leaves last → the empty channel never gets deleted.
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
 * v3.9.38 FIX: extracted the "delete a temp voice channel if empty" block from CASE 3
 * into a helper — used by both the human path AND the BOT path (handleBotLeaveTempVoice).
 * Semantics identical to the old code: the channel must exist in the guild cache &
 * members.size === 0. Discord-code-aware error handling stays the same.
 */
async function cleanupEmptyTempChannel(guild, guildId, channelId) {
    const oldChannel = guild.channels.cache.get(channelId);
    if (!oldChannel || oldChannel.members.size !== 0) return;
    try {
        await oldChannel.delete('Temp voice empty');
        tempVoiceManager.unregisterChannel(guildId, channelId);
        console.log(`🎤 Temp voice ${channelId} deleted (empty).`);
    } catch (err) {
        // Distinguish Discord errors (numeric code) from non-Discord errors.
        // err.code undefined = non-Discord error (TypeError, RangeError, etc)
        if (err.code === 10003) {
            // Unknown Channel — already deleted previously, safe to unregister
            tempVoiceManager.unregisterChannel(guildId, channelId);
        } else if (typeof err.code === 'number') {
            // Other Discord error (50013 Missing Permissions, 50001 Missing Access, etc).
            // The channel still exists on Discord but the bot can't delete it. Do NOT unregister —
            // it can be retried later. Log a warning so the admin knows there's a stuck channel.
            console.warn(
                `⚠️ Failed to delete temp voice ${channelId} (Discord code ${err.code}). Channel still exists, the bot lacks permission. Entry kept for retry.`
            );
        } else {
            console.error(`❌ Non-Discord error while deleting temp voice ${channelId}:`, err);
            // For non-Discord errors, unregister too so it doesn't get stuck in a loop
            tempVoiceManager.unregisterChannel(guildId, channelId);
        }
    }
}

/**
 * Auto-transfer ownership when the owner leaves the voice channel.
 * Picks the member with the earliest joinedAt (most senior).
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

        // v3.9.8: GRANT the new owner FIRST, then REVOKE the old owner.
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
            console.warn(`⚠️ Failed to update permissions during auto-transfer: ${err.message}`);
            return;
        }

        tempVoiceManager.transferOwnership(guildId, channelId, newOwner.id, newOwner.user.tag);

        // v3.9.42: notify the new owner via the voice channel's TEXT CHAT (not a DM) — user request.
        // Reason: DMs often don't arrive (user DMs closed) / go unread; via the channel
        // chat the message is guaranteed visible to everyone inside, and the new-owner
        // mention keeps a ping notification.
        try {
            await voiceChannel.send(
                `🎁 <@${newOwner.id}> **You are now the owner of voice channel: ${voiceChannel.name}**\n\n` +
                    `Ownership was automatically transferred to you because the previous owner (<@${oldOwnerId}>) left the voice channel.\n\n` +
                    `🎛️ You can control this channel via the global temp voice panel in the server.`
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
 * Handle a member joining the trigger channel → create a new voice channel.
 *
 * v3.9.17 FIX: added a per-user lock. Previously, network jitter/Gateway retry
 * could fire 2 voiceStateUpdate events for the same user within <100ms. Both
 * events passed `findChannelByOwner` (returns null because the channel isn't registered yet)
 * → both called `guild.channels.create` → 2 channels created, 1 becoming an orphan.
 * Now: lock per-(guildId,userId) at the start, release in finally.
 */
const tempVoiceCreateLocks = new Map();

async function handleCreateTempVoice(newState) {
    const guild = newState.guild;
    const member = newState.member;
    const lockKey = `${guild.id}:${member.id}`;

    // v3.9.17: check the lock first — if it's currently being processed, skip.
    if (tempVoiceCreateLocks.has(lockKey)) {
        return;
    }
    tempVoiceCreateLocks.set(lockKey, true);

    try {
        const config = tempVoiceManager.getGuildConfig(guild.id);
        if (!config?.categoryId) {
            console.warn('⚠️ Temp voice config has no categoryId.');
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
                console.log(`🧹 Temp voice orphan ${existingChannelId} removed (channel no longer exists).`);
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
                `❌ Failed to register temp voice ${newChannel.id}, deleting the channel to prevent an orphan:`,
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
            console.warn(`⚠️ Failed to move member to the new channel: ${err.message}. Cleaning up orphan channel.`);
            try {
                await newChannel.delete('SetChannel failed — cleanup orphan');
            } catch (_) {}
            try {
                tempVoiceManager.unregisterChannel(guild.id, newChannel.id);
            } catch (_) {}
            return;
        }

        await refreshGlobalControlPanel(newState.client, guild.id);
        console.log(`🎤 Temp voice created: ${newChannel.name} (${newChannel.id}) by ${member.user.tag}`);
    } catch (err) {
        console.error('Error create temp voice:', err);
    } finally {
        // v3.9.17: make sure the lock is released even on error.
        tempVoiceCreateLocks.delete(lockKey);
    }
}

/**
 * Refresh the global control panel in the control channel.
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
                `⚠️ Global temp voice panel for guild ${guildId} not found. Run /setup-tempvoice again.`
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
            console.warn(`⚠️ Failed to refresh the global temp voice panel: ${err.message}`);
        });
    } catch (err) {
        console.warn('Failed to refresh global panel:', err.message);
    }
}

module.exports = {
    name: Events.VoiceStateUpdate,
    execute: onVoiceStateUpdate,
    // Export refreshGlobalControlPanel so interactionHandler can call it.
    refreshGlobalControlPanel
};
