/**
 * Event: messageUpdate (edit) — log before/after to the server-log channel.
 *
 * Real cases in a trading server: a seller edits the price AFTER the deal is
 * agreed ("but you said 50k" → the before/after is the proof), a scammer
 * edits fake transfer receipts, or a member edits a message into slurs
 * after passing the first read.
 *
 * Design notes:
 *   - The executor is NOT looked up in the audit log — Discord does not
 *     record regular member message edits there (only moderator deletions).
 *     The author is always the editor (except webhook integrations).
 *   - Embed-only edits (empty content) → skip (the bot itself does this often).
 *   - Guards: DMs, GUILD_ID, bot messages, partial without old content → skip.
 */

const { Events } = require('discord.js');
const { logServerEvent, snip } = require('../../infra/serverLog');

async function onEvent(oldMessage, newMessage) {
    try {
        const msg = newMessage || oldMessage;
        if (!msg.guild?.id) return; // DM
        if (process.env.GUILD_ID && msg.guild.id !== process.env.GUILD_ID) return;
        if (msg.author?.bot) return;

        // Embed-only edit (content empty in both versions) → skip.
        const oldC = oldMessage?.content || '';
        const newC = newMessage?.content || '';
        if (!oldC && !newC) return;
        // Unchanged (event fired for an embed change / pin) → skip.
        if (oldC === newC) return;

        // Partial old message without content → before cannot be shown.
        const before = oldC ? snip(oldC) : '_(old message not cached)_';
        const after = newC ? snip(newC) : '_(removed / embed only)_';

        await logServerEvent(msg.client, {
            type: 'MSG_EDIT',
            guildId: msg.guild.id,
            fields: [
                { name: '✍️ Author', value: `<@${msg.author.id}> (\`${msg.author.tag}\`)`, inline: true },
                { name: '📍 Channel', value: `<#${msg.channel.id}> (\`#${msg.channel.name || '?'}\`)`, inline: true },
                { name: '🔗 Message', value: `[View message](${msg.url})`, inline: true },
                { name: '📄 Before', value: before },
                { name: '📄 After', value: after }
            ],
            footer: `Author ID: ${msg.author.id} | Message ID: ${msg.id}`
        });
    } catch (err) {
        console.error('MessageUpdate log error:', err.message);
    }
}

module.exports = {
    name: Events.MessageUpdate,
    execute: onEvent
};
