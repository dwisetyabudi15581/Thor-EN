/**
 * Event: guildDelete — the bot left / was removed from a guild, OR the guild
 * went unavailable (v3.29.0, TAHAP 1 sync audit).
 *
 * Why this handler exists: before v3.29.0 a kick was completely INVISIBLE —
 * no log line, no explanation, and the admin only found out when the web
 * dashboard stopped listing the server. discord.js fires guildDelete for two
 * VERY different situations, and they must not be conflated:
 *
 *   1. `guild.available === false` → the guild is temporarily unavailable
 *      (Discord outage / shard reconnect). The bot is STILL in the guild —
 *      absolutely no cleanup may run, and it will come back via guildCreate.
 *   2. otherwise → the bot was kicked / left. The guild's channels are gone
 *      with it, so a server-log entry is impossible — this handler is the
 *      audit trail.
 *
 * What happens automatically when the bot is kicked (NO extra cleanup needed
 * — verified in this audit):
 *   - /guilds (DASH API) reads the LIVE client cache → the server picker
 *     stops listing it within seconds (the "Invite" button returns).
 *   - The scheduler's processors self-heal: scheduled announcements and
 *     role-schedule entries for a missing guild are deleted on their next
 *     tick, and ending giveaways are marked ended (no infinite retry loop).
 *   - ALL stored data (config, panels, keys, stats, boost history) is
 *     deliberately RETAINED — if the bot is re-invited, everything works
 *     again exactly as it was left.
 */

const { Events } = require('discord.js');

module.exports = {
    name: Events.GuildDelete,
    async execute(guild) {
        try {
            if (!guild?.id) return;

            // Case 1: outage — NOT a kick. Never clean anything on this path.
            if (guild.available === false) {
                console.warn(
                    `🔌 [sync] Guild ${guild.name || guild.id} is temporarily unavailable (Discord outage) — not a kick. No data touched.`
                );
                return;
            }

            // Case 2: kicked / left.
            console.warn(`👢 [sync] The bot was REMOVED from "${guild.name}" (ID ${guild.id}) — kicked, or it left.`);
            console.log(
                '   📦 All data for that server is retained (config, panels, keys, stats) — it returns if the bot is re-invited.'
            );
            console.log(
                '   🧹 Pending scheduled work (announcements, giveaways, role schedules) self-cleans on the next scheduler tick.'
            );
            console.log(
                '   🖥️ The web dashboard reflects this automatically: the server picker reads the live guild cache.'
            );
        } catch (err) {
            console.error('[guildDelete] handler error:', err);
        }
    }
};
