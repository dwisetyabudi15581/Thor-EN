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
// v3.12.0: single GUILD_ID guard (single-server / public mode).
const { isGuildAllowed } = require('../../infra/guild');
// v3.9.51: live server stats counters.
const { markStatsDirty } = require('../../data/serverstatsManager');

async function onEvent(member) {
    try {
        // v3.9.26 → v3.12.0 (single GUILD_ID): ignore members from guilds other
        // than the GUILD_ID in .env (empty GUILD_ID = every guild — public mode).
        // v3.9.48: this skip is now VISIBLE (was a silent return — a member joined
        // in the other guild and the admin could not tell why no welcome appeared).
        if (member.guild?.id && !isGuildAllowed(member.guild.id)) {
            console.warn(
                `⚠️ Ignored a member join from another guild (ID: ${member.guild.id}) — this ID does not match the GUILD_ID in .env (single-server mode). Welcome only runs in that server.`
            );
            return;
        }
        await onMemberAdd(member);

        // v3.9.51: the member counter changed (memberCount includes bots, so
        // this must run BEFORE the bot-return below). Cheap no-op when the
        // /serverstats counters are not set up.
        markStatsDirty(member.guild.id);

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
