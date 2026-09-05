/**
 * GuildMemberAdd handler — delegates to handlers/memberHandler.js (legacy)
 * + server log join (v3.9.43).
 *
 * The server log join = an audit record (who joined, when, account age) —
 * its purpose differs from the welcome embed (public greeting). Both the
 * welcome channel and the log may fill up; set the server-log channel
 * separately from welcome if you want them apart.
 *
 * Status: will be split into src/bot/handlers/memberAdd.js after the migration.
 */

const { Events } = require('discord.js');
const { onMemberAdd } = require('../memberHandler');
const { logServerEvent } = require('../../infra/serverLog');

async function onEvent(member) {
    try {
        // v3.9.26 (single-guild hardening): ignore members from other guilds.
        // memberHandler uses the global config (roles.unverified, channels.welcome) —
        // in a second guild those IDs are invalid → role/channel lookups fail + warn spam.
        if (process.env.GUILD_ID && member.guild?.id && member.guild.id !== process.env.GUILD_ID) return;
        await onMemberAdd(member);

        // v3.9.43: server log join (best effort — must never break the welcome).
        if (member.user?.bot) return; // bot joins = integration invites, not members
        const accountAgeSec = Math.floor((Date.now() - member.user.createdTimestamp) / 1000);
        await logServerEvent(member.client, {
            type: 'MEMBER_JOIN',
            guildId: member.guild.id,
            fields: [
                { name: '👤 Member', value: `<@${member.user.id}> (\`${member.user.tag}\`)`, inline: true },
                { name: '🎉 Account created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R> (<t:${Math.floor(member.user.createdTimestamp / 1000)}:d>)`, inline: true },
                { name: '👥 Total members', value: `**${member.guild.memberCount}**`, inline: true }
            ],
            footer: `User ID: ${member.user.id} | Account age: ${accountAgeSec >= 86400 ? `${Math.floor(accountAgeSec / 86400)} days` : 'brand new'}`
        });
    } catch (err) {
        console.error('GuildMemberAdd Error:', err);
    }
}

module.exports = {
    name: Events.GuildMemberAdd,
    execute: onEvent
};
