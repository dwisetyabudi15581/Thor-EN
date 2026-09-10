/**
 * Unit tests for the /help category `detail` guides (v3.9.52 → v3.9.53).
 *
 * v3.9.52 added an optional per-category `detail` array. v3.9.53 (user
 * request: "rewrite /help so every category's slash commands get
 * explanations — members should not have to ask") makes `detail` the FULL
 * category view: when present it IS the description (a self-contained
 * per-command guide with syntax + behavior + FAQs), while the compact
 * `lines` remain the content of the 📖 All Commands embed (5793/5800 — only
 * 7 chars of slack; a guide leak would silently drop the last category)
 * and the 🔍 Search index.
 *
 * Verifies:
 *   - EVERY category carries a non-empty `detail` guide (the rewrite).
 *   - The category view renders the guide (not the compact lines).
 *   - Guides document real commands: each guide mentions at least one
 *     `/command` that also exists in the category's `lines`.
 *   - All-Commands embed excludes guide text, stays within the 5800 budget,
 *     and keeps ALL 20 categories (no silent drop).
 *   - Statistics guide documents the v3.9.53 counter-selection options.
 *   - Every category view description stays ≤ 4096 (Discord limit).
 *   - Search scans only `lines` (command findable; guide-only phrase never
 *     leaks into results).
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
// === 1. Every category is a full guide ===
// ====================================================

test('helpDetail: EVERY category has a non-empty detail guide (v3.9.53 rewrite)', () => {
    assert.strictEqual(HELP_CATEGORIES.length, 20, 'expected the 20-category catalog');
    for (const cat of HELP_CATEGORIES) {
        assert.ok(
            Array.isArray(cat.detail) && cat.detail.length >= 3,
            `category ${cat.id} needs a full detail guide (got ${cat.detail ? cat.detail.length : 'none'} lines)`
        );
    }
});

test('helpDetail: the category view renders the guide, not the compact lines', () => {
    for (const cat of HELP_CATEGORIES) {
        const desc = buildCategoryEmbed(null, cat.id).toJSON().description;
        assert.strictEqual(desc, cat.detail.join('\n'), `category ${cat.id} view must be exactly its guide`);
    }
});

test('helpDetail: each guide documents real commands that also exist in lines', () => {
    for (const cat of HELP_CATEGORIES) {
        const guide = cat.detail.join('\n');
        const commands = [...cat.lines.join('\n').matchAll(/`\/([a-z-]+)/g)].map(m => m[1]);
        const documented = commands.filter(cmd => guide.includes(`/${cmd}`));
        assert.ok(
            documented.length >= Math.min(1, commands.length),
            `guide for ${cat.id} must mention at least one real command`
        );
    }
});

// ====================================================
// === 2. All-Commands embed — guides must NOT leak ===
// ====================================================

test('helpDetail: All-Commands embed excludes guide text and keeps all 20 categories', () => {
    const embeds = buildAllEmbeds();
    assert.strictEqual(embeds.length, 1, 'All-Commands is a single embed');
    const total = embedTotalChars(embeds[0]);
    const json = embeds[0].toJSON();

    // Budget contract — the exact reason the guides live in `detail` (7 chars!).
    assert.ok(total <= 5800, `All-Commands total ${total} exceeds the 5800 budget`);
    assert.strictEqual(json.fields.length, HELP_CATEGORIES.length, 'every category must stay in the full listing');

    // Guide-only phrases must never appear in the full listing.
    const all = JSON.stringify(json);
    assert.ok(!all.includes('Pick which counters'), 'guide leaked into All-Commands');
    assert.ok(!all.includes('self-heal'), 'guide leaked into All-Commands');
    assert.ok(!all.includes('Why can'), 'FAQ phrasing leaked into All-Commands');
});

// ====================================================
// === 3. Statistics guide — the v3.9.53 options ===
// ====================================================

test('helpDetail: stats guide documents the counter-selection options', () => {
    const guide = findCat('stats').detail.join('\n');
    assert.match(guide, /\/serverstats setup/, 'must document setup');
    assert.match(guide, /\/serverstats remove/, 'must document remove');
    assert.match(guide, /\/serverstats refresh/, 'must document refresh');
    assert.match(guide, /bots/, 'must name the bots option');
    assert.match(guide, /False/, 'must explain False = skip');
    assert.match(guide, /rate-limit/i, 'must explain the rate-limit safety');
    assert.match(guide, /server-booster/, 'must mention the boost channel');
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

test('helpDetail: search scans lines only — command findable, guide phrases not', () => {
    // The command name still finds the compact line.
    const result = searchHelp('serverstats');
    assert.ok(result.totalBlocks >= 1, 'searching "serverstats" must find the command');
    const stats = result.groups.find(g => g.cat.id === 'stats');
    assert.ok(stats, 'stats category must be in the results');
    assert.match(stats.blocks.map(b => b.join('\n')).join('\n'), /\/serverstats/);

    // Guide-only phrasing must NOT leak into search results.
    const leak = searchHelp('self-heal');
    assert.strictEqual(leak.totalBlocks, 0, 'guide-only phrases must not be searchable');
});
