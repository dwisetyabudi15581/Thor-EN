/**
 * Domain: embed
 * Slash commands: /embed-builder, /embed-list, /embed-cancel
 *
 * Dipisah dari handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: interactive embed builder (session-based, live preview), list, cancel.
 *
 * v3.9.6: tampilkan message indicator di summary (/embed-list).
 * v3.9.8: wrap draft send di try/catch + cleanup orphan session kalau gagal.
 */

const {
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    createSession,
    buildEmbed,
    getSessionsByUser,
    deleteSession,
    deleteSessionByOwner,
    safeEditReply
} = require('./_shared');

module.exports = async function (interaction) {
    // ====================================================
    // === /embed-builder — INTERACTIVE BUILDER ===
    // ====================================================
    if (interaction.commandName === 'embed-builder') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Buat session baru
        const session = createSession(interaction.user.id, interaction.channel.id);

        // Build initial embed (default state)
        const previewEmbed = buildEmbed(session);

        // Komponen: 1 select menu + 1 row dengan 3 buttons
        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`emb_edit:${session.id}`)
                .setPlaceholder('✏️ Pilih bagian embed yang ingin diedit...')
                .addOptions([
                    { label: 'Title', value: 'title', emoji: '✏️', description: 'Judul embed (maks 256 char)' },
                    {
                        label: 'Description',
                        value: 'description',
                        emoji: '📝',
                        description: 'Isi utama embed (maks 4000 char)'
                    },
                    {
                        label: 'Message (plain text)',
                        value: 'message',
                        emoji: '💬',
                        description: 'Teks di luar embed (maks 2000 char, support \\n)'
                    },
                    { label: 'Color', value: 'color', emoji: '🎨', description: 'Warna hex (mis. #FF0000)' },
                    { label: 'Image', value: 'image', emoji: '🖼️', description: 'URL gambar besar' },
                    {
                        label: 'Thumbnail',
                        value: 'thumbnail',
                        emoji: '🖼️',
                        description: 'URL gambar kecil (pojok kanan atas)'
                    },
                    { label: 'Footer', value: 'footer', emoji: '👣', description: 'Teks & icon di bawah embed' },
                    { label: 'Author', value: 'author', emoji: '👤', description: 'Teks & icon di atas embed' },
                    {
                        label: 'Add Field (normal)',
                        value: 'add_field',
                        emoji: '➕',
                        description: 'Tambah field (full width)'
                    },
                    {
                        label: 'Add Field (inline)',
                        value: 'add_field_inline',
                        emoji: '➕',
                        description: 'Tambah field (sejajar samping)'
                    },
                    {
                        label: 'Remove Last Field',
                        value: 'remove_field',
                        emoji: '❌',
                        description: 'Hapus field terakhir'
                    },
                    { label: 'Clear All Fields', value: 'clear_fields', emoji: '🧹', description: 'Hapus SEMUA field' },
                    {
                        label: 'Toggle Timestamp',
                        value: 'toggle_timestamp',
                        emoji: '🕒',
                        description: 'Show/hide timestamp'
                    }
                ])
        );

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`emb_preview:${session.id}`)
                .setLabel('Preview')
                .setEmoji('👁️')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`emb_send:${session.id}`)
                .setLabel('Send')
                .setEmoji('📤')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`emb_cancel:${session.id}`)
                .setLabel('Cancel')
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger)
        );

        // Kirim draft message
        // v3.9.8 FIX: wrap di try/catch. Sebelumnya kalau send gagal (bot gak
        // punya SendMessages/EmbedLinks), session tetap ke-create di storage
        // tapi gak ada draft message → orphan session forever di /embed-list.
        let draftMsg;
        try {
            draftMsg = await interaction.channel.send({
                content:
                    `🛠️ **Embed Builder Draft** — dimulai oleh <@${interaction.user.id}>\n` +
                    `Preview real-time di bawah. Klik dropdown untuk edit bagian, atau tombol untuk preview/send/cancel.\n` +
                    `💡 **Tips:** Pilih **💬 Message (plain text)** di dropdown untuk menambah teks di luar embed (cocok untuk @everyone ping atau teks pengantar).\n` +
                    `🆔 Session: \`${session.id}\``,
                embeds: [previewEmbed],
                components: [selectRow, actionRow]
            });
        } catch (err) {
            console.error('Gagal kirim embed builder draft:', err);
            // Cleanup session orphan supaya tidak numpuk di /embed-list.
            try {
                deleteSession(session.id);
            } catch (_) {}
            return safeEditReply(interaction, {
                content: `❌ Gagal kirim draft message ke channel ini. Cek permission bot (Send Messages + Embed Links).`
            });
        }

        // Simpan messageId ke session
        session.messageId = draftMsg.id;

        return safeEditReply(interaction, {
            content: `✅ Embed builder dimulai!\n📍 Draft: ${draftMsg}\n\n💡 Klik dropdown di draft untuk edit bagian embed. Setelah selesai, klik **📤 Send** untuk kirim ke channel target.`
        });
    }

    // ====================================================
    // === /embed-list — LIST ACTIVE EMBED BUILDER SESSIONS ===
    // ====================================================
    if (interaction.commandName === 'embed-list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const userSessions = getSessionsByUser(interaction.user.id);
        if (userSessions.length === 0) {
            return safeEditReply(interaction, {
                content:
                    '📭 **Tidak ada session embed builder aktif untuk kamu.**\n\nPakai `/embed-builder` untuk membuat draft baru.'
            });
        }

        const lines = userSessions
            .map(s => {
                const d = s.data;
                const summary = [];
                if (d.title) summary.push('title');
                if (d.description) summary.push('desc');
                // v3.9.6: tampilkan message indicator di summary
                if (d.content) summary.push(`msg (${d.content.length} char)`);
                if (d.fields && d.fields.length > 0)
                    summary.push(`${d.fields.length} field${d.fields.length > 1 ? 's' : ''}`);
                if (d.image) summary.push('image');
                if (d.thumbnail) summary.push('thumb');
                if (d.footer && d.footer.text) summary.push('footer');
                if (d.author && d.author.name) summary.push('author');
                const summaryStr = summary.length > 0 ? summary.join(', ') : '*(kosong)*';

                const ageMs = Date.now() - s.createdAt;
                const ageMin = Math.floor(ageMs / 60000);
                const ageStr =
                    ageMin < 1
                        ? 'baru saja'
                        : ageMin < 60
                          ? `${ageMin}m lalu`
                          : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m lalu`;

                const link = s.messageId
                    ? `[🔗 buka draft](https://discord.com/channels/${interaction.guild.id}/${s.channelId}/${s.messageId})`
                    : '*(draft belum dibuat)*';
                const channelStr = s.channelId ? `<#${s.channelId}>` : '???';

                return `• 🆔 \`${s.id}\`\n  📍 ${channelStr} | ${link}\n  ⏰ Dibuat: ${ageStr} | 📝 ${summaryStr}`;
            })
            .join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle('🛠️ SESSION EMBED BUILDER AKTIF')
            .setDescription(
                `Kamu punya **${userSessions.length}** session aktif.\n\n` +
                    lines +
                    `\n\n💡 **Cara pakai:** Klik link **buka draft** untuk lompat ke pesan draft-nya, lalu pakai dropdown di situ untuk edit. Setiap draft independen — gak akan saling ganggu.`
            )
            .setColor(0x5865f2)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /embed-cancel — CANCEL EMBED BUILDER SESSION BY ID ===
    // ====================================================
    if (interaction.commandName === 'embed-cancel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const sessionId = interaction.options.getString('session_id');
        const session = deleteSessionByOwner(sessionId, interaction.user.id);

        if (!session) {
            return safeEditReply(interaction, {
                content: `❌ Session \`${sessionId}\` tidak ditemukan atau bukan milik kamu.\n\nPakai \`/embed-list\` untuk lihat session aktif.`
            });
        }

        // Coba hapus draft message-nya juga kalau masih ada
        let draftDeleted = false;
        try {
            const channel = interaction.guild.channels.cache.get(session.channelId);
            if (channel && session.messageId) {
                const msg = await channel.messages.fetch(session.messageId).catch(() => null);
                if (msg) {
                    await msg.delete();
                    draftDeleted = true;
                }
            }
        } catch (_) {}

        return safeEditReply(interaction, {
            content:
                `🗑️ Session \`${sessionId}\` dibatalkan.` +
                (draftDeleted ? ' Pesan draft juga dihapus.' : ' (Pesan draft sudah tidak ditemukan.)')
        });
    }
};
