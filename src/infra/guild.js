/**
 * Guild helpers — v3.10.0 multi-guild, v3.11.0 phase 2 (allowlist).
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
 *
 * ---------------------------------------------------------------------
 * v3.11.0 PHASE 2 — ALLOWED_GUILD_IDS (multi-server allowlist):
 *   getAllowedGuildIds(): the guilds allowed to use the bot.
 *     Sources (priority):
 *       1. env ALLOWED_GUILD_IDS — comma/space separated, e.g.
 *          "111...,222...,333...".
 *       2. env GUILD_ID (fallback) — the v3.9.26 single-guild mode; admins
 *          upgrading do not need to touch their .env at all.
 *       3. [] (empty) = OPEN MODE: every guild is processed (the v3.10.0
 *          behavior) — for a genuinely public bot.
 *   isGuildAllowed(guildId): true when the guild is on the list, OR when
 *     the list is empty (open mode). Used as the guard by ALL event handlers.
 *
 * Read directly from process.env (no cache) — env is static for the life of
 * the process, and unit tests freely rotate env values between cases. The
 * operation is a tiny string split — cheap even on high-frequency events
 * like messageCreate.
 */
function resolveGuildId(interaction) {
    if (!interaction) return null;
    return interaction.guildId || (interaction.guild && interaction.guild.id) || null;
}

/**
 * The allowed guild list (see the priority rules in the header).
 * Empty tokens are dropped; there is NO strict digit validation so the
 * GUILD_ID fallback stays compatible with whatever value an admin uses
 * (real Discord IDs are numeric snowflakes, but we do not enforce that).
 * @returns {string[]} — empty means open mode (every guild).
 */
function getAllowedGuildIds() {
    const rawList = (process.env.ALLOWED_GUILD_IDS || '').trim();
    if (rawList) {
        return rawList
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
    }
    const single = (process.env.GUILD_ID || '').trim();
    if (single) return [single];
    return [];
}

/**
 * Allowlist guard: may this guild be processed?
 * - guildId null/undefined → false (DM / no context — callers guard themselves).
 * - Empty list (open mode) → always true.
 * - Non-empty list → true only for list members.
 * @param {string|null} guildId
 * @returns {boolean}
 */
function isGuildAllowed(guildId) {
    if (!guildId) return false;
    const list = getAllowedGuildIds();
    if (list.length === 0) return true;
    return list.includes(String(guildId));
}

module.exports = { resolveGuildId, getAllowedGuildIds, isGuildAllowed };
