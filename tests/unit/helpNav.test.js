/**
 * Unit tests for the interactive /help navigation (v3.9.39).
 *
 * Verifies:
 *   - Catalog integrity: 19 categories, unique ids, all select-menu options
 *     within Discord limits (label/desc/value ≤ 100, options ≤ 25).
 *   - Every view embed within limits (description ≤ 4096, total ≤ 6000 —
 *     including the 📖 All Commands view which may be 2 embeds in 1 message).
 *   - Search: case-insensitive substring, category name → whole category,
 *     command blocks (bullet + continuation option lines), empty query,
 *     no results.
 *   - Command handler: /help without options → home + components;
 *     /help search:x → search results directly; mocks without
 *     interaction.options stay safe.
 *   - Interaction handler: category dropdown (known/unknown), search button
 *     (showModal), modal submit, home button, all button (1-2 embeds).
 *   - Interaction router: the `help_` prefix routes to the help domain.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    HELP_CATEGORIES,
    HELP_IDS,
    buildHomeEmbed,
    buildCategoryEmbed,
    buildAllEmbeds,
    buildSearchEmbed,
    searchHelp,
    buildHelpComponents,
    embedTotalChars
} = require('../../src/ui/helpCatalog');

const { version: PKG_VERSION } = require('../../package.json');
const { EMBED_LIMITS, DISCORD_LIMITS } = require('../../src/infra/constants');

function makeClient() {
    return {
        user: {
            username: 'TestBot',
            displayAvatarURL: () => 'http://example.com/avatar.png'
        }
    };
}

function catalogAllText() {
    return HELP_CATEGORIES.map(c => c.lines.join('\n')).join('\n');
}

// ====================================================
// === 1. Catalog integrity ===
// ====================================================

test('helpNav: catalog — unique ids, all fields non-empty', () => {
    assert.ok(HELP_CATEGORIES.length >= 15, `too few categories: ${HELP_CATEGORIES.length}`);
    const ids = new Set(HELP_CATEGORIES.map(c => c.id));
    assert.strictEqual(ids.size, HELP_CATEGORIES.length, 'category ids must be unique');
    for (const c of HELP_CATEGORIES) {
        assert.match(c.id, /^[a-z0-9_]+$/, `id must be ascii-safe: ${c.id}`);
        assert.ok(c.emoji && typeof c.emoji === 'string', `emoji required: ${c.id}`);
        assert.ok(c.name && c.name.length <= 100, `name ≤100: ${c.id}`);
        assert.ok(c.short && c.short.length > 0, `short required: ${c.id}`);
        assert.ok(Array.isArray(c.lines) && c.lines.length > 0, `lines required: ${c.id}`);
    }
});

test('helpNav: guard 25 select-menu options (Discord limit)', () => {
    assert.ok(
        HELP_CATEGORIES.length <= DISCORD_LIMITS.SELECT_MENU_MAX_OPTIONS,
        `categories (${HELP_CATEGORIES.length}) exceed max select options (${DISCORD_LIMITS.SELECT_MENU_MAX_OPTIONS}) — split the dropdown into 2 pages`
    );
});

test('helpNav: select options — label/description/value ≤ 100 chars', () => {
    for (const c of HELP_CATEGORIES) {
        assert.ok(c.name.length <= 100, `label ≤100: ${c.id}`);
        assert.ok(c.short.length <= 100, `description ≤100: ${c.id} (${c.short.length})`);
        assert.ok(c.id.length <= 100, `value ≤100: ${c.id}`);
    }
});

test('helpNav: every view embed — description ≤ 4096 & total ≤ 6000', () => {
    const client = makeClient();
    const user = { toString: () => '<@test>' };

    // Home.
    const home = buildHomeEmbed(client, user);
    assert.ok(embedTotalChars(home) <= EMBED_LIMITS.TOTAL_CHARS, 'home ≤ 6000');
    assert.ok((home.data.description?.length || 0) <= EMBED_LIMITS.DESCRIPTION, 'home desc ≤ 4096');

    // Every category.
    for (const c of HELP_CATEGORIES) {
        const embed = buildCategoryEmbed(client, c.id);
        assert.ok(embed, `category must have an embed: ${c.id}`);
        assert.ok(embedTotalChars(embed) <= EMBED_LIMITS.TOTAL_CHARS, `total ≤ 6000: ${c.id}`);
        assert.ok(
            (embed.data.description?.length || 0) <= EMBED_LIMITS.DESCRIPTION,
            `desc ≤ 4096: ${c.id} (${embed.data.description.length})`
        );
        for (const f of embed.data.fields || []) {
            assert.ok(f.value.length <= EMBED_LIMITS.FIELD_VALUE, `field value ≤ 1024: ${c.id}`);
        }
    }

    // All (may be 2 embeds in ONE message — combined total must be ≤ 6000).
    const all = buildAllEmbeds();
    assert.ok(all.length >= 1 && all.length <= 2, `all view 1-2 embeds: ${all.length}`);
    const total = all.reduce((sum, e) => sum + embedTotalChars(e), 0);
    assert.ok(total <= EMBED_LIMITS.TOTAL_CHARS, `all view total ${total} ≤ 6000`);

    // Search (use a query producing many matches).
    const search = buildSearchEmbed('e');
    assert.ok(embedTotalChars(search) <= EMBED_LIMITS.TOTAL_CHARS, 'search ≤ 6000');
    assert.ok((search.data.description?.length || 0) <= EMBED_LIMITS.DESCRIPTION, 'search desc ≤ 4096');
});

// ====================================================
// === 2. Builders ===
// ====================================================

test('helpNav: buildHomeEmbed — category index + instructions + dynamic version', () => {
    const embed = buildHomeEmbed(makeClient(), { toString: () => '<@42>' });
    assert.match(embed.data.title, /HELP/);
    assert.match(embed.data.description, /<@42>/);
    assert.match(embed.data.description, /dropdown/i);
    assert.match(embed.data.description, /Search Commands/);
    assert.match(embed.data.description, /All Commands/);
    assert.match(embed.data.footer.text, new RegExp(`v${PKG_VERSION.replace(/\./g, '\\.')}`));
    // The category index mentions every category name.
    const indexField = embed.data.fields.find(f => /Categories/.test(f.name));
    assert.ok(indexField, 'category index field required');
    for (const c of HELP_CATEGORIES) {
        assert.match(indexField.value, new RegExp(c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
});

test('helpNav: buildCategoryEmbed — known & unknown id', () => {
    const client = makeClient();
    const midman = buildCategoryEmbed(client, 'midman');
    assert.ok(midman);
    assert.match(midman.data.title, /Midman \/ Escrow/);
    assert.match(midman.data.description, /set-midman-fee/);
    // Unknown id (old message after an update) → null, NOT a crash.
    assert.strictEqual(buildCategoryEmbed(client, 'does_not_exist'), null);
    assert.strictEqual(buildCategoryEmbed(client, undefined), null);
});

test('helpNav: buildHelpComponents — dropdown always present + buttons per view', () => {
    const home = buildHelpComponents('home');
    assert.strictEqual(home.length, 2, '2 action rows (select + button)');
    const selectRow = home[0];
    const selectJSON = selectRow.components[0].toJSON();
    assert.strictEqual(selectJSON.custom_id, HELP_IDS.SELECT);
    assert.strictEqual(selectJSON.options.length, HELP_CATEGORIES.length);
    const homeButtons = home[1].components;
    assert.strictEqual(homeButtons.length, 2, 'home: 🔍 + 📖 (no 🏠)');
    assert.ok(homeButtons.every(b => b.toJSON().custom_id !== HELP_IDS.HOME_BUTTON));

    const cat = buildHelpComponents('cat');
    const catButtons = cat[1].components;
    assert.strictEqual(catButtons.length, 3, 'other views: 🔍 + 🏠 + 📖');
    assert.ok(catButtons.some(b => b.toJSON().custom_id === HELP_IDS.HOME_BUTTON));

    // Select option values = category ids.
    const values = selectJSON.options.map(o => o.value);
    for (const c of HELP_CATEGORIES) {
        assert.ok(values.includes(c.id), `select options must include: ${c.id}`);
    }
});

// ====================================================
// === 3. Search ===
// ====================================================

test('helpNav: searchHelp — case-insensitive substring', () => {
    const r1 = searchHelp('set-key');
    assert.ok(r1.groups.some(g => g.cat.id === 'keys'), 'set-key → keys category');
    const r2 = searchHelp('SET-KEY');
    assert.strictEqual(r2.totalBlocks, r1.totalBlocks, 'case-insensitive yields the same result');
});

test('helpNav: searchHelp — category name match → whole category', () => {
    const r = searchHelp('escrow');
    assert.ok(r.totalBlocks > 0);
    const midmanGroup = r.groups.find(g => g.cat.id === 'midman');
    assert.ok(midmanGroup, 'escrow → midman category');
    // Whole-category: every midman block is included (also midman-deals).
    const flat = midmanGroup.blocks.map(b => b.join('\n')).join('\n');
    assert.match(flat, /midman-deals/);
});

test('helpNav: searchHelp — a bullet block carries its continuation option lines', () => {
    // "use_dropdown" lives on a continuation option line of /setup-ticket-panel.
    const r = searchHelp('use_dropdown');
    const panelGroup = r.groups.find(g => g.cat.id === 'panels');
    assert.ok(panelGroup, 'use_dropdown → panels category');
    const flat = panelGroup.blocks.map(b => b.join('\n')).join('\n');
    assert.match(flat, /setup-ticket-panel/, 'the matched block must contain its bullet command');
});

test('helpNav: searchHelp — empty query & no results', () => {
    const empty = searchHelp('');
    assert.strictEqual(empty.emptyQuery, true);
    assert.strictEqual(empty.groups.length, 0);
    const spaces = searchHelp('   ');
    assert.strictEqual(spaces.emptyQuery, true);
    const none = searchHelp('zzzz-nothing-here');
    assert.strictEqual(none.groups.length, 0);
    assert.strictEqual(none.totalBlocks, 0);
    assert.strictEqual(none.emptyQuery, false);
});

test('helpNav: buildSearchEmbed — results, empty & no-result paths', () => {
    const hit = buildSearchEmbed('panel');
    assert.match(hit.data.title, /Search Results/);
    assert.match(hit.data.description, /panel/);
    assert.match(hit.data.description, /results found/);

    const empty = buildSearchEmbed('');
    assert.match(empty.data.description, /Empty keyword/);

    const none = buildSearchEmbed('zzzz-nothing-here');
    assert.match(none.data.description, /No matching commands/);
});

test('helpNav: buildSearchEmbed — results capped so the embed stays small', () => {
    // A super-wide 1-letter query → there must be a truncation note, not a giant embed.
    const wide = buildSearchEmbed('e');
    assert.ok((wide.data.description?.length || 0) <= EMBED_LIMITS.DESCRIPTION, 'desc ≤ 4096 even for wide matches');
    assert.match(wide.data.description, /not shown|more specific/);
});

// ====================================================
// === 4. Command handler (/help) ===
// ====================================================

test('helpNav: /help without options → home view + components + ephemeral', async () => {
    const replies = [];
    const mock = {
        user: { toString: () => '<@test>' },
        client: makeClient(),
        reply: async opts => {
            replies.push(opts);
            return {};
        }
    };
    const helpHandler = require('../../src/commands/help');
    await helpHandler(mock);
    assert.strictEqual(replies.length, 1);
    const { embeds, components, flags } = replies[0];
    assert.ok(embeds[0], 'embed required');
    assert.match(embeds[0].data.title, /HELP/);
    assert.strictEqual(components.length, 2, 'select row + button row');
    assert.strictEqual(components[0].components[0].toJSON().custom_id, HELP_IDS.SELECT);
    assert.strictEqual(flags, 64, 'ephemeral (MessageFlags.Ephemeral)');
});

test('helpNav: /help search:key → search results directly', async () => {
    const replies = [];
    const mock = {
        user: { toString: () => '<@test>' },
        client: makeClient(),
        options: { getString: name => (name === 'search' ? 'key' : null) },
        reply: async opts => {
            replies.push(opts);
            return {};
        }
    };
    const helpHandler = require('../../src/commands/help');
    await helpHandler(mock);
    assert.match(replies[0].embeds[0].data.title, /Search Results/);
    assert.match(replies[0].embeds[0].data.description, /key/);
    assert.strictEqual(replies[0].components.length, 2);
});

test('helpNav: /help search with whitespace-only value → treated as no query (home)', async () => {
    const replies = [];
    const mock = {
        user: { toString: () => '<@test>' },
        client: makeClient(),
        options: { getString: () => '   ' },
        reply: async opts => {
            replies.push(opts);
            return {};
        }
    };
    const helpHandler = require('../../src/commands/help');
    await helpHandler(mock);
    assert.match(replies[0].embeds[0].data.title, /HELP/);
});

// ====================================================
// === 5. Interaction handler (navigation) ===
// ====================================================

function makeComponentInteraction(overrides = {}) {
    const updates = [];
    const shown = [];
    return {
        i: {
            customId: 'help_cat',
            id: `helpnav-${Date.now()}-${Math.random()}`,
            replied: false,
            deferred: false,
            isRepliable: () => true,
            isChatInputCommand: () => false,
            isButton: () => false,
            isStringSelectMenu: () => true,
            isUserSelectMenu: () => false,
            isModalSubmit: () => false,
            client: makeClient(),
            user: { toString: () => '<@test>' },
            values: ['midman'],
            update: async opts => {
                updates.push(opts);
                return {};
            },
            showModal: async modal => {
                shown.push(modal);
                return {};
            },
            fields: { getTextInputValue: () => 'panel' },
            ...overrides
        },
        updates,
        shown
    };
}

test('helpNav: dropdown category pick → update with the category embed', async () => {
    const { i, updates } = makeComponentInteraction();
    const handler = require('../../src/interactions/help');
    await handler(i);
    assert.strictEqual(updates.length, 1);
    assert.match(updates[0].embeds[0].data.title, /Midman \/ Escrow/);
    assert.ok(updates[0].components[1].components.some(b => b.toJSON().custom_id === HELP_IDS.HOME_BUTTON));
});

test('helpNav: unknown dropdown value (old message) → home fallback, no crash', async () => {
    const { i, updates } = makeComponentInteraction({ values: ['category_was_deleted'] });
    const handler = require('../../src/interactions/help');
    await handler(i);
    assert.strictEqual(updates.length, 1);
    assert.match(updates[0].embeds[0].data.title, /HELP/);
});

test('helpNav: 🔍 button → showModal with a required input', async () => {
    const { i, shown } = makeComponentInteraction({ customId: 'help_search', isButton: () => true, isStringSelectMenu: () => false });
    const handler = require('../../src/interactions/help');
    await handler(i);
    assert.strictEqual(shown.length, 1);
    const modalJSON = shown[0].toJSON();
    assert.strictEqual(modalJSON.custom_id, HELP_IDS.SEARCH_MODAL);
    const input = modalJSON.components[0].components[0];
    assert.strictEqual(input.custom_id, HELP_IDS.SEARCH_INPUT);
    assert.strictEqual(input.required, true);
});

test('helpNav: modal submit → update with search results', async () => {
    const { i, updates } = makeComponentInteraction({
        customId: 'help_search_modal',
        isButton: () => false,
        isStringSelectMenu: () => false,
        isModalSubmit: () => true
    });
    const handler = require('../../src/interactions/help');
    await handler(i);
    assert.strictEqual(updates.length, 1);
    assert.match(updates[0].embeds[0].data.title, /Search Results/);
    assert.match(updates[0].embeds[0].data.description, /panel/);
});

test('helpNav: 🏠 button → update with home', async () => {
    const { i, updates } = makeComponentInteraction({
        customId: 'help_home',
        isButton: () => true,
        isStringSelectMenu: () => false
    });
    const handler = require('../../src/interactions/help');
    await handler(i);
    assert.strictEqual(updates.length, 1);
    assert.match(updates[0].embeds[0].data.title, /HELP/);
    assert.ok(!updates[0].components[1].components.some(b => b.toJSON().custom_id === HELP_IDS.HOME_BUTTON));
});

test('helpNav: 📖 button → update with the full list (1-2 embeds, total ≤ 6000)', async () => {
    const { i, updates } = makeComponentInteraction({
        customId: 'help_all',
        isButton: () => true,
        isStringSelectMenu: () => false
    });
    const handler = require('../../src/interactions/help');
    await handler(i);
    assert.strictEqual(updates.length, 1);
    const embeds = updates[0].embeds;
    assert.ok(embeds.length >= 1 && embeds.length <= 2);
    const total = embeds.reduce((sum, e) => sum + embedTotalChars(e), 0);
    assert.ok(total <= EMBED_LIMITS.TOTAL_CHARS, `total ${total} ≤ 6000`);
});

test('helpNav: foreign help_* customId → warning, no crash', async () => {
    const { i } = makeComponentInteraction({
        customId: 'help_mysterious',
        isButton: () => true,
        isStringSelectMenu: () => false
    });
    const handler = require('../../src/interactions/help');
    await handler(i); // must not throw
    assert.ok(true);
});

// ====================================================
// === 6. Interaction router — help_ prefix ===
// ====================================================

test('helpNav: router — select help_cat dispatched to the help domain (update called)', async () => {
    const routeInteraction = require('../../src/interactions');
    const { i, updates } = makeComponentInteraction();
    await routeInteraction(i);
    assert.strictEqual(updates.length, 1, 'must dispatch & run the handler (not an unknown warning)');
});

test('helpNav: router — button help_search dispatched (showModal called)', async () => {
    const routeInteraction = require('../../src/interactions');
    const { i, shown } = makeComponentInteraction({
        customId: 'help_search',
        isButton: () => true,
        isStringSelectMenu: () => false
    });
    await routeInteraction(i);
    assert.strictEqual(shown.length, 1);
});

test('helpNav: old content intact in the catalog (regression v3.9.37/v3.9.38)', () => {
    const allText = catalogAllText();
    // Auto-Split 3 categories + midman (previously in the giant embed — now in the catalog).
    assert.match(allText, /3 categories/);
    assert.doesNotMatch(allText, /2 categories/);
    assert.match(allText, /ESCROW/);
    assert.match(allText, /midman\.category/);
    assert.match(allText, /set-midman-fee/);
    assert.match(allText, /midman-deals/);
    assert.match(allText, /set-role midman/);
    assert.match(allText, /verified\/unverified\/admin\/\*\*midman\*\*/);
    // Panels & popular commands.
    assert.match(allText, /list-panels/);
    assert.match(allText, /update-panel/);
    assert.match(allText, /use_dropdown/);
    assert.match(allText, /update-category/);
    assert.match(allText, /update-product/);
});
