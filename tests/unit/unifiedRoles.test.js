/**
 * Unit tests for v3.22.0 — THE UNIFIED ROLE SYSTEM.
 *
 * What changed (all covered here):
 *   1. src/services/roleEngine.js — the single gateway for role grants:
 *      validation (@everyone / managed / hierarchy), idempotency, batch
 *      fallback, structured results, joinRoleIds().
 *   2. guildMemberUpdate — the UNIVERSAL UNVERIFIED RULE: a member holding
 *      the Unverified marker who receives ANY other role (from any source)
 *      loses the marker. Join roles (the /set-autorole list) are exempt so
 *      granting @Member + @Unverified at join doesn't "verify" everyone.
 *   3. memberHandler.onMemberAdd — grants the join list (autorole +
 *      Unverified) through the engine.
 *   4. /set-autorole — add / remove / list.
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
                autorole: partial.autorole || { roleIds: [] },
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
    assert.match(res.failed[0].error, /ABOVE the bot/i);
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

test('roleEngine: joinRoleIds — autorole list + unverified marker, deduped', () => {
    const { joinRoleIds } = require('../../src/services/roleEngine');
    assert.deepStrictEqual(joinRoleIds({ autorole: { roleIds: ['a', 'b'] }, roles: { unverified: 'u' } }), ['a', 'b', 'u']);
    assert.deepStrictEqual(joinRoleIds({ autorole: { roleIds: ['u', 'a'] }, roles: { unverified: 'u' } }), ['u', 'a']);
    assert.deepStrictEqual(joinRoleIds({ autorole: { roleIds: [] }, roles: {} }), []);
    assert.deepStrictEqual(joinRoleIds({}), []);
});

// ====================================================
// === 2. The universal Unverified rule                ===
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

test('universal rule: member with Unverified gains a self-role → marker removed', async () => {
    writeConfig({ roles: { unverified: 'r_unverified' } });
    const guild = makeGuild({ roles: [makeRole('r_unverified'), makeRole('r_gamer')] });
    const m = await runMemberUpdate({ guild, oldHas: ['r_unverified'], newHas: ['r_unverified', 'r_gamer'] });
    assert.deepStrictEqual(m._calls.remove, ['r_unverified'], 'the marker must be revoked');
});

test('universal rule: join-list roles do NOT trigger removal (join grant exemption)', async () => {
    writeConfig({ roles: { unverified: 'r_unverified' }, autorole: { roleIds: ['r_member'] } });
    const guild = makeGuild({ roles: [makeRole('r_unverified'), makeRole('r_member')] });
    // A join grant: unverified + autorole roles arrive together.
    const m = await runMemberUpdate({ guild, oldHas: [], newHas: ['r_unverified', 'r_member'] });
    assert.deepStrictEqual(m._calls.remove, [], 'join roles must NOT remove the marker');
});

test('universal rule: the marker itself being added does NOT self-remove', async () => {
    writeConfig({ roles: { unverified: 'r_unverified' } });
    const guild = makeGuild({ roles: [makeRole('r_unverified')] });
    const m = await runMemberUpdate({ guild, oldHas: [], newHas: ['r_unverified'] });
    assert.deepStrictEqual(m._calls.remove, []);
});

test('universal rule: no marker configured → nothing happens', async () => {
    writeConfig({});
    const guild = makeGuild({ roles: [makeRole('r_gamer')] });
    const m = await runMemberUpdate({ guild, oldHas: [], newHas: ['r_gamer'] });
    assert.deepStrictEqual(m._calls.remove, []);
});

test('universal rule: member WITHOUT the marker gains a role → untouched', async () => {
    writeConfig({ roles: { unverified: 'r_unverified' } });
    const guild = makeGuild({ roles: [makeRole('r_unverified'), makeRole('r_gamer')] });
    const m = await runMemberUpdate({ guild, oldHas: [], newHas: ['r_gamer'] });
    assert.deepStrictEqual(m._calls.remove, []);
});

test('universal rule: a BOOST role (managed, granted by Discord) counts as the first role', async () => {
    writeConfig({ roles: { unverified: 'r_unverified' } });
    const guild = makeGuild({ roles: [makeRole('r_unverified'), makeRole('r_booster', { managed: true })] });
    const m = await runMemberUpdate({ guild, oldHas: ['r_unverified'], newHas: ['r_unverified', 'r_booster'] });
    assert.deepStrictEqual(m._calls.remove, ['r_unverified']);
});

// ====================================================
// === 3. memberHandler.onMemberAdd — join grant       ===
// ====================================================

test('onMemberAdd: grants autorole list + Unverified in one engine call', async () => {
    writeConfig({ roles: { unverified: 'r_unverified' }, autorole: { roleIds: ['r_member'] } });
    const { onMemberAdd } = require('../../src/bot/memberHandler');
    const guild = makeGuild({ roles: [makeRole('r_unverified'), makeRole('r_member')] });
    // memberHandler needs welcome channel lookup — none set → warning path.
    const m = makeMember({ guild, has: [] });
    await onMemberAdd(m);
    assert.deepStrictEqual(m._calls.add.sort(), ['r_member', 'r_unverified']);
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

function makeAutoroleInteraction({ action, role, guildRoles, botPos = 10 }) {
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
            getRole: () => role || null
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

test('/set-autorole list: shows the list + the Unverified marker note', async () => {
    writeConfig({ roles: { unverified: 'r_unverified' }, autorole: { roleIds: ['r_member'] } });
    const configHandler = require('../../src/commands/config');
    const itx = makeAutoroleInteraction({
        action: 'list',
        guildRoles: [makeRole('r_unverified'), makeRole('r_member')]
    });
    await configHandler(itx);
    const edit = itx._replies.find(r => r.type === 'edit');
    assert.match(edit.opts.content, /AUTO-ROLE ON JOIN.*\(1\/10\)/s);
    assert.match(edit.opts.content, /<@&r_member>/);
    assert.match(edit.opts.content, /Unverified marker/i);
});

// ====================================================
// === 5. The btn_verify deprecation stub              ===
// ====================================================

test('btn_verify stub: replies with the self-role migration guide (no crash)', async () => {
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
    assert.match(replies[0].content, /setup-selfrole/);
    assert.strictEqual(replies[0].flags, 64); // Ephemeral
});

// ====================================================
// === 6. Static contracts (anti-regression pins)     ===
// ====================================================

test('PIN: the verify command registrations are gone from the registry', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'registry.js'), 'utf8');
    assert.ok(!/name:\s*'setup-verify'/.test(src), '/setup-verify must be removed');
    assert.ok(!/name:\s*'set-verify-button'/.test(src), '/set-verify-button must be removed');
    assert.ok(/name:\s*'set-autorole'/.test(src), '/set-autorole must be registered');
});

test('PIN: set-role no longer offers the verified choice', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'registry.js'), 'utf8');
    const setRoleBlock = src.slice(src.indexOf("name: 'set-role'"), src.indexOf("name: 'set-channel'"));
    assert.ok(!/value:\s*'verified'/.test(setRoleBlock), 'the verified choice must be gone');
    assert.ok(/value:\s*'unverified'/.test(setRoleBlock), 'the unverified choice must stay');
});

test('PIN: configManager defaults carry autorole, not verifyButton', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'data', 'configManager.js'), 'utf8');
    assert.ok(/autorole:\s*\{\s*\n?\s*roleIds:\s*\[\]/.test(src), 'DEFAULTS.autorole.roleIds = []');
    assert.ok(!/verifyButton:\s*\{/.test(src), 'DEFAULTS.verifyButton must be gone');
});

test('PIN: guildMemberUpdate carries the universal rule + join exemption', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bot', 'events', 'guildMemberUpdate.js'), 'utf8');
    assert.ok(/UNIVERSAL UNVERIFIED RULE/.test(src));
    assert.ok(src.includes('joinRoleIds(config).includes(r.id)'), 'join roles must be exempt');
    assert.ok(src.includes('revokeRoles(newMember, [unverifiedId]'), 'removal must go through the engine');
});
