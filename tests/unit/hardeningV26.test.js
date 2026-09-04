/**
 * v3.9.26 HARDENING TESTS — regression tests for the single-guild audit fixes:
 *   1. isValidEmoji (anti poison config)
 *   2. claimGiveawayDismissed (anti category resurrection)
 *   3. v1→v2 migration preserves modern fields
 *   4. Corrupt file quarantine (quarantineCorruptFile)
 *   5. GC prune (giveaway/poll/announcement)
 *   6. Read-through cache + invalidateCache (automod/afk)
 *   7. /giveaway list & /poll list bounding
 *   8. /poll create question validation + /giveaway subcommand hint
 *   9. Panel patch contract (imageUrl/thumbnailUrl/footerText)
 *
 * Sandbox: snapshot/restore every data file touched (v3.9.24 pattern).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SANDBOX_FILES = [
    'config.json',
    'giveaways.json',
    'polls.json',
    'scheduledAnnouncements.json',
    'afk.json',
    'panels.json',
    'automod.json',
    'levels.json',
    'responders.json'
];

// --- sandbox setup/teardown ---
const snapshots = new Map();
for (const f of SANDBOX_FILES) {
    const p = path.join(DATA_DIR, f);
    snapshots.set(f, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
}

function restoreSandbox() {
    for (const [f, content] of snapshots) {
        const p = path.join(DATA_DIR, f);
        if (content === null) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } else {
            fs.writeFileSync(p, content);
        }
    }
}

function writeDataJSON(name, data) {
    fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2));
}

function readDataJSON(name) {
    const p = path.join(DATA_DIR, name);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function clearQuarantineArtifacts() {
    // Remove leftover .corrupt-* files from the quarantine test
    if (!fs.existsSync(DATA_DIR)) return;
    for (const f of fs.readdirSync(DATA_DIR)) {
        if (f.includes('.corrupt-')) {
            try {
                fs.unlinkSync(path.join(DATA_DIR, f));
            } catch (_) {}
        }
    }
}

const { isValidEmoji } = require('../../src/infra/text');
const { quarantineCorruptFile } = require('../../src/infra/safeWrite');

test('v3.9.26 isValidEmoji: accepts unicode & custom emoji', () => {
    assert.strictEqual(isValidEmoji('✅'), true);
    assert.strictEqual(isValidEmoji('🎫'), true);
    assert.strictEqual(isValidEmoji('👍🏽'), true); // skin tone modifier
    assert.strictEqual(isValidEmoji('<:coolname:123456789>'), true);
    assert.strictEqual(isValidEmoji('<a:anim:987654321>'), true);
    assert.strictEqual(isValidEmoji(':name:12345'), true);
});

test('v3.9.26 isValidEmoji: rejects strings that would poison setEmoji()', () => {
    assert.strictEqual(isValidEmoji('notanemoji'), false);
    assert.strictEqual(isValidEmoji('a'.repeat(200)), false);
    assert.strictEqual(isValidEmoji('hello world'), false);
    assert.strictEqual(isValidEmoji(''), false);
    assert.strictEqual(isValidEmoji(null), false);
    assert.strictEqual(isValidEmoji(42), false);
    // Pure ASCII digits are not emoji (even though they pass the non-printable check)
    assert.strictEqual(isValidEmoji('123'), false);
});

test('v3.9.26 claim_giveaway: dismissed flag prevents resurrection', () => {
    const { getConfig } = require('../../src/data/configManager');
    // Write a config WITHOUT claim_giveaway + WITH the dismissed flag
    writeDataJSON('config.json', {
        roles: { admin: 'r_admin' },
        ticketCategories: [
            { id: 'transaction', label: 'Beli Key', emoji: '🛒', style: 'Primary', requiresKey: true, isDefault: true },
            { id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false, isDefault: true }
        ],
        claimGiveawayDismissed: true,
        customFieldAdmin: 'jangan-hilang'
    });

    const config = getConfig();
    const ids = config.ticketCategories.map(c => c.id);
    assert.ok(!ids.includes('claim_giveaway'), 'claim_giveaway must NOT be re-added when dismissed');
    // Custom fields must be preserved
    assert.strictEqual(config.customFieldAdmin, 'jangan-hilang');
});

test('v3.9.26 claim_giveaway: without the flag, the migration still adds it (backward compat)', () => {
    const { getConfig } = require('../../src/data/configManager');
    writeDataJSON('config.json', {
        roles: { admin: 'r_admin' },
        ticketCategories: [
            { id: 'transaction', label: 'Beli Key', emoji: '🛒', style: 'Primary', requiresKey: true, isDefault: true }
        ]
        // claimGiveawayDismissed NOT set
    });
    const config = getConfig();
    const ids = config.ticketCategories.map(c => c.id);
    assert.ok(ids.includes('claim_giveaway'), 'without the flag, the sample category is still added (old behavior)');
});

test('v3.9.26 v1→v2 migration: modern fields are no longer DROPPED', () => {
    const { getConfig } = require('../../src/data/configManager');
    // MIXED config: leftover v1 flat keys + v2 modern fields — previously the
    // auto-save migration only wrote the 5 main keys → ticketCategories/leveling were lost from disk.
    writeDataJSON('config.json', {
        verifiedRoleId: 'r_verified_old',
        invoiceChannelId: 'c_invoice_old',
        roles: { admin: 'r_admin' },
        channels: {},
        messages: { welcomeTitle: 'Kustom' },
        ticketCategories: [
            { id: 'jasa', label: 'Jasa', emoji: '🛠️', style: 'Success', requiresKey: false, isDefault: false }
        ],
        leveling: { enabled: true, xpPerMessage: 25 },
        verifyButton: { label: 'Klik Aku', style: 'Danger' },
        customFieldAdmin: 'preserve-me'
    });

    const config = getConfig();
    // Flat v1 → moved into nested
    assert.strictEqual(config.roles.verified, 'r_verified_old');
    assert.strictEqual(config.channels.invoice, 'c_invoice_old');
    // Modern fields must be present in the merged result
    assert.strictEqual(config.leveling.enabled, true);
    assert.strictEqual(config.verifyButton.label, 'Klik Aku');
    assert.strictEqual(config.customFieldAdmin, 'preserve-me');
    const ids = config.ticketCategories.map(c => c.id);
    assert.ok(ids.includes('jasa'), 'custom ticketCategories must be preserved');

    // And what is saved to disk must be FREE of v1 flat keys (idempotent)
    const saved = readDataJSON('config.json');
    assert.strictEqual(saved.verifiedRoleId, undefined, 'v1 flat keys must be gone from disk after the migration');
    assert.ok(Array.isArray(saved.ticketCategories));
});

test('v3.9.26 quarantineCorruptFile: corrupt file is renamed, not overwritten', () => {
    const target = path.join(DATA_DIR, 'levels.json');
    writeDataJSON('levels.json', { 'g:u': { xp: 100 } });
    // Corrupt the file
    fs.writeFileSync(target, '{ ini bukan json valid !!!');

    // invalidate the cache first (levelManager caches for 15s)
    const levelManager = require('../../src/data/levelManager');
    levelManager.invalidateCache();

    // getUser → parse fails → quarantine → returns a default user (no crash)
    const user = levelManager.getUser('g_quar', 'u_quar');
    assert.ok(user && typeof user === 'object', 'getUser must return a default object, not throw');
    assert.strictEqual(user.xp, 0);

    // The corrupt file must have been renamed to .corrupt-<ts>
    const leftovers = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('levels.json.corrupt-'));
    assert.strictEqual(leftovers.length, 1, 'there must be exactly 1 quarantine file');
    assert.ok(fs.readFileSync(path.join(DATA_DIR, leftovers[0]), 'utf8').includes('ini bukan json'));
    // The original file is gone (the next save will rewrite it fresh)
    assert.strictEqual(fs.existsSync(target), false);

    // Rewrite it fresh so other managers (save) aren't confused
    writeDataJSON('levels.json', {});
    levelManager.invalidateCache();
});

test('v3.9.26 GC prune: giveaways ended >30 days ago are deleted, active & recent stay', () => {
    const { pruneEndedOlderThan, invalidateCacheNoop } = {
        pruneEndedOlderThan: require('../../src/data/giveawayManager').pruneEndedOlderThan,
        invalidateCacheNoop: null
    };
    const DAY = 86400000;
    const now = Date.now();
    writeDataJSON('giveaways.json', [
        {
            id: 'gw_old_ended',
            ended: true,
            endedAt: now - 40 * DAY,
            endsAt: now - 40 * DAY,
            winnerIds: [],
            participantIds: []
        },
        {
            id: 'gw_new_ended',
            ended: true,
            endedAt: now - 5 * DAY,
            endsAt: now - 5 * DAY,
            winnerIds: [],
            participantIds: []
        },
        { id: 'gw_active', ended: false, endsAt: now + 5 * DAY, winnerIds: [], participantIds: [] },
        { id: 'gw_old_active', ended: false, endsAt: now - 40 * DAY, winnerIds: [], participantIds: [] } // odd but active → must NOT be deleted
    ]);

    const removed = pruneEndedOlderThan(30 * DAY);
    assert.strictEqual(removed, 1, 'only gw_old_ended may be deleted');
    const remaining = readDataJSON('giveaways.json').map(g => g.id);
    assert.deepStrictEqual(remaining.sort(), ['gw_active', 'gw_new_ended', 'gw_old_active']);
});

test('v3.9.26 GC prune: polls closed >30 days ago are deleted', () => {
    const { pruneClosedOlderThan } = require('../../src/data/pollManager');
    const DAY = 86400000;
    const now = Date.now();
    writeDataJSON('polls.json', [
        { id: 'p_old', closed: true, closedAt: now - 40 * DAY, createdAt: now - 45 * DAY, options: [] },
        { id: 'p_new', closed: true, closedAt: now - 2 * DAY, createdAt: now - 10 * DAY, options: [] },
        { id: 'p_open', closed: false, createdAt: now - 1 * DAY, options: [] }
    ]);
    const removed = pruneClosedOlderThan(30 * DAY);
    assert.strictEqual(removed, 1);
    const remaining = readDataJSON('polls.json').map(p => p.id);
    assert.deepStrictEqual(remaining.sort(), ['p_new', 'p_open']);
});

test('v3.9.26 GC prune: announcements sent >30 days ago are deleted, pending stay', () => {
    const { pruneSentOlderThan } = require('../../src/data/scheduledAnnouncements');
    const DAY = 86400000;
    const now = Date.now();
    writeDataJSON('scheduledAnnouncements.json', [
        { id: 'a_old', sent: true, sentAt: now - 40 * DAY, sendAt: now - 40 * DAY },
        { id: 'a_recent', sent: true, sentAt: now - 3 * DAY, sendAt: now - 3 * DAY },
        { id: 'a_pending', sent: false, sendAt: now + DAY }
    ]);
    const removed = pruneSentOlderThan(30 * DAY);
    assert.strictEqual(removed, 1);
    const remaining = readDataJSON('scheduledAnnouncements.json').map(a => a.id);
    assert.deepStrictEqual(remaining.sort(), ['a_pending', 'a_recent']);
});

test('v3.9.26 cache: automod update-on-save — the next read sees the new data', () => {
    const automodManager = require('../../src/data/automodManager');
    automodManager.invalidateCache();
    const gid = `test_guild_v26_${Date.now()}`;

    automodManager.setGuildConfig(gid, { enabled: true, spamThreshold: 3 });
    // No sleep — the cache must already be in sync with the latest save (update-on-save)
    const cfg = automodManager.getGuildConfig(gid);
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.spamThreshold, 3);

    // invalidateCache → fresh read from disk
    automodManager.setGuildConfig(gid, { spamThreshold: 9 });
    automodManager.invalidateCache();
    const cfg2 = automodManager.getGuildConfig(gid);
    assert.strictEqual(cfg2.spamThreshold, 9);

    // Cleanup the test entry
    const data = readDataJSON('automod.json');
    delete data[gid];
    writeDataJSON('automod.json', data);
    automodManager.invalidateCache();
});

test('v3.9.26 cache: afkManager getAFKBatch — one load for all mentions', () => {
    const afkManager = require('../../src/data/afkManager');
    afkManager.invalidateCache();
    const gid = `test_guild_v26_afk_${Date.now()}`;

    afkManager.setAFK(gid, 'u1', 'Tidur');
    afkManager.setAFK(gid, 'u2', 'Makan');
    const batch = afkManager.getAFKBatch(gid, ['u1', 'u2', 'u3']);
    assert.strictEqual(Object.keys(batch).length, 2);
    assert.strictEqual(batch.u1.reason, 'Tidur');
    assert.strictEqual(batch.u2.reason, 'Makan');
    assert.strictEqual(batch.u3, undefined);

    // Cleanup
    afkManager.clearAFK(gid, 'u1');
    afkManager.clearAFK(gid, 'u2');
});

test('v3.9.26 /giveaway list: bounded to the 15 latest when there is a lot of data', async () => {
    const giveawayHandler = require('../../src/commands/giveaway');
    const DAY = 86400000;
    const now = Date.now();
    const gid = `test_guild_v26_gw_${Date.now()}`;
    const giveaways = [];
    for (let i = 0; i < 30; i++) {
        giveaways.push({
            id: `gw_list_${i}`,
            guildId: gid,
            channelId: 'c1',
            prize: `Prize ${i}`,
            winnersCount: 1,
            endsAt: now - i * DAY,
            ended: true,
            endedAt: now - i * DAY,
            winnerIds: ['u1'],
            participantIds: ['u1', 'u2'],
            hostId: 'h1',
            hostTag: 'Host'
        });
    }
    writeDataJSON('giveaways.json', giveaways);

    let replyPayload = null;
    const interaction = {
        commandName: 'giveaway',
        options: { getSubcommand: () => 'list', getString: () => null },
        guild: { id: gid },
        client: { user: { username: 'Thor', displayAvatarURL: () => 'https://x/a.png' } },
        user: { id: 'admin', tag: 'Admin' },
        deferReply: async () => {},
        editReply: async payload => {
            replyPayload = payload;
            return {};
        }
    };
    await giveawayHandler(interaction);

    assert.ok(replyPayload && replyPayload.embeds, 'must reply with an embed');
    const desc = replyPayload.embeds[0].data.description;
    assert.ok(desc.includes('Total **30** giveaway'), 'the header must mention the total');
    assert.ok(desc.includes('latest'), 'a bounding indicator must be present');
    assert.ok(desc.includes('15 latest'), 'displays the 15 latest');
    assert.ok(!desc.includes('gw_list_0'), 'the oldest entry (0) is hidden');
    assert.ok(desc.includes('gw_list_29'), 'the newest entry (29) is displayed');
    assert.ok(desc.length <= 4096, 'description must be within the Discord limit');
});

test('v3.9.26 bare /giveaway (no subcommand): usage hint, not a crash', async () => {
    const giveawayHandler = require('../../src/commands/giveaway');
    let replyPayload = null;
    const interaction = {
        commandName: 'giveaway',
        options: { getSubcommand: () => null, getString: () => null },
        guild: { id: 'g1' },
        client: { user: {} },
        user: { id: 'admin', tag: 'Admin' },
        reply: async payload => {
            replyPayload = payload;
            return {};
        }
    };
    await giveawayHandler(interaction);
    assert.ok(replyPayload, 'must reply with a hint');
    assert.ok(replyPayload.content.includes('subcommand'));
});

test('v3.9.26 /poll create: question > 250 chars rejected BEFORE modal/persist', async () => {
    const pollHandler = require('../../src/commands/poll');
    let replyPayload = null;
    let showModalCalled = false;
    const interaction = {
        commandName: 'poll',
        options: {
            getSubcommand: () => 'create',
            getChannel: () => ({ id: 'c1', type: 0 }),
            getString: name => (name === 'question' ? 'x'.repeat(300) : null),
            getBoolean: () => false
        },
        guild: { id: 'g1' },
        client: { user: {} },
        user: { id: 'admin', tag: 'Admin' },
        reply: async payload => {
            replyPayload = payload;
            return {};
        },
        showModal: async () => {
            showModalCalled = true;
        }
    };
    await pollHandler(interaction);
    assert.ok(replyPayload, 'must reply with a validation error');
    assert.ok(replyPayload.content.includes('250'));
    assert.strictEqual(showModalCalled, false, 'the modal must NOT open for invalid input');
});

test('v3.9.26 /poll create: voice channel rejected with a clear message', async () => {
    const pollHandler = require('../../src/commands/poll');
    let replyPayload = null;
    const interaction = {
        commandName: 'poll',
        options: {
            getSubcommand: () => 'create',
            getChannel: () => ({ id: 'c_voice', type: 2 }), // 2 = GuildVoice
            getString: name => (name === 'question' ? 'Pertanyaan valid?' : null),
            getBoolean: () => false
        },
        guild: { id: 'g1' },
        client: { user: {} },
        user: { id: 'admin', tag: 'Admin' },
        reply: async payload => {
            replyPayload = payload;
            return {};
        },
        showModal: async () => {}
    };
    await pollHandler(interaction);
    assert.ok(replyPayload.content.includes('text channel'));
});

test('v3.9.26 panel patch contract: imageUrl/thumbnailUrl/footerText reach the builder', () => {
    const panelManager = require('../../src/data/panelManager');
    const { buildTicketPanel } = require('../../src/commands/panels');
    panelManager.invalidateCache();

    const panelId = `tp_test_v26_${Date.now()}`;
    // Simulate /update-panel output AFTER the mapping fix: the patch uses storage keys
    panelManager.upsertPanel({
        id: panelId,
        guildId: 'g_test',
        channelId: 'c_test',
        messageId: 'm_test',
        title: 'Panel Test',
        categoryIds: ['transaction'],
        imageUrl: 'https://example.com/img.png',
        thumbnailUrl: 'https://example.com/thumb.png',
        footerText: 'Footer Kustom',
        createdAt: Date.now()
    });
    const patched = panelManager.patchPanel(panelId, { imageUrl: 'https://example.com/new.png' });
    assert.strictEqual(
        patched.imageUrl,
        'https://example.com/new.png',
        'patch imageUrl must be saved under the correct key'
    );

    // The builder must LOAD the same value (this was the v3.9.26 bug: the old patch
    // wrote `image` but the builder read `imageUrl` → a silent no-op)
    const built = buildTicketPanel(patched, {
        guild: { name: 'Test Guild', members: { me: { id: 'bot' } } },
        client: { user: { username: 'Thor', displayAvatarURL: () => 'https://example.com/a.png' } }
    });
    // buildTicketPanel returns { embed, components } (not an EmbedBuilder directly)
    const embedData = built.embed.data;
    assert.strictEqual(embedData.image.url, 'https://example.com/new.png');
    assert.strictEqual(embedData.thumbnail.url, 'https://example.com/thumb.png');
    assert.strictEqual(embedData.footer.text, 'Footer Kustom');

    // Cleanup
    panelManager.deletePanel(panelId);
    panelManager.invalidateCache();
});

// --- global teardown: restore all files + discard quarantine artifacts ---
test('v3.9.26 teardown: restore sandbox', () => {
    restoreSandbox();
    clearQuarantineArtifacts();
    assert.ok(true);
});
