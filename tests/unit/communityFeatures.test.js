/**
 * Unit tests for v3.9.13 — 4 new community features
 * - responderManager (auto-responder)
 * - automodManager (anti-spam)
 * - afkManager (AFK system)
 * - levelManager (leveling)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============ RESPONDER MANAGER ============

test('responderManager: addResponder creates entry', () => {
    const { addResponder, getGuildResponders, removeResponder } = require('../../src/data/responderManager');
    const result = addResponder('test_guild_resp', {
        trigger: '!test-trigger',
        reply: 'Test reply',
        replyType: 'text',
        createdBy: 'test_user',
        createdByTag: 'TestUser'
    });
    assert.ok(result.ok);
    assert.strictEqual(result.responder.trigger, '!test-trigger');
    assert.strictEqual(result.responder.reply, 'Test reply');

    const list = getGuildResponders('test_guild_resp');
    assert.ok(list.some(r => r.trigger === '!test-trigger'));

    removeResponder('test_guild_resp', '!test-trigger');
});

test('responderManager: duplicate trigger rejected', () => {
    const { addResponder, removeResponder } = require('../../src/data/responderManager');
    addResponder('test_guild_dup', {
        trigger: '!dup-test',
        reply: 'First',
        createdBy: 'u',
        createdByTag: 'U'
    });
    const result = addResponder('test_guild_dup', {
        trigger: '!dup-test',
        reply: 'Second',
        createdBy: 'u',
        createdByTag: 'U'
    });
    assert.ok(!result.ok);
    assert.match(result.error, /already exists/i);
    removeResponder('test_guild_dup', '!dup-test');
});

test('responderManager: findMatch returns correct responder', () => {
    const { addResponder, findMatch, removeResponder, markUsed } = require('../../src/data/responderManager');
    addResponder('test_guild_match', {
        trigger: '!sosmed-test',
        reply: 'IG: @test',
        createdBy: 'u',
        createdByTag: 'U'
    });

    const match = findMatch('test_guild_match', '!sosmed-test halo');
    assert.ok(match);
    assert.strictEqual(match.trigger, '!sosmed-test');

    // No match for other triggers
    const noMatch = findMatch('test_guild_match', '!lain');
    assert.strictEqual(noMatch, null);

    removeResponder('test_guild_match', '!sosmed-test');
});

test('responderManager: case-insensitive trigger match', () => {
    const { addResponder, findMatch, removeResponder } = require('../../src/data/responderManager');
    addResponder('test_guild_case', {
        trigger: '!SOSMED',
        reply: 'Test',
        createdBy: 'u',
        createdByTag: 'U'
    });

    const match = findMatch('test_guild_case', '!sosmed halo');
    assert.ok(match);

    removeResponder('test_guild_case', '!SOSMED');
});

test('responderManager: v3.9.14 per-user cooldown (different users not blocked)', () => {
    const { addResponder, findMatch, removeResponder, markUsed } = require('../../src/data/responderManager');
    addResponder('test_guild_usercd', {
        trigger: '!cdtest',
        reply: 'Test reply',
        createdBy: 'u',
        createdByTag: 'U',
        cooldownMs: 5000
    });

    // User A triggers
    const matchA = findMatch('test_guild_usercd', '!cdtest', 'userA');
    assert.ok(matchA);
    markUsed('test_guild_usercd', matchA.id, 'userA');

    // User B triggers within cooldown period — should still get reply (per-user cooldown)
    const matchB = findMatch('test_guild_usercd', '!cdtest', 'userB');
    assert.ok(matchB, 'User B should get reply even if User A just triggered (per-user cooldown)');

    // User A triggers again within cooldown — should be blocked
    const matchA2 = findMatch('test_guild_usercd', '!cdtest', 'userA');
    assert.strictEqual(matchA2, null, 'User A should be on cooldown');

    removeResponder('test_guild_usercd', '!cdtest');
});

// ============ AUTOMOD MANAGER ============

test('automodManager: getDefaultConfig returns valid structure', () => {
    const { getDefaultConfig } = require('../../src/data/automodManager');
    const config = getDefaultConfig();
    assert.ok('spamThreshold' in config);
    assert.ok('spamWindowMs' in config);
    assert.ok('spamAction' in config);
    assert.ok('blockLinks' in config);
    assert.ok('blockWords' in config);
    assert.ok('maxMentions' in config);
    assert.ok('enabled' in config);
});

test('automodManager: setGuildConfig persists updates', () => {
    const { setGuildConfig, getGuildConfig } = require('../../src/data/automodManager');
    setGuildConfig('test_guild_automod', { spamThreshold: 10, blockLinks: true });
    const config = getGuildConfig('test_guild_automod');
    assert.strictEqual(config.spamThreshold, 10);
    assert.strictEqual(config.blockLinks, true);
});

test('automodManager: containsLink detects URLs', () => {
    const { containsLink } = require('../../src/data/automodManager');
    assert.ok(containsLink('cek https://google.com'));
    assert.ok(containsLink('cek http://example.com'));
    assert.ok(containsLink('cek www.google.com'));
    assert.ok(!containsLink('pesan biasa tanpa link'));
});

test('automodManager: containsBlockedWord detects bad words', () => {
    const { containsBlockedWord } = require('../../src/data/automodManager');
    const blockWords = ['spam', 'scam'];
    assert.strictEqual(containsBlockedWord('ini spam banget', blockWords), 'spam');
    assert.strictEqual(containsBlockedWord('awas scam', blockWords), 'scam');
    assert.strictEqual(containsBlockedWord('pesan bersih', blockWords), null);
});

test('automodManager: checkSpam detects spam pattern', () => {
    const { checkSpam, resetSpamTracker, getDefaultConfig } = require('../../src/data/automodManager');
    const config = { ...getDefaultConfig(), spamThreshold: 3, spamWindowMs: 10000, enabled: true };
    resetSpamTracker('test_guild_spam', 'test_user_spam');

    // 3 messages within the window → spam (threshold 3, so the 4th message triggers)
    // Actually checkSpam returns true when length > threshold
    assert.ok(!checkSpam('test_guild_spam', 'test_user_spam', config)); // 1 msg
    assert.ok(!checkSpam('test_guild_spam', 'test_user_spam', config)); // 2 msg
    assert.ok(!checkSpam('test_guild_spam', 'test_user_spam', config)); // 3 msg (== threshold, not >)
    assert.ok(checkSpam('test_guild_spam', 'test_user_spam', config)); // 4 msg (> threshold)

    resetSpamTracker('test_guild_spam', 'test_user_spam');
});

// ============ AFK MANAGER ============

test('afkManager: setAFK creates entry', () => {
    const { setAFK, getAFK, isAFK, clearAFK } = require('../../src/data/afkManager');
    setAFK('test_guild_afk', 'test_user_afk', 'Makan dulu');
    assert.ok(isAFK('test_guild_afk', 'test_user_afk'));
    const data = getAFK('test_guild_afk', 'test_user_afk');
    assert.strictEqual(data.reason, 'Makan dulu');
    clearAFK('test_guild_afk', 'test_user_afk');
});

test('afkManager: clearAFK removes entry', () => {
    const { setAFK, isAFK, clearAFK } = require('../../src/data/afkManager');
    setAFK('test_guild_clear', 'test_user_clear', 'AFK');
    assert.ok(isAFK('test_guild_clear', 'test_user_clear'));
    clearAFK('test_guild_clear', 'test_user_clear');
    assert.ok(!isAFK('test_guild_clear', 'test_user_clear'));
});

test('afkManager: AFK scoped per guild', () => {
    const { setAFK, isAFK, clearAFK } = require('../../src/data/afkManager');
    setAFK('guild_A', 'user_x', 'AFK di A');
    assert.ok(isAFK('guild_A', 'user_x'));
    assert.ok(!isAFK('guild_B', 'user_x')); // not AFK in guild B
    clearAFK('guild_A', 'user_x');
});

test('afkManager: formatDuration returns readable string', () => {
    const { formatDuration } = require('../../src/data/afkManager');
    const now = Date.now();
    assert.match(formatDuration(now - 30 * 1000, now), /second/);
    assert.match(formatDuration(now - 5 * 60 * 1000, now), /minute/);
    assert.match(formatDuration(now - 2 * 60 * 60 * 1000, now), /hour/);
    assert.match(formatDuration(now - 24 * 60 * 60 * 1000, now), /day/);
});

// ============ LEVEL MANAGER ============

test('levelManager: xpForLevel formula', () => {
    const { xpForLevel } = require('../../src/data/levelManager');
    assert.strictEqual(xpForLevel(0), 0);
    assert.strictEqual(xpForLevel(1), 100);
    assert.strictEqual(xpForLevel(2), 300);
    assert.strictEqual(xpForLevel(5), 1500);
    assert.strictEqual(xpForLevel(10), 5500);
});

test('levelManager: levelFromXp correct calculation', () => {
    const { levelFromXp, xpForLevel } = require('../../src/data/levelManager');
    assert.strictEqual(levelFromXp(0), 0);
    assert.strictEqual(levelFromXp(99), 0); // below 100 = level 0
    assert.strictEqual(levelFromXp(100), 1); // exactly 100 = level 1
    assert.strictEqual(levelFromXp(299), 1); // below 300 = level 1
    assert.strictEqual(levelFromXp(300), 2); // exactly 300 = level 2
    assert.strictEqual(levelFromXp(1500), 5); // exactly 1500 = level 5
});

test('levelManager: addXp increases level', () => {
    const { addXp, getUser } = require('../../src/data/levelManager');
    const config = { cooldownMs: 0 }; // no cooldown for test
    const gid = 'test_guild_lvl_' + Date.now();
    const uid = 'test_user_lvl_' + Date.now();

    // Add 100 XP → level 1
    const result1 = addXp(gid, uid, 100, config);
    assert.ok(result1.leveledUp);
    assert.strictEqual(result1.newLevel, 1);

    const user = getUser(gid, uid);
    assert.strictEqual(user.level, 1);
    assert.strictEqual(user.totalXp, 100);
});

test('levelManager: addXp respects cooldown', () => {
    const { addXp } = require('../../src/data/levelManager');
    const config = { cooldownMs: 60000 }; // 1 minute cooldown
    const gid = 'test_guild_cd_' + Date.now();
    const uid = 'test_user_cd_' + Date.now();

    // First call → gain XP
    const result1 = addXp(gid, uid, 50, config);
    assert.ok(!result1.onCooldown);

    // Second call immediately → on cooldown, no XP gain
    const result2 = addXp(gid, uid, 50, config);
    assert.ok(result2.onCooldown);
    assert.ok(!result2.leveledUp);
});

test('levelManager: getTopUsers returns sorted list', () => {
    const { addXp, getTopUsers } = require('../../src/data/levelManager');
    const config = { cooldownMs: 0 };

    // Add different XP to 3 users
    addXp('test_guild_top', 'user_low', 50, config);
    addXp('test_guild_top', 'user_mid', 200, config);
    addXp('test_guild_top', 'user_high', 500, config);

    const top = getTopUsers('test_guild_top', 10);
    assert.ok(top.length >= 3);
    // Sorted descending by totalXp
    assert.strictEqual(top[0].userId, 'user_high');
    assert.strictEqual(top[1].userId, 'user_mid');
    assert.strictEqual(top[2].userId, 'user_low');
});

test('levelManager: getRoleForLevel returns array of roles for stacking (v3.9.14)', () => {
    const { getRoleForLevel } = require('../../src/data/levelManager');
    const config = {
        levelRoles: [
            { level: 10, roleId: 'role_10' },
            { level: 50, roleId: 'role_50' }
        ]
    };
    assert.deepStrictEqual(getRoleForLevel(5, config), []); // below any threshold
    assert.deepStrictEqual(getRoleForLevel(10, config), ['role_10']); // cap level 10
    assert.deepStrictEqual(getRoleForLevel(30, config), ['role_10']); // still only role_10 (level 50 not yet capped)
    assert.deepStrictEqual(getRoleForLevel(50, config), ['role_10', 'role_50']); // STACKING: gets both
    assert.deepStrictEqual(getRoleForLevel(100, config), ['role_10', 'role_50']); // still both
});

// ============ CONFIG MANAGER — leveling config ============

test('configManager: leveling config defaults applied', () => {
    const { getConfig } = require('../../src/data/configManager');
    const config = getConfig();
    assert.ok(config.leveling);
    assert.strictEqual(config.leveling.enabled, false); // default off
    assert.ok('xpPerMessage' in config.leveling);
    assert.ok('cooldownMs' in config.leveling);
    assert.ok(Array.isArray(config.levelRoles));
});

// ============ v3.9.23: AUTOMOD WORD FLEX ============
// - addWords: appends without replacing the old list + dedupe + per-word action
// - removeWord: removes one specific word
// - matchWord: whole-word vs substring
// - findViolatedWord: per-word action + exempt list
// - legacy blockWords → wordRules migration

test('automodWordFlex: getDefaultConfig has new v3.9.23 fields', () => {
    const { getDefaultConfig } = require('../../src/data/automodManager');
    const config = getDefaultConfig();
    assert.ok(Array.isArray(config.wordRules), 'wordRules should be array');
    assert.ok(Array.isArray(config.exemptWords), 'exemptWords should be array');
    assert.strictEqual(config.wordMatchMode, 'whole_word', 'default match mode should be whole_word');
});

test('automodWordFlex: addWords appends without destroying existing list', () => {
    const { addWords, getGuildConfig } = require('../../src/data/automodManager');
    // Unique guild ID per run — this test APPENDS data, so it must not collide with residue from previous runs
    // (same pattern as the levelManager tests: 'test_guild_lvl_' + Date.now()).
    const gid = 'test_guild_wflex_add_' + Date.now();
    const uid = 'admin_user';

    // Add the first batch
    const r1 = addWords(gid, 'kata1, kata2', null, uid);
    assert.deepStrictEqual(r1.added, ['kata1', 'kata2']);
    assert.strictEqual(r1.skipped.length, 0);

    // Add a second batch — the old list MUST survive (append, not replace)
    const r2 = addWords(gid, 'kata3', 'mute_10m', uid);
    assert.deepStrictEqual(r2.added, ['kata3']);

    const config = getGuildConfig(gid);
    const words = config.wordRules.map(r => r.word);
    assert.deepStrictEqual(words, ['kata1', 'kata2', 'kata3'], 'old words must survive append');
    // kata3 has a custom action, kata1/kata2 do not (null → global fallback)
    const kata3 = config.wordRules.find(r => r.word === 'kata3');
    assert.strictEqual(kata3.action, 'mute_10m');
    const kata1 = config.wordRules.find(r => r.word === 'kata1');
    assert.strictEqual(kata1.action, null);
});

test('automodWordFlex: addWords skips duplicate words', () => {
    const { addWords, getGuildConfig } = require('../../src/data/automodManager');
    const gid = 'test_guild_wflex_dup_' + Date.now();

    addWords(gid, 'spamword', null, 'u');
    const r2 = addWords(gid, 'spamword, otherword', null, 'u');
    assert.deepStrictEqual(r2.skipped, ['spamword'], 'duplicate should be skipped');
    assert.deepStrictEqual(r2.added, ['otherword']);

    const config = getGuildConfig(gid);
    assert.strictEqual(config.wordRules.length, 2, 'no duplicate entries');
});

test('automodWordFlex: addWords rejects invalid action', () => {
    const { addWords, getGuildConfig } = require('../../src/data/automodManager');
    const gid = 'test_guild_wflex_badact_' + Date.now();
    const r = addWords(gid, 'kata', 'bogus_action', 'u');
    assert.ok(r.error, 'invalid action should return error');
    const config = getGuildConfig(gid);
    assert.strictEqual(config, null, 'nothing persisted on invalid action');
});

test('automodWordFlex: removeWord removes only the target word', () => {
    const { addWords, removeWord, getGuildConfig } = require('../../src/data/automodManager');
    const gid = 'test_guild_wflex_rm_' + Date.now();

    addWords(gid, 'kataa, kata b, katac', null, 'u');
    const r = removeWord(gid, 'Kata B'); // case-insensitive input
    assert.ok(r.ok);
    assert.strictEqual(r.removed, 'kata b');

    const config = getGuildConfig(gid);
    const words = config.wordRules.map(w => w.word);
    assert.deepStrictEqual(words, ['kataa', 'katac'], 'other words untouched');

    // Remove a word that does not exist → ok:false, error message
    const r2 = removeWord(gid, 'tidakada');
    assert.ok(!r2.ok);
});

test('automodWordFlex: matchWord whole-word does not match substrings', () => {
    const { matchWord } = require('../../src/data/automodManager');
    // whole_word: "asu" does NOT match "asus" (anti false-positive)
    assert.ok(matchWord('asu banget', 'asu', 'whole_word'));
    assert.ok(matchWord('kamu asu!', 'asu', 'whole_word'), 'punctuation counts as boundary');
    assert.ok(matchWord('ASU KAMU', 'asu', 'whole_word'), 'case-insensitive');
    assert.ok(matchWord('asu', 'asu', 'whole_word'), 'exact single word');
    assert.ok(!matchWord('asus bagus', 'asu', 'whole_word'), 'must NOT match inside asus');
    assert.ok(!matchWord('biasasaja', 'asu', 'whole_word'), 'must NOT match inside word');
    // substring mode: the old behavior
    assert.ok(matchWord('asus bagus', 'asu', 'substring'), 'substring mode matches inside word');
});

test('automodWordFlex: findViolatedWord returns per-word action', () => {
    const { addWords, getGuildConfig, findViolatedWord } = require('../../src/data/automodManager');
    const gid = 'test_guild_wflex_action_' + Date.now();

    addWords(gid, 'ringan', 'delete_only', 'u');
    addWords(gid, 'berat', 'mute_1h', 'u');
    addWords(gid, 'normal', null, 'u'); // fallback global

    const config = getGuildConfig(gid);

    const v1 = findViolatedWord('ini ringan banget', config);
    assert.strictEqual(v1.word, 'ringan');
    assert.strictEqual(v1.action, 'delete_only');

    const v2 = findViolatedWord('ini berat banget', config);
    assert.strictEqual(v2.action, 'mute_1h');

    // Word without a custom action → action null (caller falls back to config.wordAction)
    const v3 = findViolatedWord('ini normal banget', config);
    assert.strictEqual(v3.action, null);

    assert.strictEqual(findViolatedWord('pesan bersih', config), null);
});

test('automodWordFlex: exempt words cancel false-positive matches', () => {
    const {
        addWords,
        addExemptWords,
        getGuildConfig,
        findViolatedWord,
        removeExemptWord
    } = require('../../src/data/automodManager');
    const gid = 'test_guild_wflex_exempt_' + Date.now();

    // Substring mode: blocking "asu" would false-positive on "asus" — the exempt list saves it.
    addWords(gid, 'asu', null, 'u');
    setGuildModeSubstring(gid);

    // Without the exempt → "asus bagus" gets flagged (substring match)
    let config = getGuildConfig(gid);
    assert.ok(findViolatedWord('asus bagus', config), 'substring mode should flag asus');

    // Add exempt "asus" → messages containing asus are not flagged
    const r = addExemptWords(gid, 'asus');
    assert.deepStrictEqual(r.added, ['asus']);
    config = getGuildConfig(gid);
    assert.strictEqual(findViolatedWord('asus bagus', config), null, 'exempt word should cancel flag');
    // But standalone "asu" is still flagged
    assert.ok(findViolatedWord('asu banget', config), 'standalone blocked word still flagged');

    // Remove the exempt → the flag returns
    const rm = removeExemptWord(gid, 'asus');
    assert.ok(rm.ok);
    config = getGuildConfig(gid);
    assert.ok(findViolatedWord('asus bagus', config), 'flag returns after exempt removed');
});

test('automodWordFlex: legacy blockWords auto-migrate to wordRules', () => {
    const { setGuildConfig, getGuildConfig } = require('../../src/data/automodManager');
    const gid = 'test_guild_wflex_migrate_' + Date.now();

    // Simulate an old v3.9.22 config (flat blockWords array)
    setGuildConfig(gid, {
        blockWords: ['katalama1', 'KataLama2', 'katalama1'], // has a duplicate & different casing
        wordRules: undefined // make sure it starts empty (not the default [])
    });

    const config = getGuildConfig(gid);
    assert.ok(Array.isArray(config.wordRules), 'wordRules created after migration');
    const words = config.wordRules.map(r => r.word);
    assert.ok(words.includes('katalama1'), 'legacy word migrated');
    assert.ok(words.includes('katalama2'), 'legacy word lowercased during migration');
    assert.strictEqual(words.length, 2, 'duplicates deduped during migration');
    assert.strictEqual(config.blockWords.length, 0, 'legacy field cleared after migration');
    assert.strictEqual(config.wordMatchMode, 'whole_word', 'match mode defaulted');
});

test('automodWordFlex: setGuildConfig bulk replace via wordRules (pattern /set-automod block_words)', () => {
    const { addWords, setGuildConfig, getGuildConfig } = require('../../src/data/automodManager');
    const gid = 'test_guild_wflex_bulk_' + Date.now();

    addWords(gid, 'lama1, lama2', null, 'u');
    // Bulk replace — the same thing the /set-automod block_words handler does
    setGuildConfig(gid, {
        wordRules: [{ word: 'baru1', action: null, addedBy: 'u', addedAt: Date.now() }],
        blockWords: []
    });

    const config = getGuildConfig(gid);
    const words = config.wordRules.map(r => r.word);
    assert.deepStrictEqual(words, ['baru1'], 'bulk replace swaps entire list');
});

test('automodWordFlex: word with regex special chars matches safely', () => {
    const { matchWord, addWords, getGuildConfig, findViolatedWord } = require('../../src/data/automodManager');
    const gid = 'test_guild_wflex_regex_' + Date.now();

    // Word with regex special characters — must not crash or mismatch
    addWords(gid, 'a.b*c', null, 'u');
    const config = getGuildConfig(gid);

    assert.ok(matchWord('cek a.b*c dong', 'a.b*c', 'whole_word'), 'special chars word matches');
    assert.ok(!matchWord('cek aXbYc dong', 'a.b*c', 'whole_word'), 'regex chars must be escaped (literal match)');

    const v = findViolatedWord('pesan a.b*c di sini', config);
    assert.ok(v, 'findViolatedWord handles regex-special word');
    assert.strictEqual(v.word, 'a.b*c');
});

test('registry: /add-word /remove-word /list-words /remove-link-whitelist registered (v3.9.23)', () => {
    const { getCommands } = require('../../src/commands/registry');
    const commands = getCommands();

    const addWord = commands.find(c => c.name === 'add-word');
    assert.ok(addWord, 'add-word should be registered');
    const addOpts = addWord.options.map(o => o.name);
    assert.ok(addOpts.includes('words'));
    assert.ok(addOpts.includes('tipe'));
    assert.ok(addOpts.includes('action'));
    const tipeChoices = addWord.options.find(o => o.name === 'tipe').choices.map(c => c.value);
    assert.ok(tipeChoices.includes('blocklist'));
    assert.ok(tipeChoices.includes('exempt'));

    const removeWord = commands.find(c => c.name === 'remove-word');
    assert.ok(removeWord, 'remove-word should be registered');
    assert.ok(removeWord.options.map(o => o.name).includes('word'));

    assert.ok(
        commands.find(c => c.name === 'list-words'),
        'list-words should be registered'
    );

    const removeWL = commands.find(c => c.name === 'remove-link-whitelist');
    assert.ok(removeWL, 'remove-link-whitelist should be registered');
    assert.ok(removeWL.options.map(o => o.name).includes('channel'));
    assert.ok(removeWL.options.map(o => o.name).includes('role'));
});

test('router: automod domain routes new word commands (v3.9.23)', () => {
    // v3.9.24: check the mapping through the RUNTIME object exported by the router — not
    // by grepping source text (a grep still passes even if dispatch is broken).
    const routeCommand = require('../../src/commands');
    const map = routeCommand.COMMAND_TO_DOMAIN;
    for (const cmd of ['add-word', 'remove-word', 'list-words', 'remove-link-whitelist']) {
        assert.strictEqual(map[cmd], 'automod', `${cmd} should be mapped to automod domain`);
    }
    assert.ok(typeof routeCommand === 'function');
});

// ====================================================
// === v3.9.24: cleanup of test-guild residue from data files ===
// ====================================================
// Earlier automod/level/responder tests wrote test guild entries
// (test_guild_*, smoke_guild_*) into data/automod.json, levels.json, etc. and
// never cleaned them up — the production data files kept bloating every
// time npm test ran. This test removes all residue at the end of the run.
test('v3.9.24 cleanup: remove test-guild residue from data files', () => {
    const fs = require('fs');
    const path = require('path');
    const { safeWriteJSON } = require('../../src/infra/safeWrite');
    const dataDir = path.join(__dirname, '..', '..', 'data');
    const TEST_KEY_RE = /^(test_guild|smoke_guild)/;
    let totalRemoved = 0;

    for (const file of ['automod.json', 'levels.json', 'responders.json', 'afk.json', 'stats.json']) {
        const p = path.join(dataDir, file);
        if (!fs.existsSync(p)) continue;
        try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            // Structure must be a top-level keyed object (not an array) so scanning is safe.
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
                totalRemoved += removed;
            }
        } catch (_) {
            // Corrupt/oddly-shaped file — not this test's concern.
        }
    }
    // v3.9.26: the automod/afk/responders/levels managers now have a read-through
    // cache — the file was written directly via safeWriteJSON (bypassing the manager),
    // so the cache must be invalidated manually so the next test run doesn't read stale data.
    for (const mod of [
        '../../src/data/automodManager',
        '../../src/data/afkManager',
        '../../src/data/responderManager',
        '../../src/data/levelManager'
    ]) {
        try {
            const m = require(mod);
            if (typeof m.invalidateCache === 'function') m.invalidateCache();
        } catch (_) {}
    }
    // No count assertion (0 is fine if already clean) — what matters is that this run
    // doesn't leave NEW residue behind.
    assert.ok(true, `cleanup done (${totalRemoved} residue entries removed)`);
});

// Helper: set substring mode directly via setGuildConfig (internal type).
function setGuildModeSubstring(guildId) {
    const { setGuildConfig } = require('../../src/data/automodManager');
    setGuildConfig(guildId, { wordMatchMode: 'substring' });
}
