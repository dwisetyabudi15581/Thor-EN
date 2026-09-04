/**
 * Unit tests v3.9.38 — hardening data layer (audit task 1-c, fix batch 3-c).
 *
 * Yang diuji (8 fix, semuanya bug terverifikasi):
 *   (a) pollManager.vote: toggle multi-choice — unvote opsi yang sudah di-vote
 *       (dulu silent no-op) + single-mode toggle/unvote & pindah opsi.
 *   (b) responderManager: cooldownMs 0 = cooldown MATI (dulu `0 || 3000` → 3000).
 *   (c) levelManager.addXp: cooldownMs 0 = XP tiap pesan (dulu `0 || 60000`);
 *       cooldown 60000 tetap memblok panggilan kedua.
 *   (d) giveawayManager.end: set endedAt (GC pakai waktu end aktual, bukan endsAt).
 *   (e) statsManager.parsePrice: nilai negatif di-clamp ke 0.
 *   (f) afkManager.pruneOldAFK: entry >30 hari dihapus, fresh & legacy tetap;
 *       pruneStaleData (scheduler harian) memanggilnya.
 *   (g) processGiveawayEnd: re-read state FRESH dari disk setelah lock —
 *       snapshot stale vs manual /giveaway end → tidak dobel announce/timpa
 *       winner; jalur manual (skipPick) pakai winnerIds fresh; jalur natural
 *       pick dari participantIds fresh; isGiveawayProcessing observable in-flight.
 *   (h) reconcileZombieDeals: deal TERMINAL dengan channel terhapus juga
 *       dibersihkan (dulu hanya deal non-terminal yang di-inspect).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');
const DAY = 24 * 60 * 60 * 1000;

// ====================================================
// === Sandbox: file data produksi di-snapshot & restore ===
// === (pola hardeningV37.test.js / communityFeatures.test.js) ===
// ====================================================
const SANDBOX_FILES = ['giveaways.json', 'polls.json', 'responders.json', 'levels.json', 'afk.json', 'stats.json', 'deals.json'];
const backups = [];
for (const f of SANDBOX_FILES) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) {
        const b = p + '.v3938-backup';
        fs.copyFileSync(p, b);
        backups.push({ orig: p, backup: b });
    }
}
process.on('exit', () => {
    for (const { orig, backup } of backups) {
        try {
            fs.copyFileSync(backup, orig);
            fs.rmSync(backup, { force: true });
        } catch (_) {}
    }
    for (const f of SANDBOX_FILES) {
        const p = path.join(dataDir, f);
        if (!backups.some(b => b.orig === p) && fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
            } catch (_) {}
        }
    }
});

function resetDataFile(name, content) {
    const p = path.join(dataDir, name);
    if (content === null) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
        fs.writeFileSync(p, JSON.stringify(content, null, 2));
    }
}

const { processGiveawayEnd, isGiveawayProcessing, pruneStaleData, reconcileZombieDeals } = require('../../src/services/schedulerTasks');
const mm = require('../../src/data/midmanManager');

// ====================================================
// === (a) POLL — toggle multi-choice & single-choice ===
// ====================================================

test('pollManager.vote v3.9.38: multi-choice toggle — klik opsi yang sudah di-vote = unvote (dulu no-op)', () => {
    resetDataFile('polls.json', []);
    const pm = require('../../src/data/pollManager');
    const poll = pm.create({
        guildId: 'g_poll_v38',
        channelId: 'c_poll_v38',
        question: 'Pilih?',
        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        multiple: true,
        creatorId: 'creator1',
        creatorTag: 'Creator#0001'
    });

    pm.vote(poll.id, 'user1', 0); // vote A
    pm.vote(poll.id, 'user1', 2); // vote C (multi)
    let p = pm.get(poll.id);
    assert.deepStrictEqual(p.options[0].votes, ['user1']);
    assert.deepStrictEqual(p.options[2].votes, ['user1']);

    // Klik LAGI opsi C → harus unvote (sebelum v3.9.38: silent no-op)
    pm.vote(poll.id, 'user1', 2);
    p = pm.get(poll.id);
    assert.deepStrictEqual(p.options[2].votes, [], 'unvote multi-choice bekerja');
    assert.deepStrictEqual(p.options[0].votes, ['user1'], 'vote di opsi lain tetap');
    assert.strictEqual(pm.getTotalVotes(p), 1, 'total votes menurun setelah unvote');
});

test('pollManager.vote v3.9.38: single-mode — klik ulang opsi sama = unvote, klik opsi lain = pindah', () => {
    resetDataFile('polls.json', []);
    const pm = require('../../src/data/pollManager');
    const poll = pm.create({
        guildId: 'g_poll_v38s',
        channelId: 'c_poll_v38s',
        question: 'Pilih satu?',
        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        multiple: false,
        creatorId: 'creator1',
        creatorTag: 'Creator#0001'
    });

    pm.vote(poll.id, 'user1', 0); // vote A
    pm.vote(poll.id, 'user1', 0); // klik A lagi → unvote
    let p = pm.get(poll.id);
    assert.deepStrictEqual(p.options[0].votes, [], 'klik ulang opsi sama = unvote');

    pm.vote(poll.id, 'user1', 1); // vote B
    pm.vote(poll.id, 'user1', 2); // pindah ke C → B otomatis hilang
    p = pm.get(poll.id);
    assert.deepStrictEqual(p.options[1].votes, [], 'vote lama hilang saat pindah opsi');
    assert.deepStrictEqual(p.options[2].votes, ['user1']);
    assert.strictEqual(pm.getTotalVotes(p), 1);
});

// ====================================================
// === (b) RESPONDER — cooldown 0 = mati ===
// ====================================================

test('responderManager v3.9.38: cooldownMs 0 → tanpa cooldown, dua tembakan langsung dua-duanya lolos', () => {
    const rm = require('../../src/data/responderManager');
    const gid = 'test_guild_resp_v38_' + Date.now();
    const add = rm.addResponder(gid, {
        trigger: '!nocd',
        reply: 'Balasan test',
        replyType: 'text',
        createdBy: 'u',
        createdByTag: 'U',
        cooldownMs: 0
    });
    assert.ok(add.ok);
    assert.strictEqual(add.responder.cooldownMs, 0, 'cooldownMs 0 tersimpan apa adanya (dulu jadi 3000 via `||`)');

    const m1 = rm.findMatch(gid, '!nocd', 'userA');
    assert.ok(m1, 'tembakan pertama match');
    rm.markUsed(gid, m1.id, 'userA');

    // userA yang SAMA, tanpa jeda — harus tetap lolos karena cooldown 0
    // (sebelum v3.9.38: 0||3000 → 3000 → null).
    const m2 = rm.findMatch(gid, '!nocd', 'userA');
    assert.ok(m2, 'cooldown 0 → tembakan kedua LANGSUNG lolos');

    rm.removeResponder(gid, '!nocd');
});

// ====================================================
// === (c) LEVELING — cooldown 0 = XP tiap pesan ===
// ====================================================

test('levelManager.addXp v3.9.38: cooldownMs 0 → dua addXp langsung dua-duanya dapat XP; 60000 → kedua diblok', () => {
    const lm = require('../../src/data/levelManager');
    const gid = 'test_guild_lvl_v38_' + Date.now();

    // cooldown 0: dua panggilan berturutan (tanpa jeda) → total XP dobel
    const r1 = lm.addXp(gid, 'u_nocd', 15, { cooldownMs: 0 });
    const r2 = lm.addXp(gid, 'u_nocd', 15, { cooldownMs: 0 });
    assert.ok(!r1.onCooldown);
    assert.ok(!r2.onCooldown, 'cooldown 0 → panggilan kedua TIDAK diblok (dulu 0||60000 → 60000)');
    assert.strictEqual(lm.getUser(gid, 'u_nocd').totalXp, 30, 'XP terakumulasi tiap pesan');

    // cooldown 60000: panggilan kedua langsung → diblok
    const a1 = lm.addXp(gid, 'u_cd', 15, { cooldownMs: 60000 });
    const a2 = lm.addXp(gid, 'u_cd', 15, { cooldownMs: 60000 });
    assert.ok(!a1.onCooldown);
    assert.ok(a2.onCooldown, 'cooldown 60000 tetap memblok panggilan kedua');
    assert.strictEqual(lm.getUser(gid, 'u_cd').totalXp, 15);
});

// ====================================================
// === (d) GIVEAWAY END — endedAt ===
// ====================================================

test('giveawayManager.end v3.9.38: menyetel endedAt = waktu end aktual (bukan endsAt)', () => {
    resetDataFile('giveaways.json', []);
    const gwm = require('../../src/data/giveawayManager');
    const endsAt = Date.now() + 24 * 60 * 60 * 1000; // masih 1 hari lagi — di-end DINI oleh admin
    const gw = gwm.create({
        guildId: 'g_gw_v38',
        channelId: 'c_gw_v38',
        prize: 'Hadiah Test',
        winnersCount: 1,
        endsAt,
        hostId: 'host1',
        hostTag: 'Host#0001'
    });
    const before = Date.now();
    gwm.end(gw.id, ['winner1']);
    const after = gwm.get(gw.id);
    assert.ok(after.ended);
    assert.ok(
        after.endedAt >= before && after.endedAt <= Date.now(),
        'endedAt = waktu end (dulu tidak pernah diset → GC pakai endsAt yang masih jauh)'
    );
});

// ====================================================
// === (e) PARSE PRICE — clamp negatif ===
// ====================================================

test('statsManager.parsePrice v3.9.38: nilai negatif di-clamp ke 0 (anti totalSpent/revenue minus)', () => {
    const { parsePrice } = require('../../src/data/statsManager');
    assert.strictEqual(parsePrice('-5000'), 0, 'string negatif → 0');
    assert.strictEqual(parsePrice('Rp -25k'), 0, '"Rp -25k" → 0');
    assert.strictEqual(parsePrice(-100), 0, 'number negatif → 0');
    assert.strictEqual(parsePrice(NaN), 0, 'NaN → 0');
    // Perilaku positif tidak berubah
    assert.strictEqual(parsePrice('25k'), 25000);
    assert.strictEqual(parsePrice(25000), 25000);
});

// ====================================================
// === (f) AFK — GC entry lama ===
// ====================================================

test('afkManager.pruneOldAFK v3.9.38: hapus entry >30 hari, keep fresh & legacy tanpa since', () => {
    const am = require('../../src/data/afkManager');
    resetDataFile('afk.json', {
        'g_afk_v38:u_old': { reason: 'sudah lama', since: Date.now() - 40 * DAY, guildId: 'g_afk_v38', userId: 'u_old' },
        'g_afk_v38:u_fresh': { reason: 'baru', since: Date.now() - 1000, guildId: 'g_afk_v38', userId: 'u_fresh' },
        'g_afk_v38:u_legacy': { reason: 'entry lama tanpa since', guildId: 'g_afk_v38', userId: 'u_legacy' }
    });
    am.invalidateCache();
    const removed = am.pruneOldAFK();
    assert.strictEqual(removed, 1, 'cuma entry 40 hari yang kehapus');
    assert.strictEqual(am.getAFK('g_afk_v38', 'u_old'), null, 'entry lama dihapus');
    assert.ok(am.getAFK('g_afk_v38', 'u_fresh'), 'entry fresh tetap');
    assert.ok(am.getAFK('g_afk_v38', 'u_legacy'), 'entry legacy TANPA since di-keep (tidak di-break)');

    // maxAge custom
    resetDataFile('afk.json', {
        'g_afk_v38b:u2h': { reason: '2 jam lalu', since: Date.now() - 2 * 60 * 60 * 1000, guildId: 'g_afk_v38b', userId: 'u2h' }
    });
    am.invalidateCache();
    assert.strictEqual(am.pruneOldAFK(60 * 60 * 1000), 1, 'maxAge 1 jam → entry 2 jam dihapus');
});

// ====================================================
// === (g) PROCESS GIVEAWAY END — re-read fresh state ===
// ====================================================

/** Mock client/guild/channel/user untuk processGiveawayEnd (tanpa Discord). */
function makeGwClientMocks({ announcements, dms, msgFetchSpy } = {}) {
    const channel = {
        id: 'c_gw_v38',
        messages: {
            fetch: async () => {
                if (msgFetchSpy) msgFetchSpy();
                return { edit: async () => {} };
            }
        },
        send: async opts => {
            announcements.push(opts.content);
            return {};
        }
    };
    const guild = {
        id: 'g_gw_v38',
        name: 'Guild Test',
        channels: { cache: new Map([['c_gw_v38', channel]]) }
    };
    return {
        client: {
            guilds: {
                fetch: async () => guild
            },
            users: {
                fetch: async uid => ({ id: uid, send: async o => dms.push(o) })
            }
        }
    };
}

test('processGiveawayEnd v3.9.38: snapshot stale setelah manual end → skip, tidak announce/DM/timpa winner', async () => {
    resetDataFile('giveaways.json', []);
    const gwm = require('../../src/data/giveawayManager');
    const gw = gwm.create({
        guildId: 'g_gw_v38',
        channelId: 'c_gw_v38',
        prize: 'Hadiah Stale',
        winnersCount: 1,
        endsAt: Date.now() - 1000,
        hostId: 'host1',
        hostTag: 'Host#0001'
    });
    gwm.addParticipant(gw.id, 'userA');
    gwm.addParticipant(gw.id, 'userB');

    // Snapshot STALE (ended=false) — persis kondisi getEnding() saat scheduler
    // tick mengambil daftar sebelum manual end menyisipkan diri.
    const stale = JSON.parse(JSON.stringify(gwm.get(gw.id)));

    // Manual /giveaway end duluan: pick + persist winner.
    gwm.end(gw.id, ['userA']);

    let guildFetchCalls = 0;
    const client = {
        guilds: {
            fetch: async () => {
                guildFetchCalls++;
                return null;
            }
        },
        users: { fetch: async () => null }
    };
    await processGiveawayEnd(client, stale);

    assert.strictEqual(guildFetchCalls, 0, 'early-return SEBELUM guild fetch → tidak ada announce/DM dobel');
    const after = gwm.get(gw.id);
    assert.deepStrictEqual(after.winnerIds, ['userA'], 'winnerIds manual TIDAK tertimpa re-pick scheduler');
    assert.ok(after.ended);
});

test('processGiveawayEnd v3.9.38: jalur manual (skipPick) pakai winnerIds FRESH dari disk — announce sekali', async () => {
    resetDataFile('giveaways.json', []);
    const gwm = require('../../src/data/giveawayManager');
    const gw = gwm.create({
        guildId: 'g_gw_v38',
        channelId: 'c_gw_v38',
        prize: 'Hadiah Manual',
        winnersCount: 1,
        endsAt: Date.now() - 1000,
        hostId: 'host1',
        hostTag: 'Host#0001'
    });
    gwm.addParticipant(gw.id, 'userA');
    gwm.addParticipant(gw.id, 'userB');

    const stale = JSON.parse(JSON.stringify(gwm.get(gw.id))); // snapshot pre-end
    // Manual flow: endGiveaway persist winner SEBELUM announce.
    gwm.end(gw.id, ['userB']);

    const announcements = [];
    const dms = [];
    const processingSeen = [];
    const { client } = makeGwClientMocks({
        announcements,
        dms,
        msgFetchSpy: () => processingSeen.push(isGiveawayProcessing(gw.id))
    });

    assert.strictEqual(isGiveawayProcessing(gw.id), false, 'belum diproses');
    await processGiveawayEnd(client, stale, { skipPick: true });

    assert.deepStrictEqual(processingSeen, [true], 'saat in-flight, Set processingGiveaways terisi (dipakai guard /giveaway end)');
    assert.strictEqual(isGiveawayProcessing(gw.id), false, 'lock dilepas setelah selesai');
    assert.strictEqual(announcements.length, 1, 'announce tepat 1x');
    assert.match(announcements[0], /<@userB>/, 'announce menyebut winner dari disk, bukan re-pick');
    assert.strictEqual(dms.length, 1, 'DM winner tepat 1x');
    assert.deepStrictEqual(gwm.get(gw.id).winnerIds, ['userB'], 'tidak ada re-pick/penimpaan');
});

test('processGiveawayEnd v3.9.38: jalur natural end — pick dari participantIds FRESH + mark ended', async () => {
    resetDataFile('giveaways.json', []);
    const gwm = require('../../src/data/giveawayManager');
    const gw = gwm.create({
        guildId: 'g_gw_v38',
        channelId: 'c_gw_v38',
        prize: 'Hadiah Natural',
        winnersCount: 1,
        endsAt: Date.now() - 1000,
        hostId: 'host1',
        hostTag: 'Host#0001'
    });
    gwm.addParticipant(gw.id, 'userA');
    gwm.addParticipant(gw.id, 'userB');

    // Participant join SETELAH snapshot diambil — natural end harus pick dari
    // state FRESH, bukan snapshot (dulu: gw.participantIds stale).
    const stale = JSON.parse(JSON.stringify(gwm.get(gw.id)));
    gwm.addParticipant(gw.id, 'userC');

    const announcements = [];
    const dms = [];
    const { client } = makeGwClientMocks({ announcements, dms });
    await processGiveawayEnd(client, stale);

    const after = gwm.get(gw.id);
    assert.ok(after.ended, 'giveaway di-mark ended');
    assert.ok(after.endedAt, 'endedAt ter-set (v3.9.38)');
    assert.strictEqual(after.winnerIds.length, 1, '1 winner ter-pick');
    assert.ok(
        ['userA', 'userB', 'userC'].includes(after.winnerIds[0]),
        'winner dipick dari participant FRESH (termasuk userC yang join belakangan)'
    );
    assert.strictEqual(announcements.length, 1, 'announce 1x');
    assert.strictEqual(dms.length, 1, 'DM winner 1x');
});

// ====================================================
// === (h) RECONCILE ZOMBIE DEALS — terminal juga dibersihkan ===
// ====================================================

test('reconcileZombieDeals v3.9.38: deal TERMINAL dengan channel terhapus → meta dibersihkan (dulu menumpuk selamanya)', async () => {
    resetDataFile('deals.json', {
        // Terminal + channel hilang (fetch null) → HAPUS (dulu: tidak pernah di-inspect)
        ch_v38_dead: { channelId: 'ch_v38_dead', guildId: 'g_rec_v38', state: 'COMPLETED', buyerId: 'b1', sellerId: 's1' },
        // Terminal + fetch throw 10003 → HAPUS
        ch_v38_10003: { channelId: 'ch_v38_10003', guildId: 'g_rec_v38', state: 'CANCELLED', buyerId: 'b2', sellerId: 's2' },
        // Terminal + channel masih ada (cache hit) → TETAP
        ch_v38_live: { channelId: 'ch_v38_live', guildId: 'g_rec_v38', state: 'REFUNDED', buyerId: 'b3', sellerId: 's3' },
        // Terminal + fetch error transient (non-10003) → TETAP (retry tick berikutnya)
        ch_v38_err: { channelId: 'ch_v38_err', guildId: 'g_rec_v38', state: 'COMPLETED', buyerId: 'b4', sellerId: 's4' },
        // Kontrol non-terminal + channel ada → TETAP (logika lama utuh)
        ch_v38_active: { channelId: 'ch_v38_active', guildId: 'g_rec_v38', state: 'WAITING_PAYMENT', buyerId: 'b5', sellerId: 's5' }
    });
    const guild = {
        id: 'g_rec_v38',
        channels: {
            cache: new Map([
                ['ch_v38_live', { id: 'ch_v38_live' }],
                ['ch_v38_active', { id: 'ch_v38_active' }]
            ]),
            fetch: async id => {
                if (id === 'ch_v38_dead') return null;
                if (id === 'ch_v38_10003') {
                    const e = new Error('Unknown Channel');
                    e.code = 10003;
                    throw e;
                }
                if (id === 'ch_v38_err') throw new Error('transient 500');
                return { id };
            }
        }
    };
    const client = { guilds: { cache: new Map([['g_rec_v38', guild]]) } };

    const removed = await reconcileZombieDeals(client);

    assert.strictEqual(removed, 2, 'deal terminal zombie (null + 10003) dibersihkan');
    assert.strictEqual(mm.getDeal('ch_v38_dead'), null, 'deal COMPLETED zombie dihapus dari deals.json');
    assert.strictEqual(mm.getDeal('ch_v38_10003'), null, 'deal CANCELLED zombie dihapus');
    assert.ok(mm.getDeal('ch_v38_live'), 'deal terminal dengan channel masih ada → tetap');
    assert.ok(mm.getDeal('ch_v38_err'), 'error transient → entry tetap (guard 10003-only preserved)');
    assert.ok(mm.getDeal('ch_v38_active'), 'deal aktif tidak di-touch');
    assert.strictEqual(mm.hasActiveDealFor('g_rec_v38', 'b5'), true, 'buyer deal aktif tetap terkunci (benar)');
});

// ====================================================
// === (f-2) pruneStaleData — scheduler harian GC AFK ===
// ====================================================
// Ditaruh PALING AKHIR: guard harian module-level (lastDataPruneDay) membuat
// hanya panggilan PERTAMA pruneStaleData di proses ini yang efektif.

test('pruneStaleData v3.9.38: GC entry AFK lama jalan lewat scheduler harian', () => {
    const am = require('../../src/data/afkManager');
    resetDataFile('afk.json', {
        'g_prune_v38:u_old': { reason: 'sudah pergi', since: Date.now() - 40 * DAY, guildId: 'g_prune_v38', userId: 'u_old' },
        'g_prune_v38:u_new': { reason: 'baru saja', since: Date.now(), guildId: 'g_prune_v38', userId: 'u_new' }
    });
    am.invalidateCache();

    pruneStaleData();

    am.invalidateCache();
    assert.strictEqual(am.getAFK('g_prune_v38', 'u_old'), null, 'entry AFK >30 hari dihapus oleh scheduler GC');
    assert.ok(am.getAFK('g_prune_v38', 'u_new'), 'entry AFK fresh tetap ada');
});
