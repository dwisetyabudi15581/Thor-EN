/**
 * Domain: config
 * Slash commands: /setup-verify, /setup-ticket, /set-role, /set-channel,
 *                 /set-message, /remove-role, /remove-channel, /list-messages,
 *                 /reset-message, /reset-config, /config-show
 *
 * Dipisah dari handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: kelola config bot (roles, channels, messages) + setup panel verifikasi/tiket.
 * v3.9.30: /set-transcript-channel (panels) digabung ke /set-channel tipe:transcript.
 */

const {
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    MessageFlags,
    getConfig,
    saveConfig,
    setField,
    DEFAULTS,
    Embeds,
    logAudit,
    safeEditReply,
    invalidateAdminRoleCache,
    getKeyStatsByGuild,
    getScheduledActiveByGuild,
    getPanelsByGuild,
    getSessionsByUser,
    EMBED_LIMITS
} = require('./_shared');

// v3.9.12: ModalBuilder untuk /edit-message
// v3.9.30: ChannelType untuk validasi /set-channel (semua tipe butuh text channel)
const { ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType } = require('discord.js');

// v3.9.25: konversi \n literal → newline asli (fitur multi-line PC)
// v3.9.38: truncateUtf8Safe — potong teks per code point (emoji aman)
const { normalizeNewlines, truncateUtf8Safe } = require('../infra/text');

module.exports = async function (interaction) {
    const embeds = new Embeds(interaction.client);
    const config = getConfig();

    // === SETUP VERIFY ===
    if (interaction.commandName === 'setup-verify') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Kalau role verified belum di-set, minta admin set dulu
        if (!config.roles.verified) {
            return safeEditReply(interaction, {
                content: '❌ Role Verified belum di-set. Pakai `/set-role verified @role` dulu.'
            });
        }

        const embed = new EmbedBuilder()
            .setTitle(config.messages.verifyTitle)
            .setDescription(config.messages.verifyBody.replace(/\{server\}/g, interaction.guild.name))
            .setColor(0x2ecc71)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();

        // v3.9.11 Phase 1: verify button configurable (label/emoji/style dari config.verifyButton).
        const btnConfig = config.verifyButton || {};
        const styleMap = {
            Primary: ButtonStyle.Primary,
            Secondary: ButtonStyle.Secondary,
            Success: ButtonStyle.Success,
            Danger: ButtonStyle.Danger
        };
        const btnStyle = styleMap[btnConfig.style] || ButtonStyle.Success;
        const btnEmoji = btnConfig.emoji || '✅';
        const btnLabel = btnConfig.label || 'Verifikasi Saya';

        const verifyBtn = new ButtonBuilder()
            .setCustomId('btn_verify')
            .setLabel(btnLabel.slice(0, 80))
            .setEmoji(btnEmoji)
            .setStyle(btnStyle);

        // v3.9.11 Phase 1: emoji bisa berupa custom emoji ID (<:name:id>) atau unicode.
        // Discord ButtonBuilder.setEmoji otomatis handle keduanya.
        const row = new ActionRowBuilder().addComponents(verifyBtn);

        // Kirim panel ke channel. Kalau gagal (biasanya permission), balas error jelas
        // biar admin tau apa yang harus diperbaiki.
        try {
            await interaction.channel.send({ embeds: [embed], components: [row] });
        } catch (sendErr) {
            return safeEditReply(interaction, {
                content: `❌ Gagal kirim panel verifikasi: ${sendErr.message}\n\nPastikan bot punya permission **Send Messages** dan **Embed Links** di channel ini.`
            });
        }
        return safeEditReply(interaction, { content: '✅ Panel verifikasi dipasang!' });
    }

    // === SETUP TICKET ===
    if (interaction.commandName === 'setup-ticket') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // v3.9.17 FIX: validasi roles.admin di awal. Sebelumnya, panel kepasang
        // tanpa cek — saat user klik tombol kategori, createTicket return error
        // "Role Admin belum di-set" → admin gak sadar sampai user report.
        if (!config.roles.admin) {
            return safeEditReply(interaction, {
                content: '❌ Role Admin belum di-set. Pakai `/set-role admin @role` dulu sebelum setup panel tiket.'
            });
        }

        // v3.9.11 Phase 2: auto-migrate produk lama (tambah category & requiresKey default).
        // Dilakukan di configManager getConfig(), tapi kita pastikan di sini juga.
        const productsWithCategory = (config.products || []).map(p => ({
            ...p,
            category: p.category || 'transaction',
            requiresKey: p.requiresKey !== undefined ? p.requiresKey : true
        }));

        // v3.9.11 Phase 2: gunakan config.ticketCategories untuk render tombol dinamis.
        // Kalau belum ada kategori (config lama), pakai default 3 tombol (legacy behavior).
        const categories = config.ticketCategories || [];
        const styleMap = {
            Primary: ButtonStyle.Primary,
            Secondary: ButtonStyle.Secondary,
            Success: ButtonStyle.Success,
            Danger: ButtonStyle.Danger
        };

        // v3.9.12: pakai fillTemplate dengan variabel ticket-specific.
        // Variabel yang tersedia untuk ticketBody:
        //   {server}            → nama guild
        //   {price_list}        → semua produk (auto-generated)
        //   {price_list:<cat>}  → produk filter by category
        //   {price_header}      → config.messages.ticketPriceHeader
        //   {categories_list}   → daftar kategori (untuk multi-panel info)
        const { fillTemplate } = require('../data/configManager');

        // Build price list per category
        const priceListByCategory = {};
        for (const cat of categories) {
            const prods = productsWithCategory.filter(p => (p.category || 'transaction') === cat.id);
            priceListByCategory[cat.id] =
                prods.length > 0 ? prods.map(p => `• **${p.label}** — ${p.price}`).join('\n') : `_(belum ada produk)_`;
        }

        // All-products price list (gabungan semua kategori)
        const fullPriceList =
            productsWithCategory.length > 0
                ? productsWithCategory.map(p => `• **${p.label}** — ${p.price}`).join('\n')
                : '_(belum ada produk — pakai `/add-product`)_';

        // Categories list (untuk info multi-panel)
        const categoriesListStr =
            categories.length > 0
                ? categories.map(c => `${c.emoji} **${c.label}** (\`${c.id}\`)`).join(' • ')
                : '_(belum ada kategori)_';

        const priceHeader = config.messages?.ticketPriceHeader || '💰 PRICE LIST 💰';

        const renderedBody = fillTemplate(config.messages.ticketBody, {
            server: interaction.guild.name,
            priceList: fullPriceList,
            priceHeader,
            categoriesList: categoriesListStr,
            priceListByCategory
        });

        // v3.9.38 FIX: validasi panjang SETELAH ekspansi template {price_list} —
        // sebelumnya hanya raw teks yang di-validasi (/set-message), jadi body
        // 500 char + 40 produk (±120 char/produk) lolos validasi tapi
        // setDescription(renderedBody) throw RangeError >4096 saat panel dipasang
        // (panel tiket mati total sampai body diperpendek). Pre-validate, bukan
        // try/catch, biar error message jelas ke admin.
        if ((config.messages.ticketTitle || '').length > EMBED_LIMITS.TITLE) {
            return safeEditReply(interaction, {
                content: `❌ Ticket Title terlalu panjang (${config.messages.ticketTitle.length} char, maks ${EMBED_LIMITS.TITLE}). Perpendek lewat \`/set-message ticketTitle\`.`
            });
        }
        if (renderedBody.length > EMBED_LIMITS.DESCRIPTION) {
            return safeEditReply(interaction, {
                content:
                    `❌ Ticket body terlalu panjang SETELAH {price_list} diekspansi: **${renderedBody.length}/${EMBED_LIMITS.DESCRIPTION}** char.\n\n` +
                    `💡 Perpendek ticket body (\`/set-message ticketBody\`), kurangi jumlah produk, atau pakai \`{price_list:<kategori>}\` untuk hanya tampilkan kategori tertentu.`
            });
        }

        const embed = new EmbedBuilder()
            .setTitle(config.messages.ticketTitle)
            .setDescription(renderedBody)
            .setColor(0xe67e22)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();

        // v3.9.11 Phase 2: render tombol dari config.ticketCategories.
        // Discord limit: 5 button per ActionRow, max 5 rows (25 button total).
        // Kalau kategori > 5, bagi ke multiple rows.
        const rows = [];
        let currentRow = new ActionRowBuilder();
        let btnCount = 0;

        for (const cat of categories.slice(0, 25)) {
            if (btnCount === 5) {
                rows.push(currentRow);
                currentRow = new ActionRowBuilder();
                btnCount = 0;
            }
            const btnStyle = styleMap[cat.style] || ButtonStyle.Primary;
            const btn = new ButtonBuilder()
                .setCustomId(`ticket_cat:${cat.id}`)
                .setLabel((cat.label || cat.id).slice(0, 80))
                .setEmoji(cat.emoji || '🎫')
                .setStyle(btnStyle);
            currentRow.addComponents(btn);
            btnCount++;
        }
        if (btnCount > 0) rows.push(currentRow);

        // Fallback kalau categories kosong: pakai tombol legacy (ticket_trade, ticket_help, ticket_report)
        // v3.9.18: label diupdate ke "Help" & "Report" (sebelumnya "Bantuan Staff" & "Laporkan Member").
        if (rows.length === 0) {
            const fallbackRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_trade')
                    .setLabel('Beli Key / Transaksi')
                    .setEmoji('🛒')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('ticket_help')
                    .setLabel('Help')
                    .setEmoji('📞')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('ticket_report')
                    .setLabel('Report')
                    .setEmoji('⚠️')
                    .setStyle(ButtonStyle.Danger)
            );
            rows.push(fallbackRow);
        }

        // Kirim panel ke channel. Wrap try/catch biar error message jelas ke admin.
        try {
            await interaction.channel.send({ embeds: [embed], components: rows });
        } catch (sendErr) {
            return safeEditReply(interaction, {
                content: `❌ Gagal kirim panel tiket: ${sendErr.message}\n\nPastikan bot punya permission **Send Messages** dan **Embed Links** di channel ini.`
            });
        }
        return safeEditReply(interaction, {
            content: `✅ Panel tiket dipasang! (${categories.length} kategori aktif)`
        });
    }

    // === SET ROLE ===
    if (interaction.commandName === 'set-role') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');
        const role = interaction.options.getRole('role');

        // v3.9.38 FIX: validasi role bisa di-assign bot — sebelumnya role managed/
        // @everyone/posisinya di atas bot lolos validasi → tersimpan ke config,
        // lalu auto-role gagal diam-diam tiap member join/verify (tidak ada
        // error sampai admin cek manual).
        if (role.id === interaction.guild.id) {
            return safeEditReply(interaction, {
                content: '❌ @everyone tidak bisa dipakai. Pilih role biasa.'
            });
        }
        if (role.managed) {
            return safeEditReply(interaction, {
                content: '❌ Role ini dikelola integrasi/bot lain (managed) — tidak bisa di-assign bot.'
            });
        }
        // Null-guard: guild.members.me bisa null di partial state — fallback 0
        // (maks ketat, admin diminta pindahkan role bot dulu).
        const botHighestPos = interaction.guild.members.me?.roles?.highest?.position ?? 0;
        if ((role.position ?? 0) >= botHighestPos) {
            return safeEditReply(interaction, {
                content:
                    '❌ Role ini posisinya DI ATAS role bot tertinggi — bot tidak bisa meng-assign. ' +
                    'Pindahkan role bot ke atas di Server Settings → Roles, atau pilih role lain.'
            });
        }

        setField(`roles.${tipe}`, role.id);
        await logAudit(interaction.client, {
            action: 'SET_ROLE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Role **${tipe}** diatur ke ${role.name} (\`${role.id}\`)`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, { content: `✅ Role **${tipe}** diatur ke ${role} (\`${role.id}\`)` });
    }

    // === SET CHANNEL ===
    // v3.9.30: mantan /set-transcript-channel digabung ke sini — satu command
    // untuk semua channel (invoice/welcome/goodbye/audit-log/transcript).
    if (interaction.commandName === 'set-channel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');
        const channel = interaction.options.getChannel('channel');

        // Validasi tipe channel: semua tujuan di sini butuh text channel
        // (bot mengirim embed/teks — voice/category/announcement-forum tidak cocok).
        if (!channel || channel.type !== ChannelType.GuildText) {
            return safeEditReply(interaction, { content: '❌ Channel harus berupa text channel.' });
        }

        setField(`channels.${tipe}`, channel.id);
        await logAudit(interaction.client, {
            action: 'SET_CHANNEL',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Channel **${tipe}** diatur ke #${channel.name} (\`${channel.id}\`)`,
            guildId: interaction.guild.id
        });

        // v3.9.30 (dipindah dari mantan /set-transcript-channel): tip khusus transcript.
        const transcriptTip =
            tipe === 'transcript'
                ? '\n\n💡 Setiap tiket yang di-close akan auto-save chat history ke channel ini sebagai bukti transaksi.'
                : '';
        return safeEditReply(interaction, {
            content: `✅ Channel **${tipe}** diatur ke ${channel} (\`${channel.id}\`)${transcriptTip}`
        });
    }

    // === EDIT MESSAGE (v3.9.12: modal editor — lebih flexible dari /set-message) ===
    // Buka modal dengan textarea pre-filled dengan teks saat ini.
    // Admin bisa edit multi-line dengan nyaman, lihat preview sebelum apply.
    if (interaction.commandName === 'edit-message') {
        const tipe = interaction.options.getString('tipe');
        const currentValue = config.messages[tipe] || '';

        const isTitle = tipe.endsWith('Title');
        const maxLength = isTitle ? EMBED_LIMITS.TITLE : EMBED_LIMITS.DESCRIPTION;

        const modal = new ModalBuilder().setCustomId(`modal_edit_message:${tipe}`).setTitle(`Edit ${tipe}`);

        const input = new TextInputBuilder()
            .setCustomId('message_text')
            .setLabel(`Teks ${tipe} (maks ${maxLength} char)`)
            .setStyle(isTitle ? TextInputStyle.Short : TextInputStyle.Paragraph)
            .setValue(currentValue.slice(0, 4000))
            .setMinLength(1)
            .setMaxLength(Math.min(maxLength, 4000))
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
    }

    // === SET MESSAGE ===
    if (interaction.commandName === 'set-message') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');
        const rawTeks = interaction.options.getString('teks');

        // P2-10 FIX: validasi panjang sesuai Discord embed limits.
        // Sebelumnya: admin bisa set teks sepanjang apapun → saat embed dikirim,
        // `setTitle` / `setDescription` throw error → silent failure.
        const isTitle = tipe.endsWith('Title');
        // v3.9.25: \n literal → newline asli untuk tipe Body (slash command input
        // di PC/HP tidak bisa Enter). Tipe *Title sengaja TIDAL dikonversi:
        // embed title Discord menolak newline — kalau dikonversi, panel verifikasi/
        // welcome bakal gagal kirim saat setup.
        const teks = isTitle ? rawTeks : normalizeNewlines(rawTeks);
        const limit = isTitle ? EMBED_LIMITS.TITLE : EMBED_LIMITS.DESCRIPTION;
        const limitLabel = isTitle ? 'title (max 256)' : 'body (max 4096)';
        if (teks.length > limit) {
            return safeEditReply(interaction, {
                content: `❌ Teks terlalu panjang untuk **${tipe}**.\n\n📏 Panjang: **${teks.length}** char\n🎯 Limit: **${limit}** char (${limitLabel})\n💡 Potong ${teks.length - limit} char lagi.`
            });
        }
        setField(`messages.${tipe}`, teks);
        await logAudit(interaction.client, {
            action: 'SET_MESSAGE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Set pesan **${tipe}** (${teks.length} char)`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Pesan **${tipe}** diperbarui.\n\nPreview:\n\`\`\`\n${teks}\n\`\`\`\nVariabel tersedia: \`{user}\` \`{username}\` \`{server}\` \`{count}\` \`{action}\``
        });
    }

    // === CONFIG SHOW (v3.1 — comprehensive view) ===
    if (interaction.commandName === 'config-show') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const fmt = (id, type) => (id ? `<${type}:${id}> (\`${id}\`)` : '❌ belum di-set');

        // v3.9.38 FIX: defense-in-depth — SEMUA field value di-cap 1024 char
        // (limit Discord). Kalau joined value kepanjangan, potong (per code
        // point, emoji aman) + note; budget dikurangi note + ellipsis supaya
        // total (konten + '…' + note) tetap <= 1024 code unit.
        const DIPOTONG_NOTE = '\n… (dipotong — batas 1024 char field Discord)';
        const capFieldValue = value => {
            if (typeof value !== 'string' || value.length <= EMBED_LIMITS.FIELD_VALUE) return value;
            return truncateUtf8Safe(value, EMBED_LIMITS.FIELD_VALUE - DIPOTONG_NOTE.length - 1) + DIPOTONG_NOTE;
        };

        // v3.9.38 FIX: daftar ber-cap — maks `maxShown` entry pertama + suffix
        // "+N lainnya". Kalau gabungan entry + suffix (+ prefix header) masih
        // kepanjangan untuk field (1024 char), kurangi jumlah entry satu per
        // satu supaya suffix tetap utuh di akhir (bukan kepotong di tengah teks).
        const buildCappedList = (items, maxShown, renderEntry, moreSuffix, emptyText, prefix = '') => {
            if (items.length === 0) return `${prefix}${emptyText}`;
            for (let n = Math.min(maxShown, items.length); n >= 1; n--) {
                const hidden = items.length - n;
                const value =
                    prefix + items.slice(0, n).map(renderEntry).join('\n') + (hidden > 0 ? moreSuffix(hidden) : '');
                if (value.length <= EMBED_LIMITS.FIELD_VALUE) return value;
            }
            // Entry tunggal super panjang (praktis mustahil) → potong per code point.
            return capFieldValue(prefix + items.slice(0, 1).map(renderEntry).join('\n'));
        };

        // --- Stats: VIP Keys ---
        // v3.9.4: scoped per guild — sebelumnya getKeyStats() return global count.
        const keyStats = getKeyStatsByGuild(interaction.guild.id);
        const keyLines = [
            `• Total key tersimpan: **${keyStats.total}**`,
            `• Aktif: **${keyStats.active}**${keyStats.permanent > 0 ? ` (termasuk ${keyStats.permanent} permanen)` : ''}`,
            keyStats.expired > 0
                ? `• ⚠️ Expired (menunggu scheduler bersihkan): **${keyStats.expired}**`
                : `• Expired: **0** ✅`
        ];

        // --- Stats: Scheduled Role Removals ---
        // v3.9.4: scoped per guild — sebelumnya getAllScheduledActive() return global list.
        const scheduled = getScheduledActiveByGuild(interaction.guild.id);
        let nextDueStr = '—';
        if (scheduled.length > 0) {
            const next = scheduled.reduce((a, b) => (a.expireAt < b.expireAt ? a : b));
            const msLeft = next.expireAt - Date.now();
            if (msLeft > 0) {
                const days = Math.floor(msLeft / 86400000);
                const hours = Math.floor((msLeft % 86400000) / 3600000);
                nextDueStr = days > 0 ? `${days}h ${hours}j lagi` : `${hours}j lagi`;
            } else {
                nextDueStr = 'akan dieksekusi loop berikutnya';
            }
        }
        const schedLines = [
            `• Total jadwal aktif: **${scheduled.length}**`,
            `• Eksekusi berikutnya: **${nextDueStr}**`,
            `• Loop scheduler: setiap 60 detik`
        ];

        // --- Stats: Self-Role Panels (guild ini) ---
        // v3.9.38 FIX: cap panel yang ditampilkan (15) + suffix — sebelumnya
        // panelSummary unbounded → field value > 1024 char di ~17 panel →
        // addFields throw RangeError (command /config-show mati total sampai
        // panel dihapus).
        const panels = getPanelsByGuild(interaction.guild.id);
        const panelSummary = buildCappedList(
            panels,
            15,
            p =>
                `  • **${p.title}** — ${p.type === 'button' ? '🔘 Button' : '📋 Select'} | ${p.exclusive ? '🔒 Eksklusif' : '✅ Multi'} | ${p.roles.length} role`,
            hidden => `\n… +${hidden} panel lainnya`,
            '_(belum ada panel — pakai `/setup-selfrole`)_',
            `${panels.length} panel terdaftar di guild ini:\n`
        );

        // --- Stats: Embed Builder Sessions (milik user ini) ---
        const mySessions = getSessionsByUser(interaction.user.id);
        const sessionLine =
            mySessions.length > 0
                ? `**${mySessions.length} session aktif** (milik kamu) — pakai \`/embed-list\` untuk lihat detail`
                : '_(tidak ada session aktif — pakai `/embed-builder` untuk mulai)_';

        // --- Products detail (dengan role + days mapping) ---
        // v3.9.38 FIX: cap produk yang ditampilkan (10) + suffix — sebelumnya
        // productLines unbounded → field value > 1024 char di ~12 produk →
        // addFields throw RangeError (command /config-show selalu error
        // sampai produk dikurangi).
        const productLines = buildCappedList(
            config.products,
            10,
            p => {
                const roleStr = p.roleId ? `<@&${p.roleId}>` : '❌ belum di-map';
                const daysStr = p.days === 0 || !p.days ? '♾️ permanen' : `${p.days} hari`;
                return `• **${p.label}** (\`${p.value}\`) — ${p.price}\n  → Role: ${roleStr} | Durasi: ${daysStr}`;
            },
            hidden => `\n\n… +${hidden} produk lainnya — pakai /list-products`,
            '_(belum ada produk — pakai `/add-product`)_'
        );

        const embed = embeds
            .info(
                '⚙️ KONFIGURASI BOT',
                'Berikut setting bot saat ini (v3.1 — key-driven VIP + self-role + embed builder):'
            )
            .addFields(
                {
                    name: '🎭 Roles',
                    value: capFieldValue(
                        [
                            `• Verified: ${fmt(config.roles.verified, '@&')}`,
                            `• Unverified: ${fmt(config.roles.unverified, '@&')}`,
                            `• Admin: ${fmt(config.roles.admin, '@&')}`,
                            `• Midman (Rekber): ${fmt(config.roles.midman, '@&')}`
                        ].join('\n')
                    ),
                    inline: false
                },
                {
                    name: '🤝 Rekber (v3.9.32)',
                    value: capFieldValue(
                        [
                            `• Fee: ${
                                config.midman?.feeMode === 'flat'
                                    ? `${config.midman?.feeValue ?? 0} flat per deal`
                                    : `${config.midman?.feeValue ?? 5}% dari harga deal`
                            }`,
                            `• Kategori channel: ${config.midman?.category || '🤝 REKBER'}`,
                            '• Lihat deal aktif: `/midman-deals`'
                        ].join('\n')
                    ),
                    inline: false
                },
                {
                    name: '📢 Channels',
                    value: capFieldValue(
                        [
                            `• Welcome: ${fmt(config.channels.welcome, '#')}`,
                            `• Goodbye: ${fmt(config.channels.goodbye, '#')}`,
                            `• Invoice: ${fmt(config.channels.invoice, '#')}`,
                            `• Audit Log: ${fmt(config.channels['audit-log'], '#')}`,
                            `• Transcript Tiket: ${fmt(config.channels.transcript, '#')}`
                        ].join('\n')
                    ),
                    inline: false
                },
                { name: `📦 Produk (${config.products.length})`, value: capFieldValue(productLines), inline: false },
                {
                    name: '🔑 VIP Keys (Key-Driven Model)',
                    value: capFieldValue(keyLines.join('\n')),
                    inline: false
                },
                { name: '⏰ Scheduled Role Removals', value: capFieldValue(schedLines.join('\n')), inline: false },
                { name: `🎭 Self-Role Panels (${panels.length})`, value: capFieldValue(panelSummary), inline: false },
                { name: '🛠️ Embed Builder Sessions', value: capFieldValue(sessionLine), inline: false }
            );
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === REMOVE ROLE ===
    if (interaction.commandName === 'remove-role') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');
        const current = config.roles[tipe];
        if (!current) {
            return safeEditReply(interaction, {
                content: `ℹ️ Role **${tipe}** memang belum di-set, tidak ada yang perlu dihapus.`
            });
        }
        delete config.roles[tipe];
        saveConfig(config);
        // v3.9.2: invalidate permissions cache kalau admin role dihapus
        if (tipe === 'admin') {
            try {
                invalidateAdminRoleCache();
            } catch (_) {}
        }
        await logAudit(interaction.client, {
            action: 'REMOVE_ROLE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Hapus role **${tipe}** dari config (sebelumnya: <@&${current}>)`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Role **${tipe}** berhasil dihapus dari config.\n\n💡 Untuk set ulang, pakai: \`/set-role ${tipe} @role\``
        });
    }

    // === REMOVE CHANNEL ===
    if (interaction.commandName === 'remove-channel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');
        const current = config.channels[tipe];
        if (!current) {
            return safeEditReply(interaction, {
                content: `ℹ️ Channel **${tipe}** memang belum di-set, tidak ada yang perlu dihapus.`
            });
        }
        delete config.channels[tipe];
        saveConfig(config);
        await logAudit(interaction.client, {
            action: 'REMOVE_CHANNEL',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Hapus channel **${tipe}** dari config (sebelumnya: <#${current}>)`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Channel **${tipe}** berhasil dihapus dari config.\n\n💡 Untuk set ulang, pakai: \`/set-channel ${tipe} #channel\``
        });
    }

    // === LIST MESSAGES ===
    if (interaction.commandName === 'list-messages') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const fields = [];
        const labels = {
            welcomeTitle: '👋 Welcome Title',
            welcomeBody: '👋 Welcome Body',
            goodbyeTitle: '👋 Goodbye Title',
            goodbyeBody: '👋 Goodbye Body',
            verifyTitle: '✅ Verify Title',
            verifyBody: '✅ Verify Body',
            ticketTitle: '🎫 Ticket Title',
            ticketBody: '🎫 Ticket Body',
            // v3.9.11 Phase 1: ticket price header configurable
            ticketPriceHeader: '🎫 Ticket Price Header'
        };
        for (const [key, label] of Object.entries(labels)) {
            const val = config.messages[key] || '(kosong)';
            // Potong teks panjang supaya muat di field Discord (1024 char).
            // v3.9.38 FIX: potong per code point — slice() biasa bisa motong
            // surrogate pair emoji jadi lone surrogate (embed ditolak Discord).
            const truncated = truncateUtf8Safe(val, 500);
            fields.push({ name: label, value: '```\n' + truncated + '\n```', inline: false });
        }
        const embed = embeds
            .info(
                '📝 DAFTAR PESAN EMBED',
                'Berikut semua teks pesan saat ini. Pakai `/set-message` untuk ubah, `/reset-message` untuk kembalikan ke default.'
            )
            .addFields(fields);
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === RESET MESSAGE ===
    if (interaction.commandName === 'reset-message') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const tipe = interaction.options.getString('tipe');

        if (tipe === 'ALL') {
            config.messages = { ...DEFAULTS.messages };
            saveConfig(config);
            await logAudit(interaction.client, {
                action: 'RESET_MESSAGE',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Reset SEMUA pesan ke default`,
                guildId: interaction.guild.id
            });
            return safeEditReply(interaction, { content: '✅ **SEMUA pesan** berhasil direset ke default.' });
        }

        const before = config.messages[tipe];
        config.messages[tipe] = DEFAULTS.messages[tipe];
        saveConfig(config);
        await logAudit(interaction.client, {
            action: 'RESET_MESSAGE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Reset pesan **${tipe}** ke default`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Pesan **${tipe}** berhasil direset ke default.\n\n**Sebelumnya:**\n\`\`\`\n${before}\n\`\`\`\n**Sekarang:**\n\`\`\`\n${config.messages[tipe]}\n\`\`\``
        });
    }

    // === RESET CONFIG (hapus semua) — v3.9.0: dengan tombol konfirmasi 2-step ===
    // Sebelumnya: 1 klik /reset-config → semua config hilang, tidak bisa undo.
    // Sekarang: tampilkan tombol konfirmasi dulu, admin harus klik "Ya, Reset"
    // untuk benar-benar reset. Mencegah fat-finger / misclick.
    if (interaction.commandName === 'reset-config') {
        const confirmBtn = new ButtonBuilder()
            .setCustomId('reset_config_confirm')
            .setLabel('⚠️ Ya, Reset Total')
            .setStyle(ButtonStyle.Danger);
        const cancelBtn = new ButtonBuilder()
            .setCustomId('reset_config_cancel')
            .setLabel('Batal')
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);

        return interaction.reply({
            content:
                '🚨 **KONFIRMASI RESET CONFIG**\n\n' +
                'Peringatan: ini akan menghapus **SEMUA** pengaturan (roles, channels, products, messages).\n' +
                'Tidak bisa di-undo!\n\n' +
                'Klik tombol di bawah untuk konfirmasi:',
            components: [row],
            flags: MessageFlags.Ephemeral
        });
    }
};
