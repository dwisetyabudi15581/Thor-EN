/**
 * Unit tests untuk userLock (TOCTOU race condition guard)
 *
 * v3.9.24: acquire() sekarang mengembalikan TOKEN unik (truthy) alih-alih `true` —
 * dipakai release() untuk owner-check (cek test "stale holder" di bawah).
 */

const test = require('node:test');
const assert = require('node:assert');
const { acquire, release, withLock } = require('../../src/infra/userLock');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('acquire: returns truthy token for first acquire', () => {
    const scope = 'test_scope_1';
    const userId = 'user_1';
    // v3.9.24: token (string) — truthy, bukan literal true
    const token = acquire(scope, userId);
    assert.ok(typeof token === 'string' && token.length > 0, 'acquire should return a token string');
    release(scope, userId, token);
});

test('acquire: returns false for second acquire (locked)', () => {
    const scope = 'test_scope_2';
    const userId = 'user_2';
    acquire(scope, userId);
    assert.strictEqual(acquire(scope, userId), false);
    release(scope, userId);
});

test('acquire: independent scopes do not block each other', () => {
    const userId = 'user_3';
    const tokenA = acquire('scope_a', userId);
    const tokenB = acquire('scope_b', userId);
    assert.ok(tokenA && tokenB);
    release('scope_a', userId, tokenA);
    release('scope_b', userId, tokenB);
});

test('acquire: independent users do not block each other', () => {
    const scope = 'test_scope_4';
    const tokenA = acquire(scope, 'user_a');
    const tokenB = acquire(scope, 'user_b');
    assert.ok(tokenA && tokenB);
    release(scope, 'user_a', tokenA);
    release(scope, 'user_b', tokenB);
});

test('release: idempotent (safe to call without prior acquire)', () => {
    assert.doesNotThrow(() => release('unused_scope', 'unused_user'));
});

test('v3.9.8 FIX: acquire throws on missing scope or userId', () => {
    // Sebelum v3.9.8: return true (bypass lock) — hide bug.
    // Sekarang: throw error.
    assert.throws(() => acquire(null, 'user'), /scope dan userId wajib diisi/);
    assert.throws(() => acquire('scope', null), /scope dan userId wajib diisi/);
    assert.throws(() => acquire('', 'user'), /scope dan userId wajib diisi/);
});

test('withLock: executes fn and returns its result', async () => {
    const result = await withLock('test_scope_5', 'user_5', async () => {
        return 42;
    });
    assert.strictEqual(result, 42);
});

test('withLock: returns null when lock is busy', async () => {
    const scope = 'test_scope_6';
    const userId = 'user_6';
    acquire(scope, userId);
    const result = await withLock(scope, userId, async () => 'should not run');
    assert.strictEqual(result, null);
    release(scope, userId);
});

test('withLock: releases lock even when fn throws', async () => {
    const scope = 'test_scope_7';
    const userId = 'user_7';

    await assert.rejects(
        withLock(scope, userId, async () => {
            throw new Error('boom');
        }),
        /boom/
    );

    // Lock should be released → can acquire again
    const token = acquire(scope, userId);
    assert.ok(token);
    release(scope, userId, token);
});

test('withLock: serializes concurrent calls', async () => {
    const scope = 'test_scope_8';
    const userId = 'user_8';
    const order = [];

    // 2 concurrent calls — second should wait (or skip if timeout)
    const p1 = withLock(scope, userId, async () => {
        order.push('start_1');
        await new Promise(r => setTimeout(r, 50));
        order.push('end_1');
    });
    const p2 = withLock(scope, userId, async () => {
        order.push('start_2');
        await new Promise(r => setTimeout(r, 50));
        order.push('end_2');
    });

    await Promise.all([p1, p2]);

    // p2 should have been skipped (lock busy) → only p1's starts/ends
    // p2 returns null silently
    assert.deepStrictEqual(order, ['start_1', 'end_1']);
});

// ====================================================
// === v3.9.24: owner token — regresi stale release ===
// ====================================================

test('v3.9.24 FIX: stale holder tidak bisa melepas lock holder baru (owner token)', async () => {
    const scope = 'test_scope_token1';
    const userId = 'user_token1';

    // Holder A acquire dengan timeout 10ms (supaya cepat expired)
    const tokenA = acquire(scope, userId, 10);
    assert.ok(tokenA);

    await sleep(25); // biar lock A expired

    // Holder B overtake (lock A sudah expired)
    const tokenB = acquire(scope, userId, 5000);
    assert.ok(tokenB);

    // Holder A (stale) coba release pakai token lama → harus NO-OP.
    // Bug lama: release tanpa owner-check menghapus lock B!
    release(scope, userId, tokenA);

    // Lock harus masih dipegang B → acquire baru ditolak
    assert.strictEqual(acquire(scope, userId, 5000), false, 'lock B harus masih aktif setelah stale release dari A');

    // Release oleh pemilik yang benar → lock lepas
    release(scope, userId, tokenB);
    const tokenC = acquire(scope, userId, 5000);
    assert.ok(tokenC, 'lock harus bisa di-acquire lagi setelah release oleh holder B');
    release(scope, userId, tokenC);
});

test('v3.9.24 FIX: withLock fn lambat — release di finally tidak melepas lock holder yang overtake', async () => {
    const scope = 'test_scope_token2';
    const userId = 'user_token2';

    // A: critical section lambat (30ms) dengan timeout lock 10ms → lock kedaluwarsa saat masih jalan
    const pA = withLock(
        scope,
        userId,
        async () => {
            await sleep(30);
            return 'A';
        },
        10
    );

    await sleep(15); // lock A expired → B bisa overtake

    // B: critical section lebih lama (50ms) — masih berjalan saat A selesai
    const pB = withLock(
        scope,
        userId,
        async () => {
            await sleep(50);
            return 'B';
        },
        5000
    );

    await sleep(30); // t=45: A sudah selesai & release (stale token), B masih jalan

    // Bug lama: release unconditional dari A menghapus lock B → pihak ketiga bisa masuk
    // Fix baru: release A no-op (token beda) → lock B masih aktif
    assert.strictEqual(acquire(scope, userId, 5000), false, 'lock B harus masih aktif saat B masih jalan');

    const [ra, rb] = await Promise.all([pA, pB]);
    assert.strictEqual(ra, 'A');
    assert.strictEqual(rb, 'B');

    // Setelah B selesai & release dengan token-nya sendiri → lock lepas
    const tokenC = acquire(scope, userId, 5000);
    assert.ok(tokenC, 'lock harus lepas setelah B selesai');
    release(scope, userId, tokenC);
});
