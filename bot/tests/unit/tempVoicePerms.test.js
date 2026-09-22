/**
 * Unit tests v3.27.2 — temp voice 50013 (Missing Permissions) UX.
 *
 * What is tested:
 *   1. channels.create rejecting with DiscordAPIError code 50013 →
 *      a) a friendly, actionable console.error (mentions "Manage Channels" +
 *         "Manage Roles" and dragging the bot role up) — NOT a raw stack dump;
 *      b) the member who joined the trigger channel receives a warning message
 *         in that channel's text chat (visible feedback instead of silence);
 *      c) the warning mentions the member.
 *   2. The per-user create lock (v3.9.17) is RELEASED after the failure → a
 *      second event for the same member reaches channels.create again
 *      (no permanently stuck lock after an error).
 *   3. Non-50013 errors keep the legacy raw log ('Error create temp voice:') and
 *      do NOT send the friendly channel warning.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');
const tempVoiceManager = require('../../src/data/tempVoiceManager');
const voiceStateUpdate = require('../../src/bot/events/voiceStateUpdate');

// ====================================================
// === Sandbox: production data/tempVoice.json is snapshotted & restored ===
// === (hardeningV38Automod.test.js pattern)                              ===
// ====================================================
const tvPath = path.join(dataDir, 'tempVoice.json');
const tvBackup = tvPath + '.v3272-backup';
const tvExisted = fs.existsSync(tvPath);
if (tvExisted) fs.copyFileSync(tvPath, tvBackup);
// Start from a clean slate so setupGuild('g1', …) is deterministic.
try {
    fs.rmSync(tvPath, { force: true });
} catch (_) {}
process.on('exit', () => {
    if (tvExisted) {
        try {
            fs.copyFileSync(tvBackup, tvPath);
            fs.rmSync(tvBackup, { force: true });
        } catch (_) {}
    } else {
        try {
            fs.rmSync(tvPath, { force: true });
        } catch (_) {}
    }
});

// The GUILD_ID guard (v3.9.26) must be off during tests — save & restore.
const _savedGuildId = process.env.GUILD_ID;
if ('GUILD_ID' in process.env) delete process.env.GUILD_ID;

const GUILD_ID = 'g-test-tvperms';

/**
 * Build (oldState, newState) pair + a mock guild whose channels.create rejects.
 * Returns { oldState, newState, sent, createCalls } for assertions.
 */
function makeStates(createImpl) {
    const sent = [];
    const createCalls = [];

    const triggerChannel = {
        id: 'ch_trigger',
        send: async content => {
            sent.push(content);
        }
    };

    const guild = {
        id: GUILD_ID,
        roles: { everyone: { id: 'everyone' } },
        channels: {
            cache: {
                get: () => undefined
            },
            create: async opts => {
                createCalls.push(opts);
                return createImpl(opts);
            }
        }
    };

    const member = {
        id: 'u_tester',
        user: { id: 'u_tester', username: 'tester', tag: 'tester#0001', bot: false },
        voice: { setChannel: async () => {} }
    };

    const newState = {
        guild,
        member,
        id: 'u_tester',
        channelId: 'ch_trigger',
        channel: triggerChannel,
        client: {}
    };
    const oldState = { channelId: null };

    return { oldState, newState, sent, createCalls };
}

/** Discard console.error output during a call, capturing the messages. */
async function captureConsoleError(fn) {
    const original = console.error;
    const captured = [];
    console.error = (...args) => captured.push(args.map(a => (typeof a === 'string' ? a : a && a.message ? a.message : '')).join(' '));
    try {
        await fn();
    } finally {
        console.error = original;
    }
    return captured;
}

// Seed the temp voice config for the test guild: trigger channel + category.
tempVoiceManager.setupGuild(GUILD_ID, 'ch_trigger', 'cat_tempvoice', 'ch_control');

// ====================================================
// === Test 1: 50013 → friendly log + member warning ===
// ====================================================
test('v3.27.2 temp voice 50013: friendly actionable log + member warned in the trigger channel', async () => {
    const e = new Error('Missing Permissions');
    e.code = 50013;
    const { oldState, newState, sent } = makeStates(() => {
        throw e;
    });

    const logs = await captureConsoleError(() => voiceStateUpdate.execute(oldState, newState));

    // a) friendly, actionable console output — mentions both permissions + role order
    assert.strictEqual(logs.length, 1, 'exactly one console.error for the 50013 path');
    assert.ok(logs[0].includes('Manage Channels'), 'log must mention Manage Channels');
    assert.ok(logs[0].includes('Manage Roles'), 'log must mention Manage Roles');
    assert.ok(/above|drag/i.test(logs[0]), 'log must mention dragging the bot role up');
    assert.ok(!logs[0].includes('at handleErrors'), 'no raw stack dump for the 50013 path');

    // b) the member got a visible warning in the trigger channel's text chat
    assert.strictEqual(sent.length, 1, 'exactly one warning message sent');
    assert.ok(sent[0].includes('<@u_tester>'), 'warning mentions the member');
    assert.ok(sent[0].includes('Manage Channels'), 'warning names the missing permission');
});

// ====================================================
// === Test 2: the lock is released after a 50013 failure ===
// ====================================================
test('v3.27.2 temp voice 50013: per-user lock released → a second event still reaches channels.create', async () => {
    const e = new Error('Missing Permissions');
    e.code = 50013;
    const { oldState, newState, createCalls } = makeStates(() => {
        throw e;
    });

    await captureConsoleError(() => voiceStateUpdate.execute(oldState, newState));
    await captureConsoleError(() => voiceStateUpdate.execute(oldState, newState));

    assert.strictEqual(createCalls.length, 2, 'channels.create must be attempted again (lock not stuck)');
});

// ====================================================
// === Test 3: non-50013 errors keep the legacy raw log, no channel warning ===
// ====================================================
test('v3.27.2 temp voice non-50013 error: legacy raw log + NO friendly channel warning', async () => {
    const { oldState, newState, sent } = makeStates(() => {
        throw new Error('Something else broke');
    });

    const logs = await captureConsoleError(() => voiceStateUpdate.execute(oldState, newState));

    assert.strictEqual(logs.length, 1, 'one console.error');
    assert.ok(logs[0].includes('Error create temp voice:'), 'legacy log label preserved');
    assert.ok(logs[0].includes('Something else broke'), 'error message preserved');
    assert.strictEqual(sent.length, 0, 'no channel warning for non-permission errors');
});

// Restore GUILD_ID for other test files in the same process.
if (_savedGuildId !== undefined) process.env.GUILD_ID = _savedGuildId;
