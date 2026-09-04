/**
 * Scheduler Tasks — functions called by the scheduler loop in index.js.
 *
 * Purpose (P3-6 refactor): separate the scheduler logic from the bot entry point
 * so index.js stays lean and easy to read.
 *
 * Contains:
 *   - processExpiredRole: processes expired role-removal schedules
 *   - processGiveawayEnd: processes ended giveaways (pick winners + announce)
 *   - announceRerollWinner: announces the new winner after a reroll
 *   - processScheduledAnnouncement: sends scheduled announcements that are due
 *
 * `processGiveawayEnd` & `announceRerollWinner` are attached to `client`
 * so they can be called from commandHandler for `/giveaway end` & `/giveaway reroll`.
 */

// v3.9.24: getExpired removed from the import — never used in this file
// (only used by ready.js); one source of lint warnings.
const { removeEntry, updateExpireAt } = require('../data/roleScheduler');
const { hasPermanentKey, getMaxExpireAtByUserAndRole } = require('../data/keyManager');
// v3.9.35 cleanup: the discord.js import is hoisted to top level — previously 2 lazy
// requires inside processGiveawayEnd & processScheduledAnnouncement (redundant:
// discord.js is always already loaded when the bot starts).
const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const {
    get: getGiveawayById,
    end: endGiveaway,
    pickWinners: pickGiveawayWinners,
    pruneEndedOlderThan: pruneOldGiveaways
} = require('../data/giveawayManager');
const {
    markSent: markAnnSent,
    remove: removeAnn,
    pruneSentOlderThan: pruneOldAnns
} = require('../data/scheduledAnnouncements');
const { pruneClosedOlderThan: pruneOldPolls } = require('../data/pollManager');
const { recordGiveawayWin: trackGiveawayWin } = require('../data/statsManager');
// v3.9.37: reconcile zombie escrow deals (see reconcileZombieDeals below).
// v3.9.38 FIX: loadDeals is used so the reconcile can iterate ALL deals
// (including terminal) — getActiveDealsByGuild is no longer used here.
const {
    loadDeals: loadAllDeals,
    removeDeal: removeDealMeta
} = require('../data/midmanManager');
// v3.9.38 FIX: GC old AFK entries (see pruneStaleData below).
const { pruneOldAFK } = require('../data/afkManager');

// v3.9.8 FIX: in-memory guard so the same giveaway/announcement isn't
// processed 2x in parallel by a scheduler tick. Previously, if one
// processGiveawayEnd took >60s (DMs to many winners, rate limit), the next
// tick picked winners a SECOND time → 2x announce + 2x winner DMs.
const processingGiveaways = new Set();
const processingAnns = new Set();
const processingRoles = new Set();

/**
 * Process an expired schedule — KEY-DRIVEN MODEL with recheck.
 *
 * Logic:
 *   1. Check whether the user is still in the guild. If not → delete the schedule.
 *   2. Check active keys for user+role:
 *      a. If a PERMANENT key exists → delete the schedule, the role stays (permanent).
 *      b. If an active key with expireAt > now exists → reschedule to max(expireAt).
 *         The role stays. (this is the MAX EXTEND key — the schedule must never be shorter than the longest key)
 *      c. If no active key exists → remove the role + delete the schedule.
 *
 * v3.9.0 FIX: if a transient error occurs (Discord API 5xx, network blip),
 * do NOT delete the schedule entry. Previously, the catch block always called removeEntry,
 * which made the user keep the role forever if the error was transient. Now,
 * the entry stays so the next tick can retry.
 */
async function processExpiredRole(client, entry) {
    // v3.9.8 FIX: skip if this entry is already being processed by a previous tick.
    // Previously, if processExpiredRole took >60s (slow Discord API),
    // the next tick picked the same entry → 2x "your role was removed" DMs.
    if (processingRoles.has(entry.id)) {
        console.log(`⏭️ processExpiredRole ${entry.id} skipped (still being processed by a previous tick).`);
        return;
    }
    processingRoles.add(entry.id);
    try {
        const guild = await client.guilds.fetch(entry.guildId).catch(() => null);
        if (!guild) {
            // Guild is truly gone (bot kicked) → safe to remove.
            removeEntry(entry.id);
            return;
        }
        const member = await guild.members.fetch(entry.userId).catch(() => null);
        if (!member) {
            // User already left the guild → safe to remove.
            removeEntry(entry.id);
            return;
        }
        // P2-11 FIX: use fetch (falls back to the API) instead of cache.get
        // so roles not yet cached can still be processed.
        const role = await guild.roles.fetch(entry.roleId).catch(() => null);
        const now = Date.now();

        // === 1. Check for a PERMANENT key ===
        if (hasPermanentKey(entry.userId, entry.roleId)) {
            console.log(
                `♾️ ${member.user.tag}: schedule ${role?.name || entry.roleId} removed (permanent key exists). Role stays.`
            );
            removeEntry(entry.id);
            return;
        }

        // === 2. Check for another active key with expireAt > now ===
        const maxExpireAt = getMaxExpireAtByUserAndRole(entry.userId, entry.roleId, now);
        if (maxExpireAt !== null && maxExpireAt > now) {
            // An active key with time remaining still exists → reschedule to max
            updateExpireAt(entry.id, maxExpireAt);
            const days = Math.ceil((maxExpireAt - now) / 86400000);
            console.log(
                `⏰ ${member.user.tag}: schedule ${role?.name || entry.roleId} rescheduled to ${days} more days (following the longest key).`
            );
            return;
        }

        // === 3. No active key → remove the role + delete the schedule ===
        if (role && member.roles.cache.has(entry.roleId)) {
            try {
                await member.roles.remove(entry.roleId);
                console.log(`✅ Auto-removed role ${role.name} from ${member.user.tag} (all keys expired).`);
                // Send a DM notification
                try {
                    await member.send({
                        content: `⏰ Your role **${role.name}** on server **${guild.name}** has been removed because all of its keys have expired.\n\nIf you think this is a mistake, contact an admin.`
                    });
                } catch (_) {}
            } catch (err) {
                // v3.9.0 FIX: if removing the role fails, check whether the error is transient.
                // If transient (Discord 5xx, ECONNRESET, ETIMEDOUT), do NOT delete
                // the schedule entry — let the next tick retry.
                // If non-transient (Missing Permissions, Unknown Role), delete the entry
                // so it doesn't get stuck forever.
                const isTransient = isTransientDiscordError(err);
                if (isTransient) {
                    console.warn(
                        `⚠️ Failed to remove role ${entry.roleId} from ${member.user.tag} (transient: ${err.code || err.name}). Will retry next tick. Entry NOT deleted.`
                    );
                    return; // important: don't removeEntry
                }
                // Non-transient: log the error, delete the entry so it doesn't loop forever.
                console.error(
                    `❌ Failed to remove role ${entry.roleId} from ${member.user.tag} (permanent: ${err.code || err.name}):`,
                    err.message
                );
                removeEntry(entry.id);
                return;
            }
        }
        removeEntry(entry.id);
    } catch (err) {
        // v3.9.0 FIX: only delete the entry if the error is non-transient.
        // Transient error (network blip) → let the next tick retry.
        const isTransient = isTransientDiscordError(err);
        if (isTransient) {
            console.warn(
                `⚠️ Transient error in processExpiredRole ${entry.id} (${err.code || err.name}). Entry NOT deleted, will be retried.`
            );
            return;
        }
        console.error(`❌ Error processing expired role ${entry.id} (permanent):`, err.message);
        removeEntry(entry.id);
    } finally {
        // v3.9.8: make sure the processing lock is released even on error / return.
        processingRoles.delete(entry.id);
    }
}

/**
 * Detect whether an error is transient (network / Discord 5xx / rate limit).
 * Transient errors should be retried, not treated as permanent failures.
 */
function isTransientDiscordError(err) {
    if (!err) return false;
    const code = err.code || '';
    const status = err.status || 0;
    const name = err.name || '';

    // Network / timeout
    if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code))
        return true;
    if (['ConnectTimeoutError', 'WebSocketClosedError'].includes(name)) return true;

    // Discord 5xx (server error, transient)
    if (status >= 500 && status < 600) return true;
    // Rate limit (transient)
    if (status === 429) return true;

    return false;
}

/**
 * Process a giveaway that has ended — pick winners + edit the message + announce.
 *
 * P0-3 FIX: added the `options.skipPick` option — if true, winners are not picked again
 * (used by manual `/giveaway end` when winners were already picked before).
 *
 * Accessible from commandHandler via `client.processGiveawayEnd(gw, opts)`.
 */
async function processGiveawayEnd(client, gw, options = {}) {
    // v3.9.8 FIX: TOCTOU guard. Previously, if one processGiveawayEnd
    // took >60s (DMs to many winners, rate limit), the next tick also
    // returned this gw from getEnding() (because endGiveaway hadn't run) → picked
    // winners a SECOND time → 2x announce + 2x winner DMs.
    if (processingGiveaways.has(gw.id)) {
        console.log(`⏭️ processGiveawayEnd ${gw.id} skipped (still being processed by a previous tick).`);
        return;
    }
    processingGiveaways.add(gw.id);
    try {
        // v3.9.38 FIX: re-read state FRESH from disk AFTER acquiring the scheduler
        // lock. `gw` can be a STALE snapshot from getEnding() (the scheduler awaited
        // another tick item first), while manual /giveaway end — which uses a
        // DIFFERENT lock (withUserLock('gw_end'), not this Set) — already picked
        // winners + persisted + announced. The scheduler then continued with the
        // old snapshot → a SECOND pick + endGiveaway overwriting winnerIds → 2x
        // announce + 2x DMs.
        const fresh = getGiveawayById(gw.id);
        if (!fresh) {
            console.log(`⏭️ processGiveawayEnd ${gw.id} skipped (giveaway not on disk).`);
            return;
        }
        // Manual announce path: the giveaway is ALREADY ended with persisted winners
        // (picked manually by /giveaway end before calling this) and the caller
        // requests skipPick → continue announcing using the winnerIds from disk, do NOT re-pick.
        const isManualAnnounce = Boolean(options.skipPick && fresh.winnerIds && fresh.winnerIds.length > 0);
        if (fresh.ended && !isManualAnnounce) {
            // Already fully-ended & announced by another process (manual end
            // OR a previous scheduler tick) → don't double announce/DM.
            console.log(`⏭️ processGiveawayEnd ${gw.id} skipped (already ended — handled by another process).`);
            return;
        }

        const guild = await client.guilds.fetch(fresh.guildId).catch(() => null);
        // If the guild isn't found (bot kicked / guild deleted), mark the giveaway as ended
        // so it isn't re-picked every tick. Previously this caused an infinite retry loop of ~60s ticks.
        if (!guild) {
            console.warn(
                `⚠️ Giveaway ${fresh.id}: guild ${fresh.guildId} not found, marking ended (bot kicked / guild deleted?).`
            );
            endGiveaway(fresh.id, []);
            return;
        }

        const channel = guild.channels.cache.get(fresh.channelId);
        // Same — if the channel was already deleted, mark ended to avoid an infinite retry.
        if (!channel) {
            console.warn(
                `⚠️ Giveaway ${fresh.id}: channel ${fresh.channelId} not found in guild ${fresh.guildId}, marking ended.`
            );
            endGiveaway(fresh.id, []);
            return;
        }

        // Pick winners from the FRESH state (skipped if already picked before — for manual /giveaway end).
        // v3.9.38 FIX: uses fresh.participantIds/winnersCount, not the possibly stale `gw` snapshot.
        let winnerIds;
        if (isManualAnnounce) {
            winnerIds = fresh.winnerIds;
        } else {
            winnerIds = pickGiveawayWinners(fresh.participantIds, fresh.winnersCount);
            endGiveaway(fresh.id, winnerIds);
        }

        // Edit the message
        const msg = await channel.messages.fetch(fresh.messageId).catch(() => null);
        const winnersStr = winnerIds.length > 0 ? winnerIds.map(id => `<@${id}>`).join(', ') : '_(no participants)_';
        if (msg) {
            const embed = new EmbedBuilder()
                .setTitle('🎉 GIVEAWAY ENDED!')
                .setDescription(
                    `🎁 **Prize:** ${fresh.prize}\n\n` +
                        `🏆 **Winners:** ${winnersStr}\n` +
                        `👥 **Participants:** ${fresh.participantIds.length}\n` +
                        `⏰ **Ended:** <t:${Math.floor(fresh.endsAt / 1000)}:R>\n\n` +
                        (winnerIds.length > 0
                            ? '🎊 Congratulations to the winners! The host will DM you to claim the prize.'
                            : '_(No one joined this giveaway)_')
                )
                .setColor(winnerIds.length > 0 ? 0x57f287 : 0x95a5a6)
                .setFooter({ text: `Host: ${fresh.hostTag} | ID: ${fresh.id}` })
                .setTimestamp();
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`gw_join:${fresh.id}`)
                    .setLabel('🎉 Join (Ended)')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(`gw_leave:${fresh.id}`)
                    .setLabel('🚪 Leave (Ended)')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );
            await msg.edit({ embeds: [embed], components: [row] }).catch(() => {});
        }

        // Announce the winners
        if (winnerIds.length > 0) {
            await channel
                .send({
                    content: `🎊 **GIVEAWAY WINNERS!** 🎊\n\nPrize: **${fresh.prize}**\nWinners: ${winnersStr}\n\nCongratulations! 🎉`
                })
                .catch(() => {});

            // DM the winners
            for (const wid of winnerIds) {
                const user = await client.users.fetch(wid).catch(() => null);
                if (user) {
                    await user
                        .send(
                            `🎊 **Congratulations! You won a giveaway!**\n\nPrize: **${fresh.prize}**\nHost: ${fresh.hostTag}\nServer: ${guild.name}\n\nContact the host to claim your prize.`
                        )
                        .catch(() => {});
                }
                // Track the giveaway win for the leaderboard
                // v3.9.4: scoped per guild — previously leaked to other guilds.
                try {
                    trackGiveawayWin(fresh.guildId, wid);
                } catch (_) {}
            }
        } else {
            await channel
                .send({ content: `📭 Giveaway **${fresh.prize}** ended with no winners (no participants).` })
                .catch(() => {});
        }

        console.log(`🎉 Giveaway ${fresh.id} (${fresh.prize}) ended. Winners: ${winnerIds.length}`);
    } catch (err) {
        console.error('Error processGiveawayEnd:', err);
    } finally {
        // v3.9.8: make sure the processing lock is released even on error / return.
        processingGiveaways.delete(gw.id);
    }
}

/**
 * v3.9.38 FIX: check whether the scheduler is currently processing this giveaway (natural end).
 * Used by /giveaway end (commands/giveaway.js) BEFORE the manual lock — the manual
 * lock (withUserLock 'gw_end') and the scheduler lock (Set processingGiveaways)
 * used to be disjoint: a manual end landing in the middle of a scheduler end could
 * overwrite winnerIds that were still being announced → double announce/DM.
 */
function isGiveawayProcessing(giveawayId) {
    return processingGiveaways.has(giveawayId);
}

/**
 * Helper: send the new-winner announcement to the giveaway channel (for /giveaway reroll).
 * Used by commandHandler after a reroll persists the new winner.
 */
async function announceRerollWinner(client, gw, winnerId) {
    try {
        const guild = await client.guilds.fetch(gw.guildId).catch(() => null);
        if (!guild) return;
        const channel = guild.channels.cache.get(gw.channelId);
        if (!channel) return;

        await channel
            .send({
                content: `🎲 **REROLL!** New winner for giveaway **${gw.prize}**: <@${winnerId}>!\n\nCongratulations! 🎉 The host will DM you to claim the prize.`
            })
            .catch(() => {});

        // DM the new winner
        const user = await client.users.fetch(winnerId).catch(() => null);
        if (user) {
            await user
                .send(
                    `🎊 **Congratulations! You won the giveaway (reroll)!**\n\nPrize: **${gw.prize}**\nHost: ${gw.hostTag}\nServer: ${guild.name}\n\nContact the host to claim your prize.`
                )
                .catch(() => {});
        }
        // Track stats
        // v3.9.4: scoped per guild
        try {
            trackGiveawayWin(gw.guildId, winnerId);
        } catch (_) {}
    } catch (err) {
        console.error('Error announceRerollWinner:', err);
    }
}

/**
 * Process a scheduled announcement that is due to be sent.
 * v3.9.0 FIX: if the target channel no longer exists (deleted by an admin), REMOVE the entry
 *   instead of markSent. Previously, markSent on a recurring announcement would
 *   create a new entry for the next cycle → the next cycle also fails because the
 *   channel still doesn't exist → creates yet another new entry → unbounded ghost
 *   entries piling up and eating disk + scheduler time.
 */
async function processScheduledAnnouncement(client, ann) {
    // v3.9.8 FIX: TOCTOU guard. Previously, if processScheduledAnnouncement
    // threw after sending the message but before markSent, the next tick sent
    // the same announcement again → duplicate ping. This guard skips parallel duplicates.
    if (processingAnns.has(ann.id)) {
        console.log(`⏭️ processScheduledAnnouncement ${ann.id} skipped (still being processed by a previous tick).`);
        return;
    }
    processingAnns.add(ann.id);
    try {
        const guild = await client.guilds.fetch(ann.guildId).catch(() => null);
        if (!guild) {
            // Guild gone (bot kicked) → delete the entry to avoid a ghost loop.
            console.warn(`⚠️ Scheduled announce ${ann.id}: guild ${ann.guildId} not found, deleting entry.`);
            removeAnn(ann.id);
            return;
        }

        const channel = guild.channels.cache.get(ann.channelId);
        if (!channel) {
            // v3.9.0 FIX: channel already deleted → REMOVE the entry, don't markSent
            // (markSent for recurring entries would create a new entry that also fails).
            console.warn(
                `⚠️ Scheduled announce ${ann.id}: channel ${ann.channelId} not found in guild ${guild.name}, deleting entry.`
            );
            removeAnn(ann.id);
            return;
        }

        const d = ann.data;
        const embed = new EmbedBuilder()
            .setTitle(d.title)
            .setDescription(d.description.replace(/\\n/g, '\n'))
            .setColor(d.color || 0x5865f2)
            .setFooter({ text: `Scheduled by ${d.authorTag}` })
            .setTimestamp();
        if (d.image) embed.setImage(d.image);
        if (d.thumbnail) embed.setThumbnail(d.thumbnail);

        // v3.9.8 FIX: markSent BEFORE sending, so if send throws,
        // the next tick doesn't resend (which would duplicate the ping).
        // Trade-off: if the send fails completely, the announcement is treated as
        // "sent" even though it wasn't. But that's better than a duplicate ping.
        markAnnSent(ann.id);

        await channel
            .send({
                content: d.mention || null,
                embeds: [embed]
            })
            .catch(err => console.warn('Failed to send scheduled announcement:', err.message));

        console.log(`📢 Scheduled announce ${ann.id} sent to ${channel.name}.`);
    } catch (err) {
        console.error('Error processScheduledAnnouncement:', err);
    } finally {
        // v3.9.8: make sure the processing lock is released even on error / return.
        processingAnns.delete(ann.id);
    }
}

/**
 * v3.9.26 (GC): prune old data that grows without bounds.
 * - Giveaways ended > 30 days ago → deleted from giveaways.json
 * - Polls closed > 30 days ago → deleted from polls.json
 * - Scheduled announcements sent > 30 days ago → deleted (recurring ones keep
 *   running — the NEW entry for the next cycle is never `sent`)
 * Active data is NEVER touched. Runs once per day by the scheduler
 * (lastDataPruneDay guard so it doesn't run on every 60-second tick).
 */
const PRUNE_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
let lastDataPruneDay = 0;

function pruneStaleData() {
    const today = Math.floor(Date.now() / 86400000);
    if (today === lastDataPruneDay) return; // already ran today
    lastDataPruneDay = today;

    try {
        const gwRemoved = pruneOldGiveaways(PRUNE_OLDER_THAN_MS);
        if (gwRemoved > 0) console.log(`🧹 GC: removed ${gwRemoved} giveaway(s) ended >30d ago.`);
    } catch (err) {
        console.warn('⚠️ GC giveaway error:', err.message);
    }
    try {
        const pollRemoved = pruneOldPolls(PRUNE_OLDER_THAN_MS);
        if (pollRemoved > 0) console.log(`🧹 GC: removed ${pollRemoved} poll(s) closed >30d ago.`);
    } catch (err) {
        console.warn('⚠️ GC poll error:', err.message);
    }
    try {
        const annRemoved = pruneOldAnns(PRUNE_OLDER_THAN_MS);
        if (annRemoved > 0) console.log(`🧹 GC: removed ${annRemoved} scheduled announcement(s) sent >30d ago.`);
    } catch (err) {
        console.warn('⚠️ GC announcement error:', err.message);
    }
    // v3.9.38 FIX: GC old AFK entries — afk.json was previously NEVER GC'd
    // (users who left the guild stayed AFK forever, the file grew without bounds).
    try {
        const afkRemoved = pruneOldAFK(PRUNE_OLDER_THAN_MS);
        if (afkRemoved > 0) console.log(`🧹 GC: removed ${afkRemoved} AFK entr(y/ies) older than 30d.`);
    } catch (err) {
        console.warn('⚠️ GC afk error:', err.message);
    }
}

/**
 * v3.9.37: reconcile zombie escrow deals — deals whose channel no longer exists
 * (deleted manually from the Discord UI by an admin / channel lost).
 * v3.9.38 FIX: ALL deals are inspected (active + terminal) — terminal deals that
 * failed to delete their channel on finalize are also cleaned up.
 *
 * Without the reconcile, users involved in a zombie deal are LOCKED OUT FOREVER:
 *   - can't open regular tickets (hasActiveDealFor → rejected in createTicket),
 *   - can't be picked as buyer/seller in a new deal (pick flow validation),
 *   - /midman-deals shows dead channel links.
 * Tickets have similar self-healing (findActiveTicketFor) — since v3.9.37 deals
 * do too. Cleanup uses removeDeal (the finalizeDeal pattern): terminal deal
 * history is indeed not kept long-term.
 *
 * Called: (a) once at startup (ready.js), (b) daily by the scheduler
 * tick via the wrapper reconcileZombieDealsDaily (day guard — mirrors pruneStaleData).
 *
 * @param {Client} client - Discord client (guilds cache)
 * @returns {Promise<number>} number of zombie deals cleaned up
 */
async function reconcileZombieDeals(client) {
    let removed = 0;
    for (const [gid, guild] of client.guilds.cache) {
        let deals;
        try {
            // v3.9.38 FIX: iterate ALL deals of this guild (active + terminal).
            // Previously only non-terminal deals (getActiveDealsByGuild) →
            // terminal deals (COMPLETED/CANCELLED/REFUNDED) that failed to delete
            // their channel on finalize (error ≠ 10003) were NEVER cleaned up
            // → metadata piled up in deals.json forever.
            // loadDeals = full map (keyed by channelId) — filter the local guild here.
            deals = Object.values(loadAllDeals()).filter(d => d && d.guildId === gid);
        } catch (err) {
            console.warn(`⚠️ Deal reconcile: failed to load deals for guild ${gid}:`, err.message);
            continue;
        }
        for (const deal of deals) {
            if (!deal.channelId) continue;
            try {
                // Cache first, fetch from the API on cache miss (the findActiveTicketFor pattern).
                let ch = guild.channels.cache.get(deal.channelId);
                if (!ch) {
                    try {
                        ch = await guild.channels.fetch(deal.channelId);
                    } catch (fetchErr) {
                        // 10003 = Unknown Channel → the channel is really deleted.
                        // Other errors (5xx / network / rate-limit) = TRANSIENT —
                        // don't delete an active deal just because of a momentary blip;
                        // leave the entry, retry on the next tick.
                        if (fetchErr?.code !== 10003) continue;
                        ch = null;
                    }
                }
                if (!ch) {
                    removeDealMeta(deal.channelId);
                    removed++;
                    console.log(
                        `🧹 Deal reconcile: channel ${deal.channelId} (guild ${gid}, state ${deal.state}) no longer exists — deal metadata removed.`
                    );
                }
            } catch (_) {
                // Defensive — an unexpected per-deal error must not abort the loop.
            }
        }
    }
    return removed;
}

let lastDealReconcileDay = 0;

/**
 * Daily wrapper for the scheduler tick — reconcileZombieDeals max 1x/day
 * (day guard, mirrors pruneStaleData; startup ready.js calls the non-guarded
 * version directly so a fresh check runs after a restart).
 */
async function reconcileZombieDealsDaily(client) {
    const today = Math.floor(Date.now() / 86400000);
    if (today === lastDealReconcileDay) return;
    lastDealReconcileDay = today;
    await reconcileZombieDeals(client);
}

/**
 * Attach all functions to the client so commandHandler can access them.
 * Called once when the bot is ready.
 */
function attachToClient(client) {
    client.processGiveawayEnd = processGiveawayEnd;
    client.announceRerollWinner = announceRerollWinner;
    // v3.9.38 FIX: used by /giveaway end to check for an in-flight scheduler end (anti double-end).
    client.isGiveawayProcessing = isGiveawayProcessing;
}

module.exports = {
    processExpiredRole,
    processGiveawayEnd,
    isGiveawayProcessing,
    announceRerollWinner,
    processScheduledAnnouncement,
    pruneStaleData,
    reconcileZombieDeals,
    reconcileZombieDealsDaily,
    attachToClient
};
