/**
 * GuildMemberRemove handler — delegates to handlers/memberHandler.js (legacy).
 */

const { Events } = require('discord.js');
const { onMemberRemove } = require('../memberHandler');

async function onEvent(member) {
    try {
        // v3.9.26 (single-guild hardening): ignore members from other guilds.
        if (process.env.GUILD_ID && member.guild?.id && member.guild.id !== process.env.GUILD_ID) return;
        await onMemberRemove(member);
    } catch (err) {
        console.error('GuildMemberRemove Error:', err);
    }
}

module.exports = {
    name: Events.GuildMemberRemove,
    execute: onEvent
};
