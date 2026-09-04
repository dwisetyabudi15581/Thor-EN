/**
 * Unit tests v3.9.32–v3.9.34 — Midman/Escrow feature (3-party escrow deal).
 *
 * What is tested (pure layer — classifyProduct pattern: the core logic is
 * extracted into midmanManager so it can be tested without mocking Discord):
 *   1. State machine: step order cannot be skipped (canTransition/
 *      nextState) — the core of the escrow "double gate" security.
 *   2. actorAllowed: only the authorized party can perform an event.
 *   3. calcFee: percent / flat / 0 / invalid mode (v3.9.33: additive, no cap).
 *   4. calcTotals: the fee is added on top of the price — the seller receives the FULL price.
 *   5. parsePriceNumber: "100000" / "100.000" / "100k" / "1m" / invalid.
 *   6. formatRupiah.
 *   7. deals.json persistence: setDeal/getDeal/removeDeal/hasActiveDealFor.
 *   8. Config: midman DEFAULTS + 'midman' category migration into old configs
 *      (once only — the midmanCategoryDismissed flag prevents re-adding).
 *   9. findActiveTicketFor (ticketManager): meta exists → active; zombie meta
 *      (channel gone) → cleaned up & returns null.
 *  10. v3.9.34: applyAgreement — dual consent (partial vs both vs
 *      double-click vs non-participant).
 *  11. v3.9.34: observer (extra member) — canAddObserver/addObserver/
 *      removeObserver + participant/duplicate/limit guards.
 *  12. v3.9.34: migration of old WAITING_SELLER deals → WAITING_AGREE.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: production data files are snapshotted & restored ===
// === (hardeningV31.test.js pattern)                             ===
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
    // Files that did NOT exist before the test → remove test output (new deals.json).
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
// === 1. STATE MACHINE — step order cannot be skipped ===
// ====================================================

const mm = require('../../src/data/midmanManager');

test('state machine: full happy path agree→payment→delivery→release', () => {
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

test('state machine: double gate — release rejected before goods are delivered', () => {
    // Deal not yet goods-delivered → the middleman cannot release the funds (classic fraud scheme).
    assert.strictEqual(mm.nextState('WAITING_DELIVERY', 'release'), null);
    assert.strictEqual(mm.canTransition('WAITING_DELIVERY', 'release'), false);
    // Same goes for before funds are received.
    assert.strictEqual(mm.nextState('WAITING_PAYMENT', 'release'), null);
});

test('state machine: double fundin / double join rejected', () => {
    assert.strictEqual(mm.nextState('WAITING_DELIVERY', 'fundin'), null);
    assert.strictEqual(mm.nextState('WAITING_PAYMENT', 'join'), null);
});

test('state machine: cancel only before funds are received', () => {
    assert.strictEqual(mm.canTransition('WAITING_AGREE', 'cancel'), true);
    assert.strictEqual(mm.canTransition('WAITING_PAYMENT', 'cancel'), true);
    // Once the funds are with the middleman — a refund MUST go through dispute + admin resolve.
    assert.strictEqual(mm.canTransition('WAITING_DELIVERY', 'cancel'), false);
    assert.strictEqual(mm.canTransition('WAITING_RELEASE', 'cancel'), false);
    assert.strictEqual(mm.canTransition('DISPUTE', 'cancel'), false);
});

test('state machine: dispute valid mid-flow, not at the start/terminal', () => {
    assert.strictEqual(mm.canTransition('WAITING_PAYMENT', 'dispute'), true);
    assert.strictEqual(mm.canTransition('WAITING_DELIVERY', 'dispute'), true);
    assert.strictEqual(mm.canTransition('WAITING_RELEASE', 'dispute'), true);
    assert.strictEqual(mm.canTransition('WAITING_AGREE', 'dispute'), false);
    assert.strictEqual(mm.canTransition('COMPLETED', 'dispute'), false);
});

test('state machine: all actions dead during DISPUTE & terminal states', () => {
    for (const event of ['join', 'fundin', 'received', 'release', 'cancel', 'dispute']) {
        assert.strictEqual(mm.canTransition('DISPUTE', event), false, `event ${event} must be dead during DISPUTE`);
    }
    for (const event of ['join', 'fundin', 'received', 'release', 'cancel', 'dispute']) {
        assert.strictEqual(mm.canTransition('COMPLETED', event), false);
    }
    // Only admin resolve stays alive from DISPUTE.
    assert.strictEqual(mm.canTransition('DISPUTE', 'resolve_release'), true);
    assert.strictEqual(mm.canTransition('DISPUTE', 'resolve_refund'), true);
});

test('state machine: unknown event → false (defensive)', () => {
    assert.strictEqual(mm.canTransition('WAITING_AGREE', 'hack_the_system'), false);
    assert.strictEqual(mm.nextState('WAITING_AGREE', ''), null);
    assert.strictEqual(mm.canTransition(null, 'join'), false);
});

// ====================================================
// === 2. ACTOR — only authorized parties ===
// ====================================================

const BUYER = { isBuyer: true, isSeller: false, isMidman: false, isAdmin: false };
const SELLER = { isBuyer: false, isSeller: true, isMidman: false, isAdmin: false };
const MIDMAN = { isBuyer: false, isSeller: false, isMidman: true, isAdmin: false };
const ADMIN = { isBuyer: false, isSeller: false, isMidman: false, isAdmin: true };
const OUTSIDER = { isBuyer: false, isSeller: false, isMidman: false, isAdmin: false };

test('actor: v3.9.34 — buyer AND seller can join; only the buyer can received', () => {
    // Dual consent: whoever creates the deal, both the buyer & the seller
    // must agree to the terms.
    assert.strictEqual(mm.actorAllowed('join', SELLER), true);
    assert.strictEqual(mm.actorAllowed('join', BUYER), true);
    assert.strictEqual(mm.actorAllowed('join', MIDMAN), false);
    assert.strictEqual(mm.actorAllowed('join', ADMIN), false);
    assert.strictEqual(mm.actorAllowed('join', OUTSIDER), false);
    assert.strictEqual(mm.actorAllowed('received', BUYER), true);
    assert.strictEqual(mm.actorAllowed('received', SELLER), false);
    assert.strictEqual(mm.actorAllowed('received', MIDMAN), false);
});

test('actor: only midman/admin can fundin & release', () => {
    assert.strictEqual(mm.actorAllowed('fundin', MIDMAN), true);
    assert.strictEqual(mm.actorAllowed('fundin', ADMIN), true);
    assert.strictEqual(mm.actorAllowed('fundin', BUYER), false);
    assert.strictEqual(mm.actorAllowed('release', MIDMAN), true);
    assert.strictEqual(mm.actorAllowed('release', BUYER), false);
    assert.strictEqual(mm.actorAllowed('release', SELLER), false);
});

test('actor: only admin can resolve a dispute', () => {
    assert.strictEqual(mm.actorAllowed('resolve_release', ADMIN), true);
    assert.strictEqual(mm.actorAllowed('resolve_refund', ADMIN), true);
    assert.strictEqual(mm.actorAllowed('resolve_release', MIDMAN), false);
    assert.strictEqual(mm.actorAllowed('resolve_refund', BUYER), false);
});

test('actor: participants may dispute, outsiders may not', () => {
    assert.strictEqual(mm.actorAllowed('dispute', BUYER), true);
    assert.strictEqual(mm.actorAllowed('dispute', SELLER), true);
    assert.strictEqual(mm.actorAllowed('dispute', MIDMAN), true);
    assert.strictEqual(mm.actorAllowed('dispute', OUTSIDER), false);
});

test('actor: cancel — buyer/seller/admin allowed, midman not', () => {
    assert.strictEqual(mm.actorAllowed('cancel', BUYER), true);
    assert.strictEqual(mm.actorAllowed('cancel', SELLER), true);
    assert.strictEqual(mm.actorAllowed('cancel', ADMIN), true);
    assert.strictEqual(mm.actorAllowed('cancel', MIDMAN), false);
    assert.strictEqual(mm.actorAllowed('cancel', OUTSIDER), false);
});

// ====================================================
// === 3. FEE ===
// ====================================================

test('calcFee: percent mode', () => {
    assert.strictEqual(mm.calcFee(100000, 'percent', 5), 5000);
    assert.strictEqual(mm.calcFee(250000, 'percent', 3), 7500);
    // Rounding: 99999 * 5% = 4999.95 → 5000
    assert.strictEqual(mm.calcFee(99999, 'percent', 5), 5000);
});

test('calcFee: flat mode', () => {
    assert.strictEqual(mm.calcFee(100000, 'flat', 5000), 5000);
    assert.strictEqual(mm.calcFee(50000, 'flat', 5000), 5000);
});

test('calcFee: fee 0 = free, negative/invalid value = 0', () => {
    assert.strictEqual(mm.calcFee(100000, 'percent', 0), 0);
    assert.strictEqual(mm.calcFee(100000, 'percent', -10), 0);
    assert.strictEqual(mm.calcFee(-100, 'percent', 5), 0);
    assert.strictEqual(mm.calcFee('abc', 'percent', 5), 0);
});

test('calcFee: v3.9.33 — fee is ADDITIVE, not capped at the deal price', () => {
    // A flat fee may exceed the price (the admin sets it — /set-midman-fee
    // caps the max percent at 90% on the command side; percent can never be > price).
    assert.strictEqual(mm.calcFee(100000, 'percent', 90), 90000);
    assert.strictEqual(mm.calcFee(10000, 'flat', 999999), 999999);
    assert.strictEqual(mm.calcFee(100000, 'percent', 150), 150000);
});

test('calcFee: unknown mode → fee 0 (the deal still proceeds)', () => {
    assert.strictEqual(mm.calcFee(100000, 'weird', 50), 0);
    assert.strictEqual(mm.calcFee(100000, undefined, 50), 0);
});

test('calcTotals: v3.9.33 — fee added on top of the price (user example: 100k + 5% = 105k)', () => {
    // Exact example from the user's policy: price 100,000, fee 5% (5,000)
    // → the buyer transfers 105,000, the seller receives the FULL 100,000.
    const fee = mm.calcFee(100000, 'percent', 5);
    const totals = mm.calcTotals(100000, fee);
    assert.deepStrictEqual(totals, { buyerPays: 105000, sellerGets: 100000, midmanKeeps: 5000 });
});

test('calcTotals: fee 0 → the buyer pays exactly the price; the seller gets the full price', () => {
    assert.deepStrictEqual(mm.calcTotals(100000, 0), { buyerPays: 100000, sellerGets: 100000, midmanKeeps: 0 });
});

test('calcTotals: invalid/negative input → no NaN thrown, negative fee clamped to 0', () => {
    assert.deepStrictEqual(mm.calcTotals('abc', 'x'), { buyerPays: 0, sellerGets: 0, midmanKeeps: 0 });
    assert.deepStrictEqual(mm.calcTotals(null, null), { buyerPays: 0, sellerGets: 0, midmanKeeps: 0 });
    // A negative fee (corrupt deal / manual edit) must not "reduce" the total.
    assert.deepStrictEqual(mm.calcTotals(50000, -3000), { buyerPays: 50000, sellerGets: 50000, midmanKeeps: 0 });
});

// ====================================================
// === 4-5. MODAL INPUT PARSER (price) ===
// ====================================================
// v3.9.33: parseSellerInput removed — the seller is picked via a member
// dropdown (User Select Menu), not a mention/ID text input.

test('parsePriceNumber: common rupiah formats', () => {
    assert.strictEqual(mm.parsePriceNumber('100000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('100.000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('100,000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('Rp100.000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('rp 100000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('100k'), 100000);
    assert.strictEqual(mm.parsePriceNumber('1m'), 1000000);
    assert.strictEqual(mm.parsePriceNumber(50000), 50000);
});

test('parsePriceNumber: invalid input → 0', () => {
    assert.strictEqual(mm.parsePriceNumber('abc'), 0);
    assert.strictEqual(mm.parsePriceNumber(''), 0);
    assert.strictEqual(mm.parsePriceNumber('-5000'), 0);
    assert.strictEqual(mm.parsePriceNumber('0'), 0);
    assert.strictEqual(mm.parsePriceNumber(null), 0);
});

test('formatRupiah: en-US locale', () => {
    assert.strictEqual(mm.formatRupiah(95000), 'Rp95,000');
    assert.strictEqual(mm.formatRupiah(1000000), 'Rp1,000,000');
    assert.strictEqual(mm.formatRupiah(0), 'Rp0');
});

// ====================================================
// === 6. deals.json PERSISTENCE ===
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
    // v3.9.34: loadDeals normalizes the new fields (observers/buyerAgreed/
    // sellerAgreed) — getDeal returns the complete shape.
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

test('hasActiveDealFor: buyer & seller detected, outsiders not', () => {
    resetDataFile('deals.json', {
        ch1: { guildId: 'g1', buyerId: 'buyer-1', sellerId: 'seller-1', state: 'WAITING_PAYMENT' }
    });
    assert.strictEqual(mm.hasActiveDealFor('g1', 'buyer-1'), true);
    assert.strictEqual(mm.hasActiveDealFor('g1', 'seller-1'), true);
    assert.strictEqual(mm.hasActiveDealFor('g1', 'random-guy'), false);
    // Another guild with the same userId → no leak (per-guild isolation).
    assert.strictEqual(mm.hasActiveDealFor('g2', 'buyer-1'), false);
});

test('hasActiveDealFor: terminal states are not counted as active', () => {
    resetDataFile('deals.json', {
        ch1: { guildId: 'g1', buyerId: 'buyer-1', sellerId: 'seller-1', state: 'COMPLETED' }
    });
    assert.strictEqual(mm.hasActiveDealFor('g1', 'buyer-1'), false);
    assert.strictEqual(mm.hasActiveDealFor('g1', 'seller-1'), false);
});

test('recordTransition: state changes + history recorded; invalid event → null', () => {
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

    // An invalid event from the current state → null, state unchanged.
    assert.strictEqual(mm.recordTransition(deal, 'join', actor), null);
    assert.strictEqual(deal.state, 'WAITING_DELIVERY');
    assert.strictEqual(deal.history.length, 1); // no fake entry
});

// ====================================================
// === 6b. DUAL CONSENT (v3.9.34) ===
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

test('applyAgreement: first click = partial, second click = both', () => {
    const deal = mkDeal();
    // The buyer agrees first — still waiting for the seller.
    let res = mm.applyAgreement(deal, 'buyer-1');
    assert.deepStrictEqual(res, { ok: true, both: false, role: 'buyer' });
    assert.strictEqual(deal.buyerAgreed, true);
    assert.strictEqual(deal.sellerAgreed, false);
    // The seller follows → both = true (the caller must recordTransition join).
    res = mm.applyAgreement(deal, 'seller-1');
    assert.deepStrictEqual(res, { ok: true, both: true, role: 'seller' });
    assert.strictEqual(deal.state, 'WAITING_AGREE'); // the manager does not change state
});

test('applyAgreement: seller-first order is also valid (the creator can be anyone)', () => {
    const deal = mkDeal();
    let res = mm.applyAgreement(deal, 'seller-1');
    assert.deepStrictEqual(res, { ok: true, both: false, role: 'seller' });
    res = mm.applyAgreement(deal, 'buyer-1');
    assert.deepStrictEqual(res, { ok: true, both: true, role: 'buyer' });
});

test('applyAgreement: double-click / a party that already agreed → rejected', () => {
    const deal = mkDeal({ buyerAgreed: true });
    const res = mm.applyAgreement(deal, 'buyer-1');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.both, false);
    // Flag unchanged (no fake history entry from a double-click).
    assert.strictEqual(deal.buyerAgreed, true);
    assert.strictEqual(deal.sellerAgreed, false);
});

test('applyAgreement: non-participant (observer/outsider) → rejected', () => {
    const deal = mkDeal();
    assert.strictEqual(mm.applyAgreement(deal, 'random-guy').ok, false);
    assert.strictEqual(mm.applyAgreement(deal, null).ok, false);
    assert.strictEqual(mm.applyAgreement(null, 'buyer-1').ok, false);
});

test('applyAgreement + recordTransition: caller contract — join is only recorded after both agree', () => {
    const deal = mkDeal();
    const actor = { id: 'buyer-1', tag: 'budi#0001' };
    // Buyer clicks alone → both=false → the caller does NOT call recordTransition
    // (state stays WAITING_AGREE; the partial consent is recorded by the caller in history).
    const partial = mm.applyAgreement(deal, 'buyer-1');
    assert.strictEqual(partial.both, false);
    assert.strictEqual(deal.state, 'WAITING_AGREE');
    // The seller follows → both=true → NOW recordTransition join is valid.
    const both = mm.applyAgreement(deal, 'seller-1');
    assert.strictEqual(both.both, true);
    const applied = mm.recordTransition(deal, 'join', actor);
    assert.strictEqual(applied, deal);
    assert.strictEqual(deal.state, 'WAITING_PAYMENT');
    assert.strictEqual(deal.history.length, 1);
    assert.strictEqual(deal.history[0].event, 'join');
});

// ====================================================
// === 6c. OBSERVER / EXTRA MEMBER (v3.9.34) ===
// ====================================================

test('observer: add & remove an extra member', () => {
    const deal = mkDeal();
    assert.strictEqual(mm.addObserver(deal, 'witness-1'), true);
    assert.deepStrictEqual(deal.observers, ['witness-1']);
    assert.strictEqual(mm.removeObserver(deal, 'witness-1'), true);
    assert.deepStrictEqual(deal.observers, []);
    // Removing someone who is not an observer → false.
    assert.strictEqual(mm.removeObserver(deal, 'witness-1'), false);
});

test('observer: the buyer/seller CANNOT become an extra member', () => {
    const deal = mkDeal();
    assert.deepStrictEqual(mm.canAddObserver(deal, 'buyer-1'), { ok: false, reason: 'principal' });
    assert.deepStrictEqual(mm.canAddObserver(deal, 'seller-1'), { ok: false, reason: 'principal' });
    assert.strictEqual(mm.addObserver(deal, 'buyer-1'), false);
    assert.deepStrictEqual(deal.observers, []);
});

test('observer: duplicate & max limit', () => {
    const deal = mkDeal();
    for (let i = 0; i < mm.MAX_OBSERVERS; i++) {
        assert.strictEqual(mm.addObserver(deal, `obs-${i}`), true);
    }
    assert.deepStrictEqual(mm.canAddObserver(deal, 'obs-11'), { ok: false, reason: 'full' });
    // Duplicate of the first observer.
    assert.deepStrictEqual(mm.canAddObserver(deal, 'obs-0'), { ok: false, reason: 'duplicate' });
    assert.strictEqual(mm.MAX_OBSERVERS, 10);
});

test('observer: invalid input defensively rejected', () => {
    assert.deepStrictEqual(mm.canAddObserver(mkDeal(), null), { ok: false, reason: 'invalid' });
    assert.deepStrictEqual(mm.canAddObserver(null, 'x'), { ok: false, reason: 'invalid' });
    assert.strictEqual(mm.addObserver(null, 'x'), false);
    assert.strictEqual(mm.removeObserver(null, 'x'), false);
    // Deal without the observers field (old data) → removeObserver false, no crash.
    assert.strictEqual(mm.removeObserver({ buyerId: 'b', sellerId: 's' }, 'x'), false);
});

// ====================================================
// === 6d. MIGRATION of old WAITING_SELLER deals (v3.9.34) ===
// ====================================================

test('migration: deal v3.9.33 WAITING_SELLER → WAITING_AGREE + buyerAgreed=true', () => {
    // Old deal: creator = the buyer who wrote the terms (implicit consent),
    // the seller has not clicked agree yet.
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
    // loadDeals runs the migration (module already cached — call loadDeals
    // directly, same pattern as the persistence tests above).
    const all = mm.loadDeals();
    const old = all['ch-old'];
    assert.strictEqual(old.state, 'WAITING_AGREE');
    assert.strictEqual(old.buyerAgreed, true, 'old buyer = terms writer → implicit consent');
    assert.strictEqual(old.sellerAgreed, false);
    assert.deepStrictEqual(old.observers, []);
    // Other deals are untouched.
    assert.strictEqual(all['ch-fresh'].state, 'WAITING_PAYMENT');
    // The migration is saved to disk — the on-disk file is already in the new shape.
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'deals.json'), 'utf8'));
    assert.strictEqual(raw['ch-old'].state, 'WAITING_AGREE');
});

test('migration: a new deal already WAITING_AGREE is unchanged (idempotent)', () => {
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
// === 7. CONFIG: DEFAULTS + midman category migration ===
// ====================================================

function freshConfigManager() {
    delete require.cache[require.resolve('../../src/data/configManager')];
    return require('../../src/data/configManager');
}

test('config DEFAULTS: midman fee exists & midman category registered', () => {
    resetDataFile('config.json', {});
    const { getConfig, DEFAULTS } = freshConfigManager();
    const config = getConfig();
    assert.strictEqual(DEFAULTS.midman.feeMode, 'percent');
    assert.strictEqual(DEFAULTS.midman.feeValue, 5);
    assert.strictEqual(DEFAULTS.midman.category, '🤝 ESCROW');
    // The default merge is present even with an empty raw config.
    assert.strictEqual(config.midman.feeMode, 'percent');
    const cats = (config.ticketCategories || []).map(c => c.id);
    assert.ok(cats.includes('midman'), 'the midman category must exist in DEFAULTS ticketCategories');
});

test('config migration: an old config automatically gets the midman category (once only)', () => {
    // Simulate an old v3.9.31 config — no midman category yet.
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
    assert.ok(cats.includes('midman'), 'migration must add the midman category');
    assert.ok(config.ticketCategories.find(c => c.id === 'midman').emoji === '🤝');
    // The migration is saved to disk — re-reading getConfig does not add a duplicate.
    const config2 = freshConfigManager().getConfig();
    const midmanCount = config2.ticketCategories.filter(c => c.id === 'midman').length;
    assert.strictEqual(midmanCount, 1, 'the midman category must not be duplicated after a re-read');
});

test('config migration: the midmanCategoryDismissed flag prevents re-adding after /remove-category', () => {
    resetDataFile('config.json', {
        roles: { admin: '123' },
        midmanCategoryDismissed: true,
        ticketCategories: [{ id: 'transaction', label: 'Beli Key', emoji: '🔑', style: 'Primary' }],
        products: []
    });
    const { getConfig } = freshConfigManager();
    const cats = getConfig().ticketCategories.map(c => c.id);
    assert.ok(!cats.includes('midman'), 'the midman category must NOT be added again once dismissed');
});

test('config merge: custom admin midman fields preserved', () => {
    resetDataFile('config.json', { roles: { admin: '1' }, midman: { feeMode: 'flat', feeValue: 2500 }, products: [] });
    const { getConfig } = freshConfigManager();
    const config = getConfig();
    assert.strictEqual(config.midman.feeMode, 'flat');
    assert.strictEqual(config.midman.feeValue, 2500);
    // Fields not set by the admin fall back to DEFAULTS (category).
    assert.strictEqual(config.midman.category, '🤝 ESCROW');
});

// ====================================================
// === 8. findActiveTicketFor (ticketManager) ===
// ====================================================

test('findActiveTicketFor: meta exists → active; zombie meta → cleanup & null', async () => {
    resetDataFile('tickets.json', {
        'ch-live': { userId: 'user-1', guildId: 'g1', productName: 'VIP' },
        'ch-zombie': { userId: 'user-2', guildId: 'g1', productName: 'VIP' }
    });
    delete require.cache[require.resolve('../../src/data/ticketManager')];
    const { findActiveTicketFor } = require('../../src/data/ticketManager');

    // Fake guild: ch-live is cached; ch-zombie is not cached & fetch → throw.
    // v3.9.38: the fetch mock follows the REAL discord.js contract — a deleted
    // channel makes guild.channels.fetch THROW error code 10003 (Unknown
    // Channel), not resolve null. ticketManager (parallel ticket-domain fix)
    // now only deletes zombie meta on 10003; the old mock (resolve null) no
    // longer triggers the cleanup. The mock was updated to be realistic.
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

    // user-1: meta + cached channel → gets the channel.
    const live = await findActiveTicketFor(fakeGuild, 'user-1');
    assert.ok(live);
    assert.strictEqual(live.id, 'ch-live');

    // user-2: meta exists but the channel is gone (fetch throws) → null + zombie deleted.
    const zombie = await findActiveTicketFor(fakeGuild, 'user-2');
    assert.strictEqual(zombie, null);
    const ticketsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'tickets.json'), 'utf8'));
    assert.ok(!ticketsRaw['ch-zombie'], 'zombie metadata must be deleted');
    assert.ok(ticketsRaw['ch-live'], 'live channel metadata must not be deleted too');

    // user-3: no ticket → null.
    assert.strictEqual(await findActiveTicketFor(fakeGuild, 'user-3'), null);
});
