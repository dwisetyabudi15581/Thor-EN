/**
 * Unit tests for v3.9.59 — BOOSTER AUTO ROLE.
 *
 * User request: "those who boost the server should get a role" — members who
 * boost the server automatically receive the admin-configured Booster role.
 *
 * What v3.9.59 adds (all covered here):
 *   1. Registry: /set-role & /remove-role gain the `booster` choice.
 *   2. boostHandler.applyBoostRole — grant/remove the role following boost
 *      status: healthy add, idempotent, remove, remove-without-role, ghost ID,
 *      not-set, roles.add throwing (never rejects), role-position guard.
 *   3. boostHandler.syncBoostRoles — STATE sync: live boosters missing the
 *      role → granted; boost-ended-while-offline → removed; MANUAL grants to
 *      regular members are NEVER revoked; bots skipped.
 *   4. guildMemberUpdate — live add/remove boost events call applyBoostRole.
 *   5. /set-role booster — config saved + RETROACTIVE application to the
 *      boosters that already exist (reply states the count).
 *   6. /test-booster — role-chain diagnostics (set → exists → position →
 *      permission) WITHOUT ever touching the role (the simulation stays pure).
 *   7. Help catalog: booster documented + All-Commands budget ≤ 5800.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// v3.10.0: per-guild config — the makeMember//set-role mocks use guild 'g_br',
// the local /test-booster mock uses guild 'g_tb'. writeConfig writes both so
// both handler paths read the same config.
const CONFIG_GUILD_IDS = ['g_br', 'g_tb'];
const configPaths = CONFIG_GUILD_IDS.map(g => path.join(DATA_DIR, 'config', `${g}.json`));
const boostsPath = path.join(DATA_DIR, 'boosts.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ====================================================
// === Sandbox: snapshot & restore config.json AND    ===
// === boosts.json                                   ===
// ====================================================
const backups = [
    ...configPaths.map(p => ({ path: p, had: fs.existsSync(p) })),
    { path: boostsPath, had: fs.existsSync(boostsPath) }
];
for (const b of backups) {
    if (b.had) fs.copyFileSync(b.path, b.path + '.test-backup');
}
process.on('exit', () => {
    for (const b of backups) {
        try {
            if (b.had) {
                fs.copyFileSync(b.path + '.test-backup', b.path);
                fs.rmSync(b.path + '.test-backup', { force: true });
            } else if (fs.existsSync(b.path)) {
                fs.rmSync(b.path, { force: true });
            }
        } catch (_) {}
    }
});

// ====================================================
// === Helpers                                       ===
// ====================================================

/** Write the mock guild config (roles + channels) — v3.10.0: per-guild path. */
function writeConfig({ roles = {}, channels = {} } = {}) {
    fs.mkdirSync(path.join(DATA_DIR, 'config'), { recursive: true });
    for (const p of configPaths) {
        fs.writeFileSync(p, JSON.stringify({ channels, roles, messages: {} }, null, 4));
    }
}

/** Standard booster role (position 3, below the bot role at position 10). */
const BOOSTER_ROLE = { id: 'r_boost', name: 'Booster', managed: false, position: 3 };

/** Fresh role copy — a test that mutates position cannot pollute other tests. */
function freshBoosterRole() {
    return { ...BOOSTER_ROLE };
}

/** Stub GuildMember with a recording role cache. */
function makeMember({ hasRole = false, boosting = true, addThrows = null, removeThrows = null, bot = false } = {}) {
    const calls = { add: [], remove: [] };
    return {
        id: 'u_member',
        __calls: calls,
        user: { id: 'u_member', tag: 'Member#0001', bot },
        premiumSinceTimestamp: boosting ? 1700000000000 : null,
        guild: {
            id: 'g_br',
            roles: { cache: new Map([['r_boost', freshBoosterRole()]]) },
            members: { me: { roles: { highest: { position: 10 } } } }
        },
        roles: {
            cache: { has: id => id === 'r_boost' && hasRole },
            add: async r => {
                if (addThrows) throw new Error(addThrows);
                calls.add.push(r);
            },
            remove: async r => {
                if (removeThrows) throw new Error(removeThrows);
                calls.remove.push(r);
            }
        }
    };
}

// ====================================================
// === 1. Registry contract                          ===
// ====================================================

test('registry contract: /set-role & /remove-role have the booster choice', () => {
    const { getCommands } = require('../../src/commands/registry');
    const setRole = getCommands().find(c => c.name === 'set-role');
    assert.ok(setRole, 'set-role registered');
    const tipe = setRole.options.find(o => o.name === 'tipe');
    assert.ok(
        tipe.choices.some(c => c.value === 'booster'),
        'booster choice present in set-role'
    );
    const removeRole = getCommands().find(c => c.name === 'remove-role');
    assert.ok(removeRole, 'remove-role registered');
    const tipeRm = removeRole.options.find(o => o.name === 'tipe');
    assert.ok(
        tipeRm.choices.some(c => c.value === 'booster'),
        'booster choice present in remove-role'
    );
});

// ====================================================
// === 2. applyBoostRole — unit                       ===
// ====================================================

test('applyBoostRole add (healthy): role granted once, result ok/added', async () => {
    writeConfig({ roles: { booster: 'r_boost' } });
    const { applyBoostRole } = require('../../src/bot/boostHandler');
    const member = makeMember({ hasRole: false });

    const res = await applyBoostRole(member, 'add');

    assert.deepStrictEqual(res, { ok: true, reason: 'added' });
    assert.strictEqual(member.__calls.add.length, 1, 'roles.add called once');
    assert.strictEqual(member.__calls.add[0].id, 'r_boost', 'the right role');
    assert.strictEqual(member.__calls.remove.length, 0, 'no remove');
});

test('applyBoostRole add idempotent: a member already holding the role is not re-added', async () => {
    writeConfig({ roles: { booster: 'r_boost' } });
    const { applyBoostRole } = require('../../src/bot/boostHandler');
    const member = makeMember({ hasRole: true });

    const res = await applyBoostRole(member, 'add');

    assert.deepStrictEqual(res, { ok: true, reason: 'already' });
    assert.strictEqual(member.__calls.add.length, 0, 'no roles.add call');
});

test('applyBoostRole remove: role revoked when the boost ends', async () => {
    writeConfig({ roles: { booster: 'r_boost' } });
    const { applyBoostRole } = require('../../src/bot/boostHandler');
    const member = makeMember({ hasRole: true, boosting: false });

    const res = await applyBoostRole(member, 'remove');

    assert.deepStrictEqual(res, { ok: true, reason: 'removed' });
    assert.strictEqual(member.__calls.remove.length, 1, 'roles.remove called');
});

test('applyBoostRole remove without the role: clean no-op (no error)', async () => {
    writeConfig({ roles: { booster: 'r_boost' } });
    const { applyBoostRole } = require('../../src/bot/boostHandler');
    const member = makeMember({ hasRole: false, boosting: false });

    const res = await applyBoostRole(member, 'remove');

    assert.deepStrictEqual(res, { ok: true, reason: 'absent' });
    assert.strictEqual(member.__calls.remove.length, 0, 'no roles.remove call');
});

test('applyBoostRole ghost ID: role deleted from the server → no crash, no add', async () => {
    writeConfig({ roles: { booster: 'r_ghost' } });
    const { applyBoostRole } = require('../../src/bot/boostHandler');
    const member = makeMember({ hasRole: false });

    const res = await applyBoostRole(member, 'add');

    assert.deepStrictEqual(res, { ok: false, reason: 'ghost' });
    assert.strictEqual(member.__calls.add.length, 0);
});

test('applyBoostRole role not set: no-op (the optional feature is off)', async () => {
    writeConfig({ roles: {} });
    const { applyBoostRole } = require('../../src/bot/boostHandler');
    const member = makeMember({ hasRole: false });

    const res = await applyBoostRole(member, 'add');

    assert.deepStrictEqual(res, { ok: false, reason: 'not-set' });
    assert.strictEqual(member.__calls.add.length, 0);
});

test('applyBoostRole roles.add throws: does NOT reject — returned as {ok:false,reason:"error"}', async () => {
    writeConfig({ roles: { booster: 'r_boost' } });
    const { applyBoostRole } = require('../../src/bot/boostHandler');
    const member = makeMember({ hasRole: false, addThrows: 'Missing Permissions' });

    const res = await applyBoostRole(member, 'add');

    assert.deepStrictEqual(res, { ok: false, reason: 'error' });
});

test('applyBoostRole position guard: role ABOVE the bot role → not added, reason "position"', async () => {
    writeConfig({ roles: { booster: 'r_boost' } });
    const { applyBoostRole } = require('../../src/bot/boostHandler');
    const member = makeMember({ hasRole: false });
    // Booster role moved to position 10 = same height as the bot role (10).
    member.guild.roles.cache.get('r_boost').position = 10;

    const res = await applyBoostRole(member, 'add');

    assert.deepStrictEqual(res, { ok: false, reason: 'position' });
    assert.strictEqual(member.__calls.add.length, 0, 'roles.add must not be called');
});

// ====================================================
// === 3. syncBoostRoles — state sync                ===
// ====================================================

test('syncBoostRoles: live booster missing the role gets it; a manual grant to a regular member is NOT revoked; removed stripped; bots skipped', async () => {
    writeConfig({ roles: { booster: 'r_boost' } });
    const { syncBoostRoles } = require('../../src/bot/boostHandler');

    const boosterNoRole = makeMember({ hasRole: false, boosting: true }); // → must be added
    const boosterHasRole = makeMember({ hasRole: true, boosting: true }); // → already correct, untouched
    const plainWithRole = makeMember({ hasRole: true, boosting: false }); // manual grant → do NOT revoke
    const botBooster = makeMember({ hasRole: false, boosting: true, bot: true }); // bot → skip
    const lapsedBooster = makeMember({ hasRole: true, boosting: false }); // boost ended offline → removed

    // Unique ids so cache.get(userId) finds the right one.
    boosterNoRole.user.id = 'u_booster_new';
    boosterHasRole.user.id = 'u_booster_ok';
    plainWithRole.user.id = 'u_plain';
    botBooster.user.id = 'u_bot';
    lapsedBooster.user.id = 'u_lapsed';

    const members = new Map([
        ['u_booster_new', boosterNoRole],
        ['u_booster_ok', boosterHasRole],
        ['u_plain', plainWithRole],
        ['u_bot', botBooster],
        ['u_lapsed', lapsedBooster]
    ]);
    const guild = {
        id: 'g_br',
        roles: { cache: new Map([['r_boost', freshBoosterRole()]]) },
        members: { cache: members, me: { roles: { highest: { position: 10 } } } }
    };

    const out = await syncBoostRoles(guild, ['u_lapsed']);

    assert.deepStrictEqual(out, { applied: 1, removed: 1 });
    assert.strictEqual(boosterNoRole.__calls.add.length, 1, 'new booster added');
    assert.strictEqual(boosterHasRole.__calls.add.length, 0, 'booster already holding the role untouched');
    assert.strictEqual(plainWithRole.__calls.remove.length, 0, 'manual grant NOT revoked');
    assert.strictEqual(botBooster.__calls.add.length, 0, 'bot skipped');
    assert.strictEqual(lapsedBooster.__calls.remove.length, 1, 'boost ended offline → role removed');
});

test('syncBoostRoles: role not set → silent no-op, {applied:0, removed:0}', async () => {
    writeConfig({ roles: {} });
    const { syncBoostRoles } = require('../../src/bot/boostHandler');
    const member = makeMember({ hasRole: false, boosting: true });
    const guild = {
        id: 'g_br',
        roles: { cache: new Map() },
        members: { cache: new Map([['u_member', member]]) }
    };
    const out = await syncBoostRoles(guild, []);
    assert.deepStrictEqual(out, { applied: 0, removed: 0 });
    assert.strictEqual(member.__calls.add.length, 0);
});

// ====================================================
// === 4. guildMemberUpdate — live event             ===
// ====================================================

test('guildMemberUpdate: boost STARTS (premium_since null → date) → booster role added', async () => {
    writeConfig({ roles: { booster: 'r_boost' } });
    // Reset the boostManager store so it is clean between tests (the sandboxed
    // file is restored on exit).
    if (fs.existsSync(boostsPath)) fs.rmSync(boostsPath, { force: true });
    require('../../src/data/boostManager').reload();

    const member = makeMember({ hasRole: false, boosting: true });
    const oldMember = {
        ...member,
        premiumSinceTimestamp: null,
        roles: member.roles // same reference — the old cache "has no role yet"
    };
    const event = require('../../src/bot/events/guildMemberUpdate');

    await event.execute(oldMember, member);

    assert.strictEqual(member.__calls.add.length, 1, 'applyBoostRole ran via the live event');
    // Boost history still recorded (onBoostChange runs BEFORE the role).
    const boosts = JSON.parse(fs.readFileSync(boostsPath, 'utf8'));
    assert.ok(boosts['g_br:u_member'], 'boost history recorded');
});

test('guildMemberUpdate: boost ENDS (premium_since date → null) → booster role revoked', async () => {
    writeConfig({ roles: { booster: 'r_boost' } });
    if (fs.existsSync(boostsPath)) fs.rmSync(boostsPath, { force: true });
    require('../../src/data/boostManager').reload();

    const member = makeMember({ hasRole: true, boosting: false });
    const oldMember = {
        ...member,
        premiumSinceTimestamp: 1700000000000,
        roles: member.roles
    };
    const event = require('../../src/bot/events/guildMemberUpdate');

    await event.execute(oldMember, member);

    assert.strictEqual(member.__calls.remove.length, 1, 'role revoked when the boost ends');
});

// ====================================================
// === 5. /set-role booster — retroactive            ===
// ====================================================

test('/set-role booster: config saved + retroactive to existing boosters + reply states the count', async () => {
    writeConfig({ roles: {} });
    if (fs.existsSync(boostsPath)) fs.rmSync(boostsPath, { force: true });
    require('../../src/data/boostManager').reload();

    const booster = makeMember({ hasRole: false, boosting: true });
    booster.user.id = 'u_booster_live';
    const roleOption = { id: 'r_boost', name: 'Booster', managed: false, position: 3 };

    const replies = [];
    const interaction = {
        commandName: 'set-role',
        client: { user: { username: 'TestBot', displayAvatarURL: () => 'http://x/a.png' } },
        user: { id: 'admin1', tag: 'Admin#0001' },
        guild: {
            id: 'g_br',
            roles: { cache: new Map([['r_boost', freshBoosterRole()]]) },
            members: {
                me: { roles: { highest: { position: 10 } } },
                fetch: async () => {},
                cache: new Map([['u_booster_live', booster]])
            }
        },
        options: {
            getString: () => 'booster',
            getRole: () => roleOption
        },
        deferReply: async () => {},
        editReply: async opts => {
            replies.push(opts);
            return {};
        }
    };

    await require('../../src/commands/config')(interaction);

    // Config saved (v3.10.0: /set-role writes guild 'g_br' config).
    const saved = JSON.parse(fs.readFileSync(configPaths[0], 'utf8'));
    assert.strictEqual(saved.roles.booster, 'r_boost', 'roles.booster saved');
    // Retroactive: the member currently boosting gets the role right away.
    assert.strictEqual(booster.__calls.add.length, 1, 'the live booster gets the role right away');
    // The admin reply states the applied count.
    assert.match(replies[0].content, /Role \*\*booster\*\* set to/);
    assert.match(replies[0].content, /1 member\(s\) currently boosting/);
});

// ====================================================
// === 6. /test-booster — role diagnostics (pure)    ===
// ====================================================

/** /test-booster interaction stub in the testBooster.test.js style + roles. */
function makeTestBoosterInteraction({ configRoles = {} } = {}) {
    const sent = [];
    const currentCh = { id: 'ch_cur', name: 'cur', send: async p => sent.push(p) };
    const boosterRole = { id: 'r_boost', name: 'Booster', position: 3 };
    // The cache always holds the REAL role ('r_boost') — when the config points
    // at another ID (ghost), guild.roles.cache.get() cannot find it.
    const roleCache = new Map([['r_boost', boosterRole]]);
    const roleCalls = { add: [], remove: [] };
    const guild = {
        id: 'g_tb',
        name: 'TestServer',
        iconURL: () => null,
        premiumTier: 1,
        premiumSubscriptionCount: 3,
        channels: { cache: new Map() },
        roles: { cache: roleCache },
        members: {
            me: { id: 'bot_me', roles: { highest: { position: 10 } }, permissions: { has: () => true } }
        }
    };
    const member = {
        guild,
        premiumSinceTimestamp: null,
        roles: {
            cache: { has: () => false },
            add: async r => roleCalls.add.push(r),
            remove: async r => roleCalls.remove.push(r)
        },
        user: { id: 'user_admin', bot: false, tag: 'Admin#0001', displayAvatarURL: () => 'https://cdn.example/a.png' }
    };
    const replies = [];
    const interaction = {
        commandName: 'test-booster',
        client: {},
        deferReply: async () => {},
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        guild,
        member,
        user: member.user,
        channel: currentCh,
        options: { getString: () => 'add', getBoolean: () => null }
    };
    interaction.__replies = replies;
    interaction.__roleCalls = roleCalls;
    return interaction;
}

test('/test-booster (role set & healthy): ✅ booster role line + grant/revoke semantics', async () => {
    writeConfig({ roles: { booster: 'r_boost' }, channels: {} });
    const interaction = makeTestBoosterInteraction({ configRoles: { booster: 'r_boost' } });

    await require('../../src/commands/stats')(interaction);

    const reply = interaction.__replies[0].content;
    assert.match(reply, /booster role:/);
    assert.match(reply, /granted automatically when a member boosts, removed when the boost ends/);
    // Pure simulation: the admin's role is NEVER touched.
    assert.strictEqual(interaction.__roleCalls.add.length, 0, 'no roles.add');
    assert.strictEqual(interaction.__roleCalls.remove.length, 0, 'no roles.remove');
    assert.match(reply, /booster role is never touched/);
});

test('/test-booster (ghost role): ❌ line + the fix command', async () => {
    writeConfig({ roles: { booster: 'r_ghost' }, channels: {} });
    const interaction = makeTestBoosterInteraction({ configRoles: { booster: 'r_ghost' } }); // not cached

    await require('../../src/commands/stats')(interaction);

    const reply = interaction.__replies[0].content;
    assert.match(reply, /booster role: not found/);
    assert.match(reply, /\/set-role booster @role/);
});

test('/test-booster (role not set): ℹ️ optional line — no error', async () => {
    writeConfig({ roles: {}, channels: {} });
    const interaction = makeTestBoosterInteraction({});

    await require('../../src/commands/stats')(interaction);

    const reply = interaction.__replies[0].content;
    assert.match(reply, /Booster role: not set \(optional\)/);
    assert.match(reply, /\/set-role booster @role/);
});

// ====================================================
// === 7. Help catalog — docs + budget               ===
// ====================================================

test('help catalog: booster role documented (roles + stats) + budget safe', () => {
    const { HELP_CATEGORIES, buildAllEmbeds, embedTotalChars, searchHelp } = require('../../src/ui/helpCatalog');
    const rolesCat = HELP_CATEGORIES.find(c => c.id === 'roles');
    assert.ok(rolesCat.lines.some(l => l.includes('booster')), 'set-role compact line mentions booster');
    assert.match(rolesCat.detail.join('\n'), /tipe:booster/, 'roles guide explains tipe:booster');

    const statsCat = HELP_CATEGORIES.find(c => c.id === 'stats');
    assert.match(statsCat.detail.join('\n'), /granted\/removed automatically along with the boost/, 'boost guide mentions the auto role');

    // All-Commands budget still holds.
    const all = buildAllEmbeds();
    const total = all.reduce((s, e) => s + embedTotalChars(e), 0);
    assert.ok(total <= 5800, `All-Commands total ${total} ≤ 5800`);

    // set-role booster is findable via search.
    const result = searchHelp('booster');
    assert.ok(result.totalBlocks >= 1, 'searching "booster" finds a related category');
});
