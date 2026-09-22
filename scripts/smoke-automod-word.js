/**
 * End-to-end smoke test for the new automod commands (v3.9.23 WORD FLEX).
 * Simulates mock interactions → makes sure every handler runs without errors
 * and the data state is correct.
 *
 * Run: node scripts/smoke-automod-word.js
 */

const handler = require('../src/commands/automod');

function makeMockInteraction({ commandName, options = {} }) {
    return {
        commandName,
        deferred: false,
        replied: false,
        guild: { id: 'smoke_guild_automod' },
        user: { id: 'smoke_user', tag: 'SmokeUser' },
        client: {
            channels: {
                cache: { get: () => null },
                fetch: async () => null
            }
        },
        options: {
            getString: name => (options[name] !== undefined ? options[name] : null),
            getChannel: name => (options[name] !== undefined ? options[name] : null),
            getRole: name => (options[name] !== undefined ? options[name] : null),
            getInteger: name => (options[name] !== undefined ? options[name] : null),
            getBoolean: name => (options[name] !== undefined ? options[name] : null)
        },
        deferReply: async () => {},
        editReply: async opts => {
            const summary = JSON.stringify(opts, (key, value) => (value && value.toJSON ? value.toJSON() : value));
            console.log(`  → [${commandName}] reply: ${summary.slice(0, 300)}${summary.length > 300 ? '…' : ''}`);
            return {};
        }
    };
}

(async () => {
    console.log('1. /add-word blocklist + action mute_10m');
    await handler(
        makeMockInteraction({
            commandName: 'add-word',
            options: { words: 'smokeword1, smokeword2', action: 'mute_10m' }
        })
    );

    console.log('\n2. /add-word duplicate (must skip)');
    await handler(makeMockInteraction({ commandName: 'add-word', options: { words: 'smokeword1' } }));

    console.log('\n3. /add-word tipe exempt');
    await handler(makeMockInteraction({ commandName: 'add-word', options: { words: 'smokesafe', tipe: 'exempt' } }));

    console.log('\n4. /list-words');
    await handler(makeMockInteraction({ commandName: 'list-words' }));

    console.log('\n5. /remove-word (existing)');
    await handler(makeMockInteraction({ commandName: 'remove-word', options: { word: 'smokeword1' } }));

    console.log('\n6. /remove-word (not found)');
    await handler(makeMockInteraction({ commandName: 'remove-word', options: { word: 'tidakada' } }));

    console.log('\n7. /automod-show');
    await handler(makeMockInteraction({ commandName: 'automod-show' }));

    console.log('\n8. /remove-link-whitelist without arguments (must show an error message)');
    await handler(makeMockInteraction({ commandName: 'remove-link-whitelist' }));

    console.log('\n9. /add-link-whitelist + /remove-link-whitelist with a role');
    await handler(
        makeMockInteraction({
            commandName: 'add-link-whitelist',
            options: { role: { id: 'role123', name: 'TestRole' } }
        })
    );
    await handler(
        makeMockInteraction({
            commandName: 'remove-link-whitelist',
            options: { role: { id: 'role123', name: 'TestRole' } }
        })
    );

    console.log('\n10. /set-automod bulk replace (block_words + word_action)');
    await handler(
        makeMockInteraction({
            commandName: 'set-automod',
            options: { block_words: 'bulk1, bulk2', word_action: 'warn' }
        })
    );

    console.log('\n11. /automod-toggle');
    await handler(makeMockInteraction({ commandName: 'automod-toggle', options: { enabled: true } }));

    // === Verify the final state ===
    const { getGuildConfig, findViolatedWord } = require('../src/data/automodManager');
    const config = getGuildConfig('smoke_guild_automod');

    console.log('\n=== FINAL STATE ===');
    console.log('wordRules   :', JSON.stringify(config.wordRules.map(r => ({ word: r.word, action: r.action }))));
    console.log('exemptWords :', JSON.stringify(config.exemptWords));
    console.log('wordAction  :', config.wordAction, '| matchMode:', config.wordMatchMode);

    // Sanity: end-to-end violation detection from the state produced by the commands
    const v = findViolatedWord('cek bulk1 dong', config);
    if (!v || v.word !== 'bulk1') throw new Error('FAIL: bulk1 must be detected as a violation');
    if (v.action !== null) throw new Error('FAIL: bulk1 without a specific action must be null (global fallback)');
    console.log('\nviolation check OK:', JSON.stringify(v), '(falls back to wordAction=warn)');

    // === v3.9.24: cleanup residue — previous smoke tests used to leave the
    // smoke_guild_automod guild behind forever in the production data/automod.json.
    const fs = require('fs');
    const path = require('path');
    const { safeWriteJSON } = require('../src/infra/safeWrite');
    const automodPath = path.join(__dirname, '..', 'data', 'automod.json');
    try {
        if (fs.existsSync(automodPath)) {
            const data = JSON.parse(fs.readFileSync(automodPath, 'utf8'));
            if (data && typeof data === 'object' && !Array.isArray(data) && 'smoke_guild_automod' in data) {
                delete data.smoke_guild_automod;
                safeWriteJSON(automodPath, data);
                console.log('🧹 smoke_guild_automod residue cleaned from data/automod.json');
            }
        }
    } catch (cleanupErr) {
        console.warn('⚠️ Residue cleanup failed (not fatal):', cleanupErr.message);
    }

    console.log('\n✅ SMOKE TEST PASS — all v3.9.23 handlers ran without errors');
})().catch(err => {
    console.error('❌ SMOKE FAIL:', err);
    process.exit(1);
});
