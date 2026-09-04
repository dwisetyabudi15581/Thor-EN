/**
 * Backup / reset config domain handler — button `reset_config_confirm`,
 * `reset_config_cancel`, `restore_backup_confirm:*`, `restore_backup_cancel:*`.
 *
 * Di-ekstrak dari handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior dipertahankan apa adanya — hanya pindah file.
 *
 * Helper `handleResetConfigConfirm` dan `handleRestoreBackupConfirm` jadi
 * LOCAL function di file ini.
 *
 * Router (src/interactions/index.js) sudah apply:
 *   - dedup (checkAndMark)
 *   - guard `replied/deferred`
 *   - cek tipe interaction (button/select/modal)
 *   - routing by customId prefix (reset_config_ / restore_backup_)
 * Jadi domain handler fokus ke logic-nya saja.
 */

const { MessageFlags } = require('discord.js');
const { safeEditReply } = require('../commands/_shared');
const { saveConfig, DEFAULTS } = require('../data/configManager');
const { isAdmin } = require('../infra/permissions');
const { restoreBackup } = require('../data/backupManager');
const { logAudit } = require('../infra/auditLog');

module.exports = async function (interaction) {
    // ====================================================
    // === v3.9.0: RESET CONFIG — Confirmation button handlers ===
    // ====================================================
    if (interaction.isButton() && interaction.customId === 'reset_config_confirm') {
        return handleResetConfigConfirm(interaction);
    }
    if (interaction.isButton() && interaction.customId === 'reset_config_cancel') {
        // v3.9.26: wrap update — kalau ephemeral sudah di-dismiss sebelum tombol
        // diklik, update() throw 10008 → tanpa catch, user lihat "interaction failed"
        // tanpa pesan (asimetris dengan tombol confirm yang sudah di-handle).
        try {
            return await interaction.update({
                content: '✅ Reset config dibatalkan. Tidak ada perubahan yang dilakukan.',
                components: []
            });
        } catch (_) {
            return interaction
                .reply({
                    content: '✅ Reset config dibatalkan (konfirmasi sudah kedaluwarsa).',
                    flags: MessageFlags.Ephemeral
                })
                .catch(() => {});
        }
    }

    // ====================================================
    // === v3.9.1: RESTORE BACKUP — Confirmation button handlers ===
    // ====================================================
    if (interaction.isButton() && interaction.customId.startsWith('restore_backup_confirm:')) {
        return handleRestoreBackupConfirm(interaction);
    }
    if (interaction.isButton() && interaction.customId.startsWith('restore_backup_cancel:')) {
        const parts = interaction.customId.split(':');
        const ownerId = parts[1];
        if (interaction.user.id !== ownerId) {
            return interaction.reply({
                content: '❌ Hanya admin yang memulai konfirmasi ini yang bisa membatalkan.',
                flags: MessageFlags.Ephemeral
            });
        }
        // v3.9.26: wrap update — symetris dengan reset_config_cancel (ephemeral
        // di-dismiss → update throw 10008).
        try {
            return await interaction.update({
                content: '✅ Restore backup dibatalkan. Tidak ada perubahan yang dilakukan.',
                components: []
            });
        } catch (_) {
            return interaction
                .reply({
                    content: '✅ Restore backup dibatalkan (konfirmasi sudah kedaluwarsa).',
                    flags: MessageFlags.Ephemeral
                })
                .catch(() => {});
        }
    }
};

// ====================================================
// === v3.9.0: HELPER — Reset Config Confirmation ===
// ====================================================
/**
 * Handle tombol "Ya, Reset Total" yang muncul setelah admin jalankan /reset-config.
 * Sebelumnya, /reset-config langsung hapus semua config tanpa konfirmasi.
 * Sekarang, admin harus klik tombol ini untuk benar-benar reset.
 */
async function handleResetConfigConfirm(interaction) {
    try {
        // Verify admin permission (defense-in-depth, even though slash command already gated)
        if (!isAdmin(interaction.member)) {
            return interaction.update({
                content: '❌ Kamu tidak punya permission admin. Reset dibatalkan.',
                components: []
            });
        }

        const fresh = {
            roles: {},
            channels: {},
            messages: { ...DEFAULTS.messages },
            colors: { ...DEFAULTS.colors },
            products: []
        };
        saveConfig(fresh);

        await logAudit(interaction.client, {
            action: 'RESET_CONFIG',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: '⚠️ RESET CONFIG TOTAL — semua setting dihapus (via 2-step confirm)',
            guildId: interaction.guild.id
        });

        return interaction.update({
            content:
                '⚠️ **SEMUA konfigurasi berhasil direset.**\n\n' +
                'Sekarang config.json kosong. Silakan set ulang:\n' +
                '• `/set-role verified @role`\n' +
                '• `/set-role unverified @role`\n' +
                '• `/set-role admin @role`\n' +
                '• `/set-channel welcome #channel`\n' +
                '• `/set-channel goodbye #channel`\n' +
                '• `/set-channel invoice #channel`\n' +
                '• `/set-channel transcript #channel`\n' +
                '• `/add-product label value price duration`',
            components: []
        });
    } catch (err) {
        console.error('Reset config confirm error:', err);
        // v3.9.8 FIX: kalau error 10008 (Unknown Message — ephemeral di-dismiss admin),
        // interaction.update() akan throw. Fallback ke interaction.reply() ephemeral
        // supaya admin tetap dapat konfirmasi bahwa reset sudah sukses (atau gagal).
        const isUnknownMessage = err.code === 10008 || err.code === 10062;
        if (isUnknownMessage && !interaction.replied) {
            await interaction
                .reply({
                    content:
                        '✅ Reset config berhasil (pesan konfirmasi sebelumnya sudah tidak bisa di-edit karena di-dismiss).',
                    flags: MessageFlags.Ephemeral
                })
                .catch(() => {});
            return;
        }
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Gagal reset: ${err.message}` }).catch(() => {});
        } else if (!interaction.replied) {
            await interaction.update({ content: `❌ Gagal reset: ${err.message}`, components: [] }).catch(() => {});
        }
    }
}

// ====================================================
// === v3.9.1: HELPER: RESTORE BACKUP CONFIRM ===
// ====================================================
async function handleRestoreBackupConfirm(interaction) {
    try {
        // customId: restore_backup_confirm:<ownerUserId>:<backupName>
        const parts = interaction.customId.split(':');
        const ownerId = parts[1];
        // backupName bisa mengandung ":" kalau ada edge case, jadi join sisa parts.
        const name = parts.slice(2).join(':');

        // Defense-in-depth: hanya admin yang memulai yang bisa konfirmasi.
        if (interaction.user.id !== ownerId) {
            return interaction.reply({
                content: '❌ Hanya admin yang memulai konfirmasi ini yang bisa mengeksekusi restore.',
                flags: MessageFlags.Ephemeral
            });
        }

        // Verify admin permission (defense-in-depth, even though slash command already gated)
        if (!isAdmin(interaction.member)) {
            return interaction.update({
                content: '❌ Kamu tidak punya permission admin. Restore dibatalkan.',
                components: []
            });
        }

        const result = restoreBackup(name);
        if (!result.ok) {
            return interaction.update({
                content: `❌ Gagal restore: ${result.errors[0]}\n\nPakai \`/backup-list\` untuk lihat daftar backup yang valid.`,
                components: []
            });
        }

        await logAudit(interaction.client, {
            action: 'RESTORE_BACKUP',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Restore backup \`${name}\` (${result.filesRestored} files, via 2-step confirm). Pre-restore backup: \`${result.preRestoreName}\``,
            guildId: interaction.guild.id
        });

        return interaction.update({
            content:
                `♻️ **Restore berhasil!**\n\n` +
                `📁 Dari: \`${name}\`\n` +
                `📦 File dipulihkan: **${result.filesRestored}**\n` +
                `💾 Backup sebelum restore: \`${result.preRestoreName}\` (safety net)\n\n` +
                `⚠️ **RESTART bot sekarang** supaya data baru ke-load penuh.\n\`\`\`bash\nnpm start\n\`\`\`\n` +
                (result.errors.length > 0 ? `⚠️ Error: \`\`\`\n${result.errors.join('\n')}\n\`\`\`` : ''),
            components: []
        });
    } catch (err) {
        console.error('Restore backup confirm error:', err);
        // v3.9.8 FIX: sama seperti reset config — kalau 10008 (ephemeral dismissed),
        // fallback ke reply() supaya admin tetap dapat konfirmasi.
        const isUnknownMessage = err.code === 10008 || err.code === 10062;
        if (isUnknownMessage && !interaction.replied) {
            await interaction
                .reply({
                    content:
                        '✅ Restore backup berhasil (pesan konfirmasi sebelumnya sudah tidak bisa di-edit karena di-dismiss). **RESTART bot sekarang** supaya data baru ke-load penuh.',
                    flags: MessageFlags.Ephemeral
                })
                .catch(() => {});
            return;
        }
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Gagal restore: ${err.message}` }).catch(() => {});
        } else if (!interaction.replied) {
            await interaction.update({ content: `❌ Gagal restore: ${err.message}`, components: [] }).catch(() => {});
        }
    }
}
