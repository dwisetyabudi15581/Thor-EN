/**
 * Temp Voice Control Panel Builder — renders the embed + buttons for the GLOBAL control panel.
 *
 * v3.8.5: GLOBAL panel — shows a list of all active voice channels + control buttons.
 *   - Idle: shows info on how to create a voice channel
 *   - Active: shows the list of active voice channels + control buttons (Rename, Kick, Limit, Lock, Transfer, Delete, Info Room)
 *   - Creating a voice channel only works by joining the "🔊 Create Voice" trigger channel — there is no button on the panel
 *   - Info Room: shows voice room details (ephemeral)
 *   - Control buttons work via owner auto-detect
 *
 * Used by refreshGlobalControlPanel() in index.js.
 */

const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

/**
 * Build the select menu for kicking members (only those currently in the voice channel).
 */
function buildKickSelectMenu(voiceChannel, ownerId) {
    const options = [];
    if (voiceChannel?.members) {
        for (const [memberId, member] of voiceChannel.members) {
            if (memberId === ownerId) continue; // skip the owner
            options.push({
                label: member.user.tag.slice(0, 100),
                value: memberId,
                description: `Kick ${member.user.username} from the voice channel`
            });
        }
    }
    if (options.length === 0) {
        return null; // no members to kick
    }
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('tv_kick_select')
            .setPlaceholder('Select a member to kick...')
            .addOptions(options.slice(0, 25))
            .setMinValues(1)
            .setMaxValues(Math.min(options.length, 25))
    );
}

/**
 * Build the select menu for transferring ownership.
 */
function buildTransferSelectMenu(voiceChannel, ownerId) {
    const options = [];
    if (voiceChannel?.members) {
        for (const [memberId, member] of voiceChannel.members) {
            if (memberId === ownerId) continue; // skip the current owner
            options.push({
                label: member.user.tag.slice(0, 100),
                value: memberId,
                description: `Transfer ownership to ${member.user.username}`
            });
        }
    }
    if (options.length === 0) {
        return null;
    }
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('tv_transfer_select')
            .setPlaceholder('Select the new owner...')
            .addOptions(options.slice(0, 25))
            .setMinValues(1)
            .setMaxValues(1)
    );
}

/**
 * v3.8.5: Build the embed + components for the GLOBAL control panel.
 *
 * This panel is purely global — it shows all active voice channels without focusing on a specific owner.
 * The control buttons (Rename, Kick, Limit, etc) work via owner auto-detect
 * (the bot automatically detects which channel the user owns and is currently in).
 *
 * @param {Object} options - { activeOwners: [{channelId, channelInfo, voiceChannel}], guildName }
 * @returns {Object} { embed, components }
 */
function buildGlobalControlPanel(options = {}) {
    const { activeOwners = [], guildName = 'Server' } = options;

    if (activeOwners.length === 0) {
        // No active voice channels — idle view
        const embed = new EmbedBuilder()
            .setTitle('TEMP VOICE')
            .setDescription(
                'There are no active voice channels.\n\n' +
                    `Join the "🔊 Create Voice" channel to create your own private voice channel.`
            )
            .setColor(0x2c2f33)
            .setFooter({ text: `${guildName}` })
            .setTimestamp();

        return { embed, components: [] };
    }

    // v3.8.5: Sort activeOwners by createdAt desc (newest first)
    const sorted = [...activeOwners].sort((a, b) => (b.channelInfo.createdAt || 0) - (a.channelInfo.createdAt || 0));

    // Build description — list of active voice channels + button legend
    let description = `**Active Voice Channels (${sorted.length})**\n\n`;

    for (let i = 0; i < Math.min(sorted.length, 10); i++) {
        const o = sorted[i];
        const mc = o.voiceChannel?.members?.size || 0;
        const lockIcon = o.channelInfo.locked ? ' 🔒' : '';
        // Null check channelInfo.name (in case of corrupt data / migrated from an old format)
        const displayName = o.channelInfo.name || `Channel ${o.channelId || 'unknown'}`;
        description += `• ${displayName} — <@${o.channelInfo.ownerId}> (${mc}${lockIcon})\n`;
    }
    if (sorted.length > 10) {
        description += `• ... +${sorted.length - 10} more\n`;
    }

    description += `\n**Control Buttons:**\n`;
    description += `✏️ Rename — Change the channel name\n`;
    description += `🚫 Kick — Remove a member from the voice channel\n`;
    description += `👥 Limit — Set the member cap (0 = unlimited)\n`;
    description += `🔒 Lock — Lock/unlock joining\n`;
    description += `🔄 Transfer — Transfer ownership\n`;
    description += `🗑️ Delete — Delete the channel\n`;
    description += `ℹ️ Info Room — View voice room details`;

    const embed = new EmbedBuilder()
        .setTitle('TEMP VOICE')
        .setDescription(description)
        .setColor(0x2c2f33)
        .setFooter({ text: `${guildName}` })
        .setTimestamp();

    // Row 1: rename, kick, limit, lock
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tv_rename').setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('tv_kick').setLabel('Kick').setEmoji('🚫').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('tv_limit').setLabel('Limit').setEmoji('👥').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tv_lock').setLabel('Lock').setEmoji('🔒').setStyle(ButtonStyle.Secondary)
    );

    // Row 2: transfer, delete, info room
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tv_transfer')
            .setLabel('Transfer')
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('tv_delete').setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('tv_info').setLabel('Info Room').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary)
    );

    const components = [row1, row2];

    // v3.8.5: if there are multiple active voices, add an "Info Room" select menu
    // so the user can pick which channel's info to view
    if (sorted.length > 1) {
        const switchOptions = sorted.map(o => ({
            // Null check channelInfo.name (same as in the description)
            label: `${o.channelInfo.name || `Channel ${o.channelId}`}`.slice(0, 100),
            value: o.channelId,
            description: `Owner: ${o.channelInfo.ownerTag} (${o.voiceChannel?.members?.size || 0} member(s))`.slice(0, 100)
        }));
        const switchRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('tv_switch_select')
                .setPlaceholder('ℹ️ Select a channel to view its info...')
                .addOptions(switchOptions.slice(0, 25))
                .setMinValues(1)
                .setMaxValues(1)
        );
        components.push(switchRow);
    }

    return { embed, components };
}

/**
 * v3.8.5: Build the ephemeral room-info embed for a specific voice channel.
 * Called when the user clicks "Info Room" or selects a channel from the switch select.
 *
 * @param {Object} channelInfo - info from tempVoiceManager
 * @param {VoiceChannel} voiceChannel - Discord voice channel object
 * @param {string} guildName
 * @returns {Object} { embed }
 */
function buildInfoRoomEmbed(channelInfo, voiceChannel, guildName = 'Server') {
    const memberCount = voiceChannel?.members?.size || 0;
    const limitStr = channelInfo.limit === 0 ? 'Unlimited' : `${channelInfo.limit}`;
    const lockStr = channelInfo.locked ? 'Locked' : 'Open';
    const createdDate = channelInfo.createdAt ? `<t:${Math.floor(channelInfo.createdAt / 1000)}:R>` : '-';

    let memberList = '';
    if (voiceChannel?.members && voiceChannel.members.size > 0) {
        const members = [...voiceChannel.members.values()];
        for (const m of members) {
            const isOwner = m.id === channelInfo.ownerId;
            memberList += `${isOwner ? '👑' : '•'} <@${m.id}>${isOwner ? ' (Owner)' : ''}\n`;
        }
    } else {
        memberList = '-';
    }

    const embed = new EmbedBuilder()
        .setTitle(`${channelInfo.name}`)
        .setDescription(
            `👑 Owner: <@${channelInfo.ownerId}>\n` +
                `👥 Members: ${memberCount}${channelInfo.limit > 0 ? ` / ${channelInfo.limit}` : ''}\n` +
                `📊 Limit: ${limitStr}\n` +
                `🔒 Status: ${lockStr}\n` +
                `🕐 Created: ${createdDate}\n\n` +
                `**Members in voice:**\n${memberList}`
        )
        .setColor(channelInfo.locked ? 0xe67e22 : 0x57f287)
        .setFooter({ text: `${guildName}` })
        .setTimestamp();

    return { embed };
}

module.exports = {
    buildKickSelectMenu,
    buildTransferSelectMenu,
    buildGlobalControlPanel,
    buildInfoRoomEmbed
};
