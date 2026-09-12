/**
 * Guild helpers — v3.10.0 multi-guild.
 *
 * resolveGuildId(interaction): get the guild ID from a Discord interaction.
 * Real Discord provides `interaction.guildId` (always present in a server
 * context); `interaction.guild?.id` is available when the guild is cached.
 * Both are checked so that:
 *   - production: guildId is used directly (guild.id is only a fallback),
 *   - unit tests: a mock interaction that only has `guild: { id }` still
 *     works without mimicking the full discord.js interaction class.
 *
 * Returns null for DMs / no guild context — callers must guard null (or let
 * configManager throw with a clear message).
 */
function resolveGuildId(interaction) {
    if (!interaction) return null;
    return interaction.guildId || (interaction.guild && interaction.guild.id) || null;
}

module.exports = { resolveGuildId };
