/**
 * Unit tests v3.9.30 — MERGING /set-transcript-channel INTO /set-channel.
 *
 * User request: "/set-transcript-channel should be merged into /set-channel so it's
 * less confusing" — admins no longer need to remember two similar channel commands.
 *
 * What this test proves:
 *   1. Registry: the separate /set-transcript-channel command is REALLY gone
 *      (total commands 81 → 80) and no routing mapping is left dangling.
 *   2. Registry: /set-channel tipe now has a 'transcript' choice;
 *      /remove-channel too (so it can be removed with the same pattern).
 *   3. Handler: /set-channel tipe:transcript writes to the same key that
 *      ticketManager.saveTranscript reads — config.channels.transcript —
 *      behavior identical to the former separate command (key roundtrip).
 *   4. Handler: non-text channels (voice/category) are rejected — guard moved
 *      from the old handler, now applies to ALL channel config types.
 *   5. Handler: other types (invoice/welcome/...) keep working exactly like
 *      before (regression guard) — without the transcript tip.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const configPath = path.join(DATA_DIR, 'config.json');

// ====================================================
// === Sandbox: snapshot & restore config.json       ===
// === (newCategorySafety.test.js pattern)           ===
// ====================================================
const SANDBOX_FILES = ['config.json'];
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

/** Controlled config: no audit-log → logAudit silently skips. */
function writeTestConfig() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
        configPath,
        JSON.stringify(
            {
                roles: {},
                channels: {},
                messages: {},
                products: [],
                ticketCategories: []
            },
            null,
            2
        )
    );
}

/** Discord channel mock. Default: text channel (type GuildText). */
function makeChannel({ id = '111', name = 'transcript-log', type = ChannelType.GuildText } = {}) {
    return {
        id,
        name,
        type,
        toString: () => `<#${id}>`
    };
}

/** Interaction mock for the config domain handler (/set-channel). */
function makeSetChannelInteraction({ tipe, channel }) {
    const replies = [];
    return {
        isChatInputCommand: () => true,
        commandName: 'set-channel',
        replied: false,
        deferred: false,
        member: { permissions: { has: () => true }, roles: { cache: { has: () => false } } },
        user: { id: 'admin_test', tag: 'admin#0001' },
        guild: { id: 'guild_test' },
        client: { channels: { cache: new Map() } },
        options: {
            getString: name => (name === 'tipe' ? tipe : null),
            getChannel: name => (name === 'channel' ? channel : null)
        },
        deferReply: async () => {
            replies.push({ type: 'defer', opts: {} });
            return {};
        },
        editReply: async opts => {
            replies.push({ type: 'editReply', opts });
            return {};
        },
        reply: async opts => {
            replies.push({ type: 'reply', opts });
            return {};
        },
        _replies: replies
    };
}

// ====================================================
// === 1. Registry — old command gone, new choice present ===
// ====================================================

test('registry: /set-transcript-channel is NO LONGER registered (merged into /set-channel)', () => {
    const { getCommands } = require('../../src/commands/registry');
    const names = getCommands().map(c => c.name);
    assert.ok(!names.includes('set-transcript-channel'), 'the old command must be gone from the registry');
});

test('registry: total commands exactly 88 (82 + 6 moderation v3.9.43)', () => {
    const { getCommands } = require('../../src/commands/registry');
    assert.strictEqual(getCommands().length, 88);
});

test('registry: /set-channel has the "transcript" tipe choice + description mentions transcript', () => {
    const { getCommands } = require('../../src/commands/registry');
    const cmd = getCommands().find(c => c.name === 'set-channel');
    assert.ok(cmd, 'set-channel must be registered');
    assert.ok(/transcript/i.test(cmd.description), 'the root description must mention transcript');
    const tipe = cmd.options.find(o => o.name === 'tipe');
    assert.ok(tipe, 'set-channel must have a tipe option');
    const values = tipe.choices.map(c => c.value);
    for (const v of ['invoice', 'welcome', 'goodbye', 'audit-log', 'transcript']) {
        assert.ok(values.includes(v), `choice "${v}" must still exist`);
    }
});

test('registry: /remove-channel also has the "transcript" choice (consistent removal pattern)', () => {
    const { getCommands } = require('../../src/commands/registry');
    const cmd = getCommands().find(c => c.name === 'remove-channel');
    assert.ok(cmd, 'remove-channel must be registered');
    const tipe = cmd.options.find(o => o.name === 'tipe');
    const values = tipe.choices.map(c => c.value);
    assert.ok(values.includes('transcript'), 'remove-channel must be able to remove transcript');
});

test('router: /set-transcript-channel is no longer mapped — replies "not supported"', async () => {
    const routeCommand = require('../../src/commands');
    const replies = [];
    const interaction = {
        isChatInputCommand: () => true,
        commandName: 'set-transcript-channel',
        isRepliable: () => true,
        replied: false,
        deferred: false,
        member: { permissions: { has: () => true }, roles: { cache: { has: () => false } } },
        reply: async opts => {
            replies.push({ type: 'reply', opts });
            return {};
        },
        editReply: async opts => {
            replies.push({ type: 'editReply', opts });
            return {};
        },
        _replies: replies
    };
    await routeCommand(interaction);
    assert.strictEqual(replies.length, 1);
    assert.match(replies[0].opts.content, /not supported by the router/i);
});

// ====================================================
// === 2. /set-channel handler — transcript behavior ===
// ====================================================

test('handler: /set-channel tipe:transcript → config.channels.transcript filled + special tip', async () => {
    writeTestConfig();
    const { getConfig } = require('../../src/data/configManager');
    const configHandler = require('../../src/commands/config');

    const ch = makeChannel({ id: '999', name: 'transcript-log' });
    const interaction = makeSetChannelInteraction({ tipe: 'transcript', channel: ch });
    await configHandler(interaction);

    assert.strictEqual(getConfig().channels.transcript, '999', 'must write the channels.transcript key');
    const last = interaction._replies[interaction._replies.length - 1];
    assert.match(last.opts.content, /✅/);
    assert.match(last.opts.content, /transcript/i);
    assert.match(last.opts.content, /auto-save/i, 'the transcript-specific tip must appear');
});

test('handler: the key written = the key saveTranscript reads (data key roundtrip)', () => {
    writeTestConfig();
    const { getConfig } = require('../../src/data/configManager');
    const config = getConfig();
    // ticketManager.js reads: config.channels?.transcript (saveTranscript).
    // This test locks the contract: the key the handler writes == the key the runtime reads.
    assert.ok('transcript' in config.channels === false, 'start: empty');
    const ch = makeChannel({ id: '777' });
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'data', 'ticketManager.js'), 'utf8');
    assert.match(src, /config\.channels\?\.transcript/, 'ticketManager must read channels.transcript');
    // Write via the handler, then make sure it is exactly the same key the runtime reads.
    return require('../../src/commands/config')(makeSetChannelInteraction({ tipe: 'transcript', channel: ch })).then(
        () => {
            assert.strictEqual(getConfig().channels.transcript, '777');
        }
    );
});

test('handler: /set-channel tipe:transcript with a VOICE channel → rejected, config unchanged', async () => {
    writeTestConfig();
    const { getConfig } = require('../../src/data/configManager');
    const configHandler = require('../../src/commands/config');

    const voice = makeChannel({ id: '555', name: 'General Voice', type: ChannelType.GuildVoice });
    const interaction = makeSetChannelInteraction({ tipe: 'transcript', channel: voice });
    await configHandler(interaction);

    assert.strictEqual(getConfig().channels.transcript, undefined, 'must not be saved');
    const last = interaction._replies[interaction._replies.length - 1];
    assert.match(last.opts.content, /must be a text channel/i);
});

test('handler: /set-channel tipe:invoice still normal — without the transcript tip (regression)', async () => {
    writeTestConfig();
    const { getConfig } = require('../../src/data/configManager');
    const configHandler = require('../../src/commands/config');

    const ch = makeChannel({ id: '321', name: 'testimoni' });
    const interaction = makeSetChannelInteraction({ tipe: 'invoice', channel: ch });
    await configHandler(interaction);

    assert.strictEqual(getConfig().channels.invoice, '321');
    const last = interaction._replies[interaction._replies.length - 1];
    assert.match(last.opts.content, /✅/);
    assert.ok(!/auto-save/i.test(last.opts.content), 'the transcript tip must NOT appear for other types');
});

// ====================================================
// === 3. /remove-channel — transcript can be removed ===
// ====================================================

test('handler: /remove-channel tipe:transcript → key removed from config', async () => {
    writeTestConfig();
    const { getConfig, saveConfig } = require('../../src/data/configManager');
    const config = getConfig();
    config.channels.transcript = '888';
    saveConfig(config);

    const configHandler = require('../../src/commands/config');
    const replies = [];
    const interaction = {
        isChatInputCommand: () => true,
        commandName: 'remove-channel',
        replied: false,
        deferred: false,
        member: { permissions: { has: () => true }, roles: { cache: { has: () => false } } },
        user: { id: 'admin_test', tag: 'admin#0001' },
        guild: { id: 'guild_test' },
        client: { channels: { cache: new Map() } },
        options: {
            getString: name => (name === 'tipe' ? 'transcript' : null)
        },
        deferReply: async () => {
            replies.push({ type: 'defer', opts: {} });
            return {};
        },
        editReply: async opts => {
            replies.push({ type: 'editReply', opts });
            return {};
        },
        reply: async opts => {
            replies.push({ type: 'reply', opts });
            return {};
        },
        _replies: replies
    };
    await configHandler(interaction);

    assert.strictEqual(getConfig().channels.transcript, undefined, 'the transcript key must be removed');
    const last = replies[replies.length - 1];
    assert.match(last.opts.content, /removed from config/i);
    assert.match(last.opts.content, /\/set-channel transcript/);
});
