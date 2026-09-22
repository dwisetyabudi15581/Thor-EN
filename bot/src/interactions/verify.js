/**
 * Verify domain handler — LEGACY STUB for the old `btn_verify` button.
 *
 * v3.22.0: the dedicated verification feature was removed ("verified is just
 * another role on a self-role panel"). v3.23.0: the Unverified marker concept
 * was removed too (replacement: /set-autorole + the removeOnNewRole toggle).
 *
 * v3.28.0: /setup-verify is BACK — a wizard over the one-way self-role panel.
 * This stub remains for OLD panels installed before the upgrades that still
 * carry a live `btn_verify` button: without a handler those clicks would show
 * the generic "This interaction failed". Instead the member gets a clear
 * explanation and the admin gets the exact migration command.
 */

const { MessageFlags } = require('discord.js');

module.exports = async function (interaction) {
    return interaction.reply({
        content:
            '⚠️ This old verification button no longer works — the feature was replaced by a **new, safer verification panel**.\n\n' +
            '👤 *Members:* use the new verification panel (its button can be clicked as many times as you like — your role is never lost).\n' +
            '🛠️ *Admins:* delete this old panel and install the new one:\n' +
            '```\n/setup-verify role:@Verified\n```\n' +
            '💡 Tip: for a "new member" role that disappears once verified, use `/set-autorole action:add` then `action:toggle`.',
        flags: MessageFlags.Ephemeral
    });
};
