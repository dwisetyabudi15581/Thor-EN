/**
 * Poll domain handler — button `poll_vote:*` & modal `poll_modal_create:*`.
 *
 * Extracted from handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior preserved as-is — just moved to a new file.
 *
 * Helpers `handlePollButton`, `handlePollModalCreate`, `updatePollVoteMessage`
 * are LOCAL functions in this file.
 *
 * The router (src/interactions/index.js) already applies:
 *   - dedup (checkAndMark)
 *   - `replied/deferred` guard
 *   - interaction type check (button/select/modal)
 *   - routing by customId prefix
 * So the domain handler can focus on its logic alone.
 */

const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags } = require('discord.js');
const { logAudit, withUserLock, safeEditReply } = require('../commands/_shared');
// votePoll / getPollByMessage / removePoll / getPollSession / deletePollSession
// are not exported from _shared — import them directly from pollManager.
const {
    get: getPoll,
    vote: votePoll,
    getTotalVotes: getPollTotalVotes,
    remove: removePoll,
    getPollSession,
    deletePollSession,
    create: createPoll,
    setMessageId: setPollMessageId
} = require('../data/pollManager');

module.exports = async function (interaction) {
    // ====================================================
    // === POLL: VOTE BUTTONS ===
    // ====================================================
    if (interaction.isButton() && interaction.customId.startsWith('poll_vote:')) {
        return handlePollButton(interaction);
    }

    // ====================================================
    // === POLL: MODAL CREATE SUBMIT ===
    // ====================================================
    if (interaction.isModalSubmit() && interaction.customId.startsWith('poll_modal_create:')) {
        return handlePollModalCreate(interaction);
    }
};

// ====================================================
// === HELPER: POLL VOTE BUTTON HANDLER ===
// ====================================================
async function handlePollButton(interaction) {
    try {
        // customId: poll_vote:<pollId>:<optionIndex>
        const parts = interaction.customId.split(':');
        const pollId = parts[1];
        const optionIndex = parseInt(parts[2]);

        // Quick pre-check for instant feedback (without a lock)
        const pollPre = getPoll(pollId);
        if (!pollPre) {
            return interaction.reply({ content: '❌ Poll not found.', flags: MessageFlags.Ephemeral });
        }
        if (pollPre.closed) {
            return interaction.reply({ content: '❌ This poll is already closed.', flags: MessageFlags.Ephemeral });
        }

        // v3.9.2 FIX: per-user lock to prevent a TOCTOU race condition.
        // Previously, 2 quick clicks on the same option (multiple=false)
        // could go: click-1 toggles ON, click-2 toggles OFF. Result: the vote
        // disappears even though the user thinks they voted. The lock forces
        // click-2 to read the latest data after click-1 finishes.
        //
        // v3.9.17 FIX: distinguish lock-failed vs poll-not-found. Previously,
        // withUserLock returned null either when the lock failed OR when fn()
        // returned null (poll missing). The user saw "clicking too fast" when
        // the poll had actually been deleted by an admin. Now: fn() returns an
        // object { type, poll } so the caller can tell them apart.
        const result = await withUserLock('poll', interaction.user.id, () => {
            const r = votePoll(pollId, interaction.user.id, optionIndex);
            if (r === null) {
                // Poll missing or option invalid
                return { type: 'notfound_or_invalid' };
            }
            if (r.closed) {
                return { type: 'closed', poll: r };
            }
            return { type: 'voted', poll: r };
        });

        if (result === null) {
            // Lock failed — user clicked too fast
            return interaction.reply({
                content: '⏳ Hold on, you are clicking too fast. Try again in 1 second.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (result.type === 'notfound_or_invalid') {
            return interaction.reply({
                content: '❌ Poll not found or the option is invalid (it may have been deleted by an admin).',
                flags: MessageFlags.Ephemeral
            });
        }
        if (result.type === 'closed') {
            return interaction.reply({ content: '❌ This poll is already closed.', flags: MessageFlags.Ephemeral });
        }
        // result.type === 'voted'
        const poll = result.poll;
        await updatePollVoteMessage(interaction, poll);
        const opt = poll.options[optionIndex];
        // v3.9.38 FIX: check the post-state from the manager — multi-choice unvote
        // now actually happens (toggle in pollManager), so the "Vote cancelled"
        // branch is reachable for multi polls too (previously the multi toggle
        // was a silent no-op → always "Vote recorded"). The embed re-render
        // above (updatePollVoteMessage) already uses the same poll state → the
        // bar chart follows the toggle result.
        const voted = opt.votes.includes(interaction.user.id);
        return interaction.reply({
            content: voted ? `✅ Vote recorded for **${opt.label}**!` : `🚪 Vote cancelled for **${opt.label}**.`,
            flags: MessageFlags.Ephemeral
        });
    } catch (err) {
        console.error('Poll button error:', err);
        if (interaction.isRepliable() && !interaction.replied) {
            await interaction.reply({ content: '❌ An error occurred.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }
}

async function updatePollVoteMessage(interaction, poll) {
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
                    `🔄 Mode: ${poll.multiple ? 'Multi-vote (you may pick several)' : 'Single-vote (pick one)'}\n` +
                    `⏰ Created: <t:${Math.floor(poll.createdAt / 1000)}:R>\n\n` +
                    `👇 Click the buttons below to vote (toggle)`
            )
            .setColor(0x5865f2)
            .setFooter({ text: `Poll by ${poll.creatorTag} | ID: ${poll.id}` })
            .setTimestamp();
        await msg.edit({ embeds: [embed] });
    } catch (err) {
        console.warn('Failed to update poll message:', err.message);
    }
}

// ====================================================
// === HELPER: POLL MODAL CREATE (process input options) ===
// ====================================================
async function handlePollModalCreate(interaction) {
    try {
        // v3.9.1 FIX: customId is now just `poll_modal_create:<sessionId>`.
        // Poll data (channelId, multiple, question) is stored in an in-memory session
        // so the customId doesn't overflow Discord's 100-char limit on long questions.
        const parts = interaction.customId.split(':');
        const sessionId = parts[1];
        const session = getPollSession(sessionId);

        if (!session) {
            return interaction.reply({
                content: '❌ The poll session has expired (more than 5 minutes). Run `/poll create` again.',
                flags: MessageFlags.Ephemeral
            });
        }

        // Defense-in-depth: make sure the user submitting the modal is the user who created the session.
        if (session.userId !== interaction.user.id) {
            return interaction.reply({
                content: '❌ This modal does not belong to you. Run `/poll create` yourself.',
                flags: MessageFlags.Ephemeral
            });
        }

        const { channelId, multiple, question } = session;

        const optionsRaw = interaction.components[0]?.components?.[0]?.value?.trim() || '';
        if (!optionsRaw) {
            return interaction.reply({ content: '❌ Options cannot be empty.', flags: MessageFlags.Ephemeral });
        }

        const optionLines = optionsRaw
            .split('\n')
            .map(s => s.trim())
            .filter(s => s.length > 0);
        if (optionLines.length < 2) {
            return interaction.reply({ content: '❌ Minimum of 2 options (1 per line).', flags: MessageFlags.Ephemeral });
        }
        if (optionLines.length > 10) {
            return interaction.reply({ content: '❌ Maximum of 10 options.', flags: MessageFlags.Ephemeral });
        }

        const options = optionLines.map((label, i) => ({
            label: label.slice(0, 80),
            emoji: `${i + 1}️⃣`
        }));

        // Defense-in-depth: the command router already gates guild-only, but check again to be safe
        if (!interaction.guild) {
            return interaction.reply({ content: '❌ Polls can only be created in a server.', flags: MessageFlags.Ephemeral });
        }
        const channel = interaction.guild.channels.cache.get(channelId);
        if (!channel) {
            deletePollSession(sessionId);
            return interaction.reply({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral });
        }

        // v3.9.26 FIX: BUILD the embed + buttons FIRST, PERSIST afterwards.
        // Previously createPoll() wrote polls.json BEFORE setTitle() — a long or
        // oddly shaped question made setTitle throw (>256) AFTER the entry was
        // saved → zombie poll (messageId:null) + user stuck on
        // "Bot is thinking..." because the catch called reply() after deferReply
        // had already succeeded (InteractionAlreadyAcknowledged, swallowed by .catch).
        // Question validation already exists in the command (/poll create, max 250), but
        // this reordering closes the remaining error path and makes rollback
        // unnecessary for render-failure cases.

        // Build embed + buttons
        const pollId = `poll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const createdAt = Date.now();
        const lines = options
            .map(opt => {
                const bar = '░'.repeat(10);
                return `${opt.emoji} **${opt.label}** — 0 votes (0%)\n\`${bar}\``;
            })
            .join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle(`📊 ${question}`)
            .setDescription(
                `${lines}\n\n` +
                    `🗳️ Total votes: **0**\n` +
                    `🔄 Mode: ${multiple ? 'Multi-vote (you may pick several)' : 'Single-vote (pick one)'}\n` +
                    `⏰ Created: <t:${Math.floor(createdAt / 1000)}:R>\n\n` +
                    `👇 Click the buttons below to vote (toggle)`
            )
            .setColor(0x5865f2)
            .setFooter({ text: `Poll by ${interaction.user.tag} | ID: ${pollId}` })
            .setTimestamp();

        // Build buttons — 5 per row (Discord limit), wrap to the next row if more
        const rows = [];
        for (let i = 0; i < options.length; i += 5) {
            const row = new ActionRowBuilder();
            for (let j = i; j < Math.min(i + 5, options.length); j++) {
                const opt = options[j];
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`poll_vote:${pollId}:${j}`)
                        .setLabel(opt.label.slice(0, 80))
                        .setEmoji(opt.emoji)
                        .setStyle(ButtonStyle.Primary)
                );
            }
            rows.push(row);
        }

        // v3.9.24 FIX: defer BEFORE channel.send (a slow operation). Previously
        // this modal never deferred — if send was slow / the network retried,
        // Discord's 3-second ack window passed → "This interaction failed".
        // The validations above are fast (in-memory), so deferring at this point is right.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

        // Persist the poll entry AFTER a successful render (v3.9.26)
        const poll = createPoll({
            id: pollId,
            guildId: interaction.guild.id,
            channelId: channel.id,
            question,
            options,
            multiple,
            creatorId: interaction.user.id,
            creatorTag: interaction.user.tag
        });

        const msg = await channel
            .send({ embeds: [embed], components: rows, content: `📊 **NEW POLL** by ${interaction.user}` })
            .catch(() => null);
        if (!msg) {
            // P0-5 FIX: roll back the saved poll entry if sending the message fails.
            try {
                removePoll(poll.id);
            } catch (_) {}
            deletePollSession(sessionId);
            return safeEditReply(interaction, {
                content: `❌ Failed to send the poll to ${channel}. Check the bot's permissions. Entry rolled back.`
            });
        }
        setPollMessageId(poll.id, msg.id);
        // v3.9.1: the session has been used, remove it from memory.
        deletePollSession(sessionId);
        // P1-10 FIX: add an audit log for POLL_CREATE (previously missing).
        try {
            await logAudit(interaction.client, {
                action: 'POLL_CREATE',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Create poll **${question}** (${poll.options.length} options, ${multiple ? 'multi' : 'single'}-vote) in ${channel}`,
                guildId: interaction.guild.id
            });
        } catch (_) {}
        return safeEditReply(interaction, {
            content: `✅ Poll created in ${channel}!\n🆔 \`${poll.id}\`\n💡 Close it with \`/poll close id:${poll.id}\``
        });
    } catch (err) {
        console.error('Poll modal create error:', err);
        // v3.9.26 FIX: use safeEditReply, not reply(). deferReply has already run
        // on the success path → reply() throws InteractionAlreadyAcknowledged (swallowed
        // by .catch) → the user is stuck on "Bot is thinking..." for 15 minutes with no
        // error message. safeEditReply handles the deferred/replied/nothing-yet cases correctly.
        await safeEditReply(interaction, {
            content: '❌ An error occurred while creating the poll: ' + (err.message || 'unknown')
        }).catch(() => {});
    }
}
