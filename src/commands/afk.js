/**
 * Domain: afk
 * Slash commands: /afk, /afk-clear, /afk-list
 *
 * v3.9.13: AFK system.
 * User sets AFK → the bot auto-replies when someone mentions them.
 * AFK auto-clears when the user sends a message again.
 */

const { EmbedBuilder, MessageFlags, safeEditReply } = require('./_shared');

// v3.9.25: convert literal \n → real newlines (PC multi-line feature)
const { normalizeNewlines } = require('../infra/text');

const afkManager = require('../data/afkManager');

module.exports = async function (interaction) {
    // === AFK (set AFK status) ===
    if (interaction.commandName === 'afk') {
        // v3.9.25: literal \n → real newlines so the AFK reason can be multi-line
        const reason = normalizeNewlines(interaction.options.getString('reason') || 'AFK');

        afkManager.setAFK(interaction.guild.id, interaction.user.id, reason);

        const embed = new EmbedBuilder()
            .setTitle('💤 AFK Status Set')
            .setColor(0xf1c40f)
            .setDescription(
                `Hello ${interaction.user}, you are now **AFK**.\n\n` +
                    `📝 Reason: ${reason}\n` +
                    `🕒 Since: <t:${Math.floor(Date.now() / 1000)}:R>\n\n` +
                    `💡 When someone mentions you, the bot will auto-reply with your reason.\n` +
                    `💡 AFK clears automatically when you send a message again.`
            )
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    // === AFK CLEAR ===
    if (interaction.commandName === 'afk-clear') {
        const cleared = afkManager.clearAFK(interaction.guild.id, interaction.user.id);
        if (!cleared) {
            return interaction.reply({
                content: 'ℹ️ You aren\'t AFK right now anyway.',
                flags: MessageFlags.Ephemeral
            });
        }
        return interaction.reply({
            content: '✅ Your AFK status has been cleared. Welcome back! 👋',
            flags: MessageFlags.Ephemeral
        });
    }

    // === AFK LIST (admin: see who is AFK in the guild) ===
    if (interaction.commandName === 'afk-list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // v3.9.17 FIX: use afkManager.listGuildAFK (encapsulation).
        // Previously, the command read afk.json directly via fs.readFileSync —
        // bypassing the manager, easily broken if the afk.json schema changes.
        const afkUsers = afkManager.listGuildAFK(interaction.guild.id);

        if (afkUsers.length === 0) {
            return safeEditReply(interaction, { content: '✅ No members are AFK right now.' });
        }

        const lines = afkUsers
            .slice(0, 25)
            .map((u, i) => {
                const duration = afkManager.formatDuration(u.since);
                const reason = u.reason.length > 50 ? u.reason.slice(0, 50) + '...' : u.reason;
                return `\`${i + 1}.\` <@${u.userId}> — ${reason} *(${duration})*`;
            })
            .join('\n');

        const embed = new EmbedBuilder()
            .setTitle(`💤 AFK MEMBERS (${afkUsers.length})`)
            .setDescription(lines)
            .setColor(0xf1c40f)
            .setTimestamp();

        return safeEditReply(interaction, { embeds: [embed] });
    }
};
