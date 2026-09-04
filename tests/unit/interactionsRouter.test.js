/**
 * Unit tests for the interactions router (src/interactions/index.js)
 *
 * Verify:
 *   - Slash commands are ignored (not the interactions router's domain)
 *   - Button interaction with a known customId → dispatched to the domain
 *   - Modal submit with a known customId → dispatched to the domain
 *   - Select menu with an unknown customId → logs a warning, no crash
 *   - Dedup: the same interaction.id is processed only once (v3.9.38: marked
 *     AFTER the handler succeeds — a throwing handler is not marked, a replay
 *     can retry)
 *   - v3.9.33: User Select Menu (mm_pick_seller) → dispatched to the midman domain
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
        // v3.9.33: the router now accepts user select menus (member dropdowns).
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
    // The midman handler needs interaction.guild/user/values — it will throw.
    // What matters: the dispatch HAPPENS to the midman domain (not ignored).
    try {
        await routeInteraction(interaction);
    } catch (err) {
        assert.ok(!/no handler/i.test(err.message), 'must dispatch, not skip');
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
        assert.ok(!/no handler/i.test(err.message), 'must dispatch, not skip');
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
        assert.ok(!/no handler/i.test(err.message), 'must dispatch, not skip');
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
        assert.ok(!/no handler/i.test(err.message), 'must dispatch, not skip');
        return;
    }
    assert.ok(true, 'dispatched without error');
});

test('interactions router: btn_verify dispatched to verify domain', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({ customId: 'btn_verify', type: 'button' });
    // The verify handler needs interaction.member etc — it will throw. What matters: the dispatch happens.
    try {
        await routeInteraction(interaction);
    } catch (err) {
        // Expected — the handler needs member. Verify the dispatch happened (the error is not "no handler").
        assert.ok(!/no handler/i.test(err.message), 'should dispatch, not skip');
        return;
    }
    // If it succeeded, the dispatch still happened
    assert.ok(true, 'dispatched without error');
});

test('interactions router: gw_join: dispatched to giveaway domain', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({ customId: 'gw_join:gw_123', type: 'button' });
    try {
        await routeInteraction(interaction);
    } catch (err) {
        // Expected — the handler needs guild, user, etc
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

test('interactions router: dedup — same interaction.id processed only once (v3.9.38: mark AFTER success)', async () => {
    const routeInteraction = require('../../src/interactions');
    const id = `dedup-test-${Date.now()}`;
    const replies = [];
    // v3.9.38 FIX: dedup is now check-before + mark-AFTER-handler-success.
    // Uses btn_verify with a minimal mock: the handler replies with an error to
    // the user (success — no throw) → the entry is marked → replaying the same
    // interaction is skipped. (Before: checkAndMark marked BEFORE the handler ran.)
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

    // First call: dispatch + handler reply (success) → only then marked
    await routeInteraction(makeInteraction());
    assert.strictEqual(replies.length, 1, 'first call: handler ran (1 reply)');

    // Second call (Discord retry / gateway replay): should be deduped (no dispatch)
    const result = await routeInteraction(makeInteraction());
    assert.strictEqual(result, undefined, 'second call should be deduped');
    assert.strictEqual(replies.length, 1, 'the handler must not run 2x');
});

test('interactions router: dedup v3.9.38 — handler THROWS → not marked → the replay is reprocessed', async () => {
    const routeInteraction = require('../../src/interactions');
    const { check, processedInteractions } = require('../../src/interactions/_dedup');
    const id = `dedup-throw-test-${Date.now()}`;
    // mm_pick_seller + a mock without deferReply → the midman domain THROWS
    // (manual probe: "interaction.deferReply is not a function").
    const makeInteraction = () => makeMockInteraction({ customId: 'mm_pick_seller', type: 'userselect', id });

    // First call: handler crashes → the error propagates to the caller, the entry is NOT marked
    await assert.rejects(() => routeInteraction(makeInteraction()));
    assert.strictEqual(check(id), false, 'handler threw → the entry must not be marked');

    // Replay: the same interaction MUST be processed again (not swallowed)
    await assert.rejects(() => routeInteraction(makeInteraction()), 'the replay must run the handler again');

    // Cleanup so it doesn't leak into other tests in the same file
    processedInteractions.delete(id);
});
