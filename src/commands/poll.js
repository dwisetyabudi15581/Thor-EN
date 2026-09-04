/**
 * Domain: poll
 * Slash commands: /poll (subcommands: create, list, close)
 *
 * Dipisah dari handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: bikin poll (modal → options), list poll, close poll + update message.
 *
 * v3.9.1: simpan data poll di in-memory session (bukan di customId) supaya
 *         question panjang tidak overflow 100-char Discord limit.
 *
 * Catatan: helper `updatePollMessage` dipisah dari commandHandler.js dan
 *          dideklarasikan sebagai local function di file ini (sebelumnya
 *          ada di bottom-of-file commandHandler.js).
 */

const {
    EmbedBuilder,
    ButtonBuilder,
    ActionRowBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    getPoll,
    getPollsByGuild,
    closePoll,
    getPollTotalVotes,
    createPollSession,
    logAudit,
    safeEditReply
} = require('./_shared');

module.exports = async function (interaction) {
    // ====================================================
    // === /poll ===
    // ====================================================
    if (interaction.commandName !== 'poll') return;

    // v3.9.26 FIX: getSubcommand(false). Registry menandai semua subcommand
    // required:false → Discord BOLEH kirim /poll tanpa subcommand → getSubcommand()
    // throw CommandInteractionOptionNoSubcommand (unhandled, stack penuh di log,
    // user lihat error generik). Sekarang: hint penggunaan yang jelas.
    const sub = interaction.options.getSubcommand(false);
    if (!sub) {
        return interaction.reply({
            content: '❌ Pakai subcommand: `/poll create`, `/poll list`, atau `/poll close`.',
            flags: MessageFlags.Ephemeral
        });
    }

    // --- /poll create ---
    if (sub === 'create') {
        const channel = interaction.options.getChannel('channel');
        const question = interaction.options.getString('question');
        const multiple = interaction.options.getBoolean('multiple') || false;

        // v3.9.26 FIX: validasi SEBELUM session/modal. Question > ~250 char membuat
        // `setTitle(\`📊 ${question}\`)` throw (>256) NANTI di modal handler —
        // setelah poll PERSIST ke polls.json (zombie) dan setelah deferReply
        // (error reply ditelan → user stuck "Bot is thinking..."). Cek di sini
        // = murah + pesan jelas.
        if (!question || question.length > 250) {
            return interaction.reply({
                content: `❌ Pertanyaan poll wajib diisi dan maksimal 250 karakter (dapat: ${question ? question.length : 0}).`,
                flags: MessageFlags.Ephemeral
            });
        }
        // v3.9.26: poll cuma masuk akal di text channel (voice/category bikin
        // channel.send gagal di modal handler dengan pesan menyesatkan).
        if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
            return interaction.reply({
                content: '❌ Channel harus berupa text channel (atau announcement).',
                flags: MessageFlags.Ephemeral
            });
        }
        // v3.9.1 FIX: simpan data poll di in-memory session, bukan di customId.
        // Sebelumnya customId = `poll_modal_create:${channel.id}:${multiple}:${encodeURIComponent(question)}`
        // yang bisa overflow 100-char Discord limit kalau question panjang
        // (esp. setelah encodeURIComponent — spasi jadi %20, dll).
        // Sekarang customId = `poll_modal_create:${sessionId}` (~50 char, aman).
        const sessionId = createPollSession({
            userId: interaction.user.id,
            channelId: channel.id,
            multiple,
            question
        });

        // Open modal untuk input options (satu field, dipisah newline)
        const modal = new ModalBuilder()
            .setCustomId(`poll_modal_create:${sessionId}`)
            .setTitle('Buat Poll — Input Options');
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('options')
                    .setLabel('Options (1 per baris, min 2, maks 10)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setPlaceholder('Rank Push\nCustom Room\nTurnamen\nOff')
                    .setMaxLength(500)
            )
        );
        return interaction.showModal(modal);
    }

    // --- /poll list ---
    if (sub === 'list') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const polls = getPollsByGuild(interaction.guild.id);
        if (polls.length === 0) {
            return safeEditReply(interaction, { content: '📭 Belum ada poll di guild ini.' });
        }
        // v3.9.26 FIX: bound description. Poll closed tidak pernah dihapus dari
        // polls.json — di ~25-30 poll, total lines > 4096 → setDescription THROW
        // → /poll list (dan satu-satunya cara lihat ID untuk /poll close) mati
        // permanen. Sekarang: tampilkan 15 terbaru + ringkas sisanya.
        const MAX_SHOWN = 15;
        const shown = polls.slice(-MAX_SHOWN);
        const hidden = polls.length - shown.length;
        const lines = shown
            .map(p => {
                const status = p.closed ? '🔒 Closed' : '🟢 Active';
                const total = getPollTotalVotes(p);
                return `• ❓ **${p.question}** — ${status}\n  🆔 \`${p.id}\` | 👥 ${p.options.length} options | 🗳️ ${total} votes\n  📍 <#${p.channelId}> | ⏰ <t:${Math.floor(p.createdAt / 1000)}:R>`;
            })
            .join('\n\n');
        const header = `Total **${polls.length}** poll${hidden > 0 ? ` (menampilkan ${shown.length} terbaru — ${hidden} lama disembunyikan)` : ''}.`;
        const embed = new EmbedBuilder()
            .setTitle('📊 DAFTAR POLL')
            .setDescription(`${header}\n\n${lines.slice(0, 3900)}`)
            .setColor(0x5865f2)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // --- /poll close ---
    if (sub === 'close') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const id = interaction.options.getString('id');
        const poll = getPoll(id);
        if (!poll) return safeEditReply(interaction, { content: `❌ Poll \`${id}\` tidak ditemukan.` });
        if (poll.guildId !== interaction.guild.id)
            return safeEditReply(interaction, { content: '❌ Poll ini bukan dari guild ini.' });
        if (poll.closed) return safeEditReply(interaction, { content: `❌ Poll sudah closed.` });
        const updated = closePoll(id);
        // v3.9.26 FIX: guard null — poll bisa kehapus (rollback/refresh) di antara
        // getPoll dan closePoll; tanpa guard, updatePollMessage(interaction, null)
        // TypeError di poll.channelId.
        if (!updated) {
            return safeEditReply(interaction, { content: `❌ Poll \`${id}\` sudah tidak ada (barusan dihapus?).` });
        }
        await updatePollMessage(interaction, updated);
        await logAudit(interaction.client, {
            action: 'POLL_CLOSE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Close poll \`${id}\` ("${poll.question}")`,
            guildId: interaction.guild.id
        });
        return safeEditReply(interaction, { content: `✅ Poll **${poll.question}** ditutup! Lihat hasil di channel.` });
    }
};

// ====================================================
// === HELPER: UPDATE POLL MESSAGE (untuk close) ===
// ====================================================
// Dipisah dari handlers/commandHandler.js (v3.9.9 refactor). Function declaration
// di-hoist, jadi bisa dipanggil dari `module.exports` di atas.
async function updatePollMessage(interaction, poll) {
    try {
        const channel = interaction.guild.channels.cache.get(poll.channelId);
        if (!channel) return;
        const msg = await channel.messages.fetch(poll.messageId).catch(() => null);
        if (!msg) return;

        const total = getPollTotalVotes(poll);
        const lines = poll.options
            .map(opt => {
                const pct = total > 0 ? Math.round((opt.votes.length / total) * 100) : 0;
                const bar = '█'.repeat(Math.floor(pct / 10)).padEnd(10, '░');
                return `${opt.emoji} **${opt.label}** — ${opt.votes.length} votes (${pct}%)\n\`${bar}\``;
            })
            .join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle(`📊 ${poll.question}`)
            .setDescription(
                `${lines}\n\n` +
                    `🗳️ Total votes: **${total}**\n` +
                    `🔒 Status: **Closed** <t:${Math.floor(poll.closedAt / 1000)}:R>`
            )
            .setColor(0x95a5a6)
            .setFooter({ text: `Poll by ${poll.creatorTag} | Closed` })
            .setTimestamp();

        // Disable all buttons
        const disabledRows = msg.components.map(row => {
            const newRow = new ActionRowBuilder();
            for (const comp of row.components) {
                newRow.addComponents(ButtonBuilder.from(comp).setDisabled(true));
            }
            return newRow;
        });

        await msg.edit({ embeds: [embed], components: disabledRows });
    } catch (err) {
        console.warn('Gagal update poll message:', err.message);
    }
}
