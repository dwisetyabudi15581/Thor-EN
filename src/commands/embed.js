/**
 * Domain: embed
 * Slash commands: /embed-builder, /embed-list, /embed-cancel
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: interactive embed builder (session-based, live preview), list, cancel.
 *
 * v3.9.6: show a message indicator in the summary (/embed-list).
 * v3.9.8: wrap the draft send in try/catch + clean up the orphan session if it fails.
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

        // Create a new session
        const session = createSession(interaction.user.id, interaction.channel.id);

        // Build the initial embed (default state)
        const previewEmbed = buildEmbed(session);

        // Components: 1 select menu + 1 row with 3 buttons
        const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`emb_edit:${session.id}`)
                .setPlaceholder('✏️ Select the embed section to edit...')
                .addOptions([
                    { label: 'Title', value: 'title', emoji: '✏️', description: 'Embed title (max 256 chars)' },
                    {
                        label: 'Description',
                        value: 'description',
                        emoji: '📝',
                        description: 'Embed main content (max 4000 chars)'
                    },
                    {
                        label: 'Message (plain text)',
                        value: 'message',
                        emoji: '💬',
                        description: 'Text outside the embed (max 2000 chars, supports \\n)'
                    },
                    { label: 'Color', value: 'color', emoji: '🎨', description: 'Hex color (e.g. #FF0000)' },
                    { label: 'Image', value: 'image', emoji: '🖼️', description: 'Large image URL' },
                    {
                        label: 'Thumbnail',
                        value: 'thumbnail',
                        emoji: '🖼️',
                        description: 'Small image URL (top-right corner)'
                    },
                    { label: 'Footer', value: 'footer', emoji: '👣', description: 'Text & icon below the embed' },
                    { label: 'Author', value: 'author', emoji: '👤', description: 'Text & icon above the embed' },
                    {
                        label: 'Add Field (normal)',
                        value: 'add_field',
                        emoji: '➕',
                        description: 'Add a field (full width)'
                    },
                    {
                        label: 'Add Field (inline)',
                        value: 'add_field_inline',
                        emoji: '➕',
                        description: 'Add a field (side by side)'
                    },
                    {
                        label: 'Remove Last Field',
                        value: 'remove_field',
                        emoji: '❌',
                        description: 'Remove the last field'
                    },
                    { label: 'Clear All Fields', value: 'clear_fields', emoji: '🧹', description: 'Remove ALL fields' },
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

        // Send the draft message
        // v3.9.8 FIX: wrap in try/catch. Previously, if the send failed (bot
        // lacking SendMessages/EmbedLinks), the session was still created in storage
        // but there was no draft message → an orphan session forever in /embed-list.
        let draftMsg;
        try {
            draftMsg = await interaction.channel.send({
                content:
                    `🛠️ **Embed Builder Draft** — started by <@${interaction.user.id}>\n` +
                    `Real-time preview below. Click the dropdown to edit sections, or the buttons to preview/send/cancel.\n` +
                    `💡 **Tip:** Select **💬 Message (plain text)** in the dropdown to add text outside the embed (great for @everyone pings or an intro line).\n` +
                    `🆔 Session: \`${session.id}\``,
                embeds: [previewEmbed],
                components: [selectRow, actionRow]
            });
        } catch (err) {
            console.error('Failed to send embed builder draft:', err);
            // Clean up the orphan session so it doesn't pile up in /embed-list.
            try {
                deleteSession(session.id);
            } catch (_) {}
            return safeEditReply(interaction, {
                content: `❌ Failed to send the draft message to this channel. Check bot permissions (Send Messages + Embed Links).`
            });
        }

        // Save the messageId to the session
        session.messageId = draftMsg.id;

        return safeEditReply(interaction, {
            content: `✅ Embed builder started!\n📍 Draft: ${draftMsg}\n\n💡 Click the dropdown on the draft to edit embed sections. When done, click **📤 Send** to send it to the target channel.`
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
                    '📭 **You have no active embed builder sessions.**\n\nUse `/embed-builder` to create a new draft.'
            });
        }

        const lines = userSessions
            .map(s => {
                const d = s.data;
                const summary = [];
                if (d.title) summary.push('title');
                if (d.description) summary.push('desc');
                // v3.9.6: show a message indicator in the summary
                if (d.content) summary.push(`msg (${d.content.length} char)`);
                if (d.fields && d.fields.length > 0)
                    summary.push(`${d.fields.length} field${d.fields.length > 1 ? 's' : ''}`);
                if (d.image) summary.push('image');
                if (d.thumbnail) summary.push('thumb');
                if (d.footer && d.footer.text) summary.push('footer');
                if (d.author && d.author.name) summary.push('author');
                const summaryStr = summary.length > 0 ? summary.join(', ') : '*(empty)*';

                const ageMs = Date.now() - s.createdAt;
                const ageMin = Math.floor(ageMs / 60000);
                const ageStr =
                    ageMin < 1
                        ? 'just now'
                        : ageMin < 60
                          ? `${ageMin}m ago`
                          : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;

                const link = s.messageId
                    ? `[🔗 open draft](https://discord.com/channels/${interaction.guild.id}/${s.channelId}/${s.messageId})`
                    : '*(draft not created yet)*';
                const channelStr = s.channelId ? `<#${s.channelId}>` : '???';

                return `• 🆔 \`${s.id}\`\n  📍 ${channelStr} | ${link}\n  ⏰ Created: ${ageStr} | 📝 ${summaryStr}`;
            })
            .join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle('🛠️ ACTIVE EMBED BUILDER SESSIONS')
            .setDescription(
                `You have **${userSessions.length}** active session(s).\n\n` +
                    lines +
                    `\n\n💡 **How to use:** Click an **open draft** link to jump to that draft message, then use the dropdown there to edit. Each draft is independent — they won't interfere with each other.`
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
                content: `❌ Session \`${sessionId}\` not found or isn't yours.\n\nUse \`/embed-list\` to see active sessions.`
            });
        }

        // Also try to delete the draft message if it still exists
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
                `🗑️ Session \`${sessionId}\` canceled.` +
                (draftDeleted ? ' The draft message was also deleted.' : ' (The draft message was no longer found.)')
        });
    }
};
