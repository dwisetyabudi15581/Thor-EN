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
    if (liveFiles.length === 0) {
        // v3.9.60 FIX: fresh checkout / CI — data/ exists (gitkeep) but holds no
        // runtime JSON (all data/*.json are gitignored). Previously this branch
        // FAILED the assertion below, making `npm test` red on every fresh clone.
        // Nothing live on disk → nothing can be missing from FILES_TO_BACKUP.
        // The registry itself is guarded by the dedicated regression tests below.
        return;
    }
    for (const f of liveFiles) {
        assert.ok(
            FILES_TO_BACKUP.includes(f),
            `Live data file "${f}" is NOT in FILES_TO_BACKUP — the backup has a hole! Add it to src/data/backupManager.js`
        );
    }
});

// ====================================================
// === v3.9.60 REGRESSION: FILES_TO_BACKUP registry completeness ===
// ====================================================
// The GUARD test above can only catch holes when data/ holds live runtime files
// (never true on a fresh clone / CI — data/*.json are gitignored). These
// registry assertions are order-independent and environment-independent, so the
// holes caught in the wild are pinned here forever.

test('v3.9.60 REGRESSION: modlogs.json is in FILES_TO_BACKUP (modLogManager v3.9.43 hole)', () => {
    // Real bug: modLogManager (v3.9.43) writes data/modlogs.json (per-user
    // timeout/kick/ban history shown by /warn-list), but the file was NEVER
    // added to FILES_TO_BACKUP → /backup-now skipped it and /restore-backup
    // silently lost all moderation history.
    assert.ok(
        FILES_TO_BACKUP.includes('modlogs.json'),
        'modlogs.json must be in FILES_TO_BACKUP — moderation history was silently excluded from backups'
    );
});

test('v3.9.60 REGRESSION: every data manager JSON file name is in FILES_TO_BACKUP', () => {
    // Cross-check the managers that persist a data/<name>.json file (grep for
    // path.join(..., 'data', '<file>.json') in src/data/*). A new manager added
    // without a FILES_TO_BACKUP entry breaks this test — same invariant as the
    // live-file GUARD above, but green on a fresh clone.
    const managerFiles = [
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
        'automod.json',
        'levels.json',
        'responders.json',
        'afk.json',
        'panels.json',
        'deals.json',
        'boosts.json',
        'serverstats.json',
        'modlogs.json'
    ];
    for (const f of managerFiles) {
        assert.ok(
            FILES_TO_BACKUP.includes(f),
            `"${f}" (data-layer manager file) is missing from FILES_TO_BACKUP — add it to src/data/backupManager.js`
        );
    }
});

// ====================================================
// === v3.9.60 REGRESSION: post-restore cache invalidation ===
// ====================================================
// Real bug: boosts.json has been restored since v3.9.49, but boostManager holds
// a permanent in-memory `store` cache that was never invalidated post-restore
// (only stats/serverstats/permissions/panels/automod/afk/responders/levels
// were). The first boost event after a restore mutated the STALE pre-restore
// object and save() wrote it over the freshly restored boosts.json → silent
// loss of the restored history. modlogs.json (added to FILES_TO_BACKUP in
// v3.9.60) has the same permanent-cache pattern → must be invalidated too.
test('v3.9.60 REGRESSION: restoreBackup invalidates boostManager & modLogManager caches', () => {
    // 1. Create a real backup with a boosts.json + modlogs.json in it.
    const boostsPath = path.join(__dirname, '..', '..', 'data', 'boosts.json');
    const modlogsPath = path.join(__dirname, '..', '..', 'data', 'modlogs.json');
    const hadBoosts = fs.existsSync(boostsPath);
    const hadModlogs = fs.existsSync(modlogsPath);
    const oldBoosts = hadBoosts ? fs.readFileSync(boostsPath, 'utf8') : null;
    const oldModlogs = hadModlogs ? fs.readFileSync(modlogsPath, 'utf8') : null;
    fs.writeFileSync(
        boostsPath,
        JSON.stringify({ 'g1:u1': { guildId: 'g1', userId: 'u1', totalBoosts: 7 } }),
        'utf8'
    );
    fs.writeFileSync(modlogsPath, JSON.stringify({ 'g1:u1': [{ id: 'mod_x', type: 'ban' }] }), 'utf8');
    try {
        const created = createBackup();
        assert.ok(created.ok, 'createBackup should succeed');
        assert.ok(created.filesCopied >= 2, 'boosts.json + modlogs.json should be in the backup');

        // 2. Prime the managers' permanent caches with the current (live) state.
        const boostManager = require('../../src/data/boostManager');
        const modLogManager = require('../../src/data/modLogManager');
        boostManager.getBoostHistory('g1'); // populates store cache
        modLogManager.getModLogs('g1', 'u1'); // populates store cache

        // 3. Change the live files to something DIFFERENT from the backup...
        fs.writeFileSync(
            boostsPath,
            JSON.stringify({ 'g1:u1': { guildId: 'g1', userId: 'u1', totalBoosts: 99 } }),
            'utf8'
        );
        fs.writeFileSync(modlogsPath, JSON.stringify({ 'g1:u1': [{ id: 'mod_y', type: 'kick' }] }), 'utf8');

        // 4. Restore the backup (should copy the backed-up values back AND drop
        //    the stale in-memory caches). The restore is sandboxed to the real
        //    backups/ folder by the stash at the top of this file.
        const restored = restoreBackup(created.backupName);
        assert.ok(restored.ok, 'restoreBackup should succeed');
        assert.strictEqual(
            JSON.parse(fs.readFileSync(boostsPath, 'utf8'))['g1:u1'].totalBoosts,
            7,
            'boosts.json content should be the restored one'
        );
        assert.strictEqual(
            JSON.parse(fs.readFileSync(modlogsPath, 'utf8'))['g1:u1'][0].id,
            'mod_x',
            'modlogs.json content should be the restored one'
        );

        // 5. THE REGRESSION: the caches must now reflect the RESTORED data, not
        //    the pre-restore state (a permanent store cache that still holds
        //    totalBoosts=99 / mod_y would overwrite the restored file on the
        //    next save()).
        assert.strictEqual(
            boostManager.getBoostHistory('g1').find(e => e.userId === 'u1')?.totalBoosts,
            7,
            'boostManager cache must be reloaded from the RESTORED boosts.json (was stale → silent data loss)'
        );
        assert.strictEqual(
            modLogManager.getModLogs('g1', 'u1')[0]?.id,
            'mod_x',
            'modLogManager cache must be reloaded from the RESTORED modlogs.json (was stale → silent data loss)'
        );
    } finally {
        // 6. Restore the original (pre-test) state of the live files.
        try {
            if (oldBoosts !== null) fs.writeFileSync(boostsPath, oldBoosts, 'utf8');
            else fs.rmSync(boostsPath, { force: true });
            if (oldModlogs !== null) fs.writeFileSync(modlogsPath, oldModlogs, 'utf8');
            else fs.rmSync(modlogsPath, { force: true });
        } catch (_) {}
        // Drop the caches so other tests / a later fresh start re-read from disk.
        try {
            require('../../src/data/boostManager').reload();
            require('../../src/data/modLogManager').reload();
        } catch (_) {}
        void hadBoosts;
        void hadModlogs;
    }
});
