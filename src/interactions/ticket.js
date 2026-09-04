/**
 * Ticket domain handler — semua customId terkait tiket.
 *
 * Di-ekstrak dari handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior dipertahankan apa adanya — hanya pindah file.
 *
 * CustomId yang ditangani:
 *   - ticket_trade                (button)  → tampilkan dropdown produk
 *   - select_product              (select)  → buat tiket produk
 *   - ticket_help / ticket_report(button)  → buat tiket help/report
 *   - ticket_close                (button)  → tampilkan tombol konfirmasi
 *   - ticket_close_abort / _abort2(button) → batal tutup (jangan tutup channel)
 *   - ticket_close_success        (button)  → tutup tiket help/report (sukses)
 *   - ticket_close_cancel_trans   (button)  → tutup tiket transaksi tanpa key
 *   - ticket_close_cancel         (button)  → v3.9.35: tutup tiket help/report/
 *                                             claim/giveaway TANPA selesai
 *                                             (label: "❌ Tutup Tanpa Selesai")
 *   - ticket_set_key              (button)  → buka modal set key
 *   - modal_set_key:<value>       (modal)   → full flow set key
 *   - ticket_deliver              (button)  → v3.9.27: buka modal kirim pesanan
 *                                             (produk transaksi non-key: akun/jasa)
 *   - modal_deliver_order:<value> (modal)   → v3.9.27: full flow kirim pesanan
 *
 * Router (src/interactions/index.js) sudah apply:
 *   - dedup (checkAndMark)
 *   - guard `replied/deferred`
 *   - cek tipe interaction (button/select/modal)
 * Jadi domain handler fokus ke logic-nya saja.
 */

const {
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const { getConfig, safeEditReply, logAudit, checkIsAdmin } = require('../commands/_shared');
const {
    createTicket,
    closeTicket,
    sendInvoice,
    getTicketMeta,
    patchTicketMeta,
    resolveTicketType,
    // v3.9.38 FIX (FIX 3): satu helper lookup produk by meta (value stabil dulu,
    // label fallback) — dipakai semua site lookup produk di file ini.
    resolveProduct
} = require('../data/ticketManager');
const { addKey, getActiveKeysByUserAndRole, formatRemaining } = require('../data/keyManager');
const { recordPurchase, parsePrice } = require('../data/statsManager');
const { scheduleRoleRemoval } = require('../data/roleScheduler');
// v3.9.32: redirect kategori midman/rekber (dropdown) ke domain midman.
const midmanDomain = require('./midman');

// v3.9.38 FIX (FIX 2c/4): per-channel completion lock — cegah 2 admin
// memproses flow completion (Set Key / Kirim Pesanan / ✅ Pesanan Sukses)
// untuk channel tiket yang sama secara bersamaan. Dedup router hanya per
// interaction.id — 2 klik/2 admin TIDAK ter-dedup, dan gate isCompleted baru
// efektif SETELAH patch meta jalan. Set ini menutup jendela race tersebut:
// check-and-acquire atomik di awal handler, release di finally.
// (Mirror ticketLocks/closeTicketLocks di ticketManager.js.)
const completionLocks = new Set();

/**
 * v3.9.17 FIX: helper untuk cek verified role — konsisten di semua handler.
 * Policy: kalau config.roles.verified belum di-set, ALLOW through (jangan
 * lockout admin yang belum setup). Kalau sudah di-set, user harus punya role itu.
 * Sebelumnya, 2 handler pakai `if (!config.roles.verified || ...)` (block kalau
 * unset), 2 handler lain pakai `if (config.roles.verified && ...)` (allow kalau
 * unset). Inkonsistensi ini bikin UX confusing.
 *
 * @returns {boolean} true kalau user LULUS check (boleh lanjut), false kalau ditolak.
 */
function passesVerifiedCheck(interaction, config) {
    // Kalau member.roles gak ada (partial member / user leave), anggap ditolak.
    if (!interaction.member?.roles?.cache) return false;
    // Kalau verified role belum di-set di config, allow through.
    if (!config.roles.verified) return true;
    // Kalau sudah di-set, user harus punya role itu.
    return interaction.member.roles.cache.has(config.roles.verified);
}

module.exports = async function (interaction) {
    const config = getConfig();

    // ====================================================
    // === v3.9.14: TIKET KATEGORI SELECT MENU (DROPDOWN PANEL) ===
    // === customId: ticket_cat_select (exact match)         ===
    // ====================================================
    // Saat panel pakai use_dropdown=true, kategori dirender sebagai select menu.
    // User pilih kategori di dropdown → handler ini jalan.
    // v3.9.19: Behavior berbasis "ada produk atau tidak" (fleksibel):
    //   - Kategori dengan produk → tampilkan dropdown produk
    //   - Kategori tanpa produk → langsung create ticket (help/report/claim_giveaway/dll)
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_cat_select') {
        const categoryId = interaction.values && interaction.values[0];
        if (!categoryId) {
            return interaction.reply({
                content: '❌ Tidak ada kategori yang dipilih.',
                flags: MessageFlags.Ephemeral
            });
        }
        const categories = config.ticketCategories || [];
        const catConfig = categories.find(c => c.id === categoryId);

        if (!catConfig) {
            return interaction.reply({
                content: `❌ Kategori \`${categoryId}\` tidak ditemukan di config.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.17: pakai helper passesVerifiedCheck (konsisten di semua handler).
        if (!passesVerifiedCheck(interaction, config)) {
            return interaction.reply({ content: '❌ Verifikasi dulu!', flags: MessageFlags.Ephemeral });
        }

        // v3.9.32: kategori midman/rekber → buka modal deal rekber, BUKAN tiket.
        // (Tombol `ticket_cat:midman` sudah di-intercept router → domain midman;
        // redirect ini khusus path dropdown yang value-nya tidak bisa di-route.)
        if (categoryId === 'midman') {
            return midmanDomain.openCreateModal(interaction);
        }

        // v3.9.19 FLEXIBILITY FIX: logic sekarang berbasis "ada produk atau tidak",
        // bukan requiresKey. Ini lebih intuitive & fleksibel:
        //   - Kategori dengan produk (transaction, jasa, dll)     → tampilkan dropdown
        //     produk. Bisa campur produk key & non-key.
        //   - Kategori tanpa produk (help, report, claim_giveaway) → langsung buat
        //     tiket tanpa produk. Pakai catConfig.label sebagai label.
        //
        // Sebelumnya (v3.9.18): pakai requiresKey=false untuk skip dropdown. Tapi
        // ini bikin kategori "jasa" yang punya beberapa produk non-key malah skip
        // dropdown → user gak bisa pilih jasa yang mana. Bug fixed sekarang.
        const productsInCat = (config.products || []).filter(p => {
            const pCat = p.category || 'transaction';
            return pCat === categoryId;
        });

        if (productsInCat.length === 0) {
            // Tidak ada produk di kategori ini → langsung buat tiket.
            const product = {
                label: catConfig.label || 'Bantuan',
                duration: '-',
                price: '-',
                isHelp: true,
                category: categoryId,
                // v3.9.19: requiresKey=false supaya tombol Set Key tidak muncul.
                requiresKey: false
            };
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return createTicket(interaction, product);
        }

        // Ada produk → tampilkan dropdown produk filtered by category
        // v3.9.26: label/price di-slice 100 (limit Discord select option).
        // v3.9.27: emoji per-produk — 📦 non-key (akun/jasa) vs 🔑 pakai key,
        // supaya pembeli langsung tahu produk mana yang butuh key.
        const selectMenu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_product')
                .setPlaceholder(`Pilih produk — ${catConfig.label}...`.slice(0, 100))
                .addOptions(
                    productsInCat.map(p => ({
                        label: String(p.label || 'Produk').slice(0, 100),
                        description: String(p.price || '-').slice(0, 100),
                        value: p.value,
                        emoji: p.requiresKey === false ? '📦' : '🔑'
                    }))
                )
        );
        return interaction.reply({
            content: `Silakan pilih produk di kategori **${catConfig.label}** ${catConfig.emoji || ''}:`,
            components: [selectMenu],
            flags: MessageFlags.Ephemeral
        });
    }

    // ====================================================
    // === v3.9.11 Phase 2: TIKET KATEGORI BUTTON → DROPDOWN PRODUK FILTERED ===
    // === customId: ticket_cat:<categoryId>                ===
    // ====================================================
    // v3.9.19: Saat user klik tombol kategori di panel tiket dinamis:
    //   - Kalau kategori punya produk → tampilkan dropdown produk filtered.
    //   - Kalau kategori kosong produk → langsung buat tiket (help/report/custom).
    // Bisa campur produk key & non-key dalam 1 kategori (mis. "Jasa" dengan
    // "Joki" non-key + "Booster" pakai key).
    if (interaction.isButton() && interaction.customId.startsWith('ticket_cat:')) {
        const categoryId = interaction.customId.split(':')[1];
        const categories = config.ticketCategories || [];
        const catConfig = categories.find(c => c.id === categoryId);

        if (!catConfig) {
            return interaction.reply({
                content: `❌ Kategori \`${categoryId}\` tidak ditemukan di config.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.17: pakai helper passesVerifiedCheck (konsisten di semua handler).
        if (!passesVerifiedCheck(interaction, config)) {
            return interaction.reply({ content: '❌ Verifikasi dulu!', flags: MessageFlags.Ephemeral });
        }

        // v3.9.19 FLEXIBILITY FIX: logic sama dengan ticket_cat_select di atas.
        //   - Ada produk di kategori → tampilkan dropdown produk.
        //   - Tidak ada produk         → langsung buat tiket (help/report/custom).
        // Bisa campur produk key & non-key dalam 1 kategori (mis. "Jasa" dengan
        // "Joki" non-key + "Booster" pakai key).
        const productsInCat = (config.products || []).filter(p => {
            const pCat = p.category || 'transaction';
            return pCat === categoryId;
        });

        if (productsInCat.length === 0) {
            // Tidak ada produk → langsung buat tiket dengan label = catConfig.label.
            const product = {
                label: catConfig.label || 'Bantuan',
                duration: '-',
                price: '-',
                isHelp: true,
                category: categoryId,
                requiresKey: false
            };
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return createTicket(interaction, product);
        }

        // Ada produk → tampilkan dropdown produk filtered by category
        // v3.9.26: label/price di-slice 100 (Discord select option limit) — data
        // lama/restore bisa melebihi batas → addOptions throw → flow tiket kategori
        // ini mati total sampai produk diperbaiki.
        // v3.9.27: emoji per-produk 📦/🔑 (lihat ticket_cat_select di atas).
        const selectMenu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_product')
                .setPlaceholder(`Pilih produk — ${catConfig.label}...`.slice(0, 100))
                .addOptions(
                    productsInCat.map(p => ({
                        label: String(p.label || 'Produk').slice(0, 100),
                        description: String(p.price || '-').slice(0, 100),
                        value: p.value,
                        emoji: p.requiresKey === false ? '📦' : '🔑'
                    }))
                )
        );
        return interaction.reply({
            content: `Silakan pilih produk di kategori **${catConfig.label}** ${catConfig.emoji || ''}:`,
            components: [selectMenu],
            flags: MessageFlags.Ephemeral
        });
    }

    // ====================================================
    // === TIKET: TOMBOL TRANSAKSI → DROPDOWN PRODUK (LEGACY) ===
    // ====================================================
    if (interaction.isButton() && interaction.customId === 'ticket_trade') {
        // v3.9.17: pakai helper passesVerifiedCheck (konsisten di semua handler).
        if (!passesVerifiedCheck(interaction, config)) {
            return interaction.reply({ content: '❌ Verifikasi dulu!', flags: MessageFlags.Ephemeral });
        }
        if (!config.products || config.products.length === 0) {
            return interaction.reply({ content: '❌ Belum ada produk.', flags: MessageFlags.Ephemeral });
        }
        const selectMenu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('select_product')
                .setPlaceholder('Pilih produk yang ingin dibeli...')
                .addOptions(
                    // v3.9.26: slice 100 (limit Discord select option) — lihat ticket_cat:.
                    // v3.9.27: emoji per-produk 📦/🔑 + teks generik (dulu "paket key"
                    // padahal dropdown bisa berisi produk non-key).
                    config.products.map(p => ({
                        label: String(p.label || 'Produk').slice(0, 100),
                        description: String(p.price || '-').slice(0, 100),
                        value: p.value,
                        emoji: p.requiresKey === false ? '📦' : '🔑'
                    }))
                )
        );
        return interaction.reply({
            content: 'Silakan pilih produk di bawah ini:',
            components: [selectMenu],
            flags: MessageFlags.Ephemeral
        });
    }

    // ====================================================
    // === TIKET: PILIH PRODUK / HELP / REPORT → BUAT TIKET ===
    // ====================================================
    if (
        (interaction.isStringSelectMenu() && interaction.customId === 'select_product') ||
        (interaction.isButton() && (interaction.customId === 'ticket_help' || interaction.customId === 'ticket_report'))
    ) {
        // v3.9.17: pakai helper passesVerifiedCheck (konsisten di semua handler).
        if (!passesVerifiedCheck(interaction, config)) {
            return interaction.reply({ content: '❌ Verifikasi dulu!', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let product;
        if (interaction.customId === 'select_product') {
            const selectedValue = interaction.values[0];
            product = config.products.find(p => p.value === selectedValue);
            if (!product) return safeEditReply(interaction, { content: '❌ Produk tidak ditemukan.' });
        } else if (interaction.customId === 'ticket_help') {
            // v3.9.18: label diupdate dari "Bantuan Staff" → "Help" (sesuai default baru).
            product = { label: 'Help', duration: '-', price: '-', isHelp: true, category: 'help' };
        } else if (interaction.customId === 'ticket_report') {
            // v3.9.18: label diupdate dari "Laporkan Member" → "Report" (sesuai default baru).
            product = { label: 'Report', duration: '-', price: '-', isHelp: true, category: 'report' };
        } else {
            // v3.9.11 Phase 3: multi-panel ticket — customId `ticket_cat:<categoryId>`
            // akan di-handle di sini. Untuk sekarang, fallback ke help.
            product = { label: 'Help', duration: '-', price: '-', isHelp: true, category: 'help' };
        }
        return createTicket(interaction, product);
    }

    // ====================================================
    // === TIKET: TUTUP TIKET (ADMIN) ===
    // ====================================================
    if (interaction.isButton() && interaction.customId === 'ticket_close') {
        const isAdmin = checkIsAdmin(interaction.member);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Hanya Admin/Staff yang dapat menutup tiket ini!',
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.31 FIX (pola P1-8): guard channel masih ada. Sebelumnya
        // `interaction.channel.id` di bawah tanpa `?.` — kalau channel terhapus
        // tepat sebelum admin klik tombol (partial/uncached), throw TypeError
        // yang ditelan handler global sebagai error generik tanpa pesan jelas.
        if (!interaction.channel) {
            return interaction.reply({
                content: '❌ Channel tiket sudah tidak ada (mungkin sudah ditutup admin lain).',
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.4 FIX: pakai getTicketMeta (sumber utama tickets.json) bukan parse topic langsung.
        const meta = getTicketMeta(interaction.channel.id, interaction.channel?.topic || '');
        // v3.9.27 FIX (bug user-reported): produk non-key (jual akun ML, jasa,
        // dll) tadinya dianggap tiket BANTUAN di sini karena isTransaction
        // ditarik dari meta.requiresKey. Akibatnya tombol "✅ Pesanan Sukses /
        // ❌ Tidak Jadi Beli" tidak pernah muncul untuk produk tanpa key.
        // Sekarang: resolveTicketType() baca flag isTransaction eksplisit
        // (disimpan saat createTicket v3.9.27+) — transaksi non-key akhirnya
        // dapat tombol close yang benar.
        const type = resolveTicketType(meta);
        const isTransaction = type.isTransaction;
        const requiresKey = type.requiresKey;

        // v3.9.20: cek apakah Set Key / Kirim Pesanan sudah dilakukan. Kalau ya,
        // transaksi sudah sukses → tombol close hanya "Selesai" (skip "Tidak Jadi Beli").
        const isCompleted = type.isCompleted;

        // 5 skenario tombol konfirmasi close:
        // - Transaksi pakai key + SUDAH Set Key (isCompleted=true):
        //     • ✅ Selesai (close sukses — kirim invoice & transcript)
        //     • ⏏️ Batal Tutup
        //
        // - Transaksi pakai key + BELUM Set Key (requiresKey=true, isCompleted=false):
        //     • ❌ Tidak Jadi Beli (close tanpa invoice)
        //     • ⏏️ Batal Tutup
        //   (sukses ditandai via Set Key, jadi gak perlu tombol sukses di sini)
        //
        // - Transaksi non-key + SUDAH Kirim Pesanan (isCompleted=true) — v3.9.27:
        //     • ✅ Selesai (close + transcript; invoice sudah terkirim saat Kirim Pesanan)
        //     • ⏏️ Batal Tutup
        //
        // - Transaksi non-key + BELUM dikirim (requiresKey=false, isCompleted=false):
        //     • ✅ Pesanan Sukses (close + kirim invoice/testimoni + role + stats)
        //     • ❌ Tidak Jadi Beli (close tanpa invoice)
        //     • ⏏️ Batal Tutup
        //
        // - Help / Report / Claim / Giveaway (isTransaction=false):
        //     • ✅ Selesai (close sukses — transcript ditandai selesai)
        //     • ❌ Tutup Tanpa Selesai (close TANPA sukses — transcript
        //       ditandai tidak selesai; channel tetap dihapus)
        //     • ⏏️ Batal Tutup (jangan tutup channel)
        //
        // v3.9.35 FIX (bug user-reported): tombol "❌ Tutup Tanpa Selesai"
        // dulunya salah pakai customId `ticket_close_abort` — sama dengan
        // "⏏️ Batal Tutup". Akibatnya KEDUA tombol hanya membatalkan
        // penutupan; tiket help/report/claim/giveaway tidak bisa ditutup
        // tanpa selesai. Sekarang tombol itu memakai customId
        // `ticket_close_cancel` yang benar-benar menutup tiket.
        const confirmRow = new ActionRowBuilder();
        if (isTransaction && requiresKey && isCompleted) {
            // v3.9.20: Set Key sudah dilakukan → transaksi sudah sukses.
            // Hanya tampilkan "Selesai" + "Batal Tutup" (tidak ada "Tidak Jadi Beli"
            // karena key sudah dikirim & role sudah diberikan).
            confirmRow.addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_close_success')
                    .setLabel('✅ Selesai')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('ticket_close_abort')
                    .setLabel('⏏️ Batal Tutup')
                    .setStyle(ButtonStyle.Secondary)
            );
        } else if (isTransaction && !requiresKey && isCompleted) {
            // v3.9.27: Kirim Pesanan / Pesanan Sukses sudah dilakukan untuk produk
            // non-key → mirror cabang Set Key: hanya "Selesai" + "Batal Tutup".
            confirmRow.addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_close_success')
                    .setLabel('✅ Selesai')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('ticket_close_abort')
                    .setLabel('⏏️ Batal Tutup')
                    .setStyle(ButtonStyle.Secondary)
            );
        } else if (isTransaction && requiresKey) {
            // Transaksi pakai key — sukses via Set Key, di sini cuma batal/abort
            confirmRow.addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_close_cancel_trans')
                    .setLabel('❌ Tidak Jadi Beli')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('ticket_close_abort')
                    .setLabel('⏏️ Batal Tutup')
                    .setStyle(ButtonStyle.Secondary)
            );
        } else if (isTransaction && !requiresKey) {
            // Transaksi non-key — butuh tombol sukses buat kirim invoice
            confirmRow.addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_close_success')
                    .setLabel('✅ Pesanan Sukses')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('ticket_close_cancel_trans')
                    .setLabel('❌ Tidak Jadi Beli')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('ticket_close_abort')
                    .setLabel('⏏️ Batal Tutup')
                    .setStyle(ButtonStyle.Secondary)
            );
        } else {
            // Help / Report / Claim / Giveaway (non-transaksi).
            // v3.9.35 FIX: "Tutup Tanpa Selesai" pakai customId
            // `ticket_close_cancel` (dulunya salah `ticket_close_abort`
            // → kedua tombol sama-sama cuma batal). "Batal Tutup" kini
            // konsisten pakai `ticket_close_abort` seperti cabang lain
            // (`_abort2` tetap di-handle untuk ephemeral lama).
            confirmRow.addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_close_success')
                    .setLabel('✅ Selesai')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('ticket_close_cancel')
                    .setLabel('❌ Tutup Tanpa Selesai')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('ticket_close_abort')
                    .setLabel('⏏️ Batal Tutup')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        // v3.9.20: pesan konfirmasi berbeda untuk 5 skenario.
        let msg;
        if (isTransaction && requiresKey && isCompleted) {
            // Set Key sudah dilakukan → transaksi sukses → close + save transcript.
            msg =
                '✅ Transaksi sudah sukses (Set Key sudah dilakukan).\nKlik **✅ Selesai** untuk menutup tiket & menyimpan transcript.';
        } else if (isTransaction && !requiresKey && isCompleted) {
            // v3.9.27: pesanan non-key sudah dikirim → mirror Set Key.
            msg =
                '✅ Pesanan sudah terkirim ke pembeli.\nKlik **✅ Selesai** untuk menutup tiket & menyimpan transcript.';
        } else if (isTransaction && requiresKey) {
            msg = '⚠️ Tutup tiket tanpa memberi key? Klik **❌ Tidak Jadi Beli**.';
        } else if (isTransaction && !requiresKey) {
            msg =
                '⚠️ Tutup tiket transaksi ini?\n' +
                '• **✅ Pesanan Sukses** — transaksi berhasil, kirim invoice/testimoni\n' +
                '• **❌ Tidak Jadi Beli** — batal, tanpa invoice';
        } else {
            // v3.9.35: pesan konfirmasi help/report — terangkas per tombol
            // (pola yang sama dengan cabang transaksi non-key di atas).
            msg =
                '⚠️ Tutup tiket ini?\n' +
                '• **✅ Selesai** — selesai, transcript ditandai sukses\n' +
                '• **❌ Tutup Tanpa Selesai** — tutup tiket sekarang, transcript ditandai tidak selesai';
        }
        return interaction.reply({ content: msg, components: [confirmRow], flags: MessageFlags.Ephemeral });
    }

    if (
        interaction.isButton() &&
        (interaction.customId === 'ticket_close_abort' || interaction.customId === 'ticket_close_abort2')
    ) {
        // Wrap interaction.update dalam try/catch. Kalau ephemeral sudah di-dismiss (10008)
        // atau token expired (10062), fallback ke reply ephemeral.
        try {
            return await interaction.update({ content: '❌ Penutupan tiket dibatalkan.', embeds: [], components: [] });
        } catch (err) {
            if (err.code === 10008 || err.code === 10062) {
                return interaction
                    .reply({ content: '❌ Penutupan tiket dibatalkan.', flags: MessageFlags.Ephemeral })
                    .catch(() => {});
            }
            console.warn('ticket_close_abort update error:', err.message);
            if (!interaction.replied) {
                return interaction
                    .reply({ content: '❌ Penutupan tiket dibatalkan.', flags: MessageFlags.Ephemeral })
                    .catch(() => {});
            }
        }
    }

    if (interaction.isButton() && interaction.customId === 'ticket_close_success') {
        // Untuk tiket help/report (selesai) ATAU transaksi non-key (pesanan sukses).
        // isSuccess=true → closeTicket akan kirim invoice ke channel invoice (kalau di-set).
        //
        // v3.9.24 FIX: re-check admin + validasi channel adalah tiket terdaftar.
        // Sebelumnya tombol konfirmasi ini langsung closeTicket TANPA cek apapun
        // (aman cuma karena row-nya ephemeral — bukan karena cek server-side).
        // closeTicket akan menghapus channel apa pun yang dikirim kepadanya,
        // jadi forged/legacy customId bisa menghapus channel non-tiket.
        if (!checkIsAdmin(interaction.member)) {
            return interaction.reply({
                content: '❌ Hanya Admin/Staff yang bisa menutup tiket!',
                flags: MessageFlags.Ephemeral
            });
        }
        const closeMeta = getTicketMeta(interaction.channel?.id, interaction.channel?.topic || '');
        if (!closeMeta) {
            return interaction.reply({
                content: '❌ Channel ini bukan tiket yang terdaftar (mungkin sudah ditutup admin lain).',
                flags: MessageFlags.Ephemeral
            });
        }
        try {
            await interaction.deferUpdate();
        } catch (err) {
            if (err.code !== 10008 && err.code !== 10062) {
                console.warn('ticket_close_success deferUpdate error:', err.message);
            }
        }

        // v3.9.27: transaksi NON-KEY yang di-close sebagai "✅ Pesanan Sukses"
        // TANPA lewat 📦 Kirim Pesanan → jalankan side-effect di sini: auto-role
        // (janji /set-product-role yang selama ini tidak pernah ditepati untuk
        // produk non-key), catat pembelian ke stats, tandai isCompleted.
        // Invoice tetap ditangani closeTicket (isSuccess=true + isTransaction).
        // Kalau sudah isCompleted (lewat Kirim Pesanan), skip — jangan dobel.
        const closeType = resolveTicketType(closeMeta);
        if (closeType.isTransaction && !closeType.requiresKey && !closeType.isCompleted) {
            // v3.9.38 FIX (FIX 4): race double-click "✅ Pesanan Sukses" — 2 klik
            // (atau 2 admin) sebelum patch isCompleted oleh klik pertama jalan →
            // completeNonKeyOrder dobel (recordPurchase 2x, auto-role 2x). Pakai
            // completionLocks (FIX 2): check-and-acquire channel lock sebelum
            // side-effect, release di finally. Klik pertama menang; klik kedua
            // yang kebetulan datang SETELAH release tetap aman — meta di-re-read
            // di bawah lock sehingga isCompleted dari klik pertama terlihat.
            const closeChId = interaction.channel.id;
            if (completionLocks.has(closeChId)) {
                await interaction
                    .followUp({ content: '⏳ Tiket sedang diproses admin lain.', flags: MessageFlags.Ephemeral })
                    .catch(() => {});
                return;
            }
            completionLocks.add(closeChId);
            try {
                // v3.9.38 FIX (FIX 4): re-read meta DI BAWAH LOCK — closeMeta di atas
                // bisa stale (dibaca sebelum deferUpdate). Kalau admin lain barusan
                // menyelesaikan tiket, isCompleted sekarang terlihat → skip dobel.
                const freshMeta = getTicketMeta(closeChId, interaction.channel?.topic || '');
                const freshType = resolveTicketType(freshMeta);
                if (freshType.isTransaction && !freshType.requiresKey && !freshType.isCompleted) {
                    const warnings = await completeNonKeyOrder(interaction, freshMeta);
                    if (warnings.length > 0) {
                        // Tiket tetap ditutup (intent admin jelas), tapi kasih tau kendalanya
                        // supaya bisa ditindaklanjuti manual (ephemeral — tetap muncul
                        // walau channel sudah terhapus).
                        await interaction
                            .followUp({
                                content: `⚠️ Tiket ditutup sebagai **Pesanan Sukses**, tapi ada kendala:\n• ${warnings.join('\n• ')}`,
                                flags: MessageFlags.Ephemeral
                            })
                            .catch(() => {});
                    }
                }
            } finally {
                // v3.9.38 FIX (FIX 4): pastikan lock dilepas walau ada error.
                completionLocks.delete(closeChId);
            }
        }
        await closeTicket(interaction.channel, interaction.user, true);
        return;
    }

    if (
        interaction.isButton() &&
        (interaction.customId === 'ticket_close_cancel_trans' || interaction.customId === 'ticket_close_cancel')
    ) {
        // Tutup tiket TANPA sukses — dua pintu, satu perilaku:
        //   - ticket_close_cancel_trans ("❌ Tidak Jadi Beli")  → tiket TRANSAKSI
        //     yang dibatalkan (tanpa invoice).
        //   - ticket_close_cancel ("❌ Tutup Tanpa Selesai")    → v3.9.35: tiket
        //     help/report/claim/giveaway yang ditutup tanpa diselesaikan.
        //     Dulunya tombol ini salah wiring ke `ticket_close_abort` (bug
        //     user-reported: "tutup tanpa selesai" cuma membatalkan penutupan).
        // v3.9.24 FIX: re-check admin + validasi tiket (sama seperti ticket_close_success).
        if (!checkIsAdmin(interaction.member)) {
            return interaction.reply({
                content: '❌ Hanya Admin/Staff yang bisa menutup tiket!',
                flags: MessageFlags.Ephemeral
            });
        }
        if (!getTicketMeta(interaction.channel?.id, interaction.channel?.topic || '')) {
            return interaction.reply({
                content: '❌ Channel ini bukan tiket yang terdaftar (mungkin sudah ditutup admin lain).',
                flags: MessageFlags.Ephemeral
            });
        }
        try {
            await interaction.deferUpdate();
        } catch (err) {
            if (err.code !== 10008 && err.code !== 10062) {
                console.warn('ticket_close_cancel_trans deferUpdate error:', err.message);
            }
        }
        await closeTicket(interaction.channel, interaction.user, false);
        return;
    }

    // ====================================================
    // === TIKET: TOMBOL SET KEY (ADMIN) → MODAL ===
    // ====================================================
    if (interaction.isButton() && interaction.customId === 'ticket_set_key') {
        const isAdmin = checkIsAdmin(interaction.member);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Hanya Admin/Staff yang bisa set key!',
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.31 FIX (pola P1-8): guard channel masih ada — konsisten dengan
        // guard yang sudah ada di modal Set Key (line ~654). `interaction.channel.id`
        // di bawah tanpa `?.` bisa throw TypeError kalau channel terhapus tepat
        // sebelum admin klik (partial/uncached).
        if (!interaction.channel) {
            return interaction.reply({
                content: '❌ Channel tiket sudah tidak ada (mungkin sudah ditutup admin lain).',
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.4 FIX: pakai getTicketMeta (sumber utama tickets.json) bukan parse topic langsung.
        const meta = getTicketMeta(interaction.channel.id, interaction.channel?.topic || '');
        const productName = meta?.productName || null;
        // v3.9.27: pakai resolveTicketType (satu sumber kebenaran) — Set Key hanya
        // untuk tiket transaksi yang memang pakai key.
        const setType = resolveTicketType(meta);
        // v3.9.38 FIX (FIX 2a): gate isCompleted — tombol Set Key yang sudah
        // pernah dijalankan (Set Key / Kirim Pesanan / Pesanan Sukses) tidak
        // boleh membuka modal lagi. Sebelumnya gate ini cuma ada di tombol
        // deliver & close flow — flow Set Key bocor: invoice dobel, stats dobel,
        // pembeli dapat 2 key. (Layer 1 dari 3 — lihat modal handler untuk layer 2-3.)
        if (setType.isCompleted) {
            return interaction.reply({
                content: 'ℹ️ Key untuk tiket ini sudah di-set sebelumnya. Tiket sudah selesai.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (!productName || !setType.isTransaction) {
            return interaction.reply({
                content: '❌ Tombol Set Key hanya untuk tiket transaksi.',
                flags: MessageFlags.Ephemeral
            });
        }
        // v3.9.16: reject kalau produk non-key (requiresKey=false).
        // Tombol Set Key seharusnya tidak muncul untuk produk non-key, tapi ini defense-in-depth
        // kalau admin somehow klik via customId lama / message lama yang belum di-update.
        // (v3.9.27: produk non-key sekarang punya tombol sendiri — 📦 Kirim Pesanan.)
        if (!setType.requiresKey) {
            return interaction.reply({
                content:
                    '❌ Produk ini tidak memerlukan key. Pakai tombol **📦 Kirim Pesanan** untuk mengirim detail pesanan ke pembeli.',
                flags: MessageFlags.Ephemeral
            });
        }

        // v3.9.26 FIX: lookup by value DULU, label sebagai fallback. Sebelumnya
        // cuma by label — admin rename produk via /update-product membuat tombol
        // Set Key di semua tiket lama error "Produk tidak ditemukan" (meta tiket
        // menyimpan label beku saat tiket dibuat). value = ID stabil.
        // v3.9.38 FIX (FIX 3b): pakai resolveProduct() — satu helper yang sama di
        // semua site lookup (tiket v3.9.38+ resolve by productValue di meta,
        // tiket legacy tetap fallback by label).
        const product = resolveProduct(config, meta);
        if (!product) {
            return interaction.reply({
                content: `❌ Produk "${productName}" tidak ditemukan di config (mungkin sudah di-rename/dihapus). Cek /list-products.`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (!product.roleId) {
            return interaction.reply({
                content: `❌ Produk **${product.label}** belum punya auto-role. Pakai \`/set-product-role\` dulu.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Buka modal input key
        // v3.9.27 FIX: slice title ke 45 char — limit Discord ModalBuilder.
        // label produk bisa 80 char (limit /add-product) → "Set Key — <label>"
        // bisa > 45 → showModal throw → tombol Set Key mati diam-diam.
        const modal = new ModalBuilder()
            .setCustomId(`modal_set_key:${product.value}`)
            .setTitle(`Set Key — ${product.label}`.slice(0, 45));

        const keyInput = new TextInputBuilder()
            .setCustomId('key_value')
            .setLabel('Key yang akan dikirim ke pembeli')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder('Contoh: ABCDE-12345-FGHIJ-67890')
            .setMinLength(1)
            .setMaxLength(500);

        modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
        return interaction.showModal(modal);
    }

    // ====================================================
    // === MODAL SET KEY SUBMIT — FULL FLOW ===
    // ====================================================
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_set_key:')) {
        // v3.9.24 FIX: re-check admin di modal submit (defense-in-depth — sama
        // seperti backup.js). Sebelumnya cek admin cuma ada di tombol ticket_set_key;
        // modal bisa di-submit oleh user lain kalau somehow modalnya kebuka
        // (customId forged / client state aneh).
        if (!checkIsAdmin(interaction.member)) {
            return interaction
                .reply({
                    content: '❌ Hanya Admin/Staff yang bisa set key!',
                    flags: MessageFlags.Ephemeral
                })
                .catch(() => {});
        }
        // v3.9.38 FIX (FIX 2c): per-channel completion lock (defense-in-depth
        // layer 3). Gate isCompleted di tombol (layer 1) + re-check meta di
        // modal (layer 2) tidak menutup race 2 admin submit bersamaan — kedua
        // submit lewat cek SEBELUM side-effect pertama selesai. Lock
        // check-and-acquire atomik di event loop; release di finally.
        const lockChId = interaction.channel?.id || null;
        if (lockChId && completionLocks.has(lockChId)) {
            return interaction
                .reply({ content: '⏳ Tiket sedang diproses admin lain, tunggu sebentar.', flags: MessageFlags.Ephemeral })
                .catch(() => {});
        }
        if (lockChId) completionLocks.add(lockChId);
        try {
            // v3.9.7: log deferReply failure (sama seperti embed builder modal)
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(err => {
                console.warn(`[Set Key Modal] deferReply gagal untuk ${interaction.customId}: ${err.message}`);
            });

            const productValue = interaction.customId.split(':')[1];
            const keyValue = interaction.components[0]?.components?.[0]?.value?.trim() || '';
            // v3.9.38 FIX (FIX 5a): key kosong/whitespace ditolak SEBELUM side
            // effect apa pun. Modal required=true + minLength=1 biasanya mencegah,
            // tapi input berisi spasi saja lolos validasi Discord (trim → kosong)
            // dan dulu tetap tersimpan sebagai key blank oleh addKey.
            if (!keyValue) {
                return safeEditReply(interaction, { content: '❌ Key tidak boleh kosong.' });
            }

            // P1-8 FIX: validasi interaction.channel masih ada (belum dihapus admin lain).
            // Sebelumnya: kalau channel sudah dihapus saat admin submit modal,
            // `interaction.channel.topic` throw TypeError → error generik.
            if (!interaction.channel) {
                return safeEditReply(interaction, {
                    content: '❌ Channel tiket sudah tidak ada (mungkin sudah ditutup admin lain).'
                }).catch(() => {});
            }

            // v3.9.1: baca metadata tiket dari tickets.json (sumber kebenaran).
            // Fallback ke topic parsing untuk tiket lama yang dibuat sebelum v3.9.1.
            const topic = interaction.channel.topic || '';
            const meta = getTicketMeta(interaction.channel.id, topic);
            const userId = meta?.userId || null;
            const price = meta?.price || 'Unknown';

            if (!userId) {
                return safeEditReply(interaction, {
                    content: '❌ Gagal ambil metadata tiket (channel ini mungkin bukan tiket valid).'
                });
            }

            // v3.9.38 FIX (FIX 2b, layer 2): re-check isCompleted di bawah lock —
            // admin lain bisa menyelesaikan tiket ini (Set Key / Kirim Pesanan /
            // ✅ Pesanan Sukses) di antara modal dibuka dan di-submit. Tanpa
            // re-check, invoice + stats + key terkirim DOBEL.
            if (resolveTicketType(meta).isCompleted) {
                return safeEditReply(interaction, {
                    content: 'ℹ️ Tiket ini sudah selesai diproses admin lain.'
                });
            }

            // v3.9.38 FIX (FIX 3b): resolve produk dari META (productValue stabil
            // dulu, label fallback) — rename-proof. Fallback terakhir ke value di
            // customId (perilaku legacy v3.9.26: tombol resolve produk lalu embed
            // value-nya ke customId modal).
            const product = resolveProduct(config, meta) || config.products.find(p => p.value === productValue);
            if (!product) {
                return safeEditReply(interaction, { content: `❌ Produk value \`${productValue}\` tidak ditemukan.` });
            }
            if (!product.roleId) {
                return safeEditReply(interaction, { content: `❌ Produk **${product.label}** belum punya auto-role.` });
            }

            const guild = interaction.guild;
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
                return safeEditReply(interaction, { content: `❌ Member <@${userId}> sudah tidak ada di server.` });
            }
            const role = guild.roles.cache.get(product.roleId);
            if (!role) {
                return safeEditReply(interaction, {
                    content: `❌ Role ID \`${product.roleId}\` tidak ditemukan di guild.`
                });
            }

            // === 1. Simpan key baru (independent expireAt) ===
            // v3.9.17 FIX: wrap addKey di try/catch. Sebelumnya, kalau key duplikat,
            // addKey throw "Key sudah ada" → propagate ke global handler → admin
            // lihat error generik "Terjadi error, coba lagi" tanpa tahu penyebabnya.
            // Sekarang: catch spesifik, balas dengan pesan jelas.
            let keyEntry;
            try {
                keyEntry = addKey({
                    key: keyValue,
                    userId: member.id,
                    username: member.user.tag,
                    roleId: role.id,
                    productName: product.label,
                    days: product.days || 0,
                    guildId: interaction.guild.id // v3.9.3: simpan guildId supaya cross-guild wipe akurat
                });
            } catch (keyErr) {
                // v3.9.38 FIX (FIX 6): log hanya panjang key — error duplikat dari
                // keyManager sudah tidak menyertakan nilai key (bocor ke console log).
                console.warn(`⚠️ Gagal simpan key (kemungkinan duplikat) — key (len=${keyValue.length}):`, keyErr.message);
                return safeEditReply(interaction, {
                    content: `❌ Gagal simpan key: ${keyErr.message}\n\n💡 Coba pakai key lain, atau hapus key lama via \`/list-keys\` dulu.`
                });
            }

            // === 2. Schedule role removal (MAX EXTEND) — v3.9.17: pindah SEBELUM addRole ===
            // v3.9.17 FIX: reorder. Sebelumnya: addKey → addRole → scheduleRoleRemoval.
            // Kalau bot crash setelah addRole tapi sebelum schedule, role menempel tanpa
            // auto-expire. Sekarang: addKey → scheduleRoleRemoval → addRole.
            // Kalau crash setelah schedule tapi sebelum addRole: schedule entry orphan
            // (roleId ter-schedule tapi user belum dapat role) — scheduler tick akan
            // detect "member tidak punya role" dan skip, lebih aman dari role permanen.
            let scheduleResult;
            try {
                scheduleResult = scheduleRoleRemoval({
                    userId: member.id,
                    roleId: role.id,
                    guildId: guild.id,
                    days: product.days || 0,
                    expireAt: keyEntry.expireAt,
                    productName: product.label
                });
            } catch (schedErr) {
                console.error(
                    `⚠️ Gagal scheduleRoleRemoval saat set-key (key tetap tersimpan, role TIDAK diberikan): ${schedErr.message}`
                );
                // Catatan: key yang barusan di-add tersimpan tanpa auto-expire schedule.
                // Tidak ada API targeted removal untuk single key di keyManager (hanya
                // removeAllKeysByUser yang terlalu broad). Admin bisa manual remove via
                // /list-keys kalau perlu. Log warning supaya kelihatan.
                console.warn(
                    // v3.9.38 FIX (FIX 6): jangan bocorkan nilai key mentah ke console
                    // log — cukup panjangnya (pola /set-key audit log v3.9.1).
                    `⚠️ Schedule gagal — key (len=${keyValue.length}) tersimpan tanpa auto-expire. Admin perlu manual remove via /list-keys jika perlu.`
                );
                return safeEditReply(interaction, {
                    content: `❌ Gagal schedule auto-expire role: ${schedErr.message}\n\nKey sudah tersimpan tapi role BELUM diberikan. Coba Set Key lagi, atau hubungi dev.`
                });
            }

            // === 3. Berikan role ke member ===
            try {
                if (!member.roles.cache.has(role.id)) {
                    await member.roles.add(role);
                }
            } catch (err) {
                console.error('Gagal add role saat set key:', err.message);
                return safeEditReply(interaction, {
                    content: `❌ Gagal memberikan role ${role}. Pastikan role bot ada di ATAS role tersebut.\n\nKey + schedule sudah tersimpan. Hubungi admin untuk add role manual.`
                });
            }

            // === 4. DM member ===
            // v3.9.22: DM format sesuai template user — pakai emoji supaya lebih
            // ramai & gak sepi. Role pakai nama role (role.name) bukan mention
            // (`${role}`), karena di DM mention role gak ke-resolve (muncul
            // "unknown role" atau @role mentah).
            let dmSent = false;
            try {
                let expireInfo;
                if (keyEntry.expireAt === null) {
                    expireInfo = 'permanen (gak akan hilang)';
                } else {
                    const days = Math.ceil((keyEntry.expireAt - Date.now()) / 86400000);
                    expireInfo = `${days} hari lagi`;
                }

                // Cek semua key aktif buat info tambahan
                // v3.9.31: pass guildId (opsional) supaya guild-scoped konsisten pola lain.
                const activeKeys = getActiveKeysByUserAndRole(member.id, role.id, Date.now(), guild.id);
                // v3.9.26 FIX: bound daftar key di DM. Key bisa 200 char; 4+ key panjang
                // bikin DM > 2000 char → member.send throw → dmSent=false padahal
                // key/role/schedule sudah sukses. Sekarang maks 5 key teratas + ringkasan.
                const MAX_KEYS_IN_DM = 5;
                const shownKeys = activeKeys.slice(0, MAX_KEYS_IN_DM);
                const hiddenKeys = activeKeys.length - shownKeys.length;
                const keyList =
                    shownKeys
                        .map((k, i) => {
                            const rem = formatRemaining(k);
                            return `${i + 1}. \`${k.key}\` (sisa ${rem})`;
                        })
                        .join('\n') + (hiddenKeys > 0 ? `\n... +${hiddenKeys} key lainnya (tanya admin)` : '');
                const keyListStr = activeKeys.length > 0 ? keyList : '_(belum ada)_';

                // v3.9.17 FIX: sanitize backtick di keyValue. Kalau key mengandung
                // backtick, inline code bisa break. Ganti dengan single quote.
                const safeKey = keyValue.replace(/`/g, "'");

                await member.send({
                    content:
                        `Halo ${member.user.username}! Transaksi kamu udah selesai 🎉\n\n` +
                        `📦 Produk: ${product.label}\n` +
                        `🌐 Server: ${guild.name}\n\n` +
                        `🔑 KEY:\n` +
                        `\`${safeKey}\`\n\n` +
                        `🎭 Role: ${role.name}\n` +
                        `⏰ Expire: ${expireInfo}\n\n` +
                        `📋 Key aktif kamu untuk role ini:\n${keyListStr}\n\n` +
                        `💡 Simpan keynya. Kalau role tiba-tiba hilang padahal key masih aktif, hubungi admin.`
                });
                dmSent = true;
            } catch (_dmErr) {
                console.log(`ℹ️ Tidak bisa kirim DM ke ${member.user.tag} (mungkin DM ditutup).`);
            }

            // === 5. Kirim invoice ke channel invoice ===
            // v3.9.8 FIX: wrap sendInvoice di try/catch. Sebelumnya, kalau sendInvoice
            // throw (channel invoice hilang / bot gak punya SendMessages), outer catch
            // menyamarkan error. Padahal key + role + schedule + DM sudah terlanjur jalan.
            // Admin lihat error → klik "Set Key" lagi → addKey jalan 2x (duplicate key).
            // v3.9.27: catat isInvoiceSent — invoice saat Set Key tidak dikirim LAGI saat
            // close "Selesai" (dulu kekirim dobel: 1x di sini + 1x di closeTicket).
            let invoiceOk = false;
            try {
                invoiceOk = await sendInvoice(interaction.channel, userId, product.label, price, interaction.user);
            } catch (invoiceErr) {
                console.warn(`⚠️ Gagal kirim invoice saat set-key (key tetap tersimpan): ${invoiceErr.message}`);
            }

            // === 5.5. Track purchase untuk stats/leaderboard ===
            try {
                // v3.9.4: scoped per guild
                recordPurchase(interaction.guild.id, userId, parsePrice(price));
            } catch (_) {}

            // === 5.6. P1-10 FIX: audit log untuk SET_KEY via ticket modal ===
            try {
                await logAudit(interaction.client, {
                    action: 'SET_KEY',
                    actorId: interaction.user.id,
                    actorTag: interaction.user.tag,
                    details: `Set key (ticket) untuk <@${member.id}> — produk: **${product.label}**, role: ${role.name}`,
                    guildId: interaction.guild.id
                });
            } catch (_) {}

            // v3.9.8 FIX: balas ephemeral SEBELUM hapus channel. Sebelumnya, comment
            // bilang "channel sudah dihapus, jadi tidak perlu editReply" — ini SALAH.
            // Ephemeral reply terikat ke interaction token (bukan channel), jadi tetap
            // valid setelah channel dihapus. Tanpa editReply, admin lihat "Thinking..."
            // 15 menit sampai token expired.
            try {
                await safeEditReply(interaction, {
                    content: `✅ Set Key sukses!\n\n👤 Member: <@${userId}>\n📦 Produk: ${product.label}\n🎭 Role: ${role.name}\n${dmSent ? '📬 DM terkirim.' : '⚠️ DM gagal.'}`
                });
            } catch (_) {}

            // === v3.9.21: Jangan munculin embed/panel baru di channel. ===
            // Cukup kirim pesan teks simpel yang bilang "key sudah dikirim via DM".
            // Tombol Tutup Tiket dari pesan awal createTicket masih ada — admin bisa
            // klik itu kalau udah selesai Q&A sama member.
            try {
                patchTicketMeta(interaction.channel.id, {
                    isCompleted: true,
                    keySetAt: Date.now(),
                    keySetBy: interaction.user.id,
                    // v3.9.27: anti dobel-invoice saat close (kalau invoice sukses terkirim).
                    ...(invoiceOk ? { isInvoiceSent: true } : {})
                });
            } catch (patchErr) {
                console.warn('⚠️ Gagal patch meta (isCompleted):', patchErr.message);
            }

            try {
                // v3.9.22: Notif di channel TIDAK untuk admin — untuk user.
                // Cukup kasih tau kalau key udah dikirim via DM. Singkat & jelas.
                // Kalau DM gagal, fallback kasih tau admin supaya kirim manual.
                const noticeMsg = dmSent
                    ? `Halo <@${userId}>! 🔑 Key kamu udah dikirim via DM, cek ya 📬`
                    : `⚠️ <@${userId}> — gagal kirim DM (kemungkinan DM ditutup). Admin akan kirim key manual ya.`;

                await interaction.channel.send({
                    content: noticeMsg
                });
            } catch (sendErr) {
                console.warn('⚠️ Gagal kirim notice "key sudah dikirim" ke channel:', sendErr.message);
            }

            // === 7. Log sukses (channel TIDAK dihapus — admin yang close manual) ===
            console.log(
                `✅ Set Key sukses: ${member.user.tag} | produk=${product.label} | role=${role.name} | extend=${scheduleResult.extended} | permanen=${scheduleResult.permanent} | dm=${dmSent} | invoice=${invoiceOk} | channel TIDAK dihapus (menunggu admin close manual)`
            );
            return;
        } finally {
            // v3.9.38 FIX (FIX 2c): pastikan lock dilepas walau handler throw.
            if (lockChId) completionLocks.delete(lockChId);
        }
    }

    // ====================================================
    // === v3.9.27: TOMBOL KIRIM PESANAN (ADMIN) → MODAL ===
    // === customId: ticket_deliver (button)              ===
    // ====================================================
    // Mirror dari Set Key, khusus produk transaksi NON-KEY (jual akun ML,
    // jasa, dll). Sebelumnya produk non-key hanya punya tombol Tutup Tiket —
    // detail pesanan (akun/password) hanya ada di chat tiket yang TERHAPUS
    // saat close. Sekarang: admin klik tombol → isi detail di modal → bot DM
    // detail ke pembeli + auto-role (kalau di-set) + stats + invoice.
    if (interaction.isButton() && interaction.customId === 'ticket_deliver') {
        if (!checkIsAdmin(interaction.member)) {
            return interaction.reply({
                content: '❌ Hanya Admin/Staff yang bisa kirim pesanan!',
                flags: MessageFlags.Ephemeral
            });
        }

        const meta = getTicketMeta(interaction.channel?.id, interaction.channel?.topic || '');
        if (!meta) {
            return interaction.reply({
                content: '❌ Channel ini bukan tiket yang terdaftar (mungkin sudah ditutup admin lain).',
                flags: MessageFlags.Ephemeral
            });
        }
        const deliverType = resolveTicketType(meta);
        if (!deliverType.isTransaction) {
            return interaction.reply({
                content: '❌ Tombol Kirim Pesanan hanya untuk tiket transaksi.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (deliverType.requiresKey) {
            // Produk pakai key → pakai Set Key (bukan ini).
            return interaction.reply({
                content: '❌ Produk ini pakai key — pakai tombol **🔑 Set Key**.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (deliverType.isCompleted) {
            return interaction.reply({
                content: 'ℹ️ Pesanan tiket ini sudah dikirim/diselesaikan. Langsung tutup tiketnya saja (✅ Selesai).',
                flags: MessageFlags.Ephemeral
            });
        }

        // Lookup produk: by value dulu, label fallback (pola v3.9.26).
        // v3.9.38 FIX (FIX 3b): pakai resolveProduct() — lookup by productValue
        // di meta (stabil, rename-proof), label fallback untuk tiket legacy.
        const productName = meta?.productName || null;
        const product = resolveProduct(config, meta);
        if (!product) {
            return interaction.reply({
                content: `❌ Produk "${productName}" tidak ditemukan di config (mungkin sudah di-rename/dihapus). Cek /list-products.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Buka modal input detail pesanan.
        // v3.9.27 FIX: title di-slice 45 char (limit ModalBuilder — lihat Set Key).
        const modal = new ModalBuilder()
            .setCustomId(`modal_deliver_order:${product.value}`)
            .setTitle(`Kirim Pesanan — ${product.label}`.slice(0, 45));

        const detailsInput = new TextInputBuilder()
            .setCustomId('delivery_details')
            .setLabel('Detail pesanan untuk pembeli')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            // Di modal, Enter menghasilkan newline ASLI — cocok untuk detail
            // multi-baris (username/password/note). Tidak perlu \n conversion.
            .setPlaceholder('Contoh: Username: akunml123 | Password: rahasia | Note: ...')
            .setMinLength(1)
            .setMaxLength(1500);

        modal.addComponents(new ActionRowBuilder().addComponents(detailsInput));
        return interaction.showModal(modal);
    }

    // ====================================================
    // === v3.9.27: MODAL KIRIM PESANAN SUBMIT — FULL FLOW ===
    // === customId: modal_deliver_order:<value> (modal)  ===
    // ====================================================
    // Urutan (mirror Set Key): role-schedule → role → DM detail → invoice →
    // stats → audit → reply admin → patch meta → notice di channel.
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_deliver_order:')) {
        // v3.9.24-style: re-check admin di modal submit (defense-in-depth).
        if (!checkIsAdmin(interaction.member)) {
            return interaction
                .reply({
                    content: '❌ Hanya Admin/Staff yang bisa kirim pesanan!',
                    flags: MessageFlags.Ephemeral
                })
                .catch(() => {});
        }
        // v3.9.38 FIX (FIX 2c): per-channel completion lock (defense-in-depth
        // layer 3). Gate isCompleted di tombol (layer 1) + re-check meta di
        // modal (layer 2) tidak menutup race 2 admin submit bersamaan — kedua
        // submit lewat cek SEBELUM side-effect pertama selesai. Lock
        // check-and-acquire atomik di event loop; release di finally.
        const lockChId = interaction.channel?.id || null;
        if (lockChId && completionLocks.has(lockChId)) {
            return interaction
                .reply({ content: '⏳ Tiket sedang diproses admin lain, tunggu sebentar.', flags: MessageFlags.Ephemeral })
                .catch(() => {});
        }
        if (lockChId) completionLocks.add(lockChId);
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(err => {
                console.warn(`[Kirim Pesanan Modal] deferReply gagal untuk ${interaction.customId}: ${err.message}`);
            });

            // P1-8-style FIX: validasi channel masih ada (belum dihapus admin lain).
            if (!interaction.channel) {
                return safeEditReply(interaction, {
                    content: '❌ Channel tiket sudah tidak ada (mungkin sudah ditutup admin lain).'
                }).catch(() => {});
            }

            const productValue = interaction.customId.split(':')[1];
            const details = interaction.components[0]?.components?.[0]?.value?.trim() || '';
            if (!details) {
                return safeEditReply(interaction, { content: '❌ Detail pesanan kosong.' });
            }

            const meta = getTicketMeta(interaction.channel.id, interaction.channel.topic || '');
            const userId = meta?.userId || null;
            const price = meta?.price || 'Unknown';
            if (!userId) {
                return safeEditReply(interaction, {
                    content: '❌ Gagal ambil metadata tiket (channel ini mungkin bukan tiket valid).'
                });
            }

            // v3.9.38 FIX (FIX 2b, layer 2): re-check isCompleted di bawah lock —
            // admin lain bisa menyelesaikan tiket ini di antara modal dibuka dan
            // di-submit. Tanpa re-check, invoice + stats + role terkirim DOBEL.
            if (resolveTicketType(meta).isCompleted) {
                return safeEditReply(interaction, {
                    content: 'ℹ️ Tiket ini sudah selesai diproses admin lain.'
                });
            }

            // v3.9.38 FIX (FIX 3b): resolve produk dari META (productValue stabil
            // dulu, label fallback) — rename-proof. Fallback terakhir ke value di
            // customId (perilaku legacy v3.9.27).
            const product = resolveProduct(config, meta) || config.products.find(p => p.value === productValue);
            if (!product) {
                return safeEditReply(interaction, {
                    content: `❌ Produk value \`${productValue}\` tidak ditemukan (mungkin sudah dihapus). Cek /list-products.`
                });
            }

            const guild = interaction.guild;
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
                return safeEditReply(interaction, { content: `❌ Member <@${userId}> sudah tidak ada di server.` });
            }

            // === 1. Auto-role (kalau di-set) — schedule SEBELUM add (pola v3.9.17) ===
            let roleInfo = null;
            let expireInfo = null;
            if (product.roleId) {
                const role = guild.roles.cache.get(product.roleId);
                if (!role) {
                    return safeEditReply(interaction, {
                        content: `❌ Role ID \`${product.roleId}\` tidak ditemukan di guild. Cek /set-product-role.`
                    });
                }
                if ((product.days || 0) > 0) {
                    try {
                        scheduleRoleRemoval({
                            userId: member.id,
                            roleId: role.id,
                            guildId: guild.id,
                            days: product.days,
                            productName: product.label
                        });
                    } catch (schedErr) {
                        console.error(
                            `⚠️ Gagal scheduleRoleRemoval saat kirim pesanan (role TIDAK diberikan): ${schedErr.message}`
                        );
                        return safeEditReply(interaction, {
                            content: `❌ Gagal schedule auto-expire role: ${schedErr.message}\n\nRole belum diberikan. Coba lagi atau hubungi dev.`
                        });
                    }
                }
                try {
                    if (!member.roles.cache.has(role.id)) {
                        await member.roles.add(role);
                    }
                    roleInfo = role.name;
                    expireInfo = (product.days || 0) > 0 ? `${product.days} hari lagi` : 'permanen';
                } catch (roleErr) {
                    console.error('Gagal add role saat kirim pesanan:', roleErr.message);
                    return safeEditReply(interaction, {
                        content: `❌ Gagal memberikan role ${role}. Pastikan role bot ada di ATAS role tersebut.\n\nCoba Kirim Pesanan lagi, atau add role manual.`
                    });
                }
            }

            // === 2. DM detail pesanan ke pembeli ===
            // Detail dikirim APA ADANYA (tanpa sanitize) — ini bisa berupa password,
            // mengubah isi = merusak kredensial pembeli.
            let dmSent = false;
            try {
                await member.send({
                    content:
                        `Halo ${member.user.username}! Pesanan kamu udah dikirim 🎉\n\n` +
                        `📦 Produk: ${product.label}\n` +
                        `🌐 Server: ${guild.name}\n\n` +
                        `📋 DETAIL PESANAN:\n${details}\n\n` +
                        (roleInfo ? `🎭 Role: ${roleInfo}\n⏰ Expire: ${expireInfo}\n\n` : '') +
                        `💡 Simpan detail ini. Kalau ada masalah dengan pesanan, hubungi admin.`
                });
                dmSent = true;
            } catch (_dmErr) {
                console.log(`ℹ️ Tidak bisa kirim DM ke ${member.user.tag} (mungkin DM ditutup).`);
            }

            // === 3. Invoice ke channel invoice ===
            let invoiceOk = false;
            try {
                invoiceOk = await sendInvoice(interaction.channel, userId, product.label, price, interaction.user);
            } catch (invoiceErr) {
                console.warn(`⚠️ Gagal kirim invoice saat kirim pesanan (pesanan tetap tercatat): ${invoiceErr.message}`);
            }

            // === 4. Track purchase untuk stats/leaderboard ===
            // Sebelum v3.9.27: cuma tercatat via Set Key — penjualan produk non-key
            // (akun ML, jasa) TIDAK PERNAH masuk stats/leaderboard.
            try {
                recordPurchase(guild.id, userId, parsePrice(price));
            } catch (_) {}

            // === 5. Audit log ===
            try {
                await logAudit(interaction.client, {
                    action: 'ORDER_DELIVERED',
                    actorId: interaction.user.id,
                    actorTag: interaction.user.tag,
                    details: `Kirim pesanan (ticket) untuk <@${member.id}> — produk: **${product.label}**${roleInfo ? `, role: ${roleInfo}` : ''}`,
                    guildId: interaction.guild.id
                });
            } catch (_) {}

            // === 6. Reply admin ===
            try {
                await safeEditReply(interaction, {
                    content:
                        `✅ Pesanan terkirim!\n\n👤 Member: <@${userId}>\n📦 Produk: ${product.label}\n` +
                        (roleInfo ? `🎭 Role: ${roleInfo}\n` : '') +
                        `${invoiceOk ? '🧾 Invoice terkirim.\n' : ''}` +
                        (dmSent ? '📬 DM terkirim.' : '⚠️ DM gagal — kirim detail manual ke member (cek chat tiket).')
                });
            } catch (_) {}

            // === 7. Patch meta: isCompleted + anti dobel-invoice ===
            try {
                patchTicketMeta(interaction.channel.id, {
                    isCompleted: true,
                    deliveredAt: Date.now(),
                    deliveredBy: interaction.user.id,
                    ...(invoiceOk ? { isInvoiceSent: true } : {})
                });
            } catch (patchErr) {
                console.warn('⚠️ Gagal patch meta (isCompleted):', patchErr.message);
            }

            // === 8. Notice di channel untuk pembeli ===
            try {
                const noticeMsg = dmSent
                    ? `Halo <@${userId}>! 📦 Detail pesanan kamu udah dikirim via DM, cek ya 📬`
                    : `⚠️ <@${userId}> — gagal kirim DM (kemungkinan DM ditutup). Admin akan kirim detail pesanan manual ya.`;
                await interaction.channel.send({ content: noticeMsg });
            } catch (sendErr) {
                console.warn('⚠️ Gagal kirim notice "pesanan sudah dikirim" ke channel:', sendErr.message);
            }

            console.log(
                `✅ Kirim Pesanan sukses: ${member.user.tag} | produk=${product.label} | role=${roleInfo || '-'} | dm=${dmSent} | invoice=${invoiceOk} | channel TIDAK dihapus (menunggu admin close manual)`
            );
            return;
        } finally {
            // v3.9.38 FIX (FIX 2c): pastikan lock dilepas walau handler throw.
            if (lockChId) completionLocks.delete(lockChId);
        }
    }
};

/**
 * v3.9.27: Side-effect "✅ Pesanan Sukses" untuk transaksi non-key yang di-close
 * TANPA lewat 📦 Kirim Pesanan: auto-role + stats + tandai isCompleted.
 * Dipanggil dari ticket_close_success SEBELUM closeTicket (invoice ditangani
 * closeTicket). Non-blocking per langkah — kendala dikumpulkan jadi warnings,
 * tiket tetap ditutup (intent admin sudah jelas; role bisa di-add manual).
 *
 * @param {Interaction} interaction - interaction tombol ticket_close_success
 * @param {Object} meta - metadata tiket (dari tickets.json)
 * @returns {Promise<string[]>} daftar kendala (kosong = semua mulus)
 */
async function completeNonKeyOrder(interaction, meta) {
    const warnings = [];
    const config = getConfig();
    const userId = meta?.userId;

    // 1. Auto-role (kalau produknya punya roleId — janji /set-product-role).
    // v3.9.38 FIX (FIX 3b): pakai resolveProduct() — lookup by productValue di
    // meta (stabil, rename-proof), label fallback untuk tiket legacy.
    const product = resolveProduct(config, meta);
    if (product && product.roleId) {
        try {
            const guild = interaction.guild;
            const member = userId ? await guild.members.fetch(userId).catch(() => null) : null;
            const role = guild.roles.cache.get(product.roleId);
            if (!member) {
                warnings.push(`member <@${userId}> sudah keluar — role **${product.label}** tidak diberikan`);
            } else if (!role) {
                warnings.push(`role ID \`${product.roleId}\` (produk **${product.label}**) tidak ditemukan di guild`);
            } else {
                if ((product.days || 0) > 0) {
                    try {
                        scheduleRoleRemoval({
                            userId: member.id,
                            roleId: role.id,
                            guildId: guild.id,
                            days: product.days,
                            productName: product.label
                        });
                    } catch (schedErr) {
                        warnings.push(`gagal schedule auto-expire role ${role.name}: ${schedErr.message}`);
                    }
                }
                try {
                    if (!member.roles.cache.has(role.id)) {
                        await member.roles.add(role);
                    }
                } catch (roleErr) {
                    warnings.push(`gagal memberikan role ${role.name}: ${roleErr.message} (add manual)`);
                }
            }
        } catch (err) {
            warnings.push(`gagal proses auto-role: ${err.message}`);
        }
    } else if (product && !product.roleId) {
        // Produk tanpa auto-role — bukan kendala, memang tidak di-set.
    } else {
        warnings.push(`produk "${meta?.productName}" tidak ditemukan di config — auto-role tidak diproses`);
    }

    // 2. Catat pembelian ke stats/leaderboard (dulu cuma via Set Key).
    try {
        recordPurchase(interaction.guild.id, userId, parsePrice(meta?.price));
    } catch (_) {}

    // 3. Tandai isCompleted — mencegah side-effect dobel + transcript catat sukses.
    // (Invoice TIDAK ditandai di sini — closeTicket yang mengirimnya.)
    try {
        patchTicketMeta(interaction.channel.id, {
            isCompleted: true,
            completedAt: Date.now(),
            completedBy: interaction.user.id
        });
    } catch (patchErr) {
        console.warn('⚠️ Gagal patch meta (isCompleted) saat Pesanan Sukses:', patchErr.message);
    }

    return warnings;
}
