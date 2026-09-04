/**
 * Measure embed size untuk SEMUA command handler yang reply embed.
 * Cari yang potensi exceed 6000 char.
 *
 * Strategy: panggil setiap command handler dengan mock interaction,
 * capture embed yang direply, hitung total char.
 */
const path = require('path');

const replyLog = [];

function makeMockInteraction(commandName) {
    return {
        commandName,
        user: { toString: () => '<@test>', tag: 'TestUser#1234', id: '999' },
        guild: {
            name: 'Test Server',
            id: '123',
            memberCount: 100,
            members: {
                fetch: async () => ({
                    roles: { cache: { has: () => false }, add: async () => {}, remove: async () => {} },
                    user: { tag: 'Test', send: async () => {} }
                })
            },
            roles: { cache: { get: () => ({ name: 'TestRole' }) } },
            channels: { cache: { get: () => null } }
        },
        channel: { send: async opts => opts, edit: async () => ({}) },
        client: {
            user: {
                username: 'TestBot',
                displayAvatarURL: () => 'http://example.com/avatar.png'
            }
        },
        member: { roles: { cache: { has: () => false } }, permissions: { has: () => true } },
        options: {
            getString: () => null,
            getBoolean: () => null,
            getChannel: () => ({ id: '1', type: 0, name: 'test' }),
            getRole: () => ({ id: '1', name: 'TestRole' }),
            getUser: () => ({ id: '999', tag: 'TestUser', send: async () => {} }),
            getSubcommand: () => null,
            getInteger: () => null,
            getNumber: () => null,
            getMember: () => null
        },
        deferred: false,
        replied: false,
        deferReply: async () => {
            this.deferred = true;
        },
        editReply: async opts => {
            measureEmbed(opts, commandName);
            return {};
        },
        reply: async opts => {
            measureEmbed(opts, commandName);
            return {};
        },
        showModal: async () => {}
    };
}

function measureEmbed(opts, commandName) {
    if (!opts || !opts.embeds || !opts.embeds[0]) return;
    const embed = opts.embeds[0];
    const data = embed.data || embed;
    let total = 0;
    if (data.title) total += data.title.length;
    if (data.description) total += data.description.length;
    if (data.fields) {
        for (const f of data.fields) {
            total += (f.name || '').length + (f.value || '').length;
        }
    }
    if (data.footer && data.footer.text) total += data.footer.text.length;
    if (data.author && data.author.name) total += data.author.name.length;
    replyLog.push({ commandName, total, fields: data.fields?.length || 0 });
}

async function test() {
    const commands = [
        'help',
        'config-show',
        'list-products',
        'list-categories',
        'list-messages',
        'list-keys',
        'list-panels',
        'stats',
        'leaderboard',
        'list-level-roles'
    ];

    for (const cmd of commands) {
        try {
            const handler = require(
                `../src/commands/${
                    cmd === 'config-show' || cmd === 'list-messages' || cmd === 'list-products'
                        ? 'config'
                        : cmd === 'list-categories'
                          ? 'categories'
                          : cmd === 'list-keys'
                            ? 'keys'
                            : cmd === 'list-panels'
                              ? 'panels-mgmt'
                              : cmd === 'stats' || cmd === 'leaderboard'
                                ? 'stats'
                                : cmd === 'list-level-roles'
                                  ? 'leveling'
                                  : 'help'
                }`
            );
            const interaction = makeMockInteraction(cmd);
            await handler(interaction);
        } catch (err) {
            // ignore — kita cuma peduli embed yang berhasil direply
        }
    }

    console.log('=== Embed size report ===');
    replyLog.sort((a, b) => b.total - a.total);
    for (const r of replyLog) {
        const status = r.total > 6000 ? '❌ EXCEED' : r.total > 5000 ? '⚠️ HIGH' : '✅';
        console.log(`  /${r.commandName}: ${r.total} char (${r.fields} fields) ${status}`);
    }
}

test().catch(err => console.error('Error:', err.message));
