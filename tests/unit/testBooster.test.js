/**
 * Unit tests for v3.9.58 — /test-booster (the boost feature's /test-welcome).
 *
 * User request: "command test booster". Admins cannot simulate a real boost
 * (it costs real money), so /test-booster proves the whole notification chain
 * works: config → channel exists → bot permissions, plus a LIVE PREVIEW of
 * the exact embed a real boost sends (the SAME builders the live event uses).
 *
 * What v3.9.58 adds (all covered here):
 *   1. Registry: /test-booster with tipe:add|remove choices + optional
 *      `live` boolean, admin-gated (ManageGuild).
 *   2. Router: 'test-booster' → stats domain.
 *   3. The command (real stats.js module, stubbed interaction):
 *      - all-healthy → ✅ diagnostics + pink NEW SERVER BOOST preview in the
 *        CURRENT channel (with the <@mention> content, like the real one);
 *      - tipe:remove → gray BOOST ENDED embed, no mention;
 *      - channel not set / ghost ID / missing permissions → the reply names
 *        the problem AND the fix command (v3.9.48 diagnosability pattern);
 *      - live:true → ALSO delivers to the REAL server-booster channel;
 *        live:true with no channel → skipped with a clear reason;
 *   4. PURE SIMULATION: boosts.json must stay byte-identical — no history
 *      entries, no server-log writes (the data layer is never touched).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// v3.10.0: per-guild config — the /test-booster mock uses guild 'guild_tb'.
const configPath = path.join(DATA_DIR, 'config', 'guild_tb.json');
const boostsPath = path.join(DATA_DIR, 'boosts.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ====================================================
// === Sandbox: snapshot & restore config.json AND    ===
// === boosts.json (purity is the whole point here)   ===
// ====================================================
const backups = [
    { path: configPath, had: fs.existsSync(configPath) },
    { path: boostsPath, had: fs.existsSync(boostsPath) }
];
for (const b of backups) {
    if (b.had) fs.copyFileSync(b.path, b.path + '.test-backup');
}
process.on('exit', () => {
    for (const b of backups) {
        try {
            if (b.had) {
                fs.copyFileSync(b.path + '.test-backup', b.path);
                fs.rmSync(b.path + '.test-backup', { force: true });
            } else if (fs.existsSync(b.path)) {
                fs.rmSync(b.path, { force: true });
            }
        } catch (_) {}
    }
});

// ====================================================
// === Helpers                                       ===
// ====================================================

/** Write the mock guild config — v3.10.0: per-guild path. */
function writeConfig(channels = {}) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ channels, roles: {}, messages: {} }, null, 4));
}

/** Current boosts.json bytes (for the purity assertions). */
function boostsSnapshot() {
    return fs.existsSync(boostsPath) ? fs.readFileSync(boostsPath, 'utf8') : null;
}

/** Stub channel that records everything sent to it. */
function makeChannel(id, { fail } = {}) {
    const sent = [];
    return {
        id,
        name: `chan-${id}`,
        sent,
        send: async payload => {
            if (fail) throw new Error(fail);
            sent.push(payload);
            return { id: `msg_${id}_${sent.length}` };
        }
    };
}

/**
 * Interaction stub shaped for src/commands/stats.js (/test-booster path).
 * `configChannels['server-booster']` simulates the configured channel being
 * present in the guild cache (only then does the diagnostic find it).
 */
function makeTestBoosterInteraction({ tipe = 'add', live = null, configChannels = {}, perms = {} } = {}) {
    const boosterCh = makeChannel('ch_sb');
    const currentCh = makeChannel('ch_cur');
    const me = { id: 'bot_me' };
    boosterCh.permissionsFor = () => ({
        has: bit => {
            const { PermissionFlagsBits } = require('discord.js');
            if (bit === PermissionFlagsBits.SendMessages) return perms.send !== false;
            if (bit === PermissionFlagsBits.EmbedLinks) return perms.embed !== false;
            if (bit === PermissionFlagsBits.ViewChannel) return perms.view !== false;
            return true;
        }
    });

    const cache = new Map();
    cache.set('ch_cur', currentCh);
    if (configChannels['server-booster']) cache.set('ch_sb', boosterCh); // only cached when the ID matches

    const guild = {
        id: 'guild_tb',
        name: 'TestServer',
        iconURL: () => null,
        premiumTier: 1,
        premiumSubscriptionCount: 3,
        channels: { cache },
        members: { me }
    };
    const member = {
        guild,
        premiumSinceTimestamp: null,
        user: {
            id: 'user_admin',
            bot: false,
            tag: 'Admin#0001',
            displayAvatarURL: () => 'https://cdn.example/avatar.png'
        }
    };

    const replies = [];
    const interaction = {
        commandName: 'test-booster',
        client: {},
        deferReply: async () => {},
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        guild,
        member,
        user: member.user,
        channel: currentCh,
        options: { getString: () => tipe, getBoolean: () => live }
    };
    interaction.__replies = replies;
    interaction.__currentChannel = currentCh;
    interaction.__boosterChannel = boosterCh;
    return interaction;
}

// ====================================================
// === 1. Registry + router contracts                ===
// ====================================================

test('registry contract: /test-booster exists with add|remove choices + ManageGuild + optional live', () => {
    const { getCommands } = require('../../src/commands/registry');
    const cmd = getCommands().find(c => c.name === 'test-booster');
    assert.ok(cmd, 'command registered');
    assert.ok(cmd.defaultMemberPermissions, 'admin-gated');
    const tipe = cmd.options.find(o => o.name === 'tipe');
    assert.ok(tipe.required, 'tipe is required');
    assert.deepStrictEqual(
        tipe.choices.map(c => c.value).sort(),
        ['add', 'remove']
    );
    const live = cmd.options.find(o => o.name === 'live');
    assert.ok(live, 'live option exists');
    assert.strictEqual(live.type, 5, 'live is a boolean');
    assert.ok(!live.required, 'live is optional (default: preview only)');
});

test('router contract: test-booster routes to the stats domain', () => {
    const { COMMAND_TO_DOMAIN } = require('../../src/commands/index');
    assert.strictEqual(COMMAND_TO_DOMAIN['test-booster'], 'stats');
});

// ====================================================
// === 2. The command — diagnostics + live preview   ===
// ====================================================

test('/test-booster (add, all healthy): ✅ diagnostics + pink preview in the current channel', async () => {
    writeConfig({ 'server-booster': 'ch_sb' });
    const interaction = makeTestBoosterInteraction({ tipe: 'add', configChannels: { 'server-booster': 'ch_sb' } });
    const before = boostsSnapshot();

    await require('../../src/commands/stats')(interaction);

    assert.strictEqual(interaction.__replies.length, 1, 'exactly one ephemeral reply');
    const reply = interaction.__replies[0].content;
    assert.match(reply, /server-booster channel:/);
    assert.match(reply, /✅ Send Messages · ✅ Embed Links/);
    assert.match(reply, /GuildMembers intent/);
    assert.match(reply, /Simulation only/);

    // The preview: the EXACT embed a real boost add sends.
    assert.strictEqual(interaction.__currentChannel.sent.length, 1, 'preview embed sent');
    assert.strictEqual(interaction.__currentChannel.sent[0].content, '<@user_admin>', 'mention content like the real one');
    const embed = interaction.__currentChannel.sent[0].embeds[0];
    assert.match(embed.data.title, /NEW SERVER BOOST/);
    assert.strictEqual(embed.data.color, 0xf472b6, 'boost pink');
    assert.match(reply, /Preview sent/);

    // No live delivery without live:true.
    assert.strictEqual(interaction.__boosterChannel.sent.length, 0, 'real channel untouched by default');
    // PURE SIMULATION — the history file is byte-identical.
    assert.strictEqual(boostsSnapshot(), before, 'boosts.json untouched');
});

test('/test-booster tipe:remove — gray BOOST ENDED embed, no mention content', async () => {
    writeConfig({ 'server-booster': 'ch_sb' });
    const interaction = makeTestBoosterInteraction({ tipe: 'remove', configChannels: { 'server-booster': 'ch_sb' } });
    const before = boostsSnapshot();

    await require('../../src/commands/stats')(interaction);

    assert.strictEqual(interaction.__currentChannel.sent.length, 1, 'preview embed sent');
    assert.strictEqual(interaction.__currentChannel.sent[0].content, undefined, 'no mention on remove');
    const embed = interaction.__currentChannel.sent[0].embeds[0];
    assert.match(embed.data.title, /BOOST ENDED/);
    assert.strictEqual(embed.data.color, 0x95a5a6, 'boost gray');
    assert.match(embed.data.description, /no longer boosting/);
    assert.strictEqual(boostsSnapshot(), before, 'boosts.json untouched');
});

test('/test-booster (server-booster channel NOT set): the reply names the fix command; preview still sent', async () => {
    writeConfig({}); // nothing set
    const interaction = makeTestBoosterInteraction({ tipe: 'add', configChannels: {} });

    await require('../../src/commands/stats')(interaction);

    const reply = interaction.__replies[0].content;
    assert.match(reply, /not set/);
    assert.match(reply, /\/set-channel server-booster #channel/);
    // The preview still sends — the admin sees the embed format.
    assert.strictEqual(interaction.__currentChannel.sent.length, 1, 'preview still sent');
});

test('/test-booster (channel ID unknown): reply explains deleted / other-server', async () => {
    writeConfig({ 'server-booster': 'ch_ghost' });
    const interaction = makeTestBoosterInteraction({ tipe: 'add', configChannels: {} }); // ghost → not cached

    await require('../../src/commands/stats')(interaction);

    const reply = interaction.__replies[0].content;
    assert.match(reply, /not found/);
    assert.match(reply, /ch_ghost/);
    assert.match(reply, /\/set-channel server-booster #channel/);
});

test('/test-booster (bot lacks Send Messages): the permission line flips to ❌ + fix hint', async () => {
    writeConfig({ 'server-booster': 'ch_sb' });
    const interaction = makeTestBoosterInteraction({
        tipe: 'add',
        configChannels: { 'server-booster': 'ch_sb' },
        perms: { send: false }
    });

    await require('../../src/commands/stats')(interaction);

    const reply = interaction.__replies[0].content;
    assert.match(reply, /❌ Send Messages/);
    assert.match(reply, /enable \*\*Send Messages\*\*/);
});

// ====================================================
// === 3. live:true — the end-to-end delivery test   ===
// ====================================================

test('/test-booster live:true (healthy): preview ALSO delivered to the REAL server-booster channel', async () => {
    writeConfig({ 'server-booster': 'ch_sb' });
    const interaction = makeTestBoosterInteraction({
        tipe: 'add',
        live: true,
        configChannels: { 'server-booster': 'ch_sb' }
    });
    const before = boostsSnapshot();

    await require('../../src/commands/stats')(interaction);

    assert.strictEqual(interaction.__currentChannel.sent.length, 1, 'preview in the current channel');
    assert.strictEqual(interaction.__boosterChannel.sent.length, 1, 'ALSO delivered to the real channel');
    assert.match(interaction.__boosterChannel.sent[0].embeds[0].data.title, /NEW SERVER BOOST/);
    assert.match(interaction.__replies[0].content, /Live delivery: ✅/);
    // Still a simulation — no history entry.
    assert.strictEqual(boostsSnapshot(), before, 'boosts.json untouched even with live delivery');
});

test('/test-booster live:true (channel not set): live delivery skipped with a clear reason, no crash', async () => {
    writeConfig({});
    const interaction = makeTestBoosterInteraction({ tipe: 'remove', live: true, configChannels: {} });

    await require('../../src/commands/stats')(interaction);

    assert.strictEqual(interaction.__boosterChannel.sent.length, 0, 'nothing to deliver to');
    const reply = interaction.__replies[0].content;
    assert.match(reply, /Live delivery: skipped/);
    assert.strictEqual(interaction.__currentChannel.sent.length, 1, 'local preview still sent');
});

// ====================================================
// === 4. PURE SIMULATION — the data-layer purity    ===
// ====================================================

test('PURE SIMULATION: running add + remove never writes boosts.json', async () => {
    writeConfig({ 'server-booster': 'ch_sb' });
    const before = boostsSnapshot();

    const add = makeTestBoosterInteraction({ tipe: 'add', configChannels: { 'server-booster': 'ch_sb' } });
    await require('../../src/commands/stats')(add);
    const remove = makeTestBoosterInteraction({ tipe: 'remove', live: true, configChannels: { 'server-booster': 'ch_sb' } });
    await require('../../src/commands/stats')(remove);

    assert.strictEqual(boostsSnapshot(), before, 'boosts.json byte-identical after both runs');
    // And no entry for the fake booster ever exists.
    if (before === null) {
        assert.ok(!fs.existsSync(boostsPath), 'no boosts.json created');
    }
});

// ====================================================
// === 5. help catalog contract                      ===
// ====================================================

test('help catalog: /test-booster documented in the stats lines + guide (budget-safe)', () => {
    const { HELP_CATEGORIES, buildAllEmbeds, embedTotalChars, searchHelp } = require('../../src/ui/helpCatalog');
    const statsCat = HELP_CATEGORIES.find(c => c.id === 'stats');
    assert.ok(statsCat.lines.some(l => l.includes('/test-booster')), 'compact line lists /test-booster');
    assert.match(statsCat.detail.join('\n'), /\/test-booster/, 'the guide explains /test-booster');

    // The All-Commands budget still holds with the new line.
    const all = buildAllEmbeds();
    const total = all.reduce((s, e) => s + embedTotalChars(e), 0);
    assert.ok(total <= 5800, `All-Commands total ${total} ≤ 5800`);

    // Searchable via the compact lines.
    const result = searchHelp('test-booster');
    assert.ok(result.totalBlocks >= 1, 'searching "test-booster" finds the command');
});
