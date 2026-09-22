/**
 * Unit tests v3.24.4 — FULL slash-command parity from the web dashboard.
 *
 * Covers the 9 new DASH API endpoints:
 *   POST /guilds/:id/messages/reset  (parity with /reset-message)
 *   POST /guilds/:id/config/reset    (parity with /reset-config)
 *   POST /guilds/:id/warn            (parity with /warn — thresholds + guards)
 *   POST /guilds/:id/warns/remove    (parity with /warn-remove)
 *   POST /guilds/:id/warns/clear     (parity with /warn-clear)
 *   POST /guilds/:id/send-message    (parity with /send-message)
 *   POST /guilds/:id/booster-test     (parity with /test-booster)
 *   POST /guilds/:id/moderate         (parity with /kick /ban /unban /timeout /untimeout)
 *   POST /guilds/:id/purge            (parity with /purge)
 *
 * The mock guild carries richer member data than dashServer.test.js:
 * a real hierarchy (actor above target, bot above all) so the moderation
 * guards can be exercised both ways.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const dataDir = path.join(__dirname, '..', '..', 'data');
const configDir = path.join(dataDir, 'config');
const TOUCHED = ['warns.json', 'modlogs.json'];
const backups = {};
for (const f of TOUCHED) {
    const p = path.join(dataDir, f);
    backups[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
    if (backups[p] === null) fs.writeFileSync(p, '[]');
}
let configDirBackup = null;
if (fs.existsSync(configDir)) {
    configDirBackup = fs.readdirSync(configDir).map((f) => ({
        name: f,
        content: fs.readFileSync(path.join(configDir, f))
    }));
}
process.on('exit', () => {
    try {
        for (const [p, content] of Object.entries(backups)) {
            if (content === null) {
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } else {
                fs.writeFileSync(p, content);
            }
        }
        if (configDirBackup !== null) {
            const now = fs.existsSync(configDir) ? fs.readdirSync(configDir) : [];
            for (const f of now) {
                if (!configDirBackup.some((b) => b.name === f)) fs.unlinkSync(path.join(configDir, f));
            }
        }
    } catch (_) {}
});

const { createDashHandler } = require('../../src/infra/dashServer');
const { DEFAULTS } = require('../../src/data/configManager');

const TOKEN = 'unit-test-token-xyz789';
const GUILD_ID = '999555444333222111';
const ACTOR_ID = '111111111111111111'; // the dashboard admin
const TARGET_ID = '222222222222222222'; // the moderated member
const CHANNEL_ID = '333333333333333333'; // text channel
const VC_CHANNEL_ID = '344444444444444444'; // voice channel (type 2)

function memberMock(id, highestPosition, extra = {}) {
    return {
        id,
        user: { id, tag: `user-${id}`, bot: false, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
        // The boost embed builders read member.guild (name/premiumTier/iconURL).
        guild: {
            id: GUILD_ID,
            name: 'Parity Server',
            premiumTier: 1,
            premiumSubscriptionCount: 3,
            iconURL: () => null
        },
        roles: { highest: { position: highestPosition }, cache: new Map() },
        send: async () => { throw new Error('DMs closed'); }, // exercise the dmOk=false path
        timeout: extra.timeoutImpl || (async () => {}),
        kick: async () => {},
        ban: async () => {},
        isCommunicationDisabled: extra.isDisabled || (() => false),
        ...extra
    };
}

function makeMockClient() {
    const actor = memberMock(ACTOR_ID, 10);
    const target = memberMock(TARGET_ID, 1);
    const members = new Map([[ACTOR_ID, actor], [TARGET_ID, target]]);
    const botMember = {
        id: '999999999999999999',
        roles: { highest: { position: 100 } },
        permissions: { has: () => true }
    };
    const guild = {
        id: GUILD_ID,
        name: 'Parity Server',
        memberCount: 7,
        ownerId: ACTOR_ID,
        premiumTier: 1,
        premiumSubscriptionCount: 3,
        channels: {
            cache: new Map([
                [CHANNEL_ID, {
                    id: CHANNEL_ID, name: 'general', type: 0,
                    permissionsFor: () => ({ has: () => true }),
                    send: async (opts) => ({ id: `msg_${Date.now()}`, opts }),
                    messages: {
                        fetch: async () => new Map([
                            ['m1', { id: 'm1', author: { id: TARGET_ID }, createdTimestamp: Date.now() - 1000, delete: async () => {} }],
                            ['m2', { id: 'm2', author: { id: ACTOR_ID }, createdTimestamp: Date.now() - 2000, delete: async () => {} }],
                            ['m3', { id: 'm3', author: { id: TARGET_ID }, createdTimestamp: Date.now() - 3000, delete: async () => {} }]
                        ])
                    },
                    bulkDelete: async (msgs) => msgs.length
                }],
                [VC_CHANNEL_ID, { id: VC_CHANNEL_ID, name: 'voice', type: 2, permissionsFor: () => ({ has: () => true }) }]
            ])
        },
        roles: { cache: new Map() },
        bans: {
            fetch: async (id) => (id === '444444444444444444' ? { user: { id, tag: 'banned-user' } } : null),
            remove: async () => {}
        },
        members: {
            me: botMember,
            fetch: async (id) => members.get(id) || null
        }
    };
    return {
        isReady: () => true,
        guilds: { cache: new Map([[GUILD_ID, guild]]) },
        channels: { fetch: async () => { throw new Error('not needed'); } }
    };
}

let server;
let baseUrl;

test.before(async () => {
    server = http.createServer(createDashHandler({ client: makeMockClient(), token: TOKEN }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

function api(method, pathname, { body } = {}) {
    return fetch(baseUrl + pathname, {
        method,
        headers: { 'x-dash-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
}

const ACTOR = { id: ACTOR_ID, tag: 'admin#0001' };

// ====================================================
// === POST /messages/reset — /reset-message parity ===
// ====================================================

test('messages/reset: the welcome group is reset to the factory text + audit-logged', async () => {
    // Dirty the messages first through the config PUT.
    const dirty = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { updates: { 'messages.welcomeTitle': 'CUSTOM', 'messages.welcomeBody': 'custom body' } }
    });
    assert.strictEqual(dirty.status, 200);

    const res = await api('POST', `/guilds/${GUILD_ID}/messages/reset`, { body: { type: 'welcome', actor: ACTOR } });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.type, 'welcome');
    assert.strictEqual(data.messages.welcomeTitle, DEFAULTS.messages.welcomeTitle);
    assert.strictEqual(data.messages.welcomeBody, DEFAULTS.messages.welcomeBody);
    // The other groups are untouched by a group reset (goodbye was never dirtied).
    assert.strictEqual(data.messages.goodbyeTitle, DEFAULTS.messages.goodbyeTitle);
    // Persisted: a cold read of the config shows the factory welcome text.
    const dash = await (await api('GET', `/guilds/${GUILD_ID}/dashboard`)).json();
    assert.strictEqual(dash.config.messages.welcomeTitle, DEFAULTS.messages.welcomeTitle);
});

test('messages/reset: ALL resets every message + an invalid type is 400', async () => {
    const bad = await api('POST', `/guilds/${GUILD_ID}/messages/reset`, { body: { type: 'bogus', actor: ACTOR } });
    assert.strictEqual(bad.status, 400);

    const res = await api('POST', `/guilds/${GUILD_ID}/messages/reset`, { body: { type: 'ALL', actor: ACTOR } });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    for (const key of Object.keys(DEFAULTS.messages)) {
        assert.strictEqual(data.messages[key], DEFAULTS.messages[key], `${key} back to factory`);
    }
});

// ====================================================
// === POST /config/reset — /reset-config parity ===
// ====================================================

test('config/reset: requires the confirm string, then rebuilds from DEFAULTS', async () => {
    const noConfirm = await api('POST', `/guilds/${GUILD_ID}/config/reset`, { body: { actor: ACTOR } });
    assert.strictEqual(noConfirm.status, 400);

    // Dirty the config so we can prove the reset.
    await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { updates: { 'messages.welcomeTitle': 'DIRTY', 'channels.welcome': '123' } }
    });

    const res = await api('POST', `/guilds/${GUILD_ID}/config/reset`, { body: { confirm: 'RESET', actor: ACTOR } });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.config);
    assert.deepStrictEqual(data.config.messages, DEFAULTS.messages);
    assert.strictEqual(data.config.channels.welcome, undefined, 'channel overrides are gone (DEFAULTS.channels is empty)');
});

// ====================================================
// === POST /warn — /warn parity ===
// ====================================================

test('warn: adds a warn (hierarchy OK) and returns the count', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/warn`, {
        body: { userId: TARGET_ID, reason: 'spam in general', actor: ACTOR }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.count, 1);
    assert.strictEqual(data.dmOk, false, 'DM mock always fails — the flag is surfaced');
});

test('warn: hierarchy guard — the actor cannot warn someone at/above their level', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/warn`, {
        body: { userId: ACTOR_ID, reason: 'self warn', actor: ACTOR }
    });
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /yourself/i);
});

test('warn: validation — missing reason 400, unknown user 404, invalid id 400', async () => {
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/warn`, { body: { userId: TARGET_ID, reason: '', actor: ACTOR } })).status, 400);
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/warn`, { body: { userId: '555555555555555555', reason: 'x', actor: ACTOR } })).status, 404);
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/warn`, { body: { userId: 'abc', reason: 'x', actor: ACTOR } })).status, 400);
});

// ====================================================
// === POST /warns/remove + /warns/clear ===
// ====================================================

test('warns/remove + warns/clear: remove one, then clear the rest', async () => {
    const { getGuildWarns } = require('../../src/data/warnManager');
    // Two warns from the previous tests + one more.
    await api('POST', `/guilds/${GUILD_ID}/warn`, { body: { userId: TARGET_ID, reason: 'second', actor: ACTOR } });
    const warns = getGuildWarns(GUILD_ID, 10);
    assert.ok(warns.length >= 2);

    const res = await api('POST', `/guilds/${GUILD_ID}/warns/remove`, {
        body: { userId: TARGET_ID, warnId: warns[0].id, actor: ACTOR }
    });
    assert.strictEqual(res.status, 200);
    assert.ok(!getGuildWarns(GUILD_ID, 10).some((w) => w.id === warns[0].id), 'that warn is gone');

    // Unknown warnId → 404.
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/warns/remove`, { body: { userId: TARGET_ID, warnId: 'warn_nope', actor: ACTOR } })).status,
        404
    );

    const clear = await api('POST', `/guilds/${GUILD_ID}/warns/clear`, { body: { userId: TARGET_ID, actor: ACTOR } });
    assert.strictEqual(clear.status, 200);
    const data = await clear.json();
    assert.ok(data.removed >= 1);
    assert.strictEqual(getGuildWarns(GUILD_ID, 10).filter((w) => w.userId === TARGET_ID).length, 0);
});

// ====================================================
// === POST /send-message — /send-message parity ===
// ====================================================

test('send-message: sends plain text to a text channel', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/send-message`, {
        body: { channelId: CHANNEL_ID, message: 'hello\\nworld', actor: ACTOR }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.messageId);
});

test('send-message: guards — empty 400, too long 400, voice channel 400, unknown channel 404, bad mention 400', async () => {
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/send-message`, { body: { channelId: CHANNEL_ID, message: '   ', actor: ACTOR } })).status, 400);
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/send-message`, { body: { channelId: CHANNEL_ID, message: 'x'.repeat(2001), actor: ACTOR } })).status, 400);
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/send-message`, { body: { channelId: VC_CHANNEL_ID, message: 'x', actor: ACTOR } })).status, 400);
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/send-message`, { body: { channelId: '123456789012345678', message: 'x', actor: ACTOR } })).status, 404);
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/send-message`, { body: { channelId: CHANNEL_ID, message: 'x', mention: '<@&12>', actor: ACTOR } })).status, 400);
    // A valid role mention passes the whitelist.
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/send-message`, { body: { channelId: CHANNEL_ID, message: 'hi', mention: '@here', actor: ACTOR } })).status, 200);
});

// ====================================================
// === POST /booster-test — /test-booster parity ===
// ====================================================

test('booster-test: pure simulation (nothing sent) + live delivery to the configured channel', async () => {
    // No booster channel configured yet.
    const noChannel = await api('POST', `/guilds/${GUILD_ID}/booster-test`, { body: { type: 'add', live: false, actor: ACTOR } });
    assert.strictEqual(noChannel.status, 200);
    let data = await noChannel.json();
    assert.strictEqual(data.live, false);
    assert.ok(Array.isArray(data.lines));
    assert.ok(data.lines.some((l) => l.includes('not set')));

    // Configure the booster channel, then live-deliver.
    await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { updates: { 'channels.server-booster': CHANNEL_ID } }
    });
    const live = await api('POST', `/guilds/${GUILD_ID}/booster-test`, { body: { type: 'add', live: true, actor: ACTOR } });
    assert.strictEqual(live.status, 200);
    data = await live.json();
    assert.strictEqual(data.live, true);
    assert.strictEqual(data.sent, true);
    assert.ok(data.lines.some((l) => l.includes('#general')));

    // Live but the channel is broken → 422.
    await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { updates: { 'channels.server-booster': '123456789012345678' } }
    });
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/booster-test`, { body: { type: 'remove', live: true, actor: ACTOR } })).status,
        422
    );
});

// ====================================================
// === POST /moderate — kick/ban/unban/timeout/untimeout ===
// ====================================================

test('moderate: timeout validation + success path', async () => {
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/moderate`, { body: { action: 'timeout', userId: TARGET_ID, minutes: 0, actor: ACTOR } })).status,
        400
    );
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/moderate`, { body: { action: 'timeout', userId: TARGET_ID, minutes: 43201, actor: ACTOR } })).status,
        400
    );
    const res = await api('POST', `/guilds/${GUILD_ID}/moderate`, {
        body: { action: 'timeout', userId: TARGET_ID, minutes: 60, reason: 'spam', actor: ACTOR }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.action, 'timeout');
    assert.strictEqual(data.minutes, 60);

    // Hierarchy: the actor cannot moderate themselves.
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/moderate`, { body: { action: 'kick', userId: ACTOR_ID, actor: ACTOR } })).status,
        403
    );
});

test('moderate: unban by ID — not banned → 404, banned → 200', async () => {
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/moderate`, { body: { action: 'unban', userId: '777777777777777777', actor: ACTOR } })).status,
        404
    );
    const res = await api('POST', `/guilds/${GUILD_ID}/moderate`, {
        body: { action: 'unban', userId: '444444444444444444', reason: 'appeal accepted', actor: ACTOR }
    });
    assert.strictEqual(res.status, 200);
});

test('moderate: unknown action → 400, unknown member → 403 (not-in-guild)', async () => {
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/moderate`, { body: { action: 'explode', userId: TARGET_ID, actor: ACTOR } })).status,
        400
    );
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/moderate`, { body: { action: 'kick', userId: '555555555555555555', actor: ACTOR } })).status,
        403
    );
});

// ====================================================
// === POST /purge — /purge parity ===
// ====================================================

test('purge: validation (amount/channel) + a real bulk delete with a user filter', async () => {
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/purge`, { body: { channelId: CHANNEL_ID, amount: 0, actor: ACTOR } })).status, 400);
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/purge`, { body: { channelId: CHANNEL_ID, amount: 101, actor: ACTOR } })).status, 400);
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/purge`, { body: { channelId: '123456789012345678', amount: 5, actor: ACTOR } })).status, 404);
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/purge`, { body: { channelId: VC_CHANNEL_ID, amount: 5, actor: ACTOR } })).status, 400);

    const res = await api('POST', `/guilds/${GUILD_ID}/purge`, {
        body: { channelId: CHANNEL_ID, amount: 10, userId: TARGET_ID, actor: ACTOR }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    // The mock channel has 3 messages, 2 from the target → both deleted.
    assert.strictEqual(data.deleted, 2);
});
