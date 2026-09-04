/**
 * Unit tests for backupManager (data layer)
 *
 * Verify: createBackup, listBackups, restoreBackup, cleanOldBackups
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    createBackup,
    listBackups,
    restoreBackup,
    formatSize,
    FILES_TO_BACKUP
} = require('../../src/data/backupManager');

// ====================================================
// === v3.9.24 FIX: production backups/ sandbox ===
// ====================================================
// The previous test created real backups in the production backups/ folder AND
// triggered cleanOldBackups() (keep-7), which EVICTED real backups. Now: the
// real backups/ folder is temporarily renamed while the test runs, and restored on exit.
const realBackupsDir = path.join(__dirname, '..', '..', 'backups');
const stashBackupsDir = path.join(__dirname, '..', '..', 'backups_test_stash');
let backupsStashed = false;
if (fs.existsSync(realBackupsDir)) {
    fs.renameSync(realBackupsDir, stashBackupsDir);
    backupsStashed = true;
}
process.on('exit', () => {
    // Must be sync (inside an exit handler). Restore the real backups/, discard test output.
    try {
        if (fs.existsSync(realBackupsDir)) {
            fs.rmSync(realBackupsDir, { recursive: true, force: true });
        }
        if (backupsStashed) {
            fs.renameSync(stashBackupsDir, realBackupsDir);
        }
    } catch (_) {}
});

test('backupManager: formatSize handles various sizes', () => {
    assert.strictEqual(formatSize(0), '0 B');
    assert.strictEqual(formatSize(512), '512 B');
    assert.strictEqual(formatSize(1024), '1.0 KB');
    assert.strictEqual(formatSize(1536), '1.5 KB');
    assert.strictEqual(formatSize(1048576), '1.00 MB');
    assert.strictEqual(formatSize(1572864), '1.50 MB');
});

test('backupManager: createBackup returns valid structure', () => {
    const result = createBackup();
    assert.ok(typeof result === 'object');
    assert.ok('ok' in result);
    assert.ok('backupName' in result);
    assert.ok('filesCopied' in result);
    assert.ok('totalSize' in result);
    assert.ok('errors' in result);
    assert.ok(Array.isArray(result.errors));
    assert.ok(typeof result.backupName === 'string');
    assert.ok(typeof result.filesCopied === 'number');
    assert.ok(typeof result.totalSize === 'number');
});

test('backupManager: createBackup result.ok is true when files copied', () => {
    const result = createBackup();
    if (result.filesCopied > 0) {
        assert.strictEqual(result.ok, true);
    }
    // If filesCopied === 0 (no data files yet), ok may be false — that's fine.
});

test('backupManager: listBackups returns array', () => {
    const backups = listBackups();
    assert.ok(Array.isArray(backups));
    for (const b of backups) {
        assert.ok('name' in b);
        assert.ok('size' in b);
        assert.ok('fileCount' in b);
        assert.ok('mtime' in b);
    }
});

test('backupManager: restoreBackup rejects invalid name format', () => {
    const result = restoreBackup('invalid-name-without-timestamp');
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.match(result.errors[0], /Invalid backup name format/i);
});

test('backupManager: restoreBackup rejects path traversal attempts', () => {
    const result = restoreBackup('../../../etc/passwd');
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
    // Can match "Invalid backup name format" or "path traversal"
    assert.ok(/Invalid|path traversal/i.test(result.errors[0]));
});

test('backupManager: restoreBackup rejects non-existent backup', () => {
    // Valid format but missing on disk
    const result = restoreBackup('2020-01-01_00-00-00');
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.match(result.errors[0], /not found/i);
});

test('backupManager: createBackup + listBackups integration', () => {
    // Create backup
    const createResult = createBackup();
    assert.ok(createResult.ok, 'create should succeed');

    // List backups — should include the one we just created
    const backups = listBackups();
    const found = backups.find(b => b.name === createResult.backupName);
    assert.ok(found, 'created backup should appear in listBackups');
});

// ====================================================
// === v3.9.24 GUARD: FILES_TO_BACKUP must not have holes ===
// ====================================================
// Real bug: automod.json (word rules auto-mod), levels.json, responders.json,
// afk.json, panels.json were NEVER backed up — /restore-backup couldn't
// recover those features. Guard: every live JSON file in data/ MUST be
// present in FILES_TO_BACKUP (the test fails if a new file is missing from the registry).
test('v3.9.24 GUARD: FILES_TO_BACKUP covers every live JSON file in data/', () => {
    const dataDir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dataDir)) {
        return; // fresh checkout without data — nothing can be missing
    }
    const liveFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
    assert.ok(liveFiles.length > 0, 'data/ should contain at least a few JSON files in this dev repo');
    for (const f of liveFiles) {
        assert.ok(
            FILES_TO_BACKUP.includes(f),
            `Live data file "${f}" is NOT in FILES_TO_BACKUP — the backup has a hole! Add it to src/data/backupManager.js`
        );
    }
});
