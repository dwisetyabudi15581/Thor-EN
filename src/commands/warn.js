/**
 * Domain: warn
 * Slash commands: /warn, /warn-list, /warn-remove, /warn-clear
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: manage user warnings + auto-actions (mute/kick) based on thresholds.
 *
 * v3.9.0: scoped per guild.
 * v3.9.4: don't markActionTaken if the action failed (silent enforcement failure).
 * v3.9.8: check bot vs target hierarchy — give a warning if the auto-action will fail.
 */

const {
    EmbedBuilder,
    MessageFlags,
    addWarn,
    getWarns,
    getWarnCount,
    removeWarn,
    clearWarns,
    markActionTaken,
    WARN_THRESHOLDS,
    logAudit,
    safeEditReply
} = require('./_shared');

// v3.9.25: convert literal \n → real newlines (PC multi-line feature)
const { normalizeNewlines } = require('../infra/text');

module.exports = async function (interaction) {
    // ====================================================
    // === /warn ===
    // ====================================================
    if (interaction.commandName === 'warn') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        // v3.9.25: literal \n → real newlines so the warning reason can be multi-line
        const reason = normalizeNewlines(interaction.options.getString('reason'));

        if (user.id === interaction.user.id) {
            return safeEditReply(interaction, { content: '❌ You cannot warn yourself.' });
        }
        if (user.bot) {
            return safeEditReply(interaction, { content: '❌ You cannot warn a bot.' });
        }

        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) {
            return safeEditReply(interaction, { content: `❌ User <@${user.id}> is not on this server.` });
        }

        // Check hierarchy: the admin must be higher than the target
        if (member.roles.highest.position >= interaction.member.roles.highest.position) {
            return safeEditReply(interaction, {
                content: '❌ You cannot warn a member with a role equal to or higher than yours.'
            });
        }

        // Also check bot vs target hierarchy. If the target has a higher role than the bot,
        // the auto-action (timeout/kick) will throw "Missing Permissions".
        // But the warn record is still created — useful as a record even if the auto-action can't run.
        // So: don't return, just set a warning flag and continue to addWarn.
        const botMember = interaction.guild.members.me;
        let botHierarchyWarning = '';
        if (botMember && member.roles.highest.position >= botMember.roles.highest.position) {
            botHierarchyWarning = `\n\n⚠️ **Heads up:** The bot's role (\`${botMember.roles.highest.name || 'top role'}\`) is lower than the target's highest role (\`${member.roles.highest.name || 'top role'}\`). The bot won't be able to execute the auto-action (timeout/kick) if a threshold is reached. Move the bot's role above the target's role in Server Settings → Roles so the auto-action works.`;
        }

        // v3.9.0: addWarn is now scoped per guild (guildId, userId, data)
        const result = addWarn(interaction.guild.id, user.id, {
            reason,
            warnedBy: interaction.user.id,
            warnedByTag: interaction.user.tag,
            guildId: interaction.guild.id
        });

        await logAudit(interaction.client, {
            action: 'WARN_ADD',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Warn <@${user.id}> (${user.tag}) — Reason: "${reason}" — Total: ${result.count} warn`,
            guildId: interaction.guild.id
        });

        // Execute the auto-action if needed
        // P1-7 FIX: if actionAlreadyTaken=true, don't re-apply the timeout
        // (the user already got the same mute — don't reset the timer).
        // v3.9.4 FIX: if the action fails (e.g., bot lacks the ModerateMembers permission),
        // don't markActionTaken — previously markActionTaken was called unconditionally,
        // causing the next identical action to be skipped (silent enforcement failure).
        let actionMsg = '';
        if (result.actionAlreadyTaken) {
            actionMsg = `\nℹ️ Auto-action not repeated (the user already received the same action before).`;
        } else if (result.actionToTake) {
            try {
                if (result.actionToTake === 'mute_1h' || result.actionToTake === 'mute_1d') {
                    const durationMin = result.actionToTake === 'mute_1h' ? 60 : 1440;
                    // Find the mute role (or create a timeout)
                    let muted = false;
                    try {
                        await member.timeout(durationMin * 60 * 1000, `Auto-action: ${result.count} warnings`);
                        muted = true;
                    } catch (err) {
                        actionMsg = `\n⚠️ Auto-action failed: ${err.message}`;
                    }
                    if (muted) {
                        actionMsg = `\n🔇 **Auto-action:** Timeout ${durationMin === 60 ? '1 hour' : '1 day'} (${result.count} warnings)`;
                        markActionTaken(interaction.guild.id, user.id, result.warnEntry.id, result.actionToTake);
                    }
                } else if (result.actionToTake === 'kick') {
                    let kicked = false;
                    try {
                        await member.kick(`Auto-action: ${result.count} warnings`);
                        kicked = true;
                    } catch (err) {
                        actionMsg = `\n⚠️ Auto-action failed: ${err.message}`;
                    }
                    if (kicked) {
                        actionMsg = `\n👢 **Auto-action:** Kicked (${result.count} warnings)`;
                        markActionTaken(interaction.guild.id, user.id, result.warnEntry.id, result.actionToTake);
                    }
                }
            } catch (err) {
                actionMsg = `\n⚠️ Auto-action failed: ${err.message}`;
            }
        }

        // DM the user
        try {
            await user.send(
                `⚠️ **You received a warning in ${interaction.guild.name}**\n\nReason: ${reason}\nTotal warnings: ${result.count}\n${result.actionToTake ? `Action: ${result.actionToTake}` : 'No auto-action yet (thresholds: 3=mute 1h, 5=mute 1d, 7=kick)'}`
            );
        } catch (_) {}

        return safeEditReply(interaction, {
            content:
                `⚠️ **<@${user.id}> has been warned.**\n\n` +
                `📝 Reason: ${reason}\n` +
                `📊 Total warnings: **${result.count}**\n` +
                `👤 By: ${interaction.user.tag}${actionMsg}${botHierarchyWarning}`
        });
    }

    // ====================================================
    // === /warn-list ===
    // ====================================================
    if (interaction.commandName === 'warn-list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        // v3.9.0: getWarns is now scoped per guild
        const warns = getWarns(interaction.guild.id, user.id);
        if (warns.length === 0) {
            return safeEditReply(interaction, { content: `✅ <@${user.id}> has no warnings.` });
        }
        const lines = warns
            .map((w, i) => {
                // v3.9.15: removed dead variable `date` (previously declared but unused)
                return `\`${i + 1}.\` 🆔 \`${w.id}\`\n   📝 ${w.reason}\n   👤 By: ${w.warnedByTag} | ⏰ <t:${Math.floor(w.createdAt / 1000)}:R>${w.actionTaken ? ` | ⚡ ${w.actionTaken}` : ''}`;
            })
            .join('\n\n');
        const embed = new EmbedBuilder()
            .setTitle(`⚠️ WARN HISTORY — ${user.tag}`)
            .setDescription(
                `Total **${warns.length}** warning(s).\n\n${lines}\n\n**Thresholds:**\n• ${WARN_THRESHOLDS.mute1h} warns → 1 hour mute\n• ${WARN_THRESHOLDS.mute1d} warns → 1 day mute\n• ${WARN_THRESHOLDS.kick} warns → kick`
            )
            .setColor(
                warns.length >= WARN_THRESHOLDS.kick
                    ? 0xed4245
                    : warns.length >= WARN_THRESHOLDS.mute1h
                      ? 0xe67e22
                      : 0xfee75c
            )
            .setFooter({ text: `User ID: ${user.id}` })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /warn-remove ===
    // ====================================================
    if (interaction.commandName === 'warn-remove') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const warnId = interaction.options.getString('warn_id');
        // v3.9.0: removeWarn is now scoped per guild
        const ok = removeWarn(interaction.guild.id, user.id, warnId);
        if (!ok) {
            return safeEditReply(interaction, {
                content: `❌ Warn ID \`${warnId}\` not found for user <@${user.id}> in this guild.`
            });
        }
        await logAudit(interaction.client, {
            action: 'WARN_REMOVE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Remove warn \`${warnId}\` from <@${user.id}>. Remaining: ${getWarnCount(interaction.guild.id, user.id)} warn(s)`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Warn \`${warnId}\` removed from <@${user.id}>.\n📊 Remaining warnings: **${getWarnCount(interaction.guild.id, user.id)}**`
        });
    }

    // ====================================================
    // === /warn-clear ===
    // ====================================================
    if (interaction.commandName === 'warn-clear') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        // v3.9.0: clearWarns is now scoped per guild
        const count = clearWarns(interaction.guild.id, user.id);
        if (count === 0) {
            return safeEditReply(interaction, { content: `ℹ️ <@${user.id}> has no warnings in this guild anyway.` });
        }
        await logAudit(interaction.client, {
            action: 'WARN_CLEAR_ALL',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Clear ALL warns (${count}) from <@${user.id}> in this guild`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ **${count}** warning(s) removed from <@${user.id}> in this guild.`
        });
    }
};
