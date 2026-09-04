/**
 * Domain: selfrole
 * Slash commands: /setup-selfrole, /selfrole-add, /selfrole-remove,
 *                 /selfrole-list, /selfrole-delete
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
    buildPanelEmbed,
    buildPanelComponents,
    logAudit,
    safeEditReply
} = require('./_shared');

// v3.9.25: convert literal \n → real newlines (PC multi-line feature)
const { normalizeNewlines } = require('../infra/text');

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

        // Create the panel (no messageId yet; it's updated after the message is sent)
        const panel = createPanel({
            guildId: interaction.guild.id,
            channelId: interaction.channel.id,
            title,
            description,
            type,
            exclusive
        });

        // Render the initial embed + components (components empty since there are no roles yet)
        const embed = buildPanelEmbed(panel, interaction.client);
        const components = buildPanelComponents(panel);

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
            details: `Create self-role panel **${title}** (\`${panel.id}\`) in ${interaction.channel} — type: ${panel.type}, exclusive: ${panel.exclusive}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ **Self-role panel created!**\n\n` +
                `🆔 Panel ID: \`${panel.id}\`\n` +
                `📍 Channel: ${interaction.channel}\n` +
                `🎨 Type: **${panel.type}**\n` +
                `🔒 Mode: **${panel.exclusive ? 'Exclusive (1 role)' : 'Multi (multiple allowed)'}**\n\n` +
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

        const lines = panels
            .map(p => {
                const typeStr = p.type === 'select' ? '📋 Select' : '🔘 Button';
                const modeStr = p.exclusive ? '🔒 Exclusive' : '✅ Multi';
                const rolesStr =
                    p.roles.length === 0
                        ? '_empty_'
                        : p.roles.map(r => `${r.emoji ? r.emoji + ' ' : ''}<@&${r.roleId}>`).join(', ');
                return `• **${p.title}**\n  🆔 \`${p.id}\` | ${typeStr} | ${modeStr} | ${p.roles.length} role\n  📍 <#${p.channelId}> | [message](https://discord.com/channels/${p.guildId}/${p.channelId}/${p.messageId})\n  Role: ${rolesStr}`;
            })
            .join('\n\n');

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
