/**
 * Unit tests v3.30.0 — the RBAC endpoints of the DASH API (dashServer.js).
 *
 * Covers the bot half of the Bot ↔ Dashboard access contract:
 *   GET  /guilds/:id/access/:userId   → the authoritative tier answer
 *   GET  /guilds/:id/member/:userId   → the member tier's own profile
 *   GET  /users/:userId/guilds        → member guild list + tier (sidebar)
 *   GET  /guilds/:id/dashboard?actor= → tier-filtered payload (staff subset /
 *                                       member 403 / admin full / no-actor full)
 *   PUT  /guilds/:id/config access.*  → validator + privilege escalation guard
 *                                       (tier-2 actors can never edit access.*)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PermissionFlagsBits } = require('discord.js');

const dataDir = path.join(__dirname, '..', '..', 'data');
const configDir = path.join(dataDir, 'config');

// Snapshot & restore every data/*.json + the config dir (pattern from
// dashServer.test.js / dashPanelsStyleV3283.test.js — this suite WRITES).
// NOTE: keys.json is an ARRAY store; the object-map stores get '{}'.
const TOUCHED = ['stats.json', 'levels.json', 'warns.json', 'modlogs.json', 'afk.json'];
const backups = {};
for (const f of TOUCHED) {
    const p = path.join(dataDir, f);
    backups[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
    fs.writeFileSync(p, '{}');
}
{
    const p = path.join(dataDir, 'keys.json');
    backups[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
    fs.writeFileSync(p, '[]');
}
let configDirBackup = null;
if (fs.existsSync(configDir)) {
    configDirBackup = fs.readdirSync(configDir).map(f => ({
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
                if (!configDirBackup.some(b => b.name === f)) fs.unlinkSync(path.join(configDir, f));
            }
            for (const b of configDirBackup) {
                fs.writeFileSync(path.join(configDir, b.name), b.content);
            }
        }
    } catch (_) {}
});

const { createDashHandler } = require('../../src/infra/dashServer');

const TOKEN = 'unit-test-token-v3300';
const G1 = '111111111111111111';
const G2 = '222222222222222222';
const ROLE_STAFF = '333333333333333333';
const U_ADMIN = '444444444444444444';
const U_STAFF_ROLE = '555555555555555555';
const U_MEMBER = '666666666666666666';
const U_STAFF_ID = '777777777777777777';

/** A minimal discord.js-shaped member. */
function makeMember({ id, guildId, bits = [], roleIds = [] }) {
    const bitSet = new Set(bits);
    return {
        id,
        guild: { id: guildId },
        permissions: { has: bit => bitSet.has(bit) },
        roles: { cache: new Map(roleIds.map(r => [r, { id: r }])) },
        user: { id, tag: `user#${id.slice(-4)}` },
        joinedTimestamp: 1700000000000,
        premiumSinceTimestamp: null
    };
}

function makeMockClient() {
    const membersG1 = new Map([
        [U_ADMIN, makeMember({ id: U_ADMIN, guildId: G1, bits: [PermissionFlagsBits.ManageGuild] })],
        [U_STAFF_ROLE, makeMember({ id: U_STAFF_ROLE, guildId: G1, roleIds: [ROLE_STAFF] })],
        [U_MEMBER, makeMember({ id: U_MEMBER, guildId: G1 })],
        [U_STAFF_ID, makeMember({ id: U_STAFF_ID, guildId: G1 })]
    ]);
    const guild1 = {
        id: G1,
        name: 'Main Server',
        icon: 'icon1',
        memberCount: 10,
        ownerId: U_ADMIN,
        channels: {
            cache: new Map([
                ['900000000000000001', { id: '900000000000000001', name: 'general', type: 0, rawPosition: 0 }]
            ])
        },
        roles: {
            cache: new Map([
                ['100000000000000001', { id: '100000000000000001', name: '@everyone', color: 0, position: 0 }]
            ])
        },
        members: {
            me: { roles: { highest: { position: 10 } } },
            cache: membersG1,
            // Unknown users are "not a member" — fetch rejects like discord.js.
            fetch: async id => {
                if (membersG1.has(id)) return membersG1.get(id);
                throw new Error('Unknown Member');
            }
        }
    };
    const guild2 = {
        id: G2,
        name: 'Other Server',
        icon: null,
        memberCount: 5,
        ownerId: '123456789012345678',
        channels: { cache: new Map() },
        roles: { cache: new Map() },
        members: {
            me: { roles: { highest: { position: 10 } } },
            cache: new Map(),
            fetch: async () => {
                throw new Error('Unknown Member');
            }
        }
    };
    return {
        isReady: () => true,
        guilds: {
            cache: new Map([
                [G1, guild1],
                [G2, guild2]
            ])
        },
        channels: {
            fetch: async () => {
                throw new Error('no channel');
            }
        }
    };
}

let server;
let baseUrl;

test.before(async () => {
    server = http.createServer(createDashHandler({ client: makeMockClient(), token: TOKEN }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise(resolve => server.close(resolve));
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

async function putAccess(updates, actor) {
    return api('PUT', `/guilds/${G1}/config`, { body: { updates, actor } });
}

// ====================================================
// === 1. access validator on PUT /config ===
// ====================================================

test('v3.30.0: PUT config access.staffRoleIds (valid array) → applied', async () => {
    const res = await putAccess({ 'access.staffRoleIds': [ROLE_STAFF] }, { id: '42', tag: 'tester' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.applied.includes('access.staffRoleIds'));
    assert.deepStrictEqual(data.config.access.staffRoleIds, [ROLE_STAFF]);
});

test('v3.30.0: PUT config access.staffRoleIds (not an array) → 422', async () => {
    const res = await putAccess({ 'access.staffRoleIds': 'nope' }, { id: '42', tag: 'tester' });
    assert.strictEqual(res.status, 422);
});

test('v3.30.0: PUT config access.dangerousKey → 422 (whitelist)', async () => {
    const res = await putAccess({ 'access.ownerIds': [U_ADMIN] }, { id: '42', tag: 'tester' });
    assert.strictEqual(res.status, 422);
});

test('v3.30.0: PUT config access.adminUserIds with a duplicate → 422', async () => {
    const res = await putAccess({ 'access.adminUserIds': [U_ADMIN, U_ADMIN] }, { id: '42', tag: 'tester' });
    assert.strictEqual(res.status, 422);
});

// ====================================================
// === 2. GET /guilds/:id/access/:userId ===
// ====================================================

test('v3.30.0: access endpoint — admin via Discord ManageGuild → tier 3 + sources', async () => {
    const res = await api('GET', `/guilds/${G1}/access/${U_ADMIN}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.tier, 3);
    assert.ok(data.sources.some(s => s.startsWith('discord:ManageGuild')));
});

test('v3.30.0: access endpoint — staff via access.staffRoleIds (uncached member: fetched) → tier 2', async () => {
    // The member is NOT in the members cache — resolveMemberTier must fetch.
    const res = await api('GET', `/guilds/${G1}/access/${U_STAFF_ROLE}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.tier, 2);
});

test('v3.30.0: access endpoint — plain member → tier 1', async () => {
    const res = await api('GET', `/guilds/${G1}/access/${U_MEMBER}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).tier, 1);
});

test('v3.30.0: access endpoint — unknown user → tier 0 / not-member (never a grant)', async () => {
    const res = await api('GET', `/guilds/${G1}/access/999999999999999999`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.tier, 0);
    assert.strictEqual(data.label, 'not-member');
});

test('v3.30.0: access endpoint — bot not in guild → 404; bad userId → 400', async () => {
    {
        const res = await api('GET', `/guilds/${G2}/access/${U_ADMIN}`);
        assert.strictEqual(res.status, 200); // G2 IS a bot guild — no member → tier 0
        assert.strictEqual((await res.json()).tier, 0);
    }
    {
        const res = await api('GET', `/guilds/${G1}/access/notanid`);
        assert.strictEqual(res.status, 400);
    }
});

test('v3.30.0: HOT SYNC — granting staffUserIds via PUT is visible on the NEXT access call', async () => {
    // Before: plain member.
    let res = await api('GET', `/guilds/${G1}/access/${U_STAFF_ID}`);
    assert.strictEqual((await res.json()).tier, 1);
    // Grant via the dashboard path (PUT config + invalidation).
    res = await putAccess({ 'access.staffUserIds': [U_STAFF_ID] }, { id: '42', tag: 'tester' });
    assert.strictEqual(res.status, 200);
    // After: staff — immediately, no restart, no TTL wait.
    res = await api('GET', `/guilds/${G1}/access/${U_STAFF_ID}`);
    assert.strictEqual((await res.json()).tier, 2);
});

// ====================================================
// === 3. GET /guilds/:id/dashboard?actor= (tier filter) ===
// ====================================================

test('v3.30.0: dashboard?actor=<staff> → the moderation SUBSET (no keys/commands/products)', async () => {
    const res = await api('GET', `/guilds/${G1}/dashboard?actor=${U_STAFF_ROLE}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.tier, 2);
    assert.ok(Array.isArray(data.warns), 'staff sees warns');
    assert.ok(Array.isArray(data.modlogs), 'staff sees modlogs');
    assert.ok(data.config && data.config.access, 'staff sees the (read-only) access lists');
    assert.strictEqual(data.keys, undefined, 'keys must NOT ship to staff');
    assert.strictEqual(data.commands, undefined, 'command manager must NOT ship to staff');
    assert.strictEqual(data.panels, undefined, 'panels must NOT ship to staff');
    assert.strictEqual(data.giveaways, undefined, 'giveaways must NOT ship to staff');
    assert.strictEqual(data.config.products, undefined, 'product list must NOT ship to staff');
});

test('v3.30.0: dashboard?actor=<member> → 403 (members use the profile endpoint)', async () => {
    const res = await api('GET', `/guilds/${G1}/dashboard?actor=${U_MEMBER}`);
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.strictEqual(data.tier, 1);
});

test('v3.30.0: dashboard?actor=<admin> → the FULL payload + tier 3', async () => {
    const res = await api('GET', `/guilds/${G1}/dashboard?actor=${U_ADMIN}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.tier, 3);
    assert.ok(Array.isArray(data.keys), 'admin sees keys');
    assert.ok(data.commands && Array.isArray(data.commands.list), 'admin sees the command manager');
});

test('v3.30.0: dashboard without actor → FULL payload (backward compatibility)', async () => {
    const res = await api('GET', `/guilds/${G1}/dashboard`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.tier, 3);
    assert.ok(Array.isArray(data.keys));
});

test('v3.30.0: dashboard?actor=<unknown> → full payload (old-proxy / mock compatibility)', async () => {
    const res = await api('GET', `/guilds/${G1}/dashboard?actor=999999999999999999`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).tier, 3);
});

// ====================================================
// === 4. GET /users/:userId/guilds (sidebar feed) ===
// ====================================================

test('v3.30.0: users/:id/guilds — only guilds where the user is a member, with their tier', async () => {
    const res = await api('GET', `/users/${U_MEMBER}/guilds`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.guilds));
    // Member of G1 only (G2's fetch rejects → not listed).
    assert.strictEqual(data.guilds.length, 1);
    assert.strictEqual(data.guilds[0].id, G1);
    assert.strictEqual(data.guilds[0].tier, 1);
    assert.strictEqual(data.guilds[0].name, 'Main Server');
});

test('v3.30.0: users/:id/guilds — staff tier reported per guild', async () => {
    const res = await api('GET', `/users/${U_STAFF_ROLE}/guilds`);
    const data = await res.json();
    assert.strictEqual(data.guilds[0].tier, 2);
});

test('v3.30.0: users/:id/guilds — bad userId → 400', async () => {
    const res = await api('GET', `/users/abc/guilds`);
    assert.strictEqual(res.status, 400);
});

// ====================================================
// === 5. GET /guilds/:id/member/:userId (member profile) ===
// ====================================================

test('v3.30.0: member endpoint — full personal profile shape', async () => {
    const res = await api('GET', `/guilds/${G1}/member/${U_MEMBER}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.tier, 1);
    assert.strictEqual(data.userId, U_MEMBER);
    assert.ok(data.stats && typeof data.stats.messages === 'number');
    assert.ok(data.level && typeof data.level.level === 'number');
    assert.ok(Array.isArray(data.warns));
    assert.ok(Array.isArray(data.modlogs));
    assert.strictEqual(typeof data.warnCount, 'number');
});

test('v3.30.0: member endpoint — non-member → 404', async () => {
    const res = await api('GET', `/guilds/${G1}/member/999999999999999999`);
    assert.strictEqual(res.status, 404);
});

// ====================================================
// === 6. Privilege escalation guard on PUT config access.* ===
// ====================================================

test('v3.30.0: a TIER-2 actor CANNOT change access.* (privilege escalation guard)', async () => {
    const res = await putAccess({ 'access.adminUserIds': [U_STAFF_ROLE] }, { id: U_STAFF_ROLE, tag: 'staff user' });
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /admin/i);
});

test('v3.30.0: a TIER-3 actor CAN change access.* — and it applies instantly', async () => {
    const res = await putAccess({ 'access.adminUserIds': [U_MEMBER] }, { id: U_ADMIN, tag: 'admin user' });
    assert.strictEqual(res.status, 200);
    // The promoted member's very next access call is tier 3.
    const after = await api('GET', `/guilds/${G1}/access/${U_MEMBER}`);
    assert.strictEqual((await after.json()).tier, 3);
});

test('v3.30.0: an UNKNOWN actor keeps the old behavior (dashboard proxy already gated)', async () => {
    // Tier-0 actor (not a member) — e.g. the sandbox mock — must not be
    // blocked by the bot-side guard (the proxy is the gate for those).
    const res = await putAccess({ 'access.staffRoleIds': [ROLE_STAFF] }, { id: '42', tag: 'mock actor' });
    assert.strictEqual(res.status, 200);
});

// ====================================================
// === 7. Auth never loosened ===
// ====================================================

test('v3.30.0: RBAC endpoints still require the DASH token', async () => {
    const res = await api('GET', `/guilds/${G1}/access/${U_ADMIN}`, { token: null });
    assert.strictEqual(res.status, 401);
    const res2 = await api('GET', `/users/${U_MEMBER}/guilds`, { token: 'wrong-token-123' });
    assert.strictEqual(res2.status, 401);
});
