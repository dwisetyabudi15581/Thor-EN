/**
 * Domain: backup
 * Slash commands: /backup-now, /backup-list, /restore-backup
 *
 * Dipisah dari handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: backup manual, list backup, restore (dengan 2-step confirmation).
 *
 * v3.9.1: 2-step confirmation untuk restore (safety).
 * v3.9.8: wrap createBackup di try/catch (mencegah "Thinking..." 15 menit).
 */

const {
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    MessageFlags,
    createBackup,
    listBackups,
    formatBackupSize,
    logAudit,
    safeEditReply
} = require('./_shared');

module.exports = async function (interaction) {
    // ====================================================
    // === /backup-now ===
    // ====================================================
    if (interaction.commandName === 'backup-now') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        // v3.9.8 FIX: wrap createBackup di try/catch. Sebelumnya kalau throw
        // (disk full, permission error), outer catch di index.js lihat
        // interaction.deferred=true → skip reply → admin lihat "Thinking..." 15 menit.
        let result;
        try {
            result = createBackup();
        } catch (err) {
            console.error('Backup-now gagal:', err);
            return safeEditReply(interaction, { content: `❌ Gagal buat backup: ${err.message}` });
        }
        if (!result.ok) {
            // Bedain total failure vs partial biar admin tau severity
            if (result.partial) {
                return safeEditReply(interaction, {
                    content:
                        `⚠️ **Backup PARTIAL!** Hanya ${result.filesCopied} file berhasil disalin (sebagian gagal).\n\n` +
                        `❌ Error:\n\`\`\`\n${result.errors.join('\n')}\n\`\`\`\n` +
                        `💡 Backup tetap dibuat dengan file yang berhasil — tapi **tidak lengkap**. Cek disk space & permission file \`data/\`.`
                });
            }
            return safeEditReply(interaction, { content: `❌ Backup gagal total: ${result.errors.join('; ')}` });
        }
        try {
            await logAudit(interaction.client, {
                action: 'BACKUP_NOW',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Backup manual: \`${result.backupName}\` (${result.filesCopied} files, ${formatBackupSize(result.totalSize)})`,
                guildId: interaction.guild.id
            });
        } catch (auditErr) {
            console.warn(`⚠️ Gagal log audit backup (backup tetap dibuat): ${auditErr.message}`);
        }
        return safeEditReply(interaction, {
            content:
                `💾 **Backup berhasil dibuat!**\n\n` +
                `📁 Nama: \`${result.backupName}\`\n` +
                `📦 File disalin: **${result.filesCopied}**\n` +
                `📊 Ukuran total: **${formatBackupSize(result.totalSize)}**\n` +
                (result.errors.length > 0 ? `⚠️ Error: \`\`\`\n${result.errors.join('\n')}\n\`\`\`` : '') +
                `\n💡 Auto-backup berjalan tiap 24 jam + saat bot start. Maks 7 backup terbaru disimpan.`
        });
    }

    // ====================================================
    // === /backup-list ===
    // ====================================================
    if (interaction.commandName === 'backup-list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const backups = listBackups();
        if (backups.length === 0) {
            return safeEditReply(interaction, {
                content: '📭 Belum ada backup. Backup otomatis dibuat saat bot start.'
            });
        }
        const lines = backups
            .map((b, i) => {
                const ageMs = Date.now() - b.mtime.getTime();
                const ageMin = Math.floor(ageMs / 60000);
                const ageStr =
                    ageMin < 60
                        ? `${ageMin}m lalu`
                        : ageMin < 1440
                          ? `${Math.floor(ageMin / 60)}h lalu`
                          : `${Math.floor(ageMin / 1440)}d lalu`;
                return `\`${i + 1}.\` 📁 \`${b.name}\`\n   📦 ${b.fileCount} file | 📊 ${formatBackupSize(b.size)} | ⏰ ${ageStr}`;
            })
            .join('\n\n');
        const embed = new EmbedBuilder()
            .setTitle('💾 DAFTAR BACKUP')
            .setDescription(
                `Total **${backups.length}** backup tersimpan (maks 7, auto-clean yang lama).\n\n${lines}\n\n💡 Restore pakai: \`/restore-backup name:<nama-folder>\``
            )
            .setColor(0x57f287)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /restore-backup ===
    // ====================================================
    if (interaction.commandName === 'restore-backup') {
        // v3.9.1 FIX: tambah 2-step confirmation (sama seperti /reset-config).
        // Sebelumnya, /restore-backup langsung overwrite semua file JSON tanpa
        // konfirmasi. Kalau admin salah ketik nama backup, data hari ini hilang.
        // Sekarang: bot tampilkan preview + 2 tombol (Confirm / Cancel).
        const name = interaction.options.getString('name');

        // Pre-validate name SEBELUM show confirmation supaya pesan error jelas.
        const isPlainTimestamp = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name);
        const isPreRestore = /^pre-restore_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name);
        if (!isPlainTimestamp && !isPreRestore) {
            return interaction.reply({
                content: `❌ Format nama backup tidak valid: \`${name}\`\n\nFormat yang didukung: \`YYYY-MM-DD_HH-mm-ss\` atau \`pre-restore_YYYY-MM-DD_HH-mm-ss\`. Lihat \`/backup-list\`.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Stash name di metadata message supaya handler tombol bisa ambil.
        // Pakai interaction.user.id sebagai nonce untuk mencegah user lain klik
        // tombol konfirmasi (defense-in-depth — slash command sudah admin-gated).
        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`restore_backup_confirm:${interaction.user.id}:${name}`)
                .setLabel('⚠️ Ya, Restore Sekarang')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`restore_backup_cancel:${interaction.user.id}`)
                .setLabel('❌ Batal')
                .setStyle(ButtonStyle.Secondary)
        );

        return interaction.reply({
            content:
                `⚠️ **KONFIRMASI RESTORE BACKUP**\n\n` +
                `📁 Backup: \`${name}\`\n\n` +
                `**Apa yang akan terjadi kalau kamu klik Confirm:**\n` +
                `• Bot akan bikin safety backup otomatis (pre-restore) dari kondisi SEKARANG\n` +
                `• Semua file JSON (config, keys, scheduledRoles, warns, dll) akan ditimpa dengan versi dari backup ini\n` +
                `• Bot perlu di-restart supaya data baru ke-load penuh\n\n` +
                `**Tidak bisa di-undo** (kecuali restore ulang dari safety backup).\n\n` +
                `Klik tombol di bawah untuk lanjutkan atau batalkan.`,
            components: [confirmRow],
            flags: MessageFlags.Ephemeral
        });
    }
};
