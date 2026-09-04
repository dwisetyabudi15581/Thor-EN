/**
 * InteractionCreate handler — routes slash commands & button/select/modal.
 *
 * Used by index.js. Global error handling lives here so that:
 *   - Transient network errors (5xx, ECONNRESET, etc) → light warning, no stack.
 *   - Ignorable reply errors (10008 Unknown Message, 10062 Unknown Interaction,
 *     40060 Interaction already acknowledged) → light warning (user behavior).
 *   - Everything else → full error log.
 *
 * v3.9.8 FIX: the `interaction.deferred && !interaction.replied` branch is handled
 * (previously the user saw "Thinking..." for 15 minutes after a command threw post-defer).
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
        // v3.9.26 (single-guild hardening): if GUILD_ID is set, ignore
        // interactions from other guilds. Without this guard, commands could be
        // used in a second guild (if the bot gets accidentally invited): global
        // config → the main guild's roles/channels get used there → weird
        // behavior + stray data.
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
                `⚠️ Interaction ${interaction.id} reply failed (code ${err.code}): ${err.message?.slice(0, 100)}`
            );
        } else {
            console.error('Interaction Error:', err);
        }

        if (!isTransient && !isIgnorableReply && interaction.isRepliable()) {
            if (!interaction.replied && !interaction.deferred) {
                // v3.9.24: MessageFlags.Ephemeral (previously magic number 64 even
                // though MessageFlags was already imported but unused).
                interaction
                    .reply({ content: '❌ An error occurred. Try again in a moment.', flags: MessageFlags.Ephemeral })
                    .catch(() => {});
            } else if (interaction.deferred && !interaction.replied) {
                interaction.editReply({ content: '❌ An error occurred. Try again in a moment.' }).catch(() => {});
            }
        }
    }
}

module.exports = {
    name: Events.InteractionCreate,
    execute: onInteractionCreate
};
