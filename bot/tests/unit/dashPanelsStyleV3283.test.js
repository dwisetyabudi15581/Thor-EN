/**
 * Unit tests v3.28.3 — ticket-panel style editing from the web dashboard.
 *
 * Covers the two halves of the fix:
 *   1. PUT /guilds/:id/panels/:panelId with a PARTIAL body — fields absent
 *      from the body are left untouched (the web editor now only sends the
 *      fields the admin actually touched, so it must never wipe overrides it
 *      never displayed).
 *   2. GET /guilds/:id/dashboard — payload.panels carries presence flags
 *      (hasBody/hasColor/hasImage/hasThumbnail/hasFooter) so the web editor
 *      can show which overrides exist (values stay bot-side; slim shape).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const dataDir = path.join(__dirname, '..', '..', 'data');
const configDir = path.join(dataDir, 'config');

// panels.json + config are snapshotted & restored (pattern from dashServer.test.js)
const TOUCHED = ['panels.json'];
const backups = {};
for (const f of TOUCHED) {
    const p = path.join(dataDir, f);
    backups[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
    fs.writeFileSync(p, '{}');
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
            for (const b of configDirBackup) {
                fs.writeFileSync(path.join(configDir, b.name), b.content);
            }
        }
    } catch (_) {}
});

const { createDashHandler } = require('../../src/infra/dashServer');

const TOKEN = 'unit-test-token-v3283';
const GUILD_ID = '999111222333444555';
const CHANNEL_ID = '777000111222333444';
const ADMIN_ROLE_ID = '888000111222333555';

// === Mock discord.js client (same shape as dashServer.test.js) ===
function makeMockClient() {
    const guild = {
        id: GUILD_ID,
        name: 'Test Server',
        icon: 'abc123',
        memberCount: 42,
        ownerId: '111000111000111000',
        channels: {
            cache: new Map([
                [CHANNEL_ID, { id: CHANNEL_ID, name: 'general', type: 0, rawPosition: 1, send: async (opts) => ({ id: 'msg_panel_install', opts }) }]
            ])
        },
        roles: {
            cache: new Map([
                ['888000111222333444', { id: '888000111222333444', name: 'Member', color: 0, position: 1 }],
                [ADMIN_ROLE_ID, { id: ADMIN_ROLE_ID, name: 'Admin', color: 0xff0000, position: 5 }]
            ])
        },
        members: {
            me: { roles: { highest: { position: 10 } } },
            fetch: async (id) => ({
                id,
                user: { id, tag: 'Tester#0001' },
                roles: { cache: new Map(), add: async () => {}, remove: async () => {} }
            })
        }
    };
    return {
        isReady: () => true,
        guilds: { cache: new Map([[GUILD_ID, guild]]) },
        channels: {
            fetch: async (id) => ({
                id,
                type: 0,
                send: async (opts) => ({ id: `msg_${Date.now()}`, opts, url: 'https://discord.com/channels/x/y' }),
                messages: {
                    fetch: async () => ({ edit: async () => {}, delete: async () => {} })
                }
            })
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

async function installPanel() {
    // Prerequisite (same as /setup-ticket-panel): the admin role must be set.
    await api('PUT', `/guilds/${GUILD_ID}/config`, { body: { updates: { 'roles.admin': ADMIN_ROLE_ID } } });
    const res = await api('POST', `/guilds/${GUILD_ID}/panels`, {
        body: { channelId: CHANNEL_ID, actor: { id: '42', tag: 'tester' } }
    });
    assert.strictEqual(res.status, 201);
    const { panel } = await res.json();
    assert.ok(panel.id, 'panel gets an id');
    return panel.id;
}

// ====================================================
// === 1. PUT /panels/:panelId — partial body semantics ===
// ====================================================

test('v3.28.3: PUT /panels with ALL style fields set → overrides stored', async () => {
    const id = await installPanel();
    const res = await api('PUT', `/guilds/${GUILD_ID}/panels/${id}`, {
        body: {
            title: 'OVERRIDE TITLE',
            body: 'Custom body with {price_list}',
            color: '#e67e22',
            image: 'https://example.com/banner.png',
            thumbnail: 'https://example.com/thumb.png',
            footer: 'Footer text',
            actor: { id: '42', tag: 'tester' }
        }
    });
    assert.strictEqual(res.status, 200);
    const { panel } = await res.json();
    assert.strictEqual(panel.title, 'OVERRIDE TITLE');
    assert.strictEqual(panel.body, 'Custom body with {price_list}');
    assert.strictEqual(panel.color, 0xe67e22);
    assert.strictEqual(panel.imageUrl, 'https://example.com/banner.png');
    assert.strictEqual(panel.thumbnailUrl, 'https://example.com/thumb.png');
    assert.strictEqual(panel.footerText, 'Footer text');
});

test('v3.28.3: PUT /panels with ONLY title → other overrides PRESERVED (the web editor contract)', async () => {
    // The web style editor now sends only the fields the admin touched. A
    // title-only PUT must never wipe body/color/image/thumbnail/footer —
    // the old web code sent every field and cleared the ones it never showed.
    const id = await installPanel();
    await api('PUT', `/guilds/${GUILD_ID}/panels/${id}`, {
        body: {
            title: 'OVERRIDE TITLE',
            body: 'Custom body with {price_list}',
            color: '#e67e22',
            image: 'https://example.com/banner.png',
            thumbnail: 'https://example.com/thumb.png',
            footer: 'Footer text',
            actor: { id: '42', tag: 'tester' }
        }
    });
    // Title-only edit — exactly what the fixed web editor sends when the
    // admin only touched the title field.
    const res = await api('PUT', `/guilds/${GUILD_ID}/panels/${id}`, {
        body: { title: 'NEW TITLE ONLY', actor: { id: '42', tag: 'tester' } }
    });
    assert.strictEqual(res.status, 200);
    const { panel } = await res.json();
    assert.strictEqual(panel.title, 'NEW TITLE ONLY');
    assert.strictEqual(panel.body, 'Custom body with {price_list}', 'body override survives a title-only PUT');
    assert.strictEqual(panel.color, 0xe67e22, 'color override survives');
    assert.strictEqual(panel.imageUrl, 'https://example.com/banner.png', 'image override survives');
    assert.strictEqual(panel.thumbnailUrl, 'https://example.com/thumb.png', 'thumbnail override survives');
    assert.strictEqual(panel.footerText, 'Footer text', 'footer override survives');
});

test('v3.28.3: PUT /panels with an explicit empty body string clears ONLY that field', async () => {
    const id = await installPanel();
    await api('PUT', `/guilds/${GUILD_ID}/panels/${id}`, {
        body: {
            title: 'T',
            body: 'keep me',
            footer: 'keep me too',
            actor: { id: '42', tag: 'tester' }
        }
    });
    const res = await api('PUT', `/guilds/${GUILD_ID}/panels/${id}`, {
        body: { body: '', actor: { id: '42', tag: 'tester' } }
    });
    assert.strictEqual(res.status, 200);
    const { panel } = await res.json();
    assert.strictEqual(panel.body, null, 'body cleared by an explicit empty string');
    assert.strictEqual(panel.footerText, 'keep me too', 'footer untouched by the same PUT');
    assert.strictEqual(panel.title, 'T', 'title untouched');
});

// ====================================================
// === 2. Dashboard payload — presence flags ===
// ====================================================

test('v3.28.3: GET /dashboard — payload.panels carries presence flags (slim, no values)', async () => {
    const id = await installPanel();
    await api('PUT', `/guilds/${GUILD_ID}/panels/${id}`, {
        body: {
            title: 'T',
            body: 'has body',
            color: '#ff0000',
            image: 'https://example.com/i.png',
            footer: 'has footer',
            actor: { id: '42', tag: 'tester' }
        }
    });
    const dash = await (await api('GET', `/guilds/${GUILD_ID}/dashboard`)).json();
    const slim = dash.panels.find((p) => p.id === id);
    assert.ok(slim, 'panel appears in payload.panels');
    assert.strictEqual(slim.title, 'T');
    assert.strictEqual(slim.hasBody, true);
    assert.strictEqual(slim.hasColor, true);
    assert.strictEqual(slim.hasImage, true);
    assert.strictEqual(slim.hasThumbnail, false, 'no thumbnail override was set');
    assert.strictEqual(slim.hasFooter, true);
    // Slim shape preserved — the override VALUES never ship in the payload.
    assert.ok(!('body' in slim), 'payload.panels stays slim (no body value)');
    assert.ok(!('imageUrl' in slim) && !('thumbnailUrl' in slim) && !('footerText' in slim), 'no style values in the slim shape');
});

test('v3.28.3: flags flip back to false when every override is cleared', async () => {
    const id = await installPanel();
    await api('PUT', `/guilds/${GUILD_ID}/panels/${id}`, {
        body: {
            title: 'T',
            body: 'x',
            color: '#ff0000',
            image: 'https://example.com/i.png',
            thumbnail: 'https://example.com/t.png',
            footer: 'y',
            actor: { id: '42', tag: 'tester' }
        }
    });
    await api('PUT', `/guilds/${GUILD_ID}/panels/${id}`, {
        body: { body: '', color: '', image: '', thumbnail: '', footer: '', actor: { id: '42', tag: 'tester' } }
    });
    const dash = await (await api('GET', `/guilds/${GUILD_ID}/dashboard`)).json();
    const slim = dash.panels.find((p) => p.id === id);
    assert.strictEqual(slim.hasBody, false);
    assert.strictEqual(slim.hasColor, false);
    assert.strictEqual(slim.hasImage, false);
    assert.strictEqual(slim.hasThumbnail, false);
    assert.strictEqual(slim.hasFooter, false);
});
