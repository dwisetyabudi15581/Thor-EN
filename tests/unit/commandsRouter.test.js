/**
 * Unit tests for the commands router (src/commands/index.js)
 *
 * Verify:
 *   - Non-admin is rejected for non-public commands
 *   - Public commands (leaderboard, my-stats) are allowed for non-admins
 *   - Unknown commands are handled gracefully
 *   - Domain handlers are invoked correctly
 */

const test = require('node:test');
const assert = require('node:assert');

// Mock interaction object
function makeMockInteraction({ commandName, isAdmin = false, isRepliable = true }) {
    const replies = [];
    return {
        isChatInputCommand: () => true,
        commandName,
        isRepliable: () => isRepliable,
        replied: false,
        deferred: false,
        member: {
            permissions: {
                has: perm => isAdmin // ManageGuild = true when isAdmin
            },
            roles: { cache: { has: () => false } }
        },
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
}

test('router: non-admin rejected for non-public command', async () => {
    const routeCommand = require('../../src/commands');
    const interaction = makeMockInteraction({ commandName: 'set-role', isAdmin: false });
    await routeCommand(interaction);
    assert.strictEqual(interaction._replies.length, 1);
    assert.match(interaction._replies[0].opts.content, /Access Denied/);
});

test('router: non-admin allowed for public command (leaderboard)', async () => {
    const routeCommand = require('../../src/commands');
    const interaction = makeMockInteraction({ commandName: 'leaderboard', isAdmin: false });
    // The leaderboard handler will throw because interaction.options is undefined — that's OK,
    // what matters is the router does NOT reject at the permission check.
    try {
        await routeCommand(interaction);
    } catch (err) {
        // Expected — internal handler error because the mock interaction is incomplete.
        // What we check: there is NO "Access Denied" reply.
        const blockedReply = interaction._replies.find(r => /Access Denied/.test(r.opts?.content || ''));
        assert.ok(!blockedReply, 'should not be blocked by permission check');
        return;
    }
    // If it succeeded (no throw), make sure there is no blocked reply
    const blockedReply = interaction._replies.find(r => /Access Denied/.test(r.opts?.content || ''));
    assert.ok(!blockedReply, 'should not be blocked by permission check');
});

test('router: non-admin allowed for public command (my-stats)', async () => {
    const routeCommand = require('../../src/commands');
    const interaction = makeMockInteraction({ commandName: 'my-stats', isAdmin: false });
    try {
        await routeCommand(interaction);
    } catch (err) {
        const blockedReply = interaction._replies.find(r => /Access Denied/.test(r.opts?.content || ''));
        assert.ok(!blockedReply, 'should not be blocked');
        return;
    }
    const blockedReply = interaction._replies.find(r => /Access Denied/.test(r.opts?.content || ''));
    assert.ok(!blockedReply, 'should not be blocked');
});

test('router: admin not blocked by permission check', async () => {
    const routeCommand = require('../../src/commands');
    const interaction = makeMockInteraction({ commandName: 'help', isAdmin: true });
    try {
        await routeCommand(interaction);
    } catch (err) {
        // The help handler needs interaction.client — it will throw. What matters: no "Access Denied".
        const blockedReply = interaction._replies.find(r => /Access Denied/.test(r.opts?.content || ''));
        assert.ok(!blockedReply, 'admin should not be blocked');
        return;
    }
    const blockedReply = interaction._replies.find(r => /Access Denied/.test(r.opts?.content || ''));
    assert.ok(!blockedReply, 'admin should not be blocked');
});

test('router: unknown command returns "not supported" reply', async () => {
    const routeCommand = require('../../src/commands');
    const interaction = makeMockInteraction({ commandName: 'totally-fake-command', isAdmin: true });
    await routeCommand(interaction);
    assert.strictEqual(interaction._replies.length, 1);
    assert.match(interaction._replies[0].opts.content, /not supported by the router/i);
});

// ====================================================
// === v3.9.24: guard against "command registered but not routed" ===
// ====================================================
// Real bug: /update-category & /update-product were registered in the
// registry, had a handler, were advertised in /help — but were missing from
// COMMAND_TO_DOMAIN → always errored with "not supported by the router".
// This test makes sure NO registry command slips through without a mapping
// (the old test that grepped source text couldn't catch a bug like this).

test('v3.9.24 GUARD: every registry command has a router domain mapping', () => {
    const { getCommands } = require('../../src/commands/registry');
    const routeCommand = require('../../src/commands');
    const map = routeCommand.COMMAND_TO_DOMAIN;
    const handlers = routeCommand.DOMAIN_HANDLERS;

    const commands = getCommands();
    assert.ok(commands.length >= 80, `registry should have 80+ commands, got ${commands.length}`);

    for (const cmd of commands) {
        const domain = map[cmd.name];
        assert.ok(
            domain,
            `/${cmd.name} is registered in the registry but is NOT in COMMAND_TO_DOMAIN — it would always error with "not supported by the router"!`
        );
        assert.ok(
            handlers[domain],
            `/${cmd.name} is mapped to domain "${domain}" but DOMAIN_HANDLERS has no handler for it!`
        );
    }
});

test('v3.9.24 FIX: /update-category & /update-product are now routed (old bug: always error)', () => {
    const routeCommand = require('../../src/commands');
    const map = routeCommand.COMMAND_TO_DOMAIN;
    assert.strictEqual(map['update-category'], 'categories', 'update-category must go to the categories domain');
    assert.strictEqual(map['update-product'], 'products', 'update-product must go to the products domain');
});
