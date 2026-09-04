/**
 * Unit tests v3.9.38 — midman/escrow domain hardening (task 3-a).
 *
 * Bugs being tested (all v3.9.38 fixes in src/interactions/midman.js +
 * src/data/midmanManager.js):
 *   1. FIX 3 — parsePriceNumber: "1.5m" no longer becomes 15,000,000 (the
 *      decimal read as an extra digit = price 10x off). With a k/m suffix,
 *      a leftover `.`/`,` = invalid. Without a suffix, `.`/`,` are only
 *      allowed as thousand separators with a consistent separator type.
 *   2. FIX 1 — handlePickMember/handleRemovePick now also follow
 *      transitionLocks (the same per-deal lock as handleEvent): while the
 *      lock is held, the click is rejected as "being processed" WITHOUT
 *      touching channel permissions.
 *   3. FIX 1 — fresh re-read: a validated state transition (fundin) saved
 *      EXACTLY during the permissionOverwrites await is NOT reverted by a
 *      stale observer write (state + history stay intact).
 *   4. FIX 2 — anti double-submit: the pending session is deleted BEFORE the
 *      channel create await → a second seller-dropdown submit is rejected as
 *      "expired" → only ONE deal is formed.
 *   5. FIX 2 — re-check "active deal" right before setDeal: another deal
 *      committed in the middle of the create await → the new channel is
 *      cleaned up & the TOCTOU deal is not saved.
 *   6. FIX 5 — a third-party creator is recorded as the deal's first observer
 *      (previously they only got channel access, and could not be removed via
 *      the ➖ button).
 *   7. FIX 4 — handleEvent deferReply at the start; confirmations/guards via
 *      editReply (safeEditReply), not interaction.reply after several awaits
 *      (Discord's 3-second ack window).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');

const dataDir = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: production data files are snapshotted & restored ===
// === (hardeningV37.test.js / midman.test.js pattern)         ===
// ====================================================
const SANDBOX_FILES = ['deals.json', 'config.json', 'tickets.json'];
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

const mm = require('../../src/data/midmanManager');
const midmanDomain = require('../../src/interactions/midman');

// ====================================================
// === 1. FIX 3 — parsePriceNumber ===
// ====================================================

test('parsePriceNumber v3.9.38: decimal + k/m suffix → invalid (0), not a 10x price', () => {
    // Old bug: "1.5m" → "15" × 1e6 = 15,000,000 (price inflated 10x).
    assert.strictEqual(mm.parsePriceNumber('1.5m'), 0);
    assert.strictEqual(mm.parsePriceNumber('0.5k'), 0);
    assert.strictEqual(mm.parsePriceNumber('2.5k'), 0);
    assert.strictEqual(mm.parsePriceNumber('1,5m'), 0);
    assert.strictEqual(mm.parsePriceNumber('0.5M'), 0);
});

test('parsePriceNumber v3.9.38: without a suffix, separators must be consistent thousand separators', () => {
    assert.strictEqual(mm.parsePriceNumber('2.5'), 0); // decimal, not a thousands group
    assert.strictEqual(mm.parsePriceNumber('1,5'), 0);
    assert.strictEqual(mm.parsePriceNumber('100.00'), 0); // 2-digit group — not thousands
    assert.strictEqual(mm.parsePriceNumber('1.000,000'), 0); // mixing two separator types
    assert.strictEqual(mm.parsePriceNumber('100000.'), 0); // trailing separator
});

test('parsePriceNumber v3.9.38 (regression): valid formats still parse correctly', () => {
    assert.strictEqual(mm.parsePriceNumber('500000'), 500000);
    assert.strictEqual(mm.parsePriceNumber('500k'), 500000);
    assert.strictEqual(mm.parsePriceNumber('1m'), 1000000);
    assert.strictEqual(mm.parsePriceNumber('1.000.000'), 1000000);
    assert.strictEqual(mm.parsePriceNumber('1,000,000'), 1000000);
    assert.strictEqual(mm.parsePriceNumber('100.000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('100,000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('Rp100.000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('rp 100000'), 100000);
    assert.strictEqual(mm.parsePriceNumber(50000), 50000);
    assert.strictEqual(mm.parsePriceNumber('abc'), 0);
    assert.strictEqual(mm.parsePriceNumber('0'), 0);
});

// ====================================================
// === 2. Mock infrastructure (hardeningV37 pattern) ===
// ====================================================

/** Fake Collection (Map + find — mirrors the discord.js Collection API). */
class FakeCollection extends Map {
    find(pred) {
        for (const v of this.values()) if (pred(v)) return v;
        return undefined;
    }
}

/**
 * Interaction mock — all reply/edit/defer calls are recorded into separate
 * arrays so the FIX 4 test can distinguish a new reply vs an edit of the
 * deferred reply.
 * Default actor: user 'mid-1' with the midman role 'rm' (not a Discord admin).
 */
function makeInteraction({ type, customId, values, fields, channel, guild, userId, userTag }) {
    const replies = [];
    const edits = [];
    const defers = [];
    return {
        id: `v38-${customId}-${Date.now()}-${Math.random()}`,
        customId,
        values,
        fields,
        channel,
        guild,
        client: { user: { id: 'bot1' } },
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => type === 'button',
        isStringSelectMenu: () => type === 'select',
        isUserSelectMenu: () => type === 'userselect',
        isModalSubmit: () => type === 'modal',
        user: { id: userId || 'mid-1', tag: userTag || 'Midman#0001' },
        member: {
            permissions: { has: () => false },
            roles: { cache: new Map([['rm', { id: 'rm' }]]) }
        },
        deferReply: async opts => {
            defers.push(opts);
            return {};
        },
        reply: async opts => {
            replies.push(opts);
            return {};
        },
        editReply: async opts => {
            edits.push(opts);
            return {};
        },
        _replies: replies,
        _edits: edits,
        _defers: defers
    };
}

/** Deal channel mock — records how many times permission & send are touched. */
function makeDealChannel({ id, onPermEdit, onPermDelete }) {
    const sent = [];
    return {
        id,
        toString: () => `<#${id}>`,
        permissionOverwrites: {
            edit: async (...args) => {
                if (onPermEdit) await onPermEdit(...args);
            },
            delete: async (...args) => {
                if (onPermDelete) await onPermDelete(...args);
            }
        },
        send: async opts => {
            sent.push(opts);
            return { id: `msg-${id}` };
        },
        _sent: sent
    };
}

/** Guild mock — members (buyer1/seller1/witness1) + escrow category + create. */
function makeV38Guild({ guildId, createImpl }) {
    const members = new FakeCollection();
    members.set('buyer1', { id: 'buyer1', user: { id: 'buyer1', bot: false } });
    members.set('seller1', { id: 'seller1', user: { id: 'seller1', bot: false } });
    members.set('witness1', { id: 'witness1', user: { id: 'witness1', bot: false } });
    const channels = new FakeCollection();
    // The escrow category "already exists" → skip category creation.
    channels.set('cat_rec', { id: 'cat_rec', name: '🤝 ESCROW', type: 4 });
    return {
        id: guildId,
        roles: { everyone: { id: 'everyone1' } },
        client: { user: { id: 'bot1' } },
        members: { cache: members },
        channels: {
            cache: channels,
            create: createImpl || (async () => {
                throw new Error('channels.create must not be called in this test');
            })
        }
    };
}

/** Seed one WAITING_PAYMENT deal into deals.json. */
function seedDeal(channelId, overrides = {}) {
    const deal = {
        channelId,
        guildId: 'g_v38',
        buyerId: 'buyer1',
        sellerId: 'seller1',
        buyerAgreed: true,
        sellerAgreed: true,
        observers: [],
        item: 'Akun ML Mythic',
        priceNum: 100000,
        fee: 5000,
        feeMode: 'percent',
        feeValue: 5,
        state: 'WAITING_PAYMENT',
        boardMessageId: null, // null → refreshBoard no-op (skip mock board edit)
        createdBy: 'creator1',
        history: [],
        ...overrides
    };
    resetDataFile('deals.json', { [channelId]: deal });
    return deal;
}

function seedConfig() {
    resetDataFile('config.json', { roles: { admin: 'ra', midman: 'rm' }, channels: {} });
}

// ====================================================
// === 3. FIX 1 — per-deal lock for observer management ===
// ====================================================

test('v3.9.38 FIX 1: mm_pick_member while transitionLocks is held → rejected without touching permissions', async () => {
    seedConfig();
    seedDeal('ch_v38_lock', {});
    mm.transitionLocks.add('ch_v38_lock'); // handleEvent is processing a transition
    try {
        let permEdits = 0;
        const dealChannel = makeDealChannel({
            id: 'ch_v38_lock',
            onPermEdit: () => {
                permEdits++;
            }
        });
        const guild = makeV38Guild({ guildId: 'g_v38' });
        const interaction = makeInteraction({
            type: 'userselect',
            customId: 'mm_pick_member',
            values: ['witness1'],
            channel: dealChannel,
            guild
        });
        await midmanDomain(interaction);

        const last = interaction._edits[interaction._edits.length - 1];
        assert.ok(last, 'there must be a reply');
        assert.match(last.content, /being processed/i);
        assert.strictEqual(permEdits, 0, 'permissionOverwrites.edit must NOT be called while the lock is held');
        assert.deepStrictEqual(mm.getDeal('ch_v38_lock').observers, [], 'observers unchanged');
    } finally {
        mm.transitionLocks.delete('ch_v38_lock');
    }
});

test('v3.9.38 FIX 1: mm_remove_pick while transitionLocks is held → rejected without touching permissions', async () => {
    seedConfig();
    seedDeal('ch_v38_lock2', { observers: ['witness1'] });
    mm.transitionLocks.add('ch_v38_lock2');
    try {
        let permDeletes = 0;
        const dealChannel = makeDealChannel({
            id: 'ch_v38_lock2',
            onPermDelete: () => {
                permDeletes++;
            }
        });
        const guild = makeV38Guild({ guildId: 'g_v38' });
        const interaction = makeInteraction({
            type: 'select',
            customId: 'mm_remove_pick',
            values: ['witness1'],
            channel: dealChannel,
            guild
        });
        await midmanDomain(interaction);

        const last = interaction._edits[interaction._edits.length - 1];
        assert.ok(last, 'there must be a reply');
        assert.match(last.content, /being processed/i);
        assert.strictEqual(permDeletes, 0, 'permissionOverwrites.delete must NOT be called while the lock is held');
        assert.deepStrictEqual(mm.getDeal('ch_v38_lock2').observers, ['witness1'], 'observers unchanged');
    } finally {
        mm.transitionLocks.delete('ch_v38_lock2');
    }
});

// ====================================================
// === 4. FIX 1 — fresh re-read (transition not reverted) ===
// ====================================================

test('v3.9.38 FIX 1: mm_pick_member — a fundin transition during the permission await is NOT reverted (fresh re-read)', async () => {
    seedConfig();
    seedDeal('ch_v38_race', {});
    let permEdits = 0;
    const dealChannel = makeDealChannel({
        id: 'ch_v38_race',
        // "Slow" permission grant — during the await, another (simulated)
        // handleEvent saves a validated fundin transition to deals.json.
        onPermEdit: async () => {
            permEdits++;
            await new Promise(r => setTimeout(r, 10));
            const concurrent = mm.getDeal('ch_v38_race');
            mm.recordTransition(concurrent, 'fundin', { id: 'mid-2', tag: 'Midman#2' });
            mm.setDeal('ch_v38_race', concurrent);
        }
    });
    const guild = makeV38Guild({ guildId: 'g_v38' });
    const interaction = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_member',
        values: ['witness1'],
        channel: dealChannel,
        guild
    });
    await midmanDomain(interaction);

    const after = mm.getDeal('ch_v38_race');
    // Before the fix: a stale write overwrote fundin → state rolled back to WAITING_PAYMENT.
    assert.strictEqual(after.state, 'WAITING_DELIVERY', 'fundin stays intact (not reverted by a stale write)');
    assert.ok(after.observers.includes('witness1'), 'the observer is still added on the fresh object');
    assert.strictEqual(after.history.filter(h => h.event === 'fundin').length, 1, 'the fundin history is not lost');
    assert.ok(after.history.some(h => /Member added/.test(h.event)), 'member-add history recorded');
    assert.strictEqual(permEdits, 1);
    assert.strictEqual(mm.transitionLocks.has('ch_v38_race'), false, 'lock released when done');
});

test('v3.9.38 FIX 1: mm_remove_pick — a fundin transition during the permission await is NOT reverted (fresh re-read)', async () => {
    seedConfig();
    seedDeal('ch_v38_rm', { observers: ['witness1'] });
    const dealChannel = makeDealChannel({
        id: 'ch_v38_rm',
        onPermDelete: async () => {
            await new Promise(r => setTimeout(r, 10));
            const concurrent = mm.getDeal('ch_v38_rm');
            mm.recordTransition(concurrent, 'fundin', { id: 'mid-2', tag: 'Midman#2' });
            mm.setDeal('ch_v38_rm', concurrent);
        }
    });
    const guild = makeV38Guild({ guildId: 'g_v38' });
    const interaction = makeInteraction({
        type: 'select',
        customId: 'mm_remove_pick',
        values: ['witness1'],
        channel: dealChannel,
        guild
    });
    await midmanDomain(interaction);

    const after = mm.getDeal('ch_v38_rm');
    assert.strictEqual(after.state, 'WAITING_DELIVERY', 'fundin stays intact (not reverted by a stale write)');
    assert.deepStrictEqual(after.observers, [], 'the observer is removed from the fresh object');
    assert.strictEqual(after.history.filter(h => h.event === 'fundin').length, 1, 'the fundin history is not lost');
    assert.ok(after.history.some(h => /Member removed/.test(h.event)), 'member-remove history recorded');
    assert.strictEqual(mm.transitionLocks.has('ch_v38_rm'), false, 'lock released when done');
});

// ====================================================
// === 5. FIX 2 — creation TOCTOU / double-submit ===
// ====================================================

test('v3.9.38 FIX 2: mm_pick_seller double-submit while create is still running → the second submit is rejected, only 1 deal', async () => {
    seedConfig();
    resetDataFile('deals.json', {});
    resetDataFile('tickets.json', {});

    // "Slow" (network) channels.create — the gate is controlled manually from the test.
    let resolveCreate;
    const createGate = new Promise(res => {
        resolveCreate = res;
    });
    const guild = makeV38Guild({
        guildId: 'g_v38c',
        createImpl: async () => {
            await createGate;
            return {
                id: 'ch_new_deal_c',
                toString: () => '<#ch_new_deal_c>',
                send: async () => ({ id: 'msg_board' }),
                delete: async () => {}
            };
        }
    });

    // Steps 1-2: item+price modal, then pick the buyer.
    const i1 = makeInteraction({
        type: 'modal',
        customId: 'modal_mm_create',
        fields: { getTextInputValue: id => (id === 'mm_field_item' ? 'Akun ML Mythic' : '100000') },
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i1);
    const i2 = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_buyer',
        values: ['buyer1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i2);

    // First step 3 — runs until it suspends at the await channels.create.
    const i3a = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_seller',
        values: ['seller1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    const p1 = midmanDomain(i3a);
    await new Promise(r => setImmediate(r)); // let i3a pass validation + delete the pending session

    // Second submit (dropdown double-click) while create is still running.
    const i3b = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_seller',
        values: ['seller1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i3b);
    const lastB = i3b._edits[i3b._edits.length - 1];
    assert.ok(lastB, 'the second submit must be answered');
    assert.match(lastB.content, /expired/i, 'the pending session was deleted before the await → rejected as expired');

    // Complete the first create.
    resolveCreate();
    await p1;

    const all = mm.loadDeals();
    assert.strictEqual(Object.keys(all).length, 1, 'only ONE deal is formed (no duplicate)');
    assert.ok(all['ch_new_deal_c'], 'the first deal is saved');
    const lastA = i3a._edits[i3a._edits.length - 1];
    assert.match(lastA.content, /Escrow deal created/, 'the first submit succeeds normally');
});

test('v3.9.38 FIX 2: another deal committed in the middle of the create await → the channel is cleaned up & the TOCTOU deal is not saved', async () => {
    seedConfig();
    resetDataFile('deals.json', {});
    resetDataFile('tickets.json', {});

    let deleted = false;
    const guild = makeV38Guild({
        guildId: 'g_v38d',
        createImpl: async () => {
            // ANOTHER deal for seller1 is committed while create is still
            // running (a real race of two deal creators for the same seller).
            await new Promise(r => setTimeout(r, 5));
            mm.setDeal('ch_other_v38d', {
                channelId: 'ch_other_v38d',
                guildId: 'g_v38d',
                buyerId: 'buyerX',
                sellerId: 'seller1',
                state: 'WAITING_PAYMENT'
            });
            return {
                id: 'ch_new_deal_d',
                toString: () => '<#ch_new_deal_d>',
                send: async () => ({ id: 'msg_board' }),
                delete: async () => {
                    deleted = true;
                }
            };
        }
    });

    const i1 = makeInteraction({
        type: 'modal',
        customId: 'modal_mm_create',
        fields: { getTextInputValue: id => (id === 'mm_field_item' ? 'Akun ML Mythic' : '100000') },
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i1);
    const i2 = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_buyer',
        values: ['buyer1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i2);
    const i3 = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_seller',
        values: ['seller1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i3);

    assert.strictEqual(deleted, true, 'the newly created channel is cleaned up (best-effort delete)');
    assert.strictEqual(mm.getDeal('ch_new_deal_d'), null, 'the TOCTOU deal is NOT saved');
    assert.ok(mm.getDeal('ch_other_v38d'), 'the deal that won the race stays intact');
    const last = i3._edits[i3._edits.length - 1];
    assert.match(last.content, /involved in another active deal/, 'a clear apology to the user');
});

// ====================================================
// === 6. FIX 5 — a third-party creator becomes an observer ===
// ====================================================

test('v3.9.38 FIX 5: a third-party creator is recorded as a deal observer (can be removed via the ➖ button)', async () => {
    seedConfig();
    resetDataFile('deals.json', {});
    resetDataFile('tickets.json', {});

    const guild = makeV38Guild({
        guildId: 'g_v38e',
        createImpl: async () => ({
            id: 'ch_new_deal_e',
            toString: () => '<#ch_new_deal_e>',
            send: async () => ({ id: 'msg_board' }),
            delete: async () => {}
        })
    });

    const i1 = makeInteraction({
        type: 'modal',
        customId: 'modal_mm_create',
        fields: { getTextInputValue: id => (id === 'mm_field_item' ? 'Akun ML Mythic' : '100000') },
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i1);
    const i2 = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_buyer',
        values: ['buyer1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i2);
    const i3 = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_seller',
        values: ['seller1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i3);

    const deal = mm.getDeal('ch_new_deal_e');
    assert.ok(deal, 'deal created');
    assert.deepStrictEqual(deal.observers, ['creator1'], 'the third-party creator is in the observer list');
    // The creator can now be removed via the regular observer mechanism.
    assert.strictEqual(mm.removeObserver(deal, 'creator1'), true);
    // The observer slot is not leaked: 1 of MAX_OBSERVERS used → can still add.
    assert.strictEqual(mm.canAddObserver(mm.getDeal('ch_new_deal_e'), 'witness1').ok, true);
});

// ====================================================
// === 7. FIX 4 — handleEvent deferReply + safeEditReply ===
// ====================================================

test('v3.9.38 FIX 4: handleEvent mm_fundin → deferReply at the start, confirmation via editReply (not a new reply)', async () => {
    seedConfig();
    seedDeal('ch_v38_ev', {});
    const dealChannel = makeDealChannel({ id: 'ch_v38_ev' });
    const guild = makeV38Guild({ guildId: 'g_v38' });
    const interaction = makeInteraction({
        type: 'button',
        customId: 'mm_fundin',
        channel: dealChannel,
        guild
    });
    await midmanDomain(interaction);

    assert.strictEqual(interaction._defers.length, 1, 'deferReply called exactly once at the start');
    assert.strictEqual(interaction._defers[0].flags, MessageFlags.Ephemeral, 'defer ephemeral');
    assert.strictEqual(interaction._replies.length, 0, 'no interaction.reply after the defer (3s ack window safe)');
    assert.ok(interaction._edits.length > 0, 'confirmation via editReply of the deferred reply');
    assert.match(interaction._edits[interaction._edits.length - 1].content, /Funds confirmed received/);
    assert.strictEqual(mm.getDeal('ch_v38_ev').state, 'WAITING_DELIVERY', 'the transition is still saved');
    assert.strictEqual(mm.transitionLocks.has('ch_v38_ev'), false, 'lock released when done');
});

test('v3.9.38 FIX 4: handleEvent while the lock is held → rejected via editReply, state & channel untouched', async () => {
    seedConfig();
    seedDeal('ch_v38_ev2', {});
    mm.transitionLocks.add('ch_v38_ev2'); // another transition is being processed
    try {
        const dealChannel = makeDealChannel({ id: 'ch_v38_ev2' });
        const guild = makeV38Guild({ guildId: 'g_v38' });
        const interaction = makeInteraction({
            type: 'button',
            customId: 'mm_fundin',
            channel: dealChannel,
            guild
        });
        await midmanDomain(interaction);

        assert.strictEqual(interaction._defers.length, 1, 'the defer still runs at the start');
        assert.ok(
            interaction._edits.some(e => /being processed/.test(e.content)),
            'the rejection is sent via editReply of the deferred reply'
        );
        assert.strictEqual(mm.getDeal('ch_v38_ev2').state, 'WAITING_PAYMENT', 'state unchanged');
        assert.strictEqual(dealChannel._sent.length, 0, 'no announcement sent');
    } finally {
        mm.transitionLocks.delete('ch_v38_ev2');
    }
});
