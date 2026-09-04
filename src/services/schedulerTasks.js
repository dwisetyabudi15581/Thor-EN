/**
 * Scheduler Tasks — fungsi-fungsi yang dipanggil scheduler loop di index.js.
 *
 * Tujuan (P3-6 refactor): pisahkan logic scheduler dari entry point bot
 * supaya index.js lebih lean dan mudah dibaca.
 *
 * Berisi:
 *   - processExpiredRole: proses schedule role removal yang sudah expired
 *   - processGiveawayEnd: proses giveaway yang sudah berakhir (pick winners + announce)
 *   - announceRerollWinner: kirim announce winner baru setelah reroll
 *   - processScheduledAnnouncement: kirim scheduled announcement yang sudah waktunya
 *
 * Fungsi `processGiveawayEnd` & `announceRerollWinner` di-attach ke `client`
 * supaya bisa dipanggil dari commandHandler untuk `/giveaway end` & `/giveaway reroll`.
 */

// v3.9.24: getExpired dihapus dari import — tidak pernah dipakai di file ini
// (hanya dipakai ready.js); salah satu sumber lint warning.
const { removeEntry, updateExpireAt } = require('../data/roleScheduler');
const { hasPermanentKey, getMaxExpireAtByUserAndRole } = require('../data/keyManager');
// v3.9.35 cleanup: import discord.js di-hoist ke top-level — sebelumnya 2x lazy
// require di dalam processGiveawayEnd & processScheduledAnnouncement (redundan:
// discord.js selalu sudah ter-load saat bot start).
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
// v3.9.37: reconcile deal rekber zombie (lihat reconcileZombieDeals di bawah).
// v3.9.38 FIX: loadDeals dipakai supaya reconcile bisa iterasi SEMUA deal
// (termasuk terminal) — getActiveDealsByGuild tidak lagi dipakai di sini.
const {
    loadDeals: loadAllDeals,
    removeDeal: removeDealMeta
} = require('../data/midmanManager');
// v3.9.38 FIX: GC entry AFK lama (lihat pruneStaleData di bawah).
const { pruneOldAFK } = require('../data/afkManager');

// v3.9.8 FIX: in-memory guard supaya giveaway/announcement yang sama tidak
// diproses 2x paralel oleh scheduler tick. Sebelumnya, kalau satu
// processGiveawayEnd butuh >60s (DM ke banyak winner, rate limit), tick
// berikutnya pick winner KEDUA kalinya → 2x announce + 2x DM winner.
const processingGiveaways = new Set();
const processingAnns = new Set();
const processingRoles = new Set();

/**
 * Proses schedule yang sudah expired — MODEL KEY-DRIVEN dengan recheck.
 *
 * Logic:
 *   1. Cek apakah user masih ada di guild. Kalau tidak → hapus schedule.
 *   2. Cek key aktif untuk user+role:
 *      a. Kalau ada key PERMANEN → hapus schedule, role tetap (permanen).
 *      b. Kalau ada key aktif dengan expireAt > now → reschedule ke max(expireAt).
 *         Role tetap. (ini kunci MAX EXTEND — schedule tidak boleh lebih pendek dari key terpanjang)
 *      c. Kalau tidak ada key aktif → hapus role + hapus schedule.
 *
 * v3.9.0 FIX: kalau terjadi transient error (Discord API 5xx, network blip),
 * JANGAN hapus schedule entry. Sebelumnya, catch block selalu removeEntry
 * yang bikin user keep role forever kalau error-nya transient. Sekarang,
 * entry tetap ada untuk di-retry tick berikutnya.
 */
async function processExpiredRole(client, entry) {
    // v3.9.8 FIX: skip kalau entry ini lagi di-process tick sebelumnya.
    // Sebelumnya, kalau processExpiredRole butuh >60s (Discord API lambat),
    // tick berikutnya pick entry yang sama → 2x DM "role kamu dihapus".
    if (processingRoles.has(entry.id)) {
        console.log(`⏭️ processExpiredRole ${entry.id} di-skip (masih diproses tick sebelumnya).`);
        return;
    }
    processingRoles.add(entry.id);
    try {
        const guild = await client.guilds.fetch(entry.guildId).catch(() => null);
        if (!guild) {
            // Guild benar-benar hilang (bot di-kick) → safe to remove.
            removeEntry(entry.id);
            return;
        }
        const member = await guild.members.fetch(entry.userId).catch(() => null);
        if (!member) {
            // User sudah leave guild → safe to remove.
            removeEntry(entry.id);
            return;
        }
        // P2-11 FIX: pakai fetch (fallback ke API) bukan cache.get
        // supaya role yang belum ter-cache tetap bisa diproses.
        const role = await guild.roles.fetch(entry.roleId).catch(() => null);
        const now = Date.now();

        // === 1. Cek key PERMANEN ===
        if (hasPermanentKey(entry.userId, entry.roleId)) {
            console.log(
                `♾️ ${member.user.tag}: schedule ${role?.name || entry.roleId} dihapus (ada key permanen). Role tetap.`
            );
            removeEntry(entry.id);
            return;
        }

        // === 2. Cek key aktif lain dengan expireAt > now ===
        const maxExpireAt = getMaxExpireAtByUserAndRole(entry.userId, entry.roleId, now);
        if (maxExpireAt !== null && maxExpireAt > now) {
            // Masih ada key aktif dengan sisa waktu → reschedule ke max
            updateExpireAt(entry.id, maxExpireAt);
            const days = Math.ceil((maxExpireAt - now) / 86400000);
            console.log(
                `⏰ ${member.user.tag}: schedule ${role?.name || entry.roleId} di-reschedule ke ${days} hari lagi (mengikuti key terpanjang).`
            );
            return;
        }

        // === 3. Tidak ada key aktif → hapus role + hapus schedule ===
        if (role && member.roles.cache.has(entry.roleId)) {
            try {
                await member.roles.remove(entry.roleId);
                console.log(`✅ Auto-remove role ${role.name} dari ${member.user.tag} (semua key sudah expired).`);
                // Kirim DM notifikasi
                try {
                    await member.send({
                        content: `⏰ Role **${role.name}** kamu di server **${guild.name}** sudah dihapus karena semua key sudah expired.\n\nKalau merasa ini salah, hubungi admin.`
                    });
                } catch (_) {}
            } catch (err) {
                // v3.9.0 FIX: kalau gagal hapus role, cek apakah error transient.
                // Kalau transient (Discord 5xx, ECONNRESET, ETIMEDOUT), JANGAN hapus
                // schedule entry — biarkan tick berikutnya retry.
                // Kalau non-transient (Missing Permissions, Unknown Role), hapus entry
                // supaya tidak stuck forever.
                const isTransient = isTransientDiscordError(err);
                if (isTransient) {
                    console.warn(
                        `⚠️ Gagal hapus role ${entry.roleId} dari ${member.user.tag} (transient: ${err.code || err.name}). Akan di-retry tick berikutnya. Entry TIDAK dihapus.`
                    );
                    return; // penting: jangan removeEntry
                }
                // Non-transient: log error, hapus entry supaya tidak loop forever.
                console.error(
                    `❌ Gagal hapus role ${entry.roleId} dari ${member.user.tag} (permanent: ${err.code || err.name}):`,
                    err.message
                );
                removeEntry(entry.id);
                return;
            }
        }
        removeEntry(entry.id);
    } catch (err) {
        // v3.9.0 FIX: hanya hapus entry kalau error-nya non-transient.
        // Transient error (network blip) → biarkan tick berikutnya retry.
        const isTransient = isTransientDiscordError(err);
        if (isTransient) {
            console.warn(
                `⚠️ Transient error di processExpiredRole ${entry.id} (${err.code || err.name}). Entry TIDAK dihapus, akan di-retry.`
            );
            return;
        }
        console.error(`❌ Error process expired role ${entry.id} (permanent):`, err.message);
        removeEntry(entry.id);
    } finally {
        // v3.9.8: pastikan processing lock dilepas walau ada error / return.
        processingRoles.delete(entry.id);
    }
}

/**
 * Deteksi apakah error adalah transient (network / Discord 5xx / rate limit).
 * Transient errors seharusnya di-retry, bukan dianggap permanent failure.
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
 * Proses giveaway yang sudah berakhir — pick winners + edit message + announce.
 *
 * P0-3 FIX: tambah opsi `options.skipPick` — kalau true, tidak pick winners lagi
 * (dipakai saat manual `/giveaway end` yang sudah pick winners sebelumnya).
 *
 * Bisa diakses dari commandHandler via `client.processGiveawayEnd(gw, opts)`.
 */
async function processGiveawayEnd(client, gw, options = {}) {
    // v3.9.8 FIX: TOCTOU guard. Sebelumnya, kalau satu processGiveawayEnd
    // butuh >60s (DM ke banyak winner, rate limit), tick berikutnya juga
    // return gw ini di getEnding() (karena endGiveaway belum jalan) → pick
    // winner KEDUA kalinya → 2x announce + 2x DM winner.
    if (processingGiveaways.has(gw.id)) {
        console.log(`⏭️ processGiveawayEnd ${gw.id} di-skip (masih diproses tick sebelumnya).`);
        return;
    }
    processingGiveaways.add(gw.id);
    try {
        // v3.9.38 FIX: re-read state FRESH dari disk SETELAH lock scheduler
        // dipegang. `gw` bisa snapshot STALE dari getEnding() (scheduler await
        // item tick lain dulu), sementara manual /giveaway end — yang memakai
        // lock BERBEDA (withUserLock('gw_end'), bukan Set ini) — sudah pick
        // winners + persist + announce. Scheduler lanjut dengan snapshot lama
        // → pick KEDUA + endGiveaway menimpa winnerIds → 2x announce + 2x DM.
        const fresh = getGiveawayById(gw.id);
        if (!fresh) {
            console.log(`⏭️ processGiveawayEnd ${gw.id} di-skip (giveaway tidak ada di disk).`);
            return;
        }
        // Jalur announce manual: giveaway SUDAH ended dengan winner ter-persist
        // (dipick manual oleh /giveaway end sebelum memanggil ini) dan caller
        // minta skipPick → lanjut announce pakai winnerIds dari disk, TIDAK re-pick.
        const isManualAnnounce = Boolean(options.skipPick && fresh.winnerIds && fresh.winnerIds.length > 0);
        if (fresh.ended && !isManualAnnounce) {
            // Sudah di-fully-ended & di-announce oleh proses lain (manual end
            // ATAU tick scheduler sebelumnya) → jangan dobel announce/DM.
            console.log(`⏭️ processGiveawayEnd ${gw.id} di-skip (sudah berakhir — dihandle proses lain).`);
            return;
        }

        const guild = await client.guilds.fetch(fresh.guildId).catch(() => null);
        // Kalau guild gak ketemu (bot di-kick / guild di-delete), mark giveaway sebagai ended
        // biar gak di-pick ulang tiap tick. Sebelumnya ini bikin infinite retry loop 60-an.
        if (!guild) {
            console.warn(
                `⚠️ Giveaway ${fresh.id}: guild ${fresh.guildId} tidak ditemukan, mark ended (bot di-kick / guild di-delete?).`
            );
            endGiveaway(fresh.id, []);
            return;
        }

        const channel = guild.channels.cache.get(fresh.channelId);
        // Sama — kalau channel udah di-delete, mark ended biar gak infinite retry.
        if (!channel) {
            console.warn(
                `⚠️ Giveaway ${fresh.id}: channel ${fresh.channelId} tidak ditemukan di guild ${fresh.guildId}, mark ended.`
            );
            endGiveaway(fresh.id, []);
            return;
        }

        // Pick winners dari state FRESH (skip kalau sudah di-pick sebelumnya — untuk manual /giveaway end).
        // v3.9.38 FIX: pakai fresh.participantIds/winnersCount, bukan snapshot `gw` yang bisa stale.
        let winnerIds;
        if (isManualAnnounce) {
            winnerIds = fresh.winnerIds;
        } else {
            winnerIds = pickGiveawayWinners(fresh.participantIds, fresh.winnersCount);
            endGiveaway(fresh.id, winnerIds);
        }

        // Edit message
        const msg = await channel.messages.fetch(fresh.messageId).catch(() => null);
        const winnersStr = winnerIds.length > 0 ? winnerIds.map(id => `<@${id}>`).join(', ') : '_(tidak ada peserta)_';
        if (msg) {
            const embed = new EmbedBuilder()
                .setTitle('🎉 GIVEAWAY BERAKHIR!')
                .setDescription(
                    `🎁 **Prize:** ${fresh.prize}\n\n` +
                        `🏆 **Pemenang:** ${winnersStr}\n` +
                        `👥 **Peserta:** ${fresh.participantIds.length}\n` +
                        `⏰ **Berakhir:** <t:${Math.floor(fresh.endsAt / 1000)}:R>\n\n` +
                        (winnerIds.length > 0
                            ? '🎊 Selamat kepada pemenang! Host akan DM kalian untuk klaim hadiah.'
                            : '_(Tidak ada peserta yang ikut)_')
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

        // Announce winners
        if (winnerIds.length > 0) {
            await channel
                .send({
                    content: `🎊 **GIVEAWAY WINNERS!** 🎊\n\nPrize: **${fresh.prize}**\nPemenang: ${winnersStr}\n\nSelamat! 🎉`
                })
                .catch(() => {});

            // DM winners
            for (const wid of winnerIds) {
                const user = await client.users.fetch(wid).catch(() => null);
                if (user) {
                    await user
                        .send(
                            `🎊 **Selamat! Kamu menang giveaway!**\n\nPrize: **${fresh.prize}**\nHost: ${fresh.hostTag}\nServer: ${guild.name}\n\nHubungi host untuk klaim hadiahmu.`
                        )
                        .catch(() => {});
                }
                // Track giveaway win untuk leaderboard
                // v3.9.4: scoped per guild — sebelumnya bocor ke guild lain.
                try {
                    trackGiveawayWin(fresh.guildId, wid);
                } catch (_) {}
            }
        } else {
            await channel
                .send({ content: `📭 Giveaway **${fresh.prize}** berakhir tanpa pemenang (tidak ada peserta).` })
                .catch(() => {});
        }

        console.log(`🎉 Giveaway ${fresh.id} (${fresh.prize}) berakhir. Winners: ${winnerIds.length}`);
    } catch (err) {
        console.error('Error processGiveawayEnd:', err);
    } finally {
        // v3.9.8: pastikan processing lock dilepas walau ada error / return.
        processingGiveaways.delete(gw.id);
    }
}

/**
 * v3.9.38 FIX: cek apakah scheduler lagi memproses giveaway ini (natural end).
 * Dipakai /giveaway end (commands/giveaway.js) SEBELUM lock manual — lock
 * manual (withUserLock 'gw_end') dan lock scheduler (Set processingGiveaways)
 * tadinya disjoint: manual end yang masuk di tengah scheduler end bisa
 * menimpa winnerIds yang sedang di-announce → announce/DM dobel.
 */
function isGiveawayProcessing(giveawayId) {
    return processingGiveaways.has(giveawayId);
}

/**
 * Helper: kirim announce winner baru ke channel giveaway (untuk /giveaway reroll).
 * Dipakai oleh commandHandler setelah reroll persist winner baru.
 */
async function announceRerollWinner(client, gw, winnerId) {
    try {
        const guild = await client.guilds.fetch(gw.guildId).catch(() => null);
        if (!guild) return;
        const channel = guild.channels.cache.get(gw.channelId);
        if (!channel) return;

        await channel
            .send({
                content: `🎲 **REROLL!** Winner baru untuk giveaway **${gw.prize}**: <@${winnerId}>!\n\nSelamat! 🎉 Host akan DM kamu untuk klaim hadiah.`
            })
            .catch(() => {});

        // DM winner baru
        const user = await client.users.fetch(winnerId).catch(() => null);
        if (user) {
            await user
                .send(
                    `🎊 **Selamat! Kamu menang giveaway (reroll)!**\n\nPrize: **${gw.prize}**\nHost: ${gw.hostTag}\nServer: ${guild.name}\n\nHubungi host untuk klaim hadiahmu.`
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
 * Proses scheduled announcement yang sudah waktunya dikirim.
 * v3.9.0 FIX: kalau channel target sudah tidak ada (dihapus admin), REMOVE entry
 *   instead of markSent. Sebelumnya, markSent pada recurring announcement akan
 *   membuat entry baru untuk next cycle → next cycle juga gagal karena channel
 *   tetap tidak ada → bikin entry baru lagi → unbounded ghost entries yang
 *   menumpuk dan ngabisin disk + scheduler time.
 */
async function processScheduledAnnouncement(client, ann) {
    // v3.9.8 FIX: TOCTOU guard. Sebelumnya, kalau processScheduledAnnouncement
    // throw setelah kirim pesan tapi sebelum markSent, tick berikutnya kirim
    // announcement yang sama → duplicate ping. Guard ini skip duplikat paralel.
    if (processingAnns.has(ann.id)) {
        console.log(`⏭️ processScheduledAnnouncement ${ann.id} di-skip (masih diproses tick sebelumnya).`);
        return;
    }
    processingAnns.add(ann.id);
    try {
        const guild = await client.guilds.fetch(ann.guildId).catch(() => null);
        if (!guild) {
            // Guild hilang (bot di-kick) → hapus entry supaya tidak ghost loop.
            console.warn(`⚠️ Scheduled announce ${ann.id}: guild ${ann.guildId} tidak ditemukan, hapus entry.`);
            removeAnn(ann.id);
            return;
        }

        const channel = guild.channels.cache.get(ann.channelId);
        if (!channel) {
            // v3.9.0 FIX: channel sudah dihapus → REMOVE entry, jangan markSent
            // (karena markSent untuk recurring akan bikin entry baru yang juga gagal).
            console.warn(
                `⚠️ Scheduled announce ${ann.id}: channel ${ann.channelId} tidak ditemukan di guild ${guild.name}, hapus entry.`
            );
            removeAnn(ann.id);
            return;
        }

        const d = ann.data;
        const embed = new EmbedBuilder()
            .setTitle(d.title)
            .setDescription(d.description.replace(/\\n/g, '\n'))
            .setColor(d.color || 0x5865f2)
            .setFooter({ text: `Dijadwalkan oleh ${d.authorTag}` })
            .setTimestamp();
        if (d.image) embed.setImage(d.image);
        if (d.thumbnail) embed.setThumbnail(d.thumbnail);

        // v3.9.8 FIX: markSent DULU sebelum kirim, supaya kalau send throw,
        // tick berikutnya tidak kirim ulang (yang bakal duplicate ping).
        // Trade-off: kalau send gagal total, announcement dianggap "terkirim"
        // padahal belum. Tapi ini lebih baik daripada duplicate ping.
        markAnnSent(ann.id);

        await channel
            .send({
                content: d.mention || null,
                embeds: [embed]
            })
            .catch(err => console.warn('Gagal kirim scheduled ann:', err.message));

        console.log(`📢 Scheduled announce ${ann.id} terkirim ke ${channel.name}.`);
    } catch (err) {
        console.error('Error processScheduledAnnouncement:', err);
    } finally {
        // v3.9.8: pastikan processing lock dilepas walau ada error / return.
        processingAnns.delete(ann.id);
    }
}

/**
 * v3.9.26 (GC): prune data lama yang tumbuh tanpa batas.
 * - Giveaway ended > 30 hari → dihapus dari giveaways.json
 * - Poll closed > 30 hari → dihapus dari polls.json
 * - Scheduled announcement terkirim > 30 hari → dihapus (recurring tetap
 *   jalan — entry BARU untuk cycle berikutnya tidak pernah `sent`)
 * Data aktif TIDAK PERNAH di-touch. Dijalankan sekali/hari oleh scheduler
 * (guard lastDataPruneDay supaya tidak jalan tiap tick 60 detik).
 */
const PRUNE_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari
let lastDataPruneDay = 0;

function pruneStaleData() {
    const today = Math.floor(Date.now() / 86400000);
    if (today === lastDataPruneDay) return; // sudah jalan hari ini
    lastDataPruneDay = today;

    try {
        const gwRemoved = pruneOldGiveaways(PRUNE_OLDER_THAN_MS);
        if (gwRemoved > 0) console.log(`🧹 GC: ${gwRemoved} giveaway ended >30h dihapus.`);
    } catch (err) {
        console.warn('⚠️ GC giveaway error:', err.message);
    }
    try {
        const pollRemoved = pruneOldPolls(PRUNE_OLDER_THAN_MS);
        if (pollRemoved > 0) console.log(`🧹 GC: ${pollRemoved} poll closed >30h dihapus.`);
    } catch (err) {
        console.warn('⚠️ GC poll error:', err.message);
    }
    try {
        const annRemoved = pruneOldAnns(PRUNE_OLDER_THAN_MS);
        if (annRemoved > 0) console.log(`🧹 GC: ${annRemoved} scheduled announcement terkirim >30h dihapus.`);
    } catch (err) {
        console.warn('⚠️ GC announcement error:', err.message);
    }
    // v3.9.38 FIX: GC entry AFK lama — afk.json sebelumnya TIDAK PERNAH di-GC
    // (user yang leave guild tetap AFK selamanya, file tumbuh tanpa batas).
    try {
        const afkRemoved = pruneOldAFK(PRUNE_OLDER_THAN_MS);
        if (afkRemoved > 0) console.log(`🧹 GC: ${afkRemoved} AFK entry >30h dihapus.`);
    } catch (err) {
        console.warn('⚠️ GC afk error:', err.message);
    }
}

/**
 * v3.9.37: reconcile deal rekber zombie — deal yang channel-nya sudah tidak ada
 * (dihapus manual dari UI Discord oleh admin / channel hilang).
 * v3.9.38 FIX: SEMUA deal di-inspect (aktif + terminal) — deal terminal yang
 * gagal hapus channel saat finalize juga dibersihkan.
 *
 * Tanpa reconcile, user yang terlibat deal zombie TERKUNCI SELAMANYA:
 *   - tidak bisa buka tiket reguler (hasActiveDealFor → tolak di createTicket),
 *   - tidak bisa dipilih jadi pembeli/penjual deal baru (validasi pick flow),
 *   - /midman-deals menampilkan link channel mati.
 * Tiket punya self-healing serupa (findActiveTicketFor) — mulai v3.9.37 deal
 * juga. Cleanup pakai removeDeal (pola finalizeDeal): riwayat deal terminal
 * memang tidak disimpan jangka panjang.
 *
 * Dipanggil: (a) sekali saat startup (ready.js), (b) harian oleh scheduler
 * tick via wrapper reconcileZombieDealsDaily (guard hari — mirror pruneStaleData).
 *
 * @param {Client} client - Discord client (guilds cache)
 * @returns {Promise<number>} jumlah zombie deal yang dibersihkan
 */
async function reconcileZombieDeals(client) {
    let removed = 0;
    for (const [gid, guild] of client.guilds.cache) {
        let deals;
        try {
            // v3.9.38 FIX: iterasi SEMUA deal guild ini (aktif + terminal).
            // Sebelumnya hanya deal non-terminal (getActiveDealsByGuild) →
            // deal terminal (COMPLETED/CANCELLED/REFUNDED) yang gagal hapus
            // channel-nya saat finalize (error ≠ 10003) TIDAK PERNAH
            // dibersihkan → meta menumpuk di deals.json selamanya.
            // loadDeals = full map (key channelId) — filter guild lokal di sini.
            deals = Object.values(loadAllDeals()).filter(d => d && d.guildId === gid);
        } catch (err) {
            console.warn(`⚠️ Reconcile deal: gagal load deals guild ${gid}:`, err.message);
            continue;
        }
        for (const deal of deals) {
            if (!deal.channelId) continue;
            try {
                // Cache dulu, fetch API kalau cache miss (pola findActiveTicketFor).
                let ch = guild.channels.cache.get(deal.channelId);
                if (!ch) {
                    try {
                        ch = await guild.channels.fetch(deal.channelId);
                    } catch (fetchErr) {
                        // 10003 = Unknown Channel → channel benar-benar dihapus.
                        // Error lain (5xx / network / rate-limit) = TRANSIENT —
                        // jangan hapus deal aktif cuma karena blip sesaat;
                        // biarkan entry, retry tick berikutnya.
                        if (fetchErr?.code !== 10003) continue;
                        ch = null;
                    }
                }
                if (!ch) {
                    removeDealMeta(deal.channelId);
                    removed++;
                    console.log(
                        `🧹 Reconcile deal: channel ${deal.channelId} (guild ${gid}, state ${deal.state}) sudah tidak ada — meta deal dihapus.`
                    );
                }
            } catch (_) {
                // Defensive — error tak terduga per-deal tidak boleh abort loop.
            }
        }
    }
    return removed;
}

let lastDealReconcileDay = 0;

/**
 * Wrapper harian untuk scheduler tick — reconcileZombieDeals max 1x/hari
 * (guard hari, mirror pruneStaleData; startup ready.js memanggil versi
 * non-guard langsung supaya fresh-check setelah restart).
 */
async function reconcileZombieDealsDaily(client) {
    const today = Math.floor(Date.now() / 86400000);
    if (today === lastDealReconcileDay) return;
    lastDealReconcileDay = today;
    await reconcileZombieDeals(client);
}

/**
 * Attach semua function ke client supaya commandHandler bisa akses.
 * Dipanggil sekali saat bot ready.
 */
function attachToClient(client) {
    client.processGiveawayEnd = processGiveawayEnd;
    client.announceRerollWinner = announceRerollWinner;
    // v3.9.38 FIX: dipakai /giveaway end untuk cek scheduler in-flight (anti dobel end).
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
