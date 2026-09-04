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
        // v3.9.26: clamp absurd values. The registry already has min_value/max_value, but
        // old data / manual config can contain weird values (xpPerMessage: -50 →
        // user LOSES XP per message; negative cooldownMs → cooldown dead).
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
                text: 'Members earn XP per message (subject to cooldown). Use /add-level-role to set up reward roles.'
            });

        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === ADD LEVEL ROLE ===
    if (interaction.commandName === 'add-level-role') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const level = interaction.options.getInteger('level');
        const role = interaction.options.getRole('role');

        if (level < 1 || level > 1000) {
            return safeEditReply(interaction, { content: '❌ Level must be between 1 and 1000.' });
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
                `✅ Level role added!\n\n📊 Level **${level}** → ${role} (${role.name})\n\n` +
                `💡 Users who reach level ${level}+ automatically get this role.`
        });
    }

    // === LIST LEVEL ROLES ===
    if (interaction.commandName === 'list-level-roles') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const roles = config.levelRoles || [];
        if (roles.length === 0) {
            return safeEditReply(interaction, {
                content: '📭 No level roles yet. Use `/add-level-role level:10 role:@Active` to add one.'
            });
        }

        const lines = roles.map(r => `• Level **${r.level}** → <@&${r.roleId}>`).join('\n');
        const embed = new EmbedBuilder()
            .setTitle('📊 LEVEL ROLES')
            .setDescription(lines)
            .setColor(0x5865f2)
            .setFooter({ text: `${roles.length} reward roles registered` });

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
            return safeEditReply(interaction, { content: `❌ No level role exists for level ${level}.` });
        }

        saveConfig(config);

        await logAudit(interaction.client, {
            action: 'REMOVE_LEVEL_ROLE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Remove level role for level ${level}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content: `✅ Level role for level ${level} successfully removed.`
        });
    }

    // === RANK (view your own or another user's level) ===
    if (interaction.commandName === 'rank') {
        // deferReply first so it doesn't time out if disk I/O is slow
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
                content: '📭 No members have XP yet. Send some messages to earn XP!'
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
