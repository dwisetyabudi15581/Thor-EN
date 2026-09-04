/**
 * Embed builder domain handler — customId `emb_edit:`, `emb_preview:`,
 * `emb_send:`, `emb_cancel:`, dan modal `emb_modal_*`.
 *
 * Di-ekstrak dari handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior dipertahankan apa adanya — hanya pindah file.
 *
 * Helper `handleEmbedBuilderEdit`, `handleEmbedBuilderModal`, dan
 * `refreshEmbedDraft` jadi LOCAL function di file ini (sebelumnya
 * function-level di module lama).
 *
 * Router (src/interactions/index.js) sudah apply:
 *   - dedup (checkAndMark)
 *   - guard `replied/deferred`
 *   - cek tipe interaction (button/select/modal)
 *   - routing by customId prefix
 * Jadi domain handler fokus ke logic-nya saja.
 */

const { ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { safeEditReply, logAudit, parseColor } = require('../commands/_shared');
// `getSession` (singular) tidak di-export dari _shared, import langsung.
const { getSession, deleteSession, buildEmbed: buildSessionEmbed } = require('../ui/embedBuilderSessions');

module.exports = async function (interaction) {
    // ====================================================
    // === EMBED BUILDER: SELECT MENU (pilih bagian edit) ===
    // ====================================================
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('emb_edit:')) {
        return handleEmbedBuilderEdit(interaction);
    }

    // ====================================================
    // === EMBED BUILDER: BUTTONS (preview/send/cancel) ===
    // ====================================================
    if (interaction.isButton() && interaction.customId.startsWith('emb_preview:')) {
        const sessionId = interaction.customId.split(':')[1];
        const session = getSession(sessionId);
        if (!session) {
            return interaction.reply({
                content: '❌ Session builder sudah tidak ada (mungkin bot restart).',
                flags: MessageFlags.Ephemeral
            });
        }
        // v3.9.17 FIX: owner check. Sebelumnya, member biasa yang klik tombol
        // Preview (di channel public tempat admin buka builder) bisa lihat
        // draft content yang sedang admin susun, termasuk plain text message.
        if (session.ownerId !== interaction.user.id) {
            return interaction.reply({
                content: '❌ Hanya pembuat yang bisa preview draft ini.',
                flags: MessageFlags.Ephemeral
            });
        }
        const embed = buildSessionEmbed(session);
        // v3.9.6: tampilkan plain text message di preview ephemeral supaya
        // admin bisa lihat bagaimana message + embed akan terlihat saat dikirim.
        // Kalau tidak ada message, behavior lama (preview embed saja).
        // v3.9.26 FIX: truncate isi message di preview. Message bisa 2000 char —
        // wrapper preview (+70 char header/code fence) bikin reply > 2000 → 50035
        // → error generik, preview tidak pernah terlihat justru saat paling panjang.
        const previewContent = session.data.content
            ? `👁️ **Preview:**\n\n💬 **Plain text message:**\n\`\`\`\n${session.data.content.slice(0, 1850)}${session.data.content.length > 1850 ? '\n…(dipotong)' : ''}\n\`\`\`\n📋 **Embed:**`
            : '👁️ **Preview:**';
        return interaction.reply({ content: previewContent, embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.isButton() && interaction.customId.startsWith('emb_send:')) {
        const sessionId = interaction.customId.split(':')[1];
        const session = getSession(sessionId);
        if (!session) {
            return interaction.reply({ content: '❌ Session builder sudah tidak ada.', flags: MessageFlags.Ephemeral });
        }
        if (session.ownerId !== interaction.user.id) {
            return interaction.reply({
                content: '❌ Hanya pembuat yang bisa kirim draft ini.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (!session.data.title && !session.data.description) {
            return interaction.reply({
                content: '❌ Embed minimal harus punya **Title** atau **Description** sebelum dikirim.',
                flags: MessageFlags.Ephemeral
            });
        }
        // v3.9.6: kirim bisa dengan atau tanpa plain text message.
        // Message sudah diset via opsi "Message (plain text)" di dropdown.
        // Tampilkan di modal supaya admin bisa lihat & edit cepat sebelum kirim.
        const currentMessage = session.data.content || '';
        // Buka modal untuk input channel target + optional override message
        const modal = new ModalBuilder().setCustomId(`emb_modal_send:${sessionId}`).setTitle('Kirim Embed ke Channel');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('channel')
                    .setLabel('Channel target (#mention atau ID)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder('#announcements atau 123456789012345678')
                    .setMaxLength(100)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('message')
                    .setLabel('Pesan di luar embed (opsional, support @)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(2000)
                    .setPlaceholder(
                        'Kosongkan = embed saja. Isi = teks + embed.\nSupport @everyone, @here, <@&role>, <@user>'
                    )
                    .setValue(currentMessage)
            )
        );
        return interaction.showModal(modal);
    }

    if (interaction.isButton() && interaction.customId.startsWith('emb_cancel:')) {
        const sessionId = interaction.customId.split(':')[1];
        const session = getSession(sessionId);
        if (!session) {
            return interaction.reply({ content: '❌ Session builder sudah tidak ada.', flags: MessageFlags.Ephemeral });
        }
        if (session.ownerId !== interaction.user.id) {
            return interaction.reply({
                content: '❌ Hanya pembuat yang bisa cancel draft ini.',
                flags: MessageFlags.Ephemeral
            });
        }
        // Hapus draft message
        try {
            const channel = interaction.guild.channels.cache.get(session.channelId);
            if (channel) {
                const msg = await channel.messages.fetch(session.messageId).catch(() => null);
                if (msg) await msg.delete();
            }
        } catch (_) {}
        deleteSession(sessionId);
        return interaction.reply({ content: '🗑️ Builder dibatalkan, draft dihapus.', flags: MessageFlags.Ephemeral });
    }

    // ====================================================
    // === EMBED BUILDER: MODAL SUBMITS ===
    // ====================================================
    if (interaction.isModalSubmit() && interaction.customId.startsWith('emb_modal_')) {
        return handleEmbedBuilderModal(interaction);
    }
};

// ====================================================
// === HELPER: EMBED BUILDER — SELECT MENU (edit bagian) ===
// ====================================================
async function handleEmbedBuilderEdit(interaction) {
    const sessionId = interaction.customId.split(':')[1];
    const session = getSession(sessionId);
    if (!session) {
        return interaction.reply({
            content: '❌ Session builder sudah tidak ada (mungkin bot restart).',
            flags: MessageFlags.Ephemeral
        });
    }
    if (session.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: '❌ Hanya pembuat yang bisa edit draft ini.',
            flags: MessageFlags.Ephemeral
        });
    }

    const action = interaction.values[0];
    const d = session.data;

    // === TITLE ===
    if (action === 'title') {
        const modal = new ModalBuilder().setCustomId(`emb_modal_title:${sessionId}`).setTitle('Edit Title');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('value')
                    .setLabel('Title (kosongkan untuk hapus)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(256)
                    .setValue(d.title || '')
            )
        );
        return interaction.showModal(modal);
    }

    // === DESCRIPTION ===
    if (action === 'description') {
        const modal = new ModalBuilder().setCustomId(`emb_modal_desc:${sessionId}`).setTitle('Edit Description');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('value')
                    .setLabel('Description (kosongkan untuk hapus)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(4000)
                    .setValue(d.description || '')
            )
        );
        return interaction.showModal(modal);
    }

    // === COLOR ===
    if (action === 'color') {
        const modal = new ModalBuilder().setCustomId(`emb_modal_color:${sessionId}`).setTitle('Set Color');
        const currentHex =
            d.color !== null && d.color !== undefined ? '#' + d.color.toString(16).padStart(6, '0').toUpperCase() : '';
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('value')
                    .setLabel('Color hex (mis. #FF0000 atau FF0000)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(7)
                    .setPlaceholder('#FF0000')
                    .setValue(currentHex)
            )
        );
        return interaction.showModal(modal);
    }

    // === IMAGE ===
    if (action === 'image') {
        const modal = new ModalBuilder().setCustomId(`emb_modal_image:${sessionId}`).setTitle('Set Image');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('value')
                    .setLabel('Image URL (kosongkan untuk hapus)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(d.image?.url || '')
            )
        );
        return interaction.showModal(modal);
    }

    // === THUMBNAIL ===
    if (action === 'thumbnail') {
        const modal = new ModalBuilder().setCustomId(`emb_modal_thumbnail:${sessionId}`).setTitle('Set Thumbnail');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('value')
                    .setLabel('Thumbnail URL (kosongkan untuk hapus)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(d.thumbnail?.url || '')
            )
        );
        return interaction.showModal(modal);
    }

    // === FOOTER ===
    if (action === 'footer') {
        const modal = new ModalBuilder().setCustomId(`emb_modal_footer:${sessionId}`).setTitle('Set Footer');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('text')
                    .setLabel('Footer text (maks 2000 char)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(2000)
                    .setValue(d.footer?.text || '')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('iconurl')
                    .setLabel('Footer icon URL (opsional)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(d.footer?.iconURL || '')
            )
        );
        return interaction.showModal(modal);
    }

    // === AUTHOR ===
    if (action === 'author') {
        const modal = new ModalBuilder().setCustomId(`emb_modal_author:${sessionId}`).setTitle('Set Author');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('name')
                    .setLabel('Author name (maks 256 char)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(256)
                    .setValue(d.author?.name || '')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('iconurl')
                    .setLabel('Author icon URL (opsional)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(d.author?.iconURL || '')
            )
        );
        return interaction.showModal(modal);
    }

    // === MESSAGE (plain text di luar embed) — v3.9.6 ===
    // Teks biasa yang dikirim bersama embed (di field `content` message Discord,
    // bukan di dalam embed). Cocok untuk teks yang nggak perlu styling embed,
    // atau untuk mention @everyone / @here / role yang harus berada di content
    // (bukan di embed) supaya trigger ping.
    if (action === 'message') {
        const modal = new ModalBuilder()
            .setCustomId(`emb_modal_message:${sessionId}`)
            .setTitle('Set Message (Plain Text)');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('value')
                    .setLabel('Pesan di luar embed (kosongkan untuk hapus)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(2000)
                    .setPlaceholder('Teks pengantar di luar embed.\nSupport @everyone, @here, mention')
                    .setValue(d.content || '')
            )
        );
        return interaction.showModal(modal);
    }

    // === ADD FIELD (normal / inline) ===
    if (action === 'add_field' || action === 'add_field_inline') {
        if (d.fields.length >= 25) {
            return interaction.reply({
                content: '❌ Maksimal 25 field (batas Discord). Hapus field lama dulu.',
                flags: MessageFlags.Ephemeral
            });
        }
        const inline = action === 'add_field_inline';
        const modal = new ModalBuilder()
            .setCustomId(`emb_modal_field:${sessionId}:${inline ? '1' : '0'}`)
            .setTitle(`Add Field (${inline ? 'inline' : 'normal'})`);
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('name')
                    .setLabel('Field name (maks 256 char)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(256)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('value')
                    .setLabel('Field value (maks 1024 char)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1024)
            )
        );
        return interaction.showModal(modal);
    }

    // === REMOVE LAST FIELD ===
    if (action === 'remove_field') {
        if (d.fields.length === 0) {
            return interaction.reply({ content: '❌ Belum ada field untuk dihapus.', flags: MessageFlags.Ephemeral });
        }
        d.fields.pop();
        await refreshEmbedDraft(interaction, session);
        return interaction.reply({ content: '✅ Field terakhir dihapus.', flags: MessageFlags.Ephemeral });
    }

    // === CLEAR ALL FIELDS ===
    if (action === 'clear_fields') {
        if (d.fields.length === 0) {
            return interaction.reply({ content: '❌ Tidak ada field untuk dihapus.', flags: MessageFlags.Ephemeral });
        }
        const count = d.fields.length;
        d.fields = [];
        await refreshEmbedDraft(interaction, session);
        return interaction.reply({ content: `✅ ${count} field dihapus.`, flags: MessageFlags.Ephemeral });
    }

    // === TOGGLE TIMESTAMP ===
    if (action === 'toggle_timestamp') {
        d.timestamp = !d.timestamp;
        await refreshEmbedDraft(interaction, session);
        return interaction.reply({
            content: `✅ Timestamp ${d.timestamp ? 'DINYALAKAN' : 'DIMATIKAN'}.`,
            flags: MessageFlags.Ephemeral
        });
    }
}

// ====================================================
// === HELPER: EMBED BUILDER — MODAL SUBMIT ===
// ====================================================
async function handleEmbedBuilderModal(interaction) {
    const parts = interaction.customId.split(':');
    const modalType = parts[0];
    const sessionId = parts[1];
    const session = getSession(sessionId);

    if (!session) {
        return interaction.reply({ content: '❌ Session builder sudah tidak ada.', flags: MessageFlags.Ephemeral });
    }
    if (session.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: '❌ Hanya pembuat yang bisa edit draft ini.',
            flags: MessageFlags.Ephemeral
        });
    }

    // v3.9.7: log deferReply failure supaya tidak gaib. Kalau deferReply gagal
    // (mis. interaction token expired karena modal terbuka >15 menit),
    // safeEditReply akan fallback ke reply() otomatis. Tapi kita tetap log
    // supaya admin tau kenapa konfirmasi ephemeral mungkin tidak muncul.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(err => {
        console.warn(`[Embed Builder Modal] deferReply gagal untuk ${interaction.customId}: ${err.message}`);
    });

    const d = session.data;
    // Discord.js v14: ModalSubmitInteraction.components adalah array of ActionRowModalData.
    // Setiap ActionRowModalData punya .components (bukan .fields!) — array TextInputModalData.
    // Tiap TextInputModalData punya .value (string).
    // Pakai ?. di seluruh chain supaya gak throw kalau index gak ada.
    const getFieldValue = idx => interaction.components[idx]?.components?.[0]?.value?.trim() || '';

    // === TITLE ===
    if (modalType === 'emb_modal_title') {
        // v3.9.2: validate Discord embed title limit (256 char)
        const val = getFieldValue(0);
        if (val && val.length > 256) {
            return safeEditReply(interaction, { content: `❌ Title terlalu panjang (${val.length} char, maks 256).` });
        }
        d.title = val || null;
    }

    // === DESCRIPTION ===
    else if (modalType === 'emb_modal_desc') {
        // v3.9.2: validate Discord embed description limit (4096 char)
        const val = getFieldValue(0);
        if (val && val.length > 4096) {
            return safeEditReply(interaction, {
                content: `❌ Description terlalu panjang (${val.length} char, maks 4096).`
            });
        }
        d.description = val || null;
    }

    // === COLOR ===
    else if (modalType === 'emb_modal_color') {
        const val = getFieldValue(0);
        if (!val) {
            d.color = 0x5865f2; // reset ke default
        } else {
            const parsed = parseColor(val);
            if (parsed === null) {
                return safeEditReply(interaction, {
                    content: `❌ Color tidak valid: \`${val}\`. Pakai format hex 6 digit, mis. \`#FF0000\`.`
                });
            }
            d.color = parsed;
        }
    }

    // === IMAGE ===
    else if (modalType === 'emb_modal_image') {
        const val = getFieldValue(0);
        if (val && !/^https?:\/\//i.test(val)) {
            return safeEditReply(interaction, { content: '❌ Image URL harus mulai dengan `http://` atau `https://`' });
        }
        d.image = val ? { url: val } : null;
    }

    // === THUMBNAIL ===
    else if (modalType === 'emb_modal_thumbnail') {
        const val = getFieldValue(0);
        if (val && !/^https?:\/\//i.test(val)) {
            return safeEditReply(interaction, {
                content: '❌ Thumbnail URL harus mulai dengan `http://` atau `https://`'
            });
        }
        d.thumbnail = val ? { url: val } : null;
    }

    // === FOOTER ===
    else if (modalType === 'emb_modal_footer') {
        const text = getFieldValue(0);
        const iconURL = getFieldValue(1);
        if (!text) {
            d.footer = null;
        } else {
            d.footer = { text };
            if (iconURL && /^https?:\/\//i.test(iconURL)) {
                d.footer.iconURL = iconURL;
            }
        }
    }

    // === AUTHOR ===
    else if (modalType === 'emb_modal_author') {
        const name = getFieldValue(0);
        const iconURL = getFieldValue(1);
        if (!name) {
            d.author = null;
        } else {
            d.author = { name };
            if (iconURL && /^https?:\/\//i.test(iconURL)) {
                d.author.iconURL = iconURL;
            }
        }
    }

    // === MESSAGE (plain text di luar embed) — v3.9.6 ===
    else if (modalType === 'emb_modal_message') {
        const val = getFieldValue(0);
        // v3.9.6: validate Discord message content limit (2000 char).
        // Modal setMaxLength sudah batasi, tapi defense-in-depth tetap cek.
        if (val && val.length > 2000) {
            return safeEditReply(interaction, {
                content: `❌ Message terlalu panjang (${val.length} char, maks 2000).`
            });
        }
        d.content = val || null;
    }

    // === ADD FIELD ===
    else if (modalType === 'emb_modal_field') {
        const inline = parts[2] === '1';
        const name = getFieldValue(0);
        const value = getFieldValue(1);
        if (!name || !value) {
            return safeEditReply(interaction, { content: '❌ Field name dan value wajib diisi.' });
        }
        if (d.fields.length >= 25) {
            return safeEditReply(interaction, { content: '❌ Maksimal 25 field (batas Discord).' });
        }
        // v3.9.2: defense-in-depth — walau modal setMaxLength sudah membatasi,
        // validasi lagi di sini supaya embed tidak throw di buildEmbed().
        // Field name maks 256 char, value maks 1024 char (Discord API limit).
        if (name.length > 256) {
            return safeEditReply(interaction, {
                content: `❌ Field name terlalu panjang (${name.length} char, maks 256).`
            });
        }
        if (value.length > 1024) {
            return safeEditReply(interaction, {
                content: `❌ Field value terlalu panjang (${value.length} char, maks 1024).`
            });
        }
        d.fields.push({ name, value, inline });
    }

    // === SEND TO CHANNEL ===
    else if (modalType === 'emb_modal_send') {
        const channelInput = getFieldValue(0);
        // v3.9.6: ambil message dari modal (bisa di-edit admin sebelum kirim).
        // Kalau kosong, fallback ke session.data.content (yang sudah diset via opsi "Message").
        const messageInput = getFieldValue(1);
        const messageText = messageInput || session.data.content || '';

        let targetChannel = null;

        // Parse: <#123> or 123 or #name
        // Tambah fetch API fallback buat channel yang belum ter-cache
        // (channel baru setelah bot start, atau guild besar dengan cache parsial).
        const mentionMatch = channelInput.match(/^<#(\d+)>$/);
        if (mentionMatch) {
            targetChannel =
                interaction.guild.channels.cache.get(mentionMatch[1]) ||
                (await interaction.guild.channels.fetch(mentionMatch[1]).catch(() => null));
        } else if (/^\d+$/.test(channelInput)) {
            targetChannel =
                interaction.guild.channels.cache.get(channelInput) ||
                (await interaction.guild.channels.fetch(channelInput).catch(() => null));
        } else {
            const name = channelInput.replace(/^#/, '');
            // Buat name lookup, cache lookup udah cukup (fetch gak bisa by name).
            targetChannel = interaction.guild.channels.cache.find(c => c.name === name);
        }

        if (!targetChannel) {
            return safeEditReply(interaction, {
                content: `❌ Channel tidak ditemukan: \`${channelInput}\`. Pakai #mention atau channel ID.`
            });
        }

        // v3.9.6: validate message length (Discord limit 2000 char)
        if (messageText.length > 2000) {
            return safeEditReply(interaction, {
                content: `❌ Message terlalu panjang (${messageText.length} char, maks 2000). Persingkat teks atau hapus mention.`
            });
        }

        // v3.9.6: detect & validate mentions di message (sama ketatnya dengan /announce & /send-message).
        // Hanya format berikut yang diperbolehkan:
        //   - @everyone / everyone
        //   - @here / here
        //   - <@&ROLE_ID>      (role mention)
        //   - <@USER_ID>       (user mention)
        //   - <@!USER_ID>      (user mention, old format)
        // Selain itu → reject. Mencegah admin nggak sengaja kirim teks dengan
        // mention format aneh yang bisa trigger ping yang tidak diinginkan.
        //
        // Strategi: scan message untuk semua token mention yang ada, validasi satu per satu.
        // Kalau ada yang tidak valid → reject dengan pesan error yang menjelaskan format valid.
        if (messageText) {
            const mentionRegex = /@everyone|@here|<@!?\d{17,20}>|<@&\d{17,20}>|@\w+/g;
            const foundMentions = messageText.match(mentionRegex) || [];
            const invalidMentions = [];
            for (const m of foundMentions) {
                const lower = m.toLowerCase();
                if (lower === '@everyone' || lower === '@here') continue;
                if (/^<@&\d{17,20}>$/.test(m)) continue; // role mention
                if (/^<@!?\d{17,20}>$/.test(m)) continue; // user mention
                // Kalau sampai sini, berarti `@\w+` match tapi bukan format valid
                // (mis. "@halo", "@admin", "@semua") → reject
                invalidMentions.push(m);
            }
            if (invalidMentions.length > 0) {
                return safeEditReply(interaction, {
                    content:
                        `❌ Mention tidak valid di message: \`${invalidMentions.join('`, `')}\`\n\n` +
                        'Format mention yang didukung:\n' +
                        '• `@everyone` atau `@here`\n' +
                        '• `<@&ROLE_ID>` (mention role — ketik `@rolename` di Discord lalu copy)\n' +
                        '• `<@USER_ID>` (mention user — ketik `@username` di Discord lalu copy)\n\n' +
                        'Tip: mention seperti `@halo` atau `@admin` (tanpa ID) tidak akan trigger ping di Discord, ' +
                        'tapi kami tolak di sini supaya admin tidak salah kirim mention yang nggak sengaja.'
                });
            }
        }

        // v3.9.6: unescape \\n → \n (Discord modal otomatis escape backslash di input user)
        const finalMessage = messageText.replace(/\\n/g, '\n');

        const embed = buildSessionEmbed(session);
        try {
            // Kirim dengan content (plain text) + embeds.
            // allowedMentions parse: biarkan Discord parse mention normal
            // (everyone, roles, users) — sudah divalidasi di atas.
            await targetChannel.send({
                content: finalMessage || undefined,
                embeds: [embed],
                allowedMentions: { parse: ['everyone', 'roles', 'users'] }
            });
        } catch (err) {
            return safeEditReply(interaction, { content: `❌ Gagal kirim ke ${targetChannel}: ${err.message}` });
        }

        // P1-10 FIX: audit log untuk EMBED_BUILDER_SEND (sebelumnya missing).
        // v3.9.6: include info message (panjang + ada/tidak) di audit log.
        try {
            await logAudit(interaction.client, {
                action: 'EMBED_BUILDER_SEND',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Kirim embed (builder) ke ${targetChannel}: ${session.data.title ? `**${session.data.title}**` : '_(no title)_'}${finalMessage ? ` | +message (${finalMessage.length} char)` : ''}`,
                guildId: interaction.guild.id
            });
        } catch (_) {}

        // Hapus draft message
        try {
            const channel = interaction.guild.channels.cache.get(session.channelId);
            if (channel) {
                const msg = await channel.messages.fetch(session.messageId).catch(() => null);
                if (msg) await msg.delete();
            }
        } catch (_) {}
        deleteSession(sessionId);
        return safeEditReply(interaction, {
            content: `✅ ${finalMessage ? 'Message + ' : ''}Embed terkirim ke ${targetChannel}! Draft dihapus.`
        });
    }

    // Refresh draft dengan embed terbaru
    await refreshEmbedDraft(interaction, session);
    return safeEditReply(interaction, { content: '✅ Embed diupdate.' });
}

// ====================================================
// === HELPER: REFRESH EMBED BUILDER DRAFT MESSAGE ===
// ====================================================
async function refreshEmbedDraft(interaction, session) {
    try {
        const channel = interaction.guild.channels.cache.get(session.channelId);
        if (!channel) return;
        const msg = await channel.messages.fetch(session.messageId).catch(() => null);
        if (!msg) return;
        const embed = buildSessionEmbed(session);
        await msg.edit({ embeds: [embed] });
    } catch (err) {
        console.warn('Gagal refresh embed draft:', err.message);
    }
}
