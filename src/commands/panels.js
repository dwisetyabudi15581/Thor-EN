/**
 * Domain: panels
 * Slash commands: /set-verify-button, /setup-ticket-panel
 *
 * v3.9.11 Phase 1: verify button customization
 * v3.9.11 Phase 3: multi-panel ticket + transcript channel (command-nya sejak
 *          v3.9.30 digabung ke /set-channel tipe:transcript — domain config)
 * v3.9.14: persistent panel storage (panels.json) + full customization per panel
 *          (title, body, color, image, thumbnail, footer, layout, channel target).
 *          New shared builder: buildTicketPanel(panel, ctx) supaya
 *          /setup-ticket-panel & /refresh-panel bisa reuse code yang sama.
 */

const {
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ChannelType,
    MessageFlags,
    StringSelectMenuBuilder,
    getConfig,
    saveConfig,
    logAudit,
    safeEditReply
} = require('./_shared');

const { fillTemplate } = require('../data/configManager');
const { upsertPanel } = require('../data/panelManager');
// v3.9.17: shared parseColor + parseColorOrError supaya konsisten di seluruh codebase.
const { parseColorOrError } = require('../infra/colors');
// v3.9.24: normalisasi \n literal → newline asli (input command di PC tidak bisa Enter).
const { normalizeNewlines, isValidEmoji } = require('../infra/text');

const VALID_STYLES = ['Primary', 'Secondary', 'Success', 'Danger'];
const STYLE_MAP = {
    Primary: ButtonStyle.Primary,
    Secondary: ButtonStyle.Secondary,
    Success: ButtonStyle.Success,
    Danger: ButtonStyle.Danger
};

// Discord button limits
const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;

/**
 * v3.9.17: parseColor local ini di-keep untuk backward compat (dipakai di
 * panels-mgmt.js dan tests). Behavior tetap sama: THROW kalau invalid.
 * Tapi sekarang delegate ke shared `parseColorOrError` di infra/colors.js
 * supaya logic tidak duplikat. Caller baru sebaiknya pakai `parseColorOrError`
 * langsung dari `infra/colors.js`.
 *
 * @deprecated Use `parseColorOrError` from `infra/colors.js` instead.
 */
function parseColor(input) {
    const result = parseColorOrError(input);
    if (!result.ok) {
        throw new Error(result.error);
    }
    return result.color;
}

/**
 * Validate URL format (http/https). Return null kalau invalid.
 */
function validateUrl(input) {
    if (input === null || input === undefined || input === '') return null;
    if (typeof input !== 'string') return null;
    try {
        const u = new URL(input);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return input;
    } catch (_) {
        return null;
    }
}

/**
 * v3.9.29: Safety-net — deteksi kategori di panel yang TIDAK punya produk.
 *
 * Kenapa penting: kategori tanpa produk → klik tombolnya membuka tiket
 * BANTUAN langsung (bukan transaksi — bukan bug, fitur "quick action").
 * Tapi kalau admin baru bikin kategori jualan (mis. `akun_ml`) dan lupa
 * tambah produk, tiket pembeli diam-diam jadi bantuan tanpa admin sadar.
 * Helper ini kasih visibilitas di /refresh-panel & /setup-ticket-panel.
 *
 * Kategori `help`/`report` di-skip — memang quick-action (selalu kosong,
 * warning-nya cuma jadi noise).
 * v3.9.37: kategori `midman` juga di-skip — klik tombolnya membuka modal
 * deal rekber (bukan tiket), jadi "belum punya produk" bukan masalah sama
 * sekali (produk di kategori midman bahkan tidak akan pernah tampil — klik
 * tetap di-route ke alur deal).
 *
 * @param {Object} panel - panel metadata (categoryIds dipakai, mirror logic
 *   buildTicketPanel: kosong = semua kategori)
 * @param {Object} config - config global (ticketCategories + products)
 * @returns {string[]} baris warning (kosong = tidak ada masalah)
 */
function findEmptyCategoryWarnings(panel, config) {
    const allCategories = config.ticketCategories || [];
    const categoryIds = Array.isArray(panel.categoryIds) ? panel.categoryIds : [];
    let categoriesToShow =
        categoryIds.length === 0 ? allCategories : allCategories.filter(c => categoryIds.includes(c.id));
    if (categoriesToShow.length === 0) categoriesToShow = allCategories;

    const products = config.products || [];
    const lines = [];
    for (const cat of categoriesToShow) {
        if (!cat || cat.id === 'help' || cat.id === 'report' || cat.id === 'midman') continue; // quick-action default / deal rekber
        const hasProducts = products.some(p => (p.category || 'transaction') === cat.id);
        if (hasProducts) continue;
        if (cat.requiresKey !== false) {
            lines.push(
                `⚠️ **${cat.label || cat.id}** (\`${cat.id}\`) — di-set *pakai key* tapi belum punya produk. ` +
                    `Klik tombolnya membuka tiket **BANTUAN** (bukan transaksi). ` +
                    `Tambah produk: \`/add-product category:${cat.id} requires_key:true\``
            );
        } else {
            lines.push(
                `ℹ️ **${cat.label || cat.id}** (\`${cat.id}\`) — tanpa produk, klik tombolnya membuka tiket **BANTUAN** langsung. ` +
                    (cat.isDefault === false
                        ? `Kalau ini kategori jualan, tambah produk dulu: \`/add-product category:${cat.id} requires_key:false\``
                        : `Normal kalau memang quick-action.`)
            );
        }
    }
    return lines;
}

/**
 * Build embed + components untuk panel tiket.
 * Dipakai /setup-ticket-panel (buat baru) & /refresh-panel (re-render existing).
 *
 * @param {Object} panel - panel metadata (liat panelManager.js schema)
 * @param {Object} ctx - { guild, client, config } (guild dipakai untuk {server} template)
 * @returns {{embed: EmbedBuilder, components: ActionRowBuilder[]}}
 */
function buildTicketPanel(panel, ctx) {
    const config = ctx.config || getConfig();
    const allCategories = config.ticketCategories || [];
    const categoryIds = Array.isArray(panel.categoryIds) ? panel.categoryIds : [];

    // Pilih kategori yang akan ditampilkan.
    // - Kalau categoryIds kosong → tampilkan semua.
    // - Kalau ada → filter by id.
    let categoriesToShow;
    if (categoryIds.length === 0) {
        categoriesToShow = allCategories;
    } else {
        categoriesToShow = allCategories.filter(c => categoryIds.includes(c.id));
        // Kalau filter hasil 0 (semua id invalid), fallback ke semua biar panel
        // tidak kosong. Admin tetap lihat warning di reply.
        if (categoriesToShow.length === 0) {
            categoriesToShow = allCategories;
        }
    }
    categoriesToShow = categoriesToShow.slice(0, 25);

    // === Build price list per category ===
    const categoryIdsSet = new Set(categoriesToShow.map(c => c.id));
    const productsInCategories = (config.products || []).filter(p => {
        const pCat = p.category || 'transaction';
        return categoryIdsSet.has(pCat);
    });

    const priceListByCategory = {};
    for (const cat of categoriesToShow) {
        const prods = productsInCategories.filter(p => (p.category || 'transaction') === cat.id);
        priceListByCategory[cat.id] =
            prods.length > 0
                ? prods.map(p => `• **${p.label}** — ${p.price}`).join('\n')
                : `_(belum ada produk di kategori ini)_`;
    }

    const priceList =
        productsInCategories.length > 0
            ? productsInCategories.map(p => `• **${p.label}** — ${p.price}`).join('\n')
            : '_(belum ada produk — pakai `/add-product`)_';

    const categoriesListStr = categoriesToShow.map(c => `${c.emoji || '🎫'} **${c.label}**`).join(' • ');

    const priceHeader = config.messages?.ticketPriceHeader || '💰 PRICE LIST 💰';

    // Body: pakai panel.body kalau di-override, else config.messages.ticketBody.
    const bodyTemplate = panel.body != null && panel.body !== '' ? panel.body : config.messages.ticketBody;

    const renderedBody = fillTemplate(bodyTemplate, {
        server: ctx.guild?.name || 'Server',
        priceList,
        priceHeader,
        categoriesList: categoriesListStr,
        priceListByCategory
    });

    // Title: pakai panel.title kalau di-override, else config default.
    const title = panel.title != null && panel.title !== '' ? panel.title : config.messages.ticketTitle;

    // Color: parse dulu (bisa hex string dari JSON), fallback ke default orange.
    let color = 0xe67e22;
    if (panel.color != null) {
        try {
            const parsed = parseColor(panel.color);
            if (parsed !== null) color = parsed;
        } catch (_) {
            // ignore parse error di build time, default dipakai.
        }
    }

    const embed = new EmbedBuilder().setTitle(title).setDescription(renderedBody).setColor(color);

    // Optional image & thumbnail
    const imageUrl = validateUrl(panel.imageUrl);
    if (imageUrl) embed.setImage(imageUrl);
    const thumbUrl = validateUrl(panel.thumbnailUrl);
    if (thumbUrl) embed.setThumbnail(thumbUrl);

    // Footer: pakai panel.footerText kalau di-override, else bot username.
    const footerText =
        panel.footerText != null && panel.footerText !== ''
            ? panel.footerText
            : ctx.client?.user?.username || 'Community Bot';
    embed.setFooter({
        text: footerText,
        iconURL: ctx.client?.user?.displayAvatarURL({ dynamic: true })
    });
    embed.setTimestamp();

    // === Build components: buttons (default) atau dropdown select menu ===
    const components = [];
    if (panel.useDropdown) {
        // Select menu — 1 row, 1 menu, max 25 options.
        // v3.9.27 FIX (bug user-reported): deskripsi option tidak lagi memakai
        // requiresKey sebagai proxy "transaksi vs bantuan" — kategori non-key
        // (jual akun, jasa) tadinya dilabeli "Bantuan / non-transaksi" padahal
        // itu kategori jual-beli. Sekarang deskripsi berbasis KONTEN kategori:
        //   - punya produk → "Transaksi — N produk (pakai/tanpa key)"
        //   - tanpa produk → "Bantuan / buka tiket langsung" (help/report/custom)
        // v3.9.28 FIX: hitung key dari PRODUK aktual, bukan flag kategori —
        // kategori boleh campur (mis. "Akun ML" berisi 2 akun non-key + 1
        // top-up pakai key). Flag kategori hanya fallback kalau gak ada produk
        // key/non-key yang bisa disimpulkan.
        // v3.9.37 FIX: kategori midman selalu "deal rekber" — deskripsi lama
        // "Bantuan / buka tiket langsung" menyesatkan end user (klik tombolnya
        // membuka formulir deal escrow, bukan tiket bantuan).
        const options = categoriesToShow.map(cat => {
            const prods = productsInCategories.filter(p => (p.category || 'transaction') === cat.id);
            let desc;
            if (cat.id === 'midman') {
                desc = 'Deal escrow rekber — 3 pihak';
            } else if (prods.length > 0) {
                const nonKeyCount = prods.filter(p => p.requiresKey === false).length;
                let keyInfo;
                if (nonKeyCount === 0) {
                    keyInfo = 'pakai key';
                } else if (nonKeyCount === prods.length) {
                    keyInfo = 'tanpa key';
                } else {
                    keyInfo = `${nonKeyCount} tanpa key / ${prods.length - nonKeyCount} pakai key`;
                }
                desc = `Transaksi — ${prods.length} produk (${keyInfo})`;
            } else {
                desc = 'Bantuan / buka tiket langsung';
            }
            return {
                label: (cat.label || cat.id).slice(0, 100),
                value: cat.id,
                description: desc.slice(0, 100),
                emoji: cat.emoji || '🎫'
            };
        });
        if (options.length === 0) {
            // Tidak ada kategori → fallback ke single disabled button biar
            // panel tetap punya 1 komponen (Discord gak allow 0 komponen
            // kalau message udah di-set ada components).
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_noop')
                    .setLabel('Tidak ada kategori')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );
            components.push(row);
        } else {
            const menu = new StringSelectMenuBuilder()
                .setCustomId('ticket_cat_select')
                .setPlaceholder('Pilih kategori tiket...')
                .addOptions(options);
            components.push(new ActionRowBuilder().addComponents(menu));
        }
    } else {
        // Buttons — auto-wrap ke row baru tiap 5 button.
        let currentRow = new ActionRowBuilder();
        let btnCount = 0;
        for (const cat of categoriesToShow) {
            if (btnCount === MAX_BUTTONS_PER_ROW) {
                components.push(currentRow);
                currentRow = new ActionRowBuilder();
                btnCount = 0;
                if (components.length >= MAX_ROWS) break;
            }
            const btnStyle = STYLE_MAP[cat.style] || ButtonStyle.Primary;
            const btn = new ButtonBuilder()
                .setCustomId(`ticket_cat:${cat.id}`)
                .setLabel((cat.label || cat.id).slice(0, 80))
                .setEmoji(cat.emoji || '🎫')
                .setStyle(btnStyle);
            currentRow.addComponents(btn);
            btnCount++;
        }
        if (btnCount > 0 && components.length < MAX_ROWS) {
            components.push(currentRow);
        }
    }

    return { embed, components };
}

module.exports = async function (interaction) {
    const config = getConfig();

    // === SET VERIFY BUTTON ===
    if (interaction.commandName === 'set-verify-button') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const label = interaction.options.getString('label');
        const emoji = interaction.options.getString('emoji');
        const style = interaction.options.getString('style');

        // Validate style
        if (style && !VALID_STYLES.includes(style)) {
            return safeEditReply(interaction, {
                content: '❌ `style` tidak valid. Pilih: Primary, Secondary, Success, Danger.'
            });
        }

        // v3.9.26: validasi emoji SEBELUM save (anti poison config). Emoji string
        // bebas yang tersimpan bikin setEmoji() throw di /setup-verify nanti —
        // panel verifikasi mati sampai config diperbaiki manual.
        if (emoji && !isValidEmoji(emoji)) {
            return safeEditReply(interaction, {
                content: '❌ `emoji` tidak valid. Pakai emoji unicode (mis. ✅) atau custom emoji format `<:nama:id>`.'
            });
        }

        // Build new verifyButton config
        const newVerifyBtn = {
            ...(config.verifyButton || {}),
            label: label.slice(0, 80)
        };
        if (emoji) newVerifyBtn.emoji = emoji;
        if (style) newVerifyBtn.style = style;

        config.verifyButton = newVerifyBtn;
        saveConfig(config);

        await logAudit(interaction.client, {
            action: 'SET_VERIFY_BUTTON',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Update verify button — label: "${newVerifyBtn.label}", emoji: ${newVerifyBtn.emoji}, style: ${newVerifyBtn.style}`,
            guildId: interaction.guild.id
        });

        // Preview button
        const previewBtn = new ButtonBuilder()
            .setCustomId('btn_verify_preview')
            .setLabel(newVerifyBtn.label)
            .setEmoji(newVerifyBtn.emoji || '✅')
            .setStyle(STYLE_MAP[newVerifyBtn.style] || ButtonStyle.Success)
            .setDisabled(true);
        const previewRow = new ActionRowBuilder().addComponents(previewBtn);

        return safeEditReply(interaction, {
            content: '✅ Verify button di-update!\n\n**Preview:**',
            components: [previewRow]
        });
    }

    // === SETUP TICKET PANEL (multi-panel + full customization, v3.9.14) ===
    if (interaction.commandName === 'setup-ticket-panel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // v3.9.17 FIX: validasi roles.admin di awal (sama seperti /setup-ticket).
        if (!config.roles.admin) {
            return safeEditReply(interaction, {
                content: '❌ Role Admin belum di-set. Pakai `/set-role admin @role` dulu sebelum setup panel tiket.'
            });
        }

        const customTitle = interaction.options.getString('title');
        const categoriesFilter = interaction.options.getString('categories');
        // v3.9.24: dukung \n literal → newline asli di body panel (multi-line
        // price list / instruksi). Footer tetap 1 baris (Discord render footer flat).
        const customBody = normalizeNewlines(interaction.options.getString('body'));
        const colorInput = interaction.options.getString('color');
        const imageUrlInput = interaction.options.getString('image');
        const thumbnailInput = interaction.options.getString('thumbnail');
        const footerInput = interaction.options.getString('footer');
        const channelOption = interaction.options.getChannel('channel');
        const useDropdownOption = interaction.options.getBoolean('use_dropdown');

        const allCategories = config.ticketCategories || [];
        if (allCategories.length === 0) {
            return safeEditReply(interaction, {
                content:
                    '❌ Belum ada kategori. Tambah dulu pakai `/add-category`, atau pakai `/setup-ticket` untuk default.'
            });
        }

        // Filter categories by IDs (kalau di-specify), else pakai semua
        let categoriesToShow = allCategories;
        const missingCategoryIds = [];
        if (categoriesFilter) {
            const requestedIds = categoriesFilter
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
            categoriesToShow = allCategories.filter(c => requestedIds.includes(c.id));
            if (categoriesToShow.length === 0) {
                return safeEditReply(interaction, {
                    content: `❌ Tidak ada kategori yang match dengan: \`${categoriesFilter}\`. Pakai /list-categories untuk lihat daftar.`
                });
            }
            // Warning kalau ada id yang diminta tapi gak ketemu
            for (const req of requestedIds) {
                if (!allCategories.find(c => c.id === req)) missingCategoryIds.push(req);
            }
        }

        // Validate color
        let parsedColor = null;
        if (colorInput) {
            try {
                parsedColor = parseColor(colorInput);
            } catch (colorErr) {
                return safeEditReply(interaction, { content: `❌ ${colorErr.message}` });
            }
        }

        // Validate image & thumbnail URLs
        const imageUrl = validateUrl(imageUrlInput);
        if (imageUrlInput && !imageUrl) {
            return safeEditReply(interaction, {
                content: '❌ URL image tidak valid. Harus format http(s)://...'
            });
        }
        const thumbnailUrl = validateUrl(thumbnailInput);
        if (thumbnailInput && !thumbnailUrl) {
            return safeEditReply(interaction, {
                content: '❌ URL thumbnail tidak valid. Harus format http(s)://...'
            });
        }
        // v3.9.29: guard panjang 2048 (limit URL embed Discord) — tanpa ini,
        // URL panjang baru gagal belakangan saat send (error 50035 kurang jelas).
        if (imageUrl && imageUrl.length > 2048) {
            return safeEditReply(interaction, {
                content: `❌ URL image terlalu panjang (${imageUrl.length} char, maks 2048). Pakai link lebih pendek.`
            });
        }
        if (thumbnailUrl && thumbnailUrl.length > 2048) {
            return safeEditReply(interaction, {
                content: `❌ URL thumbnail terlalu panjang (${thumbnailUrl.length} char, maks 2048). Pakai link lebih pendek.`
            });
        }

        // Tentukan channel target
        const targetChannel = channelOption || interaction.channel;
        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
            return safeEditReply(interaction, {
                content: '❌ Channel target harus berupa text channel.'
            });
        }

        // Build panel metadata object (belum ada messageId — di-set setelah send)
        const panelMeta = {
            guildId: interaction.guild.id,
            channelId: targetChannel.id,
            title: customTitle || null,
            body: customBody || null,
            color: parsedColor,
            imageUrl: imageUrl || null,
            thumbnailUrl: thumbnailUrl || null,
            footerText: footerInput || null,
            categoryIds: categoriesToShow.map(c => c.id),
            useDropdown: useDropdownOption === true,
            createdBy: interaction.user.id
        };

        // Build embed + components via shared builder
        let build;
        try {
            build = buildTicketPanel(panelMeta, {
                guild: interaction.guild,
                client: interaction.client,
                config
            });
        } catch (buildErr) {
            return safeEditReply(interaction, {
                content: `❌ Gagal build panel: ${buildErr.message}`
            });
        }

        // Kirim panel ke channel target
        try {
            const sent = await targetChannel.send({
                embeds: [build.embed],
                components: build.components
            });

            // Simpan panel ke panels.json (dengan messageId baru)
            const saved = upsertPanel({
                ...panelMeta,
                messageId: sent.id
            });

            await logAudit(interaction.client, {
                action: 'SETUP_TICKET_PANEL',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Pasang panel tiket \`${saved.id}\` di ${targetChannel} — ${categoriesToShow.length} kategori, ${panelMeta.useDropdown ? 'dropdown' : 'buttons'}`,
                guildId: interaction.guild.id
            });

            const missing =
                missingCategoryIds.length > 0
                    ? `\n\n⚠️ Kategori ID tidak ditemukan (diabaikan): \`${missingCategoryIds.join(', ')}\``
                    : '';

            // v3.9.29: safety-net — kategori tanpa produk = klik tombol buka
            // tiket BANTUAN. Kasih tahu admin SEKARANG, bukan setelah pembeli
            // komplain kenapa ordernya masuk kategori bantuan.
            const emptyWarnings = findEmptyCategoryWarnings(panelMeta, config);
            const emptyWarn =
                emptyWarnings.length > 0
                    ? `\n\n🔮 **Kategori tanpa produk** (klik = tiket BANTUAN langsung):\n${emptyWarnings.map(l => `• ${l}`).join('\n')}`
                    : '';

            return safeEditReply(interaction, {
                content:
                    `✅ Panel tiket dipasang di ${targetChannel}!\n\n` +
                    `🆔 Panel ID: \`${saved.id}\` (simpan untuk /update-panel, /delete-panel, /refresh-panel)\n` +
                    `🎫 Kategori: ${categoriesToShow.map(c => `\`${c.id}\``).join(', ')} (${categoriesToShow.length})\n` +
                    `🎨 Layout: ${panelMeta.useDropdown ? 'Dropdown Select Menu' : 'Buttons'}${missing}${emptyWarn}`
            });
        } catch (sendErr) {
            return safeEditReply(interaction, {
                content: `❌ Gagal kirim panel tiket ke ${targetChannel}: ${sendErr.message}\n\nPastikan bot punya permission **Send Messages** dan **Embed Links** di channel tersebut.`
            });
        }
    }
};

// Export shared builder supaya /refresh-panel & /update-panel bisa reuse.
module.exports.buildTicketPanel = buildTicketPanel;
module.exports.parseColor = parseColor;
module.exports.validateUrl = validateUrl;
// v3.9.29: safety-net kategori kosong (dipakai panels-mgmt.js + unit test).
module.exports.findEmptyCategoryWarnings = findEmptyCategoryWarnings;
