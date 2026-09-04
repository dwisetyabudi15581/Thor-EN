/**
 * Command Router — routes slash commands to per-domain handlers.
 *
 * Architecture (v3.9.9 refactor):
 *   Slash commands are split per domain file in src/commands/<domain>.js.
 *   This router checks permissions (admin/public), then calls the domain handler.
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
 * Status: FULL SPLIT (v3.9.9). All commands are domain-ized.
 * handlers/commandHandler.js is deprecated — no longer used by this router.
 */

const { MessageFlags } = require('discord.js');
const { isAdmin: checkIsAdmin } = require('../infra/permissions');

// === Domain handlers ===
// Each file exports a single async function (interaction) → void.
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
// v3.9.14: panel management (list/delete/update/refresh) — separate handler
const panelsMgmtHandler = require('./panels-mgmt');
// v3.9.13: new community features
const responderHandler = require('./responder');
const automodHandler = require('./automod');
const afkHandler = require('./afk');
const levelingHandler = require('./leveling');
// v3.9.32: midman/escrow commands (/set-midman-fee, /midman-deals)
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

// Mapping commandName → domain key (in DOMAIN_HANDLERS).
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
    // v3.9.12: modal editor for message config
    'edit-message': 'config',

    // v3.9.32: midman/escrow
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
    // v3.9.24 FIX: these two commands were previously REGISTERED in the registry + had a
    // handler + were advertised in /help, but were NOT mapped here → always errored
    // with "Command not supported by router". The bug stayed hidden because the
    // router didn't error, it just replied "contact the dev".
    'update-category': 'categories',
    'update-product': 'products',

    // v3.9.11 Phase 1 & 3: panels (verify button, multi-panel ticket)
    // v3.9.30: /set-transcript-channel removed — merged into /set-channel
    // type:transcript (config domain) so admins only memorize one channel command.
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
    // v3.9.23: word flex — manage blocklist/exempt words per word
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

// Commands that regular members (non-admins) may use.
// v3.9.13: added afk, afk-clear, rank, leaderboard-level (public community features)
const PUBLIC_COMMANDS = ['leaderboard', 'my-stats', 'afk', 'afk-clear', 'rank', 'leaderboard-level'];

/**
 * Main router — called from index.js on InteractionCreate (chatInputCommand).
 */
async function routeCommand(interaction) {
    if (!interaction.isChatInputCommand()) return;

    // === PERMISSION CHECK ===
    if (!checkIsAdmin(interaction.member) && !PUBLIC_COMMANDS.includes(interaction.commandName)) {
        return interaction.reply({
            content:
                '🚫 **Access Denied.**\n\nSlash commands can only be used by **Admin/Staff**.\n\nIf you believe this is a mistake, contact a server admin.',
            flags: MessageFlags.Ephemeral
        });
    }

    // === DOMAIN DISPATCH ===
    const domain = COMMAND_TO_DOMAIN[interaction.commandName];
    const handler = domain ? DOMAIN_HANDLERS[domain] : null;
    if (handler) {
        return handler(interaction);
    }

    // Unknown command — send an ephemeral error so the admin knows the command isn't supported yet.
    // (Previously it fell back to handlers/commandHandler.js — now it's a FULL SPLIT,
    //  so no command should end up here except a new command that hasn't been
    //  mapped in COMMAND_TO_DOMAIN yet.)
    console.warn(`[router] Unmapped command: ${interaction.commandName}`);
    if (interaction.deferred || interaction.replied) return;
    return interaction.reply({
        content: `⚠️ Command \`${interaction.commandName}\` is not supported by the router yet. Contact the dev.`,
        flags: MessageFlags.Ephemeral
    });
}

// v3.9.24: export the domain mapping so it can be unit-tested (guard against
// "command registered in the registry but never routed" — the exact bug that
// happened to /update-category & /update-product before this fix).
routeCommand.COMMAND_TO_DOMAIN = COMMAND_TO_DOMAIN;
routeCommand.DOMAIN_HANDLERS = DOMAIN_HANDLERS;

module.exports = routeCommand;
