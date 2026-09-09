/**
 * Unit tests for v3.9.47 — /stats & /my-stats display accuracy.
 *
 * User report: "the stats don't match". Root causes fixed in v3.9.47:
 *   1. /stats showed "Total Member Tracked" (stats.json entries) — NOT the
 *      real member count, and no live server data at all.
 *   2. The label said "VIP Purchases" while it counts ALL transactions
 *      (ticket orders + escrow deals).
 *   3. /my-stats showed "Joined Tracking: not recorded" for everyone who
 *      joined before v3.2 — the real join date lives on the member object.
 *
 * These tests run the REAL command module end-to-end with a stubbed
 * interaction (deferReply/editReply captured) and assert the embed content.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { safeWriteJSON } = require('../../src/infra/safeWrite');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STATS_PATH = path.join(DATA_DIR, 'stats.json');
const TICKETS_PATH = path.join(DATA_DIR, 'tickets.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const GUILD_ID = 'test_guild_statsdisp';
const USER_ID = 'test_user_statsdisp';
// Fixed timestamps so the <t:...:R> assertions are deterministic.
const REAL_JOINED_TS = 1600000000000;

/**
 * Stub interaction shaped exactly like what src/commands/stats.js touches:
 * commandName / deferReply / editReply (captured) / guild / user / member.
 */
function makeStubInteraction(overrides = {}) {
    const replies = [];
    const interaction = {
        commandName: 'stats',
        deferReply: async () => {},
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        guild: {
            id: GUILD_ID,
            name: 'Test Server',
            memberCount: 123,
            premiumTier: 2,
            premiumSubscriptionCount: 5,
            iconURL: () => 'https://example.com/icon.png'
        },
        user: { id: USER_ID, tag: 'Tester#0001' },
        member: { joinedTimestamp: REAL_JOINED_TS },
        options: { getString: () => null, getInteger: () => null }
    };
    Object.assign(interaction, overrides);
    interaction.__replies = replies;
    return interaction;
}

function fieldMap(embed) {
    // embeds[0].data.fields → { name → value } (names are unique in our embeds)
    return Object.fromEntries((embed.data.fields || []).map(f => [f.name, f.value]));
}

/** Populate stats.json + tickets.json with deterministic test data. */
function seedTestData() {
    const statsManager = require('../../src/data/statsManager');
    // 3 messages for the test user (also seeds "members tracked").
    for (let i = 0; i < 3; i++) statsManager.incrementMessages(GUILD_ID, USER_ID);
    // 2 transactions × Rp 10.000 → revenue Rp 20.000.
    statsManager.recordPurchase(GUILD_ID, USER_ID, 10000);
    statsManager.recordPurchase(GUILD_ID, USER_ID, 10000);

    // 2 open tickets for this guild (tickets.json is scoped by meta.guildId).
    const { setTicketMeta } = require('../../src/data/ticketManager');
    setTicketMeta('test_guild_statsdisp_ch1', {
        userId: USER_ID,
        productName: 'Test Product A',
        price: 'Rp 10.000',
        guildId: GUILD_ID
    });
    setTicketMeta('test_guild_statsdisp_ch2', {
        userId: USER_ID,
        productName: 'Test Product B',
        price: 'Rp 10.000',
        guildId: GUILD_ID
    });
}

test('USER REPORT /stats: live member count, boosts, tickets + tracked activity', async () => {
    seedTestData();
    const statsCommand = require('../../src/commands/stats');

    const interaction = makeStubInteraction();
    await statsCommand(interaction);

    assert.strictEqual(interaction.__replies.length, 1, 'exactly one reply');
    const embed = interaction.__replies[0].embeds[0];
    const fields = fieldMap(embed);

    // Live data straight from the guild object — verifiable against Discord.
    assert.strictEqual(fields['👥 Members'], '123');
    assert.strictEqual(fields['🎫 Open Tickets'], '2');
    assert.strictEqual(fields['🚀 Server Boosts'], 'Level 2 (5 boosts)');

    // Tracked activity from stats.json — seeded above.
    assert.strictEqual(fields['💬 Messages Tracked'], '3');
    assert.strictEqual(fields['🛒 Transactions'], '2');
    assert.strictEqual(fields['💰 Total Revenue'], 'Rp 20,000');

    // v3.9.49 (user report: "member tracked & member live — if they do the same
    // thing, make it one"): exactly ONE member field (the live count) + the
    // average divides by the LIVE member count so the numbers are consistent.
    const names = (embed.data.fields || []).map(f => f.name);
    assert.strictEqual(names.filter(n => /member/i.test(n) && !/avg/i.test(n)).length, 1, `exactly one member field: ${names.join(' | ')}`);
    assert.ok(!names.includes('👤 Members Tracked'), 'the duplicate Members Tracked field must be gone');
    assert.strictEqual(fields['📈 Avg Messages/Member'], `${Math.round(3 / 123)}`);

    // The title names the server; the icon is attached when available.
    assert.match(embed.data.title, /SERVER STATS — Test Server/);
    assert.strictEqual(embed.data.thumbnail?.url, 'https://example.com/icon.png');
});

test('USER REPORT /stats: the misleading "VIP Purchases" label is gone', async () => {
    const statsCommand = require('../../src/commands/stats');
    const interaction = makeStubInteraction();
    await statsCommand(interaction);

    const embed = interaction.__replies[0].embeds[0];
    const names = (embed.data.fields || []).map(f => f.name);
    // v3.9.47 rename: it counts ALL transactions (ticket orders + escrow),
    // so the old "VIP Purchases" wording must not come back.
    assert.ok(!names.some(n => /VIP/i.test(n)), `no field may say "VIP": ${names.join(' | ')}`);
    assert.ok(names.includes('🛒 Transactions'));
});

test('/stats edge: no boosts → "None"; no icon → no thumbnail field', async () => {
    const statsCommand = require('../../src/commands/stats');
    const interaction = makeStubInteraction({
        guild: {
            id: GUILD_ID,
            name: 'Test Server',
            memberCount: 7,
            premiumTier: 0,
            premiumSubscriptionCount: null,
            iconURL: () => null
        }
    });
    await statsCommand(interaction);

    const embed = interaction.__replies[0].embeds[0];
    const fields = fieldMap(embed);
    assert.strictEqual(fields['🚀 Server Boosts'], 'None');
    assert.strictEqual(fields['👥 Members'], '7');
    assert.strictEqual(embed.data.thumbnail, undefined, 'iconURL() null → no thumbnail');
});

test('USER REPORT /my-stats: the REAL join date + transaction label', async () => {
    const statsCommand = require('../../src/commands/stats');
    const interaction = makeStubInteraction({ commandName: 'my-stats' });
    await statsCommand(interaction);

    const embed = interaction.__replies[0].embeds[0];
    const fields = fieldMap(embed);

    // The real join date comes from the member object — NOT the v3.2 tracking
    // (stats.joinedAt is null here: recordJoin was never called for this user).
    assert.strictEqual(fields['📅 Joined This Server'], `<t:${Math.floor(REAL_JOINED_TS / 1000)}:R>`);
    assert.strictEqual(fields['💬 Messages'], '3');
    assert.strictEqual(fields['🛒 Transactions'], '2');
    assert.strictEqual(fields['💰 Total Spent'], 'Rp 20,000');

    const names = (embed.data.fields || []).map(f => f.name);
    assert.ok(!names.some(n => /VIP/i.test(n)), 'my-stats must not say "VIP" either');
});

test('/my-stats edge: partial member (no join data anywhere) → "unknown"', async () => {
    const statsCommand = require('../../src/commands/stats');
    const interaction = makeStubInteraction({ commandName: 'my-stats', member: undefined });
    await statsCommand(interaction);

    const fields = fieldMap(interaction.__replies[0].embeds[0]);
    assert.strictEqual(fields['📅 Joined This Server'], 'unknown');
});

test('ticketManager: getActiveTicketCount is guild-scoped (v3.9.47)', () => {
    const { getActiveTicketCount } = require('../../src/data/ticketManager');
    assert.strictEqual(getActiveTicketCount(GUILD_ID), 2);
    assert.strictEqual(getActiveTicketCount('test_guild_other'), 0);
    assert.strictEqual(getActiveTicketCount(''), 0);
});

// ============ CLEANUP (residue from seeding) ============

test('v3.9.47 cleanup: remove stats/tickets test residue', () => {
    const statsManager = require('../../src/data/statsManager');

    // 1) stats.json — drop every test_guild key.
    if (fs.existsSync(STATS_PATH)) {
        try {
            const data = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                let removed = 0;
                for (const key of Object.keys(data)) {
                    if (/^test_guild/.test(key)) {
                        delete data[key];
                        removed++;
                    }
                }
                if (removed > 0) safeWriteJSON(STATS_PATH, data);
            }
        } catch (_) {}
    }
    // Reset the in-memory cache + dirty flag so nothing flushes stale data back.
    statsManager.reload();

    // 2) tickets.json — remove the synthetic ticket channels.
    const { removeTicketMeta, getActiveTicketCount } = require('../../src/data/ticketManager');
    removeTicketMeta('test_guild_statsdisp_ch1');
    removeTicketMeta('test_guild_statsdisp_ch2');
    assert.strictEqual(getActiveTicketCount(GUILD_ID), 0, 'ticket residue removed');

    assert.ok(true, 'stats/tickets cleanup done');
});
