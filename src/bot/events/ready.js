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
    reconcileZombieDealsDaily
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
