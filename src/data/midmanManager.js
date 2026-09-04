/**
 * Midman (Rekber) Manager — data layer & state machine deal escrow 3-pihak.
 * v3.9.34.
 *
 * File: data/deals.json
 * {
 *   "<channelId>": {
 *     "channelId": "123...",
 *     "guildId":    "123...",
 *     "buyerId":    "123...",   // pembeli
 *     "sellerId":   "123...",   // penjual
 *     // v3.9.34: deal bisa dibuka siapa saja (pembeli/penjual/pihak yang
 *     // menolong) — peran eksplisit dipilih lewat formulir 3 langkah.
 *     "buyerAgreed":  false,     // v3.9.34: persetujuan DUA pihak (WAITING_AGREE)
 *     "sellerAgreed": false,
 *     "observers":  ["123..."],  // v3.9.34: member tambahan (non-peserta) di channel deal
 *     "item":       "Akun ML Mythic",
 *     "priceNum":   100000,     // harga deal dalam rupiah (number)
 *     "priceText":  "Rp100.000",
 *     "fee":        5000,       // fee midman (dihitung saat deal dibuat)
 *     "feeMode":    "percent",  // v3.9.33: snapshot mode fee saat deal dibuat
 *     "feeValue":   5,          // v3.9.33: snapshot nilai fee saat deal dibuat
 *     "state":      "WAITING_PAYMENT",
 *     "boardMessageId": "123...", // ID pesan Deal Board (embed sumber kebenaran)
 *     "createdBy":  "123...",
 *     "createdAt":  1725...,
 *     "history": [ { ts, event, fromState, toState, actorId, actorTag } ]
 *   }
 * }
 *
 * === PRINSIP INTI ===
 * Rekber = ada ORANG KETIGA yang pegang dana. Mode gagal rekber selalu soal
 * "siapa bilang apa di chat" — chat bisa diedit/dihapus, jadi chat bukan bukti.
 * Solusinya: Deal Board (embed bot) jadi sumber kebenaran, dan SEMUA
 * perpindahan state hanya lewat tombol dengan validasi GANDA:
 *   1. `canTransition(state, event)`  → urutan langkah tidak bisa dilompati.
 *   2. `actorAllowed(event, roles)`   → hanya pihak yang berhak yang bisa klik.
 *
 * Contoh yang OTOMATIS DITOLAK bot:
 *   - Midman klik "Cairkan" saat buyer belum konfirmasi barang  (release dari
 *     WAITING_DELIVERY → invalid).
 *   - Buyer klik "Dana Masuk" menyamar midman                  (aktor salah).
 *   - Semua aksi saat DISPUTE                                  (state dibekukan).
 *
 * v3.9.34: state awal WAITING_AGREE — PEMBELI DAN PENJUAL dua-duanya harus
 * klik "Setuju Deal" sebelum terms terkunci (dulu hanya penjual, karena
 * creator deal selalu pembeli yang menulis terms). Sekarang creator bisa
 * siapa saja, jadi persetujuan ganda menjaga prinsip "pihak yang TIDAK
 * menulis terms harus menyetujuinya".
 *
 * Fungsi pure (canTransition, nextState, actorAllowed, calcFee,
 * calcTotals, parsePriceNumber, formatRupiah, applyAgreement,
 * canAddObserver, addObserver, removeObserver) mengikuti pola
 * classifyProduct() v3.9.28: di-ekstrak supaya bisa di-unit-test tanpa mock
 * Discord.
 *
 * v3.9.33 revisi fee: fee DITAMBAHKAN DI ATAS harga (additive), TIDAK dipotong
 * dari dana penjual. Contoh: harga 100.000 + fee 5% (5.000) → pembeli
 * transfer 105.000, penjual menerima 100.000 PENUH, midman menyimpan 5.000.
 * Penjual tidak pernah "kehilangan" sebagian harga deal karena fee.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const dealsPath = path.join(__dirname, '..', '..', 'data', 'deals.json');

// ====================================================
// === STATE DEAL ===
// ====================================================
const STATES = {
    // v3.9.34: WAITING_SELLER diganti WAITING_AGREE — pembeli & penjual
    // dua-duanya harus setuju (creator deal bisa siapa saja sekarang).
    // Deal lama (WAITING_SELLER) dimigrasi otomatis saat load (lihat loadDeals).
    WAITING_AGREE: { label: '⏳ Menunggu Pembeli & Penjual Setuju Deal', color: 0xf1c40f },
    WAITING_PAYMENT: { label: '💰 Menunggu Pembayaran ke Midman', color: 0xe67e22 },
    WAITING_DELIVERY: { label: '📦 Menunggu Barang Dikirim Penjual', color: 0x3498db },
    WAITING_RELEASE: { label: '✅ Barang Diterima — Menunggu Pencairan', color: 0x9b59b6 },
    DISPUTE: { label: '🚨 DISPUTE — Deal Dibekukan', color: 0xed4245 },
    // Terminal states (deal selesai — meta dihapus dari deals.json saat close):
    COMPLETED: { label: '✅ Selesai — Dana Cair ke Penjual', color: 0x2ecc71 },
    REFUNDED: { label: '↩️ Selesai — Dana Kembali ke Pembeli', color: 0x95a5a6 },
    CANCELLED: { label: '❌ Dibatalkan (sebelum dana masuk)', color: 0x95a5a6 }
};

const TERMINAL_STATES = new Set(['COMPLETED', 'REFUNDED', 'CANCELLED']);

// ====================================================
// === TABEL TRANSISI — jantung escrow ===
// ====================================================
// Urutan normal: WAITING_AGREE → (buyer & seller join) → WAITING_PAYMENT →
// (midman fundin) → WAITING_DELIVERY → (buyer received) → WAITING_RELEASE →
// (midman release) → COMPLETED.
//
// Dua "gerbang ganda" (inti keamanan escrow):
//   - Barang boleh dikirim HANYA setelah midman konfirmasi dana masuk.
//   - Dana boleh dicairkan HANYA setelah pembeli konfirmasi barang diterima.
//   - v3.9.34: Terms terkunci HANYA setelah pembeli & penjual dua-duanya
//     setuju (gerbang ketiga — creator deal bisa siapa saja).
// Tidak ada satu orang pun yang bisa gerakkan deal sendirian melewati
// gerbang yang bukan otoritasnya.
const TRANSITIONS = {
    // v3.9.34: join = persetujuan pihak deal. Aktor boleh buyer ATAU seller;
    // transisi ke WAITING_PAYMENT hanya terjadi setelah KEDUA pihak setuju
    // (flag buyerAgreed/sellerAgreed — lihat applyAgreement).
    join: { from: ['WAITING_AGREE'], to: 'WAITING_PAYMENT', actors: ['buyer', 'seller'] },
    // Cancel hanya sebelum dana masuk — setelah dana di midman, urusan
    // pengembalian dana HARUS lewat dispute + resolve admin (tercatat).
    cancel: { from: ['WAITING_AGREE', 'WAITING_PAYMENT'], to: 'CANCELLED', actors: ['buyer', 'seller', 'admin'] },
    fundin: { from: ['WAITING_PAYMENT'], to: 'WAITING_DELIVERY', actors: ['midman', 'admin'] },
    received: { from: ['WAITING_DELIVERY'], to: 'WAITING_RELEASE', actors: ['buyer'] },
    dispute: { from: ['WAITING_PAYMENT', 'WAITING_DELIVERY', 'WAITING_RELEASE'], to: 'DISPUTE', actors: ['buyer', 'seller', 'midman', 'admin'] },
    release: { from: ['WAITING_RELEASE'], to: 'COMPLETED', actors: ['midman', 'admin'] },
    // Resolve dispute — hanya admin (midman pihak berkepentingan atas fee,
    // jadi keputusan akhir dispute harus di atas midman):
    resolve_release: { from: ['DISPUTE'], to: 'COMPLETED', actors: ['admin'] },
    resolve_refund: { from: ['DISPUTE'], to: 'REFUNDED', actors: ['admin'] }
};

// Lock per-channel: cegah double-click race saat transisi diproses.
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
            console.warn('⚠️ deals.json rusak, pakai {}. Pesan:', err.message);
            // v3.9.26 pattern: karantina file korup sebelum lanjut pakai kosong —
            // supaya save berikutnya tidak menimpa data lama tanpa bekas.
            quarantineCorruptFile(dealsPath);
        }
        return {};
    }
}

function saveDeals(all) {
    safeWriteJSON(dealsPath, all);
}

/**
 * v3.9.34 migration (sekali jalan per deal, idempotent):
 *   - WAITING_SELLER (v3.9.32/33: creator = pembeli, terms tertulis oleh
 *     pembeli) → WAITING_AGREE dengan buyerAgreed=true (pembeli penulis terms
 *     = sudah setuju implisit), sellerAgreed=false (tetap harus klik setuju).
 *   - deal tanpa field `observers` → [] (field baru v3.9.34).
 * Perubahan di-save langsung supaya file di disk selalu bentuk baru.
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
 * User terlibat deal aktif (sebagai buyer ATAU seller) di guild ini?
 *
 * Dipakai ganda:
 *   - createDeal: buyer & seller tidak boleh terlibat 2 deal bersamaan.
 *   - createTicket (ticketManager): user dengan deal aktif tidak bisa buka
 *     tiket reguler lain — cegah bypass alur escrow lewat tiket biasa.
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
// === PURE FUNCTIONS (testable — pola classifyProduct) ===
// ====================================================

/**
 * Apakah event valid dari state sekarang? (validasi URUTAN langkah)
 */
function canTransition(state, event) {
    const t = TRANSITIONS[event];
    return Boolean(t && state && t.from.includes(state));
}

/**
 * State berikutnya setelah event — null kalau transisi invalid.
 */
function nextState(state, event) {
    return canTransition(state, event) ? TRANSITIONS[event].to : null;
}

// Mapping nama aktor di TRANSITIONS → key object roles.
// TRANSITIONS pakai nama pendek ('buyer'), pemanggil pakai boolean flags
// ({isBuyer}) — mapping ini menyatukan keduanya.
const ACTOR_KEY_MAP = { buyer: 'isBuyer', seller: 'isSeller', midman: 'isMidman', admin: 'isAdmin' };

/**
 * Apakah aktor boleh melakukan event? (validasi PERAN)
 *
 * @param {string} event
 * @param {{isBuyer: boolean, isSeller: boolean, isMidman: boolean, isAdmin: boolean}} roles
 *   Catatan: pemanggil (interactions/midman.js resolveActor) sudah menjamin
 *   isMidman/isAdmin FALSE kalau user adalah buyer/seller deal itu — anti
 *   self-dealing (midman tidak bisa megang deal-nya sendiri sebagai peserta).
 */
function actorAllowed(event, roles) {
    const t = TRANSITIONS[event];
    if (!t || !roles) return false;
    return t.actors.some(a => roles[ACTOR_KEY_MAP[a] || a] === true);
}

/**
 * Hitung fee midman. PURE — tidak baca config (caller yang passes).
 *
 * v3.9.33: fee ADDITIVE — ditambah di atas harga, bukan dipotong dari dana
 * penjual. Karena tidak lagi "memotong" dana siapa pun, fee tidak di-cap
 * sebesar harga deal (fee flat boleh melebihi harga; /set-midman-fee sudah
 * membatasi persen maks 90% sebagai sanity guard di sisi command).
 *
 * @param {number} priceNum - harga deal (rupiah)
 * @param {string} feeMode - 'percent' | 'flat'
 * @param {number} feeValue - persen (mis. 5 = 5%) atau nominal flat
 * @returns {number} fee nominal rupiah
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
    return 0; // mode tak dikenal → fee 0 (deal tetap jalan, gratis)
}

/**
 * Rincian nominal deal (v3.9.33 — fee additive, sumber tunggal perhitungan):
 *   buyerPays   = price + fee → yang ditransfer pembeli ke midman
 *   sellerGets  = price       → yang diterima penjual (harga PENUH, tanpa potongan)
 *   midmanKeeps = fee         → sisa dana di tangan midman setelah cairkan
 *
 * Contoh: calcTotals(100000, 5000) →
 *   { buyerPays: 105000, sellerGets: 100000, midmanKeeps: 5000 }
 */
function calcTotals(priceNum, fee) {
    // Clamp negatif → 0 (defensive: calcFee tidak pernah return negatif, tapi
    // data lama/manual edit deals.json tidak boleh bikin total jadi minus).
    const price = Math.max(0, Number(priceNum) || 0);
    const feeNum = Math.max(0, Number(fee) || 0);
    return {
        buyerPays: price + feeNum,
        sellerGets: price,
        midmanKeeps: feeNum
    };
}

/**
 * Parse harga dari input modal. Terima: "100000", "100.000", "100,000",
 * "100k", "1m", "Rp100.000". Return 0 kalau invalid.
 *
 * v3.9.38 FIX: desimal tidak lagi "lolos" jadi digit ekstra (bug 10x harga).
 *   - Dengan suffix k/m: sisa input TIDAK BOLEH mengandung `.`/`,` ("1.5m"
 *     dulu di-parse jadi 15.000.000 — desimal dibaca sebagai digit tambahan).
 *   - Tanpa suffix: `.`/`,` hanya sah sebagai pemisah RIBUAN — format
 *     `^\d{1,3}([.,]\d{3})*$` dengan JENIS separator konsisten ("1.000.000"
 *     dan "1,000,000" valid; "2.5", "1.000,000", "100000." invalid → 0).
 *     Harga deal rekber memang selalu integer rupiah.
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
    // v3.9.38 FIX: validasi pemisah SEBELUM strip — lihat JSDoc di atas.
    if (/[.,]/.test(s)) {
        if (hasSuffix) return 0; // "1.5m" / "0.5k" → invalid (bukan 15jt/5rb)
        // Tanpa suffix: hanya pemisah ribuan konsisten yang boleh.
        const isDotGroups = /^\d{1,3}(\.\d{3})+$/.test(s);
        const isCommaGroups = /^\d{1,3}(,\d{3})+$/.test(s);
        if (!isDotGroups && !isCommaGroups) return 0; // "2.5" / "1.000,000" → 0
    }
    s = s.replace(/[.,]/g, '');
    if (!/^\d+$/.test(s)) return 0;
    return parseInt(s, 10) * multiplier;
}

/**
 * Format rupiah: 95000 → "Rp95.000" (locale id-ID).
 */
function formatRupiah(n) {
    const num = Number(n) || 0;
    return 'Rp' + num.toLocaleString('id-ID');
}

/**
 * v3.9.34: terapkan persetujuan pihak deal (mutate deal, tanpa IO).
 *
 * Dipanggil saat buyer/seller klik "Setuju Deal" di state WAITING_AGREE.
 * Yang menjalankan transisi `join` (→ WAITING_PAYMENT) adalah caller, HANYA
 * setelah fungsi ini return { ok: true, both: true }.
 *
 * @returns {{ok: boolean, both: boolean, role: string|null}}
 *   ok=false   → userId bukan peserta deal, ATAU pihak itu sudah setuju
 *                (double-click / tombol stale).
 *   both=true  → kedua pihak sudah setuju → caller wajib recordTransition.
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
// === OBSERVER (member tambahan di channel deal) ===
// ====================================================
// v3.9.34: admin/midman bisa menambah member NON-PESERTA ke channel deal
// (saksi, staff yang dilatih, midman cadangan). Observer dapat akses
// lihat/chat/attach, tapi resolveActor tidak mengakuinya sebagai
// buyer/seller — dia tidak bisa menggerakkan state deal. Observer yang
// kebetulan punya role midman TETAP dihitung midman (fitur: midman
// cadangan). Jumlah dibatasi supaya channel deal tidak jadi ruang publik.

const MAX_OBSERVERS = 10;

/**
 * Bolehkah user jadi observer deal ini? (pure — tanpa IO)
 * @returns {{ok: boolean, reason: string|null}} reason: 'principal' |
 *   'duplicate' | 'full' | 'invalid' — null kalau ok.
 */
function canAddObserver(deal, userId) {
    if (!deal || !userId) return { ok: false, reason: 'invalid' };
    // Peserta deal (buyer/seller) TIDAK bisa jadi observer — mereka memang
    // peserta. Add member bukan cara mengganti peran orang.
    if (userId === deal.buyerId || userId === deal.sellerId) {
        return { ok: false, reason: 'principal' };
    }
    const obs = Array.isArray(deal.observers) ? deal.observers : [];
    if (obs.includes(userId)) return { ok: false, reason: 'duplicate' };
    if (obs.length >= MAX_OBSERVERS) return { ok: false, reason: 'full' };
    return { ok: true, reason: null };
}

/**
 * Tambah observer (mutate deal). Return false kalau ditolak canAddObserver.
 * Tidak menyimpan ke disk — caller panggil setDeal().
 */
function addObserver(deal, userId) {
    if (!canAddObserver(deal, userId).ok) return false;
    if (!Array.isArray(deal.observers)) deal.observers = [];
    deal.observers.push(userId);
    return true;
}

/**
 * Hapus observer (mutate deal). Return false kalau userId memang bukan
 * observer. Peserta deal tidak bisa dihapus lewat sini (bukan observer).
 */
function removeObserver(deal, userId) {
    if (!deal || !Array.isArray(deal.observers)) return false;
    const idx = deal.observers.indexOf(userId);
    if (idx === -1) return false;
    deal.observers.splice(idx, 1);
    return true;
}

/**
 * Terapkan event ke deal (mutate): push history + set state.
 * TIDAK menyimpan ke disk — caller panggil setDeal() setelah ini.
 *
 * @returns {Object|null} deal yang sudah di-update, atau null kalau event
 *   invalid dari state sekarang (caller harus cek nextState dulu).
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
    // persetujuan ganda v3.9.34 (pure, mutate deal tanpa IO)
    applyAgreement,
    // observer v3.9.34 (pure, mutate deal tanpa IO)
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
