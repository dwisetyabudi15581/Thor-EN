/**
 * Domain: leveling
 * Slash commands: /setup-leveling, /level-config, /add-level-role,
 *                 /list-level-roles, /remove-level-role, /rank, /leaderboard-level
 *
 * v3.9.13: Leveling system — XP per message + level + auto-role on level up.
 */

const { EmbedBuilder, MessageFlags, getConfig, saveConfig, logAudit, safeEditReply } = require('./_shared');

const levelManager = require('../data/levelManager');

module.exports = async function (interaction) {
    const config = getConfig();

    // === SETUP LEVELING (enable/disable + basic config) ===
    if (interaction.commandName === 'setup-leveling') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const enabled = interaction.options.getBoolean('enabled');
        const xpPerMessage = interaction.options.getInteger('xp_per_message');
        const cooldown = interaction.options.getInteger('cooldown');
        const announceLevelUp = interaction.options.getBoolean('announce_levelup');

        const updates = { ...(config.leveling || {}) };
        if (enabled !== null) updates.enabled = enabled;
        // v3.9.26: clamp nilai absurd. Registry sudah min_value/max_value, tapi
        // data lama / config manual bisa berisi nilai aneh (xpPerMessage: -50 →
        // user BUSA XP tiap pesan; cooldownMs negatif → cooldown mati).
        if (xpPerMessage !== null) updates.xpPerMessage = Math.max(1, Math.min(1000, xpPerMessage));
        if (cooldown !== null) updates.cooldownMs = Math.max(0, Math.min(3600, cooldown)) * 1000;
        if (announceLevelUp !== null) updates.announceLevelUp = announceLevelUp;

        config.leveling = updates;
        saveConfig(config);

        await logAudit(interaction.client, {
            action: 'SETUP_LEVELING',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Leveling ${updates.enabled ? 'ENABLED' : 'DISABLED'} | XP/msg: ${updates.xpPerMessage} | cooldown: ${updates.cooldownMs / 1000}s`,
            guildId: interaction.guild.id
        });

        const embed = new EmbedBuilder()
            .setTitle('📊 LEVELING SYSTEM')
            .setColor(updates.enabled ? 0x57f287 : 0x95a5a6)
            .addFields(
                { name: '✅ Status', value: updates.enabled ? 'Enabled ✅' : 'Disabled ❌', inline: true },
                { name: '⚡ XP per Message', value: `${updates.xpPerMessage}`, inline: true },
                { name: '⏱️ Cooldown', value: `${updates.cooldownMs / 1000}s`, inline: true },
                { name: '📢 Announce Level Up', value: updates.announceLevelUp ? 'Yes' : 'No', inline: true }
            )
            .setFooter({
                text: 'Member dapat XP tiap pesan (subject to cooldown). Pakai /add-level-role untuk setup role reward.'
            });

        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === ADD LEVEL ROLE ===
    if (interaction.commandName === 'add-level-role') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const level = interaction.options.getInteger('level');
        const role = interaction.options.getRole('role');

        if (level < 1 || level > 1000) {
            return safeEditReply(interaction, { content: '❌ Level harus antara 1 dan 1000.' });
        }

        const roles = config.levelRoles || [];
        // Remove existing entry for same level (replace)
        const filtered = roles.filter(r => r.level !== level);
        filtered.push({ level, roleId: role.id });
        filtered.sort((a, b) => a.level - b.level);

        config.levelRoles = filtered;
        saveConfig(config);

        await logAudit(interaction.client, {
            action: 'ADD_LEVEL_ROLE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Level ${level} → role ${role.name} (${role.id})`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ Level role ditambahkan!\n\n📊 Level **${level}** → ${role} (${role.name})\n\n` +
                `💡 User yang cap level ${level}+ akan otomatis dapat role ini.`
        });
    }

    // === LIST LEVEL ROLES ===
    if (interaction.commandName === 'list-level-roles') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const roles = config.levelRoles || [];
        if (roles.length === 0) {
            return safeEditReply(interaction, {
                content: '📭 Belum ada level role. Pakai `/add-level-role level:10 role:@Active` untuk tambah.'
            });
        }

        const lines = roles.map(r => `• Level **${r.level}** → <@&${r.roleId}>`).join('\n');
        const embed = new EmbedBuilder()
            .setTitle('📊 LEVEL ROLES')
            .setDescription(lines)
            .setColor(0x5865f2)
            .setFooter({ text: `${roles.length} role reward terdaftar` });

        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === REMOVE LEVEL ROLE ===
    if (interaction.commandName === 'remove-level-role') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const level = interaction.options.getInteger('level');
        const roles = config.levelRoles || [];
        const before = roles.length;
        config.levelRoles = roles.filter(r => r.level !== level);

        if (config.levelRoles.length === before) {
            return safeEditReply(interaction, { content: `❌ Tidak ada level role untuk level ${level}.` });
        }

        saveConfig(config);

        await logAudit(interaction.client, {
            action: 'REMOVE_LEVEL_ROLE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Hapus level role untuk level ${level}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content: `✅ Level role untuk level ${level} berhasil dihapus.`
        });
    }

    // === RANK (lihat level sendiri / user lain) ===
    if (interaction.commandName === 'rank') {
        // deferReply dulu biar gak timeout kalo disk I/O lambat
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const targetUser = interaction.options.getUser('user') || interaction.user;
        const userData = levelManager.getUser(interaction.guild.id, targetUser.id);

        const xpForCurrent = levelManager.xpForLevel(userData.level);
        const xpForNext = levelManager.xpForLevel(userData.level + 1);
        const xpInLevel = userData.totalXp - xpForCurrent;
        const xpNeeded = xpForNext - xpForCurrent;
        const progress = xpNeeded > 0 ? Math.round((xpInLevel / xpNeeded) * 100) : 0;

        // Progress bar
        const barLength = 20;
        const filledBars = Math.floor(progress / (100 / barLength));
        const bar = '█'.repeat(filledBars) + '░'.repeat(barLength - filledBars);

        const embed = new EmbedBuilder()
            .setTitle(`📊 Rank — ${targetUser.tag}`)
            .setColor(0xf1c40f)
            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: 'Level', value: `**${userData.level}**`, inline: true },
                { name: 'Total XP', value: `**${userData.totalXp}**`, inline: true },
                { name: 'XP Progress', value: `${xpInLevel}/${xpNeeded} (${progress}%)`, inline: false },
                { name: 'Progress Bar', value: `\`${bar}\``, inline: false }
            )
            .setFooter({
                text: `Leveling ${config.leveling?.enabled ? 'enabled' : 'disabled'} | XP/msg: ${config.leveling?.xpPerMessage || 15}`
            });

        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === LEADERBOARD LEVEL (public) ===
    if (interaction.commandName === 'leaderboard-level') {
        await interaction.deferReply();

        const top = levelManager.getTopUsers(interaction.guild.id, 10);
        if (top.length === 0) {
            return safeEditReply(interaction, {
                content: '📭 Belum ada member yang punya XP. Kirim pesan dulu untuk dapat XP!'
            });
        }

        const lines = top
            .map((u, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${i + 1}.\``;
                return `${medal} <@${u.userId}> — Level **${u.level}** (${u.totalXp} XP)`;
            })
            .join('\n');

        const embed = new EmbedBuilder()
            .setTitle('🏆 LEADERBOARD — TOP 10 (Level)')
            .setDescription(lines)
            .setColor(0xf1c40f)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();

        return safeEditReply(interaction, { embeds: [embed] });
    }
};
