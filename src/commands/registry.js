/**
 * Command Definitions — semua slash command bot (P3-6 refactor).
 *
 * Dipakai oleh index.js saat bot ready untuk register ke Discord.
 * Tujuan: pisahkan definisi command dari logic bot supaya index.js lebih lean.
 */

const { PermissionFlagsBits } = require('discord.js');

function getCommands() {
    return [
        // === HELP ===
        {
            name: 'help',
            description: 'Lihat semua command & cara pakai bot',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === PANEL SETUP ===
        {
            name: 'setup-verify',
            description: 'Pasang panel verifikasi',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'setup-ticket',
            description: 'Pasang panel tiket & price list',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === SET ROLE ===
        {
            name: 'set-role',
            description: 'Atur role (verified / unverified / admin / midman)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Pilih tipe role',
                    required: true,
                    choices: [
                        { name: 'Verified', value: 'verified' },
                        { name: 'Unverified', value: 'unverified' },
                        { name: 'Admin', value: 'admin' },
                        // v3.9.32: role midman/rekber — pegang deal escrow 3-pihak.
                        { name: 'Midman (Rekber)', value: 'midman' }
                    ]
                },
                { type: 8, name: 'role', description: 'Role yang akan dipakai', required: true }
            ]
        },

        // === SET CHANNEL ===
        // v3.9.30: /set-transcript-channel digabung ke sini (tipe: transcript)
        // supaya admin cuma hafal SATU command channel.
        {
            name: 'set-channel',
            description: 'Atur channel (invoice / welcome / goodbye / audit-log / transcript)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Pilih tipe channel',
                    required: true,
                    choices: [
                        { name: 'Invoice', value: 'invoice' },
                        { name: 'Welcome', value: 'welcome' },
                        { name: 'Goodbye', value: 'goodbye' },
                        { name: 'Audit Log (catat admin action)', value: 'audit-log' },
                        { name: 'Transcript Tiket (auto-save saat close)', value: 'transcript' }
                    ]
                },
                { type: 7, name: 'channel', description: 'Channel text yang dipakai', required: true }
            ]
        },

        // === SET PESAN ===
        {
            name: 'set-message',
            description: 'Ubah teks embed welcome / goodbye / verify / ticket',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Pilih pesan yang diubah',
                    required: true,
                    choices: [
                        { name: 'Welcome Title', value: 'welcomeTitle' },
                        { name: 'Welcome Body', value: 'welcomeBody' },
                        { name: 'Goodbye Title', value: 'goodbyeTitle' },
                        { name: 'Goodbye Body', value: 'goodbyeBody' },
                        { name: 'Verify Title', value: 'verifyTitle' },
                        { name: 'Verify Body', value: 'verifyBody' },
                        { name: 'Ticket Title', value: 'ticketTitle' },
                        { name: 'Ticket Body', value: 'ticketBody' },
                        // v3.9.11 Phase 1: ticket price header configurable
                        { name: 'Ticket Price Header', value: 'ticketPriceHeader' }
                    ]
                },
                {
                    type: 3,
                    name: 'teks',
                    description: 'Teks baru (support \\n newline). Pakai {user} {username} {server} {count} {action}',
                    required: true
                }
            ]
        },

        // v3.9.11 Phase 1: verify button configurable
        {
            name: 'set-verify-button',
            description: 'Kustomisasi tombol verifikasi (label, emoji, style)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'label',
                    description: 'Teks tombol (maks 80 char)',
                    required: true,
                    min_length: 1,
                    max_length: 80
                },
                {
                    type: 3,
                    name: 'emoji',
                    description: 'Emoji tombol (unicode atau custom <:name:id>)',
                    required: false
                },
                {
                    type: 3,
                    name: 'style',
                    description: 'Warna tombol',
                    required: false,
                    choices: [
                        { name: '🔵 Primary (Blurple)', value: 'Primary' },
                        { name: '⚪ Secondary (Grey)', value: 'Secondary' },
                        { name: '🟢 Success (Green)', value: 'Success' },
                        { name: '🔴 Danger (Red)', value: 'Danger' }
                    ]
                }
            ]
        },

        // v3.9.11 Phase 2: ticket category management
        {
            name: 'add-category',
            description: 'Tambah kategori tiket baru (untuk panel tiket dinamis)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'id',
                    description: 'ID unik kategori (huruf/angka/_/-, maks 30 char)',
                    required: true,
                    min_length: 1,
                    max_length: 30
                },
                {
                    type: 3,
                    name: 'label',
                    description: 'Label tombol (maks 80 char)',
                    required: true,
                    min_length: 1,
                    max_length: 80
                },
                {
                    type: 3,
                    name: 'emoji',
                    description: 'Emoji tombol (unicode atau custom <:name:id>)',
                    required: false
                },
                {
                    type: 3,
                    name: 'style',
                    description: 'Warna tombol',
                    required: false,
                    choices: [
                        { name: '🔵 Primary (Blurple)', value: 'Primary' },
                        { name: '⚪ Secondary (Grey)', value: 'Secondary' },
                        { name: '🟢 Success (Green)', value: 'Success' },
                        { name: '🔴 Danger (Red)', value: 'Danger' }
                    ]
                },
                {
                    type: 5,
                    name: 'requires_key',
                    description: 'Apakah kategori ini butuh tombol Set Key? (default: true)',
                    required: false
                }
            ]
        },

        {
            name: 'list-categories',
            description: 'Lihat semua kategori tiket yang terdaftar',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        {
            name: 'remove-category',
            description: 'Hapus kategori tiket dari config',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'id', description: 'ID kategori yang akan dihapus', required: true }]
        },

        // v3.9.19: update kategori existing (label/emoji/style/requires_key) tanpa hapus+add
        {
            name: 'update-category',
            description: 'Edit kategori tiket existing (label/emoji/style/requires_key) tanpa hapus+add ulang',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'id',
                    description: 'ID kategori yang akan diupdate',
                    required: true,
                    min_length: 1,
                    max_length: 30
                },
                {
                    type: 3,
                    name: 'label',
                    description: 'Label tombol baru (maks 80 char)',
                    required: false,
                    min_length: 1,
                    max_length: 80
                },
                {
                    type: 3,
                    name: 'emoji',
                    description: 'Emoji tombol baru (unicode atau custom <:name:id>)',
                    required: false
                },
                {
                    type: 3,
                    name: 'style',
                    description: 'Warna tombol baru',
                    required: false,
                    choices: [
                        { name: '🔵 Primary (Blurple)', value: 'Primary' },
                        { name: '⚪ Secondary (Grey)', value: 'Secondary' },
                        { name: '🟢 Success (Green)', value: 'Success' },
                        { name: '🔴 Danger (Red)', value: 'Danger' }
                    ]
                },
                {
                    type: 5,
                    name: 'requires_key',
                    description: 'Apakah kategori ini butuh tombol Set Key?',
                    required: false
                }
            ]
        },

        // v3.9.11 Phase 3: multi-panel ticket (v3.9.14: full customization)
        {
            name: 'setup-ticket-panel',
            description: 'Pasang panel tiket dengan kustomisasi penuh (multi-panel support)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'title',
                    description: 'Judul embed (override global). Kosongkan = pakai config default',
                    required: false
                },
                {
                    type: 3,
                    name: 'categories',
                    description: 'Koma-separated category IDs yang mau ditampilkan (kosongkan = semua)',
                    required: false
                },
                {
                    type: 3,
                    name: 'body',
                    description:
                        'Body custom (override global). Support \\n newline & template {server} {price_list} {categories_list}',
                    required: false
                },
                {
                    type: 3,
                    name: 'color',
                    description: 'Warna hex (mis. #ff5733 atau #fff). Kosongkan = default orange',
                    required: false
                },
                {
                    type: 3,
                    name: 'image',
                    description: 'URL gambar besar (https://...). Kosongkan = no image',
                    required: false
                },
                {
                    type: 3,
                    name: 'thumbnail',
                    description: 'URL thumbnail kecil (https://...). Kosongkan = no thumbnail',
                    required: false
                },
                {
                    type: 3,
                    name: 'footer',
                    description: 'Teks footer. Kosongkan = pakai nama bot',
                    required: false
                },
                {
                    type: 7,
                    name: 'channel',
                    description: 'Channel target (default: channel saat ini). Harus text channel',
                    required: false
                },
                {
                    type: 5,
                    name: 'use_dropdown',
                    description: 'TRUE = pakai dropdown select menu (default: FALSE = buttons)',
                    required: false
                }
            ]
        },

        // v3.9.14: panel management commands
        {
            name: 'list-panels',
            description: 'Lihat semua panel tiket persistent di server ini',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'delete-panel',
            description: 'Hapus panel tiket by ID (auto delete message + metadata)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'id', description: 'Panel ID (lihat /list-panels)', required: true }]
        },
        {
            name: 'refresh-panel',
            description: 'Re-render panel dengan kategori/produk terbaru (tanpa setup ulang)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'id', description: 'Panel ID (lihat /list-panels)', required: true }]
        },
        {
            name: 'update-panel',
            description: 'Edit field panel (title/body/color/image/thumbnail/footer) via modal',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 3, name: 'id', description: 'Panel ID (lihat /list-panels)', required: true },
                {
                    type: 3,
                    name: 'field',
                    description: 'Field yang mau diedit',
                    required: true,
                    choices: [
                        { name: 'Title (judul)', value: 'title' },
                        { name: 'Body (isi, dukung template)', value: 'body' },
                        { name: 'Color (warna hex)', value: 'color' },
                        { name: 'Image (URL gambar besar)', value: 'image' },
                        { name: 'Thumbnail (URL gambar kecil)', value: 'thumbnail' },
                        { name: 'Footer (teks footer)', value: 'footer' }
                    ]
                }
            ]
        },

        // v3.9.12: /edit-message — modal editor untuk message config (multi-line, lebih flexible)
        {
            name: 'edit-message',
            description: 'Edit teks pesan embed via modal (multi-line, lebih flexible dari /set-message)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Pilih pesan yang akan diedit',
                    required: true,
                    choices: [
                        { name: 'Welcome Title', value: 'welcomeTitle' },
                        { name: 'Welcome Body', value: 'welcomeBody' },
                        { name: 'Goodbye Title', value: 'goodbyeTitle' },
                        { name: 'Goodbye Body', value: 'goodbyeBody' },
                        { name: 'Verify Title', value: 'verifyTitle' },
                        { name: 'Verify Body', value: 'verifyBody' },
                        { name: 'Ticket Title', value: 'ticketTitle' },
                        { name: 'Ticket Body', value: 'ticketBody' },
                        { name: 'Ticket Price Header', value: 'ticketPriceHeader' }
                    ]
                }
            ]
        },

        // === MANAJEMEN PRODUK ===
        {
            name: 'add-product',
            description: 'Tambah produk baru ke price list',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'label',
                    description: 'Nama produk (mis. 7 Days, maks 80 char)',
                    required: true,
                    max_length: 80
                },
                { type: 3, name: 'value', description: 'ID unik (mis. 7d)', required: true },
                {
                    type: 3,
                    name: 'price',
                    description: 'Harga (mis. Rp. 50.000, maks 100 char)',
                    required: true,
                    max_length: 100
                },
                {
                    type: 3,
                    name: 'duration',
                    description: 'Opsional. Keterangan durasi (mis. 7 Hari). Kosong = pakai label.',
                    required: false
                },
                // v3.9.11 Phase 2: category & requires_key
                {
                    type: 3,
                    name: 'category',
                    description: 'Kategori produk (default: transaction). Lihat /list-categories untuk daftar.',
                    required: false
                },
                {
                    type: 5,
                    name: 'requires_key',
                    description: 'Apakah produk ini butuh Set Key? (default: true untuk kategori key)',
                    required: false
                }
            ]
        },
        {
            name: 'remove-product',
            description: 'Hapus produk dari price list',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 3, name: 'value', description: 'Value produk yang ingin dihapus (mis. 7d)', required: true }
            ]
        },
        {
            name: 'list-products',
            description: 'Lihat semua produk saat ini',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // v3.9.19: update produk existing tanpa hapus+add ulang
        // value TIDAK bisa diubah (dipakai sebagai customId di modal_set_key).
        {
            name: 'update-product',
            description: 'Edit produk existing (label/price/duration/category/requires_key) tanpa hapus+add ulang',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'value',
                    description: 'Value produk yang akan diupdate (identifier — tidak berubah)',
                    required: true,
                    min_length: 1,
                    max_length: 50
                },
                {
                    type: 3,
                    name: 'label',
                    description: 'Label produk baru (maks 80 char)',
                    required: false,
                    min_length: 1,
                    max_length: 80
                },
                {
                    type: 3,
                    name: 'price',
                    description: 'Harga baru (mis. "Rp 25.000")',
                    required: false,
                    min_length: 1,
                    max_length: 100
                },
                {
                    type: 3,
                    name: 'duration',
                    description: 'Durasi baru (kosongkan string untuk hapus duration)',
                    required: false,
                    max_length: 100
                },
                {
                    type: 3,
                    name: 'category',
                    description: 'Kategori baru (lihat /list-categories)',
                    required: false,
                    min_length: 1,
                    max_length: 30
                },
                {
                    type: 5,
                    name: 'requires_key',
                    description: 'Apakah produk ini butuh Set Key? (true=key, false=jasa/non-key)',
                    required: false
                }
            ]
        },

        // === CONFIG SHOW ===
        {
            name: 'config-show',
            description: 'Lihat semua konfigurasi bot saat ini',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === REMOVE ROLE (hapus role dari config) ===
        {
            name: 'remove-role',
            description: 'Hapus role dari config (verified / unverified / admin)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Pilih tipe role yang dihapus',
                    required: true,
                    choices: [
                        { name: 'Verified', value: 'verified' },
                        { name: 'Unverified', value: 'unverified' },
                        { name: 'Admin', value: 'admin' },
                        // v3.9.32: hapus role midman dari config.
                        { name: 'Midman (Rekber)', value: 'midman' }
                    ]
                }
            ]
        },

        // === MIDMAN / REKBER (v3.9.32) ===
        {
            name: 'set-midman-fee',
            description: 'Atur fee rekber (persen harga deal atau nominal flat)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'mode',
                    description: 'Mode perhitungan fee',
                    required: true,
                    choices: [
                        { name: 'Persen (%) dari harga deal', value: 'percent' },
                        { name: 'Nominal flat (Rp per deal)', value: 'flat' }
                    ]
                },
                {
                    type: 10,
                    name: 'value',
                    description: 'Nilai fee (persen: 0-90, flat: nominal Rp). 0 = gratis',
                    required: true,
                    minValue: 0
                }
            ]
        },
        {
            name: 'midman-deals',
            description: 'Lihat semua deal rekber aktif di server',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === REMOVE CHANNEL (hapus channel dari config) ===
        {
            name: 'remove-channel',
            description: 'Hapus channel dari config (invoice / welcome / goodbye / audit-log / transcript)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Pilih tipe channel yang dihapus',
                    required: true,
                    choices: [
                        { name: 'Invoice', value: 'invoice' },
                        { name: 'Welcome', value: 'welcome' },
                        { name: 'Goodbye', value: 'goodbye' },
                        { name: 'Audit Log', value: 'audit-log' },
                        { name: 'Transcript Tiket', value: 'transcript' }
                    ]
                }
            ]
        },

        // === LIST MESSAGES (lihat semua teks pesan) ===
        {
            name: 'list-messages',
            description: 'Lihat semua teks pesan embed saat ini',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === RESET MESSAGE (kembalikan pesan ke default) ===
        {
            name: 'reset-message',
            description: 'Reset teks pesan embed kembali ke default',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Pilih pesan yang direset (atau ALL untuk semua)',
                    required: true,
                    choices: [
                        { name: 'Welcome Title', value: 'welcomeTitle' },
                        { name: 'Welcome Body', value: 'welcomeBody' },
                        { name: 'Goodbye Title', value: 'goodbyeTitle' },
                        { name: 'Goodbye Body', value: 'goodbyeBody' },
                        { name: 'Verify Title', value: 'verifyTitle' },
                        { name: 'Verify Body', value: 'verifyBody' },
                        { name: 'Ticket Title', value: 'ticketTitle' },
                        { name: 'Ticket Body', value: 'ticketBody' },
                        { name: '⚡ Reset SEMUA', value: 'ALL' }
                    ]
                }
            ]
        },

        // === RESET CONFIG (reset semua setting ke kondisi kosong) ===
        {
            name: 'reset-config',
            description: '⚠️ Hapus SEMUA setting (role, channel, pesan) - tidak bisa di-undo!',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === AUTO-ROLE PRODUCT (VIP role per produk) ===
        {
            name: 'set-product-role',
            description: 'Set role & durasi auto-expire untuk produk tertentu',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 3, name: 'value', description: 'Value produk (mis. 30d)', required: true },
                { type: 8, name: 'role', description: 'Role yang akan diberikan saat pembeli sukses', required: true },
                {
                    type: 4,
                    name: 'days',
                    description: 'Durasi hari sebelum role otomatis dihapus (0 = permanen)',
                    required: true
                }
            ]
        },
        {
            name: 'remove-product-role',
            description: 'Hapus auto-role dari produk tertentu',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'value', description: 'Value produk (mis. 30d)', required: true }]
        },
        {
            name: 'list-product-roles',
            description: 'Lihat semua mapping produk → role + durasi',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === KEY MANAGER (model key-driven) ===
        {
            name: 'set-key',
            description: 'Beri key ke user + grant role + extend schedule (MAX EXTEND)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 6, name: 'user', description: 'User penerima key', required: true },
                { type: 3, name: 'value', description: 'Value produk (mis. 30d)', required: true },
                {
                    type: 3,
                    name: 'key',
                    description: 'Key yang akan dikirim ke user (maks 200 char)',
                    required: true,
                    max_length: 200
                }
            ]
        },
        {
            name: 'list-keys',
            description: 'Lihat semua key (aktif & expired) milik user',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 6, name: 'user', description: 'User yang ingin dilihat key-nya', required: true }]
        },
        {
            name: 'clear-schedule',
            description: 'Hapus semua schedule role user (+ opsional hapus semua key & lepas role VIP)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 6, name: 'user', description: 'User yang di-clear', required: true },
                {
                    type: 5,
                    name: 'clear_keys',
                    description: 'True = hapus SEMUA key user + lepas role VIP (full reset). Default: false.',
                    required: false
                }
            ]
        },

        // === SELF-ROLE FLEKSIBEL ===
        {
            name: 'setup-selfrole',
            description: 'Buat panel self-role baru (member bisa ambil/lepas role sendiri)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 3, name: 'title', description: 'Judul panel (mis. Pilih Role Notif)', required: true },
                { type: 3, name: 'description', description: 'Deskripsi panel (support \\n newline)', required: true },
                {
                    type: 3,
                    name: 'type',
                    description: 'Tipe UI panel',
                    required: true,
                    choices: [
                        { name: 'Button (≤25 role, klik toggle)', value: 'button' },
                        { name: 'Select Menu (dropdown, ≤25 role)', value: 'select' }
                    ]
                },
                {
                    type: 5,
                    name: 'exclusive',
                    description: 'True = hanya boleh 1 role pada satu waktu (mis. color role). Default false.',
                    required: false
                }
            ]
        },
        {
            name: 'selfrole-add',
            description: 'Tambah role ke panel self-role yang sudah ada',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'panel_id',
                    description: 'Panel ID (lihat di /selfrole-list atau footer panel)',
                    required: true
                },
                { type: 8, name: 'role', description: 'Role yang akan ditambahkan ke panel', required: true },
                { type: 3, name: 'label', description: 'Label tombol / option (maks 80 char)', required: true },
                { type: 3, name: 'emoji', description: 'Emoji (opsional, mis. 🔔)', required: false },
                {
                    type: 3,
                    name: 'description',
                    description: 'Deskripsi (opsional, select menu, support \\n newline)',
                    required: false
                },
                // v3.9.11 Phase 3: per-role button style
                {
                    type: 3,
                    name: 'style',
                    description: 'Warna tombol (default: Secondary)',
                    required: false,
                    choices: [
                        { name: '🔵 Primary (Blurple)', value: 'Primary' },
                        { name: '⚪ Secondary (Grey)', value: 'Secondary' },
                        { name: '🟢 Success (Green)', value: 'Success' },
                        { name: '🔴 Danger (Red)', value: 'Danger' }
                    ]
                },
                // v3.9.11 Phase 3: conditional role (requiresRoleId)
                {
                    type: 8,
                    name: 'requires_role',
                    description: 'Role yang harus dimiliki user sebelum bisa ambil role ini (opsional)',
                    required: false
                }
            ]
        },
        {
            name: 'selfrole-remove',
            description: 'Hapus role dari panel self-role',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 3, name: 'panel_id', description: 'Panel ID', required: true },
                { type: 8, name: 'role', description: 'Role yang akan dihapus dari panel', required: true }
            ]
        },
        {
            name: 'selfrole-list',
            description: 'Lihat semua panel self-role di guild ini',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'selfrole-delete',
            description: 'Hapus panel self-role (hapus pesan + config)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'panel_id', description: 'Panel ID yang akan dihapus', required: true }]
        },

        // === ANNOUNCE & EMBED BUILDER ===
        {
            name: 'announce',
            description: 'Quick announce — kirim embed ke channel (1 command, 1 embed)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 7, name: 'channel', description: 'Channel tujuan announce', required: true },
                { type: 3, name: 'title', description: 'Judul announce', required: true },
                { type: 3, name: 'description', description: 'Isi announce (support newline \\n)', required: true },
                { type: 3, name: 'color', description: 'Warna hex (mis. #FF0000). Default: blurple', required: false },
                { type: 3, name: 'image', description: 'URL gambar besar (opsional)', required: false },
                { type: 3, name: 'thumbnail', description: 'URL gambar kecil pojok (opsional)', required: false },
                {
                    type: 3,
                    name: 'mention',
                    description: 'Mention: @everyone, @here, atau <@&role_id>',
                    required: false
                }
            ]
        },
        {
            name: 'embed-builder',
            description: 'Interactive embed builder dengan live preview (untuk embed kompleks)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'embed-list',
            description: 'Lihat semua session embed builder aktif kamu (+ link ke draft message)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'embed-cancel',
            description: 'Batalkan session embed builder berdasarkan ID (jika draft kehapus/bug)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'session_id', description: 'Session ID (lihat di /embed-list)', required: true }]
        },

        // === BACKUP SYSTEM ===
        {
            name: 'backup-now',
            description: 'Buat backup manual sekarang (config, keys, scheduledRoles, selfRoles, dll)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'backup-list',
            description: 'Lihat semua backup yang tersimpan (maks 7 terbaru)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'restore-backup',
            description: 'Restore backup berdasarkan nama (auto-buat safety backup sebelum restore)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'name',
                    description: 'Nama folder backup (lihat /backup-list, format: YYYY-MM-DD_HH-mm-ss)',
                    required: true
                }
            ]
        },

        // === GIVEAWAY SYSTEM ===
        {
            name: 'giveaway',
            description: 'Kelola giveaway komunitas (create, list, end, reroll)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 1,
                    name: 'create',
                    description: 'Buat giveaway baru',
                    required: false,
                    options: [
                        { type: 7, name: 'channel', description: 'Channel untuk giveaway', required: true },
                        {
                            type: 3,
                            name: 'prize',
                            description: 'Hadiah (mis. VIP 30 Hari, maks 200 char)',
                            required: true,
                            max_length: 200
                        },
                        { type: 4, name: 'duration', description: 'Durasi dalam menit (min 1)', required: true },
                        { type: 4, name: 'winners', description: 'Jumlah pemenang (1-20, default 1)', required: false },
                        {
                            type: 8,
                            name: 'required_role',
                            description: 'Role yang wajib dimiliki peserta (opsional)',
                            required: false
                        }
                    ]
                },
                {
                    type: 1,
                    name: 'list',
                    description: 'Lihat semua giveaway di guild ini',
                    required: false
                },
                {
                    type: 1,
                    name: 'end',
                    description: 'Akhiri giveaway lebih awal + pick winners',
                    required: false,
                    options: [
                        { type: 3, name: 'id', description: 'Giveaway ID (lihat /giveaway list)', required: true }
                    ]
                },
                {
                    type: 1,
                    name: 'reroll',
                    description: 'Reroll winner giveaway yang sudah berakhir',
                    required: false,
                    options: [
                        { type: 3, name: 'id', description: 'Giveaway ID (lihat /giveaway list)', required: true }
                    ]
                }
            ]
        },

        // === SCHEDULED ANNOUNCEMENTS ===
        {
            name: 'announce-schedule',
            description: 'Jadwalkan announce ke channel pada waktu tertentu (one-shot atau recurring)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 7, name: 'channel', description: 'Channel tujuan', required: true },
                { type: 3, name: 'title', description: 'Judul announce', required: true },
                {
                    type: 3,
                    name: 'description',
                    description: 'Isi announce (support \\n untuk newline)',
                    required: true
                },
                {
                    type: 3,
                    name: 'at',
                    description: 'Waktu kirim. Format: "30m", "2h", "1d", atau "2026-01-15 20:00"',
                    required: true
                },
                { type: 3, name: 'color', description: 'Warna hex (mis. #FF0000). Default: blurple', required: false },
                { type: 3, name: 'image', description: 'URL gambar besar (opsional)', required: false },
                { type: 3, name: 'thumbnail', description: 'URL gambar kecil pojok (opsional)', required: false },
                {
                    type: 3,
                    name: 'mention',
                    description: 'Mention: @everyone, @here, atau <@&role_id>',
                    required: false
                },
                {
                    type: 3,
                    name: 'recurring',
                    description: 'Ulangi (opsional)',
                    required: false,
                    choices: [
                        { name: 'Daily (tiap hari)', value: 'daily' },
                        { name: 'Weekly (tiap minggu)', value: 'weekly' },
                        { name: 'Monthly (tiap bulan)', value: 'monthly' }
                    ]
                }
            ]
        },
        {
            name: 'announce-list',
            description: 'Lihat semua announce terjadwal yang pending',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'announce-cancel',
            description: 'Batalkan announce terjadwal berdasarkan ID',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'id', description: 'Announce ID (lihat di /announce-list)', required: true }]
        },

        // === WARN SYSTEM ===
        // P2-3 FIX: defaultMemberPermissions disamakan dengan isAdmin check (ManageGuild).
        // Sebelumnya: ModerateMembers → moderator bisa lihat command tapi ditolak saat dijalankan.
        {
            name: 'warn',
            description: 'Beri warning ke member (auto-action: 3=mute 1h, 5=mute 1d, 7=kick)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 6, name: 'user', description: 'Member yang diwarn', required: true },
                { type: 3, name: 'reason', description: 'Alasan warning (support \\n newline)', required: true }
            ]
        },
        {
            name: 'warn-list',
            description: 'Lihat semua warning milik user',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 6, name: 'user', description: 'User yang ingin dicek', required: true }]
        },
        {
            name: 'warn-remove',
            description: 'Hapus 1 warning berdasarkan ID',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 6, name: 'user', description: 'User pemilik warning', required: true },
                { type: 3, name: 'warn_id', description: 'Warn ID (lihat di /warn-list)', required: true }
            ]
        },
        {
            name: 'warn-clear',
            description: 'Hapus SEMUA warning milik user',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 6, name: 'user', description: 'User yang ingin di-clear warn-nya', required: true }]
        },

        // === STATS & LEADERBOARD ===
        {
            name: 'stats',
            description: 'Lihat statistik agregat server (admin only)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'leaderboard',
            description: 'Lihat top 10 member (public — boleh dipakai member biasa)',
            options: [
                {
                    type: 3,
                    name: 'metric',
                    description: 'Metric leaderboard',
                    required: false,
                    choices: [
                        { name: '💬 Pesan Terbanyak', value: 'messages' },
                        { name: '🛒 Top Buyer (transaksi)', value: 'vipPurchases' },
                        { name: '💰 Top Spender (belanja)', value: 'totalSpent' },
                        { name: '🎉 Top Winner (giveaway)', value: 'giveawaysWon' }
                    ]
                }
            ]
        },
        {
            name: 'my-stats',
            description: 'Lihat statistik pribadi kamu (public — boleh dipakai member biasa)'
        },

        // === POLL SYSTEM ===
        {
            name: 'poll',
            description: 'Kelola poll komunitas (create, list, close)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 1,
                    name: 'create',
                    description: 'Buat poll baru (modal input untuk options)',
                    required: false,
                    options: [
                        {
                            type: 7,
                            name: 'channel',
                            description: 'Channel untuk poll',
                            required: true,
                            // v3.9.26: restrict ke text/announcement — tanpa ini admin
                            // bisa pilih voice/category → channel.send gagal di modal
                            // handler dengan pesan error yang menyesatkan.
                            channel_types: [0, 5]
                        },
                        {
                            type: 3,
                            name: 'question',
                            description: 'Pertanyaan poll (maks 250 char)',
                            required: true,
                            max_length: 250
                        },
                        {
                            type: 5,
                            name: 'multiple',
                            description: 'True = member boleh pilih banyak. Default false (single)',
                            required: false
                        }
                    ]
                },
                {
                    type: 1,
                    name: 'list',
                    description: 'Lihat semua poll di guild ini',
                    required: false
                },
                {
                    type: 1,
                    name: 'close',
                    description: 'Tutup poll + tampilkan hasil akhir',
                    required: false,
                    options: [{ type: 3, name: 'id', description: 'Poll ID (lihat di /poll list)', required: true }]
                }
            ]
        },

        // === TEMP VOICE ===
        // v3.8.2: /setup-tempvoice tanpa parameter — bot auto-create kategori
        // berisi text channel (untuk panel) + voice channel (untuk trigger).
        {
            name: 'setup-tempvoice',
            description: 'Setup temp voice — auto buat kategori + channel panel + channel trigger',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'tempvoice-remove',
            description: 'Hapus setup temp voice dari guild (kategori + semua channel terkait dihapus)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === SEND MESSAGE (plain text ke channel) ===
        // v3.9.5: pelengkap /announce (yang kirim embed). /send-message kirim
        // plain text biasa — cocok untuk pengumuman kasual, chat bot, atau
        // teks yang tidak perlu styling embed.
        {
            name: 'send-message',
            description: 'Kirim plain text message ke text channel (support \\n & mention)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 7, name: 'channel', description: 'Channel tujuan (harus text channel)', required: true },
                {
                    type: 3,
                    name: 'message',
                    description: 'Isi pesan (support \\n untuk newline). Maks 2000 char.',
                    required: true
                },
                {
                    type: 3,
                    name: 'mention',
                    description: 'Mention: @everyone, @here, atau <@&role_id> / <@user_id>',
                    required: false
                }
            ]
        },

        // === v3.9.13: AUTO-RESPONDER ===
        {
            name: 'add-responder',
            description: 'Tambah auto-responder: trigger keyword → auto reply',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'trigger',
                    description: 'Keyword trigger (mis. !sosmed). Case-insensitive, maks 50 char.',
                    required: true,
                    min_length: 1,
                    max_length: 50
                },
                {
                    type: 3,
                    name: 'reply',
                    description: 'Teks reply (support \\n). Maks 2000 char.',
                    required: true,
                    min_length: 1,
                    max_length: 2000
                },
                {
                    type: 3,
                    name: 'reply_type',
                    description: 'Tipe reply (default: text)',
                    required: false,
                    choices: [
                        { name: 'Plain text', value: 'text' },
                        { name: 'Embed', value: 'embed' }
                    ]
                },
                {
                    type: 4,
                    name: 'cooldown',
                    description: 'Cooldown dalam detik (anti-spam, default: 3, 0 = matiin)',
                    required: false,
                    min_value: 0
                }
            ]
        },
        {
            name: 'list-responder',
            description: 'Lihat semua auto-responder terdaftar',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'remove-responder',
            description: 'Hapus auto-responder berdasarkan trigger',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 3, name: 'trigger', description: 'Trigger yang akan dihapus', required: true }]
        },

        // === v3.9.13: ANTI-SPAM & AUTO-MOD ===
        {
            name: 'set-automod',
            description: 'Konfigurasi auto-mod (spam, link, word filter, mention limit)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 4,
                    name: 'spam_threshold',
                    description: 'Jumlah pesan dalam window = spam (default: 5)',
                    required: false,
                    min_value: 1
                },
                {
                    type: 3,
                    name: 'spam_action',
                    description: 'Action untuk spammer',
                    required: false,
                    choices: [
                        { name: 'Delete only', value: 'delete_only' },
                        { name: 'Warn', value: 'warn' },
                        { name: 'Mute 10 menit', value: 'mute_10m' },
                        { name: 'Mute 1 jam', value: 'mute_1h' },
                        { name: 'Kick', value: 'kick' }
                    ]
                },
                { type: 5, name: 'block_links', description: 'Block semua link?', required: false },
                {
                    type: 3,
                    name: 'block_words',
                    description: 'Kata yang di-block (comma-separated, mis. kata1,kata2)',
                    required: false
                },
                {
                    type: 3,
                    name: 'word_action',
                    description: 'Action untuk word filter',
                    required: false,
                    choices: [
                        { name: 'Delete only', value: 'delete_only' },
                        { name: 'Warn', value: 'warn' },
                        { name: 'Mute 10 menit', value: 'mute_10m' }
                    ]
                },
                {
                    type: 4,
                    name: 'max_mentions',
                    description: 'Max mention per message (default: 5)',
                    required: false,
                    min_value: 0
                },
                {
                    type: 3,
                    name: 'mention_action',
                    description: 'Action untuk mass-mention',
                    required: false,
                    choices: [
                        { name: 'Delete only', value: 'delete_only' },
                        { name: 'Warn', value: 'warn' },
                        { name: 'Mute 10 menit', value: 'mute_10m' }
                    ]
                }
            ]
        },
        {
            name: 'automod-show',
            description: 'Lihat konfigurasi auto-mod saat ini',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'automod-toggle',
            description: 'Enable/disable auto-mod',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 5, name: 'enabled', description: 'Enable atau disable?', required: true }]
        },
        {
            name: 'add-link-whitelist',
            description: 'Tambah channel/role ke whitelist link (boleh post link)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 7, name: 'channel', description: 'Channel yang boleh post link', required: false },
                { type: 8, name: 'role', description: 'Role yang boleh post link', required: false }
            ]
        },

        // === v3.9.23: AUTOMOD WORD FLEX ===
        {
            name: 'add-word',
            description: 'Tambah kata ke blocklist/exempt auto-mod (append, tidak replace)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                {
                    type: 3,
                    name: 'words',
                    description: 'Kata yang mau ditambah (comma-separated, mis. kata1,kata2)',
                    required: true,
                    max_length: 500
                },
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Tambah ke daftar mana?',
                    required: false,
                    choices: [
                        { name: 'Blocklist (kata di-block)', value: 'blocklist' },
                        { name: 'Exempt (kata diizinkan)', value: 'exempt' }
                    ]
                },
                {
                    type: 3,
                    name: 'action',
                    description: 'Action khusus kata ini (kosong = pakai word_action global)',
                    required: false,
                    choices: [
                        { name: 'Delete only', value: 'delete_only' },
                        { name: 'Warn', value: 'warn' },
                        { name: 'Mute 10 menit', value: 'mute_10m' },
                        { name: 'Mute 1 jam', value: 'mute_1h' },
                        { name: 'Kick', value: 'kick' }
                    ]
                }
            ]
        },
        {
            name: 'remove-word',
            description: 'Hapus 1 kata dari blocklist/exempt auto-mod',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 3, name: 'word', description: 'Kata yang mau dihapus', required: true, max_length: 100 },
                {
                    type: 3,
                    name: 'tipe',
                    description: 'Hapus dari daftar mana?',
                    required: false,
                    choices: [
                        { name: 'Blocklist (kata di-block)', value: 'blocklist' },
                        { name: 'Exempt (kata diizinkan)', value: 'exempt' }
                    ]
                }
            ]
        },
        {
            name: 'list-words',
            description: 'Lihat daftar kata blocklist + exempt + action per kata',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'remove-link-whitelist',
            description: 'Hapus channel/role dari whitelist link',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 7, name: 'channel', description: 'Channel yang dihapus dari whitelist', required: false },
                { type: 8, name: 'role', description: 'Role yang dihapus dari whitelist', required: false }
            ]
        },

        // === v3.9.13: AFK SYSTEM ===
        {
            name: 'afk',
            description: 'Set status AFK (bot auto-reply saat di-mention)',
            options: [
                // v3.9.17: tambah max_length supaya reason tidak overflow reply.
                // Sebelumnya, default Discord max 6000 char bisa bikin AFK reply
                // (yang gabung multiple mentions) exceed 2000 char limit → gagal kirim.
                {
                    type: 3,
                    name: 'reason',
                    description: 'Alasan AFK (support \\n, mis. "Makan dulu, 30 menit")',
                    required: false,
                    max_length: 200
                }
            ]
        },
        {
            name: 'afk-clear',
            description: 'Clear status AFK kamu'
        },
        {
            name: 'afk-list',
            description: 'Lihat semua member yang sedang AFK',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },

        // === v3.9.13: LEVELING SYSTEM ===
        {
            name: 'setup-leveling',
            description: 'Enable/disable leveling system + config XP',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 5, name: 'enabled', description: 'Enable atau disable leveling?', required: true },
                {
                    type: 4,
                    name: 'xp_per_message',
                    description: 'XP per message (default: 15)',
                    required: false,
                    min_value: 1,
                    max_value: 1000
                },
                {
                    type: 4,
                    name: 'cooldown',
                    description: 'Cooldown dalam detik (default: 60)',
                    required: false,
                    min_value: 0,
                    max_value: 3600
                },
                {
                    type: 5,
                    name: 'announce_levelup',
                    description: 'Announce saat user level up? (default: true)',
                    required: false
                }
            ]
        },
        {
            name: 'add-level-role',
            description: 'Tambah role reward untuk level tertentu (auto-assign saat cap level)',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [
                { type: 4, name: 'level', description: 'Level yang harus dicap (mis. 10)', required: true },
                { type: 8, name: 'role', description: 'Role yang akan di-assign', required: true }
            ]
        },
        {
            name: 'list-level-roles',
            description: 'Lihat semua level role reward',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild
        },
        {
            name: 'remove-level-role',
            description: 'Hapus role reward untuk level tertentu',
            defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
            options: [{ type: 4, name: 'level', description: 'Level yang akan dihapus role-nya', required: true }]
        },
        {
            name: 'rank',
            description: 'Lihat level & XP kamu (atau user lain)',
            options: [{ type: 6, name: 'user', description: 'User yang ingin dicek (default: kamu)', required: false }]
        },
        {
            name: 'leaderboard-level',
            description: 'Top 10 member dengan level tertinggi (public)'
        }
    ];
}

module.exports = { getCommands };
