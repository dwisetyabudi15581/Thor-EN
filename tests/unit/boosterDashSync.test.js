/**
 * v4.4.2 — booster auto-role set from the WEB applies retroactively
 * (dashboard sync parity):
 *   - PUT /guilds/:id/config with updates['roles.booster'] saves the role
 *     AND runs syncBoostRoles(guild, []) — the exact /set-role booster
 *     behavior (config.js): every member currently boosting gets the role
 *     right away; boosts that ended are NOT touched (removedUserIds empty).
 *   - A sync FAILURE never fails the PUT (the role is already saved; the
 *     startup sync in ready.js catches up on the next restart).
 *   - PUTs that do NOT touch roles.booster never run the sync.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Snowflake-shaped: the DASH API validates the guild id format.
const GUILD_ID = '999555444333222777';

function resetGuildConfig() {
    const { configPathFor } = require('../../src/data/configManager');
    const file = configPathFor(GUILD_ID);
    try {
        fs.unlinkSync(file);
    } catch (_) {}
    return file;
}

test('dashParity: PUT config roles.booster — retroactive syncBoostRoles runs over the live roster (HTTP end-to-end)', async () => {
    resetGuildConfig();
    const http = require('http');
    const { setField, getConfig } = require('../../src/data/configManager');
    const { createDashHandler } = require('../../src/infra/dashServer');

    const TOKEN = 'bs-dash-token';
    const BOOSTER_ROLE_ID = '888555444333222111';
    const BOOSTER_ID = '111222333444555666'; // currently boosting, no role yet
    const PLAIN_ID = '121212121212121212'; // regular member
    const ENDED_ID = '131313131313131313'; // boost ended, still holds the role

    const grantCalls = [];

    // Members shaped for syncBoostRoles/applyBoostRole: premiumSinceTimestamp
    // marks a LIVE booster; roles.add is the observable grant.
    const mkMember = (id, tag, { premiumSinceTimestamp = null, roleIds = [] } = {}) => ({
        id,
        user: { id, tag, bot: false },
        premiumSinceTimestamp,
        roles: {
            cache: new Map(roleIds.map((rid) => [rid, true])),
            add: async (role) => {
                grantCalls.push({ id, action: 'add', roleId: role.id });
            }
        }
    });
    const boosterMember = mkMember(BOOSTER_ID, 'livebooster#1', { premiumSinceTimestamp: 1750000000000 });
    const endedMember = mkMember(ENDED_ID, 'endedbooster#2', { roleIds: [BOOSTER_ROLE_ID] });
    const plainMember = mkMember(PLAIN_ID, 'regular#3');

    const guild = {
        id: GUILD_ID,
        name: 'Booster Sync Server',
        channels: { cache: new Map() },
        roles: { cache: new Map([[BOOSTER_ROLE_ID, { id: BOOSTER_ROLE_ID, name: 'Booster', color: 0xf47fff, position: 2 }]]) },
        members: {
            me: { roles: { highest: { position: 10 } } },
            cache: new Map([
                [BOOSTER_ID, boosterMember],
                [ENDED_ID, endedMember],
                [PLAIN_ID, plainMember]
            ]),
            fetch: async () => null
        }
    };
    // The member needs a .guild back-reference for applyBoostRole.
    for (const m of guild.members.cache.values()) m.guild = guild;

    const client = {
        isReady: () => true,
        guilds: { cache: new Map([[GUILD_ID, guild]]), fetch: async () => guild },
        channels: { fetch: async () => null },
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
        // Sanity: the feature is off before the PUT.
        assert.strictEqual(getConfig(GUILD_ID).roles.booster, undefined, 'booster role not set yet');

        // The web sets the booster role (the new v4.7.0 dashboard field).
        const res = await api('PUT', `/guilds/${GUILD_ID}/config`, {
            body: { actor: { id: '42', tag: 'web-tester' }, updates: { 'roles.booster': BOOSTER_ROLE_ID } }
        });
        assert.strictEqual(res.status, 200, `PUT config accepted (got ${res.status})`);
        const payload = await res.json();
        assert.deepStrictEqual(payload.applied, ['roles.booster'], 'exactly the one field applied');

        // The config saved…
        assert.strictEqual(getConfig(GUILD_ID).roles.booster, BOOSTER_ROLE_ID, 'role saved to config');

        // …and the RETROACTIVE sync ran over the live roster:
        // the live booster (missing the role) got it, the regular member was
        // untouched, and the ended boost (removedUserIds is empty on this
        // path) was NOT stripped — /set-role booster semantics.
        assert.strictEqual(grantCalls.length, 1, 'exactly one grant happened');
        assert.strictEqual(grantCalls[0].id, BOOSTER_ID, 'granted to the live booster');
        assert.strictEqual(grantCalls[0].action, 'add', 'it was an add');
        assert.strictEqual(grantCalls[0].roleId, BOOSTER_ROLE_ID, 'the configured booster role');
    } finally {
        server.close();
        resetGuildConfig();
    }
});

test('dashParity: PUT config without roles.booster — the retroactive sync never runs', async () => {
    resetGuildConfig();
    const http = require('http');
    const { createDashHandler } = require('../../src/infra/dashServer');

    const TOKEN = 'bs-dash-token-2';
    let membersFetchCalls = 0;

    const guild = {
        id: GUILD_ID,
        name: 'No Booster Sync Server',
        channels: { cache: new Map() },
        roles: { cache: new Map() },
        members: {
            me: { roles: { highest: { position: 10 } } },
            cache: new Map(),
            fetch: async () => {
                membersFetchCalls += 1;
                return null;
            }
        }
    };
    const client = {
        isReady: () => true,
        guilds: { cache: new Map([[GUILD_ID, guild]]), fetch: async () => guild },
        channels: { fetch: async () => null },
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
        const res = await api('PUT', `/guilds/${GUILD_ID}/config`, {
            body: { actor: { id: '42', tag: 'web-tester' }, updates: { 'channels.welcome': '555000111222333444' } }
        });
        assert.strictEqual(res.status, 200, `PUT config accepted (got ${res.status})`);
        assert.strictEqual(membersFetchCalls, 0, 'no roster fetch — the booster sync path was never entered');
    } finally {
        server.close();
        resetGuildConfig();
    }
});

test('dashParity: PUT config roles.booster with a sync FAILURE — the PUT still succeeds (best-effort)', async () => {
    resetGuildConfig();
    const http = require('http');
    const { getConfig } = require('../../src/data/configManager');
    const { createDashHandler } = require('../../src/infra/dashServer');

    const TOKEN = 'bs-dash-token-3';
    const BOOSTER_ROLE_ID = '888555444333222999';

    // A guild whose members.fetch THROWS — the sync fails after the save.
    const guild = {
        id: GUILD_ID,
        name: 'Broken Sync Server',
        channels: { cache: new Map() },
        roles: { cache: new Map([[BOOSTER_ROLE_ID, { id: BOOSTER_ROLE_ID, name: 'Booster', color: 0xf47fff, position: 2 }]]) },
        members: {
            me: { roles: { highest: { position: 10 } } },
            cache: new Map(),
            fetch: async () => {
                throw new Error('roster fetch exploded');
            }
        }
    };
    const client = {
        isReady: () => true,
        guilds: { cache: new Map([[GUILD_ID, guild]]), fetch: async () => guild },
        channels: { fetch: async () => null },
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
        const res = await api('PUT', `/guilds/${GUILD_ID}/config`, {
            body: { actor: { id: '42', tag: 'web-tester' }, updates: { 'roles.booster': BOOSTER_ROLE_ID } }
        });
        assert.strictEqual(res.status, 200, `PUT still succeeds (got ${res.status}) — the sync failure is logged, not thrown`);
        assert.strictEqual(getConfig(GUILD_ID).roles.booster, BOOSTER_ROLE_ID, 'the role is saved despite the sync failure');
    } finally {
        server.close();
        resetGuildConfig();
    }
});
