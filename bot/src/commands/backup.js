/**
 * Domain: backup
 * Slash commands: /backup-now, /backup-list, /restore-backup
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: manual backup, list backups, restore (with 2-step confirmation).
 *
 * v3.9.1: 2-step confirmation for restore (safety).
 * v3.9.8: wrap createBackup in try/catch (prevents "Thinking..." for 15 minutes).
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
        // v3.9.8 FIX: wrap createBackup in try/catch. Previously, if it threw
        // (disk full, permission error), the outer catch in index.js saw
        // interaction.deferred=true → skipped the reply → admin saw "Thinking..." for 15 minutes.
        let result;
        try {
            result = createBackup();
        } catch (err) {
            console.error('Backup-now failed:', err);
            return safeEditReply(interaction, { content: `❌ Failed to create backup: ${err.message}` });
        }
        if (!result.ok) {
            // Distinguish total failure vs partial so the admin knows the severity
            if (result.partial) {
                return safeEditReply(interaction, {
                    content:
                        `⚠️ **PARTIAL BACKUP!** Only ${result.filesCopied} files were copied (some failed).\n\n` +
                        `❌ Errors:\n\`\`\`\n${result.errors.join('\n')}\n\`\`\`\n` +
                        `💡 A backup was still created from the successful files — but it is **incomplete**. Check disk space & permissions on the \`data/\` files.`
                });
            }
            return safeEditReply(interaction, { content: `❌ Total backup failure: ${result.errors.join('; ')}` });
        }
        try {
            await logAudit(interaction.client, {
                action: 'BACKUP_NOW',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Manual backup: \`${result.backupName}\` (${result.filesCopied} files, ${formatBackupSize(result.totalSize)})`,
                guildId: interaction.guild.id
            });
        } catch (auditErr) {
            console.warn(`⚠️ Failed to log backup audit (backup still created): ${auditErr.message}`);
        }
        return safeEditReply(interaction, {
            content:
                `💾 **Backup successfully created!**\n\n` +
                `📁 Name: \`${result.backupName}\`\n` +
                `📦 Files copied: **${result.filesCopied}**\n` +
                `📊 Total size: **${formatBackupSize(result.totalSize)}**\n` +
                (result.errors.length > 0 ? `⚠️ Errors: \`\`\`\n${result.errors.join('\n')}\n\`\`\`` : '') +
                `\n💡 Auto-backup runs every 24 hours + at bot start. The 7 most recent backups are kept.`
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
                content: '📭 No backups yet. An automatic backup is created at bot start.'
            });
        }
        const lines = backups
            .map((b, i) => {
                const ageMs = Date.now() - b.mtime.getTime();
                const ageMin = Math.floor(ageMs / 60000);
                const ageStr =
                    ageMin < 60
                        ? `${ageMin}m ago`
                        : ageMin < 1440
                          ? `${Math.floor(ageMin / 60)}h ago`
                          : `${Math.floor(ageMin / 1440)}d ago`;
                return `\`${i + 1}.\` 📁 \`${b.name}\`\n   📦 ${b.fileCount} file | 📊 ${formatBackupSize(b.size)} | ⏰ ${ageStr}`;
            })
            .join('\n\n');
        const embed = new EmbedBuilder()
            .setTitle('💾 BACKUP LIST')
            .setDescription(
                `Total **${backups.length}** backups stored (max 7, older ones auto-cleaned).\n\n${lines}\n\n💡 Restore with: \`/restore-backup name:<folder-name>\``
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
        // v3.9.1 FIX: add a 2-step confirmation (same as /reset-config).
        // Previously, /restore-backup immediately overwrote all JSON files without
        // confirmation. If the admin mistyped the backup name, today's data was gone.
        // Now: the bot shows a preview + 2 buttons (Confirm / Cancel).
        const name = interaction.options.getString('name');

        // Pre-validate the name BEFORE showing the confirmation so the error message is clear.
        const isPlainTimestamp = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name);
        const isPreRestore = /^pre-restore_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name);
        if (!isPlainTimestamp && !isPreRestore) {
            return interaction.reply({
                content: `❌ Invalid backup name format: \`${name}\`\n\nSupported formats: \`YYYY-MM-DD_HH-mm-ss\` or \`pre-restore_YYYY-MM-DD_HH-mm-ss\`. See \`/backup-list\`.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // Stash the name in the message metadata so the button handler can grab it.
        // Use interaction.user.id as a nonce to prevent other users from clicking
        // the confirm button (defense-in-depth — the slash command is already admin-gated).
        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`restore_backup_confirm:${interaction.user.id}:${name}`)
                .setLabel('⚠️ Yes, Restore Now')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`restore_backup_cancel:${interaction.user.id}`)
                .setLabel('❌ Cancel')
                .setStyle(ButtonStyle.Secondary)
        );

        return interaction.reply({
            content:
                `⚠️ **RESTORE BACKUP CONFIRMATION**\n\n` +
                `📁 Backup: \`${name}\`\n\n` +
                `**What happens if you click Confirm:**\n` +
                `• The bot will create an automatic safety backup (pre-restore) of the CURRENT state\n` +
                `• All JSON files (config, keys, scheduledRoles, warns, etc.) will be overwritten with this backup's versions\n` +
                `• The bot needs a restart to fully load the new data\n\n` +
                `**This cannot be undone** (except by restoring the safety backup).\n\n` +
                `Click a button below to continue or cancel.`,
            components: [confirmRow],
            flags: MessageFlags.Ephemeral
        });
    }
};
