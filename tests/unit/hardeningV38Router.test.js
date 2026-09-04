/**
 * Unit tests v3.9.38 — router/announce/config hardening (task 3-e).
 *
 * What is tested (bugs from the task 1-d audit fixed in v3.9.38):
 *   1. parseTime absolute: explicit bot timezone offset (default WITA +8) —
 *      not the host timezone. A UTC VPS previously made every absolute
 *      announcement fire 8 hours later than the help text promised.
 *      Configurable via the TZ_OFFSET_HOURS env var.
 *   2. Router dedup: mark() is called AFTER the handler succeeds — a handler
 *      that throws is NOT marked so the Discord gateway replay can retry
 *      (previously: checkAndMark marked before the handler ran → a crash
 *      swallowed the replay).
 *   3. truncateUtf8Safe: cuts per code point — a plain slice() can cut an
 *      emoji surrogate pair into a lone surrogate (Discord rejects 50035).
 *   4. /set-role: managed roles / @everyone / roles above the bot REJECTED
 *      (previously passed → auto-role failed silently).
 *   5. /announce & /announce-schedule: category channels (type 4) REJECTED
 *      (previously passed → the scheduled announcement failed silently at
 *      fire time).
 */

const test = require('node:test');
const assert = require('node:assert');

// ====================================================
// === (a) parseTime absolute — explicit offset ===
// ====================================================

test('v3.9.38: parseTime absolute — default WITA +8 offset (host TZ has no effect)', () => {
    delete process.env.TZ_OFFSET_HOURS;
    const { parseTime, getTzOffsetHours } = require('../../src/data/scheduledAnnouncements');
    assert.strictEqual(getTzOffsetHours(), 8, 'default offset = +8 (WITA)');
    const y = new Date().getFullYear() + 1; // always in the future, < 5 years
    const result = parseTime(`${y}-01-15 20:00`);
    assert.ok(result !== null, 'a valid future time must pass');
    // Wall-clock 20:00 WITA = 12:00 UTC → timestamp = Date.UTC(...) - 8 hours.
    assert.strictEqual(result, Date.UTC(y, 0, 15, 20, 0, 0) - 8 * 3600 * 1000);
});

test('v3.9.38: parseTime absolute — env TZ_OFFSET_HOURS=0 → absolute parsed as UTC', () => {
    process.env.TZ_OFFSET_HOURS = '0';
    try {
        const { parseTime, getTzOffsetHours } = require('../../src/data/scheduledAnnouncements');
        assert.strictEqual(getTzOffsetHours(), 0, 'env override active');
        const y = new Date().getFullYear() + 1;
        const result = parseTime(`${y}-01-15 20:00`);
        assert.ok(result !== null);
        assert.strictEqual(result, Date.UTC(y, 0, 15, 20, 0, 0));
    } finally {
        delete process.env.TZ_OFFSET_HOURS;
    }
});

test('v3.9.38: parseTime absolute — v3.9.8 rollover validation intact with the new offset', () => {
    delete process.env.TZ_OFFSET_HOURS;
    const { parseTime } = require('../../src/data/scheduledAnnouncements');
    assert.strictEqual(parseTime('2027-13-40 99:99'), null, 'month 13 / day 40 / hour 99 invalid');
    assert.strictEqual(parseTime('2027-00-15 20:00'), null, 'month 0 invalid');
    assert.strictEqual(parseTime('2027-01-32 20:00'), null, 'day 32 invalid');
    assert.strictEqual(parseTime('2027-01-15 25:00'), null, 'hour 25 invalid');
});

// ====================================================
// === (b) router dedup — check BEFORE, mark AFTER success ===
// ====================================================

test('v3.9.38: dedup — handler success → only then marked; check() true afterwards; replay skipped', async () => {
    const { check, mark, processedInteractions } = require('../../src/interactions/_dedup');
    // Direct unit: mark() only after success, check() reads the status.
    const unitId = `v3938-unit-${Date.now()}-${Math.random()}`;
    assert.strictEqual(check(unitId), false, 'not processed yet → check false');
    mark(unitId);
    assert.strictEqual(check(unitId), true, 'already marked → check true');
    processedInteractions.delete(unitId);

    // End-to-end via the router: btn_verify + a minimal mock → the handler replies (success)
    // → the router marks AFTER the handler finishes → a replay of the same interaction is skipped.
    const routeInteraction = require('../../src/interactions');
    const id = `v3938-dedup-${Date.now()}`;
    const replies = [];
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
        reply: async opts => {
            replies.push(opts);
            return {};
        },
        editReply: async opts => {
            replies.push(opts);
            return {};
        }
    });
    await routeInteraction(makeInteraction());
    assert.strictEqual(replies.length, 1, 'the handler ran 1x (1 reply)');
    assert.strictEqual(check(id), true, 'the router marks AFTER the handler succeeds');
    const replayResult = await routeInteraction(makeInteraction());
    assert.strictEqual(replayResult, undefined, 'the replay is skipped (check true)');
    assert.strictEqual(replies.length, 1, 'the handler does not run 2x');
    processedInteractions.delete(id);
});

test('v3.9.38: dedup — handler THROWS → NOT marked → the gateway replay is processed again', async () => {
    const { check, processedInteractions } = require('../../src/interactions/_dedup');
    const routeInteraction = require('../../src/interactions');
    const id = `v3938-dedup-throw-${Date.now()}`;
    // mm_pick_seller + a mock without deferReply → the midman domain throws
    // ("interaction.deferReply is not a function") — a manual probe.
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

    // First crash: the error propagates to the caller — the entry is NOT marked.
    await assert.rejects(() => routeInteraction(makeInteraction()));
    assert.strictEqual(check(id), false, 'handler threw → entry NOT marked');

    // Replay of the same interaction: it MUST be processed again (throwing again
    // = the handler really ran again). If it were still pre-marked (the old bug),
    // the replay would be skipped → assert.rejects would fail on an undefined
    // resolution — that is the failure this test detects.
    await assert.rejects(() => routeInteraction(makeInteraction()), 'the replay must run the handler again');
    processedInteractions.delete(id);
});

// ====================================================
// === (c) truncateUtf8Safe — emojis not cut into lone surrogates ===
// ====================================================

test('v3.9.38: truncateUtf8Safe — emojis cut per code point, no lone surrogates', () => {
    const { truncateUtf8Safe } = require('../../src/infra/text');
    const s = '👍'.repeat(300); // 600 code units (2 per emoji)
    const out = truncateUtf8Safe(s, 256);
    assert.ok(out.length <= 257, `total (content + ellipsis) ≤ 257 code units, got ${out.length}`);
    assert.ok(out.endsWith('…'), 'truncated → ends with an ellipsis');

    // Core bug: the content must not contain a lone surrogate (a high without
    // its low pair, or vice versa). Check that all pairs are intact.
    const content = out.slice(0, -1); // drop the ellipsis (not a surrogate)
    for (let i = 0; i < content.length; i += 2) {
        const hi = content.charCodeAt(i);
        const lo = content.charCodeAt(i + 1);
        assert.ok(hi >= 0xd800 && hi <= 0xdbff, `position ${i}: must be a high surrogate`);
        assert.ok(lo >= 0xdc00 && lo <= 0xdfff, `position ${i + 1}: must be a low surrogate (intact pair)`);
    }
    // The last content char is not an orphaned high surrogate (the old form:
    // slice(0,256) stopping right AFTER a high surrogate → broken string).
    const lastCode = content.charCodeAt(content.length - 1);
    assert.ok(lastCode >= 0xdc00 && lastCode <= 0xdfff, 'the last content char = a paired low surrogate');

    // Light regression: short text is unchanged.
    assert.strictEqual(truncateUtf8Safe('halo', 10), 'halo');
});

// ====================================================
// === (d) /set-role — unassignable roles rejected ===
// ====================================================

function makeSetRoleInteraction({ role, botHighestPos = 10 }) {
    const replies = [];
    return {
        commandName: 'set-role',
        client: { user: { username: 'TestBot', displayAvatarURL: () => 'http://x/a.png' } },
        user: { id: 'admin1', tag: 'Admin#0001' },
        guild: {
            id: 'g_test',
            members: { me: { roles: { highest: { position: botHighestPos } } } }
        },
        options: {
            getString: () => 'verified',
            getRole: () => role
        },
        deferReply: async () => {
            replies.push({ type: 'defer' });
        },
        editReply: async opts => {
            replies.push({ type: 'edit', opts });
            return {};
        },
        _replies: replies
    };
}

test('v3.9.38: /set-role — a managed role REJECTED (previously passed → auto-role failed silently)', async () => {
    const configHandler = require('../../src/commands/config');
    const interaction = makeSetRoleInteraction({
        role: { id: 'r_managed', name: 'BotIntegrationRole', managed: true, position: 5 }
    });
    await configHandler(interaction);
    const edit = interaction._replies.find(r => r.type === 'edit');
    assert.ok(edit, 'must reply with an ephemeral error');
    assert.match(edit.opts.content, /managed|integration|another bot/i);
});

test('v3.9.38: /set-role — @everyone REJECTED', async () => {
    const configHandler = require('../../src/commands/config');
    // The @everyone role: its id equals the guild id.
    const interaction = makeSetRoleInteraction({
        role: { id: 'g_test', name: '@everyone', managed: false, position: 0 }
    });
    await configHandler(interaction);
    const edit = interaction._replies.find(r => r.type === 'edit');
    assert.ok(edit, 'must reply with an ephemeral error');
    assert.match(edit.opts.content, /@everyone/i);
});

test('v3.9.38: /set-role — a role ABOVE the bot role REJECTED (the bot cannot assign it)', async () => {
    const configHandler = require('../../src/commands/config');
    const interaction = makeSetRoleInteraction({
        role: { id: 'r_high', name: 'HighRole', managed: false, position: 10 },
        botHighestPos: 10 // both 10 → role.position >= bot → cannot assign
    });
    await configHandler(interaction);
    const edit = interaction._replies.find(r => r.type === 'edit');
    assert.ok(edit, 'must reply with an ephemeral error');
    assert.match(edit.opts.content, /ABOVE|positioned/i);
});

// ====================================================
// === (e) /announce & /announce-schedule — channel type validated ===
// ====================================================

test('v3.9.38: /announce & /announce-schedule — a category channel (type 4) REJECTED', async () => {
    const announceHandler = require('../../src/commands/announce');
    // Category channel: type 4 — cannot receive announcement messages.
    const makeCategoryInteraction = commandName => {
        const replies = [];
        return {
            commandName,
            client: { user: { username: 'TestBot', displayAvatarURL: () => 'http://x/a.png' } },
            user: { id: 'admin1', tag: 'Admin#0001' },
            guild: { id: 'g_test', channels: { cache: new Map() } },
            options: {
                getChannel: () => ({ id: 'ch_cat', type: 4, name: 'Kategori' }),
                // getString must not be called — the channel validation must come first.
                getString: () => {
                    throw new Error('the channel validation must reject BEFORE other options are read');
                }
            },
            deferReply: async () => {
                replies.push({ type: 'defer' });
            },
            editReply: async opts => {
                replies.push({ type: 'edit', opts });
                return {};
            },
            _replies: replies
        };
    };

    for (const commandName of ['announce', 'announce-schedule']) {
        const interaction = makeCategoryInteraction(commandName);
        await announceHandler(interaction);
        const edit = interaction._replies.find(r => r.type === 'edit');
        assert.ok(edit, `${commandName}: must reply with an ephemeral error`);
        assert.match(edit.opts.content, /Channel must be a regular text channel/);
        assert.match(edit.opts.content, /category|forum|voice/);
    }
});
