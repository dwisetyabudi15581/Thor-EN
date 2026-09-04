/**
 * User-scoped in-process lock.
 *
 * Dipakai untuk mencegah TOCTOU race condition ketika user menekan tombol
 * Discord sangat cepat (double-click / spam click) yang bisa memicu
 * double-add / double-vote sebelum file JSON sempat di-flush.
 *
 * Lock di-key per (scope, userId). Scope biasanya nama fitur ('gw', 'poll').
 * Resolusi otomatis setelah timeout (defensive — kalau ada bug, lock tidak
 * nge-hang forever).
 *
 * Concurrency model: single-process Node.js, jadi Map + flag boolean cukup.
 * Tidak butuh mutex/atomic primitive.
 *
 * v3.9.24 FIX (owner token): sebelumnya `acquire` boolean + `release` hapus
 * tanpa cek pemilik. Kalau critical section jalan lebih lama dari timeout,
 * lock di-overtake pemegang baru — lalu `finally` pemegang LAMA menghapus
 * lock milik pemegang BARU → pihak ketiga bisa masuk → 2 critical section
 * jalan bersamaan. Lock gagal justru saat paling dibutuhkan (operasi lambat).
 * Sekarang tiap akuisisi punya token unik; release hanya berlaku kalau token
 * cocok (pemanggilan release tanpa token tetap boleh — kompatibel lama).
 */

const locks = new Map(); // key: `${scope}:${userId}` -> { acquiredAt, expiresAt, token, timeoutMs }

const DEFAULT_TIMEOUT_MS = 5000; // 5 detik — seharusnya cukup untuk semua flow

/**
 * Coba acquire lock untuk (scope, userId).
 * @returns {string|false} token lock (truthy) kalau berhasil, false kalau masih di-pegang.
 *   v3.9.24: sebelumnya mengembalikan `true`; sekarang token unik (tetap truthy,
 *   jadi `if (!acquire(...))` lama tetap valid). Token dipakai releaseLock.
 */
function acquire(scope, userId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    // v3.9.8 FIX: sebelumnya return true (bypass lock) kalau scope/userId invalid.
    // Ini "defensive" yang hide bug — bisa bikin race condition yang lock seharusnya
    // cegah. Sekarang throw error supaya bug langsung keliatan di development.
    if (!scope || !userId) {
        throw new Error(`userLock.acquire: scope dan userId wajib diisi (got scope=${scope}, userId=${userId})`);
    }
    const key = `${scope}:${userId}`;
    const now = Date.now();
    const existing = locks.get(key);
    if (existing) {
        if (now < existing.expiresAt) {
            return false; // masih di-pegang
        }
        // expired — overtake (holder lama tidak bisa melepas lock baru: token beda)
    }
    const token = `${now}-${Math.random().toString(36).slice(2)}`;
    locks.set(key, { acquiredAt: now, expiresAt: now + timeoutMs, token, timeoutMs });
    return token;
}

/**
 * Release lock.
 * Aman dipanggil walau lock tidak pernah di-acquire.
 * @param {string} [token] - token dari acquire(). Kalau diisi, lock hanya dihapus
 *   kalau token cocok (owner check — cegah holder basi melepas lock holder baru).
 *   Kalau tidak diisi, hapus tanpa cek (perilaku lama, kompatibel).
 */
function release(scope, userId, token) {
    if (!scope || !userId) return;
    const key = `${scope}:${userId}`;
    const existing = locks.get(key);
    if (!existing) return;
    // v3.9.24: owner check — kalau token dioper dan TIDAK cocok, ini release
    // dari holder basi (lock-nya sudah di-overtake). No-op.
    if (token !== undefined && existing.token !== token) return;
    locks.delete(key);
}

/**
 * Jalankan fn di bawah lock. Auto-release di akhir (termasuk kalau throw).
 * @returns hasil fn, atau null kalau gagal acquire.
 */
async function withLock(scope, userId, fn, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const token = acquire(scope, userId, timeoutMs);
    if (!token) return null;
    try {
        return await fn();
    } finally {
        // v3.9.24: release dengan token — kalau fn lambat dan lock sempat di-overtake,
        // release ini otomatis no-op (tidak menghapus lock milik holder baru).
        release(scope, userId, token);
    }
}

// Periodic cleanup — hapus lock yang sudah expired (defensive terhadap bug
// yang lupa release). Run setiap 1 menit.
// v3.9.24: pakai expiresAt per-entry (bukan DEFAULT_TIMEOUT_MS * 2 global),
// jadi lock dengan custom timeout lama tidak ter-reap di tengah jalan.
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, val] of locks) {
        // Grace 1x timeout tambahan setelah expiry sebelum dianggap sampah.
        if (now > val.expiresAt + (val.timeoutMs || DEFAULT_TIMEOUT_MS)) {
            locks.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.warn(`🧹 userLock: ${cleaned} stale lock dihapus (possible bug).`);
    }
}, 60 * 1000).unref?.();

module.exports = { acquire, release, withLock };
