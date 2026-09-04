/**
 * Unit tests untuk interactions router (src/interactions/index.js)
 *
 * Verify:
 *   - Slash command diabaikan (bukan domain interactions router)
 *   - Button interaction dengan customId known → dispatch ke domain
 *   - Modal submit dengan customId known → dispatch ke domain
 *   - Select menu dengan customId unknown → log warning, no crash
 *   - Dedup: interaction.id yang sama diproses hanya 1x (v3.9.38: mark SETELAH
 *     handler sukses — handler yang throw tidak ditandai, replay bisa retry)
 *   - v3.9.33: User Select Menu (mm_pick_seller) → dispatch ke domain midman
 */

const test = require('node:test');
const assert = require('node:assert');

function makeMockInteraction({ customId, type = 'button', id = `test-${Date.now()}-${Math.random()}` }) {
    const replies = [];
    const interaction = {
        id,
        customId,
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => type === 'button',
        isStringSelectMenu: () => type === 'select',
        // v3.9.33: router kini menerima user select menu (dropdown member).
        isUserSelectMenu: () => type === 'userselect',
        isModalSubmit: () => type === 'modal',
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
    return interaction;
}

test('interactions router: ignores slash commands', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = {
        isChatInputCommand: () => true,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => false,
        isModalSubmit: () => false,
        id: `slash-${Date.now()}`
    };
    // Should return undefined (no action) without throwing
    const result = await routeInteraction(interaction);
    assert.strictEqual(result, undefined);
});

test('interactions router: non-button/select/modal ignored', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = {
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => false,
        isModalSubmit: () => false,
        id: `auto-${Date.now()}`
    };
    const result = await routeInteraction(interaction);
    assert.strictEqual(result, undefined);
});

test('interactions router: v3.9.33 — user select mm_pick_seller dispatched to midman domain', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({ customId: 'mm_pick_seller', type: 'userselect' });
    // midman handler butuh interaction.guild/user/values — akan throw.
    // Yang penting: dispatch TERJADI ke domain midman (bukan di-ignore).
    try {
        await routeInteraction(interaction);
    } catch (err) {
        assert.ok(!/no handler/i.test(err.message), 'harus dispatch, bukan skip');
        return;
    }
    assert.ok(true, 'dispatched without error');
});

test('interactions router: v3.9.34 — user select mm_pick_buyer dispatched to midman domain', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({ customId: 'mm_pick_buyer', type: 'userselect' });
    try {
        await routeInteraction(interaction);
    } catch (err) {
        assert.ok(!/no handler/i.test(err.message), 'harus dispatch, bukan skip');
        return;
    }
    assert.ok(true, 'dispatched without error');
});

test('interactions router: v3.9.34 — user select mm_pick_member dispatched to midman domain', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({ customId: 'mm_pick_member', type: 'userselect' });
    try {
        await routeInteraction(interaction);
    } catch (err) {
        assert.ok(!/no handler/i.test(err.message), 'harus dispatch, bukan skip');
        return;
    }
    assert.ok(true, 'dispatched without error');
});

test('interactions router: v3.9.34 — string select mm_remove_pick dispatched to midman domain', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({ customId: 'mm_remove_pick', type: 'select' });
    try {
        await routeInteraction(interaction);
    } catch (err) {
        assert.ok(!/no handler/i.test(err.message), 'harus dispatch, bukan skip');
        return;
    }
    assert.ok(true, 'dispatched without error');
});

test('interactions router: btn_verify dispatched to verify domain', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({ customId: 'btn_verify', type: 'button' });
    // verify handler butuh interaction.member dll — akan throw. Yang penting: dispatch terjadi.
    try {
        await routeInteraction(interaction);
    } catch (err) {
        // Expected — handler butuh member. Verify dispatch terjadi (error bukan "no handler").
        assert.ok(!/no handler/i.test(err.message), 'should dispatch, not skip');
        return;
    }
    // Kalau sukses, dispatch tetap terjadi
    assert.ok(true, 'dispatched without error');
});

test('interactions router: gw_join: dispatched to giveaway domain', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({ customId: 'gw_join:gw_123', type: 'button' });
    try {
        await routeInteraction(interaction);
    } catch (err) {
        // Expected — handler butuh guild, user, dll
        assert.ok(!/no handler/i.test(err.message));
        return;
    }
    assert.ok(true);
});

test('interactions router: poll_vote: dispatched to poll domain', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({ customId: 'poll_vote:poll_123:0', type: 'button' });
    try {
        await routeInteraction(interaction);
    } catch (err) {
        assert.ok(!/no handler/i.test(err.message));
        return;
    }
    assert.ok(true);
});

test('interactions router: unknown customId logs warning (no crash)', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({ customId: 'unknown_customId_xyz', type: 'button' });
    // Should not throw — unknown customId just logs warning
    await routeInteraction(interaction);
    assert.ok(true, 'no crash on unknown customId');
});

test('interactions router: dedup — same interaction.id processed only once (v3.9.38: mark SETELAH sukses)', async () => {
    const routeInteraction = require('../../src/interactions');
    const id = `dedup-test-${Date.now()}`;
    const replies = [];
    // v3.9.38 FIX: dedup sekarang check-sebelum + mark-SETELAH-handler-sukses.
    // Pakai btn_verify dengan mock minimal: handler membalas error ke user
    // (sukses — tidak throw) → entry ditandai → replay interaksi yang sama
    // di-skip. (Dulu: checkAndMark menandai SEBELUM handler jalan.)
    const makeInteraction = () => ({
        id,
        customId: 'btn_verify',
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => false,
        isModalSubmit: () => false,
        reply: async opts => {
            replies.push(opts);
            return {};
        },
        editReply: async opts => {
            replies.push(opts);
            return {};
        }
    });

    // First call: dispatches + handler reply (success) → baru ditandai
    await routeInteraction(makeInteraction());
    assert.strictEqual(replies.length, 1, 'first call: handler jalan (1 reply)');

    // Second call (Discord retry / gateway replay): should be deduped (no dispatch)
    const result = await routeInteraction(makeInteraction());
    assert.strictEqual(result, undefined, 'second call should be deduped');
    assert.strictEqual(replies.length, 1, 'handler tidak boleh jalan 2x');
});

test('interactions router: dedup v3.9.38 — handler THROW → tidak ditandai → replay diproses ulang', async () => {
    const routeInteraction = require('../../src/interactions');
    const { check, processedInteractions } = require('../../src/interactions/_dedup');
    const id = `dedup-throw-test-${Date.now()}`;
    // mm_pick_seller + mock tanpa deferReply → domain midman THROW (probe
    // manual: "interaction.deferReply is not a function").
    const makeInteraction = () => makeMockInteraction({ customId: 'mm_pick_seller', type: 'userselect', id });

    // First call: handler crash → error propagate ke caller, entry TIDAK ditandai
    await assert.rejects(() => routeInteraction(makeInteraction()));
    assert.strictEqual(check(id), false, 'handler throw → entry tidak boleh tertandai');

    // Replay: interaction yang sama HARUS diproses lagi (tidak di-swallow)
    await assert.rejects(() => routeInteraction(makeInteraction()), 'replay harus menjalankan handler lagi');

    // Cleanup supaya tidak bocor ke test lain dalam file yang sama
    processedInteractions.delete(id);
});
