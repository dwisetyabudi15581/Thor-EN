/**
 * Domain: keys
 * Slash commands: /set-key, /list-keys, /clear-schedule
 *
 * Dipisah dari handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: beri key + role + extend schedule user, list key, hapus schedule/key.
 *
 * v3.9.0: scoped per guild (clear-schedule tidak wipe cross-guild).
 * v3.9.8: track role yang gagal dilepas di clear-schedule.
 */

const {
    EmbedBuilder,
    MessageFlags,
    getConfig,
    addKey,
    findAllByUser,
    findAllSchedulesByUser,
    formatKeysForUser,
    removeAllKeysByUser,
    scheduleRoleRemoval,
    removeAllSchedulesByUser,
    parsePriceNum,
    trackPurchase,
    sendInvoice,
    logAudit,
    safeEditReply,
    getActiveKeysByUserAndRole
} = require('./_shared');
// v3.9.22: formatRemaining di-import langsung dari keyManager (gak ada di _shared).
const { formatRemaining } = require('../data/keyManager');

module.exports = async function (interaction) {
    const config = getConfig();

    // ====================================================
    // === /set-key — BERI KEY + ROLE + EXTEND SCHEDULE ===
    // ====================================================
    if (interaction.commandName === 'set-key') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const value = interaction.options.getString('value');
        // v3.9.38 FIX (FIX 5b): trim input + tolak key kosong/whitespace SEBELUM
        // side effect apa pun (addKey/role/DM/invoice). Discord hanya validasi
        // required/minLength di sisi client string — "   " (spasi saja) lolos.
        const keyValue = (interaction.options.getString('key') || '').trim();
        if (!keyValue) {
            return safeEditReply(interaction, { content: '❌ Key tidak boleh kosong.' });
        }

        const product = config.products.find(p => p.value === value);
        if (!product) {
            return safeEditReply(interaction, {
                content: `❌ Produk value \`${value}\` tidak ditemukan. Pakai \`/list-products\` untuk lihat daftar.`
            });
        }
        if (!product.roleId) {
            return safeEditReply(interaction, {
                content: `❌ Produk **${product.label}** belum punya auto-role. Pakai \`/set-product-role\` dulu.`
            });
        }

        const guild = interaction.guild;
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member) {
            return safeEditReply(interaction, { content: `❌ User <@${user.id}> tidak ada di server.` });
        }
        const role = guild.roles.cache.get(product.roleId);
        if (!role) {
            return safeEditReply(interaction, {
                content: `❌ Role ID \`${product.roleId}\` tidak ditemukan di guild.`
            });
        }

        // 1. Simpan key ke database. Wrap try/catch biar error jelas ke admin
        // (kalau gagal, role belum dikasih, schedule belum dibuat — state masih bersih).
        let keyEntry;
        try {
            keyEntry = addKey({
                key: keyValue,
                userId: member.id,
                username: member.user.tag,
                roleId: role.id,
                productName: product.label,
                days: product.days || 0,
                guildId: interaction.guild.id
            });
        } catch (keyErr) {
            console.error('addKey gagal:', keyErr);
            return safeEditReply(interaction, {
                content: `❌ Gagal simpan key ke database: ${keyErr.message}\n\nCek disk space dan permission file \`data/keys.json\`. Role belum diberikan, schedule belum dibuat.`
            });
        }

        // 2. Kasih role ke member
        try {
            if (!member.roles.cache.has(role.id)) {
                await member.roles.add(role);
            }
        } catch (_err) {
            return safeEditReply(interaction, {
                content:
                    `❌ Gagal add role ${role}. Pastikan role bot ada di ATAS role tersebut.\n\n` +
                    `⚠️ **Key disimpan TANPA role.** Setelah role bot diperbaiki, admin bisa:\n` +
                    `• Add role manual ke member, atau\n` +
                    `• Hapus key ini via \`/clear-schedule clear_keys:true\` lalu re-set key.`
            });
        }

        // 3. Schedule auto-expire (MAX EXTEND). Wrap try/catch — kalau gagal, role + key
        // udah tersimpan. Tampilin warning ke admin biar dia tau role gak auto-expire.
        let schedResult;
        let scheduleWarning = '';
        try {
            schedResult = scheduleRoleRemoval({
                userId: member.id,
                roleId: role.id,
                guildId: guild.id,
                days: product.days || 0,
                expireAt: keyEntry.expireAt,
                productName: product.label
            });
        } catch (schedErr) {
            console.error('scheduleRoleRemoval gagal:', schedErr);
            schedResult = { extended: false, permanent: false };
            scheduleWarning = `\n⚠️ **Schedule auto-expire gagal dibuat:** ${schedErr.message}. Role tidak akan auto-expire — admin harus lepas manual.`;
        }

        // 4. DM member
        // v3.9.22: /set-key tujuan awalnya buat GIFT (hadiah dari admin ke member),
        // BUKAN transaksi beli. Jadi DM-nya bilang "kamu dapat hadiah" — bukan
        // "transaksi selesai" (itu cuma untuk ticket Set Key).
        // Format tetap sama: emoji + role.name (bukan mention) + inline code
        // untuk key (HP-friendly tap-to-copy).
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
            const keyList = activeKeys
                .map((k, i) => {
                    const rem = formatRemaining(k);
                    return `${i + 1}. \`${k.key}\` (sisa ${rem})`;
                })
                .join('\n');

            // v3.9.17 FIX: sanitize backtick di keyValue.
            const safeKey = keyValue.replace(/`/g, "'");

            await member.send({
                content:
                    `Halo ${member.user.username}! Kamu dapat hadiah dari admin 🎁\n\n` +
                    `📦 Produk: ${product.label}\n` +
                    `🌐 Server: ${guild.name}\n\n` +
                    `🔑 KEY:\n` +
                    `\`${safeKey}\`\n\n` +
                    `🎭 Role: ${role.name}\n` +
                    `⏰ Expire: ${expireInfo}\n\n` +
                    `📋 Key aktif kamu untuk role ini:\n${keyList}\n\n` +
                    `💡 Simpan keynya. Kalau role tiba-tiba hilang padahal key masih aktif, hubungi admin.`
            });
            dmSent = true;
        } catch (_) {}

        // 5. P2-1 FIX: kirim invoice juga (sebelumnya hanya modal set key yang kirim invoice,
        //    /set-key slash command skip — inkonsistensi jejak transaksi).
        let invoiceSent = false;
        try {
            // Buat pseudo-channel dari guild untuk akses invoiceChannel.
            // sendInvoice mengambil channel dari channel.guild.channels.cache,
            // jadi kita oper interaction.channel (channel command dijalankan).
            if (interaction.channel && interaction.channel.guild) {
                invoiceSent = await sendInvoice(
                    interaction.channel,
                    member.id,
                    product.label,
                    product.price,
                    interaction.user
                );
            }
        } catch (err) {
            console.warn('Gagal kirim invoice dari /set-key:', err.message);
        }

        // 6. Track purchase untuk stats
        // v3.9.4: scoped per guild
        try {
            trackPurchase(interaction.guild.id, member.id, parsePriceNum(product.price));
        } catch (_) {}

        // 7. Audit log (P1-10 FIX: sebelumnya tidak ada logAudit untuk SET_KEY)
        // v3.9.1 FIX: jangan bocorkan key (bahkan sebagian) ke audit log channel.
        // Sebelumnya `keyValue.slice(0, 8)` membocorkan 8 char pertama key, yang
        // bisa ditebak orang yang punya akses ke audit-log channel. Sekarang
        // hanya tampilkan panjang key saja (untuk debugging), nilai key disembunyikan.
        await logAudit(interaction.client, {
            action: 'SET_KEY',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Set key untuk <@${member.id}> — produk: **${product.label}**, role: ${role.name}, key: \`***\` (len=${keyValue.length})`,
            guildId: interaction.guild.id
        });

        const expireStr =
            keyEntry.expireAt === null ? 'permanen' : `${Math.ceil((keyEntry.expireAt - Date.now()) / 86400000)} hari`;
        // v3.9.26 FIX: tampilkan key ter-truncate di reply konfirmasi. Key bisa
        // 200 char; wrapper reply (+info lain) bikin > 2000 → 50035 SETELAH semua
        // operasi sukses → admin lihat error generik dan mungkin retry (duplicate key).
        const keyDisplay = keyValue.length > 80 ? `${keyValue.slice(0, 60)}…(${keyValue.length} char)` : keyValue;
        return safeEditReply(interaction, {
            content:
                `✅ **Set Key sukses!**\n\n` +
                `👤 User: ${member}\n` +
                `📦 Produk: ${product.label}\n` +
                `🔑 Key: \`${keyDisplay}\`\n` +
                `🎭 Role: ${role}\n` +
                `⏰ Expire: ${expireStr}\n` +
                `${schedResult.extended ? '↳ Schedule di-extend (MAX EXTEND).' : schedResult.permanent ? '↳ Permanen, schedule lama dihapus.' : '↳ Schedule baru dibuat.'}\n` +
                `${dmSent ? '📬 DM terkirim.' : '⚠️ DM gagal (DM ditutup).'}\n` +
                `${invoiceSent ? '🧾 Invoice terkirim.' : '⚠️ Invoice tidak terkirim (channel invoice belum di-set).'}` +
                scheduleWarning
        });
    }

    // ====================================================
    // === /list-keys — LIHAT SEMUA KEY USER ===
    // ====================================================
    if (interaction.commandName === 'list-keys') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');

        // v3.9.8 FIX: guild-scoped. Sebelumnya pakai findAllByUser(userId) yang
        // return SEMUA key user di SEMUA guild → admin Guild A bisa lihat key
        // user yang dibeli di Guild B (cross-guild information disclosure).
        const allKeys = findAllByUser(user.id, interaction.guild.id);
        if (allKeys.length === 0) {
            return safeEditReply(interaction, { content: `📭 <@${user.id}> tidak punya key apa pun di server ini.` });
        }

        // Pisahkan jadi aktif & expired
        const now = Date.now();
        const active = allKeys.filter(k => k.expireAt === null || k.expireAt > now);
        const expired = allKeys.filter(k => k.expireAt !== null && k.expireAt <= now);

        const fields = [];
        if (active.length > 0) {
            fields.push({
                name: `✅ Key Aktif (${active.length})`,
                value: formatKeysForUser(active, now).slice(0, 1024),
                inline: false
            });
        }
        if (expired.length > 0) {
            fields.push({
                name: `⏰ Key Expired (${expired.length}) — akan dihapus otomatis`,
                value: formatKeysForUser(expired, now).slice(0, 1024),
                inline: false
            });
        }

        const embed = new EmbedBuilder()
            .setTitle(`🔑 Daftar Key — ${user.tag}`)
            .setDescription(`Total: **${allKeys.length}** key (${active.length} aktif, ${expired.length} expired)`)
            .setColor(0x5865f2)
            .addFields(fields)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /clear-schedule — HAPUS SCHEDULE (+ KEY) ===
    // ====================================================
    // v3.9.0 FIX: pass guildId supaya cross-guild wipe tidak terjadi.
    // Sebelumnya, removeAllByUser/removeAllKeysByUser hanya filter by userId,
    // yang berarti admin di Guild A bisa wipe key + schedule user di Guild B.
    if (interaction.commandName === 'clear-schedule') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const clearKeys = interaction.options.getBoolean('clear_keys') || false;
        const guildId = interaction.guild.id; // v3.9.0: scope to this guild only

        // v3.9.31 FIX: snapshot roleId milik user ini SEBELUM schedule/key dihapus
        // (via API data layer). Dipakai di bawah untuk tahu role mana yang harus
        // dilepas. Mengambil snapshot SETELAH hapus sudah terlambat (data sudah
        // hilang) — itu yang memicu workaround fs yang lama.
        const userScheduledRoleIds = new Set(
            findAllSchedulesByUser(user.id)
                .filter(e => e && e.roleId && (!e.guildId || e.guildId === guildId))
                .map(e => e.roleId)
        );
        const userKeyRoleIds = new Set(
            findAllByUser(user.id, guildId)
                .filter(k => k && k.roleId)
                .map(k => k.roleId)
        );

        // Hapus semua schedule milik user DI GUILD INI saja
        const removedSched = removeAllSchedulesByUser(user.id, guildId);

        // Hapus key kalau diminta (juga scoped to guild)
        let removedKeys = 0;
        if (clearKeys) {
            removedKeys = removeAllKeysByUser(user.id, guildId);
        }

        // Opsional: lepas semua role yang terkait schedule?
        // v3.9.17: scan config.products JUGA (bukan cuma scheduledRoles), karena
        // schedule user bisa sudah dihapus/expired duluan — role lama tetap nempel
        // selamanya kalau produknya sudah dihapus dari config.
        const rolesRemoved = [];
        const rolesFailed = []; // v3.9.8: track role yang gagal dilepas
        if (clearKeys) {
            const guild = interaction.guild;
            const member = await guild.members.fetch(user.id).catch(() => null);
            if (member) {
                // v3.9.17: kumpulkan roleId dari 2 sumber:
                //   1. config.products (yang masih ada di config)
                //   2. schedule/key milik user ini (snapshot sebelum dihapus — lihat atas)
                //      — bisa contain roleId untuk produk yang sudah dihapus dari config
                //
                // v3.9.31 FIX (2 masalah sekaligus, menggantikan blok fs lama):
                //   1. LAYERING — blok lama membaca data/scheduledRoles.json LANGSUNG
                //      via fs + path hardcode, melewati API roleScheduler. Kalau
                //      path/schema berubah, kode gagal diam-diam (catch ignore).
                //   2. HEURISTIC TERLALU BROAD — blok lama mengumpulkan roleId dari
                //      SEMUA entry scheduledRoles (termasuk milik USER LAIN) → role
                //      manual member yang kebetulan sama dengan role VIP terjadwal
                //      user lain ikut terlepas. Sekarang: kandidat role = snapshot
                //      milik user ini saja (schedule + key), plus config.products.
                const productRoleIds = new Set((config.products || []).filter(p => p.roleId).map(p => p.roleId));
                for (const rid of userScheduledRoleIds) productRoleIds.add(rid);
                for (const rid of userKeyRoleIds) productRoleIds.add(rid);

                for (const rid of productRoleIds) {
                    if (member.roles.cache.has(rid)) {
                        try {
                            await member.roles.remove(rid);
                            const r = guild.roles.cache.get(rid);
                            rolesRemoved.push(r ? r.name : rid);
                        } catch (_err) {
                            // v3.9.8 FIX: track failure. Sebelumnya catch swallow error
                            // silent → admin told "Clear selesai" padahal role tetap nempel
                            // selamanya (schedule sudah dihapus, gak akan auto-expire).
                            const r = guild.roles.cache.get(rid);
                            rolesFailed.push(r ? r.name : rid);
                        }
                    }
                }
            }
        }

        const msg =
            `🧹 **Clear selesai!**\n\n` +
            `👤 User: <@${user.id}>\n` +
            `📋 Schedule dihapus (guild ini): **${removedSched}**\n` +
            (clearKeys
                ? `🔑 Key dihapus (guild ini): **${removedKeys}**\n` +
                  (rolesRemoved.length > 0
                      ? `🎭 Role dilepas: ${rolesRemoved.map(n => `\`${n}\``).join(', ')}\n`
                      : '') +
                  (rolesFailed.length > 0
                      ? `⚠️ Role GAGAL dilepas (bot hierarki / permission): ${rolesFailed.map(n => `\`${n}\``).join(', ')} — LEPAS MANUAL!\n`
                      : '')
                : `ℹ️ Key TIDAK dihapus (clear_keys=false). Pakai \`clear_keys:true\` untuk reset total VIP.\n`);

        await logAudit(interaction.client, {
            action: 'CLEAR_SCHEDULE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Clear schedule <@${user.id}> di guild ${guildId}: ${removedSched} schedule${clearKeys ? ` + ${removedKeys} key${rolesRemoved.length > 0 ? ` + ${rolesRemoved.length} role` : ''}` : ' (tanpa key)'}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, { content: msg });
    }
};
