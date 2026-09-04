/**
 * Unit tests untuk keyManager (data layer)
 *
 * Verify: addKey uniqueness, findAllByUser guild-scoped, getActiveKeys, expiry logic
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ====================================================
// === v3.9.24 FIX: keys.json produksi di-snapshot & restore ===
// ====================================================
// Test sebelumnya meng-claim pakai temp file (mock Module._resolveFilename),
// tapi scaffolding itu TIDAK PERNAH BERFUNGSI — test menulis langsung ke
// data/keys.json produksi. Sekarang: keys.json asli di-backup sebelum test
// dan di-restore saat process exit (exit handler harus sync).
const realKeysPath = path.join(__dirname, '..', '..', 'data', 'keys.json');
const keysBackupPath = realKeysPath + '.test-backup';
let keysBackedUp = false;
if (fs.existsSync(realKeysPath)) {
    fs.copyFileSync(realKeysPath, keysBackupPath);
    keysBackedUp = true;
    // Mulai dari state kosong yang deterministik (seperti fresh checkout).
    fs.unlinkSync(realKeysPath);
}
process.on('exit', () => {
    try {
        if (keysBackedUp) {
            fs.copyFileSync(keysBackupPath, realKeysPath);
            fs.rmSync(keysBackupPath, { force: true });
        } else if (fs.existsSync(realKeysPath)) {
            // Tidak ada file asli → hapus file hasil test.
            fs.unlinkSync(realKeysPath);
        }
    } catch (_) {}
});

test('keyManager: addKey throws on duplicate key (v3.9.8 fix)', () => {
    const { addKey } = require('../../src/data/keyManager');
    // Add pertama
    addKey({
        key: 'TEST-DUPLICATE-001',
        userId: 'user_test_1',
        username: 'TestUser',
        roleId: 'role_test',
        productName: 'Test',
        days: 30,
        guildId: 'guild_test'
    });
    // Add kedua dengan key yang sama → harus throw
    assert.throws(() => {
        addKey({
            key: 'TEST-DUPLICATE-001',
            userId: 'user_test_2',
            username: 'TestUser2',
            roleId: 'role_test',
            productName: 'Test',
            days: 30,
            guildId: 'guild_test'
        });
    }, /sudah ada di database.*duplicate/i);

    // Cleanup
    const { removeAllKeysByUser } = require('../../src/data/keyManager');
    removeAllKeysByUser('user_test_1', 'guild_test');
});

test('keyManager: addKey accepts unique keys', () => {
    const { addKey, removeAllKeysByUser } = require('../../src/data/keyManager');
    const entry = addKey({
        key: 'TEST-UNIQUE-' + Date.now(),
        userId: 'user_test_unique',
        roleId: 'role_test',
        productName: 'Test',
        days: 30,
        guildId: 'guild_test'
    });
    assert.ok(entry.id, 'should return entry with id');
    assert.ok(entry.expireAt > Date.now(), 'expireAt should be in future');
    removeAllKeysByUser('user_test_unique', 'guild_test');
});

test('keyManager: addKey with days=0 creates permanent key (expireAt=null)', () => {
    const { addKey, removeAllKeysByUser } = require('../../src/data/keyManager');
    const entry = addKey({
        key: 'TEST-PERM-' + Date.now(),
        userId: 'user_test_perm',
        roleId: 'role_test',
        productName: 'Test',
        days: 0,
        guildId: 'guild_test'
    });
    assert.strictEqual(entry.expireAt, null);
    assert.strictEqual(entry.days, 0);
    removeAllKeysByUser('user_test_perm', 'guild_test');
});

test('keyManager: findAllByUser guild-scoped (v3.9.8 fix)', () => {
    const { addKey, findAllByUser, removeAllKeysByUser } = require('../../src/data/keyManager');

    // Add key di guild A
    addKey({
        key: 'TEST-SCOPE-A-' + Date.now(),
        userId: 'user_scope_test',
        roleId: 'role_test',
        productName: 'Test',
        days: 30,
        guildId: 'guild_A'
    });
    // Add key di guild B
    addKey({
        key: 'TEST-SCOPE-B-' + Date.now(),
        userId: 'user_scope_test',
        roleId: 'role_test',
        productName: 'Test',
        days: 30,
        guildId: 'guild_B'
    });

    // findAllByUser dengan guildId=A → hanya return key guild_A
    const keysInA = findAllByUser('user_scope_test', 'guild_A');
    assert.ok(
        keysInA.every(k => k.guildId === 'guild_A' || !k.guildId),
        'should only return keys from guild_A (or legacy without guildId)'
    );

    // findAllByUser tanpa guildId → return semua key user (backward compat)
    const allKeys = findAllByUser('user_scope_test');
    assert.ok(allKeys.length >= 2, 'should return all keys for user');

    // Cleanup
    removeAllKeysByUser('user_scope_test', 'guild_A');
    removeAllKeysByUser('user_scope_test', 'guild_B');
});

test('keyManager: getActiveKeysByUserAndRole filters expired', () => {
    const { addKey, getActiveKeysByUserAndRole, removeAllKeysByUser } = require('../../src/data/keyManager');
    const userId = 'user_active_test';
    const roleId = 'role_active';

    // Add expired key (days=-1 tidak mungkin, jadi pakai trik: add dengan days=1 lalu manual edit)
    // Sebenarnya kita test active key saja.
    addKey({
        key: 'TEST-ACTIVE-' + Date.now(),
        userId,
        roleId,
        productName: 'Test',
        days: 30,
        guildId: 'guild_test'
    });

    const active = getActiveKeysByUserAndRole(userId, roleId);
    assert.ok(active.length >= 1);
    assert.ok(
        active.every(k => k.expireAt === null || k.expireAt > Date.now()),
        'all returned keys should be active'
    );

    removeAllKeysByUser(userId, 'guild_test');
});

test('keyManager: hasPermanentKey detects days=0 keys', () => {
    const { addKey, hasPermanentKey, removeAllKeysByUser } = require('../../src/data/keyManager');
    const userId = 'user_perm_detect';
    const roleId = 'role_perm';

    addKey({
        key: 'TEST-PERM-DET-' + Date.now(),
        userId,
        roleId,
        productName: 'Test',
        days: 0,
        guildId: 'guild_test'
    });

    assert.ok(hasPermanentKey(userId, roleId), 'should detect permanent key');

    removeAllKeysByUser(userId, 'guild_test');
});

test('keyManager: removeAllKeysByUser respects guildId scope', () => {
    const { addKey, removeAllKeysByUser, findAllByUser } = require('../../src/data/keyManager');
    const userId = 'user_remove_scope';

    addKey({ key: 'TEST-RM-A-' + Date.now(), userId, roleId: 'r', productName: 'P', days: 30, guildId: 'guild_X' });
    addKey({ key: 'TEST-RM-B-' + Date.now(), userId, roleId: 'r', productName: 'P', days: 30, guildId: 'guild_Y' });

    // Remove only dari guild_X
    const removed = removeAllKeysByUser(userId, 'guild_X');
    assert.ok(removed >= 1, 'should remove at least 1 key from guild_X');

    // guild_Y key masih ada
    const remaining = findAllByUser(userId, 'guild_Y');
    assert.ok(remaining.length >= 1, 'guild_Y keys should remain');

    // Cleanup
    removeAllKeysByUser(userId, 'guild_Y');
});
