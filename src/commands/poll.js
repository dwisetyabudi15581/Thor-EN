/**
 * Domain: poll
 * Slash commands: /poll (subcommands: create, list, close)
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: create polls (modal → options), list polls, close polls + update messages.
 *
 * v3.9.1: store poll data in an in-memory session (not in the customId) so
 *         long questions don't overflow Discord's 100-char limit.
 *
 * Note: the `updatePollMessage` helper was split from commandHandler.js and
 *          declared as a local function in this file (previously it lived
 *          at the bottom of commandHandler.js).
 */

const {
    EmbedBuilder,
    ButtonBuilder,
    ActionRowBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    getPoll,
    getPollsByGuild,
    closePoll,
    getPollTotalVotes,
    createPollSession,
    logAudit,
    safeEditReply
} = require('./_shared');

module.exports = async function (interaction) {
    // ====================================================
    // === /poll ===
    // ====================================================
    if (interaction.commandName !== 'poll') return;

    // v3.9.26 FIX: getSubcommand(false). The registry marks all subcommands
    // required:false → Discord MAY send /poll without a subcommand → getSubcommand()
    // throws CommandInteractionOptionNoSubcommand (unhandled, full stack in the log,
    // user sees a generic error). Now: a clear usage hint.
    const sub = interaction.options.getSubcommand(false);
    if (!sub) {
        return interaction.reply({
            content: '❌ Use a subcommand: `/poll create`, `/poll list`, or `/poll close`.',
            flags: MessageFlags.Ephemeral
        });
    }

    // --- /poll create ---
    if (sub === 'create') {
        const channel = interaction.options.getChannel('channel');
        const question = interaction.options.getString('question');
        const multiple = interaction.options.getBoolean('multiple') || false;

        // v3.9.26 FIX: validate BEFORE the session/modal. A question > ~250 chars makes
        // `setTitle(\`📊 ${question}\`)` throw (>256) LATER in the modal handler —
        // after the poll PERSISTS to polls.json (zombie) and after deferReply
        // (the error reply gets swallowed → user stuck at "Bot is thinking..."). Checking here
        // = cheap + a clear message.
        if (!question || question.length > 250) {
            return interaction.reply({
                content: `❌ The poll question is required and max 250 characters (got: ${question ? question.length : 0}).`,
                flags: MessageFlags.Ephemeral
            });
        }
        // v3.9.26: polls only make sense in a text channel (voice/category makes
        // channel.send fail in the modal handler with a misleading message).
        if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
            return interaction.reply({
                content: '❌ Channel must be a text channel (or announcement).',
                flags: MessageFlags.Ephemeral
            });
        }
        // v3.9.1 FIX: store poll data in an in-memory session, not in the customId.
        // Previously customId = `poll_modal_create:${channel.id}:${multiple}:${encodeURIComponent(question)}`
        // which could overflow Discord's 100-char limit for long questions
        // (esp. after encodeURIComponent — spaces become %20, etc).
        // Now customId = `poll_modal_create:${sessionId}` (~50 chars, safe).
        const sessionId = createPollSession({
            userId: interaction.user.id,
            channelId: channel.id,
            multiple,
            question
        });

        // Open a modal to input options (one field, split by newlines)
        const modal = new ModalBuilder()
            .setCustomId(`poll_modal_create:${sessionId}`)
            .setTitle('Create Poll — Enter Options');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('options')
                    .setLabel('Options (1 per line, min 2, max 10)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setPlaceholder('Rank Push\nCustom Room\nTournament\nOff')
                    .setMaxLength(500)
            )
        );
        return interaction.showModal(modal);
    }

    // --- /poll list ---
    if (sub === 'list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const polls = getPollsByGuild(interaction.guild.id);
        if (polls.length === 0) {
            return safeEditReply(interaction, { content: '📭 No polls in this guild yet.' });
        }
        // v3.9.26 FIX: bound description. Closed polls are never removed from
        // polls.json — at ~25-30 polls, total lines > 4096 → setDescription THROWS
        // → /poll list (and the only way to see IDs for /poll close) goes
        // permanently dead. Now: show the latest 15 + summarize the rest.
        const MAX_SHOWN = 15;
        const shown = polls.slice(-MAX_SHOWN);
        const hidden = polls.length - shown.length;
        const lines = shown
            .map(p => {
                const status = p.closed ? '🔒 Closed' : '🟢 Active';
                const total = getPollTotalVotes(p);
                return `• ❓ **${p.question}** — ${status}\n  🆔 \`${p.id}\` | 👥 ${p.options.length} options | 🗳️ ${total} votes\n  📍 <#${p.channelId}> | ⏰ <t:${Math.floor(p.createdAt / 1000)}:R>`;
            })
            .join('\n\n');
        const header = `Total **${polls.length}** polls${hidden > 0 ? ` (showing the ${shown.length} latest — ${hidden} older hidden)` : ''}.`;
        const embed = new EmbedBuilder()
            .setTitle('📊 POLL LIST')
            .setDescription(`${header}\n\n${lines.slice(0, 3900)}`)
            .setColor(0x5865f2)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // --- /poll close ---
    if (sub === 'close') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const id = interaction.options.getString('id');
        const poll = getPoll(id);
        if (!poll) return safeEditReply(interaction, { content: `❌ Poll \`${id}\` not found.` });
        if (poll.guildId !== interaction.guild.id)
            return safeEditReply(interaction, { content: '❌ This poll doesn\'t belong to this guild.' });
        if (poll.closed) return safeEditReply(interaction, { content: `❌ This poll is already closed.` });
        const updated = closePoll(id);
        // v3.9.26 FIX: null guard — the poll can be deleted (rollback/refresh) between
        // getPoll and closePoll; without the guard, updatePollMessage(interaction, null)
        // throws a TypeError on poll.channelId.
        if (!updated) {
            return safeEditReply(interaction, { content: `❌ Poll \`${id}\` no longer exists (just deleted?).` });
        }
        await updatePollMessage(interaction, updated);
        await logAudit(interaction.client, {
            action: 'POLL_CLOSE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Close poll \`${id}\` ("${poll.question}")`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, { content: `✅ Poll **${poll.question}** closed! Check the results in the channel.` });
    }
};

// ====================================================
// === HELPER: UPDATE POLL MESSAGE (for close) ===
// ====================================================
// Split off from handlers/commandHandler.js (v3.9.9 refactor). The function declaration
// is hoisted, so it can be called from `module.exports` above.
async function updatePollMessage(interaction, poll) {
    try {
        const channel = interaction.guild.channels.cache.get(poll.channelId);
        if (!channel) return;
        const msg = await channel.messages.fetch(poll.messageId).catch(() => null);
        if (!msg) return;

        const total = getPollTotalVotes(poll);
        const lines = poll.options
            .map(opt => {
                const pct = total > 0 ? Math.round((opt.votes.length / total) * 100) : 0;
                const bar = '█'.repeat(Math.floor(pct / 10)).padEnd(10, '░');
                return `${opt.emoji} **${opt.label}** — ${opt.votes.length} votes (${pct}%)\n\`${bar}\``;
            })
            .join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle(`📊 ${poll.question}`)
            .setDescription(
                `${lines}\n\n` +
                    `🗳️ Total votes: **${total}**\n` +
                    `🔒 Status: **Closed** <t:${Math.floor(poll.closedAt / 1000)}:R>`
            )
            .setColor(0x95a5a6)
            .setFooter({ text: `Poll by ${poll.creatorTag} | Closed` })
            .setTimestamp();

        // Disable all buttons
        const disabledRows = msg.components.map(row => {
            const newRow = new ActionRowBuilder();
            for (const comp of row.components) {
                newRow.addComponents(ButtonBuilder.from(comp).setDisabled(true));
            }
            return newRow;
        });

        await msg.edit({ embeds: [embed], components: disabledRows });
    } catch (err) {
        console.warn('Failed to update poll message:', err.message);
    }
}
