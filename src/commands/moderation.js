/**
 * Domain: moderation
 * Slash commands: /timeout, /untimeout, /purge, /kick, /ban, /unban (v3.9.43)
 *
 * Full moderation pack — wired into the existing systems:
 *   - Every action → recorded in the user's MODERATION HISTORY
 *     (data/modlogs.json) and shown by /warn-list in a "Moderation History"
 *     section (without affecting the warn thresholds 3=mute/5=mute/7=kick —
 *     no double punishment).
 *   - Every action → logAudit to the audit-log channel (MOD_* labels).
 *   - Targets get a DM with the reason (best-effort, silent fail).
 *
 * Guards (src/infra/moderationGuards.js, unit-tested):
 *   - Cannot action yourself / the bot itself / a bot target.
 *   - Hierarchy: the moderator's AND the bot's roles must be higher than the
 *     target's (same level = rejected, consistent with /warn v3.9.8).
 *   - Timeout max 28 days (Discord limit), purge 1–100 + skip messages older
 *     than 14 days (bulk delete API limit), ban delete-days 0–7.
 *   - Bot permissions are checked up front (ModerateMembers/KickMembers/
 *     BanMembers/ManageMessages) so the error is clear, not a raw
 *     "Missing Permissions" from the API.
 *
 * Router: these commands are usable by non-admin moderators who hold the
 * matching Discord permission (ModerateMembers etc.) — see
 * MODERATION_COMMANDS in src/commands/index.js.
 */

const {
    MessageFlags,
    PermissionFlagsBits,
    safeEditReply,
    logAudit,
    addModLog,
    getModLogCount
} = require('./_shared');
const { normalizeNewlines } = require('../infra/text');
const {
    validateModerationTarget,
    validateTimeoutDuration,
    validatePurgeAmount,
    filterBulkDeletable,
    formatDurationMinutes,
    isValidUserId,
    TIMEOUT_MAX_MINUTES,
    BAN_DELETE_DAYS_MAX
} = require('../infra/moderationGuards');

/** Guard code → user-facing message (English). */
const GUARD_MESSAGES = {
    'self': '❌ You cannot take action against yourself.',
    'bot-self': '❌ You cannot take action against this bot itself.',
    'target-bot': '❌ You cannot take action against bots. (Consistent with /warn — bots are not moderation targets.)',
    'not-in-guild': '❌ That user is not in this server.',
    'hierarchy': '❌ You cannot take action against a member with a role equal to or higher than yours.',
    'bot-hierarchy': '❌ The bot role is lower than the target — the bot cannot execute this action. Raise the bot role in Server Settings → Roles.'
};

function guardMessage(code) {
    return GUARD_MESSAGES[code] || `❌ Action rejected (${code}).`;
}

/**
 * Helper: DM the target (best effort — closed DMs = silent, never fails the command).
 */
async function dmTarget(user, text) {
    try {
        await user.send(text);
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = async function (interaction) {
    const guild = interaction.guild;
    const botMember = guild.members.me;

    // ====================================================
    // === /timeout — temporary mute (max 28 days) ===
    // ====================================================
    if (interaction.commandName === 'timeout') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const minutes = interaction.options.getInteger('duration');
        const reason = normalizeNewlines(interaction.options.getString('reason') || '(no reason given)');

        const dur = validateTimeoutDuration(minutes);
        if (!dur.ok) {
            return safeEditReply(interaction, {
                content:
                    dur.error === 'too-long'
                        ? `❌ The maximum timeout duration is **28 days** (${TIMEOUT_MAX_MINUTES} minutes).`
                        : '❌ The minimum duration is 1 minute.'
            });
        }

        const member = await guild.members.fetch(user.id).catch(() => null);
        const guard = validateModerationTarget({
            moderatorMember: interaction.member,
            targetMember: member,
            botMember
        });
        if (!guard.ok) return safeEditReply(interaction, { content: guardMessage(guard.error) });

        if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
            return safeEditReply(interaction, { content: '❌ The bot is missing the **Timeout Members** permission.' });
        }

        await member.timeout(dur.ms, ` by ${interaction.user.tag}: ${reason}`.slice(0, 512));

        addModLog(guild.id, user.id, {
            type: 'timeout',
            reason,
            durationMs: dur.ms,
            moderatorId: interaction.user.id,
            moderatorTag: interaction.user.tag
        });
        await logAudit(interaction.client, {
            action: 'MOD_TIMEOUT',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Timeout <@${user.id}> (${user.tag}) — ${formatDurationMinutes(minutes)} — Reason: "${reason}"`,
            guildId: guild.id
        });
        const dmOk = await dmTarget(
            user,
            `🔇 **You have been timed out in ${guild.name}**\n\nDuration: ${formatDurationMinutes(minutes)}\nReason: ${reason}\nBy: ${interaction.user.tag}\n\nWhile the timeout is active you cannot send messages or join voice.`
        );

        return safeEditReply(interaction, {
            content:
                `🔇 **<@${user.id}> timed out for ${formatDurationMinutes(minutes)}.**\n\n` +
                `📝 Reason: ${reason}\n👤 By: ${interaction.user.tag}\n` +
                `📊 User moderation history: **${getModLogCount(guild.id, user.id)}** actions${dmOk ? '' : '\n⚠️ DM could not be delivered (DMs closed) — let them know in chat.'}`
        });
    }

    // ====================================================
    // === /untimeout — lift a mute early ===
    // ====================================================
    if (interaction.commandName === 'untimeout') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const reason = normalizeNewlines(interaction.options.getString('reason') || '(no reason given)');

        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member) {
            return safeEditReply(interaction, { content: guardMessage('not-in-guild') });
        }
        if (user.id === interaction.user.id) {
            return safeEditReply(interaction, { content: guardMessage('self') });
        }
        if (member.isCommunicationDisabled()) {
            if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
                return safeEditReply(interaction, { content: '❌ The bot is missing the **Timeout Members** permission.' });
            }
            await member.timeout(null, ` by ${interaction.user.tag}: ${reason}`.slice(0, 512));
            addModLog(guild.id, user.id, {
                type: 'untimeout',
                reason,
                moderatorId: interaction.user.id,
                moderatorTag: interaction.user.tag
            });
            await logAudit(interaction.client, {
                action: 'MOD_UNTIMEOUT',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Timeout removed for <@${user.id}> (${user.tag}) — Reason: "${reason}"`,
                guildId: guild.id
            });
            await dmTarget(user, `🔊 **Your timeout in ${guild.name} has been lifted.**\n\nReason: ${reason}\nBy: ${interaction.user.tag}`);
            return safeEditReply(interaction, {
                content: `🔊 **Timeout for <@${user.id}> removed.**\n\n📝 Reason: ${reason}\n👤 By: ${interaction.user.tag}`
            });
        }
        return safeEditReply(interaction, { content: `ℹ️ <@${user.id}> is not currently timed out.` });
    }

    // ====================================================
    // === /purge — bulk delete messages (1–100) ===
    // ====================================================
    if (interaction.commandName === 'purge') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const amount = interaction.options.getInteger('amount');
        const user = interaction.options.getUser('user'); // optional filter

        const check = validatePurgeAmount(amount);
        if (!check.ok) {
            return safeEditReply(interaction, {
                content: check.error === 'too-large' ? '❌ Maximum 100 messages per purge (Discord limit).' : '❌ Minimum 1 message.'
            });
        }
        if (!botMember.permissions.has(PermissionFlagsBits.ManageMessages)) {
            return safeEditReply(interaction, { content: '❌ The bot is missing the **Manage Messages** permission.' });
        }
        if (interaction.channel.type !== 0) {
            // 0 = GuildText — purge only works in text channels (not threads/voice).
            return safeEditReply(interaction, { content: '❌ Purge only works in text channels.' });
        }

        // Fetch the last 100 messages, filter by user if given, take `amount`.
        const fetched = await interaction.channel.messages.fetch({ limit: 100 });
        let pool = [...fetched.values()];
        if (user) pool = pool.filter(m => m.author?.id === user.id);
        pool = pool.slice(0, amount);
        const deletable = filterBulkDeletable(pool);
        const skippedOld = pool.length - deletable.length;

        if (deletable.length === 0) {
            return safeEditReply(interaction, {
                content: user
                    ? `ℹ️ No deletable messages from <@${user.id}> found (within the last 100 messages).`
                    : 'ℹ️ No deletable messages found (messages older than 14 days cannot be bulk-deleted).'
            });
        }

        // The bulk API needs ≥2 messages; 1 message → single delete.
        if (deletable.length === 1) {
            await deletable[0].delete().catch(() => null);
        } else {
            await interaction.channel.bulkDelete(deletable, true);
        }

        await logAudit(interaction.client, {
            action: 'MOD_PURGE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Purged ${deletable.length} messages in #${interaction.channel.name}${user ? ` (only <@${user.id}>'s messages)` : ''}${skippedOld > 0 ? ` — ${skippedOld} skipped (>14 days old)` : ''}`,
            guildId: guild.id
        });

        return safeEditReply(interaction, {
            content:
                `🧹 **${deletable.length} messages deleted** from #${interaction.channel.name}${user ? ` (only <@${user.id}>'s messages)` : ''}.` +
                (skippedOld > 0 ? `\n⚠️ ${skippedOld} messages older than 14 days were skipped (Discord bulk-delete limit — delete those manually).` : '')
        });
    }

    // ====================================================
    // === /kick — remove a member ===
    // ====================================================
    if (interaction.commandName === 'kick') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const reason = normalizeNewlines(interaction.options.getString('reason') || '(no reason given)');

        const member = await guild.members.fetch(user.id).catch(() => null);
        const guard = validateModerationTarget({
            moderatorMember: interaction.member,
            targetMember: member,
            botMember
        });
        if (!guard.ok) return safeEditReply(interaction, { content: guardMessage(guard.error) });
        if (!botMember.permissions.has(PermissionFlagsBits.KickMembers)) {
            return safeEditReply(interaction, { content: '❌ The bot is missing the **Kick Members** permission.' });
        }

        // DM BEFORE the kick — once out of the server the member context
        // (roles) is gone; "you were kicked from X" is most reliably
        // delivered while the member is still present.
        const dmOk = await dmTarget(
            user,
            `👢 **You were kicked from ${guild.name}**\n\nReason: ${reason}\nBy: ${interaction.user.tag}\n\nYou can rejoin using the server's invite link.`
        );

        await member.kick(` by ${interaction.user.tag}: ${reason}`.slice(0, 512));

        addModLog(guild.id, user.id, {
            type: 'kick',
            reason,
            moderatorId: interaction.user.id,
            moderatorTag: interaction.user.tag
        });
        await logAudit(interaction.client, {
            action: 'MOD_KICK',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Kick <@${user.id}> (${user.tag}) — Reason: "${reason}"`,
            guildId: guild.id
        });

        return safeEditReply(interaction, {
            content:
                `👢 **<@${user.id}> kicked.**\n\n📝 Reason: ${reason}\n👤 By: ${interaction.user.tag}\n` +
                `📊 User moderation history: **${getModLogCount(guild.id, user.id)}** actions${dmOk ? '' : '\n⚠️ DM could not be delivered (DMs closed).'}`
        });
    }

    // ====================================================
    // === /ban — ban a member (optional message purge 0–7 days) ===
    // ====================================================
    if (interaction.commandName === 'ban') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const reason = normalizeNewlines(interaction.options.getString('reason') || '(no reason given)');
        const deleteDays = interaction.options.getInteger('delete_days') || 0;

        if (deleteDays < 0 || deleteDays > BAN_DELETE_DAYS_MAX) {
            return safeEditReply(interaction, { content: `❌ Message deletion is capped at ${BAN_DELETE_DAYS_MAX} days (Discord limit).` });
        }

        const member = await guild.members.fetch(user.id).catch(() => null);
        const guard = validateModerationTarget({
            moderatorMember: interaction.member,
            targetMember: member,
            botMember
        });
        if (!guard.ok) return safeEditReply(interaction, { content: guardMessage(guard.error) });
        if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
            return safeEditReply(interaction, { content: '❌ The bot is missing the **Ban Members** permission.' });
        }

        const dmOk = await dmTarget(
            user,
            `🔨 **You were BANNED from ${guild.name}**\n\nReason: ${reason}\nBy: ${interaction.user.tag}${deleteDays > 0 ? `\nYour messages from the last ${deleteDays} days were also deleted.` : ''}`
        );

        await member.ban({
            deleteMessageSeconds: deleteDays * 86400, // v14: seconds, max 7 days
            reason: ` by ${interaction.user.tag}: ${reason}`.slice(0, 512)
        });

        addModLog(guild.id, user.id, {
            type: 'ban',
            reason,
            moderatorId: interaction.user.id,
            moderatorTag: interaction.user.tag
        });
        await logAudit(interaction.client, {
            action: 'MOD_BAN',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Ban <@${user.id}> (${user.tag})${deleteDays > 0 ? ` + delete ${deleteDays} days of messages` : ''} — Reason: "${reason}"`,
            guildId: guild.id
        });

        return safeEditReply(interaction, {
            content:
                `🔨 **<@${user.id}> banned.**\n\n📝 Reason: ${reason}\n🗑️ Messages deleted: ${deleteDays > 0 ? `last ${deleteDays} days` : 'none'}\n👤 By: ${interaction.user.tag}\n` +
                `📊 User moderation history: **${getModLogCount(guild.id, user.id)}** actions${dmOk ? '' : '\n⚠️ DM could not be delivered (DMs closed).'}`
        });
    }

    // ====================================================
    // === /unban — revoke a ban by user ID ===
    // ====================================================
    if (interaction.commandName === 'unban') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const rawId = interaction.options.getString('user_id');
        const reason = normalizeNewlines(interaction.options.getString('reason') || '(no reason given)');

        if (!isValidUserId(rawId)) {
            return safeEditReply(interaction, { content: '❌ Invalid user ID — the format is 17–20 digits (User Settings → Advanced → Developer Mode → right-click user → Copy User ID).' });
        }
        const userId = rawId.trim();
        if (userId === interaction.user.id) {
            return safeEditReply(interaction, { content: guardMessage('self') });
        }
        if (userId === botMember.id) {
            return safeEditReply(interaction, { content: guardMessage('bot-self') });
        }
        if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
            return safeEditReply(interaction, { content: '❌ The bot is missing the **Ban Members** permission.' });
        }

        // Check whether the user is actually banned (clear error message).
        const banInfo = await guild.bans.fetch(userId).catch(() => null);
        if (!banInfo) {
            return safeEditReply(interaction, { content: `ℹ️ User \`${userId}\` is not on this server's ban list.` });
        }

        await guild.bans.remove(userId, ` by ${interaction.user.tag}: ${reason}`.slice(0, 512));
        addModLog(guild.id, userId, {
            type: 'unban',
            reason,
            moderatorId: interaction.user.id,
            moderatorTag: interaction.user.tag
        });
        await logAudit(interaction.client, {
            action: 'MOD_UNBAN',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Unban \`${userId}\`${banInfo.user?.tag ? ` (${banInfo.user.tag})` : ''} — Reason: "${reason}"`,
            guildId: guild.id
        });

        return safeEditReply(interaction, {
            content: `♻️ **Ban on \`${userId}\`${banInfo.user ? ` (${banInfo.user.tag})` : ''} revoked.**\n\n📝 Reason: ${reason}\n👤 By: ${interaction.user.tag}`
        });
    }
};
