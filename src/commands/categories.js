/**
 * Domain: categories
 * Slash commands: /add-category, /list-categories, /remove-category
 *
 * v3.9.11 Phase 2: Ticket category management.
 * Admin bisa CRUD kategori tiket dari Discord. Kategori dipakai di /setup-ticket
 * untuk render button dinamis.
 */

const { EmbedBuilder, MessageFlags, getConfig, saveConfig, logAudit, safeEditReply } = require('./_shared');
const { isValidEmoji } = require('../infra/text');

const CATEGORY_ID_REGEX = /^[a-zA-Z0-9_-]{1,30}$/;

module.exports = async function (interaction) {
    const config = getConfig();

    // === ADD CATEGORY ===
    if (interaction.commandName === 'add-category') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const id = interaction.options.getString('id');
        const label = interaction.options.getString('label');
        const emoji = interaction.options.getString('emoji') || '🎫';
        const style = interaction.options.getString('style') || 'Primary';
        const requiresKey = interaction.options.getBoolean('requires_key');

        // Validate id format
        if (!CATEGORY_ID_REGEX.test(id)) {
            return safeEditReply(interaction, {
                content: '❌ `id` hanya boleh huruf/angka/_/-, maks 30 karakter.'
            });
        }

        // Validate style
        const validStyles = ['Primary', 'Secondary', 'Success', 'Danger'];
        if (!validStyles.includes(style)) {
            return safeEditReply(interaction, { content: '❌ `style` tidak valid.' });
        }

        // v3.9.26: validasi emoji SEBELUM save. Emoji invalid (string panjang /
        // bukan emoji) tersimpan ke config → ButtonBuilder.setEmoji() throw saat
        // panel dirender → /setup-ticket & /refresh-panel mati sampai config
        // diperbaiki manual (poison persist).
        if (!isValidEmoji(emoji)) {
            return safeEditReply(interaction, {
                content: '❌ `emoji` tidak valid. Pakai emoji unicode (mis. 🎫) atau custom emoji format `<:nama:id>`.'
            });
        }

        // Check duplicate
        const categories = config.ticketCategories || [];
        if (categories.some(c => c.id === id)) {
            return safeEditReply(interaction, {
                content: `❌ Kategori dengan ID \`${id}\` sudah ada. Pakai /remove-category dulu kalau mau replace.`
            });
        }

        // Check max 25 categories (Discord button limit per message)
        if (categories.length >= 25) {
            return safeEditReply(interaction, {
                content: '❌ Maksimal 25 kategori (limit Discord: 25 button per message).'
            });
        }

        // Add new category
        const newCategory = {
            id,
            label: label.slice(0, 80),
            emoji,
            style,
            requiresKey: requiresKey !== null ? requiresKey : true,
            isDefault: false
        };
        categories.push(newCategory);
        config.ticketCategories = categories;
        saveConfig(config);

        await logAudit(interaction.client, {
            action: 'ADD_CATEGORY',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Tambah kategori tiket: **${label}** (\`${id}\`) — emoji: ${emoji}, style: ${style}, requiresKey: ${newCategory.requiresKey}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ Kategori ditambahkan!\n\n` +
                `🎫 ID: \`${id}\`\n` +
                `📝 Label: **${label}**\n` +
                `${emoji} Emoji: ${emoji}\n` +
                `🎨 Style: ${style}\n` +
                `🔑 Requires Key: ${newCategory.requiresKey ? 'Yes' : 'No'}\n\n` +
                `💡 Pakai \`/setup-ticket\` (atau \`/refresh-panel <id>\` kalau panel sudah ada) untuk menerapkan kategori baru.`
        });
    }

    // === LIST CATEGORIES ===
    if (interaction.commandName === 'list-categories') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const categories = config.ticketCategories || [];
        if (categories.length === 0) {
            return safeEditReply(interaction, {
                content:
                    '📭 Belum ada kategori. Default 5 kategori (transaction, help, report, claim_giveaway, midman) akan dipakai kalau config kosong.'
            });
        }

        const lines = categories
            .map((c, i) => {
                const keyFlag = c.requiresKey ? '🔑' : '📋';
                const defaultFlag = c.isDefault ? ' *(default)*' : '';
                return `\`${i + 1}.\` ${c.emoji} **${c.label}** (\`${c.id}\`) — ${c.style} ${keyFlag}${defaultFlag}`;
            })
            .join('\n');

        const embed = new EmbedBuilder()
            .setTitle('🎫 DAFTAR KATEGORI TIKET')
            .setDescription(lines)
            .setColor(0x5865f2)
            .setFooter({ text: `${categories.length}/25 kategori terpakai` })
            .setTimestamp();

        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === REMOVE CATEGORY ===
    if (interaction.commandName === 'remove-category') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const id = interaction.options.getString('id');
        const categories = config.ticketCategories || [];
        const idx = categories.findIndex(c => c.id === id);

        if (idx === -1) {
            return safeEditReply(interaction, {
                content: `❌ Kategori \`${id}\` tidak ditemukan. Pakai /list-categories untuk lihat daftar.`
            });
        }

        // v3.9.11: jangan hapus kategori default (transaction, help, report) — terlalu risky.
        if (categories[idx].isDefault) {
            return safeEditReply(interaction, {
                content:
                    `❌ Kategori \`${id}\` adalah kategori default dan tidak bisa dihapus.\n` +
                    `Kalau mau disable, set \`requiresKey: false\` atau edit label via config langsung.`
            });
        }

        const [removed] = categories.splice(idx, 1);
        config.ticketCategories = categories;

        // v3.9.26 FIX: tandai dismiss supaya migration claim_giveaway di
        // configManager TIDAK menambah ulang kategori ini di getConfig()
        // berikutnya (dulu: kategori "hidup lagi" diam-diam di run berikutnya
        // karena migration re-add tanpa cek flag apa pun).
        if (removed.id === 'claim_giveaway') {
            config.claimGiveawayDismissed = true;
        }
        // v3.9.32: sama untuk kategori midman/rekber — flag mencegah migration
        // configManager menambah ulang kategori ini di getConfig() berikutnya.
        if (removed.id === 'midman') {
            config.midmanCategoryDismissed = true;
        }

        // v3.9.17 FIX: implement fallback actual. Sebelumnya, pesan bilang
        // "produk akan fallback ke transaction" tapi tidak ada code yang update
        // product.category → produk jadi orphan (tidak muncul di panel manapun).
        // Sekarang: iterate products, set category='transaction' untuk produk
        // yang category-nya === id kategori yang dihapus.
        const removedId = removed.id;
        let migratedCount = 0;
        if (Array.isArray(config.products)) {
            config.products = config.products.map(p => {
                if (p && p.category === removedId) {
                    migratedCount++;
                    return { ...p, category: 'transaction' };
                }
                return p;
            });
        }

        saveConfig(config);

        await logAudit(interaction.client, {
            action: 'REMOVE_CATEGORY',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Hapus kategori tiket: **${removed.label}** (\`${removed.id}\`) — ${migratedCount} produk di-migrate ke \`transaction\``,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ Kategori **${removed.label}** (\`${removed.id}\`) berhasil dihapus.\n\n` +
                (migratedCount > 0
                    ? `📦 ${migratedCount} produk yang pakai kategori ini sudah otomatis dipindah ke kategori \`transaction\`.`
                    : `ℹ️ Tidak ada produk yang pakai kategori ini.`)
        });
    }

    // === UPDATE CATEGORY (v3.9.19) ===
    // Edit kategori existing tanpa harus hapus + add ulang.
    // Semua field optional — hanya field yang diisi yang akan diupdate.
    if (interaction.commandName === 'update-category') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const id = interaction.options.getString('id');
        const newLabel = interaction.options.getString('label');
        const newEmoji = interaction.options.getString('emoji');
        const newStyle = interaction.options.getString('style');
        const newRequiresKey = interaction.options.getBoolean('requires_key');

        const categories = config.ticketCategories || [];
        const idx = categories.findIndex(c => c.id === id);

        if (idx === -1) {
            return safeEditReply(interaction, {
                content: `❌ Kategori \`${id}\` tidak ditemukan. Pakai /list-categories untuk lihat daftar.`
            });
        }

        // Validate style kalau diisi
        if (newStyle !== null) {
            const validStyles = ['Primary', 'Secondary', 'Success', 'Danger'];
            if (!validStyles.includes(newStyle)) {
                return safeEditReply(interaction, { content: '❌ `style` tidak valid.' });
            }
        }

        // v3.9.26: validasi emoji kalau diisi (anti poison config — lihat add-category)
        if (newEmoji !== null && !isValidEmoji(newEmoji)) {
            return safeEditReply(interaction, {
                content: '❌ `emoji` tidak valid. Pakai emoji unicode (mis. 🎫) atau custom emoji format `<:nama:id>`.'
            });
        }

        const before = { ...categories[idx] };
        const changes = [];

        if (newLabel !== null) {
            categories[idx].label = newLabel.slice(0, 80);
            changes.push(`label: \`${before.label}\` → \`${categories[idx].label}\``);
        }
        if (newEmoji !== null) {
            categories[idx].emoji = newEmoji;
            changes.push(`emoji: ${before.emoji} → ${newEmoji}`);
        }
        if (newStyle !== null) {
            categories[idx].style = newStyle;
            changes.push(`style: ${before.style} → ${newStyle}`);
        }
        if (newRequiresKey !== null) {
            categories[idx].requiresKey = newRequiresKey;
            changes.push(`requiresKey: ${before.requiresKey} → ${newRequiresKey}`);
        }

        if (changes.length === 0) {
            return safeEditReply(interaction, {
                content:
                    `ℹ️ Tidak ada perubahan dilakukan. Berikan minimal 1 field untuk diupdate (label/emoji/style/requires_key).\n\n` +
                    `Kategori **${before.label}** (\`${before.id}\`) tetap seperti sebelumnya.`
            });
        }

        config.ticketCategories = categories;
        saveConfig(config);

        await logAudit(interaction.client, {
            action: 'UPDATE_CATEGORY',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Update kategori tiket: **${before.label}** (\`${before.id}\`) — ${changes.join('; ')}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ Kategori **${categories[idx].label}** (\`${categories[idx].id}\`) berhasil diupdate!\n\n` +
                `📝 Perubahan:\n${changes.map(c => `• ${c}`).join('\n')}\n\n` +
                `💡 Pakai \`/refresh-panel <id>\` untuk re-render panel yang sudah terpasang.`
        });
    }
};
