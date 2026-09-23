/**
 * Unit tests v3.28.0 — /setup-verify (the verification feature is BACK).
 *
 * History: the dedicated verification feature was removed in v3.22.0
 * ("verified is just another role on a self-role panel") and the owner
 * asked for it back. v3.28.0 re-adds it as a WIZARD over the v3.27.0
 * one-way self-role panel.
 *
 * What is tested:
 *   1. Registry contract: /setup-verify registered, admin-gated, role
 *      option required, 95 commands total, routed to the selfrole domain.
 *   2. Handler happy path: creates a ONE-WAY panel with the Verified role
 *      as its single button, sends the message, saves roles.verified +
 *      roles.verifyPanelId, replies with the one-way explanation.
 *   3. Duplicate guard: a second /setup-verify while the panel is alive
 *      → guidance, NO second panel.
 *   4. Stale entry: verifyPanelId pointing at a deleted panel → guard
 *      self-clears, install proceeds.
 *   5. Validation: @everyone / managed / above-bot roles rejected.
 *   6. /selfrole-delete on the verify panel → clears roles.verified +
 *      roles.verifyPanelId (the ticket/escrow gate never points at a
 *      role nobody can obtain).
 *   7. DASH API: POST verify-panel → 201 + one-way panel + config saved;
 *      duplicate → 409; invalid role → 400; DELETE selfroles/:id clears
 *      the verify config too.
 *   8. PUT config: roles.verified accepted again (snowflake);
 *      roles.unverified still 422; roles.verifyPanelId rejected (managed).
 *
 * Data safety: selfRoles.json + the guild config file are snapshotted &
 * restored (established pattern).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

// === Snapshot & restore selfRoles.json ===
const dataDir = path.join(__dirname, '..', '..', 'data');
const selfRolesPath = path.join(dataDir, 'selfRoles.json');
const backup = fs.existsSync(selfRolesPath) ? fs.readFileSync(selfRolesPath) : null;
if (backup === null) fs.writeFileSync(selfRolesPath, '[]');

const configManager = require('../../src/data/configManager');
const guildConfigPath = configManager.configPathFor
    ? configManager.configPathFor('999111222333444555')
    : path.join(dataDir, 'config', '999111222333444555.json');
const configBackup = fs.existsSync(guildConfigPath) ? fs.readFileSync(guildConfigPath) : null;
if (configBackup === null) {
    fs.mkdirSync(path.dirname(guildConfigPath), { recursive: true });
    fs.writeFileSync(guildConfigPath, JSON.stringify({}));
}

process.on('exit', () => {
    try {
        if (backup === null) {
            if (fs.existsSync(selfRolesPath)) fs.unlinkSync(selfRolesPath);
        } else {
            fs.writeFileSync(selfRolesPath, backup);
        }
        if (configBackup === null) {
            if (fs.existsSync(guildConfigPath)) fs.unlinkSync(guildConfigPath);
        } else {
            fs.writeFileSync(guildConfigPath, configBackup);
        }
    } catch (_) {}
});

const selfRoleManager = require('../../src/data/selfRoleManager');
const selfroleCommand = require('../../src/commands/selfrole');
const { createDashHandler } = require('../../src/infra/dashServer');

// 18-digit snowflake-shaped IDs
const GUILD_ID = '999111222333444555';
const CHANNEL_ID = '555444333222111000';
const ROLE_VERIFIED = '111222333444555666';
const ROLE_HIGH = '444555666777888999';

// === Guild role cache shared by the mocks ===
const guildRoles = new Map();
for (const [id, name, position] of [
    [ROLE_VERIFIED, 'Verified', 1],
    [ROLE_HIGH, 'HighRole', 50]
]) {
    guildRoles.set(id, { id, name, managed: false, position });
}
guildRoles.set(GUILD_ID, { id: GUILD_ID, name: '@everyone', managed: false, position: 0 });

/** Reset the guild config to a clean slate (no verified role, no verify panel). */
function resetGuildConfig() {
    fs.writeFileSync(
        guildConfigPath,
        JSON.stringify({ roles: { admin: null, midman: null, booster: null }, channels: {}, messages: {} })
    );
}

/** Interaction mock shaped for the selfrole COMMAND handler. */
function makeCommandInteraction({ roleId = ROLE_VERIFIED, channelId = null, rolePos = 1, managed = false } = {}) {
    const replies = [];
    const sent = [];
    const everyoneRole = { id: GUILD_ID, name: '@everyone', managed: false, position: 0 };
    const pickedRole =
        roleId === GUILD_ID
            ? everyoneRole
            : { id: roleId, name: guildRoles.get(roleId)?.name || 'Role', managed, position: rolePos };

    const targetChannel = { id: channelId || CHANNEL_ID, type: 0, send: async (opts) => { sent.push(opts); return { id: `msg_${Date.now()}` }; } };

    return {
        replies,
        sent,
        commandName: 'setup-verify',
        guildId: GUILD_ID,
        guild: {
            id: GUILD_ID,
            name: 'Verify Test Server',
            members: { me: { roles: { highest: { position: 10 } } } },
            channels: { cache: new Map([[targetChannel.id, targetChannel]]) }
        },
        channel: targetChannel,
        client: { user: { username: 'ThorTest', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' } },
        user: { id: 'admin_user', tag: 'admin#0001' },
        options: {
            getRole: () => pickedRole,
            getChannel: () => (channelId ? targetChannel : null),
            getString: (name) =>
                name === 'button_label' ? 'Verify Me' : name === 'button_emoji' ? '✅' : name === 'button_style' ? 'Success' : null
        },
        deferReply: async () => {},
        editReply: async (opts) => {
            replies.push(opts);
            return {};
        }
    };
}

// ====================================================
// === 1. Registry + routing contract ===
// ====================================================

test('contract: /setup-verify registered, admin-gated, role required, routed to selfrole', () => {
    const { getCommands } = require('../../src/commands/registry');
    const cmds = getCommands();
    // v4.2.0: 95 → 96 — /set-verify-button RESTORED (CHRONOS parity, Tahap 1).
    assert.strictEqual(cmds.length, 96, '96 commands (v4.2.0 — set-verify-button restored)');
    const svb = cmds.find((c) => c.name === 'set-verify-button');
    assert.ok(svb, 'set-verify-button is registered (v4.2.0)');
    assert.strictEqual(svb.defaultMemberPermissions !== undefined, true, 'set-verify-button is admin-gated');
    const svbLabel = (svb.options || []).find((o) => o.name === 'label');
    assert.ok(svbLabel && svbLabel.required, 'label is required');
    const cmd = cmds.find((c) => c.name === 'setup-verify');
    assert.ok(cmd, 'setup-verify is registered');
    assert.strictEqual(cmd.defaultMemberPermissions !== undefined, true, 'admin-gated');
    const roleOpt = (cmd.options || []).find((o) => o.name === 'role');
    assert.ok(roleOpt, 'role option present');
    assert.strictEqual(roleOpt.type, 8, 'role is a ROLE option');
    assert.strictEqual(roleOpt.required, true, 'role is required');

    // Routed to the selfrole domain.
    const { COMMAND_TO_DOMAIN } = require('../../src/commands/index');
    assert.strictEqual(COMMAND_TO_DOMAIN['setup-verify'], 'selfrole');
});

// ====================================================
// === 2. Handler happy path ===
// ====================================================

test('handler: /setup-verify creates a ONE-WAY panel + saves the Verified role', async () => {
    resetGuildConfig();

    const ix = makeCommandInteraction({});
    await selfroleCommand(ix);

    // One reply, the success one.
    assert.strictEqual(ix.replies.length, 1);
    assert.match(ix.replies[0].content, /Verification panel installed/i);
    assert.match(ix.replies[0].content, /One-way/i, 'the reply explains the one-way mode');

    // The panel: one-way, single role, message sent.
    const config = configManager.getConfig(GUILD_ID);
    assert.ok(config.roles.verifyPanelId, 'roles.verifyPanelId saved');
    assert.strictEqual(config.roles.verified, ROLE_VERIFIED, 'roles.verified saved');
    const panel = selfRoleManager.getPanel(config.roles.verifyPanelId);
    assert.ok(panel, 'the panel exists');
    assert.strictEqual(panel.once, true, 'the panel is ONE-WAY');
    assert.strictEqual(panel.type, 'button');
    assert.strictEqual(panel.roles.length, 1, 'a single role button');
    assert.strictEqual(panel.roles[0].roleId, ROLE_VERIFIED);
    assert.strictEqual(panel.roles[0].label, 'Verify Me');
    assert.strictEqual(ix.sent.length, 1, 'the panel message was sent to the channel');
    assert.ok(panel.messageId, 'messageId recorded');

    // Cleanup for the next test.
    selfRoleManager.deletePanel(panel.id);
});

// ====================================================
// === 3. Duplicate guard ===
// ====================================================

test('handler: second /setup-verify while installed → guidance, no second panel', async () => {
    const ix1 = makeCommandInteraction({});
    await selfroleCommand(ix1);
    const config = configManager.getConfig(GUILD_ID);
    const firstPanelId = config.roles.verifyPanelId;
    const countAfterFirst = selfRoleManager.getPanelsByGuild(GUILD_ID).length;

    const ix2 = makeCommandInteraction({});
    await selfroleCommand(ix2);
    assert.strictEqual(ix2.replies.length, 1);
    assert.match(ix2.replies[0].content, /already installed/i);
    assert.strictEqual(
        selfRoleManager.getPanelsByGuild(GUILD_ID).length,
        countAfterFirst,
        'no second panel was created'
    );
    assert.strictEqual(configManager.getConfig(GUILD_ID).roles.verifyPanelId, firstPanelId, 'the link is unchanged');

    selfRoleManager.deletePanel(firstPanelId);
});

// ====================================================
// === 4. Stale verifyPanelId → guard self-clears ===
// ====================================================

test('handler: a stale verifyPanelId (deleted panel) self-clears and install proceeds', async () => {
    configManager.setField(GUILD_ID, 'roles.verifyPanelId', '123456789012345678');
    configManager.setField(GUILD_ID, 'roles.verified', '987654321098765432');

    const ix = makeCommandInteraction({});
    await selfroleCommand(ix);
    assert.match(ix.replies[0].content, /Verification panel installed/i, 'install proceeded past the stale entry');

    const config = configManager.getConfig(GUILD_ID);
    assert.notStrictEqual(config.roles.verifyPanelId, '123456789012345678', 'stale id replaced');
    assert.strictEqual(config.roles.verified, ROLE_VERIFIED);
    selfRoleManager.deletePanel(config.roles.verifyPanelId);
});

// ====================================================
// === 5. Validation ===
// ====================================================

test('handler: @everyone / managed / above-bot roles are rejected', async () => {
    resetGuildConfig();

    const asEveryone = makeCommandInteraction({ roleId: GUILD_ID });
    await selfroleCommand(asEveryone);
    assert.match(asEveryone.replies[0].content, /@everyone cannot be used/i);

    const asManaged = makeCommandInteraction({ managed: true });
    await selfroleCommand(asManaged);
    assert.match(asManaged.replies[0].content, /managed by another integration/i);

    const asHigh = makeCommandInteraction({ rolePos: 99 });
    await selfroleCommand(asHigh);
    assert.match(asHigh.replies[0].content, /positioned ABOVE the bot/i);

    assert.strictEqual(selfRoleManager.getPanelsByGuild(GUILD_ID).length, 0, 'no panel was created');
    assert.strictEqual(configManager.getConfig(GUILD_ID).roles.verified, undefined, 'no verified role saved');
});

// ====================================================
// === 6. /selfrole-delete clears the verify config ===
// ====================================================

test('lifecycle: /selfrole-delete on the verify panel clears roles.verified + verifyPanelId', async () => {
    resetGuildConfig();
    const setup = makeCommandInteraction({});
    await selfroleCommand(setup);
    const config = configManager.getConfig(GUILD_ID);
    const panelId = config.roles.verifyPanelId;
    assert.ok(panelId);

    // /selfrole-delete with a minimal interaction mock.
    const replies = [];
    await selfroleCommand({
        commandName: 'selfrole-delete',
        guild: { id: GUILD_ID, channels: { cache: new Map() } },
        client: { user: { username: 'ThorTest', displayAvatarURL: () => 'x' } },
        user: { id: 'admin_user', tag: 'admin#0001' },
        options: { getString: () => panelId },
        deferReply: async () => {},
        editReply: async (opts) => {
            replies.push(opts);
            return {};
        }
    });

    assert.match(replies[0].content, /successfully deleted/i);
    assert.match(replies[0].content, /verification panel/i, 'the reply notes the verify config was cleared');
    const after = configManager.getConfig(GUILD_ID);
    assert.strictEqual(after.roles.verifyPanelId, null, 'verifyPanelId cleared');
    assert.strictEqual(after.roles.verified, null, 'verified cleared');
});

// ====================================================
// === 7 + 8. DASH API ===
// ====================================================

const TOKEN = 'unit-test-token-v328';

function makeMockClient() {
    const guild = {
        id: GUILD_ID,
        name: 'Verify Test Server',
        channels: {
            cache: new Map([
                [
                    CHANNEL_ID,
                    {
                        id: CHANNEL_ID,
                        name: 'verify',
                        type: 0,
                        send: async () => ({ id: `msg_${Date.now()}` }),
                        messages: { fetch: async () => ({ edit: async () => {}, delete: async () => {} }) }
                    }
                ]
            ])
        },
        roles: { cache: guildRoles },
        members: { me: { roles: { highest: { position: 10 } } }, fetch: async () => null }
    };
    return {
        isReady: () => true,
        guilds: {
            cache: new Map([[GUILD_ID, guild]]),
            fetch: async () => guild
        },
        channels: {
            fetch: async (id) => {
                const ch = guild.channels.cache.get(id);
                if (!ch) throw new Error('Unknown Channel');
                return ch;
            }
        },
        user: { username: 'ThorTest', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
        users: { fetch: async () => null }
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

test('dash API: POST verify-panel → 201, one-way panel + config saved', async () => {
    resetGuildConfig();
    const res = await api('POST', `/guilds/${GUILD_ID}/verify-panel`, {
        body: { roleId: ROLE_VERIFIED, channelId: CHANNEL_ID, label: 'Verify Me' }
    });
    assert.strictEqual(res.status, 201);
    const { panel } = await res.json();
    assert.strictEqual(panel.once, true, 'the panel is one-way');
    assert.strictEqual(panel.type, 'button');
    // v3.28.2: tagged for the CLASSIC render + old default title.
    assert.strictEqual(panel.kind, 'verify', 'panel is tagged kind:verify');
    assert.strictEqual(panel.title, '✅ SERVER VERIFICATION', 'old default title');
    assert.ok(panel.messageId, 'the message was sent');
    assert.strictEqual(panel.roles.length, 1);
    assert.strictEqual(panel.roles[0].roleId, ROLE_VERIFIED);

    const config = configManager.getConfig(GUILD_ID);
    assert.strictEqual(config.roles.verified, ROLE_VERIFIED, 'roles.verified saved');
    assert.strictEqual(config.roles.verifyPanelId, panel.id, 'roles.verifyPanelId saved');

    // Duplicate while alive → 409, no second panel.
    const dup = await api('POST', `/guilds/${GUILD_ID}/verify-panel`, {
        body: { roleId: ROLE_VERIFIED, channelId: CHANNEL_ID }
    });
    assert.strictEqual(dup.status, 409);
    assert.match((await dup.json()).error, /already installed/i);

    // Cleanup via the API DELETE — which must ALSO clear the verify config.
    const del = await api('DELETE', `/guilds/${GUILD_ID}/selfroles/${panel.id}`);
    assert.strictEqual(del.status, 200);
    assert.match((await del.json()).note, /verification panel/i, 'the delete response notes the verify config');
    const after = configManager.getConfig(GUILD_ID);
    assert.strictEqual(after.roles.verifyPanelId, null);
    assert.strictEqual(after.roles.verified, null);
});

test('dash API: POST verify-panel validation — bad role / unknown role / above-bot', async () => {
    resetGuildConfig();
    const bad = await api('POST', `/guilds/${GUILD_ID}/verify-panel`, {
        body: { roleId: 'not-a-snowflake', channelId: CHANNEL_ID }
    });
    assert.strictEqual(bad.status, 400);

    const unknown = await api('POST', `/guilds/${GUILD_ID}/verify-panel`, {
        body: { roleId: '999000111222333444', channelId: CHANNEL_ID }
    });
    assert.strictEqual(unknown.status, 400);
    assert.match((await unknown.json()).error, /not found in this server/i);

    const high = await api('POST', `/guilds/${GUILD_ID}/verify-panel`, {
        body: { roleId: ROLE_HIGH, channelId: CHANNEL_ID }
    });
    assert.strictEqual(high.status, 400);
    assert.match((await high.json()).error, /ABOVE the bot/i);
});

test('dash API: PUT config — roles.verified accepted again; unverified + verifyPanelId rejected', async () => {
    resetGuildConfig();
    const ok = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { actor: { id: '42', tag: 'tester' }, updates: { 'roles.verified': ROLE_VERIFIED } }
    });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(configManager.getConfig(GUILD_ID).roles.verified, ROLE_VERIFIED, 'roles.verified saved via PUT');

    const unverified = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { actor: { id: '42', tag: 'tester' }, updates: { 'roles.unverified': '888000111222333444' } }
    });
    assert.strictEqual(unverified.status, 422);
    assert.match(JSON.stringify(await unverified.json()), /removed in v3\.23\.0/i);

    const managedKey = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { actor: { id: '42', tag: 'tester' }, updates: { 'roles.verifyPanelId': '123456789012345678' } }
    });
    assert.strictEqual(managedKey.status, 422);
    assert.match(JSON.stringify(await managedKey.json()), /managed by \/setup-verify/i);
});

// ====================================================
// === 9. v3.28.2 — CLASSIC LOOK (old /setup-verify embed) ===
// ====================================================

test('classic look: /setup-verify renders the OLD-STYLE embed (green, plain, bot-name footer)', async () => {
    resetGuildConfig();
    const ix = makeCommandInteraction({});
    await selfroleCommand(ix);

    assert.strictEqual(ix.sent.length, 1, 'the panel message was sent');
    const embed = ix.sent[0].embeds[0];
    const d = embed.data ?? embed;
    assert.strictEqual(d.title, '✅ SERVER VERIFICATION', 'old default title (verifyTitle)');
    assert.match(d.description, /Welcome to \*\*Verify Test Server\*\*!/, 'old default body (verifyBody)');
    assert.match(d.description, /get verified and gain full access to all channels/);
    assert.strictEqual(d.color, 0x2ecc71, 'the OLD green color');
    assert.strictEqual(d.footer?.text, 'ThorTest', 'footer = the bot username (old style)');
    // NO self-role panel furniture:
    assert.doesNotMatch(d.description, /One-way mode/i, 'no mode line');
    assert.doesNotMatch(d.description, /Available roles/i, 'no role list');
    assert.doesNotMatch(String(d.footer?.text ?? ''), /Panel ID/i, 'no Panel ID in the footer');

    // The panel is tagged so /selfrole-update + web edits KEEP the classic look.
    const config = configManager.getConfig(GUILD_ID);
    const panel = selfRoleManager.getPanel(config.roles.verifyPanelId);
    assert.strictEqual(panel.kind, 'verify', 'panel tagged kind:verify');

    selfRoleManager.deletePanel(panel.id);
});

test('classic look: builder — kind:verify renders plain; untagged one-way panels keep the full layout', () => {
    const { buildPanelEmbed } = require('../../src/ui/selfRolePanelBuilder');
    const client = { user: { username: 'ThorTest', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' } };

    const classic = buildPanelEmbed(
        {
            title: '✅ SERVER VERIFICATION',
            description: 'Welcome!',
            once: true,
            exclusive: false,
            kind: 'verify',
            roles: [{ roleId: '1', label: 'Verify Me', emoji: '✅', description: '', style: 'Success', requiresRoleId: null }]
        },
        client
    );
    assert.strictEqual(classic.data.color, 0x2ecc71, 'green');
    assert.strictEqual(classic.data.description, 'Welcome!', 'description untouched — no furniture');
    assert.strictEqual(classic.data.footer.text, 'ThorTest', 'bot-name footer');

    // Contrast: a one-way panel WITHOUT the tag keeps the informative layout
    // (this is what /setup-selfrole once:true still produces).
    const busy = buildPanelEmbed(
        {
            title: 'Panel',
            description: 'Pick roles',
            once: true,
            exclusive: false,
            roles: [{ roleId: '1', label: 'R', emoji: '', description: '', style: 'Secondary', requiresRoleId: null }]
        },
        client
    );
    assert.match(busy.data.description, /One-way mode/i, 'untagged one-way panels keep the mode line');
    assert.match(String(busy.data.footer.text), /Panel ID/i, 'and the Panel ID footer');
});

test('classic look: createPanel stores kind only when set; setPanelKind migrates legacy panels', () => {
    const legacy = selfRoleManager.createPanel({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        title: 'Old v3.28.0 panel',
        once: true
    });
    assert.strictEqual(legacy.kind, null, 'panels created without kind stay untagged');

    selfRoleManager.setPanelKind(legacy.id, 'verify');
    assert.strictEqual(selfRoleManager.getPanel(legacy.id).kind, 'verify', 'setPanelKind tags the panel');

    selfRoleManager.setPanelKind(legacy.id, null);
    assert.strictEqual(selfRoleManager.getPanel(legacy.id).kind, null, 'and can untag');

    const fresh = selfRoleManager.createPanel({ guildId: GUILD_ID, channelId: CHANNEL_ID, kind: 'verify' });
    assert.strictEqual(fresh.kind, 'verify', 'createPanel persists kind:verify');

    selfRoleManager.deletePanel(legacy.id);
    selfRoleManager.deletePanel(fresh.id);
});
