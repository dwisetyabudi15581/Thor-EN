/**
 * Unit tests for v3.9.47 — auto-responder MATCH MODES.
 *
 * User request (production): "if I set the trigger 'beli', then when a member
 * writes 'bagaimana cara beli' the bot must respond" + a setting to choose
 * between exact (as set / start of message) and contains (anywhere in the
 * sentence). These tests pin both modes, the word-boundary behavior, the
 * legacy-entry migration, the cooldown interplay, and the registry option.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { safeWriteJSON } = require('../../src/infra/safeWrite');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const RESPONDERS_PATH = path.join(DATA_DIR, 'responders.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============ PURE MATCHER (messageMatchesTrigger) ============

test('messageMatchesTrigger: contains matches the trigger word anywhere', () => {
    const { messageMatchesTrigger } = require('../../src/data/responderManager');
    // The exact scenario the user reported as broken.
    assert.strictEqual(messageMatchesTrigger('bagaimana cara beli', 'beli', 'contains'), true);
    assert.strictEqual(messageMatchesTrigger('beli', 'beli', 'contains'), true);
    assert.strictEqual(messageMatchesTrigger('mau beli dong', 'beli'), true); // omitted mode = contains
    assert.strictEqual(messageMatchesTrigger('Bagaimana Cara Beli', 'beli', 'contains'), true);
});

test('messageMatchesTrigger: word boundaries — longer words do NOT match', () => {
    const { messageMatchesTrigger } = require('../../src/data/responderManager');
    assert.strictEqual(messageMatchesTrigger('belian murah banget', 'beli', 'contains'), false);
    assert.strictEqual(messageMatchesTrigger('aku membeli diamond', 'beli', 'contains'), false);
    assert.strictEqual(messageMatchesTrigger('belipulsa disini', 'beli', 'contains'), false);
    // Punctuation counts as a boundary (a question/answer is still the word).
    assert.strictEqual(messageMatchesTrigger('mau beli?', 'beli', 'contains'), true);
    assert.strictEqual(messageMatchesTrigger('beli!', 'beli', 'contains'), true);
});

test('messageMatchesTrigger: exact mode = start of message only (legacy behavior)', () => {
    const { messageMatchesTrigger } = require('../../src/data/responderManager');
    assert.strictEqual(messageMatchesTrigger('!sosmed halo', '!sosmed', 'exact'), true);
    assert.strictEqual(messageMatchesTrigger('!sosmed', '!sosmed', 'exact'), true);
    assert.strictEqual(messageMatchesTrigger('oi !sosmed halo', '!sosmed', 'exact'), false);
    assert.strictEqual(messageMatchesTrigger('!sosmednya', '!sosmed', 'exact'), false);
});

test('messageMatchesTrigger: multi-word triggers + whitespace collapsing', () => {
    const { messageMatchesTrigger } = require('../../src/data/responderManager');
    assert.strictEqual(messageMatchesTrigger('bagaimana cara beli ya', 'cara beli', 'contains'), true);
    // Doubled spaces in the message still match a single-spaced trigger.
    assert.strictEqual(messageMatchesTrigger('bagaimana cara  beli ya', 'cara beli', 'contains'), true);
    // "caranya" is NOT the word "cara" — no match.
    assert.strictEqual(messageMatchesTrigger('caranya beli', 'cara beli', 'contains'), false);
});

test('messageMatchesTrigger: regex-special triggers are escaped, never crash', () => {
    const { messageMatchesTrigger } = require('../../src/data/responderManager');
    assert.doesNotThrow(() => messageMatchesTrigger('oi !sos.med+ ya', '!sos.med+', 'contains'));
    assert.strictEqual(messageMatchesTrigger('oi !sos.med+ ya', '!sos.med+', 'contains'), true);
    assert.strictEqual(messageMatchesTrigger('plain text here', 'a.b*c', 'contains'), false);
});

test('messageMatchesTrigger: invalid inputs return false (never throw)', () => {
    const { messageMatchesTrigger } = require('../../src/data/responderManager');
    assert.strictEqual(messageMatchesTrigger('', 'beli'), false);
    assert.strictEqual(messageMatchesTrigger('beli apa', ''), false);
    assert.strictEqual(messageMatchesTrigger(null, 'beli'), false);
    assert.strictEqual(messageMatchesTrigger('beli', undefined), false);
});

// ============ STORAGE (addResponder) ============

test('addResponder: stores matchMode, defaults to contains (v3.9.47)', () => {
    const { addResponder, removeResponder, invalidateCache } = require('../../src/data/responderManager');
    const G = 'test_guild_store';

    const a = addResponder(G, { trigger: 'beli', reply: 'x', createdBy: 'u', createdByTag: 'U' });
    assert.strictEqual(a.responder.matchMode, 'contains'); // default

    const b = addResponder(G, { trigger: 'jual', reply: 'y', matchMode: 'exact', createdBy: 'u', createdByTag: 'U' });
    assert.strictEqual(b.responder.matchMode, 'exact');

    // Garbage values are normalized to contains — the data file must never
    // carry an unknown mode forward.
    const c = addResponder(G, { trigger: 'sewa', reply: 'z', matchMode: 'weird', createdBy: 'u', createdByTag: 'U' });
    assert.strictEqual(c.responder.matchMode, 'contains');

    removeResponder(G, 'beli');
    removeResponder(G, 'jual');
    removeResponder(G, 'sewa');
    invalidateCache();
});

// ============ INTEGRATION (findMatch) ============

test('USER SCENARIO: trigger "beli" now answers "bagaimana cara beli" (v3.9.47)', () => {
    const { addResponder, findMatch, removeResponder, invalidateCache } = require('../../src/data/responderManager');
    const G = 'test_guild_userscenario';

    addResponder(G, { trigger: 'beli', reply: 'Ini cara belinya!', createdBy: 'u', createdByTag: 'U' });

    const m = findMatch(G, 'Bagaimana cara beli ya?');
    assert.ok(m, '"bagaimana cara beli" must match the trigger "beli"');
    assert.strictEqual(m.trigger, 'beli');

    removeResponder(G, 'beli');
    invalidateCache();
});

test('findMatch: exact mode keeps the legacy start-of-message behavior', () => {
    const { addResponder, findMatch, removeResponder, invalidateCache } = require('../../src/data/responderManager');
    const G = 'test_guild_exact';

    addResponder(G, { trigger: 'kunci', reply: 'x', matchMode: 'exact', createdBy: 'u', createdByTag: 'U' });

    assert.ok(findMatch(G, 'kunci dong')); // starts with the trigger + space
    assert.strictEqual(findMatch(G, 'oi kunci dong'), null); // mid-sentence: NO match in exact mode
    assert.strictEqual(findMatch(G, 'kuncinya apa'), null); // glued suffix: no match either

    removeResponder(G, 'kunci');
    invalidateCache();
});

test('findMatch: contains matching stays case-insensitive (v3.9.47)', () => {
    const { addResponder, findMatch, removeResponder, invalidateCache } = require('../../src/data/responderManager');
    const G = 'test_guild_case';

    addResponder(G, { trigger: 'BELI', reply: 'x', createdBy: 'u', createdByTag: 'U' });
    assert.ok(findMatch(G, 'mau Beli dong'));
    assert.ok(findMatch(G, 'GIMANA CARA BELI'));

    removeResponder(G, 'BELI');
    invalidateCache();
});

test('findMatch: legacy entry without matchMode is treated as contains (v3.9.47)', () => {
    const { addResponder, findMatch, removeResponder, invalidateCache } = require('../../src/data/responderManager');
    const G = 'test_guild_legacy';

    addResponder(G, { trigger: 'beli', reply: 'x', createdBy: 'u', createdByTag: 'U' });
    // Simulate an entry created BEFORE v3.9.47: strip matchMode on disk.
    const data = JSON.parse(fs.readFileSync(RESPONDERS_PATH, 'utf8'));
    for (const r of data[G]) delete r.matchMode;
    safeWriteJSON(RESPONDERS_PATH, data);
    invalidateCache();

    const m = findMatch(G, 'bagaimana cara beli');
    assert.ok(m, 'a legacy entry (no matchMode) must default to the contains mode');
    assert.strictEqual(m.trigger, 'beli');

    removeResponder(G, 'beli');
    invalidateCache();
});

test('findMatch: per-user cooldown still applies in contains mode (v3.9.47)', () => {
    const { addResponder, findMatch, markUsed, removeResponder, invalidateCache } = require('../../src/data/responderManager');
    const G = 'test_guild_cd';

    const res = addResponder(G, {
        trigger: 'stok',
        reply: 'x',
        cooldownMs: 60000,
        createdBy: 'u',
        createdByTag: 'U'
    });

    assert.ok(findMatch(G, 'stok ready?', 'userA'));
    markUsed(G, res.responder.id, 'userA');

    // Same user within the cooldown → no match…
    assert.strictEqual(findMatch(G, 'stok ready?', 'userA'), null);
    // …but a DIFFERENT user still gets the reply (per-user, not global).
    assert.ok(findMatch(G, 'stok ready?', 'userB'));

    removeResponder(G, 'stok');
    invalidateCache();
});

test('findMatch: a responder on cooldown no longer aborts the scan (v3.9.47)', () => {
    const { addResponder, findMatch, markUsed, removeResponder, invalidateCache } = require('../../src/data/responderManager');
    const G = 'test_guild_cdscan';

    addResponder(G, { trigger: 'beli', reply: 'A', createdBy: 'u', createdByTag: 'U' });
    addResponder(G, { trigger: 'cara beli', reply: 'B', createdBy: 'u', createdByTag: 'U' });

    // Both match "bagaimana cara beli"; 'beli' sits earlier in the array.
    const first = findMatch(G, 'bagaimana cara beli', 'userA');
    assert.ok(first);
    assert.strictEqual(first.trigger, 'beli');
    markUsed(G, first.id, 'userA'); // userA is now on cooldown for 'beli'

    // OLD behavior: `return null` → NO reply at all. NEW: the scan continues
    // → the overlapping 'cara beli' responder still answers.
    const second = findMatch(G, 'bagaimana cara beli', 'userA');
    assert.ok(second, 'the scan must continue past a cooldown responder');
    assert.strictEqual(second.trigger, 'cara beli');

    removeResponder(G, 'beli');
    removeResponder(G, 'cara beli');
    invalidateCache();
});

// ============ REGISTRY CONTRACT ============

test('registry: /add-responder exposes the match_mode option (v3.9.47)', () => {
    const { getCommands } = require('../../src/commands/registry');
    const cmd = getCommands().find(c => c.name === 'add-responder');
    assert.ok(cmd, 'add-responder must stay registered');

    const opt = cmd.options.find(o => o.name === 'match_mode');
    assert.ok(opt, 'add-responder needs the match_mode option');
    const values = opt.choices.map(c => c.value).sort();
    assert.deepStrictEqual(values, ['contains', 'exact']);
    // Optional so Discord can omit it — the bot then defaults to contains.
    assert.strictEqual(opt.required, false);
    // Choice names must respect the Discord 100-char limit.
    for (const c of opt.choices) assert.ok(c.name.length <= 100);
});

// ============ CLEANUP ============

test('v3.9.47 cleanup: no test-guild residue in responders.json', () => {
    const { invalidateCache } = require('../../src/data/responderManager');
    if (!fs.existsSync(RESPONDERS_PATH)) {
        assert.ok(true, 'no responders.json — nothing to clean');
        return;
    }
    const data = JSON.parse(fs.readFileSync(RESPONDERS_PATH, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        assert.ok(true, 'oddly-shaped file — not this test\'s concern');
        return;
    }
    let removed = 0;
    for (const key of Object.keys(data)) {
        if (/^test_guild/.test(key)) {
            delete data[key];
            removed++;
        }
    }
    if (removed > 0) safeWriteJSON(RESPONDERS_PATH, data);
    invalidateCache();
    assert.ok(true, `cleanup done (${removed} residue guilds removed)`);
});
