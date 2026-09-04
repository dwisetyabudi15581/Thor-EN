/**
 * One-off cleanup: hapus residue data test dari clone dev ini (v3.9.24).
 *
 * Latar: test & smoke script sebelum v3.9.24 menulis entry guild test
 * (test_guild_*, smoke_guild_*, test-debug-guild) ke data/*.json dan bikin
 * folder backup artefak di backups/ tanpa pernah membersihkannya.
 * (data/ & backups/ di-gitignore — ini artefak lokal clone dev, BUKAN
 * data produksi yang jalan di server user.)
 *
 * Run sekali: node scripts/clean-test-residue.js
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON } = require('../src/infra/safeWrite');

const rootDir = path.join(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const backupsDir = path.join(rootDir, 'backups');

// Prefix key test yang pernah dipakai test/smoke di top-level data files.
const TEST_KEY_RE = /^(test_guild|smoke_guild|test-debug-guild)/;

let totalKeys = 0;

// === 1. Bersihkan residue key test dari data/*.json ===
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
            console.log(`🧹 ${file}: ${removed} key residue test dihapus`);
            totalKeys += removed;
        } else {
            console.log(`✅ ${file}: bersih`);
        }
    } catch (err) {
        console.warn(`⚠️ ${file}: skip (${err.message})`);
    }
}

// === 2. Bersihkan folder backup artefak test ===
// Signature artefak test: SEMUA file di dalamnya < 1KB (data test kecil).
// Backup asli berisi keys/config produksi yang jauh lebih besar.
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
            console.log(`🧹 backups/${name}: artefak test dihapus (semua file < 1KB)`);
            totalBackupDirs++;
        }
    }
    if (fs.existsSync(backupsDir) && fs.readdirSync(backupsDir).length === 0) {
        console.log('ℹ️ backups/ sekarang kosong — bot akan bikin backup-on-boot saat start.');
    }
}

console.log(`\n✅ Selesai: ${totalKeys} key data + ${totalBackupDirs} folder backup artefak dibersihkan.`);
