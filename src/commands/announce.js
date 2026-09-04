/**
 * Domain: announce
 * Slash commands: /announce, /announce-schedule, /announce-list, /announce-cancel
 *
 * Dipisah dari handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: kirim embed announce ke channel (quick / scheduled).
 *
 * v3.9.1: validasi mention ketat (no injection).
 * v3.9.3: validate Discord embed length limits.
 * v3.9.8: pisahkan logAudit dari send supaya audit failure tidak abort announce.
 */

const {
    EmbedBuilder,
    MessageFlags,
    createScheduledAnn,
    getScheduledAnnsByGuild,
    getScheduledAnn,
    removeScheduledAnn,
    parseAnnTime,
    parseColor,
    logAudit,
    safeEditReply,
    EMBED_LIMITS
} = require('./_shared');
// v3.9.24: normalisasi \n literal → newline asli (input command di PC tidak bisa Enter).
// v3.9.38: truncateUtf8Safe — potong teks per code point (emoji aman) untuk cap description.
const { normalizeNewlines, truncateUtf8Safe } = require('../infra/text');
// v3.9.38 FIX: ChannelType untuk validasi tipe channel tujuan announce
// (kategori/forum/voice tidak bisa menerima pesan announce).
const { ChannelType } = require('discord.js');

module.exports = async function (interaction) {
    // ====================================================
    // === /announce — QUICK ANNOUNCE (1 command, 1 embed) ===
    // ====================================================
    if (interaction.commandName === 'announce') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const channel = interaction.options.getChannel('channel');

        // v3.9.38 FIX: validasi tipe channel — kategori/forum/voice tidak bisa
        // terima announce. Sebelumnya baru gagal di send() dengan error generik.
        // GuildAnnouncement (type 5) boleh — channel itu memang untuk broadcast.
        if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
            return safeEditReply(interaction, {
                content: '❌ Channel harus text channel biasa (bukan kategori/forum/voice).'
            });
        }

        const title = interaction.options.getString('title');
        // v3.9.24: dukung \n literal → newline asli (dulu cuma /send-message yang support).
        // Normalisasi SEBELUM validasi panjang supaya limit dihitung pada teks final.
        const description = normalizeNewlines(interaction.options.getString('description'));
        const colorStr = interaction.options.getString('color');
        const image = interaction.options.getString('image');
        const thumbnail = interaction.options.getString('thumbnail');
        const mention = interaction.options.getString('mention');

        // Parse color
        let color = 0x5865f2; // default blurple
        if (colorStr) {
            const parsed = parseColor(colorStr);
            if (parsed === null) {
                return safeEditReply(interaction, {
                    content: `❌ Color tidak valid: \`${colorStr}\`. Pakai format hex 6 digit, mis. \`#FF0000\` atau \`FF0000\`.`
                });
            }
            color = parsed;
        }

        // v3.9.3: validate Discord embed length limits sebelum setTitle/setDescription.
        // Discord API akan throw RangeError kalau title > 256 atau description > 4096,
        // yang sebelumnya ditangkap outer try-catch sebagai "Terjadi error" generik.
        if (title.length > EMBED_LIMITS.TITLE) {
            return safeEditReply(interaction, {
                content: `❌ Title terlalu panjang (${title.length} char, maks ${EMBED_LIMITS.TITLE}).`
            });
        }
        if (description.length > EMBED_LIMITS.DESCRIPTION) {
            return safeEditReply(interaction, {
                content: `❌ Description terlalu panjang (${description.length} char, maks ${EMBED_LIMITS.DESCRIPTION}).`
            });
        }

        // Validate URLs
        if (image && !/^https?:\/\//i.test(image)) {
            return safeEditReply(interaction, { content: '❌ Image URL harus mulai dengan `http://` atau `https://`' });
        }
        if (thumbnail && !/^https?:\/\//i.test(thumbnail)) {
            return safeEditReply(interaction, {
                content: '❌ Thumbnail URL harus mulai dengan `http://` atau `https://`'
            });
        }

        // Build embed
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description)
            .setColor(color)
            .setFooter({
                text: `Diumumkan oleh ${interaction.user.tag}`,
                iconURL: interaction.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        if (image) embed.setImage(image);
        if (thumbnail) embed.setThumbnail(thumbnail);

        // Resolve target channel
        const targetChannel = interaction.guild.channels.cache.get(channel.id);
        if (!targetChannel) {
            return safeEditReply(interaction, { content: '❌ Channel tidak ditemukan.' });
        }

        // Build content (mention)
        // v3.9.1 FIX: validasi mention secara ketat. Sebelumnya, admin bisa
        // oper string bebas sebagai `mention` (mis. "halo @everyone dunia")
        // yang akan bocor ke channel tujuan dan trigger ping yang tidak
        // diinginkan. Sekarang hanya format berikut yang diterima:
        //   - @everyone / everyone
        //   - @here / here
        //   - <@&ROLE_ID>      (role mention)
        //   - <@USER_ID>       (user mention)
        //   - <@!USER_ID>      (user mention, old format)
        // Selain itu → reject dengan pesan error.
        let content = undefined;
        if (mention) {
            const m = mention.trim().toLowerCase();
            if (m === 'everyone' || m === '@everyone') {
                content = '@everyone';
            } else if (m === 'here' || m === '@here') {
                content = '@here';
            } else if (/^<@&\d{17,20}>$/.test(mention)) {
                // Role mention: <@&123456789012345678>
                content = mention;
            } else if (/^<@!?\d{17,20}>$/.test(mention)) {
                // User mention: <@123456789012345678> or <@!123456789012345678>
                content = mention;
            } else {
                return safeEditReply(interaction, {
                    content:
                        `❌ Format mention tidak valid: \`${mention}\`\n\n` +
                        `Format yang didukung:\n` +
                        `• \`@everyone\` atau \`everyone\`\n` +
                        `• \`@here\` atau \`here\`\n` +
                        `• \`<@&ROLE_ID>\` (mention role)\n` +
                        `• \`<@USER_ID>\` (mention user)\n\n` +
                        `Tip: untuk mention role, ketik \`@rolename\` di Discord lalu copy hasilnya.`
                });
            }
        }

        try {
            await targetChannel.send({ content, embeds: [embed] });
            // v3.9.8 FIX: pisahkan logAudit dari send supaya kalau audit throw
            // (audit channel hilang / DB write error), admin tidak diberi tahu
            // "Gagal kirim ke channel" padahal announce sudah terkirim.
            try {
                await logAudit(interaction.client, {
                    action: 'ANNOUNCE_SEND',
                    actorId: interaction.user.id,
                    actorTag: interaction.user.tag,
                    details: `Kirim announce ke ${targetChannel}: **${title}**${mention ? ` | mention: ${mention}` : ''}`,
                    guildId: interaction.guild.id
                });
            } catch (auditErr) {
                console.warn(`⚠️ Gagal log audit announce (announce tetap terkirim): ${auditErr.message}`);
            }
            return safeEditReply(interaction, {
                content: `✅ Announce terkirim ke ${targetChannel}!\n\n📋 **Preview:**`,
                embeds: [embed]
            });
        } catch (err) {
            return safeEditReply(interaction, { content: `❌ Gagal kirim ke ${targetChannel}: ${err.message}` });
        }
    }

    // ====================================================
    // === /announce-schedule ===
    // ====================================================
    if (interaction.commandName === 'announce-schedule') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const channel = interaction.options.getChannel('channel');

        // v3.9.38 FIX: validasi tipe channel — sama seperti /announce. Sebelumnya
        // kategori/voice lolos → announce terjadwal, lalu GAGAL SENYAP saat fire
        // time (entry mubazir, admin baru sadar announce tidak pernah terkirim).
        if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
            return safeEditReply(interaction, {
                content: '❌ Channel harus text channel biasa (bukan kategori/forum/voice).'
            });
        }

        const title = interaction.options.getString('title');
        // v3.9.24: dukung \n literal → newline asli (konsisten dengan /announce).
        const description = normalizeNewlines(interaction.options.getString('description'));
        const at = interaction.options.getString('at');
        const color = interaction.options.getString('color');
        const image = interaction.options.getString('image');
        const thumbnail = interaction.options.getString('thumbnail');
        const mention = interaction.options.getString('mention');
        const recurring = interaction.options.getString('recurring') || null;

        // Parse time
        const sendAt = parseAnnTime(at);
        if (!sendAt) {
            return safeEditReply(interaction, {
                content:
                    '❌ Format waktu tidak valid.\n\nFormat yang didukung:\n• Relative: `30m`, `2h`, `1d`\n• Absolute: `2026-01-15 20:00` (zona waktu bot — default WITA/UTC+8, bisa diubah via env TZ_OFFSET_HOURS; format YYYY-MM-DD HH:MM)'
            });
        }
        if (sendAt <= Date.now()) {
            return safeEditReply(interaction, {
                content: '❌ Waktu yang dimasukkan sudah lewat. Pakai waktu di masa depan.'
            });
        }

        // Parse color
        let colorNum = 0x5865f2;
        if (color) {
            const parsed = parseColor(color);
            if (parsed === null) {
                return safeEditReply(interaction, {
                    content: `❌ Color tidak valid: \`${color}\`. Pakai format hex 6 digit, mis. \`#FF0000\` atau \`FF0000\`.`
                });
            }
            colorNum = parsed;
        }

        // v3.9.3: validate Discord embed length limits (sama seperti /announce).
        // Embedded announce dikirim saat scheduled time; kalau title/description
        // kelebihan, EmbedBuilder akan throw saat processScheduledAnnouncement
        // jalan → announce gagal terkirim dan entry stuck di scheduledAnns.json.
        if (title.length > EMBED_LIMITS.TITLE) {
            return safeEditReply(interaction, {
                content: `❌ Title terlalu panjang (${title.length} char, maks ${EMBED_LIMITS.TITLE}).`
            });
        }
        if (description.length > EMBED_LIMITS.DESCRIPTION) {
            return safeEditReply(interaction, {
                content: `❌ Description terlalu panjang (${description.length} char, maks ${EMBED_LIMITS.DESCRIPTION}).`
            });
        }

        // Validate URLs
        if (image && !/^https?:\/\//.test(image)) {
            return safeEditReply(interaction, { content: '❌ Image URL harus mulai dengan `http://` atau `https://`' });
        }
        if (thumbnail && !/^https?:\/\//.test(thumbnail)) {
            return safeEditReply(interaction, {
                content: '❌ Thumbnail URL harus mulai dengan `http://` atau `https://`'
            });
        }

        // v3.9.1 FIX: validasi mention (sama seperti /announce) supaya admin
        // tidak bisa inject string bebas yang memicu ping tidak diinginkan.
        if (mention) {
            const m = mention.trim().toLowerCase();
            const isValidMention =
                m === 'everyone' ||
                m === '@everyone' ||
                m === 'here' ||
                m === '@here' ||
                /^<@&\d{17,20}>$/.test(mention) ||
                /^<@!?\d{17,20}>$/.test(mention);
            if (!isValidMention) {
                return safeEditReply(interaction, {
                    content: `❌ Format mention tidak valid: \`${mention}\`\n\nFormat yang didukung: \`@everyone\`, \`@here\`, \`<@&ROLE_ID>\`, \`<@USER_ID>\`.`
                });
            }
        }

        const entry = createScheduledAnn({
            guildId: interaction.guild.id,
            channelId: channel.id,
            sendAt,
            title,
            description,
            color: colorNum,
            image,
            thumbnail,
            mention,
            authorId: interaction.user.id,
            authorTag: interaction.user.tag,
            recurring
        });

        await logAudit(interaction.client, {
            action: 'ANNOUNCE_SCHEDULE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Schedule announce ke ${channel} pada <t:${Math.floor(sendAt / 1000)}:F>${recurring ? ` (recurring: ${recurring})` : ''} — Title: "${title}"`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ **Announce dijadwalkan!**\n\n` +
                `📍 Channel: ${channel}\n` +
                `⏰ Kirim pada: <t:${Math.floor(sendAt / 1000)}:F> (<t:${Math.floor(sendAt / 1000)}:R>)\n` +
                (recurring ? `🔄 Recurring: **${recurring}**\n` : '') +
                `📝 Title: ${title}\n` +
                `🆔 ID: \`${entry.id}\`\n\n` +
                `💡 Cek dengan \`/announce-list\`, batalkan dengan \`/announce-cancel id:${entry.id}\``
        });
    }

    // ====================================================
    // === /announce-list ===
    // ====================================================
    if (interaction.commandName === 'announce-list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const entries = getScheduledAnnsByGuild(interaction.guild.id);
        const pending = entries.filter(e => !e.sent);
        if (pending.length === 0) {
            return safeEditReply(interaction, {
                content: '📭 Tidak ada announce terjadwal yang pending. Pakai `/announce-schedule` untuk bikin.'
            });
        }
        // v3.9.38 FIX: cap entry yang ditampilkan (15) + suffix; total description
        // SELALU dihitung terhadap limit 4096 — sebelumnya lines unbounded →
        // setDescription throw RangeError di ~27 pending (command /announce-list
        // mati total sampai entry berkurang lewat send/cancel).
        const MAX_SHOWN_ENTRIES = 15;
        const entryLine = e => {
            return `• 📝 **${e.data.title}**\n  🆔 \`${e.id}\`\n  📍 <#${e.channelId}> | ⏰ <t:${Math.floor(e.sendAt / 1000)}:F> (<t:${Math.floor(e.sendAt / 1000)}:R>)\n  ${e.recurring ? `🔄 Recurring: ${e.recurring}\n  ` : ''}👤 Oleh: ${e.data.authorTag}`;
        };
        const listHeader = `Total **${pending.length}** announce pending.\n\n`;
        let listDescription = '';
        for (let n = Math.min(MAX_SHOWN_ENTRIES, pending.length); n >= 1; n--) {
            const shown = pending.slice(0, n);
            const hidden = pending.length - shown.length;
            const footerNote = hidden > 0 ? `\n\n… +${hidden} announcement lainnya` : '';
            listDescription = `${listHeader}${shown.map(entryLine).join('\n\n')}${footerNote}`;
            if (listDescription.length <= EMBED_LIMITS.DESCRIPTION) break;
        }
        // Defense terakhir: entry tunggal super panjang (praktis mustahil —
        // title ≤ 256 divalidasi saat schedule) → potong per code point.
        // maxLen - 1 supaya total DENGAN ellipsis tetap ≤ 4096 code unit.
        if (listDescription.length > EMBED_LIMITS.DESCRIPTION) {
            listDescription = truncateUtf8Safe(listDescription, EMBED_LIMITS.DESCRIPTION - 1);
        }
        const embed = new EmbedBuilder()
            .setTitle('⏰ ANNOUNCE TERJADWAL')
            .setDescription(listDescription)
            .setColor(0x5865f2)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /announce-cancel ===
    // ====================================================
    if (interaction.commandName === 'announce-cancel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const id = interaction.options.getString('id');
        const entry = getScheduledAnn(id);
        if (!entry) return safeEditReply(interaction, { content: `❌ Announce ID \`${id}\` tidak ditemukan.` });
        if (entry.sent)
            return safeEditReply(interaction, { content: `❌ Announce sudah terkirim, tidak bisa dibatalkan.` });
        if (entry.guildId !== interaction.guild.id)
            return safeEditReply(interaction, { content: '❌ Announce ini bukan dari guild ini.' });
        removeScheduledAnn(id);
        await logAudit(interaction.client, {
            action: 'ANNOUNCE_CANCEL',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Cancel scheduled announce \`${id}\` (Title: "${entry.data.title}")`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, { content: `✅ Announce \`${id}\` (${entry.data.title}) dibatalkan.` });
    }
};
