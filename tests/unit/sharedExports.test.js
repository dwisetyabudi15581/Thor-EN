/**
 * Unit tests v3.9.45 — PermissionFlagsBits hotfix + _shared safety net.
 *
 * Bug timeline: v3.9.43 added the moderation pack; moderation.js destructured
 * PermissionFlagsBits from './_shared', but _shared.js never exported it
 * → undefined at runtime → every /purge /timeout /untimeout /kick /ban crashed:
 *   TypeError: Cannot read properties of undefined (reading 'ManageMessages')
 * Why it slipped past every QC gate (457 green tests + clean ESLint): a missing
 * export in destructuring does NOT throw at require time — the variable silently
 * becomes undefined, and no test executed the moderation permission-check path
 * with the real module graph. This test closes that hole permanently.
 *
 * What is guarded:
 *   A. PermissionFlagsBits is exported by _shared and is the very same object
 *      discord.js exports (same reference), plus the moderation bits exist:
 *      ModerateMembers / ManageMessages / KickMembers / BanMembers / ViewChannel.
 *   B. SAFETY NET (whole bug class, not just this instance): every src/** file
 *      that destructures anything from _shared — every binding identifier MUST
 *      exist in _shared's runtime exports. A future missing export fails here
 *      at test time, instead of crashing in production the first time a user
 *      runs the command.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PermissionFlagsBits, MessageFlags } = require('../../src/commands/_shared');
const { PermissionFlagsBits: RealPermissionFlagsBits } = require('discord.js');

test('A. _shared exports the real discord.js PermissionFlagsBits + all moderation bits', () => {
    assert.ok(PermissionFlagsBits, 'PermissionFlagsBits must be defined in _shared (v3.9.44 bug: undefined)');
    assert.strictEqual(PermissionFlagsBits, RealPermissionFlagsBits, 'must be the same discord.js object, not an imitation');
    for (const bit of ['ModerateMembers', 'ManageMessages', 'KickMembers', 'BanMembers', 'ViewChannel']) {
        assert.ok(PermissionFlagsBits[bit], `bit ${bit} must exist (used by bot permission checks in moderation/midman)`);
    }
    assert.ok(MessageFlags, 'MessageFlags still exported (old contract intact)');
});

test('B. safety net: every identifier destructured from require(..._shared) exists in runtime exports', () => {
    const shared = require('../../src/commands/_shared');
    const ROOT = path.resolve(__dirname, '../../src');
    const re = /const\s*\{([^{}]*)\}\s*=\s*require\(\s*['"][^'"]*_shared['"]\s*\)/g;

    const violations = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.js') || entry.name === '_shared.js') continue;
            // strip line comments so comments inside a destructure block are not
            // misparsed as fake identifiers.
            const src = fs.readFileSync(full, 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');
            for (const m of src.matchAll(re)) {
                for (const raw of m[1].split(',')) {
                    let name = raw.trim();
                    if (!name) continue;
                    if (name.includes(':')) name = name.split(':')[1].trim(); // { key: binding }
                    if (name.includes('=')) name = name.split('=')[0].trim(); // { binding = fallback }
                    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
                    if (!(name in shared)) {
                        violations.push(`${path.relative(ROOT, full)} → "${name}" destructured but NOT exported by _shared`);
                    }
                }
            }
        }
    };
    walk(ROOT);
    assert.deepStrictEqual(violations, [],
        `destructures from _shared that are silently undefined (runtime crash):\n${violations.join('\n')}`);
});
