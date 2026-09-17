/**
 * Domain: custom
 * Handler: admin-made slash commands (created from the web dashboard, v3.20.0).
 *
 * The router (index.js) calls this file when a command name is NOT in
 * COMMAND_TO_DOMAIN but matches a custom command of that guild. The reply
 * = text (content) + embed, exactly as the admin defined it on the web.
 * Per-command `ephemeral` option: reply visible only to the invoking user.
 */

const { EmbedBuilder, MessageFlags } = require('discord.js');
const customCommandManager = require('../data/customCommandManager');
const { buildEmbedFromDef, isEmbedEmpty } = require('../infra/embedPayload');

module.exports = async function (interaction) {
    const cmd = customCommandManager.getCommand(interaction.guildId, interaction.commandName);
    if (!cmd) {
        // Race: the command was deleted right before use. Don't hard-error —
        // a short ephemeral note is enough (the stale entry stays visible in
        // Discord's command cache until the next sync).
        if (interaction.deferred || interaction.replied) return;
        return interaction.reply({
            content: '⚠️ This command was deleted by an admin. Hang on until Discord refreshes its command list.',
            flags: MessageFlags.Ephemeral
        });
    }

    const payload = {};
    if (cmd.content) payload.content = cmd.content;
    if (cmd.embed && !isEmbedEmpty(cmd.embed)) {
        payload.embeds = [buildEmbedFromDef(cmd.embed, EmbedBuilder)];
    }
    if (cmd.ephemeral === true) payload.flags = MessageFlags.Ephemeral;

    customCommandManager.incrementUse(interaction.guildId, cmd.name);

    return interaction.reply(payload);
};
