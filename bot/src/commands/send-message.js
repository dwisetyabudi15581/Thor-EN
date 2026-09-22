/**
 * Domain: send-message
 * Slash commands: /send-message
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: send plain text to a channel (not an embed — complements /announce).
 *
 * v3.9.5: complements /announce (embed). /send-message sends plain text.
 * - Support \n for newlines (escaped automatically from slash command input)
 * - Mentions strictly validated (same as /announce)
 * - Channel must be a text channel (GuildText) — not voice/category/forum.
 * - Discord limit of 2000 chars for message content.
 */

const { MessageFlags, ChannelType, logAudit, safeEditReply, DISCORD_LIMITS } = require('./_shared');
// v3.9.24: normalize literal \n → real newlines (command input on PC can't press Enter).
const { normalizeNewlines } = require('../infra/text');

module.exports = async function (interaction) {
    if (interaction.commandName !== 'send-message') return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.options.getChannel('channel');
    const rawMessage = interaction.options.getString('message');
    const mention = interaction.options.getString('mention');

    // === Channel validation ===
    // type 0 = GuildText (Discord.js v14 ChannelType.GuildText)
    // Reject voice, category, forum, announcement threads, etc.
    if (!channel || channel.type !== ChannelType.GuildText) {
        return safeEditReply(interaction, {
            content:
                '❌ Channel must be a **text channel**.\n\n' +
                'Tip: pick a regular text channel from the dropdown — not voice, category, or forum.'
        });
    }

    // === Resolve the target channel from the guild cache (not the interaction option, which can be stale) ===
    const targetChannel = interaction.guild.channels.cache.get(channel.id);
    if (!targetChannel) {
        return safeEditReply(interaction, { content: '❌ Channel not found in this guild.' });
    }

    // Check the bot's permission to send messages in the target channel
    if (!targetChannel.permissionsFor(interaction.guild.members.me)?.has('SendMessages')) {
        return safeEditReply(interaction, {
            content:
                `❌ The bot lacks the **Send Messages** permission in ${targetChannel}.\n\n` +
                'Grant the permission to the bot or pick another channel.'
        });
    }

    // === Process the message: unescape literal \n / \r\n → real newlines ===
    // v3.9.24: moved to a shared helper (infra/text) for consistency with
    // /announce, /announce-schedule, /setup-ticket-panel, and /add-responder.
    // Previously inline here only (the only command that supported \n).
    const message = normalizeNewlines(rawMessage);

    // === Validate message length (Discord limit 2000 chars) ===
    if (message.length > DISCORD_LIMITS.MESSAGE_CONTENT) {
        return safeEditReply(interaction, {
            content:
                `❌ Message is too long (${message.length} chars, max ${DISCORD_LIMITS.MESSAGE_CONTENT} chars).\n\n` +
                'Tip: split it into 2 messages, or use `/announce` which supports 4096-char descriptions.'
        });
    }
    if (message.trim().length === 0 && !mention) {
        return safeEditReply(interaction, { content: '❌ Message cannot be empty.' });
    }

    // === Mention validation (as strict as /announce) ===
    // Only the following formats are accepted:
    //   - @everyone / everyone
    //   - @here / here
    //   - <@&ROLE_ID>      (role mention)
    //   - <@USER_ID>       (user mention)
    //   - <@!USER_ID>      (user mention, old format)
    // Anything else → rejected (prevents unwanted mention injection)
    let mentionContent = '';
    if (mention) {
        const m = mention.trim().toLowerCase();
        if (m === 'everyone' || m === '@everyone') {
            mentionContent = '@everyone';
        } else if (m === 'here' || m === '@here') {
            mentionContent = '@here';
        } else if (/^<@&\d{17,20}>$/.test(mention)) {
            mentionContent = mention;
        } else if (/^<@!?\d{17,20}>$/.test(mention)) {
            mentionContent = mention;
        } else {
            return safeEditReply(interaction, {
                content:
                    `❌ Invalid mention format: \`${mention}\`\n\n` +
                    'Supported formats:\n' +
                    '• `@everyone` or `everyone`\n' +
                    '• `@here` or `here`\n' +
                    '• `<@&ROLE_ID>` (role mention)\n' +
                    '• `<@USER_ID>` (user mention)\n\n' +
                    'Tip: to mention a role, type `@rolename` in Discord then copy the result.'
            });
        }
    }

    // === Combine mention + message ===
    // The mention goes in front, separated from the message body by a newline.
    const finalContent = mentionContent ? `${mentionContent}\n${message}`.trim() : message;

    // Safety net: if the combined result is > 2000 chars (rare, but mention + body can overflow)
    if (finalContent.length > DISCORD_LIMITS.MESSAGE_CONTENT) {
        return safeEditReply(interaction, {
            content: `❌ Total length (mention + message) exceeds ${DISCORD_LIMITS.MESSAGE_CONTENT} chars. Shorten the message or drop the mention.`
        });
    }

    // === Send the message ===
    try {
        await targetChannel.send({ content: finalContent, allowedMentions: { parse: ['everyone', 'roles', 'users'] } });
        await logAudit(interaction.client, {
            action: 'SEND_MESSAGE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Send plain text message to ${targetChannel}${mentionContent ? ` | mention: ${mentionContent}` : ''} | ${message.length} char`,
            guildId: interaction.guild.id
        });

        // Preview in the ephemeral reply (truncated if > 1500 chars so it doesn't overflow)
        const preview =
            finalContent.length > 1500
                ? finalContent.slice(0, 1500) + '\n...*(message truncated for preview)*'
                : finalContent;

        return safeEditReply(interaction, {
            content: `✅ Message sent to ${targetChannel}!\n\n📋 **Preview:**\n\`\`\`\n${preview}\n\`\`\``
        });
    } catch (err) {
        return safeEditReply(interaction, {
            content: `❌ Failed to send the message to ${targetChannel}: \`${err.message}\``
        });
    }
};
