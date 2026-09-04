/**
 * One-off cleanup: remove test data residue from this dev clone (v3.9.24).
 *
 * Background: tests & smoke scripts before v3.9.24 wrote test guild entries
 * (test_guild_*, smoke_guild_*, test-debug-guild) into data/*.json and created
 * artifact backup folders in backups/ without ever cleaning them up.
 * (data/ & backups/ are gitignored — these are local artifacts of the dev clone,
 * NOT production data running on a user's server.)
 *
 * Run once: node scripts/clean-test-residue.js
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON } = require('../src/infra/safeWrite');

const rootDir = path.join(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const backupsDir = path.join(rootDir, 'backups');

// Test key prefixes once used by tests/smoke scripts in the top-level data files.
const TEST_KEY_RE = /^(test_guild|smoke_guild|test-debug-guild)/;

let totalKeys = 0;

// === 1. Clean test-key residue from data/*.json ===
for (const file of fs.readdirSync(dataDir).filter(f => f.endsWith('.json'))) {
    const p = path.join(dataDir, file);
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        let removed = 0;
        for (const key of Object.keys(data)) {
            if (TEST_KEY_RE.test(key)) {
                delete data[key];
                removed++;
            }
        }
        if (removed > 0) {
            safeWriteJSON(p, data);
            console.log(`🧹 ${file}: removed ${removed} test residue key(s)`);
            totalKeys += removed;
        } else {
            console.log(`✅ ${file}: clean`);
        }
    } catch (err) {
        console.warn(`⚠️ ${file}: skip (${err.message})`);
    }
}

// === 2. Clean test-artifact backup folders ===
// Test artifact signature: ALL files inside are < 1KB (small test data).
// Real backups contain production keys/config, which are far larger.
let totalBackupDirs = 0;
if (fs.existsSync(backupsDir)) {
    for (const name of fs.readdirSync(backupsDir)) {
        const dir = path.join(backupsDir, name);
        if (!fs.statSync(dir).isDirectory()) continue;
        const files = fs.readdirSync(dir);
        const allTiny =
            files.length > 0 &&
            files.every(f => {
                try {
                    return fs.statSync(path.join(dir, f)).size < 1024;
                } catch (_) {
                    return false;
                }
            });
        if (allTiny) {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`🧹 backups/${name}: test artifact removed (all files < 1KB)`);
            totalBackupDirs++;
        }
    }
    if (fs.existsSync(backupsDir) && fs.readdirSync(backupsDir).length === 0) {
        console.log('ℹ️ backups/ is now empty — the bot will create a backup-on-boot at startup.');
    }
}

console.log(`\n✅ Done: cleaned ${totalKeys} data key(s) + ${totalBackupDirs} artifact backup folder(s).`);
