/**
 * Domain: tempvoice
 * Slash commands: /setup-tempvoice, /tempvoice-remove
 *
 * Dipisah dari handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: setup kategori + trigger channel + control panel global temp voice,
 *           hapus setup (beserta kategori + semua channel terkait).
 *
 * v3.8.2: /setup-tempvoice tanpa parameter — auto-create kategori + 2 channel.
 * v3.9.8: rollback channel yang sudah dibuat kalau salah satu step gagal (mencegah orphan).
 */

const {
    MessageFlags,
    ChannelType,
    tempVoiceManager,
    buildGlobalControlPanel,
    logAudit,
    safeEditReply
} = require('./_shared');

module.exports = async function (interaction) {
    // ====================================================
    // === /setup-tempvoice ===
    // ====================================================
    // v3.8.2: /setup-tempvoice tanpa parameter.
    // Bot auto-create 1 kategori berisi:
    //   - 1 text channel "📋 control-panel" (tempat panel global dipasang)
    //   - 1 voice channel "🔊 Buat Voice" (trigger — member join untuk bikin voice baru)
    if (interaction.commandName === 'setup-tempvoice') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guild = interaction.guild;

        // Cek apakah sudah ada setup sebelumnya
        const existingConfig = tempVoiceManager.getGuildConfig(guild.id);

        // Kalau sudah ada setup, re-kirim panel ke control channel yang ada.
        if (existingConfig?.controlChannelId && existingConfig?.creatorChannelId) {
            const existingControlChannel = guild.channels.cache.get(existingConfig.controlChannelId);
            // Kalau control channel lama udah dihapus, jangan lanjut ke setup baru (bikin orphan).
            // Suruh admin cleanup dulu via /tempvoice-remove.
            if (!existingControlChannel) {
                return safeEditReply(interaction, {
                    content:
                        `❌ Control channel lama (ID: \`${existingConfig.controlChannelId}\`) sudah terhapus dari server.\n\n` +
                        `Jalankan \`/tempvoice-remove\` dulu untuk cleanup config lama, lalu \`/setup-tempvoice\` lagi.`
                });
            }
            // Hapus panel lama kalau ada
            if (existingConfig.controlMessageId) {
                try {
                    const oldMsg = await existingControlChannel.messages
                        .fetch(existingConfig.controlMessageId)
                        .catch(() => null);
                    if (oldMsg) await oldMsg.delete().catch(() => {});
                } catch (_) {}
            }
            // Kirim panel baru
            const { embed, components } = buildGlobalControlPanel({
                activeOwners: [],
                guildName: guild.name
            });
            const panelMsg = await existingControlChannel.send({ embeds: [embed], components }).catch(err => {
                console.warn('Gagal refresh panel temp voice:', err?.message || err);
                return null;
            });
            // Kalau send gagal, balas error — jangan lanjut ke setup baru (anti orphan)
            if (!panelMsg) {
                return safeEditReply(interaction, {
                    content:
                        `❌ Gagal refresh panel ke ${existingControlChannel}. Cek permission bot (**Send Messages** + **Embed Links**).\n\n` +
                        `Setup yang ada tidak diubah.`
                });
            }
            tempVoiceManager.setControlMessageId(guild.id, panelMsg.id);
            return safeEditReply(interaction, {
                content: `✅ **Panel temp voice di-refresh!**\n\n🎛️ ${panelMsg.url}\n\n💡 Setup yang sudah ada tetap dipakai (kategori + trigger + control channel).`
            });
        }

        // === Setup baru: bikin kategori + 2 channel ===
        // v3.9.8 FIX: tambah rollback kalau salah satu step gagal. Sebelumnya,
        // kalau creatorChannel create gagal setelah controlChannel dibuat,
        // controlChannel orphan (tidak ter-register, tidak ter-cleanup).
        let category, controlChannel, creatorChannel;
        try {
            // Bikin kategori "🎤 TEMP VOICE"
            category = guild.channels.cache.find(
                c => c.name === '🎤 TEMP VOICE' && c.type === ChannelType.GuildCategory
            );
            if (!category) {
                category = await guild.channels.create({
                    name: '🎤 TEMP VOICE',
                    type: ChannelType.GuildCategory
                });
            }

            // Bikin text channel "📋 control-panel" untuk naruh panel global
            controlChannel = await guild.channels.create({
                name: '📋 control-panel',
                type: ChannelType.GuildText,
                parent: category.id,
                topic: 'Panel kontrol global untuk temp voice. Jangan dihapus — bot pakai pesan di sini untuk kontrol voice channel.'
            });

            // Bikin voice channel "🔊 Buat Voice" sebagai trigger
            creatorChannel = await guild.channels.create({
                name: '🔊 Buat Voice',
                type: ChannelType.GuildVoice,
                parent: category.id,
                bitrate: 64000
            });

            // Simpan config
            tempVoiceManager.setupGuild(guild.id, creatorChannel.id, category.id, controlChannel.id);
        } catch (err) {
            console.error('Error setup temp voice:', err);
            // v3.9.8: rollback — hapus channel yang sudah dibuat tapi belum ter-register
            // supaya tidak jadi orphan. Hapus yang pasti dibuat di try block ini saja.
            if (controlChannel) {
                try {
                    await controlChannel.delete('Rollback: setup-tempvoice gagal');
                } catch (_) {}
            }
            if (creatorChannel) {
                try {
                    await creatorChannel.delete('Rollback: setup-tempvoice gagal');
                } catch (_) {}
            }
            // Category tidak dihapus karena mungkin sudah ada sebelumnya / dipakai oleh channel lain.
            return safeEditReply(interaction, {
                content: `❌ Gagal setup temp voice: ${err.message}\n\nPastikan bot punya permission **Manage Channels** dan **Manage Roles**.`
            });
        }

        // Kirim panel kontrol GLOBAL ke control channel
        const { embed, components } = buildGlobalControlPanel({
            activeOwners: [],
            guildName: guild.name
        });

        let panelMsg;
        try {
            panelMsg = await controlChannel.send({ embeds: [embed], components });
        } catch (err) {
            console.error('Gagal kirim panel global:', err.message);
            return safeEditReply(interaction, {
                content: `❌ Gagal kirim panel ke ${controlChannel}. Cek permission bot (Send Messages + Embed Links).`
            });
        }

        // Simpan controlMessageId
        tempVoiceManager.setControlMessageId(guild.id, panelMsg.id);

        await logAudit(interaction.client, {
            action: 'SETUP_TEMPVOICE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Setup Temp Voice — kategori: ${category.name}, trigger: ${creatorChannel} (\`${creatorChannel.id}\`), control panel: ${controlChannel} (\`${controlChannel.id}\`)`,
            guildId: guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ **Temp Voice siap!**\n\n` +
                `📂 **Kategori:** ${category.name}\n` +
                `🎤 **Trigger channel:** ${creatorChannel} (member join sini untuk bikin voice baru)\n` +
                `🎛️ **Control panel:** ${panelMsg.url}\n\n` +
                `💡 Member tinggal klik tombol **🎤 Buat Voice** di control panel, atau join langsung ke trigger channel. Setelah jadi owner, panel akan otomatis update untuk menampilkan kontrol channel mereka.`
        });
    }

    // ====================================================
    // === /tempvoice-remove ===
    // ====================================================
    if (interaction.commandName === 'tempvoice-remove') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const config = tempVoiceManager.getGuildConfig(interaction.guild.id);
        if (!config) {
            return safeEditReply(interaction, { content: 'ℹ️ Temp voice belum di-setup di guild ini.' });
        }

        // Hapus control panel message global
        try {
            if (config.controlMessageId && config.controlChannelId) {
                const ctrlChannel = interaction.guild.channels.cache.get(config.controlChannelId);
                if (ctrlChannel) {
                    const ctrlMsg = await ctrlChannel.messages.fetch(config.controlMessageId).catch(() => null);
                    if (ctrlMsg) await ctrlMsg.delete().catch(() => {});
                }
            }
        } catch (_) {}

        // v3.8.2: hapus SEMUA channel di kategori (control, trigger, temp voice aktif, kategori sendiri)
        try {
            const channelsToDelete = [];
            if (config.controlChannelId) channelsToDelete.push(config.controlChannelId);
            if (config.creatorChannelId) channelsToDelete.push(config.creatorChannelId);
            if (config.channels) {
                for (const channelId of Object.keys(config.channels)) {
                    channelsToDelete.push(channelId);
                }
            }
            for (const channelId of channelsToDelete) {
                const ch = interaction.guild.channels.cache.get(channelId);
                if (ch) await ch.delete('Temp voice setup dihapus').catch(() => {});
            }
            // Hapus kategori (sekarang harusnya kosong)
            if (config.categoryId) {
                const cat = interaction.guild.channels.cache.get(config.categoryId);
                if (cat) await cat.delete('Temp voice kategori dihapus').catch(() => {});
            }
        } catch (_) {}

        tempVoiceManager.removeGuild(interaction.guild.id);
        await logAudit(interaction.client, {
            action: 'TEMPVOICE_REMOVE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Hapus setup Temp Voice dari guild (kategori + semua channel terkait dihapus)`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                '✅ Setup Temp Voice berhasil dihapus. Kategori + control panel + trigger channel + semua channel temp voice aktif juga dihapus.'
        });
    }
};
