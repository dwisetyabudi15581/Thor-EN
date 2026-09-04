/**
 * Domain: responder
 * Slash commands: /add-responder, /list-responder, /remove-responder
 *
 * v3.9.13: Auto-Responder system.
 * Admin set trigger keyword → bot auto-reply saat member kirim pesan yang diawali trigger.
 */

// v3.9.24: merge 2 require _shared yang duplikat jadi 1.
const { EmbedBuilder, MessageFlags, logAudit, safeEditReply } = require('./_shared');

const responderManager = require('../data/responderManager');
// v3.9.24: normalisasi \n literal → newline asli (input command di PC tidak bisa Enter).
// Deskripsi opsi /add-responder memang meng-claim "support \n" — sebelumnya
// klaim itu BOHONG (teks disimpan mentah, reply berisi literal backslash-n).
const { normalizeNewlines } = require('../infra/text');

module.exports = async function (interaction) {
    // === ADD RESPONDER ===
    if (interaction.commandName === 'add-responder') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const trigger = interaction.options.getString('trigger');
        const reply = normalizeNewlines(interaction.options.getString('reply'));
        const replyType = interaction.options.getString('reply_type') || 'text';
        const cooldown = interaction.options.getInteger('cooldown');

        // Validasi cooldown gak boleh negatif. 0 = matiin cooldown.
        if (cooldown !== null && cooldown < 0) {
            return safeEditReply(interaction, {
                content: '❌ `cooldown` gak boleh negatif. Pakai 0 buat matiin cooldown, atau minimal 1 detik.'
            });
        }

        const result = responderManager.addResponder(interaction.guild.id, {
            trigger,
            reply,
            replyType,
            cooldownMs: cooldown !== null ? cooldown * 1000 : 3000, // 0 = matiin, null = default 3s
            createdBy: interaction.user.id,
            createdByTag: interaction.user.tag
        });

        if (!result.ok) {
            return safeEditReply(interaction, { content: `❌ ${result.error}` });
        }

        await logAudit(interaction.client, {
            action: 'ADD_RESPONDER',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Tambah responder: trigger \`${result.responder.trigger}\` → "${reply.slice(0, 80)}${reply.length > 80 ? '...' : ''}"`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ Responder ditambahkan!\n\n` +
                `🔤 Trigger: \`${result.responder.trigger}\`\n` +
                `💬 Reply: ${reply.slice(0, 200)}${reply.length > 200 ? '...' : ''}\n` +
                `📝 Type: ${replyType}\n` +
                `⏱️ Cooldown: ${result.responder.cooldownMs / 1000}s\n\n` +
                `💡 Member kirim pesan yang diawali \`${result.responder.trigger}\` → bot auto-reply.`
        });
    }

    // === LIST RESPONDER ===
    if (interaction.commandName === 'list-responder') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const responders = responderManager.getGuildResponders(interaction.guild.id);
        if (responders.length === 0) {
            return safeEditReply(interaction, {
                content: '📭 Belum ada responder. Pakai `/add-responder trigger:"!sosmed" reply:"..."` untuk tambah.'
            });
        }

        const lines = responders
            .map((r, i) => {
                const replyPreview = r.reply.length > 60 ? r.reply.slice(0, 60) + '...' : r.reply;
                return `\`${i + 1}.\` \`${r.trigger}\` → ${replyPreview} *(used ${r.useCount}x)*`;
            })
            .join('\n');

        const embed = new EmbedBuilder()
            .setTitle('💬 DAFTAR AUTO-RESPONDER')
            .setDescription(lines)
            .setColor(0x5865f2)
            .setFooter({ text: `${responders.length}/50 responder terpakai` })
            .setTimestamp();

        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === REMOVE RESPONDER ===
    if (interaction.commandName === 'remove-responder') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const trigger = interaction.options.getString('trigger');
        const result = responderManager.removeResponder(interaction.guild.id, trigger);

        if (!result.ok) {
            return safeEditReply(interaction, { content: `❌ ${result.error}` });
        }

        await logAudit(interaction.client, {
            action: 'REMOVE_RESPONDER',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Hapus responder: trigger \`${trigger}\``,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content: `✅ Responder dengan trigger \`${trigger}\` berhasil dihapus.`
        });
    }
};
