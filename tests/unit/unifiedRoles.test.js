/**
 * Unit tests for v4.3.0 — AUTO-ROLE DELETED, CLASSIC UNVERIFIED RESTORED.
 *
 * History: v3.23.0 replaced the Unverified marker concept with the
 * /set-autorole join list + the removeOnNewRole strip rule. v4.3.0 (owner's
 * request — CHRONOS parity) deleted BOTH and restored the classic chain:
 *
 *   1. memberHandler.onMemberAdd — grants roles.unverified on join.
 *   2. btn_verify — grants roles.verified AND removes roles.unverified
 *      directly (classic CHRONOS finish, v3.9.17-style honest messaging).
 *   3. The verify PANEL button (kind:'verify') does the same.
 *   4. guildMemberUpdate — the strip rule is GONE (regression pin).
 *   5. /set-autorole is unregistered; /set-role gains tipe:unverified.
 *   6. configManager — DEFAULTS carry no autorole; a load-time migration
 *      cleans the stale `autorole` key from v3.23.0–v4.2.x configs.
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

/** Write this guild's config (roles/channels) for a test case. */
function writeConfig(partial = {}) {
    fs.writeFileSync(
        configPath,
        JSON.stringify(
            {
                roles: partial.roles || {},
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
function makeMember({ has = [], guild, addFails = {}, removeFails = {} } = {}) {
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
                for (const id of list) {
                    if (removeFails[id]) throw new Error(`fake fail ${id}`);
                }
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

test('roleEngine (v4.3.0): joinRoleIds is GONE from the public API', () => {
    const engine = require('../../src/services/roleEngine');
    assert.strictEqual(typeof engine.joinRoleIds, 'undefined', 'joinRoleIds must not exist anymore');
    assert.strictEqual(typeof engine.grantRoles, 'function');
    assert.strictEqual(typeof engine.revokeRoles, 'function');
});

// ====================================================
// === 2. memberHandler.onMemberAdd — Unverified grant ===
// ====================================================

test('onMemberAdd (v4.3.0): grants the Unverified role on join', async () => {
    writeConfig({ roles: { unverified: 'r_unverified' } });
    const { onMemberAdd } = require('../../src/bot/memberHandler');
    const guild = makeGuild({ roles: [makeRole('r_unverified')] });
    const m = makeMember({ guild, has: [] });
    await onMemberAdd(m);
    assert.deepStrictEqual(m._calls.add, ['r_unverified'], 'the Unverified role must be granted on join');
});

test('onMemberAdd (v4.3.0): no unverified role configured → no grant', async () => {
    writeConfig({});
    const { onMemberAdd } = require('../../src/bot/memberHandler');
    const guild = makeGuild({ roles: [] });
    const m = makeMember({ guild });
    await onMemberAdd(m);
    assert.deepStrictEqual(m._calls.add, []);
});

test('onMemberAdd (v4.3.0): a stale autorole key in an old config is IGNORED + cleaned on load', async () => {
    // Simulate a config saved by v3.23.0–v4.2.x (has the deleted section).
    fs.writeFileSync(
        configPath,
        JSON.stringify(
            {
                roles: { unverified: 'r_unverified' },
                autorole: { roleIds: ['r_member'], removeOnNewRole: true },
                channels: {},
                messages: {}
            },
            null,
            4
        )
    );
    const { onMemberAdd } = require('../../src/bot/memberHandler');
    const guild = makeGuild({ roles: [makeRole('r_unverified'), makeRole('r_member')] });
    const m = makeMember({ guild, has: [] });
    await onMemberAdd(m);
    // Only the classic marker is granted — the autorole list is gone.
    assert.deepStrictEqual(m._calls.add, ['r_unverified']);
    // The load-time migration cleaned the stale key.
    const { getConfig } = require('../../src/data/configManager');
    const cfg = getConfig(GUILD_ID);
    assert.ok(!cfg.autorole, 'the stale autorole section must be cleaned by the v4.3.0 migration');
});

// ====================================================
// === 3. guildMemberUpdate — the strip rule is GONE   ===
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

test('v4.3.0 regression: NO auto-strip — a member gaining a role keeps everything', async () => {
    // Even with an old-style autorole config still on disk, nothing is stripped:
    // the rule was deleted (CHRONOS parity).
    fs.writeFileSync(
        configPath,
        JSON.stringify({ roles: {}, autorole: { roleIds: ['r_member'], removeOnNewRole: true }, channels: {}, messages: {} }, null, 4)
    );
    const guild = makeGuild({ roles: [makeRole('r_member'), makeRole('r_gamer')] });
    const m = await runMemberUpdate({ guild, oldHas: ['r_member'], newHas: ['r_member', 'r_gamer'] });
    assert.deepStrictEqual(m._calls.remove, [], 'no role may ever be auto-stripped by a role diff again');
});

test('v4.3.0 regression: unverified removal is NOT the event handler\'s job', async () => {
    // The marker is removed by the verify CLICK, not by "gets another role".
    writeConfig({ roles: { unverified: 'r_unverified' } });
    const guild = makeGuild({ roles: [makeRole('r_unverified'), makeRole('r_gamer')] });
    const m = await runMemberUpdate({ guild, oldHas: ['r_unverified'], newHas: ['r_unverified', 'r_gamer'] });
    assert.deepStrictEqual(m._calls.remove, [], 'gaining any role must NOT strip the Unverified marker');
});

// ====================================================
// === 4. btn_verify — the classic CHRONOS finish     ===
// ====================================================
// v4.2.0 restored the click; v4.3.0 adds the direct Unverified removal with
// the v3.9.17-style honest messaging. Full decision tree, faked member/guild.

function makeVerifyMember({ hasVerified = false, grantOk = true, hasUnverified = false, removeOk = true } = {}) {
    const granted = [];
    const removed = [];
    const member = {
        id: 'user_verify',
        user: { tag: 'verifier#1' },
        roles: {
            cache: {
                has: (id) => (id === 'role_verified' ? hasVerified : id === 'role_unverified' ? hasUnverified : false)
            },
            add: async (id) => {
                if (!grantOk) throw new Error('Missing Permissions');
                granted.push(id);
                return member;
            },
            remove: async (id) => {
                if (!removeOk) throw new Error('Missing Permissions');
                removed.push(id);
                return member;
            }
        }
    };
    return { member, granted, removed };
}

function attachGuild(member, { verifyPos = 1, unverifyPos = 1 } = {}) {
    const guild = makeGuild({
        roles: [makeRole('role_verified', { position: verifyPos }), makeRole('role_unverified', { position: unverifyPos })],
        botPosition: 10
    });
    member.guild = guild;
    member.client = { user: { id: 'bot' } };
    guild.members = new Map([[member.id, member]]);
    guild.members.me = { id: 'bot', roles: { highest: { position: 10 }, cache: new Map() } };
    return guild;
}

function makeVerifyInteraction({ member, config } = {}) {
    const replies = [];
    // getConfig(guildId) reads the sandboxed file — writeConfig() sets it up.
    if (config !== undefined) writeConfig(config);
    return {
        isButton: () => true,
        customId: 'btn_verify',
        guildId: GUILD_ID,
        member,
        reply: async opts => {
            replies.push(opts);
            return {};
        },
        _replies: replies
    };
}

test('btn_verify: Verified role not set → clear /setup-verify guidance', async () => {
    const verifyHandler = require('../../src/interactions/verify');
    const { member } = makeVerifyMember();
    const itx = makeVerifyInteraction({ member, config: { roles: {} } });
    await verifyHandler(itx);
    assert.strictEqual(itx._replies.length, 1);
    assert.match(itx._replies[0].content, /not set yet/i);
    assert.match(itx._replies[0].content, /\/setup-verify/);
    assert.strictEqual(itx._replies[0].flags, 64); // Ephemeral
});

test('btn_verify: member already verified → friendly no-op', async () => {
    const verifyHandler = require('../../src/interactions/verify');
    const { member } = makeVerifyMember({ hasVerified: true });
    const itx = makeVerifyInteraction({ member, config: { roles: { verified: 'role_verified' } } });
    await verifyHandler(itx);
    assert.strictEqual(itx._replies.length, 1);
    assert.match(itx._replies[0].content, /already verified/i);
});

test('btn_verify (v4.3.0 CLASSIC): grant + Unverified REMOVED, reply says both', async () => {
    const verifyHandler = require('../../src/interactions/verify');
    const { member, granted, removed } = makeVerifyMember({ hasUnverified: true });
    attachGuild(member);
    const itx = makeVerifyInteraction({
        member,
        config: { roles: { verified: 'role_verified', unverified: 'role_unverified' } }
    });
    await verifyHandler(itx);
    assert.deepStrictEqual(granted, ['role_verified']);
    assert.deepStrictEqual(removed, ['role_unverified'], 'the Unverified role must be removed directly');
    assert.match(itx._replies[0].content, /Verification successful/i);
    assert.match(itx._replies[0].content, /Unverified role has been removed/i);
});

test('btn_verify (v4.3.0): no Unverified role in config → honest info note', async () => {
    const verifyHandler = require('../../src/interactions/verify');
    const { member, removed } = makeVerifyMember();
    attachGuild(member);
    const itx = makeVerifyInteraction({ member, config: { roles: { verified: 'role_verified' } } });
    await verifyHandler(itx);
    assert.deepStrictEqual(removed, []);
    assert.match(itx._replies[0].content, /Unverified role is not set in config/i);
});

test('btn_verify (v4.3.0): Unverified removal FAILS → warning note, grant kept', async () => {
    const verifyHandler = require('../../src/interactions/verify');
    const { member, granted } = makeVerifyMember({ hasUnverified: true, removeOk: false });
    attachGuild(member);
    const itx = makeVerifyInteraction({
        member,
        config: { roles: { verified: 'role_verified', unverified: 'role_unverified' } }
    });
    await verifyHandler(itx);
    assert.deepStrictEqual(granted, ['role_verified'], 'the Verified grant still landed');
    assert.match(itx._replies[0].content, /cannot remove the Unverified role/i);
});

test('btn_verify: engine failure → honest bot-hierarchy message', async () => {
    const verifyHandler = require('../../src/interactions/verify');
    const { member } = makeVerifyMember({ grantOk: false });
    // Engine validation passes (assignable role) but discord.js add() throws —
    // the engine reports it as failed and the handler explains the cause.
    attachGuild(member);
    const itx = makeVerifyInteraction({ member, config: { roles: { verified: 'role_verified' } } });
    await verifyHandler(itx);
    assert.strictEqual(itx._replies.length, 1);
    assert.match(itx._replies[0].content, /cannot give you the Verified role/i);
});

test('btn_verify: incomplete member data → guarded reply', async () => {
    const verifyHandler = require('../../src/interactions/verify');
    const itx = makeVerifyInteraction({ member: null, config: { roles: { verified: 'role_verified' } } });
    await verifyHandler(itx);
    assert.strictEqual(itx._replies.length, 1);
    assert.match(itx._replies[0].content, /Incomplete member data/i);
});

// ====================================================
// === 5. The verify PANEL button (kind:'verify')     ===
// ====================================================
// /setup-verify mounts a once:true + exclusive:false panel — its grant path
// is `!panel.exclusive && !hasRole`, which must ALSO strip the Unverified
// role directly (same classic finish as btn_verify).

function makePanelInteraction({ member, panel, config } = {}) {
    const replies = [];
    if (config !== undefined) writeConfig(config);
    return {
        isButton: () => true,
        isStringSelectMenu: () => false,
        customId: `sr_btn:${panel.id}:role_verified`,
        guildId: GUILD_ID,
        guild: member.guild,
        member,
        reply: async opts => {
            replies.push(opts);
            return {};
        },
        _replies: replies
    };
}

test('verify panel click (v4.3.0): grant + Unverified removed directly', async () => {
    // Register a verify-kind panel in the self-role manager.
    const selfRoleManager = require('../../src/data/selfRoleManager');
    const panel = selfRoleManager.createPanel({
        guildId: GUILD_ID,
        channelId: 'chan_1',
        title: 'VERIFY',
        description: 'click',
        type: 'button',
        exclusive: false,
        once: true,
        kind: 'verify'
    });
    selfRoleManager.addRoleToPanel(panel.id, { roleId: 'role_verified', label: 'Verify Me', emoji: '✅', style: 'Success' });

    const { member, granted, removed } = makeVerifyMember({ hasUnverified: true });
    attachGuild(member);
    const handler = require('../../src/interactions/selfrole');
    const itx = makePanelInteraction({
        member,
        panel,
        config: { roles: { verified: 'role_verified', unverified: 'role_unverified' } }
    });
    await handler(itx);
    assert.deepStrictEqual(granted, ['role_verified']);
    assert.deepStrictEqual(removed, ['role_unverified'], 'the verify panel must strip the marker directly');
    assert.match(itx._replies[0].content, /Unverified role has been removed/i);
    selfRoleManager.deletePanel(panel.id);
});

test('verify panel click (v4.3.0): regular (non-verify) panels do NOT touch the marker', async () => {
    const selfRoleManager = require('../../src/data/selfRoleManager');
    const panel = selfRoleManager.createPanel({
        guildId: GUILD_ID,
        channelId: 'chan_1',
        title: 'GAMES',
        description: 'pick',
        type: 'button',
        exclusive: false,
        once: false
    });
    selfRoleManager.addRoleToPanel(panel.id, { roleId: 'role_verified', label: 'Gamer', emoji: '🎮' });

    const { member, removed } = makeVerifyMember({ hasUnverified: true });
    attachGuild(member);
    const handler = require('../../src/interactions/selfrole');
    const itx = makePanelInteraction({
        member,
        panel,
        config: { roles: { verified: 'role_verified', unverified: 'role_unverified' } }
    });
    await handler(itx);
    assert.deepStrictEqual(removed, [], 'a plain self-role panel must never strip the Unverified role');
    selfRoleManager.deletePanel(panel.id);
});

// ====================================================
// === 6. Static contracts (anti-regression pins)     ===
// ====================================================

test('PIN (v4.3.0): /set-autorole is UNREGISTERED', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'registry.js'), 'utf8');
    assert.ok(!/name:\s*'set-autorole'/.test(src), '/set-autorole must be gone (feature deleted)');
    assert.ok(!/name:\s*'setup-verify'/.test(src) === false, '/setup-verify stays registered');
});

test('PIN (v4.3.0): set-role & remove-role offer verified AND unverified', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'registry.js'), 'utf8');
    const setRoleBlock = src.slice(src.indexOf("name: 'set-role'"), src.indexOf("name: 'set-channel'"));
    assert.ok(/value:\s*'verified'/.test(setRoleBlock), 'the verified choice is back (v4.2.0)');
    assert.ok(/value:\s*'unverified'/.test(setRoleBlock), 'the unverified choice is back (v4.3.0)');
    const removeRoleBlock = src.slice(src.indexOf("name: 'remove-role'"), src.indexOf("name: 'set-midman-fee'"));
    assert.ok(/value:\s*'verified'/.test(removeRoleBlock), 'remove-role: verified is back (v4.2.0)');
    assert.ok(/value:\s*'unverified'/.test(removeRoleBlock), 'remove-role: unverified is back (v4.3.0)');
});

test('PIN (v4.3.0): configManager DEFAULTS carry NO autorole section', () => {
    const { DEFAULTS } = require('../../src/data/configManager');
    assert.ok(!('autorole' in DEFAULTS), 'DEFAULTS.autorole must be gone');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'data', 'configManager.js'), 'utf8');
    assert.ok(!/verifyButton:\s*\{/.test(src), 'DEFAULTS.verifyButton must be gone');
    assert.ok(!/autorole:\s*\{\s*\.\.\.DEFAULTs/.test(src), 'no autorole merge line');
});

test('PIN (v4.3.0): guildMemberUpdate carries NO strip rule', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bot', 'events', 'guildMemberUpdate.js'), 'utf8');
    assert.ok(!src.includes('removeOnNewRole'), 'the removeOnNewRole toggle must be gone');
    assert.ok(!src.includes('joinRoleIds'), 'joinRoleIds must not be imported anymore');
    assert.ok(!/revokeRoles\(/.test(src), 'no engine revoke call in the event handler');
});

test('PIN (v4.3.0): /set-role tipe:unverified saves roles.unverified', async () => {
    writeConfig({ roles: {} });
    const configHandler = require('../../src/commands/config');
    const guild = makeGuild({ roles: [makeRole('r_unverified')] });
    const replies = [];
    const itx = {
        commandName: 'set-role',
        client: { user: { username: 'TestBot' } },
        user: { id: 'admin1', tag: 'Admin#0001' },
        guildId: GUILD_ID,
        guild,
        options: {
            getString: () => 'unverified',
            getRole: () => makeRole('r_unverified')
        },
        deferReply: async () => {},
        editReply: async opts => {
            replies.push(opts);
            return {};
        }
    };
    await configHandler(itx);
    assert.match(replies[0].content, /Role \*\*unverified\*\* set to/i);
    assert.match(replies[0].content, /receive it automatically when they join/i);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(saved.roles.unverified, 'r_unverified');
});

test('PIN (v4.3.0): help catalog mentions tipe:unverified, not /set-autorole', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'helpCatalog.js'), 'utf8');
    assert.ok(!/set-autorole/.test(src), 'no /set-autorole command may remain in the help texts');
    assert.ok(/tipe:unverified/.test(src), 'the classic marker must be documented');
});
