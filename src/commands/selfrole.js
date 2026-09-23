/**
 * Domain: selfrole
 * Slash commands: /setup-verify, /setup-selfrole, /selfrole-add, /selfrole-remove,
 *                 /selfrole-list, /selfrole-update, /selfrole-delete
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: manage self-role panels (members pick their own roles via buttons/selects).
 *
 * v3.28.0: /setup-verify is BACK (the owner missed the dedicated verification
 * feature removed in v3.22.0). It is now a thin WIZARD over the v3.27.0 one-way
 * self-role panel: one command installs a repeat-click-safe verification panel
 * and remembers the Verified role (config.roles.verified — which also gates
 * tickets & escrow for verified-only access) + the panel id
 * (config.roles.verifyPanelId — deleted together with the panel).
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
    safeEditReply,
    getConfig,
    setField
} = require('./_shared');

// v3.9.25: convert literal \n → real newlines (PC multi-line feature)
// v4.2.0: isValidEmoji — /set-verify-button (restored) validates emoji input
// BEFORE saving (anti poison-config, v3.9.26 pattern).
const { normalizeNewlines, joinCappedLines, isValidEmoji } = require('../infra/text');

module.exports = async function (interaction) {
    // ====================================================
    // === VERIFY: /setup-verify (v3.28.0 — re-added) ===
    // ====================================================
    if (interaction.commandName === 'setup-verify') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guildId = interaction.guild.id;
        const role = interaction.options.getRole('role');
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        // v3.28.2: defaults = the OLD dedicated verification feature's exact
        // text (verifyTitle / verifyBody from before the v3.22.0 removal), so a
        // plain `/setup-verify role:@Verified` looks identical to the old days.
        const title = interaction.options.getString('title') || '✅ SERVER VERIFICATION';
        const description =
            normalizeNewlines(interaction.options.getString('description')) ||
            `Welcome to **${interaction.guild.name}**!\n\nClick the button below to get verified and gain full access to all channels.`;
        const label = interaction.options.getString('button_label') || 'Verify Me';
        const emoji = interaction.options.getString('button_emoji') || '✅';
        const style = interaction.options.getString('button_style') || 'Success';

        // Same validation as /set-role (v3.9.38): catch an unassignable role
        // BEFORE anything is created, not on the first member click.
        if (role.id === interaction.guild.id) {
            return safeEditReply(interaction, { content: '❌ @everyone cannot be used. Pick a regular role.' });
        }
        if (role.managed) {
            return safeEditReply(interaction, {
                content: '❌ This role is managed by another integration/bot — it cannot be assigned by the bot.'
            });
        }
        const botHighestPos = interaction.guild.members.me?.roles?.highest?.position ?? 0;
        if ((role.position ?? 0) >= botHighestPos) {
            return safeEditReply(interaction, {
                content:
                    '❌ This role is positioned ABOVE the bot highest role — the bot cannot assign it. ' +
                    'Move the bot role up in Server Settings → Roles, or pick another role.'
            });
        }
        if (!channel || channel.type === undefined) {
            return safeEditReply(interaction, { content: '❌ Channel not found. Pick a valid text channel.' });
        }

        // One verification panel per guild — tracked via config.roles.verifyPanelId.
        // (If the tracked panel was already deleted manually on Discord, the
        // entry is stale → the guard self-clears and a new install is allowed.)
        const config = getConfig(guildId);
        const existingId = config?.roles?.verifyPanelId;
        if (existingId) {
            const existingPanel = getPanel(existingId);
            if (existingPanel && existingPanel.guildId === guildId) {
                const existingChannel = interaction.guild.channels.cache.get(existingPanel.channelId);
                return safeEditReply(interaction, {
                    content:
                        `⚠️ A verification panel is already installed: **${existingPanel.title}** in ${
                            existingChannel || `<#${existingPanel.channelId}>`
                        } (panel ID: \`${existingId}\`).\n\n` +
                        `• Change its look → \`/selfrole-update panel_id:${existingId} …\`\n` +
                        `• Change the Verified role → \`/selfrole-add panel_id:${existingId} role:@New label:Verify Me\` + \`/selfrole-remove panel_id:${existingId} role:@Old\`\n` +
                        `• Move / reinstall it → \`/selfrole-delete panel_id:${existingId}\` first (that also clears the Verified role), then run \`/setup-verify\` again.`
                });
            }
            // Stale entry (panel already deleted) — clear it and fall through.
            setField(guildId, 'roles.verifyPanelId', null);
            setField(guildId, 'roles.verified', null);
        }

        // Create the ONE-WAY panel (once:true — the whole point of the
        // v3.27.0 fix: repeat clicks can never strip the role) with the
        // Verified role as its only button. kind:'verify' (v3.28.2) renders
        // the CLASSIC simple embed — like the old verification feature.
        const panel = createPanel({
            guildId,
            channelId: channel.id,
            title,
            description,
            type: 'button',
            exclusive: false,
            once: true,
            kind: 'verify'
        });
        const added = addRoleToPanel(panel.id, {
            roleId: role.id,
            label,
            emoji,
            style
        });
        if (!added.ok) {
            try {
                deleteSelfRolePanel(panel.id);
            } catch (_) {}
            return safeEditReply(interaction, { content: `❌ ${added.error}` });
        }

        // Render + send (P0-5 rollback pattern, identical to /setup-selfrole).
        const fresh = getPanel(panel.id);
        let embed;
        let components;
        try {
            embed = buildPanelEmbed(fresh, interaction.client);
            components = buildPanelComponents(fresh);
        } catch (renderErr) {
            try {
                deleteSelfRolePanel(panel.id);
            } catch (_) {}
            return safeEditReply(interaction, {
                content: `❌ Failed to render the panel: ${renderErr.message}\n💡 Keep the title under **256** and the description under **4000** characters. Entry rolled back.`
            });
        }
        let panelMsg;
        try {
            panelMsg = await channel.send({ embeds: [embed], components });
        } catch (sendErr) {
            try {
                deleteSelfRolePanel(panel.id);
            } catch (_) {}
            return safeEditReply(interaction, {
                content: `❌ Failed to send the panel to ${channel}: ${sendErr.message}\n💡 The bot needs **Send Messages** + **Embed Links** there. Entry rolled back.`
            });
        }
        setMessageId(panel.id, panelMsg.id);

        // Remember the Verified role (gates tickets/escrow for verified-only
        // access) + which panel is THE verification panel (one per guild).
        setField(guildId, 'roles.verified', role.id);
        setField(guildId, 'roles.verifyPanelId', panel.id);

        await logAudit(interaction.client, {
            action: 'SETUP_VERIFY',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Install verification panel **${title}** (\`${panel.id}\`) in ${channel} — Verified role: ${role.name} (one-way)`,
            guildId
        });

        return safeEditReply(interaction, {
            content:
                `✅ **Verification panel installed!**\n\n` +
                `📍 Channel: ${channel}\n` +
                `🎭 Verified role: ${role}\n` +
                `🎟️ Mode: **One-way** — members can only GAIN the role; repeat clicks never remove it (safe for Discord newcomers).\n` +
                `🎨 Look: **classic embed** — clean & green, like the old verification panel.\n\n` +
                `💡 **Tips:**\n` +
                `• Want a "new member" role that disappears once verified? \`/set-autorole action:add role:@Member\` then \`/set-autorole action:toggle\`.\n` +
                `• Tickets & escrow are now limited to verified members while the Verified role is set.\n` +
                `• Edit the panel anytime: \`/selfrole-update panel_id:${panel.id}\``
        });
    }

    // ====================================================
    // === VERIFY: /set-verify-button (v4.2.0 — RESTORED) ===
    // ====================================================
    // The classic CHRONOS command is back — restyle the verification panel's
    // button LIVE (label/emoji/style) without delete + reinstall. v4.2.0
    // adaptation: the button now lives in the verify panel's role ENTRY
    // (panel.roles[0]), not the old verifyButton config key (auto-cleaned
    // since v3.23.0) — so this edits the panel via selfRoleManager.updatePanel
    // and re-renders its message (the /selfrole-update pattern).
    if (interaction.commandName === 'set-verify-button') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guildId = interaction.guild.id;
        const label = interaction.options.getString('label');
        const emoji = interaction.options.getString('emoji'); // null = keep
        const style = interaction.options.getString('style'); // null = keep

        const config = getConfig(guildId);
        const panelId = config?.roles?.verifyPanelId;
        if (!panelId) {
            return safeEditReply(interaction, {
                content:
                    '❌ No verification panel is installed yet. Run `/setup-verify role:@Verified` first — this command only restyles that panel\'s button.'
            });
        }
        const panel = getPanel(panelId);
        if (!panel || panel.guildId !== guildId) {
            // Stale entry (panel deleted manually) — self-clear like /setup-verify.
            setField(guildId, 'roles.verifyPanelId', null);
            return safeEditReply(interaction, {
                content:
                    '❌ The verification panel was deleted. Run `/setup-verify role:@Verified` to install a new one.'
            });
        }
        const entry = Array.isArray(panel.roles) ? panel.roles[0] : null;
        if (!entry) {
            return safeEditReply(interaction, {
                content: `❌ The verification panel has no role entry — reinstall it: \`/selfrole-delete panel_id:${panelId}\` then \`/setup-verify\`.`
            });
        }

        // v3.9.26 (kept): validate the emoji BEFORE saving — a poison value
        // would break every future render of the panel.
        if (emoji !== null && !isValidEmoji(emoji)) {
            return safeEditReply(interaction, {
                content: '❌ Invalid `emoji`. Use a unicode emoji (e.g. ✅) or a custom emoji in the format `<:name:id>`.'
            });
        }
        if (!label || !label.trim()) {
            return safeEditReply(interaction, { content: '❌ The `label` cannot be empty.' });
        }

        // Build the new entry (keep roleId — the button's TARGET never changes here).
        const newEntry = {
            ...entry,
            label: label.trim().slice(0, 80),
            ...(emoji !== null ? { emoji } : {}),
            ...(style !== null ? { style } : {})
        };
        const updated = updatePanel(panelId, { roles: [newEntry, ...panel.roles.slice(1)] });
        if (!updated) {
            return safeEditReply(interaction, {
                content: '❌ Failed to update the panel (invalid entry). The panel is unchanged.'
            });
        }

        // Re-render the live panel message (the /selfrole-update pattern — best-effort).
        let rendered = '';
        let preview;
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
            console.warn('Failed to update verify panel message:', err.message);
            rendered = '\n\n⚠️ Failed to update the panel message (the config is saved).';
        }

        await logAudit(interaction.client, {
            action: 'SET_VERIFY_BUTTON',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Update verify button — label: "${newEntry.label}", emoji: ${newEntry.emoji ?? '(kept)'}, style: ${newEntry.style ?? '(kept)'}`,
            guildId
        });

        // Live preview of the new button (disabled — clicking it would verify the admin).
        try {
            const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
            const STYLE_MAP = { Primary: ButtonStyle.Primary, Secondary: ButtonStyle.Secondary, Success: ButtonStyle.Success, Danger: ButtonStyle.Danger };
            preview = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_verify_preview')
                    .setLabel(newEntry.label)
                    .setEmoji(newEntry.emoji || '✅')
                    .setStyle(STYLE_MAP[newEntry.style] || ButtonStyle.Success)
                    .setDisabled(true)
            );
        } catch (_) {
            preview = undefined; // preview is cosmetic — never fail the command for it
        }

        return safeEditReply(interaction, {
            content: `✅ Verify button updated!${rendered}\n\n**Preview:**`,
            components: preview ? [preview] : undefined
        });
    }

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

        // v3.28.0: deleting THE verification panel also clears the Verified
        // role — otherwise the ticket/escrow verified-only gate would keep
        // filtering members against a role nobody can obtain anymore
        // (a deleted panel = no way to get verified).
        let verifyClearedNote = '';
        const config = getConfig(interaction.guild.id);
        if (config?.roles?.verifyPanelId === panelId) {
            setField(interaction.guild.id, 'roles.verifyPanelId', null);
            setField(interaction.guild.id, 'roles.verified', null);
            verifyClearedNote =
                '\n🎟️ This was the **verification panel** — the Verified role was cleared with it. ' +
                'Run `/setup-verify` again to reinstall verification.';
        }

        await logAudit(interaction.client, {
            action: 'SELFROLE_DELETE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Delete self-role panel **${panel.title}** (\`${panelId}\`)`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Panel \`${panelId}\` (${panel.title}) successfully deleted.${verifyClearedNote}`
        });
    }
};
