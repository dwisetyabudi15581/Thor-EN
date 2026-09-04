/**
 * Unit tests v3.9.29 — panel edit (modal) + safety-net kategori kosong.
 *
 * Trigger: user report "kemaren saya coba gabisa menaruh link gambar untuk
 * thumbnail tolong cek keseluruhan juga".
 *
 * Yang diuji:
 *   1. handlePanelModal — flow modal /update-panel end-to-end (mock):
 *      simpan CDN URL, clear field, URL invalid, guard panjang 2048.
 *   2. EDITABLE_FIELDS — maxLength modal image/thumbnail = 2048 (regression
 *      guard: dulu 500 → Discord client tolak input URL panjang).
 *   3. FIELD_TO_STORAGE_KEY — patch ditulis ke key penyimpanan yang benar.
 *   4. findEmptyCategoryWarnings — safety-net kategori tanpa produk.
 *   5. buildTicketPanel — thumbnailUrl tersimpan benar-benar dirender.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const panelsPath = path.join(DATA_DIR, 'panels.json');

// ====================================================
// === Sandbox: panels.json produksi snapshot & restore ===
// === (pola ticketFlexibility.test.js)                  ===
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
    channels: {} // tanpa audit-log → logAudit silent-skip
};

/** Mock modal-submit interaction (mirror pola repro + commandsRouter.test). */
function makeModalSubmit({ customId, value }) {
    const replies = [];
    return {
        isModalSubmit: () => true,
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => false,
        // v3.9.33: router kini juga menerima user select menu.
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

/** Buat panel test baru + invalidate cache panelManager. */
function makeTestPanel(extra = {}) {
    const panel = upsertPanel({
        guildId: 'g1',
        channelId: 'c1',
        messageId: 'm1',
        title: 'Panel Test',
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
// === 1. EDITABLE_FIELDS — regression guard maxLength ===
// ====================================================

test('EDITABLE_FIELDS: maxLength modal image/thumbnail = 2048 (bukan 500)', () => {
    assert.strictEqual(EDITABLE_FIELDS.image.max, 2048, 'image.max harus 2048 (limit URL embed Discord)');
    assert.strictEqual(EDITABLE_FIELDS.thumbnail.max, 2048, 'thumbnail.max harus 2048');
    // Bug asli: 500 → URL CDN Discord signed (300-450 char) + query custom
    // gampang tembus 500 → client tolak input modal sebelum submit.
});

test('EDITABLE_FIELDS: field mapping storage key benar (image→imageUrl, thumbnail→thumbnailUrl)', () => {
    assert.strictEqual(FIELD_TO_STORAGE_KEY.image, 'imageUrl');
    assert.strictEqual(FIELD_TO_STORAGE_KEY.thumbnail, 'thumbnailUrl');
    assert.strictEqual(FIELD_TO_STORAGE_KEY.footer, 'footerText');
    assert.strictEqual(FIELD_TO_STORAGE_KEY.title, 'title');
});

// ====================================================
// === 2. handlePanelModal — flow modal end-to-end ===
// ====================================================

test('handlePanelModal: URL thumbnail Discord CDN → tersimpan + dirender di embed', async () => {
    const panel = makeTestPanel();
    // URL CDN signed nyata (~224 char — dulu lolos, tapi ini regression guard)
    const cdnUrl =
        'https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/thumb.png?ex=66d1f2a0&is=66d1f200&hm=abcdef0123456789abcdef0123456789abcdef&format=webp&quality=lossless';

    const interaction = makeModalSubmit({ customId: `modal_panel_edit:${panel.id}:thumbnail`, value: cdnUrl });
    await handlePanelModal(interaction);

    const saved = getPanel(panel.id);
    assert.strictEqual(saved.thumbnailUrl, cdnUrl, 'thumbnailUrl harus tersimpan persis');
    assert.match(lastReply(interaction), /✅.*diupdate/);

    // Render: embed benar-benar punya thumbnail
    const build = buildTicketPanel(saved, {
        guild: { name: 'G' },
        client: TEST_CONFIG.client,
        config: TEST_CONFIG
    });
    assert.strictEqual(build.embed.data.thumbnail?.url, cdnUrl, 'embed harus render thumbnail');
});

test('handlePanelModal: URL panjang 536 char (yang DULU ditolak modal 500) → tersimpan', async () => {
    const panel = makeTestPanel();
    const longUrl = 'https://example.com/images/' + 'a'.repeat(480) + '.png?sig=long';

    const interaction = makeModalSubmit({ customId: `modal_panel_edit:${panel.id}:image`, value: longUrl });
    await handlePanelModal(interaction);

    const saved = getPanel(panel.id);
    assert.strictEqual(saved.imageUrl, longUrl);
    assert.match(lastReply(interaction), /✅/);
});

test('handlePanelModal: URL > 2048 char → ditolak dengan pesan jelas', async () => {
    const panel = makeTestPanel();
    const tooLong = 'https://example.com/' + 'a'.repeat(2100) + '.png';

    const interaction = makeModalSubmit({ customId: `modal_panel_edit:${panel.id}:thumbnail`, value: tooLong });
    await handlePanelModal(interaction);

    const saved = getPanel(panel.id);
    assert.notStrictEqual(saved.thumbnailUrl, tooLong, 'URL > 2048 tidak boleh tersimpan');
    assert.match(lastReply(interaction), /terlalu panjang/);
});

test('handlePanelModal: clear (input kosong) → field jadi null (fallback global)', async () => {
    const panel = makeTestPanel({ thumbnailUrl: 'https://old.example.com/thumb.png' });

    const interaction = makeModalSubmit({ customId: `modal_panel_edit:${panel.id}:thumbnail`, value: '' });
    await handlePanelModal(interaction);

    const saved = getPanel(panel.id);
    assert.strictEqual(saved.thumbnailUrl, null);
});

test('handlePanelModal: URL bukan http(s) → ditolak, field tidak berubah', async () => {
    const panel = makeTestPanel({ thumbnailUrl: 'https://keep.example.com/t.png' });

    const interaction = makeModalSubmit({
        customId: `modal_panel_edit:${panel.id}:thumbnail`,
        value: 'discord.gg/gambar'
    });
    await handlePanelModal(interaction);

    const saved = getPanel(panel.id);
    assert.strictEqual(saved.thumbnailUrl, 'https://keep.example.com/t.png', 'nilai lama tetap');
    assert.match(lastReply(interaction), /tidak valid/);
});

test('handlePanelModal: panel dari guild lain → ditolak (cross-guild guard)', async () => {
    const panel = makeTestPanel({ guildId: 'guild_lain' });
    const interaction = makeModalSubmit({
        customId: `modal_panel_edit:${panel.id}:thumbnail`,
        value: 'https://x.com/t.png'
    });
    await handlePanelModal(interaction);
    assert.match(lastReply(interaction), /bukan milik server ini/);
});

// ====================================================
// === 3. findEmptyCategoryWarnings — safety-net ===
// ====================================================

test('findEmptyCategoryWarnings: kategori jualan kosong → warning actionable', () => {
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
    assert.strictEqual(lines.length, 2, 'transaction + akun_ml kosong → 2 baris');
    // transaction (requiresKey true, kosong) → warning "pakai key tapi belum punya produk"
    assert.match(lines[0], /transaction/);
    assert.match(lines[0], /pakai key/);
    assert.match(lines[1], /akun_ml/);
    assert.match(lines[1], /tambah produk/i);
});

test('findEmptyCategoryWarnings: help/report kosong → TIDAK muncul (quick-action normal)', () => {
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
    assert.strictEqual(lines.length, 0, 'help/report selalu kosong — bukan warning');
});

test('findEmptyCategoryWarnings: kategori berproduk → tidak ada warning', () => {
    const lines = findEmptyCategoryWarnings(
        { categoryIds: ['akun_ml'] },
        {
            ticketCategories: [{ id: 'akun_ml', label: 'Akun ML', requiresKey: false, isDefault: false }],
            products: [{ label: 'Akun ML Mythic', value: 'ml1', price: 'x', category: 'akun_ml' }]
        }
    );
    assert.strictEqual(lines.length, 0);
});

test('findEmptyCategoryWarnings: panel filter categoryIds — kategori di luar filter tidak di-warn', () => {
    const lines = findEmptyCategoryWarnings(
        { categoryIds: ['akun_ml'] },
        {
            ticketCategories: [
                { id: 'akun_ml', label: 'Akun ML', requiresKey: false, isDefault: false },
                { id: 'jasa', label: 'Jasa', requiresKey: false, isDefault: false } // kosong, tapi tidak ditampilkan panel
            ],
            products: [{ label: 'Akun ML', value: 'ml1', price: 'x', category: 'akun_ml' }]
        }
    );
    assert.strictEqual(lines.length, 0, 'jasa tidak di panel ini → tidak di-warn');
});

test('findEmptyCategoryWarnings: produk tanpa field category → dianggap kategori transaction', () => {
    // Produk lama tanpa category → default 'transaction' (mirror logic
    // buildTicketPanel & dropdown). Kalau ada produk seperti itu, transaction
    // tidak boleh dianggap kosong.
    const lines = findEmptyCategoryWarnings(
        { categoryIds: [] },
        {
            ticketCategories: [{ id: 'transaction', label: 'Beli', requiresKey: true }],
            products: [{ label: 'VIP 30 Hari', value: 'vip30', price: 'x' }] // tanpa category
        }
    );
    assert.strictEqual(lines.length, 0, 'produk tanpa category = produk transaction');
});

// ====================================================
// === 4. patchPanel roundtrip — key penyimpanan ===
// ====================================================

test('patchPanel: patch { thumbnailUrl } tidak menimpa field lain (merge benar)', () => {
    const panel = makeTestPanel({ title: 'Judul', imageUrl: 'https://x.com/i.png' });
    const updated = patchPanel(panel.id, { thumbnailUrl: 'https://x.com/t.png' });
    invalidateCache();
    assert.strictEqual(updated.thumbnailUrl, 'https://x.com/t.png');
    assert.strictEqual(updated.imageUrl, 'https://x.com/i.png', 'imageUrl tetap');
    assert.strictEqual(updated.title, 'Judul', 'title tetap');
    assert.ok(updated.updatedAt >= panel.createdAt, 'updatedAt ter-set');
});
