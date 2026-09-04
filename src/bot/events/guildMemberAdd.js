/**
 * GuildMemberAdd handler — delegates to handlers/memberHandler.js (legacy).
 *
 * Status: will be split into src/bot/handlers/memberAdd.js after the migration.
 */

const { Events } = require('discord.js');
const { onMemberAdd } = require('../memberHandler');

async function onEvent(member) {
    try {
        // v3.9.26 (single-guild hardening): ignore members from other guilds.
        // memberHandler uses the global config (roles.unverified, channels.welcome) —
        // in a second guild those IDs are invalid → role/channel lookups fail + warn spam.
        if (process.env.GUILD_ID && member.guild?.id && member.guild.id !== process.env.GUILD_ID) return;
        await onMemberAdd(member);
    } catch (err) {
        console.error('GuildMemberAdd Error:', err);
    }
}

module.exports = {
    name: Events.GuildMemberAdd,
    execute: onEvent
};
