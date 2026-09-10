/**
 * Unit tests for the /help category `detail` blocks (v3.9.52).
 *
 * v3.9.52 (user request: "update /help too so everything is in sync") adds an
 * optional `detail` array per help category: richer usage documentation that
 * renders ONLY in the 📂 category detail view. The 📖 All Commands embed and
 * 🔍 Search keep rendering the compact `lines` — the All-Commands budget had
 * only ~7 chars of slack (5793/5800), so a detail leak would silently drop
 * the last category from the full listing.
 *
 * Verifies:
 *   - Statistics category detail: /serverstats setup/remove/refresh usage,
 *     auto-update + rate-limit explanation, boost notification guidance.
 *   - Quick Start + Logging & Channels detail blocks present.
 *   - All-Commands embed does NOT contain detail text, stays within the 5800
 *     budget, and keeps ALL 20 categories (no silent drop).
 *   - Categories without `detail` render exactly as before (backward compat).
 *   - Every category view description stays ≤ 4096 (Discord limit).
 *   - Search scans only `lines`: the command name finds /serverstats, but a
 *     detail-only phrase ("self-heal") never leaks into search results.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    HELP_CATEGORIES,
    buildCategoryEmbed,
    buildAllEmbeds,
    searchHelp,
    embedTotalChars
} = require('../../src/ui/helpCatalog');

const { EMBED_LIMITS } = require('../../src/infra/constants');

function findCat(id) {
    return HELP_CATEGORIES.find(c => c.id === id);
}

// ====================================================
// === 1. Statistics category — extended usage docs ===
// ====================================================

test('helpDetail: stats category has a detail block documenting /serverstats', () => {
    const cat = findCat('stats');
    assert.ok(cat, 'stats category must exist');
    assert.ok(Array.isArray(cat.detail) && cat.detail.length > 0, 'stats category needs a detail array');
    const text = cat.detail.join('\n');

    // /serverstats usage: setup + remove + refresh (the 3 subcommands).
    assert.match(text, /\/serverstats setup/, 'detail must document `setup`');
    assert.match(text, /\/serverstats remove/, 'detail must document `remove`');
    assert.match(text, /\/serverstats refresh/, 'detail must document `refresh`');

    // The live-counter promise (what the user asked for — like ServerStats bots).
    assert.match(text, /Members/i, 'detail must name the Members counter');
    assert.match(text, /Boosts/i, 'detail must name the Boosts counter');
    assert.match(text, /rate-limit/i, 'detail must explain the rate-limit safety');

    // Boost notification guidance → the server-booster channel.
    assert.match(text, /server-booster/, 'detail must mention the server-booster channel');
});

test('helpDetail: stats category detail renders in the category view', () => {
    const embed = buildCategoryEmbed(null, 'stats');
    assert.ok(embed, 'category embed must build');
    const desc = embed.toJSON().description;
    // Compact command list first…
    assert.match(desc, /• `\/stats` — live server stats/);
    // …then the extended detail.
    assert.match(desc, /\/serverstats setup/);
    assert.match(desc, /Boost notifications/);
});

// ====================================================
// === 2. Quick Start + Logging detail blocks ===
// ====================================================

test('helpDetail: quickstart detail suggests /serverstats setup as optional', () => {
    const cat = findCat('quickstart');
    const text = (cat.detail || []).join('\n');
    assert.match(text, /\/serverstats setup/, 'quickstart detail should point at the live counters');
    // The 5 numbered steps themselves must stay unchanged (All-Commands budget).
    assert.strictEqual(
        cat.lines.length,
        7,
        'quickstart lines count changed — All-Commands budget is budget-critical'
    );
});

test('helpDetail: logging detail explains the boost auto-announcement', () => {
    const cat = findCat('logging');
    const text = (cat.detail || []).join('\n');
    assert.match(text, /server-booster/, 'logging detail must mention the server-booster channel');
    assert.match(text, /BOOST_ADD/, 'logging detail must mention the server-log event types');
});

// ====================================================
// === 3. All-Commands embed — detail must NOT leak ===
// ====================================================

test('helpDetail: All-Commands embed excludes detail text and keeps all 20 categories', () => {
    const embeds = buildAllEmbeds();
    assert.strictEqual(embeds.length, 1, 'All-Commands is a single embed');
    const total = embedTotalChars(embeds[0]);
    const json = embeds[0].toJSON();

    // Budget contract — the exact reason `detail` exists (7 chars of slack!).
    assert.ok(total <= 5800, `All-Commands total ${total} exceeds the 5800 budget`);
    assert.strictEqual(json.fields.length, HELP_CATEGORIES.length, 'every category must stay in the full listing');

    // Detail-only phrases must never appear in the full listing.
    const all = JSON.stringify(json);
    assert.ok(!all.includes('/serverstats setup'), 'detail leaked into All-Commands');
    assert.ok(!all.includes('Boost notifications'), 'detail leaked into All-Commands');
    assert.ok(!all.includes('self-heal'), 'detail leaked into All-Commands');
});

test('helpDetail: categories without detail render exactly as before', () => {
    for (const cat of HELP_CATEGORIES) {
        if (cat.detail) continue;
        const desc = buildCategoryEmbed(null, cat.id).toJSON().description;
        assert.strictEqual(desc, cat.lines.join('\n'), `category ${cat.id} without detail must render lines only`);
    }
});

// ====================================================
// === 4. Discord limits + search contract ===
// ====================================================

test('helpDetail: every category view description stays within 4096', () => {
    for (const cat of HELP_CATEGORIES) {
        const embed = buildCategoryEmbed(null, cat.id);
        assert.ok(embed, `category ${cat.id} must build`);
        const desc = embed.toJSON().description;
        assert.ok(
            desc.length <= EMBED_LIMITS.DESCRIPTION,
            `category ${cat.id} description ${desc.length} > ${EMBED_LIMITS.DESCRIPTION}`
        );
    }
});

test('helpDetail: search scans lines only — command findable, detail phrases not', () => {
    // The command name still finds the compact line.
    const result = searchHelp('serverstats');
    assert.ok(result.totalBlocks >= 1, 'searching "serverstats" must find the command');
    const stats = result.groups.find(g => g.cat.id === 'stats');
    assert.ok(stats, 'stats category must be in the results');
    assert.match(stats.blocks.map(b => b.join('\n')).join('\n'), /\/serverstats/);

    // Detail-only phrasing must NOT leak into search results.
    const leak = searchHelp('self-heal');
    assert.strictEqual(leak.totalBlocks, 0, 'detail-only phrases must not be searchable');
});
