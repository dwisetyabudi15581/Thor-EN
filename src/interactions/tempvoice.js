/**
 * Temp voice domain handler — button/select `tv_*` & modal `tv_modal_*`.
 *
 * Extracted from handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior preserved as-is — just moved to a new file.
 *
 * CustomIds handled:
 *   - tv_rename / tv_kick / tv_kick_select / tv_limit / tv_lock / tv_unlock /
 *     tv_transfer / tv_transfer_select / tv_delete / tv_info (button/select)
 *   - tv_modal_rename / tv_modal_limit (modal submit)
 *   - tv_switch_select / tv_channel_select (select menu)
 *
 * Helpers `requireTempVoiceOwner`, `findAllOwnerVoiceChannels`,
 * `findOwnerVoiceChannel`, `showChannelSelectMenu`, plus all the
 * `handleTempVoice*` functions are LOCAL to this file.
 *
 * The router (src/interactions/index.js) already applies:
 *   - dedup (checkAndMark)
 *   - `replied/deferred` guard
 *   - interaction type check (button/select/modal)
 *   - routing by customId prefix (tv_ / tv_modal_)
 * So the domain handler can focus on its logic alone.
 */

const {
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
    PermissionFlagsBits
} = require('discord.js');
const { safeEditReply } = require('../commands/_shared');
const tempVoiceManager = require('../data/tempVoiceManager');
const { buildKickSelectMenu, buildTransferSelectMenu, buildInfoRoomEmbed } = require('../ui/tempVoiceControlPanel');

module.exports = async function (interaction) {
    // ====================================================
    // === v3.8.5: TEMP VOICE — Button / Modal / Select handlers ===
    // Note: voice creation is only via the join trigger channel "🔊 Create Voice" — there is no create button
    // ====================================================
    if (interaction.isButton() && interaction.customId === 'tv_rename') {
        return handleTempVoiceRename(interaction);
    }
    if (interaction.isButton() && interaction.customId === 'tv_kick') {
        return handleTempVoiceKickMenu(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'tv_kick_select') {
        return handleTempVoiceKickExecute(interaction);
    }
    if (interaction.isButton() && interaction.customId === 'tv_limit') {
        return handleTempVoiceLimit(interaction);
    }
    if (interaction.isButton() && (interaction.customId === 'tv_lock' || interaction.customId === 'tv_unlock')) {
        return handleTempVoiceLockToggle(interaction);
    }
    if (interaction.isButton() && interaction.customId === 'tv_transfer') {
        return handleTempVoiceTransferMenu(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'tv_transfer_select') {
        return handleTempVoiceTransferExecute(interaction);
    }
    if (interaction.isButton() && interaction.customId === 'tv_delete') {
        return handleTempVoiceDelete(interaction);
    }
    if (interaction.isButton() && interaction.customId === 'tv_info') {
        return handleTempVoiceInfo(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'tv_modal_rename') {
        return handleTempVoiceRenameSubmit(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'tv_modal_limit') {
        return handleTempVoiceLimitSubmit(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'tv_switch_select') {
        return handleTempVoiceSwitchSelect(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'tv_channel_select') {
        return handleTempVoiceChannelSelect(interaction);
    }
};

// ====================================================
// === v3.8: TEMP VOICE — Helper functions ===
// ====================================================

/**
 * Helper: find ALL voice channels owned by interaction.user in their guild.
 *
 * v3.8.3: support multiple channels per owner (e.g. a user owning 2 different channels).
 * Returns an array of { guild, channel, channelInfo, channelId }.
 */
async function findAllOwnerVoiceChannels(interaction) {
    const userId = interaction.user.id;
    const results = [];

    // Search the guild where the interaction happened (more efficient than scanning every guild)
    if (interaction.guild) {
        const cfg = tempVoiceManager.getGuildConfig(interaction.guild.id);
        if (cfg?.channels) {
            for (const [channelId, info] of Object.entries(cfg.channels)) {
                if (info.ownerId === userId) {
                    const channel = interaction.guild.channels.cache.get(channelId);
                    if (channel) {
                        results.push({ guild: interaction.guild, channel, channelInfo: info, channelId });
                    }
                }
            }
        }
    }
    return results;
}

/**
 * v3.8.3: Helper for the control-panel button guard — AUTO-DETECT the owner.
 *
 * Logic:
 *   1. Find all voice channels this user owns in the guild
 *   2. Filter: only channels the user is currently inside
 *   3. If 0 channels → error "you have no active voice"
 *   4. If 1 channel → return that channel right away (auto-detect!)
 *   5. If 2+ channels → return the needSelect flag; the handler must show
 *      a channel-picker select menu first
 *
 * Returns:
 *   - { ok: true, found } — 1 channel, ready to execute
 *   - { ok: false, needSelect: true, channels } — multiple channels, user must pick
 *   - { ok: false, reason } — error, show it to the user
 */
async function requireTempVoiceOwner(interaction) {
    const allOwned = await findAllOwnerVoiceChannels(interaction);

    if (allOwned.length === 0) {
        return {
            ok: false,
            reason: '❌ You don\'t have an active voice channel. Click **🎤 Create Voice** first to make your own channel.'
        };
    }

    // Filter: only the channels the user is currently inside
    const inVoice = allOwned.filter(o => o.channel.members.has(interaction.user.id));

    if (inVoice.length === 0) {
        // User owns channels but isn't in any of them → show their channel list
        const channelList = allOwned.map(o => `• ${o.channel}`).join('\n');
        return {
            ok: false,
            reason: `❌ You must be in your voice channel to use these controls.\n\nYour voice channels:\n${channelList}\n\n💡 Join one of the channels above, then click the control button again.`
        };
    }

    if (inVoice.length === 1) {
        // AUTO-DETECT: 1 channel → use it directly
        return { ok: true, found: inVoice[0] };
    }

    // Multiple channels: user must pick one first
    return { ok: false, needSelect: true, channels: inVoice };
}

/**
 * v3.8.3: Build a select menu to pick a channel (when the owner has multiple channels).
 */
async function showChannelSelectMenu(interaction, channels, action) {
    try {
        const options = channels.map(o => ({
            label: o.channelInfo.name.slice(0, 100),
            value: `${action}:${o.channelId}`,
            description: `Control ${o.channelInfo.name} (${o.channel.members.size} members)`.slice(0, 100)
        }));
        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('tv_channel_select')
                .setPlaceholder('Select the channel you want to control...')
                .addOptions(options.slice(0, 25))
                .setMinValues(1)
                .setMaxValues(1)
        );
        const embed = new EmbedBuilder()
            .setTitle('🔄 SELECT CHANNEL')
            .setDescription('You own several voice channels. Select the channel you want to control:')
            .setColor(0x5865f2);
        return interaction.reply({ embeds: [embed], components: [selectRow], flags: MessageFlags.Ephemeral });
    } catch (err) {
        console.error('showChannelSelectMenu error:', err);
        await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

/**
 * Button: tv_rename — open the modal for a new name.
 */
async function handleTempVoiceRename(interaction) {
    try {
        // v3.8.3: auto-detect owner
        const check = await requireTempVoiceOwner(interaction);
        if (!check.ok) {
            if (check.needSelect) {
                return showChannelSelectMenu(interaction, check.channels, 'rename');
            }
            return interaction.reply({ content: check.reason, flags: MessageFlags.Ephemeral });
        }
        const modal = new ModalBuilder().setCustomId('tv_modal_rename').setTitle('✏️ Rename Voice Channel');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('new_name')
                    .setLabel('New channel name')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder('e.g. 🎮 Chill Squad')
                    .setMinLength(1)
                    .setMaxLength(95)
            )
        );
        return interaction.showModal(modal);
    } catch (err) {
        console.error('TempVoice rename modal error:', err);
        await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

/**
 * Modal: tv_modal_rename — rename submit.
 */
async function handleTempVoiceRenameSubmit(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const newName = interaction.components[0]?.components?.[0]?.value?.trim() || '';
        if (!newName) {
            return safeEditReply(interaction, { content: '❌ Name cannot be empty.' });
        }

        const check = await requireTempVoiceOwner(interaction);
        if (!check.ok) {
            return safeEditReply(interaction, { content: check.reason });
        }
        const found = check.found;
        const { guild, channel, channelId } = found;
        try {
            await channel.setName(newName.slice(0, 100));
        } catch (err) {
            return safeEditReply(interaction, { content: `❌ Failed to rename: ${err.message}` });
        }

        tempVoiceManager.updateChannel(guild.id, channelId, { name: newName.slice(0, 100) });

        // v3.8.1: refresh the global panel so the new name shows up
        if (typeof interaction.client.refreshGlobalControlPanel === 'function') {
            await interaction.client.refreshGlobalControlPanel(interaction.client, guild.id);
        }

        return safeEditReply(interaction, { content: `✅ Channel renamed to: **${newName}**` });
    } catch (err) {
        console.error('TempVoice rename submit error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Failed: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * Button: tv_kick — show the member select menu for kicking.
 */
async function handleTempVoiceKickMenu(interaction) {
    try {
        const check = await requireTempVoiceOwner(interaction);
        if (!check.ok) {
            if (check.needSelect) {
                return showChannelSelectMenu(interaction, check.channels, 'kick');
            }
            return interaction.reply({ content: check.reason, flags: MessageFlags.Ephemeral });
        }
        const found = check.found;
        const selectMenu = buildKickSelectMenu(found.channel, found.channelInfo.ownerId);
        if (!selectMenu) {
            return interaction.reply({
                content: '❌ There are no other members in your voice right now.',
                flags: MessageFlags.Ephemeral
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('🚫 KICK MEMBER')
            .setDescription('Select the member you want to remove from the voice channel.')
            .setColor(0xed4245);

        return interaction.reply({ embeds: [embed], components: [selectMenu], flags: MessageFlags.Ephemeral });
    } catch (err) {
        console.error('TempVoice kick menu error:', err);
        await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

/**
 * Select: tv_kick_select — execute the kick.
 */
async function handleTempVoiceKickExecute(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const check = await requireTempVoiceOwner(interaction);
        if (!check.ok) {
            return safeEditReply(interaction, { content: check.reason });
        }
        const found = check.found;

        const targetIds = interaction.values;
        const kicked = [];
        const failed = [];

        for (const targetId of targetIds) {
            const targetMember = found.channel.members.get(targetId);
            if (!targetMember) {
                failed.push(`<@${targetId}> — not in the voice channel`);
                continue;
            }
            try {
                // Kick = move to null channel (disconnect)
                await targetMember.voice.disconnect('Kicked by the temp voice owner');
                kicked.push(`<@${targetId}>`);
            } catch (err) {
                failed.push(`<@${targetId}> — ${err.message}`);
            }
        }

        let msg = `✅ Successfully kicked: ${kicked.join(', ') || '_(none)_'}`;
        if (failed.length > 0) {
            msg += `\n❌ Failed: ${failed.join(', ')}`;
        }

        // v3.8.1: refresh the global panel so the member count shows up
        if (typeof interaction.client.refreshGlobalControlPanel === 'function') {
            await interaction.client.refreshGlobalControlPanel(interaction.client, found.guild.id);
        }

        return safeEditReply(interaction, { content: msg });
    } catch (err) {
        console.error('TempVoice kick execute error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Failed: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * Button: tv_limit — open the modal for the limit.
 */
async function handleTempVoiceLimit(interaction) {
    try {
        const check = await requireTempVoiceOwner(interaction);
        if (!check.ok) {
            if (check.needSelect) {
                return showChannelSelectMenu(interaction, check.channels, 'limit');
            }
            return interaction.reply({ content: check.reason, flags: MessageFlags.Ephemeral });
        }
        const modal = new ModalBuilder().setCustomId('tv_modal_limit').setTitle('👥 Set Member Limit');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('limit_value')
                    .setLabel('Max members (0 = unlimited, max 99)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder('e.g. 5 for a squad, 0 for unlimited')
                    .setMinLength(1)
                    .setMaxLength(2)
            )
        );
        return interaction.showModal(modal);
    } catch (err) {
        console.error('TempVoice limit modal error:', err);
        await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

/**
 * Modal: tv_modal_limit — limit submit.
 */
async function handleTempVoiceLimitSubmit(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const limitStr = interaction.components[0]?.components?.[0]?.value?.trim() || '0';
        let limit = parseInt(limitStr, 10);
        if (isNaN(limit) || limit < 0) limit = 0;
        if (limit > 99) limit = 99;

        const check = await requireTempVoiceOwner(interaction);
        if (!check.ok) {
            return safeEditReply(interaction, { content: check.reason });
        }
        const found = check.found;

        try {
            await found.channel.setUserLimit(limit);
        } catch (err) {
            return safeEditReply(interaction, { content: `❌ Failed to set limit: ${err.message}` });
        }

        tempVoiceManager.updateChannel(found.guild.id, found.channelId, { limit });

        // v3.8.1: refresh the global panel so the limit shows up
        if (typeof interaction.client.refreshGlobalControlPanel === 'function') {
            await interaction.client.refreshGlobalControlPanel(interaction.client, found.guild.id);
        }

        const limitStr2 = limit === 0 ? 'unlimited' : `${limit} members`;
        return safeEditReply(interaction, { content: `✅ Limit set to: **${limitStr2}**` });
    } catch (err) {
        console.error('TempVoice limit submit error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Failed: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * Button: tv_lock — toggle lock/unlock channel.
 * v3.8.5: Single button, toggles based on current locked state.
 */
async function handleTempVoiceLockToggle(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const check = await requireTempVoiceOwner(interaction);
        if (!check.ok) {
            if (check.needSelect) {
                // For lock, we could process all channels at once (or pick one).
                // For simplicity, show a select menu.
                await safeEditReply(interaction, {
                    content:
                        'You own several channels. Use the switch select on the global panel to focus on one, then click Lock/Unlock again.'
                });
                return;
            }
            return safeEditReply(interaction, { content: check.reason });
        }
        const found = check.found;
        const PFB = PermissionFlagsBits;
        // v3.8.5: toggle based on current state (the panel only has one Lock button)
        const willLock = !found.channelInfo.locked;

        try {
            // Lock = deny Connect for @everyone, Unlock = allow Connect
            await found.channel.permissionOverwrites.edit(found.guild.roles.everyone.id, {
                [PFB.Connect]: willLock ? false : true
            });
        } catch (err) {
            return safeEditReply(interaction, { content: `❌ Failed to ${willLock ? 'lock' : 'unlock'}: ${err.message}` });
        }

        tempVoiceManager.updateChannel(found.guild.id, found.channelId, { locked: willLock });

        // v3.8.1: refresh the global panel so the lock status shows up
        if (typeof interaction.client.refreshGlobalControlPanel === 'function') {
            await interaction.client.refreshGlobalControlPanel(interaction.client, found.guild.id);
        }

        return safeEditReply(interaction, {
            content: willLock
                ? '🔒 Channel **locked**. Only the owner can invite members (via mention/drag).'
                : '🔓 Channel **unlocked**. Members can join freely.'
        });
    } catch (err) {
        console.error('TempVoice lock toggle error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Failed: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * Button: tv_transfer — show the member select menu for transferring ownership.
 */
async function handleTempVoiceTransferMenu(interaction) {
    try {
        const check = await requireTempVoiceOwner(interaction);
        if (!check.ok) {
            if (check.needSelect) {
                return showChannelSelectMenu(interaction, check.channels, 'transfer');
            }
            return interaction.reply({ content: check.reason, flags: MessageFlags.Ephemeral });
        }
        const found = check.found;
        const selectMenu = buildTransferSelectMenu(found.channel, found.channelInfo.ownerId);
        if (!selectMenu) {
            return interaction.reply({
                content: '❌ There are no other members in your voice right now.',
                flags: MessageFlags.Ephemeral
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('🔄 TRANSFER OWNERSHIP')
            .setDescription('Select the member who will become the new owner. You will no longer be the owner after this.')
            .setColor(0x5865f2);

        return interaction.reply({ embeds: [embed], components: [selectMenu], flags: MessageFlags.Ephemeral });
    } catch (err) {
        console.error('TempVoice transfer menu error:', err);
        await interaction.reply({ content: `❌ Failed: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

/**
 * Select: tv_transfer_select — execute the ownership transfer.
 */
async function handleTempVoiceTransferExecute(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const check = await requireTempVoiceOwner(interaction);
        if (!check.ok) {
            return safeEditReply(interaction, { content: check.reason });
        }
        const found = check.found;

        const newOwnerId = interaction.values[0];
        const newOwner = found.channel.members.get(newOwnerId);
        if (!newOwner) {
            return safeEditReply(interaction, { content: '❌ That member is no longer in your voice channel.' });
        }

        const PFB = PermissionFlagsBits;

        // Update permissions: revoke the old owner, grant the new owner
        // v3.9.8 FIX: GRANT the new owner FIRST, then REVOKE the old one — so that
        // if the grant fails (rate limit / network), the channel doesn't end up ownerless.
        try {
            await found.channel.permissionOverwrites.edit(newOwnerId, {
                [PFB.ViewChannel]: true,
                [PFB.Connect]: true,
                [PFB.ManageChannels]: true,
                [PFB.MoveMembers]: true,
                [PFB.MuteMembers]: true,
                [PFB.DeafenMembers]: true
            });
            await found.channel.permissionOverwrites.edit(found.channelInfo.ownerId, {
                [PFB.ManageChannels]: false,
                [PFB.MoveMembers]: false,
                [PFB.MuteMembers]: false,
                [PFB.DeafenMembers]: false
            });
        } catch (err) {
            return safeEditReply(interaction, { content: `❌ Failed to update permissions: ${err.message}` });
        }

        // Capture the OLD owner before the registry is overwritten by
        // transferOwnership — used in the notification message below (the
        // permission revoke above already read the old ownerId directly).
        const oldOwnerId = found.channelInfo.ownerId;

        tempVoiceManager.transferOwnership(found.guild.id, found.channelId, newOwnerId, newOwner.user.tag);

        // v3.9.8 FIX: the new owner gets notified (previously not notified at all).
        // v3.9.42: notify via the voice channel's TEXT CHAT (not a DM) — user request:
        // DMs often don't arrive (DMs closed / ignored) → announce it in the channel
        // chat itself, with a mention so the new owner still gets a ping.
        try {
            await found.channel.send(
                `🎁 <@${newOwnerId}> **You are now the owner of voice channel: ${found.channel.name}**\n\n` +
                    `Ownership was transferred to you by <@${oldOwnerId}>.\n\n` +
                    `🎛️ You can control this channel via the global temp voice panel.`
            );
        } catch (_) {}

        // v3.8.1: refresh the global panel so the new owner shows up
        if (typeof interaction.client.refreshGlobalControlPanel === 'function') {
            await interaction.client.refreshGlobalControlPanel(interaction.client, found.guild.id);
        }

        return safeEditReply(interaction, {
            content: `✅ Ownership transferred to <@${newOwnerId}>. You are no longer the owner of this channel.`
        });
    } catch (err) {
        console.error('TempVoice transfer execute error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Failed: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * Button: tv_delete — delete the user's temp voice channel.
 */
async function handleTempVoiceDelete(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const check = await requireTempVoiceOwner(interaction);
        if (!check.ok) {
            if (check.needSelect) {
                await safeEditReply(interaction, {
                    content:
                        'You own several channels. Use the switch select on the global panel to focus on one, then click Delete again.'
                });
                return;
            }
            return safeEditReply(interaction, { content: check.reason });
        }
        const found = check.found;

        try {
            await found.channel.delete('Deleted by the owner via the control panel');
        } catch (err) {
            if (err.code !== 10003) {
                return safeEditReply(interaction, { content: `❌ Failed to delete channel: ${err.message}` });
            }
        }
        tempVoiceManager.unregisterChannel(found.guild.id, found.channelId);

        // v3.8.1: refresh the global panel so it goes back to the idle view
        if (typeof interaction.client.refreshGlobalControlPanel === 'function') {
            await interaction.client.refreshGlobalControlPanel(interaction.client, found.guild.id);
        }

        return safeEditReply(interaction, { content: '🗑️ Your voice channel has been deleted.' });
    } catch (err) {
        console.error('TempVoice delete error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Failed: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * v3.8.5: Button: tv_info — show voice room info (ephemeral).
 *
 * Logic:
 *   - If the user is an owner → show info for their channel
 *   - If the user isn't an owner but is in a voice channel → show info for the room they're in
 *   - If the user isn't in voice → show a list of all active voice channels
 */
async function handleTempVoiceInfo(interaction) {
    try {
        if (!interaction.guild) {
            return interaction.reply({ content: '❌ This can only be used in a server.', flags: MessageFlags.Ephemeral });
        }

        const config = tempVoiceManager.getGuildConfig(interaction.guild.id);

        if (!config?.channels || Object.keys(config.channels).length === 0) {
            return interaction.reply({
                content: '❌ There are no active voice channels right now.',
                flags: MessageFlags.Ephemeral
            });
        }

        // Check whether the user is currently in a voice channel that is a temp voice
        const userVoiceChannel = interaction.member?.voice?.channelId;
        if (userVoiceChannel) {
            const channelInfo = tempVoiceManager.getChannel(interaction.guild.id, userVoiceChannel);
            if (channelInfo) {
                // User is in a temp voice → show the room info
                const voiceChannel = interaction.guild.channels.cache.get(userVoiceChannel);
                if (voiceChannel) {
                    const { embed } = buildInfoRoomEmbed(channelInfo, voiceChannel, interaction.guild.name);
                    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
                }
            }
        }

        // User isn't in a temp voice → check whether they own any channel
        const allOwned = await findAllOwnerVoiceChannels(interaction);
        if (allOwned.length === 1) {
            // User has 1 channel → show its info
            const found = allOwned[0];
            const { embed } = buildInfoRoomEmbed(found.channelInfo, found.channel, interaction.guild.name);
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (allOwned.length > 1) {
            // User has multiple channels → show a select menu
            const options = allOwned.map(o => ({
                label: o.channelInfo.name.slice(0, 100),
                value: o.channelId,
                description: `Owner: ${o.channelInfo.ownerTag} (${o.channel.members.size} members)`.slice(0, 100)
            }));
            const selectRow = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('tv_switch_select')
                    .setPlaceholder('Select a channel to view info...')
                    .addOptions(options.slice(0, 25))
                    .setMinValues(1)
                    .setMaxValues(1)
            );
            const embed = new EmbedBuilder()
                .setTitle('ℹ️ INFO ROOM')
                .setDescription('You own several voice channels. Select the channel whose info you want to see:')
                .setColor(0x5865f2);
            return interaction.reply({ embeds: [embed], components: [selectRow], flags: MessageFlags.Ephemeral });
        }

        // User isn't an owner and isn't in a temp voice → show a list of all active voice channels
        const activeList = [];
        for (const [channelId, info] of Object.entries(config.channels)) {
            const vc = interaction.guild.channels.cache.get(channelId);
            if (vc) {
                const mc = vc.members.size;
                const limitPart = info.limit > 0 ? `/${info.limit}` : '';
                const lockIcon = info.locked ? ' 🔒' : '';
                activeList.push(`• **${info.name}** — <@${info.ownerId}> (${mc}${limitPart} members${lockIcon})`);
            }
        }

        if (activeList.length === 0) {
            return interaction.reply({
                content: '❌ There are no active voice channels right now.',
                flags: MessageFlags.Ephemeral
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('ℹ️ INFO ROOM — ACTIVE VOICE LIST')
            .setDescription(
                `You are not currently in a temp voice.\n\n` +
                    `**Active Voice Channels (${activeList.length}):**\n${activeList.slice(0, 15).join('\n')}` +
                    (activeList.length > 15 ? `\n... and ${activeList.length - 15} more` : '') +
                    `\n\n💡 Join a voice channel to see room info, or use the dropdown on the global panel.`
            )
            .setColor(0x5865f2);

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch (err) {
        console.error('TempVoice info error:', err);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction
                .reply({ content: `❌ Failed: ${err.message}`, flags: MessageFlags.Ephemeral })
                .catch(() => {});
        }
    }
}

/**
 * v3.8.5: Select menu tv_switch_select — user picks a channel to view room info.
 *
 * Logic:
 *   - User picks a channelId from the dropdown
 *   - Show the room info (ephemeral) for the selected channel
 *   - Any user can view the info, not just owners
 */
async function handleTempVoiceSwitchSelect(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!interaction.guild) {
            return safeEditReply(interaction, { content: '❌ This can only be used in a server.' });
        }

        const selectedChannelId = interaction.values[0];
        const channelInfo = tempVoiceManager.getChannel(interaction.guild.id, selectedChannelId);

        if (!channelInfo) {
            return safeEditReply(interaction, { content: '❌ That channel is no longer active.' });
        }

        const voiceChannel = interaction.guild.channels.cache.get(selectedChannelId);
        if (!voiceChannel) {
            return safeEditReply(interaction, { content: '❌ Channel not found.' });
        }

        // Show the room info (ephemeral)
        const { embed } = buildInfoRoomEmbed(channelInfo, voiceChannel, interaction.guild.name);

        return safeEditReply(interaction, { embeds: [embed] });
    } catch (err) {
        console.error('TempVoice switch select error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Failed: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * v3.8.3: Select menu tv_channel_select — the owner picks which channel to control
 * when they own multiple channels at once.
 *
 * Value format: `${action}:${channelId}` (e.g. "rename:123456789")
 * After picking, the bot immediately executes the action for that channel.
 */
async function handleTempVoiceChannelSelect(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!interaction.guild) {
            return safeEditReply(interaction, { content: '❌ This can only be used in a server.' });
        }

        const value = interaction.values[0];
        const [action, channelId] = value.split(':');

        const channelInfo = tempVoiceManager.getChannel(interaction.guild.id, channelId);
        if (!channelInfo) {
            return safeEditReply(interaction, { content: '❌ That channel is no longer active.' });
        }

        // Validate: user must be the owner of this channel
        if (channelInfo.ownerId !== interaction.user.id) {
            return safeEditReply(interaction, { content: '❌ You are not the owner of that channel.' });
        }

        const voiceChannel = interaction.guild.channels.cache.get(channelId);
        if (!voiceChannel) {
            return safeEditReply(interaction, { content: '❌ Channel not found.' });
        }

        // Execute the requested action
        switch (action) {
            case 'rename': {
                // For rename we need a modal. But we've already deferred, so showModal is no longer possible.
                // Solution: ask the user to click the Rename button again (auto-detect will now target this
                // channel, since the user is currently inside one of their channels).
                // Alternative: fall back to a default name.
                // For better UX, we give guidance instead.
                return safeEditReply(interaction, {
                    content: `✅ Channel selected: **${channelInfo.name}**\n\n💡 Click the **✏️ Rename** button on the global panel again to open the rename modal. The bot will automatically detect this channel because you are currently inside it.`
                });
            }
            case 'kick': {
                const selectMenu = buildKickSelectMenu(voiceChannel, channelInfo.ownerId);
                if (!selectMenu) {
                    return safeEditReply(interaction, { content: '❌ There are no other members in that channel.' });
                }
                // Replace the previous ephemeral reply, send a new one with the select menu
                await safeEditReply(interaction, {
                    content: `🚫 Select a member to kick from **${channelInfo.name}**:`,
                    components: [selectMenu]
                });
                return;
            }
            case 'limit': {
                return safeEditReply(interaction, {
                    content: `✅ Channel selected: **${channelInfo.name}**\n\n💡 Click the **👥 Limit** button on the global panel again to open the limit input modal.`
                });
            }
            case 'transfer': {
                const selectMenu = buildTransferSelectMenu(voiceChannel, channelInfo.ownerId);
                if (!selectMenu) {
                    return safeEditReply(interaction, { content: '❌ There are no other members in that channel.' });
                }
                await safeEditReply(interaction, {
                    content: `🔄 Select the new owner for transfer of **${channelInfo.name}**:`,
                    components: [selectMenu]
                });
                return;
            }
            default:
                return safeEditReply(interaction, { content: `❌ Unknown action: ${action}` });
        }
    } catch (err) {
        console.error('TempVoice channel select error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Failed: ${err.message}` }).catch(() => {});
        }
    }
}
