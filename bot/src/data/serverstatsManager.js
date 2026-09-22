/**
 * Server Stats Manager — live counter channels (v3.9.51).
 *
 * User request: "I want a live server-stats feature like the ServerStats
 * bots" — channels whose NAMES are live counters (e.g. "👥 Members: 123")
 * that update automatically, like the popular counter bots.
 *
 * How it works:
 *   /serverstats setup creates a "📊 SERVER STATS" category + 5 voice
 *   channels (Members, Bots, Boosts, Roles, Channels). @everyone is denied
 *   Connect so they act as display-only counters. The channel IDs are
 *   persisted in data/serverstats.json.
 *
 *   Updates are EVENT-DRIVEN + PERIODIC:
 *     - guildMemberAdd/Remove/Update (members, bots, boosts),
 *       channelCreate/Delete (channels), guildRoleCreate/Delete (roles)
 *       mark the stats "dirty" → the 60s scheduler tick refreshes them.
 *     - Every 5th scheduler tick (~5 min) is a catch-up refresh even
 *       without an event, so a missed event self-heals.
 *     - ready.js does one forced refresh at startup.
 *
 *   RENAME RATE LIMIT (the critical part): Discord allows only 2 channel
 *   name edits per channel per 10 minutes — a counter that renames on
 *   EVERY join would 429 and the bot could get temp-banned from the API.
 *   Three guards:
 *     1. CHANGE DETECTION — setName is only called when the name actually
 *        differs (no API call for unchanged counters).
 *     2. PER-CHANNEL COOLDOWN — at least COOLDOWN_MS (5 min) between real
 *        edits per channel → max 2 per 10 min, exactly the limit.
 *     3. DIRTY-DRIVEN — a burst of joins = 1 refresh, not 1 rename each.
 *   A rename skipped by the cooldown is retried on a later tick (the value
 *   is still different, so the change detection keeps it "pending").
 *
 *   MISSING CHANNELS: if an admin deletes a counter channel, the refresh
 *   logs a warning (with the fix commands) and skips it. If ALL counters
 *   are gone, the feature auto-disables (config cleared) so the scheduler
 *   stops calling it — re-run /serverstats setup to recreate everything.
 *
 * File: data/serverstats.json
 * {
 *   "guildId": "...",
 *   "categoryId": "...",
 *   "counters": {
 *     "members": "channelId",
 *     "bots": "channelId",
 *     "boosts": "channelId",
 *     "roles": "channelId",
 *     "channels": "channelId"
 *   },
 *   "enabled": true,
 *   "updatedAt": 1735689600000
 * }
 *
 * Note: NO "online members" counter on purpose — it requires the
 * GuildPresences privileged intent (NOT enabled: enabling it without the
 * portal toggle crashes the login). Without presences the online number
 * would be a lie, so it is not offered at all.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');

const filePath = path.join(__dirname, '..', '..', 'data', 'serverstats.json');

// === Rate-limit constants ===
// Discord: 2 channel-name edits / channel / 10 min. 5-min spacing = exactly 2.
const COOLDOWN_MS = 5 * 60 * 1000;
// Refresh every N scheduler ticks (tick = 60s) even without events.
const REFRESH_EVERY_TICKS = 5;

// === In-memory state ===
let cache = null; // null = not loaded yet
const lastRenameAt = {}; // counterType → timestamp of the last REAL rename
const warnedMissing = new Set(); // counterTypes already warned about (avoid log spam)
let dirty = false; // an event says the numbers may have changed
let schedulerTicks = 0; // 60s ticks since startup (drives the 5-min catch-up)

/**
 * Counter definitions — order = display order in the category (top → bottom).
 * The emoji + label is what the channel NAME shows.
 */
const COUNTER_DEFS = [
    { type: 'members', emoji: '👥', label: 'Members' },
    { type: 'bots', emoji: '🤖', label: 'Bots' },
    { type: 'boosts', emoji: '🚀', label: 'Boosts' },
    { type: 'roles', emoji: '🎭', label: 'Roles' },
    { type: 'channels', emoji: '📺', label: 'Channels' }
];

/**
 * Pure: build the counter channel name. Voice channel names keep spaces,
 * case & emoji, so this is exactly what members see in the sidebar.
 * @param {string} type - counter type (COUNTER_DEFS)
 * @param {number} value - the live number
 * @returns {string} e.g. "👥 Members: 123"
 */
function buildCounterName(type, value) {
    const def = COUNTER_DEFS.find(d => d.type === type);
    if (!def) return `${value}`;
    return `${def.emoji} ${def.label}: ${value}`;
}

/**
 * Pure: read the live value for a counter straight from the guild object.
 *   - members: guild.memberCount (exact, includes bots — what Discord itself
 *     counts as "members"; the Bots counter shows the bot part separately)
 *   - bots: members cache filtered on user.bot — best-effort. The roster is
 *     fetched at startup (booster reconcile) so this is accurate in practice;
 *     right after a cold start with a failed fetch it can lag a few bots.
 *   - boosts: guild.premiumSubscriptionCount (null → 0)
 *   - roles: roles.cache.size (includes @everyone — same as Discord's UI count)
 *   - channels: channels.cache.size (includes categories)
 *
 * @param {Object} guild - discord.js Guild (or a stub with the same caches)
 * @param {string} type
 * @returns {number}
 */
function computeCounterValue(guild, type) {
    if (!guild) return 0;
    switch (type) {
        case 'members':
            return guild.memberCount || 0;
        case 'bots': {
            const members = guild.members?.cache;
            if (!members || typeof members.values !== 'function') return 0;
            let bots = 0;
            for (const m of members.values()) {
                if (m.user?.bot) bots++;
            }
            return bots;
        }
        case 'boosts':
            return guild.premiumSubscriptionCount || 0;
        case 'roles':
            return guild.roles?.cache?.size || 0;
        case 'channels':
            return guild.channels?.cache?.size || 0;
        default:
            return 0;
    }
}

// === Persistence ===

function load() {
    if (cache !== null) return cache;
    try {
        if (!fs.existsSync(filePath)) {
            cache = null;
            return null;
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        cache = parsed;
        return cache;
    } catch (err) {
        console.warn('⚠️ serverstats.json is corrupted:', err.message);
        quarantineCorruptFile(filePath);
        cache = null;
        return null;
    }
}

function getConfig() {
    return load();
}

function isEnabled() {
    const cfg = load();
    return !!(cfg && cfg.enabled && cfg.counters && Object.keys(cfg.counters).length > 0);
}

/**
 * Save the config (used by /serverstats setup). Writes atomically and
 * refreshes the in-memory cache.
 */
function saveConfig(cfg) {
    cache = cfg;
    safeWriteJSON(filePath, cfg);
    // New configuration → the cooldown/warning state belongs to the old one.
    for (const k of Object.keys(lastRenameAt)) delete lastRenameAt[k];
    warnedMissing.clear();
}

/**
 * Clear the config (used by /serverstats remove + auto-disable).
 */
function clearConfig() {
    cache = null;
    dirty = false;
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
        console.warn('⚠️ Failed to delete serverstats.json:', err.message);
    }
}

/**
 * v3.9.51: invalidate the cache + re-read from disk (after /restore-backup —
 * same staleness scenario as statsManager.reload: the in-memory cache would
 * otherwise overwrite the restored file on the next save).
 */
function reload() {
    cache = null;
    dirty = false;
    for (const k of Object.keys(lastRenameAt)) delete lastRenameAt[k];
    warnedMissing.clear();
    return load();
}

// === Live refresh ===

/**
 * Refresh every counter channel of the guild (rename only when the value
 * actually changed + the cooldown allows it).
 *
 * @param {Object} guild - the discord.js Guild (or stub with channels.cache)
 * @param {Object} [opts]
 * @param {boolean} [opts.force] - bypass the per-channel cooldown (admin
 *        /serverstats refresh + the startup sync — both rare, both safe).
 * @returns {Promise<{updated:number,deferred:number,missing:number,errors:number,skipped?:boolean}>}
 */
async function refreshServerStats(guild, opts = {}) {
    const { force = false } = opts;
    const cfg = load();
    if (!cfg || !cfg.enabled || !cfg.counters) {
        return { updated: 0, deferred: 0, missing: 0, errors: 0, skipped: true };
    }

    let updated = 0;
    let deferred = 0;
    let missing = 0;
    let errors = 0;
    let found = 0;

    for (const def of COUNTER_DEFS) {
        const channelId = cfg.counters[def.type];
        if (!channelId) continue;

        const channel = guild?.channels?.cache?.get?.(channelId);
        if (!channel || typeof channel.setName !== 'function') {
            missing++;
            if (!warnedMissing.has(def.type)) {
                warnedMissing.add(def.type);
                console.warn(
                    `⚠️ Server stats counter "${def.label}" (channel ID ${channelId}) not found in "${guild?.name || 'the guild'}" — deleted by an admin? Re-create with /serverstats setup (after /serverstats remove).`
                );
            }
            continue;
        }
        found++;

        const newName = buildCounterName(def.type, computeCounterValue(guild, def.type));

        // Guard 1 — change detection: unchanged name = zero API calls.
        if (channel.name === newName) continue;

        // Guard 2 — per-channel cooldown (Discord: 2 renames / 10 min).
        const last = lastRenameAt[def.type] || 0;
        if (!force && Date.now() - last < COOLDOWN_MS) {
            deferred++;
            continue;
        }

        try {
            await channel.setName(newName, 'Server stats counter');
            lastRenameAt[def.type] = Date.now();
            updated++;
        } catch (err) {
            errors++;
            console.warn(
                `⚠️ Server stats: could not rename the "${def.label}" counter: ${err.message}${String(err.message).includes('rate limit') ? ' — hit the rename rate limit, the next scheduler tick will retry.' : ''}`
            );
        }
    }

    // ALL counters gone → auto-disable (stop burning scheduler ticks on a
    // dead feature; the warning above already names the fix).
    if (cfg.counters && Object.values(cfg.counters).length > 0 && found === 0 && missing > 0) {
        console.warn(
            '⚠️ All server stats counter channels are gone — the live counters feature is disabled. Re-create with /serverstats setup.'
        );
        clearConfig();
        return { updated, deferred, missing, errors, disabled: true };
    }

    if (updated > 0) {
        cfg.updatedAt = Date.now();
        dirty = false;
        try {
            safeWriteJSON(filePath, cfg);
        } catch (_) {} // the renames already happened; persistence is best-effort
    }

    return { updated, deferred, missing, errors };
}

// === Event → scheduler wiring ===

/**
 * An event that may change the numbers happened (member join/leave, boost
 * change, role/channel create/delete). Cheap enough to call unconditionally
 * from every event handler — a no-op when the feature is disabled.
 * @param {string} guildId
 */
function markStatsDirty(guildId) {
    const cfg = load();
    if (!cfg || !cfg.enabled || !cfg.counters) return;
    if (guildId && cfg.guildId && guildId !== cfg.guildId) return;
    dirty = true;
}

/**
 * Is a refresh pending for this guild? (used by tests + diagnostics)
 */
function isDirty() {
    return dirty;
}

/**
 * Called from the 60s scheduler loop (via schedulerTasks.processServerStatsTick):
 * refreshes when an event marked the stats dirty OR every REFRESH_EVERY_TICKS
 * ticks as a catch-up (missed events self-heal).
 *
 * @param {Object} client - the discord.js Client
 * @returns {Promise<Object>} the refreshServerStats result (or {skipped})
 */
async function processSchedulerTick(client) {
    const cfg = load();
    if (!cfg || !cfg.enabled || !cfg.counters) return { skipped: true };

    schedulerTicks++;
    const due = dirty || schedulerTicks % REFRESH_EVERY_TICKS === 0;
    if (!due) return { skipped: true };

    const guild = client?.guilds?.cache?.get?.(cfg.guildId);
    if (!guild) return { noGuild: true };

    return refreshServerStats(guild);
}

/**
 * Test helper — reset all in-memory state (cooldowns, warnings, dirty flag,
 * tick counter) so tests are independent of each other.
 */
function _resetForTests() {
    cache = null;
    dirty = false;
    schedulerTicks = 0;
    for (const k of Object.keys(lastRenameAt)) delete lastRenameAt[k];
    warnedMissing.clear();
}

module.exports = {
    COUNTER_DEFS,
    buildCounterName,
    computeCounterValue,
    getConfig,
    isEnabled,
    saveConfig,
    clearConfig,
    reload,
    refreshServerStats,
    markStatsDirty,
    isDirty,
    processSchedulerTick,
    COOLDOWN_MS,
    REFRESH_EVERY_TICKS,
    _resetForTests
};
