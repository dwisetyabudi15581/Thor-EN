/**
 * User-scoped in-process lock.
 *
 * Used to prevent TOCTOU race conditions when a user presses Discord buttons
 * very fast (double-click / spam click) which could trigger double-add /
 * double-vote before the JSON file gets flushed.
 *
 * Locks are keyed per (scope, userId). Scope is usually a feature name ('gw', 'poll').
 * Auto-resolves after a timeout (defensive — if there's a bug, the lock won't
 * hang forever).
 *
 * Concurrency model: single-process Node.js, so a Map + boolean flag is enough.
 * No mutex/atomic primitives needed.
 *
 * v3.9.24 FIX (owner token): previously `acquire` returned a boolean + `release`
 * deleted without checking ownership. If the critical section ran longer than
 * the timeout, the lock was overtaken by a new holder — then the OLD holder's
 * `finally` deleted the NEW holder's lock → a third party could get in →
 * 2 critical sections running together. The lock failed exactly when it was
 * needed most (slow operations).
 * Now each acquisition has a unique token; release only applies if the token
 * matches (calling release without a token is still allowed — backward compatible).
 */

const locks = new Map(); // key: `${scope}:${userId}` -> { acquiredAt, expiresAt, token, timeoutMs }

const DEFAULT_TIMEOUT_MS = 5000; // 5 seconds — should be enough for all flows

/**
 * Try to acquire the lock for (scope, userId).
 * @returns {string|false} lock token (truthy) on success, false if still held.
 *   v3.9.24: previously returned `true`; now returns a unique token (still truthy,
 *   so old `if (!acquire(...))` checks remain valid). The token is used by releaseLock.
 */
function acquire(scope, userId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    // v3.9.8 FIX: previously returned true (bypassing the lock) for invalid scope/userId.
    // That "defensive" behavior hid bugs — it could enable the very race condition
    // the lock is supposed to prevent. Now it throws so the bug is immediately
    // visible in development.
    if (!scope || !userId) {
        throw new Error(`userLock.acquire: scope and userId are required (got scope=${scope}, userId=${userId})`);
    }
    const key = `${scope}:${userId}`;
    const now = Date.now();
    const existing = locks.get(key);
    if (existing) {
        if (now < existing.expiresAt) {
            return false; // still held
        }
        // expired — overtake (the old holder can't release the new lock: different token)
    }
    const token = `${now}-${Math.random().toString(36).slice(2)}`;
    locks.set(key, { acquiredAt: now, expiresAt: now + timeoutMs, token, timeoutMs });
    return token;
}

/**
 * Release a lock.
 * Safe to call even if the lock was never acquired.
 * @param {string} [token] - token from acquire(). If provided, the lock is only deleted
 *   if the token matches (owner check — prevents a stale holder from releasing a
 *   new holder's lock). If omitted, deletes without checking (old behavior, compatible).
 */
function release(scope, userId, token) {
    if (!scope || !userId) return;
    const key = `${scope}:${userId}`;
    const existing = locks.get(key);
    if (!existing) return;
    // v3.9.24: owner check — if a token is passed and does NOT match, this is a
    // release from a stale holder (the lock was already overtaken). No-op.
    if (token !== undefined && existing.token !== token) return;
    locks.delete(key);
}

/**
 * Run fn under the lock. Auto-releases at the end (including on throw).
 * @returns fn's result, or null if acquiring failed.
 */
async function withLock(scope, userId, fn, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const token = acquire(scope, userId, timeoutMs);
    if (!token) return null;
    try {
        return await fn();
    } finally {
        // v3.9.24: release with the token — if fn was slow and the lock was overtaken,
        // this release is automatically a no-op (it won't delete the new holder's lock).
        release(scope, userId, token);
    }
}

// Periodic cleanup — remove locks that have already expired (defensive against bugs
// that forget to release). Runs every 1 minute.
// v3.9.24: uses per-entry expiresAt (not a global DEFAULT_TIMEOUT_MS * 2),
// so locks with a long custom timeout aren't reaped mid-flight.
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, val] of locks) {
        // One extra timeout of grace after expiry before it's considered garbage.
        if (now > val.expiresAt + (val.timeoutMs || DEFAULT_TIMEOUT_MS)) {
            locks.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.warn(`🧹 userLock: removed ${cleaned} stale lock(s) (possible bug).`);
    }
}, 60 * 1000).unref?.();

module.exports = { acquire, release, withLock };
