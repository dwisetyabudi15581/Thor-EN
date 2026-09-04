/**
 * Domain: responder
 * Slash commands: /add-responder, /list-responder, /remove-responder
 *
 * v3.9.13: Auto-Responder system.
 * Admin sets a trigger keyword → the bot auto-replies when a member sends a message starting with the trigger.
 */

// v3.9.24: merge 2 duplicate _shared requires into 1.
const { EmbedBuilder, MessageFlags, logAudit, safeEditReply } = require('./_shared');

const responderManager = require('../data/responderManager');
// v3.9.24: normalize literal \n → real newlines (command input on PC can't press Enter).
// The /add-responder option description does claim "supports \n" — previously
// that claim was FALSE (text stored raw, replies contained literal backslash-n).
const { normalizeNewlines } = require('../infra/text');

module.exports = async function (interaction) {
    // === ADD RESPONDER ===
    if (interaction.commandName === 'add-responder') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const trigger = interaction.options.getString('trigger');
        const reply = normalizeNewlines(interaction.options.getString('reply'));
        const replyType = interaction.options.getString('reply_type') || 'text';
        const cooldown = interaction.options.getInteger('cooldown');

        // Validate that cooldown isn't negative. 0 = disable the cooldown.
        if (cooldown !== null && cooldown < 0) {
            return safeEditReply(interaction, {
                content: '❌ `cooldown` cannot be negative. Use 0 to disable the cooldown, or at least 1 second.'
            });
        }

        const result = responderManager.addResponder(interaction.guild.id, {
            trigger,
            reply,
            replyType,
            cooldownMs: cooldown !== null ? cooldown * 1000 : 3000, // 0 = disabled, null = default 3s
            createdBy: interaction.user.id,
            createdByTag: interaction.user.tag
        });

        if (!result.ok) {
            return safeEditReply(interaction, { content: `❌ ${result.error}` });
        }

        await logAudit(interaction.client, {
            action: 'ADD_RESPONDER',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Add responder: trigger \`${result.responder.trigger}\` → "${reply.slice(0, 80)}${reply.length > 80 ? '...' : ''}"`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ Responder added!\n\n` +
                `🔤 Trigger: \`${result.responder.trigger}\`\n` +
                `💬 Reply: ${reply.slice(0, 200)}${reply.length > 200 ? '...' : ''}\n` +
                `📝 Type: ${replyType}\n` +
                `⏱️ Cooldown: ${result.responder.cooldownMs / 1000}s\n\n` +
                `💡 A member sends a message starting with \`${result.responder.trigger}\` → the bot auto-replies.`
        });
    }

    // === LIST RESPONDER ===
    if (interaction.commandName === 'list-responder') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const responders = responderManager.getGuildResponders(interaction.guild.id);
        if (responders.length === 0) {
            return safeEditReply(interaction, {
                content: '📭 No responders yet. Use `/add-responder trigger:"!sosmed" reply:"..."` to add one.'
            });
        }

        const lines = responders
            .map((r, i) => {
                const replyPreview = r.reply.length > 60 ? r.reply.slice(0, 60) + '...' : r.reply;
                return `\`${i + 1}.\` \`${r.trigger}\` → ${replyPreview} *(used ${r.useCount}x)*`;
            })
            .join('\n');

        const embed = new EmbedBuilder()
            .setTitle('💬 AUTO-RESPONDER LIST')
            .setDescription(lines)
            .setColor(0x5865f2)
            .setFooter({ text: `${responders.length}/50 responders used` })
            .setTimestamp();

        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === REMOVE RESPONDER ===
    if (interaction.commandName === 'remove-responder') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const trigger = interaction.options.getString('trigger');
        const result = responderManager.removeResponder(interaction.guild.id, trigger);

        if (!result.ok) {
            return safeEditReply(interaction, { content: `❌ ${result.error}` });
        }

        await logAudit(interaction.client, {
            action: 'REMOVE_RESPONDER',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Remove responder: trigger \`${trigger}\``,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content: `✅ Responder with trigger \`${trigger}\` successfully removed.`
        });
    }
};
