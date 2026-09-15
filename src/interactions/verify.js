/**
 * Verify domain handler — DEPRECATED STUB for the `btn_verify` button.
 *
 * v3.22.0: the dedicated verification feature was REMOVED. "Verified" is now
 * just another role on a self-role panel (/setup-selfrole + /selfrole-add).
 * v3.23.0: the Unverified marker concept was removed too — its replacement
 * is auto-role on join + the "remove on another role" toggle
 * (/set-autorole action:toggle).
 *
 * Why this stub exists: servers that installed a verify panel before
 * upgrading still have live `btn_verify` buttons in their channels. Without
 * this handler those clicks would show the generic "This interaction
 * failed" — instead the member gets a clear explanation and the admin gets
 * the exact commands to migrate to a self-role panel.
 */

const { MessageFlags } = require('discord.js');

module.exports = async function (interaction) {
    return interaction.reply({
        content:
            '⚠️ This verification button no longer works — the feature was replaced by **self-role panels**.\n\n' +
            '👤 *Members:* pick your roles from the server\'s self-role panel.\n' +
            '🛠️ *Admins:* delete this old panel and create a self-role one:\n' +
            '```\n/setup-selfrole title:Verification description:Click below to verify yourself\n' +
            '/selfrole-add panel_id:<id> role:@Verified label:Verify Me emoji:✅ style:Success\n```\n' +
            '💡 Tip: for a "new member" role, use `/set-autorole action:add` then `action:toggle` — join roles disappear automatically once the member gets another role.',
        flags: MessageFlags.Ephemeral
    });
};
