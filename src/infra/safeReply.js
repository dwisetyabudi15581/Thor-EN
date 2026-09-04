/**
 * Safe interaction reply helpers.
 *
 * Problems solved:
 * - After `interaction.deferReply()`, the bot does a long task (deleting many
 *   channels, restoring a backup, etc.), then calls `interaction.editReply()`.
 * - If the user dismisses the ephemeral "Bot is thinking..." message before
 *   editReply runs, Discord returns `DiscordAPIError[10008]: Unknown Message`.
 * - Before v3.9.4, this error vanished into the global error handler and showed
 *   up as a full stack trace in the logs — even though the user simply dismissed it.
 *
 * Solutions:
 * - `safeEditReply` tries editReply; on 10008/10062 it falls back to
 *   `followUp` (which creates a new message in the same channel).
 * - v3.9.7: on `InteractionNotReplied` (deferReply failed silently — e.g. the
 *   interaction token expired while a modal was still open), fall back to
 *   `reply()` so the error message still reaches the user.
 * - `safeFollowUp` is the same, but for followUp used directly without a
 *   preceding editReply.
 *
 * When to use:
 * - EVERY command that deferReply's and then does >1 second of Discord API work
 *   (deleting multiple channels, sending many DMs, restoring a backup) MUST use
 *   `safeEditReply` at the end, not `interaction.editReply` directly.
 *
 * When NOT needed:
 * - Fast synchronous commands (<1s) without deferReply → interaction.reply() is enough.
 * - Handlers that already use .catch(()=>{}) on editReply and don't care whether
 *   the confirmation arrives.
 */

const { MessageFlags } = require('discord.js');

/**
 * Discord error codes that mean "the original reply can no longer be edited":
 * - 10008: Unknown Message (user dismissed the ephemeral, or the message was deleted)
 * - 10062: Unknown Interaction (interaction token expired, >15 minutes)
 * - 40060: Interaction has already been acknowledged (race condition)
 */
const IGNORABLE_REPLY_CODES = new Set([10008, 10062, 40060]);

/**
 * v3.9.17: dead code removed. IGNORABLE_REPLY_STRING_CODES was never used —
 * the 'InteractionNotReplied' check in safeEditReply uses direct string comparison.
 */

/**
 * Edit an interaction reply with a followUp fallback if the original is gone.
 *
 * @param {import('discord.js').BaseInteraction} interaction
 * @param {import('discord.js').InteractionReplyOptions} options - same as the options for editReply
 * @returns {Promise<import('discord.js').Message|null>} Message on success, null on total failure (silent)
 */
async function safeEditReply(interaction, options) {
    try {
        return await interaction.editReply(options);
    } catch (err) {
        // v3.9.7: InteractionNotReplied — deferReply failed silently (e.g. token
        // expired). The interaction hasn't been acknowledged at all yet, so we
        // can still reply() (as long as the token isn't fully expired).
        if (err.code === 'InteractionNotReplied') {
            try {
                // Default to ephemeral because all safeEditReply callers in this
                // codebase use ephemeral deferReply. If options already
                // specify flags, respect that.
                const replyOptions = { ...options };
                if (replyOptions.flags === undefined) {
                    replyOptions.flags = MessageFlags.Ephemeral;
                }
                return await interaction.reply(replyOptions);
            } catch (_) {
                // reply() also failed — the token is probably fully expired.
                // Nothing we can do; return silently.
                return null;
            }
        }

        if (!IGNORABLE_REPLY_CODES.has(err.code)) {
            throw err; // unexpected error — re-throw so the caller knows
        }

        // Original reply is gone. Try followUp (creates a new message).
        // Preserve the ephemeral flag if the original deferReply was ephemeral.
        const wasEphemeral =
            interaction.ephemeral === true || options?.flags === MessageFlags.Ephemeral || options?.flags === 64;

        try {
            return await interaction.followUp({
                ...options,
                ...(wasEphemeral ? { flags: MessageFlags.Ephemeral } : {})
            });
        } catch (_) {
            // followUp also failed — likely the interaction token expired (>15 minutes).
            // Nothing we can do; return silently.
            return null;
        }
    }
}

/**
 * Follow up an interaction with silent error handling.
 * Use when the caller doesn't care whether the followUp arrives (e.g., an optional
 * notification after the main command finishes).
 *
 * @param {import('discord.js').BaseInteraction} interaction
 * @param {import('discord.js').InteractionReplyOptions} options
 * @returns {Promise<import('discord.js').Message|null>}
 */
async function safeFollowUp(interaction, options) {
    try {
        return await interaction.followUp(options);
    } catch (err) {
        if (!IGNORABLE_REPLY_CODES.has(err.code)) {
            throw err;
        }
        return null;
    }
}

/**
 * Reply to an interaction with silent error handling.
 * Used for the initial reply when the interaction may already be expired (rare).
 *
 * @param {import('discord.js').BaseInteraction} interaction
 * @param {import('discord.js').InteractionReplyOptions} options
 * @returns {Promise<import('discord.js').Message|null>}
 */
async function safeReply(interaction, options) {
    try {
        return await interaction.reply(options);
    } catch (err) {
        if (!IGNORABLE_REPLY_CODES.has(err.code)) {
            throw err;
        }
        return null;
    }
}

module.exports = {
    safeEditReply,
    safeFollowUp,
    safeReply,
    IGNORABLE_REPLY_CODES
};
