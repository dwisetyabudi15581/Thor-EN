/**
 * Unit tests v3.9.38 — hardening automod & temp voice (Task 3-d).
 *
 * Yang diuji:
 *   1. containsLink: domain polos (discord.gg/xxx, t.me/x, example.com) —
 *      sebelumnya cuma match https?:// atau www. → invite/scam lolos.
 *   2. Exempt masking: exempt word di-MASK sebelum deteksi blocked word —
 *      "asus asu banget" (block "asu" + exempt "asus") sekarang di-flag,
 *      "asus baru" tetap bersih (kata terlarang standalone tidak ketutup).
 *   3. Split whitelist: isUserWhitelisted (admin-only) vs isLinkAllowed
 *      (linkAllowedRoles) — role link-whitelist tidak lagi bypass
 *      spam/kata terlarang/mass-mention.
 *   4. Boundary whole_word unicode-aware: "кот" tidak match di "коты".
 *   5. hookAutoMod (level messageCreate.execute dengan message mock):
 *      member link-whitelist posting kata terlarang → dihapus;
 *      posting link → tidak dihapus; member biasa posting bare domain → dihapus.
 *   6. voiceStateUpdate: event BOT keluar terakhir dari temp voice kosong →
 *      channel dihapus + di-unregister (sebelumnya bot di-skip total).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');

const dataDir = path.join(__dirname, '..', '..', 'data');
const automodManager = require('../../src/data/automodManager');

// ====================================================
// === Sandbox: snapshot & restore file data produksi ===
// === (pola hardeningV37.test.js / midman.test.js)    ===
// ====================================================
const SANDBOX_FILES = [
    'automod.json',
    'tempVoice.json',
    'stats.json',
    'levels.json',
    'responders.json',
    'afk.json',
    'config.json'
];
const backups = [];
for (const f of SANDBOX_FILES) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) {
        const b = p + '.v3938-backup';
        fs.copyFileSync(p, b);
        backups.push({ orig: p, backup: b });
    }
}
process.on('exit', () => {
    for (const { orig, backup } of backups) {
        try {
            fs.copyFileSync(backup, orig);
            fs.rmSync(backup, { force: true });
        } catch (_) {}
    }
    // File yang TIDAK ada sebelum test tapi tercipta selama test → dihapus,
    // supaya run test tidak meninggalkan residue di data/ produksi.
    for (const f of SANDBOX_FILES) {
        const p = path.join(dataDir, f);
        if (!backups.some(b => b.orig === p) && fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
            } catch (_) {}
        }
    }
    // v3.9.26: invalidasi cache manager automod supaya proses lain / run
    // berikutnya tidak baca snapshot basi.
    try {
        automodManager.invalidateCache();
    } catch (_) {}
    if (_savedGuildId !== undefined) process.env.GUILD_ID = _savedGuildId;
});

// Guard GUILD_ID (v3.9.26) di messageCreate/voiceStateUpdate tidak boleh aktif
// saat test — save & restore.
const _savedGuildId = process.env.GUILD_ID;
if ('GUILD_ID' in process.env) delete process.env.GUILD_ID;

// ====================================================
// === Helper mock ===
// ====================================================

/** Mock GuildMember: permissions (PermissionFlagsBits) + roles cache. */
function makeMember({ perms = [], roleIds = [] } = {}) {
    const permSet = new Set(perms);
    const roleSet = new Set(roleIds);
    return {
        permissions: { has: flag => permSet.has(flag) },
        roles: { cache: { has: id => roleSet.has(id) } }
    };
}

/** Mock Message untuk messageCreate.execute (hook automod end-to-end). */
function makeMessage({ guildId, userId, content, member, channelId = 'ch_general' }) {
    const msg = {
        author: { id: userId, tag: `tester_${userId}#0000`, bot: false, displayAvatarURL: () => 'x' },
        webhookId: null,
        guild: { id: guildId, name: 'Guild Test' },
        member,
        content,
        channel: { id: channelId, send: async () => {} },
        mentions: { users: new Map(), roles: new Map(), everyone: false },
        attachments: { size: 0 },
        stickers: { size: 0 },
        components: [],
        _deleted: false,
        delete: async () => {
            msg._deleted = true;
        },
        reply: async () => ({ delete: async () => {} })
    };
    return msg;
}

/** Mock voice channel untuk voiceStateUpdate.execute. */
function makeVoiceChannel(channelId, memberCount) {
    const ch = {
        id: channelId,
        members: { size: memberCount },
        _deleted: false,
        delete: async () => {
            ch._deleted = true;
        }
    };
    return ch;
}

// ====================================================
// === FIX 1 (bagian pure): containsLink bare domain ===
// ====================================================

test('v3.9.38 containsLink: domain polos terdeteksi (discord.gg / t.me / example.com)', () => {
    assert.ok(automodManager.containsLink('discord.gg/abc'), 'discord.gg/abc harus terdeteksi');
    assert.ok(automodManager.containsLink('t.me/x'), 't.me/x harus terdeteksi');
    assert.ok(automodManager.containsLink('example.com'), 'example.com harus terdeteksi');
    assert.ok(automodManager.containsLink('http://x.com'), 'scheme http (sudah works sebelumnya)');
    assert.ok(automodManager.containsLink('cek www.google.com'), 'www (sudah works sebelumnya)');
    assert.ok(automodManager.containsLink('cek https://google.com'), 'https (sudah works sebelumnya)');
});

test('v3.9.38 containsLink: chat Indonesia biasa tidak false-positive', () => {
    assert.ok(!automodManager.containsLink('biasa chat aja'));
    assert.ok(!automodManager.containsLink('3.5rb'));
    assert.ok(!automodManager.containsLink('gitu deh'));
    assert.ok(!automodManager.containsLink('ygd ok'));
    assert.ok(!automodManager.containsLink('jgn lupa ya'));
    assert.ok(!automodManager.containsLink('b aja'));
    assert.ok(!automodManager.containsLink('pesan biasa tanpa link'));
});

// ====================================================
// === FIX 2: exempt masking (findViolatedWord) ===
// ====================================================

test('v3.9.38 exempt masking: "asus asu banget" (block asu + exempt asus) → VIOLATION', () => {
    const config = {
        wordRules: [{ word: 'asu', action: null }],
        exemptWords: ['asus'],
        wordMatchMode: 'whole_word'
    };
    // Sebelum fix: exempt "asus" menutupi SEMUA violasi → pesan ini lolos.
    const v = automodManager.findViolatedWord('asus asu banget', config);
    assert.ok(v, 'kata terlarang standalone di samping exempt word harus di-flag');
    assert.strictEqual(v.word, 'asu');
    assert.strictEqual(v.action, null, 'action per-kata tetap utuh (null → fallback global)');
    // Exempt murni → tetap bersih
    assert.strictEqual(automodManager.findViolatedWord('asus baru', config), null);
});

test('v3.9.38 exempt masking: mode substring — exempt hanya menetralkan occurrence-nya', () => {
    const config = {
        wordRules: [{ word: 'asu', action: 'delete_only' }],
        exemptWords: ['asus'],
        wordMatchMode: 'substring'
    };
    assert.strictEqual(automodManager.findViolatedWord('asus baru', config), null, 'exempt murni bersih');
    const v = automodManager.findViolatedWord('asus asu banget', config);
    assert.ok(v, 'substring mode: "asu" standalone tetap di-flag walau ada "asus"');
    assert.strictEqual(v.word, 'asu');
    assert.strictEqual(v.action, 'delete_only', 'action per-kata tetap utuh');
});

test('v3.9.38 maskExemptWords: diganti run spasi sama-panjang, occurrence bersebelahan ikut ke-mask', () => {
    // whole_word: hanya occurrence berdiri sendiri (lookaround non-consuming)
    assert.strictEqual(automodManager.maskExemptWords('asus asu', ['asus'], 'whole_word'), ' '.repeat(4) + ' asu');
    assert.strictEqual(automodManager.maskExemptWords('asus asus asus', ['asus'], 'whole_word').trim(), '');
    assert.strictEqual(automodManager.maskExemptWords('asus asus asus', ['asus'], 'whole_word').length, 14, 'panjang teks tidak berubah');
    // substring: semua occurrence (termasuk yang menempel di kata lain)
    assert.strictEqual(automodManager.maskExemptWords('asus xasusy', ['asus'], 'substring'), ' '.repeat(5) + 'x' + ' '.repeat(4) + 'y');
    // exempt kosong → zero-overhead, content dikembalikan apa adanya
    assert.strictEqual(automodManager.maskExemptWords('asus asu', [], 'whole_word'), 'asus asu');
});

// ====================================================
// === FIX 1: split isUserWhitelisted vs isLinkAllowed ===
// ====================================================

test('v3.9.38 whitelist split: role linkAllowedRoles TIDAK lagi bypass global', () => {
    const config = { linkAllowedRoles: ['ROLE_LINK'] };
    const member = makeMember({ roleIds: ['ROLE_LINK'] });
    assert.strictEqual(
        automodManager.isUserWhitelisted(member, config),
        false,
        'member dengan link-whitelist role TIDAK whitelist dari spam/kata/mass-mention'
    );
    assert.strictEqual(
        automodManager.isLinkAllowed(member, config),
        true,
        'member dengan link-whitelist role tetap exempt KHUSUS cek link'
    );
});

test('v3.9.38 whitelist split: admin lolos semua cek, member biasa tidak', () => {
    const config = { linkAllowedRoles: ['ROLE_LINK'] };
    const admin = makeMember({ perms: [PermissionFlagsBits.Administrator] });
    const manager = makeMember({ perms: [PermissionFlagsBits.ManageGuild] });
    const plain = makeMember();
    // Admin → true untuk keduanya (bypass total, termasuk link)
    assert.strictEqual(automodManager.isUserWhitelisted(admin, config), true);
    assert.strictEqual(automodManager.isLinkAllowed(admin, config), true);
    // ManageGuild juga dianggap admin (whitelist global)
    assert.strictEqual(automodManager.isUserWhitelisted(manager, config), true);
    // Member biasa → false keduanya
    assert.strictEqual(automodManager.isUserWhitelisted(plain, config), false);
    assert.strictEqual(automodManager.isLinkAllowed(plain, config), false);
});

// ====================================================
// === FIX 3: boundary whole_word unicode-aware ===
// ====================================================

test('v3.9.38 unicode boundary: whole_word "кот" TIDAK match "коты" (Cyrillic)', () => {
    assert.ok(!automodManager.matchWord('коты walked', 'кот', 'whole_word'), 'huruf Cyrillic adalah bagian kata, bukan boundary');
    assert.ok(automodManager.matchWord('large кот!', 'кот', 'whole_word'), 'kata berdiri sendiri tetap match');
    assert.ok(automodManager.matchWord('кот', 'кот', 'whole_word'), 'exact single word');
    // Regression: boundary Latin tetap benar
    assert.ok(automodManager.matchWord('asu banget', 'asu', 'whole_word'));
    assert.ok(!automodManager.matchWord('asus bagus', 'asu', 'whole_word'));
    // Regression: kata dengan karakter regex-special tetap aman (flag u)
    assert.ok(automodManager.matchWord('cek a.b*c dong', 'a.b*c', 'whole_word'));
    assert.ok(!automodManager.matchWord('cek aXbYc dong', 'a.b*c', 'whole_word'));
});

// ====================================================
// === FIX 1 (level hook): hookAutoMod end-to-end ===
// ====================================================

const messageCreate = require('../../src/bot/events/messageCreate');

function setupHookGuild(gid) {
    automodManager.setGuildConfig(gid, {
        enabled: true,
        blockLinks: true,
        linkAllowedChannels: [],
        linkAllowedRoles: ['ROLE_LINK'],
        wordRules: [{ word: 'asu', action: null }],
        exemptWords: ['asus'],
        wordMatchMode: 'whole_word',
        wordAction: 'delete_only',
        spamThreshold: 50,
        spamWindowMs: 10000,
        maxMentions: 50,
        mentionAction: 'delete_only'
    });
}

test('v3.9.38 hookAutoMod: link-whitelist role posting KATA TERLARANG → pesan tetap dihapus', async () => {
    const gid = 'test_guild_v3938_hook_word_' + Date.now();
    setupHookGuild(gid);
    const member = makeMember({ roleIds: ['ROLE_LINK'] });
    const msg = makeMessage({ guildId: gid, userId: 'usr_hook_word', content: 'asu banget', member });
    await messageCreate.execute(msg);
    assert.ok(msg._deleted, 'spam/kata terlarang TETAP di-enforce walau member punya link-whitelist role');
    automodManager.resetSpamTracker(gid, 'usr_hook_word');
});

test('v3.9.38 hookAutoMod: link-whitelist role posting LINK → pesan tidak dihapus', async () => {
    const gid = 'test_guild_v3938_hook_link_' + Date.now();
    setupHookGuild(gid);
    const member = makeMember({ roleIds: ['ROLE_LINK'] });
    const msg = makeMessage({ guildId: gid, userId: 'usr_hook_link', content: 'cek discord.gg/abc', member });
    await messageCreate.execute(msg);
    assert.ok(!msg._deleted, 'link dibolehkan untuk role link-whitelist (exempt khusus link)');
    automodManager.resetSpamTracker(gid, 'usr_hook_link');
});

test('v3.9.38 hookAutoMod: member biasa posting BARE DOMAIN → pesan dihapus (blockLinks)', async () => {
    const gid = 'test_guild_v3938_hook_plain_' + Date.now();
    setupHookGuild(gid);
    const member = makeMember();
    const msg = makeMessage({ guildId: gid, userId: 'usr_hook_plain', content: 'join t.me/scam ya', member });
    await messageCreate.execute(msg);
    assert.ok(msg._deleted, 'domain polos (tanpa scheme/www) harus ke-delete — sebelumnya lolos');
    automodManager.resetSpamTracker(gid, 'usr_hook_plain');
});

// ====================================================
// === FIX 4: voiceStateUpdate — bot keluar terakhir ===
// ====================================================

const voiceStateUpdate = require('../../src/bot/events/voiceStateUpdate');
const tempVoiceManager = require('../../src/data/tempVoiceManager');

test('v3.9.38 voiceStateUpdate: MUSIC BOT keluar terakhir dari temp voice kosong → channel dihapus + unregister', async () => {
    const gid = 'test_guild_v3938_voice_bot_' + Date.now();
    const channelId = 'ch_voice_bot_' + Date.now();
    tempVoiceManager.registerChannel(gid, channelId, 'owner_1', 'Owner#0001', "🔊 Owner's Room");

    const ch = makeVoiceChannel(channelId, 0); // kosong — bot adalah member terakhir
    const guild = { id: gid, channels: { cache: new Map([[channelId, ch]]) } };
    const oldState = { channelId };
    const newState = {
        guild,
        id: 'music_bot_1',
        channelId: null,
        member: { user: { bot: true } },
        client: {}
    };

    // Sebelum fix: event bot di-skip total → channel orphan + entry menempel selamanya.
    await voiceStateUpdate.execute(oldState, newState);

    assert.ok(ch._deleted, 'channel temp voice kosong harus dihapus saat bot keluar terakhir');
    assert.strictEqual(tempVoiceManager.getChannel(gid, channelId), null, 'entry tempVoice.json harus di-unregister');
});

test('v3.9.38 voiceStateUpdate: channel masih ada member → TIDAK dihapus (path bot & human tidak berubah)', async () => {
    const gid = 'test_guild_v3938_voice_stay_' + Date.now();
    tempVoiceManager.setupGuild(gid, 'ch_creator', 'cat_voice', null); // controlChannelId null → refresh panel no-op

    // Bot keluar tapi channel masih ada 2 member (owner + human lain)
    const chBot = makeVoiceChannel('ch_stay_bot', 2);
    tempVoiceManager.registerChannel(gid, 'ch_stay_bot', 'owner_2', 'Owner#0002', "🔊 Bot Stay Room");
    await voiceStateUpdate.execute(
        { channelId: 'ch_stay_bot' },
        {
            guild: { id: gid, channels: { cache: new Map([['ch_stay_bot', chBot]]) } },
            id: 'music_bot_2',
            channelId: null,
            member: { user: { bot: true } },
            client: {}
        }
    );
    assert.ok(!chBot._deleted, 'channel yang masih ada member tidak boleh dihapus (path bot)');
    assert.ok(tempVoiceManager.getChannel(gid, 'ch_stay_bot'), 'entry tetap terdaftar selama channel masih dipakai');

    // Human keluar tapi channel masih ada 2 member (owner tetap di dalam)
    const chHuman = makeVoiceChannel('ch_stay_human', 2);
    tempVoiceManager.registerChannel(gid, 'ch_stay_human', 'owner_3', 'Owner#0003', "🔊 Human Stay Room");
    await voiceStateUpdate.execute(
        { channelId: 'ch_stay_human' },
        {
            guild: { id: gid, channels: { cache: new Map([['ch_stay_human', chHuman]]) } },
            id: 'human_leaver', // bukan owner → tidak ada transfer
            channelId: null,
            member: { user: { bot: false } },
            client: {}
        }
    );
    assert.ok(!chHuman._deleted, 'channel yang masih ada member tidak boleh dihapus (path human — behavior lama)');
});

test('v3.9.38 voiceStateUpdate: HUMAN terakhir keluar dari channel kosong → tetap dihapus (behavior lama utuh)', async () => {
    const gid = 'test_guild_v3938_voice_human_' + Date.now();
    tempVoiceManager.setupGuild(gid, 'ch_creator', 'cat_voice', null);
    const channelId = 'ch_voice_human_' + Date.now();
    tempVoiceManager.registerChannel(gid, channelId, 'owner_4', 'Owner#0004', "🔊 Human Last Room");

    const ch = makeVoiceChannel(channelId, 0);
    await voiceStateUpdate.execute(
        { channelId },
        {
            guild: { id: gid, channels: { cache: new Map([[channelId, ch]]) } },
            id: 'owner_4', // owner sendiri keluar terakhir → transfer di-skip (size 0), langsung cleanup
            channelId: null,
            member: { user: { bot: false } },
            client: {}
        }
    );
    assert.ok(ch._deleted, 'cleanup channel kosong path human harus tetap jalan lewat helper yang di-extract');
    assert.strictEqual(tempVoiceManager.getChannel(gid, channelId), null, 'entry di-unregister (behavior lama)');
});
