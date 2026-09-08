/**
 * Unit tests v3.9.46 — the intent-missing hint must not false-alarm.
 *
 * Production report: the "Message Content Intent is not enabled" hint fired
 * while the intent WAS enabled and the bot was online (with the portal toggle
 * off, the bot would crash at login: "Privileged intent provided is not
 * enabled"). The triggering message (from thor064747) was a text-less type:
 * a native poll / Tenor GIF-picker message / system message.
 *
 * What is guarded:
 *   A. isContentlessByDesign() (pure helper): true for poll / embeds (gifv) /
 *      system messages (system/type) / attachments / stickers / components;
 *      false for a plain empty message.
 *   B. End-to-end (execute + console.warn stubbed): text-less messages from
 *      those sources → 0 warnings; a plain empty message → the hint fires,
 *      exactly ONCE per guild per 24h (dedup).
 */

const test = require('node:test');
const assert = require('node:assert');

// The GUILD_ID guard (v3.9.26) must be off during tests — save & restore.
const _savedGuildId = process.env.GUILD_ID;
if ('GUILD_ID' in process.env) delete process.env.GUILD_ID;

const messageCreate = require('../../src/bot/events/messageCreate');
const { isContentlessByDesign } = messageCreate;

test.after(() => {
    if (_savedGuildId !== undefined) process.env.GUILD_ID = _savedGuildId;
});

/** Mock Message — plain and text-less by default + per-scenario overrides. */
function makeEmptyMessage(guildId, extra = {}) {
    return Object.assign({
        author: { id: 'usr_hint', tag: 'tester_hint#0000', bot: false, displayAvatarURL: () => 'x' },
        webhookId: null,
        guild: { id: guildId, name: 'Guild Hint Test' },
        member: { permissions: { has: () => false }, roles: { cache: { has: () => false } } },
        content: '',
        channel: { id: 'ch_hint', send: async () => {} },
        mentions: { users: new Map(), roles: new Map(), everyone: false },
        attachments: { size: 0 },
        stickers: { size: 0 },
        components: [],
        embeds: [],
        poll: null,
        system: false,
        type: 0,
        reply: async () => ({ delete: async () => {} })
    }, extra);
}

/** execute() with console.warn stubbed → number of warnings triggered. */
async function countWarnings(guildId, extra = {}) {
    const orig = console.warn;
    let calls = 0;
    console.warn = () => { calls += 1; };
    try {
        await messageCreate.execute(makeEmptyMessage(guildId, extra));
    } finally {
        console.warn = orig;
    }
    return calls;
}

test('A. isContentlessByDesign: poll/gifv-embed/system-message/attachment/sticker/components = true; plain = false', () => {
    assert.strictEqual(isContentlessByDesign({ poll: {} }), true, 'a native Discord poll needs no text');
    assert.strictEqual(isContentlessByDesign({ embeds: [{ provider: { name: 'Tenor' } }] }), true, 'a GIF picker (gifv embed) needs no text');
    assert.strictEqual(isContentlessByDesign({ system: true }), true, 'a system message (join/pin) needs no text');
    assert.strictEqual(isContentlessByDesign({ type: 7 }), true, 'type 7 (USER_JOIN) needs no text');
    assert.strictEqual(isContentlessByDesign({ attachments: { size: 1 } }), true, 'an attachment-only message (old behavior intact)');
    assert.strictEqual(isContentlessByDesign({ stickers: { size: 1 } }), true, 'a sticker-only message (old behavior intact)');
    assert.strictEqual(isContentlessByDesign({ components: [{}] }), true, 'a UI-component message (old behavior intact)');
    assert.strictEqual(isContentlessByDesign({}), false, 'a plain empty message = suspicious → the hint may fire');
});

test('B. end-to-end: legitimate text-less sources → the hint does NOT fire (0 warnings)', async () => {
    const cases = [
        ['native poll', { poll: { question: {} } }],
        ['Tenor gif', { embeds: [{ type: 'gifv' }] }],
        ['system join message', { system: true, type: 7 }],
        ['attachment only', { attachments: { size: 1 } }]
    ];
    for (const [label, extra] of cases) {
        const n = await countWarnings('test_guild_hint_' + label.replace(/\W+/g, '_'), extra);
        assert.strictEqual(n, 0, `${label} must not trigger the intent-missing hint (v3.9.45 false alarm)`);
    }
});

test('C. end-to-end: a plain empty message → the hint fires EXACTLY ONCE per guild per 24h', async () => {
    const gid = 'test_guild_hint_dedup';
    const first = await countWarnings(gid, {});
    assert.strictEqual(first, 1, 'a plain empty message still triggers the hint (real intent detection)');
    const second = await countWarnings(gid, {});
    assert.strictEqual(second, 0, 'a second message in the same guild within 24h must not repeat the hint (dedup)');
});
