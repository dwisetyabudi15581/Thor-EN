/**
 * Unit tests for v3.13.0 — Premium SaaS: stock keys + self-service redemption.
 *
 * Coverage:
 *   - generateKeyString: format, anti-ambiguity alphabet, uniqueness
 *   - createStockKey: stock entry fields (status available, userId null,
 *     expireAt null = duration not running yet), productName/roleId validation
 *   - redeemKey: success (status/expireAt computed SINCE REDEMPTION),
 *     permanent (days=0), every failure → GENERIC message (anti-enumeration),
 *     guild-scoped, atomic single-use (second redeem → generic)
 *   - listStockKeys: guild-scoped
 *   - revokeStockKey: success, already-redeemed → null, another guild → null
 *   - /redeem rate limiter: 5 failures → limited, 10-minute sliding window
 *     (auto reset), success resets the count
 *   - getStats/getStatsByGuild: stock keys counted as `available` SEPARATELY
 *     (not in active/permanent)
 *   - removeExpiredKeys: stock (expireAt null) SURVIVES cleanup
 *   - Registry/router contract: 4 commands registered, routed to the premium
 *     domain, /redeem PUBLIC + no permission gate, the other 3 admin-gated
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ====================================================
// === Snapshot & restore the production keys.json (keyManager.test.js pattern) ===
// ====================================================
const realKeysPath = path.join(__dirname, '..', '..', 'data', 'keys.json');
const keysBackupPath = realKeysPath + '.test-backup';
let keysBackedUp = false;
if (fs.existsSync(realKeysPath)) {
    fs.copyFileSync(realKeysPath, keysBackupPath);
    keysBackedUp = true;
    fs.unlinkSync(realKeysPath);
}
process.on('exit', () => {
    try {
        if (keysBackedUp) {
            fs.copyFileSync(keysBackupPath, realKeysPath);
            fs.rmSync(keysBackupPath, { force: true });
        } else if (fs.existsSync(realKeysPath)) {
            fs.unlinkSync(realKeysPath);
        }
    } catch (_) {}
});

const {
    generateKeyString,
    createStockKey,
    findKeyByString,
    redeemKey,
    listStockKeys,
    revokeStockKey,
    isRedeemRateLimited,
    noteRedeemFailure,
    noteRedeemSuccess,
    _resetRedeemRateLimitForTest,
    getStats,
    getStatsByGuild,
    removeExpiredKeys
} = require('../../src/data/keyManager');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KEY_RE = new RegExp(`^[${ALPHABET}]{5}(-[${ALPHABET}]{5}){2}$`);
const GENERIC_RE = /invalid or already used/i;

// ====================================================
// === generateKeyString ===
// ====================================================

test('v3.13.0 generateKeyString: XXXXX-XXXXX-XXXXX format + anti-ambiguity alphabet (no I/L/O/0/1)', () => {
    for (let i = 0; i < 25; i++) {
        const key = generateKeyString();
        assert.match(key, KEY_RE, `key "${key}" must be 3 groups of 5 safe-alphabet chars`);
        assert.strictEqual(key.length, 17, '3x5 chars + 2 dashes');
    }
});

test('v3.13.0 generateKeyString: never duplicates an existing list', () => {
    const existing = [];
    for (let i = 0; i < 60; i++) {
        const key = generateKeyString(existing);
        existing.push({ key });
    }
    const unique = new Set(existing.map(e => e.key));
    assert.strictEqual(unique.size, existing.length, '60 keys → all unique');
});

// ====================================================
// === createStockKey ===
// ====================================================

test('v3.13.0 createStockKey: stock entry has status available, userId null, expireAt null', () => {
    const entry = createStockKey({
        productName: 'VIP 30 Days',
        roleId: 'role_vip',
        days: 30,
        guildId: 'guild_a',
        note: 'launch stock',
        createdBy: 'Admin#0001'
    });
    assert.ok(entry.id, 'has an id');
    assert.match(entry.key, KEY_RE);
    assert.strictEqual(entry.status, 'available');
    assert.strictEqual(entry.userId, null, 'not redeemed by anyone yet');
    assert.strictEqual(entry.expireAt, null, 'duration NOT running — computed at redeem');
    assert.strictEqual(entry.guildId, 'guild_a');
    assert.strictEqual(entry.days, 30);
    assert.ok(entry.createdAt > 0);
    // Persisted
    const found = findKeyByString(entry.key);
    assert.ok(found, 'stored in keys.json');
    assert.strictEqual(found.status, 'available');
});

test('v3.13.0 createStockKey: throws without productName / without roleId (fail-fast)', () => {
    assert.throws(() => createStockKey({ roleId: 'r', days: 30, guildId: 'g' }), /product name/i);
    assert.throws(() => createStockKey({ productName: 'P', days: 30, guildId: 'g' }), /roleId/i);
});

test('v3.13.0 createStockKey: days=0 → a permanent-when-redeemed stock key (not an error)', () => {
    const entry = createStockKey({ productName: 'VIP Permanent', roleId: 'r', days: 0, guildId: 'g' });
    assert.strictEqual(entry.days, 0);
    assert.strictEqual(entry.expireAt, null);
});

// ====================================================
// === redeemKey ===
// ====================================================

test('v3.13.0 redeemKey: success — status redeemed, expireAt = NOW + days (duration starts at redemption)', () => {
    const stock = createStockKey({ productName: 'VIP 30', roleId: 'r1', days: 30, guildId: 'guild_a' });
    const before = Date.now();
    const redeemed = redeemKey(stock.key, { userId: 'user_x', username: 'X#0001', guildId: 'guild_a' });
    const after = Date.now();

    assert.strictEqual(redeemed.status, 'redeemed');
    assert.strictEqual(redeemed.userId, 'user_x');
    assert.strictEqual(redeemed.username, 'X#0001');
    assert.ok(redeemed.redeemedAt >= before && redeemed.redeemedAt <= after);
    // 30 days since redemption (tolerating a few ms of test execution)
    assert.ok(redeemed.expireAt >= before + 30 * 86400000, 'expireAt >= now + 30 days');
    assert.ok(redeemed.expireAt <= after + 30 * 86400000, 'expireAt <= now + 30 days');
});

test('v3.13.0 redeemKey: days=0 → expireAt null (permanent)', () => {
    const stock = createStockKey({ productName: 'VIP Perm', roleId: 'r1', days: 0, guildId: 'guild_a' });
    const redeemed = redeemKey(stock.key, { userId: 'user_p', username: 'P', guildId: 'guild_a' });
    assert.strictEqual(redeemed.expireAt, null);
});

test('v3.13.0 redeemKey: single-use — a SECOND redeem of the same key → generic', () => {
    const stock = createStockKey({ productName: 'VIP 7', roleId: 'r1', days: 7, guildId: 'guild_a' });
    redeemKey(stock.key, { userId: 'user_a', username: 'A', guildId: 'guild_a' });
    assert.throws(
        () => redeemKey(stock.key, { userId: 'user_b', username: 'B', guildId: 'guild_a' }),
        GENERIC_RE
    );
});

test('v3.13.0 redeemKey: key not found → GENERIC message (anti-enumeration)', () => {
    _resetRedeemRateLimitForTest();
    assert.throws(() => redeemKey('ZZZZZ-ZZZZZ-ZZZZZ', { userId: 'u', username: 'u', guildId: 'guild_a' }), GENERIC_RE);
});

test('v3.13.0 redeemKey: a non-stock legacy key (already claimed) → generic', () => {
    _resetRedeemRateLimitForTest();
    const { addKey } = require('../../src/data/keyManager');
    const legacy = addKey({
        key: 'LEGACY-CLAIMED-001',
        userId: 'user_legacy',
        username: 'Legacy',
        roleId: 'r1',
        productName: 'Legacy',
        days: 30,
        guildId: 'guild_a'
    });
    assert.ok(!legacy.status, 'legacy keys have no status field');
    assert.throws(
        () => redeemKey('LEGACY-CLAIMED-001', { userId: 'user_other', username: 'O', guildId: 'guild_a' }),
        GENERIC_RE
    );
});

test('v3.13.0 redeemKey: another guild\'s stock key → generic (guild-scoped, critical in public mode)', () => {
    _resetRedeemRateLimitForTest();
    const stock = createStockKey({ productName: 'VIP 7', roleId: 'r1', days: 7, guildId: 'guild_a' });
    assert.throws(
        () => redeemKey(stock.key, { userId: 'user_b', username: 'B', guildId: 'guild_b' }),
        GENERIC_RE
    );
});

test('v3.13.0 redeemKey: empty/whitespace input → throws (no leak into validation)', () => {
    assert.throws(() => redeemKey('   ', { userId: 'u', username: 'u', guildId: 'g' }));
    assert.throws(() => redeemKey('', { userId: 'u', username: 'u', guildId: 'g' }));
});

// ====================================================
// === listStockKeys + revokeStockKey ===
// ====================================================

test('v3.13.0 listStockKeys: guild-scoped — other guilds\' stock never shows', () => {
    createStockKey({ productName: 'A', roleId: 'r', days: 7, guildId: 'guild_list_a' });
    createStockKey({ productName: 'B', roleId: 'r', days: 7, guildId: 'guild_list_b' });
    createStockKey({ productName: 'C', roleId: 'r', days: 7, guildId: 'guild_list_a' });
    const names = listStockKeys('guild_list_a').map(k => k.productName).sort();
    assert.deepStrictEqual(names, ['A', 'C'], 'only guild_list_a stock');
});

test('v3.13.0 revokeStockKey: successfully removes an unredeemed stock key', () => {
    const stock = createStockKey({ productName: 'R', roleId: 'r', days: 7, guildId: 'guild_rev' });
    const removed = revokeStockKey(stock.key, 'guild_rev');
    assert.ok(removed, 'returns the removed entry');
    assert.strictEqual(removed.key, stock.key);
    assert.strictEqual(findKeyByString(stock.key), null, 'gone from keys.json');
    // A revoked key cannot be redeemed
    assert.throws(
        () => redeemKey(stock.key, { userId: 'u', username: 'u', guildId: 'guild_rev' }),
        GENERIC_RE
    );
});

test('v3.13.0 revokeStockKey: an ALREADY redeemed key → null (a legitimate redemption is not revocable)', () => {
    const stock = createStockKey({ productName: 'R2', roleId: 'r', days: 7, guildId: 'guild_rev2' });
    redeemKey(stock.key, { userId: 'u', username: 'u', guildId: 'guild_rev2' });
    assert.strictEqual(revokeStockKey(stock.key, 'guild_rev2'), null);
});

test('v3.13.0 revokeStockKey: another guild\'s stock → null (guild A\'s admin cannot revoke guild B\'s)', () => {
    const stock = createStockKey({ productName: 'R3', roleId: 'r', days: 7, guildId: 'guild_rev3' });
    assert.strictEqual(revokeStockKey(stock.key, 'other_guild'), null);
    // ...and the stock stays intact
    assert.ok(findKeyByString(stock.key));
});

test('v3.13.0 revokeStockKey: key not found → null', () => {
    assert.strictEqual(revokeStockKey('ZZZZZ-ZZZZZ-ZZZZZ', 'guild_rev'), null);
});

// ====================================================
// === /redeem rate limiter (anti brute-force) ===
// ====================================================

test('v3.13.0 rate limiter: 5 failures → user on cooldown, a 6th failure stays limited', () => {
    _resetRedeemRateLimitForTest();
    const uid = 'user_rl_1';
    for (let i = 0; i < 5; i++) {
        assert.strictEqual(isRedeemRateLimited(uid), false, `failure #${i + 1} before being limited`);
        noteRedeemFailure(uid);
    }
    assert.strictEqual(isRedeemRateLimited(uid), true, 'after 5 failures → limited');
    noteRedeemFailure(uid); // 6th failure (from the handler on the generic throw)
    assert.strictEqual(isRedeemRateLimited(uid), true, 'still limited');
});

test('v3.13.0 rate limiter: 10-minute sliding window — past the window → auto reset', () => {
    _resetRedeemRateLimitForTest();
    const uid = 'user_rl_2';
    const t0 = 1000000000000;
    for (let i = 0; i < 5; i++) noteRedeemFailure(uid, t0);
    assert.strictEqual(isRedeemRateLimited(uid, t0 + 10 * 60 * 1000 - 1), true, 'inside the window → limited');
    assert.strictEqual(isRedeemRateLimited(uid, t0 + 10 * 60 * 1000 + 1), false, 'past the window → reset');
});

test('v3.13.0 rate limiter: a SUCCESSFUL redeem resets the user\'s count', () => {
    _resetRedeemRateLimitForTest();
    const uid = 'user_rl_3';
    for (let i = 0; i < 4; i++) noteRedeemFailure(uid);
    noteRedeemSuccess(uid);
    assert.strictEqual(isRedeemRateLimited(uid), false, 'success → count reset');
});

test('v3.13.0 rate limiter: different users do not affect each other', () => {
    _resetRedeemRateLimitForTest();
    for (let i = 0; i < 5; i++) noteRedeemFailure('user_rl_4a');
    assert.strictEqual(isRedeemRateLimited('user_rl_4a'), true);
    assert.strictEqual(isRedeemRateLimited('user_rl_4b'), false, 'the other user is clean');
});

// ====================================================
// === getStats / getStatsByGuild: stock counted SEPARATELY ===
// ====================================================

test('v3.13.0 getStats: stock keys counted as `available`, NOT in active/permanent', () => {
    const before = getStats();
    createStockKey({ productName: 'S1', roleId: 'r', days: 30, guildId: 'guild_st' });
    createStockKey({ productName: 'S2', roleId: 'r', days: 0, guildId: 'guild_st' });
    const after = getStats();
    // Relative deltas (other tests may leave data in the same file).
    assert.strictEqual(after.available - before.available, 2, 'two new stock keys counted as available');
    assert.strictEqual(after.active - before.active, 0, 'stock NOT counted as active');
    assert.strictEqual(after.permanent - before.permanent, 0, 'potentially-permanent stock NOT counted as permanent');
    assert.strictEqual(after.total - before.total, 2);
});

test('v3.13.0 getStatsByGuild: guild-scoped available + other guilds\' stock excluded', () => {
    const before = getStatsByGuild('guild_st2');
    createStockKey({ productName: 'S3', roleId: 'r', days: 30, guildId: 'guild_st2' });
    createStockKey({ productName: 'S4', roleId: 'r', days: 30, guildId: 'guild_st_other' });
    const after = getStatsByGuild('guild_st2');
    assert.strictEqual(after.available - before.available, 1, 'only guild_st2 stock');
});

// ====================================================
// === removeExpiredKeys: stock survives (expireAt null) ===
// ====================================================

test('v3.13.0 removeExpiredKeys: STOCK keys are never deleted by the cleaner (expireAt null)', () => {
    const stock = createStockKey({ productName: 'KeepMe', roleId: 'r', days: 30, guildId: 'guild_keep' });
    removeExpiredKeys();
    assert.ok(findKeyByString(stock.key), 'stock survives — unredeemed, no duration running');
});

// ====================================================
// === Registry + router contract (the v3.9.24 GUARD pattern) ===
// ====================================================

test('v3.13.0 CONTRACT: /gen-key /redeem /list-stock /revoke-key registered & routed to the premium domain', () => {
    const { getCommands } = require('../../src/commands/registry');
    const routeCommand = require('../../src/commands');

    const cmds = getCommands();
    assert.strictEqual(cmds.length, 96, '96 commands (92 + 4 premium v3.13.0)');

    const byName = Object.fromEntries(cmds.map(c => [c.name, c]));
    for (const name of ['gen-key', 'redeem', 'list-stock', 'revoke-key']) {
        assert.ok(byName[name], `/${name} is registered`);
        assert.strictEqual(
            routeCommand.COMMAND_TO_DOMAIN[name],
            'premium',
            `/${name} routes to the premium domain`
        );
    }
    assert.strictEqual(typeof routeCommand.DOMAIN_HANDLERS.premium, 'function', 'the premium handler exists');
});

test('v3.13.0 CONTRACT: /redeem is PUBLIC (no permission gate) — the other 3 are admin-gated', () => {
    const { getCommands } = require('../../src/commands/registry');
    const routeCommand = require('../../src/commands');
    const byName = Object.fromEntries(getCommands().map(c => [c.name, c]));

    assert.strictEqual(byName['redeem'].defaultMemberPermissions, undefined, '/redeem has no gate → all members');
    for (const name of ['gen-key', 'list-stock', 'revoke-key']) {
        assert.ok(byName[name].defaultMemberPermissions, `/${name} is admin-gated (ManageGuild)`);
    }

    assert.ok(routeCommand.PUBLIC_COMMANDS.includes('redeem'), '/redeem is in PUBLIC_COMMANDS');
    for (const name of ['gen-key', 'list-stock', 'revoke-key']) {
        assert.ok(!routeCommand.PUBLIC_COMMANDS.includes(name), `/${name} is not public`);
    }
});

test('v3.13.0 CONTRACT: /gen-key has value/count/note options; /redeem & /revoke-key have a key option', () => {
    const { getCommands } = require('../../src/commands/registry');
    const byName = Object.fromEntries(getCommands().map(c => [c.name, c]));
    const genOpts = byName['gen-key'].options.map(o => o.name);
    assert.ok(genOpts.includes('value') && genOpts.includes('count') && genOpts.includes('note'));
    assert.strictEqual(byName['redeem'].options[0].name, 'key');
    assert.strictEqual(byName['revoke-key'].options[0].name, 'key');
});

test('v3.13.0 CONTRACT: premium.js uses the SAME generic message as redeemKey (no enumeration leak)', () => {
    // Read premium.js source — make sure the handler's generic string matches
    // what keyManager.redeemKey throws (a mismatch would leak whether an
    // error came from the data layer vs the handler).
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'premium.js'), 'utf8');
    assert.ok(src.includes('Key is invalid or already used'), 'the handler uses the same generic message');
});
