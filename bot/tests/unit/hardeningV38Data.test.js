/**
 * Unit tests v3.9.38 — data layer hardening (audit task 1-c, fix batch 3-c).
 *
 * What is tested (8 fixes, all verified bugs):
 *   (a) pollManager.vote: multi-choice toggle — unvoting an already-voted
 *       option (previously a silent no-op) + single-mode toggle/unvote &
 *       switching options.
 *   (b) responderManager: cooldownMs 0 = cooldown OFF (previously `0 || 3000` → 3000).
 *   (c) levelManager.addXp: cooldownMs 0 = XP on every message (previously
 *       `0 || 60000`); a 60000 cooldown still blocks the second call.
 *   (d) giveawayManager.end: sets endedAt (GC uses the actual end time, not endsAt).
 *   (e) statsManager.parsePrice: negative values clamped to 0.
 *   (f) afkManager.pruneOldAFK: entries older than 30 days are deleted, fresh
 *       & legacy ones stay; pruneStaleData (daily scheduler) calls it.
 *   (g) processGiveawayEnd: re-reads FRESH state from disk after the lock —
 *       stale snapshot vs manual /giveaway end → no double announce/overwriting
 *       the winner; the manual path (skipPick) uses fresh winnerIds; the natural
 *       path picks from fresh participantIds; isGiveawayProcessing observable in-flight.
 *   (h) reconcileZombieDeals: TERMINAL deals with a deleted channel are also
 *       cleaned up (previously only non-terminal deals were inspected).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');
const DAY = 24 * 60 * 60 * 1000;

// ====================================================
// === Sandbox: production data files are snapshotted & restored ===
// === (hardeningV37.test.js / communityFeatures.test.js pattern) ===
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
// === (a) POLL — multi-choice & single-choice toggle ===
// ====================================================

test('pollManager.vote v3.9.38: multi-choice toggle — clicking an already-voted option = unvote (previously a no-op)', () => {
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

    // Click option C AGAIN → must unvote (before v3.9.38: silent no-op)
    pm.vote(poll.id, 'user1', 2);
    p = pm.get(poll.id);
    assert.deepStrictEqual(p.options[2].votes, [], 'multi-choice unvote works');
    assert.deepStrictEqual(p.options[0].votes, ['user1'], 'votes on other options remain');
    assert.strictEqual(pm.getTotalVotes(p), 1, 'total votes decreases after unvote');
});

test('pollManager.vote v3.9.38: single-mode — clicking the same option again = unvote, clicking another = switch', () => {
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
    pm.vote(poll.id, 'user1', 0); // click A again → unvote
    let p = pm.get(poll.id);
    assert.deepStrictEqual(p.options[0].votes, [], 'clicking the same option again = unvote');

    pm.vote(poll.id, 'user1', 1); // vote B
    pm.vote(poll.id, 'user1', 2); // switch to C → B is removed automatically
    p = pm.get(poll.id);
    assert.deepStrictEqual(p.options[1].votes, [], 'the old vote is removed when switching options');
    assert.deepStrictEqual(p.options[2].votes, ['user1']);
    assert.strictEqual(pm.getTotalVotes(p), 1);
});

// ====================================================
// === (b) RESPONDER — cooldown 0 = off ===
// ====================================================

test('responderManager v3.9.38: cooldownMs 0 → no cooldown, two immediate triggers both pass', () => {
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
    assert.strictEqual(add.responder.cooldownMs, 0, 'cooldownMs 0 stored as-is (previously became 3000 via `||`)');

    const m1 = rm.findMatch(gid, '!nocd', 'userA');
    assert.ok(m1, 'the first trigger matches');
    rm.markUsed(gid, m1.id, 'userA');

    // The SAME userA, with no pause — must still pass because the cooldown is 0
    // (before v3.9.38: 0||3000 → 3000 → null).
    const m2 = rm.findMatch(gid, '!nocd', 'userA');
    assert.ok(m2, 'cooldown 0 → the second trigger passes IMMEDIATELY');

    rm.removeResponder(gid, '!nocd');
});

// ====================================================
// === (c) LEVELING — cooldown 0 = XP on every message ===
// ====================================================

test('levelManager.addXp v3.9.38: cooldownMs 0 → two immediate addXp calls both earn XP; 60000 → the second blocked', () => {
    const lm = require('../../src/data/levelManager');
    const gid = 'test_guild_lvl_v38_' + Date.now();

    // cooldown 0: two back-to-back calls (no pause) → double total XP
    const r1 = lm.addXp(gid, 'u_nocd', 15, { cooldownMs: 0 });
    const r2 = lm.addXp(gid, 'u_nocd', 15, { cooldownMs: 0 });
    assert.ok(!r1.onCooldown);
    assert.ok(!r2.onCooldown, 'cooldown 0 → the second call is NOT blocked (previously 0||60000 → 60000)');
    assert.strictEqual(lm.getUser(gid, 'u_nocd').totalXp, 30, 'XP accumulates on every message');

    // cooldown 60000: an immediate second call → blocked
    const a1 = lm.addXp(gid, 'u_cd', 15, { cooldownMs: 60000 });
    const a2 = lm.addXp(gid, 'u_cd', 15, { cooldownMs: 60000 });
    assert.ok(!a1.onCooldown);
    assert.ok(a2.onCooldown, 'a 60000 cooldown still blocks the second call');
    assert.strictEqual(lm.getUser(gid, 'u_cd').totalXp, 15);
});

// ====================================================
// === (d) GIVEAWAY END — endedAt ===
// ====================================================

test('giveawayManager.end v3.9.38: sets endedAt = the actual end time (not endsAt)', () => {
    resetDataFile('giveaways.json', []);
    const gwm = require('../../src/data/giveawayManager');
    const endsAt = Date.now() + 24 * 60 * 60 * 1000; // still 1 day away — ended EARLY by an admin
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
        'endedAt = the end time (previously never set → GC used the far-off endsAt)'
    );
});

// ====================================================
// === (e) PARSE PRICE — negative clamp ===
// ====================================================

test('statsManager.parsePrice v3.9.38: negative values clamped to 0 (prevents negative totalSpent/revenue)', () => {
    const { parsePrice } = require('../../src/data/statsManager');
    assert.strictEqual(parsePrice('-5000'), 0, 'negative string → 0');
    assert.strictEqual(parsePrice('Rp -25k'), 0, '"Rp -25k" → 0');
    assert.strictEqual(parsePrice(-100), 0, 'negative number → 0');
    assert.strictEqual(parsePrice(NaN), 0, 'NaN → 0');
    // Positive behavior unchanged
    assert.strictEqual(parsePrice('25k'), 25000);
    assert.strictEqual(parsePrice(25000), 25000);
});

// ====================================================
// === (f) AFK — GC of old entries ===
// ====================================================

test('afkManager.pruneOldAFK v3.9.38: deletes entries >30 days, keeps fresh & legacy without since', () => {
    const am = require('../../src/data/afkManager');
    resetDataFile('afk.json', {
        'g_afk_v38:u_old': { reason: 'sudah lama', since: Date.now() - 40 * DAY, guildId: 'g_afk_v38', userId: 'u_old' },
        'g_afk_v38:u_fresh': { reason: 'baru', since: Date.now() - 1000, guildId: 'g_afk_v38', userId: 'u_fresh' },
        'g_afk_v38:u_legacy': { reason: 'entry lama tanpa since', guildId: 'g_afk_v38', userId: 'u_legacy' }
    });
    am.invalidateCache();
    const removed = am.pruneOldAFK();
    assert.strictEqual(removed, 1, 'only the 40-day-old entry is deleted');
    assert.strictEqual(am.getAFK('g_afk_v38', 'u_old'), null, 'the old entry is deleted');
    assert.ok(am.getAFK('g_afk_v38', 'u_fresh'), 'the fresh entry stays');
    assert.ok(am.getAFK('g_afk_v38', 'u_legacy'), 'the legacy entry WITHOUT since is kept (not broken)');

    // custom maxAge
    resetDataFile('afk.json', {
        'g_afk_v38b:u2h': { reason: '2 jam lalu', since: Date.now() - 2 * 60 * 60 * 1000, guildId: 'g_afk_v38b', userId: 'u2h' }
    });
    am.invalidateCache();
    assert.strictEqual(am.pruneOldAFK(60 * 60 * 1000), 1, 'maxAge 1 hour → the 2-hour-old entry is deleted');
});

// ====================================================
// === (g) PROCESS GIVEAWAY END — fresh state re-read ===
// ====================================================

/** Mock client/guild/channel/user for processGiveawayEnd (no Discord). */
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

test('processGiveawayEnd v3.9.38: stale snapshot after a manual end → skipped, no announce/DM/winner overwrite', async () => {
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

    // STALE snapshot (ended=false) — exactly the state getEnding() has when the
    // scheduler tick took the list before a manual end snuck in.
    const stale = JSON.parse(JSON.stringify(gwm.get(gw.id)));

    // Manual /giveaway end first: pick + persist the winner.
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

    assert.strictEqual(guildFetchCalls, 0, 'early-return BEFORE the guild fetch → no double announce/DM');
    const after = gwm.get(gw.id);
    assert.deepStrictEqual(after.winnerIds, ['userA'], 'the manual winnerIds are NOT overwritten by the scheduler re-pick');
    assert.ok(after.ended);
});

test('processGiveawayEnd v3.9.38: the manual path (skipPick) uses FRESH winnerIds from disk — announced once', async () => {
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

    const stale = JSON.parse(JSON.stringify(gwm.get(gw.id))); // pre-end snapshot
    // Manual flow: endGiveaway persists the winner BEFORE the announce.
    gwm.end(gw.id, ['userB']);

    const announcements = [];
    const dms = [];
    const processingSeen = [];
    const { client } = makeGwClientMocks({
        announcements,
        dms,
        msgFetchSpy: () => processingSeen.push(isGiveawayProcessing(gw.id))
    });

    assert.strictEqual(isGiveawayProcessing(gw.id), false, 'not processing yet');
    await processGiveawayEnd(client, stale, { skipPick: true });

    assert.deepStrictEqual(processingSeen, [true], 'while in-flight, the processingGiveaways Set is populated (used by the /giveaway end guard)');
    assert.strictEqual(isGiveawayProcessing(gw.id), false, 'lock released when done');
    assert.strictEqual(announcements.length, 1, 'announced exactly 1x');
    assert.match(announcements[0], /<@userB>/, 'the announcement names the winner from disk, not a re-pick');
    assert.strictEqual(dms.length, 1, 'winner DM exactly 1x');
    assert.deepStrictEqual(gwm.get(gw.id).winnerIds, ['userB'], 'no re-pick/overwrite');
});

test('processGiveawayEnd v3.9.38: the natural end path — picks from FRESH participantIds + marks ended', async () => {
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

    // A participant joined AFTER the snapshot was taken — the natural end must
    // pick from the FRESH state, not the snapshot (previously: stale gw.participantIds).
    const stale = JSON.parse(JSON.stringify(gwm.get(gw.id)));
    gwm.addParticipant(gw.id, 'userC');

    const announcements = [];
    const dms = [];
    const { client } = makeGwClientMocks({ announcements, dms });
    await processGiveawayEnd(client, stale);

    const after = gwm.get(gw.id);
    assert.ok(after.ended, 'the giveaway is marked ended');
    assert.ok(after.endedAt, 'endedAt is set (v3.9.38)');
    assert.strictEqual(after.winnerIds.length, 1, '1 winner picked');
    assert.ok(
        ['userA', 'userB', 'userC'].includes(after.winnerIds[0]),
        'the winner is picked from the FRESH participants (including userC who joined later)'
    );
    assert.strictEqual(announcements.length, 1, 'announced 1x');
    assert.strictEqual(dms.length, 1, 'winner DM 1x');
});

// ====================================================
// === (h) RECONCILE ZOMBIE DEALS — terminal deals cleaned too ===
// ====================================================

test('reconcileZombieDeals v3.9.38: a TERMINAL deal with a deleted channel → meta cleaned up (previously piled up forever)', async () => {
    resetDataFile('deals.json', {
        // Terminal + channel gone (fetch null) → DELETE (previously: never inspected)
        ch_v38_dead: { channelId: 'ch_v38_dead', guildId: 'g_rec_v38', state: 'COMPLETED', buyerId: 'b1', sellerId: 's1' },
        // Terminal + fetch throws 10003 → DELETE
        ch_v38_10003: { channelId: 'ch_v38_10003', guildId: 'g_rec_v38', state: 'CANCELLED', buyerId: 'b2', sellerId: 's2' },
        // Terminal + channel still exists (cache hit) → KEEP
        ch_v38_live: { channelId: 'ch_v38_live', guildId: 'g_rec_v38', state: 'REFUNDED', buyerId: 'b3', sellerId: 's3' },
        // Terminal + transient fetch error (non-10003) → KEEP (retry next tick)
        ch_v38_err: { channelId: 'ch_v38_err', guildId: 'g_rec_v38', state: 'COMPLETED', buyerId: 'b4', sellerId: 's4' },
        // Non-terminal control + channel exists → KEEP (old logic intact)
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

    assert.strictEqual(removed, 2, 'zombie terminal deals (null + 10003) cleaned up');
    assert.strictEqual(mm.getDeal('ch_v38_dead'), null, 'the zombie COMPLETED deal is deleted from deals.json');
    assert.strictEqual(mm.getDeal('ch_v38_10003'), null, 'the zombie CANCELLED deal is deleted');
    assert.ok(mm.getDeal('ch_v38_live'), 'a terminal deal whose channel still exists → stays');
    assert.ok(mm.getDeal('ch_v38_err'), 'transient error → entry stays (10003-only guard preserved)');
    assert.ok(mm.getDeal('ch_v38_active'), 'the active deal is not touched');
    assert.strictEqual(mm.hasActiveDealFor('g_rec_v38', 'b5'), true, 'the active deal buyer stays locked (correct)');
});

// ====================================================
// === (f-2) pruneStaleData — daily scheduler AFK GC ===
// ====================================================
// Placed LAST: the module-level daily guard (lastDataPruneDay) means only the
// FIRST pruneStaleData call in this process is effective.

test('pruneStaleData v3.9.38: the GC of old AFK entries runs via the daily scheduler', () => {
    const am = require('../../src/data/afkManager');
    resetDataFile('afk.json', {
        'g_prune_v38:u_old': { reason: 'sudah pergi', since: Date.now() - 40 * DAY, guildId: 'g_prune_v38', userId: 'u_old' },
        'g_prune_v38:u_new': { reason: 'baru saja', since: Date.now(), guildId: 'g_prune_v38', userId: 'u_new' }
    });
    am.invalidateCache();

    pruneStaleData();

    am.invalidateCache();
    assert.strictEqual(am.getAFK('g_prune_v38', 'u_old'), null, 'the >30-day AFK entry is deleted by the scheduler GC');
    assert.ok(am.getAFK('g_prune_v38', 'u_new'), 'the fresh AFK entry stays');
});
