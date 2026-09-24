/**
 * Verify domain handler — the `btn_verify` button (RESTORED in v4.2.0).
 *
 * History:
 *   - v3.9.x (CHRONOS era): the dedicated verification feature — click →
 *     Verified role granted, Unverified role removed.
 *   - v3.22.0: removed ("verified is just another role on a self-role
 *     panel") — this handler became a deprecation stub.
 *   - v4.2.0 RESTORE (owner's request — the classic behavior is back):
 *     legacy panels installed before the upgrades carry a live `btn_verify`
 *     button and must WORK again. The grant now flows through the Role
 *     Engine (hierarchy/managed/@everyone checks + structured failure logs)
 *     and reads the per-guild config (v3.10.0 multi-guild).
 *   - v4.3.0 (auto-role deleted — CHRONOS parity): the Unverified role is
 *     removed DIRECTLY here again, exactly like CHRONOS — no more relying on
 *     the autorole.removeOnNewRole toggle (deleted together with the whole
 *     auto-role feature). The v3.9.17 honesty pattern is kept: the reply
 *     says whether the Unverified role was actually removed, never claims
 *     success on failure, and notes when no Unverified role is configured.
 *
 * RBAC note: verification is a MEMBER-level action — this handler is
 * intentionally NOT admin/staff gated (same as CHRONOS).
 *
 * The router (src/interactions/index.js) already applies:
 *   - dedup (checkAndMark)
 *   - `replied/deferred` guard
 *   - interaction type check
 *   - routing by customId ('btn_verify')
 */

const { MessageFlags } = require('discord.js');
const { getConfig } = require('../commands/_shared');
const { grantRoles, revokeRoles } = require('../services/roleEngine');

module.exports = async function (interaction) {
    // The router calls this handler ONLY for customId === 'btn_verify'.
    const guildId = interaction.guildId || interaction.guild?.id;
    const config = getConfig(guildId);

    if (!config?.roles?.verified) {
        return interaction.reply({
            content: '❌ The Verified role is not set yet. Ask an admin to run `/setup-verify role:@Verified`.',
            flags: MessageFlags.Ephemeral
        });
    }
    // v3.9.17 FIX (kept): guard the member.roles access (partial member / user left before clicking).
    if (!interaction.member?.roles?.cache) {
        return interaction.reply({
            content: '❌ Incomplete member data. Try again in a moment.',
            flags: MessageFlags.Ephemeral
        });
    }
    if (interaction.member.roles.cache.has(config.roles.verified)) {
        return interaction.reply({ content: '✅ You are already verified!', flags: MessageFlags.Ephemeral });
    }

    // v4.2.0: through the Role Engine — the single gateway for every grant
    // (validation + per-role retry + failure logs, shared with self-role
    // panels / level rewards).
    const res = await grantRoles(interaction.member, [config.roles.verified], {
        reason: 'verification (btn_verify)'
    });
    if (!res.ok || res.granted.length === 0) {
        return interaction.reply({
            content:
                '❌ The bot cannot give you the Verified role. Make sure the bot\'s role is ABOVE the Verified role.',
            flags: MessageFlags.Ephemeral
        });
    }

    // v4.3.0: the classic CHRONOS finish — remove the Unverified role
    // directly (previously delegated to the autorole.removeOnNewRole toggle,
    // deleted with the auto-role feature). The v3.9.17 honesty pattern:
    // track whether it actually happened and say so.
    let unverifiedNote = '';
    const unverifiedId = config.roles.unverified;
    if (unverifiedId) {
        const rm = await revokeRoles(interaction.member, [unverifiedId], {
            reason: 'verification complete (btn_verify)'
        });
        if (rm.ok && rm.revoked.length > 0) {
            unverifiedNote = ' The Unverified role has been removed.';
        } else if (!rm.ok) {
            unverifiedNote =
                '\n⚠️ The bot cannot remove the Unverified role. Make sure the bot\'s role is ABOVE the Unverified role. Contact an admin to remove it manually.';
        }
        // ok-but-skipped = the member didn't hold it (e.g. joined before the
        // role was set) — nothing to report, not an error.
    } else {
        unverifiedNote = '\nℹ️ The Unverified role is not set in config — only the Verified role was given.';
    }

    return interaction.reply({
        content: `✅ Verification successful! The Verified role has been given to you.${unverifiedNote}`,
        flags: MessageFlags.Ephemeral
    });
};
