/**
 * Domain: panels-mgmt
 * Slash commands: /list-panels, /delete-panel, /update-panel, /refresh-panel
 *
 * v3.9.14: Panel management commands. Works with panels.json
 * (see src/data/panelManager.js). Lets admins:
 *   - list all active panels
 *   - delete a panel by id (auto-deletes the channel message + removes metadata)
 *   - update a panel field (title/body/color/image/thumbnail/footer/layout) via modal
 *   - refresh a panel (re-render with the latest categories/products)
 *
 * CustomIds handled (modal):
 *   - modal_panel_edit:<panelId>:<field>
 */

const {
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    getConfig,
    logAudit,
    safeEditReply,
    EMBED_LIMITS
} = require('./_shared');

const { getPanel, getPanelsByGuild, deletePanel, patchPanel } = require('../data/panelManager');
const { buildTicketPanel, parseColor, validateUrl, findEmptyCategoryWarnings } = require('./panels');

// v3.9.26 FIX: maps command field → storage key in panels.json.
// BEFORE: /update-panel wrote a patch `{ image: value }` (key = the command
// field name), but the panel builder + panelManager read `panel.imageUrl` /
// `panel.thumbnailUrl` / `panel.footerText`. Result: the image/thumbnail/footer
// fields were "successfully" updated (metadata stored under the wrong key) but
// NEVER showed up in the panel — 3 of the 6 advertised fields were silent no-ops,
// and the modal pre-fill was always empty even when a value existed.
const FIELD_TO_STORAGE_KEY = {
    title: 'title',
    body: 'body',
    color: 'color',
    image: 'imageUrl',
    thumbnail: 'thumbnailUrl',
    footer: 'footerText'
};

// Fields editable via the /update-panel modal.
const EDITABLE_FIELDS = {
    title: {
        label: 'Panel Title (empty = use global)',
        style: TextInputStyle.Short,
        max: EMBED_LIMITS.TITLE
    },
    body: {
        label: 'Panel Body (empty = global; supports templates)',
        style: TextInputStyle.Paragraph,
        max: EMBED_LIMITS.DESCRIPTION
    },
    color: {
        label: 'Hex color (e.g. #ff5733, empty = default orange)',
        style: TextInputStyle.Short,
        max: 20
    },
    image: {
        // v3.9.29 FIX (user report: "can't put an image link"): max 500 → 2048.
        // Discord's limit for embed URLs = 2048 char. Signed Discord CDN
        // URLs (ex=/is=/hm=) can be 300-450 char, and custom URLs (imgur/GDrive
        // + long queries) easily blow past 500 → the client rejects the modal input
        // ("answer too long") before it can even be submitted.
        label: 'Large image URL (empty = no image)',
        style: TextInputStyle.Short,
        max: 2048
    },
    thumbnail: {
        // v3.9.29: see the comment on `image` — 500 is too small for real URLs.
        label: 'Small thumbnail URL (empty = no thumb)',
        style: TextInputStyle.Short,
        max: 2048
    },
    footer: {
        label: 'Footer text (empty = use bot name)',
        style: TextInputStyle.Short,
        max: EMBED_LIMITS.FOOTER_TEXT
    }
};

module.exports = async function (interaction) {
    // === LIST PANELS ===
    if (interaction.commandName === 'list-panels') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panels = getPanelsByGuild(interaction.guild.id);
        if (panels.length === 0) {
            return safeEditReply(interaction, {
                content:
                    '📭 No persistent ticket panels on this server yet.\n\n' +
                    '💡 Create one with `/setup-ticket-panel` — it will be automatically listed here.'
            });
        }

        const lines = panels
            .map((p, i) => {
                const channelMention = p.channelId ? `<#${p.channelId}>` : '_(channel missing)_';
                const title = p.title ? `**${p.title}**` : '_(default title)_';
                const catCount = Array.isArray(p.categoryIds) ? p.categoryIds.length : 0;
                const layout = p.useDropdown ? 'Dropdown' : 'Buttons';
                const date = p.createdAt ? new Date(p.createdAt).toLocaleDateString('en-US') : '?';
                return (
                    `\`${i + 1}.\` 🆔 \`${p.id}\`\n` +
                    `   ${title} — in ${channelMention}\n` +
                    `   🎫 ${catCount} categories • 🎨 ${layout} • 📅 ${date}`
                );
            })
            .join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle('🎫 TICKET PANEL LIST')
            .setDescription(lines)
            .setColor(0x5865f2)
            .setFooter({
                text: `${panels.length} active panels • Use the ID for /delete-panel, /update-panel, /refresh-panel`
            })
            .setTimestamp();

        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === DELETE PANEL ===
    if (interaction.commandName === 'delete-panel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panelId = interaction.options.getString('id');
        const panel = getPanel(panelId);

        if (!panel) {
            return safeEditReply(interaction, {
                content: `❌ Panel \`${panelId}\` not found. Use /list-panels to see the list.`
            });
        }
        // Cross-guild safety: don't allow deleting another guild's panel.
        if (panel.guildId !== interaction.guild.id) {
            return safeEditReply(interaction, {
                content: '❌ This panel belongs to another server. It cannot be deleted.'
            });
        }

        // Try to delete the channel message (best-effort — channel/message may already be gone)
        let messageDeleted = false;
        let messageNotFound = false;
        if (panel.channelId && panel.messageId) {
            try {
                const channel = await interaction.guild.channels.fetch(panel.channelId).catch(() => null);
                if (channel) {
                    const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
                    if (msg) {
                        await msg.delete();
                        messageDeleted = true;
                    } else {
                        messageNotFound = true;
                    }
                } else {
                    messageNotFound = true;
                }
            } catch (delErr) {
                console.warn(`⚠️ Failed to delete panel message ${panelId}: ${delErr.message}`);
                messageNotFound = true;
            }
        }

        // Delete the panel metadata
        const removed = deletePanel(panelId);
        if (!removed) {
            return safeEditReply(interaction, {
                content: `❌ Failed to delete panel metadata \`${panelId}\`. It may already be deleted.`
            });
        }

        await logAudit(interaction.client, {
            action: 'DELETE_PANEL',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Deleted ticket panel \`${panelId}\` (message ${messageDeleted ? 'deleted' : 'already gone'})`,
            guildId: interaction.guild.id
        });

        const status = messageDeleted
            ? '✅ Panel message deleted from the channel + metadata cleaned up.'
            : messageNotFound
              ? 'ℹ️ The panel message is already gone from the channel (possibly deleted manually). Metadata cleaned up.'
              : '✅ Panel metadata cleaned up.';

        return safeEditReply(interaction, {
            content: `✅ Panel \`${panelId}\` deleted.\n\n${status}`
        });
    }

    // === REFRESH PANEL ===
    if (interaction.commandName === 'refresh-panel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panelId = interaction.options.getString('id');
        const panel = getPanel(panelId);

        if (!panel) {
            return safeEditReply(interaction, {
                content: `❌ Panel \`${panelId}\` not found. Use /list-panels to see the list.`
            });
        }
        if (panel.guildId !== interaction.guild.id) {
            return safeEditReply(interaction, {
                content: '❌ This panel belongs to another server.'
            });
        }
        if (!panel.channelId || !panel.messageId) {
            return safeEditReply(interaction, {
                content: '❌ This panel has no message reference (possibly corrupt). Delete it and set it up again.'
            });
        }

        const config = getConfig();
        let build;
        try {
            build = buildTicketPanel(panel, {
                guild: interaction.guild,
                client: interaction.client,
                config
            });
        } catch (buildErr) {
            return safeEditReply(interaction, {
                content: `❌ Failed to rebuild the panel: ${buildErr.message}`
            });
        }

        try {
            const channel = await interaction.guild.channels.fetch(panel.channelId).catch(() => null);
            if (!channel) {
                return safeEditReply(interaction, {
                    content: `❌ Channel <#${panel.channelId}> no longer exists. Delete the panel and set it up again.`
                });
            }
            const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
            if (!msg) {
                return safeEditReply(interaction, {
                    content: '❌ The panel message is no longer in the channel. Delete the panel and set it up again.'
                });
            }

            await msg.edit({ embeds: [build.embed], components: build.components });

            await logAudit(interaction.client, {
                action: 'REFRESH_PANEL',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Refreshed panel \`${panelId}\` — re-rendered with the latest categories/products`,
                guildId: interaction.guild.id
            });

            // v3.9.29: safety net — categories on this panel that still have no
            // products. Clicking an empty category button = SUPPORT ticket (not a
            // transaction); the admin needs to know BEFORE buyers use the button.
            const emptyWarnings = findEmptyCategoryWarnings(panel, config);
            const emptyWarn =
                emptyWarnings.length > 0
                    ? `\n\n🔮 **Categories without products** (click = instant SUPPORT ticket):\n${emptyWarnings.map(l => `• ${l}`).join('\n')}`
                    : '';

            return safeEditReply(interaction, {
                content: `✅ Panel \`${panelId}\` refreshed!\n\n📬 Location: ${channel}\n🎨 Layout: ${panel.useDropdown ? 'Dropdown' : 'Buttons'}\n🎫 Categories: ${(panel.categoryIds || []).length} active${emptyWarn}`
            });
        } catch (editErr) {
            return safeEditReply(interaction, {
                content: `❌ Failed to edit the panel message: ${editErr.message}`
            });
        }
    }

    // === UPDATE PANEL — open modal for field selection ===
    if (interaction.commandName === 'update-panel') {
        const panelId = interaction.options.getString('id');
        const field = interaction.options.getString('field');
        const panel = getPanel(panelId);

        if (!panel) {
            return interaction.reply({
                content: `❌ Panel \`${panelId}\` not found. Use /list-panels to see the list.`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (panel.guildId !== interaction.guild.id) {
            return interaction.reply({
                content: '❌ This panel belongs to another server.',
                flags: MessageFlags.Ephemeral
            });
        }

        const fieldDef = EDITABLE_FIELDS[field];
        if (!fieldDef) {
            return interaction.reply({
                content: `❌ Invalid field \`${field}\`.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Pre-fill the current value (or leave empty if still default)
        // v3.9.26: read via the CORRECT storage key (mapping), not the command field name.
        const storageKey = FIELD_TO_STORAGE_KEY[field] || field;
        const currentValue = panel[storageKey] != null ? String(panel[storageKey]) : '';

        const modal = new ModalBuilder()
            .setCustomId(`modal_panel_edit:${panelId}:${field}`)
            .setTitle(`Edit ${field} — ${panelId.slice(0, 16)}...`);

        const input = new TextInputBuilder()
            .setCustomId('panel_field_value')
            .setLabel(fieldDef.label.slice(0, 45))
            .setStyle(fieldDef.style)
            .setValue(currentValue)
            .setMinLength(0)
            .setMaxLength(Math.min(fieldDef.max, 4000))
            .setRequired(false); // false so admins can "clear" the field = fall back to global

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
    }
};

// === Export the modal handler to be called from interactions/panels.js ===
// Since the interaction router does not automatically recognize the modal_panel_edit prefix,
// we register its handler in interactions/index.js (see the next step).
// v3.9.29: EDITABLE_FIELDS + FIELD_TO_STORAGE_KEY are also exported so unit
// tests can verify the modal maxLength limits (regression guard for the
// "URL > 500 char rejected by modal input" bug) and the storage key mapping.
module.exports.EDITABLE_FIELDS = EDITABLE_FIELDS;
module.exports.FIELD_TO_STORAGE_KEY = FIELD_TO_STORAGE_KEY;
module.exports.handlePanelModal = async function handlePanelModal(interaction) {
    // customId: modal_panel_edit:<panelId>:<field>
    // But panelId might contain ':' (unlikely, but defensive) — split from the right.
    const parts = interaction.customId.split(':');
    if (parts.length < 3) {
        return interaction.reply({
            content: '❌ Invalid modal customId format.',
            flags: MessageFlags.Ephemeral
        });
    }
    const field = parts[parts.length - 1];
    const panelId = parts.slice(1, -1).join(':');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

    // v3.9.26 (hardening consistent with modal_set_key / restore_backup_confirm):
    // re-check admin when the modal is submitted — not just when it opens. A modal
    // can be left open for hours; an admin demoted during that window could
    // still apply the patch without a re-check in earlier versions.
    try {
        const { isAdmin } = require('../infra/permissions');
        if (!isAdmin(interaction.member)) {
            return safeEditReply(interaction, {
                content: '❌ You do not have admin permission to edit panels.'
            });
        }
    } catch (_) {
        // If the admin check fails (e.g. a role cache error), don't block the edit —
        // the modal can only have been opened by that same admin anyway.
    }

    const panel = getPanel(panelId);
    if (!panel) {
        return safeEditReply(interaction, {
            content: `❌ Panel \`${panelId}\` not found (it may already be deleted).`
        });
    }
    if (panel.guildId !== interaction.guild.id) {
        return safeEditReply(interaction, { content: '❌ This panel belongs to another server.' });
    }

    const newValue = (interaction.fields.getTextInputValue('panel_field_value') || '').trim();
    const fieldDef = EDITABLE_FIELDS[field];
    if (!fieldDef) {
        return safeEditReply(interaction, { content: `❌ Invalid field \`${field}\`.` });
    }

    // Validate & build the patch object
    // v3.9.26: the patch is written with the STORAGE KEY (mapping) — not the command
    // field name — so the panel builder (which reads imageUrl/thumbnailUrl/footerText)
    // actually sees the change.
    const patch = {};
    const storageKey = FIELD_TO_STORAGE_KEY[field] || field;
    if (newValue === '') {
        // Empty = clear the field (fall back to the global default)
        patch[storageKey] = null;
    } else {
        // Validate per field type
        if (field === 'color') {
            try {
                patch[storageKey] = parseColor(newValue);
            } catch (colorErr) {
                return safeEditReply(interaction, { content: `❌ ${colorErr.message}` });
            }
        } else if (field === 'image' || field === 'thumbnail') {
            // v3.9.29: 2048 length guard — the Discord embed URL limit. Past this,
            // the Discord API rejects it at message edit time (vague 50035 error).
            if (newValue.length > 2048) {
                return safeEditReply(interaction, {
                    content: `❌ The ${field} URL is too long (${newValue.length} char, max 2048 — Discord embed limit). Use a shorter link.`
                });
            }
            const validated = validateUrl(newValue);
            if (!validated) {
                return safeEditReply(interaction, {
                    content: `❌ Invalid ${field} URL. Must be http(s)://...`
                });
            }
            patch[storageKey] = validated;
        } else if (newValue.length > fieldDef.max) {
            return safeEditReply(interaction, {
                content: `❌ Text is too long (${newValue.length} > ${fieldDef.max} char).`
            });
        } else {
            patch[storageKey] = newValue;
        }
    }

    // Apply patch
    const updated = patchPanel(panelId, patch);
    if (!updated) {
        return safeEditReply(interaction, { content: '❌ Failed to update the panel.' });
    }

    // Re-render the panel message so the change shows up right away
    let renderedMessage = '';
    try {
        const config = getConfig();
        const build = buildTicketPanel(updated, {
            guild: interaction.guild,
            client: interaction.client,
            config
        });
        const channel = await interaction.guild.channels.fetch(updated.channelId).catch(() => null);
        if (channel) {
            const msg = await channel.messages.fetch(updated.messageId).catch(() => null);
            if (msg) {
                await msg.edit({ embeds: [build.embed], components: build.components });
                renderedMessage = '\n\n✅ Panel message refreshed.';
            } else {
                renderedMessage = '\n\n⚠️ Panel message not found (possibly deleted). Metadata still updated.';
            }
        } else {
            renderedMessage = '\n\n⚠️ Panel channel not found. Metadata still updated.';
        }
    } catch (editErr) {
        renderedMessage = `\n\n⚠️ Failed to refresh the message: ${editErr.message} (metadata still updated).`;
    }

    await logAudit(interaction.client, {
        action: 'UPDATE_PANEL',
        actorId: interaction.user.id,
        actorTag: interaction.user.tag,
        // v3.9.29 FIX: read the patch using storageKey (previously patch[field] — always
        // `undefined` for image/thumbnail/footer because the patch is written to
        // imageUrl/thumbnailUrl/footerText).
        details: `Update field \`${field}\` panel \`${panelId}\` → ${
            patch[storageKey] === null
                ? '(clear → default)'
                : typeof patch[storageKey] === 'string' && patch[storageKey].length > 80
                  ? patch[storageKey].slice(0, 80) + '...'
                  : patch[storageKey]
        }`,
        guildId: interaction.guild.id
    });

    return safeEditReply(interaction, {
        content: `✅ Field \`${field}\` of panel \`${panelId}\` updated!${renderedMessage}`
    });
};
