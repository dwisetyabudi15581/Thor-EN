/**
 * Unit tests v3.9.27 — transaksi NON-KEY (jual akun ML, jasa, dll).
 *
 * Bug yang diuji: sistem lama mengacaukan `requiresKey` (produk pakai key?)
 * dengan `isTransaction` (ini tiket jual-beli?) → produk non-key:
 *   - tombol close pakai gaya help (tidak ada "Pesanan Sukses")
 *   - invoice/testimoni tidak pernah dikirim
 *   - stats pembelian tidak tercatat, auto-role tidak pernah diberikan
 *
 * Yang diuji di sini (data layer murni + router):
 *   1. resolveTicketType() — flag eksplisit, fallback legacy, meta null
 *   2. setTicketMeta/getTicketMeta — persist isTransaction/isInvoiceSent/
 *      deliveredAt/deliveredBy
 *   3. patchTicketMeta — partial patch field baru
 *   4. Router interactions — ticket_deliver & modal_deliver_order: dispatch
 *      ke domain tiket (tanpa entry PREFIX_TO_DOMAIN, modal jadi dead
 *      interaction).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ticketsPath = path.join(__dirname, '..', '..', 'data', 'tickets.json');

// ====================================================
// === Sandbox: tickets.json produksi di-snapshot & restore ===
// === (pola ticketFlexibility.test.js untuk panels.json) ===
// ====================================================
const ticketsBackupPath = ticketsPath + '.test-backup';
let ticketsBackedUp = false;
if (fs.existsSync(ticketsPath)) {
    fs.copyFileSync(ticketsPath, ticketsBackupPath);
    ticketsBackedUp = true;
}
process.on('exit', () => {
    try {
        if (ticketsBackedUp) {
            fs.copyFileSync(ticketsBackupPath, ticketsPath);
            fs.rmSync(ticketsBackupPath, { force: true });
        } else if (fs.existsSync(ticketsPath)) {
            fs.unlinkSync(ticketsPath);
        }
    } catch (_) {}
});

function resetTicketsFile() {
    if (fs.existsSync(ticketsPath)) {
        fs.unlinkSync(ticketsPath);
    }
}

const { resolveTicketType, setTicketMeta, getTicketMeta, patchTicketMeta } = require('../../src/data/ticketManager');

// ====================================================
// === 1. resolveTicketType — flag eksplisit (v3.9.27+) ===
// ====================================================

test('resolveTicketType: null meta → default aman (bukan transaksi)', () => {
    const t = resolveTicketType(null);
    assert.strictEqual(t.isTransaction, false);
    assert.strictEqual(t.requiresKey, false);
    assert.strictEqual(t.isCompleted, false);
});

test('resolveTicketType: flag eksplisit isTransaction=true, requiresKey=false (produk non-key)', () => {
    // Tiket "Akun ML Mythic" dibuat v3.9.27+ — inti bug yang diperbaiki.
    const t = resolveTicketType({ isTransaction: true, requiresKey: false, category: 'transaction' });
    assert.strictEqual(t.isTransaction, true, 'produk non-key tetap TRANSAKSI');
    assert.strictEqual(t.requiresKey, false);
    assert.strictEqual(t.isCompleted, false);
});

test('resolveTicketType: flag eksplisit isTransaction=true, requiresKey=true (produk key)', () => {
    const t = resolveTicketType({ isTransaction: true, requiresKey: true, category: 'transaction' });
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, true);
});

test('resolveTicketType: flag eksplisit isTransaction=false (help/report)', () => {
    const t = resolveTicketType({ isTransaction: false, requiresKey: false, category: 'help' });
    assert.strictEqual(t.isTransaction, false);
    assert.strictEqual(t.requiresKey, false);
});

test('resolveTicketType: isCompleted dipassthrough', () => {
    const t = resolveTicketType({ isTransaction: true, requiresKey: true, isCompleted: true });
    assert.strictEqual(t.isCompleted, true);
});

// ====================================================
// === 2. resolveTicketType — fallback legacy ===
// ====================================================

test('resolveTicketType: legacy requiresKey=true → transaksi (tiket lama key)', () => {
    // Tiket dibuat v3.9.16–26 tanpa flag isTransaction.
    const t = resolveTicketType({ category: 'transaction', requiresKey: true });
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, true);
});

test('resolveTicketType: legacy requiresKey=false → BUKAN transaksi (perilaku lama dipertahankan)', () => {
    // Tiket non-key lama salah diklasifikasi sebagai bantuan — bug lama
    // dipertahankan untuk tiket yang masih terbuka (no regression; tiket
    // baru v3.9.27+ selalu punya flag eksplisit).
    const t = resolveTicketType({ category: 'transaction', requiresKey: false });
    assert.strictEqual(t.isTransaction, false);
    assert.strictEqual(t.requiresKey, false);
});

test('resolveTicketType: tiket purba tanpa requiresKey — kategori help/report → bantuan', () => {
    assert.strictEqual(resolveTicketType({ category: 'help' }).isTransaction, false);
    assert.strictEqual(resolveTicketType({ category: 'report' }).isTransaction, false);
});

test('resolveTicketType: tiket purba tanpa requiresKey — kategori transaksi → transaksi', () => {
    const t = resolveTicketType({ category: 'transaction', productName: 'VIP 30 Hari' });
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, true, 'requiresKey default mengikuti isTransaction');
});

test('resolveTicketType: tiket purba — magic string lama → bantuan', () => {
    assert.strictEqual(resolveTicketType({ productName: 'Bantuan/Lapor' }).isTransaction, false);
    assert.strictEqual(resolveTicketType({ productName: 'Bantuan Staff' }).isTransaction, false);
    assert.strictEqual(resolveTicketType({ productName: 'Laporkan Member' }).isTransaction, false);
});

// ====================================================
// === 3. Persist meta: isTransaction / isInvoiceSent / delivered* ===
// ====================================================

test('setTicketMeta→getTicketMeta: roundtrip field baru v3.9.27', () => {
    resetTicketsFile();
    setTicketMeta('chan_nonkey_1', {
        userId: '111',
        productName: 'Akun ML Mythic',
        price: 'Rp 150.000',
        guildId: 'g1',
        category: 'transaction',
        requiresKey: false,
        isTransaction: true
    });
    const meta = getTicketMeta('chan_nonkey_1');
    assert.strictEqual(meta.isTransaction, true);
    assert.strictEqual(meta.requiresKey, false);
    assert.strictEqual(meta.isInvoiceSent, false, 'default isInvoiceSent=false');
    assert.strictEqual(meta.deliveredAt, null);
    assert.strictEqual(meta.deliveredBy, null);
    assert.strictEqual(meta.isCompleted, false);
});

test('setTicketMeta: isTransaction=null kalau tidak diberikan (legacy-safe)', () => {
    resetTicketsFile();
    setTicketMeta('chan_legacy_1', {
        userId: '222',
        productName: 'VIP 30 Hari',
        price: 'Rp 30.000',
        guildId: 'g1',
        category: 'transaction',
        requiresKey: true
    });
    const meta = getTicketMeta('chan_legacy_1');
    assert.strictEqual(meta.isTransaction, null, 'tidak di-set → null (resolveTicketType fallback legacy)');
    // Resolve tetap benar untuk tiket legacy ini:
    const t = resolveTicketType(meta);
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, true);
});

test('patchTicketMeta: patch isInvoiceSent + deliveredAt/deliveredBy tanpa overwrite field lain', () => {
    resetTicketsFile();
    setTicketMeta('chan_deliver_1', {
        userId: '333',
        productName: 'Akun ML',
        price: 'Rp 100.000',
        guildId: 'g1',
        category: 'transaction',
        requiresKey: false,
        isTransaction: true
    });
    const ok = patchTicketMeta('chan_deliver_1', {
        isCompleted: true,
        deliveredAt: 12345,
        deliveredBy: 'admin999',
        isInvoiceSent: true
    });
    assert.strictEqual(ok, true);
    const meta = getTicketMeta('chan_deliver_1');
    assert.strictEqual(meta.isCompleted, true);
    assert.strictEqual(meta.deliveredAt, 12345);
    assert.strictEqual(meta.deliveredBy, 'admin999');
    assert.strictEqual(meta.isInvoiceSent, true);
    // Field lama tetap utuh:
    assert.strictEqual(meta.productName, 'Akun ML');
    assert.strictEqual(meta.userId, '333');
    assert.strictEqual(meta.isTransaction, true);
});

test('resolveTicketType setelah patch: non-key + isCompleted → cabang tombol "Selesai"', () => {
    // Simulasi tiket yang sudah lewat 📦 Kirim Pesanan:
    const t = resolveTicketType({
        isTransaction: true,
        requiresKey: false,
        isCompleted: true,
        deliveredAt: 123,
        isInvoiceSent: true
    });
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, false);
    assert.strictEqual(t.isCompleted, true);
});

// ====================================================
// === 4. Router interactions — dispatch customId baru ===
// ====================================================

function makeMockInteraction({ customId, type = 'button', id = `t-${Date.now()}-${Math.random()}` }) {
    const replies = [];
    const interaction = {
        id,
        customId,
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => type === 'button',
        isStringSelectMenu: () => type === 'select',
        // v3.9.33: router kini juga menerima user select menu.
        isUserSelectMenu: () => type === 'userselect',
        isModalSubmit: () => type === 'modal',
        reply: async opts => {
            replies.push(opts);
            interaction.replied = true;
            return {};
        },
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        _replies: replies
    };
    return interaction;
}

test('router: tombol ticket_deliver dispatch ke domain tiket', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({ customId: 'ticket_deliver', type: 'button' });
    // Handler akan menolak (bukan admin — mock tanpa member) → itu bukti
    // dispatch sampai handler, bukan "unknown customId".
    await routeInteraction(interaction);
    assert.ok(
        interaction._replies.length > 0,
        'handler merespon (ditolak sebagai non-admin) → dispatch ke domain tiket berhasil'
    );
});

test('router: modal_deliver_order: dispatch ke domain tiket (routing gap fix)', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'modal_deliver_order:akun_ml',
        type: 'modal'
    });
    await routeInteraction(interaction);
    assert.ok(
        interaction._replies.length > 0,
        'submit modal merespon (ditolak sebagai non-admin) → routing modal_deliver_order: aktif'
    );
});
