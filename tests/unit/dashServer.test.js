/**
 * Unit tests for dashServer (v3.17.0) — the HTTP API for the web dashboard.
 *
 * Verifies:
 *   - Auth: no token 401; wrong token 401; correct token passes
 *   - GET /health without auth — ok
 *   - GET /guilds — guild list from the client cache (mocked)
 *   - GET /guilds/:id/meta — channels + roles sorted
 *   - GET /guilds/:id/dashboard — the all-module payload
 *   - PUT /guilds/:id/config — valid, invalid (422), prototype pollution
 *     rejected, unknown section rejected, whole arrays (ticketCategories)
 *     validated
 *   - PUT /guilds/:id/automod — validated merge patch; unknown field 422
 *   - POST/DELETE responders — CRUD + duplicate 409
 *   - POST/DELETE announce — valid schedule; past send time 400
 *   - POST selfroles — panel created + message sent (mocked channel);
 *     rollback when the channel fetch fails
 *
 * The test server runs on an ephemeral port (listen(0)) with a mocked
 * client — Discord is never touched. Production data files are
 * snapshotted & restored.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

// === Snapshot & restore the data files touched by the tests ===
const dataDir = path.join(__dirname, '..', '..', 'data');
const configDir = path.join(dataDir, 'config');
const TOUCHED = [
    'automod.json', 'responders.json', 'selfRoles.json', 'scheduledAnnouncements.json',
    // v3.19.0: files touched by the new modules (giveaway/poll/keys/schedule)
    'giveaways.json', 'polls.json', 'keys.json', 'scheduledRoles.json',
    // v3.21.0: the Quick Start endpoints write ticket panels
    'panels.json'
];
// panels.json is an OBJECT MAP (not an array) — an empty file must be '{}'
// so loadPanels doesn't quarantine it as an invalid format.
const INIT_CONTENT = { 'panels.json': '{}' };
const backups = {}; // path -> old content (null = did not exist)
let configDirBackup = null; // old file names in data/config/

for (const f of TOUCHED) {
    const p = path.join(dataDir, f);
    backups[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
    if (backups[p] === null) fs.writeFileSync(p, INIT_CONTENT[f] ?? '[]');
}
if (fs.existsSync(configDir)) {
    configDirBackup = fs.readdirSync(configDir).map((f) => ({
        name: f,
        content: fs.readFileSync(path.join(configDir, f))
    }));
    for (const f of configDirBackup) {
        if (f.name.startsWith('999')) fs.unlinkSync(path.join(configDir, f.name)); // clean up leftovers from old runs
    }
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

const TOKEN = 'unit-test-token-abc123';
const GUILD_ID = '999111222333444555';

// === Mock discord.js client ===
function makeMockClient({ failChannelFetch = false } = {}) {
    const guild = {
        id: GUILD_ID,
        name: 'Test Server',
        icon: 'abc123',
        memberCount: 42,
        ownerId: '111000111000111000',
        channels: {
            cache: new Map([
                ['777000111222333444', { id: '777000111222333444', name: 'general', type: 0, rawPosition: 1 }],
                ['777000111222333555', { id: '777000111222333555', name: 'vc-zone', type: 2, rawPosition: 0 }]
            ])
        },
        roles: {
            cache: new Map([
                ['888000111222333444', { id: '888000111222333444', name: 'Member', color: 0, position: 1 }],
                ['888000111222333555', { id: '888000111222333555', name: 'Admin', color: 0xff0000, position: 5 }]
            ])
        },
        // v3.19.0: the keys module needs member fetch (best-effort role add/remove).
        members: {
            fetch: async (id) => ({
                id,
                user: { id, tag: 'Tester#0001' },
                roles: {
                    cache: new Map(),
                    add: async () => {},
                    remove: async () => {}
                }
            })
        }
    };
    return {
        isReady: () => true,
        guilds: { cache: new Map([[GUILD_ID, guild]]) },
        channels: {
            fetch: async (id) => {
                if (failChannelFetch) throw new Error('channel gone');
                return {
                    id,
                    type: 0, // v3.19.0: GuildText — the giveaway/poll/embed endpoints check the type
                    send: async (opts) => ({ id: `msg_${Date.now()}`, opts, url: 'https://discord.com/channels/x/y' }),
                    messages: {
                        fetch: async () => ({ edit: async () => {}, delete: async () => {} })
                    }
                };
            }
        }
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

function api(method, pathname, { token = TOKEN, body } = {}) {
    return fetch(baseUrl + pathname, {
        method,
        headers: {
            ...(token ? { 'x-dash-token': token } : {}),
            ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
}

// ====================================================
// === Auth & health ===
// ====================================================

test('dash: /health without a token is still 200', async () => {
    const res = await api('GET', '/health', { token: null });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.guildCount, 1);
});

test('dash: any other endpoint without a token → 401', async () => {
    const res = await api('GET', '/guilds', { token: null });
    assert.strictEqual(res.status, 401);
});

test('dash: wrong token → 401', async () => {
    const res = await api('GET', '/guilds', { token: 'wrong' });
    assert.strictEqual(res.status, 401);
});

// ====================================================
// === Guilds & meta ===
// ====================================================

test('dash: GET /guilds — guild list from the cache', async () => {
    const res = await api('GET', '/guilds');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.guilds.length, 1);
    assert.strictEqual(data.guilds[0].id, GUILD_ID);
    assert.strictEqual(data.guilds[0].name, 'Test Server');
});

test('dash: GET /guilds/:id/meta — channels + roles', async () => {
    const res = await api('GET', `/guilds/${GUILD_ID}/meta`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.channels.length, 2);
    assert.strictEqual(data.roles.length, 2);
    // Roles sorted by position DESC (Admin first)
    assert.strictEqual(data.roles[0].name, 'Admin');
});

test('dash: GET /guilds/:id/meta for a foreign guild → 404', async () => {
    const res = await api('GET', '/guilds/123456789123456789/meta');
    assert.strictEqual(res.status, 404);
});

// ====================================================
// === Dashboard payload ===
// ====================================================

test('dash: GET /guilds/:id/dashboard — all modules present', async () => {
    const res = await api('GET', `/guilds/${GUILD_ID}/dashboard`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    for (const key of ['config', 'automod', 'responders', 'selfroles', 'tempvoice', 'announces', 'serverstats', 'panels']) {
        assert.ok(key in data, `payload.${key} must exist`);
    }
    // Config merged with DEFAULTS (the getConfig pattern)
    assert.ok(Array.isArray(data.config.ticketCategories));
    assert.strictEqual(typeof data.config.messages.welcomeTitle, 'string');
});

// ====================================================
// === PUT config ===
// ====================================================

test('dash: PUT config valid — saved & read back', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: {
            actor: { id: '42', tag: 'tester' },
            updates: {
                'roles.verified': '888000111222333444',
                'channels.welcome': '777000111222333444',
                'messages.welcomeTitle': 'HELLO FROM DASH',
                'leveling.enabled': true,
                'leveling.xpPerMessage': 25
            }
        }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.ok);
    assert.strictEqual(data.applied.length, 5);

    // Read back via the dashboard — the values stick
    const dash = await (await api('GET', `/guilds/${GUILD_ID}/dashboard`)).json();
    assert.strictEqual(dash.config.roles.verified, '888000111222333444');
    assert.strictEqual(dash.config.channels.welcome, '777000111222333444');
    assert.strictEqual(dash.config.messages.welcomeTitle, 'HELLO FROM DASH');
    assert.strictEqual(dash.config.leveling.enabled, true);
    assert.strictEqual(dash.config.leveling.xpPerMessage, 25);

    // The physical file changed too (the slash commands' source of truth)
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, `${GUILD_ID}.json`), 'utf8'));
    assert.strictEqual(raw.messages.welcomeTitle, 'HELLO FROM DASH');
});

test('dash: PUT config invalid values → 422 with per-field details', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: {
            updates: {
                'channels.welcome': 'not-an-id', // not a snowflake
                'leveling.xpPerMessage': 99999 // above the range
            }
        }
    });
    assert.strictEqual(res.status, 422);
    const data = await res.json();
    assert.strictEqual(data.details.length, 2);
});

test('dash: PUT config prototype pollution rejected', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { updates: { '__proto__.polluted': 'yes' } }
    });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(({}).polluted, undefined, 'Object.prototype must not be polluted');
});

test('dash: PUT config unknown section rejected', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { updates: { 'hacker.field': 'x' } }
    });
    assert.strictEqual(res.status, 422);
});

test('dash: PUT config ticketCategories whole array validated', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: {
            updates: {
                ticketCategories: [
                    { id: 'buy', label: 'Buy', emoji: '🛒', style: 'Success', requiresKey: false },
                    { id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false }
                ]
            }
        }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.config.ticketCategories.length, 2);
    assert.strictEqual(data.config.ticketCategories[0].id, 'buy');

    // Duplicate category → 422
    const bad = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: {
            updates: {
                ticketCategories: [
                    { id: 'same', label: 'A', style: 'Primary' },
                    { id: 'same', label: 'B', style: 'Primary' }
                ]
            }
        }
    });
    assert.strictEqual(bad.status, 422);
});

test('dash: PUT config null channel — clears the value', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { updates: { 'channels.welcome': null } }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.config.channels.welcome, null);
});

// ====================================================
// === PUT automod ===
// ====================================================

test('dash: PUT automod patch validated & merged', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/automod`, {
        body: { enabled: true, spamThreshold: 7, spamAction: 'mute_10m', blockLinks: true }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.automod.enabled, true);
    assert.strictEqual(data.automod.spamThreshold, 7);
    assert.strictEqual(data.automod.spamAction, 'mute_10m');

    // A second patch does not wipe the first patch's fields (merge, not replace)
    const res2 = await api('PUT', `/guilds/${GUILD_ID}/automod`, {
        body: { blockLinks: false }
    });
    const data2 = await res2.json();
    assert.strictEqual(data2.automod.spamThreshold, 7, 'the merge keeps old fields');
    assert.strictEqual(data2.automod.blockLinks, false);
});

test('dash: PUT automod unknown field / wrong value → 422', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/automod`, {
        body: { bogusField: 1, spamThreshold: 'abc' }
    });
    assert.strictEqual(res.status, 422);
    const data = await res.json();
    assert.strictEqual(data.details.length, 2);
});

test('dash: PUT automod wordRules whole array normalized', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/automod`, {
        body: { wordRules: [{ word: 'Spam', action: 'delete_only' }, { word: 'scam' }] }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.automod.wordRules.length, 2);
    assert.strictEqual(data.automod.wordRules[0].word, 'spam', 'the word is lowercased');
});

// ====================================================
// === Responders CRUD ===
// ====================================================

test('dash: POST responder + DELETE by trigger', async () => {
    const post = await api('POST', `/guilds/${GUILD_ID}/responders`, {
        body: { trigger: 'price', reply: 'Check #price!', matchMode: 'contains', replyType: 'text', cooldownMs: 3000 }
    });
    assert.strictEqual(post.status, 201);
    let data = await post.json();
    assert.strictEqual(data.responders.length, 1);
    assert.strictEqual(data.responders[0].trigger, 'price');

    // Duplicate → 409
    const dup = await api('POST', `/guilds/${GUILD_ID}/responders`, {
        body: { trigger: 'PRICE', reply: 'duplicate' }
    });
    assert.strictEqual(dup.status, 409);

    const del = await api('DELETE', `/guilds/${GUILD_ID}/responders?trigger=price`);
    assert.strictEqual(del.status, 200);
    data = await del.json();
    assert.strictEqual(data.responders.length, 0);
});

test('dash: DELETE a responder that does not exist → 404', async () => {
    const res = await api('DELETE', `/guilds/${GUILD_ID}/responders?trigger=nosuchthing`);
    assert.strictEqual(res.status, 404);
});

// ====================================================
// === Announce CRUD ===
// ====================================================

test('dash: POST announce valid + DELETE', async () => {
    const sendAt = Date.now() + 60 * 60 * 1000; // 1 hour from now
    const post = await api('POST', `/guilds/${GUILD_ID}/announce`, {
        body: {
            channelId: '777000111222333444',
            sendAt,
            title: 'Test Announcement',
            description: 'Hello from the dashboard',
            recurring: 'daily',
            actor: { id: '42', tag: 'tester' }
        }
    });
    assert.strictEqual(post.status, 201);
    const { announcement } = await post.json();
    assert.strictEqual(announcement.data.title, 'Test Announcement');
    assert.strictEqual(announcement.recurring, 'daily');

    const del = await api('DELETE', `/guilds/${GUILD_ID}/announce/${announcement.id}`);
    assert.strictEqual(del.status, 200);
});

test('dash: POST announce with a past send time → 400', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/announce`, {
        body: { channelId: '777000111222333444', sendAt: Date.now() - 86400000, title: 'T', description: 'D' }
    });
    assert.strictEqual(res.status, 400);
});

// ====================================================
// === Self-role panel (mocked channel) ===
// ====================================================

test('dash: POST selfroles — panel created + message sent', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/selfroles`, {
        body: {
            channelId: '777000111222333444',
            title: '🎭 Get Roles',
            description: 'Click the buttons below',
            type: 'button',
            exclusive: false,
            roles: [{ roleId: '888000111222333444', label: 'Notif', emoji: '🔔', style: 'Secondary' }]
        }
    });
    assert.strictEqual(res.status, 201);
    const { panel } = await res.json();
    assert.ok(panel.id);
    assert.strictEqual(panel.messageId, panel.messageId); // filled in by the mock send
    assert.strictEqual(panel.roles.length, 1);

    // Add a role → best-effort re-render (mock) + the role sticks
    const add = await api('POST', `/guilds/${GUILD_ID}/selfroles/${panel.id}/roles`, {
        body: { roleId: '888000111222333555', label: 'Color', style: 'Success' }
    });
    assert.strictEqual(add.status, 200);
    const added = await add.json();
    assert.strictEqual(added.panel.roles.length, 2);

    // Delete the panel → ok
    const del = await api('DELETE', `/guilds/${GUILD_ID}/selfroles/${panel.id}`);
    assert.strictEqual(del.status, 200);
});

test('dash: POST selfroles send failure → the entry is rolled back', async () => {
    // A dedicated server whose client always fails the channel fetch.
    const failServer = http.createServer(
        createDashHandler({ client: makeMockClient({ failChannelFetch: true }), token: TOKEN })
    );
    await new Promise((resolve) => failServer.listen(0, '127.0.0.1', resolve));
    const failBase = `http://127.0.0.1:${failServer.address().port}`;
    try {
        const res = await fetch(`${failBase}/guilds/${GUILD_ID}/selfroles`, {
            method: 'POST',
            headers: { 'x-dash-token': TOKEN, 'content-type': 'application/json' },
            body: JSON.stringify({
                channelId: '777000111222333444',
                roles: [{ roleId: '888000111222333444', label: 'X' }]
            })
        });
        assert.strictEqual(res.status, 502);
        // Rollback: no leftover panel for this guild
        const dash = await (
            await fetch(`${failBase}/guilds/${GUILD_ID}/dashboard`, { headers: { 'x-dash-token': TOKEN } })
        ).json();
        assert.strictEqual(dash.selfroles.filter((p) => p.guildId === GUILD_ID && p.title === '🎭 Self Role' && p.roles.length === 0).length, 0);
    } finally {
        await new Promise((resolve) => failServer.close(resolve));
    }
});

// ====================================================
// === Unknown endpoint ===
// ====================================================

test('dash: unknown endpoint → 404', async () => {
    const res = await api('GET', '/no-such-path');
    assert.strictEqual(res.status, 404);
});

// ====================================================
// === v3.19.0: Command Manager ===
// ====================================================

test('dash: dashboard payload includes commands (list + disabled + protected)', async () => {
    const res = await api('GET', `/guilds/${GUILD_ID}/dashboard`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.commands.list.length, 93, 'all commands from the registry');
    assert.ok(Array.isArray(data.commands.disabled), 'disabled is always an array');
    assert.ok(data.commands.protected.includes('commands'), '/commands is disable-proof');
    // Every command has a valid domain (for Dyno-style UI grouping)
    const domains = new Set(data.commands.list.map((c) => c.domain));
    assert.ok(domains.has('config') && domains.has('moderation') && domains.has('leveling'));
});

test('dash: PUT /commands — save the disabled list', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/commands`, {
        body: { disabled: ['giveaway', 'poll', 'giveaway'] } // duplicates must be deduped
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data.disabled, ['giveaway', 'poll']);
    assert.strictEqual(data.total, 93);

    // Read back through the payload
    const dash = await (await api('GET', `/guilds/${GUILD_ID}/dashboard`)).json();
    assert.deepStrictEqual(dash.commands.disabled, ['giveaway', 'poll']);
});

test('dash: PUT /commands — unknown command → 422', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/commands`, {
        body: { disabled: ['giveaway', 'fake-command'] }
    });
    assert.strictEqual(res.status, 422);
});

test('dash: PUT /commands — /commands (protected) cannot be disabled → 422', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/commands`, {
        body: { disabled: ['commands'] }
    });
    assert.strictEqual(res.status, 422);
});

test('dash: PUT /commands — non-array → 422', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/commands`, {
        body: { disabled: 'giveaway' }
    });
    assert.strictEqual(res.status, 422);
});

test('dash: PUT /commands — reset to empty (enable all)', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/commands`, { body: { disabled: [] } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual((await res.json()).disabled, []);
});

// ====================================================
// === v3.19.0: Giveaway from the web ===
// ====================================================

test('dash: POST /giveaway — valid → 201 + entry stored', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/giveaway`, {
        body: {
            channelId: '777000111222333444',
            prize: '30 Days VIP',
            durationMin: 60,
            winners: 2
        }
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.giveaway.prize, '30 Days VIP');
    assert.strictEqual(data.giveaway.winnersCount, 2);
    assert.ok(data.giveaway.messageId, 'messageId stored after sending');
});

test('dash: POST /giveaway — invalid duration → 400', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/giveaway`, {
        body: { channelId: '777000111222333444', prize: 'X', durationMin: 0, winners: 1 }
    });
    assert.strictEqual(res.status, 400);
});

test('dash: POST /giveaway — empty prize → 400', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/giveaway`, {
        body: { channelId: '777000111222333444', prize: '', durationMin: 10, winners: 1 }
    });
    assert.strictEqual(res.status, 400);
});

// ====================================================
// === v3.19.0: Poll from the web ===
// ====================================================

test('dash: POST /poll — valid → 201', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/poll`, {
        body: {
            channelId: '777000111222333444',
            question: 'What is for lunch today?',
            multiple: false,
            options: [{ label: 'Pizza' }, { label: 'Burger' }, { label: 'Sushi' }]
        }
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.poll.options.length, 3);
    assert.ok(data.poll.messageId);
});

test('dash: POST /poll — fewer than 2 options → 400', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/poll`, {
        body: { channelId: '777000111222333444', question: 'Q?', options: [{ label: 'only one' }] }
    });
    assert.strictEqual(res.status, 400);
});

// ====================================================
// === v3.19.0: Embed from the web ===
// ====================================================

test('dash: POST /embed — valid → 201', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/embed`, {
        body: {
            channelId: '777000111222333444',
            title: 'Announcement',
            description: 'Hello **everyone**!',
            color: 0xf1c40f,
            footer: 'From the web dashboard'
        }
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.ok(data.messageId);
});

test('dash: POST /embed — no title & no description → 400', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/embed`, {
        body: { channelId: '777000111222333444', title: '', description: '' }
    });
    assert.strictEqual(res.status, 400);
});

// ====================================================
// === v3.19.0: Backup (invalid name restore is safe) ===
// ====================================================

test('dash: POST /backups/:name/restore — invalid name → 422 (no side effects)', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/backups/not-a-valid-format/restore`, { body: {} });
    assert.strictEqual(res.status, 422);
});

// ====================================================
// === v3.19.0: Keys from the web ===
// ====================================================

test('dash: POST /keys — product without a role → 422', async () => {
    // Set up a product WITHOUT a roleId first
    const put = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { updates: { products: [{ label: '30 Days VIP', value: 'vip30', price: '25000' }] } }
    });
    assert.strictEqual(put.status, 200, 'product setup via config');

    const res = await api('POST', `/guilds/${GUILD_ID}/keys`, {
        body: { userId: '111222333444555666', value: 'vip30' }
    });
    assert.strictEqual(res.status, 422);
});

test('dash: POST /keys — product with a role → 201 + key visible in the payload', async () => {
    // Product with roleId + days (v3.19.0: roleId is now preserved by the validator)
    const put = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: {
            updates: {
                products: [
                    { label: '30 Days VIP', value: 'vip30', price: '25000', roleId: '888000111222333444', days: 30 }
                ]
            }
        }
    });
    assert.strictEqual(put.status, 200, 'product + role setup');

    const res = await api('POST', `/guilds/${GUILD_ID}/keys`, {
        body: { userId: '111222333444555666', value: 'vip30', key: 'TESTK-EY001-ABCDE' }
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.key, 'TESTK-EY001-ABCDE');
    assert.ok(data.expireAt > Date.now(), 'expireAt computed from the product days');

    // Visible in the dashboard payload
    const dash = await (await api('GET', `/guilds/${GUILD_ID}/dashboard`)).json();
    assert.strictEqual(dash.keys.length, 1);
    assert.strictEqual(dash.keys[0].key, 'TESTK-EY001-ABCDE');
});

test('dash: DELETE /keys?userId — remove key + schedule → 200', async () => {
    const res = await api('DELETE', `/guilds/${GUILD_ID}/keys?userId=111222333444555666`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.removedKeys, 1);

    const dash = await (await api('GET', `/guilds/${GUILD_ID}/dashboard`)).json();
    assert.strictEqual(dash.keys.length, 0, 'key gone from the payload');
});

// ====================================================
// === v3.19.0: products validator keeps roleId ===
// ====================================================

test('dash: PUT config products — roleId & days preserved (v3.19.0 data loss fix)', async () => {
    const put = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: {
            updates: {
                products: [
                    { label: 'VIP', value: 'vip1', price: '10000', roleId: '888000111222333444', days: 7 }
                ]
            }
        }
    });
    assert.strictEqual(put.status, 200);
    const data = await put.json();
    assert.strictEqual(data.config.products[0].roleId, '888000111222333444', 'roleId not lost');
    assert.strictEqual(data.config.products[0].days, 7, 'days not lost');
});

test('dash: PUT config products — invalid roleId → 422', async () => {
    const res = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: {
            updates: { products: [{ label: 'VIP', value: 'vip2', price: '10000', roleId: 'not-an-id' }] }
        }
    });
    assert.strictEqual(res.status, 422);
});

// ====================================================
// === v3.21.0: Quick Start — install panels from the web ===
// ====================================================

test('dash: POST /panels without roles.admin → 422 (parity with /setup-ticket-panel)', async () => {
    // Prerequisites identical to the slash command: the admin role is required before a ticket panel.
    await api('PUT', `/guilds/${GUILD_ID}/config`, { body: { updates: { 'roles.admin': null } } });
    const res = await api('POST', `/guilds/${GUILD_ID}/panels`, {
        body: { channelId: '777000111222333444', actor: { id: '42', tag: 'tester' } }
    });
    assert.strictEqual(res.status, 422);
    assert.match((await res.json()).error, /Admin role/i);
});

test('dash: POST /panels valid → 201 + panel recorded + payload.panels slim shape', async () => {
    await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { updates: { 'roles.admin': '888000111222333555' } }
    });
    const res = await api('POST', `/guilds/${GUILD_ID}/panels`, {
        body: {
            channelId: '777000111222333444',
            title: 'PANEL FROM WEB',
            useDropdown: true,
            actor: { id: '42', tag: 'tester' }
        }
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.ok(data.ok);
    assert.ok(data.panel.id, 'panel gets an id (tp_...)');
    assert.strictEqual(data.panel.channelId, '777000111222333444');
    assert.strictEqual(data.panel.useDropdown, true);
    assert.ok(Array.isArray(data.panel.categoryIds) && data.panel.categoryIds.length > 0);
    assert.strictEqual(typeof data.panel.messageId, 'string');

    // The panel shows up in the dashboard payload — slim shape (no 4000-char body)
    const dash = await (await api('GET', `/guilds/${GUILD_ID}/dashboard`)).json();
    const slim = dash.panels.find((p) => p.id === data.panel.id);
    assert.ok(slim, 'panel must appear in payload.panels');
    assert.ok(!('body' in slim), 'payload.panels must be the slim shape (without body)');

    // The physical file records it too — source of truth for /update-panel & /refresh-panel
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'panels.json'), 'utf8'));
    assert.ok(raw[data.panel.id], 'panel saved in panels.json');
});

test('dash: POST /panels categoryIds with no match → 400', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/panels`, {
        body: { channelId: '777000111222333444', categoryIds: ['does-not-exist'], actor: { id: '42', tag: 'tester' } }
    });
    assert.strictEqual(res.status, 400);
});

test('dash: POST /verify-panel without roles.verified → 422 (parity with /setup-verify)', async () => {
    await api('PUT', `/guilds/${GUILD_ID}/config`, { body: { updates: { 'roles.verified': null } } });
    const res = await api('POST', `/guilds/${GUILD_ID}/verify-panel`, {
        body: { channelId: '777000111222333444', actor: { id: '42', tag: 'tester' } }
    });
    assert.strictEqual(res.status, 422);
    assert.match((await res.json()).error, /Verified role/i);
});

test('dash: POST /verify-panel valid → 201 (embed + verification button sent)', async () => {
    await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { updates: { 'roles.verified': '888000111222333444' } }
    });
    const res = await api('POST', `/guilds/${GUILD_ID}/verify-panel`, {
        body: { channelId: '777000111222333444', actor: { id: '42', tag: 'tester' } }
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.ok(data.ok);
    assert.strictEqual(typeof data.messageId, 'string');
});
