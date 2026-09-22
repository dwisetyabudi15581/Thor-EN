/**
 * Unit tests v3.29.0 — GUILD LIFECYCLE EVENTS (guildCreate / guildDelete).
 *
 * Context (the "TAHAP 1" two-way-sync audit): before v3.29.0 the bot being
 * KICKED from a server was completely invisible — no log, no distinction
 * from a Discord outage. These handlers are pure observability (console
 * audit trail), so the tests assert:
 *   1. guildDelete distinguishes OUTAGE (available === false → no kick
 *      message, nothing touched) from a real KICK/leave.
 *   2. guildCreate announces a new guild, and flags the single-server-mode
 *      mismatch (GUILD_ID set, different guild) that would silently inert
 *      every feature there.
 *   3. Both handlers never throw on defensive shapes (null, no id).
 *   4. Handlers are wired to the right discord.js event names.
 */

const test = require('node:test');
const assert = require('node:assert');

const guildCreateHandler = require('../../src/bot/events/guildCreate');
const guildDeleteHandler = require('../../src/bot/events/guildDelete');

/** Capture console output for matching. */
async function captureConsole(fn) {
    const lines = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...a) => lines.push(['log', a.map(String).join(' ')]);
    console.warn = (...a) => lines.push(['warn', a.map(String).join(' ')]);
    console.error = (...a) => lines.push(['error', a.map(String).join(' ')]);
    try {
        await fn();
    } finally {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
    }
    return lines;
}

test('guildDelete: an OUTAGE (available === false) is NOT reported as a kick', async () => {
    const lines = await captureConsole(() =>
        guildDeleteHandler.execute({ id: '1', name: 'My Server', available: false })
    );
    const text = lines.map(([, msg]) => msg).join('\n');
    assert.ok(text.includes('temporarily unavailable'), `outage wording expected: ${text}`);
    assert.ok(!text.includes('REMOVED from'), 'an outage must NOT be logged as a removal');
});

test('guildDelete: a real kick/leave is reported as a removal (data retained)', async () => {
    const lines = await captureConsole(() =>
        guildDeleteHandler.execute({ id: '123456789012345678', name: 'Trading Hub' })
    );
    const text = lines.map(([, msg]) => msg).join('\n');
    assert.ok(text.includes('REMOVED from'), `kick wording expected: ${text}`);
    assert.ok(text.includes('Trading Hub'), 'the guild name must appear');
    assert.ok(text.includes('retained'), 'the retention note must appear');
});

test('guildDelete: defensive shapes never throw', async () => {
    await guildDeleteHandler.execute(null);
    await guildDeleteHandler.execute({});
    await guildDeleteHandler.execute({ id: '1', available: false });
});

test('guildCreate: a new guild is announced with name and member count', async () => {
    const lines = await captureConsole(() =>
        guildCreateHandler.execute({ id: '123456789012345678', name: 'Fresh Server', memberCount: 42 })
    );
    const text = lines.map(([, msg]) => msg).join('\n');
    assert.ok(text.includes('added to'), `added wording expected: ${text}`);
    assert.ok(text.includes('Fresh Server'), 'the guild name must appear');
    assert.ok(text.includes('42'), 'the member count must appear');
    assert.ok(!text.includes('Single-server mode'), 'no mode warning in public mode');
});

test('guildCreate: single-server mode mismatch is flagged (public-mode env)', async () => {
    // Simulate GUILD_ID set to a DIFFERENT guild → the warning path.
    const prevGuildId = process.env.GUILD_ID;
    process.env.GUILD_ID = '999999999999999999';
    try {
        const lines = await captureConsole(() =>
            guildCreateHandler.execute({ id: '123456789012345678', name: 'Other Server' })
        );
        const text = lines.map(([, msg]) => msg).join('\n');
        assert.ok(text.includes('Single-server mode'), `warning expected: ${text}`);
    } finally {
        if (prevGuildId === undefined) delete process.env.GUILD_ID;
        else process.env.GUILD_ID = prevGuildId;
    }
});

test('guildCreate: an unavailable guild (outage return) is not announced as new', async () => {
    const lines = await captureConsole(() => guildCreateHandler.execute({ id: '1', name: 'Ghost', available: false }));
    const text = lines.map(([, msg]) => msg).join('\n');
    assert.ok(!text.includes('added to'), 'an unavailable guild must not be announced as added');
});

test('guildCreate: defensive shapes never throw', async () => {
    await guildCreateHandler.execute(null);
    await guildCreateHandler.execute({});
});

test('lifecycle handlers are registered under the right discord.js event names', () => {
    assert.strictEqual(guildCreateHandler.name, 'guildCreate');
    assert.strictEqual(guildDeleteHandler.name, 'guildDelete');
});
