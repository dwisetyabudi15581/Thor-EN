/**
 * Domain: send-message
 * Slash commands: /send-message
 *
 * Dipisah dari handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: kirim plain text ke channel (bukan embed — pelengkap /announce).
 *
 * v3.9.5: pelengkap /announce (embed). /send-message kirim plain text biasa.
 * - Support \n untuk newline (di-escape otomatis dari slash command input)
 * - Mention divalidasi ketat (sama seperti /announce)
 * - Channel harus berupa text channel (GuildText) — bukan voice/category/forum.
 * - Discord limit 2000 char untuk message content.
 */

const { MessageFlags, ChannelType, logAudit, safeEditReply, DISCORD_LIMITS } = require('./_shared');
// v3.9.24: normalisasi \n literal → newline asli (input command di PC tidak bisa Enter).
const { normalizeNewlines } = require('../infra/text');

module.exports = async function (interaction) {
    if (interaction.commandName !== 'send-message') return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.options.getChannel('channel');
    const rawMessage = interaction.options.getString('message');
    const mention = interaction.options.getString('mention');

    // === Validasi channel ===
    // type 0 = GuildText (Discord.js v14 ChannelType.GuildText)
    // Reject voice, category, forum, announcement thread, dll.
    if (!channel || channel.type !== ChannelType.GuildText) {
        return safeEditReply(interaction, {
            content:
                '❌ Channel harus berupa **text channel**.\n\n' +
                'Tip: pilih channel text biasa dari dropdown — bukan voice, category, atau forum.'
        });
    }

    // === Resolve target channel dari guild cache (bukan dari interaction option yang bisa stale) ===
    const targetChannel = interaction.guild.channels.cache.get(channel.id);
    if (!targetChannel) {
        return safeEditReply(interaction, { content: '❌ Channel tidak ditemukan di guild ini.' });
    }

    // Cek permission bot untuk send message di channel tujuan
    if (!targetChannel.permissionsFor(interaction.guild.members.me)?.has('SendMessages')) {
        return safeEditReply(interaction, {
            content:
                `❌ Bot tidak punya permission **Send Messages** di ${targetChannel}.\n\n` +
                'Berikan permission ke bot atau pilih channel lain.'
        });
    }

    // === Proses pesan: unescape \n / \r\n literal → newline asli ===
    // v3.9.24: pindah ke helper bersama (infra/text) supaya konsisten dengan
    // /announce, /announce-schedule, /setup-ticket-panel, dan /add-responder.
    // Sebelumnya inline di sini aja (satu-satunya command yang support \n).
    const message = normalizeNewlines(rawMessage);

    // === Validasi panjang pesan (Discord limit 2000 char) ===
    if (message.length > DISCORD_LIMITS.MESSAGE_CONTENT) {
        return safeEditReply(interaction, {
            content:
                `❌ Pesan terlalu panjang (${message.length} char, maks ${DISCORD_LIMITS.MESSAGE_CONTENT} char).\n\n` +
                'Tip: pecah jadi 2 pesan, atau pakai `/announce` yang support description 4096 char.'
        });
    }
    if (message.trim().length === 0 && !mention) {
        return safeEditReply(interaction, { content: '❌ Pesan tidak boleh kosong.' });
    }

    // === Validasi mention (sama ketatnya dengan /announce) ===
    // Hanya format berikut yang diterima:
    //   - @everyone / everyone
    //   - @here / here
    //   - <@&ROLE_ID>      (role mention)
    //   - <@USER_ID>       (user mention)
    //   - <@!USER_ID>      (user mention, old format)
    // Selain itu → reject (mencegah injection mention yang tidak diinginkan)
    let mentionContent = '';
    if (mention) {
        const m = mention.trim().toLowerCase();
        if (m === 'everyone' || m === '@everyone') {
            mentionContent = '@everyone';
        } else if (m === 'here' || m === '@here') {
            mentionContent = '@here';
        } else if (/^<@&\d{17,20}>$/.test(mention)) {
            mentionContent = mention;
        } else if (/^<@!?\d{17,20}>$/.test(mention)) {
            mentionContent = mention;
        } else {
            return safeEditReply(interaction, {
                content:
                    `❌ Format mention tidak valid: \`${mention}\`\n\n` +
                    'Format yang didukung:\n' +
                    '• `@everyone` atau `everyone`\n' +
                    '• `@here` atau `here`\n' +
                    '• `<@&ROLE_ID>` (mention role)\n' +
                    '• `<@USER_ID>` (mention user)\n\n' +
                    'Tip: untuk mention role, ketik `@rolename` di Discord lalu copy hasilnya.'
            });
        }
    }

    // === Gabungkan mention + pesan ===
    // Mention diletakkan di depan, dipisahkan newline dari body pesan.
    const finalContent = mentionContent ? `${mentionContent}\n${message}`.trim() : message;

    // Safety net: kalau setelah digabung ternyata > 2000 char (jarang, tapi mention + body bisa overflow)
    if (finalContent.length > DISCORD_LIMITS.MESSAGE_CONTENT) {
        return safeEditReply(interaction, {
            content: `❌ Total panjang (mention + pesan) melebihi ${DISCORD_LIMITS.MESSAGE_CONTENT} char. Persingkat pesan atau hilangkan mention.`
        });
    }

    // === Kirim pesan ===
    try {
        await targetChannel.send({ content: finalContent, allowedMentions: { parse: ['everyone', 'roles', 'users'] } });
        await logAudit(interaction.client, {
            action: 'SEND_MESSAGE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Kirim plain text message ke ${targetChannel}${mentionContent ? ` | mention: ${mentionContent}` : ''} | ${message.length} char`,
            guildId: interaction.guild.id
        });

        // Preview di ephemeral reply (potong kalau > 1500 char biar tidak overflow)
        const preview =
            finalContent.length > 1500
                ? finalContent.slice(0, 1500) + '\n...*(pesan dipotong untuk preview)*'
                : finalContent;

        return safeEditReply(interaction, {
            content: `✅ Pesan terkirim ke ${targetChannel}!\n\n📋 **Preview:**\n\`\`\`\n${preview}\n\`\`\``
        });
    } catch (err) {
        return safeEditReply(interaction, {
            content: `❌ Gagal kirim pesan ke ${targetChannel}: \`${err.message}\``
        });
    }
};
