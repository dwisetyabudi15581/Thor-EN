/**
 * Self-role domain handler — button `sr_btn:*` & select menu `sr_sel:*`.
 *
 * Extracted from handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior preserved as-is — just moved to a new file.
 *
 * Helpers `handleSelfRoleButton` and `handleSelfRoleSelect` are LOCAL functions
 * in this file (previously function-level in the old module).
 *
 * The router (src/interactions/index.js) already applies:
 *   - dedup (checkAndMark)
 *   - `replied/deferred` guard
 *   - interaction type check (button/select/modal)
 *   - routing by customId prefix (sr_btn: / sr_sel:)
 * So the domain handler can focus on its logic alone.
 */

const { MessageFlags } = require('discord.js');
const { getPanel, buildPanelComponents } = require('../commands/_shared');
// v3.22.0: the Role Engine — single gateway for every role grant/revoke.
// Self-role panels, verification, auto-role on join, VIP purchases… all
// funnel through here so hierarchy/managed/@everyone checks + failure logs
// are identical everywhere.
const { grantRoles, revokeRoles } = require('../services/roleEngine');

module.exports = async function (interaction) {
    // ====================================================
    // === SELF-ROLE: BUTTON CLICK ===
    // ====================================================
    if (interaction.isButton() && interaction.customId.startsWith('sr_btn:')) {
        return handleSelfRoleButton(interaction);
    }

    // ====================================================
    // === SELF-ROLE: SELECT MENU ===
    // ====================================================
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sr_sel:')) {
        return handleSelfRoleSelect(interaction);
    }
};

// ====================================================
// === HELPER: SELF-ROLE BUTTON HANDLER ===
// ====================================================
async function handleSelfRoleButton(interaction) {
    const parts = interaction.customId.split(':');
    const panelId = parts[1];
    const roleId = parts[2];
    const panel = getPanel(panelId);
    if (!panel) {
        return interaction.reply({ content: '❌ This self-role panel no longer exists.', flags: MessageFlags.Ephemeral });
    }
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
        return interaction.reply({ content: '❌ Role not found in this server.', flags: MessageFlags.Ephemeral });
    }

    // v3.9.24 FIX: make sure roleId is actually a member of this panel. Previously
    // a forged/legacy customId (sr_btn:<panel>:<otherRole>) could toggle any guild
    // role as long as it existed — even though that role was never offered by the
    // panel (the bot needs role hierarchy, but it was still an unnecessary hole).
    if (!panel.roles.some(r => r.roleId === roleId)) {
        return interaction.reply({
            content: '❌ That role is not registered on this self-role panel.',
            flags: MessageFlags.Ephemeral
        });
    }

    // v3.9.11 Phase 3: conditional role check.
    // If the role has a requiresRoleId, the user must already have that role to claim it.
    const roleConfig = panel.roles.find(r => r.roleId === roleId);
    if (roleConfig?.requiresRoleId) {
        const member = interaction.member;
        if (!member.roles.cache.has(roleConfig.requiresRoleId)) {
            const reqRole = interaction.guild.roles.cache.get(roleConfig.requiresRoleId);
            const reqName = reqRole ? reqRole.name : `<@&${roleConfig.requiresRoleId}>`;
            return interaction.reply({
                content:
                    `❌ You need the **${reqName}** role to claim this role.\n\n` +
                    `💡 Get the ${reqName} role first via the matching self-role panel.`,
                flags: MessageFlags.Ephemeral
            });
        }
    }

    const member = interaction.member;
    const hasRole = member.roles.cache.has(roleId);

    // v3.22.0: all grant/revoke calls go through the Role Engine — same
    // checks, same failure logging as every other feature. Granting a role
    // here can also trigger the automatic removal of the member's join
    // roles (the autorole.removeOnNewRole toggle in guildMemberUpdate) —
    // no special handling needed.
    if (panel.exclusive && !hasRole) {
        // Exclusive mode: remove all other panel roles first, then add this one
        const toRemove = panel.roles
            .map(r => r.roleId)
            .filter(rid => rid !== roleId && member.roles.cache.has(rid));
        const removeRes = toRemove.length > 0
            ? await revokeRoles(member, toRemove, { reason: 'self-role panel (exclusive switch)' })
            : null;
        const addRes = await grantRoles(member, [roleId], { reason: 'self-role panel' });
        if (!addRes.ok || (removeRes && !removeRes.ok)) {
            return interaction.reply({
                content: `❌ Failed to change the role. Make sure the bot's role is ABOVE the ${role} role.`,
                flags: MessageFlags.Ephemeral
            });
        }
        const removedMentions = toRemove.map(rid => `<@&${rid}>`).join(', ');
        return interaction.reply({
            content: `✅ Role ${role} added.${toRemove.length > 0 ? `\n↳ Other roles removed: ${removedMentions}` : ''}`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (panel.exclusive && hasRole) {
        // Exclusive + already has it → remove
        const res = await revokeRoles(member, [roleId], { reason: 'self-role panel (toggle off)' });
        if (!res.ok) {
            return interaction.reply({
                content: `❌ Failed to remove the role. Make sure the bot's role is ABOVE the ${role} role.`,
                flags: MessageFlags.Ephemeral
            });
        }
        return interaction.reply({ content: `✅ Role ${role} removed.`, flags: MessageFlags.Ephemeral });
    }
    if (!panel.exclusive && !hasRole) {
        // Multi + doesn't have it → add
        const res = await grantRoles(member, [roleId], { reason: 'self-role panel' });
        if (!res.ok) {
            return interaction.reply({
                content: `❌ Failed to give you the role. Make sure the bot's role is ABOVE the ${role} role.`,
                flags: MessageFlags.Ephemeral
            });
        }
        return interaction.reply({ content: `✅ Role ${role} added.`, flags: MessageFlags.Ephemeral });
    }
    // Multi + already has it → remove (toggle)
    const res = await revokeRoles(member, [roleId], { reason: 'self-role panel (toggle off)' });
    if (!res.ok) {
        return interaction.reply({
            content: `❌ Failed to remove the role. Make sure the bot's role is ABOVE the ${role} role.`,
            flags: MessageFlags.Ephemeral
        });
    }
    return interaction.reply({ content: `✅ Role ${role} removed.`, flags: MessageFlags.Ephemeral });
}

// ====================================================
// === HELPER: SELF-ROLE SELECT MENU HANDLER ===
// ====================================================
async function handleSelfRoleSelect(interaction) {
    const parts = interaction.customId.split(':');
    const panelId = parts[1];
    const panel = getPanel(panelId);
    if (!panel) {
        return interaction.reply({ content: '❌ This self-role panel no longer exists.', flags: MessageFlags.Ephemeral });
    }

    const member = interaction.member;
    const selectedIds = new Set(interaction.values); // role IDs the user selected
    const panelRoleIds = panel.roles.map(r => r.roleId);

    // === v3.9.0 FIX: implement the previously missing EXCLUSIVE mode ===
    // Exclusive mode: the user may only have 1 role from the panel at a time.
    // Behavior:
    //   - If the user selects 1 (or more — Discord allows multi-select):
    //     * Take the first selected role as the "active role".
    //     * Remove all other panel roles the user already has.
    //     * Add the selected role.
    //   - If the user selects 0 roles (cleared selection):
    //     * Remove all panel roles the user has.
    if (panel.exclusive) {
        // v3.24.1 SECURITY FIX (H-1): the exclusive branch previously skipped BOTH
        // guards every sibling path enforces — (1) the selected value must actually
        // be a member of this panel (anti forged/legacy value) and (2) the
        // requiresRoleId prerequisite. A member could pick a conditional role from
        // an exclusive dropdown without meeting its prerequisite.
        const targetRoleId =
            selectedIds.size > 0
                ? interaction.values[0] // first selected role
                : null;

        if (targetRoleId && !panelRoleIds.includes(targetRoleId)) {
            return interaction.reply({
                content: '❌ That role is not registered on this self-role panel.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (targetRoleId) {
            const tConfig = panel.roles.find(r => r.roleId === targetRoleId);
            if (tConfig?.requiresRoleId && !member.roles.cache.has(tConfig.requiresRoleId)) {
                const reqRole = interaction.guild.roles.cache.get(tConfig.requiresRoleId);
                const reqName = reqRole ? reqRole.name : `<@&${tConfig.requiresRoleId}>`;
                return interaction.reply({
                    content:
                        `❌ You need the **${reqName}** role to claim this role.\n\n` +
                        `💡 Get the ${reqName} role first via the matching self-role panel.`,
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        const toRemoveExclusive = panelRoleIds.filter(rid => rid !== targetRoleId && member.roles.cache.has(rid));
        const toAddExclusive = targetRoleId && !member.roles.cache.has(targetRoleId) ? [targetRoleId] : [];

        // v3.22.0: Role Engine (same gateway as every other feature).
        const removeRes = toRemoveExclusive.length > 0
            ? await revokeRoles(member, toRemoveExclusive, { reason: 'self-role select (exclusive)' })
            : null;
        const addRes = toAddExclusive.length > 0
            ? await grantRoles(member, toAddExclusive, { reason: 'self-role select (exclusive)' })
            : null;
        if ((removeRes && !removeRes.ok) || (addRes && !addRes.ok)) {
            return interaction.reply({
                content: `❌ Failed to change the roles. Make sure the bot's role is ABOVE the selected roles.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const action = targetRoleId
            ? `**Added:** <@&${targetRoleId}>${toRemoveExclusive.length > 0 ? `\n**Removed (exclusive mode):** ${toRemoveExclusive.map(rid => `<@&${rid}>`).join(', ')}` : ''}`
            : `**Removed:** ${toRemoveExclusive.length > 0 ? toRemoveExclusive.map(rid => `<@&${rid}>`).join(', ') : '(none)'}`;

        await interaction.reply({
            content: `✅ Roles updated (exclusive mode).\n${action}`,
            flags: MessageFlags.Ephemeral
        });

        // Update the select menu so the selection stays in sync with the roles now owned
        try {
            const newComponents = buildPanelComponents(panel);
            if (newComponents.length > 0) {
                await interaction.message.edit({ components: newComponents });
            }
        } catch (err) {
            console.warn('Failed to update the select menu after selecting (exclusive):', err.message);
        }
        return;
    }

    // === MULTI mode (default) — original logic ===
    // v3.9.11 Phase 3: filter out roles the user doesn't qualify for (requiresRoleId).
    // If the user picks a role that needs a prerequisite they don't have, skip & warn.
    const skippedForPrereq = [];
    const qualifiedSelectedIds = new Set();
    for (const selId of selectedIds) {
        const rConfig = panel.roles.find(r => r.roleId === selId);
        if (rConfig?.requiresRoleId && !member.roles.cache.has(rConfig.requiresRoleId)) {
            skippedForPrereq.push(selId);
        } else {
            qualifiedSelectedIds.add(selId);
        }
    }

    const toAdd = panelRoleIds.filter(rid => qualifiedSelectedIds.has(rid) && !member.roles.cache.has(rid));
    const toRemove = panelRoleIds.filter(rid => !qualifiedSelectedIds.has(rid) && member.roles.cache.has(rid));

    // v3.22.0: Role Engine (same gateway as every other feature).
    const removeRes = toRemove.length > 0
        ? await revokeRoles(member, toRemove, { reason: 'self-role select' })
        : null;
    const addRes = toAdd.length > 0
        ? await grantRoles(member, toAdd, { reason: 'self-role select' })
        : null;
    if ((removeRes && !removeRes.ok) || (addRes && !addRes.ok)) {
        return interaction.reply({
            content: `❌ Failed to change the roles. Make sure the bot's role is ABOVE the selected roles.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const addedMentions = toAdd.map(rid => `<@&${rid}>`).join(', ') || '(none)';
    const removedMentions = toRemove.map(rid => `<@&${rid}>`).join(', ') || '(none)';

    await interaction.reply({
        content: `✅ Roles updated.\n**Added:** ${addedMentions}\n**Removed:** ${removedMentions}`,
        flags: MessageFlags.Ephemeral
    });

    // Update the select menu so the selection stays in sync with the roles now owned
    try {
        const newComponents = buildPanelComponents(panel);
        if (newComponents.length > 0) {
            await interaction.message.edit({ components: newComponents });
        }
    } catch (err) {
        console.warn('Failed to update the select menu after selecting:', err.message);
    }
}
