/**
 * Unit tests v3.9.38 — automod & temp voice hardening (Task 3-d).
 *
 * What is tested:
 *   1. containsLink: plain domains (discord.gg/xxx, t.me/x, example.com) —
 *      previously only matched https?:// or www. → invites/scams slipped through.
 *   2. Exempt masking: exempt words are MASKED before blocked-word detection —
 *      "asus asu banget" (block "asu" + exempt "asus") is now flagged,
 *      "asus baru" stays clean (a standalone blocked word is not covered).
 *   3. Whitelist split: isUserWhitelisted (admin-only) vs isLinkAllowed
 *      (linkAllowedRoles) — a link-whitelist role no longer bypasses
 *      spam/blocked-words/mass-mention.
 *   4. Whole-word unicode-aware boundaries: "кот" does not match "коты".
 *   5. hookAutoMod (messageCreate.execute level with a message mock):
 *      a link-whitelist member posting a blocked word → deleted;
 *      posting a link → not deleted; a regular member posting a bare domain → deleted.
 *   6. voiceStateUpdate: a BOT leaving an empty temp voice channel last →
 *      channel deleted + unregistered (previously bots were skipped entirely).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');

const dataDir = path.join(__dirname, '..', '..', 'data');
const automodManager = require('../../src/data/automodManager');

// ====================================================
// === Sandbox: production data files are snapshotted & restored ===
// === (hardeningV37.test.js / midman.test.js pattern)     ===
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
    // Files that did NOT exist before the test but were created during it are
    // deleted, so the test run leaves no residue in the production data/.
    for (const f of SANDBOX_FILES) {
        const p = path.join(dataDir, f);
        if (!backups.some(b => b.orig === p) && fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
            } catch (_) {}
        }
    }
    // v3.9.26: invalidate the automod manager cache so other processes / next
    // runs do not read a stale snapshot.
    try {
        automodManager.invalidateCache();
    } catch (_) {}
    if (_savedGuildId !== undefined) process.env.GUILD_ID = _savedGuildId;
});

// The GUILD_ID guard (v3.9.26) in messageCreate/voiceStateUpdate must be off
// during tests — save & restore.
const _savedGuildId = process.env.GUILD_ID;
if ('GUILD_ID' in process.env) delete process.env.GUILD_ID;

// ====================================================
// === Mock helpers ===
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

/** Mock Message for messageCreate.execute (end-to-end automod hook). */
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

/** Mock voice channel for voiceStateUpdate.execute. */
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
// === FIX 1 (pure part): containsLink bare domains ===
// ====================================================

test('v3.9.38 containsLink: plain domains detected (discord.gg / t.me / example.com)', () => {
    assert.ok(automodManager.containsLink('discord.gg/abc'), 'discord.gg/abc must be detected');
    assert.ok(automodManager.containsLink('t.me/x'), 't.me/x must be detected');
    assert.ok(automodManager.containsLink('example.com'), 'example.com must be detected');
    assert.ok(automodManager.containsLink('http://x.com'), 'http scheme (already worked before)');
    assert.ok(automodManager.containsLink('cek www.google.com'), 'www (already worked before)');
    assert.ok(automodManager.containsLink('cek https://google.com'), 'https (already worked before)');
});

test('v3.9.38 containsLink: ordinary Indonesian chat does not false-positive', () => {
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
    // Before the fix: the "asus" exemption covered ALL violations → this message slipped through.
    const v = automodManager.findViolatedWord('asus asu banget', config);
    assert.ok(v, 'a standalone blocked word next to an exempt word must be flagged');
    assert.strictEqual(v.word, 'asu');
    assert.strictEqual(v.action, null, 'the per-word action stays intact (null → global fallback)');
    // Pure exempt → still clean
    assert.strictEqual(automodManager.findViolatedWord('asus baru', config), null);
});

test('v3.9.38 exempt masking: substring mode — the exemption only neutralizes its own occurrences', () => {
    const config = {
        wordRules: [{ word: 'asu', action: 'delete_only' }],
        exemptWords: ['asus'],
        wordMatchMode: 'substring'
    };
    assert.strictEqual(automodManager.findViolatedWord('asus baru', config), null, 'pure exempt stays clean');
    const v = automodManager.findViolatedWord('asus asu banget', config);
    assert.ok(v, 'substring mode: a standalone "asu" is still flagged even with "asus" present');
    assert.strictEqual(v.word, 'asu');
    assert.strictEqual(v.action, 'delete_only', 'the per-word action stays intact');
});

test('v3.9.38 maskExemptWords: replaced with same-length spaces, adjacent occurrences get masked too', () => {
    // whole_word: only standalone occurrences (non-consuming lookaround)
    assert.strictEqual(automodManager.maskExemptWords('asus asu', ['asus'], 'whole_word'), ' '.repeat(4) + ' asu');
    assert.strictEqual(automodManager.maskExemptWords('asus asus asus', ['asus'], 'whole_word').trim(), '');
    assert.strictEqual(automodManager.maskExemptWords('asus asus asus', ['asus'], 'whole_word').length, 14, 'text length unchanged');
    // substring: all occurrences (including ones glued inside other words)
    assert.strictEqual(automodManager.maskExemptWords('asus xasusy', ['asus'], 'substring'), ' '.repeat(5) + 'x' + ' '.repeat(4) + 'y');
    // empty exempt → zero overhead, content returned as-is
    assert.strictEqual(automodManager.maskExemptWords('asus asu', [], 'whole_word'), 'asus asu');
});

// ====================================================
// === FIX 1: split isUserWhitelisted vs isLinkAllowed ===
// ====================================================

test('v3.9.38 whitelist split: a linkAllowedRoles role NO LONGER bypasses global checks', () => {
    const config = { linkAllowedRoles: ['ROLE_LINK'] };
    const member = makeMember({ roleIds: ['ROLE_LINK'] });
    assert.strictEqual(
        automodManager.isUserWhitelisted(member, config),
        false,
        'a member with a link-whitelist role is NOT whitelisted from spam/words/mass-mention'
    );
    assert.strictEqual(
        automodManager.isLinkAllowed(member, config),
        true,
        'a member with a link-whitelist role stays exempt SPECIFICALLY for the link check'
    );
});

test('v3.9.38 whitelist split: the admin passes all checks, a regular member does not', () => {
    const config = { linkAllowedRoles: ['ROLE_LINK'] };
    const admin = makeMember({ perms: [PermissionFlagsBits.Administrator] });
    const manager = makeMember({ perms: [PermissionFlagsBits.ManageGuild] });
    const plain = makeMember();
    // Admin → true for both (total bypass, including links)
    assert.strictEqual(automodManager.isUserWhitelisted(admin, config), true);
    assert.strictEqual(automodManager.isLinkAllowed(admin, config), true);
    // ManageGuild also counts as admin (global whitelist)
    assert.strictEqual(automodManager.isUserWhitelisted(manager, config), true);
    // Regular member → false for both
    assert.strictEqual(automodManager.isUserWhitelisted(plain, config), false);
    assert.strictEqual(automodManager.isLinkAllowed(plain, config), false);
});

// ====================================================
// === FIX 3: boundary whole_word unicode-aware ===
// ====================================================

test('v3.9.38 unicode boundary: whole_word "кот" does NOT match "коты" (Cyrillic)', () => {
    assert.ok(!automodManager.matchWord('коты walked', 'кот', 'whole_word'), 'Cyrillic letters are part of the word, not a boundary');
    assert.ok(automodManager.matchWord('large кот!', 'кот', 'whole_word'), 'a standalone word still matches');
    assert.ok(automodManager.matchWord('кот', 'кот', 'whole_word'), 'exact single word');
    // Regression: Latin boundaries stay correct
    assert.ok(automodManager.matchWord('asu banget', 'asu', 'whole_word'));
    assert.ok(!automodManager.matchWord('asus bagus', 'asu', 'whole_word'));
    // Regression: words with regex-special characters stay safe (u flag)
    assert.ok(automodManager.matchWord('cek a.b*c dong', 'a.b*c', 'whole_word'));
    assert.ok(!automodManager.matchWord('cek aXbYc dong', 'a.b*c', 'whole_word'));
});

// ====================================================
// === FIX 1 (hook level): hookAutoMod end-to-end ===
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

test('v3.9.38 hookAutoMod: a link-whitelist role posting a BLOCKED WORD → the message is still deleted', async () => {
    const gid = 'test_guild_v3938_hook_word_' + Date.now();
    setupHookGuild(gid);
    const member = makeMember({ roleIds: ['ROLE_LINK'] });
    const msg = makeMessage({ guildId: gid, userId: 'usr_hook_word', content: 'asu banget', member });
    await messageCreate.execute(msg);
    assert.ok(msg._deleted, 'spam/blocked words are STILL enforced even if the member has a link-whitelist role');
    automodManager.resetSpamTracker(gid, 'usr_hook_word');
});

test('v3.9.38 hookAutoMod: a link-whitelist role posting a LINK → the message is not deleted', async () => {
    const gid = 'test_guild_v3938_hook_link_' + Date.now();
    setupHookGuild(gid);
    const member = makeMember({ roleIds: ['ROLE_LINK'] });
    const msg = makeMessage({ guildId: gid, userId: 'usr_hook_link', content: 'cek discord.gg/abc', member });
    await messageCreate.execute(msg);
    assert.ok(!msg._deleted, 'links are allowed for the link-whitelist role (link-specific exemption)');
    automodManager.resetSpamTracker(gid, 'usr_hook_link');
});

test('v3.9.38 hookAutoMod: a regular member posting a BARE DOMAIN → the message is deleted (blockLinks)', async () => {
    const gid = 'test_guild_v3938_hook_plain_' + Date.now();
    setupHookGuild(gid);
    const member = makeMember();
    const msg = makeMessage({ guildId: gid, userId: 'usr_hook_plain', content: 'join t.me/scam ya', member });
    await messageCreate.execute(msg);
    assert.ok(msg._deleted, 'a plain domain (no scheme/www) must be deleted — previously slipped through');
    automodManager.resetSpamTracker(gid, 'usr_hook_plain');
});

// ====================================================
// === FIX 4: voiceStateUpdate — the bot leaves last ===
// ====================================================

const voiceStateUpdate = require('../../src/bot/events/voiceStateUpdate');
const tempVoiceManager = require('../../src/data/tempVoiceManager');

test('v3.9.38 voiceStateUpdate: a MUSIC BOT leaving an empty temp voice channel last → channel deleted + unregistered', async () => {
    const gid = 'test_guild_v3938_voice_bot_' + Date.now();
    const channelId = 'ch_voice_bot_' + Date.now();
    tempVoiceManager.registerChannel(gid, channelId, 'owner_1', 'Owner#0001', "🔊 Owner's Room");

    const ch = makeVoiceChannel(channelId, 0); // empty — the bot is the last member
    const guild = { id: gid, channels: { cache: new Map([[channelId, ch]]) } };
    const oldState = { channelId };
    const newState = {
        guild,
        id: 'music_bot_1',
        channelId: null,
        member: { user: { bot: true } },
        client: {}
    };

    // Before the fix: bot events were skipped entirely → an orphan channel + an entry stuck forever.
    await voiceStateUpdate.execute(oldState, newState);

    assert.ok(ch._deleted, 'an empty temp voice channel must be deleted when the bot leaves last');
    assert.strictEqual(tempVoiceManager.getChannel(gid, channelId), null, 'the tempVoice.json entry must be unregistered');
});

test('v3.9.38 voiceStateUpdate: the channel still has members → NOT deleted (bot & human paths unchanged)', async () => {
    const gid = 'test_guild_v3938_voice_stay_' + Date.now();
    tempVoiceManager.setupGuild(gid, 'ch_creator', 'cat_voice', null); // controlChannelId null → refresh panel no-op

    // A bot leaves but the channel still has 2 members (owner + another human)
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
    assert.ok(!chBot._deleted, 'a channel that still has members must not be deleted (bot path)');
    assert.ok(tempVoiceManager.getChannel(gid, 'ch_stay_bot'), 'the entry stays registered while the channel is still in use');

    // A human leaves but the channel still has 2 members (the owner stays inside)
    const chHuman = makeVoiceChannel('ch_stay_human', 2);
    tempVoiceManager.registerChannel(gid, 'ch_stay_human', 'owner_3', 'Owner#0003', "🔊 Human Stay Room");
    await voiceStateUpdate.execute(
        { channelId: 'ch_stay_human' },
        {
            guild: { id: gid, channels: { cache: new Map([['ch_stay_human', chHuman]]) } },
            id: 'human_leaver', // not the owner → no transfer
            channelId: null,
            member: { user: { bot: false } },
            client: {}
        }
    );
    assert.ok(!chHuman._deleted, 'a channel that still has members must not be deleted (human path — old behavior)');
});

test('v3.9.38 voiceStateUpdate: the last HUMAN leaving an empty channel → still deleted (old behavior intact)', async () => {
    const gid = 'test_guild_v3938_voice_human_' + Date.now();
    tempVoiceManager.setupGuild(gid, 'ch_creator', 'cat_voice', null);
    const channelId = 'ch_voice_human_' + Date.now();
    tempVoiceManager.registerChannel(gid, channelId, 'owner_4', 'Owner#0004', "🔊 Human Last Room");

    const ch = makeVoiceChannel(channelId, 0);
    await voiceStateUpdate.execute(
        { channelId },
        {
            guild: { id: gid, channels: { cache: new Map([[channelId, ch]]) } },
            id: 'owner_4', // the owner themselves leaves last → transfer skipped (size 0), straight to cleanup
            channelId: null,
            member: { user: { bot: false } },
            client: {}
        }
    );
    assert.ok(ch._deleted, 'the empty-channel cleanup on the human path must still run via the extracted helper');
    assert.strictEqual(tempVoiceManager.getChannel(gid, channelId), null, 'the entry is unregistered (old behavior)');
});
