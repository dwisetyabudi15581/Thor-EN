/**
 * Unit tests for userLock (TOCTOU race condition guard)
 *
 * v3.9.24: acquire() now returns a unique (truthy) TOKEN instead of `true` —
 * release() uses it for the owner-check (see the "stale holder" test below).
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
    // Before v3.9.8: returned true (bypassing the lock) — hiding the bug.
    // Now: throws an error.
    assert.throws(() => acquire(null, 'user'), /scope and userId are required/);
    assert.throws(() => acquire('scope', null), /scope and userId are required/);
    assert.throws(() => acquire('', 'user'), /scope and userId are required/);
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
// === v3.9.24: owner token — stale release regression ===
// ====================================================

test('v3.9.24 FIX: a stale holder cannot release the new holder\'s lock (owner token)', async () => {
    const scope = 'test_scope_token1';
    const userId = 'user_token1';

    // Holder A acquires with a 10ms timeout (so it expires quickly)
    const tokenA = acquire(scope, userId, 10);
    assert.ok(tokenA);

    await sleep(25); // let lock A expire

    // Holder B takes over (lock A already expired)
    const tokenB = acquire(scope, userId, 5000);
    assert.ok(tokenB);

    // Holder A (stale) tries to release with the old token → must be a NO-OP.
    // Old bug: release without an owner-check deleted B's lock!
    release(scope, userId, tokenA);

    // The lock must still be held by B → a new acquire is rejected
    assert.strictEqual(acquire(scope, userId, 5000), false, 'lock B must still be active after the stale release from A');

    // Release by the correct owner → lock released
    release(scope, userId, tokenB);
    const tokenC = acquire(scope, userId, 5000);
    assert.ok(tokenC, 'the lock must be acquirable again after the release by holder B');
    release(scope, userId, tokenC);
});

test('v3.9.24 FIX: slow withLock fn — the finally-release does not release the overtaking holder\'s lock', async () => {
    const scope = 'test_scope_token2';
    const userId = 'user_token2';

    // A: slow critical section (30ms) with a 10ms lock timeout → the lock expires while A is still running
    const pA = withLock(
        scope,
        userId,
        async () => {
            await sleep(30);
            return 'A';
        },
        10
    );

    await sleep(15); // lock A expired → B can take over

    // B: longer critical section (50ms) — still running when A finishes
    const pB = withLock(
        scope,
        userId,
        async () => {
            await sleep(50);
            return 'B';
        },
        5000
    );

    await sleep(30); // t=45: A already finished & released (stale token), B still running

    // Old bug: A's unconditional release deleted B's lock → a third party could get in
    // New fix: A's release is a no-op (different token) → B's lock stays active
    assert.strictEqual(acquire(scope, userId, 5000), false, 'lock B must still be active while B is still running');

    const [ra, rb] = await Promise.all([pA, pB]);
    assert.strictEqual(ra, 'A');
    assert.strictEqual(rb, 'B');

    // After B finishes & releases with its own token → the lock is free
    const tokenC = acquire(scope, userId, 5000);
    assert.ok(tokenC, 'the lock must be free after B finishes');
    release(scope, userId, tokenC);
});
