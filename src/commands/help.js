/**
 * Domain: help
 * Slash commands: /help
 *
 * v3.9.12: Update komprehensif — refleksikan semua command baru dari Phase 1+2+3
 * + modal editor untuk message config + ticket body template variables.
 * v3.9.37: Auto-Split di-update ke 3 kategori (tambah 🤝 REKBER), tambah section
 * Midman/Rekber, dan versi embed kini dinamis dari package.json (anti stale).
 * v3.9.38: embed /help diukur total karakternya (limit Discord 6000) — kalau
 * lewat 5800 (buffer 200), fields dipecah ke 2 embed (reply + followUp) supaya
 * penambahan command berikutnya tidak bikin /help throw/meragukan API.
 */

const { EmbedBuilder, MessageFlags } = require('./_shared');

// v3.9.37: versi diambil dinamis dari package.json (single source of truth)
// supaya /help gak pernah stale lagi (sebelumnya hardcode "v3.9.26" padahal
// bot sudah jauh lebih baru).
const { version: BOT_VERSION } = require('../../package.json');

module.exports = async function (interaction) {
    // v3.9.38 FIX: /help embed saat ini ±5419/6000 char (audit) — makin banyak
    // command, makin besar. Kalau total > 5800, EmbedBuilder + Discord API
    // bakal menolak (embed > 6000) → /help mati diam-diam. Solusi: ukur total
    // (title + description + fields + footer), kalau lewat budget, pecah
    // field terakhir ke embed kedua yang dikirim sebagai followUp (visibility
    // ephemeral sama dengan reply pertama).
    const HELP_TOTAL_SPLIT_THRESHOLD = 5800;

    /**
     * Hitung total karakter embed seperti cara Discord menghitung limit 6000:
     * title + description + field (name+value) + footer.text + author.name.
     * @param {EmbedBuilder} embed
     * @returns {number}
     */
    function embedTotalChars(embed) {
        const data = embed.data;
        let total = 0;
        if (data.title) total += data.title.length;
        if (data.description) total += data.description.length;
        for (const f of data.fields || []) {
            total += (f.name?.length || 0) + (f.value?.length || 0);
        }
        if (data.footer?.text) total += data.footer.text.length;
        if (data.author?.name) total += data.author.name.length;
        return total;
    }

    /**
     * Bangun embed /help dari potongan fields. `part` diisi kalau ini embed
     * lanjutan (2/2) supaya user tampilannya nyambung.
     * @param {Array} fields - array field object untuk addFields
     * @param {string|null} part - null untuk embed utama, '2/2' untuk lanjutan
     * @returns {EmbedBuilder}
     */
    function buildHelpEmbed(fields, part = null) {
        const embed = new EmbedBuilder()
            .setTitle(part ? `🤖 COMMUNITY BOT — HELP (${part})` : '🤖 COMMUNITY BOT — HELP')
            .setDescription(
                part
                    ? `_Lanjutan daftar command (v${BOT_VERSION})._`
                    : `Halo ${interaction.user}! Anda terverifikasi sebagai **Admin/Staff**.\n` +
                          `Berikut daftar lengkap command yang tersedia (v${BOT_VERSION}).`
            )
            .setColor(0x5865f2);
        if (fields.length > 0) embed.addFields(fields);
        embed
            .setFooter({
                text: `${interaction.client.user.username} v${BOT_VERSION} — All-in-One Community Bot`,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return embed;
    }

    const helpFields = [
            {
                name: '📋 Informasi',
                value: [
                    '• `/help` — tampilkan pesan bantuan ini',
                    '• `/list-products` — lihat semua produk',
                    '• `/list-categories` — lihat semua kategori tiket',
                    '• `/list-messages` — lihat semua teks pesan embed',
                    '• `/config-show` — lihat semua konfigurasi bot'
                ].join('\n'),
                inline: false
            },

            {
                name: '🏗️ Panel Tiket (Multi-Panel)',
                value: [
                    '• `/setup-verify` — pasang panel verifikasi',
                    '• `/setup-ticket` — pasang panel tiket (legacy)',
                    '• `/setup-ticket-panel` — panel multi-panel penuh:',
                    '   opsi: `title` `body` `color:#ff5733` `image` `thumbnail` `footer` `categories` `channel` `use_dropdown`',
                    '• `/list-panels` `/update-panel` `/refresh-panel` `/delete-panel`',
                    '• `/set-verify-button` — kustomisasi tombol verifikasi',
                    '💡 Multi-panel = tiap panel custom sendiri. Disimpan ke panels.json.'
                ].join('\n'),
                inline: false
            },

            {
                name: '🎫 Kategori Tiket (CRUD)',
                value: [
                    '• `/add-category id:jasa label:"Jasa" emoji:🎮 style:Success requires_key:false`',
                    '• `/update-category id:jasa label:"Jasa Premium" emoji:"🛠️"` — edit tanpa hapus',
                    '• `/list-categories` — lihat semua kategori',
                    '• `/remove-category id:jasa` — hapus kategori (default dilindungi)',
                    '💡 v3.9.19: behavior fleksibel — kategori dengan produk → dropdown, kategori tanpa produk → langsung bikin tiket.'
                ].join('\n'),
                inline: false
            },

            {
                name: '💬 Auto-Responder',
                value: [
                    '• `/add-responder` `/list-responder` `/remove-responder`',
                    '💡 Member kirim trigger → bot auto-reply. Cocok untuk FAQ.'
                ].join('\n'),
                inline: false
            },

            {
                name: '🛡️ Anti-Spam & Auto-Mod',
                value: [
                    '• `/set-automod` `/automod-show` `/automod-toggle`',
                    '• `/add-word words:kata1,kata2 action:Mute_10_menit` — tambah kata (append)',
                    '• `/remove-word word:kata` `/list-words` — hapus/lihat kata',
                    '• `/add-word tipe:Exempt_(kata_diizinkan)` — whitelist kata anti false-positive',
                    '• `/add-link-whitelist` `/remove-link-whitelist`',
                    '💡 v3.9.23: action per kata + matching whole-word ("asu" tidak match "asus")'
                ].join('\n'),
                inline: false
            },

            {
                name: '💤 AFK System',
                value: ['• `/afk` `/afk-clear` `/afk-list`', '💡 Bot auto-reply saat user AFK di-mention.'].join('\n'),
                inline: false
            },

            {
                name: '📊 Leveling System',
                value: [
                    '• `/setup-leveling` `/add-level-role` `/list-level-roles` `/remove-level-role`',
                    '• `/rank` `/leaderboard-level` (public)',
                    '💡 XP per message, level up → auto-assign role.'
                ].join('\n'),
                inline: false
            },

            {
                name: '🎭 Atur Role',
                value: [
                    '• `/set-role verified @role` — set role (verified/unverified/admin/**midman**)',
                    '• `/remove-role verified` — hapus role dari config'
                ].join('\n'),
                inline: false
            },

            {
                name: '📢 Atur Channel & Auto-Split Tiket',
                value: [
                    '• `/set-channel welcome #ch` — set (welcome/goodbye/invoice/audit-log/**transcript**)',
                    '• `/remove-channel welcome` — hapus channel dari config',
                    '• `/set-channel transcript #ch` — auto-save transcript tiket sebelum close',
                    '',
                    '**🎫 Auto-Split:** Bot pisah tiket jadi 3 kategori otomatis:',
                    '• **`🎫 TRANSAKSI`** — semua tiket produk: pakai key (🔑 Set Key) ATAU non-key (📦 Kirim Pesanan)',
                    '• **`🎫 BANTUAN`** — tiket kategori tanpa produk (help/report/claim_giveaway)',
                    '• **`🤝 REKBER`** — channel deal escrow middleman (dibuat saat deal rekber dibuka)',
                    'Custom nama? Edit `data/config.json`: `ticketCategoryKey`, `ticketCategoryNoKey`, `midman.category`'
                ].join('\n'),
                inline: false
            },

            {
                name: '✏️ Atur Pesan Embed',
                value: [
                    '• `/set-message ticketBody teks...` (cepat, 1-line)',
                    '• `/edit-message tipe:"Ticket Body"` → buka modal editor multi-line',
                    '• `/reset-message ticketBody` / `/reset-message ALL`',
                    '',
                    '**Template vars:** `{server}` `{price_header}` `{price_list}` `{price_list:cat}` `{categories_list}`'
                ].join('\n'),
                inline: false
            },

            {
                name: '📦 Produk & Auto-Role',
                value: [
                    '• `/add-product` `/remove-product` `/list-products`',
                    '• `/update-product value:vip30 label:"VIP 30 Hari" price:"Rp 30.000"` — edit tanpa hapus',
                    '• `/set-product-role` `/remove-product-role` `/list-product-roles`',
                    '💡 VIP role + auto-expire (days). Bisa campur produk key & non-key (jasa).',
                    '💡 Produk non-key (akun, jasa)? `/add-product ... requires_key:false` → tiket dapat tombol **📦 Kirim Pesanan** (detail dikirim via DM ke pembeli + auto-role + invoice + stats).'
                ].join('\n'),
                inline: false
            },

            {
                name: '🔑 Key Manager',
                value: [
                    '• `/set-key user:@user value:vip30 key:ABCDE-12345`',
                    '• `/list-keys user:@user`',
                    '• `/clear-schedule user:@user clear_keys:true`'
                ].join('\n'),
                inline: false
            },

            {
                name: '🤝 Midman / Rekber (Escrow)',
                value: [
                    '• `/set-role midman @role` — WAJIB di-set dulu sebelum deal bisa dibuka',
                    '• `/set-midman-fee mode:Persen value:5` — fee otomatis per deal (persen / flat, 0 = gratis)',
                    '• `/midman-deals` — lihat semua deal rekber aktif di server',
                    '💡 Deal 3-pihak (pembeli ⇄ penjual + midman pegang dana). Siapa pun bisa buka lewat tombol **🤝 Rekber** di panel — 3 langkah: item & harga → pilih pembeli → pilih penjual, lalu kedua pihak klik **Setuju Deal**.'
                ].join('\n'),
                inline: false
            },

            {
                name: '🎭 Self-Role Panel',
                value: [
                    '• `/setup-selfrole title:... type:button exclusive:false`',
                    '• `/selfrole-add` `/selfrole-remove` `/selfrole-list` `/selfrole-delete`',
                    '💡 `requires_role:@Verified` — conditional role'
                ].join('\n'),
                inline: false
            },

            {
                name: '🎤 Temp Voice',
                value: [
                    '• `/setup-tempvoice` / `/tempvoice-remove`',
                    '💡 Member join trigger channel → otomatis bikin voice pribadi'
                ].join('\n'),
                inline: false
            },

            {
                name: '📢 Announce, Embed & Backup',
                value: [
                    '• `/announce channel:#ch title:... description:...`',
                    '• `/send-message` `/embed-builder` `/embed-list` `/embed-cancel`',
                    '• `/backup-now` `/backup-list` `/restore-backup` (auto 24h, max 7)'
                ].join('\n'),
                inline: false
            },

            {
                name: '🎉 Giveaway & Poll',
                value: [
                    '• `/giveaway create channel:#ch prize:... winners:1 duration:60`',
                    '• `/giveaway list` `/giveaway end` `/giveaway reroll`',
                    '• `/poll create` `/poll list` `/poll close`'
                ].join('\n'),
                inline: false
            },

            {
                name: '⏰ Scheduled Announce & Warn',
                value: [
                    '• `/announce-schedule channel:#ch at:30m recurring?:daily`',
                    '• `/announce-list` `/announce-cancel`',
                    '• `/warn` `/warn-list` `/warn-remove` `/warn-clear` (3=mute1h, 5=mute1d, 7=kick)'
                ].join('\n'),
                inline: false
            },

            {
                name: '📊 Stats & Lainnya',
                value: [
                    '• `/stats` `/leaderboard metric:messages|vipPurchases|totalSpent` `/my-stats`',
                    '• `/set-channel audit-log #ch` — catat admin action',
                    '• `/reset-config` — ⚠️ HAPUS SEMUA setting (konfirmasi 2-step)'
                ].join('\n'),
                inline: false
            }
    ];

    // v3.9.38 FIX: ukur dulu — hanya pecah kalau lewat budget (embed saat ini
    // 5419 → masih 1 embed, tidak ada perubahan perilaku untuk user).
    let firstFields = helpFields;
    const secondFields = [];
    while (firstFields.length > 1 && embedTotalChars(buildHelpEmbed(firstFields)) > HELP_TOTAL_SPLIT_THRESHOLD) {
        // Pindahkan field TERAKHIR ke embed kedua (berulang sampai muat).
        secondFields.unshift(firstFields[firstFields.length - 1]);
        firstFields = firstFields.slice(0, -1);
    }

    if (secondFields.length > 0) {
        // Over budget → kirim 2 embed berurutan dengan visibility sama.
        await interaction.reply({ embeds: [buildHelpEmbed(firstFields)], flags: MessageFlags.Ephemeral });
        return interaction.followUp({ embeds: [buildHelpEmbed(secondFields, '2/2')], flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({ embeds: [buildHelpEmbed(helpFields)], flags: MessageFlags.Ephemeral });
};
