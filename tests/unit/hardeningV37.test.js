/**
 * Unit tests v3.9.37 — hardening & consistency after the midman/escrow feature.
 *
 * What is tested (bugs/issues found by the thorough "sync everything" audit):
 *   1. Router: `ticket_cat:midman` is now an EXACT match — a custom category
 *      whose id starts with "midman" (e.g. midman_jual) no longer "dies" in
 *      the midman domain (fallback without a reply), but is routed correctly
 *      to ticket.
 *   2. findEmptyCategoryWarnings: the midman category is skipped — the old
 *      warning suggested "add products to the midman category" (misleading:
 *      clicking the escrow button always opens a deal, products are never
 *      shown).
 *   3. buildTicketPanel (use_dropdown): the midman option description mentions
 *      an escrow deal — not "Support / open a ticket directly" (misleading).
 *   4. auditLog ACTION_LABELS: the MIDMAN_xxx and SET_MIDMAN_FEE actions have
 *      labels (previously falling back to the raw string — inconsistent with
 *      the label convention).
 *   5. /help: Auto-Split 3 categories (TRANSACTIONS/SUPPORT/ESCROW), the
 *      Midman/Escrow section exists, the midman role is mentioned, dynamic
 *      version from package.json (anti-stale — it used to hardcode v3.9.26).
 *   6. reconcileZombieDeals: a non-terminal deal whose channel was manually
 *      deleted → meta cleaned up (the buyer/seller is not locked forever);
 *      live & terminal deals untouched; the daily wrapper only runs 1x/day.
 *   7. 3-step deal form: a seller with an active regular ticket is REJECTED
 *      (v3.9.37 — previously only the buyer was checked); the happy path
 *      still works.
 *   8. saveTranscript: empty chunks are not sent (blank code block when the
 *      hard-split lines leave exactly CHUNK_SIZE left).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: production data files are snapshotted & restored ===
// === (midman.test.js / ticketCloseButtons.test.js pattern) ===
// ====================================================
const SANDBOX_FILES = ['deals.json', 'config.json', 'tickets.json'];
const backups = [];
for (const f of SANDBOX_FILES) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) {
        const b = p + '.v3937-backup';
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

// ====================================================
// === 1. ROUTER — exact match ticket_cat:midman ===
// ====================================================

test('router v3.9.37: a custom "midman_jual" category (midman prefix) is routed to TICKET, does not die in midman', async () => {
    resetDataFile('config.json', {}); // → DEFAULTS (midman_jual is not registered)
    const routeInteraction = require('../../src/interactions');
    const replies = [];
    const interaction = {
        id: `v3937-router-${Date.now()}-${Math.random()}`,
        customId: 'ticket_cat:midman_jual',
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => false,
        isModalSubmit: () => false,
        reply: async opts => {
            replies.push(opts);
            return {};
        },
        editReply: async opts => {
            replies.push(opts);
            return {};
        }
    };
    await routeInteraction(interaction);
    // The ticket domain answers "category not found" — NOT dead air
    // (before the fix: it fell into the midman fallback → console.warn, no reply).
    assert.strictEqual(replies.length, 1, 'the interaction must be replied to by the ticket domain');
    assert.match(replies[0].content, /midman_jual/);
    assert.match(replies[0].content, /not found/);
});

test('router v3.9.37: the exact "ticket_cat:midman" button still dispatches to the midman domain', async () => {
    resetDataFile('config.json', { roles: { admin: 'ra', midman: 'rm' } });
    const routeInteraction = require('../../src/interactions');
    const interaction = {
        id: `v3937-router2-${Date.now()}-${Math.random()}`,
        customId: 'ticket_cat:midman',
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => false,
        isModalSubmit: () => false,
        // openCreateModal uses interaction.reply (not deferReply).
        user: { id: 'u1', tag: 'Creator#0001' },
        member: { roles: { cache: new Map() } },
        reply: async () => ({}),
        showModal: async () => ({})
    };
    let modalShown = false;
    interaction.showModal = () => {
        modalShown = true;
    };
    try {
        await routeInteraction(interaction);
    } catch (_) {
        // The incomplete mock may throw AFTER showModal — what matters is
        // that the midman domain ran (showModal was called).
    }
    assert.ok(modalShown, 'openCreateModal (midman domain) must have been called');
});

// ====================================================
// === 2. findEmptyCategoryWarnings — midman is skipped ===
// ====================================================

test('findEmptyCategoryWarnings v3.9.37: the midman category is not warned about (not a product category)', () => {
    const { findEmptyCategoryWarnings } = require('../../src/commands/panels');
    const lines = findEmptyCategoryWarnings(
        { categoryIds: [] },
        {
            ticketCategories: [
                { id: 'midman', label: 'Rekber / Middleman', requiresKey: false, isDefault: false }
            ],
            products: []
        }
    );
    assert.strictEqual(lines.length, 0, 'midman is not a selling category — there must be no "add products" warning');
});

// ====================================================
// === 3. buildTicketPanel dropdown — midman description ===
// ====================================================

test('buildTicketPanel v3.9.37: the midman dropdown option mentions deal/escrow (not "open a ticket")', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    resetDataFile('config.json', {});
    const build = buildTicketPanel(
        { useDropdown: true, categoryIds: [], title: 'Panel' },
        {
            client: { user: { username: 'Bot', displayAvatarURL: () => 'http://x/a.png' } }
        }
    );
    const menu = build.components[0].components[0].toJSON();
    const options = menu.options;
    const midmanOpt = options.find(o => o.value === 'midman');
    assert.ok(midmanOpt, 'the midman option must exist in the dropdown (DEFAULTS)');
    assert.match(midmanOpt.description, /escrow|deal/i);
    assert.doesNotMatch(midmanOpt.description, /support|ticket/i);
});

// ====================================================
// === 4. auditLog ACTION_LABELS — midman labels ===
// ====================================================

test('auditLog v3.9.37: the MIDMAN_* and SET_MIDMAN_FEE actions have labels (not raw strings)', () => {
    const { ACTION_LABELS } = require('../../src/infra/auditLog');
    const expected = [
        'SET_MIDMAN_FEE',
        'MIDMAN_CREATE',
        'MIDMAN_AGREE',
        'MIDMAN_JOIN',
        'MIDMAN_CANCEL',
        'MIDMAN_FUNDIN',
        'MIDMAN_RECEIVED',
        'MIDMAN_RELEASE',
        'MIDMAN_DISPUTE',
        'MIDMAN_RESOLVE_RELEASE',
        'MIDMAN_RESOLVE_REFUND',
        'MIDMAN_MEMBER_ADD',
        'MIDMAN_MEMBER_REMOVE'
    ];
    for (const action of expected) {
        assert.ok(ACTION_LABELS[action], `ACTION_LABELS.${action} must exist`);
    }
});

// v3.9.37 FIX: deals.json (live escrow data) was missing from FILES_TO_BACKUP —
// the backupManager guard test only scans files that EXIST in data/ (in dev
// deals.json may be absent), so it is pinned explicitly here to make the
// regression future-proof. A restore without deals.json = every active escrow
// deal is lost.
test('backup v3.9.37: FILES_TO_BACKUP must include deals.json (a restore must not break escrow deals)', () => {
    const fs2 = require('fs');
    const path2 = require('path');
    const src = fs2.readFileSync(
        path2.join(__dirname, '..', '..', 'src', 'data', 'backupManager.js'),
        'utf8'
    );
    assert.match(src, /'deals\.json'/, 'deals.json must be present in FILES_TO_BACKUP');
});

// ====================================================
// === 5. /help — auto-split 3 categories + midman ===
// ====================================================

test('help v3.9.37: Auto-Split 3 categories (TRANSACTIONS/SUPPORT/ESCROW) + Midman section', async () => {
    const replies = [];
    const mockInteraction = {
        user: { toString: () => '<@test>' },
        client: {
            user: {
                username: 'TestBot',
                displayAvatarURL: () => 'http://example.com/avatar.png'
            }
        },
        reply: async opts => {
            replies.push(opts);
            return {};
        }
    };
    const helpHandler = require('../../src/commands/help');
    await helpHandler(mockInteraction);

    // v3.9.39: /help is now an interactive navigator (home + dropdown + buttons) —
    // the full command list moved into the helpCatalog. Content regressions are
    // checked against the catalog; navigation structure via the reply.
    const embed = replies[0].embeds[0];
    assert.ok(replies[0].components?.length >= 1, 'v3.9.39: the reply must carry navigation components (dropdown)');
    assert.strictEqual(replies[0].components[0].components[0].toJSON().custom_id, 'help_cat');

    const { HELP_CATEGORIES } = require('../../src/ui/helpCatalog');
    const allText = HELP_CATEGORIES.map(c => c.lines.join('\n')).join('\n') + '\n' + embed.data.description;

    // Auto-Split now has 3 categories — user-reported bug ("still 2").
    assert.match(allText, /3 categories/);
    assert.doesNotMatch(allText, /2 categories/);
    assert.match(allText, /ESCROW/);
    assert.match(allText, /midman\.category/);

    // Midman section + command.
    assert.match(allText, /set-midman-fee/);
    assert.match(allText, /midman-deals/);
    assert.match(allText, /set-role midman/);

    // The role list mentions midman.
    assert.match(allText, /verified\/unverified\/admin\/\*\*midman\*\*/);

    // Dynamic version from package.json.
    const { version: pkgVersion } = require('../../package.json');
    assert.match(embed.data.footer.text, new RegExp(`v${pkgVersion.replace(/\./g, '\\.')}`));
});

// ====================================================
// === 6. reconcileZombieDeals — self-healing deals ===
// ====================================================

const mm = require('../../src/data/midmanManager');
const { reconcileZombieDeals, reconcileZombieDealsDaily } = require('../../src/services/schedulerTasks');

function makeGuildForReconcile({ fetch }) {
    const cache = new Map();
    cache.set('ch_live', { id: 'ch_live' });
    return {
        id: 'g_rec',
        channels: {
            cache,
            fetch
        }
    };
}

test('reconcileZombieDeals v3.9.37: a deal with a missing channel → meta deleted; live & terminal deals remain', async () => {
    resetDataFile('deals.json', {
        ch_live: { channelId: 'ch_live', guildId: 'g_rec', state: 'WAITING_PAYMENT', buyerId: 'b1', sellerId: 's1' },
        ch_dead: { channelId: 'ch_dead', guildId: 'g_rec', state: 'WAITING_PAYMENT', buyerId: 'b2', sellerId: 's2' },
        ch_terminal: { channelId: 'ch_terminal', guildId: 'g_rec', state: 'COMPLETED', buyerId: 'b3', sellerId: 's3' },
        ch_fetch_err: { channelId: 'ch_err', guildId: 'g_rec', state: 'WAITING_PAYMENT', buyerId: 'b4', sellerId: 's4' },
        // Discord fetching a deleted channel → throws code 10003 (not null).
        ch_10003: { channelId: 'ch_10003', guildId: 'g_rec', state: 'WAITING_PAYMENT', buyerId: 'b5', sellerId: 's5' }
    });
    const guild = makeGuildForReconcile({
        // ch_dead → null; ch_10003 → throws code 10003 (both = channel gone
        // → meta deleted); ch_err → throws WITHOUT a code (transient — entry kept).
        fetch: async id => {
            if (id === 'ch_dead') return null;
            if (id === 'ch_err') throw new Error('transient 500');
            if (id === 'ch_10003') {
                const e = new Error('Unknown Channel');
                e.code = 10003;
                throw e;
            }
            return { id };
        }
    });
    const client = { guilds: { cache: new Map([['g_rec', guild]]) } };

    const removed = await reconcileZombieDeals(client);

    assert.strictEqual(removed, 2, 'ch_dead (null) + ch_10003 (error 10003) cleaned up',
    );
    assert.ok(mm.getDeal('ch_live'), 'the live deal stays');
    assert.strictEqual(mm.getDeal('ch_dead'), null, 'zombie deal meta deleted (getDeal → null)');
    assert.strictEqual(mm.getDeal('ch_10003'), null, '10003 deal meta deleted');
    assert.ok(mm.getDeal('ch_terminal'), 'terminal deal not touched (not in the active list)');
    assert.ok(mm.getDeal('ch_fetch_err'), 'transient fetch error → entry kept, retried on the next tick');

    // The core bug: users in zombie deals are no longer locked.
    assert.strictEqual(mm.hasActiveDealFor('g_rec', 'b2'), false, 'the zombie deal buyer is freed');
    assert.strictEqual(mm.hasActiveDealFor('g_rec', 's2'), false, 'the zombie deal seller is freed');
    assert.strictEqual(mm.hasActiveDealFor('g_rec', 'b5'), false, 'the 10003 deal buyer is freed');
    assert.strictEqual(mm.hasActiveDealFor('g_rec', 'b1'), true, 'the live deal buyer stays locked (correct)');
});

test('reconcileZombieDealsDaily v3.9.37: the daily wrapper only runs the reconcile 1x/day', async () => {
    resetDataFile('deals.json', {});
    let calls = 0;
    // Spying via the module registry is not possible (internal function) — count
    // via a side effect: guild fetch is called each time the reconcile runs.
    const guild = makeGuildForReconcile({ fetch: async () => null });
    const client = { guilds: { cache: new Map([['g_rec', guild]]) } };
    const origFetch = guild.channels.fetch;
    guild.channels.fetch = async id => {
        calls++;
        return origFetch(id);
    };
    await reconcileZombieDealsDaily(client);
    await reconcileZombieDealsDaily(client); // second time → must skip
    assert.strictEqual(calls, 0, 'empty deals.json → no fetch calls at all');
    resetDataFile('deals.json', {
        ch_dead: { channelId: 'ch_dead', guildId: 'g_rec', state: 'WAITING_PAYMENT', buyerId: 'b2', sellerId: 's2' }
    });
    await reconcileZombieDealsDaily(client); // same day → still skipped
    assert.ok(mm.getDeal('ch_dead'), 'daily guard: a second reconcile on the same day does not run');
});

// ====================================================
// === 7. 3-step deal form — seller ticket check ===
// ====================================================

/**
 * Fake Collection (Map + find — mirrors the discord.js Collection API used
 * by guild.channels.cache / guild.members.cache).
 */
class FakeCollection extends Map {
    find(pred) {
        for (const v of this.values()) if (pred(v)) return v;
        return undefined;
    }
}

function makeMidmanGuild({ sellerHasTicket }) {
    const members = new FakeCollection();
    members.set('buyer1', { id: 'buyer1', user: { id: 'buyer1', bot: false } });
    members.set('seller1', { id: 'seller1', user: { id: 'seller1', bot: false } });

    const channels = new FakeCollection();
    // The escrow category "already exists" → skip category creation.
    channels.set('cat_rec', { id: 'cat_rec', name: '🤝 ESCROW', type: 4 });
    if (sellerHasTicket) {
        // seller1's active regular ticket — findActiveTicketFor must find this.
        channels.set('ch_ticket_seller', {
            id: 'ch_ticket_seller',
            toString: () => '<#ch_ticket_seller>'
        });
    }

    return {
        id: 'g_deal',
        roles: { everyone: { id: 'everyone1' } },
        client: { user: { id: 'bot1' } },
        members: { cache: members },
        channels: {
            cache: channels,
            create: async () => {
                throw new Error('create must not be called in this test');
            }
        }
    };
}

function makeFlowInteraction({ type, customId, values, fields, guild }) {
    const replies = [];
    return {
        id: `v3937-${customId}-${Date.now()}-${Math.random()}`,
        customId,
        values,
        fields,
        guild,
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => type === 'button',
        isStringSelectMenu: () => type === 'select',
        isUserSelectMenu: () => type === 'userselect',
        isModalSubmit: () => type === 'modal',
        user: { id: 'creator1', tag: 'Creator#0001' },
        client: { user: { id: 'bot1' } },
        deferReply: async () => {},
        reply: async opts => {
            replies.push(opts);
            return {};
        },
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        _replies: replies
    };
}

test('deal flow v3.9.37: a seller with an active regular ticket is REJECTED (asymmetry fixed)', async () => {
    resetDataFile('config.json', { roles: { admin: 'ra', midman: 'rm' } });
    resetDataFile('deals.json', {});
    resetDataFile('tickets.json', {
        ch_ticket_seller: { userId: 'seller1', guildId: 'g_deal', productName: 'Help', category: 'help' }
    });
    const guild = makeMidmanGuild({ sellerHasTicket: true });
    const midmanDomain = require('../../src/interactions/midman');

    // Step 1 — item & price modal.
    const i1 = makeFlowInteraction({
        type: 'modal',
        customId: 'modal_mm_create',
        fields: {
            getTextInputValue: id => (id === 'mm_field_item' ? 'Akun ML Mythic' : '100000')
        },
        guild
    });
    await midmanDomain(i1);

    // Step 2 — pick the buyer.
    const i2 = makeFlowInteraction({ type: 'userselect', customId: 'mm_pick_buyer', values: ['buyer1'], guild });
    await midmanDomain(i2);

    // Step 3 — pick the seller (has an active ticket) → must be rejected.
    const i3 = makeFlowInteraction({ type: 'userselect', customId: 'mm_pick_seller', values: ['seller1'], guild });
    await midmanDomain(i3);

    const last = i3._replies[i3._replies.length - 1];
    assert.ok(last, 'there must be a reply');
    assert.match(last.content, /seller1.*active ticket/i, 'the rejection mentions the seller\'s active ticket');
    assert.match(last.content, /Please pick another seller/);
    assert.strictEqual(mm.getDeal('ch_new_deal'), null, 'the deal must NOT be created (getDeal → null when absent)');

    // The seller is still not deal-locked (no deal exists at all).
    assert.strictEqual(mm.hasActiveDealFor('g_deal', 'seller1'), false);
});

test('deal flow v3.9.37 (regression): a seller without an active ticket → the deal is still created normally', async () => {
    resetDataFile('config.json', { roles: { admin: 'ra', midman: 'rm' }, channels: {} });
    resetDataFile('deals.json', {});
    resetDataFile('tickets.json', {});
    const guild = makeMidmanGuild({ sellerHasTicket: false });
    // The happy path needs the deal channel → allow create.
    guild.channels.create = async opts => {
        assert.ok(opts.name.startsWith('escrow-buyer1'), 'correct deal channel name');
        return {
            id: 'ch_new_deal',
            send: async () => ({ id: 'msg_board' }),
            delete: async () => {},
            toString: () => '<#ch_new_deal>'
        };
    };
    const midmanDomain = require('../../src/interactions/midman');

    const i1 = makeFlowInteraction({
        type: 'modal',
        customId: 'modal_mm_create',
        fields: {
            getTextInputValue: id => (id === 'mm_field_item' ? 'Akun ML Mythic' : '100000')
        },
        guild
    });
    await midmanDomain(i1);
    const i2 = makeFlowInteraction({ type: 'userselect', customId: 'mm_pick_buyer', values: ['buyer1'], guild });
    await midmanDomain(i2);
    const i3 = makeFlowInteraction({ type: 'userselect', customId: 'mm_pick_seller', values: ['seller1'], guild });
    await midmanDomain(i3);

    const deal = mm.getDeal('ch_new_deal');
    assert.ok(deal, 'the deal must be created (the happy path is not broken by the new check)');
    assert.strictEqual(deal.buyerId, 'buyer1');
    assert.strictEqual(deal.sellerId, 'seller1');
    assert.strictEqual(deal.state, 'WAITING_AGREE');
    const last = i3._replies[i3._replies.length - 1];
    assert.match(last.content, /Escrow deal created/);
});

// ====================================================
// === 8. saveTranscript — no empty chunks ===
// ====================================================

test('saveTranscript v3.9.37: hard-split lines with exactly 1900 chars left do not produce an empty chunk', async () => {
    const { saveTranscript } = require('../../src/data/ticketManager');
    resetDataFile('config.json', { channels: { transcript: 'ch_transcript' } });

    // One long user message: its transcript line must be > CHUNK_SIZE so the
    // hard-split path runs. The slice remainder is made EXACTLY 1900 + a small
    // header → the condition that used to produce a '' chunk (blank code block).
    const ts = 1700000000000;
    const author = 'Tester#0001';
    const time = new Date(ts).toLocaleString('en-US');
    const prefix = `[${time}] ${author}: `;
    // 2×1900 so the hard-split while loop runs twice, remainder exactly 1900.
    const contentLen = 3 * 1900 - prefix.length;
    const content = 'X'.repeat(contentLen);

    const sent = [];
    const transcriptChannel = {
        id: 'ch_transcript',
        send: async opts => {
            sent.push(opts);
            return { id: `m${sent.length}` };
        }
    };
    const ticketChannel = {
        id: 'ch_ticket',
        name: 'ticket-u1',
        guild: { channels: { cache: new Map([['ch_transcript', transcriptChannel]]) } },
        messages: {
            fetch: async () =>
                new Map([
                    [
                        'm1',
                        { createdTimestamp: ts, author: { tag: author, bot: false }, content, embeds: [] }
                    ]
                ])
        }
    };

    const ok = await saveTranscript(ticketChannel, { userId: 'u1', productName: 'P', category: 'transaction' }, { tag: 'A#1', id: 'a1' }, true);
    assert.ok(ok, 'transcript sent');

    // First send = summary embed; the rest are code block chunks.
    const chunkSends = sent.slice(1);
    assert.ok(chunkSends.length >= 2, 'a long message must be split into several chunks');
    for (const s of chunkSends) {
        const m = s.content.match(/```\n([\s\S]*?)\n```/);
        assert.ok(m, 'code block format intact');
        assert.ok(m[1].trim().length > 0, `chunk must not be empty (got: ${JSON.stringify(s.content.slice(0, 40))})`);
    }
});
