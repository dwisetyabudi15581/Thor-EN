/**
 * Unit tests untuk commands router (src/commands/index.js)
 *
 * Verify:
 *   - Non-admin ditolak untuk command non-public
 *   - Public commands (leaderboard, my-stats) diizinkan untuk non-admin
 *   - Unknown command di-handle gracefully
 *   - Domain handler dipanggil dengan benar
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
                has: perm => isAdmin // ManageGuild = true kalau isAdmin
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
    assert.match(interaction._replies[0].opts.content, /Akses Ditolak/);
});

test('router: non-admin allowed for public command (leaderboard)', async () => {
    const routeCommand = require('../../src/commands');
    const interaction = makeMockInteraction({ commandName: 'leaderboard', isAdmin: false });
    // leaderboard handler akan throw karena interaction.options undefined — itu OK,
    // yang penting router TIDAK reject di permission check.
    try {
        await routeCommand(interaction);
    } catch (err) {
        // Expected — handler internal error karena mock interaction tidak lengkap.
        // Yang kita cek: TIDAK ada reply "Akses Ditolak".
        const blockedReply = interaction._replies.find(r => /Akses Ditolak/.test(r.opts?.content || ''));
        assert.ok(!blockedReply, 'should not be blocked by permission check');
        return;
    }
    // Kalau sukses (tidak throw), pastikan tidak ada reply blocked
    const blockedReply = interaction._replies.find(r => /Akses Ditolak/.test(r.opts?.content || ''));
    assert.ok(!blockedReply, 'should not be blocked by permission check');
});

test('router: non-admin allowed for public command (my-stats)', async () => {
    const routeCommand = require('../../src/commands');
    const interaction = makeMockInteraction({ commandName: 'my-stats', isAdmin: false });
    try {
        await routeCommand(interaction);
    } catch (err) {
        const blockedReply = interaction._replies.find(r => /Akses Ditolak/.test(r.opts?.content || ''));
        assert.ok(!blockedReply, 'should not be blocked');
        return;
    }
    const blockedReply = interaction._replies.find(r => /Akses Ditolak/.test(r.opts?.content || ''));
    assert.ok(!blockedReply, 'should not be blocked');
});

test('router: admin not blocked by permission check', async () => {
    const routeCommand = require('../../src/commands');
    const interaction = makeMockInteraction({ commandName: 'help', isAdmin: true });
    try {
        await routeCommand(interaction);
    } catch (err) {
        // help handler butuh interaction.client — akan throw. Yang penting: tidak ada "Akses Ditolak".
        const blockedReply = interaction._replies.find(r => /Akses Ditolak/.test(r.opts?.content || ''));
        assert.ok(!blockedReply, 'admin should not be blocked');
        return;
    }
    const blockedReply = interaction._replies.find(r => /Akses Ditolak/.test(r.opts?.content || ''));
    assert.ok(!blockedReply, 'admin should not be blocked');
});

test('router: unknown command returns "belum didukung" reply', async () => {
    const routeCommand = require('../../src/commands');
    const interaction = makeMockInteraction({ commandName: 'totally-fake-command', isAdmin: true });
    await routeCommand(interaction);
    assert.strictEqual(interaction._replies.length, 1);
    assert.match(interaction._replies[0].opts.content, /belum didukung|tidak dikenali|not registered/i);
});

// ====================================================
// === v3.9.24: guard anti "command terdaftar tapi tidak di-route" ===
// ====================================================
// Bug nyata: /update-category & /update-product terdaftar di registry, punya
// handler, diiklankan di /help — tapi tidak ada di COMMAND_TO_DOMAIN → selalu
// error "belum didukung oleh router". Test ini memastikan TIDAK ADA command
// registry yang lolos tanpa mapping (test lama yang grep source text tidak
// bisa menangkap bug seperti ini).

test('v3.9.24 GUARD: setiap command di registry punya mapping domain di router', () => {
    const { getCommands } = require('../../src/commands/registry');
    const routeCommand = require('../../src/commands');
    const map = routeCommand.COMMAND_TO_DOMAIN;
    const handlers = routeCommand.DOMAIN_HANDLERS;

    const commands = getCommands();
    assert.ok(commands.length >= 80, `registry seharusnya punya 80+ command, dapat ${commands.length}`);

    for (const cmd of commands) {
        const domain = map[cmd.name];
        assert.ok(
            domain,
            `/${cmd.name} terdaftar di registry tapi TIDAK ada di COMMAND_TO_DOMAIN — akan selalu error "belum didukung router"!`
        );
        assert.ok(
            handlers[domain],
            `/${cmd.name} di-map ke domain "${domain}" tapi DOMAIN_HANDLERS tidak punya handler-nya!`
        );
    }
});

test('v3.9.24 FIX: /update-category & /update-product sekarang ter-route (bug lama: selalu error)', () => {
    const routeCommand = require('../../src/commands');
    const map = routeCommand.COMMAND_TO_DOMAIN;
    assert.strictEqual(map['update-category'], 'categories', 'update-category harus ke domain categories');
    assert.strictEqual(map['update-product'], 'products', 'update-product harus ke domain products');
});
