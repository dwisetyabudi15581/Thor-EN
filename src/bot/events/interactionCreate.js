/**
 * InteractionCreate handler — route slash command & button/select/modal.
 *
 * Dipakai oleh index.js. Error handling global ada di sini supaya:
 *   - Transient network error (5xx, ECONNRESET, dll) → warning ringan, no stack.
 *   - Ignorable reply error (10008 Unknown Message, 10062 Unknown Interaction,
 *     40060 Interaction already acknowledged) → warning ringan (user behavior).
 *   - Lainnya → full error log.
 *
 * v3.9.8 FIX: branch `interaction.deferred && !interaction.replied` ditangani
 * (sebelumnya user lihat "Thinking..." 15 menit setelah command throw post-defer).
 */

const { Events, MessageFlags } = require('discord.js');
const routeCommand = require('../../commands');
const routeInteraction = require('../../interactions');

function isTransientNetworkError(err) {
    if (!err) return false;
    const name = err.name || '';
    const code = err.code || '';
    const status = err.status || 0;

    if (name === 'ConnectTimeoutError') return true;
    if (name === 'WebSocketClosedError') return true;
    if (code === 'UND_ERR_CONNECT_TIMEOUT') return true;
    if (code === 'ETIMEDOUT') return true;
    if (code === 'ECONNRESET') return true;
    if (code === 'ECONNREFUSED') return true;
    if (code === 'EAI_AGAIN') return true;
    if (code === 'ENOTFOUND') return true;
    if (status >= 500 && status < 600) return true;
    if (status === 429) return true;

    return false;
}

function isIgnorableReplyError(err) {
    if (!err) return false;
    const code = err.code;
    return code === 10008 || code === 10062 || code === 40060;
}

async function onInteractionCreate(interaction) {
    try {
        // v3.9.26 (single-guild hardening): kalau GUILD_ID di-set, abaikan
        // interaction dari guild lain. Tanpa guard, command bisa dipakai di guild
        // kedua (kalau bot tak sengaja di-invite): config global → roles/channels
        // guild utama dipakai di sana → perilaku aneh + data nyasar.
        if (process.env.GUILD_ID && interaction.guildId && interaction.guildId !== process.env.GUILD_ID) {
            return;
        }
        if (interaction.isChatInputCommand()) {
            await routeCommand(interaction);
        } else {
            await routeInteraction(interaction);
        }
    } catch (err) {
        const isTransient = isTransientNetworkError(err);
        const isIgnorableReply = isIgnorableReplyError(err);
        if (isTransient) {
            console.warn(
                `⚠️ Transient network error on interaction ${interaction.id}:`,
                err.code || err.name,
                '-',
                err.message?.slice(0, 100)
            );
        } else if (isIgnorableReply) {
            console.warn(
                `⚠️ Interaction ${interaction.id} reply gagal (code ${err.code}): ${err.message?.slice(0, 100)}`
            );
        } else {
            console.error('Interaction Error:', err);
        }

        if (!isTransient && !isIgnorableReply && interaction.isRepliable()) {
            if (!interaction.replied && !interaction.deferred) {
                // v3.9.24: MessageFlags.Ephemeral (dulu magic number 64 padahal
                // MessageFlags sudah di-import tapi tidak dipakai).
                interaction
                    .reply({ content: '❌ Terjadi error. Coba lagi sebentar.', flags: MessageFlags.Ephemeral })
                    .catch(() => {});
            } else if (interaction.deferred && !interaction.replied) {
                interaction.editReply({ content: '❌ Terjadi error. Coba lagi sebentar.' }).catch(() => {});
            }
        }
    }
}

module.exports = {
    name: Events.InteractionCreate,
    execute: onInteractionCreate
};
