/**
 * Domain: selfrole
 * Slash commands: /setup-selfrole, /selfrole-add, /selfrole-remove,
 *                 /selfrole-list, /selfrole-update, /selfrole-delete
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: manage self-role panels (members pick their own roles via buttons/selects).
 *
 * P0-5 FIX: roll back the panel entry if the message fails to send (prevents zombie entries).
 */

const {
    EmbedBuilder,
    MessageFlags,
    createPanel,
    addRoleToPanel,
    removeRoleFromPanel,
    getPanel,
    getPanelsByGuild,
    deletePanel,
    deleteSelfRolePanel,
    setMessageId,
    updatePanel,
    buildPanelEmbed,
    buildPanelComponents,
    logAudit,
    safeEditReply
} = require('./_shared');

// v3.9.25: convert literal \n → real newlines (PC multi-line feature)
const { normalizeNewlines, joinCappedLines } = require('../infra/text');

module.exports = async function (interaction) {
    // ====================================================
    // === SELF-ROLE: /setup-selfrole ===
    // ====================================================
    if (interaction.commandName === 'setup-selfrole') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const title = interaction.options.getString('title');
        // v3.9.25: literal \n → real newlines so the panel description can be multi-line
        const description = normalizeNewlines(interaction.options.getString('description'));
        const type = interaction.options.getString('type') || 'button';
        const exclusive = interaction.options.getBoolean('exclusive') || false;
        // v3.27.0: one-way (verification) mode — clicking only GIVES the role.
        const once = interaction.options.getBoolean('once') || false;

        // Create the panel (no messageId yet; it's updated after the message is sent)
        const panel = createPanel({
            guildId: interaction.guild.id,
            channelId: interaction.channel.id,
            title,
            description,
            type,
            exclusive,
            once
        });

        // v3.24.1 FIX (M-1): the embed/components build was OUTSIDE the P0-5
        // try/catch — a title > 256 chars (Discord allows slash option input up
        // to 6000) made buildPanelEmbed throw AFTER the panel was persisted,
        // leaving a permanent zombie entry. Roll back on ANY render failure too.
        let embed;
        let components;
        try {
            // Render the initial embed + components (components empty since there are no roles yet)
            embed = buildPanelEmbed(panel, interaction.client);
            components = buildPanelComponents(panel);
        } catch (err) {
            console.error('Failed to render the self-role panel:', err.message);
            try {
                deleteSelfRolePanel(panel.id);
            } catch (_) {}
            return safeEditReply(interaction, {
                content:
                    `❌ Failed to render the panel: ${err.message}\n` +
                    `💡 Keep the title under **256 characters** and the description under **4000 characters**. Entry rolled back.`
            });
        }

        // Send the panel message
        // P0-5 FIX: roll back the panel entry if the message fails to send (previously a zombie entry).
        let panelMsg;
        try {
            panelMsg = await interaction.channel.send({ embeds: [embed], components });
        } catch (err) {
            console.error('Failed to send self-role panel:', err.message);
            try {
                deleteSelfRolePanel(panel.id);
            } catch (_) {}
            return safeEditReply(interaction, {
                content: `❌ Failed to send the panel to ${interaction.channel}. Check bot permissions. Entry rolled back.`
            });
        }
        if (!panelMsg) {
            try {
                deleteSelfRolePanel(panel.id);
            } catch (_) {}
            return safeEditReply(interaction, {
                content: `❌ Failed to send the panel (channel not found). Entry rolled back.`
            });
        }

        // Update the messageId
        setMessageId(panel.id, panelMsg.id);
        await logAudit(interaction.client, {
            action: 'SETUP_SELFROLE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Create self-role panel **${title}** (\`${panel.id}\`) in ${interaction.channel} — type: ${panel.type}, exclusive: ${panel.exclusive}, once: ${panel.once}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ **Self-role panel created!**\n\n` +
                `🆔 Panel ID: \`${panel.id}\`\n` +
                `📍 Channel: ${interaction.channel}\n` +
                `🎨 Type: **${panel.type}**\n` +
                `🔒 Mode: **${panel.once ? 'One-way (verification)' : panel.exclusive ? 'Exclusive (1 role)' : 'Multi (multiple allowed)'}**\n\n` +
                `💡 Now add roles to the panel with:\n\`\`\`\n/selfrole-add panel_id:${panel.id} role:@role label:Notif emoji:🔔\n\`\`\``
        });
    }

    // ====================================================
    // === SELF-ROLE: /selfrole-add ===
    // ====================================================
    if (interaction.commandName === 'selfrole-add') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panelId = interaction.options.getString('panel_id');
        const role = interaction.options.getRole('role');
        const label = interaction.options.getString('label');
        const emoji = interaction.options.getString('emoji') || '';
        // v3.9.25: literal \n → real newlines for the role description
        const description = normalizeNewlines(interaction.options.getString('description') || '');
        // v3.9.11 Phase 3: per-role style & conditional role
        const style = interaction.options.getString('style');
        const requiresRole = interaction.options.getRole('requires_role');

        const panel = getPanel(panelId);
        if (!panel) {
            return safeEditReply(interaction, {
                content: `❌ Panel ID \`${panelId}\` not found. Use \`/selfrole-list\` to see the list.`
            });
        }
        if (panel.guildId !== interaction.guild.id) {
            return safeEditReply(interaction, { content: `❌ This panel doesn't belong to this guild.` });
        }

        const result = addRoleToPanel(panelId, {
            roleId: role.id,
            label,
            emoji,
            description,
            // v3.9.11 Phase 3
            style: style || 'Secondary',
            requiresRoleId: requiresRole?.id || null
        });
        if (!result.ok) {
            return safeEditReply(interaction, { content: `❌ ${result.error}` });
        }

        // Update the panel message
        const updatedPanel = result.panel;
        try {
            const channel = interaction.guild.channels.cache.get(updatedPanel.channelId);
            if (channel) {
                const msg = await channel.messages.fetch(updatedPanel.messageId).catch(() => null);
                if (msg) {
                    const embed = buildPanelEmbed(updatedPanel, interaction.client);
                    const components = buildPanelComponents(updatedPanel);
                    await msg.edit({ embeds: [embed], components });
                }
            }
        } catch (err) {
            console.warn('Failed to update panel message:', err.message);
        }

        await logAudit(interaction.client, {
            action: 'SELFROLE_ADD',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Add role ${role.name} to panel \`${panelId}\` (label: ${label})`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Role ${role} added to panel \`${panelId}\`.\nLabel: **${label}**${emoji ? ` | Emoji: ${emoji}` : ''}${description ? ` | Desc: ${description}` : ''}`
        });
    }

    // ====================================================
    // === SELF-ROLE: /selfrole-remove ===
    // ====================================================
    if (interaction.commandName === 'selfrole-remove') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panelId = interaction.options.getString('panel_id');
        const role = interaction.options.getRole('role');

        // v3.9.17 FIX: cross-guild check. Previously, a Guild A admin who knew
        // Guild B's panel ID could remove roles from Guild B's panel.
        const panelCheck = getPanel(panelId);
        if (!panelCheck) {
            return safeEditReply(interaction, { content: `❌ Panel ID \`${panelId}\` not found.` });
        }
        if (panelCheck.guildId !== interaction.guild.id) {
            return safeEditReply(interaction, { content: '❌ This panel does not belong to this server.' });
        }

        const result = removeRoleFromPanel(panelId, role.id);
        if (!result.ok) {
            return safeEditReply(interaction, { content: `❌ ${result.error}` });
        }

        // Update the panel message
        const updatedPanel = result.panel;
        try {
            const channel = interaction.guild.channels.cache.get(updatedPanel.channelId);
            if (channel) {
                const msg = await channel.messages.fetch(updatedPanel.messageId).catch(() => null);
                if (msg) {
                    const embed = buildPanelEmbed(updatedPanel, interaction.client);
                    const components = buildPanelComponents(updatedPanel);
                    await msg.edit({ embeds: [embed], components });
                }
            }
        } catch (err) {
            console.warn('Failed to update panel message:', err.message);
        }

        await logAudit(interaction.client, {
            action: 'SELFROLE_REMOVE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Remove role ${role.name} from panel \`${panelId}\``,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Role ${role} removed from panel \`${panelId}\`.`
        });
    }

    // ====================================================
    // === SELF-ROLE: /selfrole-list ===
    // ====================================================
    if (interaction.commandName === 'selfrole-list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panels = getPanelsByGuild(interaction.guild.id);
        if (panels.length === 0) {
            return safeEditReply(interaction, {
                content: '📭 No self-role panels in this guild yet. Use `/setup-selfrole` to create one.'
            });
        }

        // v3.24.1 FIX (M-2): capped list — ~900 chars per panel with 25 role
        // mentions > the 4096 embed description limit at ~5 populated panels →
        // setDescription threw → the command was dead.
        const lines = joinCappedLines(
            panels,
            p => {
                const typeStr = p.type === 'select' ? '📋 Select' : '🔘 Button';
                const modeStr = p.once ? '🎟️ One-way' : p.exclusive ? '🔒 Exclusive' : '✅ Multi';
                const rolesStr =
                    p.roles.length === 0
                        ? '_empty_'
                        : p.roles.map(r => `${r.emoji ? r.emoji + ' ' : ''}<@&${r.roleId}>`).join(', ');
                return `• **${p.title}**\n  🆔 \`${p.id}\` | ${typeStr} | ${modeStr} | ${p.roles.length} role\n  📍 <#${p.channelId}> | [message](https://discord.com/channels/${p.guildId}/${p.channelId}/${p.messageId})\n  Role: ${rolesStr}`;
            },
            4000,
            '\n\n'
        );

        const embed = new EmbedBuilder()
            .setTitle('🎭 SELF-ROLE PANEL LIST')
            .setDescription(lines)
            .setColor(0x9b59b6)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === SELF-ROLE: /selfrole-update (v3.26.0) ===
    // === Edit an existing panel without delete + recreate ===
    // ====================================================
    if (interaction.commandName === 'selfrole-update') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panelId = interaction.options.getString('panel_id');
        const title = interaction.options.getString('title'); // null = keep
        // v3.9.25 pattern: literal \n → real newlines for the description
        const description = interaction.options.getString('description'); // null = keep
        const type = interaction.options.getString('type'); // null = keep
        const exclusive = interaction.options.getBoolean('exclusive'); // null = keep
        // v3.27.0: flip one-way (verification) mode on/off on a LIVE panel.
        const once = interaction.options.getBoolean('once'); // null = keep

        const panel = getPanel(panelId);
        if (!panel) {
            return safeEditReply(interaction, {
                content: `❌ Panel ID \`${panelId}\` not found. Use \`/selfrole-list\` to see the list.`
            });
        }
        if (panel.guildId !== interaction.guild.id) {
            return safeEditReply(interaction, { content: '❌ This panel does not belong to this server.' });
        }
        if (title === null && description === null && type === null && exclusive === null && once === null) {
            return safeEditReply(interaction, {
                content: 'ℹ️ Nothing to update — fill in at least one option (title / description / type / exclusive / once).'
            });
        }

        const updates = {};
        if (title !== null) updates.title = title;
        if (description !== null) updates.description = normalizeNewlines(description);
        if (type !== null) updates.type = type;
        if (exclusive !== null) updates.exclusive = exclusive;
        if (once !== null) updates.once = once;

        const updated = updatePanel(panelId, updates);
        if (!updated) {
            return safeEditReply(interaction, {
                content: '❌ Failed to update the panel (empty title?). The panel is unchanged.'
            });
        }

        // Re-render the panel message so the change is visible immediately
        // (same pattern as /selfrole-add & /selfrole-remove — best-effort).
        let rendered = '';
        try {
            const channel = interaction.guild.channels.cache.get(updated.channelId);
            if (channel) {
                const msg = updated.messageId
                    ? await channel.messages.fetch(updated.messageId).catch(() => null)
                    : null;
                if (msg) {
                    await msg.edit({
                        embeds: [buildPanelEmbed(updated, interaction.client)],
                        components: buildPanelComponents(updated)
                    });
                    rendered = '\n\n✅ The panel message has been updated.';
                } else {
                    rendered = '\n\n⚠️ The panel message could not be found (deleted?) — the config is saved.';
                }
            }
        } catch (err) {
            console.warn('Failed to update panel message:', err.message);
            rendered = '\n\n⚠️ Failed to update the panel message (the config is saved).';
        }

        await logAudit(interaction.client, {
            action: 'SELFROLE_UPDATE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Update panel **${updated.title}** (\`${panelId}\`) — ${Object.keys(updates).join(', ')}`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content:
                `✅ Panel **${updated.title}** updated!${rendered}\n\n` +
                `🎨 Type: **${updated.type === 'select' ? 'Select Menu' : 'Buttons'}** · ` +
                `🔒 Mode: **${updated.once ? 'One-way (verification)' : updated.exclusive ? 'Exclusive (1 role)' : 'Multi'}** · ` +
                `🎭 ${updated.roles.length} role(s)`
        });
    }

    // ====================================================
    // === SELF-ROLE: /selfrole-delete ===
    // ====================================================
    if (interaction.commandName === 'selfrole-delete') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panelId = interaction.options.getString('panel_id');
        const panel = getPanel(panelId);
        if (!panel) {
            return safeEditReply(interaction, { content: `❌ Panel ID \`${panelId}\` not found.` });
        }
        // v3.9.17 FIX: cross-guild check (same as /selfrole-remove).
        if (panel.guildId !== interaction.guild.id) {
            return safeEditReply(interaction, { content: '❌ This panel does not belong to this server.' });
        }

        // Delete the panel message
        try {
            const channel = interaction.guild.channels.cache.get(panel.channelId);
            if (channel) {
                const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
                if (msg) await msg.delete();
            }
        } catch (err) {
            console.warn('Failed to delete panel message:', err.message);
        }

        deletePanel(panelId);
        await logAudit(interaction.client, {
            action: 'SELFROLE_DELETE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Delete self-role panel **${panel.title}** (\`${panelId}\`)`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, { content: `✅ Panel \`${panelId}\` (${panel.title}) successfully deleted.` });
    }
};
