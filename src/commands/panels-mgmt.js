/**
 * Domain: panels-mgmt
 * Slash commands: /list-panels, /delete-panel, /update-panel, /refresh-panel
 *
 * v3.9.14: Panel management commands. Bekerja dengan panels.json
 * (liat src/data/panelManager.js). Memungkinkan admin untuk:
 *   - list semua panel aktif
 *   - delete panel by id (auto delete message di channel + remove metadata)
 *   - update field panel (title/body/color/image/thumbnail/footer/layout) via modal
 *   - refresh panel (re-render dengan kategori/produk terbaru)
 *
 * CustomId yang di-handle (modal):
 *   - modal_panel_edit:<panelId>:<field>
 */

const {
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    getConfig,
    logAudit,
    safeEditReply,
    EMBED_LIMITS
} = require('./_shared');

const { getPanel, getPanelsByGuild, deletePanel, patchPanel } = require('../data/panelManager');
const { buildTicketPanel, parseColor, validateUrl, findEmptyCategoryWarnings } = require('./panels');

// v3.9.26 FIX: mapping field command → key penyimpanan di panels.json.
// SEBELUMNYA: /update-panel menulis patch `{ image: value }` (key = nama field
// command), tapi panel builder + panelManager baca `panel.imageUrl` /
// `panel.thumbnailUrl` / `panel.footerText`. Akibat: field image/thumbnail/footer
// di-update "sukses" (metadata tersimpan di key yang salah) tapi TIDAK PERNAH
// terlihat di panel — 3 dari 6 field iklankan adalah no-op diam-diam, dan
// pre-fill modal selalu kosong padahal ada nilai.
const FIELD_TO_STORAGE_KEY = {
    title: 'title',
    body: 'body',
    color: 'color',
    image: 'imageUrl',
    thumbnail: 'thumbnailUrl',
    footer: 'footerText'
};

// Fields yang bisa di-edit via /update-panel modal.
const EDITABLE_FIELDS = {
    title: {
        label: 'Judul Panel (kosongkan = pakai global)',
        style: TextInputStyle.Short,
        max: EMBED_LIMITS.TITLE
    },
    body: {
        label: 'Body Panel (kosongkan = pakai global; dukung template {server} {price_list} dll)',
        style: TextInputStyle.Paragraph,
        max: EMBED_LIMITS.DESCRIPTION
    },
    color: {
        label: 'Warna hex (mis. #ff5733, kosongkan = default orange)',
        style: TextInputStyle.Short,
        max: 20
    },
    image: {
        // v3.9.29 FIX (user report: "gabisa menaruh link gambar"): max 500 → 2048.
        // Limit Discord untuk URL embed = 2048 char. URL CDN Discord yang
        // signed (ex=/is=/hm=) bisa 300-450 char, dan URL custom (imgur/GDrive
        // + query panjang) gampang tembus 500 → client menolak input modal
        // ("jawaban terlalu panjang") sebelum sempat disubmit.
        label: 'URL gambar besar (kosongkan = no image)',
        style: TextInputStyle.Short,
        max: 2048
    },
    thumbnail: {
        // v3.9.29: lihat komentar di `image` — 500 terlalu kecil untuk URL nyata.
        label: 'URL thumbnail kecil (kosongkan = no thumb)',
        style: TextInputStyle.Short,
        max: 2048
    },
    footer: {
        label: 'Teks footer (kosongkan = pakai nama bot)',
        style: TextInputStyle.Short,
        max: EMBED_LIMITS.FOOTER_TEXT
    }
};

module.exports = async function (interaction) {
    // === LIST PANELS ===
    if (interaction.commandName === 'list-panels') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panels = getPanelsByGuild(interaction.guild.id);
        if (panels.length === 0) {
            return safeEditReply(interaction, {
                content:
                    '📭 Belum ada panel tiket persistent di server ini.\n\n' +
                    '💡 Buat panel baru pakai `/setup-ticket-panel` — panel akan otomatis terdaftar di sini.'
            });
        }

        const lines = panels
            .map((p, i) => {
                const channelMention = p.channelId ? `<#${p.channelId}>` : '_(channel hilang)_';
                const title = p.title ? `**${p.title}**` : '_(default title)_';
                const catCount = Array.isArray(p.categoryIds) ? p.categoryIds.length : 0;
                const layout = p.useDropdown ? 'Dropdown' : 'Buttons';
                const date = p.createdAt ? new Date(p.createdAt).toLocaleDateString('id-ID') : '?';
                return (
                    `\`${i + 1}.\` 🆔 \`${p.id}\`\n` +
                    `   ${title} — di ${channelMention}\n` +
                    `   🎫 ${catCount} kategori • 🎨 ${layout} • 📅 ${date}`
                );
            })
            .join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle('🎫 DAFTAR PANEL TIKET')
            .setDescription(lines)
            .setColor(0x5865f2)
            .setFooter({
                text: `${panels.length} panel aktif • Pakai ID untuk /delete-panel, /update-panel, /refresh-panel`
            })
            .setTimestamp();

        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === DELETE PANEL ===
    if (interaction.commandName === 'delete-panel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panelId = interaction.options.getString('id');
        const panel = getPanel(panelId);

        if (!panel) {
            return safeEditReply(interaction, {
                content: `❌ Panel \`${panelId}\` tidak ditemukan. Pakai /list-panels untuk lihat daftar.`
            });
        }
        // Cross-guild safety: jangan izinkan hapus panel dari guild lain.
        if (panel.guildId !== interaction.guild.id) {
            return safeEditReply(interaction, {
                content: '❌ Panel ini bukan milik server ini. Tidak bisa dihapus.'
            });
        }

        // Coba hapus message di channel (best-effort — channel/message bisa sudah hilang)
        let messageDeleted = false;
        let messageNotFound = false;
        if (panel.channelId && panel.messageId) {
            try {
                const channel = await interaction.guild.channels.fetch(panel.channelId).catch(() => null);
                if (channel) {
                    const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
                    if (msg) {
                        await msg.delete();
                        messageDeleted = true;
                    } else {
                        messageNotFound = true;
                    }
                } else {
                    messageNotFound = true;
                }
            } catch (delErr) {
                console.warn(`⚠️ Gagal hapus message panel ${panelId}: ${delErr.message}`);
                messageNotFound = true;
            }
        }

        // Hapus metadata panel
        const removed = deletePanel(panelId);
        if (!removed) {
            return safeEditReply(interaction, {
                content: `❌ Gagal hapus metadata panel \`${panelId}\`. Mungkin sudah dihapus.`
            });
        }

        await logAudit(interaction.client, {
            action: 'DELETE_PANEL',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Hapus panel tiket \`${panelId}\` (message ${messageDeleted ? 'dihapus' : 'sudah tidak ada'})`,
            guildId: interaction.guild.id
        });

        const status = messageDeleted
            ? '✅ Message panel dihapus dari channel + metadata dibersihkan.'
            : messageNotFound
              ? 'ℹ️ Message panel sudah tidak ada di channel (mungkin dihapus manual). Metadata dibersihkan.'
              : '✅ Metadata panel dibersihkan.';

        return safeEditReply(interaction, {
            content: `✅ Panel \`${panelId}\` berhasil dihapus.\n\n${status}`
        });
    }

    // === REFRESH PANEL ===
    if (interaction.commandName === 'refresh-panel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const panelId = interaction.options.getString('id');
        const panel = getPanel(panelId);

        if (!panel) {
            return safeEditReply(interaction, {
                content: `❌ Panel \`${panelId}\` tidak ditemukan. Pakai /list-panels untuk lihat daftar.`
            });
        }
        if (panel.guildId !== interaction.guild.id) {
            return safeEditReply(interaction, {
                content: '❌ Panel ini bukan milik server ini.'
            });
        }
        if (!panel.channelId || !panel.messageId) {
            return safeEditReply(interaction, {
                content: '❌ Panel ini tidak punya message reference (mungkin corrupt). Hapus dan setup ulang.'
            });
        }

        const config = getConfig();
        let build;
        try {
            build = buildTicketPanel(panel, {
                guild: interaction.guild,
                client: interaction.client,
                config
            });
        } catch (buildErr) {
            return safeEditReply(interaction, {
                content: `❌ Gagal rebuild panel: ${buildErr.message}`
            });
        }

        try {
            const channel = await interaction.guild.channels.fetch(panel.channelId).catch(() => null);
            if (!channel) {
                return safeEditReply(interaction, {
                    content: `❌ Channel <#${panel.channelId}> sudah tidak ada. Hapus panel dan setup ulang.`
                });
            }
            const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
            if (!msg) {
                return safeEditReply(interaction, {
                    content: '❌ Message panel sudah tidak ada di channel. Hapus panel dan setup ulang.'
                });
            }

            await msg.edit({ embeds: [build.embed], components: build.components });

            await logAudit(interaction.client, {
                action: 'REFRESH_PANEL',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Refresh panel \`${panelId}\` — re-render dengan kategori/produk terbaru`,
                guildId: interaction.guild.id
            });

            // v3.9.29: safety-net — kategori di panel ini yang masih kosong
            // produk. Klik tombol kategori kosong = tiket BANTUAN (bukan
            // transaksi); admin perlu tau ini SEBELUM pembeli pakai tombolnya.
            const emptyWarnings = findEmptyCategoryWarnings(panel, config);
            const emptyWarn =
                emptyWarnings.length > 0
                    ? `\n\n🔮 **Kategori tanpa produk** (klik = tiket BANTUAN langsung):\n${emptyWarnings.map(l => `• ${l}`).join('\n')}`
                    : '';

            return safeEditReply(interaction, {
                content: `✅ Panel \`${panelId}\` di-refresh!\n\n📬 Lokasi: ${channel}\n🎨 Layout: ${panel.useDropdown ? 'Dropdown' : 'Buttons'}\n🎫 Kategori: ${(panel.categoryIds || []).length} aktif${emptyWarn}`
            });
        } catch (editErr) {
            return safeEditReply(interaction, {
                content: `❌ Gagal edit message panel: ${editErr.message}`
            });
        }
    }

    // === UPDATE PANEL — open modal for field selection ===
    if (interaction.commandName === 'update-panel') {
        const panelId = interaction.options.getString('id');
        const field = interaction.options.getString('field');
        const panel = getPanel(panelId);

        if (!panel) {
            return interaction.reply({
                content: `❌ Panel \`${panelId}\` tidak ditemukan. Pakai /list-panels untuk lihat daftar.`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (panel.guildId !== interaction.guild.id) {
            return interaction.reply({
                content: '❌ Panel ini bukan milik server ini.',
                flags: MessageFlags.Ephemeral
            });
        }

        const fieldDef = EDITABLE_FIELDS[field];
        if (!fieldDef) {
            return interaction.reply({
                content: `❌ Field \`${field}\` tidak valid.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Pre-fill current value (atau kosong kalau masih default)
        // v3.9.26: baca via key penyimpanan yang BENAR (mapping), bukan nama field command.
        const storageKey = FIELD_TO_STORAGE_KEY[field] || field;
        const currentValue = panel[storageKey] != null ? String(panel[storageKey]) : '';

        const modal = new ModalBuilder()
            .setCustomId(`modal_panel_edit:${panelId}:${field}`)
            .setTitle(`Edit ${field} — ${panelId.slice(0, 16)}...`);

        const input = new TextInputBuilder()
            .setCustomId('panel_field_value')
            .setLabel(fieldDef.label.slice(0, 45))
            .setStyle(fieldDef.style)
            .setValue(currentValue)
            .setMinLength(0)
            .setMaxLength(Math.min(fieldDef.max, 4000))
            .setRequired(false); // false supaya admin bisa "clear" field = fallback ke global

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
    }
};

// === Export modal handler untuk dipanggil dari interactions/panels.js ===
// Karena interaction router nggak otomatis kenalin prefix modal_panel_edit,
// kita register handler-nya di interactions/index.js (liat langkah selanjutnya).
// v3.9.29: EDITABLE_FIELDS + FIELD_TO_STORAGE_KEY juga di-export supaya unit
// test bisa verifikasi limit maxLength modal (regression guard untuk bug
// "URL > 500 char ditolak input modal") dan mapping key penyimpanan.
module.exports.EDITABLE_FIELDS = EDITABLE_FIELDS;
module.exports.FIELD_TO_STORAGE_KEY = FIELD_TO_STORAGE_KEY;
module.exports.handlePanelModal = async function handlePanelModal(interaction) {
    // customId: modal_panel_edit:<panelId>:<field>
    // Tapi panelId bisa aja contain ':' (gak kayaknya, tp defensive) — split dari kanan.
    const parts = interaction.customId.split(':');
    if (parts.length < 3) {
        return interaction.reply({
            content: '❌ Format customId modal tidak valid.',
            flags: MessageFlags.Ephemeral
        });
    }
    const field = parts[parts.length - 1];
    const panelId = parts.slice(1, -1).join(':');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

    // v3.9.26 (hardening konsisten dengan modal_set_key / restore_backup_confirm):
    // re-check admin saat modal di-submit — bukan cuma saat modal dibuka. Modal
    // bisa dibiarkan terbuka berjam-jam; admin yang ke-depromote di jeda itu
    // tetap bisa apply patch tanpa cek ulang di versi sebelumnya.
    try {
        const { isAdmin } = require('../infra/permissions');
        if (!isAdmin(interaction.member)) {
            return safeEditReply(interaction, {
                content: '❌ Kamu tidak punya izin admin untuk edit panel.'
            });
        }
    } catch (_) {
        // Kalau cek admin gagal (mis. cache role error), jangan blokir edit —
        // modal hanya bisa dibuka oleh admin yang sama kok.
    }

    const panel = getPanel(panelId);
    if (!panel) {
        return safeEditReply(interaction, {
            content: `❌ Panel \`${panelId}\` tidak ditemukan (mungkin sudah dihapus).`
        });
    }
    if (panel.guildId !== interaction.guild.id) {
        return safeEditReply(interaction, { content: '❌ Panel ini bukan milik server ini.' });
    }

    const newValue = (interaction.fields.getTextInputValue('panel_field_value') || '').trim();
    const fieldDef = EDITABLE_FIELDS[field];
    if (!fieldDef) {
        return safeEditReply(interaction, { content: `❌ Field \`${field}\` tidak valid.` });
    }

    // Validate & build patch object
    // v3.9.26: patch ditulis dengan KEY PENYIMPANAN (mapping) — bukan nama field
    // command — supaya panel builder (yang baca imageUrl/thumbnailUrl/footerText)
    // benar-benar melihat perubahannya.
    const patch = {};
    const storageKey = FIELD_TO_STORAGE_KEY[field] || field;
    if (newValue === '') {
        // Empty = clear field (fallback ke global default)
        patch[storageKey] = null;
    } else {
        // Validate per field type
        if (field === 'color') {
            try {
                patch[storageKey] = parseColor(newValue);
            } catch (colorErr) {
                return safeEditReply(interaction, { content: `❌ ${colorErr.message}` });
            }
        } else if (field === 'image' || field === 'thumbnail') {
            // v3.9.29: guard panjang 2048 — limit URL embed Discord. Lewat ini,
            // Discord API yang tolak saat edit message (error 50035 kurang jelas).
            if (newValue.length > 2048) {
                return safeEditReply(interaction, {
                    content: `❌ URL ${field} terlalu panjang (${newValue.length} char, maks 2048 — limit embed Discord). Pakai link lebih pendek.`
                });
            }
            const validated = validateUrl(newValue);
            if (!validated) {
                return safeEditReply(interaction, {
                    content: `❌ URL ${field} tidak valid. Harus http(s)://...`
                });
            }
            patch[storageKey] = validated;
        } else if (newValue.length > fieldDef.max) {
            return safeEditReply(interaction, {
                content: `❌ Teks terlalu panjang (${newValue.length} > ${fieldDef.max} char).`
            });
        } else {
            patch[storageKey] = newValue;
        }
    }

    // Apply patch
    const updated = patchPanel(panelId, patch);
    if (!updated) {
        return safeEditReply(interaction, { content: '❌ Gagal update panel.' });
    }

    // Re-render panel message biar langsung keliatan
    let renderedMessage = '';
    try {
        const config = getConfig();
        const build = buildTicketPanel(updated, {
            guild: interaction.guild,
            client: interaction.client,
            config
        });
        const channel = await interaction.guild.channels.fetch(updated.channelId).catch(() => null);
        if (channel) {
            const msg = await channel.messages.fetch(updated.messageId).catch(() => null);
            if (msg) {
                await msg.edit({ embeds: [build.embed], components: build.components });
                renderedMessage = '\n\n✅ Panel message sudah di-refresh.';
            } else {
                renderedMessage = '\n\n⚠️ Message panel tidak ditemukan (mungkin dihapus). Metadata tetap diupdate.';
            }
        } else {
            renderedMessage = '\n\n⚠️ Channel panel tidak ditemukan. Metadata tetap diupdate.';
        }
    } catch (editErr) {
        renderedMessage = `\n\n⚠️ Gagal refresh message: ${editErr.message} (metadata tetap diupdate).`;
    }

    await logAudit(interaction.client, {
        action: 'UPDATE_PANEL',
        actorId: interaction.user.id,
        actorTag: interaction.user.tag,
        // v3.9.29 FIX: baca patch pakai storageKey (dulu patch[field] — selalu
        // `undefined` untuk image/thumbnail/footer karena patch ditulis ke
        // imageUrl/thumbnailUrl/footerText).
        details: `Update field \`${field}\` panel \`${panelId}\` → ${
            patch[storageKey] === null
                ? '(clear → default)'
                : typeof patch[storageKey] === 'string' && patch[storageKey].length > 80
                  ? patch[storageKey].slice(0, 80) + '...'
                  : patch[storageKey]
        }`,
        guildId: interaction.guild.id
    });

    return safeEditReply(interaction, {
        content: `✅ Field \`${field}\` panel \`${panelId}\` diupdate!${renderedMessage}`
    });
};
