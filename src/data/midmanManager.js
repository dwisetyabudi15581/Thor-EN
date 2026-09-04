/**
 * Midman (Escrow) Manager — data layer & state machine for 3-party escrow deals.
 * v3.9.34.
 *
 * File: data/deals.json
 * {
 *   "<channelId>": {
 *     "channelId": "123...",
 *     "guildId":    "123...",
 *     "buyerId":    "123...",   // buyer
 *     "sellerId":   "123...",   // seller
 *     // v3.9.34: a deal can be opened by anyone (buyer/seller/helpful third
 *     // party) — the role is chosen explicitly via a 3-step form.
 *     "buyerAgreed":  false,     // v3.9.34: dual consent (WAITING_AGREE)
 *     "sellerAgreed": false,
 *     "observers":  ["123..."],  // v3.9.34: additional (non-participant) members in the deal channel
 *     "item":       "Akun ML Mythic",
 *     "priceNum":   100000,     // deal price in rupiah (number)
 *     "priceText":  "Rp100.000",
 *     "fee":        5000,       // middleman fee (computed when the deal is created)
 *     "feeMode":    "percent",  // v3.9.33: fee mode snapshot at deal creation
 *     "feeValue":   5,          // v3.9.33: fee value snapshot at deal creation
 *     "state":      "WAITING_PAYMENT",
 *     "boardMessageId": "123...", // Deal Board message ID (embed as the source of truth)
 *     "createdBy":  "123...",
 *     "createdAt":  1725...,
 *     "history": [ { ts, event, fromState, toState, actorId, actorTag } ]
 *   }
 * }
 *
 * === CORE PRINCIPLE ===
 * Escrow means a THIRD PARTY holds the funds. Escrow failure modes are always
 * about "who said what in chat" — chat can be edited/deleted, so chat is not proof.
 * The solution: the Deal Board (bot embed) is the source of truth, and ALL
 * state transitions go only through buttons with DUAL validation:
 *   1. `canTransition(state, event)`  → the step order cannot be skipped.
 *   2. `actorAllowed(event, roles)`   → only the authorized party can click.
 *
 * Examples the bot AUTOMATICALLY REJECTS:
 *   - Midman clicks "Release" before the buyer confirms the goods (release from
 *     WAITING_DELIVERY → invalid).
 *   - Buyer clicks "Funds Received" while posing as the midman            (wrong actor).
 *   - Any action while in DISPUTE                                        (state frozen).
 *
 * v3.9.34: initial state WAITING_AGREE — BOTH the BUYER AND SELLER must
 * click "Agree to Deal" before the terms are locked (before, only the seller,
 * because the deal creator was always the buyer who wrote the terms). Now the
 * creator can be anyone, so dual consent preserves the principle "the party
 * that did NOT write the terms must approve them".
 *
 * Pure functions (canTransition, nextState, actorAllowed, calcFee,
 * calcTotals, parsePriceNumber, formatRupiah, applyAgreement,
 * canAddObserver, addObserver, removeObserver) follow the
 * classifyProduct() v3.9.28 pattern: extracted so they can be unit-tested
 * without mocking Discord.
 *
 * v3.9.33 fee revision: the fee is ADDED ON TOP of the price (additive), NOT
 * deducted from the seller's funds. Example: price 100.000 + 5% fee (5.000) →
 * the buyer transfers 105.000, the seller receives the FULL 100.000, the
 * middleman keeps 5.000. The seller never "loses" part of the deal price to the fee.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const dealsPath = path.join(__dirname, '..', '..', 'data', 'deals.json');

// ====================================================
// === DEAL STATES ===
// ====================================================
const STATES = {
    // v3.9.34: WAITING_SELLER replaced by WAITING_AGREE — the buyer & seller
    // must BOTH agree (the deal creator can be anyone now).
    // Old deals (WAITING_SELLER) are migrated automatically at load (see loadDeals).
    WAITING_AGREE: { label: '⏳ Waiting for Buyer & Seller to Agree to the Deal', color: 0xf1c40f },
    WAITING_PAYMENT: { label: '💰 Waiting for Payment to the Middleman', color: 0xe67e22 },
    WAITING_DELIVERY: { label: '📦 Waiting for the Seller to Deliver the Goods', color: 0x3498db },
    WAITING_RELEASE: { label: '✅ Goods Delivered — Waiting for Payout', color: 0x9b59b6 },
    DISPUTE: { label: '🚨 DISPUTE — Deal Frozen', color: 0xed4245 },
    // Terminal states (deal finished — meta is removed from deals.json at close):
    COMPLETED: { label: '✅ Completed — Funds Released to the Seller', color: 0x2ecc71 },
    REFUNDED: { label: '↩️ Completed — Funds Returned to the Buyer', color: 0x95a5a6 },
    CANCELLED: { label: '❌ Cancelled (before funds arrived)', color: 0x95a5a6 }
};

const TERMINAL_STATES = new Set(['COMPLETED', 'REFUNDED', 'CANCELLED']);

// ====================================================
// === TRANSITION TABLE — the heart of escrow ===
// ====================================================
// Normal order: WAITING_AGREE → (buyer & seller join) → WAITING_PAYMENT →
// (midman fundin) → WAITING_DELIVERY → (buyer received) → WAITING_RELEASE →
// (midman release) → COMPLETED.
//
// Two "dual gates" (the core of escrow security):
//   - Goods may be delivered ONLY after the midman confirms funds received.
//   - Funds may be released ONLY after the buyer confirms goods delivered.
//   - v3.9.34: Terms are locked ONLY after the buyer & seller BOTH agree
//     (the third gate — the deal creator can be anyone).
// No single person can move a deal past a gate that isn't theirs to control.
const TRANSITIONS = {
    // v3.9.34: join = consent from a deal party. The actor can be the buyer OR seller;
    // the transition to WAITING_PAYMENT happens only after BOTH parties agree
    // (buyerAgreed/sellerAgreed flags — see applyAgreement).
    join: { from: ['WAITING_AGREE'], to: 'WAITING_PAYMENT', actors: ['buyer', 'seller'] },
    // Cancel is only allowed before funds arrive — once the midman holds the
    // funds, any refund MUST go through dispute + admin resolution (recorded).
    cancel: { from: ['WAITING_AGREE', 'WAITING_PAYMENT'], to: 'CANCELLED', actors: ['buyer', 'seller', 'admin'] },
    fundin: { from: ['WAITING_PAYMENT'], to: 'WAITING_DELIVERY', actors: ['midman', 'admin'] },
    received: { from: ['WAITING_DELIVERY'], to: 'WAITING_RELEASE', actors: ['buyer'] },
    dispute: { from: ['WAITING_PAYMENT', 'WAITING_DELIVERY', 'WAITING_RELEASE'], to: 'DISPUTE', actors: ['buyer', 'seller', 'midman', 'admin'] },
    release: { from: ['WAITING_RELEASE'], to: 'COMPLETED', actors: ['midman', 'admin'] },
    // Dispute resolution — admin only (the midman is an interested party on the
    // fee, so final dispute decisions must sit above the midman):
    resolve_release: { from: ['DISPUTE'], to: 'COMPLETED', actors: ['admin'] },
    resolve_refund: { from: ['DISPUTE'], to: 'REFUNDED', actors: ['admin'] }
};

// Per-channel lock: prevents a double-click race while a transition is being processed.
const transitionLocks = new Set();

// ====================================================
// === PERSISTENCE (pola ticketManager/keyManager) ===
// ====================================================

function loadDeals() {
    try {
        const raw = fs.readFileSync(dealsPath, 'utf8');
        const parsed = JSON.parse(raw);
        const all = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        migrateDeals(all);
        return all;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('⚠️ deals.json is corrupted, using {}. Message:', err.message);
            // v3.9.26 pattern: quarantine the corrupt file before continuing with empty —
            // so the next save doesn't overwrite the old data without a trace.
            quarantineCorruptFile(dealsPath);
        }
        return {};
    }
}

function saveDeals(all) {
    safeWriteJSON(dealsPath, all);
}

/**
 * v3.9.34 migration (runs once per deal, idempotent):
 *   - WAITING_SELLER (v3.9.32/33: creator = buyer, terms written by the
 *     buyer) → WAITING_AGREE with buyerAgreed=true (the buyer who wrote the
 *     terms = implicitly agreed), sellerAgreed=false (still must click agree).
 *   - deal without the `observers` field → [] (new field in v3.9.34).
 * Changes are saved immediately so the file on disk is always the new shape.
 */
function migrateDeals(all) {
    let migrated = false;
    for (const deal of Object.values(all)) {
        if (!deal || typeof deal !== 'object') continue;
        if (deal.state === 'WAITING_SELLER') {
            deal.state = 'WAITING_AGREE';
            if (deal.buyerAgreed === undefined) deal.buyerAgreed = true;
            if (deal.sellerAgreed === undefined) deal.sellerAgreed = false;
            migrated = true;
        }
        if (deal.observers === undefined) {
            deal.observers = [];
            migrated = true;
        }
        if (deal.buyerAgreed === undefined) {
            deal.buyerAgreed = false;
            migrated = true;
        }
        if (deal.sellerAgreed === undefined) {
            deal.sellerAgreed = false;
            migrated = true;
        }
    }
    if (migrated) saveDeals(all);
}

function getDeal(channelId) {
    if (!channelId) return null;
    return loadDeals()[channelId] || null;
}

function setDeal(channelId, deal) {
    if (!channelId || !deal) return;
    const all = loadDeals();
    all[channelId] = deal;
    saveDeals(all);
}

function removeDeal(channelId) {
    if (!channelId) return;
    const all = loadDeals();
    if (all[channelId]) {
        delete all[channelId];
        saveDeals(all);
    }
}

/**
 * Is the user involved in an active deal (as buyer OR seller) in this guild?
 *
 * Dual use:
 *   - createDeal: the buyer & seller must not be involved in 2 deals at once.
 *   - createTicket (ticketManager): a user with an active deal cannot open
 *     another regular ticket — prevents bypassing the escrow flow via a regular ticket.
 */
function hasActiveDealFor(guildId, userId) {
    if (!guildId || !userId) return false;
    const all = loadDeals();
    return Object.values(all).some(
        d =>
            d &&
            d.guildId === guildId &&
            !TERMINAL_STATES.has(d.state) &&
            (d.buyerId === userId || d.sellerId === userId)
    );
}

function getActiveDealsByGuild(guildId) {
    const all = loadDeals();
    return Object.values(all).filter(d => d && d.guildId === guildId && !TERMINAL_STATES.has(d.state));
}

// ====================================================
// === PURE FUNCTIONS (testable — classifyProduct pattern) ===
// ====================================================

/**
 * Is the event valid from the current state? (STEP-ORDER validation)
 */
function canTransition(state, event) {
    const t = TRANSITIONS[event];
    return Boolean(t && state && t.from.includes(state));
}

/**
 * The next state after the event — null if the transition is invalid.
 */
function nextState(state, event) {
    return canTransition(state, event) ? TRANSITIONS[event].to : null;
}

// Mapping of actor names in TRANSITIONS → role object keys.
// TRANSITIONS uses short names ('buyer'), the caller uses boolean flags
// ({isBuyer}) — this mapping joins the two.
const ACTOR_KEY_MAP = { buyer: 'isBuyer', seller: 'isSeller', midman: 'isMidman', admin: 'isAdmin' };

/**
 * Is the actor allowed to perform the event? (ROLE validation)
 *
 * @param {string} event
 * @param {{isBuyer: boolean, isSeller: boolean, isMidman: boolean, isAdmin: boolean}} roles
 *   Note: the caller (interactions/midman.js resolveActor) already guarantees
 *   isMidman/isAdmin are FALSE if the user is the buyer/seller of that deal —
 *   anti self-dealing (a midman cannot handle their own deal as a participant).
 */
function actorAllowed(event, roles) {
    const t = TRANSITIONS[event];
    if (!t || !roles) return false;
    return t.actors.some(a => roles[ACTOR_KEY_MAP[a] || a] === true);
}

/**
 * Compute the middleman fee. PURE — doesn't read config (the caller passes it).
 *
 * v3.9.33: ADDITIVE fee — added on top of the price, not deducted from the
 * seller's funds. Since it no longer "cuts" anyone's funds, the fee isn't
 * capped at the deal price (a flat fee may exceed the price; /set-midman-fee
 * already limits the max percent to 90% as a sanity guard on the command side).
 *
 * @param {number} priceNum - deal price (rupiah)
 * @param {string} feeMode - 'percent' | 'flat'
 * @param {number} feeValue - percent (e.g. 5 = 5%) or flat amount
 * @returns {number} fee amount in rupiah
 */
function calcFee(priceNum, feeMode, feeValue) {
    const price = Number(priceNum) || 0;
    if (price <= 0) return 0;
    const val = Number(feeValue) || 0;
    if (val <= 0) return 0;
    if (feeMode === 'percent') {
        return Math.round((price * val) / 100);
    }
    if (feeMode === 'flat') {
        return Math.round(val);
    }
    return 0; // unknown mode → fee 0 (the deal still proceeds, free)
}

/**
 * Deal amount breakdown (v3.9.33 — additive fee, single source of computation):
 *   buyerPays   = price + fee → what the buyer transfers to the middleman
 *   sellerGets  = price       → what the seller receives (FULL price, no deduction)
 *   midmanKeeps = fee         → the funds left in the middleman's hands after release
 *
 * Example: calcTotals(100000, 5000) →
 *   { buyerPays: 105000, sellerGets: 100000, midmanKeeps: 5000 }
 */
function calcTotals(priceNum, fee) {
    // Clamp negatives → 0 (defensive: calcFee never returns negative, but
    // old data/manual edits to deals.json must not turn totals negative).
    const price = Math.max(0, Number(priceNum) || 0);
    const feeNum = Math.max(0, Number(fee) || 0);
    return {
        buyerPays: price + feeNum,
        sellerGets: price,
        midmanKeeps: feeNum
    };
}

/**
 * Parse a price from modal input. Accepts: "100000", "100.000", "100,000",
 * "100k", "1m", "Rp100.000". Returns 0 if invalid.
 *
 * v3.9.38 FIX: decimals no longer "slip through" as extra digits (10x price bug).
 *   - With a k/m suffix: the remaining input must NOT contain `.`/`,` ("1.5m"
 *     used to parse as 15.000.000 — the decimal was read as extra digits).
 *   - Without a suffix: `.`/`,` are only valid as THOUSANDS separators — format
 *     `^\d{1,3}([.,]\d{3})*$` with a CONSISTENT separator type ("1.000.000"
 *     and "1,000,000" valid; "2.5", "1.000,000", "100000." invalid → 0).
 *     Escrow deal prices are always whole rupiah.
 */
function parsePriceNumber(input) {
    if (typeof input === 'number') return input > 0 ? Math.floor(input) : 0;
    if (!input || typeof input !== 'string') return 0;
    let s = String(input)
        .toLowerCase()
        .trim()
        .replace(/rp\.?/g, '')
        .replace(/\s/g, '');
    let multiplier = 1;
    const hasSuffix = s.endsWith('k') || s.endsWith('m');
    if (s.endsWith('k')) {
        multiplier = 1000;
        s = s.slice(0, -1);
    } else if (s.endsWith('m')) {
        multiplier = 1000000;
        s = s.slice(0, -1);
    }
    // v3.9.38 FIX: validate separators BEFORE stripping — see the JSDoc above.
    if (/[.,]/.test(s)) {
        if (hasSuffix) return 0; // "1.5m" / "0.5k" → invalid (not 15m/5k)
        // No suffix: only consistent thousands separators are allowed.
        const isDotGroups = /^\d{1,3}(\.\d{3})+$/.test(s);
        const isCommaGroups = /^\d{1,3}(,\d{3})+$/.test(s);
        if (!isDotGroups && !isCommaGroups) return 0; // "2.5" / "1.000,000" → 0
    }
    s = s.replace(/[.,]/g, '');
    if (!/^\d+$/.test(s)) return 0;
    return parseInt(s, 10) * multiplier;
}

/**
 * Format rupiah: 95000 → "Rp95,000" (en-US locale).
 */
function formatRupiah(n) {
    const num = Number(n) || 0;
    return 'Rp' + num.toLocaleString('en-US');
}

/**
 * v3.9.34: apply a deal party's consent (mutates the deal, no IO).
 *
 * Called when the buyer/seller clicks "Agree to Deal" in the WAITING_AGREE state.
 * The one that performs the `join` transition (→ WAITING_PAYMENT) is the caller,
 * ONLY after this function returns { ok: true, both: true }.
 *
 * @returns {{ok: boolean, both: boolean, role: string|null}}
 *   ok=false   → userId is not a deal participant, OR that party already agreed
 *                (double-click / stale button).
 *   both=true  → both parties agreed → the caller must recordTransition.
 */
function applyAgreement(deal, userId) {
    if (!deal || !userId) return { ok: false, both: false, role: null };
    let role = null;
    if (userId === deal.buyerId) role = 'buyer';
    else if (userId === deal.sellerId) role = 'seller';
    if (!role) return { ok: false, both: false, role: null };
    const flag = role === 'buyer' ? 'buyerAgreed' : 'sellerAgreed';
    if (deal[flag]) return { ok: false, both: false, role };
    deal[flag] = true;
    const both = Boolean(deal.buyerAgreed && deal.sellerAgreed);
    return { ok: true, both, role };
}

// ====================================================
// === OBSERVER (additional members in the deal channel) ===
// ====================================================
// v3.9.34: admins/midmen can add NON-PARTICIPANT members to a deal channel
// (witnesses, staff in training, backup midmen). Observers get
// view/chat/attach access, but resolveActor doesn't recognize them as the
// buyer/seller — they cannot move the deal state. An observer who happens
// to hold the midman role STILL counts as a midman (feature: backup
// midman). The count is limited so a deal channel doesn't become a public room.

const MAX_OBSERVERS = 10;

/**
 * May this user become an observer of this deal? (pure — no IO)
 * @returns {{ok: boolean, reason: string|null}} reason: 'principal' |
 *   'duplicate' | 'full' | 'invalid' — null if ok.
 */
function canAddObserver(deal, userId) {
    if (!deal || !userId) return { ok: false, reason: 'invalid' };
    // Deal participants (buyer/seller) CANNOT become observers — they already
    // are participants. Adding a member is not how you swap someone's role.
    if (userId === deal.buyerId || userId === deal.sellerId) {
        return { ok: false, reason: 'principal' };
    }
    const obs = Array.isArray(deal.observers) ? deal.observers : [];
    if (obs.includes(userId)) return { ok: false, reason: 'duplicate' };
    if (obs.length >= MAX_OBSERVERS) return { ok: false, reason: 'full' };
    return { ok: true, reason: null };
}

/**
 * Add an observer (mutates the deal). Returns false if rejected by canAddObserver.
 * Doesn't persist to disk — the caller calls setDeal().
 */
function addObserver(deal, userId) {
    if (!canAddObserver(deal, userId).ok) return false;
    if (!Array.isArray(deal.observers)) deal.observers = [];
    deal.observers.push(userId);
    return true;
}

/**
 * Remove an observer (mutates the deal). Returns false if userId isn't
 * actually an observer. Deal participants cannot be removed here (they aren't observers).
 */
function removeObserver(deal, userId) {
    if (!deal || !Array.isArray(deal.observers)) return false;
    const idx = deal.observers.indexOf(userId);
    if (idx === -1) return false;
    deal.observers.splice(idx, 1);
    return true;
}

/**
 * Apply an event to the deal (mutates): push history + set state.
 * Does NOT persist to disk — the caller calls setDeal() after this.
 *
 * @returns {Object|null} the updated deal, or null if the event is invalid
 *   from the current state (the caller must check nextState first).
 */
function recordTransition(deal, event, actor) {
    if (!deal || !actor) return null;
    const next = nextState(deal.state, event);
    if (!next) return null;
    deal.history = Array.isArray(deal.history) ? deal.history : [];
    deal.history.push({
        ts: Date.now(),
        event,
        fromState: deal.state,
        toState: next,
        actorId: actor.id,
        actorTag: actor.tag || actor.username || 'unknown'
    });
    deal.state = next;
    return deal;
}

module.exports = {
    // persistence
    loadDeals,
    saveDeals,
    getDeal,
    setDeal,
    removeDeal,
    hasActiveDealFor,
    getActiveDealsByGuild,
    // state machine (pure)
    canTransition,
    nextState,
    actorAllowed,
    recordTransition,
    // dual consent v3.9.34 (pure, mutates the deal without IO)
    applyAgreement,
    // observer v3.9.34 (pure, mutates the deal without IO)
    canAddObserver,
    addObserver,
    removeObserver,
    MAX_OBSERVERS,
    // helpers (pure)
    calcFee,
    calcTotals,
    parsePriceNumber,
    formatRupiah,
    // constants
    STATES,
    TRANSITIONS,
    TERMINAL_STATES,
    transitionLocks
};
