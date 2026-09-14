/**
 * Custom Command Sync — register/unregister custom commands with Discord (v3.20.0).
 *
 * Called from two places:
 *   1. ready.js  — startup sync (anti-drift: data files may change while
 *      the bot is down / after a backup restore).
 *   2. dashServer — every create/update/delete from the WEB -> immediate
 *      sync so the command appears/disappears in Discord within seconds.
 *
 * Registration rules (following the v3.12.0 modes in infra/guild.js):
 *   - SINGLE-SERVER MODE (GUILD_ID set): built-ins are registered at the
 *     primary guild level. `guild.commands.set()` REPLACES the whole
 *     guild-level list -> custom commands must be merged in:
 *     [...builtins, ...customs].
 *   - PUBLIC MODE (GUILD_ID empty): built-ins are GLOBAL; custom commands
 *     stay per-server -> registered at guild level containing only customs
 *     (guild.commands.set(customs) does NOT touch the global list).
 *
 * Guilds other than the primary in single-server mode are skipped (their
 * events are guarded by isGuildAllowed anyway — syncing there just burns
 * rate limit).
 */

const customCommandManager = require('../data/customCommandManager');
const { getPrimaryGuildId, isGuildAllowed } = require('../infra/guild');
const { getCommands } = require('../commands/registry');

/**
 * Sync ONE guild: align its guild-level command list with the data.
 * @returns {Promise<{ok: boolean, count?: number, error?: string}>}
 */
async function syncGuildCustomCommands(client, guildId) {
    const guild = client?.guilds?.cache?.get(guildId);
    if (!guild) return { ok: false, error: 'Bot is not in this server' };
    if (!isGuildAllowed(guildId)) return { ok: false, error: 'This server is not processed by the bot (single-server mode)' };

    const customs = customCommandManager.toApplicationCommands(guildId);
    const primary = getPrimaryGuildId();

    try {
        if (primary && String(guildId) === primary) {
            // Single-server mode on the primary guild: merge built-ins +
            // customs (set() replaces the whole list — built-ins must be
            // re-sent too).
            await guild.commands.set([...getCommands(), ...customs]);
        } else {
            // Public mode: built-ins are already GLOBAL; guild level =
            // customs only.
            await guild.commands.set(customs);
        }
        return { ok: true, count: customs.length };
    } catch (err) {
        return { ok: false, error: `Failed to sync with Discord: ${err.message}` };
    }
}

/**
 * Sync ALL guilds that have custom commands (used at startup).
 * Best-effort: failures are logged as warnings and don't stop the rest.
 */
async function syncAllGuilds(client, log = () => {}) {
    if (!client?.guilds?.cache) return { synced: 0, failed: 0 };
    let synced = 0;
    let failed = 0;
    for (const guild of client.guilds.cache.values()) {
        // Skip guilds without custom commands — nothing to sync (and it
        // prevents pointless set([]) calls that could wipe stale guild
        // commands from older bot versions on irrelevant guilds).
        if (customCommandManager.getGuildCommands(guild.id).length === 0) continue;
        const res = await syncGuildCustomCommands(client, guild.id);
        if (res.ok) {
            synced++;
            log(`✅ Custom commands synced: ${guild.name} (${res.count} commands).`);
        } else {
            failed++;
            log(`⚠️ Custom command sync failed in ${guild.name}: ${res.error}`);
        }
    }
    return { synced, failed };
}

module.exports = { syncGuildCustomCommands, syncAllGuilds };
