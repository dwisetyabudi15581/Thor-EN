/**
 * Domain: giveaway
 * Slash commands: /giveaway (subcommands: create, list, end, reroll)
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: manage giveaways (create, list, end, reroll).
 *
 * P0-3 FIX: /giveaway end calls the shared processGiveawayEnd so the message
 *           gets updated + winner announced + winner DMed + stats tracked.
 * P0-4 FIX: /giveaway reroll persists the new winner + announce + DM + track stats.
 * v3.9.1: no hardcoded @everyone ping (admins who want to ping use /announce).
 * v3.9.8: validate duration, validate channel type (GuildText), wrap reroll in userLock.
 */

// v3.9.38 FIX: check scheduler in-flight — used by /giveaway end before the manual lock.
const { isGiveawayProcessing } = require('../services/schedulerTasks');

const {
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    MessageFlags,
    ChannelType,
    createGiveaway,
    setGiveawayMessageId,
    getGiveawaysByGuild,
    getGiveaway,
    endGiveaway,
    rerollGiveaway,
    pickWinners,
    removeGiveaway,
    withUserLock,
    logAudit,
    safeEditReply
} = require('./_shared');

module.exports = async function (interaction) {
    // ====================================================
    // === /giveaway ===
    // ====================================================
    if (interaction.commandName !== 'giveaway') return;

    // v3.9.26 FIX: getSubcommand(false) — the subcommand in the registry is required:false,
    // so a bare /giveaway (no sub) can be submitted → getSubcommand() throws
    // unhandled. Now: usage hint.
    const sub = interaction.options.getSubcommand(false);
    if (!sub) {
        return interaction.reply({
            content:
                '❌ Use a subcommand: `/giveaway create`, `/giveaway list`, `/giveaway end`, or `/giveaway reroll`.',
            flags: MessageFlags.Ephemeral
        });
    }

    // --- /giveaway create ---
    if (sub === 'create') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const channel = interaction.options.getChannel('channel');
        const prize = interaction.options.getString('prize');
        const winners = interaction.options.getInteger('winners') || 1;
        const durationMin = interaction.options.getInteger('duration');
        const requiredRole = interaction.options.getRole('required_role');

        // v3.9.8 FIX: validate duration — previously `if (durationMin < 1)` passed
        // for undefined (undefined < 1 === false), endsAt became NaN, and the giveaway
        // was stuck active forever (NaN <= Date.now() is always false).
        if (!durationMin || durationMin < 1) {
            return safeEditReply(interaction, { content: '❌ Duration is required, minimum 1 minute.' });
        }
        if (durationMin > 60 * 24 * 30) {
            // 30 days max
            return safeEditReply(interaction, { content: '❌ Maximum duration is 30 days (43200 minutes).' });
        }
        if (winners < 1 || winners > 20) {
            return safeEditReply(interaction, { content: '❌ Number of winners must be 1-20.' });
        }
        // v3.9.26 FIX: validate prize BEFORE persisting. A very long prize made
        // the embed setDescription throw AFTER the entry was saved → zombie entry + a
        // bloated /giveaway list. (The registry already has max_length:200 — this is defense layer 2.)
        if (!prize || prize.length > 200) {
            return safeEditReply(interaction, {
                content: `❌ Prize is required and max 200 characters (got: ${prize ? prize.length : 0}).`
            });
        }
        // v3.9.8 FIX: validate channel type — previously an admin could pick a voice/category
        // channel; channel.send could fail or post to the text-in-voice overlay.
        if (!channel || channel.type !== ChannelType.GuildText) {
            return safeEditReply(interaction, { content: '❌ Channel must be a text channel.' });
        }

        const endsAt = Date.now() + durationMin * 60000;
        const gw = createGiveaway({
            guildId: interaction.guild.id,
            channelId: channel.id,
            prize,
            winnersCount: winners,
            endsAt,
            hostId: interaction.user.id,
            hostTag: interaction.user.tag,
            requiredRoleId: requiredRole?.id || null
        });

        // Build giveaway embed
        const embed = new EmbedBuilder()
            .setTitle('🎉 GIVEAWAY!')
            .setDescription(
                `🎁 **Prize:** ${prize}\n\n` +
                    `👥 **Winners:** ${winners}\n` +
                    `⏰ **Ends:** <t:${Math.floor(endsAt / 1000)}:R> (<t:${Math.floor(endsAt / 1000)}:F>)\n` +
                    `🎟️ **Participants:** 0\n` +
                    (requiredRole ? `🔐 **Requirement:** Must have the role ${requiredRole}\n` : '') +
                    `\n👇 Click the **🎉 Join** button below to enter!`
            )
            .setColor(0xf1c40f)
            .setFooter({ text: `Host: ${interaction.user.tag} | ID: ${gw.id}` })
            .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`gw_join:${gw.id}`).setLabel('🎉 Join').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`gw_leave:${gw.id}`).setLabel('🚪 Leave').setStyle(ButtonStyle.Secondary)
        );
        // v3.9.1 FIX: no hardcoded @everyone ping (too disruptive for members).
        // Previously every new giveaway auto-pinged @everyone, which could
        // cause members to mute / leave the server if it happened too often.
        // Now an admin who wants to ping @everyone can use a separate /announce
        // or edit the giveaway message after it's created.
        const msg = await channel
            .send({ embeds: [embed], components: [row], content: '🎉 **NEW GIVEAWAY!**' })
            .catch(() => null);
        if (!msg) {
            // P0-5 FIX: roll back the already-saved giveaway entry if the message fails to send.
            // Previously the entry stayed with messageId=null → zombie giveaway.
            try {
                removeGiveaway(gw.id);
            } catch (_) {}
            return safeEditReply(interaction, {
                content: `❌ Failed to send giveaway to ${channel}. Check bot permissions. Entry rolled back.`
            });
        }
        setGiveawayMessageId(gw.id, msg.id);
        await logAudit(interaction.client, {
            action: 'GIVEAWAY_CREATE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Create giveaway **${prize}** (${winners} winners, ${durationMin}m) in ${channel}`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Giveaway created in ${channel}!\n🆔 \`${gw.id}\`\n⏰ Ends <t:${Math.floor(endsAt / 1000)}:R>`
        });
    }

    // --- /giveaway list ---
    if (sub === 'list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const all = getGiveawaysByGuild(interaction.guild.id);
        if (all.length === 0) {
            return safeEditReply(interaction, { content: '📭 No giveaways in this guild yet.' });
        }
        // v3.9.26 FIX: bound description. Ended giveaways are NEVER removed from
        // giveaways.json — at ~25-30 giveaways, lines > 4096 → setDescription THROWS
        // → /giveaway list (the only way to see IDs for /end & /reroll) goes
        // permanently dead. Now: latest 15 + summary of the rest.
        const MAX_SHOWN = 15;
        const shown = all.slice(-MAX_SHOWN);
        const hidden = all.length - shown.length;
        const lines = shown
            .map(g => {
                const status = g.ended ? '✅ Done' : g.endsAt <= Date.now() ? '⏳ Processing' : '🟢 Active';
                const winnersStr =
                    g.ended && g.winnerIds.length > 0
                        ? g.winnerIds
                              .slice(0, 10)
                              .map(id => `<@${id}>`)
                              .join(', ') + (g.winnerIds.length > 10 ? ` +${g.winnerIds.length - 10}` : '')
                        : '—';
                return `• **${g.prize}** — ${status}\n  🆔 \`${g.id}\` | 👥 ${g.participantIds.length} participants | 🏆 ${winnersStr}\n  📍 <#${g.channelId}> | ⏰ <t:${Math.floor(g.endsAt / 1000)}:R>`;
            })
            .join('\n\n');
        const embed = new EmbedBuilder()
            .setTitle('🎉 GIVEAWAY LIST')
            .setDescription(
                `Total **${all.length}** giveaways${hidden > 0 ? ` (showing the ${shown.length} latest — ${hidden} older hidden)` : ''}.\n\n${lines.slice(0, 3900)}`
            )
            .setColor(0xf1c40f)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // --- /giveaway end ---
    // P0-3 FIX: previously it only picked + persisted, did NOT update the message,
    // did NOT announce the winner, did NOT DM the winner, did NOT track stats.
    // Now: call processGiveawayEnd (shared with auto-end) so the
    // message is updated + announce + DM + stats tracked.
    if (sub === 'end') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const id = interaction.options.getString('id');
        const gw = getGiveaway(id);
        if (!gw) return safeEditReply(interaction, { content: `❌ Giveaway \`${id}\` not found.` });
        if (gw.ended) return safeEditReply(interaction, { content: `❌ This giveaway has already ended.` });
        if (gw.guildId !== interaction.guild.id)
            return safeEditReply(interaction, { content: '❌ This giveaway doesn\'t belong to this guild.' });

        // v3.9.38 FIX: if the scheduler is CURRENTLY processing this giveaway's natural end,
        // reject first — don't manually pick winners mid-scheduler announce
        // (winnerIds could get overwritten + double announce/DM). The manual lock
        // (withUserLock 'gw_end') and the scheduler lock (Set processingGiveaways)
        // were disjoint before; this interleaving wasn't covered at all.
        if (isGiveawayProcessing(id)) {
            return safeEditReply(interaction, {
                content:
                    '⏳ This giveaway is currently being auto-processed by the scheduler (natural end). Try again in a few seconds.'
            });
        }

        // v3.9.24 FIX: wrap in lock (scoped per giveaway ID — same pattern as reroll).
        // Previously /giveaway end was NOT locked: a double-invoke (enter spam /
        // interaction retry) could double-pick winners + double-announce + double-DM.
        const lockResult = await withUserLock('gw_end', id, async () => {
            // Refresh from disk inside the lock — check the latest state
            const gwFresh = getGiveaway(id);
            if (!gwFresh) return { type: 'notfound' };
            if (gwFresh.ended) return { type: 'ended' };

            // Pick winners + persist ended state
            const winnerIds = pickWinners(gwFresh.participantIds, gwFresh.winnersCount);
            endGiveaway(id, winnerIds);

            // Re-fetch the updated gw (winnerIds already persisted)
            const updatedGw = getGiveaway(id);

            // Call the shared processGiveawayEnd with skipPick=true so it doesn't pick 2x
            if (typeof interaction.client.processGiveawayEnd === 'function') {
                await interaction.client.processGiveawayEnd(interaction.client, updatedGw, { skipPick: true });
            }
            return { type: 'ok', winnerIds, gw: gwFresh };
        });

        if (lockResult === null) {
            // Lock acquire failed — another end for the same giveaway is running
            return safeEditReply(interaction, { content: '⏳ Giveaway end is in progress — try again shortly.' });
        }
        if (lockResult.type === 'notfound') {
            return safeEditReply(interaction, { content: `❌ Giveaway \`${id}\` not found.` });
        }
        if (lockResult.type === 'ended') {
            return safeEditReply(interaction, { content: `❌ This giveaway has already ended.` });
        }

        const winnerIds = lockResult.winnerIds;
        const gwEnded = lockResult.gw;

        await logAudit(interaction.client, {
            action: 'GIVEAWAY_END',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `End giveaway \`${id}\` (${gwEnded.prize}). Winners: ${winnerIds.length > 0 ? winnerIds.map(w => `<@${w}>`).join(', ') : 'no participants'}`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Giveaway **${gwEnded.prize}** ended!\n🏆 Winners: ${winnerIds.length > 0 ? winnerIds.map(w => `<@${w}>`).join(', ') : '_(no participants)_'}\n\n📢 The giveaway message has been updated + winners have been DMed + announced in the channel.`
        });
    }

    // --- /giveaway reroll ---
    // P0-4 FIX: previously it only returned the winnerId to the admin (ephemeral).
    // Now: persist the new winner to gw.winnerIds, announce in the channel,
    // DM the winner, track stats. Also excludes existing winners so
    // the same person isn't picked 2x.
    if (sub === 'reroll') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const id = interaction.options.getString('id');
        const gw = getGiveaway(id);
        if (!gw) return safeEditReply(interaction, { content: `❌ Giveaway \`${id}\` not found.` });
        // v3.9.26: guard guild (consistent with /end — previously reroll could
        // be run from another guild for this guild's giveaway).
        if (gw.guildId !== interaction.guild.id) {
            return safeEditReply(interaction, { content: '❌ This giveaway doesn\'t belong to this guild.' });
        }
        if (!gw.ended)
            return safeEditReply(interaction, {
                content: '❌ This giveaway hasn\'t ended yet. End it first with `/giveaway end`.'
            });

        // v3.9.8 FIX: wrap reroll+announce in userLock. Previously, if the admin
        // double-clicked the reroll button (or an interaction retry due to a network blip),
        // 2 handlers ran in parallel → 2x announce, 2x winner DM, 2x winnerIds entry
        // (even though winnerIds eventually piled up, users saw 2 "you won" messages).
        // The lock is scoped per giveaway ID so different admins don't block each other
        // on different giveaways, but 2 clicks on the same giveaway are serialized.
        const result = await withUserLock('gw_reroll', gw.id, async () => rerollGiveaway(id));
        if (!result)
            return safeEditReply(interaction, {
                content: `❌ Giveaway \`${id}\` not found or hasn't ended yet. (Or another reroll is running — try again shortly.)`
            });
        if (!result.winnerId) return safeEditReply(interaction, { content: '❌ No participants to reroll.' });

        // Announce the new winner in the channel + DM + track stats
        // v3.9.8: wrap in try/catch so an announce failure doesn't make the admin
        // retry (which would pick a second winner). The reroll already persisted the winner;
        // a failed announce doesn't need to abort.
        if (typeof interaction.client.announceRerollWinner === 'function') {
            try {
                await interaction.client.announceRerollWinner(interaction.client, result.gw, result.winnerId);
            } catch (annErr) {
                console.warn(`⚠️ Reroll announce failed (winner is still saved): ${annErr.message}`);
            }
        }

        const reuseNote = result.reused ? ' _(all participants have already won, fell back to a random pick)_' : '';
        await logAudit(interaction.client, {
            action: 'GIVEAWAY_REROLL',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Reroll giveaway \`${id}\` → new winner: <@${result.winnerId}>${reuseNote}`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `🎲 **Reroll!** New winner: <@${result.winnerId}>${reuseNote}\n\n📢 The winner has been DMed + announced in the giveaway channel.`
        });
    }
};
