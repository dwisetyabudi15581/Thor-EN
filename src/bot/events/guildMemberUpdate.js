/**
 * Event: guildMemberUpdate — log role & nickname changes (v3.9.43) +
 * SERVER BOOST add/remove detection (v3.9.49).
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
// v3.9.49: boost notifications (server-booster channel + server log + history).
const { onBoostChange } = require('../boostHandler');

async function onEvent(oldMember, newMember) {
    try {
        if (!newMember?.guild?.id) return;
        if (process.env.GUILD_ID && newMember.guild.id !== process.env.GUILD_ID) return;
        if (newMember.user?.bot) return;

        const hasOldState = !!(oldMember && oldMember.roles && oldMember.roles.cache);
        const user = newMember.user;

        // === 0. Boost diff (v3.9.49) — checked FIRST so a boost that comes with
        // a role change (the auto Booster role) doesn't shadow it. oldMember
        // partial → premiumSinceTimestamp undefined → cannot compare → skip. ===
        if (hasOldState && oldMember.premiumSinceTimestamp !== newMember.premiumSinceTimestamp) {
            const wasBoosting = oldMember.premiumSinceTimestamp !== null && oldMember.premiumSinceTimestamp !== undefined;
            const isBoosting = newMember.premiumSinceTimestamp !== null && newMember.premiumSinceTimestamp !== undefined;
            if (!wasBoosting && isBoosting) {
                await onBoostChange(newMember, 'add', null);
            } else if (wasBoosting && !isBoosting) {
                await onBoostChange(newMember, 'remove', oldMember.premiumSinceTimestamp);
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
}

module.exports = {
    name: Events.GuildMemberUpdate,
    execute: onEvent
};
