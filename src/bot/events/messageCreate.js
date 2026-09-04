/**
 * Handler for incoming messages. Runs 4 community features:
 *   1. Auto-Responder — when someone types a trigger keyword, the bot auto-replies
 *   2. Anti-Spam & Auto-Mod — detects spam/links/blocked words/mass-mentions
 *   3. AFK System — auto-replies when someone mentions an AFK user + clears AFK when the AFK user chats again
 *   4. Leveling System — grants XP per message + announces level ups
 *
 * Order: anti-spam first (because if the message gets deleted, the other hooks don't need to run).
 */

const { Events, EmbedBuilder } = require('discord.js');
const { incrementMessages: trackMessage } = require('../../data/statsManager');
const { getConfig } = require('../../data/configManager');

// Data managers for the new features
const responderManager = require('../../data/responderManager');
const automodManager = require('../../data/automodManager');
const afkManager = require('../../data/afkManager');
const levelManager = require('../../data/levelManager');

// For warning the admin when they forget to enable the Message Content Intent.
// Discord sends an empty message.content when the intent isn't enabled yet.
// Result: auto-responder, anti-spam, and AFK replies don't work.
// This Set only warns once per server so the console doesn't get flooded.
//
// v3.9.17 FIX: periodic cleanup. Previously, the Set kept growing for the whole
// process lifetime (for bots that frequently join/leave guilds). Now: cleanup every
// 24 hours, removing guilds not detected for more than 24 hours.
const _intentWarnedGuilds = new Map(); // guildId → timestamp of the last warning
const INTENT_WARN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
function debugLogIntentMissing(message) {
    const gid = message.guild.id;
    const now = Date.now();
    if (_intentWarnedGuilds.has(gid)) {
        // Update the timestamp so it doesn't get cleaned up while still active.
        _intentWarnedGuilds.set(gid, now);
        return;
    }
    _intentWarnedGuilds.set(gid, now);
    console.warn(
        `⚠️ [HINT] Message from ${message.author?.tag} in server "${message.guild.name}" has empty content.\n` +
            `   Usually this means "Message Content Intent" is not enabled in the Developer Portal.\n` +
            `   Check: https://discord.com/developers/applications → Bot → Privileged Gateway Intents\n` +
            `   Result: auto-responder, anti-spam word/link checks, and AFK mention replies won't work.\n` +
            `   (this warning only appears once every 24 hours per server)`
    );
    // v3.9.17: clean up entries not detected for more than 24 hours.
    if (_intentWarnedGuilds.size > 100) {
        for (const [k, ts] of _intentWarnedGuilds) {
            if (now - ts > INTENT_WARN_TTL_MS) _intentWarnedGuilds.delete(k);
        }
    }
}

async function onMessageCreate(message) {
    try {
        // v3.9.24 FIX: combined guard + webhook filter.
        // Previously: line 57 checked `message.author?.bot` (null-safe), but the
        // line below dereferenced `message.author.id` WITHOUT a guard — a null
        // author (webhook/partial edge case) → a TypeError swallowed by the outer catch.
        // Bonus: webhook messages are now skipped (automod/AFK/leveling don't
        // process webhook messages), and the dead `client.user.id` check was removed
        // (bot messages already return at this guard).
        if (!message.author || message.author.bot || message.webhookId) return;
        if (!message.guild) return;

        // v3.9.26 (single-guild hardening): if GUILD_ID is set in .env, ignore
        // messages from other guilds. This is a single-guild bot — if it gets
        // accidentally invited to another server, without this guard: leveling
        // runs (global config!), XP gets scattered into levels.json, the main
        // guild's role IDs get added to the other guild's members (fails), and
        // audit logs stray into the main guild's channel. The guard is cheap insurance.
        if (process.env.GUILD_ID && message.guild.id !== process.env.GUILD_ID) return;

        // Detect whether the Message Content Intent isn't enabled yet.
        // If another user's message is empty but isn't an attachment/sticker, most likely the intent is missing.
        // Skip the warning if the message only contains attachments/stickers (they genuinely have no content).
        if (!message.content) {
            if (!message.attachments?.size && !message.stickers?.size && !message.components?.length) {
                debugLogIntentMissing(message);
            }
        }

        // Run the 4 community hooks. Order: automod first (if the message gets
        // deleted, the other hooks are skipped) — because once a message is
        // deleted, message.reply would throw "Unknown Message".
        try {
            const deleted = await hookAutoMod(message);
            if (deleted) return;
        } catch (err) {
            console.error('MessageCreate hook error:', err.message);
        }

        // v3.9.24 FIX: stats tracking moved AFTER automod. Previously, spam/blocked-word
        // messages that got deleted still counted toward the message leaderboard,
        // while their leveling XP was skipped — inconsistent treatment of the same message.
        try {
            trackMessage(message.guild.id, message.author.id);
        } catch (_) {}

        // v3.9.26 FIX: try/catch PER HOOK. Previously responder+AFK+leveling
        // shared one catch — if clearAFK() threw (disk full/EROFS),
        // hookLeveling DIDN'T RUN AT ALL → users silently lost XP
        // on every message until the disk recovered. Now a failing hook dies
        // alone, the rest still run, and the log names the hook + stack.
        try {
            await hookAutoResponder(message);
        } catch (err) {
            console.error('MessageCreate hook [autoResponder] error:', err);
        }
        try {
            await hookAfkSystem(message);
        } catch (err) {
            console.error('MessageCreate hook [afk] error:', err);
        }
        try {
            await hookLeveling(message);
        } catch (err) {
            console.error('MessageCreate hook [leveling] error:', err);
        }
    } catch (err) {
        // v3.9.17 FIX: log the outer error. Previously `catch (_) {}` swallowed
        // all errors without logging — a bug in any hook would silently fail with no trace.
        console.error('MessageCreate outer error:', err.message);
    }
}

/**
 * Hook 1: Anti-Spam & Auto-Mod
 * Checks 4 things: spam, links, blocked words, mass-mention.
 * If something trips, delete the message + take action (warn/mute/kick per config).
 */
async function hookAutoMod(message) {
    const config = automodManager.getGuildConfig(message.guild.id);
    if (!config || !config.enabled) return false;

    // v3.9.38 FIX: the GLOBAL whitelist is now admins ONLY (Administrator/ManageGuild).
    // Previously isUserWhitelisted also returned true for roles in
    // `linkAllowedRoles` — members with that role bypassed ALL checks (spam,
    // blocked words, mass-mention) even though that field (see /add-link-whitelist)
    // was only meant to exempt LINKS.
    if (automodManager.isUserWhitelisted(message.member, config)) return false;

    const content = message.content || '';
    let shouldDelete = false;
    let actionReason = null;
    let actionToTake = null;

    // 1. Check spam (too many messages in a short window)
    if (automodManager.checkSpam(message.guild.id, message.author.id, config)) {
        shouldDelete = true;
        actionReason = `Spam (${config.spamThreshold}+ messages in ${config.spamWindowMs / 1000}s)`;
        actionToTake = config.spamAction;
        automodManager.resetSpamTracker(message.guild.id, message.author.id);
    }

    // 2. Check links (if blockLinks is active & the channel/role isn't whitelisted)
    // v3.9.38 FIX: the link-whitelist role (linkAllowedRoles) is checked via
    // isLinkAllowed() and ONLY exempts the LINK check — spam/blocked words/
    // mass-mention are still enforced for members with that role.
    if (!shouldDelete && config.blockLinks && automodManager.containsLink(content)) {
        if (
            !config.linkAllowedChannels?.includes(message.channel.id) &&
            !automodManager.isLinkAllowed(message.member, config)
        ) {
            shouldDelete = true;
            actionReason = 'Links are blocked in this channel';
            actionToTake = 'delete_only';
        }
    }

    // 3. Check blocked words
    // v3.9.23: uses findViolatedWord — supports whole-word matching, exempt lists,
    // and per-word actions. Old blockWords entries were auto-migrated to wordRules.
    if (!shouldDelete) {
        const violation = automodManager.findViolatedWord(content, config);
        if (violation) {
            shouldDelete = true;
            actionReason = `Blocked word: "${violation.word}"`;
            // Per-word action (from /add-word action:...) — falls back to the global wordAction.
            actionToTake = violation.action || config.wordAction;
        }
    }

    // 4. Check mass-mention (too many people/roles mentioned)
    if (!shouldDelete && config.maxMentions) {
        const mentionCount = automodManager.countMentions(message);
        if (mentionCount > config.maxMentions) {
            shouldDelete = true;
            actionReason = `Mass-mention (${mentionCount} mentions, max ${config.maxMentions})`;
            actionToTake = config.mentionAction;
        }
    }

    if (!shouldDelete) return false;

    // Execute: delete the message first, then take additional action if needed
    let deleted = false;
    try {
        if (shouldDelete) {
            // v3.9.24: log if the delete FAILS (e.g. the bot lost Manage Messages).
            // Previously `.catch(() => {})` swallowed the error silently — admins
            // never knew why blocked words were still visible even with automod on.
            await message.delete().catch(err => {
                console.warn(`⚠️ Auto-mod failed to delete message (bot needs Manage Messages): ${err.message}`);
            });
            // Still counts as "deleted" (flagged) so that responder/AFK/leveling
            // don't process the violating message, and the action (mute/kick) still runs.
            deleted = true;
        }

        // Additional action (warn/mute/kick) — if it's not delete-only
        if (actionToTake && actionToTake !== 'delete_only') {
            const member = message.member;
            if (member) {
                if (actionToTake === 'warn') {
                    // DM only, as a warning
                    try {
                        await member.send(`⚠️ Your message was deleted in **${message.guild.name}**: ${actionReason}`);
                    } catch (_) {}
                } else if (actionToTake === 'mute_10m' || actionToTake === 'mute_1h') {
                    const duration = actionToTake === 'mute_10m' ? 10 * 60 * 1000 : 60 * 60 * 1000;
                    try {
                        await member.timeout(duration, `Auto-mod: ${actionReason}`);
                        console.log(`🛡️ ${message.author.tag} muted ${actionToTake} — ${actionReason}`);
                    } catch (err) {
                        console.warn(`⚠️ Failed to mute ${message.author.tag}: ${err.message}`);
                    }
                } else if (actionToTake === 'kick') {
                    try {
                        await member.kick(`Auto-mod: ${actionReason}`);
                        console.log(`🛡️ ${message.author.tag} kicked — ${actionReason}`);
                    } catch (err) {
                        console.warn(`⚠️ Failed to kick ${message.author.tag}: ${err.message}`);
                    }
                }
            }
        }

        console.log(`🛡️ Auto-mod action on ${message.author.tag}: ${actionToTake} — ${actionReason}`);
    } catch (err) {
        console.warn(`⚠️ Auto-mod apply error: ${err.message}`);
    }
    return deleted;
}

/**
 * Hook 2: Auto-Responder
 * If the message starts with a trigger keyword (e.g. "!sosmed"), the bot auto-replies.
 */
async function hookAutoResponder(message) {
    // Pass the userId so the cooldown is per-user (not global per-trigger)
    const responder = responderManager.findMatch(message.guild.id, message.content, message.author.id);
    if (!responder) return;

    // Don't trigger responder if message is in a thread about ticket (avoid noise)
    // Actually let's just send it — admin can configure cooldown

    try {
        if (responder.replyType === 'embed') {
            const embed = new EmbedBuilder()
                .setDescription(responder.reply)
                .setColor(0x5865f2)
                .setFooter({ text: `Auto-responder: ${responder.trigger}` });
            // v3.9.17 FIX: add allowedMentions: { parse: [] } so that
            // @everyone/@here/<@&ROLE> in the reply do NOT trigger a ping.
            // Previously, embed mode did NOT set allowedMentions → fell back to
            // the Discord default (parse: ['everyone', 'roles', 'users']) →
            // members could abuse trigger keywords to mass-ping @everyone.
            await message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        } else {
            await message.reply({ content: responder.reply, allowedMentions: { parse: [] } });
        }
        responderManager.markUsed(message.guild.id, responder.id, message.author.id);
    } catch (err) {
        console.warn(`⚠️ Auto-responder error: ${err.message}`);
    }
}

/**
 * Hook 3: AFK System
 * - If an AFK user sends a message → clear their AFK + greet them "welcome back"
 * - If someone mentions an AFK user → reply letting them know they're AFK
 */
async function hookAfkSystem(message) {
    // Check: if the sender is AFK, clear it first
    let senderWasAFK = false;
    if (afkManager.isAFK(message.guild.id, message.author.id)) {
        afkManager.clearAFK(message.guild.id, message.author.id);
        senderWasAFK = true;
    }

    // Collect info about AFK users mentioned in this message
    // v3.9.26: batch check — previously getAFK() per mention = 1+N reads of afk.json
    // per message containing mentions. Now 1 read for all mentions.
    const afkReplies = [];
    if (message.mentions?.users && message.mentions.users.size > 0) {
        const mentionedIds = [];
        for (const [userId, user] of message.mentions.users) {
            if (userId === message.author.id) continue; // skip self-mentions
            if (user.bot) continue;
            mentionedIds.push(userId);
        }
        const afkMap = afkManager.getAFKBatch(message.guild.id, mentionedIds);
        for (const [userId, afkData] of Object.entries(afkMap)) {
            const duration = afkManager.formatDuration(afkData.since);
            afkReplies.push(`💤 <@${userId}> is AFK: **${afkData.reason}** *(${duration})*`);
        }
    }

    // If the sender was AFK AND an AFK user was mentioned, combine into 1 message to avoid double-replies
    if (senderWasAFK && afkReplies.length > 0) {
        try {
            const reply = await message.reply({
                content: `👋 Welcome back, ${message.author}! Your AFK status has been cleared.\n\n${afkReplies.join('\n')}`,
                // v3.9.24 FIX: add parse: [] so an AFK reason (e.g. containing
                // @everyone / <@&role>) can't mass-ping — consistent with the
                // v3.9.17 responder hardening. (users: [] already existed, parse didn't.)
                allowedMentions: { parse: [], users: [] }
            });
            setTimeout(() => reply.delete().catch(() => {}), 30000).unref();
        } catch (_) {}
        return;
    }

    // Only the sender was AFK (no other AFK users mentioned)
    if (senderWasAFK) {
        try {
            const welcomeBack = await message.reply({
                content: `👋 Welcome back, ${message.author}! Your AFK status has been cleared.`,
                allowedMentions: { parse: [], users: [] }
            });
            // Delete the welcome back message after 5 seconds so the channel stays tidy
            setTimeout(() => welcomeBack.delete().catch(() => {}), 5000).unref();
        } catch (_) {}
        return;
    }

    // Only an AFK user was mentioned (the sender themselves isn't AFK)
    if (afkReplies.length > 0) {
        try {
            const reply = await message.reply({
                content: afkReplies.join('\n'),
                allowedMentions: { parse: [], users: [] }
            });
            setTimeout(() => reply.delete().catch(() => {}), 30000).unref();
        } catch (_) {}
    }
}

/**
 * Hook 4: Leveling
 * Adds XP to the user. On a level up, announces it + grants reward role(s) if any.
 */
async function hookLeveling(message) {
    const config = getConfig();
    const levelingConfig = config.leveling;
    if (!levelingConfig || !levelingConfig.enabled) return;

    const xpGain = levelingConfig.xpPerMessage || 15;
    const result = levelManager.addXp(message.guild.id, message.author.id, xpGain, levelingConfig);

    if (!result.leveledUp) return;

    const newLevel = result.newLevel;
    console.log(`📊 ${message.author.tag} leveled up to level ${newLevel}!`);

    // Announce the level up in the channel where the user chatted
    if (levelingConfig.announceLevelUp) {
        try {
            const levelUpEmbed = new EmbedBuilder()
                .setTitle('🎉 LEVEL UP!')
                .setDescription(`GG ${message.author}! You've reached **Level ${newLevel}**!`)
                .setColor(0xf1c40f)
                .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
                .setTimestamp();
            await message.channel.send({ embeds: [levelUpEmbed] });
        } catch (_) {}
    }

    // Auto-assign reward roles. Stacking is supported — a level 50 user gets all of the level 10, 20, and 50 roles at once.
    const roleIds = levelManager.getRoleForLevel(newLevel, config);
    if (roleIds.length > 0 && message.member) {
        // Check which roles the user doesn't have yet
        const toAdd = roleIds.filter(id => !message.member.roles.cache.has(id));
        if (toAdd.length > 0) {
            try {
                await message.member.roles.add(toAdd);
                console.log(
                    `📊 Granted ${toAdd.length} role(s) to ${message.author.tag} (level ${newLevel}): ${toAdd.join(', ')}`
                );
                try {
                    await message.author.send(
                        `🎉 You got new role(s) in **${message.guild.name}** for reaching Level ${newLevel}!`
                    );
                } catch (_) {}
            } catch (err) {
                console.warn(`⚠️ Failed to grant level role(s): ${err.message}`);
            }
        }
    }
}

module.exports = {
    name: Events.MessageCreate,
    execute: onMessageCreate
};
