/**
 * safeWrite.js — Atomic JSON file write helper.
 *
 * WHY THIS EXISTS
 * ---------------
 * Direct `fs.writeFileSync(path, JSON.stringify(...))` is NOT atomic:
 *   - A crash / SIGKILL / OOM / power loss mid-write leaves a truncated file.
 *   - The next load() catches SyntaxError and returns [] / {} → SILENT DATA LOSS.
 *   - Two concurrent load→modify→save cycles (via async interleaving) lose updates.
 *
 * SOLUTION
 * --------
 * 1. Write the full content to a sibling temp file (`<path>.tmp`).
 * 2. `fs.renameSync(tmp, final)` — atomic on POSIX (single filesystem op).
 *    On Windows, `rename` is also atomic since Node 10+ for same-volume renames.
 *
 * This guarantees that the final file is either:
 *   - The COMPLETE previous content (write crashed → only .tmp is corrupt)
 *   - The COMPLETE new content (rename succeeded)
 *
 * Never partial / corrupt.
 *
 * USAGE
 * -----
 *   const { safeWriteJSON, safeWriteText } = require('./safeWrite');
 *   safeWriteJSON('/path/to/file.json', data);
 *   // or with pretty-printing (default):
 *   safeWriteJSON('/path/to/file.json', data, { spaces: 2 });
 */

const fs = require('fs');

/**
 * Atomically write a JSON file.
 *
 * @param {string} filePath - Absolute path to the target JSON file.
 * @param {*} data - Any JSON-serializable value.
 * @param {Object} [opts]
 * @param {number} [opts.spaces=2] - Pretty-print indentation (0 = minified).
 * @returns {void}
 * @throws {Error} If write or rename fails. On failure, the .tmp file may
 *                 remain on disk — caller may want to clean it up, but the
 *                 target file is guaranteed intact.
 */
function safeWriteJSON(filePath, data, opts = {}) {
    const spaces = opts.spaces ?? 2;
    const content = JSON.stringify(data, null, spaces);
    safeWriteText(filePath, content);
}

/**
 * Atomically write a text file (write-to-tmp + rename).
 *
 * @param {string} filePath - Absolute path to target file.
 * @param {string} content - File content.
 * @returns {void}
 */
function safeWriteText(filePath, content) {
    // v3.9.8 FIX: use a tmp path unique per PID+timestamp so that if the bot
    // runs in cluster mode (multi-worker) or 2 instances share the same folder,
    // 2 parallel writes don't overwrite each other's .tmp (which could cause silent loss).
    // For single-process (the majority case), behavior is the same as before.
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;

    // Write to tmp file first.
    // If this throws (disk full, permission), target file is untouched.
    fs.writeFileSync(tmpPath, content, 'utf8');

    // Optional: fsync to flush kernel buffer to disk before rename.
    // Ensures the rename isn't ahead of the actual data on disk.
    // Commented out by default to avoid perf hit on hot paths.
    // To enable: open the fd, fsync, close, then rename.
    // try {
    //     const fd = fs.openSync(tmpPath, 'r');
    //     fs.fsyncSync(fd);
    //     fs.closeSync(fd);
    // } catch (_) { /* best-effort fsync */ }

    // Atomic rename. On POSIX, this is a single inode-level operation.
    try {
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        // v3.9.8: if the rename fails, clean up the .tmp so it doesn't pile up.
        try {
            fs.unlinkSync(tmpPath);
        } catch (_) {}
        throw err;
    }
}

/**
 * Atomically write JSON with a backup rotation (.bak file).
 *
 * Use this for critical files where you want an extra safety net:
 *   - Move current file → file.bak
 *   - Write new content → file
 *
 * If new write fails, the .bak is preserved. Note: the rename-to-.bak step
 * itself is atomic; the only risk window is between the .bak rename and the
 * new write — which is the same window as plain safeWriteJSON, just with
 * a recovery fallback.
 *
 * @param {string} filePath
 * @param {*} data
 * @param {Object} [opts]
 */
function safeWriteJSONWithBackup(filePath, data, opts = {}) {
    const bakPath = `${filePath}.bak`;
    // v3.9.8: use a tmp path unique per PID+timestamp (consistent with safeWriteText).
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    const content = JSON.stringify(data, null, opts.spaces ?? 2);

    // 1. Write new content to .tmp (no risk to current file)
    fs.writeFileSync(tmpPath, content, 'utf8');

    // 2. If current file exists, rotate it to .bak (overwrites previous .bak)
    if (fs.existsSync(filePath)) {
        try {
            fs.renameSync(filePath, bakPath);
        } catch (_) {
            // Best-effort: if rename-to-bak fails, continue anyway.
            // The .tmp rename will still go through.
        }
    }

    // 3. Promote .tmp → final
    try {
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        // v3.9.8: clean up the .tmp if the rename fails.
        try {
            fs.unlinkSync(tmpPath);
        } catch (_) {}
        throw err;
    }
}

/**
 * v3.9.26: Quarantine a corrupt data file before the manager falls back to defaults.
 *
 * PROBLEM: all managers use the pattern `catch → return {}` when JSON.parse fails.
 * The corrupt file contents (from a manual crash / bad edit / disk bad sector)
 * then disappear PERMANENTLY on the next save() which writes empty state — no trace left.
 *
 * SOLUTION: rename the corrupt file → `<file>.corrupt-<timestamp>` BEFORE returning
 * the fallback. The original contents are preserved, an admin can inspect/restore
 * them manually, and a fresh file is written by the next save(). Best-effort: if
 * the rename fails (permission/lock), continue without quarantine — don't make load() throw.
 *
 * @param {string} filePath - path of the file that failed to parse
 */
function quarantineCorruptFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return false;
        const quarantined = `${filePath}.corrupt-${Date.now()}`;
        fs.renameSync(filePath, quarantined);
        console.warn(`🧪 Corrupt data file quarantined: ${filePath} → ${quarantined}`);
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    safeWriteJSON,
    safeWriteText,
    safeWriteJSONWithBackup,
    quarantineCorruptFile
};
