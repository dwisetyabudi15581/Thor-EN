/**
 * Measure embed size untuk semua command yang reply embed.
 * Discord max: 6000 char total per embed.
 */
const path = require('path');

// Mock interaction minimal
function makeMockInteraction() {
    return {
        user: { toString: () => '<@test>', tag: 'TestUser#1234' },
        guild: { name: 'Test Server', id: '123', memberCount: 100 },
        client: {
            user: {
                username: 'TestBot',
                displayAvatarURL: () => 'http://example.com/avatar.png'
            }
        },
        member: { roles: { cache: { has: () => false } } },
        options: {
            getString: () => null,
            getBoolean: () => null,
            getChannel: () => null,
            getRole: () => null,
            getUser: () => null,
            getSubcommand: () => null,
            getInteger: () => null,
            getNumber: () => null
        },
        deferReply: async () => {},
        editReply: async opts => {
            // Measure embed size
            if (opts && opts.embeds && opts.embeds[0]) {
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
                console.log(`  Embed size: ${total} char (limit 6000) ${total > 6000 ? '❌ EXCEED' : '✅'}`);
                if (total > 6000) {
                    console.log(`    Title: ${data.title?.length || 0}`);
                    console.log(`    Description: ${data.description?.length || 0}`);
                    if (data.fields) {
                        data.fields.forEach((f, i) => {
                            console.log(
                                `    Field[${i}] "${f.name}": name=${f.name.length}, value=${(f.value || '').length}`
                            );
                        });
                    }
                }
            }
            return {};
        },
        reply: async opts => {
            if (opts && opts.embeds && opts.embeds[0]) {
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
                console.log(`  Embed size: ${total} char (limit 6000) ${total > 6000 ? '❌ EXCEED' : '✅'}`);
                if (total > 6000) {
                    console.log(`    Title: ${data.title?.length || 0}`);
                    console.log(`    Description: ${data.description?.length || 0}`);
                    if (data.fields) {
                        data.fields.forEach((f, i) => {
                            console.log(
                                `    Field[${i}] "${f.name}": name=${f.name.length}, value=${(f.value || '').length}`
                            );
                        });
                    }
                }
            }
            return {};
        }
    };
}

async function testHelp() {
    console.log('=== /help ===');
    const helpHandler = require('../src/commands/help');
    await helpHandler(makeMockInteraction());
}

testHelp().catch(err => {
    console.error('Error:', err.message);
});
