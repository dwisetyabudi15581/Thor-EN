/**
 * Unit tests v3.9.32–v3.9.34 — fitur Midman/Rekber (deal escrow 3-pihak).
 *
 * Yang diuji (lapisan pure — pola classifyProduct: logic inti di-ekstrak ke
 * midmanManager supaya bisa diuji tanpa mock Discord):
 *   1. State machine: urutan langkah tidak bisa dilompati (canTransition/
 *      nextState) — inti keamanan escrow "gerbang ganda".
 *   2. actorAllowed: hanya pihak yang berhak yang bisa melakukan event.
 *   3. calcFee: persen / flat / 0 / mode invalid (v3.9.33: additive, tanpa cap).
 *   4. calcTotals: fee ditambah di atas harga — penjual menerima harga PENUH.
 *   5. parsePriceNumber: "100000" / "100.000" / "100k" / "1m" / invalid.
 *   6. formatRupiah.
 *   7. Persistensi deals.json: setDeal/getDeal/removeDeal/hasActiveDealFor.
 *   8. Config: DEFAULTS midman + migration kategori 'midman' ke config lama
 *      (sekali saja — flag midmanCategoryDismissed mencegah re-add).
 *   9. findActiveTicketFor (ticketManager): meta ada → aktif; zombie meta
 *      (channel hilang) → di-cleanup & return null.
 *  10. v3.9.34: applyAgreement — persetujuan DUA pihak (parsial vs both vs
 *      double-click vs non-peserta).
 *  11. v3.9.34: observer (member tambahan) — canAddObserver/addObserver/
 *      removeObserver + guard peserta/duplikat/limit.
 *  12. v3.9.34: migration deal lama WAITING_SELLER → WAITING_AGREE.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: file data produksi di-snapshot & restore ===
// === (pola hardeningV31.test.js)                      ===
// ====================================================
const SANDBOX_FILES = ['deals.json', 'config.json', 'tickets.json'];
const backups = [];
for (const f of SANDBOX_FILES) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) {
        const b = p + '.v32-backup';
        fs.copyFileSync(p, b);
        backups.push({ orig: p, backup: b });
    }
}
process.on('exit', () => {
    for (const { orig, backup } of backups) {
        try {
            fs.copyFileSync(backup, orig);
            fs.rmSync(backup, { force: true });
        } catch (_) {}
    }
    // File yang TIDAK ada sebelum test → hapus hasil test (deals.json baru).
    for (const f of SANDBOX_FILES) {
        const p = path.join(dataDir, f);
        if (!backups.some(b => b.orig === p) && fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
            } catch (_) {}
        }
    }
});

function resetDataFile(name, content) {
    const p = path.join(dataDir, name);
    if (content === null) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return;
    }
    fs.writeFileSync(p, JSON.stringify(content, null, 2));
}

// ====================================================
// === 1. STATE MACHINE — urutan tidak bisa dilompati ===
// ====================================================

const mm = require('../../src/data/midmanManager');

test('state machine: happy path lengkap agree→payment→delivery→release', () => {
    let state = 'WAITING_AGREE';
    state = mm.nextState(state, 'join');
    assert.strictEqual(state, 'WAITING_PAYMENT');
    state = mm.nextState(state, 'fundin');
    assert.strictEqual(state, 'WAITING_DELIVERY');
    state = mm.nextState(state, 'received');
    assert.strictEqual(state, 'WAITING_RELEASE');
    state = mm.nextState(state, 'release');
    assert.strictEqual(state, 'COMPLETED');
});

test('state machine: gerbang ganda — release ditolak sebelum barang diterima', () => {
    // Deal belum barang diterima → midman tidak bisa cairkan (skema fraud klasik).
    assert.strictEqual(mm.nextState('WAITING_DELIVERY', 'release'), null);
    assert.strictEqual(mm.canTransition('WAITING_DELIVERY', 'release'), false);
    // Begitu juga sebelum dana masuk.
    assert.strictEqual(mm.nextState('WAITING_PAYMENT', 'release'), null);
});

test('state machine: fundin dobel / join dobel ditolak', () => {
    assert.strictEqual(mm.nextState('WAITING_DELIVERY', 'fundin'), null);
    assert.strictEqual(mm.nextState('WAITING_PAYMENT', 'join'), null);
});

test('state machine: cancel hanya sebelum dana masuk', () => {
    assert.strictEqual(mm.canTransition('WAITING_AGREE', 'cancel'), true);
    assert.strictEqual(mm.canTransition('WAITING_PAYMENT', 'cancel'), true);
    // Setelah dana di midman — refund HARUS lewat dispute + admin resolve.
    assert.strictEqual(mm.canTransition('WAITING_DELIVERY', 'cancel'), false);
    assert.strictEqual(mm.canTransition('WAITING_RELEASE', 'cancel'), false);
    assert.strictEqual(mm.canTransition('DISPUTE', 'cancel'), false);
});

test('state machine: dispute valid di tengah jalan, tidak di awal/terminal', () => {
    assert.strictEqual(mm.canTransition('WAITING_PAYMENT', 'dispute'), true);
    assert.strictEqual(mm.canTransition('WAITING_DELIVERY', 'dispute'), true);
    assert.strictEqual(mm.canTransition('WAITING_RELEASE', 'dispute'), true);
    assert.strictEqual(mm.canTransition('WAITING_AGREE', 'dispute'), false);
    assert.strictEqual(mm.canTransition('COMPLETED', 'dispute'), false);
});

test('state machine: semua aksi mati saat DISPUTE & terminal state', () => {
    for (const event of ['join', 'fundin', 'received', 'release', 'cancel', 'dispute']) {
        assert.strictEqual(mm.canTransition('DISPUTE', event), false, `event ${event} harus mati saat DISPUTE`);
    }
    for (const event of ['join', 'fundin', 'received', 'release', 'cancel', 'dispute']) {
        assert.strictEqual(mm.canTransition('COMPLETED', event), false);
    }
    // Hanya admin resolve yang hidup dari DISPUTE.
    assert.strictEqual(mm.canTransition('DISPUTE', 'resolve_release'), true);
    assert.strictEqual(mm.canTransition('DISPUTE', 'resolve_refund'), true);
});

test('state machine: event tidak dikenal → false (defensive)', () => {
    assert.strictEqual(mm.canTransition('WAITING_AGREE', 'hack_the_system'), false);
    assert.strictEqual(mm.nextState('WAITING_AGREE', ''), null);
    assert.strictEqual(mm.canTransition(null, 'join'), false);
});

// ====================================================
// === 2. ACTOR — hanya pihak berhak ===
// ====================================================

const BUYER = { isBuyer: true, isSeller: false, isMidman: false, isAdmin: false };
const SELLER = { isBuyer: false, isSeller: true, isMidman: false, isAdmin: false };
const MIDMAN = { isBuyer: false, isSeller: false, isMidman: true, isAdmin: false };
const ADMIN = { isBuyer: false, isSeller: false, isMidman: false, isAdmin: true };
const OUTSIDER = { isBuyer: false, isSeller: false, isMidman: false, isAdmin: false };

test('actor: v3.9.34 — buyer DAN seller bisa join; hanya buyer bisa received', () => {
    // Persetujuan ganda: siapa pun yang membuat deal, pembeli & penjual
    // dua-duanya harus menyetujui terms.
    assert.strictEqual(mm.actorAllowed('join', SELLER), true);
    assert.strictEqual(mm.actorAllowed('join', BUYER), true);
    assert.strictEqual(mm.actorAllowed('join', MIDMAN), false);
    assert.strictEqual(mm.actorAllowed('join', ADMIN), false);
    assert.strictEqual(mm.actorAllowed('join', OUTSIDER), false);
    assert.strictEqual(mm.actorAllowed('received', BUYER), true);
    assert.strictEqual(mm.actorAllowed('received', SELLER), false);
    assert.strictEqual(mm.actorAllowed('received', MIDMAN), false);
});

test('actor: hanya midman/admin bisa fundin & release', () => {
    assert.strictEqual(mm.actorAllowed('fundin', MIDMAN), true);
    assert.strictEqual(mm.actorAllowed('fundin', ADMIN), true);
    assert.strictEqual(mm.actorAllowed('fundin', BUYER), false);
    assert.strictEqual(mm.actorAllowed('release', MIDMAN), true);
    assert.strictEqual(mm.actorAllowed('release', BUYER), false);
    assert.strictEqual(mm.actorAllowed('release', SELLER), false);
});

test('actor: hanya admin bisa resolve dispute', () => {
    assert.strictEqual(mm.actorAllowed('resolve_release', ADMIN), true);
    assert.strictEqual(mm.actorAllowed('resolve_refund', ADMIN), true);
    assert.strictEqual(mm.actorAllowed('resolve_release', MIDMAN), false);
    assert.strictEqual(mm.actorAllowed('resolve_refund', BUYER), false);
});

test('actor: peserta boleh dispute, orang luar tidak', () => {
    assert.strictEqual(mm.actorAllowed('dispute', BUYER), true);
    assert.strictEqual(mm.actorAllowed('dispute', SELLER), true);
    assert.strictEqual(mm.actorAllowed('dispute', MIDMAN), true);
    assert.strictEqual(mm.actorAllowed('dispute', OUTSIDER), false);
});

test('actor: cancel — buyer/seller/admin boleh, midman tidak', () => {
    assert.strictEqual(mm.actorAllowed('cancel', BUYER), true);
    assert.strictEqual(mm.actorAllowed('cancel', SELLER), true);
    assert.strictEqual(mm.actorAllowed('cancel', ADMIN), true);
    assert.strictEqual(mm.actorAllowed('cancel', MIDMAN), false);
    assert.strictEqual(mm.actorAllowed('cancel', OUTSIDER), false);
});

// ====================================================
// === 3. FEE ===
// ====================================================

test('calcFee: mode persen', () => {
    assert.strictEqual(mm.calcFee(100000, 'percent', 5), 5000);
    assert.strictEqual(mm.calcFee(250000, 'percent', 3), 7500);
    // Pembulatan: 99999 * 5% = 4999.95 → 5000
    assert.strictEqual(mm.calcFee(99999, 'percent', 5), 5000);
});

test('calcFee: mode flat', () => {
    assert.strictEqual(mm.calcFee(100000, 'flat', 5000), 5000);
    assert.strictEqual(mm.calcFee(50000, 'flat', 5000), 5000);
});

test('calcFee: fee 0 = gratis, nilai negatif/invalid = 0', () => {
    assert.strictEqual(mm.calcFee(100000, 'percent', 0), 0);
    assert.strictEqual(mm.calcFee(100000, 'percent', -10), 0);
    assert.strictEqual(mm.calcFee(-100, 'percent', 5), 0);
    assert.strictEqual(mm.calcFee('abc', 'percent', 5), 0);
});

test('calcFee: v3.9.33 — fee ADDITIVE, tidak di-cap sebesar harga deal', () => {
    // Fee flat boleh melebihi harga (admin yang setting — /set-midman-fee
    // membatasi persen maks 90% di sisi command; percent tidak mungkin > harga).
    assert.strictEqual(mm.calcFee(100000, 'percent', 90), 90000);
    assert.strictEqual(mm.calcFee(10000, 'flat', 999999), 999999);
    assert.strictEqual(mm.calcFee(100000, 'percent', 150), 150000);
});

test('calcFee: mode tak dikenal → fee 0 (deal tetap jalan)', () => {
    assert.strictEqual(mm.calcFee(100000, 'weird', 50), 0);
    assert.strictEqual(mm.calcFee(100000, undefined, 50), 0);
});

test('calcTotals: v3.9.33 — fee ditambah di atas harga (contoh user: 100rb + 5% = 105rb)', () => {
    // Contoh persis dari kebijakan user: harga 100.000, fee 5% (5.000)
    // → pembeli transfer 105.000, penjual menerima 100.000 PENUH.
    const fee = mm.calcFee(100000, 'percent', 5);
    const totals = mm.calcTotals(100000, fee);
    assert.deepStrictEqual(totals, { buyerPays: 105000, sellerGets: 100000, midmanKeeps: 5000 });
});

test('calcTotals: fee 0 → pembeli bayar persis harga; seller dapat harga penuh', () => {
    assert.deepStrictEqual(mm.calcTotals(100000, 0), { buyerPays: 100000, sellerGets: 100000, midmanKeeps: 0 });
});

test('calcTotals: input invalid/negatif → tidak melempar NaN, fee negatif di-clamp 0', () => {
    assert.deepStrictEqual(mm.calcTotals('abc', 'x'), { buyerPays: 0, sellerGets: 0, midmanKeeps: 0 });
    assert.deepStrictEqual(mm.calcTotals(null, null), { buyerPays: 0, sellerGets: 0, midmanKeeps: 0 });
    // Fee negatif (deal korup/manual edit) tidak boleh "mengurangi" total.
    assert.deepStrictEqual(mm.calcTotals(50000, -3000), { buyerPays: 50000, sellerGets: 50000, midmanKeeps: 0 });
});

// ====================================================
// === 4-5. PARSER INPUT MODAL (harga) ===
// ====================================================
// v3.9.33: parseSellerInput dihapus — penjual dipilih lewat dropdown member
// (User Select Menu), bukan input teks mention/ID.

test('parsePriceNumber: format umum rupiah', () => {
    assert.strictEqual(mm.parsePriceNumber('100000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('100.000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('100,000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('Rp100.000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('rp 100000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('100k'), 100000);
    assert.strictEqual(mm.parsePriceNumber('1m'), 1000000);
    assert.strictEqual(mm.parsePriceNumber(50000), 50000);
});

test('parsePriceNumber: input tidak valid → 0', () => {
    assert.strictEqual(mm.parsePriceNumber('abc'), 0);
    assert.strictEqual(mm.parsePriceNumber(''), 0);
    assert.strictEqual(mm.parsePriceNumber('-5000'), 0);
    assert.strictEqual(mm.parsePriceNumber('0'), 0);
    assert.strictEqual(mm.parsePriceNumber(null), 0);
});

test('formatRupiah: locale id-ID', () => {
    assert.strictEqual(mm.formatRupiah(95000), 'Rp95.000');
    assert.strictEqual(mm.formatRupiah(1000000), 'Rp1.000.000');
    assert.strictEqual(mm.formatRupiah(0), 'Rp0');
});

// ====================================================
// === 6. PERSISTENSI deals.json ===
// ====================================================

test('deals.json: setDeal → getDeal → removeDeal', () => {
    resetDataFile('deals.json', {});
    const deal = {
        channelId: 'ch-deal-1',
        guildId: 'g1',
        buyerId: 'buyer-1',
        sellerId: 'seller-1',
        item: 'Akun ML',
        priceNum: 100000,
        state: 'WAITING_PAYMENT'
    };
    mm.setDeal('ch-deal-1', deal);
    // v3.9.34: loadDeals menormalkan field baru (observers/buyerAgreed/
    // sellerAgreed) — getDeal mengembalikan bentuk lengkap.
    assert.deepStrictEqual(mm.getDeal('ch-deal-1'), {
        ...deal,
        observers: [],
        buyerAgreed: false,
        sellerAgreed: false
    });
    assert.strictEqual(mm.getDeal('ch-tidak-ada'), null);
    mm.removeDeal('ch-deal-1');
    assert.strictEqual(mm.getDeal('ch-deal-1'), null);
});

test('hasActiveDealFor: buyer & seller terdeteksi, orang luar tidak', () => {
    resetDataFile('deals.json', {
        ch1: { guildId: 'g1', buyerId: 'buyer-1', sellerId: 'seller-1', state: 'WAITING_PAYMENT' }
    });
    assert.strictEqual(mm.hasActiveDealFor('g1', 'buyer-1'), true);
    assert.strictEqual(mm.hasActiveDealFor('g1', 'seller-1'), true);
    assert.strictEqual(mm.hasActiveDealFor('g1', 'random-guy'), false);
    // Guild lain dengan userId sama → tidak bocor (isolation per guild).
    assert.strictEqual(mm.hasActiveDealFor('g2', 'buyer-1'), false);
});

test('hasActiveDealFor: terminal state tidak dihitung aktif', () => {
    resetDataFile('deals.json', {
        ch1: { guildId: 'g1', buyerId: 'buyer-1', sellerId: 'seller-1', state: 'COMPLETED' }
    });
    assert.strictEqual(mm.hasActiveDealFor('g1', 'buyer-1'), false);
    assert.strictEqual(mm.hasActiveDealFor('g1', 'seller-1'), false);
});

test('recordTransition: state berubah + history tercatat; event invalid → null', () => {
    const deal = { state: 'WAITING_PAYMENT', history: [] };
    const actor = { id: 'midman-1', tag: 'rian#0001' };
    const result = mm.recordTransition(deal, 'fundin', actor);
    assert.strictEqual(result, deal);
    assert.strictEqual(deal.state, 'WAITING_DELIVERY');
    assert.strictEqual(deal.history.length, 1);
    assert.strictEqual(deal.history[0].event, 'fundin');
    assert.strictEqual(deal.history[0].actorId, 'midman-1');
    assert.strictEqual(deal.history[0].fromState, 'WAITING_PAYMENT');
    assert.strictEqual(deal.history[0].toState, 'WAITING_DELIVERY');

    // Event invalid dari state sekarang → null, state tidak berubah.
    assert.strictEqual(mm.recordTransition(deal, 'join', actor), null);
    assert.strictEqual(deal.state, 'WAITING_DELIVERY');
    assert.strictEqual(deal.history.length, 1); // tidak ada entry palsu
});

// ====================================================
// === 6b. PERSETUJUAN GANDA (v3.9.34) ===
// ====================================================

function mkDeal(overrides = {}) {
    return {
        channelId: 'ch-x',
        guildId: 'g1',
        buyerId: 'buyer-1',
        sellerId: 'seller-1',
        buyerAgreed: false,
        sellerAgreed: false,
        observers: [],
        state: 'WAITING_AGREE',
        history: [],
        ...overrides
    };
}

test('applyAgreement: klik pertama = parsial, klik kedua = both', () => {
    const deal = mkDeal();
    // Pembeli setuju duluan — masih menunggu penjual.
    let res = mm.applyAgreement(deal, 'buyer-1');
    assert.deepStrictEqual(res, { ok: true, both: false, role: 'buyer' });
    assert.strictEqual(deal.buyerAgreed, true);
    assert.strictEqual(deal.sellerAgreed, false);
    // Penjual menyusul → both = true (caller wajib recordTransition join).
    res = mm.applyAgreement(deal, 'seller-1');
    assert.deepStrictEqual(res, { ok: true, both: true, role: 'seller' });
    assert.strictEqual(deal.state, 'WAITING_AGREE'); // manager tidak mengubah state
});

test('applyAgreement: urutan penjual-duluan juga valid (creator bisa siapa saja)', () => {
    const deal = mkDeal();
    let res = mm.applyAgreement(deal, 'seller-1');
    assert.deepStrictEqual(res, { ok: true, both: false, role: 'seller' });
    res = mm.applyAgreement(deal, 'buyer-1');
    assert.deepStrictEqual(res, { ok: true, both: true, role: 'buyer' });
});

test('applyAgreement: double-click / pihak yang sudah setuju → ditolak', () => {
    const deal = mkDeal({ buyerAgreed: true });
    const res = mm.applyAgreement(deal, 'buyer-1');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.both, false);
    // Flag tidak berubah (tidak ada entry history palsu dari klik dobel).
    assert.strictEqual(deal.buyerAgreed, true);
    assert.strictEqual(deal.sellerAgreed, false);
});

test('applyAgreement: non-peserta (observer/luar) → ditolak', () => {
    const deal = mkDeal();
    assert.strictEqual(mm.applyAgreement(deal, 'random-guy').ok, false);
    assert.strictEqual(mm.applyAgreement(deal, null).ok, false);
    assert.strictEqual(mm.applyAgreement(null, 'buyer-1').ok, false);
});

test('applyAgreement + recordTransition: kontrak caller — join hanya direkam setelah kedua setuju', () => {
    const deal = mkDeal();
    const actor = { id: 'buyer-1', tag: 'budi#0001' };
    // Klik pembeli saja → both=false → caller TIDAK memanggil recordTransition
    // (state tetap WAITING_AGREE; persetujuan parsial tercatat caller di history).
    const partial = mm.applyAgreement(deal, 'buyer-1');
    assert.strictEqual(partial.both, false);
    assert.strictEqual(deal.state, 'WAITING_AGREE');
    // Penjual menyusul → both=true → SEKARANG recordTransition join valid.
    const both = mm.applyAgreement(deal, 'seller-1');
    assert.strictEqual(both.both, true);
    const applied = mm.recordTransition(deal, 'join', actor);
    assert.strictEqual(applied, deal);
    assert.strictEqual(deal.state, 'WAITING_PAYMENT');
    assert.strictEqual(deal.history.length, 1);
    assert.strictEqual(deal.history[0].event, 'join');
});

// ====================================================
// === 6c. OBSERVER / MEMBER TAMBAHAN (v3.9.34) ===
// ====================================================

test('observer: tambah & keluarkan member tambahan', () => {
    const deal = mkDeal();
    assert.strictEqual(mm.addObserver(deal, 'witness-1'), true);
    assert.deepStrictEqual(deal.observers, ['witness-1']);
    assert.strictEqual(mm.removeObserver(deal, 'witness-1'), true);
    assert.deepStrictEqual(deal.observers, []);
    // Keluarkan yang memang bukan observer → false.
    assert.strictEqual(mm.removeObserver(deal, 'witness-1'), false);
});

test('observer: pembeli/penjual TIDAK bisa jadi member tambahan', () => {
    const deal = mkDeal();
    assert.deepStrictEqual(mm.canAddObserver(deal, 'buyer-1'), { ok: false, reason: 'principal' });
    assert.deepStrictEqual(mm.canAddObserver(deal, 'seller-1'), { ok: false, reason: 'principal' });
    assert.strictEqual(mm.addObserver(deal, 'buyer-1'), false);
    assert.deepStrictEqual(deal.observers, []);
});

test('observer: duplikat & limit maksimal', () => {
    const deal = mkDeal();
    for (let i = 0; i < mm.MAX_OBSERVERS; i++) {
        assert.strictEqual(mm.addObserver(deal, `obs-${i}`), true);
    }
    assert.deepStrictEqual(mm.canAddObserver(deal, 'obs-11'), { ok: false, reason: 'full' });
    // Duplikat observer pertama.
    assert.deepStrictEqual(mm.canAddObserver(deal, 'obs-0'), { ok: false, reason: 'duplicate' });
    assert.strictEqual(mm.MAX_OBSERVERS, 10);
});

test('observer: input invalid ditolak defensive', () => {
    assert.deepStrictEqual(mm.canAddObserver(mkDeal(), null), { ok: false, reason: 'invalid' });
    assert.deepStrictEqual(mm.canAddObserver(null, 'x'), { ok: false, reason: 'invalid' });
    assert.strictEqual(mm.addObserver(null, 'x'), false);
    assert.strictEqual(mm.removeObserver(null, 'x'), false);
    // Deal tanpa field observers (data lama) → removeObserver false, tidak crash.
    assert.strictEqual(mm.removeObserver({ buyerId: 'b', sellerId: 's' }, 'x'), false);
});

// ====================================================
// === 6d. MIGRATION deal lama WAITING_SELLER (v3.9.34) ===
// ====================================================

test('migration: deal v3.9.33 WAITING_SELLER → WAITING_AGREE + buyerAgreed=true', () => {
    // Deal lama: creator = pembeli penulis terms (setuju implisit),
    // penjual belum klik setuju.
    resetDataFile('deals.json', {
        'ch-old': {
            channelId: 'ch-old',
            guildId: 'g1',
            buyerId: 'buyer-1',
            sellerId: 'seller-1',
            item: 'Akun',
            priceNum: 100000,
            state: 'WAITING_SELLER'
        },
        'ch-fresh': { guildId: 'g1', buyerId: 'b2', sellerId: 's2', state: 'WAITING_PAYMENT' }
    });
    // loadDeals menjalankan migrasi (module sudah ter-cache — panggil loadDeals
    // langsung, pola persistence test di atas).
    const all = mm.loadDeals();
    const old = all['ch-old'];
    assert.strictEqual(old.state, 'WAITING_AGREE');
    assert.strictEqual(old.buyerAgreed, true, 'pembeli lama = penulis terms → setuju implisit');
    assert.strictEqual(old.sellerAgreed, false);
    assert.deepStrictEqual(old.observers, []);
    // Deal lain tidak tersentuh.
    assert.strictEqual(all['ch-fresh'].state, 'WAITING_PAYMENT');
    // Migrasi di-save ke disk — file di disk sudah bentuk baru.
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'deals.json'), 'utf8'));
    assert.strictEqual(raw['ch-old'].state, 'WAITING_AGREE');
});

test('migration: deal baru sudah WAITING_AGREE tidak diubah (idempotent)', () => {
    resetDataFile('deals.json', {
        'ch-new': {
            channelId: 'ch-new',
            guildId: 'g1',
            buyerId: 'b',
            sellerId: 's',
            buyerAgreed: true,
            sellerAgreed: true,
            observers: ['w1'],
            state: 'WAITING_AGREE'
        }
    });
    const all = mm.loadDeals();
    assert.strictEqual(all['ch-new'].state, 'WAITING_AGREE');
    assert.strictEqual(all['ch-new'].buyerAgreed, true);
    assert.deepStrictEqual(all['ch-new'].observers, ['w1']);
});

// ====================================================
// === 7. CONFIG: DEFAULTS + migration kategori midman ===
// ====================================================

function freshConfigManager() {
    delete require.cache[require.resolve('../../src/data/configManager')];
    return require('../../src/data/configManager');
}

test('config DEFAULTS: midman fee ada & kategori midman terdaftar', () => {
    resetDataFile('config.json', {});
    const { getConfig, DEFAULTS } = freshConfigManager();
    const config = getConfig();
    assert.strictEqual(DEFAULTS.midman.feeMode, 'percent');
    assert.strictEqual(DEFAULTS.midman.feeValue, 5);
    assert.strictEqual(DEFAULTS.midman.category, '🤝 REKBER');
    // Merge default hadir walau raw kosong.
    assert.strictEqual(config.midman.feeMode, 'percent');
    const cats = (config.ticketCategories || []).map(c => c.id);
    assert.ok(cats.includes('midman'), 'kategori midman harus ada di DEFAULTS ticketCategories');
});

test('config migration: config lama otomatis dapat kategori midman (sekali saja)', () => {
    // Simulasi config v3.9.31 lama — belum ada kategori midman.
    resetDataFile('config.json', {
        roles: { admin: '123' },
        ticketCategories: [
            { id: 'transaction', label: 'Beli Key / Transaksi', emoji: '🔑', style: 'Primary', requiresKey: true },
            { id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false }
        ],
        products: []
    });
    const { getConfig } = freshConfigManager();
    const config = getConfig();
    const cats = config.ticketCategories.map(c => c.id);
    assert.ok(cats.includes('midman'), 'migration harus menambah kategori midman');
    assert.ok(config.ticketCategories.find(c => c.id === 'midman').emoji === '🤝');
    // Migration di-save ke disk — getConfig ulang tidak menambah dobel.
    const config2 = freshConfigManager().getConfig();
    const midmanCount = config2.ticketCategories.filter(c => c.id === 'midman').length;
    assert.strictEqual(midmanCount, 1, 'kategori midman tidak boleh dobel setelah re-read');
});

test('config migration: flag midmanCategoryDismissed mencegah re-add setelah /remove-category', () => {
    resetDataFile('config.json', {
        roles: { admin: '123' },
        midmanCategoryDismissed: true,
        ticketCategories: [{ id: 'transaction', label: 'Beli Key', emoji: '🔑', style: 'Primary' }],
        products: []
    });
    const { getConfig } = freshConfigManager();
    const cats = getConfig().ticketCategories.map(c => c.id);
    assert.ok(!cats.includes('midman'), 'kategori midman TIDAK boleh ditambah lagi jika dismissed');
});

test('config merge: field midman custom admin preserve', () => {
    resetDataFile('config.json', { roles: { admin: '1' }, midman: { feeMode: 'flat', feeValue: 2500 }, products: [] });
    const { getConfig } = freshConfigManager();
    const config = getConfig();
    assert.strictEqual(config.midman.feeMode, 'flat');
    assert.strictEqual(config.midman.feeValue, 2500);
    // Field yang tidak di-set admin fallback ke DEFAULTS (category).
    assert.strictEqual(config.midman.category, '🤝 REKBER');
});

// ====================================================
// === 8. findActiveTicketFor (ticketManager) ===
// ====================================================

test('findActiveTicketFor: meta ada → aktif; zombie meta → cleanup & null', async () => {
    resetDataFile('tickets.json', {
        'ch-live': { userId: 'user-1', guildId: 'g1', productName: 'VIP' },
        'ch-zombie': { userId: 'user-2', guildId: 'g1', productName: 'VIP' }
    });
    delete require.cache[require.resolve('../../src/data/ticketManager')];
    const { findActiveTicketFor } = require('../../src/data/ticketManager');

    // Guild fake: ch-live ter-cache; ch-zombie tidak ter-cache & fetch → throw.
    // v3.9.38: mock fetch ikut kontrak discord.js ASLI — channel yang sudah
    // dihapus membuat guild.channels.fetch THROW error code 10003 (Unknown
    // Channel), bukan resolve null. ticketManager (fix paralel domain tiket)
    // kini hanya menghapus meta zombie pada 10003; mock lama (resolve null)
    // tidak lagi memicu cleanup. Mock diperbarui agar realistis.
    const unknownChannelErr = () => {
        const e = new Error('Unknown Channel');
        e.code = 10003;
        return e;
    };
    const fakeGuild = {
        id: 'g1',
        channels: {
            cache: new Map([['ch-live', { id: 'ch-live', name: 'ticket-1' }]]),
            fetch: async id => {
                if (id === 'ch-uncached') return { id: 'ch-uncached' };
                throw unknownChannelErr();
            }
        }
    };

    // user-1: meta + channel ter-cache → dapat channel.
    const live = await findActiveTicketFor(fakeGuild, 'user-1');
    assert.ok(live);
    assert.strictEqual(live.id, 'ch-live');

    // user-2: meta ada tapi channel hilang (fetch null) → null + zombie dihapus.
    const zombie = await findActiveTicketFor(fakeGuild, 'user-2');
    assert.strictEqual(zombie, null);
    const ticketsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tickets.json'), 'utf8'));
    assert.ok(!ticketsRaw['ch-zombie'], 'metadata zombie harus terhapus');
    assert.ok(ticketsRaw['ch-live'], 'metadata channel hidup tidak boleh ikut terhapus');

    // user-3: tidak punya tiket → null.
    assert.strictEqual(await findActiveTicketFor(fakeGuild, 'user-3'), null);
});
