/**
 * Unit tests v3.31.0 — the per-guild command execution counter
 * (src/data/commandStats.js) that feeds the dashboard Overview
 * "Commands Executed" summary card.
 *
 * Locked behaviors:
 *   - increment/getCount round-trip per guild (cross-guild isolation)
 *   - reads never throw on a missing file (fresh counter starts at 0)
 *   - a corrupt file is quarantined, never crashes, and resets to 0
 *   - garbage entries in an otherwise valid file are filtered defensively
 *   - invalid guild ids (null/empty/number) are ignored, never counted
 *   - flush() persists counts to disk (a reload sees them)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');
const statsFile = path.join(dataDir, 'commandStats.json');

// Snapshot & restore — the module caches in memory, so a clean require per
// test group is the only way to exercise the file-loading paths.
let backup = null;
if (fs.existsSync(statsFile)) {
    backup = fs.readFileSync(statsFile);
}
process.on('exit', () => {
    try {
        if (backup !== null) {
            fs.writeFileSync(statsFile, backup);
        } else if (fs.existsSync(statsFile)) {
            fs.unlinkSync(statsFile);
        }
        // Clean up quarantine leftovers from the corrupt-file test.
        for (const f of fs.readdirSync(dataDir)) {
            if (f.startsWith('commandStats.json.')) {
                fs.unlinkSync(path.join(dataDir, f));
            }
        }
    } catch (_) {
        /* best-effort cleanup */
    }
});

function freshModule(withFile = null) {
    if (fs.existsSync(statsFile)) fs.unlinkSync(statsFile);
    if (withFile !== null) fs.writeFileSync(statsFile, withFile);
    return reloadModule();
}

/** Re-require WITHOUT touching the file on disk (simulates a process restart). */
function reloadModule() {
    delete require.cache[require.resolve('../../src/data/commandStats')];
    return require('../../src/data/commandStats');
}

test('v3.31.0 commandStats: increment + getCount round-trip, guild isolation', () => {
    const cs = freshModule();
    assert.strictEqual(cs.getCount('111'), 0, 'unknown guild starts at 0');
    cs.increment('111');
    cs.increment('111');
    cs.increment('222');
    assert.strictEqual(cs.getCount('111'), 2);
    assert.strictEqual(cs.getCount('222'), 1);
    assert.strictEqual(cs.getCount('333'), 0, 'a third guild stays at 0');
});

test('v3.31.0 commandStats: invalid guild ids are ignored', () => {
    const cs = freshModule();
    cs.increment(null);
    cs.increment(undefined);
    cs.increment('');
    cs.increment(12345);
    cs.getCount(null);
    cs.getCount(undefined);
    assert.strictEqual(cs.getCount('111'), 0, 'nothing was counted for invalid ids');
});

test('v3.31.0 commandStats: a persisted file is loaded back', () => {
    const cs = freshModule(JSON.stringify({ 111: 7, 222: 3 }));
    assert.strictEqual(cs.getCount('111'), 7);
    assert.strictEqual(cs.getCount('222'), 3);
});

test('v3.31.0 commandStats: garbage entries are filtered defensively', () => {
    const cs = freshModule(JSON.stringify({ 111: 5, bad: 'nope', 222: -4, 333: 2.7, '': 9 }));
    assert.strictEqual(cs.getCount('111'), 5, 'valid numeric entry survives');
    assert.strictEqual(cs.getCount('bad'), 0, 'non-numeric entry dropped');
    assert.strictEqual(cs.getCount('222'), 0, 'negative entry dropped');
    assert.strictEqual(cs.getCount('333'), 2, 'fractional entry floors to 2');
    assert.strictEqual(cs.getCount(''), 0, 'empty key dropped');
});

test('v3.31.0 commandStats: a corrupt file quarantines and resets to 0', () => {
    const cs = freshModule('{ this is not json !!');
    assert.strictEqual(cs.getCount('111'), 0);
    cs.increment('111');
    assert.strictEqual(cs.getCount('111'), 1);
});

test('v3.31.0 commandStats: flush persists counts a reload can see', () => {
    const cs = freshModule();
    cs.increment('111');
    cs.increment('111');
    cs.increment('111');
    cs.flush();
    const onDisk = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    assert.deepStrictEqual(onDisk, { 111: 3 });
    // A fresh process (fresh require, file kept) reads the same numbers.
    const cs2 = reloadModule();
    assert.strictEqual(cs2.getCount('111'), 3);
});
