/**
 * Unit tests v3.9.29 — panel edit (modal) + empty-category safety net.
 *
 * Trigger: user report "kemaren saya coba gabisa menaruh link gambar untuk
 * thumbnail tolong cek keseluruhan juga" (couldn't put an image link for the
 * thumbnail yesterday, please check everything).
 *
 * What is tested:
 *   1. handlePanelModal — the end-to-end /update-panel modal flow (mocked):
 *      save a CDN URL, clear a field, invalid URL, 2048-length guard.
 *   2. EDITABLE_FIELDS — modal maxLength for image/thumbnail = 2048 (regression
 *      guard: it used to be 500 → the Discord client rejected long URL input).
 *   3. FIELD_TO_STORAGE_KEY — the patch is written to the right storage key.
 *   4. findEmptyCategoryWarnings — safety net for categories without products.
 *   5. buildTicketPanel — a stored thumbnailUrl is actually rendered.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const panelsPath = path.join(DATA_DIR, 'panels.json');

// ====================================================
// === Sandbox: production panels.json snapshotted & restored ===
// === (pattern from ticketFlexibility.test.js)                ===
// ====================================================
const panelsBackedUp = fs.existsSync(panelsPath);
if (panelsBackedUp) fs.copyFileSync(panelsPath, panelsPath + '.test-backup');
process.on('exit', () => {
    try {
        if (panelsBackedUp) {
            fs.copyFileSync(panelsPath + '.test-backup', panelsPath);
            fs.rmSync(panelsPath + '.test-backup', { force: true });
        } else if (fs.existsSync(panelsPath)) {
            fs.unlinkSync(panelsPath);
        }
    } catch (_) {}
});

const { upsertPanel, getPanel, patchPanel, invalidateCache } = require('../../src/data/panelManager');
const { handlePanelModal, EDITABLE_FIELDS, FIELD_TO_STORAGE_KEY } = require('../../src/commands/panels-mgmt');
const { buildTicketPanel, findEmptyCategoryWarnings } = require('../../src/commands/panels');

const TEST_CONFIG = {
    ticketCategories: [
        { id: 'transaction', label: 'Beli', emoji: '🔑', style: 'Primary', requiresKey: true },
        { id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false },
        { id: 'akun_ml', label: 'Akun ML', emoji: '🎮', style: 'Success', requiresKey: false, isDefault: false }
    ],
    products: [{ label: 'Akun ML Mythic', value: 'ml1', price: 'Rp 150k', category: 'akun_ml', requiresKey: false }],
    messages: { ticketTitle: 'T', ticketBody: 'B', ticketPriceHeader: 'P' },
    channels: {} // no audit-log → logAudit silently skips
};

/** Mock modal-submit interaction (mirrors the repro pattern + commandsRouter.test). */
function makeModalSubmit({ customId, value }) {
    const replies = [];
    return {
        isModalSubmit: () => true,
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => false,
        // v3.9.33: the router now also accepts user select menus.
        isUserSelectMenu: () => false,
        customId,
        replied: false,
        deferred: false,
        member: { permissions: { has: () => true }, roles: { cache: new Map() } },
        user: { id: 'u1', tag: 'admin#0001' },
        guild: {
            id: 'g1',
            channels: {
                fetch: async () => ({
                    messages: {
                        fetch: async () => ({ edit: async () => ({}) })
                    }
                })
            }
        },
        client: { channels: { cache: new Map() }, user: { username: 'Bot', displayAvatarURL: () => 'http://x' } },
        fields: { getTextInputValue: () => value },
        deferReply: async () => ({}),
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        reply: async opts => {
            replies.push(opts);
            return {};
        },
        followUp: async opts => {
            replies.push(opts);
            return {};
        },
        _replies: replies
    };
}

function lastReply(interaction) {
    return interaction._replies[interaction._replies.length - 1]?.content || '';
}

/** Create a fresh test panel + invalidate the panelManager cache. */
function makeTestPanel(extra = {}) {
    const panel = upsertPanel({
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm1',
        title: 'Test Panel',
        body: 'Body',
        color: null,
        categoryIds: [],
        useDropdown: true,
        ...extra
    });
    invalidateCache();
    return panel;
}

// ====================================================
// === 1. EDITABLE_FIELDS — maxLength regression guard ===
// ====================================================

test('EDITABLE_FIELDS: modal maxLength image/thumbnail = 2048 (not 500)', () => {
    assert.strictEqual(EDITABLE_FIELDS.image.max, 2048, 'image.max must be 2048 (Discord embed URL limit)');
    assert.strictEqual(EDITABLE_FIELDS.thumbnail.max, 2048, 'thumbnail.max must be 2048');
    // Original bug: 500 → signed Discord CDN URLs (300-450 chars) + custom query
    // params easily exceed 500 → the client rejects the modal input before submit.
});

test('EDITABLE_FIELDS: field mapping to storage key is correct (image→imageUrl, thumbnail→thumbnailUrl)', () => {
    assert.strictEqual(FIELD_TO_STORAGE_KEY.image, 'imageUrl');
    assert.strictEqual(FIELD_TO_STORAGE_KEY.thumbnail, 'thumbnailUrl');
    assert.strictEqual(FIELD_TO_STORAGE_KEY.footer, 'footerText');
    assert.strictEqual(FIELD_TO_STORAGE_KEY.title, 'title');
});

// ====================================================
// === 2. handlePanelModal — end-to-end modal flow ===
// ====================================================

test('handlePanelModal: Discord CDN thumbnail URL → saved + rendered in the embed', async () => {
    const panel = makeTestPanel();
    // A real signed CDN URL (~224 chars — used to pass, but this is a regression guard)
    const cdnUrl =
        'https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/thumb.png?ex=66d1f2a0&is=66d1f200&hm=abcdef0123456789abcdef0123456789abcdef&format=webp&quality=lossless';

    const interaction = makeModalSubmit({ customId: `modal_panel_edit:${panel.id}:thumbnail`, value: cdnUrl });
    await handlePanelModal(interaction);

    const saved = getPanel(panel.id);
    assert.strictEqual(saved.thumbnailUrl, cdnUrl, 'thumbnailUrl must be saved verbatim');
    assert.match(lastReply(interaction), /✅.*updated/);

    // Render: the embed actually has the thumbnail
    const build = buildTicketPanel(saved, {
        guild: { name: 'G' },
        client: TEST_CONFIG.client,
        config: TEST_CONFIG
    });
    assert.strictEqual(build.embed.data.thumbnail?.url, cdnUrl, 'the embed must render the thumbnail');
});

test('handlePanelModal: 536-char URL (which the 500-char modal USED to reject) → saved', async () => {
    const panel = makeTestPanel();
    const longUrl = 'https://example.com/images/' + 'a'.repeat(480) + '.png?sig=long';

    const interaction = makeModalSubmit({ customId: `modal_panel_edit:${panel.id}:image`, value: longUrl });
    await handlePanelModal(interaction);

    const saved = getPanel(panel.id);
    assert.strictEqual(saved.imageUrl, longUrl);
    assert.match(lastReply(interaction), /✅/);
});

test('handlePanelModal: URL > 2048 chars → rejected with a clear message', async () => {
    const panel = makeTestPanel();
    const tooLong = 'https://example.com/' + 'a'.repeat(2100) + '.png';

    const interaction = makeModalSubmit({ customId: `modal_panel_edit:${panel.id}:thumbnail`, value: tooLong });
    await handlePanelModal(interaction);

    const saved = getPanel(panel.id);
    assert.notStrictEqual(saved.thumbnailUrl, tooLong, 'URLs > 2048 must not be saved');
    assert.match(lastReply(interaction), /too long/);
});

test('handlePanelModal: clear (empty input) → field becomes null (global fallback)', async () => {
    const panel = makeTestPanel({ thumbnailUrl: 'https://old.example.com/thumb.png' });

    const interaction = makeModalSubmit({ customId: `modal_panel_edit:${panel.id}:thumbnail`, value: '' });
    await handlePanelModal(interaction);

    const saved = getPanel(panel.id);
    assert.strictEqual(saved.thumbnailUrl, null);
});

test('handlePanelModal: non-http(s) URL → rejected, field unchanged', async () => {
    const panel = makeTestPanel({ thumbnailUrl: 'https://keep.example.com/t.png' });

    const interaction = makeModalSubmit({
        customId: `modal_panel_edit:${panel.id}:thumbnail`,
        value: 'discord.gg/gambar'
    });
    await handlePanelModal(interaction);

    const saved = getPanel(panel.id);
    assert.strictEqual(saved.thumbnailUrl, 'https://keep.example.com/t.png', 'the old value stays');
    assert.match(lastReply(interaction), /Invalid .* URL/);
});

test('handlePanelModal: panel from another guild → rejected (cross-guild guard)', async () => {
    const panel = makeTestPanel({ guildId: 'guild_lain' });
    const interaction = makeModalSubmit({
        customId: `modal_panel_edit:${panel.id}:thumbnail`,
        value: 'https://x.com/t.png'
    });
    await handlePanelModal(interaction);
    assert.match(lastReply(interaction), /belongs to another server/);
});

// ====================================================
// === 3. findEmptyCategoryWarnings — safety net ===
// ====================================================

test('findEmptyCategoryWarnings: empty sales category → actionable warning', () => {
    const lines = findEmptyCategoryWarnings(
        { categoryIds: [] },
        {
            ticketCategories: [
                { id: 'transaction', label: 'Beli', requiresKey: true },
                { id: 'akun_ml', label: 'Akun ML', requiresKey: false, isDefault: false }
            ],
            products: []
        }
    );
    assert.strictEqual(lines.length, 2, 'transaction + akun_ml empty → 2 lines');
    // transaction (requiresKey true, empty) → warning "uses keys but has no products yet"
    assert.match(lines[0], /transaction/);
    assert.match(lines[0], /use keys/);
    assert.match(lines[1], /akun_ml/);
    assert.match(lines[1], /add products/i);
});

test('findEmptyCategoryWarnings: empty help/report → NOT shown (normal quick action)', () => {
    const lines = findEmptyCategoryWarnings(
        { categoryIds: [] },
        {
            ticketCategories: [
                { id: 'help', label: 'Help', requiresKey: false },
                { id: 'report', label: 'Report', requiresKey: false }
            ],
            products: []
        }
    );
    assert.strictEqual(lines.length, 0, 'help/report are always empty — not a warning');
});

test('findEmptyCategoryWarnings: category with products → no warning', () => {
    const lines = findEmptyCategoryWarnings(
        { categoryIds: ['akun_ml'] },
        {
            ticketCategories: [{ id: 'akun_ml', label: 'Akun ML', requiresKey: false, isDefault: false }],
            products: [{ label: 'Akun ML Mythic', value: 'ml1', price: 'x', category: 'akun_ml' }]
        }
    );
    assert.strictEqual(lines.length, 0);
});

test('findEmptyCategoryWarnings: panel categoryIds filter — categories outside the filter are not warned', () => {
    const lines = findEmptyCategoryWarnings(
        { categoryIds: ['akun_ml'] },
        {
            ticketCategories: [
                { id: 'akun_ml', label: 'Akun ML', requiresKey: false, isDefault: false },
                { id: 'jasa', label: 'Jasa', requiresKey: false, isDefault: false } // empty, but not shown on this panel
            ],
            products: [{ label: 'Akun ML', value: 'ml1', price: 'x', category: 'akun_ml' }]
        }
    );
    assert.strictEqual(lines.length, 0, 'jasa is not on this panel → not warned');
});

test('findEmptyCategoryWarnings: product without a category field → counted as the transaction category', () => {
    // Old products without a category → default 'transaction' (mirrors the
    // buildTicketPanel & dropdown logic). If such a product exists, transaction
    // must not be considered empty.
    const lines = findEmptyCategoryWarnings(
        { categoryIds: [] },
        {
            ticketCategories: [{ id: 'transaction', label: 'Beli', requiresKey: true }],
            products: [{ label: 'VIP 30 Hari', value: 'vip30', price: 'x' }] // no category field
        }
    );
    assert.strictEqual(lines.length, 0, 'a product without a category = a transaction product');
});

// ====================================================
// === 4. patchPanel roundtrip — storage keys ===
// ====================================================

test('patchPanel: patch { thumbnailUrl } does not overwrite other fields (correct merge)', () => {
    const panel = makeTestPanel({ title: 'Title', imageUrl: 'https://x.com/i.png' });
    const updated = patchPanel(panel.id, { thumbnailUrl: 'https://x.com/t.png' });
    invalidateCache();
    assert.strictEqual(updated.thumbnailUrl, 'https://x.com/t.png');
    assert.strictEqual(updated.imageUrl, 'https://x.com/i.png', 'imageUrl unchanged');
    assert.strictEqual(updated.title, 'Title', 'title unchanged');
    assert.ok(updated.updatedAt >= panel.createdAt, 'updatedAt is set');
});
