/**
 * Guild helpers — v3.10.0 multi-guild, v3.12.0 ONE GUILD ID.
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
 * v3.12.0 — ONE GUILD ID (admin request: no more confusion):
 *   There is exactly ONE variable in .env: GUILD_ID. The v3.11.0
 *   multi-server allowlist is REMOVED — an ID list only made switching
 *   servers confusing. Two modes, one place to change:
 *
 *   1. GUILD_ID SET → SINGLE-SERVER MODE (private):
 *      - Slash commands are registered per-guild → INSTANT (seconds, not
 *        hours).
 *      - ALL events (messages/commands/joins/boosts/tickets/etc.) from
 *        other servers are IGNORED — insurance in case the bot is
 *        accidentally invited elsewhere.
 *      - Only this guild may claim the legacy config.json.
 *      This is the mode normal deployments use: switching servers = edit
 *      the single GUILD_ID line in .env, done.
 *
 *   2. GUILD_ID EMPTY → PUBLIC MODE (Dyno-style):
 *      - Slash commands are registered GLOBALLY: they appear
 *        automatically in EVERY server that invites the bot (~1 hour
 *        propagation) — the same behavior as big public bots like
 *        Dyno/MEE6; they never enter a guild id manually either.
 *      - All events are processed; configs are isolated per-server
 *        automatically (data/config/<guildId>.json — the v3.10.0
 *        architecture).
 *
 *   getPrimaryGuildId(): the GUILD_ID from .env (trimmed), or null (public
 *     mode). isGuildAllowed(guildId): the guard used by ALL event
 *     handlers — true in public mode, or when guildId === GUILD_ID.
 *
 * Read directly from process.env (no cache) — env is static for the life of
 * the process, and unit tests freely rotate env values between cases. The
 * operation is a single string comparison — cheap even on high-frequency
 * events like messageCreate.
 */
function resolveGuildId(interaction) {
    if (!interaction) return null;
    return interaction.guildId || (interaction.guild && interaction.guild.id) || null;
}

/**
 * The ONE guild the bot serves (see the two modes in the header).
 * @returns {string|null} — the trimmed GUILD_ID, or null
 *   (= public mode: every guild is processed).
 */
function getPrimaryGuildId() {
    const single = (process.env.GUILD_ID || '').trim();
    return single || null;
}

/**
 * Guild guard: may this guild be processed?
 * - guildId null/undefined → false (DM / no context — callers guard themselves).
 * - GUILD_ID empty (public mode) → always true.
 * - GUILD_ID set (single-server mode) → true only for the matching guild.
 * @param {string|null} guildId
 * @returns {boolean}
 */
function isGuildAllowed(guildId) {
    if (!guildId) return false;
    const primary = getPrimaryGuildId();
    if (!primary) return true; // public mode — every server is allowed
    return String(guildId) === primary;
}

module.exports = { resolveGuildId, getPrimaryGuildId, isGuildAllowed };
