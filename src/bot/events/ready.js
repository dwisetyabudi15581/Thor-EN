/**
 * ClientReady handler — dipanggil saat bot berhasil login ke Discord.
 *
 * Tugas:
 *   1. Log bot online status.
 *   2. Cleanup global slash commands (anti duplikat dari versi lama).
 *   3. Register slash commands ke guild spesifik (instan) atau global (1 jam).
 *   4. Cleanup expired keys + process expired role schedules (offline catch-up).
 *   5. Start auto-backup + auto-flush stats cache.
 *   6. Reconcile temp voice registry (cleanup zombie + detect orphan).
 *   6b. Reconcile deal rekber zombie (cleanup meta deal tanpa channel).
 *   7. Init statsManager dengan default guild untuk migrasi legacy entries.
 *   8. Start main scheduler loop (60s interval).
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
    console.log(`✅ Bot online sebagai ${client.user.tag}`);

    // v3.9.24 FIX: urutan dibalik — daftar command ke guild DULU, baru bersihkan
    // command global. Sebelumnya wipe global jalan duluan; kalau registrasi guild
    // gagal setelahnya, bot jadi ZERO command di mana-mana sampai restart sukses.
    // (Wipe global tetap perlu supaya gak duplikat versi lama yang pernah global.)

    // === 1. Register slash commands ke guild spesifik (instan) ===
    let registeredToGuild = false;
    try {
        if (!GUILD_ID) {
            console.warn('⚠️ GUILD_ID belum di-set di .env. Bot fallback ke global commands.');
            console.warn('   Set GUILD_ID di file .env untuk registrasi instan (1 detik vs 1 jam).');
            // set() mengganti SELURUH daftar global sekaligus — tidak perlu pre-wipe.
            await client.application.commands.set(getCommands());
        } else {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) {
                console.warn(
                    `⚠️ Guild dengan ID ${GUILD_ID} tidak ditemukan. Pastikan bot sudah di-invite ke server itu.`
                );
                console.warn('   Sementara fallback ke global commands (perlu ~1 jam untuk muncul).');
                await client.application.commands.set(getCommands());
            } else {
                await guild.commands.set(getCommands());
                registeredToGuild = true;
                console.log(`✅ Slash Commands terdaftar ke guild: ${guild.name} (instan!)`);
            }
        }
    } catch (err) {
        console.error('Gagal daftar slash command:', err);
    }

    // === 1b. Cleanup global slash commands (anti duplikat) — hanya kalau guild sukses ===
    if (registeredToGuild) {
        try {
            const globalCmds = await client.application.commands.fetch();
            if (globalCmds.size > 0) {
                console.log(`🧹 Menghapus ${globalCmds.size} command global yang tersisa (anti duplikat)...`);
                await client.application.commands.set([]);
                console.log('✅ Command global dibersihkan.');
            }
        } catch (e) {
            console.warn('⚠️ Gagal bersihkan command global:', e.message);
        }
    }

    // v3.9.24 FIX (PENTING): langkah-langkah startup di bawah sebelumnya dibungkus
    // SATU try/catch raksasa. Kalau langkah awal throw (mis. removeExpiredKeys →
    // saveKeys → disk full), maka auto-backup, auto-flush, dan SELURUH scheduler
    // 60-detik TIDAK JALAN SAMA SEKALI — bot online tapi zombie (tidak expire
    // role, tidak end giveaway, tidak kirim announcement) dengan satu baris log
    // "Error re-schedule role:" yang tidak menjelaskan apa-apa. Sekarang tiap
    // langkah punya try/catch sendiri — gagal satu, sisanya tetap jalan.

    // === 2. Cleanup expired keys (offline catch-up) ===
    try {
        const removedKeys = removeExpiredKeys();
        if (removedKeys > 0) {
            console.log(`🧹 Membersihkan ${removedKeys} key expired dari keys.json.`);
        }
    } catch (err) {
        console.error('Startup: removeExpiredKeys error:', err.message);
    }

    // === 3. Re-schedule auto-remove role (offline catch-up) ===
    try {
        const expired = getExpired();
        if (expired.length > 0) {
            console.log(`⏰ Ditemukan ${expired.length} role yang harus diproses (schedule expired saat bot offline).`);
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
            console.log(`📋 ${active.length} auto-role terjadwal aktif.`);
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
    // Cleanup zombie entries (channel sudah dihapus admin) & detect orphan channels.
    try {
        for (const [gid] of client.guilds.cache) {
            const r = tempVoiceManager.reconcileGuild(client, gid);
            if (r.zombiesRemoved > 0 || r.orphansDetected > 0) {
                console.log(
                    `🧹 Temp voice reconcile ${gid}: ${r.zombiesRemoved} zombie dihapus, ${r.orphansDetected} orphan terdeteksi.`
                );
            }
        }
    } catch (err) {
        console.warn('⚠️ Gagal reconcile temp voice:', err.message);
    }

    // === 6b. Reconcile deal rekber zombie (v3.9.37) ===
    // Deal non-terminal yang channel-nya dihapus manual → meta dibersihkan,
    // supaya pembeli/penjual gak terkunci selamanya (mirror self-healing
    // tiket di findActiveTicketFor). Tick scheduler juga jalanin harian.
    try {
        const zombies = await reconcileZombieDeals(client);
        if (zombies > 0) console.log(`🧹 Startup: ${zombies} zombie deal rekber dibersihkan.`);
    } catch (err) {
        console.warn('⚠️ Gagal reconcile deal rekber:', err.message);
    }

    // === 7. Init statsManager dengan default guild untuk migrasi legacy ===
    const defaultStatsGuildId = GUILD_ID || (client.guilds.cache.size > 0 ? client.guilds.cache.first().id : null);
    if (defaultStatsGuildId) {
        try {
            initStats(defaultStatsGuildId);
        } catch (err) {
            console.warn('⚠️ Gagal init statsManager:', err.message);
        }
    }

    // === 8. Start main scheduler loop (60s) ===
    // Guard overlap: skip tick kalau sebelumnya belum selesai (anti double-DM).
    // Setiap item di-wrap try/catch sendiri (1 throw gak abort sisa loop).
    try {
        let schedulerRunning = false;
        // Simpen reference + .unref() biar interval gak nge-block graceful shutdown.
        // Kalau gak, process bisa jadi zombie kalo gracefulShutdown gagal reach process.exit.
        const schedulerInterval = setInterval(async () => {
            if (schedulerRunning) {
                console.log('⏭️ Scheduler tick di-skip (iterasi sebelumnya masih jalan).');
                return;
            }
            schedulerRunning = true;
            try {
                try {
                    const removed = removeExpiredKeys();
                    if (removed > 0) console.log(`🧹 ${removed} key expired dihapus.`);
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

                // v3.9.26: GC harian — giveaway/poll/announcement lama (internal
                // guard per-hari, jadi efektif jalan 1x/hari saja).
                try {
                    pruneStaleData();
                } catch (err) {
                    console.error('Scheduler: pruneStaleData error:', err.message);
                }

                // v3.9.37: reconcile harian deal rekber zombie (channel dihapus
                // manual selagi bot jalan — startup check gak meliputi kasus ini).
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
        console.error('Startup: gagal start scheduler loop:', err);
    }
}

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute: onReady
};
