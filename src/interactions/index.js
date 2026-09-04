/**
 * Interaction Router — distribusi button/select-menu/modal ke handler per-domain.
 *
 * Arsitektur (v3.9.9 refactor):
 *   customId dipisah berdasarkan prefix → handler domain terpisah.
 *
 * Prefix mapping (semua prefix di sini SEKARANG punya handler aktif —
 * fallback ke legacy `handlers/interactionHandler.js` DIHAPUS):
 *   - btn_verify                              → verify.js      (exact match)
 *   - ticket_cat:, ticket_, select_product, modal_set_key:,
 *     modal_deliver_order:                    → ticket.js
 *   - ticket_cat:midman (SEBELUM ticket_cat:),
 *     modal_mm_, mm_ (user select mm_pick_buyer/mm_pick_seller/
 *     mm_pick_member, string select mm_remove_pick, tombol mm_*)
 *                                             → midman.js     (v3.9.34 rekber)
 *   - sr_btn:, sr_sel:                        → selfrole.js
 *   - emb_edit:, emb_preview:, emb_send:,
 *     emb_cancel:, emb_modal_                 → embed.js
 *   - gw_join:, gw_leave:                     → giveaway.js
 *   - poll_vote:, poll_modal_create:          → poll.js
 *   - tv_, tv_modal_                          → tempvoice.js
 *   - reset_config_, restore_backup_          → backup.js
 *
 * Router meng-apply di sini (BUKAN di domain handler):
 *   1. Dedup interaction ID (check sebelum / mark SETELAH handler sukses — v3.9.38)
 *      — pertahanan terhadap Discord retry.
 *   2. Guard `replied/deferred` — interaction yang sudah reply/defer tidak diproses ulang.
 *   3. Filter tipe interaction (button/select/modal only).
 *   4. Routing by customId prefix.
 */

const { check, mark } = require('./_dedup');

// Domain handlers — masing-masing export `async function(interaction)`.
const verifyDomain = require('./verify');
const ticketDomain = require('./ticket');
// v3.9.32: domain midman/rekber (deal escrow 3-pihak).
const midmanDomain = require('./midman');
const selfroleDomain = require('./selfrole');
const embedDomain = require('./embed');
const giveawayDomain = require('./giveaway');
const pollDomain = require('./poll');
const tempvoiceDomain = require('./tempvoice');
const backupDomain = require('./backup');
const configDomain = require('./config');
// v3.9.14: panel modal handler (modal_panel_edit:<panelId>:<field>)
// Di-impor dari commands/panels-mgmt.js supaya logic-nya reuse dengan slash command.
const { handlePanelModal: panelModalHandler } = require('../commands/panels-mgmt');

// Mapping customId prefix → domain.
// Diurutkan dari paling spesifik ke paling umum (startsWith cocok dengan prefix
// pertama yang match). `select_product` ditaruh sebelum `ticket_` karena keduanya
// distinct prefix, tidak overlap — tapi tetap defensive untuk urutan.
//
// `btn_verify` di-handle exact-match (lihat helper `pickDomain`).
const PREFIX_TO_DOMAIN = [
    { prefix: 'btn_verify', domain: 'verify', exact: true },
    { prefix: 'select_product', domain: 'ticket', exact: true },
    // v3.9.14: dropdown select menu dari panel (customId: ticket_cat_select)
    { prefix: 'ticket_cat_select', domain: 'ticket', exact: true },
    { prefix: 'modal_set_key:', domain: 'ticket' },
    // v3.9.27: modal Kirim Pesanan (produk non-key — mirror modal_set_key).
    // WAJIB explicit: prefix modal gak punya fallback generik — tanpa entry ini
    // submit modal tidak pernah sampai ke handler tiket (dead interaction).
    { prefix: 'modal_deliver_order:', domain: 'ticket' },
    // v3.9.32: midman/rekber. WAJIB SEBELUM prefix `ticket_cat:` generik —
    // `ticket_cat:midman` (tombol kategori rekber di panel) harus di-route ke
    // domain midman, bukan ticket (kalau kena ticket_, customId tidak dikenal).
    // v3.9.37: EXACT-match — tanpa ini, kategori custom yang kebetulan diawali
    // "midman" (mis. `midman_jual`, id valid per CATEGORY_ID_REGEX) kena
    // prefix-match dan mati di fallback midman (tidak pernah di-reply).
    { prefix: 'ticket_cat:midman', domain: 'midman', exact: true },
    { prefix: 'modal_mm_', domain: 'midman' },
    { prefix: 'mm_', domain: 'midman' },
    { prefix: 'modal_edit_message:', domain: 'config' },
    // v3.9.14: panel edit modal (modal_panel_edit:<panelId>:<field>)
    { prefix: 'modal_panel_edit:', domain: 'panel-modal' },
    // ticket_cat: di-explicit di sini (sebelum ticket_) biar routing jelas,
    // gak andalkan fallback ticket_ yang fragile kalau nanti ada refactor.
    { prefix: 'ticket_cat:', domain: 'ticket' },
    { prefix: 'ticket_', domain: 'ticket' },
    { prefix: 'sr_btn:', domain: 'selfrole' },
    { prefix: 'sr_sel:', domain: 'selfrole' },
    { prefix: 'emb_edit:', domain: 'embed' },
    { prefix: 'emb_preview:', domain: 'embed' },
    { prefix: 'emb_send:', domain: 'embed' },
    { prefix: 'emb_cancel:', domain: 'embed' },
    { prefix: 'emb_modal_', domain: 'embed' },
    { prefix: 'gw_join:', domain: 'giveaway' },
    { prefix: 'gw_leave:', domain: 'giveaway' },
    { prefix: 'poll_vote:', domain: 'poll' },
    { prefix: 'poll_modal_create:', domain: 'poll' },
    { prefix: 'tv_modal_', domain: 'tempvoice' },
    { prefix: 'tv_', domain: 'tempvoice' },
    { prefix: 'reset_config_', domain: 'backup' },
    { prefix: 'restore_backup_', domain: 'backup' }
];

const DOMAIN_HANDLERS = {
    verify: verifyDomain,
    ticket: ticketDomain,
    midman: midmanDomain,
    selfrole: selfroleDomain,
    embed: embedDomain,
    giveaway: giveawayDomain,
    poll: pollDomain,
    tempvoice: tempvoiceDomain,
    backup: backupDomain,
    config: configDomain,
    // v3.9.14: panel modal handler (bukan domain biasa — function langsung)
    'panel-modal': { handler: panelModalHandler }
};

/**
 * Pilih domain handler berdasarkan customId.
 * Mengembalikan function atau `null` kalau tidak ada match.
 *
 * v3.9.14: domain bisa berupa:
 *   - async function(interaction) → langsung dipanggil
 *   - { handler: async function(interaction) } → wrapper (untuk modal yang
 *     di-impor dari commands/* bukan interactions/*). Fungsi `pickDomain`
 *     mengembalikan function-nya, bukan wrapper object.
 */
function pickDomain(customId) {
    if (!customId) return null;
    for (const entry of PREFIX_TO_DOMAIN) {
        let matched = false;
        if (entry.exact) {
            if (customId === entry.prefix) matched = true;
        } else if (customId.startsWith(entry.prefix)) {
            matched = true;
        }
        if (matched) {
            const domainEntry = DOMAIN_HANDLERS[entry.domain];
            if (!domainEntry) return null;
            // Kalau wrapper { handler }, return function-nya langsung.
            if (domainEntry.handler && typeof domainEntry.handler === 'function') {
                return domainEntry.handler;
            }
            // Kalau function biasa, return as-is.
            if (typeof domainEntry === 'function') return domainEntry;
            return null;
        }
    }
    return null;
}

/**
 * Router utama — dipanggil dari src/bot/events/interactionCreate.js
 * saat InteractionCreate (button/select/modal).
 *
 * v3.9.8 FIX: dedup + replied/deferred guard di-apply DI SINI (bukan di
 * domain handler) supaya domain handler bisa fokus ke logic-nya saja dan
 * interaction selalu fresh saat di-dispatch.
 */
async function routeInteraction(interaction) {
    if (interaction.isChatInputCommand()) return; // slash command → command router
    // v3.9.33: tambah isUserSelectMenu — dropdown member (mm_pick_seller)
    // harus sampai ke domain midman (sebelumnya cuma button/string-select/modal).
    // v3.9.34: dipakai juga mm_pick_buyer & mm_pick_member; string select
    // mm_remove_pick tertangani isStringSelectMenu yang sudah ada.
    if (
        !interaction.isButton() &&
        !interaction.isStringSelectMenu() &&
        !interaction.isUserSelectMenu() &&
        !interaction.isModalSubmit()
    ) {
        return;
    }

    // P1-6 FIX: cek duplikat interaction ID dulu (defense-in-depth).
    // Discord kadang fire event yang sama 2x kalau ada retry.
    // v3.9.8: kalau entry ada tapi udah lebih dari TTL, anggap belum diproses.
    // v3.9.38 FIX: hanya CHECK di sini — MARK dipindah ke SETELAH handler sukses.
    // Sebelumnya checkAndMark menandai SEBELUM handler jalan → kalau handler
    // crash, replay gateway dari Discord untuk interaction yang sama di-swallow
    // (sudah "terproses" padahal tidak) → action user hilang diam-diam.
    if (check(interaction.id)) {
        return;
    }

    // Guard: skip kalau interaction sudah replied/deferred.
    // Modal submit yang sudah replied = ANGGAP SUDAH DIPROSES, jangan lanjut.
    if (interaction.replied || interaction.deferred) {
        return;
    }

    // Cek domain berdasarkan customId prefix
    const handler = pickDomain(interaction.customId || '');
    if (handler) {
        // v3.9.38 FIX: mark interaction hanya SETELAH handler sukses — baris
        // `mark()` di bawah ini tidak jalan kalau handler throw (await melempar
        // error ke caller, entry TIDAK ditandai) → replay gateway (Discord retry
        // interaction yang sama) bisa memproses ulang. Tanpa try/catch rethrow
        // karena semantiknya identik (eslint no-useless-catch).
        const result = await handler(interaction);
        mark(interaction.id);
        return result;
    }

    // v3.9.9 refactor: fallback ke legacy handler DIHAPUS. Semua customId yang
    // seharusnya tertangani sudah punya domain. Kalau sampai sini, berarti
    // interaction tidak dikenali — log warning supaya kelihatan kalau ada
    // customId baru yang belum di-route (defensive observability).
    console.warn(`[interactionRouter] customId tidak dikenali (no domain match): ${interaction.customId}`);
}

module.exports = routeInteraction;
