/**
 * Auto-Backup System — backs up important JSON files to the backups/ folder.
 *
 * v3.9.24 FIX: FILES_TO_BACKUP previously had holes — 5 live data files were NEVER
 * backed up: automod.json (word rules!), levels.json, responders.json,
 * afk.json, panels.json. As a result, /restore-backup couldn't restore the
 * auto-mod & leveling configuration at all. Now every live data-layer file is
 * in the list (guarded by a test: every live data/*.json file must be present
 * in FILES_TO_BACKUP).
 *
 * Folder structure:
 *   backups/
 *     2026-07-31_15-30-00/
 *       config.json
 *       keys.json
 *       ...
 *     2026-07-31_09-00-00/
 *       ...
 *
 * Auto-clean: at most the 7 newest backups are kept, the rest are deleted.
 *
 * Automatic backups:
 *   - At bot start (backup-on-boot)
 *   - Every 24 hours (interval)
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..', '..');
const dataDir = path.join(rootDir, 'data');
const backupsDir = path.join(rootDir, 'backups');

// v3.9.10: data JSON files now live in the data/ folder (previously in root).
// FILES_TO_BACKUP stays a list of file names, but the path prefix uses dataDir.
// v3.9.24: + automod.json, levels.json, responders.json, afk.json, panels.json
// (before, these 5 files were NOT backed up even though they're used live by the
// auto-mod word rules, leveling, responder, AFK, and ticket panel features).
const FILES_TO_BACKUP = [
    'config.json',
    'keys.json',
    'scheduledRoles.json',
    'selfRoles.json',
    'giveaways.json',
    'warns.json',
    'polls.json',
    'scheduledAnnouncements.json',
    'stats.json',
    'tempVoice.json',
    'tickets.json',
    // v3.9.24 additions:
    'automod.json',
    'levels.json',
    'responders.json',
    'afk.json',
    'panels.json',
    // v3.9.37 FIX: deals.json (escrow v3.9.32+) was missing — restore-backup
    // previously broke ALL active escrow deals (buyers/sellers locked
    // forever because the meta was gone). Caught by the guard test "live files must
    // be backed up" as soon as deals.json existed in data/.
    'deals.json'
];

// v3.9.10: helper to resolve data file paths (to the data/ folder).
function dataFilePath(file) {
    return path.join(dataDir, file);
}

const MAX_BACKUPS = 7;
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Create the backups/ folder if it doesn't exist yet.
 */
function ensureBackupsDir() {
    if (!fs.existsSync(backupsDir)) {
        fs.mkdirSync(backupsDir, { recursive: true });
    }
}

/**
 * Format a timestamp into a filesystem-safe folder name.
 * Format: YYYY-MM-DD_HH-mm-ss
 */
function formatTimestamp(ts = new Date()) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
        `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
    );
}

/**
 * Create a backup now.
 * @returns {Object} { ok, backupName, filesCopied, totalSize, errors[] }
 */
function createBackup() {
    ensureBackupsDir();
    const name = formatTimestamp();
    const targetDir = path.join(backupsDir, name);
    fs.mkdirSync(targetDir, { recursive: true });

    const result = { ok: true, backupName: name, filesCopied: 0, totalSize: 0, errors: [] };

    for (const file of FILES_TO_BACKUP) {
        const src = dataFilePath(file);
        const dst = path.join(targetDir, file);
        try {
            if (fs.existsSync(src)) {
                const stats = fs.statSync(src);
                fs.copyFileSync(src, dst);
                result.filesCopied++;
                result.totalSize += stats.size;
            }
        } catch (err) {
            result.errors.push(`${file}: ${err.message}`);
        }
    }

    // Determine the backup status from the count of successfully copied files vs errors.
    // Files that DON'T exist (existsSync=false) are NOT errors — the feature isn't used yet.
    // What counts as an error: a file exists but the copy failed (permission, disk full, etc).
    //   - errors.length === 0 → success (every existing file was copied)
    //   - errors.length > 0 && filesCopied > 0 → partial failure
    //   - errors.length > 0 && filesCopied === 0 → total failure
    if (result.errors.length > 0) {
        if (result.filesCopied === 0) {
            result.ok = false;
        } else {
            result.ok = false;
            result.partial = true;
        }
    }

    // Auto-clean old backups
    try {
        cleanOldBackups();
    } catch (err) {
        // Not fatal — the backup is still created, only the cleanup failed.
        result.errors.push(`cleanOldBackups: ${err.message}`);
    }

    return result;
}

/**
 * Delete old backups, keeping at most MAX_BACKUPS newest ones.
 * @returns {number} number of backups removed
 */
function cleanOldBackups() {
    ensureBackupsDir();
    // v3.9.8 FIX: wrap statSync in try/catch. Before, if a directory was
    // deleted between readdirSync & statSync (a race with another process /
    // manual admin delete), statSync threw → createBackup crashed.
    const entries = fs
        .readdirSync(backupsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => {
            try {
                const mtime = fs.statSync(path.join(backupsDir, e.name)).mtime;
                return { name: e.name, mtime };
            } catch (_) {
                return null;
            }
        })
        .filter(e => e !== null)
        .sort((a, b) => b.mtime - a.mtime); // newest first

    let removed = 0;
    for (let i = MAX_BACKUPS; i < entries.length; i++) {
        try {
            fs.rmSync(path.join(backupsDir, entries[i].name), { recursive: true, force: true });
            removed++;
        } catch (_) {}
    }
    return removed;
}

/**
 * List all existing backups.
 * @returns {Array} [{ name, size, fileCount, mtime }]
 */
function listBackups() {
    ensureBackupsDir();
    // v3.9.8 FIX: wrap statSync in try/catch so that if a directory gets
    // deleted in a race condition, listBackups doesn't crash.
    const entries = fs.readdirSync(backupsDir, { withFileTypes: true }).filter(e => e.isDirectory());

    return entries
        .map(e => {
            const dir = path.join(backupsDir, e.name);
            let stat;
            try {
                stat = fs.statSync(dir);
            } catch (_) {
                // Directory deleted in a race — skip.
                return null;
            }
            let fileCount = 0;
            let totalSize = 0;
            try {
                const files = fs.readdirSync(dir);
                fileCount = files.length;
                for (const f of files) {
                    try {
                        totalSize += fs.statSync(path.join(dir, f)).size;
                    } catch (_) {}
                }
            } catch (_) {}
            return {
                name: e.name,
                size: totalSize,
                fileCount,
                mtime: stat.mtime
            };
        })
        .filter(e => e !== null)
        .sort((a, b) => b.mtime - a.mtime);
}

/**
 * v3.9.1: In-process lock so two admins can't restore at the same time.
 * If restoreInProgress = true, the next restoreBackup() call is
 * rejected immediately (not queued) so the files don't overwrite each other.
 */
let restoreInProgress = false;

/**
 * Restore a backup by folder name.
 * @param {string} name - the backup folder name (e.g. "2026-07-31_15-30-00")
 *   or "pre-restore_2026-07-31_15-30-00" (auto-backup taken before a restore).
 * @returns {Object} { ok, filesRestored, errors[] }
 */
function restoreBackup(name) {
    // v3.9.1 FIX: prevent concurrent restores (race condition between admins).
    if (restoreInProgress) {
        return {
            ok: false,
            filesRestored: 0,
            errors: ['Another restore is in progress. Wait for it to finish before retrying.']
        };
    }
    restoreInProgress = true;
    try {
        return _restoreBackupImpl(name);
    } finally {
        restoreInProgress = false;
    }
}

function _restoreBackupImpl(name) {
    // Sanitize the name — if it contains slashes/dots, reject.
    // v3.9.1: allow the `pre-restore_` prefix in addition to the YYYY-MM-DD_HH-mm-ss format.
    // Before, pre-restore backups couldn't be restored via /restore-backup
    // because the regex only matched the plain timestamp format. Now pre-restore
    // backups can be restored too (useful for rolling back if a previous restore
    // picked the wrong backup).
    const isPlainTimestamp = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name);
    const isPreRestore = /^pre-restore_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name);
    if (!isPlainTimestamp && !isPreRestore) {
        return { ok: false, filesRestored: 0, errors: ['Invalid backup name format'] };
    }
    // Defense-in-depth: make sure the name contains no `..` or slashes.
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
        return { ok: false, filesRestored: 0, errors: ['Invalid backup name (path traversal detected)'] };
    }

    const srcDir = path.join(backupsDir, name);
    if (!fs.existsSync(srcDir)) {
        return { ok: false, filesRestored: 0, errors: [`Backup '${name}' not found`] };
    }

    // Before restoring, create a "pre-restore" backup for safety
    const preRestoreName = `pre-restore_${formatTimestamp()}`;
    const preRestoreDir = path.join(backupsDir, preRestoreName);
    fs.mkdirSync(preRestoreDir, { recursive: true });
    for (const file of FILES_TO_BACKUP) {
        const src = dataFilePath(file);
        if (fs.existsSync(src)) {
            try {
                fs.copyFileSync(src, path.join(preRestoreDir, file));
            } catch (_) {}
        }
    }

    // Restore: copy files from the backup to the data dir
    const result = { ok: true, filesRestored: 0, errors: [], preRestoreName };
    for (const file of FILES_TO_BACKUP) {
        const src = path.join(srcDir, file);
        const dst = dataFilePath(file);
        try {
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, dst);
                result.filesRestored++;
            }
        } catch (err) {
            result.errors.push(`${file}: ${err.message}`);
        }
    }

    // v3.9.1: invalidate the statsManager in-memory cache so the restored data
    // isn't overwritten by the old cache at the next flush.
    try {
        const stats = require('./statsManager');
        if (typeof stats.reload === 'function') stats.reload();
    } catch (_) {}

    // v3.9.4: invalidate the admin role permissions cache too.
    // Before, if the restored backup had a different admin role ID, isAdmin()
    // kept using the old admin role until the 30-second TTL expired → admin lockout.
    try {
        const { invalidateAdminRoleCache } = require('../infra/permissions');
        invalidateAdminRoleCache();
    } catch (_) {}

    // v3.9.8 FIX: invalidate the panel cache after a restore. Before (wrong target)
    // it called selfRoleManager.invalidateCache — a function that NEVER EXISTED in
    // selfRoleManager (silent no-op). The correct target: panelManager has a 30s
    // cache (panels.json) — and since v3.9.24 panels.json is restored too, the old
    // cache must be invalidated so the restored panels take effect immediately.
    try {
        const panelManager = require('./panelManager');
        if (typeof panelManager.invalidateCache === 'function') panelManager.invalidateCache();
    } catch (_) {}

    // v3.9.26: invalidate the caches of managers that now have read-through caches
    // (automod/afk/responders/levels). All of these files get restored — without
    // invalidation, the hot path keeps reading a 15-second cache holding OLD data.
    for (const mod of ['./automodManager', './afkManager', './responderManager', './levelManager']) {
        try {
            const m = require(mod);
            if (typeof m.invalidateCache === 'function') m.invalidateCache();
        } catch (_) {}
    }

    return result;
}

/**
 * Start the auto-backup interval (called in index.js when the bot comes online).
 * @param {Client} client - Discord client (for logging if needed)
 * @returns {Object} { stop } - function to stop the interval
 */
function startAutoBackup(client) {
    // Backup at start
    const initial = createBackup();
    if (client)
        console.log(
            `💾 Auto-backup at startup: ${initial.backupName} (${initial.filesCopied} files, ${(initial.totalSize / 1024).toFixed(1)} KB)`
        );

    // Backup every 24 hours
    // P3-10 FIX: .unref() so the interval doesn't block process exit.
    const interval = setInterval(() => {
        const result = createBackup();
        if (client) console.log(`💾 Scheduled auto-backup: ${result.backupName} (${result.filesCopied} files)`);
    }, BACKUP_INTERVAL_MS);
    if (typeof interval.unref === 'function') interval.unref();

    return {
        stop: () => clearInterval(interval)
    };
}

/**
 * Format bytes into human-readable form.
 */
function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

module.exports = {
    createBackup,
    listBackups,
    restoreBackup,
    startAutoBackup,
    formatSize,
    FILES_TO_BACKUP,
    MAX_BACKUPS
};
