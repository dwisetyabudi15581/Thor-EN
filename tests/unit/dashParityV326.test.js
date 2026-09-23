/**
 * Unit tests v3.26.0 — FULL web-control parity, round 2.
 *
 * Covers the new DASH API endpoints + the /selfrole-update command:
 *   PUT    /guilds/:id/selfroles/:panelId        (parity with /selfrole-update — NEW command)
 *   POST   /guilds/:id/selfroles/:panelId/roles  (requiresRoleId — parity with /selfrole-add)
 *   DELETE /guilds/:id/selfroles/:panelId/roles  (parity with /selfrole-remove)
 *   POST   /guilds/:id/giveaway/end             (parity with /giveaway end)
 *   POST   /guilds/:id/giveaway/reroll          (parity with /giveaway reroll)
 *   POST   /guilds/:id/poll/close              (parity with /poll close)
 *   PUT    /guilds/:id/panels/:panelId          (parity with /update-panel)
 *   POST   /guilds/:id/panels/:panelId/refresh  (parity with /refresh-panel)
 *   DELETE /guilds/:id/panels/:panelId          (parity with /delete-panel)
 *   products roleId/days round-trip             (parity with /set-product-role)
 *
 * Plus the registry/router/manager contracts for the new /selfrole-update.
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
    'selfRoles.json', 'giveaways.json', 'polls.json', 'panels.json',
    // trackGiveawayWin (reroll announce) writes stats.json
    'stats.json'
];
// panels.json + stats.json are OBJECT MAPs — empty files must be '{}' so the
// loaders don't quarantine them as invalid (same note as dashServer.test.js).
const INIT_CONTENT = { 'panels.json': '{}', 'stats.json': '{}' };
const backups = {};
for (const f of TOUCHED) {
    const p = path.join(dataDir, f);
    backups[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
    if (backups[p] === null) fs.writeFileSync(p, INIT_CONTENT[f] ?? '[]');
}
let configDirBackup = null;
if (fs.existsSync(configDir)) {
    configDirBackup = fs.readdirSync(configDir).map((f) => ({
        name: f,
        content: fs.readFileSync(path.join(configDir, f))
    }));
    for (const f of configDirBackup) {
        if (f.name.startsWith('999')) fs.unlinkSync(path.join(configDir, f.name));
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

const TOKEN = 'unit-test-token-v326';
const GUILD_ID = '999666555444333222';
const CHANNEL_ID = '333222111000999888'; // text channel
const ACTOR_ID = '121212121212121212';
const ROLE_ID = '888777666555444333';

function makeMockClient() {
    const guild = {
        id: GUILD_ID,
        name: 'Parity Two Server',
        icon: null,
        memberCount: 5,
        ownerId: ACTOR_ID,
        channels: {
            cache: new Map([
                [CHANNEL_ID, {
                    id: CHANNEL_ID,
                    name: 'general',
                    type: 0,
                    send: async (opts) => ({ id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, opts, url: 'https://discord.com/channels/x/y' }),
                    messages: {
                        fetch: async () => ({ edit: async () => {}, delete: async () => {} })
                    }
                }]
            ])
        },
        roles: {
            cache: new Map([
                [ROLE_ID, { id: ROLE_ID, name: 'VIP', color: 0, position: 2 }]
            ])
        },
        members: { fetch: async () => null }
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
        // Winner DMs are best-effort — resolve to null so the happy path runs clean.
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

const ACTOR = { id: ACTOR_ID, tag: 'admin#0001' };

// ====================================================
// === Contract: /selfrole-update registered + routed ===
// ====================================================

test('contract: registry has 96 commands and selfrole-update is admin-gated with 6 options', () => {
    const { getCommands } = require('../../src/commands/registry');
    const cmds = getCommands();
    assert.strictEqual(cmds.length, 96, '96 commands (v4.2.0 — set-verify-button restored)');
    const cmd = cmds.find((c) => c.name === 'selfrole-update');
    assert.ok(cmd, '/selfrole-update is registered');
    assert.ok(cmd.defaultMemberPermissions, '/selfrole-update is admin-gated');
    // v3.27.0: `once` — one-way (verification) mode.
    assert.deepStrictEqual(
        (cmd.options || []).map((o) => o.name),
        ['panel_id', 'title', 'description', 'type', 'exclusive', 'once']
    );
    // Type choices = button | select (same vocabulary as /setup-selfrole)
    const typeOpt = cmd.options.find((o) => o.name === 'type');
    assert.deepStrictEqual(typeOpt.choices.map((c) => c.value).sort(), ['button', 'select']);
});

test('contract: router maps selfrole-update to the selfrole domain (no dead command)', () => {
    const routeCommand = require('../../src/commands/index');
    assert.strictEqual(routeCommand.COMMAND_TO_DOMAIN['selfrole-update'], 'selfrole');
    assert.ok(routeCommand.DOMAIN_HANDLERS.selfrole, 'the handler file is wired');
});

test('contract: selfRoleManager.updatePanel validates the type (invalid → null, nothing saved)', () => {
    const selfRoleManager = require('../../src/data/selfRoleManager');
    // Quarantine the data dir side effects: the endpoint tests below also use
    // these files, so use a dedicated panel here and let the exit hook restore.
    const panel = selfRoleManager.createPanel({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        title: 'Contract Panel',
        description: 'temp',
        type: 'button'
    });
    // Invalid type → null (rejected, panel unchanged)
    assert.strictEqual(selfRoleManager.updatePanel(panel.id, { type: 'radio' }), null);
    const unchanged = selfRoleManager.getPanel(panel.id);
    assert.strictEqual(unchanged.type, 'button');
    // Empty title → null (rejected)
    assert.strictEqual(selfRoleManager.updatePanel(panel.id, { title: '   ' }), null);
    // Valid edit → all four fields
    const updated = selfRoleManager.updatePanel(panel.id, {
        title: 'Renamed',
        description: 'new desc',
        type: 'select',
        exclusive: true
    });
    assert.strictEqual(updated.title, 'Renamed');
    assert.strictEqual(updated.description, 'new desc');
    assert.strictEqual(updated.type, 'select');
    assert.strictEqual(updated.exclusive, true);
    selfRoleManager.deletePanel(panel.id);
});

// ====================================================
// === PUT /selfroles/:panelId — edit a live panel ===
// ====================================================

test('selfroles PUT: edit title/description/type/exclusive — applied + persisted + returned', async () => {
    const create = await api('POST', `/guilds/${GUILD_ID}/selfroles`, {
        body: {
            channelId: CHANNEL_ID,
            title: 'Original Panel',
            description: 'old description',
            type: 'button',
            exclusive: false,
            roles: [{ roleId: ROLE_ID, label: 'VIP' }]
        }
    });
    assert.strictEqual(create.status, 201);
    const created = await create.json();
    const id = created.panel.id;

    // No fields → 400
    assert.strictEqual((await api('PUT', `/guilds/${GUILD_ID}/selfroles/${id}`, { body: {} })).status, 400);
    // Unknown panel → 404
    assert.strictEqual((await api('PUT', `/guilds/${GUILD_ID}/selfroles/sr_nope`, { body: { title: 'x' } })).status, 404);
    // Bad type → 400
    assert.strictEqual(
        (await api('PUT', `/guilds/${GUILD_ID}/selfroles/${id}`, { body: { type: 'radio' } })).status,
        400
    );

    const edit = await api('PUT', `/guilds/${GUILD_ID}/selfroles/${id}`, {
        body: {
            title: 'Renamed Panel',
            description: 'new description',
            type: 'select',
            exclusive: true,
            actor: ACTOR
        }
    });
    assert.strictEqual(edit.status, 200);
    const data = await edit.json();
    assert.strictEqual(data.panel.title, 'Renamed Panel');
    assert.strictEqual(data.panel.description, 'new description');
    assert.strictEqual(data.panel.type, 'select');
    assert.strictEqual(data.panel.exclusive, true);
    // The roles survive the edit.
    assert.strictEqual(data.panel.roles.length, 1);

    // Persisted: a fresh payload read shows the new values.
    const dash = await (await api('GET', `/guilds/${GUILD_ID}/dashboard`)).json();
    const live = dash.selfroles.find((p) => p.id === id);
    assert.strictEqual(live.title, 'Renamed Panel');
    assert.strictEqual(live.type, 'select');
    assert.strictEqual(live.exclusive, true);
});

// ====================================================
// === PUT /selfroles/:panelId with a roles array   ===
// === (v4.2.1 — /set-verify-button parity, web)    ===
// ====================================================

test('selfroles PUT roles: restyle the button entries — validated, applied, persisted', async () => {
    const create = await api('POST', `/guilds/${GUILD_ID}/selfroles`, {
        body: {
            channelId: CHANNEL_ID,
            title: 'Button Restyle Panel',
            description: 'x',
            type: 'button',
            roles: [{ roleId: ROLE_ID, label: 'Old Label', style: 'Secondary' }]
        }
    });
    assert.strictEqual(create.status, 201);
    const { panel } = await create.json();

    // Empty roles array → 400
    assert.strictEqual(
        (await api('PUT', `/guilds/${GUILD_ID}/selfroles/${panel.id}`, { body: { roles: [] } })).status,
        400
    );
    // Bad roleId → 400
    assert.strictEqual(
        (await api('PUT', `/guilds/${GUILD_ID}/selfroles/${panel.id}`, {
            body: { roles: [{ roleId: 'abc', label: 'X' }] }
        })).status,
        400
    );
    // Empty label → 400
    assert.strictEqual(
        (await api('PUT', `/guilds/${GUILD_ID}/selfroles/${panel.id}`, {
            body: { roles: [{ roleId: ROLE_ID, label: '   ' }] }
        })).status,
        400
    );
    // Bad style → 400
    assert.strictEqual(
        (await api('PUT', `/guilds/${GUILD_ID}/selfroles/${panel.id}`, {
            body: { roles: [{ roleId: ROLE_ID, label: 'X', style: 'Neon' }] }
        })).status,
        400
    );

    // Valid restyle (the /set-verify-button flow from the web).
    const edit = await api('PUT', `/guilds/${GUILD_ID}/selfroles/${panel.id}`, {
        body: {
            roles: [{ roleId: ROLE_ID, label: 'Verify Me', emoji: '✅', style: 'Success' }],
            actor: ACTOR
        }
    });
    assert.strictEqual(edit.status, 200);
    const data = await edit.json();
    assert.strictEqual(data.panel.roles.length, 1);
    assert.strictEqual(data.panel.roles[0].label, 'Verify Me');
    assert.strictEqual(data.panel.roles[0].emoji, '✅');
    assert.strictEqual(data.panel.roles[0].style, 'Success');

    // Persisted: a fresh payload read keeps the new look.
    const dash = await (await api('GET', `/guilds/${GUILD_ID}/dashboard`)).json();
    const live = dash.selfroles.find((p) => p.id === panel.id);
    assert.strictEqual(live.roles[0].label, 'Verify Me');
    assert.strictEqual(live.roles[0].style, 'Success');
});

test('selfroles PUT roles: manager-level validation (bad entry → null, panel unchanged)', () => {
    const selfRoleManager = require('../../src/data/selfRoleManager');
    const panel = selfRoleManager.createPanel({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        title: 'Manager Roles Guard',
        description: 'temp',
        type: 'button'
    });
    // Non-array → null
    assert.strictEqual(selfRoleManager.updatePanel(panel.id, { roles: 'nope' }), null);
    // Entry without roleId → null
    assert.strictEqual(selfRoleManager.updatePanel(panel.id, { roles: [{ label: 'X' }] }), null);
    // Entry with a non-snowflake roleId → null
    assert.strictEqual(
        selfRoleManager.updatePanel(panel.id, { roles: [{ roleId: '1234', label: 'X' }] }),
        null
    );
    // Panel unchanged after the rejected writes.
    const p = selfRoleManager.getPanel(panel.id);
    assert.deepStrictEqual(p.roles, []);
    selfRoleManager.deletePanel(panel.id);
});

test('selfroles roles: add with requiresRoleId (gated role) + remove', async () => {
    const create = await api('POST', `/guilds/${GUILD_ID}/selfroles`, {
        body: {
            channelId: CHANNEL_ID,
            title: 'Gated Panel',
            description: 'x',
            type: 'button',
            roles: [{ roleId: ROLE_ID, label: 'VIP' }]
        }
    });
    const { panel } = await create.json();

    // Invalid requiresRoleId → 400
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/selfroles/${panel.id}/roles`, {
            body: { roleId: '123', label: 'X' }
        })).status,
        400
    );

    const secondRoleId = '888777666555444999';
    const add = await api('POST', `/guilds/${GUILD_ID}/selfroles/${panel.id}/roles`, {
        body: { roleId: secondRoleId, label: 'Secret', style: 'Success', description: 'hidden', requiresRoleId: ROLE_ID }
    });
    assert.strictEqual(add.status, 200);
    const added = (await add.json()).panel;
    const gated = added.roles.find((r) => r.roleId === secondRoleId);
    assert.ok(gated, 'the new role is on the panel');
    assert.strictEqual(gated.style, 'Success');
    assert.strictEqual(gated.requiresRoleId, ROLE_ID, 'the conditional gate is stored (parity with /selfrole-add)');

    // Remove it again — parity with /selfrole-remove
    const del = await api('DELETE', `/guilds/${GUILD_ID}/selfroles/${panel.id}/roles?roleId=${secondRoleId}`);
    assert.strictEqual(del.status, 200);
    const after = (await del.json()).panel;
    assert.ok(!after.roles.some((r) => r.roleId === secondRoleId), 'the role is off the panel');
});

// ====================================================
// === POST /giveaway/end + /giveaway/reroll ===
// ====================================================

test('giveaway end: picks winners, persists, announces; second end → 409', async () => {
    const create = await api('POST', `/guilds/${GUILD_ID}/giveaway`, {
        body: { channelId: CHANNEL_ID, prize: 'Nitro', winners: 1, durationMin: 60, actor: ACTOR }
    });
    assert.strictEqual(create.status, 201);
    const { giveaway } = await create.json();

    // Seed two participants (the same way the Join button does).
    const giveawayManager = require('../../src/data/giveawayManager');
    giveawayManager.addParticipant(giveaway.id, '111111111111111111');
    giveawayManager.addParticipant(giveaway.id, '222222222222222222');

    const end = await api('POST', `/guilds/${GUILD_ID}/giveaway/end`, { body: { id: giveaway.id, actor: ACTOR } });
    assert.strictEqual(end.status, 200);
    const data = await end.json();
    assert.strictEqual(data.winnerIds.length, 1, 'one winner picked');
    assert.ok(['111111111111111111', '222222222222222222'].includes(data.winnerIds[0]));
    assert.strictEqual(data.giveaway.ended, true);

    // Persisted.
    assert.strictEqual(giveawayManager.get(giveaway.id).ended, true);

    // Already ended → 409
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/giveaway/end`, { body: { id: giveaway.id, actor: ACTOR } })).status,
        409
    );
    // Unknown id → 404
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/giveaway/end`, { body: { id: 'gw_nope', actor: ACTOR } })).status,
        404
    );
});

test('giveaway reroll: not-ended → 409; ended → new winner persisted', async () => {
    // A RUNNING giveaway cannot be rerolled.
    const running = await api('POST', `/guilds/${GUILD_ID}/giveaway`, {
        body: { channelId: CHANNEL_ID, prize: 'Key', winners: 1, durationMin: 60, actor: ACTOR }
    });
    const { giveaway: gwRunning } = await running.json();
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/giveaway/reroll`, { body: { id: gwRunning.id, actor: ACTOR } })).status,
        409
    );

    // Find the ended one from the previous test (2 participants, 1 winner).
    const giveawayManager = require('../../src/data/giveawayManager');
    const ended = giveawayManager.getByGuild(GUILD_ID).find((g) => g.ended && g.participantIds.length === 2);
    assert.ok(ended, 'the ended giveaway from the previous test is on disk');

    const reroll = await api('POST', `/guilds/${GUILD_ID}/giveaway/reroll`, { body: { id: ended.id, actor: ACTOR } });
    assert.strictEqual(reroll.status, 200);
    const data = await reroll.json();
    assert.ok(data.winnerId, 'a new winner was picked');
    // The fresh state has BOTH winners persisted.
    const fresh = giveawayManager.get(ended.id);
    assert.strictEqual(fresh.winnerIds.length, 2);
    assert.ok(fresh.winnerIds.includes(data.winnerId));
});

// ====================================================
// === POST /poll/close ===
// ====================================================

test('poll close: closes + final render; second close → 409; unknown → 404', async () => {
    const create = await api('POST', `/guilds/${GUILD_ID}/poll`, {
        body: {
            channelId: CHANNEL_ID,
            question: 'Best feature?',
            multiple: false,
            options: [{ label: 'Web parity' }, { label: 'Slash commands' }],
            actor: ACTOR
        }
    });
    assert.strictEqual(create.status, 201);
    const { poll } = await create.json();

    const close = await api('POST', `/guilds/${GUILD_ID}/poll/close`, { body: { id: poll.id, actor: ACTOR } });
    assert.strictEqual(close.status, 200);
    const data = await close.json();
    assert.strictEqual(data.poll.closed, true);
    assert.ok(data.poll.closedAt, 'closedAt is stamped');

    // Persisted.
    const pollManager = require('../../src/data/pollManager');
    assert.strictEqual(pollManager.get(poll.id).closed, true);

    // Already closed → 409
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/poll/close`, { body: { id: poll.id, actor: ACTOR } })).status,
        409
    );
    // Unknown → 404
    assert.strictEqual(
        (await api('POST', `/guilds/${GUILD_ID}/poll/close`, { body: { id: 'poll_nope', actor: ACTOR } })).status,
        404
    );
});

// ====================================================
// === PUT /panels/:id + refresh + DELETE ===
// ====================================================

test('panels: install, edit fields, refresh, delete — the full /update-panel cycle', async () => {
    // The install endpoint needs roles.admin + at least 1 category.
    const cfgPut = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: { updates: { 'roles.admin': ROLE_ID } }
    });
    assert.strictEqual(cfgPut.status, 200);

    const install = await api('POST', `/guilds/${GUILD_ID}/panels`, {
        body: { channelId: CHANNEL_ID, useDropdown: false, actor: ACTOR }
    });
    assert.strictEqual(install.status, 201);
    const { panel } = await install.json();
    assert.ok(panel.id, 'the panel got an id');
    assert.ok(panel.messageId, 'the message was sent');

    // --- PUT: edit fields ---
    // No fields → 400
    assert.strictEqual((await api('PUT', `/guilds/${GUILD_ID}/panels/${panel.id}`, { body: {} })).status, 400);
    // Invalid color → 400
    assert.strictEqual(
        (await api('PUT', `/guilds/${GUILD_ID}/panels/${panel.id}`, { body: { color: 'rainbow' } })).status,
        400
    );
    // Invalid image URL → 400
    assert.strictEqual(
        (await api('PUT', `/guilds/${GUILD_ID}/panels/${panel.id}`, { body: { image: 'notaurl' } })).status,
        400
    );
    // Valid edits → 200 + storage keys (v3.9.26 mapping)
    const edit = await api('PUT', `/guilds/${GUILD_ID}/panels/${panel.id}`, {
        body: { title: 'Custom Panel', color: '#ff5733', image: 'https://example.com/banner.png', footer: 'Buy now', actor: ACTOR }
    });
    assert.strictEqual(edit.status, 200);
    const edited = (await edit.json()).panel;
    assert.strictEqual(edited.title, 'Custom Panel');
    assert.strictEqual(edited.color, 0xff5733);
    assert.strictEqual(edited.imageUrl, 'https://example.com/banner.png');
    assert.strictEqual(edited.footerText, 'Buy now');

    // Empty title CLEARS the override (falls back to global).
    const clear = await api('PUT', `/guilds/${GUILD_ID}/panels/${panel.id}`, {
        body: { title: '', actor: ACTOR }
    });
    assert.strictEqual(clear.status, 200);
    assert.strictEqual((await clear.json()).panel.title, null);

    // --- POST refresh: re-render with the latest config ---
    const refresh = await api('POST', `/guilds/${GUILD_ID}/panels/${panel.id}/refresh`, { body: {} });
    assert.strictEqual(refresh.status, 200);
    const rf = await refresh.json();
    assert.strictEqual(rf.ok, true);
    assert.ok(Array.isArray(rf.emptyCategoryWarnings), 'the empty-category warnings ship (v3.9.29 safety net)');

    // --- DELETE: message + metadata ---
    const del = await api('DELETE', `/guilds/${GUILD_ID}/panels/${panel.id}`);
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await del.json()).messageDeleted, true, 'the mock message was deleted');
    // Gone → 404 on a second delete
    assert.strictEqual((await api('DELETE', `/guilds/${GUILD_ID}/panels/${panel.id}`)).status, 404);
    // Unknown panel → 404 on PUT/refresh
    assert.strictEqual((await api('PUT', `/guilds/${GUILD_ID}/panels/tp_nope`, { body: { title: 'x' } })).status, 404);
    assert.strictEqual((await api('POST', `/guilds/${GUILD_ID}/panels/tp_nope/refresh`, { body: {} })).status, 404);
});

// ====================================================
// === products roleId/days round-trip (set-product-role parity) ===
// ====================================================

test('products: roleId + days survive a config PUT round-trip (web set-product-role)', async () => {
    const put = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: {
            updates: {
                products: [
                    { label: 'VIP 30d', value: 'vip30', price: '25,000 IDR', category: 'transaction', requiresKey: true, roleId: ROLE_ID, days: 30 },
                    { label: 'Manual', value: 'manual1', price: '5,000 IDR', category: 'transaction', requiresKey: false }
                ]
            }
        }
    });
    assert.strictEqual(put.status, 200);

    const dash = await (await api('GET', `/guilds/${GUILD_ID}/dashboard`)).json();
    const vip = dash.config.products.find((p) => p.value === 'vip30');
    assert.strictEqual(vip.roleId, ROLE_ID, 'the auto-role mapping is stored');
    assert.strictEqual(vip.days, 30, 'the expiry is stored');
    const manual = dash.config.products.find((p) => p.value === 'manual1');
    assert.strictEqual(manual.roleId, undefined, 'no role on the manual product');

    // Clearing the role (remove-product-role parity): drop roleId + days.
    const clear = await api('PUT', `/guilds/${GUILD_ID}/config`, {
        body: {
            updates: {
                products: [{ label: 'VIP 30d', value: 'vip30', price: '25,000 IDR', category: 'transaction', requiresKey: true }]
            }
        }
    });
    assert.strictEqual(clear.status, 200);
    const dash2 = await (await api('GET', `/guilds/${GUILD_ID}/dashboard`)).json();
    assert.strictEqual(dash2.config.products.find((p) => p.value === 'vip30').roleId, undefined, 'the role mapping is gone');
});
