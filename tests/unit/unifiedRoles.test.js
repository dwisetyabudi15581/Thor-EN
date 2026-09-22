/**
 * Unit tests for v3.23.0 — UNIFIED AUTO-ROLE + THE REMOVE-ON-NEW-ROLE TOGGLE.
 *
 * What changed (all covered here):
 *   1. src/services/roleEngine.js — joinRoleIds() is now PURELY the autorole
 *      list (the Unverified marker concept was removed).
 *   2. guildMemberUpdate — THE TOGGLE RULE: while autorole.removeOnNewRole
 *      is on, EVERY join role the member holds is stripped the moment they
 *      receive ANOTHER role (from any source). The join roles themselves
 *      are exempt so a join grant never strips itself.
 *   3. memberHandler.onMemberAdd — grants the join list through the engine.
 *   4. /set-autorole — add / remove / list / toggle.
 *   5. The btn_verify stub — legacy panels get a deprecation reply.
 *
 * Sandboxed guild config (snapshot & restore — welcomeDiagnostics pattern).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const GUILD_ID = 'guild_unified_roles';
const configPath = path.join(CONFIG_DIR, `${GUILD_ID}.json`);
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

const hadConfig = fs.existsSync(configPath);
if (hadConfig) fs.copyFileSync(configPath, configPath + '.test-backup');
process.on('exit', () => {
    try {
        if (hadConfig) {
            fs.copyFileSync(configPath + '.test-backup', configPath);
            fs.rmSync(configPath + '.test-backup', { force: true });
        } else if (fs.existsSync(configPath)) {
            fs.rmSync(configPath, { force: true });
        }
    } catch (_) {}
});

// Public mode — every guild allowed (guild.js reads env per call).
process.env.GUILD_ID = '';

/** Write this guild's config (roles/autorole) for a test case. */
function writeConfig(partial = {}) {
    fs.writeFileSync(
        configPath,
        JSON.stringify(
            {
                roles: partial.roles || {},
                autorole: partial.autorole || { roleIds: [], removeOnNewRole: false },
                channels: partial.channels || {},
                messages: {
                    welcomeTitle: 'W',
                    welcomeBody: 'B',
                    goodbyeTitle: 'G',
                    goodbyeBody: 'B'
                }
            },
            null,
            4
        )
    );
}

// ====================================================
// === Fake members / guilds (engine-shaped)          ===
// ====================================================

function makeRole(id, { managed = false, position = 1 } = {}) {
    return { id, name: `Role-${id}`, managed, position };
}

function makeGuild({ roles = [], botPosition = 10 } = {}) {
    const roleCache = new Map();
    for (const r of roles) roleCache.set(r.id, r);
    roleCache.set(GUILD_ID, { id: GUILD_ID, name: '@everyone', managed: false, position: 0 });
    return {
        id: GUILD_ID,
        name: 'Unified',
        memberCount: 10,
        roles: { cache: roleCache },
        members: { me: { roles: { highest: { position: botPosition } } } }
    };
}

/** A member that records every roles.add / roles.remove call.
 *  roles.cache is a real Map (id → role object) — same surface the handlers
 *  use: .has(id) and .values() (discord.js GuildMemberRoleManager.cache). */
function makeMember({ has = [], guild, addFails = {} } = {}) {
    const calls = { add: [], remove: [] };
    const roleMap = new Map();
    const resolve = id => (guild && guild.roles && guild.roles.cache && guild.roles.cache.get(id)) || { id, name: `Role-${id}` };
    for (const id of has) roleMap.set(id, resolve(id));
    return {
        id: 'member_1',
        user: { id: 'member_1', tag: 'Tester#0001', bot: false },
        guild,
        roles: {
            cache: roleMap,
            add: async (ids, opts) => {
                const list = Array.isArray(ids) ? ids : [ids];
                for (const id of list) {
                    if (addFails[id]) throw new Error(`fake fail ${id}`);
                }
                calls.add.push(...list);
                for (const id of list) roleMap.set(id, resolve(id));
            },
            remove: async (ids, opts) => {
                const list = Array.isArray(ids) ? ids : [ids];
                calls.remove.push(...list);
                for (const id of list) roleMap.delete(id);
            }
        },
        _calls: calls
    };
}

// ====================================================
// === 1. Role Engine                                 ===
// ====================================================

test('roleEngine: plain grant — one call, granted list filled', async () => {
    const { grantRoles } = require('../../src/services/roleEngine');
    const guild = makeGuild({ roles: [makeRole('r_a'), makeRole('r_b')] });
    const m = makeMember({ guild });
    const res = await grantRoles(m, ['r_a', 'r_b'], { reason: 'test' });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.granted, ['r_a', 'r_b']);
    assert.deepStrictEqual(m._calls.add, ['r_a', 'r_b']);
});

test('roleEngine: already-has → skipped (idempotent), dedupe input', async () => {
    const { grantRoles } = require('../../src/services/roleEngine');
    const guild = makeGuild({ roles: [makeRole('r_a'), makeRole('r_b')] });
    const m = makeMember({ guild, has: ['r_a'] });
    const res = await grantRoles(m, ['r_a', 'r_a', 'r_b']);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.granted, ['r_b']);
    assert.deepStrictEqual(res.skipped, ['r_a']);
    assert.deepStrictEqual(m._calls.add, ['r_b']);
});

test('roleEngine: managed role rejected, valid role still granted', async () => {
    const { grantRoles } = require('../../src/services/roleEngine');
    const guild = makeGuild({ roles: [makeRole('r_managed', { managed: true }), makeRole('r_ok')] });
    const m = makeMember({ guild });
    const res = await grantRoles(m, ['r_managed', 'r_ok']);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.failed.length, 1);
    assert.match(res.failed[0].error, /managed by another integration/i);
    assert.deepStrictEqual(res.granted, ['r_ok']);
});

test('roleEngine: role above the bot → rejected (the #1 silent failure)', async () => {
    const { grantRoles } = require('../../src/services/roleEngine');
    const guild = makeGuild({ roles: [makeRole('r_high', { position: 99 })], botPosition: 10 });
    const m = makeMember({ guild });
    const res = await grantRoles(m, ['r_high']);
    assert.strictEqual(res.ok, false);
    assert.match(res.failed[0].error, /ABOVE the bot's highest role/i);
    assert.strictEqual(m._calls.add.length, 0);
});

test('roleEngine: batch failure → per-role retry, good roles land', async () => {
    const { grantRoles } = require('../../src/services/roleEngine');
    const guild = makeGuild({ roles: [makeRole('r_a'), makeRole('r_bad')] });
    const m = makeMember({ guild, addFails: { r_bad: true } });
    const res = await grantRoles(m, ['r_a', 'r_bad']);
    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(res.granted, ['r_a']);
    assert.deepStrictEqual(res.failed.map(f => f.roleId), ['r_bad']);
});

test('roleEngine: revoke skips roles the member does not have', async () => {
    const { revokeRoles } = require('../../src/services/roleEngine');
    const guild = makeGuild({ roles: [makeRole('r_x'), makeRole('r_y')] });
    const m = makeMember({ guild, has: ['r_x'] });
    const res = await revokeRoles(m, ['r_x', 'r_y']);
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.revoked, ['r_x']);
    assert.deepStrictEqual(res.skipped, ['r_y']);
});

test('roleEngine: cacheless member (unit-test style fake) still works', async () => {
    const { grantRoles } = require('../../src/services/roleEngine');
    const added = [];
    const m = {
        id: 'm2',
        user: { tag: 'Bare#0002' },
        roles: {
            cache: { has: () => false },
            add: async ids => added.push(...(Array.isArray(ids) ? ids : [ids])),
            remove: async () => {}
        }
    };
    const res = await grantRoles(m, ['r_z'], { quiet: true });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.granted, ['r_z']);
    assert.deepStrictEqual(added, ['r_z']);
});

test('roleEngine: joinRoleIds — purely the autorole list, deduped, WITHOUT unverified', () => {
    const { joinRoleIds } = require('../../src/services/roleEngine');
    assert.deepStrictEqual(joinRoleIds({ autorole: { roleIds: ['a', 'b', 'a'] } }), ['a', 'b']);
    // v3.23.0: roles.unverified is no longer merged in — the concept is gone.
    assert.deepStrictEqual(joinRoleIds({ autorole: { roleIds: [] }, roles: { unverified: 'u' } }), []);
    assert.deepStrictEqual(joinRoleIds({ roles: { unverified: 'u' } }), []);
    assert.deepStrictEqual(joinRoleIds({}), []);
});

// ====================================================
// === 2. The removeOnNewRole toggle rule              ===
// ====================================================

/**
 * Run the guildMemberUpdate event handler on a role change.
 * old/new members share the guild; each carries its own role-set snapshot
 * as a Map (the exact cache surface the handler reads).
 */
async function runMemberUpdate({ guild, oldHas, newHas }) {
    const event = require('../../src/bot/events/guildMemberUpdate');
    const oldMember = makeMember({ guild, has: oldHas });
    const newMember = makeMember({ guild, has: newHas });
    // guildMemberUpdate also touches client via logServerEvent — no server-log
    // channel configured → silent skip. Provide a minimal client anyway.
    newMember.client = { user: { username: 'TestBot' } };
    oldMember.client = newMember.client;
    await event.execute(oldMember, newMember);
    return newMember;
}

test('toggle rule: ON — member holding a join role gains another role → join role revoked', async () => {
    writeConfig({ autorole: { roleIds: ['r_member'], removeOnNewRole: true } });
    const guild = makeGuild({ roles: [makeRole('r_member'), makeRole('r_gamer')] });
    const m = await runMemberUpdate({ guild, oldHas: ['r_member'], newHas: ['r_member', 'r_gamer'] });
    assert.deepStrictEqual(m._calls.remove, ['r_member'], 'the join role must be revoked');
});

test('toggle rule: OFF (default) — join roles are permanent , nothing revoked', async () => {
    writeConfig({ autorole: { roleIds: ['r_member'] } });
    const guild = makeGuild({ roles: [makeRole('r_member'), makeRole('r_gamer')] });
    const m = await runMemberUpdate({ guild, oldHas: ['r_member'], newHas: ['r_member', 'r_gamer'] });
    assert.deepStrictEqual(m._calls.remove, [], 'toggle off → join roles stay');
});

test('toggle rule: a join-role grant does NOT strip itself (join exemption)', async () => {
    writeConfig({ autorole: { roleIds: ['r_member', 'r_newbie'], removeOnNewRole: true } });
    const guild = makeGuild({ roles: [makeRole('r_member'), makeRole('r_newbie')] });
    // A join grant: all join roles arrive together.
    const m = await runMemberUpdate({ guild, oldHas: [], newHas: ['r_member', 'r_newbie'] });
    assert.deepStrictEqual(m._calls.remove, [], 'join roles must NOT remove themselves');
});

test('toggle rule: multiple join roles — ALL revoked on another role', async () => {
    writeConfig({ autorole: { roleIds: ['r_member', 'r_newbie'], removeOnNewRole: true } });
    const guild = makeGuild({ roles: [makeRole('r_member'), makeRole('r_newbie'), makeRole('r_gamer')] });
    const m = await runMemberUpdate({ guild, oldHas: ['r_member', 'r_newbie'], newHas: ['r_member', 'r_newbie', 'r_gamer'] });
    assert.deepStrictEqual(m._calls.remove.sort(), ['r_member', 'r_newbie']);
});

test('toggle rule: member WITHOUT a join role gains a role → untouched', async () => {
    writeConfig({ autorole: { roleIds: ['r_member'], removeOnNewRole: true } });
    const guild = makeGuild({ roles: [makeRole('r_member'), makeRole('r_gamer')] });
    const m = await runMemberUpdate({ guild, oldHas: [], newHas: ['r_gamer'] });
    assert.deepStrictEqual(m._calls.remove, []);
});

test('toggle rule: empty autorole list (toggle on) → nothing to revoke', async () => {
    writeConfig({ autorole: { roleIds: [], removeOnNewRole: true } });
    const guild = makeGuild({ roles: [makeRole('r_gamer')] });
    const m = await runMemberUpdate({ guild, oldHas: [], newHas: ['r_gamer'] });
    assert.deepStrictEqual(m._calls.remove, []);
});

test('toggle rule: a BOOST role (managed, granted by Discord) counts as another role', async () => {
    writeConfig({ autorole: { roleIds: ['r_member'], removeOnNewRole: true } });
    const guild = makeGuild({ roles: [makeRole('r_member'), makeRole('r_booster', { managed: true })] });
    const m = await runMemberUpdate({ guild, oldHas: ['r_member'], newHas: ['r_member', 'r_booster'] });
    assert.deepStrictEqual(m._calls.remove, ['r_member']);
});

// ====================================================
// === 3. memberHandler.onMemberAdd — join grant       ===
// ====================================================

test('onMemberAdd: grants the autorole list in one engine call', async () => {
    writeConfig({ autorole: { roleIds: ['r_member', 'r_newbie'] } });
    const { onMemberAdd } = require('../../src/bot/memberHandler');
    const guild = makeGuild({ roles: [makeRole('r_member'), makeRole('r_newbie')] });
    // memberHandler needs welcome channel lookup — none set → warning path.
    const m = makeMember({ guild, has: [] });
    await onMemberAdd(m);
    assert.deepStrictEqual(m._calls.add.sort(), ['r_member', 'r_newbie']);
});

test('onMemberAdd: no join roles configured → no add call', async () => {
    writeConfig({});
    const { onMemberAdd } = require('../../src/bot/memberHandler');
    const guild = makeGuild({ roles: [] });
    const m = makeMember({ guild });
    await onMemberAdd(m);
    assert.deepStrictEqual(m._calls.add, []);
});

// ====================================================
// === 4. /set-autorole add / remove / list            ===
// ====================================================

function makeAutoroleInteraction({ action, role, guildRoles, botPos = 10, enabled = null }) {
    const replies = [];
    const guild = makeGuild({ roles: guildRoles, botPosition: botPos });
    return {
        commandName: 'set-autorole',
        client: { user: { username: 'TestBot', displayAvatarURL: () => 'http://x/a.png' } },
        user: { id: 'admin1', tag: 'Admin#0001' },
        guildId: GUILD_ID,
        guild,
        options: {
            getString: () => action,
            getRole: () => role || null,
            getBoolean: () => enabled
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

test('/set-autorole add: role appended + saved + audit reply', async () => {
    writeConfig({ autorole: { roleIds: ['r_member'] } });
    const configHandler = require('../../src/commands/config');
    const itx = makeAutoroleInteraction({
        action: 'add',
        role: makeRole('r_gamer'),
        guildRoles: [makeRole('r_member'), makeRole('r_gamer')]
    });
    await configHandler(itx);
    const edit = itx._replies.find(r => r.type === 'edit');
    assert.match(edit.opts.content, /added to the \*\*auto-role on join\*\* list \(2\/10\)/);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(saved.autorole.roleIds, ['r_member', 'r_gamer']);
});

test('/set-autorole add: duplicate → info reply, list unchanged', async () => {
    writeConfig({ autorole: { roleIds: ['r_gamer'] } });
    const configHandler = require('../../src/commands/config');
    const itx = makeAutoroleInteraction({
        action: 'add',
        role: makeRole('r_gamer'),
        guildRoles: [makeRole('r_gamer')]
    });
    await configHandler(itx);
    const edit = itx._replies.find(r => r.type === 'edit');
    assert.match(edit.opts.content, /already in the auto-role list/i);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(saved.autorole.roleIds, ['r_gamer']);
});

test('/set-autorole add: managed role REJECTED (parity with /set-role validation)', async () => {
    writeConfig({ autorole: { roleIds: [] } });
    const configHandler = require('../../src/commands/config');
    const itx = makeAutoroleInteraction({
        action: 'add',
        role: makeRole('r_managed', { managed: true }),
        guildRoles: [makeRole('r_managed')]
    });
    await configHandler(itx);
    const edit = itx._replies.find(r => r.type === 'edit');
    assert.match(edit.opts.content, /managed by another integration/i);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(saved.autorole.roleIds, []);
});

test('/set-autorole remove: role removed from the list', async () => {
    writeConfig({ autorole: { roleIds: ['r_member', 'r_gamer'] } });
    const configHandler = require('../../src/commands/config');
    const itx = makeAutoroleInteraction({
        action: 'remove',
        role: makeRole('r_member'),
        guildRoles: [makeRole('r_member'), makeRole('r_gamer')]
    });
    await configHandler(itx);
    const edit = itx._replies.find(r => r.type === 'edit');
    assert.match(edit.opts.content, /removed from the auto-role list/i);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(saved.autorole.roleIds, ['r_gamer']);
});

test('/set-autorole list: shows the list + the removeOnNewRole toggle state', async () => {
    writeConfig({ autorole: { roleIds: ['r_member'], removeOnNewRole: true } });
    const configHandler = require('../../src/commands/config');
    const itx = makeAutoroleInteraction({
        action: 'list',
        guildRoles: [makeRole('r_member')]
    });
    await configHandler(itx);
    const edit = itx._replies.find(r => r.type === 'edit');
    assert.match(edit.opts.content, /AUTO-ROLE ON JOIN.*\(1\/10\)/s);
    assert.match(edit.opts.content, /<@&r_member>/);
    assert.match(edit.opts.content, /Remove on another role: ON/i);
});

test('/set-autorole toggle: without the enabled option → flips the current value (false → true)', async () => {
    writeConfig({ autorole: { roleIds: ['r_member'] } }); // removeOnNewRole default false
    const configHandler = require('../../src/commands/config');
    const itx = makeAutoroleInteraction({ action: 'toggle', guildRoles: [makeRole('r_member')] });
    await configHandler(itx);
    const edit = itx._replies.find(r => r.type === 'edit');
    assert.match(edit.opts.content, /ON ✅/);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(saved.autorole.removeOnNewRole, true);
});

test('/set-autorole toggle: explicit enabled:false → toggle turned off', async () => {
    writeConfig({ autorole: { roleIds: [], removeOnNewRole: true } });
    const configHandler = require('../../src/commands/config');
    const itx = makeAutoroleInteraction({ action: 'toggle', enabled: false, guildRoles: [] });
    await configHandler(itx);
    const edit = itx._replies.find(r => r.type === 'edit');
    assert.match(edit.opts.content, /OFF ⛔/);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(saved.autorole.removeOnNewRole, false);
});

// ====================================================
// === 5. The btn_verify deprecation stub              ===
// ====================================================

test('btn_verify stub: replies with the new /setup-verify migration guide (no crash)', async () => {
    const verifyHandler = require('../../src/interactions/verify');
    const replies = [];
    await verifyHandler({
        isButton: () => true,
        customId: 'btn_verify',
        member: null, // the stub needs nothing — it must work on ANY legacy panel click
        reply: async opts => {
            replies.push(opts);
            return {};
        }
    });
    assert.strictEqual(replies.length, 1);
    assert.match(replies[0].content, /no longer works/i);
    // v3.28.0: the stub now points to the RE-ADDED /setup-verify wizard
    // (previously it pointed to the manual /setup-selfrole + /selfrole-add chain).
    assert.match(replies[0].content, /\/setup-verify/);
    assert.strictEqual(replies[0].flags, 64); // Ephemeral
});

// ====================================================
// === 6. Static contracts (anti-regression pins)     ===
// ====================================================

test('PIN (v3.28.0): /setup-verify is REGISTERED again — /set-verify-button stays removed', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'registry.js'), 'utf8');
    // v3.22.0 removed it; v3.28.0 RE-ADDED it (owner's request) — as a one-way
    // wizard over the self-role panel, NOT the old duplicated system.
    assert.ok(/name:\s*'setup-verify'/.test(src), '/setup-verify is registered (v3.28.0)');
    // The old companion command stays gone — the wizard covers its use.
    assert.ok(!/name:\s*'set-verify-button'/.test(src), '/set-verify-button must be removed');
    assert.ok(/name:\s*'set-autorole'/.test(src), '/set-autorole must be registered');
});

test('PIN: set-role & remove-role no longer offer verified/unverified choices', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'registry.js'), 'utf8');
    const setRoleBlock = src.slice(src.indexOf("name: 'set-role'"), src.indexOf("name: 'set-channel'"));
    assert.ok(!/value:\s*'verified'/.test(setRoleBlock), 'the verified choice must be gone');
    assert.ok(!/value:\s*'unverified'/.test(setRoleBlock), 'the unverified choice must be gone (v3.23.0)');
    const removeRoleBlock = src.slice(src.indexOf("name: 'remove-role'"), src.indexOf("name: 'set-midman-fee'"));
    assert.ok(!/value:\s*'verified'/.test(removeRoleBlock), 'remove-role: verified must be gone');
    assert.ok(!/value:\s*'unverified'/.test(removeRoleBlock), 'remove-role: unverified must be gone (v3.23.0)');
});

test('PIN: set-autorole registers the toggle action + enabled option', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'registry.js'), 'utf8');
    const block = src.slice(src.indexOf("name: 'set-autorole'"), src.indexOf("name: 'set-role'"));
    assert.ok(/value:\s*'toggle'/.test(block), 'the toggle action choice must exist');
    assert.ok(/name:\s*'enabled'/.test(block), 'the enabled boolean option must exist');
});

test('PIN: configManager defaults carry autorole.roleIds + removeOnNewRole', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'data', 'configManager.js'), 'utf8');
    assert.ok(/autorole:\s*\{\s*\n?\s*roleIds:\s*\[\],\s*\n?\s*removeOnNewRole:\s*false/.test(src), 'DEFAULTS.autorole = { roleIds: [], removeOnNewRole: false }');
    assert.ok(!/verifyButton:\s*\{/.test(src), 'DEFAULTS.verifyButton must be gone');
});

test('PIN: guildMemberUpdate carries the toggle rule + join exemption', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bot', 'events', 'guildMemberUpdate.js'), 'utf8');
    assert.ok(/TOGGLE "JOIN ROLES REMOVED ON A NEW ROLE"/.test(src));
    assert.ok(src.includes('autorole?.removeOnNewRole === true'), 'the rule must be gated by the toggle');
    assert.ok(src.includes('!joinIds.includes(r.id)'), 'join roles must be exempt');
    assert.ok(src.includes('revokeRoles(newMember, held'), 'removal must go through the engine');
});
