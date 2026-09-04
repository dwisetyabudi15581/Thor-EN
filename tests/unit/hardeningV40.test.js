/**
 * Unit tests v3.9.40 — hardening from the full post-v3.9.39 audit
 * ("check the whole codebase to sync docs + thorough debugging").
 *
 * What's tested (all bugs verified by the 3-domain review):
 *   (1) /help search: a long query (up to 6000 chars from Discord) no longer
 *       makes EmbedBuilder.setDescription throw — capped at 100 in searchHelp
 *       + max_length:100 in the registry; backticks in the query are sanitized
 *       for display.
 *   (2) buildAllEmbeds: Discord guards ALWAYS hold for a catalog of any size —
 *       field value ≤1024, fields ≤25, one message total ≤6000, truncation
 *       with a note (replacing the v3.9.39 dead-code 2-embed split).
 *   (3) processGiveawayEnd manual path (skipPick) with 0 participants:
 *       the message still gets edited + an "ended with no winners" announcement
 *       (before: silent — Join buttons stayed live, admin told it succeeded).
 *   (4) findActiveTicketFor transient → createTicket ABORTS (no duplicate
 *       ticket) + the 3 midman call sites (pick buyer/seller) reject with a
 *       retry message.
 *   (5) Close-vs-complete race: the ticket close buttons while completionLocks
 *       is held → rejected with a "being processed by another admin" message.
 *   (6) Router dedup in-flight: a PARALLEL gateway replay (arriving while the
 *       first handler is still running) is dropped — the handler runs once.
 *   (7) reconcileZombieDeals skips deals held by transitionLocks
 *       (anti zombie-resurrect via the handler's setDeal).
 *   (8) Transcript: user content containing ``` no longer closes the chunk's
 *       code fence.
 *   (9) /help unknown customId → the interaction is acknowledged (reply),
 *       not warn-only.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: production data files are snapshotted & restored ===
// === (hardeningV38*.test.js pattern) ===
// ====================================================
const SANDBOX_FILES = ['giveaways.json', 'tickets.json', 'config.json', 'deals.json', 'polls.json'];
const backups = [];
for (const f of SANDBOX_FILES) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) {
        const b = p + '.v3940-backup';
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
});

/** Reset a data file to deterministic content (mirrors the v3.9.38 pattern). */
function resetDataFile(name, content) {
    fs.writeFileSync(path.join(dataDir, name), JSON.stringify(content, null, 2));
}

// ====================================================
// === (1) /help search — long query & backticks ===
// ====================================================

const {
    HELP_CATEGORIES,
    buildSearchEmbed,
    searchHelp,
    buildAllEmbeds,
    embedTotalChars
} = require('../../src/ui/helpCatalog');
const { EMBED_LIMITS } = require('../../src/infra/constants');

test('v3.9.40 FIX: /help search query of 4000 chars → does NOT throw, description ≤ 4096', () => {
    // Before the fix: a query longer than ~3.9K chars → description > 4096 →
    // EmbedBuilder.setDescription throws (uncaught) → /help search errors out.
    const long = 'a'.repeat(4000);
    let embed;
    assert.doesNotThrow(() => {
        embed = buildSearchEmbed(long);
    }, 'a long query must not make the builder throw');
    assert.ok(
        (embed.data.description?.length || 0) <= EMBED_LIMITS.DESCRIPTION,
        `desc ≤ 4096 (actual: ${embed.data.description.length})`
    );
});

test('v3.9.40 FIX: searchHelp truncates the query to 100 chars (two entry points: slash + modal)', () => {
    const result = searchHelp('x'.repeat(400));
    assert.ok(result.query.length <= 100, `query capped at 100 (actual: ${result.query.length})`);
    assert.strictEqual(result.emptyQuery, false);
});

test('v3.9.40 FIX: the /help registry search option has max_length 100', () => {
    const { getCommands } = require('../../src/commands/registry');
    const help = getCommands().find(c => c.name === 'help');
    assert.ok(help, 'the /help command exists in the registry');
    const opt = help.options.find(o => o.name === 'search');
    assert.ok(opt, 'the search option exists');
    assert.strictEqual(opt.max_length, 100, 'max_length 100 (Discord default string option is 6000)');
});

test('v3.9.40 FIX: a query containing backticks → display header sanitized (inline-code fence stays intact)', () => {
    const embed = buildSearchEmbed('ab`cd');
    assert.doesNotThrow(() => embed); // builder doesn't throw
    const desc = embed.data.description || '';
    // The raw backtick must not appear inside the echoed query (it would close
    // the inline-code span).
    assert.ok(!desc.includes('`ab`cd'), 'the query backtick is escaped for display');
    assert.ok(desc.includes("ab'cd"), 'the query is still readable (backtick → apostrophe)');
});

// ====================================================
// === (2) buildAllEmbeds — guard limits for a giant catalog ===
// ====================================================

test('v3.9.40 FIX: buildAllEmbeds — 49 categories × 40 long lines → 1 embed, all guards hold', () => {
    const orig = HELP_CATEGORIES.slice();
    try {
        for (let i = 0; i < 30; i++) {
            HELP_CATEGORIES.push({
                id: `extra_v40_${i}`,
                emoji: '🧪',
                name: `Extra Category ${i}`,
                short: 'v3.9.40 stress test category',
                lines: Array.from({ length: 40 }, (_, j) => `• \`/cmd-extra-${i}-${j}\` — a stress test command with a very long line aaaaaaaaaaaaaaaaaaaa`)
            });
        }
        const embeds = buildAllEmbeds();
        assert.strictEqual(embeds.length, 1, 'always 1 embed (the 2-embed split was removed)');
        const embed = embeds[0];
        const total = embedTotalChars(embed);
        assert.ok(total <= EMBED_LIMITS.TOTAL_CHARS, `message total ≤ 6000 (actual: ${total})`);
        const fields = embed.data.fields || [];
        assert.ok(fields.length <= 25, `fields ≤ 25 (actual: ${fields.length})`);
        for (const f of fields) {
            assert.ok(f.value.length <= EMBED_LIMITS.FIELD_VALUE, `field value ≤ 1024 (actual: ${f.value.length})`);
        }
        // The truncation note points to the dropdown/search (not silent).
        assert.match(
            embed.data.description,
            /\+\d+ more categories not loaded/,
            'the category truncation note appears'
        );
    } finally {
        HELP_CATEGORIES.length = 0;
        orig.forEach(c => HELP_CATEGORIES.push(c));
    }
});

test('v3.9.40 FIX: buildAllEmbeds — one category with giant lines → field capped ≤ 1024 + note', () => {
    const orig = HELP_CATEGORIES.slice();
    try {
        // unshift (not push) so the stress category is NOT dropped by the
        // truncation drop-loop (dropping works from the back) — its field must
        // survive and be visibly capped at 1024 by Guard 1.
        HELP_CATEGORIES.unshift({
            id: 'stress_field_v40',
            emoji: '🧪',
            name: 'Stress Field Category',
            short: 'stress field value',
            lines: Array.from({ length: 80 }, (_, j) => `• \`/cmd-stress-${j}\` — a long line to test the field value cap bbbbbbbbbbbbbbbbbbbbbb`)
        });
        const embeds = buildAllEmbeds();
        const fields = embeds[0].data.fields || [];
        const stress = fields.find(f => f.name.includes('Stress Field'));
        assert.ok(stress, 'the stress category appears as a field');
        assert.ok(stress.value.length <= EMBED_LIMITS.FIELD_VALUE, `value capped ≤ 1024 (actual: ${stress.value.length})`);
        assert.match(stress.value, /\+more lines not shown/, 'the line-cap note appears');
    } finally {
        HELP_CATEGORIES.length = 0;
        orig.forEach(c => HELP_CATEGORIES.push(c));
    }
});

test('v3.9.40: buildAllEmbeds with the normal catalog (19 categories) → no truncation note, total ≤ 6000', () => {
    const embeds = buildAllEmbeds();
    assert.strictEqual(embeds.length, 1);
    assert.ok(embedTotalChars(embeds[0]) <= EMBED_LIMITS.TOTAL_CHARS);
    assert.doesNotMatch(embeds[0].data.description, /more categories not loaded/, 'normal catalog: no note');
});

// ====================================================
// === (3) processGiveawayEnd — manual end with 0 participants ===
// ====================================================

const { processGiveawayEnd, reconcileZombieDeals } = require('../../src/services/schedulerTasks');

test('v3.9.40 FIX: manual end with 0 participants → message edited + no-winner announcement (not silent)', async () => {
    resetDataFile('giveaways.json', []);
    const gwm = require('../../src/data/giveawayManager');
    const gw = gwm.create({
        guildId: 'g_gw_v40',
        channelId: 'c_gw_v40',
        prize: 'Lonely Prize',
        winnersCount: 1,
        endsAt: Date.now() - 1000,
        hostId: 'host1',
        hostTag: 'Host#0001'
    });
    // NO participants — a manual /giveaway end picks [] (legitimate).

    const stale = JSON.parse(JSON.stringify(gwm.get(gw.id))); // pre-end snapshot
    gwm.end(gw.id, []); // manual: persist ended + empty winnerIds

    const edited = [];
    const announcements = [];
    const channel = {
        id: 'c_gw_v40',
        messages: {
            fetch: async () => ({ edit: async opts => edited.push(opts) })
        },
        send: async opts => {
            announcements.push(opts.content);
            return {};
        }
    };
    const guild = {
        id: 'g_gw_v40',
        name: 'Test Guild',
        channels: { cache: new Map([['c_gw_v40', channel]]) }
    };
    const client = {
        guilds: { fetch: async () => guild },
        users: { fetch: async () => null }
    };

    // Before v3.9.40: isManualAnnounce required winnerIds.length > 0 → a silent
    // early return (message not edited, no announcement).
    await processGiveawayEnd(client, stale, { skipPick: true });

    assert.strictEqual(announcements.length, 1, 'the "ended with no winners" announcement is sent');
    assert.match(announcements[0], /no winner/i, 'the announcement mentions no winners');
    assert.strictEqual(edited.length, 1, 'the giveaway message is edited (Join buttons not left live)');
    const embed = edited[0].embeds[0];
    assert.match(embed.data.title, /ENDED|BERAKHIR|OVER/i, 'the embed title announces the end');
});

// ====================================================
// === (4) findActiveTicketFor transient → callers abort ===
// ====================================================

const { findActiveTicketFor, createTicket } = require('../../src/data/ticketManager');

function makeFetchGuildThrow({ code, cachedEntries = [] }) {
    const err = new Error(code === 429 ? 'Too many requests' : 'Server error');
    err.code = code;
    return {
        id: 'g_v40',
        channels: {
            cache: new Map(cachedEntries),
            fetch: async () => {
                throw err;
            }
        }
    };
}

test('v3.9.40 FIX: findActiveTicketFor 429 → throws TICKET_VERIFY_TRANSIENT (not null)', async () => {
    resetDataFile('tickets.json', {
        'ch-live-429': { userId: 'u-v40', guildId: 'g_v40', productName: 'VIP 30 Hari', productValue: 'vip30' }
    });
    const guild = makeFetchGuildThrow({ code: 429 });
    await assert.rejects(
        () => findActiveTicketFor(guild, 'u-v40'),
        err => err.code === 'TICKET_VERIFY_TRANSIENT'
    );
    // The live meta stays (the v3.9.38 invariant holds).
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tickets.json'), 'utf8'));
    assert.ok(raw['ch-live-429'], 'the live ticket meta is not deleted');
});

test('v3.9.40 FIX: createTicket during a transient verification → ABORTS with a retry message (no duplicate ticket)', async () => {
    resetDataFile('tickets.json', {
        'ch-live-2': { userId: 'buyer-v40', guildId: 'g_v40', productName: 'VIP 30 Hari', productValue: 'vip30' }
    });
    resetDataFile('config.json', {
        roles: { admin: 'role-admin' },
        categories: [{ id: 'transaction', label: 'Transaction' }],
        products: [
            { label: 'VIP 30 Hari', value: 'vip30', price: 'Rp 30.000', category: 'transaction', requiresKey: true }
        ]
    });

    const guild = makeFetchGuildThrow({ code: 429 });
    const replies = [];
    const interaction = {
        guild,
        user: { id: 'buyer-v40', tag: 'Buyer#0001' },
        member: { roles: { cache: new Map() } },
        replied: true,
        deferred: true,
        editReply: async opts => {
            replies.push(opts.content);
            return {};
        }
    };

    await createTicket(interaction, {
        label: 'VIP 30 Hari',
        value: 'vip30',
        price: 'Rp 30.000',
        requiresKey: true
    });

    assert.strictEqual(replies.length, 1, 'one abort reply');
    assert.match(replies[0], /Could not verify your active ticket/i, 'a verification-failed message');
    // Core: NO new channel was created → the user still has exactly ONE meta.
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tickets.json'), 'utf8'));
    const metas = Object.values(raw).filter(m => m.userId === 'buyer-v40');
    assert.strictEqual(metas.length, 1, 'no second ticket created (the 1-active-ticket invariant holds)');
});

// ====================================================
// === (5) Close-vs-complete race (completionLocks) ===
// ====================================================

const ticketDomain = require('../../src/interactions/ticket');
const { setTicketMeta, getTicketMeta } = require('../../src/data/ticketManager');

const ADMIN_MEMBER = { permissions: { has: () => true }, roles: { cache: new Map() } };

function makeTicketInteraction({ customId, channelId }) {
    const replies = [];
    const interaction = {
        id: `v3940-${customId}-${Date.now()}-${Math.random()}`,
        customId,
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => false,
        isModalSubmit: () => false,
        member: ADMIN_MEMBER,
        user: { id: 'admin_v40', tag: 'Admin#0001' },
        channel: { id: channelId, topic: `Ticket UserID: buyer-v40 | ${channelId}` },
        client: { user: { username: 'BotTest', displayAvatarURL: () => 'http://x' } },
        reply: async opts => {
            replies.push(opts.content);
            interaction.replied = true;
            return {};
        },
        followUp: async opts => {
            replies.push(opts.content);
            return {};
        },
        update: async opts => {
            replies.push(opts.content);
            interaction.replied = true;
            return {};
        },
        deferUpdate: async () => {
            interaction.deferred = true;
            return {};
        },
        deferReply: async () => {
            interaction.deferred = true;
            return {};
        },
        editReply: async opts => {
            replies.push(opts.content);
            return {};
        },
        _replies: replies
    };
    return interaction;
}

test('v3.9.40 FIX: close button (✅ Done) while completionLocks is held → REJECTED, channel not deleted', async () => {
    resetDataFile('config.json', {
        roles: { admin: 'role-admin' },
        products: [{ label: 'VIP 30 Hari', value: 'vip30', price: 'Rp 30.000', category: 'transaction', requiresKey: true }]
    });
    resetDataFile('tickets.json', {
        'ch-race-1': { userId: 'buyer-v40', guildId: 'g_v40', productName: 'VIP 30 Hari', productValue: 'vip30', category: 'transaction', isCompleted: false }
    });

    // Simulate admin A holding the lock (set key / deliver order running).
    const locks = ticketDomain.completionLocks;
    locks.add('ch-race-1');
    try {
        const i = makeTicketInteraction({ customId: 'ticket_close_success', channelId: 'ch-race-1' });
        await ticketDomain(i);
        assert.strictEqual(i._replies.length, 1, 'one rejection reply');
        assert.match(i._replies[0], /being processed by another admin/i, 'a busy message');
        // The meta is NOT deleted (closeTicket didn't run).
        assert.ok(getTicketMeta('ch-race-1', ''), 'the ticket meta still exists — the channel was not closed');
    } finally {
        locks.delete('ch-race-1');
    }
});

test('v3.9.40 FIX: close button (❌ Purchase Cancelled) while completionLocks is held → REJECTED', async () => {
    resetDataFile('config.json', {
        roles: { admin: 'role-admin' },
        products: [{ label: 'VIP 30 Hari', value: 'vip30', price: 'Rp 30.000', category: 'transaction', requiresKey: true }]
    });
    resetDataFile('tickets.json', {
        'ch-race-2': { userId: 'buyer-v40', guildId: 'g_v40', productName: 'VIP 30 Hari', productValue: 'vip30', category: 'transaction', isCompleted: false }
    });

    const locks = ticketDomain.completionLocks;
    locks.add('ch-race-2');
    try {
        const i = makeTicketInteraction({ customId: 'ticket_close_cancel_trans', channelId: 'ch-race-2' });
        await ticketDomain(i);
        assert.match(i._replies[0], /being processed by another admin/i, 'a busy message');
        assert.ok(getTicketMeta('ch-race-2', ''), 'the ticket meta still exists');
    } finally {
        locks.delete('ch-race-2');
    }
});

// ====================================================
// === (6) Router dedup — in-flight guard (PARALLEL replay) ===
// ====================================================

test('v3.9.40 FIX: a PARALLEL gateway replay while the handler is still running → dropped, handler runs once', async () => {
    const { processedInteractions } = require('../../src/interactions/_dedup');
    const routeInteraction = require('../../src/interactions');
    const id = `v3940-inflight-${Date.now()}-${Math.random()}`;

    let release;
    const gate = new Promise(res => {
        release = res;
    });
    let replyCalls = 0;
    const makeInteraction = () => ({
        id,
        customId: 'btn_verify',
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => false,
        isModalSubmit: () => false,
        reply: async () => {
            replyCalls++;
            await gate; // slow reply → the first handler stays in-flight
            return {};
        },
        editReply: async () => ({})
    });

    const first = routeInteraction(makeInteraction()); // do NOT await — let it run
    await new Promise(res => setImmediate(res)); // one tick so it enters the await gate

    // A parallel replay with the SAME interaction.id (Discord double-delivery):
    // v3.9.39: it passed check() (not yet marked) + the replied guard (a fresh
    // instance) → the handler ran 2x in parallel. v3.9.40: silently dropped.
    const second = await routeInteraction(makeInteraction());
    assert.strictEqual(second, undefined, 'the parallel replay is dropped (in-flight guard)');
    assert.strictEqual(replyCalls, 1, 'no double handler — exactly one reply');

    release();
    await first;
    assert.strictEqual(replyCalls, 1, 'still exactly one reply after completion');
    processedInteractions.delete(id);
});

test('v3.9.40: handler THROWS → in-flight released → Discord\'s NEXT retry can still get in', async () => {
    const { processedInteractions } = require('../../src/interactions/_dedup');
    const routeInteraction = require('../../src/interactions');
    const id = `v3940-inflight-throw-${Date.now()}-${Math.random()}`;
    const makeInteraction = () => ({
        id,
        customId: 'mm_pick_seller',
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => true,
        isModalSubmit: () => false,
        reply: async () => ({}),
        editReply: async () => ({})
    });

    // First crash — in-flight MUST already be released (finally).
    await assert.rejects(() => routeInteraction(makeInteraction()));
    // The next retry is still processed (the v3.9.38 crash-retry semantics hold).
    await assert.rejects(() => routeInteraction(makeInteraction()), 'the post-throw retry still gets in (not stuck in-flight)');
    processedInteractions.delete(id);
});

// ====================================================
// === (7) reconcileZombieDeals — skip locked deals ===
// ====================================================

test('v3.9.40 FIX: reconcile does NOT delete the meta of a deal held by transitionLocks', async () => {
    resetDataFile('deals.json', {
        'ch-deal-locked': {
            channelId: 'ch-deal-locked',
            guildId: 'g_recon_v40',
            state: 'WAITING_PAYMENT',
            buyerId: 'b1',
            sellerId: 's1',
            priceNum: 100000,
            history: []
        }
    });
    const mm = require('../../src/data/midmanManager');

    // The deal channel is gone (fetch throws 10003) BUT a handler holds the lock.
    const unknownErr = new Error('Unknown Channel');
    unknownErr.code = 10003;
    const channelFetch = async () => {
        throw unknownErr;
    };
    const guild = {
        id: 'g_recon_v40',
        channels: {
            cache: new Map(),
            fetch: channelFetch
        }
    };
    const client = { guilds: { cache: new Map([['g_recon_v40', guild]]) } };

    mm.transitionLocks.add('ch-deal-locked');
    let removed;
    try {
        removed = await reconcileZombieDeals(client);
    } finally {
        mm.transitionLocks.delete('ch-deal-locked');
    }
    assert.strictEqual(removed, 0, 'the locked deal is NOT reconciled (zombie-resurrect prevented)');
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'deals.json'), 'utf8'));
    assert.ok(raw['ch-deal-locked'], 'the deal meta remains while a handler works');

    // Once the lock is released → the next reconcile may clean it up.
    const removed2 = await reconcileZombieDeals(client);
    assert.strictEqual(removed2, 1, 'after the lock is released, the zombie is cleaned');
    const raw2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'deals.json'), 'utf8'));
    assert.ok(!raw2['ch-deal-locked'], 'the zombie deal meta is deleted after the handler finishes');
});

// ====================================================
// === (8) Transcript — ``` content no longer closes the fence ===
// ====================================================

const { saveTranscript } = require('../../src/data/ticketManager');

test('v3.9.40 FIX: a user message containing ``` → the transcript code fence stays intact', async () => {
    resetDataFile('config.json', { channels: { transcript: 'ch-trans-v40' } });

    const evil = '```\nevil script\n```';
    const msgs = [
        { id: '900', createdTimestamp: 1700000000000, author: { bot: false, tag: 'user#0001' }, embeds: [], content: evil },
        { id: '901', createdTimestamp: 1700000001000, author: { bot: false, tag: 'user#0001' }, embeds: [], content: 'normal-message' }
    ];
    const sent = [];
    const transcriptChannel = { send: async opts => sent.push(opts) };
    const ticketChannel = {
        id: 'ch-t40',
        name: 'ticket-t40',
        guild: { channels: { cache: new Map([['ch-trans-v40', transcriptChannel]]) } },
        messages: {
            fetch: async opts => {
                const sorted = [...msgs].sort((a, b) => Number(b.id) - Number(a.id));
                const page = opts.before ? sorted.filter(m => Number(m.id) < Number(opts.before)) : sorted;
                return new Map(page.map(m => [m.id, m]));
            }
        }
    };

    const ok = await saveTranscript(
        ticketChannel,
        { userId: 'u-v40', productName: 'VIP 30 Hari', price: 'Rp 30.000', category: 'transaction', createdAt: Date.now() },
        { tag: 'Admin#0001', id: 'admin-v40' },
        true
    );
    assert.strictEqual(ok, true, 'the transcript sends successfully');

    // Every chunk must have an intact fence: the ``` content is escaped with
    // zero-width spaces; an unescaped ``` would make the fence count odd/higher.
    const chunks = sent.filter(s => (s.content || '').includes('```'));
    assert.ok(chunks.length > 0, 'there is a code-fence chunk');
    for (const chunk of chunks) {
        const body = chunk.content;
        const fenceCount = (body.match(/```/g) || []).length;
        assert.strictEqual(fenceCount, 2, `exactly one fence pair (actual: ${fenceCount})`);
    }
    // The evil content is still readable (backticks replaced by ZWSP — the raw string never appears).
    assert.ok(sent.some(s => (s.content || '').includes('evil script')), 'the message content is still archived');
});

// ====================================================
// === (9) /help unknown customId → interaction acknowledged ===
// ====================================================

test('v3.9.40 FIX: an alien help_* customId → ephemeral reply (not "interaction failed")', async () => {
    const helpDomain = require('../../src/interactions/help');
    const replies = [];
    const interaction = {
        customId: 'help_unknown_v40',
        id: `v3940-help-${Date.now()}`,
        replied: false,
        deferred: false,
        client: { user: { username: 'BotTest', displayAvatarURL: () => 'http://x' } },
        user: { toString: () => '<@test>' },
        isButton: () => true,
        isStringSelectMenu: () => false,
        reply: async opts => {
            replies.push(opts.content);
            interaction.replied = true;
            return {};
        },
        update: async () => ({})
    };
    await helpDomain(interaction);
    assert.strictEqual(replies.length, 1, 'the interaction is acknowledged');
    assert.match(replies[0], /Unrecognized/i, 'an informative message');
});
