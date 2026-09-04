/**
 * Interaction Router — dispatches buttons/select-menus/modals to per-domain handlers.
 *
 * Architecture (v3.9.9 refactor):
 *   customIds are split by prefix → separate domain handlers.
 *
 * Prefix mapping (every prefix here NOW has an active handler —
 * fallback to the legacy `handlers/interactionHandler.js` was REMOVED):
 *   - btn_verify                              → verify.js      (exact match)
 *   - ticket_cat:, ticket_, select_product, modal_set_key:,
 *     modal_deliver_order:                    → ticket.js
 *   - ticket_cat:midman (BEFORE ticket_cat:),
 *     modal_mm_, mm_ (user select mm_pick_buyer/mm_pick_seller/
 *     mm_pick_member, string select mm_remove_pick, mm_* buttons)
 *                                             → midman.js     (v3.9.34 escrow)
 *   - sr_btn:, sr_sel:                        → selfrole.js
 *   - emb_edit:, emb_preview:, emb_send:,
 *     emb_cancel:, emb_modal_                 → embed.js
 *   - gw_join:, gw_leave:                     → giveaway.js
 *   - poll_vote:, poll_modal_create:          → poll.js
 *   - tv_, tv_modal_                          → tempvoice.js
 *   - reset_config_, restore_backup_          → backup.js
 *
 * The router applies here (NOT in the domain handler):
 *   1. Interaction ID dedup (check before / mark AFTER handler success — v3.9.38)
 *      — defense against Discord retries.
 *   2. `replied/deferred` guard — interactions already replied/deferred are not re-processed.
 *   3. Interaction type filter (button/select/modal only).
 *   4. Routing by customId prefix.
 */

const { check, mark } = require('./_dedup');

// Domain handlers — each exports `async function(interaction)`.
const verifyDomain = require('./verify');
const ticketDomain = require('./ticket');
// v3.9.39: help domain — interactive /help navigation (category dropdown +
// search/all/home buttons + the search modal).
const helpDomain = require('./help');
// v3.9.32: midman/escrow domain (3-party escrow deals).
const midmanDomain = require('./midman');
const selfroleDomain = require('./selfrole');
const embedDomain = require('./embed');
const giveawayDomain = require('./giveaway');
const pollDomain = require('./poll');
const tempvoiceDomain = require('./tempvoice');
const backupDomain = require('./backup');
const configDomain = require('./config');
// v3.9.14: panel modal handler (modal_panel_edit:<panelId>:<field>)
// Imported from commands/panels-mgmt.js so its logic is reused with the slash command.
const { handlePanelModal: panelModalHandler } = require('../commands/panels-mgmt');

// Mapping customId prefix → domain.
// Sorted from most specific to most generic (startsWith matches the first
// prefix that fits). `select_product` is placed before `ticket_` because they
// are distinct prefixes and don't overlap — but the ordering stays defensive.
//
// `btn_verify` is handled by exact match (see the `pickDomain` helper).
const PREFIX_TO_DOMAIN = [
    { prefix: 'btn_verify', domain: 'verify', exact: true },
    // v3.9.39: /help navigation (select help_cat, buttons help_search/
    // help_home/help_all, modal help_search_modal). Stable customIds without
    // suffixes — the `help_` prefix catches them all, no collisions.
    { prefix: 'help_', domain: 'help' },
    { prefix: 'select_product', domain: 'ticket', exact: true },
    // v3.9.14: dropdown select menu from the panel (customId: ticket_cat_select)
    { prefix: 'ticket_cat_select', domain: 'ticket', exact: true },
    { prefix: 'modal_set_key:', domain: 'ticket' },
    // v3.9.27: Deliver Order modal (non-key products — mirrors modal_set_key).
    // MUST be explicit: modal prefixes have no generic fallback — without this entry
    // the modal submit would never reach the ticket handler (dead interaction).
    { prefix: 'modal_deliver_order:', domain: 'ticket' },
    // v3.9.32: midman/escrow. MUST come BEFORE the generic `ticket_cat:` prefix —
    // `ticket_cat:midman` (the escrow category button on the panel) must route to
    // the midman domain, not ticket (if it hit ticket_, the customId is unknown there).
    // v3.9.37: EXACT match — without this, a custom category that happens to start
    // with "midman" (e.g. `midman_jual`, a valid id per CATEGORY_ID_REGEX) would hit
    // the prefix match and die in the midman fallback (never replied).
    { prefix: 'ticket_cat:midman', domain: 'midman', exact: true },
    { prefix: 'modal_mm_', domain: 'midman' },
    { prefix: 'mm_', domain: 'midman' },
    { prefix: 'modal_edit_message:', domain: 'config' },
    // v3.9.14: panel edit modal (modal_panel_edit:<panelId>:<field>)
    { prefix: 'modal_panel_edit:', domain: 'panel-modal' },
    // ticket_cat: is explicit here (before ticket_) so routing stays clear,
    // not relying on the fragile ticket_ fallback in case of a future refactor.
    { prefix: 'ticket_cat:', domain: 'ticket' },
    { prefix: 'ticket_', domain: 'ticket' },
    { prefix: 'sr_btn:', domain: 'selfrole' },
    { prefix: 'sr_sel:', domain: 'selfrole' },
    { prefix: 'emb_edit:', domain: 'embed' },
    { prefix: 'emb_preview:', domain: 'embed' },
    { prefix: 'emb_send:', domain: 'embed' },
    { prefix: 'emb_cancel:', domain: 'embed' },
    { prefix: 'emb_modal_', domain: 'embed' },
    { prefix: 'gw_join:', domain: 'giveaway' },
    { prefix: 'gw_leave:', domain: 'giveaway' },
    { prefix: 'poll_vote:', domain: 'poll' },
    { prefix: 'poll_modal_create:', domain: 'poll' },
    { prefix: 'tv_modal_', domain: 'tempvoice' },
    { prefix: 'tv_', domain: 'tempvoice' },
    { prefix: 'reset_config_', domain: 'backup' },
    { prefix: 'restore_backup_', domain: 'backup' }
];

const DOMAIN_HANDLERS = {
    verify: verifyDomain,
    ticket: ticketDomain,
    help: helpDomain,
    midman: midmanDomain,
    selfrole: selfroleDomain,
    embed: embedDomain,
    giveaway: giveawayDomain,
    poll: pollDomain,
    tempvoice: tempvoiceDomain,
    backup: backupDomain,
    config: configDomain,
    // v3.9.14: panel modal handler (not a regular domain — a direct function)
    'panel-modal': { handler: panelModalHandler }
};

/**
 * Pick the domain handler based on the customId.
 * Returns the function, or `null` when nothing matches.
 *
 * v3.9.14: a domain can be:
 *   - async function(interaction) → called directly
 *   - { handler: async function(interaction) } → wrapper (for modals imported
 *     from commands/* instead of interactions/*). The `pickDomain` function
 *     returns the function itself, not the wrapper object.
 */
function pickDomain(customId) {
    if (!customId) return null;
    for (const entry of PREFIX_TO_DOMAIN) {
        let matched = false;
        if (entry.exact) {
            if (customId === entry.prefix) matched = true;
        } else if (customId.startsWith(entry.prefix)) {
            matched = true;
        }
        if (matched) {
            const domainEntry = DOMAIN_HANDLERS[entry.domain];
            if (!domainEntry) return null;
            // If it's a { handler } wrapper, return the function directly.
            if (domainEntry.handler && typeof domainEntry.handler === 'function') {
                return domainEntry.handler;
            }
            // If it's a plain function, return it as-is.
            if (typeof domainEntry === 'function') return domainEntry;
            return null;
        }
    }
    return null;
}

/**
 * Main router — called from src/bot/events/interactionCreate.js
 * on InteractionCreate (button/select/modal).
 *
 * v3.9.8 FIX: dedup + the replied/deferred guard are applied HERE (not in
 * the domain handler) so domain handlers can focus on their logic and the
 * interaction is always fresh when dispatched.
 */
async function routeInteraction(interaction) {
    if (interaction.isChatInputCommand()) return; // slash command → command router
    // v3.9.33: added isUserSelectMenu — the member dropdown (mm_pick_seller)
    // must reach the midman domain (previously only button/string-select/modal).
    // v3.9.34: also used by mm_pick_buyer & mm_pick_member; the string select
    // mm_remove_pick is covered by the existing isStringSelectMenu.
    if (
        !interaction.isButton() &&
        !interaction.isStringSelectMenu() &&
        !interaction.isUserSelectMenu() &&
        !interaction.isModalSubmit()
    ) {
        return;
    }

    // P1-6 FIX: check for a duplicate interaction ID first (defense-in-depth).
    // Discord sometimes fires the same event twice on a retry.
    // v3.9.8: if an entry exists but is older than the TTL, treat it as unprocessed.
    // v3.9.38 FIX: only CHECK here — MARK was moved to AFTER handler success.
    // Previously checkAndMark marked BEFORE the handler ran → if the handler
    // crashed, the gateway replay from Discord for the same interaction got swallowed
    // (already "processed" when it wasn't) → the user's action silently vanished.
    if (check(interaction.id)) {
        return;
    }

    // Guard: skip if the interaction is already replied/deferred.
    // A modal submit that was already replied = CONSIDERED PROCESSED, don't continue.
    if (interaction.replied || interaction.deferred) {
        return;
    }

    // Determine the domain from the customId prefix
    const handler = pickDomain(interaction.customId || '');
    if (handler) {
        // v3.9.38 FIX: mark the interaction only AFTER handler success — the
        // `mark()` line below doesn't run if the handler throws (the await throws
        // the error to the caller, the entry is NOT marked) → the gateway replay
        // (Discord retrying the same interaction) can process it again. No
        // try/catch rethrow because the semantics are identical (eslint no-useless-catch).
        const result = await handler(interaction);
        mark(interaction.id);
        return result;
    }

    // v3.9.9 refactor: fallback to the legacy handler was REMOVED. Every customId
    // that should be handled already has a domain. Getting here means the
    // interaction is unrecognized — log a warning so any new unrouted customId
    // becomes visible (defensive observability).
    console.warn(`[interactionRouter] unrecognized customId (no domain match): ${interaction.customId}`);
}

module.exports = routeInteraction;
