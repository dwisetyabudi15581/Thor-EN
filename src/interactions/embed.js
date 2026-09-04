/**
 * Embed builder domain handler — customId `emb_edit:`, `emb_preview:`,
 * `emb_send:`, `emb_cancel:`, and modal `emb_modal_*`.
 *
 * Extracted from handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior preserved as-is — just moved to a new file.
 *
 * Helpers `handleEmbedBuilderEdit`, `handleEmbedBuilderModal`, and
 * `refreshEmbedDraft` are LOCAL functions in this file (previously
 * function-level in the old module).
 *
 * The router (src/interactions/index.js) already applies:
 *   - dedup (checkAndMark)
 *   - `replied/deferred` guard
 *   - interaction type check (button/select/modal)
 *   - routing by customId prefix
 * So the domain handler can focus on its logic alone.
 */

const { ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { safeEditReply, logAudit, parseColor } = require('../commands/_shared');
// `getSession` (singular) is not exported from _shared — import it directly.
const { getSession, deleteSession, buildEmbed: buildSessionEmbed } = require('../ui/embedBuilderSessions');

module.exports = async function (interaction) {
    // ====================================================
    // === EMBED BUILDER: SELECT MENU (pick the part to edit) ===
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
                content: '❌ The builder session no longer exists (the bot may have restarted).',
                flags: MessageFlags.Ephemeral
            });
        }
        // v3.9.17 FIX: owner check. Previously, a regular member clicking the
        // Preview button (in the public channel where the admin opened the builder)
        // could see the draft content the admin was composing, including the plain
        // text message.
        if (session.ownerId !== interaction.user.id) {
            return interaction.reply({
                content: '❌ Only the creator can preview this draft.',
                flags: MessageFlags.Ephemeral
            });
        }
        const embed = buildSessionEmbed(session);
        // v3.9.6: show the plain text message in the ephemeral preview so
        // the admin can see how the message + embed will look when sent.
        // If there is no message, keep the old behavior (preview the embed only).
        // v3.9.26 FIX: truncate the message content in the preview. A message can
        // be 2000 chars — the preview wrapper (+70 char header/code fence) pushed
        // the reply past 2000 → 50035 → generic error, so the preview was never
        // visible exactly when it was longest.
        const previewContent = session.data.content
            ? `👁️ **Preview:**\n\n💬 **Plain text message:**\n\`\`\`\n${session.data.content.slice(0, 1850)}${session.data.content.length > 1850 ? '\n…(truncated)' : ''}\n\`\`\`\n📋 **Embed:**`
            : '👁️ **Preview:**';
        return interaction.reply({ content: previewContent, embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.isButton() && interaction.customId.startsWith('emb_send:')) {
        const sessionId = interaction.customId.split(':')[1];
        const session = getSession(sessionId);
        if (!session) {
            return interaction.reply({ content: '❌ The builder session no longer exists.', flags: MessageFlags.Ephemeral });
        }
        if (session.ownerId !== interaction.user.id) {
            return interaction.reply({
                content: '❌ Only the creator can send this draft.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (!session.data.title && !session.data.description) {
            return interaction.reply({
                content: '❌ The embed must have at least a **Title** or **Description** before it can be sent.',
                flags: MessageFlags.Ephemeral
            });
        }
        // v3.9.6: sending can include a plain text message or not.
        // The message was already set via the "Message (plain text)" option in the dropdown.
        // Show it in the modal so the admin can quickly view & edit it before sending.
        const currentMessage = session.data.content || '';
        // Open a modal for the target channel input + optional message override
        const modal = new ModalBuilder().setCustomId(`emb_modal_send:${sessionId}`).setTitle('Send Embed to Channel');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('channel')
                    .setLabel('Target channel (#mention or ID)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder('#announcements or 123456789012345678')
                    .setMaxLength(100)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('message')
                    .setLabel('Message outside the embed (optional, supports @)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(2000)
                    .setPlaceholder(
                        'Leave empty = embed only. Fill in = text + embed.\nSupports @everyone, @here, <@&role>, <@user>'
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
            return interaction.reply({ content: '❌ The builder session no longer exists.', flags: MessageFlags.Ephemeral });
        }
        if (session.ownerId !== interaction.user.id) {
            return interaction.reply({
                content: '❌ Only the creator can cancel this draft.',
                flags: MessageFlags.Ephemeral
            });
        }
        // Delete the draft message
        try {
            const channel = interaction.guild.channels.cache.get(session.channelId);
            if (channel) {
                const msg = await channel.messages.fetch(session.messageId).catch(() => null);
                if (msg) await msg.delete();
            }
        } catch (_) {}
        deleteSession(sessionId);
        return interaction.reply({ content: '🗑️ Builder cancelled, draft deleted.', flags: MessageFlags.Ephemeral });
    }

    // ====================================================
    // === EMBED BUILDER: MODAL SUBMITS ===
    // ====================================================
    if (interaction.isModalSubmit() && interaction.customId.startsWith('emb_modal_')) {
        return handleEmbedBuilderModal(interaction);
    }
};

// ====================================================
// === HELPER: EMBED BUILDER — SELECT MENU (edit a part) ===
// ====================================================
async function handleEmbedBuilderEdit(interaction) {
    const sessionId = interaction.customId.split(':')[1];
    const session = getSession(sessionId);
    if (!session) {
        return interaction.reply({
            content: '❌ The builder session no longer exists (the bot may have restarted).',
            flags: MessageFlags.Ephemeral
        });
    }
    if (session.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: '❌ Only the creator can edit this draft.',
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
                    .setLabel('Title (leave empty to remove)')
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
                    .setLabel('Description (leave empty to remove)')
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
                    .setLabel('Color hex (e.g. #FF0000 or FF0000)')
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
                    .setLabel('Image URL (leave empty to remove)')
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
                    .setLabel('Thumbnail URL (leave empty to remove)')
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
                    .setLabel('Footer text (max 2000 chars)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(2000)
                    .setValue(d.footer?.text || '')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('iconurl')
                    .setLabel('Footer icon URL (optional)')
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
                    .setLabel('Author name (max 256 chars)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setMaxLength(256)
                    .setValue(d.author?.name || '')
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('iconurl')
                    .setLabel('Author icon URL (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(d.author?.iconURL || '')
            )
        );
        return interaction.showModal(modal);
    }

    // === MESSAGE (plain text outside the embed) — v3.9.6 ===
    // Plain text sent alongside the embed (in the Discord message `content` field,
    // not inside the embed). Good for text that doesn't need embed styling,
    // or for @everyone / @here / role mentions that must live in the content
    // (not in the embed) to actually trigger a ping.
    if (action === 'message') {
        const modal = new ModalBuilder()
            .setCustomId(`emb_modal_message:${sessionId}`)
            .setTitle('Set Message (Plain Text)');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('value')
                    .setLabel('Message outside the embed (leave empty to remove)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(2000)
                    .setPlaceholder('Intro text outside the embed.\nSupports @everyone, @here, mentions')
                    .setValue(d.content || '')
            )
        );
        return interaction.showModal(modal);
    }

    // === ADD FIELD (normal / inline) ===
    if (action === 'add_field' || action === 'add_field_inline') {
        if (d.fields.length >= 25) {
            return interaction.reply({
                content: '❌ Maximum of 25 fields (Discord limit). Remove old fields first.',
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
                    .setLabel('Field name (max 256 chars)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(256)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('value')
                    .setLabel('Field value (max 1024 chars)')
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
            return interaction.reply({ content: '❌ There are no fields to remove yet.', flags: MessageFlags.Ephemeral });
        }
        d.fields.pop();
        await refreshEmbedDraft(interaction, session);
        return interaction.reply({ content: '✅ Last field removed.', flags: MessageFlags.Ephemeral });
    }

    // === CLEAR ALL FIELDS ===
    if (action === 'clear_fields') {
        if (d.fields.length === 0) {
            return interaction.reply({ content: '❌ There are no fields to remove.', flags: MessageFlags.Ephemeral });
        }
        const count = d.fields.length;
        d.fields = [];
        await refreshEmbedDraft(interaction, session);
        return interaction.reply({ content: `✅ ${count} field${count > 1 ? 's' : ''} removed.`, flags: MessageFlags.Ephemeral });
    }

    // === TOGGLE TIMESTAMP ===
    if (action === 'toggle_timestamp') {
        d.timestamp = !d.timestamp;
        await refreshEmbedDraft(interaction, session);
        return interaction.reply({
            content: `✅ Timestamp ${d.timestamp ? 'ENABLED' : 'DISABLED'}.`,
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
        return interaction.reply({ content: '❌ The builder session no longer exists.', flags: MessageFlags.Ephemeral });
    }
    if (session.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: '❌ Only the creator can edit this draft.',
            flags: MessageFlags.Ephemeral
        });
    }

    // v3.9.7: log deferReply failures so they aren't silent. If deferReply fails
    // (e.g. the interaction token expired because the modal was open >15 minutes),
    // safeEditReply will automatically fall back to reply(). We still log it
    // so the admin knows why the ephemeral confirmation might not appear.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(err => {
        console.warn(`[Embed Builder Modal] deferReply failed for ${interaction.customId}: ${err.message}`);
    });

    const d = session.data;
    // Discord.js v14: ModalSubmitInteraction.components is an array of ActionRowModalData.
    // Each ActionRowModalData has .components (not .fields!) — an array of TextInputModalData.
    // Each TextInputModalData has .value (a string).
    // Use ?. across the whole chain so it doesn't throw when an index is missing.
    const getFieldValue = idx => interaction.components[idx]?.components?.[0]?.value?.trim() || '';

    // === TITLE ===
    if (modalType === 'emb_modal_title') {
        // v3.9.2: validate Discord embed title limit (256 char)
        const val = getFieldValue(0);
        if (val && val.length > 256) {
            return safeEditReply(interaction, { content: `❌ Title is too long (${val.length} chars, max 256).` });
        }
        d.title = val || null;
    }

    // === DESCRIPTION ===
    else if (modalType === 'emb_modal_desc') {
        // v3.9.2: validate Discord embed description limit (4096 char)
        const val = getFieldValue(0);
        if (val && val.length > 4096) {
            return safeEditReply(interaction, {
                content: `❌ Description is too long (${val.length} chars, max 4096).`
            });
        }
        d.description = val || null;
    }

    // === COLOR ===
    else if (modalType === 'emb_modal_color') {
        const val = getFieldValue(0);
        if (!val) {
            d.color = 0x5865f2; // reset to default
        } else {
            const parsed = parseColor(val);
            if (parsed === null) {
                return safeEditReply(interaction, {
                    content: `❌ Invalid color: \`${val}\`. Use 6-digit hex format, e.g. \`#FF0000\`.`
                });
            }
            d.color = parsed;
        }
    }

    // === IMAGE ===
    else if (modalType === 'emb_modal_image') {
        const val = getFieldValue(0);
        if (val && !/^https?:\/\//i.test(val)) {
            return safeEditReply(interaction, { content: '❌ Image URL must start with `http://` or `https://`' });
        }
        d.image = val ? { url: val } : null;
    }

    // === THUMBNAIL ===
    else if (modalType === 'emb_modal_thumbnail') {
        const val = getFieldValue(0);
        if (val && !/^https?:\/\//i.test(val)) {
            return safeEditReply(interaction, {
                content: '❌ Thumbnail URL must start with `http://` or `https://`'
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

    // === MESSAGE (plain text outside the embed) — v3.9.6 ===
    else if (modalType === 'emb_modal_message') {
        const val = getFieldValue(0);
        // v3.9.6: validate the Discord message content limit (2000 chars).
        // The modal's setMaxLength already limits it, but defense-in-depth still checks.
        if (val && val.length > 2000) {
            return safeEditReply(interaction, {
                content: `❌ Message is too long (${val.length} chars, max 2000).`
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
            return safeEditReply(interaction, { content: '❌ Field name and value are required.' });
        }
        if (d.fields.length >= 25) {
            return safeEditReply(interaction, { content: '❌ Maximum of 25 fields (Discord limit).' });
        }
        // v3.9.2: defense-in-depth — even though the modal's setMaxLength already
        // limits it, validate again here so the embed doesn't throw in buildEmbed().
        // Field name max 256 chars, value max 1024 chars (Discord API limits).
        if (name.length > 256) {
            return safeEditReply(interaction, {
                content: `❌ Field name is too long (${name.length} chars, max 256).`
            });
        }
        if (value.length > 1024) {
            return safeEditReply(interaction, {
                content: `❌ Field value is too long (${value.length} chars, max 1024).`
            });
        }
        d.fields.push({ name, value, inline });
    }

    // === SEND TO CHANNEL ===
    else if (modalType === 'emb_modal_send') {
        const channelInput = getFieldValue(0);
        // v3.9.6: take the message from the modal (the admin can edit it before sending).
        // If empty, fall back to session.data.content (set earlier via the "Message" option).
        const messageInput = getFieldValue(1);
        const messageText = messageInput || session.data.content || '';

        let targetChannel = null;

        // Parse: <#123> or 123 or #name
        // Add an API fetch fallback for channels not yet cached
        // (channels created after bot start, or large guilds with a partial cache).
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
            // For name lookup, a cache lookup is enough (fetch can't search by name).
            targetChannel = interaction.guild.channels.cache.find(c => c.name === name);
        }

        if (!targetChannel) {
            return safeEditReply(interaction, {
                content: `❌ Channel not found: \`${channelInput}\`. Use a #mention or the channel ID.`
            });
        }

        // v3.9.6: validate message length (Discord limit 2000 chars)
        if (messageText.length > 2000) {
            return safeEditReply(interaction, {
                content: `❌ Message is too long (${messageText.length} chars, max 2000). Shorten the text or remove mentions.`
            });
        }

        // v3.9.6: detect & validate mentions in the message (just as strict as /announce & /send-message).
        // Only the following formats are allowed:
        //   - @everyone / everyone
        //   - @here / here
        //   - <@&ROLE_ID>      (role mention)
        //   - <@USER_ID>       (user mention)
        //   - <@!USER_ID>      (user mention, old format)
        // Anything else → rejected. Prevents the admin from accidentally sending
        // text with weird mention formats that could trigger unwanted pings.
        //
        // Strategy: scan the message for every mention token present, validate them one by one.
        // If any are invalid → reject with an error message explaining the valid formats.
        if (messageText) {
            const mentionRegex = /@everyone|@here|<@!?\d{17,20}>|<@&\d{17,20}>|@\w+/g;
            const foundMentions = messageText.match(mentionRegex) || [];
            const invalidMentions = [];
            for (const m of foundMentions) {
                const lower = m.toLowerCase();
                if (lower === '@everyone' || lower === '@here') continue;
                if (/^<@&\d{17,20}>$/.test(m)) continue; // role mention
                if (/^<@!?\d{17,20}>$/.test(m)) continue; // user mention
                // If we got here, `@\w+` matched but it isn't a valid format
                // (e.g. "@hello", "@admin", "@staff") → reject
                invalidMentions.push(m);
            }
            if (invalidMentions.length > 0) {
                return safeEditReply(interaction, {
                    content:
                        `❌ Invalid mention in the message: \`${invalidMentions.join('`, `')}\`\n\n` +
                        'Supported mention formats:\n' +
                        '• `@everyone` or `@here`\n' +
                        '• `<@&ROLE_ID>` (role mention — type `@rolename` in Discord then copy it)\n' +
                        '• `<@USER_ID>` (user mention — type `@username` in Discord then copy it)\n\n' +
                        'Tip: mentions like `@hello` or `@admin` (without an ID) will not trigger a ping in Discord, ' +
                        'but we reject them here so the admin doesn\'t send a stray mention by mistake.'
                });
            }
        }

        // v3.9.6: unescape \\n → \n (the Discord modal automatically escapes backslashes in user input)
        const finalMessage = messageText.replace(/\\n/g, '\n');

        const embed = buildSessionEmbed(session);
        try {
            // Send with content (plain text) + embeds.
            // allowedMentions parse: let Discord parse mentions normally
            // (everyone, roles, users) — already validated above.
            await targetChannel.send({
                content: finalMessage || undefined,
                embeds: [embed],
                allowedMentions: { parse: ['everyone', 'roles', 'users'] }
            });
        } catch (err) {
            return safeEditReply(interaction, { content: `❌ Failed to send to ${targetChannel}: ${err.message}` });
        }

        // P1-10 FIX: audit log for EMBED_BUILDER_SEND (previously missing).
        // v3.9.6: include message info (length + presence) in the audit log.
        try {
            await logAudit(interaction.client, {
                action: 'EMBED_BUILDER_SEND',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Send embed (builder) to ${targetChannel}: ${session.data.title ? `**${session.data.title}**` : '_(no title)_'}${finalMessage ? ` | +message (${finalMessage.length} chars)` : ''}`,
                guildId: interaction.guild.id
            });
        } catch (_) {}

        // Delete the draft message
        try {
            const channel = interaction.guild.channels.cache.get(session.channelId);
            if (channel) {
                const msg = await channel.messages.fetch(session.messageId).catch(() => null);
                if (msg) await msg.delete();
            }
        } catch (_) {}
        deleteSession(sessionId);
        return safeEditReply(interaction, {
            content: `✅ ${finalMessage ? 'Message + ' : ''}Embed sent to ${targetChannel}! Draft deleted.`
        });
    }

    // Refresh the draft with the latest embed
    await refreshEmbedDraft(interaction, session);
    return safeEditReply(interaction, { content: '✅ Embed updated.' });
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
        console.warn('Failed to refresh the embed draft:', err.message);
    }
}
