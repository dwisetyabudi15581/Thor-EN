/**
 * Unit tests v3.9.28 — KEAMANAN MENAMBAH KATEGORI BARU.
 *
 * Pertanyaan user: "Bagaimana jika saya menambahkan kategori baru seperti
 * akun ML atau lisensi key — apakah sudah aman?"
 *
 * Jawaban yang dibuktikan test ini:
 *   1. classifyProduct(): SEMUA kategori baru (id ≠ 'help'/'report') otomatis
 *      diklasifikasi TRANSAKSI — tidak perlu ubah code sama sekali.
 *      - 'akun_ml' + requiresKey: false  → TRANSAKSI + tombol 📦 Kirim Pesanan
 *      - 'lisensi_key' + requiresKey: true → TRANSAKSI + tombol 🔑 Set Key
 *   2. Roundtrip data: classifyProduct → setTicketMeta → getTicketMeta →
 *      resolveTicketType → keputusan tombol yang benar.
 *   3. /add-product: produk mewarisi requiresKey dari kategori (admin tidak
 *      perlu set requires_key per produk kalau kategorinya sudah benar).
 *   4. panels.js dropdown: deskripsi menghitung produk key/non-key aktual
 *      (kategori campur → "N tanpa key / M pakai key").
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const configPath = path.join(DATA_DIR, 'config.json');
const ticketsPath = path.join(DATA_DIR, 'tickets.json');

// ====================================================
// === Sandbox: snapshot & restore config.json + tickets.json ===
// === (file produksi ada — pola ticketNonKey.test.js)         ===
// ====================================================
const SANDBOX_FILES = ['config.json', 'tickets.json'];
const backups = new Map();
for (const f of SANDBOX_FILES) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) {
        fs.copyFileSync(p, p + '.test-backup');
        backups.set(f, true);
    }
}
process.on('exit', () => {
    for (const f of SANDBOX_FILES) {
        const p = path.join(DATA_DIR, f);
        try {
            if (backups.has(f)) {
                fs.copyFileSync(p + '.test-backup', p);
                fs.rmSync(p + '.test-backup', { force: true });
            } else if (fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
        } catch (_) {}
    }
});

/** Tulis config.json terkontrol untuk test (tanpa audit channel → logAudit skip). */
function writeTestConfig(cfg) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

function resetTicketsFile() {
    if (fs.existsSync(ticketsPath)) fs.unlinkSync(ticketsPath);
}

const {
    classifyProduct,
    setTicketMeta,
    getTicketMeta,
    patchTicketMeta,
    resolveTicketType
} = require('../../src/data/ticketManager');

// ====================================================
// === 1. classifyProduct — skenario kategori BARU ===
// === (pertanyaan user: akun ML & lisensi key)     ===
// ====================================================

test('classifyProduct: kategori baru "akun_ml" produk non-key → TRANSAKSI tanpa key', () => {
    // /add-category id:akun_ml requires_key:false → /add-product value:ml_legend requires_key:false
    const t = classifyProduct({
        label: 'Akun ML Mythic',
        value: 'ml_legend',
        price: 'Rp 150.000',
        category: 'akun_ml',
        requiresKey: false
    });
    assert.strictEqual(t.isTransaction, true, 'akun_ml HARUS transaksi (bukan bantuan)');
    assert.strictEqual(t.requiresKey, false, 'produk akun tidak pakai key');
});

test('classifyProduct: kategori baru "lisensi_key" produk key → TRANSAKSI pakai key', () => {
    const t = classifyProduct({
        label: 'Windows 11 Pro OEM',
        value: 'win11_pro',
        price: 'Rp 150.000',
        category: 'lisensi_key',
        requiresKey: true
    });
    assert.strictEqual(t.isTransaction, true, 'lisensi_key HARUS transaksi');
    assert.strictEqual(t.requiresKey, true, 'lisensi pakai key');
});

test('classifyProduct: produk di kategori baru TANPA flag requiresKey → default pakai key (gotcha)', () => {
    // Admin lupa set requires_key di kategori DAN produk → default true.
    // Ini PERILAKU BERDASARKAN (bukan bug): produk transaksi dianggap pakai key
    // sampai admin eksplisit bilang tidak. Admin akun ML wajib set requires_key:false.
    const t = classifyProduct({ label: 'Akun ML', value: 'ml1', price: 'x', category: 'akun_ml' });
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, true, 'tanpa flag → default pakai key (Set Key)');
});

test('classifyProduct: hanya id "help"/"report" yang spesial — id lain apa pun = transaksi', () => {
    // Kategori custom apa pun (jasa, topup, event, konsultasi, ...) → transaksi.
    for (const catId of ['jasa', 'topup', 'event', 'bantuan_premium', 'konsultasi', 'Akun_ML-1']) {
        const t = classifyProduct({ label: 'X', value: 'x', price: 'x', category: catId, requiresKey: false });
        assert.strictEqual(t.isTransaction, true, `kategori "${catId}" harus transaksi`);
    }
    // 'bantuan_premium' ≠ 'help' → tetap transaksi (tidak ada magic-string prefix).
});

test('classifyProduct: kategori help/report/isHelp → BANTUAN (bukan transaksi)', () => {
    for (const product of [
        { label: 'Help', category: 'help', isHelp: true, requiresKey: false },
        { label: 'Report', category: 'report', isHelp: true, requiresKey: false },
        { label: 'Custom', category: 'event', isHelp: true, requiresKey: false } // objek sintetis kategori tanpa produk
    ]) {
        const t = classifyProduct(product);
        assert.strictEqual(t.isTransaction, false, `${product.label} harus bantuan`);
        assert.strictEqual(t.requiresKey, false);
    }
});

test('classifyProduct: null/undefined product → aman (bukan transaksi)', () => {
    assert.deepStrictEqual(classifyProduct(null), { isTransaction: false, requiresKey: false });
    assert.deepStrictEqual(classifyProduct(undefined), { isTransaction: false, requiresKey: false });
});

// ====================================================
// === 2. Roundtrip: meta tiket kategori baru → resolveTicketType ===
// === (menjamin tombol close/deliver/set_key benar)              ===
// ====================================================

test('roundtrip: tiket akun_ml (non-key) → Kirim Pesanan diizinkan, Set Key ditolak', () => {
    resetTicketsFile();
    const product = {
        label: 'Akun ML Mythic',
        value: 'ml_legend',
        price: 'Rp 150.000',
        category: 'akun_ml',
        requiresKey: false
    };
    // createTicket (v3.9.27+) menyimpan hasil classifyProduct ke meta:
    const { isTransaction, requiresKey } = classifyProduct(product);
    setTicketMeta('ch_akun_ml_1', {
        userId: 'user_ml',
        productName: product.value,
        price: product.price,
        guildId: 'g1',
        category: product.category,
        requiresKey,
        isTransaction
    });

    const meta = getTicketMeta('ch_akun_ml_1', '');
    const type = resolveTicketType(meta);
    assert.strictEqual(type.isTransaction, true, 'tiket akun ML = transaksi');
    assert.strictEqual(type.requiresKey, false);

    // Matriks tombol (mirror logic ticket.js):
    // - ticket_deliver: butuh isTransaction && !requiresKey && !isCompleted → ALLOW
    const deliverAllowed = type.isTransaction && !type.requiresKey && !type.isCompleted;
    assert.strictEqual(deliverAllowed, true, 'tombol 📦 Kirim Pesanan harus aktif');
    // - ticket_set_key: ditolak untuk non-key (defense-in-depth)
    const setKeyAllowed = type.isTransaction && type.requiresKey;
    assert.strictEqual(setKeyAllowed, false, 'tombol 🔑 Set Key harus ditolak');
    // - close: non-key + belum dikirim → "Pesanan Sukses" muncul
    const showOrderSuccess = type.isTransaction && !type.requiresKey && !type.isCompleted;
    assert.strictEqual(showOrderSuccess, true, 'tombol ✅ Pesanan Sukses harus muncul');
});

test('roundtrip: tiket lisensi_key → Set Key diizinkan, Kirim Pesanan ditolak', () => {
    resetTicketsFile();
    const product = {
        label: 'Windows 11 Pro OEM',
        value: 'win11_pro',
        price: 'Rp 150.000',
        category: 'lisensi_key',
        requiresKey: true
    };
    const { isTransaction, requiresKey } = classifyProduct(product);
    setTicketMeta('ch_lisensi_1', {
        userId: 'user_win',
        productName: product.value,
        price: product.price,
        guildId: 'g1',
        category: product.category,
        requiresKey,
        isTransaction
    });

    const type = resolveTicketType(getTicketMeta('ch_lisensi_1', ''));
    assert.strictEqual(type.isTransaction, true);
    assert.strictEqual(type.requiresKey, true);
    const setKeyAllowed = type.isTransaction && type.requiresKey;
    assert.strictEqual(setKeyAllowed, true, 'tombol 🔑 Set Key harus aktif');
    const deliverAllowed = type.isTransaction && !type.requiresKey && !type.isCompleted;
    assert.strictEqual(deliverAllowed, false, 'tombol 📦 Kirim Pesanan harus ditolak');
});

test('roundtrip: setelah Kirim Pesanan (isCompleted) → close gaya "Selesai", deliver ditolak', () => {
    resetTicketsFile();
    setTicketMeta('ch_ml_2', {
        userId: 'u9',
        productName: 'ml_legend',
        price: 'Rp 150.000',
        guildId: 'g1',
        category: 'akun_ml',
        requiresKey: false,
        isTransaction: true
    });
    patchTicketMeta('ch_ml_2', { isCompleted: true, isInvoiceSent: true, deliveredAt: Date.now() });

    const type = resolveTicketType(getTicketMeta('ch_ml_2', ''));
    assert.strictEqual(type.isCompleted, true);
    const deliverAllowed = type.isTransaction && !type.requiresKey && !type.isCompleted;
    assert.strictEqual(deliverAllowed, false, 'Kirim Pesanan kedua kali harus ditolak (anti-dobel)');
});

// ====================================================
// === 3. /add-product — pewarisan requiresKey dari kategori ===
// === (jalankan handler ASLI dengan mock interaction)        ===
// ====================================================

function makeAddProductInteraction({ label, value, price, category, requiresKey }) {
    const replies = [];
    const stringOpts = { label, value, price, duration: null, category };
    return {
        isChatInputCommand: () => true,
        commandName: 'add-product',
        replied: false,
        deferred: false,
        member: { permissions: { has: () => true }, roles: { cache: { has: () => false } } },
        user: { id: 'admin_test', tag: 'admin#0001' },
        guild: { id: 'guild_test' },
        client: { channels: { cache: new Map() } },
        options: {
            getString: name => stringOpts[name] ?? null,
            getBoolean: name => (name === 'requires_key' ? requiresKey : null)
        },
        deferReply: async () => {
            replies.push({ type: 'defer', opts: {} });
            return {};
        },
        editReply: async opts => {
            replies.push({ type: 'editReply', opts });
            return {};
        },
        followUp: async opts => {
            replies.push({ type: 'followUp', opts });
            return {};
        },
        reply: async opts => {
            replies.push({ type: 'reply', opts });
            return {};
        },
        _replies: replies
    };
}

test('add-product: produk di kategori non-key mewarisi requiresKey:false tanpa opsi eksplisit', async () => {
    const { getConfig, saveConfig } = require('../../src/data/configManager');
    const productsHandler = require('../../src/commands/products');

    // Setup: kategori baru "akun_ml" requiresKey:false (dari /add-category).
    const cfg = getConfig();
    const originalCategories = cfg.ticketCategories || [];
    const originalProducts = cfg.products || [];
    const originalChannels = { ...(cfg.channels || {}) };
    delete originalChannels['audit-log']; // logAudit silent-skip
    cfg.channels = originalChannels;
    cfg.ticketCategories = [
        ...originalCategories.filter(c => c.id !== 'akun_ml'),
        { id: 'akun_ml', label: 'Akun ML', emoji: '🎮', style: 'Success', requiresKey: false, isDefault: false }
    ];
    cfg.products = originalProducts.filter(p => p.value !== 'ml_test_1');
    saveConfig(cfg);

    // Admin TIDAK set requires_key (null) → harus mewarisi false dari kategori.
    const interaction = makeAddProductInteraction({
        label: 'Akun ML Mythic',
        value: 'ml_test_1',
        price: 'Rp 150.000',
        category: 'akun_ml',
        requiresKey: null
    });
    await productsHandler(interaction);

    const saved = getConfig().products.find(p => p.value === 'ml_test_1');
    assert.ok(saved, 'produk harus tersimpan');
    assert.strictEqual(saved.category, 'akun_ml');
    assert.strictEqual(saved.requiresKey, false, 'mewarisi requiresKey:false dari kategori akun_ml');
    assert.match(interaction._replies[interaction._replies.length - 1].opts.content, /Requires Key: No/);

    // Klasifikasi akhir produk tersimpan → transaksi non-key.
    const t = classifyProduct(saved);
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, false);
});

test('add-product: kategori tidak dikenal → DITOLAK (anti typo id)', async () => {
    const { getConfig, saveConfig } = require('../../src/data/configManager');
    const productsHandler = require('../../src/commands/products');

    const cfg = getConfig();
    const originalProducts = cfg.products || [];
    cfg.products = originalProducts.filter(p => p.value !== 'ml_typo_1');
    saveConfig(cfg);

    const interaction = makeAddProductInteraction({
        label: 'Akun Typo',
        value: 'ml_typo_1',
        price: 'Rp 1',
        category: 'akun_ML', // salah kapital — id kategori exact-match
        requiresKey: null
    });
    await productsHandler(interaction);

    const saved = getConfig().products.find(p => p.value === 'ml_typo_1');
    assert.ok(!saved, 'produk dengan kategori typo TIDAK boleh tersimpan');
    const last = interaction._replies[interaction._replies.length - 1].opts.content;
    assert.match(last, /tidak ditemukan/);
});

test('add-product: requires_key eksplisit menimpa kategori (produk key di kategori non-key)', async () => {
    const { getConfig, saveConfig } = require('../../src/data/configManager');
    const productsHandler = require('../../src/commands/products');

    const cfg = getConfig();
    const originalProducts = cfg.products || [];
    cfg.products = originalProducts.filter(p => p.value !== 'ml_topup_1');
    saveConfig(cfg);

    // Kategori akun_ml requiresKey:false, tapi produk ini top-up pakai voucher key.
    const interaction = makeAddProductInteraction({
        label: 'Top Up 350 Diamond',
        value: 'ml_topup_1',
        price: 'Rp 75.000',
        category: 'akun_ml',
        requiresKey: true // eksplisit menimpa kategori
    });
    await productsHandler(interaction);

    const saved = getConfig().products.find(p => p.value === 'ml_topup_1');
    assert.ok(saved);
    assert.strictEqual(saved.requiresKey, true, 'flag produk menimpa flag kategori');
    const t = classifyProduct(saved);
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, true);
});

// ====================================================
// === 4. panels.js dropdown — deskripsi kategori campur ===
// === (v3.9.28: hitung dari produk aktual)              ===
// ====================================================

test('panels dropdown: kategori campur → "N tanpa key / M pakai key" (dari produk aktual)', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const panel = {
        title: 'X',
        body: 'X',
        color: null,
        categoryIds: [],
        useDropdown: true
    };
    const ctx = {
        guild: { name: 'T' },
        client: { user: { username: 'B', displayAvatarURL: () => 'http://x' } },
        config: {
            ticketCategories: [
                // Flag kategori true TAPI isi 2 dari 3 produk non-key — deskripsi
                // v3.9.27 (pakai flag kategori) akan bohong bilang "pakai key".
                { id: 'akun_ml', label: 'Akun ML', emoji: '🎮', style: 'Success', requiresKey: true },
                { id: 'lisensi_key', label: 'Lisensi Key', emoji: '🔑', style: 'Primary', requiresKey: true }
            ],
            products: [
                { label: 'Akun ML Mythic', value: 'ml1', price: 'Rp 150k', category: 'akun_ml', requiresKey: false },
                { label: 'Akun ML Epic', value: 'ml2', price: 'Rp 90k', category: 'akun_ml', requiresKey: false },
                { label: 'Top Up 350 DM', value: 'ml3', price: 'Rp 75k', category: 'akun_ml', requiresKey: true },
                { label: 'Win11 Pro', value: 'w11', price: 'Rp 150k', category: 'lisensi_key', requiresKey: true }
            ],
            messages: { ticketTitle: 'T', ticketBody: 'B', ticketPriceHeader: 'P' }
        }
    };
    const { components } = buildTicketPanel(panel, ctx);
    const menu = components[0].components[0];
    const opts = menu.options;
    const getDesc = o => o.data?.description || o.description;

    // akun_ml: 2 non-key + 1 key → campur (deskripsi dari PRODUK, bukan flag kategori)
    assert.strictEqual(getDesc(opts[0]), 'Transaksi — 3 produk (2 tanpa key / 1 pakai key)');
    // lisensi_key: semua pakai key
    assert.strictEqual(getDesc(opts[1]), 'Transaksi — 1 produk (pakai key)');
});

test('panels dropdown: kategori baru tanpa produk → "Bantuan / buka tiket langsung"', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const { components } = buildTicketPanel(
        { title: 'X', body: 'X', color: null, categoryIds: [], useDropdown: true },
        {
            guild: { name: 'T' },
            client: { user: { username: 'B', displayAvatarURL: () => 'http://x' } },
            config: {
                ticketCategories: [
                    { id: 'akun_ml_baru', label: 'Akun ML', emoji: '🎮', style: 'Success', requiresKey: false }
                ],
                products: [],
                messages: { ticketTitle: 'T', ticketBody: 'B', ticketPriceHeader: 'P' }
            }
        }
    );
    const menu = components[0].components[0];
    const getDesc = o => o.data?.description || o.description;
    assert.strictEqual(getDesc(menu.options[0]), 'Bantuan / buka tiket langsung');
});
