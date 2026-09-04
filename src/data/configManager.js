const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const configPath = path.join(__dirname, '..', '..', 'data', 'config.json');

// Default structure (digunakan kalau config.json kosong / rusak / format lama)
const DEFAULTS = {
    roles: {},
    channels: {},
    messages: {
        welcomeTitle: '👋 SELAMAT DATANG!',
        welcomeBody:
            'Halo {user}!\n\nSelamat datang di **{server}** 🎉\n\n🔐 Silakan verifikasi dirimu untuk mendapatkan akses penuh ke server.\n\n📊 Kamu adalah member ke-**{count}**!',
        goodbyeTitle: '👋 SELAMAT JALAN',
        goodbyeBody:
            '**{username}** telah {action} dari server.\n\nSampai jumpa lagi! 👋\n\n📊 Sisa member: **{count}**',
        verifyTitle: '✅ VERIFIKASI SERVER',
        verifyBody:
            'Selamat datang di **{server}**!\n\nKlik tombol di bawah untuk diverifikasi dan mendapatkan akses penuh ke seluruh channel.',
        ticketTitle: '🎫 SISTEM TIKET & PRICE LIST',
        // v3.9.12: ticket body sekarang support template variables.
        // Variabel tersedia: {server}, {price_list}, {price_list:<category>}, {price_header}, {categories_list}
        ticketBody:
            'Butuh bantuan atau ingin membeli?\n\nKlik tombol kategori di bawah untuk memulai.\n\n**{price_header}**\n{price_list}',
        // v3.9.11 Phase 1: ticket header configurable (sebelumnya hardcoded "PRICE LIST KEY")
        ticketPriceHeader: '💰 PRICE LIST 💰'
    },
    // v3.9.11 Phase 1: verify button configurable (sebelumnya hardcoded label/emoji/style)
    verifyButton: {
        label: 'Verifikasi Saya',
        emoji: '✅',
        style: 'Success' // Primary | Secondary | Success | Danger
    },
    // v3.9.18: ticket categories (default 4 kategori built-in)
    // - "Bantuan Staff" → "Help" (rename, lebih simpel & internasional)
    // - "Laporkan Member" → "Report" (rename)
    // - Tambahan: "Claim Giveaway" sebagai contoh kategori custom tanpa produk.
    //   Admin bisa hapus dengan /remove-category (isDefault=false) atau tambah
    //   kategori baru lain via /add-category.
    ticketCategories: [
        {
            id: 'transaction',
            label: 'Beli Key / Transaksi',
            emoji: '🔑',
            style: 'Primary',
            requiresKey: true,
            isDefault: true
        },
        { id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false, isDefault: true },
        { id: 'report', label: 'Report', emoji: '⚠️', style: 'Danger', requiresKey: false, isDefault: true },
        {
            id: 'claim_giveaway',
            label: 'Claim Giveaway',
            emoji: '🎁',
            style: 'Success',
            requiresKey: false,
            isDefault: false
        },
        // v3.9.32: kategori rekber — deal escrow 3-pihak (buyer/seller/midman).
        // Diintercept router (ticket_cat:midman → domain midman), TIDAK lewat
        // createTicket. isDefault: false + flag midmanCategoryDismissed supaya
        // admin yang tidak mau fitur rekber bisa hapus via /remove-category
        // tanpa kategori "hidup lagi" di getConfig() berikutnya.
        {
            id: 'midman',
            label: 'Rekber / Middleman',
            emoji: '🤝',
            style: 'Success',
            requiresKey: false,
            isDefault: false
        }
    ],
    // v3.9.32: konfigurasi midman/rekber.
    //   feeMode  : 'percent' (feeValue = persen) | 'flat' (feeValue = nominal Rp)
    //   feeValue : nilai fee — dihitung OTOMATIS saat deal dibuat (tidak manual).
    //   category : nama kategori channel deal (bisa dikustom).
    midman: {
        feeMode: 'percent',
        feeValue: 5,
        category: '🤝 REKBER'
    },
    // v3.9.13: Leveling system config
    leveling: {
        enabled: false, // default off — admin harus enable via /setup-leveling
        xpPerMessage: 15,
        cooldownMs: 60000, // 1 menit anti-spam XP
        announceLevelUp: true,
        levelUpChannel: null // null = channel tempat user chat
    },
    levelRoles: [], // [{ level: 10, roleId: "123" }, ...]
    colors: {
        success: 3066993,
        danger: 15158332,
        primary: 3447003,
        warning: 15105570,
        info: 5793266
    },
    products: []
};

/**
 * Baca config.json (selalu fresh - anti cache).
 * - Kalau file tidak ada / rusak -> pakai DEFAULTS
 * - Kalau format v1 (flat) -> auto-migrate ke v2 (nested)
 * - Kalau format v2 -> merge dengan DEFAULTS supaya field baru tetap ada
 *
 * P2-4 FIX: sebelumnya pakai `delete require.cache` + `require()` yang
 * rentan race condition dan anti-pattern. Sekarang pakai readFileSync + JSON.parse
 * seperti manager lain.
 */
function getConfig() {
    let raw = {};
    try {
        const fileContent = fs.readFileSync(configPath, 'utf8');
        raw = JSON.parse(fileContent);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            // File ada tapi rusak — log warning. Kalau ENOENT (file belum ada), silent.
            console.warn('⚠️ config.json rusak, pakai DEFAULTS. Pesan:', err.message);
            // v3.9.26: karantina file korup SEBELUM lanjut pakai DEFAULTS. Tanpa ini,
            // setField()/saveConfig() berikutnya menulis config BARU di atas file
            // korup — semua setting (roles/channels/products) hilang permanen tanpa
            // bekas. Dengan karantina, isi lama tersimpan sebagai
            // config.json.corrupt-<ts> untuk inspeksi/pulihkan manual.
            quarantineCorruptFile(configPath);
        }
        raw = {};
    }

    // === AUTO-MIGRATE v1 -> v2 ===
    // v1 punya field flat: verifiedRoleId, unverifiedRoleId, invoiceChannelId, welcomeChannelId, goodbyeChannelId
    let didV1Migration = false;
    if (raw.verifiedRoleId || raw.invoiceChannelId) {
        if (!raw.roles) raw.roles = {};
        if (raw.verifiedRoleId && !raw.roles.verified) raw.roles.verified = raw.verifiedRoleId;
        if (raw.unverifiedRoleId && !raw.roles.unverified) raw.roles.unverified = raw.unverifiedRoleId;
        if (raw.adminRoleId && !raw.roles.admin) raw.roles.admin = raw.adminRoleId;

        if (!raw.channels) raw.channels = {};
        if (raw.invoiceChannelId && !raw.channels.invoice) raw.channels.invoice = raw.invoiceChannelId;
        if (raw.welcomeChannelId && !raw.channels.welcome) raw.channels.welcome = raw.welcomeChannelId;
        if (raw.goodbyeChannelId && !raw.channels.goodbye) raw.channels.goodbye = raw.goodbyeChannelId;

        // v3.9.26 FIX: hapus flat key v1 dari raw — sebelumnya save migrasi cuma
        // nulis {roles, channels, messages, colors, products} ke disk, jadi file
        // CAMPURAN (v2 + sisa flat key v1, mis. hasil edit manual / restore lama)
        // kehilangan ticketCategories, leveling, levelRoles, verifyButton, dan
        // field custom admin saat auto-save. Sekarang: flat key dihapus dari raw,
        // save dilakukan SETELAH merge penuh (di bawah) → tidak ada field yang drop.
        for (const flatKey of [
            'verifiedRoleId',
            'unverifiedRoleId',
            'adminRoleId',
            'invoiceChannelId',
            'welcomeChannelId',
            'goodbyeChannelId'
        ]) {
            delete raw[flatKey];
        }
        didV1Migration = true;
    }

    // === MERGE dengan DEFAULTS (deep untuk messages) ===
    // v3.9.11: tambah merge untuk verifyButton & ticketCategories
    // v3.9.13: tambah merge untuk leveling & levelRoles
    // v3.9.17 FIX: preserve field custom (ticketCategoryKey, ticketCategoryNoKey,
    //   dan field non-standar lainnya). Sebelumnya, hanya keys di DEFAULTS yang
    //   di-merge — field yang admin tambahkan manual di config.json DROPPED.
    //   Sekarang: spread `...raw` di akhir supaya field custom preserve, TAPI
    //   keys yang sudah di-merge explicit akan override ( karena spread di awal ).
    const config = {
        ...raw, // preserve unknown fields (v3.9.17)
        roles: { ...DEFAULTS.roles, ...(raw.roles || {}) },
        channels: { ...DEFAULTS.channels, ...(raw.channels || {}) },
        messages: { ...DEFAULTS.messages, ...(raw.messages || {}) },
        colors: { ...DEFAULTS.colors, ...(raw.colors || {}) },
        verifyButton: { ...DEFAULTS.verifyButton, ...(raw.verifyButton || {}) },
        ticketCategories:
            Array.isArray(raw.ticketCategories) && raw.ticketCategories.length > 0
                ? raw.ticketCategories
                : DEFAULTS.ticketCategories,
        leveling: { ...DEFAULTS.leveling, ...(raw.leveling || {}) },
        levelRoles: Array.isArray(raw.levelRoles) ? raw.levelRoles : DEFAULTS.levelRoles,
        // v3.9.32: merge midman config (field custom admin tetap preserve).
        midman: { ...DEFAULTS.midman, ...(raw.midman || {}) },
        products: Array.isArray(raw.products) ? raw.products : DEFAULTS.products
    };

    // Backward compat: rename kategori 'mlbb_key' (lama) → 'transaction' (baru).
    // Berlaku untuk ticketCategories dan product.category.
    // Old config yang masih pakai 'mlbb_key' tetap jalan, tapi next save bakal terganti.
    if (Array.isArray(config.ticketCategories)) {
        config.ticketCategories = config.ticketCategories.map(cat =>
            cat.id === 'mlbb_key' ? { ...cat, id: 'transaction' } : cat
        );
    }
    if (Array.isArray(config.products)) {
        config.products = config.products.map(p =>
            p && p.category === 'mlbb_key' ? { ...p, category: 'transaction' } : p
        );
    }

    // === v3.9.18 MIGRATION: rename default labels & tambah claim_giveaway ===
    // Tujuan: existing server yang sudah punya config.json lama otomatis dapat
    // label baru "Help"/"Report" (menggantikan "Bantuan Staff"/"Laporkan Member"),
    // serta kategori contoh "Claim Giveaway" ditambahkan kalau belum ada.
    //
    // Migration ini konservatif:
    //   - Hanya rename label kalau masih pakai label default lama. Kalau admin
    //     sudah customize label (mis. "Tanya Admin"), TIDAK diubah.
    //   - claim_giveaway hanya ditambah kalau belum ada kategori dengan id itu.
    //     Kalau admin sudah pernah hapus, tidak akan ditambah lagi.
    let _migrationChanged = false;
    if (Array.isArray(config.ticketCategories)) {
        config.ticketCategories = config.ticketCategories.map(cat => {
            if (cat && cat.id === 'help' && (cat.label === 'Bantuan Staff' || cat.label === 'Bantuan')) {
                _migrationChanged = true;
                return { ...cat, label: 'Help' };
            }
            if (cat && cat.id === 'report' && (cat.label === 'Laporkan Member' || cat.label === 'Laporkan')) {
                _migrationChanged = true;
                return { ...cat, label: 'Report' };
            }
            return cat;
        });
        // Tambah claim_giveaway kalau belum ada (sekali saja — kalau admin hapus,
        // tidak ditambah lagi karena flag claimGiveawayDismissed di-set oleh
        // /remove-category, lihat categories.js)
        // v3.9.26 FIX: sebelumnya komentar di atas BOHONG — tidak ada flag,
        // /remove-category claim_giveaway berhasil, lalu getConfig() BERIKUTNYA
        // (jalan di setiap pesan!) re-add kategori + auto-save config. Kategori
        // "hidup lagi" diam-diam — mustahil dihapus permanen.
        const hasClaimGiveaway = config.ticketCategories.some(c => c && c.id === 'claim_giveaway');
        if (!hasClaimGiveaway && !config.claimGiveawayDismissed) {
            config.ticketCategories.push({
                id: 'claim_giveaway',
                label: 'Claim Giveaway',
                emoji: '🎁',
                style: 'Success',
                requiresKey: false,
                isDefault: false
            });
            _migrationChanged = true;
        }
        // v3.9.32: tambah kategori midman/rekber ke config lama (pola yang sama
        // dengan claim_giveaway — sekali saja; kalau admin hapus via
        // /remove-category, flag midmanCategoryDismissed mencegah re-add).
        const hasMidmanCat = config.ticketCategories.some(c => c && c.id === 'midman');
        if (!hasMidmanCat && !config.midmanCategoryDismissed) {
            config.ticketCategories.push({
                id: 'midman',
                label: 'Rekber / Middleman',
                emoji: '🤝',
                style: 'Success',
                requiresKey: false,
                isDefault: false
            });
            _migrationChanged = true;
        }
    }
    // v3.9.26: save migrasi v1→v2 sekarang SETELAH merge penuh — hasil save
    // berisi schema lengkap (ticketCategories, leveling, levelRoles, verifyButton,
    // field custom) bukan cuma 5 key utama.
    if (didV1Migration) {
        try {
            saveConfig(config);
            console.log('✅ config.json lama (v1) otomatis di-migrate ke v2 (field modern preserve).');
        } catch (e) {
            console.warn('⚠️ Gagal auto-save migrasi v1:', e.message);
        }
    }
    if (_migrationChanged) {
        try {
            saveConfig(config);
            // v3.9.37: pesan di-update — blok ini sekarang juga menambah
            // kategori midman (v3.9.32), bukan cuma rename Help/Report +
            // claim_giveaway (v3.9.18) seperti pesan lama.
            console.log(
                '📦 Migration ticket categories: Help/Report rename + claim_giveaway + midman (rekber) ditambahkan.'
            );
        } catch (migErr) {
            console.warn('⚠️ Gagal save migration ticket categories:', migErr.message);
        }
    }

    return config;
}

/**
 * Simpan config.json dengan format rapi.
 * v3.9.0 FIX: pakai safeWriteJSON (atomic write via tmp+rename) supaya
 * kalau bot crash / OOM / power loss saat write, file config.json tidak
 * corrupt (truncated / empty). Sebelumnya pakai fs.writeFileSync langsung.
 */
function saveConfig(config) {
    safeWriteJSON(configPath, config);
}

/**
 * Set nilai nested (mis. 'roles.admin' atau 'channels.welcome').
 * v3.9.0 FIX: sanitize dotPath untuk cegah prototype pollution
 * (mis. '__proto__.polluted' atau 'constructor.prototype.x').
 */
function setField(dotPath, value) {
    const config = getConfig();
    const keys = dotPath.split('.');

    // Reject keys yang bisa menyentuh Object.prototype
    const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    for (const k of keys) {
        if (FORBIDDEN_KEYS.has(k)) {
            throw new Error(`Path "${dotPath}" mengandung key terlarang: ${k}`);
        }
    }

    let cur = config;
    for (let i = 0; i < keys.length - 1; i++) {
        if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) {
            cur[keys[i]] = {};
        }
        cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = value;
    saveConfig(config);

    // v3.9.2: invalidate permissions cache kalau admin role berubah,
    // supaya perubahan langsung efektif tanpa nunggu TTL 30 detik.
    if (keys[0] === 'roles' && keys[1] === 'admin') {
        try {
            const { invalidateAdminRoleCache } = require('../infra/permissions');
            invalidateAdminRoleCache();
        } catch (_) {
            /* permissions belum di-load — ignore */
        }
    }

    return config;
}

/**
 * Ganti placeholder template variables dalam teks.
 *
 * Variabel yang didukung:
 *   - {user}          → mention user (mis. <@123>)
 *   - {username}      → user tag (mis. User#1234)
 *   - {server}        → nama guild
 *   - {count}         → jumlah member
 *   - {action}        → 'keluar' / 'di-ban' / 'dikeluarkan (kick)' (untuk goodbye)
 *
 * v3.9.12: Variabel tambahan untuk ticket body (dipakai di /setup-ticket):
 *   - {price_list}        → daftar semua produk (auto-generated dari config.products)
 *   - {price_list:<cat>}  → daftar produk filter by category (mis. {price_list:transaction})
 *   - {categories_list}   → daftar semua kategori tiket (auto-generated dari config.ticketCategories)
 *   - {price_header}      → isi dari config.messages.ticketPriceHeader
 */
function fillTemplate(text, vars = {}) {
    let result = text
        .replace(/\{user\}/g, vars.user || '')
        .replace(/\{username\}/g, vars.username || '')
        .replace(/\{server\}/g, vars.server || '')
        .replace(/\{count\}/g, vars.count || '0')
        .replace(/\{action\}/g, vars.action || 'keluar');

    // v3.9.12: ticket-specific variables
    if (vars.priceList !== undefined) {
        result = result.replace(/\{price_list\}/g, vars.priceList);
    }
    if (vars.priceHeader !== undefined) {
        result = result.replace(/\{price_header\}/g, vars.priceHeader);
    }
    if (vars.categoriesList !== undefined) {
        result = result.replace(/\{categories_list\}/g, vars.categoriesList);
    }
    // {price_list:<categoryId>} — filtered by category
    if (vars.priceListByCategory && typeof vars.priceListByCategory === 'object') {
        result = result.replace(/\{price_list:([a-zA-Z0-9_-]+)\}/g, (match, catId) => {
            return vars.priceListByCategory[catId] || `_(belum ada produk di kategori \`${catId}\`)_`;
        });
    }

    return result;
}

module.exports = { getConfig, saveConfig, setField, fillTemplate, DEFAULTS };
