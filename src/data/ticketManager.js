const {
    ChannelType,
    PermissionFlagsBits,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder
} = require('discord.js');
const { getConfig } = require('./configManager');
// v3.9.32: cek deal rekber aktif — user yang masih terlibat deal escrow tidak
// boleh buka tiket reguler (anti-bypass alur rekber lewat tiket biasa).
const { hasActiveDealFor } = require('./midmanManager');
const { safeEditReply } = require('../infra/safeReply');
const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

// P2-2 FIX: per-user lock supaya tidak bisa buka 2 tiket bersamaan (race condition).
// Sebelumnya: 2 klik tombol <100ms → kedua interaction lolos check existing ticket
// (channel belum dibuat) → 2 tiket terbuat. Sekarang: lock per userId sampai selesai.
//
// v3.9.8 FIX: lock di-scope per `${guildId}:${userId}`. Sebelumnya key cuma `userId`,
// jadi user yang ada di 2 guild bot gak bisa bikin ticket barengan di kedua guild.
const ticketLocks = new Map();

// FIX v3.7.1: per-channel close lock — cegah double-close race condition.
// Skenario: admin klik "Tutup Tiket" → network lambat → admin klik lagi →
// 2 closeTicket jalan bersamaan → salah satunya dapat "Unknown Channel".
// Lock ini memastikan hanya 1 closeTicket per channel pada satu waktu.
const closeTicketLocks = new Set();

// === v3.9.1: tickets.json — persistent ticket metadata ===
// Sebelumnya, metadata tiket (userId, productName, price) disimpan di channel
// topic dengan format "Ticket UserID: 123 | Product: Foo | Price: Rp 50.000".
// Masalah:
//   1. Channel topic bisa di-edit admin → metadata bisa rusak / dispoof.
//   2. Channel topic dibatasi 1024 char, bisa ter-truncate kalau nama produk panjang.
//   3. Parsing regex rentan false-positive kalau nama produk mengandung " | ".
//
// Sekarang: metadata utama ada di tickets.json (keyed by channelId). Channel
// topic tetap di-set untuk human-readable info, tapi tidak dipakai sebagai
// sumber kebenaran. Backward compat: kalau channelId tidak ada di tickets.json,
// fallback ke topic parsing (untuk tiket lama yang dibuat sebelum v3.9.1).
const ticketsPath = path.join(__dirname, '..', '..', 'data', 'tickets.json');

function loadTickets() {
    try {
        if (!fs.existsSync(ticketsPath)) return {};
        return JSON.parse(fs.readFileSync(ticketsPath, 'utf8'));
    } catch (err) {
        console.warn('⚠️ tickets.json rusak:', err.message);
        // v3.9.26: karantina file korup sebelum fallback (lihat safeWrite.js).
        quarantineCorruptFile(ticketsPath);
        return {};
    }
}

function saveTickets(data) {
    safeWriteJSON(ticketsPath, data);
}

/**
 * v3.9.27: Klasifikasi tipe tiket dari metadata — SATU sumber kebenaran.
 *
 * SEBELUMNYA (bug v3.9.16–v3.9.26): handler close & invoice memakai
 * `meta.requiresKey` sebagai proxy "ini transaksi?". Akibatnya produk NON-KEY
 * (jual akun ML, jasa, dll — requiresKey=false) dianggap tiket bantuan:
 *   - tombol close pakai gaya help (tidak ada "Pesanan Sukses")
 *   - invoice/testimoni tidak pernah dikirim
 *   - stats pembelian tidak tercatat
 *
 * SEKARANG: `isTransaction` (tiket jual-beli?) dan `requiresKey` (produk
 * pakai key?) adalah dua konsep TERPISAH:
 *   - Transaksi + requiresKey=true  → tombol 🔑 Set Key (key products)
 *   - Transaksi + requiresKey=false → tombol 📦 Kirim Pesanan (akun/jasa)
 *   - Bantuan (help/report/custom tanpa produk) → tanpa tombol khusus
 *
 * Prioritas sumber:
 *   1. meta.isTransaction eksplisit (tiket dibuat v3.9.27+)
 *   2. meta.requiresKey (tiket legacy v3.9.16–26 — perilaku lama dipertahankan
 *      supaya tidak ada regresi; tiket lama akan tertutup seiring waktu)
 *   3. Kategori + magic-string (tiket purba pre-v3.9.11, tanpa requiresKey)
 *
 * @param {Object|null} meta - metadata tiket dari tickets.json
 * @returns {{isTransaction: boolean, requiresKey: boolean, isCompleted: boolean}}
 */
function resolveTicketType(meta) {
    if (!meta) return { isTransaction: false, requiresKey: false, isCompleted: false };

    const isCompleted = meta.isCompleted === true;

    let isTransaction;
    if (meta.isTransaction !== undefined && meta.isTransaction !== null) {
        // v3.9.27+: flag eksplisit — sumber kebenaran.
        isTransaction = meta.isTransaction === true;
    } else if (meta.requiresKey !== undefined && meta.requiresKey !== null) {
        // Legacy v3.9.16–26: requiresKey dipakai sebagai proxy (bug lama
        // dipertahankan untuk tiket yang masih terbuka — no regression).
        isTransaction = meta.requiresKey === true;
    } else {
        // Tiket purba (pre-v3.9.11): fallback kategori + magic-string.
        isTransaction = !(
            meta.category === 'help' ||
            meta.category === 'report' ||
            meta.productName === 'Bantuan Staff' ||
            meta.productName === 'Laporkan Member' ||
            meta.productName === 'Bantuan/Lapor'
        );
    }

    const requiresKey = meta.requiresKey !== undefined && meta.requiresKey !== null ? meta.requiresKey : isTransaction;

    return { isTransaction, requiresKey, isCompleted };
}

/**
 * Simpan metadata tiket baru.
 * @param {string} channelId
 * @param {Object} meta - { userId, productName, price, guildId, createdAt, category?, requiresKey?, deliveryFields? }
 */
function setTicketMeta(channelId, meta) {
    const all = loadTickets();
    all[channelId] = {
        userId: meta.userId,
        productName: meta.productName,
        // v3.9.38 FIX (FIX 3): productValue = ID stabil produk (rename-proof).
        // null untuk tiket lama / produk sintetis kategori tanpa produk.
        productValue: meta.productValue || null,
        price: meta.price,
        guildId: meta.guildId,
        createdAt: meta.createdAt || Date.now(),
        // v3.9.11 Phase 2: simpan category untuk dispatch di interaction handler.
        category: meta.category || null,
        // v3.9.11 Phase 2: requiresKey flag (kalau true, ticket tampilkan tombol Set Key).
        requiresKey: meta.requiresKey !== undefined ? meta.requiresKey : null,
        // v3.9.11 Phase 3: deliveryFields — data yang user isi di modal form.
        deliveryFields: meta.deliveryFields || null,
        // v3.9.20: flag bahwa Set Key sudah dilakukan. Dipakai di ticket_close
        // untuk menampilkan tombol "Selesai" (bukan "Tidak Jadi Beli") karena
        // transaksi sudah sukses. Juga dipakai supaya transcript mencatat
        // status sukses saat admin close tiket yang sudah Set Key.
        isCompleted: meta.isCompleted || false,
        keySetAt: meta.keySetAt || null,
        keySetBy: meta.keySetBy || null,
        // v3.9.27: isTransaction EKSPLISIT — dipisah dari requiresKey.
        // true  = tiket jual-beli (produk key ATAU non-key: akun, jasa, dll)
        // false = tiket bantuan (help/report/kategori tanpa produk)
        isTransaction: meta.isTransaction !== undefined ? meta.isTransaction : null,
        // v3.9.27: invoice anti-dobel — dicentang saat close supaya transaksi
        // key (invoice dikirim saat Set Key) tidak dikirim LAGI saat close.
        isInvoiceSent: meta.isInvoiceSent || false,
        // v3.9.27: jejak "Kirim Pesanan" (produk non-key) — mirror keySetAt/By.
        deliveredAt: meta.deliveredAt || null,
        deliveredBy: meta.deliveredBy || null
    };
    saveTickets(all);
}

/**
 * Ambil metadata tiket by channelId. Fallback ke topic parsing kalau tidak ada
 * (untuk tiket lama yang dibuat sebelum v3.9.1).
 */
function getTicketMeta(channelId, topicFallback) {
    const all = loadTickets();
    if (all[channelId]) return all[channelId];

    // Backward compat: parse dari channel topic (tiket lama).
    if (topicFallback) {
        const userIdMatch = topicFallback.match(/UserID: (\d+)/);
        const productMatch = topicFallback.match(/Product:\s*([^|]+?)\s*\|/);
        const priceMatch = topicFallback.match(/Price:\s*(.+)$/);
        if (userIdMatch) {
            return {
                userId: userIdMatch[1],
                productName: productMatch ? productMatch[1].trim() : 'Unknown',
                price: priceMatch ? priceMatch[1].trim() : 'Unknown',
                guildId: null,
                createdAt: null,
                _legacy: true
            };
        }
    }
    return null;
}

/**
 * Hapus metadata tiket (dipanggil saat tiket ditutup).
 */
function removeTicketMeta(channelId) {
    const all = loadTickets();
    if (!all[channelId]) return false;
    delete all[channelId];
    saveTickets(all);
    return true;
}

/**
 * v3.9.20: Patch (partial update) metadata tiket — gak overwrite field lain.
 * Dipakai saat Set Key sukses: update isCompleted=true, keySetAt, keySetBy
 * tanpa harus re-set semua field (userId, productName, dll).
 */
function patchTicketMeta(channelId, patch) {
    const all = loadTickets();
    if (!all[channelId]) return false;
    all[channelId] = { ...all[channelId], ...patch };
    saveTickets(all);
    return true;
}

/**
 * v3.9.28: Klasifikasi produk → tipe tiket (pure function, di-ekstrak dari
 * createTicket supaya bisa di-unit-test — menjawab "apakah aman nambah
 * kategori baru seperti akun_ml / lisensi_key?").
 *
 * Rule klasifikasi (BACKWARD-COMPATIBLE — perilaku createTicket lama):
 *   - isTransaction = FALSE hanya kalau produk eksplisit help/report:
 *       product.isHelp === true, ATAU category === 'help' / 'report'
 *   - SEMUA kategori lain (transaction, akun_ml, lisensi_key, jasa, custom
 *     apa pun) → isTransaction = true → masuk 🎫 TRANSAKSI, bukan Bantuan.
 *   - requiresKey: pakai flag produk kalau ada; kalau tidak, default =
 *     isTransaction (produk transaksi tanpa flag dianggap pakai key).
 *
 * Artinya: menambah kategori BARU tidak perlu ubah code sama sekali —
 * klasifikasi otomatis benar selama id kategorinya bukan 'help'/'report'.
 *
 * @param {Object} product - objek produk dari config.products (atau objek
 *   sintetis dari kategori tanpa produk: { label, isHelp: true, category })
 * @returns {{isTransaction: boolean, requiresKey: boolean}}
 */
function classifyProduct(product) {
    if (!product) return { isTransaction: false, requiresKey: false };
    const isTransaction = !(product.isHelp === true || product.category === 'help' || product.category === 'report');
    const requiresKey = product.requiresKey !== undefined ? product.requiresKey : isTransaction;
    return { isTransaction, requiresKey };
}

/**
 * v3.9.32: cari tiket aktif milik user (dari tickets.json — sumber kebenaran).
 * Di-ekstrak dari createTicket supaya bisa dipakai juga oleh deal rekber
 * (interactions/midman.js: buyer tidak boleh punya tiket & deal aktif
 * bersamaan — kebijakan 1 channel aktif per user).
 *
 * Termasuk self-healing: metadata zombie (channel sudah tidak ada) dihapus.
 *
 * @param {Guild} guild
 * @param {string} userId
 * @returns {Promise<GuildChannel|null>} channel tiket aktif, atau null.
 */
async function findActiveTicketFor(guild, userId) {
    const ticketsData = loadTickets();
    for (const [chId, meta] of Object.entries(ticketsData)) {
        if (meta.userId === userId && meta.guildId === guild.id) {
            const ch = guild.channels.cache.get(chId);
            if (ch) return ch;
            // v3.9.8: channel gak ter-cache, tapi metadata ada. Fetch dari API —
            // kalau benar-benar hilang, cleanup metadata zombie.
            // v3.9.38 FIX: guild.channels.fetch THROW pada Unknown Channel
            // (10003), tidak return null. Pola lama `.catch(() => null)` membawa
            // SEMUA error (429 rate-limit, 5xx, network blip) ke null → meta tiket
            // yang masih LIVE ikut terhapus → user bisa buka tiket ke-2 dan guard
            // invoice/completion hilang. Sekarang mirror pola reconcileZombieDeals
            // (services/schedulerTasks.js): hanya 10003 yang dianggap channel
            // benar-benar dihapus; error lain = transient, meta dipertahankan.
            try {
                const fetched = await guild.channels.fetch(chId);
                if (fetched) return fetched;
            } catch (err) {
                // v3.9.38 FIX: 10003 = Unknown Channel — channel benar-benar dihapus.
                // Error lain (5xx/network/rate-limit) = TRANSIENT — jangan hapus meta,
                // biarkan percobaan berikutnya retry.
                if (err?.code === 10003) {
                    removeTicketMeta(chId);
                } else {
                    console.warn(`⚠️ Gagal fetch channel tiket ${chId} (transient): ${err?.message ?? err}`);
                }
            }
        }
    }
    return null;
}

/**
 * Buat channel tiket baru.
 * Tiket transaksi menampilkan tombol "Set Key" + "Tutup Tiket".
 * Tiket help/report menampilkan tombol "Tutup Tiket" saja.
 */
async function createTicket(interaction, product) {
    const guild = interaction.guild;
    const user = interaction.user;
    const config = getConfig();

    // P2-2 FIX: cek lock dulu — kalau sedang diproses, reject.
    // v3.9.8: lock di-scope per guild supaya user di multi-guild bot gak saling block.
    const lockKey = `${guild.id}:${user.id}`;
    if (ticketLocks.has(lockKey)) {
        return interaction.editReply({ content: '⏳ Tiket kamu sedang dibuat, tunggu sebentar...' }).catch(() => {});
    }
    ticketLocks.set(lockKey, true);

    try {
        // Cek apakah user punya tiket aktif.
        // v3.9.1: cek dari tickets.json (sumber kebenaran), fallback ke topic scan
        // untuk tiket lama yang dibuat sebelum v3.9.1.
        //
        // v3.9.8 FIX:
        //   1. Pakai tickets.json metadata sebagai sumber kebenaran — bahkan kalau
        //      channel tidak ter-cache (bot baru start), tetap dianggap aktif.
        //      Sebelumnya `cache.get(chId)` miss → duplicate ticket untuk user yang sama.
        //   2. Fix false-positive `startsWith` — tambah separator ` |` supaya
        //      user ID yang merupakan prefix dari user ID lain tidak false-match.
        // v3.9.32: loop tickets.json di bawah diekstrak ke findActiveTicketFor()
        //      (dipakai ulang oleh deal rekber) — perilaku identik.
        let existingTicket = await findActiveTicketFor(guild, user.id);
        // Fallback: scan channel topic (tiket lama)
        if (!existingTicket) {
            // v3.9.8: tambah ` |` supaya ID yang prefix dari ID lain tidak false-match.
            existingTicket = guild.channels.cache.find(
                c => c.topic && c.topic.startsWith(`Ticket UserID: ${user.id} |`)
            );
        }
        if (existingTicket) {
            return safeEditReply(interaction, { content: `❌ Kamu sudah punya tiket aktif di ${existingTicket}!` });
        }

        // v3.9.32: user yang masih terlibat deal rekber aktif (sebagai buyer ATAU
        // seller) tidak boleh buka tiket reguler — cegah bypass alur escrow
        // lewat tiket biasa (deal harus diselesaikan dulu).
        if (hasActiveDealFor(guild.id, user.id)) {
            return safeEditReply(interaction, {
                content: '❌ Kamu masih punya **deal rekber aktif**. Selesaikan deal-mu dulu sebelum buka tiket baru.'
            });
        }

        // Admin role wajib sudah di-set
        if (!config.roles.admin) {
            return safeEditReply(interaction, {
                content: '❌ Role Admin belum di-set. Pakai `/set-role admin @role` dulu.'
            });
        }

        // v3.9.11 Phase 1: hapus magic string 'Bantuan/Lapor'.
        // Pakai field `category` di product (Phase 2) atau fallback `isHelp: true` flag.
        // v3.9.28: logic di-ekstrak ke classifyProduct() (pure, testable) — perilaku
        // identik. Semua kategori selain help/report (termasuk kategori BARU apa
        // pun: akun_ml, lisensi_key, jasa, ...) otomatis dianggap transaksi.
        const { isTransaction, requiresKey } = classifyProduct(product);

        // v3.9.16: Kategori channel dipisah berdasarkan TIPE TIKET (transaksi vs bantuan),
        // BUKAN berdasarkan pakai key atau tidak. Jadi:
        // - isTransaction=true  → "🎫 TRANSAKSI" (baik pakai key atau tidak — sama-sama transaksi)
        // - isTransaction=false → "🎫 BANTUAN"   (help/report)
        //
        // Tombol Set Key di-cek terpisah berdasarkan requiresKey:
        // - requiresKey=true  → tombol Set Key muncul
        // - requiresKey=false → tombol Set Key tidak muncul (cuma Tutup Tiket)
        //
        // Contoh kasus:
        //   - Produk "VIP 30 Hari" (requiresKey=true) → 🎫 TRANSAKSI + tombol Set Key
        //   - Produk "Jasa Joki" (requiresKey=false)  → 🎫 TRANSAKSI + tanpa Set Key (cuma Tutup)
        //   - Help / Report                          → 🎫 BANTUAN + tanpa Set Key
        const transactionCategoryName = config.ticketCategoryKey || '🎫 TRANSAKSI';
        const helpCategoryName = config.ticketCategoryNoKey || '🎫 BANTUAN';
        const targetCategoryName = isTransaction ? transactionCategoryName : helpCategoryName;

        // Cari kategori target. Kalau gak ada, buat baru.
        let category = guild.channels.cache.find(
            c => c.name === targetCategoryName && c.type === ChannelType.GuildCategory
        );
        if (!category) {
            try {
                category = await guild.channels.create({
                    name: targetCategoryName,
                    type: ChannelType.GuildCategory
                });
                console.log(`📁 Kategori tiket baru dibuat: ${targetCategoryName}`);
            } catch (catErr) {
                console.error(`Gagal buat kategori ${targetCategoryName}:`, catErr.message);
                // Fallback: pakai kategori "🎫 TICKETS" lama kalau ada (backward compat)
                category = guild.channels.cache.find(
                    c => c.name === '🎫 TICKETS' && c.type === ChannelType.GuildCategory
                );
                if (!category) {
                    throw new Error(
                        `Gagal buat kategori tiket "${targetCategoryName}". Cek permission Manage Channels.`
                    );
                }
            }
        }

        const channelName = `ticket-${user.id}`.toLowerCase().slice(0, 50);

        const ticketChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category.id,
            // Topic tetap di-set untuk human-readable info, tapi bukan sumber kebenaran.
            topic: `Ticket UserID: ${user.id} | Product: ${product.label} | Price: ${product.price}`,
            permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                {
                    id: user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AttachFiles
                    ]
                },
                {
                    id: config.roles.admin,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.ManageMessages
                    ]
                },
                {
                    id: guild.client.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.EmbedLinks,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.ManageChannels
                    ]
                }
            ]
        });

        // v3.9.1: simpan metadata tiket ke tickets.json (sumber kebenaran).
        // v3.9.11 Phase 2: simpan category & requiresKey juga.
        // v3.9.27: simpan isTransaction EKSPLISIT — close flow & invoice tidak
        // lagi salah menganggap produk non-key (akun/jasa) sebagai tiket bantuan.
        // v3.9.38 FIX (FIX 3): simpan productValue (ID stabil) DI SAMPING
        // productName (label — tetap disimpan untuk display & backward compat).
        // Sebelumnya meta hanya menyimpan label → admin rename produk via
        // /update-product membuat lookup produk di semua tiket aktif miss
        // ("Produk tidak ditemukan"), dan label duplikat resolve ke produk salah.
        setTicketMeta(ticketChannel.id, {
            userId: user.id,
            productName: product.label,
            productValue: product.value || null,
            price: product.price,
            guildId: guild.id,
            createdAt: Date.now(),
            category: product.category || (isTransaction ? 'transaction' : 'help'),
            requiresKey,
            isTransaction
        });

        // v3.9.16: Pesan embed pakai isTransaction (transaksi vs bantuan).
        // Tombol Set Key pakai requiresKey (pakai key atau tidak).
        // Jadi 3 skenario:
        //   1. Transaksi + requiresKey=true  → "TIKET TRANSAKSI" + tombol Set Key + Tutup
        //   2. Transaksi + requiresKey=false → "TIKET TRANSAKSI" + tombol Tutup saja (jasa, dll)
        //   3. Help / Report                 → "TIKET BANTUAN" + tombol Tutup saja
        const ticketEmbed = new EmbedBuilder()
            .setTitle(isTransaction ? '🛒 TIKET TRANSAKSI' : '🎫 TIKET BANTUAN')
            .setDescription(
                `Halo <@${user.id}>!\n\n` +
                    (isTransaction
                        ? `Kamu memesan paket **${product.label}** dengan harga **${product.price}**.\n\n` +
                          `Silakan lakukan pembayaran dan kirim bukti pembayaran di sini.\n` +
                          `Admin <@&${config.roles.admin}> akan memproses pesananmu.\n\n` +
                          (requiresKey
                              ? `💡 Setelah pembayaran dikonfirmasi, admin klik tombol **🔑 Set Key** untuk memberikan key + role.`
                              : `💡 Setelah pembayaran dikonfirmasi, admin klik tombol **📦 Kirim Pesanan** — detail pesanan akan dikirim ke kamu via DM.`)
                        : `Silakan jelaskan kebutuhanmu di channel ini.\n` +
                          `Admin <@&${config.roles.admin}> akan segera membantu.`)
            )
            .setColor(isTransaction ? 0x3498db : 0xe67e22)
            .addFields(
                isTransaction
                    ? [
                          {
                              name: '📦 Produk',
                              value: `${product.label}${product.duration ? ` (${product.duration})` : ''}`,
                              inline: true
                          },
                          { name: '💰 Harga', value: product.price, inline: true }
                      ]
                    : [{ name: '📋 Jenis', value: product.label, inline: false }]
            )
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();

        // Tombol: Set Key (key) / Kirim Pesanan (non-key) + Tutup Tiket.
        // v3.9.27: produk transaksi NON-KEY (akun, jasa, dll) dapat tombol
        // "Kirim Pesanan" — mirror dari Set Key: admin isi detail pesanan di
        // modal, bot DM ke pembeli + auto-role + stats + invoice. Sebelumnya
        // produk non-key cuma punya Tutup Tiket, jadi detail pesanan hanya ada
        // di chat tiket yang TERHAPUS saat close — pembeli kehilangan datanya.
        const components = [];
        if (requiresKey) {
            components.push(
                new ButtonBuilder()
                    .setCustomId('ticket_set_key')
                    .setLabel('Set Key')
                    .setEmoji('🔑')
                    .setStyle(ButtonStyle.Success)
            );
        } else if (isTransaction) {
            components.push(
                new ButtonBuilder()
                    .setCustomId('ticket_deliver')
                    .setLabel('Kirim Pesanan')
                    .setEmoji('📦')
                    .setStyle(ButtonStyle.Success)
            );
        }
        components.push(
            new ButtonBuilder()
                .setCustomId('ticket_close')
                .setLabel('Tutup Tiket')
                .setEmoji('🔒')
                .setStyle(ButtonStyle.Danger)
        );
        const closeRow = new ActionRowBuilder().addComponents(...components);

        await ticketChannel.send({
            content: `<@&${config.roles.admin}> | <@${user.id}>`,
            embeds: [ticketEmbed],
            components: [closeRow]
        });
        await safeEditReply(interaction, { content: `✅ Tiket berhasil dibuat: ${ticketChannel}` });
    } catch (err) {
        console.error('Error creating ticket:', err);
        await interaction.editReply({ content: '❌ Terjadi error saat membuat tiket. Cek izin bot!' }).catch(() => {});
    } finally {
        // P2-2 FIX: pastikan lock dilepas walau ada error.
        // v3.9.8: gunakan lockKey scoped per guild.
        ticketLocks.delete(`${guild.id}:${user.id}`);
    }
}

/**
 * Kirim invoice ke channel invoice (testimoni).
 * Dipakai oleh Set Key flow & closeTicket.
 */
async function sendInvoice(channel, userId, productName, price, closer) {
    const config = getConfig();
    if (!config.channels.invoice) return false;
    // v3.9.11 Phase 1: hapus magic string 'Bantuan/Lapor'.
    // Sekarang: kirim invoice untuk semua produk transaksi (bukan help/report).
    // Caller bertanggung jawab skip sendInvoice untuk non-transaction ticket.
    if (!productName || productName === 'Unknown') return false;

    const invoiceChannel = channel.guild.channels.cache.get(config.channels.invoice);
    if (!invoiceChannel) return false;

    const orderId = `INV-${Date.now().toString().slice(-6)}`;
    const invoiceEmbed = new EmbedBuilder()
        .setTitle('🧾 BUKTI TRANSAKSI / TESTIMONI')
        .setColor(0x2ecc71)
        .addFields(
            { name: '🆔 Order ID', value: orderId, inline: false },
            { name: '👤 Pembeli', value: `<@${userId}>`, inline: false },
            { name: '📦 Produk', value: productName, inline: true },
            { name: '💰 Harga', value: price, inline: true },
            { name: '🕒 Tanggal', value: new Date().toLocaleString('id-ID'), inline: false }
        )
        .setFooter({ text: `Diproses oleh ${closer.tag}`, iconURL: closer.displayAvatarURL({ dynamic: true }) })
        .setTimestamp();

    await invoiceChannel.send({ content: `✅ Transaksi sukses oleh <@${userId}>!`, embeds: [invoiceEmbed] });
    return true;
}

/**
 * v3.9.38 FIX (FIX 3): SATU helper lookup produk dari meta tiket.
 *
 * Meta menyimpan label (productName) sejak v3.9.1 — label bisa di-rename
 * admin ("VIP 30 Hari" → "VIP 1 Bulan") → lookup by label miss. Mulai
 * v3.9.38 meta juga menyimpan productValue (ID stabil). Prioritas:
 *   1. by value: p.value === (meta.productValue || meta.productName)
 *      (meta.productName dipakai sebagai value-query dulu supaya tiket
 *      legacy yang kebetulan menyimpan value tetap match — pola v3.9.26)
 *   2. by label: p.label === meta.productName (tiket legacy, fallback)
 *   3. null (produk dihapus → caller pakai meta.productName untuk display)
 *
 * @param {Object} config - config bot (config.products)
 * @param {Object|null} meta - metadata tiket dari tickets.json
 * @returns {Object|null} objek produk dari config, atau null
 */
function resolveProduct(config, meta) {
    if (!meta) return null;
    const products = config?.products || [];
    return (
        products.find(p => p.value === (meta.productValue || meta.productName)) ||
        products.find(p => p.label === meta.productName) ||
        null
    );
}

/**
 * v3.9.11 Phase 3: Save transcript tiket ke channel transcript.
 *
 * Fetch semua messages di channel tiket, format jadi text, kirim ke channel
 * transcript yang sudah di-set via /set-channel tipe:transcript (v3.9.30,
 * dulu command terpisah /set-transcript-channel).
 *
 * Limit Discord: 1 message = 2000 char. Kalau transcript > 2000 char,
 * bagi jadi multiple messages.
 *
 * @param {Channel} ticketChannel - channel tiket yang akan di-close
 * @param {Object} meta - metadata tiket dari tickets.json
 * @param {User} closer - admin yang close
 * @param {boolean} isSuccess - true kalau transaksi sukses
 */
async function saveTranscript(ticketChannel, meta, closer, isSuccess) {
    const config = getConfig();
    const transcriptChannelId = config.channels?.transcript;
    if (!transcriptChannelId) return false;

    const transcriptChannel = ticketChannel.guild?.channels?.cache?.get(transcriptChannelId);
    if (!transcriptChannel) return false;

    // v3.9.38 FIX (FIX 7): fetch SEMUA pesan secara paginated, bukan cuma 100
    // terakhir. Bukti pembayaran dikirim di AWAL tiket — dengan limit 100,
    // transcript tiket panjang kehilangan pesan-pesan awal persis yang paling
    // penting. Loop pakai `before: <idTerlama>` sampai halaman kosong/parsial,
    // dengan hard cap MAX_TRANSCRIPT_MESSAGES untuk melindungi rate limit.
    // (API mengembalikan batch urut terbaru→terlama; ID snowflake naik seiring
    // waktu, jadi id TERKECIL di batch = pesan terlama = cursor `before`.)
    const MAX_TRANSCRIPT_MESSAGES = 1000;
    const collected = [];
    let capped = false;
    let messages;
    try {
        let oldestId = null;
        for (;;) {
            const fetchOpts = { limit: 100 };
            if (oldestId) fetchOpts.before = oldestId;
            const batch = await ticketChannel.messages.fetch(fetchOpts);
            if (batch.size === 0) break;
            for (const m of batch.values()) collected.push(m);
            for (const id of batch.keys()) {
                if (oldestId === null || BigInt(id) < BigInt(oldestId)) oldestId = id;
            }
            if (batch.size < 100) break; // halaman terakhir — tidak ada pesan lebih lama
            if (collected.length >= MAX_TRANSCRIPT_MESSAGES) {
                capped = true; // masih ada pesan lebih lama, tapi cap tercapai
                break;
            }
        }
        messages = collected;
    } catch (err) {
        console.warn(`⚠️ Gagal fetch messages untuk transcript: ${err.message}`);
        return false;
    }

    // Sort oldest-first supaya transcript terbaca kronologis
    const sorted = [...messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    // Build transcript text
    const lines = [];
    lines.push(`╔═══════════════════════════════════════════`);
    lines.push(`║ 🎫 TIKET TRANSCRIPT`);
    lines.push(`╠═══════════════════════════════════════════`);
    lines.push(`║ 📌 Channel: #${ticketChannel.name} (\`${ticketChannel.id}\`)`);
    lines.push(`║ 👤 User: <@${meta?.userId || 'unknown'}> (${meta?.userId || 'unknown'})`);
    lines.push(`║ 📦 Produk: ${meta?.productName || 'unknown'}`);
    lines.push(`║ 💰 Harga: ${meta?.price || 'unknown'}`);
    lines.push(`║ 🏷️ Kategori: ${meta?.category || 'unknown'}`);
    lines.push(`║ ✅ Status: ${isSuccess ? 'Sukses' : 'Dibatalkan'}`);
    lines.push(`║ 🔒 Ditutup oleh: ${closer?.tag || 'unknown'} (\`${closer?.id || 'unknown'}\`)`);
    lines.push(`║ 📅 Dibuat: ${meta?.createdAt ? new Date(meta.createdAt).toLocaleString('id-ID') : 'unknown'}`);
    lines.push(`║ 📅 Ditutup: ${new Date().toLocaleString('id-ID')}`);
    lines.push(`╚═══════════════════════════════════════════`);
    // v3.9.38 FIX (FIX 7): tanda kalau transcript di-truncate oleh hard cap.
    if (capped) {
        lines.push(`║ ⚠️ NOTE: channel punya lebih dari ${MAX_TRANSCRIPT_MESSAGES} pesan — hanya ${MAX_TRANSCRIPT_MESSAGES} pesan TERBARU yang diarsipkan (proteksi rate-limit).`);
    }
    lines.push('');
    lines.push('--- CHAT HISTORY ---');

    for (const msg of sorted) {
        // Skip message dari bot yang cuma embed panel (panjang & gak relevan)
        if (msg.author.bot && msg.embeds.length > 0 && msg.content === '') continue;

        const time = new Date(msg.createdTimestamp).toLocaleString('id-ID');
        const author = msg.author?.tag || 'unknown';
        const content = msg.content || '_(embed/attachment — tidak ditampilkan)_';
        lines.push(`[${time}] ${author}: ${content}`);
    }

    lines.push('--- END OF TRANSCRIPT ---');

    // Kirim sebagai embed summary + multiple text chunks kalau perlu
    const transcriptText = lines.join('\n');
    const CHUNK_SIZE = 1900; // sedikit di bawah 2000 untuk safety

    const embed = new EmbedBuilder()
        .setTitle(`🎫 Ticket Transcript — ${meta?.productName || 'Unknown'}`)
        .setColor(isSuccess ? 0x57f287 : 0xed4245)
        .addFields(
            { name: '👤 User', value: `<@${meta?.userId || 'unknown'}>`, inline: true },
            { name: '📦 Produk', value: meta?.productName || 'unknown', inline: true },
            { name: '💰 Harga', value: meta?.price || 'unknown', inline: true },
            { name: '🏷️ Kategori', value: meta?.category || 'unknown', inline: true },
            { name: '🔒 Ditutup oleh', value: closer?.tag || 'unknown', inline: true },
            { name: '✅ Status', value: isSuccess ? 'Sukses' : 'Dibatalkan', inline: true }
        )
        .setFooter({ text: `Channel: ${ticketChannel.name} | ${new Date().toLocaleString('id-ID')}` })
        .setTimestamp();

    await transcriptChannel.send({ embeds: [embed] });

    // Kirim transcript text dalam code blocks (chunked kalau perlu)
    const chunks = [];
    if (transcriptText.length <= CHUNK_SIZE) {
        chunks.push(transcriptText);
    } else {
        // Pecah per baris, gabung sampai mendekati CHUNK_SIZE
        let current = '';
        for (const line of lines) {
            // v3.9.26 FIX: hard-split baris yang sendirinya > CHUNK_SIZE. Satu
            // pesan user bisa 2000 char → satu "line" > 1900 → chunk jadi
            // > limit → send throw → SELURUH text transcript hilang (catch
            // di closeTicket menelan). Sekarang baris panjang dipecah paksa.
            let l = line;
            while (l.length > CHUNK_SIZE) {
                if (current) {
                    chunks.push(current);
                    current = '';
                }
                chunks.push(l.slice(0, CHUNK_SIZE));
                l = l.slice(CHUNK_SIZE);
            }
            // v3.9.37 FIX: `current` bisa kosong saat baris hard-split tepat
            // sepanjang CHUNK_SIZE → chunk kosong terkirim sebagai code block
            // blank. Push hanya kalau ada isinya.
            if ((current + '\n' + l).length > CHUNK_SIZE) {
                if (current) chunks.push(current);
                current = l;
            } else {
                current = current ? current + '\n' + l : l;
            }
        }
        if (current) chunks.push(current);
    }

    for (let i = 0; i < chunks.length; i++) {
        const header = chunks.length > 1 ? `\n[Part ${i + 1}/${chunks.length}]\n` : '';
        await transcriptChannel.send({
            content: `${header}\`\`\`\n${chunks[i]}\n\`\`\``
        });
    }

    return true;
}

/**
 * Tutup tiket — HANYA hapus channel + kirim invoice (kalau sukses).
 * Role granting & key delivery sekarang ditangani oleh Set Key button.
 *
 * FIX v3.7.1:
 *   - Per-channel lock mencegah double-close race condition
 *   - Handle DiscordAPIError 10003 (Unknown Channel) sebagai sukses —
 *     channel sudah tidak ada, yang artinya tujuan close sudah tercapai
 *     (mungkin dihapus admin lain atau close sebelumnya berhasil tapi
 *     reply-nya timeout).
 *   - Invoice failure tidak block close (log warning saja)
 *
 * @param {Channel} channel - channel tiket
 * @param {User} closer - admin yang menutup
 * @param {boolean} isSuccess - true kalau transaksi sukses (kirim invoice), false kalau batal
 */
async function closeTicket(channel, closer, isSuccess) {
    const channelId = channel?.id;

    // FIX v3.7.1: skip kalau channel sudah tidak ada (partial/deleted)
    if (!channelId) {
        console.log('ℹ️ closeTicket dipanggil tanpa channel valid — skip.');
        return;
    }

    // FIX v3.7.1: cegah double-close — kalau channel ini sedang di-close, skip.
    if (closeTicketLocks.has(channelId)) {
        console.log(`⏭️ Channel ${channelId} sedang di-close, skip double-close.`);
        return;
    }
    closeTicketLocks.add(channelId);

    try {
        // v3.9.1: baca metadata dari tickets.json (sumber kebenaran), fallback ke
        // topic parsing untuk tiket lama yang dibuat sebelum v3.9.1.
        const topic = channel.topic || '';
        const meta = getTicketMeta(channelId, topic);
        const userId = meta?.userId || null;
        const productName = meta?.productName || 'Unknown';
        const price = meta?.price || 'Unknown';

        // v3.9.20: kalau Set Key sudah dilakukan (meta.isCompleted=true),
        // anggap isSuccess=true supaya transcript & invoice mencatat status sukses.
        // Admin bisa close tanpa harus klik "Selesai" — meta yang penting.
        if (meta?.isCompleted === true) {
            isSuccess = true;
        }

        // v3.9.11 Phase 3: auto-save transcript ke channel transcript (kalau di-set).
        // Dilakukan SEBELUM delete channel supaya messages masih bisa di-fetch.
        // Failure tidak block close — log warning saja.
        const config = getConfig();
        const transcriptChannelId = config.channels?.transcript;
        if (transcriptChannelId) {
            try {
                await saveTranscript(channel, meta, closer, isSuccess);
            } catch (transcriptErr) {
                console.warn(`⚠️ Gagal save transcript untuk ticket ${channelId}:`, transcriptErr.message);
            }
        }

        // Kirim invoice untuk tiket TRANSAKSI yang sukses (bukan help/report).
        // v3.9.16: fix bug — sebelumnya help/report yang diklik "Selesai" juga kekirim invoice
        // padahal bukan transaksi jualan. Sekarang cek category dulu.
        // v3.9.18: generalize — pakai meta.requiresKey sebagai sumber kebenaran.
        //   - meta.requiresKey === false            → skip invoice (kategori non-transaksi)
        //   - meta.requiresKey === true             → kirim invoice kalau sukses
        //   - meta.requiresKey undefined (tiket lama) → fallback ke cek category & magic-string
        //     untuk backward compat dengan tiket yang dibuat sebelum v3.9.16.
        // v3.9.27 FIX (bug user-reported): produk non-key adalah TRANSAKSI SUNGGUHAN
        // (jual akun ML, jasa, dll). requiresKey===false tidak lagi dianggap
        // "bantuan" — sekarang pakai resolveTicketType() yang baca flag
        // isTransaction eksplisit. Invoice/testimoni akhirnya terkirim untuk
        // produk non-key yang di-close sebagai "Pesanan Sukses".
        //
        // v3.9.27 FIX #2 (dobel invoice): transaksi key yang sudah Set Key
        // dulunya kekirim invoice DUA KALI (saat Set Key + saat close "Selesai").
        // Sekarang: flag isInvoiceSent dicentang — kalau invoice sudah pernah
        // dikirim (Set Key / Kirim Pesanan), close tidak mengirim lagi.
        const ticketType = resolveTicketType(meta);
        const invoiceAlreadySent =
            meta?.isInvoiceSent === true ||
            // Legacy: tiket key (v3.9.20–26) yang isCompleted berarti Set Key sudah
            // dilakukan — invoice pasti sudah terkirim saat itu (flow lama selalu kirim).
            (meta?.isInvoiceSent === undefined && meta?.isCompleted === true && ticketType.requiresKey === true);

        if (isSuccess && userId && ticketType.isTransaction && !invoiceAlreadySent) {
            try {
                // v3.9.38 FIX (FIX 3e): tampilkan label produk TERKINI di invoice —
                // meta menyimpan label beku saat tiket dibuat; resolve by
                // productValue (stabil) dulu, fallback ke label meta kalau produk
                // sudah dihapus.
                const invoiceLabel = resolveProduct(config, meta)?.label || productName;
                await sendInvoice(channel, userId, invoiceLabel, price, closer);
            } catch (invoiceErr) {
                console.warn(`⚠️ Gagal kirim invoice saat close ticket ${channelId}:`, invoiceErr.message);
            }
        }

        // Hapus channel
        // FIX v3.7.1: handle 10003 (Unknown Channel) sebagai sukses.
        // v3.9.31 FIX: track apakah channel BENAR-BENAR sudah tidak ada.
        let channelGone = false;
        try {
            await channel.delete();
            channelGone = true;
        } catch (deleteErr) {
            // DiscordAPIError code 10003 = Unknown Channel — sudah dihapus.
            // Anggap sukses karena tujuan close sudah tercapai.
            if (deleteErr.code === 10003) {
                console.log(
                    `ℹ️ Channel ${channelId} sudah tidak ada (kemungkinan dihapus admin lain atau close sebelumnya). Anggap sukses.`
                );
                channelGone = true;
            } else {
                // Error lain (permission, network) — log tapi jangan crash
                console.warn(`⚠️ Gagal hapus channel ${channelId}:`, deleteErr.message);
                // Channel MASIH ADA — JANGAN hapus metadata (lihat guard di bawah).
            }
        }

        // v3.9.1: hapus metadata tiket dari tickets.json (cleanup).
        // Dilakukan setelah channel berhasil/anggap-sukses dihapus supaya
        // tidak ada zombie metadata untuk channel yang masih ada.
        //
        // v3.9.31 FIX (orphan meta): sebelumnya removeTicketMeta JALAN TERUS
        // walau channel.delete() gagal karena alasan non-10003 (Missing
        // Permissions, network). Akibatnya channel masih hidup tapi meta sudah
        // hilang → close berikutnya jatuh ke fallback topic-parsing yang
        // KEHILANGAN flag isCompleted/isInvoiceSent/isTransaction → invoice
        // terkirim dobel + skenario tombol close salah. Sekarang: meta hanya
        // dihapus kalau channel benar-benar sudah tidak ada. Trade-off: meta
        // bisa "zombie" sementara kalau delete gagal — itu aman & self-healing
        // (admin tinggal klik close lagi setelah masalah permission beres).
        if (channelGone) {
            try {
                removeTicketMeta(channelId);
            } catch (cleanupErr) {
                console.warn(`⚠️ Gagal hapus ticket meta ${channelId}:`, cleanupErr.message);
            }
        } else {
            console.warn(
                `⚠️ Metadata tiket ${channelId} TIDAK dihapus (channel masih ada — delete gagal). Klik close lagi setelah masalahnya dibereskan.`
            );
        }
    } catch (err) {
        // Error saat parse topic atau operasi lain — log tapi jangan crash
        console.error('Error closing ticket:', err.message);
    } finally {
        // FIX v3.7.1: pastikan lock dilepas walau ada error.
        closeTicketLocks.delete(channelId);
    }
}

module.exports = {
    createTicket,
    closeTicket,
    sendInvoice,
    saveTranscript,
    findActiveTicketFor,
    getTicketMeta,
    setTicketMeta,
    patchTicketMeta,
    removeTicketMeta,
    resolveTicketType,
    classifyProduct,
    // v3.9.38 FIX (FIX 3): helper lookup produk by meta (dipakai ticket.js
    // + closeTicket, dan unit test hardeningV38Ticket).
    resolveProduct
};
