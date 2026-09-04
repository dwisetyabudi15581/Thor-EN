/**
 * Domain: announce
 * Slash commands: /announce, /announce-schedule, /announce-list, /announce-cancel
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: send an announce embed to a channel (quick / scheduled).
 *
 * v3.9.1: strict mention validation (no injection).
 * v3.9.3: validate Discord embed length limits.
 * v3.9.8: separate logAudit from send so an audit failure doesn't abort the announce.
 */

const {
    EmbedBuilder,
    MessageFlags,
    createScheduledAnn,
    getScheduledAnnsByGuild,
    getScheduledAnn,
    removeScheduledAnn,
    parseAnnTime,
    parseColor,
    logAudit,
    safeEditReply,
    EMBED_LIMITS
} = require('./_shared');
// v3.9.24: normalize literal \n → real newlines (command input on PC can't press Enter).
// v3.9.38: truncateUtf8Safe — truncate text per code point (emoji-safe) to cap description.
const { normalizeNewlines, truncateUtf8Safe } = require('../infra/text');
// v3.9.38 FIX: ChannelType for validating the announce target channel type
// (category/forum/voice channels can't receive announce messages).
const { ChannelType } = require('discord.js');

module.exports = async function (interaction) {
    // ====================================================
    // === /announce — QUICK ANNOUNCE (1 command, 1 embed) ===
    // ====================================================
    if (interaction.commandName === 'announce') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const channel = interaction.options.getChannel('channel');

        // v3.9.38 FIX: validate channel type — category/forum/voice channels
        // can't receive announces. Previously it only failed at send() with a generic error.
        // GuildAnnouncement (type 5) is allowed — that channel is meant for broadcasts.
        if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
            return safeEditReply(interaction, {
                content: '❌ Channel must be a regular text channel (not a category/forum/voice channel).'
            });
        }

        const title = interaction.options.getString('title');
        // v3.9.24: support literal \n → real newlines (previously only /send-message supported it).
        // Normalize BEFORE length validation so the limit is computed on the final text.
        const description = normalizeNewlines(interaction.options.getString('description'));
        const colorStr = interaction.options.getString('color');
        const image = interaction.options.getString('image');
        const thumbnail = interaction.options.getString('thumbnail');
        const mention = interaction.options.getString('mention');

        // Parse color
        let color = 0x5865f2; // default blurple
        if (colorStr) {
            const parsed = parseColor(colorStr);
            if (parsed === null) {
                return safeEditReply(interaction, {
                    content: `❌ Invalid color: \`${colorStr}\`. Use 6-digit hex format, e.g. \`#FF0000\` or \`FF0000\`.`
                });
            }
            color = parsed;
        }

        // v3.9.3: validate Discord embed length limits before setTitle/setDescription.
        // The Discord API throws a RangeError if title > 256 or description > 4096,
        // which previously got caught by the outer try-catch as a generic "An error occurred".
        if (title.length > EMBED_LIMITS.TITLE) {
            return safeEditReply(interaction, {
                content: `❌ Title is too long (${title.length} chars, max ${EMBED_LIMITS.TITLE}).`
            });
        }
        if (description.length > EMBED_LIMITS.DESCRIPTION) {
            return safeEditReply(interaction, {
                content: `❌ Description is too long (${description.length} chars, max ${EMBED_LIMITS.DESCRIPTION}).`
            });
        }

        // Validate URLs
        if (image && !/^https?:\/\//i.test(image)) {
            return safeEditReply(interaction, { content: '❌ Image URL must start with `http://` or `https://`' });
        }
        if (thumbnail && !/^https?:\/\//i.test(thumbnail)) {
            return safeEditReply(interaction, {
                content: '❌ Thumbnail URL must start with `http://` or `https://`'
            });
        }

        // Build embed
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setFooter({
                text: `Announced by ${interaction.user.tag}`,
                iconURL: interaction.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        if (image) embed.setImage(image);
        if (thumbnail) embed.setThumbnail(thumbnail);

        // Resolve target channel
        const targetChannel = interaction.guild.channels.cache.get(channel.id);
        if (!targetChannel) {
            return safeEditReply(interaction, { content: '❌ Channel not found.' });
        }

        // Build content (mention)
        // v3.9.1 FIX: validate mentions strictly. Previously, an admin could
        // pass an arbitrary string as `mention` (e.g. "hello @everyone world")
        // which would leak into the target channel and trigger unwanted
        // pings. Now only the following formats are accepted:
        //   - @everyone / everyone
        //   - @here / here
        //   - <@&ROLE_ID>      (role mention)
        //   - <@USER_ID>       (user mention)
        //   - <@!USER_ID>      (user mention, old format)
        // Anything else → rejected with an error message.
        let content = undefined;
        if (mention) {
            const m = mention.trim().toLowerCase();
            if (m === 'everyone' || m === '@everyone') {
                content = '@everyone';
            } else if (m === 'here' || m === '@here') {
                content = '@here';
            } else if (/^<@&\d{17,20}>$/.test(mention)) {
                // Role mention: <@&123456789012345678>
                content = mention;
            } else if (/^<@!?\d{17,20}>$/.test(mention)) {
                // User mention: <@123456789012345678> or <@!123456789012345678>
                content = mention;
            } else {
                return safeEditReply(interaction, {
                    content:
                        `❌ Invalid mention format: \`${mention}\`\n\n` +
                        `Supported formats:\n` +
                        `• \`@everyone\` or \`everyone\`\n` +
                        `• \`@here\` or \`here\`\n` +
                        `• \`<@&ROLE_ID>\` (role mention)\n` +
                        `• \`<@USER_ID>\` (user mention)\n\n` +
                        `Tip: to mention a role, type \`@rolename\` in Discord then copy the result.`
                });
            }
        }

        try {
            await targetChannel.send({ content, embeds: [embed] });
            // v3.9.8 FIX: separate logAudit from send so if audit throws
            // (audit channel missing / DB write error), the admin isn't told
            // "Failed to send to channel" when the announce actually went through.
            try {
                await logAudit(interaction.client, {
                    action: 'ANNOUNCE_SEND',
                    actorId: interaction.user.id,
                    actorTag: interaction.user.tag,
                    details: `Send announce to ${targetChannel}: **${title}**${mention ? ` | mention: ${mention}` : ''}`,
                    guildId: interaction.guild.id
                });
            } catch (auditErr) {
                console.warn(`⚠️ Failed to log announce audit (announce still sent): ${auditErr.message}`);
            }
            return safeEditReply(interaction, {
                content: `✅ Announce sent to ${targetChannel}!\n\n📋 **Preview:**`,
                embeds: [embed]
            });
        } catch (err) {
            return safeEditReply(interaction, { content: `❌ Failed to send to ${targetChannel}: ${err.message}` });
        }
    }

    // ====================================================
    // === /announce-schedule ===
    // ====================================================
    if (interaction.commandName === 'announce-schedule') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const channel = interaction.options.getChannel('channel');

        // v3.9.38 FIX: validate channel type — same as /announce. Previously
        // category/voice channels passed → the announce got scheduled, then FAILED
        // SILENTLY at fire time (wasted entry; the admin only later realized the announce never sent).
        if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
            return safeEditReply(interaction, {
                content: '❌ Channel must be a regular text channel (not a category/forum/voice channel).'
            });
        }

        const title = interaction.options.getString('title');
        // v3.9.24: support literal \n → real newlines (consistent with /announce).
        const description = normalizeNewlines(interaction.options.getString('description'));
        const at = interaction.options.getString('at');
        const color = interaction.options.getString('color');
        const image = interaction.options.getString('image');
        const thumbnail = interaction.options.getString('thumbnail');
        const mention = interaction.options.getString('mention');
        const recurring = interaction.options.getString('recurring') || null;

        // Parse time
        const sendAt = parseAnnTime(at);
        if (!sendAt) {
            return safeEditReply(interaction, {
                content:
                    '❌ Invalid time format.\n\nSupported formats:\n• Relative: `30m`, `2h`, `1d`\n• Absolute: `2026-01-15 20:00` (bot timezone — default WITA/UTC+8, changeable via env TZ_OFFSET_HOURS; format YYYY-MM-DD HH:MM)'
            });
        }
        if (sendAt <= Date.now()) {
            return safeEditReply(interaction, {
                content: '❌ The time you entered is in the past. Use a time in the future.'
            });
        }

        // Parse color
        let colorNum = 0x5865f2;
        if (color) {
            const parsed = parseColor(color);
            if (parsed === null) {
                return safeEditReply(interaction, {
                    content: `❌ Invalid color: \`${color}\`. Use 6-digit hex format, e.g. \`#FF0000\` or \`FF0000\`.`
                });
            }
            colorNum = parsed;
        }

        // v3.9.3: validate Discord embed length limits (same as /announce).
        // The embedded announce is sent at the scheduled time; if title/description
        // is over the limit, EmbedBuilder throws while processScheduledAnnouncement
        // runs → the announce fails to send and the entry is stuck in scheduledAnns.json.
        if (title.length > EMBED_LIMITS.TITLE) {
            return safeEditReply(interaction, {
                content: `❌ Title is too long (${title.length} chars, max ${EMBED_LIMITS.TITLE}).`
            });
        }
        if (description.length > EMBED_LIMITS.DESCRIPTION) {
            return safeEditReply(interaction, {
                content: `❌ Description is too long (${description.length} chars, max ${EMBED_LIMITS.DESCRIPTION}).`
            });
        }

        // Validate URLs
        if (image && !/^https?:\/\//.test(image)) {
            return safeEditReply(interaction, { content: '❌ Image URL must start with `http://` or `https://`' });
        }
        if (thumbnail && !/^https?:\/\//.test(thumbnail)) {
            return safeEditReply(interaction, {
                content: '❌ Thumbnail URL must start with `http://` or `https://`'
            });
        }

        // v3.9.1 FIX: validate mention (same as /announce) so an admin
        // can't inject arbitrary strings that trigger unwanted pings.
        if (mention) {
            const m = mention.trim().toLowerCase();
            const isValidMention =
                m === 'everyone' ||
                m === '@everyone' ||
                m === 'here' ||
                m === '@here' ||
                /^<@&\d{17,20}>$/.test(mention) ||
                /^<@!?\d{17,20}>$/.test(mention);
            if (!isValidMention) {
                return safeEditReply(interaction, {
                    content: `❌ Invalid mention format: \`${mention}\`\n\nSupported formats: \`@everyone\`, \`@here\`, \`<@&ROLE_ID>\`, \`<@USER_ID>\`.`
                });
            }
        }

        const entry = createScheduledAnn({
            guildId: interaction.guild.id,
            channelId: channel.id,
            sendAt,
            title,
            description,
            color: colorNum,
            image,
            thumbnail,
            mention,
            authorId: interaction.user.id,
            authorTag: interaction.user.tag,
            recurring
        });

        await logAudit(interaction.client, {
            action: 'ANNOUNCE_SCHEDULE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Schedule announce to ${channel} at <t:${Math.floor(sendAt / 1000)}:F>${recurring ? ` (recurring: ${recurring})` : ''} — Title: "${title}"`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ **Announce scheduled!**\n\n` +
                `📍 Channel: ${channel}\n` +
                `⏰ Send at: <t:${Math.floor(sendAt / 1000)}:F> (<t:${Math.floor(sendAt / 1000)}:R>)\n` +
                (recurring ? `🔄 Recurring: **${recurring}**\n` : '') +
                `📝 Title: ${title}\n` +
                `🆔 ID: \`${entry.id}\`\n\n` +
                `💡 Check with \`/announce-list\`, cancel with \`/announce-cancel id:${entry.id}\``
        });
    }

    // ====================================================
    // === /announce-list ===
    // ====================================================
    if (interaction.commandName === 'announce-list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const entries = getScheduledAnnsByGuild(interaction.guild.id);
        const pending = entries.filter(e => !e.sent);
        if (pending.length === 0) {
            return safeEditReply(interaction, {
                content: '📭 No pending scheduled announces. Use `/announce-schedule` to create one.'
            });
        }
        // v3.9.38 FIX: cap displayed entries (15) + suffix; total description
        // is ALWAYS computed against the 4096 limit — previously lines were unbounded →
        // setDescription threw a RangeError at ~27 pending (the /announce-list
        // command was completely dead until entries dropped via send/cancel).
        const MAX_SHOWN_ENTRIES = 15;
        const entryLine = e => {
            return `• 📝 **${e.data.title}**\n  🆔 \`${e.id}\`\n  📍 <#${e.channelId}> | ⏰ <t:${Math.floor(e.sendAt / 1000)}:F> (<t:${Math.floor(e.sendAt / 1000)}:R>)\n  ${e.recurring ? `🔄 Recurring: ${e.recurring}\n  ` : ''}👤 By: ${e.data.authorTag}`;
        };
        const listHeader = `Total **${pending.length}** pending announcements.\n\n`;
        let listDescription = '';
        for (let n = Math.min(MAX_SHOWN_ENTRIES, pending.length); n >= 1; n--) {
            const shown = pending.slice(0, n);
            const hidden = pending.length - shown.length;
            const footerNote = hidden > 0 ? `\n\n… +${hidden} more announcements` : '';
            listDescription = `${listHeader}${shown.map(entryLine).join('\n\n')}${footerNote}`;
            if (listDescription.length <= EMBED_LIMITS.DESCRIPTION) break;
        }
        // Last line of defense: a single super-long entry (practically impossible —
        // title ≤ 256 is validated at schedule time) → truncate per code point.
        // maxLen - 1 so the total WITH ellipsis still stays ≤ 4096 code units.
        if (listDescription.length > EMBED_LIMITS.DESCRIPTION) {
            listDescription = truncateUtf8Safe(listDescription, EMBED_LIMITS.DESCRIPTION - 1);
        }
        const embed = new EmbedBuilder()
            .setTitle('⏰ SCHEDULED ANNOUNCES')
            .setDescription(listDescription)
            .setColor(0x5865f2)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /announce-cancel ===
    // ====================================================
    if (interaction.commandName === 'announce-cancel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const id = interaction.options.getString('id');
        const entry = getScheduledAnn(id);
        if (!entry) return safeEditReply(interaction, { content: `❌ Announce ID \`${id}\` not found.` });
        if (entry.sent)
            return safeEditReply(interaction, { content: `❌ This announce has already been sent and can't be canceled.` });
        if (entry.guildId !== interaction.guild.id)
            return safeEditReply(interaction, { content: "❌ This announce doesn't belong to this guild." });
        removeScheduledAnn(id);
        await logAudit(interaction.client, {
            action: 'ANNOUNCE_CANCEL',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Cancel scheduled announce \`${id}\` (Title: "${entry.data.title}")`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, { content: `✅ Announce \`${id}\` (${entry.data.title}) canceled.` });
    }
};
