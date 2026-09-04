/**
 * Temp voice domain handler — button/select `tv_*` & modal `tv_modal_*`.
 *
 * Di-ekstrak dari handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior dipertahankan apa adanya — hanya pindah file.
 *
 * CustomId yang ditangani:
 *   - tv_rename / tv_kick / tv_kick_select / tv_limit / tv_lock / tv_unlock /
 *     tv_transfer / tv_transfer_select / tv_delete / tv_info (button/select)
 *   - tv_modal_rename / tv_modal_limit (modal submit)
 *   - tv_switch_select / tv_channel_select (select menu)
 *
 * Helper `requireTempVoiceOwner`, `findAllOwnerVoiceChannels`,
 * `findOwnerVoiceChannel`, `showChannelSelectMenu`, serta semua
 * `handleTempVoice*` jadi LOCAL function di file ini.
 *
 * Router (src/interactions/index.js) sudah apply:
 *   - dedup (checkAndMark)
 *   - guard `replied/deferred`
 *   - cek tipe interaction (button/select/modal)
 *   - routing by customId prefix (tv_ / tv_modal_)
 * Jadi domain handler fokus ke logic-nya saja.
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
    // Note: Buat voice hanya via join trigger channel "🔊 Buat Voice", tidak ada button
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
 * Helper: cari SEMUA voice channel yang di-owner oleh interaction.user di guildnya.
 *
 * v3.8.3: support multiple channels per owner (mis. user owner 2 channel berbeda).
 * Return array of { guild, channel, channelInfo, channelId }.
 */
async function findAllOwnerVoiceChannels(interaction) {
    const userId = interaction.user.id;
    const results = [];

    // Cari di guild tempat interaction terjadi (lebih efisien dari scan semua guild)
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
 * v3.8.3: Helper untuk guard button control panel — AUTO-DETECT owner.
 *
 * Logic:
 *   1. Cari semua voice channel yang user owner-nya di guild ini
 *   2. Filter: hanya channel yang user sedang berada di dalamnya
 *   3. Kalau 0 channel → error "kamu tidak punya voice aktif"
 *   4. Kalau 1 channel → langsung return channel itu (auto-detect!)
 *   5. Kalau 2+ channel → return flag needSelect, handler harus tampilkan
 *      select menu pilih channel dulu
 *
 * Returns:
 *   - { ok: true, found } — 1 channel, siap eksekusi
 *   - { ok: false, needSelect: true, channels } — multiple channels, perlu pilih
 *   - { ok: false, reason } — error, tampilkan ke user
 */
async function requireTempVoiceOwner(interaction) {
    const allOwned = await findAllOwnerVoiceChannels(interaction);

    if (allOwned.length === 0) {
        return {
            ok: false,
            reason: '❌ Kamu tidak punya voice channel aktif. Klik **🎤 Buat Voice** dulu untuk bikin channel sendiri.'
        };
    }

    // Filter: channel yang user sedang berada di dalamnya
    const inVoice = allOwned.filter(o => o.channel.members.has(interaction.user.id));

    if (inVoice.length === 0) {
        // User owner channel tapi tidak ada di mana-mana → tampilkan list channel mereka
        const channelList = allOwned.map(o => `• ${o.channel}`).join('\n');
        return {
            ok: false,
            reason: `❌ Kamu harus berada di voice channel kamu untuk pakai kontrol ini.\n\nVoice channel milikmu:\n${channelList}\n\n💡 Join salah satu channel di atas, lalu klik tombol kontrol lagi.`
        };
    }

    if (inVoice.length === 1) {
        // AUTO-DETECT: 1 channel → langsung pakai
        return { ok: true, found: inVoice[0] };
    }

    // Multiple channels: perlu pilih dulu
    return { ok: false, needSelect: true, channels: inVoice };
}

/**
 * v3.8.3: Build select menu untuk pilih channel (kalau owner punya multiple channels).
 */
async function showChannelSelectMenu(interaction, channels, action) {
    try {
        const options = channels.map(o => ({
            label: o.channelInfo.name.slice(0, 100),
            value: `${action}:${o.channelId}`,
            description: `Kontrol ${o.channelInfo.name} (${o.channel.members.size} member)`.slice(0, 100)
        }));
        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('tv_channel_select')
                .setPlaceholder('Pilih channel yang ingin kamu kontrol...')
                .addOptions(options.slice(0, 25))
                .setMinValues(1)
                .setMaxValues(1)
        );
        const embed = new EmbedBuilder()
            .setTitle('🔄 PILIH CHANNEL')
            .setDescription('Kamu owner dari beberapa voice channel. Pilih channel yang ingin kamu kontrol:')
            .setColor(0x5865f2);
        return interaction.reply({ embeds: [embed], components: [selectRow], flags: MessageFlags.Ephemeral });
    } catch (err) {
        console.error('showChannelSelectMenu error:', err);
        await interaction.reply({ content: `❌ Gagal: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

/**
 * Button: tv_rename — buka modal input nama baru.
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
                    .setLabel('Nama baru channel')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder('mis. 🎮 Squad Santai')
                    .setMinLength(1)
                    .setMaxLength(95)
            )
        );
        return interaction.showModal(modal);
    } catch (err) {
        console.error('TempVoice rename modal error:', err);
        await interaction.reply({ content: `❌ Gagal: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

/**
 * Modal: tv_modal_rename — submit rename.
 */
async function handleTempVoiceRenameSubmit(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const newName = interaction.components[0]?.components?.[0]?.value?.trim() || '';
        if (!newName) {
            return safeEditReply(interaction, { content: '❌ Nama tidak boleh kosong.' });
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
            return safeEditReply(interaction, { content: `❌ Gagal rename: ${err.message}` });
        }

        tempVoiceManager.updateChannel(guild.id, channelId, { name: newName.slice(0, 100) });

        // v3.8.1: refresh panel global supaya nama baru ter-update
        if (typeof interaction.client.refreshGlobalControlPanel === 'function') {
            await interaction.client.refreshGlobalControlPanel(interaction.client, guild.id);
        }

        return safeEditReply(interaction, { content: `✅ Channel di-rename jadi: **${newName}**` });
    } catch (err) {
        console.error('TempVoice rename submit error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Gagal: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * Button: tv_kick — tampilkan select menu member untuk kick.
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
                content: '❌ Tidak ada member lain di voice kamu saat ini.',
                flags: MessageFlags.Ephemeral
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('🚫 KICK MEMBER')
            .setDescription('Pilih member yang ingin kamu keluarkan dari voice channel.')
            .setColor(0xed4245);

        return interaction.reply({ embeds: [embed], components: [selectMenu], flags: MessageFlags.Ephemeral });
    } catch (err) {
        console.error('TempVoice kick menu error:', err);
        await interaction.reply({ content: `❌ Gagal: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

/**
 * Select: tv_kick_select — eksekusi kick.
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
                failed.push(`<@${targetId}> — tidak ada di voice`);
                continue;
            }
            try {
                // Kick = pindahkan ke channel null (disconnect)
                await targetMember.voice.disconnect('Di-kick oleh owner temp voice');
                kicked.push(`<@${targetId}>`);
            } catch (err) {
                failed.push(`<@${targetId}> — ${err.message}`);
            }
        }

        let msg = `✅ Berhasil kick: ${kicked.join(', ') || '_(tidak ada)_'}`;
        if (failed.length > 0) {
            msg += `\n❌ Gagal: ${failed.join(', ')}`;
        }

        // v3.8.1: refresh panel global supaya member count ter-update
        if (typeof interaction.client.refreshGlobalControlPanel === 'function') {
            await interaction.client.refreshGlobalControlPanel(interaction.client, found.guild.id);
        }

        return safeEditReply(interaction, { content: msg });
    } catch (err) {
        console.error('TempVoice kick execute error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Gagal: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * Button: tv_limit — buka modal input limit.
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
        const modal = new ModalBuilder().setCustomId('tv_modal_limit').setTitle('👥 Atur Limit Member');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('limit_value')
                    .setLabel('Max member (0 = unlimited, max 99)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder('mis. 5 untuk squad, 0 untuk unlimited')
                    .setMinLength(1)
                    .setMaxLength(2)
            )
        );
        return interaction.showModal(modal);
    } catch (err) {
        console.error('TempVoice limit modal error:', err);
        await interaction.reply({ content: `❌ Gagal: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

/**
 * Modal: tv_modal_limit — submit limit.
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
            return safeEditReply(interaction, { content: `❌ Gagal atur limit: ${err.message}` });
        }

        tempVoiceManager.updateChannel(found.guild.id, found.channelId, { limit });

        // v3.8.1: refresh panel global supaya limit ter-update
        if (typeof interaction.client.refreshGlobalControlPanel === 'function') {
            await interaction.client.refreshGlobalControlPanel(interaction.client, found.guild.id);
        }

        const limitStr2 = limit === 0 ? 'unlimited' : `${limit} member`;
        return safeEditReply(interaction, { content: `✅ Limit diatur ke: **${limitStr2}**` });
    } catch (err) {
        console.error('TempVoice limit submit error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Gagal: ${err.message}` }).catch(() => {});
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
                // Untuk lock, kita bisa langsung proses semua channel (atau pilih satu).
                // Untuk simplicity, tampilkan select menu.
                await safeEditReply(interaction, {
                    content:
                        'Kamu owner beberapa channel. Gunakan switch select di panel global untuk fokus ke salah satu, lalu klik Lock/Unlock lagi.'
                });
                return;
            }
            return safeEditReply(interaction, { content: check.reason });
        }
        const found = check.found;
        const PFB = PermissionFlagsBits;
        // v3.8.5: toggle based on current state (panel hanya punya 1 tombol Lock)
        const willLock = !found.channelInfo.locked;

        try {
            // Lock = deny Connect untuk @everyone, Unlock = allow Connect
            await found.channel.permissionOverwrites.edit(found.guild.roles.everyone.id, {
                [PFB.Connect]: willLock ? false : true
            });
        } catch (err) {
            return safeEditReply(interaction, { content: `❌ Gagal ${willLock ? 'lock' : 'unlock'}: ${err.message}` });
        }

        tempVoiceManager.updateChannel(found.guild.id, found.channelId, { locked: willLock });

        // v3.8.1: refresh panel global supaya status lock ter-update
        if (typeof interaction.client.refreshGlobalControlPanel === 'function') {
            await interaction.client.refreshGlobalControlPanel(interaction.client, found.guild.id);
        }

        return safeEditReply(interaction, {
            content: willLock
                ? '🔒 Channel **terkunci**. Hanya owner yang bisa invite member (dengan mention/drag).'
                : '🔓 Channel **terbuka**. Member bisa join bebas.'
        });
    } catch (err) {
        console.error('TempVoice lock toggle error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Gagal: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * Button: tv_transfer — tampilkan select menu member untuk transfer ownership.
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
                content: '❌ Tidak ada member lain di voice kamu saat ini.',
                flags: MessageFlags.Ephemeral
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('🔄 TRANSFER OWNERSHIP')
            .setDescription('Pilih member yang akan menjadi owner baru. Kamu tidak akan jadi owner lagi setelah ini.')
            .setColor(0x5865f2);

        return interaction.reply({ embeds: [embed], components: [selectMenu], flags: MessageFlags.Ephemeral });
    } catch (err) {
        console.error('TempVoice transfer menu error:', err);
        await interaction.reply({ content: `❌ Gagal: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
}

/**
 * Select: tv_transfer_select — eksekusi transfer ownership.
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
            return safeEditReply(interaction, { content: '❌ Member tersebut sudah tidak ada di voice kamu.' });
        }

        const PFB = PermissionFlagsBits;

        // Update permission: lepas owner lama, beri owner baru
        // v3.9.8 FIX: GRANT owner baru DULU, baru REVOKE owner lama — supaya
        // kalau grant gagal (rate limit / network), channel tidak jadi ownerless.
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
            return safeEditReply(interaction, { content: `❌ Gagal update permission: ${err.message}` });
        }

        tempVoiceManager.transferOwnership(found.guild.id, found.channelId, newOwnerId, newOwner.user.tag);

        // v3.9.8 FIX: DM owner baru (konsisten dengan auto-transfer di index.js).
        // Sebelumnya owner baru gak diberi tahu → dia gak sadar dapat permission
        // manage channel sampai coba pakai panel.
        try {
            await newOwner.send(
                `🎁 **Kamu sekarang owner voice channel: ${found.channel.name}**\n\n` +
                    `Ownership dipindahkan ke kamu oleh <@${found.channelInfo.ownerId}>.\n\n` +
                    `🎛️ Kamu bisa kontrol channel ini lewat panel global temp voice.`
            );
        } catch (_) {}

        // v3.8.1: refresh panel global supaya owner baru ter-display
        if (typeof interaction.client.refreshGlobalControlPanel === 'function') {
            await interaction.client.refreshGlobalControlPanel(interaction.client, found.guild.id);
        }

        return safeEditReply(interaction, {
            content: `✅ Ownership dipindahkan ke <@${newOwnerId}>. Kamu tidak lagi owner channel ini.`
        });
    } catch (err) {
        console.error('TempVoice transfer execute error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Gagal: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * Button: tv_delete — hapus channel temp voice milik user.
 */
async function handleTempVoiceDelete(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const check = await requireTempVoiceOwner(interaction);
        if (!check.ok) {
            if (check.needSelect) {
                await safeEditReply(interaction, {
                    content:
                        'Kamu owner beberapa channel. Gunakan switch select di panel global untuk fokus ke salah satu, lalu klik Delete lagi.'
                });
                return;
            }
            return safeEditReply(interaction, { content: check.reason });
        }
        const found = check.found;

        try {
            await found.channel.delete('Dihapus oleh owner via control panel');
        } catch (err) {
            if (err.code !== 10003) {
                return safeEditReply(interaction, { content: `❌ Gagal hapus channel: ${err.message}` });
            }
        }
        tempVoiceManager.unregisterChannel(found.guild.id, found.channelId);

        // v3.8.1: refresh panel global supaya kembali ke tampilan idle
        if (typeof interaction.client.refreshGlobalControlPanel === 'function') {
            await interaction.client.refreshGlobalControlPanel(interaction.client, found.guild.id);
        }

        return safeEditReply(interaction, { content: '🗑️ Voice channel kamu berhasil dihapus.' });
    } catch (err) {
        console.error('TempVoice delete error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Gagal: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * v3.8.5: Button: tv_info — tampilkan info room voice (ephemeral).
 *
 * Logic:
 *   - Kalau user adalah owner → tampilkan info channel miliknya
 *   - Kalau user bukan owner tapi sedang di voice → tampilkan info voice yang sedang dia tinggali
 *   - Kalau user tidak di voice → tampilkan daftar semua voice aktif
 */
async function handleTempVoiceInfo(interaction) {
    try {
        if (!interaction.guild) {
            return interaction.reply({ content: '❌ Hanya bisa dipakai di server.', flags: MessageFlags.Ephemeral });
        }

        const config = tempVoiceManager.getGuildConfig(interaction.guild.id);

        if (!config?.channels || Object.keys(config.channels).length === 0) {
            return interaction.reply({
                content: '❌ Tidak ada voice channel aktif saat ini.',
                flags: MessageFlags.Ephemeral
            });
        }

        // Cek apakah user sedang di voice channel yang merupakan temp voice
        const userVoiceChannel = interaction.member?.voice?.channelId;
        if (userVoiceChannel) {
            const channelInfo = tempVoiceManager.getChannel(interaction.guild.id, userVoiceChannel);
            if (channelInfo) {
                // User sedang di temp voice → tampilkan info room-nya
                const voiceChannel = interaction.guild.channels.cache.get(userVoiceChannel);
                if (voiceChannel) {
                    const { embed } = buildInfoRoomEmbed(channelInfo, voiceChannel, interaction.guild.name);
                    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
                }
            }
        }

        // User tidak di temp voice → cek apakah user adalah owner dari channel manapun
        const allOwned = await findAllOwnerVoiceChannels(interaction);
        if (allOwned.length === 1) {
            // User punya 1 channel → tampilkan info
            const found = allOwned[0];
            const { embed } = buildInfoRoomEmbed(found.channelInfo, found.channel, interaction.guild.name);
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (allOwned.length > 1) {
            // User punya multiple channels → tampilkan select menu
            const options = allOwned.map(o => ({
                label: o.channelInfo.name.slice(0, 100),
                value: o.channelId,
                description: `Owner: ${o.channelInfo.ownerTag} (${o.channel.members.size} member)`.slice(0, 100)
            }));
            const selectRow = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('tv_switch_select')
                    .setPlaceholder('Pilih channel untuk lihat info...')
                    .addOptions(options.slice(0, 25))
                    .setMinValues(1)
                    .setMaxValues(1)
            );
            const embed = new EmbedBuilder()
                .setTitle('ℹ️ INFO ROOM')
                .setDescription('Kamu owner dari beberapa voice channel. Pilih channel yang ingin kamu lihat infonya:')
                .setColor(0x5865f2);
            return interaction.reply({ embeds: [embed], components: [selectRow], flags: MessageFlags.Ephemeral });
        }

        // User bukan owner dan tidak di temp voice → tampilkan daftar semua voice aktif
        const activeList = [];
        for (const [channelId, info] of Object.entries(config.channels)) {
            const vc = interaction.guild.channels.cache.get(channelId);
            if (vc) {
                const mc = vc.members.size;
                const limitPart = info.limit > 0 ? `/${info.limit}` : '';
                const lockIcon = info.locked ? ' 🔒' : '';
                activeList.push(`• **${info.name}** — <@${info.ownerId}> (${mc}${limitPart} member${lockIcon})`);
            }
        }

        if (activeList.length === 0) {
            return interaction.reply({
                content: '❌ Tidak ada voice channel aktif saat ini.',
                flags: MessageFlags.Ephemeral
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('ℹ️ INFO ROOM — DAFTAR VOICE AKTIF')
            .setDescription(
                `Kamu tidak sedang berada di temp voice.\n\n` +
                    `**Voice Channel Aktif (${activeList.length}):**\n${activeList.slice(0, 15).join('\n')}` +
                    (activeList.length > 15 ? `\n... dan ${activeList.length - 15} lainnya` : '') +
                    `\n\n💡 Join ke voice channel untuk melihat info room, atau gunakan dropdown di panel global.`
            )
            .setColor(0x5865f2);

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch (err) {
        console.error('TempVoice info error:', err);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction
                .reply({ content: `❌ Gagal: ${err.message}`, flags: MessageFlags.Ephemeral })
                .catch(() => {});
        }
    }
}

/**
 * v3.8.5: Select menu tv_switch_select — user pilih channel untuk lihat info room.
 *
 * Logic:
 *   - User pilih channelId dari dropdown
 *   - Tampilkan info room (ephemeral) untuk channel yang dipilih
 *   - Semua user bisa lihat info, bukan owner saja
 */
async function handleTempVoiceSwitchSelect(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!interaction.guild) {
            return safeEditReply(interaction, { content: '❌ Hanya bisa dipakai di server.' });
        }

        const selectedChannelId = interaction.values[0];
        const channelInfo = tempVoiceManager.getChannel(interaction.guild.id, selectedChannelId);

        if (!channelInfo) {
            return safeEditReply(interaction, { content: '❌ Channel tersebut sudah tidak aktif.' });
        }

        const voiceChannel = interaction.guild.channels.cache.get(selectedChannelId);
        if (!voiceChannel) {
            return safeEditReply(interaction, { content: '❌ Channel tidak ditemukan.' });
        }

        // Tampilkan info room (ephemeral)
        const { embed } = buildInfoRoomEmbed(channelInfo, voiceChannel, interaction.guild.name);

        return safeEditReply(interaction, { embeds: [embed] });
    } catch (err) {
        console.error('TempVoice switch select error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Gagal: ${err.message}` }).catch(() => {});
        }
    }
}

/**
 * v3.8.3: Select menu tv_channel_select — owner pilih channel mana yang dikontrol
 * kalau mereka owner multiple channels sekaligus.
 *
 * Format value: `${action}:${channelId}` (mis. "rename:123456789")
 * Setelah pilih, bot langsung eksekusi action untuk channel tsb.
 */
async function handleTempVoiceChannelSelect(interaction) {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!interaction.guild) {
            return safeEditReply(interaction, { content: '❌ Hanya bisa dipakai di server.' });
        }

        const value = interaction.values[0];
        const [action, channelId] = value.split(':');

        const channelInfo = tempVoiceManager.getChannel(interaction.guild.id, channelId);
        if (!channelInfo) {
            return safeEditReply(interaction, { content: '❌ Channel tersebut sudah tidak aktif.' });
        }

        // Validasi: user harus owner channel ini
        if (channelInfo.ownerId !== interaction.user.id) {
            return safeEditReply(interaction, { content: '❌ Kamu bukan owner channel itu.' });
        }

        const voiceChannel = interaction.guild.channels.cache.get(channelId);
        if (!voiceChannel) {
            return safeEditReply(interaction, { content: '❌ Channel tidak ditemukan.' });
        }

        // Eksekusi action yang diminta
        switch (action) {
            case 'rename': {
                // Untuk rename, kita perlu modal. Tapi karena sudah defer, tidak bisa showModal.
                // Solusi: minta user klik tombol Rename lagi sekarang (sudah auto-detect ke channel ini)
                // karena user sekarang sedang di salah satu channel mereka.
                // Atau: langsung pakai nama default.
                // Untuk UX lebih baik, kita beri petunjuk.
                return safeEditReply(interaction, {
                    content: `✅ Channel dipilih: **${channelInfo.name}**\n\n💡 Klik tombol **✏️ Rename** lagi di panel global untuk membuka modal rename. Bot akan otomatis deteksi channel ini karena kamu sedang ada di dalamnya.`
                });
            }
            case 'kick': {
                const selectMenu = buildKickSelectMenu(voiceChannel, channelInfo.ownerId);
                if (!selectMenu) {
                    return safeEditReply(interaction, { content: '❌ Tidak ada member lain di channel itu.' });
                }
                // Hapus reply ephemeral sebelumnya, kirim baru dengan select menu
                await safeEditReply(interaction, {
                    content: `🚫 Pilih member untuk di-kick dari **${channelInfo.name}**:`,
                    components: [selectMenu]
                });
                return;
            }
            case 'limit': {
                return safeEditReply(interaction, {
                    content: `✅ Channel dipilih: **${channelInfo.name}**\n\n💡 Klik tombol **👥 Limit** lagi di panel global untuk membuka modal input limit.`
                });
            }
            case 'transfer': {
                const selectMenu = buildTransferSelectMenu(voiceChannel, channelInfo.ownerId);
                if (!selectMenu) {
                    return safeEditReply(interaction, { content: '❌ Tidak ada member lain di channel itu.' });
                }
                await safeEditReply(interaction, {
                    content: `🔄 Pilih member baru untuk transfer ownership **${channelInfo.name}**:`,
                    components: [selectMenu]
                });
                return;
            }
            default:
                return safeEditReply(interaction, { content: `❌ Action tidak dikenal: ${action}` });
        }
    } catch (err) {
        console.error('TempVoice channel select error:', err);
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Gagal: ${err.message}` }).catch(() => {});
        }
    }
}
