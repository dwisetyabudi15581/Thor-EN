/**
 * Poll domain handler — button `poll_vote:*` & modal `poll_modal_create:*`.
 *
 * Di-ekstrak dari handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior dipertahankan apa adanya — hanya pindah file.
 *
 * Helper `handlePollButton`, `handlePollModalCreate`, `updatePollVoteMessage`
 * jadi LOCAL function di file ini.
 *
 * Router (src/interactions/index.js) sudah apply:
 *   - dedup (checkAndMark)
 *   - guard `replied/deferred`
 *   - cek tipe interaction (button/select/modal)
 *   - routing by customId prefix
 * Jadi domain handler fokus ke logic-nya saja.
 */

const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, MessageFlags } = require('discord.js');
const { logAudit, withUserLock, safeEditReply } = require('../commands/_shared');
// votePoll / getPollByMessage / removePoll / getPollSession / deletePollSession
// tidak di-export _shared, import langsung dari pollManager.
const {
    get: getPoll,
    vote: votePoll,
    getTotalVotes: getPollTotalVotes,
    remove: removePoll,
    getPollSession,
    deletePollSession,
    create: createPoll,
    setMessageId: setPollMessageId
} = require('../data/pollManager');

module.exports = async function (interaction) {
    // ====================================================
    // === POLL: VOTE BUTTONS ===
    // ====================================================
    if (interaction.isButton() && interaction.customId.startsWith('poll_vote:')) {
        return handlePollButton(interaction);
    }

    // ====================================================
    // === POLL: MODAL CREATE SUBMIT ===
    // ====================================================
    if (interaction.isModalSubmit() && interaction.customId.startsWith('poll_modal_create:')) {
        return handlePollModalCreate(interaction);
    }
};

// ====================================================
// === HELPER: POLL VOTE BUTTON HANDLER ===
// ====================================================
async function handlePollButton(interaction) {
    try {
        // customId: poll_vote:<pollId>:<optionIndex>
        const parts = interaction.customId.split(':');
        const pollId = parts[1];
        const optionIndex = parseInt(parts[2]);

        // Pre-check cepat untuk feedback instan (tanpa lock)
        const pollPre = getPoll(pollId);
        if (!pollPre) {
            return interaction.reply({ content: '❌ Poll tidak ditemukan.', flags: MessageFlags.Ephemeral });
        }
        if (pollPre.closed) {
            return interaction.reply({ content: '❌ Poll sudah ditutup.', flags: MessageFlags.Ephemeral });
        }

        // v3.9.2 FIX: per-user lock untuk mencegah TOCTOU race condition.
        // Sebelumnya, 2 klik cepat di option yang sama (multiple=false)
        // bisa: klik-1 toggle ON, klik-2 toggle OFF. Hasil: vote hilang
        // padahal user merasa sudah vote. Lock memaksa klik-2 baca data
        // terbaru setelah klik-1 selesai.
        //
        // v3.9.17 FIX: bedain lock-failed vs poll-not-found. Sebelumnya,
        // withUserLock return null kalau lock gagal ATAU fn() return null
        // (poll tidak ada). User lihat "klik terlalu cepat" padahal poll
        // sudah dihapus admin. Sekarang: fn() return object { type, poll }
        // supaya caller bisa bedain.
        const result = await withUserLock('poll', interaction.user.id, () => {
            const r = votePoll(pollId, interaction.user.id, optionIndex);
            if (r === null) {
                // Poll tidak ada atau option invalid
                return { type: 'notfound_or_invalid' };
            }
            if (r.closed) {
                return { type: 'closed', poll: r };
            }
            return { type: 'voted', poll: r };
        });

        if (result === null) {
            // Lock gagal — user klik terlalu cepat
            return interaction.reply({
                content: '⏳ Tunggu sebentar, kamu lagi klik terlalu cepat. Coba lagi dalam 1 detik.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (result.type === 'notfound_or_invalid') {
            return interaction.reply({
                content: '❌ Poll tidak ditemukan atau option tidak valid (mungkin sudah dihapus admin).',
                flags: MessageFlags.Ephemeral
            });
        }
        if (result.type === 'closed') {
            return interaction.reply({ content: '❌ Poll sudah ditutup.', flags: MessageFlags.Ephemeral });
        }
        // result.type === 'voted'
        const poll = result.poll;
        await updatePollVoteMessage(interaction, poll);
        const opt = poll.options[optionIndex];
        // v3.9.38 FIX: cek post-state dari manager — sekarang unvote multi-choice
        // benar-benar terjadi (toggle di pollManager), jadi cabang "Vote
        // dibatalkan" reachable untuk poll multi juga (dulu toggle multi =
        // silent no-op → selalu "Vote tercatat"). Embed re-render di atas
        // (updatePollVoteMessage) sudah pakai state poll yang sama → bar chart
        // mengikuti hasil toggle.
        const voted = opt.votes.includes(interaction.user.id);
        return interaction.reply({
            content: voted ? `✅ Vote tercatat untuk **${opt.label}**!` : `🚪 Vote dibatalkan untuk **${opt.label}**.`,
            flags: MessageFlags.Ephemeral
        });
    } catch (err) {
        console.error('Poll button error:', err);
        if (interaction.isRepliable() && !interaction.replied) {
            await interaction.reply({ content: '❌ Terjadi error.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }
}

async function updatePollVoteMessage(interaction, poll) {
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
                    `🔄 Mode: ${poll.multiple ? 'Multi-vote (boleh pilih banyak)' : 'Single-vote (pilih satu)'}\n` +
                    `⏰ Dibuat: <t:${Math.floor(poll.createdAt / 1000)}:R>\n\n` +
                    `👇 Klik tombol di bawah untuk vote (toggle)`
            )
            .setColor(0x5865f2)
            .setFooter({ text: `Poll by ${poll.creatorTag} | ID: ${poll.id}` })
            .setTimestamp();
        await msg.edit({ embeds: [embed] });
    } catch (err) {
        console.warn('Gagal update poll message:', err.message);
    }
}

// ====================================================
// === HELPER: POLL MODAL CREATE (process input options) ===
// ====================================================
async function handlePollModalCreate(interaction) {
    try {
        // v3.9.1 FIX: customId sekarang hanya `poll_modal_create:<sessionId>`.
        // Data poll (channelId, multiple, question) disimpan di in-memory session
        // supaya customId tidak overflow 100-char Discord limit kalau question panjang.
        const parts = interaction.customId.split(':');
        const sessionId = parts[1];
        const session = getPollSession(sessionId);

        if (!session) {
            return interaction.reply({
                content: '❌ Session poll sudah expired (lebih dari 5 menit). Jalankan ulang `/poll create`.',
                flags: MessageFlags.Ephemeral
            });
        }

        // Defense-in-depth: pastikan user yang submit modal = user yang buat session.
        if (session.userId !== interaction.user.id) {
            return interaction.reply({
                content: '❌ Modal ini bukan milik kamu. Jalankan `/poll create` sendiri.',
                flags: MessageFlags.Ephemeral
            });
        }

        const { channelId, multiple, question } = session;

        const optionsRaw = interaction.components[0]?.components?.[0]?.value?.trim() || '';
        if (!optionsRaw) {
            return interaction.reply({ content: '❌ Options tidak boleh kosong.', flags: MessageFlags.Ephemeral });
        }

        const optionLines = optionsRaw
            .split('\n')
            .map(s => s.trim())
            .filter(s => s.length > 0);
        if (optionLines.length < 2) {
            return interaction.reply({ content: '❌ Minimal 2 options (1 per baris).', flags: MessageFlags.Ephemeral });
        }
        if (optionLines.length > 10) {
            return interaction.reply({ content: '❌ Maksimal 10 options.', flags: MessageFlags.Ephemeral });
        }

        const options = optionLines.map((label, i) => ({
            label: label.slice(0, 80),
            emoji: `${i + 1}️⃣`
        }));

        // Defense-in-depth: command router sudah gate guild-only, tapi cek lagi biar aman
        if (!interaction.guild) {
            return interaction.reply({ content: '❌ Poll cuma bisa dibuat di server.', flags: MessageFlags.Ephemeral });
        }
        const channel = interaction.guild.channels.cache.get(channelId);
        if (!channel) {
            deletePollSession(sessionId);
            return interaction.reply({ content: '❌ Channel tidak ditemukan.', flags: MessageFlags.Ephemeral });
        }

        // v3.9.26 FIX: BUILD embed + tombol DULU, PERSIST belakangan.
        // Sebelumnya createPoll() menulis polls.json SEBELUM setTitle() —
        // question panjang/bentuk aneh membuat setTitle throw (>256) SETELAH
        // entry tersimpan → zombie poll (messageId:null) + user stuck
        // "Bot is thinking..." karena catch memanggil reply() setelah deferReply
        // sukses (InteractionAlreadyAcknowledged, ditelan .catch).
        // Validasi question sudah di command (/poll create, maks 250), tapi
        // reorder ini menutup jalur error sisanya + membuat rollback tidak
        // perlu untuk kasus render-gagal.

        // Build embed + buttons
        const pollId = `poll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const createdAt = Date.now();
        const lines = options
            .map(opt => {
                const bar = '░'.repeat(10);
                return `${opt.emoji} **${opt.label}** — 0 votes (0%)\n\`${bar}\``;
            })
            .join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle(`📊 ${question}`)
            .setDescription(
                `${lines}\n\n` +
                    `🗳️ Total votes: **0**\n` +
                    `🔄 Mode: ${multiple ? 'Multi-vote (boleh pilih banyak)' : 'Single-vote (pilih satu)'}\n` +
                    `⏰ Dibuat: <t:${Math.floor(createdAt / 1000)}:R>\n\n` +
                    `👇 Klik tombol di bawah untuk vote (toggle)`
            )
            .setColor(0x5865f2)
            .setFooter({ text: `Poll by ${interaction.user.tag} | ID: ${pollId}` })
            .setTimestamp();

        // Build buttons — 5 per row (Discord limit), wrap to next row if more
        const rows = [];
        for (let i = 0; i < options.length; i += 5) {
            const row = new ActionRowBuilder();
            for (let j = i; j < Math.min(i + 5, options.length); j++) {
                const opt = options[j];
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`poll_vote:${pollId}:${j}`)
                        .setLabel(opt.label.slice(0, 80))
                        .setEmoji(opt.emoji)
                        .setStyle(ButtonStyle.Primary)
                );
            }
            rows.push(row);
        }

        // v3.9.24 FIX: defer SEBELUM channel.send (operasi lambat). Sebelumnya
        // modal ini tidak pernah defer — kalau send lambat / retry jaringan,
        // window 3-detik ack Discord terlewati → "This interaction failed".
        // Validasi di atas cepat (in-memory), jadi defer di titik ini pas.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

        // Persist poll entry SETELAH render sukses (v3.9.26)
        const poll = createPoll({
            id: pollId,
            guildId: interaction.guild.id,
            channelId: channel.id,
            question,
            options,
            multiple,
            creatorId: interaction.user.id,
            creatorTag: interaction.user.tag
        });

        const msg = await channel
            .send({ embeds: [embed], components: rows, content: `📊 **POLL BARU** oleh ${interaction.user}` })
            .catch(() => null);
        if (!msg) {
            // P0-5 FIX: rollback poll entry yang sudah tersimpan kalau gagal kirim message.
            try {
                removePoll(poll.id);
            } catch (_) {}
            deletePollSession(sessionId);
            return safeEditReply(interaction, {
                content: `❌ Gagal kirim poll ke ${channel}. Cek permission bot. Entry di-rollback.`
            });
        }
        setPollMessageId(poll.id, msg.id);
        // v3.9.1: session sudah dipakai, hapus dari memory.
        deletePollSession(sessionId);
        // P1-10 FIX: tambah audit log untuk POLL_CREATE (sebelumnya missing).
        try {
            await logAudit(interaction.client, {
                action: 'POLL_CREATE',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Buat poll **${question}** (${poll.options.length} options, ${multiple ? 'multi' : 'single'}-vote) di ${channel}`,
                guildId: interaction.guild.id
            });
        } catch (_) {}
        return safeEditReply(interaction, {
            content: `✅ Poll dibuat di ${channel}!\n🆔 \`${poll.id}\`\n💡 Tutup pakai \`/poll close id:${poll.id}\``
        });
    } catch (err) {
        console.error('Poll modal create error:', err);
        // v3.9.26 FIX: pakai safeEditReply, bukan reply(). deferReply sudah jalan
        // di jalur sukses → reply() throw InteractionAlreadyAcknowledged (ditelan
        // .catch) → user stuck "Bot is thinking..." 15 menit tanpa pesan error.
        // safeEditReply handle kasus deferred/replied/belum-apa-apa dengan benar.
        await safeEditReply(interaction, {
            content: '❌ Terjadi error saat membuat poll: ' + (err.message || 'unknown')
        }).catch(() => {});
    }
}
