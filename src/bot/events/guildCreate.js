/**
 * Event: guildCreate — the bot was added to a guild, OR a guild came back
 * after an outage (v3.29.0, TAHAP 1 sync audit).
 *
 * Before v3.29.0 there was no trace of the bot being added to a new server:
 * no log, no heads-up — and in single-server mode (GUILD_ID set) the admin
 * had no way to see that some OTHER server had invited the bot and was being
 * silently ignored. This handler makes both visible in the console.
 *
 * No data is written here on purpose: a new guild gets pure defaults, created
 * lazily by getConfig() the first time anything touches it (the same as
 * before) — nothing to initialize eagerly.
 */

const { Events } = require('discord.js');
const { getPrimaryGuildId } = require('../../infra/guild');

module.exports = {
    name: Events.GuildCreate,
    async execute(guild) {
        try {
            if (!guild?.id) return;

            // guildCreate also fires when an unavailable guild comes back after
            // an outage — distinguish it so the log tells the truth.
            if (guild.available === false) {
                console.log(`🔌 [sync] Guild ${guild.name || guild.id} is unavailable (awaiting its return).`);
                return;
            }

            console.log(
                `➕ [sync] The bot was added to "${guild.name}" (ID ${guild.id}) — ${typeof guild.memberCount === 'number' ? guild.memberCount : '?'} members.`
            );
            console.log(
                '   ⚙️ Fresh defaults apply until an admin configures it (slash commands or the web dashboard).'
            );

            // Single-server mode warning: this guild's events will be IGNORED
            // by every handler (isGuildAllowed) — the admin should know.
            const primary = getPrimaryGuildId();
            if (primary && primary !== guild.id) {
                console.warn(
                    `   ⚠️ Single-server mode: GUILD_ID (${primary}) does not match this guild — all features stay inert here. Clear GUILD_ID in .env to serve every server.`
                );
            }
        } catch (err) {
            console.error('[guildCreate] handler error:', err);
        }
    }
};
