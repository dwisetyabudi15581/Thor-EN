/**
 * Temp Voice Control Panel Builder — render embed + button untuk panel kontrol GLOBAL.
 *
 * v3.8.5: Panel GLOBAL — menampilkan daftar semua voice aktif + button kontrol.
 *   - Idle: tampilkan info cara buat voice
 *   - Active: tampilkan daftar voice aktif + button kontrol (Rename, Kick, Limit, Lock, Transfer, Delete, Info Room)
 *   - Buat voice hanya via join trigger channel "🔊 Buat Voice", tidak ada button di panel
 *   - Info Room: tampilkan detail voice room (ephemeral)
 *   - Control buttons bekerja via auto-detect owner
 *
 * Dipakai oleh refreshGlobalControlPanel() di index.js.
 */

const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

/**
 * Build select menu untuk kick member (hanya yang saat ini di voice).
 */
function buildKickSelectMenu(voiceChannel, ownerId) {
    const options = [];
    if (voiceChannel?.members) {
        for (const [memberId, member] of voiceChannel.members) {
            if (memberId === ownerId) continue; // skip owner
            options.push({
                label: member.user.tag.slice(0, 100),
                value: memberId,
                description: `Keluarkan ${member.user.username} dari voice`
            });
        }
    }
    if (options.length === 0) {
        return null; // tidak ada member untuk di-kick
    }
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('tv_kick_select')
            .setPlaceholder('Pilih member yang ingin di-kick...')
            .addOptions(options.slice(0, 25))
            .setMinValues(1)
            .setMaxValues(Math.min(options.length, 25))
    );
}

/**
 * Build select menu untuk transfer ownership.
 */
function buildTransferSelectMenu(voiceChannel, ownerId) {
    const options = [];
    if (voiceChannel?.members) {
        for (const [memberId, member] of voiceChannel.members) {
            if (memberId === ownerId) continue; // skip current owner
            options.push({
                label: member.user.tag.slice(0, 100),
                value: memberId,
                description: `Pindah ownership ke ${member.user.username}`
            });
        }
    }
    if (options.length === 0) {
        return null;
    }
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('tv_transfer_select')
            .setPlaceholder('Pilih member baru sebagai owner...')
            .addOptions(options.slice(0, 25))
            .setMinValues(1)
            .setMaxValues(1)
    );
}

/**
 * v3.8.5: Build embed + components untuk panel kontrol GLOBAL.
 *
 * Panel ini murni global — menampilkan daftar semua voice aktif tanpa fokus ke owner tertentu.
 * Control buttons (Rename, Kick, Limit, dll) bekerja via auto-detect owner
 * (bot otomatis deteksi channel mana yang user owner-inya dan sedang user tinggali).
 *
 * @param {Object} options - { activeOwners: [{channelId, channelInfo, voiceChannel}], guildName }
 * @returns {Object} { embed, components }
 */
function buildGlobalControlPanel(options = {}) {
    const { activeOwners = [], guildName = 'Server' } = options;

    if (activeOwners.length === 0) {
        // Tidak ada voice aktif — tampilan idle
        const embed = new EmbedBuilder()
            .setTitle('TEMP VOICE')
            .setDescription(
                'Tidak ada voice channel aktif.\n\n' +
                    `Join ke channel "🔊 Buat Voice" untuk membuat voice channel pribadi.`
            )
            .setColor(0x2c2f33)
            .setFooter({ text: `${guildName}` })
            .setTimestamp();

        return { embed, components: [] };
    }

    // v3.8.5: Sort activeOwners by createdAt desc (paling baru pertama)
    const sorted = [...activeOwners].sort((a, b) => (b.channelInfo.createdAt || 0) - (a.channelInfo.createdAt || 0));

    // Build description — daftar voice aktif + keterangan button
    let description = `**Voice Aktif (${sorted.length})**\n\n`;

    for (let i = 0; i < Math.min(sorted.length, 10); i++) {
        const o = sorted[i];
        const mc = o.voiceChannel?.members?.size || 0;
        const lockIcon = o.channelInfo.locked ? ' 🔒' : '';
        // Null check channelInfo.name (kalau data corrupt / migrated dari format lama)
        const displayName = o.channelInfo.name || `Channel ${o.channelId || 'unknown'}`;
        description += `• ${displayName} — <@${o.channelInfo.ownerId}> (${mc}${lockIcon})\n`;
    }
    if (sorted.length > 10) {
        description += `• ... +${sorted.length - 10} lainnya\n`;
    }

    description += `\n**Tombol Kontrol:**\n`;
    description += `✏️ Rename — Ubah nama channel\n`;
    description += `🚫 Kick — Keluarkan member dari voice\n`;
    description += `👥 Limit — Atur max member (0 = unlimited)\n`;
    description += `🔒 Lock — Kunci/buka akses join\n`;
    description += `🔄 Transfer — Pindah ownership\n`;
    description += `🗑️ Delete — Hapus channel\n`;
    description += `ℹ️ Info Room — Lihat detail voice room`;

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

    // v3.8.5: kalau ada multiple active voices, tambah select menu "Info Room"
    // supaya user bisa pilih channel mana yang ingin dilihat infonya
    if (sorted.length > 1) {
        const switchOptions = sorted.map(o => ({
            // Null check channelInfo.name (sama kayak di description)
            label: `${o.channelInfo.name || `Channel ${o.channelId}`}`.slice(0, 100),
            value: o.channelId,
            description: `Owner: ${o.channelInfo.ownerTag} (${o.voiceChannel?.members?.size || 0} member)`.slice(0, 100)
        }));
        const switchRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('tv_switch_select')
                .setPlaceholder('ℹ️ Pilih channel untuk lihat info...')
                .addOptions(switchOptions.slice(0, 25))
                .setMinValues(1)
                .setMaxValues(1)
        );
        components.push(switchRow);
    }

    return { embed, components };
}

/**
 * v3.8.5: Build ephemeral embed info room untuk voice channel tertentu.
 * Dipanggil saat user klik "Info Room" atau pilih channel dari switch select.
 *
 * @param {Object} channelInfo - info dari tempVoiceManager
 * @param {VoiceChannel} voiceChannel - Discord voice channel object
 * @param {string} guildName
 * @returns {Object} { embed }
 */
function buildInfoRoomEmbed(channelInfo, voiceChannel, guildName = 'Server') {
    const memberCount = voiceChannel?.members?.size || 0;
    const limitStr = channelInfo.limit === 0 ? 'Unlimited' : `${channelInfo.limit}`;
    const lockStr = channelInfo.locked ? 'Terkunci' : 'Terbuka';
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
                `👥 Member: ${memberCount}${channelInfo.limit > 0 ? ` / ${channelInfo.limit}` : ''}\n` +
                `📊 Limit: ${limitStr}\n` +
                `🔒 Status: ${lockStr}\n` +
                `🕐 Dibuat: ${createdDate}\n\n` +
                `**Member di voice:**\n${memberList}`
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
