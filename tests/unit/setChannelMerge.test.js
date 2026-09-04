/**
 * Unit tests v3.9.30 — PENGGABUNGAN /set-transcript-channel KE /set-channel.
 *
 * Permintaan user: "/set-transkip-chanel di jadiin satu saja dengan /set-chanel
 * biar tidak bingung" — admin tidak perlu hafal dua command channel yang mirip.
 *
 * Yang dibuktikan test ini:
 *   1. Registry: command terpisah /set-transcript-channel BENAR-BENAR hilang
 *      (total command 81 → 80) dan tidak ada mapping routing yang nyangkut.
 *   2. Registry: /set-channel tipe kini punya choice 'transcript';
 *      /remove-channel juga (supaya bisa dihapus dengan pola yang sama).
 *   3. Handler: /set-channel tipe:transcript menulis ke key yang sama yang
 *      dibaca ticketManager.saveTranscript → config.channels.transcript —
 *      perilaku identik dengan mantan command terpisah (roundtrip key).
 *   4. Handler: channel non-text (voice/category) ditolak — guard pindahan
 *      dari handler lama, kini berlaku untuk SEMUA tipe channel config.
 *   5. Handler: tipe lain (invoice/welcome/...) tetap berfungsi seperti
 *      sebelumnya (regression guard) — tanpa tip transcript.
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
// === (pola newCategorySafety.test.js)              ===
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

/** Config terkontrol: tanpa audit-log → logAudit silent-skip. */
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

/** Mock channel Discord. default: text channel (type GuildText). */
function makeChannel({ id = '111', name = 'transcript-log', type = ChannelType.GuildText } = {}) {
    return {
        id,
        name,
        type,
        toString: () => `<#${id}>`
    };
}

/** Mock interaction untuk handler domain config (/set-channel). */
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
// === 1. Registry — command lama hilang, choice baru ada ===
// ====================================================

test('registry: /set-transcript-channel TIDAK lagi terdaftar (digabung ke /set-channel)', () => {
    const { getCommands } = require('../../src/commands/registry');
    const names = getCommands().map(c => c.name);
    assert.ok(!names.includes('set-transcript-channel'), 'command lama harus hilang dari registry');
});

test('registry: total command tepat 82 (81 - 1 digabung + 2 midman v3.9.32)', () => {
    const { getCommands } = require('../../src/commands/registry');
    assert.strictEqual(getCommands().length, 82);
});

test('registry: /set-channel punya choice tipe "transcript" + deskripsi menyebut transcript', () => {
    const { getCommands } = require('../../src/commands/registry');
    const cmd = getCommands().find(c => c.name === 'set-channel');
    assert.ok(cmd, 'set-channel harus terdaftar');
    assert.ok(/transcript/i.test(cmd.description), 'deskripsi root harus menyebut transcript');
    const tipe = cmd.options.find(o => o.name === 'tipe');
    assert.ok(tipe, 'set-channel harus punya opsi tipe');
    const values = tipe.choices.map(c => c.value);
    for (const v of ['invoice', 'welcome', 'goodbye', 'audit-log', 'transcript']) {
        assert.ok(values.includes(v), `choice "${v}" harus tetap ada`);
    }
});

test('registry: /remove-channel juga punya choice "transcript" (pola hapus konsisten)', () => {
    const { getCommands } = require('../../src/commands/registry');
    const cmd = getCommands().find(c => c.name === 'remove-channel');
    assert.ok(cmd, 'remove-channel harus terdaftar');
    const tipe = cmd.options.find(o => o.name === 'tipe');
    const values = tipe.choices.map(c => c.value);
    assert.ok(values.includes('transcript'), 'remove-channel harus bisa hapus transcript');
});

test('router: /set-transcript-channel tidak lagi di-map — balas "belum didukung"', async () => {
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
    assert.match(replies[0].opts.content, /belum didukung|tidak dikenali|not registered/i);
});

// ====================================================
// === 2. Handler /set-channel — perilaku transcript ===
// ====================================================

test('handler: /set-channel tipe:transcript → config.channels.transcript terisi + tip khusus', async () => {
    writeTestConfig();
    const { getConfig } = require('../../src/data/configManager');
    const configHandler = require('../../src/commands/config');

    const ch = makeChannel({ id: '999', name: 'transcript-log' });
    const interaction = makeSetChannelInteraction({ tipe: 'transcript', channel: ch });
    await configHandler(interaction);

    assert.strictEqual(getConfig().channels.transcript, '999', 'harus menulis key channels.transcript');
    const last = interaction._replies[interaction._replies.length - 1];
    assert.match(last.opts.content, /✅/);
    assert.match(last.opts.content, /transcript/i);
    assert.match(last.opts.content, /auto-save/i, 'tip khusus transcript harus muncul');
});

test('handler: key yang ditulis = key yang dibaca saveTranscript (roundtrip kunci data)', () => {
    writeTestConfig();
    const { getConfig } = require('../../src/data/configManager');
    const config = getConfig();
    // ticketManager.js membaca: config.channels?.transcript (saveTranscript).
    // Test ini mengunci kontrak: key tulisan handler == key pembacaan runtime.
    assert.ok('transcript' in config.channels === false, 'awal: kosong');
    const ch = makeChannel({ id: '777' });
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'data', 'ticketManager.js'), 'utf8');
    assert.match(src, /config\.channels\?\.transcript/, 'ticketManager harus membaca channels.transcript');
    // Tulis via handler lalu pastikan key persis sama yang dibaca runtime.
    return require('../../src/commands/config')(makeSetChannelInteraction({ tipe: 'transcript', channel: ch })).then(
        () => {
            assert.strictEqual(getConfig().channels.transcript, '777');
        }
    );
});

test('handler: /set-channel tipe:transcript dengan VOICE channel → ditolak, config tidak berubah', async () => {
    writeTestConfig();
    const { getConfig } = require('../../src/data/configManager');
    const configHandler = require('../../src/commands/config');

    const voice = makeChannel({ id: '555', name: 'General Voice', type: ChannelType.GuildVoice });
    const interaction = makeSetChannelInteraction({ tipe: 'transcript', channel: voice });
    await configHandler(interaction);

    assert.strictEqual(getConfig().channels.transcript, undefined, 'tidak boleh tersimpan');
    const last = interaction._replies[interaction._replies.length - 1];
    assert.match(last.opts.content, /harus berupa text channel/i);
});

test('handler: /set-channel tipe:invoice tetap normal — tanpa tip transcript (regression)', async () => {
    writeTestConfig();
    const { getConfig } = require('../../src/data/configManager');
    const configHandler = require('../../src/commands/config');

    const ch = makeChannel({ id: '321', name: 'testimoni' });
    const interaction = makeSetChannelInteraction({ tipe: 'invoice', channel: ch });
    await configHandler(interaction);

    assert.strictEqual(getConfig().channels.invoice, '321');
    const last = interaction._replies[interaction._replies.length - 1];
    assert.match(last.opts.content, /✅/);
    assert.ok(!/auto-save/i.test(last.opts.content), 'tip transcript TIDAK boleh muncul untuk tipe lain');
});

// ====================================================
// === 3. /remove-channel — transcript bisa dihapus ===
// ====================================================

test('handler: /remove-channel tipe:transcript → key dihapus dari config', async () => {
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

    assert.strictEqual(getConfig().channels.transcript, undefined, 'key transcript harus terhapus');
    const last = replies[replies.length - 1];
    assert.match(last.opts.content, /berhasil dihapus/);
    assert.match(last.opts.content, /\/set-channel transcript/);
});
