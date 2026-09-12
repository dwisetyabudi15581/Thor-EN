/**
 * ClientReady handler — called when the bot successfully logs in to Discord.
 *
 * Tasks:
 *   1. Log the bot's online status.
 *   2. Clean up global slash commands (anti-duplicate from old versions).
 *   3. Register slash commands to a specific guild (instant) or globally (1 hour).
 *   4. Clean up expired keys + process expired role schedules (offline catch-up).
 *   5. Start auto-backup + auto-flush of the stats cache.
 *   6. Reconcile the temp voice registry (clean up zombies + detect orphans).
 *   6b. Reconcile zombie escrow deals (clean up deal metadata without a channel).
 *   7. Initialize statsManager with the default guild for legacy entry migration.
 *   8. Start the main scheduler loop (60s interval).
 */

const { Events } = require('discord.js');
const { getCommands } = require('../../commands/registry');
const {
    processExpiredRole,
    processGiveawayEnd,
    processScheduledAnnouncement,
    pruneStaleData,
    reconcileZombieDeals,
    reconcileZombieDealsDaily,
    // v3.9.51: live server stats counter channels.
    processServerStatsTick
} = require('../../services/schedulerTasks');
const { getExpired, getAllActive } = require('../../data/roleScheduler');
const { removeExpiredKeys } = require('../../data/keyManager');
const { startAutoBackup } = require('../../data/backupManager');
const { getEnding: getEndingGiveaways } = require('../../data/giveawayManager');
const { getPending: getPendingAnns } = require('../../data/scheduledAnnouncements');
const { startAutoFlush: startStatsAutoFlush, init: initStats } = require('../../data/statsManager');
const tempVoiceManager = require('../../data/tempVoiceManager');

const GUILD_ID = process.env.GUILD_ID || null;

async function onReady(client) {
    console.log(`✅ Bot online as ${client.user.tag}`);

    // === 1c. v3.9.48: welcome/goodbye startup check ===
    // The #1 "welcome doesn't appear" report = the channel was never set, was
    // deleted, or its ID came from another server. Previously the bot was SILENT
    // both at startup AND when a member actually joined — now both speak up.
    // /test-welcome does the deeper check (permissions + live preview).
    // v3.9.49: server-booster joined the same check (boost notifications).
    try {
        const { getConfig } = require('../../data/configManager');
        const guild = GUILD_ID
            ? client.guilds.cache.get(GUILD_ID)
            : client.guilds.cache.size > 0
              ? client.guilds.cache.first()
              : null;
        if (guild) {
            // v3.10.0 multi-guild: check this guild's channels (if GUILD_ID
            // is unset, the first guild is used ONLY for the startup report —
            // runtime handlers always use their own guild).
            const config = getConfig(guild.id);
            const CHANNEL_LABELS = {
                welcome: 'welcome messages',
                goodbye: 'goodbye messages',
                'server-booster': 'boost notifications'
            };
            for (const key of Object.keys(CHANNEL_LABELS)) {
                const id = config.channels[key];
                if (!id) {
                    console.warn(
                        `⚠️ The ${key} channel is NOT set — ${CHANNEL_LABELS[key]} are OFF. Fix: /set-channel ${key} #channel`
                    );
                } else if (!guild.channels.cache.get(id)) {
                    console.warn(
                        `⚠️ The ${key} channel (ID ${id}) does not exist in "${guild.name}" — deleted, or the ID belongs to another server. Fix: /set-channel ${key} #channel`
                    );
                } else {
                    console.log(`✅ ${key} channel configured: #${guild.channels.cache.get(id).name} (ID ${id})`);
                }
            }
        }
    } catch (err) {
        console.warn('⚠️ Startup welcome/goodbye check failed:', err.message);
    }

    // === 1d. v3.9.49: booster offline catch-up ===
    // Boosts that started/ended while the bot was offline were invisible before
    // this. Reconcile the live state (guild members cache) against boosts.json,
    // then send ONE consolidated catch-up embed to the server-booster channel
    // when anything actually changed (no spam: one embed, not one per member).
    try {
        const guild = GUILD_ID
            ? client.guilds.cache.get(GUILD_ID)
            : client.guilds.cache.size > 0
              ? client.guilds.cache.first()
              : null;
        if (guild) {
            // Members cache is empty right after login — fetch the roster first
            // so premiumSinceTimestamp is known for EVERY member, not just the
            // ones the bot happens to have cached.
            try {
                await guild.members.fetch();
            } catch (fetchErr) {
                console.warn(`⚠️ Booster reconcile: member fetch failed (${fetchErr.message}) — using the cache only.`);
            }
            const boostManager = require('../../data/boostManager');
            const { added, removed } = boostManager.reconcileBoosters(guild);
            // v3.9.59: booster auto role — STATE sync (not event-based): every
            // live booster missing the role gets it (offline boosts OR live
            // assignments that once failed), boosts that ended while offline
            // lose it. Manual grants to regular members are never touched.
            try {
                const { syncBoostRoles } = require('../boostHandler');
                const roleRes = await syncBoostRoles(guild, removed);
                if (roleRes.applied > 0 || roleRes.removed > 0) {
                    console.log(`🎭 Booster role synced: ${roleRes.applied} granted, ${roleRes.removed} removed.`);
                }
            } catch (roleErr) {
                console.warn(`⚠️ Booster role sync failed: ${roleErr.message}`);
            }
            if (added.length > 0 || removed.length > 0) {
                const lines = [];
                if (added.length > 0) lines.push(`🚀 New booster(s) while the bot was offline: ${added.map(id => `<@${id}>`).join(' ')}`);
                if (removed.length > 0) lines.push(`💔 Stopped boosting while the bot was offline: ${removed.map(id => `<@${id}>`).join(' ')}`);
                console.log(`🚀 Booster catch-up: ${added.length} added, ${removed.length} removed since the last run.`);
                const { getConfig } = require('../../data/configManager');
                const boostChId = getConfig(guild.id).channels['server-booster'];
                const boostCh = boostChId ? guild.channels.cache.get(boostChId) : null;
                if (boostCh && typeof boostCh.send === 'function') {
                    try {
                        const { EmbedBuilder } = require('discord.js');
                        await boostCh.send({
                            embeds: [
                                new EmbedBuilder()
                                    .setTitle('🚀 BOOST CATCH-UP')
                                    .setDescription(
                                        `Boost changes that happened while the bot was offline:\n\n${lines.join('\n')}`
                                    )
                                    .setColor(0xf472b6)
                                    .setTimestamp()
                            ]
                        });
                    } catch (sendErr) {
                        console.warn(`⚠️ Failed to send the boost catch-up message: ${sendErr.message}`);
                    }
                }
            } else {
                console.log(`✅ Boosters in sync (${guild.premiumSubscriptionCount ?? 0} boost(s), level ${guild.premiumTier ?? 0}).`);
            }
        }
    } catch (err) {
        console.warn('⚠️ Startup booster reconcile failed:', err.message);
    }

    // === 1e. v3.9.51: server stats counters — startup sync ===
    // One forced refresh right after login so the counters are correct even
    // if changes happened while the bot was offline (the events were missed).
    // Also confirms the setup is healthy (deleted channels warn here).
    try {
        const serverstatsManager = require('../../data/serverstatsManager');
        if (serverstatsManager.isEnabled()) {
            const guild = GUILD_ID
                ? client.guilds.cache.get(GUILD_ID)
                : client.guilds.cache.size > 0
                  ? client.guilds.cache.first()
                  : null;
            if (guild) {
                const result = await serverstatsManager.refreshServerStats(guild, { force: true });
                if (result.disabled) {
                    console.warn('⚠️ Server stats counters: ALL channels are gone — the feature is disabled. Re-create with /serverstats setup.');
                } else {
                    console.log(
                        `📊 Server stats counters synced (updated ${result.updated}, deferred ${result.deferred}, missing ${result.missing}, errors ${result.errors}).`
                    );
                }
            }
        }
    } catch (err) {
        console.warn('⚠️ Startup server stats sync failed:', err.message);
    }

    // v3.9.24 FIX: order reversed — register commands to the guild FIRST, then clean
    // up global commands. Previously the global wipe ran first; if guild
    // registration failed afterwards, the bot had ZERO commands everywhere until
    // a successful restart. (The global wipe is still needed so old versions that
    // were once global don't get duplicated.)

    // === 1. Register slash commands to a specific guild (instant) ===
    let registeredToGuild = false;
    try {
        if (!GUILD_ID) {
            console.warn('⚠️ GUILD_ID is not set in .env. The bot falls back to global commands.');
            console.warn('   Set GUILD_ID in the .env file for instant registration (1 second vs 1 hour).');
            // set() replaces the ENTIRE global list at once — no pre-wipe needed.
            await client.application.commands.set(getCommands());
        } else {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) {
                console.warn(
                    `⚠️ Guild with ID ${GUILD_ID} not found. Make sure the bot has been invited to that server.`
                );
                console.warn('   Temporarily falling back to global commands (takes ~1 hour to appear).');
                await client.application.commands.set(getCommands());
            } else {
                await guild.commands.set(getCommands());
                registeredToGuild = true;
                console.log(`✅ Slash Commands registered to guild: ${guild.name} (instant!)`);
            }
        }
    } catch (err) {
        console.error('Failed to register slash commands:', err);
    }

    // === 1b. Cleanup global slash commands (anti-duplicate) — only if guild registration succeeded ===
    if (registeredToGuild) {
        try {
            const globalCmds = await client.application.commands.fetch();
            if (globalCmds.size > 0) {
                console.log(`🧹 Removing ${globalCmds.size} leftover global command(s) (anti-duplicate)...`);
                await client.application.commands.set([]);
                console.log('✅ Global commands cleaned up.');
            }
        } catch (e) {
            console.warn('⚠️ Failed to clean up global commands:', e.message);
        }
    }

    // v3.9.24 FIX (IMPORTANT): the startup steps below were previously wrapped in
    // ONE giant try/catch. If an early step threw (e.g. removeExpiredKeys →
    // saveKeys → disk full), then auto-backup, auto-flush, and the ENTIRE 60-second
    // scheduler NEVER RAN AT ALL — the bot was online but a zombie (no role expiry,
    // no giveaway endings, no announcements) with a single log line
    // "Error re-schedule role:" that explained nothing. Now each step has its own
    // try/catch — if one fails, the rest still run.

    // === 2. Cleanup expired keys (offline catch-up) ===
    try {
        const removedKeys = removeExpiredKeys();
        if (removedKeys > 0) {
            console.log(`🧹 Cleaning up ${removedKeys} expired key(s) from keys.json.`);
        }
    } catch (err) {
        console.error('Startup: removeExpiredKeys error:', err.message);
    }

    // === 3. Re-schedule auto-remove roles (offline catch-up) ===
    try {
        const expired = getExpired();
        if (expired.length > 0) {
            console.log(`⏰ Found ${expired.length} role(s) to process (schedules expired while the bot was offline).`);
            for (const entry of expired) {
                try {
                    await processExpiredRole(client, entry);
                } catch (err) {
                    console.error(`Startup: processExpiredRole ${entry.id} error:`, err.message);
                }
            }
        }
        const active = getAllActive();
        if (active.length > 0) {
            console.log(`📋 ${active.length} active scheduled auto-role(s).`);
        }
    } catch (err) {
        console.error('Startup: offline catch-up role error:', err.message);
    }

    // === 4. Start auto-backup ===
    try {
        startAutoBackup(client);
    } catch (err) {
        console.error('Startup: startAutoBackup error:', err.message);
    }

    // === 5. Start auto-flush stats cache ===
    try {
        startStatsAutoFlush();
    } catch (err) {
        console.error('Startup: startStatsAutoFlush error:', err.message);
    }

    // === 6. Reconcile temp voice registry ===
    // Clean up zombie entries (channels already deleted by an admin) & detect orphan channels.
    try {
        for (const [gid] of client.guilds.cache) {
            const r = tempVoiceManager.reconcileGuild(client, gid);
            if (r.zombiesRemoved > 0 || r.orphansDetected > 0) {
                console.log(
                    `🧹 Temp voice reconcile ${gid}: ${r.zombiesRemoved} zombie(s) removed, ${r.orphansDetected} orphan(s) detected.`
                );
            }
        }
    } catch (err) {
        console.warn('⚠️ Failed to reconcile temp voice:', err.message);
    }

    // === 6b. Reconcile zombie escrow deals (v3.9.37) ===
    // Non-terminal deals whose channel was deleted manually → metadata cleaned
    // up, so the buyer/seller aren't locked forever (mirrors the ticket
    // self-healing in findActiveTicketFor). The scheduler tick also runs this daily.
    try {
        const zombies = await reconcileZombieDeals(client);
        if (zombies > 0) console.log(`🧹 Startup: ${zombies} zombie escrow deal(s) cleaned up.`);
    } catch (err) {
        console.warn('⚠️ Failed to reconcile escrow deals:', err.message);
    }

    // === 7. Init statsManager with the default guild for legacy migration ===
    const defaultStatsGuildId = GUILD_ID || (client.guilds.cache.size > 0 ? client.guilds.cache.first().id : null);
    if (defaultStatsGuildId) {
        try {
            initStats(defaultStatsGuildId);
        } catch (err) {
            console.warn('⚠️ Failed to init statsManager:', err.message);
        }
    }

    // === 8. Start the main scheduler loop (60s) ===
    // Overlap guard: skip a tick if the previous one hasn't finished (anti double-DM).
    // Each item is wrapped in its own try/catch (1 throw doesn't abort the rest of the loop).
    try {
        let schedulerRunning = false;
        // Keep the reference + .unref() so the interval doesn't block graceful shutdown.
        // Otherwise the process could become a zombie if gracefulShutdown fails to reach process.exit.
        const schedulerInterval = setInterval(async () => {
            if (schedulerRunning) {
                console.log('⏭️ Scheduler tick skipped (previous iteration still running).');
                return;
            }
            schedulerRunning = true;
            try {
                try {
                    const removed = removeExpiredKeys();
                    if (removed > 0) console.log(`🧹 ${removed} expired key(s) removed.`);
                } catch (err) {
                    console.error('Scheduler: removeExpiredKeys error:', err.message);
                }

                const expiredNow = getExpired();
                for (const entry of expiredNow) {
                    try {
                        await processExpiredRole(client, entry);
                    } catch (err) {
                        console.error(`Scheduler: processExpiredRole ${entry.id} error:`, err.message);
                    }
                }

                const endingGws = getEndingGiveaways();
                for (const gw of endingGws) {
                    try {
                        await processGiveawayEnd(client, gw);
                    } catch (err) {
                        console.error(`Scheduler: processGiveawayEnd ${gw.id} error:`, err.message);
                    }
                }

                const pendingAnns = getPendingAnns();
                for (const ann of pendingAnns) {
                    try {
                        await processScheduledAnnouncement(client, ann);
                    } catch (err) {
                        console.error(`Scheduler: processScheduledAnnouncement ${ann.id} error:`, err.message);
                    }
                }

                // v3.9.26: daily GC — old giveaways/polls/announcements (internal
                // per-day guard, so it effectively runs only 1x/day).
                try {
                    pruneStaleData();
                } catch (err) {
                    console.error('Scheduler: pruneStaleData error:', err.message);
                }

                // v3.9.37: daily reconcile of zombie escrow deals (channel deleted
                // manually while the bot was running — the startup check doesn't
                // cover this case).
                try {
                    await reconcileZombieDealsDaily(client);
                } catch (err) {
                    console.error('Scheduler: reconcileZombieDeals error:', err.message);
                }

                // v3.9.51: live server stats counters — dirty-driven (an event
                // happened) + 5-min catch-up. Rate-limit safe (change detection +
                // per-channel cooldown inside the manager).
                try {
                    await processServerStatsTick(client);
                } catch (err) {
                    console.error('Scheduler: processServerStats error:', err.message);
                }
            } catch (err) {
                console.error('Scheduler tick error:', err);
            } finally {
                schedulerRunning = false;
            }
        }, 60 * 1000);
        if (typeof schedulerInterval.unref === 'function') schedulerInterval.unref();
    } catch (err) {
        console.error('Startup: failed to start scheduler loop:', err);
    }
}

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute: onReady
};
