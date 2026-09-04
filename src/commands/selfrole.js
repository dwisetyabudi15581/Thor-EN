/**
 * Domain: selfrole
 * Slash commands: /setup-selfrole, /selfrole-add, /selfrole-remove,
 *                 /selfrole-list, /selfrole-delete
 *
 * Dipisah dari handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: kelola panel self-role (member pilih role sendiri via button/select).
 *
 * P0-5 FIX: rollback panel entry kalau gagal kirim message (mencegah zombie entry).
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

// v3.9.25: konversi \n literal → newline asli (fitur multi-line PC)
const { normalizeNewlines } = require('../infra/text');

module.exports = async function (interaction) {
    // ====================================================
    // === SELF-ROLE: /setup-selfrole ===
    // ====================================================
    if (interaction.commandName === 'setup-selfrole') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const title = interaction.options.getString('title');
        // v3.9.25: \n literal → newline asli biar deskripsi panel multi-baris
        const description = normalizeNewlines(interaction.options.getString('description'));
        const type = interaction.options.getString('type') || 'button';
        const exclusive = interaction.options.getBoolean('exclusive') || false;

        // Buat panel (tanpa messageId dulu, akan diupdate setelah message dikirim)
        const panel = createPanel({
            guildId: interaction.guild.id,
            channelId: interaction.channel.id,
            title,
            description,
            type,
            exclusive
        });

        // Render embed + komponen awal (komponen kosong karena belum ada role)
        const embed = buildPanelEmbed(panel, interaction.client);
        const components = buildPanelComponents(panel);

        // Kirim panel message
        // P0-5 FIX: rollback panel entry kalau gagal kirim message (sebelumnya zombie entry).
        let panelMsg;
        try {
            panelMsg = await interaction.channel.send({ embeds: [embed], components });
        } catch (err) {
            console.error('Gagal kirim self-role panel:', err.message);
            try {
                deleteSelfRolePanel(panel.id);
            } catch (_) {}
            return safeEditReply(interaction, {
                content: `❌ Gagal kirim panel ke ${interaction.channel}. Cek permission bot. Entry di-rollback.`
            });
        }
        if (!panelMsg) {
            try {
                deleteSelfRolePanel(panel.id);
            } catch (_) {}
            return safeEditReply(interaction, {
                content: `❌ Gagal kirim panel (channel tidak ada). Entry di-rollback.`
            });
        }

        // Update messageId
        setMessageId(panel.id, panelMsg.id);
        await logAudit(interaction.client, {
            action: 'SETUP_SELFROLE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Buat panel self-role **${title}** (\`${panel.id}\`) di ${interaction.channel} — tipe: ${panel.type}, exclusive: ${panel.exclusive}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ **Panel self-role dibuat!**\n\n` +
                `🆔 Panel ID: \`${panel.id}\`\n` +
                `📍 Channel: ${interaction.channel}\n` +
                `🎨 Tipe: **${panel.type}**\n` +
                `🔒 Mode: **${panel.exclusive ? 'Eksklusif (1 role)' : 'Multi (boleh banyak)'}**\n\n` +
                `💡 Sekarang tambah role ke panel pakai:\n\`\`\`\n/selfrole-add panel_id:${panel.id} role:@role label:Notif emoji:🔔\n\`\`\``
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
        // v3.9.25: \n literal → newline asli untuk deskripsi role
        const description = normalizeNewlines(interaction.options.getString('description') || '');
        // v3.9.11 Phase 3: per-role style & conditional role
        const style = interaction.options.getString('style');
        const requiresRole = interaction.options.getRole('requires_role');

        const panel = getPanel(panelId);
        if (!panel) {
            return safeEditReply(interaction, {
                content: `❌ Panel ID \`${panelId}\` tidak ditemukan. Pakai \`/selfrole-list\` untuk lihat daftar.`
            });
        }
        if (panel.guildId !== interaction.guild.id) {
            return safeEditReply(interaction, { content: `❌ Panel ini bukan dari guild ini.` });
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

        // Update panel message
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
            console.warn('Gagal update panel message:', err.message);
        }

        await logAudit(interaction.client, {
            action: 'SELFROLE_ADD',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Tambah role ${role.name} ke panel \`${panelId}\` (label: ${label})`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Role ${role} ditambahkan ke panel \`${panelId}\`.\nLabel: **${label}**${emoji ? ` | Emoji: ${emoji}` : ''}${description ? ` | Desc: ${description}` : ''}`
        });
    }

    // ====================================================
    // === SELF-ROLE: /selfrole-remove ===
    // ====================================================
    if (interaction.commandName === 'selfrole-remove') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panelId = interaction.options.getString('panel_id');
        const role = interaction.options.getRole('role');

        // v3.9.17 FIX: cross-guild check. Sebelumnya, admin Guild A yang tahu
        // panel ID dari Guild B bisa hapus role dari panel Guild B.
        const panelCheck = getPanel(panelId);
        if (!panelCheck) {
            return safeEditReply(interaction, { content: `❌ Panel ID \`${panelId}\` tidak ditemukan.` });
        }
        if (panelCheck.guildId !== interaction.guild.id) {
            return safeEditReply(interaction, { content: '❌ Panel ini bukan milik server ini.' });
        }

        const result = removeRoleFromPanel(panelId, role.id);
        if (!result.ok) {
            return safeEditReply(interaction, { content: `❌ ${result.error}` });
        }

        // Update panel message
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
            console.warn('Gagal update panel message:', err.message);
        }

        await logAudit(interaction.client, {
            action: 'SELFROLE_REMOVE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Hapus role ${role.name} dari panel \`${panelId}\``,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Role ${role} dihapus dari panel \`${panelId}\`.`
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
                content: '📭 Belum ada panel self-role di guild ini. Pakai `/setup-selfrole` untuk membuat.'
            });
        }

        const lines = panels
            .map(p => {
                const typeStr = p.type === 'select' ? '📋 Select' : '🔘 Button';
                const modeStr = p.exclusive ? '🔒 Eksklusif' : '✅ Multi';
                const rolesStr =
                    p.roles.length === 0
                        ? '_kosong_'
                        : p.roles.map(r => `${r.emoji ? r.emoji + ' ' : ''}<@&${r.roleId}>`).join(', ');
                return `• **${p.title}**\n  🆔 \`${p.id}\` | ${typeStr} | ${modeStr} | ${p.roles.length} role\n  📍 <#${p.channelId}> | [pesan](https://discord.com/channels/${p.guildId}/${p.channelId}/${p.messageId})\n  Role: ${rolesStr}`;
            })
            .join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle('🎭 DAFTAR PANEL SELF-ROLE')
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
            return safeEditReply(interaction, { content: `❌ Panel ID \`${panelId}\` tidak ditemukan.` });
        }
        // v3.9.17 FIX: cross-guild check (sama seperti /selfrole-remove).
        if (panel.guildId !== interaction.guild.id) {
            return safeEditReply(interaction, { content: '❌ Panel ini bukan milik server ini.' });
        }

        // Hapus panel message
        try {
            const channel = interaction.guild.channels.cache.get(panel.channelId);
            if (channel) {
                const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
                if (msg) await msg.delete();
            }
        } catch (err) {
            console.warn('Gagal hapus panel message:', err.message);
        }

        deletePanel(panelId);
        await logAudit(interaction.client, {
            action: 'SELFROLE_DELETE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Hapus panel self-role **${panel.title}** (\`${panelId}\`)`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, { content: `✅ Panel \`${panelId}\` (${panel.title}) berhasil dihapus.` });
    }
};
