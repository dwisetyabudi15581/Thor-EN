/**
 * Event: guildMemberUpdate — log role & nickname changes (v3.9.43).
 *
 * Why it matters in a trading server:
 *   - Role changes = access status changes (verified → revoked, or someone
 *     gaining a "reseller" role out of nowhere without the owner knowing).
 *   - Nickname changes = scammers changing identity so their track record
 *     in vouches/warn-lists becomes hard to match.
 *
 * Guards:
 *   - oldMember can be PARTIAL (not cached) → old roles/nickname are
 *     unavailable; skip per-section (role diff needs oldMember.roles,
 *     nickname diff needs oldMember.nickname — partials have both undefined).
 *   - Bot members → skip (role changes during bot startup/tools = noise).
 *   - No change → skip.
 */

const { Events } = require('discord.js');
const { logServerEvent, snip } = require('../../infra/serverLog');

async function onEvent(oldMember, newMember) {
    try {
        if (!newMember?.guild?.id) return;
        if (process.env.GUILD_ID && newMember.guild.id !== process.env.GUILD_ID) return;
        if (newMember.user?.bot) return;

        const hasOldState = !!(oldMember && oldMember.roles && oldMember.roles.cache);
        const user = newMember.user;

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
