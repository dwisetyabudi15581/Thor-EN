/**
 * Domain: warn
 * Slash commands: /warn, /warn-list, /warn-remove, /warn-clear
 *
 * Dipisah dari handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: kelola warning user + auto-action (mute/kick) berdasarkan threshold.
 *
 * v3.9.0: scoped per guild.
 * v3.9.4: jangan markActionTaken kalau action gagal (silent enforcement failure).
 * v3.9.8: cek hierarki bot vs target — kasih warning kalau auto-action bakal gagal.
 */

const {
    EmbedBuilder,
    MessageFlags,
    addWarn,
    getWarns,
    getWarnCount,
    removeWarn,
    clearWarns,
    markActionTaken,
    WARN_THRESHOLDS,
    logAudit,
    safeEditReply
} = require('./_shared');

// v3.9.25: konversi \n literal → newline asli (fitur multi-line PC)
const { normalizeNewlines } = require('../infra/text');

module.exports = async function (interaction) {
    // ====================================================
    // === /warn ===
    // ====================================================
    if (interaction.commandName === 'warn') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        // v3.9.25: \n literal → newline asli biar alasan warning bisa multi-baris
        const reason = normalizeNewlines(interaction.options.getString('reason'));

        if (user.id === interaction.user.id) {
            return safeEditReply(interaction, { content: '❌ Tidak bisa warn diri sendiri.' });
        }
        if (user.bot) {
            return safeEditReply(interaction, { content: '❌ Tidak bisa warn bot.' });
        }

        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) {
            return safeEditReply(interaction, { content: `❌ User <@${user.id}> tidak ada di server.` });
        }

        // Cek hierarki: admin harus lebih tinggi dari target
        if (member.roles.highest.position >= interaction.member.roles.highest.position) {
            return safeEditReply(interaction, {
                content: '❌ Kamu tidak bisa warn member dengan role setingkat/lebih tinggi dari kamu.'
            });
        }

        // Cek hierarki bot vs target juga. Kalau target punya role lebih tinggi dari bot,
        // auto-action (timeout/kick) bakal throw "Missing Permissions".
        // Tapi record warn tetap dibuat — berguna buat catatan, meski auto-action gak jalan.
        // Jadi: jangan return, kasih flag warning aja, lanjut ke addWarn.
        const botMember = interaction.guild.members.me;
        let botHierarchyWarning = '';
        if (botMember && member.roles.highest.position >= botMember.roles.highest.position) {
            botHierarchyWarning = `\n\n⚠️ **Heads up:** Role bot (\`${botMember.roles.highest.name || 'top role'}\`) lebih rendah dari role tertinggi target (\`${member.roles.highest.name || 'top role'}\`). Bot gak bakal bisa eksekusi auto-action (timeout/kick) kalau mencapai threshold. Pindahin role bot ke atas role target di Server Settings → Roles biar auto-action jalan.`;
        }

        // v3.9.0: addWarn sekarang scoped per guild (guildId, userId, data)
        const result = addWarn(interaction.guild.id, user.id, {
            reason,
            warnedBy: interaction.user.id,
            warnedByTag: interaction.user.tag,
            guildId: interaction.guild.id
        });

        await logAudit(interaction.client, {
            action: 'WARN_ADD',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Warn <@${user.id}> (${user.tag}) — Reason: "${reason}" — Total: ${result.count} warn`,
            guildId: interaction.guild.id
        });

        // Eksekusi auto-action kalau perlu
        // P1-7 FIX: kalau actionAlreadyTaken=true, tidak re-apply timeout lagi
        // (user sudah pernah kena mute yang sama, jangan reset timer).
        // v3.9.4 FIX: kalau action gagal (e.g., bot kagak punya ModerateMembers permission),
        // jangan markActionTaken — sebelumnya markActionTaken dipanggil unconditional,
        // menyebabkan action selanjutnya yang sama di-skip (silent enforcement failure).
        let actionMsg = '';
        if (result.actionAlreadyTaken) {
            actionMsg = `\nℹ️ Auto-action tidak diulang (user sudah pernah kena action yang sama sebelumnya).`;
        } else if (result.actionToTake) {
            try {
                if (result.actionToTake === 'mute_1h' || result.actionToTake === 'mute_1d') {
                    const durationMin = result.actionToTake === 'mute_1h' ? 60 : 1440;
                    // Cari role mute (atau bikin timeout)
                    let muted = false;
                    try {
                        await member.timeout(durationMin * 60 * 1000, `Auto-action: ${result.count} warnings`);
                        muted = true;
                    } catch (err) {
                        actionMsg = `\n⚠️ Auto-action gagal: ${err.message}`;
                    }
                    if (muted) {
                        actionMsg = `\n🔇 **Auto-action:** Timeout ${durationMin === 60 ? '1 jam' : '1 hari'} (${result.count} warnings)`;
                        markActionTaken(interaction.guild.id, user.id, result.warnEntry.id, result.actionToTake);
                    }
                } else if (result.actionToTake === 'kick') {
                    let kicked = false;
                    try {
                        await member.kick(`Auto-action: ${result.count} warnings`);
                        kicked = true;
                    } catch (err) {
                        actionMsg = `\n⚠️ Auto-action gagal: ${err.message}`;
                    }
                    if (kicked) {
                        actionMsg = `\n👢 **Auto-action:** Kicked (${result.count} warnings)`;
                        markActionTaken(interaction.guild.id, user.id, result.warnEntry.id, result.actionToTake);
                    }
                }
            } catch (err) {
                actionMsg = `\n⚠️ Auto-action gagal: ${err.message}`;
            }
        }

        // DM user
        try {
            await user.send(
                `⚠️ **Kamu mendapat warning di ${interaction.guild.name}**\n\nReason: ${reason}\nTotal warnings: ${result.count}\n${result.actionToTake ? `Action: ${result.actionToTake}` : 'Belum ada auto-action (threshold: 3=mute 1h, 5=mute 1d, 7=kick)'}`
            );
        } catch (_) {}

        return safeEditReply(interaction, {
            content:
                `⚠️ **<@${user.id}> telah diwarn.**\n\n` +
                `📝 Reason: ${reason}\n` +
                `📊 Total warnings: **${result.count}**\n` +
                `👤 Oleh: ${interaction.user.tag}${actionMsg}${botHierarchyWarning}`
        });
    }

    // ====================================================
    // === /warn-list ===
    // ====================================================
    if (interaction.commandName === 'warn-list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        // v3.9.0: getWarns sekarang scoped per guild
        const warns = getWarns(interaction.guild.id, user.id);
        if (warns.length === 0) {
            return safeEditReply(interaction, { content: `✅ <@${user.id}> tidak punya warning.` });
        }
        const lines = warns
            .map((w, i) => {
                // v3.9.15: hapus dead variable `date` (sebelumnya dideklarasi tapi tidak dipakai)
                return `\`${i + 1}.\` 🆔 \`${w.id}\`\n   📝 ${w.reason}\n   👤 Oleh: ${w.warnedByTag} | ⏰ <t:${Math.floor(w.createdAt / 1000)}:R>${w.actionTaken ? ` | ⚡ ${w.actionTaken}` : ''}`;
            })
            .join('\n\n');
        const embed = new EmbedBuilder()
            .setTitle(`⚠️ WARN HISTORY — ${user.tag}`)
            .setDescription(
                `Total **${warns.length}** warning.\n\n${lines}\n\n**Threshold:**\n• ${WARN_THRESHOLDS.mute1h} warn → mute 1 jam\n• ${WARN_THRESHOLDS.mute1d} warn → mute 1 hari\n• ${WARN_THRESHOLDS.kick} warn → kick`
            )
            .setColor(
                warns.length >= WARN_THRESHOLDS.kick
                    ? 0xed4245
                    : warns.length >= WARN_THRESHOLDS.mute1h
                      ? 0xe67e22
                      : 0xfee75c
            )
            .setFooter({ text: `User ID: ${user.id}` })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /warn-remove ===
    // ====================================================
    if (interaction.commandName === 'warn-remove') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const warnId = interaction.options.getString('warn_id');
        // v3.9.0: removeWarn sekarang scoped per guild
        const ok = removeWarn(interaction.guild.id, user.id, warnId);
        if (!ok) {
            return safeEditReply(interaction, {
                content: `❌ Warn ID \`${warnId}\` tidak ditemukan untuk user <@${user.id}> di guild ini.`
            });
        }
        await logAudit(interaction.client, {
            action: 'WARN_REMOVE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Hapus warn \`${warnId}\` dari <@${user.id}>. Sisa: ${getWarnCount(interaction.guild.id, user.id)} warn`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ Warn \`${warnId}\` dihapus dari <@${user.id}>.\n📊 Sisa warnings: **${getWarnCount(interaction.guild.id, user.id)}**`
        });
    }

    // ====================================================
    // === /warn-clear ===
    // ====================================================
    if (interaction.commandName === 'warn-clear') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        // v3.9.0: clearWarns sekarang scoped per guild
        const count = clearWarns(interaction.guild.id, user.id);
        if (count === 0) {
            return safeEditReply(interaction, { content: `ℹ️ <@${user.id}> memang tidak punya warning di guild ini.` });
        }
        await logAudit(interaction.client, {
            action: 'WARN_CLEAR_ALL',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Clear ALL warns (${count}) dari <@${user.id}> di guild ini`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, {
            content: `✅ **${count}** warning dihapus dari <@${user.id}> di guild ini.`
        });
    }
};
