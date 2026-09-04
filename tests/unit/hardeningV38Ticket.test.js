/**
 * Unit tests v3.9.38 — ticket domain hardening (Task 3-b).
 *
 * Bugs being tested (all verified by the task 1-b audit):
 *   FIX 1 (HIGH)   : findActiveTicketFor deleted LIVE ticket meta on a
 *                    transient fetch (429/5xx/network) — now only 10003.
 *   FIX 2 (HIGH)   : Set Key flow without an isCompleted gate → invoice +
 *                    stats + key DOUBLED — now 3 layers (button, modal
 *                    re-check, per-channel completionLocks).
 *   FIX 3 (MEDIUM) : ticket meta stored the product LABEL (not value) →
 *                    renaming a product broke the lookup; duplicate labels
 *                    resolved wrongly — meta now stores productValue +
 *                    resolveProduct().
 *   FIX 5 (LOW)    : empty/whitespace keys passed validation and were saved
 *                    by addKey.
 *   FIX 6 (LOW)    : the raw key leaked to the console log via the duplicate
 *                    error message.
 *   FIX 7 (LOW)    : the transcript only archived the last 100 messages —
 *                    payment proof at the START of the ticket was lost
 *                    (paginated now).
 *
 * Sandbox: production data files are snapshotted & restored
 * (ticketNonKey.test.js pattern).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: production data files are snapshotted & restored ===
// ====================================================
const SANDBOX_FILES = ['tickets.json', 'config.json', 'keys.json', 'scheduledRoles.json', 'stats.json', 'deals.json'];
const backups = new Map();
for (const f of SANDBOX_FILES) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) {
        fs.copyFileSync(p, p + '.v3938-backup');
        backups.set(f, true);
    }
}
process.on('exit', () => {
    for (const f of SANDBOX_FILES) {
        const p = path.join(DATA_DIR, f);
        try {
            if (backups.has(f)) {
                fs.copyFileSync(p + '.v3938-backup', p);
                fs.rmSync(p + '.v3938-backup', { force: true });
            } else if (fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
        } catch (_) {}
    }
});

function resetDataFile(name, content) {
    const p = path.join(DATA_DIR, name);
    if (content === null || content === undefined) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
        fs.writeFileSync(p, JSON.stringify(content, null, 2));
    }
}

const { findActiveTicketFor, createTicket, getTicketMeta, setTicketMeta, resolveProduct, saveTranscript } =
    require('../../src/data/ticketManager');

// ====================================================
// === FIX 1: findActiveTicketFor — transient error vs 10003 ===
// ====================================================

function makeFetchGuild({ cachedEntries = [], fetchImpl }) {
    return {
        id: 'g38',
        channels: {
            cache: new Map(cachedEntries),
            fetch: fetchImpl
        }
    };
}

test('FIX 1: fetch throws code 429 (transient) → LIVE ticket meta KEPT, throws TICKET_VERIFY_TRANSIENT', async () => {
    resetDataFile('tickets.json', {
        'ch-tr-429': { userId: 'user-429', guildId: 'g38', productName: 'VIP 30 Hari', productValue: 'vip30' }
    });
    const rateLimitErr = new Error('Too many requests');
    rateLimitErr.code = 429;
    const guild = makeFetchGuild({
        fetchImpl: async () => {
            throw rateLimitErr;
        }
    });

    // v3.9.40: the contract was strengthened — a transient error is NOT "no
    // ticket" (null) but a THROW coded TICKET_VERIFY_TRANSIENT so callers
    // (createTicket, midman pick buyer/seller) can abort & ask for a retry
    // instead of creating a duplicate ticket.
    await assert.rejects(
        findActiveTicketFor(guild, 'user-429'),
        err => err.code === 'TICKET_VERIFY_TRANSIENT',
        'transient blip → must throw TICKET_VERIFY_TRANSIENT (not return null)'
    );
    // Core fix stays: metadata must NOT be deleted — the channel is still alive, only
    // its fetch failed momentarily. Before v3.9.38, the meta was deleted → the
    // user could open a 2nd ticket.
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
    assert.ok(raw['ch-tr-429'], 'live ticket metadata still present (retry on the next attempt)');
});

test('FIX 1: fetch throws code 10003 (Unknown Channel) → zombie meta deleted', async () => {
    resetDataFile('tickets.json', {
        'ch-zombie-10003': { userId: 'user-z', guildId: 'g38', productName: 'VIP 30 Hari' },
        'ch-other': { userId: 'user-lain', guildId: 'g38', productName: 'Lain' }
    });
    const unknownErr = new Error('Unknown Channel');
    unknownErr.code = 10003;
    const guild = makeFetchGuild({
        fetchImpl: async () => {
            throw unknownErr;
        }
    });

    const ch = await findActiveTicketFor(guild, 'user-z');
    assert.strictEqual(ch, null);
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
    assert.ok(!raw['ch-zombie-10003'], 'zombie metadata deleted (the channel is truly gone)');
    assert.ok(raw['ch-other'], 'another user\'s metadata is not deleted too');
});

// ====================================================
// === Common interaction mock (ticketCloseButtons.test.js pattern) ===
// ====================================================

const ADMIN_MEMBER = { permissions: { has: () => true }, roles: { cache: new Map() } };

function makeMockInteraction({ customId, type = 'button', id, channel, guild, components, member }) {
    const replies = [];
    const modals = [];
    const interaction = {
        id: id || `v3938-${customId}-${Date.now()}-${Math.random()}`,
        customId,
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => type === 'button',
        isStringSelectMenu: () => type === 'select',
        isUserSelectMenu: () => false,
        isModalSubmit: () => type === 'modal',
        member: member || ADMIN_MEMBER,
        user: { id: 'admin_v3938', tag: 'Admin#0001' },
        channel,
        guild,
        components: components || [],
        client: { user: { username: 'BotTest', displayAvatarURL: () => 'http://x' } },
        reply: async opts => {
            replies.push({ kind: 'reply', opts });
            interaction.replied = true;
            return {};
        },
        editReply: async opts => {
            replies.push({ kind: 'editReply', opts });
            return {};
        },
        followUp: async opts => {
            replies.push({ kind: 'followUp', opts });
            return {};
        },
        update: async opts => {
            replies.push({ kind: 'update', opts });
            interaction.replied = true;
            return {};
        },
        deferReply: async () => {
            interaction.deferred = true;
            return {};
        },
        deferUpdate: async () => {
            interaction.deferred = true;
            return {};
        },
        showModal: async modal => {
            modals.push(modal);
            return {};
        },
        _replies: replies,
        _modals: modals
    };
    return interaction;
}

function seedKeyTicketConfig() {
    resetDataFile('config.json', {
        roles: { admin: 'role-admin' },
        products: [
            {
                label: 'VIP 30 Hari',
                value: 'vip30',
                price: 'Rp 30.000',
                category: 'transaction',
                requiresKey: true,
                roleId: 'role-vip',
                days: 30
            }
        ]
    });
}

function makeTicketChannel(id) {
    return { id, topic: '', send: async () => ({}) };
}

// ====================================================
// === FIX 2: gate isCompleted + completionLocks ===
// ====================================================

test('FIX 2a: the ticket_set_key button on an isCompleted ticket → modal NOT opened (rejected)', async () => {
    seedKeyTicketConfig();
    resetDataFile('tickets.json', {});
    setTicketMeta('ch-done-1', {
        userId: 'buyer-1',
        productName: 'VIP 30 Hari',
        productValue: 'vip30',
        price: 'Rp 30.000',
        guildId: 'g38',
        category: 'transaction',
        requiresKey: true,
        isTransaction: true,
        isCompleted: true
    });

    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'ticket_set_key',
        channel: makeTicketChannel('ch-done-1')
    });
    await routeInteraction(interaction);

    assert.strictEqual(interaction._modals.length, 0, 'the Set Key modal must not open for a completed ticket');
    assert.ok(interaction._replies.length > 0, 'the admin gets an answer');
    assert.match(interaction._replies[0].opts.content, /already been set/);
});

test('FIX 2b: modal_set_key submit while meta isCompleted → aborted BEFORE side effects (no key/invoice)', async () => {
    seedKeyTicketConfig();
    resetDataFile('tickets.json', {});
    resetDataFile('keys.json', []);
    setTicketMeta('ch-done-2', {
        userId: 'buyer-2',
        productName: 'VIP 30 Hari',
        productValue: 'vip30',
        price: 'Rp 30.000',
        guildId: 'g38',
        category: 'transaction',
        requiresKey: true,
        isTransaction: true,
        isCompleted: true
    });

    let memberFetchCalled = false;
    const guild = {
        id: 'g38',
        roles: { cache: new Map([['role-vip', { id: 'role-vip', name: 'VIP' }]]) },
        members: {
            fetch: async () => {
                memberFetchCalled = true;
                throw new Error('members.fetch must not be called — the abort must happen before side effects');
            }
        }
    };

    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'modal_set_key:vip30',
        type: 'modal',
        channel: makeTicketChannel('ch-done-2'),
        guild,
        components: [{ components: [{ value: 'KEY-DOBEL-XYZ' }] }]
    });
    await routeInteraction(interaction);

    assert.ok(interaction._replies.length > 0, 'the admin gets an answer');
    const msg = interaction._replies[interaction._replies.length - 1].opts.content;
    assert.match(msg, /already been processed by another admin/);
    assert.strictEqual(memberFetchCalled, false, 'the flow stops before the member fetch (no side effects yet)');
    // No key saved — the invoice can't have been sent either (flow aborted).
    assert.strictEqual(require('../../src/data/keyManager').getAllKeys().length, 0, 'keys.json stays empty');
});

test('FIX 2c: channel locked by another admin → the second submit is REJECTED "⏳", the first still completes', async () => {
    seedKeyTicketConfig();
    resetDataFile('tickets.json', {});
    resetDataFile('keys.json', []);
    resetDataFile('scheduledRoles.json', []);
    resetDataFile('stats.json', {});
    setTicketMeta('ch-race-1', {
        userId: 'buyer-race',
        productName: 'VIP 30 Hari',
        productValue: 'vip30',
        price: 'Rp 30.000',
        guildId: 'g38',
        category: 'transaction',
        requiresKey: true,
        isTransaction: true
    });

    // Admin A: guild.members.fetch is suspended (slow-network simulation) —
    // the ch-race-1 lock is held by A until this promise resolves.
    let resolveMemberFetch;
    const memberFetchPromise = new Promise(res => {
        resolveMemberFetch = res;
    });
    const guildA = {
        id: 'g38',
        roles: { cache: new Map([['role-vip', { id: 'role-vip', name: 'VIP' }]]) },
        members: { fetch: () => memberFetchPromise }
    };
    const buyerMember = {
        id: 'buyer-race',
        user: { id: 'buyer-race', tag: 'Buyer#0001', username: 'buyerrace', displayAvatarURL: () => 'http://x' },
        roles: { cache: new Map(), add: async () => ({}) },
        send: async () => ({})
    };

    const routeInteraction = require('../../src/interactions');
    const interactionA = makeMockInteraction({
        customId: 'modal_set_key:vip30',
        type: 'modal',
        id: `v3938-race-A-${Date.now()}`,
        channel: makeTicketChannel('ch-race-1'),
        guild: guildA,
        components: [{ components: [{ value: 'KEY-RACE-1' }] }]
    });
    const promiseA = routeInteraction(interactionA);
    await new Promise(res => setImmediate(res)); // make sure A's synchronous prefix (lock acquire) ran

    // Admin B submits for the same channel while A is still processing.
    const interactionB = makeMockInteraction({
        customId: 'modal_set_key:vip30',
        type: 'modal',
        id: `v3938-race-B-${Date.now()}`,
        channel: makeTicketChannel('ch-race-1'),
        guild: guildA,
        components: [{ components: [{ value: 'KEY-RACE-2' }] }]
    });
    await routeInteraction(interactionB);
    assert.ok(interactionB._replies.length > 0, 'submit B gets an answer');
    assert.match(interactionB._replies[0].opts.content, /being processed by another admin/);

    // Complete flow A → lock released, A's key saved.
    resolveMemberFetch(buyerMember);
    await promiseA;

    const { getAllKeys } = require('../../src/data/keyManager');
    const keys = getAllKeys();
    assert.strictEqual(keys.length, 1, 'only the key from submit A is saved (B rejected)');
    assert.strictEqual(keys[0].key, 'KEY-RACE-1');
    const meta = getTicketMeta('ch-race-1', '');
    assert.strictEqual(meta.isCompleted, true, 'the isCompleted patch by A runs normally');
});

// ====================================================
// === FIX 3: productValue in meta + resolveProduct ===
// ====================================================

test('FIX 3a: createTicket stores productValue (stable ID) alongside productName (label)', async () => {
    resetDataFile('tickets.json', {});
    resetDataFile('config.json', { roles: { admin: 'role-admin' } });
    resetDataFile('deals.json', []);

    const created = [];
    const guild = {
        id: 'g-create',
        roles: { everyone: { id: 'role-everyone' } },
        client: { user: { id: 'bot-v3938' } },
        channels: {
            cache: {
                get: () => undefined,
                find: () => undefined
            },
            create: async opts => {
                const ch = {
                    id: `ch-created-${created.length + 1}`,
                    name: opts.name,
                    topic: opts.topic || '',
                    send: async () => ({})
                };
                created.push({ ch, opts });
                return ch;
            }
        }
    };
    const interaction = {
        guild,
        user: { id: 'user-create' },
        client: { user: { username: 'BotTest', displayAvatarURL: () => 'http://x' } },
        editReply: async () => ({})
    };

    await createTicket(interaction, {
        label: 'VIP 30 Hari',
        value: 'vip30',
        price: 'Rp 30.000',
        category: 'transaction',
        requiresKey: true
    });

    // created[0] = the category, created[1] = the ticket channel.
    assert.strictEqual(created.length, 2, 'category + ticket channel created');
    const meta = getTicketMeta(created[1].ch.id, '');
    assert.ok(meta, 'ticket meta saved');
    assert.strictEqual(meta.productName, 'VIP 30 Hari', 'the label is still stored (display/backward compat)');
    assert.strictEqual(meta.productValue, 'vip30', 'the stable value is stored too — rename-proof');
});

test('FIX 3b: resolveProduct — label renamed, productValue still resolves to the right product', () => {
    const config = {
        products: [
            // The admin renamed "VIP 30 Hari" → "VIP 1 Bulan" via /update-product.
            { label: 'VIP 1 Bulan', value: 'vip30', price: 'Rp 30.000', roleId: 'r1' }
        ]
    };
    const meta = { productName: 'VIP 30 Hari', productValue: 'vip30' };
    const product = resolveProduct(config, meta);
    assert.ok(product, 'the product is still found by value even though the label changed');
    assert.strictEqual(product.value, 'vip30');
    assert.strictEqual(product.label, 'VIP 1 Bulan', 'the CURRENT label is used for display');
});

test('FIX 3c: resolveProduct — legacy tickets (without productValue) still resolve by label', () => {
    const config = {
        products: [{ label: 'VIP 30 Hari', value: 'vip30', price: 'Rp 30.000', roleId: 'r1' }]
    };
    // v3.9.1–v3.9.37 meta: only has productName (frozen label).
    const product = resolveProduct(config, { productName: 'VIP 30 Hari' });
    assert.ok(product, 'legacy tickets still resolve (label fallback)');
    assert.strictEqual(product.value, 'vip30');
});

test('FIX 3d: resolveProduct — duplicate labels across products → productValue decides the right product', () => {
    const config = {
        products: [
            { label: 'Paket VIP', value: 'vip_a', roleId: 'r-a' },
            { label: 'Paket VIP', value: 'vip_b', roleId: 'r-b' }
        ]
    };
    // Lookup by label alone (old behavior) always takes the first one → wrong.
    const product = resolveProduct(config, { productName: 'Paket VIP', productValue: 'vip_b' });
    assert.ok(product);
    assert.strictEqual(product.value, 'vip_b', 'the value in meta decides the right product (not label order)');
    assert.strictEqual(product.roleId, 'r-b');
    // resolveProduct(null) → null (defensive).
    assert.strictEqual(resolveProduct(config, null), null);
});

// ====================================================
// === FIX 5: empty/whitespace keys ===
// ====================================================

test('FIX 5c: addKey rejects empty/whitespace keys; the key is trimmed before saving', () => {
    resetDataFile('keys.json', []);
    const { addKey, getAllKeys } = require('../../src/data/keyManager');
    const base = { userId: 'u-v38', roleId: 'r-v38', productName: 'P', days: 0 };

    assert.throws(() => addKey({ ...base, key: '' }), /Key cannot be empty/);
    assert.throws(() => addKey({ ...base, key: '   ' }), /Key cannot be empty/);
    assert.throws(() => addKey({ ...base, key: null }), /Key cannot be empty/);
    assert.throws(() => addKey({ ...base }), /Key cannot be empty/);
    assert.strictEqual(getAllKeys().length, 0, 'no blank keys saved');

    // Edge spaces are stripped — dup-check & storage use the trimmed version.
    const entry = addKey({ ...base, key: '  ABC-123-XYZ  ' });
    assert.strictEqual(entry.key, 'ABC-123-XYZ', 'the key is saved trimmed');
});

// ====================================================
// === FIX 6: raw key must not leak into logs via the duplicate error ===
// ====================================================

test('FIX 6c: the duplicate key error message does NOT contain the key value', () => {
    resetDataFile('keys.json', []);
    const { addKey } = require('../../src/data/keyManager');
    const SECRET = 'SECRET-KEY-XYZ-987';
    addKey({ key: SECRET, userId: 'u1', roleId: 'r', productName: 'P', days: 0 });

    // This error flows to the handler's console.warn → it must not contain the key.
    assert.throws(
        () => addKey({ key: SECRET, userId: 'u2', roleId: 'r', productName: 'P', days: 0 }),
        err => {
            assert.ok(!err.message.includes(SECRET), 'the error message must not contain the key value');
            assert.match(err.message, /already exists/i, 'still clearly a duplicate');
            return true;
        }
    );
});

// ====================================================
// === FIX 7: paginated transcript — the FIRST messages are archived too ===
// ====================================================

test('FIX 7: saveTranscript >100 messages → the payment proof at the START of the ticket is archived (paginated)', async () => {
    resetDataFile('config.json', { channels: { transcript: 'ch-trans' } });

    // 150 messages: ids increase with time (snowflake); message #1's content = payment proof.
    const msgs = [];
    for (let i = 0; i < 150; i++) {
        msgs.push({
            id: String(100000 + i),
            createdTimestamp: 1700000000000 + i * 1000,
            author: { bot: false, tag: `user${i}#0001` },
            embeds: [],
            content: i === 0 ? 'bukti-transfer-mulai-tiket' : `isi-pesan-${i}`
        });
    }

    const sent = [];
    const transcriptChannel = {
        send: async opts => {
            sent.push(opts);
            return {};
        }
    };
    // The fetch mock follows the Discord API contract: newest→oldest order, pages of 100,
    // `before` = exclusive cursor to older messages.
    const ticketChannel = {
        id: 'ch-t7',
        name: 'ticket-t7',
        guild: { channels: { cache: new Map([['ch-trans', transcriptChannel]]) } },
        messages: {
            fetch: async opts => {
                const sorted = [...msgs].sort((a, b) => Number(b.id) - Number(a.id));
                const page = opts.before ? sorted.filter(m => Number(m.id) < Number(opts.before)) : sorted;
                return new Map(page.slice(0, 100).map(m => [m.id, m]));
            }
        }
    };

    const ok = await saveTranscript(
        ticketChannel,
        { userId: 'u-t7', productName: 'VIP 30 Hari', price: 'Rp 30.000', category: 'transaction', createdAt: Date.now() },
        { tag: 'Admin#0001', id: 'admin-t7' },
        true
    );

    assert.strictEqual(ok, true, 'transcript sent successfully');
    const text = sent
        .map(s => s.content || '')
        .join('\n');
    assert.match(text, /bukti-transfer-mulai-tiket/, 'the FIRST message (payment proof) is included — previously lost due to the 100 cap');
    assert.match(text, /isi-pesan-149/, 'the LAST message is there too');
    assert.match(text, /isi-pesan-50/, 'a middle message is there');
});
