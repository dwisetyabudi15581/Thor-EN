/**
 * Backup / reset config domain handler — button `reset_config_confirm`,
 * `reset_config_cancel`, `restore_backup_confirm:*`, `restore_backup_cancel:*`.
 *
 * Extracted from handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior preserved as-is — just moved to a new file.
 *
 * Helpers `handleResetConfigConfirm` and `handleRestoreBackupConfirm` are
 * LOCAL functions in this file.
 *
 * The router (src/interactions/index.js) already applies:
 *   - dedup (checkAndMark)
 *   - `replied/deferred` guard
 *   - interaction type check (button/select/modal)
 *   - routing by customId prefix (reset_config_ / restore_backup_)
 * So the domain handler can focus on its logic alone.
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
        // v3.9.26: wrap update — if the ephemeral was dismissed before the button
        // was clicked, update() throws 10008 → without a catch, the user sees "interaction failed"
        // with no message (asymmetric with the confirm button which is already handled).
        try {
            return await interaction.update({
                content: '✅ Config reset cancelled. No changes were made.',
                components: []
            });
        } catch (_) {
            return interaction
                .reply({
                    content: '✅ Config reset cancelled (the confirmation has already expired).',
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
                content: '❌ Only the admin who started this confirmation can cancel it.',
                flags: MessageFlags.Ephemeral
            });
        }
        // v3.9.26: wrap update — symmetric with reset_config_cancel (ephemeral
        // dismissed → update throws 10008).
        try {
            return await interaction.update({
                content: '✅ Backup restore cancelled. No changes were made.',
                components: []
            });
        } catch (_) {
            return interaction
                .reply({
                    content: '✅ Backup restore cancelled (the confirmation has already expired).',
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
 * Handle the "Yes, Full Reset" button that appears after an admin runs /reset-config.
 * Previously, /reset-config wiped all config immediately without confirmation.
 * Now, the admin must click this button for the reset to actually happen.
 */
async function handleResetConfigConfirm(interaction) {
    try {
        // Verify admin permission (defense-in-depth, even though slash command already gated)
        if (!isAdmin(interaction.member)) {
            return interaction.update({
                content: '❌ You don\'t have admin permissions. Reset cancelled.',
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
            details: '⚠️ FULL CONFIG RESET — all settings deleted (via 2-step confirm)',
            guildId: interaction.guild.id
        });

        return interaction.update({
            content:
                '⚠️ **ALL configuration has been reset.**\n\n' +
                'config.json is now empty. Set it up again:\n' +
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
        // v3.9.8 FIX: if error 10008 (Unknown Message — the admin dismissed the ephemeral),
        // interaction.update() throws. Fall back to an ephemeral interaction.reply()
        // so the admin still gets confirmation that the reset succeeded (or failed).
        const isUnknownMessage = err.code === 10008 || err.code === 10062;
        if (isUnknownMessage && !interaction.replied) {
            await interaction
                .reply({
                    content:
                        '✅ Config reset succeeded (the previous confirmation message could no longer be edited because it was dismissed).',
                    flags: MessageFlags.Ephemeral
                })
                .catch(() => {});
            return;
        }
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Reset failed: ${err.message}` }).catch(() => {});
        } else if (!interaction.replied) {
            await interaction.update({ content: `❌ Reset failed: ${err.message}`, components: [] }).catch(() => {});
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
        // backupName may contain ":" in edge cases, so join the remaining parts.
        const name = parts.slice(2).join(':');

        // Defense-in-depth: only the admin who started it can confirm.
        if (interaction.user.id !== ownerId) {
            return interaction.reply({
                content: '❌ Only the admin who started this confirmation can execute the restore.',
                flags: MessageFlags.Ephemeral
            });
        }

        // Verify admin permission (defense-in-depth, even though slash command already gated)
        if (!isAdmin(interaction.member)) {
            return interaction.update({
                content: '❌ You don\'t have admin permissions. Restore cancelled.',
                components: []
            });
        }

        const result = restoreBackup(name);
        if (!result.ok) {
            return interaction.update({
                content: `❌ Restore failed: ${result.errors[0]}\n\nUse \`/backup-list\` to see the list of valid backups.`,
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
                `♻️ **Restore successful!**\n\n` +
                `📁 From: \`${name}\`\n` +
                `📦 Files restored: **${result.filesRestored}**\n` +
                `💾 Backup taken before restore: \`${result.preRestoreName}\` (safety net)\n\n` +
                `⚠️ **RESTART the bot now** so the new data fully loads.\n\`\`\`bash\nnpm start\n\`\`\`\n` +
                (result.errors.length > 0 ? `⚠️ Error: \`\`\`\n${result.errors.join('\n')}\n\`\`\`` : ''),
            components: []
        });
    } catch (err) {
        console.error('Restore backup confirm error:', err);
        // v3.9.8 FIX: same as reset config — if 10008 (ephemeral dismissed),
        // fall back to reply() so the admin still gets confirmation.
        const isUnknownMessage = err.code === 10008 || err.code === 10062;
        if (isUnknownMessage && !interaction.replied) {
            await interaction
                .reply({
                    content:
                        '✅ Backup restore succeeded (the previous confirmation message could no longer be edited because it was dismissed). **RESTART the bot now** so the new data fully loads.',
                    flags: MessageFlags.Ephemeral
                })
                .catch(() => {});
            return;
        }
        if (interaction.deferred && !interaction.replied) {
            await safeEditReply(interaction, { content: `❌ Restore failed: ${err.message}` }).catch(() => {});
        } else if (!interaction.replied) {
            await interaction.update({ content: `❌ Restore failed: ${err.message}`, components: [] }).catch(() => {});
        }
    }
}
