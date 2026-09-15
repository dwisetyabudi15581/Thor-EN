/**
 * Event: guildMemberUpdate — log role & nickname changes (v3.9.43) +
 * SERVER BOOST add/remove detection (v3.9.49) + booster auto role (v3.9.59).
 *
 * Why it matters in a trading server:
 *   - Role changes = access status changes (verified → revoked, or someone
 *     gaining a "reseller" role out of nowhere without the owner knowing).
 *   - Nickname changes = scammers changing identity so their track record
 *     in vouches/warn-lists becomes hard to match.
 *   - Boost changes (v3.9.49) = who is supporting the server right now —
 *     Discord fires NO dedicated boost event, so the add/remove is derived
 *     here from the premium_since diff (null → date = boost added,
 *     date → null = boost removed).
 *   - Booster auto role (v3.9.59) = the admin's custom role granted/removed
 *     following the boost status — assigning the role here fires
 *     guildMemberUpdate AGAIN (role-only diff, premium_since unchanged), so
 *     there is no recursion: the second event just logs ROLE_UPDATE.
 *
 * Guards:
 *   - oldMember can be PARTIAL (not cached) → old roles/nickname/premium info
 *     are unavailable; skip per-section (role diff needs oldMember.roles,
 *     nickname diff needs oldMember.nickname, boost diff needs
 *     oldMember.premiumSinceTimestamp — partials have all undefined).
 *   - Bot members → skip (role changes during bot startup/tools = noise;
 *     bots cannot boost anyway).
 *   - No change → skip.
 */

const { Events } = require('discord.js');
const { logServerEvent, snip } = require('../../infra/serverLog');
// v3.12.0: single GUILD_ID guard (single-server / public mode).
const { isGuildAllowed } = require('../../infra/guild');
// v3.22.0: universal Unverified rule — the Role Engine + guild config.
const { revokeRoles, joinRoleIds } = require('../../services/roleEngine');
const { getConfig } = require('../../data/configManager');
// v3.9.49: boost notifications (server-booster channel + server log + history).
// v3.9.59: applyBoostRole — booster auto role (called AFTER the notification
// so the history stays recorded even when the role assignment fails).
const { onBoostChange, applyBoostRole } = require('../boostHandler');
// v3.9.51: live server stats counters (the Boosts counter changes on boost
// add/remove).
const { markStatsDirty } = require('../../data/serverstatsManager');

async function onEvent(oldMember, newMember) {
    try {
        if (!newMember?.guild?.id) return;
        // v3.12.0: single GUILD_ID guard — guilds that do not match the GUILD_ID
        // in .env are ignored; an empty GUILD_ID = public mode (every guild).
        if (!isGuildAllowed(newMember.guild.id)) return;
        if (newMember.user?.bot) return;

        const hasOldState = !!(oldMember && oldMember.roles && oldMember.roles.cache);
        const user = newMember.user;

        // === 0. Boost diff (v3.9.49) — checked FIRST so a boost that comes with
        // a role change (Discord's built-in Server Booster role) doesn't shadow
        // it. oldMember partial → premiumSinceTimestamp undefined → cannot
        // compare → skip. ===
        if (hasOldState && oldMember.premiumSinceTimestamp !== newMember.premiumSinceTimestamp) {
            const wasBoosting = oldMember.premiumSinceTimestamp !== null && oldMember.premiumSinceTimestamp !== undefined;
            const isBoosting = newMember.premiumSinceTimestamp !== null && newMember.premiumSinceTimestamp !== undefined;
            if (!wasBoosting && isBoosting) {
                await onBoostChange(newMember, 'add', null);
                // v3.9.59: booster auto role — boosting members get the role.
                await applyBoostRole(newMember, 'add');
            } else if (wasBoosting && !isBoosting) {
                await onBoostChange(newMember, 'remove', oldMember.premiumSinceTimestamp);
                // v3.9.59: boost ended → role removed (the built-in Server
                // Booster role semantics).
                await applyBoostRole(newMember, 'remove');
            }
        }

        // === 1. Role diff (needs the old state cached) ===
        if (hasOldState) {
            const added = [...newMember.roles.cache.values()].filter(
                r => !oldMember.roles.cache.has(r.id)
            );
            const removed = [...oldMember.roles.cache.values()].filter(
                r => !newMember.roles.cache.has(r.id)
            );

            // === v3.22.0: UNIVERSAL UNVERIFIED RULE ===
            // A member who holds the Unverified marker role is considered
            // verified the moment they receive ANY other role — from ANY
            // source: a self-role panel, an admin granting it manually,
            // leveling, a VIP purchase, a boost, or another bot. The Unverified
            // role is removed silently (admin's choice: silent + logged).
            //
            // Exemptions (roles that do NOT count as the "first role"):
            //   - the Unverified role itself (granted at join)
            //   - the join roles the system granted at member join (the
            //     /set-autorole list) — otherwise granting @Member + @Unverified
            //     at join would instantly "verify" everyone and the marker
            //     would be useless.
            const config = getConfig(newMember.guild.id);
            const unverifiedId = config.roles.unverified;
            if (
                unverifiedId &&
                added.length > 0 &&
                newMember.roles.cache.has(unverifiedId) &&
                added.some(r => r.id !== unverifiedId && !joinRoleIds(config).includes(r.id))
            ) {
                const res = await revokeRoles(newMember, [unverifiedId], {
                    reason: 'Unverified marker removed automatically — first role received'
                });
                if (res.revoked.length > 0) {
                    console.log(
                        `✅ [auto-verify] ${user.tag} received a role — Unverified marker removed.`
                    );
                }
                // The removal itself fires guildMemberUpdate again → the standard
                // ROLE_UPDATE server log below records it on that pass (➖ Unverified).
                // No DM, no announcement — admin's choice: silent + logged.
            }

            if (added.length > 0 || removed.length > 0) {
                const lines = [];
                if (added.length > 0) lines.push(`➕ ${added.map(r => `\`${r.name}\``).join(', ')}`);
                if (removed.length > 0) lines.push(`➖ ${removed.map(r => `\`${r.name}\``).join(', ')}`);
                await logServerEvent(newMember.client, {
                    type: 'ROLE_UPDATE',
                    guildId: newMember.guild.id,
                    fields: [
                        { name: '👤 Member', value: `<@${user.id}> (\`${user.tag}\`)`, inline: true },
                        { name: '🎭 Changes', value: snip(lines.join('\n'), 500) }
                    ],
                    footer: `User ID: ${user.id}`
                });
            }
        }

        // === 2. Nickname diff (oldMember partial → nickname undefined → skip) ===
        if (hasOldState && oldMember.nickname !== newMember.nickname) {
            const before = oldMember.nickname || user.username;
            const after = newMember.nickname || user.username;
            await logServerEvent(newMember.client, {
                type: 'NICK_UPDATE',
                guildId: newMember.guild.id,
                fields: [
                    { name: '👤 Member', value: `<@${user.id}> (\`${user.tag}\`)`, inline: true },
                    { name: '📝 Before', value: snip(before, 200), inline: true },
                    { name: '📝 After', value: snip(after, 200), inline: true }
                ],
                footer: `User ID: ${user.id}`
            });
        }
    } catch (err) {
        console.error('GuildMemberUpdate log error:', err.message);
    }

    // v3.9.51: a boost change (or any member update that shifted the numbers)
    // marks the server stats counters dirty. Kept OUTSIDE the try above so a
    // server-log failure can't skip the counter update. Cheap no-op without
    // /serverstats setup.
    try {
        markStatsDirty(newMember?.guild?.id);
    } catch (_) {}
}

module.exports = {
    name: Events.GuildMemberUpdate,
    execute: onEvent
};
