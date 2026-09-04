/**
 * Thor — Community Bot
 * Entry point (v3.9.9 refactor: slim, event-driven via src/bot/events/).
 *
 * Flow:
 *   1. Init Discord client dengan intents + partials.
 *   2. Attach error handlers (unhandledRejection log-only, uncaughtException → shutdown).
 *   3. Attach scheduler functions ke client (supaya commandHandler bisa panggil).
 *   4. Load event handlers dari src/bot/events/*.js.
 *   5. Expose refreshGlobalControlPanel ke client (dipakai interactionHandler).
 *   6. Graceful shutdown (async, 3s timeout, flush stats cache).
 *   7. Login.
 *
 * Semua business logic ada di:
 *   - src/commands/        (slash command handlers, per-domain)
 *   - src/interactions/    (button/select/modal handlers, per-domain)
 *   - src/data/            (JSON persistence layer)
 *   - src/services/        (scheduler tasks, business logic)
 *   - src/ui/              (embed/panel builders)
 *   - src/infra/           (safeWrite, safeReply, userLock, permissions, constants, auditLog, text)
 *   - src/bot/events/      (Discord event handlers)
 *
 * v3.9.24: legacy handlers/ sudah lama dihapus — komentar fallback dibuang.
 */

const { Client, GatewayIntentBits, Partials } = require('discord.js');
require('dotenv').config();

// === MIGRATE LEGACY JSON FILES to data/ folder (v3.9.10) ===
// Sebelum v3.9.10, file JSON (config.json, keys.json, dll) disimpan di root folder.
// Sekarang dipindah ke data/ folder supaya root bersih (hanya source code).
// Migration ini jalan sekali saat startup — kalau file lama ada di root, pindahkan.
// Aman: kalau file sudah ada di data/, file root diabaikan (data/ adalah source of truth).
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
                console.warn(`⚠️ Gagal migrate ${f} ke data/: ${err.message}`);
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
        // WAJIB: Message Content Intent. Tanpa ini, message.content selalu kosong buat
        // pesan user lain, jadi auto-responder, anti-spam kata/link, dan AFK mention
        // reply gak bakal jalan.
        // ⚠️ Intent ini juga harus di-enable di Discord Developer Portal:
        //   https://discord.com/developers/applications → Bot → Privileged Gateway Intents
        //   → toggle "Message Content Intent" jadi ON.
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User]
});

// === Attach scheduler functions ke client (supaya commandHandler bisa panggil) ===
const { attachToClient } = require('./src/services/schedulerTasks');
attachToClient(client);

// === ERROR HANDLER GLOBAL ===
// v3.9.8: uncaughtException → graceful shutdown (bot lanjut jalan di state rusak berisiko korup data).
process.on('unhandledRejection', reason => {
    console.error('⚠️ Unhandled Rejection:', reason);
});
process.on('uncaughtException', err => {
    console.error('⚠️ Uncaught Exception (will shutdown after log):', err);
    // v3.9.24 FIX: exit code 1 (bukan 0). Sebelumnya exit(0) — systemd/PM2/Docker
    // menganggap "clean exit" dan TIDAK me-restart bot setelah crash sungguhan.
    gracefulShutdown('uncaughtException', 1);
});

// v3.9.24: observabilitas gateway — tanpa ini, disconnect/reconnect storm
// dari Discord tidak kelihatan sama sekali di log (bot cuma diam).
client.on('shardError', err => {
    console.error('⚠️ Discord gateway error:', err?.message ?? err);
});
client.on('shardDisconnect', (event, id) => {
    console.warn(`⚠️ Discord shard #${id} disconnect (code ${event?.code}) — reconnect otomatis.`);
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
    // v3.9.24: safety net — kalau handler lupa try/catch internal, error tetap
    // ter-log DENGAN nama event (bukan cuma unhandledRejection tanpa konteks).
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

// Expose refreshGlobalControlPanel ke client (dipakai interactionHandler setelah rename/kick/limit/lock/transfer/delete).
const voiceStateHandler = require('./src/bot/events/voiceStateUpdate');
client.refreshGlobalControlPanel = voiceStateHandler.refreshGlobalControlPanel;

// === GRACEFUL SHUTDOWN ===
// v3.9.8: async supaya shutdownStats() (yang butuh write file ke disk) benar-benar selesai sebelum exit.
const { shutdown: shutdownStats } = require('./src/data/statsManager');

// v3.9.24 FIX: re-entry guard. Sebelumnya, SIGINT kedua (atau uncaughtException
// saat shutdown jalan) menjalankan gracefulShutdown LAGI secara paralel →
// double flush + double client.destroy(). Sekarang: panggilan kedua di-ignore.
let isShuttingDown = false;

async function gracefulShutdown(signal, exitCode = 0) {
    if (isShuttingDown) {
        console.log(`⚠️ Shutdown sudah berjalan — sinyal ${signal} diabaikan.`);
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
    console.error('❌ Gagal login ke Discord:', err.message);
    process.exit(1);
});
