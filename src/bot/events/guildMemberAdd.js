/**
 * GuildMemberAdd handler — delegate ke handlers/memberHandler.js (legacy).
 *
 * Status: akan di-split ke src/bot/handlers/memberAdd.js setelah migration.
 */

const { Events } = require('discord.js');
const { onMemberAdd } = require('../memberHandler');

async function onEvent(member) {
    try {
        // v3.9.26 (single-guild hardening): abaikan member dari guild lain.
        // memberHandler pakai config global (roles.unverified, channels.welcome) —
        // di guild kedua ID itu tidak valid → role/channel lookup gagal + warn spam.
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
