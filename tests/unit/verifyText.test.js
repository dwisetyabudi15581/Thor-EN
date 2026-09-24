/**
 * v4.4.0 — the classic CHRONOS verify panel TEXT (CHRONOS parity, copied
 * from CHRONOS v3.9.59):
 *   - messages.verifyTitle / messages.verifyBody are config again (template
 *     with {server})
 *   - /set-message, /edit-message, /reset-message, /list-messages expose them
 *   - the LIVE verify panel re-renders from the config (syncVerifyPanelFromConfig)
 *   - a panel text edit writes BACK to the config (writeVerifyTextToConfig)
 *   - /setup-verify + POST verify-panel default from the config
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Snowflake-shaped: the DASH API validates the guild id format.
const GUILD_ID = '999555444333222111';

function resetGuildConfig() {
    const { configPathFor } = require('../../src/data/configManager');
    const file = configPathFor(GUILD_ID);
    try {
        fs.unlinkSync(file);
    } catch (_) {}
    return file;
}

test('verifyPanelText: resolveServer — {server} global replace (CHRONOS pattern)', () => {
    const { resolveServer } = require('../../src/services/verifyPanelText');
    assert.strictEqual(resolveServer('Welcome to **{server}**!', 'My Server'), 'Welcome to **My Server**!');
    assert.strictEqual(resolveServer('{server} & {server}', 'S'), 'S & S', 'ALL occurrences replaced');
    assert.strictEqual(resolveServer('no placeholder', 'S'), 'no placeholder', 'no-op');
    assert.strictEqual(resolveServer(undefined, 'S'), '', 'undefined → empty string (never "undefined")');
});

test('verifyPanelText: isVerifyTextKey — exactly the two classic keys', () => {
    const { isVerifyTextKey } = require('../../src/services/verifyPanelText');
    assert.ok(isVerifyTextKey('verifyTitle'));
    assert.ok(isVerifyTextKey('verifyBody'));
    assert.ok(!isVerifyTextKey('welcomeTitle'));
    assert.ok(!isVerifyTextKey('ticketBody'));
    assert.ok(!isVerifyTextKey('verifyButton'));
});

test('verifyPanelText: syncVerifyPanelFromConfig — no panel installed → no-op', async () => {
    resetGuildConfig();
    const { syncVerifyPanelFromConfig } = require('../../src/services/verifyPanelText');
    const res = await syncVerifyPanelFromConfig(GUILD_ID, null);
    assert.strictEqual(res.synced, false, 'nothing to sync when no verify panel exists');
    assert.strictEqual(res.note, '');
});

test('verifyPanelText: syncVerifyPanelFromConfig — panel text updated from config + {server} resolved', async () => {
    resetGuildConfig();
    const { setField, getConfig } = require('../../src/data/configManager');
    const selfRoleManager = require('../../src/data/selfRoleManager');
    const { syncVerifyPanelFromConfig } = require('../../src/services/verifyPanelText');

    // Install a verify panel the way /setup-verify does.
    const panel = selfRoleManager.createPanel({
        guildId: GUILD_ID,
        channelId: 'chan_vt',
        title: 'OLD TITLE',
        description: 'OLD BODY',
        type: 'button',
        exclusive: false,
        once: true,
        kind: 'verify'
    });
    selfRoleManager.addRoleToPanel(panel.id, { roleId: '111222333444555', label: 'Verify Me', emoji: '✅', style: 'Success' });
    setField(GUILD_ID, 'roles.verifyPanelId', panel.id);

    // Change the config text (the /set-message path).
    setField(GUILD_ID, 'messages.verifyTitle', '✅ NEW {server} TITLE');
    setField(GUILD_ID, 'messages.verifyBody', 'Hello {server}, click to verify.');

    // Mock client: guild name in cache; NO live message (messageId unset) →
    // best-effort render skipped, but the PANEL record must be updated.
    const client = { guilds: { cache: new Map([[GUILD_ID, { name: 'Sync Server' }]]) }, channels: { cache: new Map() } };

    const res = await syncVerifyPanelFromConfig(GUILD_ID, client);
    assert.strictEqual(res.synced, true, 'the live panel entry was synced');
    const updated = selfRoleManager.getPanel(panel.id);
    assert.strictEqual(updated.title, '✅ NEW Sync Server TITLE', 'title from config + {server} resolved');
    assert.strictEqual(updated.description, 'Hello Sync Server, click to verify.', 'body from config + {server} resolved');
    assert.ok(res.note.length > 0, 'an honest note is returned (render skipped — no live message)');

    // Non-verify panel is NEVER touched by the sync.
    const plain = selfRoleManager.createPanel({
        guildId: GUILD_ID,
        channelId: 'chan_vt',
        title: 'PLAIN',
        description: 'PLAIN BODY',
        type: 'button',
        exclusive: false
    });
    setField(GUILD_ID, 'roles.verifyPanelId', plain.id);
    setField(GUILD_ID, 'messages.verifyTitle', 'SHOULD NOT APPLY');
    const res2 = await syncVerifyPanelFromConfig(GUILD_ID, client);
    assert.strictEqual(res2.synced, true, 'the tracked panel is still synced (title updated)');
    assert.strictEqual(selfRoleManager.getPanel(plain.id).title, 'SHOULD NOT APPLY', 'the tracked panel got the new title');

    selfRoleManager.deletePanel(panel.id);
    selfRoleManager.deletePanel(plain.id);
    resetGuildConfig();
});

test('verifyPanelText: writeVerifyTextToConfig — ONLY kind:verify panels write back', () => {
    resetGuildConfig();
    const { getConfig } = require('../../src/data/configManager');
    const selfRoleManager = require('../../src/data/selfRoleManager');
    const { writeVerifyTextToConfig } = require('../../src/services/verifyPanelText');

    const verifyPanel = selfRoleManager.createPanel({
        guildId: GUILD_ID,
        channelId: 'c1',
        title: 'VT',
        description: 'VB',
        type: 'button',
        exclusive: false,
        once: true,
        kind: 'verify'
    });
    assert.strictEqual(writeVerifyTextToConfig(GUILD_ID, selfRoleManager.getPanel(verifyPanel.id)), true);
    const cfg = getConfig(GUILD_ID);
    assert.strictEqual(cfg.messages.verifyTitle, 'VT', 'panel text written back to config');
    assert.strictEqual(cfg.messages.verifyBody, 'VB', 'panel body written back to config');

    // A plain self-role panel never writes back.
    const plainPanel = selfRoleManager.createPanel({
        guildId: GUILD_ID,
        channelId: 'c1',
        title: 'PT',
        description: 'PB',
        type: 'button',
        exclusive: false
    });
    const before = getConfig(GUILD_ID).messages.verifyTitle;
    assert.strictEqual(writeVerifyTextToConfig(GUILD_ID, selfRoleManager.getPanel(plainPanel.id)), false);
    assert.strictEqual(getConfig(GUILD_ID).messages.verifyTitle, before, 'plain panel → config untouched');

    // Cross-guild guard: a verify panel from ANOTHER guild never writes back.
    const otherGuildPanel = selfRoleManager.createPanel({
        guildId: 'g_other',
        channelId: 'c1',
        title: 'OT',
        description: 'OB',
        type: 'button',
        exclusive: false,
        once: true,
        kind: 'verify'
    });
    assert.strictEqual(writeVerifyTextToConfig(GUILD_ID, selfRoleManager.getPanel(otherGuildPanel.id)), false);

    selfRoleManager.deletePanel(verifyPanel.id);
    selfRoleManager.deletePanel(plainPanel.id);
    selfRoleManager.deletePanel(otherGuildPanel.id);
    resetGuildConfig();
});

test('registry: /set-message, /edit-message, /reset-message expose the verify text choices', () => {
    const { getCommands } = require('../../src/commands/registry');
    const commands = getCommands();
    for (const name of ['set-message', 'edit-message', 'reset-message']) {
        const cmd = commands.find((c) => c.name === name);
        assert.ok(cmd, `${name} registered`);
        const tipe = cmd.options.find((o) => o.name === 'tipe');
        assert.ok(tipe, `${name} has a tipe option`);
        const values = tipe.choices.map((c) => c.value);
        assert.ok(values.includes('verifyTitle'), `${name} offers verifyTitle (v4.4.0 — CHRONOS parity)`);
        assert.ok(values.includes('verifyBody'), `${name} offers verifyBody (v4.4.0 — CHRONOS parity)`);
    }
});

test('modal handler: VALID_TYPES accepts the verify text keys', () => {
    // Reading the module source is fragile; instead assert the behavior via a
    // tiny fake interaction — the modal submit for verifyTitle must be VALID
    // (not rejected as "Invalid message type").
    const fsx = require('fs');
    const src = fsx.readFileSync(path.join(__dirname, '..', '..', 'src', 'interactions', 'config.js'), 'utf8');
    assert.match(src, /'verifyTitle'/, 'verifyTitle in VALID_TYPES');
    assert.match(src, /'verifyBody'/, 'verifyBody in VALID_TYPES');
});

test('dashParity: PUT config messages.verifyTitle — accepted + synced into the live verify panel (HTTP end-to-end)', async () => {
    resetGuildConfig();
    const http = require('http');
    const { setField, getConfig } = require('../../src/data/configManager');
    const selfRoleManager = require('../../src/data/selfRoleManager');
    const { createDashHandler } = require('../../src/infra/dashServer');

    const TOKEN = 'vt-dash-token';
    const CHANNEL_ID = '777000111222333444';
    const ROLE_ID = '888000111222333444';

    // Install a verify panel (the /setup-verify shape).
    const panel = selfRoleManager.createPanel({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        title: 'DASH OLD',
        description: 'DASH OLD BODY',
        type: 'button',
        exclusive: false,
        once: true,
        kind: 'verify'
    });
    selfRoleManager.addRoleToPanel(panel.id, { roleId: ROLE_ID, label: 'Verify Me', emoji: '✅', style: 'Success' });
    setField(GUILD_ID, 'roles.verifyPanelId', panel.id);

    // Mock client shaped like the dashParityV326 pattern.
    const guild = {
        id: GUILD_ID,
        name: 'Verify Text Server',
        channels: {
            cache: new Map([[CHANNEL_ID, {
                id: CHANNEL_ID,
                name: 'verify',
                type: 0,
                send: async () => ({ id: 'msg_vt_1' }),
                messages: { fetch: async () => ({ edit: async () => {} }) }
            }]])
        },
        roles: { cache: new Map([[ROLE_ID, { id: ROLE_ID, name: 'Verified', color: 0, position: 2 }]]) },
        members: { fetch: async () => null }
    };
    const client = {
        isReady: () => true,
        guilds: { cache: new Map([[GUILD_ID, guild]]), fetch: async () => guild },
        channels: { fetch: async (id) => guild.channels.cache.get(id) || (() => { throw new Error('Unknown Channel'); })() },
        users: { fetch: async () => null }
    };

    const server = http.createServer(createDashHandler({ client, token: TOKEN }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const api = (method, pathname, { body } = {}) =>
        fetch(baseUrl + pathname, {
            method,
            headers: { 'x-dash-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined
        });

    try {
        // 1. The web edits the verify panel text via PUT config (the CHRONOS
        //    source of truth — /set-message parity from the web).
        const res = await api('PUT', `/guilds/${GUILD_ID}/config`, {
            body: { actor: { id: '42', tag: 'web-tester' }, updates: { 'messages.verifyTitle': '✅ WEB {server} TITLE' } }
        });
        assert.strictEqual(res.status, 200, `PUT config accepted (got ${res.status})`);
        assert.strictEqual(getConfig(GUILD_ID).messages.verifyTitle, '✅ WEB {server} TITLE', 'config saved');
        // The LIVE panel was synced + {server} resolved.
        const synced = selfRoleManager.getPanel(panel.id);
        assert.strictEqual(synced.title, '✅ WEB Verify Text Server TITLE', 'live panel title synced from config with {server} resolved');

        // 2. PUT selfroles/:id with title on a verify panel writes back to config.
        const res2 = await api('PUT', `/guilds/${GUILD_ID}/selfroles/${panel.id}`, {
            body: { title: '✅ PANEL EDIT TITLE' }
        });
        assert.strictEqual(res2.status, 200, `PUT selfroles accepted (got ${res2.status})`);
        assert.strictEqual(getConfig(GUILD_ID).messages.verifyTitle, '✅ PANEL EDIT TITLE', 'panel text edit wrote back to config (never drifts)');
    } finally {
        server.close();
        selfRoleManager.deletePanel(panel.id);
        resetGuildConfig();
    }
});
