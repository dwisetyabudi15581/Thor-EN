/**
 * Unit tests v3.9.31 — hardening from the code review.
 *
 * Bugs being tested:
 *   1. closeTicket: removeTicketMeta KEPT RUNNING even when channel.delete()
 *      fails with non-10003 (Missing Permissions) → live channel without meta
 *      → the next close falls back to topic-parsing, losing isCompleted/
 *      isInvoiceSent → duplicate invoices. (ticketManager.js)
 *   2. ticket_close / ticket_set_key: `interaction.channel.id` without a
 *      guard → TypeError if the channel was deleted right before the click.
 *      (interactions/ticket.js)
 *   3. clear-schedule: the roleId snapshot is taken BEFORE removal + via the
 *      roleScheduler API (not fs directly, not other users' entries).
 *   4. getActiveKeysByUserAndRole: optional guildId filter (pattern consistency).
 *   5. getTopUsers: userId always resolved even for entries without userId.
 *   6. _shared: createContext dead code removed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: production data files are snapshotted & restored ===
// === (keyManager.test.js / ticketNonKey.test.js pattern)      ===
// ====================================================
const SANDBOX_FILES = ['tickets.json', 'config.json', 'stats.json', 'scheduledRoles.json', 'keys.json'];
const backups = [];
for (const f of SANDBOX_FILES) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) {
        const b = p + '.v31-backup';
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
    // Files that did NOT exist before the test → remove test output.
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

// ====================================================
// === 1. closeTicket — orphan meta guard (v3.9.31) ===
// ====================================================

const { closeTicket, setTicketMeta, getTicketMeta } = require('../../src/data/ticketManager');

function seedTicket(channelId) {
    resetDataFile('tickets.json', {});
    // Minimal config → no channels.transcript/invoice (skip the transcript & invoice path).
    resetDataFile('config.json', {});
    setTicketMeta(channelId, {
        userId: 'u_v31',
        productName: 'VIP 30 Hari',
        price: 'Rp 30.000',
        guildId: 'g_v31',
        category: 'transaction',
        requiresKey: true,
        isTransaction: true
    });
}

function makeMockChannel({ id, deleteImpl }) {
    return { id, topic: '', delete: deleteImpl };
}

test('v3.9.31 FIX: closeTicket — delete fails non-10003 → meta NOT deleted', async () => {
    seedTicket('chan_v31_fail');
    const err = new Error('Missing Permissions');
    err.code = 50001; // not 10003 → the channel is considered STILL ALIVE
    const ch = makeMockChannel({
        id: 'chan_v31_fail',
        deleteImpl: async () => {
            throw err;
        }
    });
    // isSuccess=false + isCompleted=false → the invoice & transcript paths are skipped.
    await closeTicket(ch, { id: 'admin', tag: 'Admin' }, false);
    const meta = getTicketMeta('chan_v31_fail', '');
    assert.ok(meta, 'meta must REMAIN present while the channel is still alive (anti orphan-meta)');
    assert.strictEqual(meta.userId, 'u_v31', 'meta contents intact — not reset to topic-parsing');
});

test('v3.9.31: closeTicket — delete fails with 10003 (Unknown Channel) → meta deleted', async () => {
    seedTicket('chan_v31_gone');
    const err = new Error('Unknown Channel');
    err.code = 10003;
    const ch = makeMockChannel({
        id: 'chan_v31_gone',
        deleteImpl: async () => {
            throw err;
        }
    });
    await closeTicket(ch, { id: 'admin', tag: 'Admin' }, false);
    assert.strictEqual(getTicketMeta('chan_v31_gone', ''), null, 'channel is gone → meta cleaned up');
});

test('v3.9.31: closeTicket — delete succeeds → meta deleted', async () => {
    seedTicket('chan_v31_ok');
    const ch = makeMockChannel({ id: 'chan_v31_ok', deleteImpl: async () => ({}) });
    await closeTicket(ch, { id: 'admin', tag: 'Admin' }, false);
    assert.strictEqual(getTicketMeta('chan_v31_ok', ''), null);
});

test('v3.9.31: closeTicket — self-healing: fails first (permission), then succeeds → meta deleted', async () => {
    seedTicket('chan_v31_heal');
    const err = new Error('Missing Permissions');
    err.code = 50001;

    // Attempt 1: delete fails → meta must survive.
    const chFail = makeMockChannel({
        id: 'chan_v31_heal',
        deleteImpl: async () => {
            throw err;
        }
    });
    await closeTicket(chFail, { id: 'admin', tag: 'Admin' }, false);
    assert.ok(getTicketMeta('chan_v31_heal', ''), 'meta survives after the first failed attempt');

    // Attempt 2 (an admin clicks close again after permissions are fixed): success.
    const chOk = makeMockChannel({ id: 'chan_v31_heal', deleteImpl: async () => ({}) });
    await closeTicket(chOk, { id: 'admin', tag: 'Admin' }, false);
    assert.strictEqual(getTicketMeta('chan_v31_heal', ''), null, 'the second attempt cleans up the meta');
});

// ====================================================
// === 2. Ticket router — null channel guard (v3.9.31) ===
// ====================================================

function makeNullChannelInteraction(customId) {
    const replies = [];
    const interaction = {
        id: `v31-${customId}-${Date.now()}-${Math.random()}`,
        customId,
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        // v3.9.33: the router now also accepts user select menus.
        isUserSelectMenu: () => false,
        isModalSubmit: () => false,
        // Admin so it passes checkIsAdmin → the guard under test is the channel one.
        member: {
            permissions: { has: () => true },
            roles: { cache: new Map() }
        },
        // interaction.channel INTENTIONALLY not defined (channel deleted / partial).
        reply: async opts => {
            replies.push(opts);
            interaction.replied = true;
            return {};
        },
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        _replies: replies
    };
    return interaction;
}

test('v3.9.31 FIX: ticket_close with a null channel → clear message, not a TypeError', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeNullChannelInteraction('ticket_close');
    // Before the fix: TypeError "Cannot read properties of null (reading 'id')"
    // swallowed by the global handler as a generic error.
    await routeInteraction(interaction);
    assert.ok(interaction._replies.length > 0, 'the handler responds with a clear message');
    assert.match(interaction._replies[0].content, /The ticket channel no longer exists/);
});

test('v3.9.31 FIX: ticket_set_key with a null channel → clear message, not a TypeError', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeNullChannelInteraction('ticket_set_key');
    await routeInteraction(interaction);
    assert.ok(interaction._replies.length > 0, 'the handler responds with a clear message');
    assert.match(interaction._replies[0].content, /The ticket channel no longer exists/);
});

// ====================================================
// === 3. clear-schedule — snapshot via the API (v3.9.31) ===
// ====================================================
// The data-layer contract now used by keys.js: snapshot the target user's
// roleIds BEFORE removeAllSchedulesByUser — via the roleScheduler API, not
// fs directly, and it must NOT suck in other users' roleIds.

test('v3.9.31 FIX: snapshot of a user schedule → only the roleIds of that user (not of other users)', () => {
    resetDataFile('scheduledRoles.json', []);
    const {
        scheduleRoleRemoval,
        findAllByUser: findAllSchedules,
        removeAllByUser: removeAllSchedules
    } = require('../../src/data/roleScheduler');

    scheduleRoleRemoval({ userId: 'ua_v31', roleId: 'ra_v31', guildId: 'g1', days: 30 });
    scheduleRoleRemoval({ userId: 'ub_v31', roleId: 'rb_v31', guildId: 'g1', days: 30 }); // ANOTHER user
    scheduleRoleRemoval({ userId: 'ua_v31', roleId: 'ra_other', guildId: 'g2', days: 30 }); // another guild

    // The new keys.js snapshot pattern (BEFORE removal):
    const snap = new Set(
        findAllSchedules('ua_v31')
            .filter(e => e && e.roleId && (!e.guildId || e.guildId === 'g1'))
            .map(e => e.roleId)
    );
    assert.deepStrictEqual(
        [...snap].sort(),
        ['ra_v31'],
        'the snapshot only contains the target user\'s roleIds in this guild — not rb_v31 (another user), not ra_other (another guild)'
    );

    const removed = removeAllSchedules('ua_v31', 'g1');
    assert.strictEqual(removed, 1, 'only this user\'s 1 schedule in this guild is deleted');
    // The other user's + other guild's entries remain intact:
    assert.strictEqual(findAllSchedules('ub_v31').length, 1);
    assert.strictEqual(findAllSchedules('ua_v31').length, 1, 'this user\'s other-guild entry is untouched');
});

// ====================================================
// === 4. keyManager — getActiveKeysByUserAndRole guildId ===
// ====================================================

test('v3.9.31: getActiveKeysByUserAndRole with guildId → filter + legacy backward compat', () => {
    resetDataFile('keys.json', []);
    const { addKey, getActiveKeysByUserAndRole, removeAllKeysByUser } = require('../../src/data/keyManager');

    addKey({ key: 'V31-G1', userId: 'u_v31', roleId: 'r_v31', days: 30, guildId: 'g1' });
    addKey({ key: 'V31-G2', userId: 'u_v31', roleId: 'r_v31', days: 30, guildId: 'g2' });
    addKey({ key: 'V31-LEGACY', userId: 'u_v31', roleId: 'r_v31', days: 30 }); // without guildId (old schema)

    // Without guildId → all keys (old behavior, backward compat):
    assert.strictEqual(getActiveKeysByUserAndRole('u_v31', 'r_v31').length, 3);

    // With guildId='g1' → only g1 + legacy:
    const filtered = getActiveKeysByUserAndRole('u_v31', 'r_v31', Date.now(), 'g1');
    assert.strictEqual(filtered.length, 2, 'the g2 key is excluded; legacy (no guildId) still counted');
    assert.deepStrictEqual(
        filtered.map(k => k.key).sort(),
        ['V31-G1', 'V31-LEGACY']
    );

    removeAllKeysByUser('u_v31', null);
});

// ====================================================
// === 5. statsManager — getTopUsers userId resolved ===
// ====================================================

test('v3.9.31: getTopUsers — userId always resolved (fallback from the composite key)', () => {
    // Written BEFORE the require so the statsManager cache loads this file.
    resetDataFile('stats.json', {
        'gv31:uv31a': { messages: 10 }, // no userId field (old/minimal entry)
        'gv31:uv31b': { messages: 5, userId: 'uv31b' } // with an explicit userId
    });
    const { getTopUsers } = require('../../src/data/statsManager');
    const top = getTopUsers('gv31', 'messages', 10);
    assert.strictEqual(top.length, 2, 'both entries make the leaderboard');
    const a = top.find(e => e.value === 10);
    const b = top.find(e => e.value === 5);
    assert.strictEqual(a.userId, 'uv31a', 'entry without userId → fallback from the key');
    assert.strictEqual(b.userId, 'uv31b', 'entry with userId → used as-is');
    assert.strictEqual(top[0].value, 10, 'descending order');
});

// ====================================================
// === 6. _shared — dead code removed ===
// ====================================================

test('v3.9.31: _shared — createContext (dead code) removed, core exports intact', () => {
    const shared = require('../../src/commands/_shared');
    assert.strictEqual(shared.createContext, undefined, 'createContext is no longer exported');
    assert.strictEqual(typeof shared.safeEditReply, 'function');
    assert.strictEqual(typeof shared.findAllSchedulesByUser, 'function', 'the roleScheduler alias remains available');
    assert.strictEqual(typeof shared.findAllByUser, 'function', 'keyManager findAllByUser remains available');
});
