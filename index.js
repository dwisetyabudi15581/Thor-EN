/**
 * Thor — Community Bot
 * Entry point (v3.9.9 refactor: slim, event-driven via src/bot/events/).
 *
 * Flow:
 *   1. Initialize the Discord client with intents + partials.
 *   2. Attach error handlers (unhandledRejection log-only, uncaughtException → shutdown).
 *   3. Attach scheduler functions to the client (so commandHandler can call them).
 *   4. Load event handlers from src/bot/events/*.js.
 *   5. Expose refreshGlobalControlPanel on the client (used by interactionHandler).
 *   6. Graceful shutdown (async, 3s timeout, flush stats cache).
 *   7. Login.
 *
 * All business logic lives in:
 *   - src/commands/        (slash command handlers, per-domain)
 *   - src/interactions/    (button/select/modal handlers, per-domain)
 *   - src/data/            (JSON persistence layer)
 *   - src/services/        (scheduler tasks, business logic)
 *   - src/ui/              (embed/panel builders)
 *   - src/infra/           (safeWrite, safeReply, userLock, permissions, constants, auditLog, text)
 *   - src/bot/events/      (Discord event handlers)
 *
 * v3.9.24: legacy handlers/ was removed long ago — the fallback comment is gone.
 */

const { Client, GatewayIntentBits, Partials } = require('discord.js');
require('dotenv').config();

// === MIGRATE LEGACY JSON FILES to data/ folder (v3.9.10) ===
// Before v3.9.10, JSON files (config.json, keys.json, etc.) were stored in the root folder.
// Now they are moved to the data/ folder to keep the root clean (source code only).
// This migration runs once at startup — if an old file exists in the root, move it.
// Safe: if the file already exists in data/, the root file is ignored (data/ is the source of truth).
(() => {
    const fs = require('fs');
    const path = require('path');
    const rootDir = __dirname;
    const dataDir = path.join(rootDir, 'data');
    const LEGACY_FILES = [
        'config.json',
        'keys.json',
        'scheduledRoles.json',
        'selfRoles.json',
        'giveaways.json',
        'warns.json',
        'polls.json',
        'scheduledAnnouncements.json',
        'stats.json',
        'tempVoice.json',
        'tickets.json'
    ];
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    let migrated = 0;
    for (const f of LEGACY_FILES) {
        const oldPath = path.join(rootDir, f);
        const newPath = path.join(dataDir, f);
        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
            try {
                fs.renameSync(oldPath, newPath);
                migrated++;
            } catch (err) {
                console.warn(`⚠️ Failed to migrate ${f} to data/: ${err.message}`);
            }
        }
    }
    if (migrated > 0) console.log(`📦 Migrated ${migrated} legacy JSON file(s) from root → data/ folder.`);
})();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        // REQUIRED: Message Content Intent. Without it, message.content is always empty
        // for other users' messages, so auto-responder, anti-spam word/link checks,
        // and AFK mention replies won't work.
        // ⚠️ This intent must also be enabled in the Discord Developer Portal:
        //   https://discord.com/developers/applications → Bot → Privileged Gateway Intents
        //   → toggle "Message Content Intent" ON.
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User]
});

// === Attach scheduler functions to the client (so commandHandler can call them) ===
const { attachToClient } = require('./src/services/schedulerTasks');
attachToClient(client);

// === GLOBAL ERROR HANDLER ===
// v3.9.8: uncaughtException → graceful shutdown (keeping the bot running in a broken state risks data corruption).
process.on('unhandledRejection', reason => {
    console.error('⚠️ Unhandled Rejection:', reason);
});
process.on('uncaughtException', err => {
    console.error('⚠️ Uncaught Exception (will shutdown after log):', err);
    // v3.9.24 FIX: exit code 1 (not 0). Previously exit(0) — systemd/PM2/Docker
    // treated it as a "clean exit" and did NOT restart the bot after a real crash.
    gracefulShutdown('uncaughtException', 1);
});

// v3.9.24: gateway observability — without this, a disconnect/reconnect storm
// from Discord is completely invisible in the logs (the bot just stays silent).
client.on('shardError', err => {
    console.error('⚠️ Discord gateway error:', err?.message ?? err);
});
client.on('shardDisconnect', (event, id) => {
    console.warn(`⚠️ Discord shard #${id} disconnect (code ${event?.code}) — automatic reconnect.`);
});
client.on('shardReconnecting', id => {
    console.warn(`🔄 Discord shard #${id} reconnecting...`);
});

// === LOAD EVENT HANDLERS ===
const eventHandlers = [
    require('./src/bot/events/ready'),
    require('./src/bot/events/interactionCreate'),
    require('./src/bot/events/guildMemberAdd'),
    require('./src/bot/events/guildMemberRemove'),
    require('./src/bot/events/messageCreate'),
    require('./src/bot/events/voiceStateUpdate')
];

for (const handler of eventHandlers) {
    // v3.9.24: safety net — if a handler forgets its internal try/catch, the error
    // still gets logged WITH the event name (not just a bare unhandledRejection with no context).
    const wrapper = (...args) =>
        Promise.resolve(handler.execute(...args)).catch(err => {
            console.error(`[${handler.name}] event handler error:`, err);
        });
    if (handler.once) {
        client.once(handler.name, wrapper);
    } else {
        client.on(handler.name, wrapper);
    }
}

// Expose refreshGlobalControlPanel on the client (used by interactionHandler after rename/kick/limit/lock/transfer/delete).
const voiceStateHandler = require('./src/bot/events/voiceStateUpdate');
client.refreshGlobalControlPanel = voiceStateHandler.refreshGlobalControlPanel;

// === GRACEFUL SHUTDOWN ===
// v3.9.8: async so shutdownStats() (which needs to write files to disk) truly finishes before exit.
const { shutdown: shutdownStats } = require('./src/data/statsManager');

// v3.9.24 FIX: re-entry guard. Previously, a second SIGINT (or an uncaughtException
// while a shutdown was in progress) ran gracefulShutdown AGAIN in parallel →
// double flush + double client.destroy(). Now: the second call is ignored.
let isShuttingDown = false;

async function gracefulShutdown(signal, exitCode = 0) {
    if (isShuttingDown) {
        console.log(`⚠️ Shutdown already in progress — signal ${signal} ignored.`);
        return;
    }
    isShuttingDown = true;
    console.log(`\n⚠️ Received ${signal}, flushing stats & shutting down...`);
    try {
        await Promise.race([Promise.resolve(shutdownStats()), new Promise(resolve => setTimeout(resolve, 3000))]);
    } catch (_) {}
    try {
        client.destroy();
    } catch (_) {}
    process.exit(exitCode);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT', 0));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 0));

// === LOGIN ===
client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('❌ Failed to log in to Discord:', err.message);
    process.exit(1);
});
