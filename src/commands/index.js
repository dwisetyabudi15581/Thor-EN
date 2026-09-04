/**
 * Command Router — distribusi slash command ke handler per-domain.
 *
 * Arsitektur (v3.9.9 refactor):
 *   Slash command dipisah per file domain di src/commands/<domain>.js.
 *   Router ini cek permission (admin/public), lalu panggil handler domain.
 *
 * Domain mapping:
 *   - help                                → help.js
 *   - setup-verify, setup-ticket,
 *     set-role, set-channel, set-message,
 *     remove-role, remove-channel,
 *     list-messages, reset-message,
 *     reset-config, config-show          → config.js
 *   - add-product, remove-product,
 *     list-products, set-product-role,
 *     remove-product-role,
 *     list-product-roles                 → products.js
 *   - set-key, list-keys, clear-schedule → keys.js
 *   - setup-selfrole, selfrole-add,
 *     selfrole-remove, selfrole-list,
 *     selfrole-delete                    → selfrole.js
 *   - announce, announce-schedule,
 *     announce-list, announce-cancel     → announce.js
 *   - embed-builder, embed-list,
 *     embed-cancel                       → embed.js
 *   - backup-now, backup-list,
 *     restore-backup                     → backup.js
 *   - giveaway                           → giveaway.js
 *   - warn, warn-list, warn-remove,
 *     warn-clear                         → warn.js
 *   - stats, leaderboard, my-stats       → stats.js
 *   - poll                               → poll.js
 *   - setup-tempvoice, tempvoice-remove  → tempvoice.js
 *   - send-message                       → send-message.js
 *
 * Status: FULL SPLIT (v3.9.9). Semua command sudah di-domain-kan.
 * handlers/commandHandler.js di-deprecate — tidak dipakai router ini lagi.
 */

const { MessageFlags } = require('discord.js');
const { isAdmin: checkIsAdmin } = require('../infra/permissions');

// === Domain handlers ===
// Tiap file export satu async function (interaction) → void.
const helpHandler = require('./help');
const configHandler = require('./config');
const productsHandler = require('./products');
const keysHandler = require('./keys');
const selfroleHandler = require('./selfrole');
const announceHandler = require('./announce');
const embedHandler = require('./embed');
const backupHandler = require('./backup');
const giveawayHandler = require('./giveaway');
const warnHandler = require('./warn');
const statsHandler = require('./stats');
const pollHandler = require('./poll');
const tempvoiceHandler = require('./tempvoice');
const sendMessageHandler = require('./send-message');
// v3.9.11 Phase 2 & 3: new domains
const categoriesHandler = require('./categories');
const panelsHandler = require('./panels');
// v3.9.14: panel management (list/delete/update/refresh) — handler terpisah
const panelsMgmtHandler = require('./panels-mgmt');
// v3.9.13: new community features
const responderHandler = require('./responder');
const automodHandler = require('./automod');
const afkHandler = require('./afk');
const levelingHandler = require('./leveling');
// v3.9.32: midman/rekber commands (/set-midman-fee, /midman-deals)
const midmanHandler = require('./midman');

const DOMAIN_HANDLERS = {
    help: helpHandler,
    config: configHandler,
    products: productsHandler,
    keys: keysHandler,
    selfrole: selfroleHandler,
    announce: announceHandler,
    embed: embedHandler,
    backup: backupHandler,
    giveaway: giveawayHandler,
    warn: warnHandler,
    stats: statsHandler,
    poll: pollHandler,
    tempvoice: tempvoiceHandler,
    'send-message': sendMessageHandler,
    // v3.9.11 Phase 2 & 3
    categories: categoriesHandler,
    panels: panelsHandler,
    // v3.9.13
    responder: responderHandler,
    automod: automodHandler,
    afk: afkHandler,
    leveling: levelingHandler,
    // v3.9.14
    'panels-mgmt': panelsMgmtHandler,
    // v3.9.32
    midman: midmanHandler
};

// Mapping commandName → domain key (di DOMAIN_HANDLERS).
const COMMAND_TO_DOMAIN = {
    // help
    help: 'help',

    // config
    'setup-verify': 'config',
    'setup-ticket': 'config',
    'set-role': 'config',
    'set-channel': 'config',
    'set-message': 'config',
    'remove-role': 'config',
    'remove-channel': 'config',
    'list-messages': 'config',
    'reset-message': 'config',
    'reset-config': 'config',
    'config-show': 'config',
    // v3.9.12: modal editor untuk message config
    'edit-message': 'config',

    // v3.9.32: midman/rekber
    'set-midman-fee': 'midman',
    'midman-deals': 'midman',

    // products
    'add-product': 'products',
    'remove-product': 'products',
    'list-products': 'products',
    'set-product-role': 'products',
    'remove-product-role': 'products',
    'list-product-roles': 'products',

    // keys
    'set-key': 'keys',
    'list-keys': 'keys',
    'clear-schedule': 'keys',

    // selfrole
    'setup-selfrole': 'selfrole',
    'selfrole-add': 'selfrole',
    'selfrole-remove': 'selfrole',
    'selfrole-list': 'selfrole',
    'selfrole-delete': 'selfrole',

    // announce
    announce: 'announce',
    'announce-schedule': 'announce',
    'announce-list': 'announce',
    'announce-cancel': 'announce',

    // embed
    'embed-builder': 'embed',
    'embed-list': 'embed',
    'embed-cancel': 'embed',

    // backup
    'backup-now': 'backup',
    'backup-list': 'backup',
    'restore-backup': 'backup',

    // giveaway
    giveaway: 'giveaway',

    // warn
    warn: 'warn',
    'warn-list': 'warn',
    'warn-remove': 'warn',
    'warn-clear': 'warn',

    // stats
    stats: 'stats',
    leaderboard: 'stats',
    'my-stats': 'stats',

    // poll
    poll: 'poll',

    // tempvoice
    'setup-tempvoice': 'tempvoice',
    'tempvoice-remove': 'tempvoice',

    // send-message
    'send-message': 'send-message',

    // v3.9.11 Phase 2: categories
    'add-category': 'categories',
    'list-categories': 'categories',
    'remove-category': 'categories',
    // v3.9.24 FIX: dua command ini sebelumnya TERDAFTAR di registry + punya
    // handler + diiklankan di /help, tapi TIDAK di-map di sini → selalu error
    // "Command belum didukung oleh router". Bug ini ketutup karena router
    // gak error, cuma balas pesan "hubungi dev".
    'update-category': 'categories',
    'update-product': 'products',

    // v3.9.11 Phase 1 & 3: panels (verify button, multi-panel ticket)
    // v3.9.30: /set-transcript-channel dihapus — digabung ke /set-channel
    // tipe:transcript (domain config) supaya admin cuma hafal satu command channel.
    'set-verify-button': 'panels',
    'setup-ticket-panel': 'panels',

    // v3.9.14: panel management (list/delete/update/refresh)
    'list-panels': 'panels-mgmt',
    'delete-panel': 'panels-mgmt',
    'refresh-panel': 'panels-mgmt',
    'update-panel': 'panels-mgmt',

    // v3.9.13: Auto-Responder
    'add-responder': 'responder',
    'list-responder': 'responder',
    'remove-responder': 'responder',

    // v3.9.13: Anti-Spam & Auto-Mod
    'set-automod': 'automod',
    'automod-show': 'automod',
    'automod-toggle': 'automod',
    'add-link-whitelist': 'automod',
    // v3.9.23: word flex — kelola kata blocklist/exempt per kata
    'add-word': 'automod',
    'remove-word': 'automod',
    'list-words': 'automod',
    'remove-link-whitelist': 'automod',

    // v3.9.13: AFK System
    afk: 'afk',
    'afk-clear': 'afk',
    'afk-list': 'afk',

    // v3.9.13: Leveling System
    'setup-leveling': 'leveling',
    'add-level-role': 'leveling',
    'list-level-roles': 'leveling',
    'remove-level-role': 'leveling',
    rank: 'leveling',
    'leaderboard-level': 'leveling'
};

// Command yang boleh dipakai member biasa (bukan admin).
// v3.9.13: tambah afk, afk-clear, rank, leaderboard-level (public community features)
const PUBLIC_COMMANDS = ['leaderboard', 'my-stats', 'afk', 'afk-clear', 'rank', 'leaderboard-level'];

/**
 * Router utama — dipanggil dari index.js saat InteractionCreate (chatInputCommand).
 */
async function routeCommand(interaction) {
    if (!interaction.isChatInputCommand()) return;

    // === PERMISSION CHECK ===
    if (!checkIsAdmin(interaction.member) && !PUBLIC_COMMANDS.includes(interaction.commandName)) {
        return interaction.reply({
            content:
                '🚫 **Akses Ditolak.**\n\nSlash command hanya bisa dipakai oleh **Admin/Staff**.\n\nKalau kamu merasa ini salah, hubungi server admin.',
            flags: MessageFlags.Ephemeral
        });
    }

    // === DOMAIN DISPATCH ===
    const domain = COMMAND_TO_DOMAIN[interaction.commandName];
    const handler = domain ? DOMAIN_HANDLERS[domain] : null;
    if (handler) {
        return handler(interaction);
    }

    // Unknown command — kirim ephemeral error supaya admin tahu command belum didukung.
    // (Sebelumnya fallback ke handlers/commandHandler.js — sekarang sudah FULL SPLIT,
    //  jadi gak ada command yang harusnya lewat sini kecuali ada command baru yang
    //  belum di-map di COMMAND_TO_DOMAIN.)
    console.warn(`[router] Unmapped command: ${interaction.commandName}`);
    if (interaction.deferred || interaction.replied) return;
    return interaction.reply({
        content: `⚠️ Command \`${interaction.commandName}\` belum didukung oleh router. Hubungi dev.`,
        flags: MessageFlags.Ephemeral
    });
}

// v3.9.24: export mapping domain supaya bisa di-unit-test (guard anti
// "command terdaftar di registry tapi tidak pernah di-route" — bug yang
// persis kejadian pada /update-category & /update-product sebelum fix ini).
routeCommand.COMMAND_TO_DOMAIN = COMMAND_TO_DOMAIN;
routeCommand.DOMAIN_HANDLERS = DOMAIN_HANDLERS;

module.exports = routeCommand;
