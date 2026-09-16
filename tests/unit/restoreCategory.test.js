/**
 * Unit tests v3.24.3 — /restore-category (the Discord-side twin of the
 * dashboard's "Restore" menu).
 *
 * Proven here:
 *   1. Registry contract: /restore-category is registered with the 6 choices
 *      (5 factory categories + all), admin-gated (ManageGuild), and routed
 *      to the categories domain.
 *   2. Restoring a deleted built-in (midman / claim_giveaway) re-adds it with
 *      the EXACT factory definition and CLEARS the dismissal flag — so
 *      getConfig()'s migration keeps it on a cold re-read (no resurrection
 *      bug in either direction: delete stays deleted, restore stays restored).
 *   3. /restore-category id:all restores every missing built-in at once.
 *   4. Edge cases: already-present → info, custom id → clear error,
 *      25-category limit → refused.
 *   5. getBuiltInCategories() always mirrors DEFAULTS.ticketCategories
 *      (the web dashboard's DEFAULT_CATEGORIES is a hand-kept copy of the
 *      same list — this test pins the source of truth).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const configPath = path.join(DATA_DIR, 'config', 'guild_test.json');

// ====================================================
// === Sandbox: snapshot & restore the guild config ===
// ====================================================
const SANDBOX_FILES = ['config/guild_test.json'];
const backups = new Map();
for (const f of SANDBOX_FILES) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) {
        fs.copyFileSync(p, p + '.test-backup');
        backups.set(f, true);
    }
}
process.on('exit', () => {
    for (const f of SANDBOX_FILES) {
        const p = path.join(DATA_DIR, f);
        try {
            if (backups.has(f)) {
                fs.copyFileSync(p + '.test-backup', p);
                fs.rmSync(p + '.test-backup', { force: true });
            } else if (fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
        } catch (_) {}
    }
});

function writeTestConfig(cfg) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

const { getConfig, saveConfig, getBuiltInCategories, DEFAULTS } = require('../../src/data/configManager');
const categoriesHandler = require('../../src/commands/categories');

/** A minimal base config with ALL built-in categories deleted (dismissed). */
function baseConfigAllDeleted() {
    return {
        welcome: { message: 'hi', channelId: null, image: null },
        goodbye: { message: 'bye', channelId: null, image: null },
        ticketCategories: [{ id: 'jasa', label: 'Jasa', emoji: '🛠️', style: 'Primary', requiresKey: false, isDefault: false }],
        products: [],
        claimGiveawayDismissed: true,
        midmanCategoryDismissed: true,
        channels: {}
    };
}

function makeRestoreInteraction(id) {
    const replies = [];
    return {
        isChatInputCommand: () => true,
        commandName: 'restore-category',
        replied: false,
        deferred: false,
        member: { permissions: { has: () => true }, roles: { cache: { has: () => false } } },
        user: { id: 'admin_test', tag: 'admin#0001' },
        guild: { id: 'guild_test' },
        client: { channels: { cache: new Map() } },
        options: {
            getString: (name) => (name === 'id' ? id : null),
            getBoolean: () => null
        },
        deferReply: async () => {
            replies.push({ type: 'defer' });
            return {};
        },
        editReply: async (opts) => {
            replies.push({ type: 'editReply', opts });
            return {};
        },
        followUp: async (opts) => {
            replies.push({ type: 'followUp', opts });
            return {};
        },
        reply: async (opts) => {
            replies.push({ type: 'reply', opts });
            return {};
        },
        _replies: replies
    };
}

function lastReply(interaction) {
    assert.ok(interaction._replies.length > 0, 'the handler must reply');
    const last = interaction._replies[interaction._replies.length - 1];
    return last.opts.content || '';
}

// ====================================================
// === 1. Registry + router contracts ===
// ====================================================

test('restore-category: registry contract — registered, admin-gated, 6 choices (5 built-ins + all)', () => {
    const { getCommands } = require('../../src/commands/registry');
    const cmd = getCommands().find((c) => c.name === 'restore-category');
    assert.ok(cmd, '/restore-category must be registered');
    assert.ok(cmd.defaultMemberPermissions, 'admin-gated (ManageGuild)');
    const idOpt = cmd.options.find((o) => o.name === 'id');
    assert.ok(idOpt, 'has the id option');
    const values = idOpt.choices.map((c) => c.value).sort();
    assert.deepStrictEqual(values, ['all', 'claim_giveaway', 'help', 'midman', 'report', 'transaction']);
});

test('restore-category: router contract — mapped to the categories domain', () => {
    const { COMMAND_TO_DOMAIN } = require('../../src/commands/index');
    assert.strictEqual(COMMAND_TO_DOMAIN['restore-category'], 'categories');
});

test('getBuiltInCategories: mirrors DEFAULTS.ticketCategories exactly (id/emoji/label/style/requiresKey)', () => {
    const builtIns = getBuiltInCategories();
    assert.deepStrictEqual(builtIns, DEFAULTS.ticketCategories, 'the export is the factory list');
    const ids = builtIns.map((c) => c.id).sort();
    assert.deepStrictEqual(ids, ['claim_giveaway', 'help', 'midman', 'report', 'transaction']);
    // Defensive: mutating the returned clone must NOT poison DEFAULTS.
    builtIns[0].label = 'POISON';
    assert.notStrictEqual(getBuiltInCategories()[0].label, 'POISON');
});

// ====================================================
// === 2. Single restore — exact factory definition + flag cleared ===
// ====================================================

test('restore-category id:midman — re-added exactly as shipped + midmanCategoryDismissed cleared', async () => {
    writeTestConfig(baseConfigAllDeleted());
    const interaction = makeRestoreInteraction('midman');
    await categoriesHandler(interaction);

    const reply = lastReply(interaction);
    assert.match(reply, /Midman \/ Escrow/);
    assert.match(reply, /restored/i);

    const cfg = getConfig('guild_test');
    const midman = (cfg.ticketCategories || []).find((c) => c.id === 'midman');
    assert.ok(midman, 'midman is back in the list');
    assert.strictEqual(midman.label, 'Midman / Escrow');
    assert.strictEqual(midman.emoji, '🤝');
    assert.strictEqual(midman.style, 'Success');
    assert.strictEqual(midman.requiresKey, false);
    assert.strictEqual(cfg.midmanCategoryDismissed, undefined, 'dismissal flag cleared');

    // The custom category that existed before is untouched.
    assert.ok(cfg.ticketCategories.some((c) => c.id === 'jasa'), 'existing custom category untouched');
});

test('restore-category id:claim_giveaway — flag cleared, survives a cold re-read (no see-saw)', async () => {
    writeTestConfig(baseConfigAllDeleted());
    await categoriesHandler(makeRestoreInteraction('claim_giveaway'));

    let cfg = getConfig('guild_test');
    assert.ok(cfg.ticketCategories.some((c) => c.id === 'claim_giveaway'));
    assert.strictEqual(cfg.claimGiveawayDismissed, undefined);

    // Cold re-read: the migration in getConfig() must neither remove the
    // restored category nor re-add anything else (midman stays dismissed).
    cfg = getConfig('guild_test');
    assert.ok(cfg.ticketCategories.some((c) => c.id === 'claim_giveaway'), 'still there on re-read');
    assert.ok(!cfg.ticketCategories.some((c) => c.id === 'midman'), 'dismissed midman does NOT come back');
    assert.strictEqual(cfg.ticketCategories.filter((c) => c.id === 'claim_giveaway').length, 1, 'no duplicate');
});

// ====================================================
// === 3. id:all — every missing built-in at once ===
// ====================================================

test('restore-category id:all — restores every missing built-in + clears both flags', async () => {
    writeTestConfig(baseConfigAllDeleted());
    const interaction = makeRestoreInteraction('all');
    await categoriesHandler(interaction);

    const reply = lastReply(interaction);
    assert.match(reply, /5 built-in categories/);

    const cfg = getConfig('guild_test');
    const ids = (cfg.ticketCategories || []).map((c) => c.id);
    for (const id of ['transaction', 'help', 'report', 'claim_giveaway', 'midman']) {
        assert.ok(ids.includes(id), `${id} restored`);
        assert.strictEqual(cfg.ticketCategories.filter((c) => c.id === id).length, 1, `${id} exactly once`);
    }
    assert.ok(ids.includes('jasa'), 'existing custom category untouched');
    assert.strictEqual(cfg.claimGiveawayDismissed, undefined);
    assert.strictEqual(cfg.midmanCategoryDismissed, undefined);
});

test('restore-category id:all with nothing missing — info reply, config untouched', async () => {
    writeTestConfig(baseConfigAllDeleted());
    // First restore all, then run all again.
    await categoriesHandler(makeRestoreInteraction('all'));
    const before = JSON.stringify(getConfig('guild_test'));
    const interaction = makeRestoreInteraction('all');
    await categoriesHandler(interaction);
    assert.match(lastReply(interaction), /nothing to restore/i);
    const after = JSON.stringify(getConfig('guild_test'));
    assert.strictEqual(before, after, 'config not rewritten');
});

// ====================================================
// === 4. Edge cases ===
// ====================================================

test('restore-category: already-present built-in — info, no duplicate, no flag change', async () => {
    writeTestConfig(baseConfigAllDeleted());
    await categoriesHandler(makeRestoreInteraction('midman'));
    const interaction = makeRestoreInteraction('midman');
    await categoriesHandler(interaction);
    assert.match(lastReply(interaction), /already exists/i);
    const cfg = getConfig('guild_test');
    assert.strictEqual(cfg.ticketCategories.filter((c) => c.id === 'midman').length, 1);
});

test('restore-category: a custom id is rejected with a clear message (only built-ins restorable)', async () => {
    writeTestConfig(baseConfigAllDeleted());
    const interaction = makeRestoreInteraction('akun_ml');
    await categoriesHandler(interaction);
    assert.match(lastReply(interaction), /not a built-in category/i);
    const cfg = getConfig('guild_test');
    assert.ok(!cfg.ticketCategories.some((c) => c.id === 'akun_ml'), 'nothing was added');
});

test('restore-category: 25-category limit refused', async () => {
    const cfg = baseConfigAllDeleted();
    cfg.ticketCategories = Array.from({ length: 25 }, (_, i) => ({
        id: `custom${i}`,
        label: `Custom ${i}`,
        emoji: '🎫',
        style: 'Primary',
        requiresKey: false,
        isDefault: false
    }));
    writeTestConfig(cfg);
    const interaction = makeRestoreInteraction('midman');
    await categoriesHandler(interaction);
    assert.match(lastReply(interaction), /25/);
    const after = getConfig('guild_test');
    assert.strictEqual(after.ticketCategories.length, 25, 'nothing was added');
});
