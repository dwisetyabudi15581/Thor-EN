/**
 * Unit tests v3.9.28 — SAFETY OF ADDING A NEW CATEGORY.
 *
 * User question: "What if I add a new category like ML accounts or key
 * licenses — is it already safe?"
 *
 * The answer proven by these tests:
 *   1. classifyProduct(): ALL new categories (id ≠ 'help'/'report') are
 *      automatically classified as a TRANSACTION — no code change needed.
 *      - 'akun_ml' + requiresKey: false  → TRANSACTION + 📦 Deliver Order button
 *      - 'lisensi_key' + requiresKey: true → TRANSACTION + 🔑 Set Key button
 *   2. Data roundtrip: classifyProduct → setTicketMeta → getTicketMeta →
 *      resolveTicketType → the correct button decision.
 *   3. /add-product: the product inherits requiresKey from the category (the
 *      admin doesn't need to set requires_key per product if the category is
 *      already correct).
 *   4. panels.js dropdown: the description counts actual key/non-key products
 *      (mixed category → "N without keys / M with keys").
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
// === (production files exist — pattern from ticketNonKey.test.js) ===
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

/** Write a controlled config.json for the test (no audit channel → logAudit skips). */
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
// === 1. classifyProduct — NEW category scenarios ===
// === (user question: ML accounts & key licenses) ===
// ====================================================

test('classifyProduct: new category "akun_ml" with a non-key product → TRANSACTION without keys', () => {
    // /add-category id:akun_ml requires_key:false → /add-product value:ml_legend requires_key:false
    const t = classifyProduct({
        label: 'Akun ML Mythic',
        value: 'ml_legend',
        price: 'Rp 150.000',
        category: 'akun_ml',
        requiresKey: false
    });
    assert.strictEqual(t.isTransaction, true, 'akun_ml MUST be a transaction (not support)');
    assert.strictEqual(t.requiresKey, false, 'account products don\'t use keys');
});

test('classifyProduct: new category "lisensi_key" with a key product → TRANSACTION with keys', () => {
    const t = classifyProduct({
        label: 'Windows 11 Pro OEM',
        value: 'win11_pro',
        price: 'Rp 150.000',
        category: 'lisensi_key',
        requiresKey: true
    });
    assert.strictEqual(t.isTransaction, true, 'lisensi_key MUST be a transaction');
    assert.strictEqual(t.requiresKey, true, 'licenses use keys');
});

test('classifyProduct: product in a new category WITHOUT a requiresKey flag → defaults to using keys (gotcha)', () => {
    // Admin forgot to set requires_key on both the category AND the product → defaults to true.
    // This is INTENTIONAL behavior (not a bug): a transaction product is assumed to use
    // keys until the admin explicitly says otherwise. ML account admins must set requires_key:false.
    const t = classifyProduct({ label: 'Akun ML', value: 'ml1', price: 'x', category: 'akun_ml' });
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, true, 'no flag → defaults to using keys (Set Key)');
});

test('classifyProduct: only the ids "help"/"report" are special — any other id = transaction', () => {
    // Any custom category (jasa, topup, event, konsultasi, ...) → transaction.
    for (const catId of ['jasa', 'topup', 'event', 'bantuan_premium', 'konsultasi', 'Akun_ML-1']) {
        const t = classifyProduct({ label: 'X', value: 'x', price: 'x', category: catId, requiresKey: false });
        assert.strictEqual(t.isTransaction, true, `category "${catId}" must be a transaction`);
    }
    // 'bantuan_premium' ≠ 'help' → still a transaction (no magic-string prefix).
});

test('classifyProduct: help/report/isHelp category → SUPPORT (not a transaction)', () => {
    for (const product of [
        { label: 'Help', category: 'help', isHelp: true, requiresKey: false },
        { label: 'Report', category: 'report', isHelp: true, requiresKey: false },
        { label: 'Custom', category: 'event', isHelp: true, requiresKey: false } // synthetic object of a category without products
    ]) {
        const t = classifyProduct(product);
        assert.strictEqual(t.isTransaction, false, `${product.label} must be support`);
        assert.strictEqual(t.requiresKey, false);
    }
});

test('classifyProduct: null/undefined product → safe (not a transaction)', () => {
    assert.deepStrictEqual(classifyProduct(null), { isTransaction: false, requiresKey: false });
    assert.deepStrictEqual(classifyProduct(undefined), { isTransaction: false, requiresKey: false });
});

// ====================================================
// === 2. Roundtrip: new-category ticket meta → resolveTicketType ===
// === (guarantees the correct close/deliver/set_key buttons)      ===
// ====================================================

test('roundtrip: akun_ml ticket (non-key) → Deliver Order allowed, Set Key rejected', () => {
    resetTicketsFile();
    const product = {
        label: 'Akun ML Mythic',
        value: 'ml_legend',
        price: 'Rp 150.000',
        category: 'akun_ml',
        requiresKey: false
    };
    // createTicket (v3.9.27+) stores the classifyProduct result in the meta:
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
    assert.strictEqual(type.isTransaction, true, 'an ML account ticket = a transaction');
    assert.strictEqual(type.requiresKey, false);

    // Button matrix (mirrors the ticket.js logic):
    // - ticket_deliver: needs isTransaction && !requiresKey && !isCompleted → ALLOW
    const deliverAllowed = type.isTransaction && !type.requiresKey && !type.isCompleted;
    assert.strictEqual(deliverAllowed, true, 'the 📦 Deliver Order button must be active');
    // - ticket_set_key: rejected for non-key (defense-in-depth)
    const setKeyAllowed = type.isTransaction && type.requiresKey;
    assert.strictEqual(setKeyAllowed, false, 'the 🔑 Set Key button must be rejected');
    // - close: non-key + not delivered yet → "Order Successful" is shown
    const showOrderSuccess = type.isTransaction && !type.requiresKey && !type.isCompleted;
    assert.strictEqual(showOrderSuccess, true, 'the ✅ Order Successful button must be shown');
});

test('roundtrip: lisensi_key ticket → Set Key allowed, Deliver Order rejected', () => {
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
    assert.strictEqual(setKeyAllowed, true, 'the 🔑 Set Key button must be active');
    const deliverAllowed = type.isTransaction && !type.requiresKey && !type.isCompleted;
    assert.strictEqual(deliverAllowed, false, 'the 📦 Deliver Order button must be rejected');
});

test('roundtrip: after Deliver Order (isCompleted) → "Done"-style close, deliver rejected', () => {
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
    assert.strictEqual(deliverAllowed, false, 'a second Deliver Order must be rejected (anti-double)');
});

// ====================================================
// === 3. /add-product — requiresKey inherited from the category ===
// === (runs the REAL handler with a mock interaction)            ===
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

test('add-product: a product in a non-key category inherits requiresKey:false without an explicit option', async () => {
    const { getConfig, saveConfig } = require('../../src/data/configManager');
    const productsHandler = require('../../src/commands/products');

    // Setup: new category "akun_ml" requiresKey:false (from /add-category).
    const cfg = getConfig();
    const originalCategories = cfg.ticketCategories || [];
    const originalProducts = cfg.products || [];
    const originalChannels = { ...(cfg.channels || {}) };
    delete originalChannels['audit-log']; // logAudit silently skips
    cfg.channels = originalChannels;
    cfg.ticketCategories = [
        ...originalCategories.filter(c => c.id !== 'akun_ml'),
        { id: 'akun_ml', label: 'Akun ML', emoji: '🎮', style: 'Success', requiresKey: false, isDefault: false }
    ];
    cfg.products = originalProducts.filter(p => p.value !== 'ml_test_1');
    saveConfig(cfg);

    // The admin did NOT set requires_key (null) → must inherit false from the category.
    const interaction = makeAddProductInteraction({
        label: 'Akun ML Mythic',
        value: 'ml_test_1',
        price: 'Rp 150.000',
        category: 'akun_ml',
        requiresKey: null
    });
    await productsHandler(interaction);

    const saved = getConfig().products.find(p => p.value === 'ml_test_1');
    assert.ok(saved, 'the product must be saved');
    assert.strictEqual(saved.category, 'akun_ml');
    assert.strictEqual(saved.requiresKey, false, 'inherits requiresKey:false from the akun_ml category');
    assert.match(interaction._replies[interaction._replies.length - 1].opts.content, /Requires Key: No/);

    // Final classification of the saved product → non-key transaction.
    const t = classifyProduct(saved);
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, false);
});

test('add-product: unknown category → REJECTED (anti id-typo)', async () => {
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
        category: 'akun_ML', // wrong capitalization — category ids are exact-match
        requiresKey: null
    });
    await productsHandler(interaction);

    const saved = getConfig().products.find(p => p.value === 'ml_typo_1');
    assert.ok(!saved, 'a product with a typo category must NOT be saved');
    const last = interaction._replies[interaction._replies.length - 1].opts.content;
    assert.match(last, /not found/);
});

test('add-product: an explicit requires_key overrides the category (key product in a non-key category)', async () => {
    const { getConfig, saveConfig } = require('../../src/data/configManager');
    const productsHandler = require('../../src/commands/products');

    const cfg = getConfig();
    const originalProducts = cfg.products || [];
    cfg.products = originalProducts.filter(p => p.value !== 'ml_topup_1');
    saveConfig(cfg);

    // The akun_ml category is requiresKey:false, but this product is a top-up using voucher keys.
    const interaction = makeAddProductInteraction({
        label: 'Top Up 350 Diamond',
        value: 'ml_topup_1',
        price: 'Rp 75.000',
        category: 'akun_ml',
        requiresKey: true // explicit, overrides the category
    });
    await productsHandler(interaction);

    const saved = getConfig().products.find(p => p.value === 'ml_topup_1');
    assert.ok(saved);
    assert.strictEqual(saved.requiresKey, true, 'the product flag overrides the category flag');
    const t = classifyProduct(saved);
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, true);
});

// ====================================================
// === 4. panels.js dropdown — mixed category description ===
// === (v3.9.28: counted from actual products)             ===
// ====================================================

test('panels dropdown: mixed category → "N without keys / M with keys" (from actual products)', () => {
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
                // The category flag is true BUT 2 of its 3 products are non-key — the
                // v3.9.27 description (which uses the category flag) would lie "with keys".
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

    // akun_ml: 2 non-key + 1 key → mixed (description from the PRODUCTS, not the category flag)
    assert.strictEqual(getDesc(opts[0]), 'Transaction — 3 products (2 without keys / 1 with keys)');
    // lisensi_key: all use keys
    assert.strictEqual(getDesc(opts[1]), 'Transaction — 1 products (with keys)');
});

test('panels dropdown: new category without products → "Support / open a ticket directly"', () => {
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
    assert.strictEqual(getDesc(menu.options[0]), 'Support / open a ticket directly');
});
