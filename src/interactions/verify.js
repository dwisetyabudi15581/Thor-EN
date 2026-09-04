/**
 * Verify domain handler — the `btn_verify` button.
 *
 * Extracted from handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior preserved as-is — just moved to a new file.
 *
 * The router (src/interactions/index.js) already applies:
 *   - dedup (checkAndMark)
 *   - `replied/deferred` guard
 *   - interaction type check (button/select/modal)
 *   - routing by customId prefix
 * So the domain handler can focus on its logic alone.
 */

const { MessageFlags } = require('discord.js');
const { getConfig } = require('../commands/_shared');

module.exports = async function (interaction) {
    // The router calls this handler ONLY for customId === 'btn_verify'.
    const config = getConfig();

    if (!config.roles.verified) {
        return interaction.reply({
            content: '❌ The Verified role is not set yet. Ask an admin to run `/set-role verified @role`.',
            flags: MessageFlags.Ephemeral
        });
    }
    // v3.9.17 FIX: guard the member.roles access (partial member / user left before clicking).
    if (!interaction.member?.roles?.cache) {
        return interaction.reply({
            content: '❌ Incomplete member data. Try again in a moment.',
            flags: MessageFlags.Ephemeral
        });
    }
    if (interaction.member.roles.cache.has(config.roles.verified)) {
        return interaction.reply({ content: '✅ You are already verified!', flags: MessageFlags.Ephemeral });
    }
    try {
        await interaction.member.roles.add(config.roles.verified);
    } catch (err) {
        console.error('Failed to add the verified role:', err.message);
        return interaction.reply({
            content: '❌ The bot cannot give you the Verified role. Make sure the bot\'s role is ABOVE the Verified role.',
            flags: MessageFlags.Ephemeral
        });
    }
    // v3.9.17 FIX: track whether the unverified role was actually removed. Previously,
    // the message always said "the Unverified role has been removed" even when it failed.
    let unverifiedRemoved = false;
    let unverifiedNote = '';
    if (config.roles.unverified) {
        try {
            await interaction.member.roles.remove(config.roles.unverified);
            unverifiedRemoved = true;
        } catch (err) {
            console.error('Failed to remove the unverified role:', err.message);
            unverifiedNote =
                '\n⚠️ The bot cannot remove the Unverified role. Make sure the bot\'s role is ABOVE the Unverified role. Contact an admin to remove it manually.';
        }
    } else {
        // unverified role not set in config — not an error, but the message shouldn't claim it was "removed".
        unverifiedNote = '\nℹ️ The Unverified role is not set in config — only the Verified role was given.';
    }
    return interaction.reply({
        content:
            '✅ Verification successful! The Verified role has been given to you.' +
            (config.roles.unverified
                ? unverifiedRemoved
                    ? ' The Unverified role has been removed.'
                    : unverifiedNote
                : unverifiedNote),
        flags: MessageFlags.Ephemeral
    });
};
