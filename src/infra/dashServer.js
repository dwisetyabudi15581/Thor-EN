/**
 * Dashboard API Server (v3.17.0) — a small HTTP API for the WEB DASHBOARD.
 *
 * Concept : every bot setting can be controlled through TWO
 * channels — slash commands directly in Discord, OR the web dashboard.
 * Both write to the same data source (data/config/<guildId>.json etc.),
 * so the state can never diverge.
 *
 * Architecture:
 *   [Browser] ⇄ [Next.js Dashboard] ⇄ DASH API (this file, in the bot process) ⇄ data/*.json
 *
 * Security:
 *   - Default bind 127.0.0.1 — only the dashboard (same host) can access it.
 *     Do NOT expose it publicly; the web dashboard is the public door
 *     (with Discord login + per-server ManageGuild permission checks).
 *   - The `x-dash-token` header is required, compared timing-safe against
 *     DASH_API_TOKEN.
 *   - Without DASH_API_TOKEN in .env → the server does NOT run (safe default).
 *   - Strict validation of every field: section whitelist, data types, string
 *     lengths, snowflake format — plus a prototype-pollution guard (the
 *     configManager.setField pattern).
 *
 * Endpoints (all JSON):
 *   GET    /health                              → bot status + guild count
 *   GET    /guilds                              → list of guilds the bot is in
 *   GET    /guilds/:id/meta                     → channels + roles (for web pickers)
 *   GET    /guilds/:id/dashboard                → ALL module data in one pull
 *   PUT    /guilds/:id/config                   → { updates: { dotPath: value } }
 *   PUT    /guilds/:id/automod                  → merge a partial automod config
 *   POST   /guilds/:id/responders               → add an auto-responder
 *   DELETE /guilds/:id/responders?trigger=...   → remove a responder (by trigger)
 *   POST   /guilds/:id/announce                 → schedule an announcement
 *   DELETE /guilds/:id/announce/:annId          → cancel an announcement
 *   POST   /guilds/:id/selfroles                → create a self-role panel (sends the message)
 *   PUT    /guilds/:id/selfroles/:panelId       → edit a live panel (v3.26.0 — /selfrole-update parity)
 *   POST   /guilds/:id/selfroles/:panelId/roles → add a role to a panel (re-renders)
 *   DELETE /guilds/:id/selfroles/:panelId/roles?roleId=... → remove a role from a panel
 *   DELETE /guilds/:id/selfroles/:panelId       → delete the panel + its message
 *   POST   /guilds/:id/serverstats/refresh      → force-refresh the counters
 *   POST   /guilds/:id/panels                   → install ticket panel to a channel (v3.21.0)
 *   PUT    /guilds/:id/panels/:panelId           → edit panel fields (v3.26.0 — /update-panel parity)
 *   POST   /guilds/:id/panels/:panelId/refresh   → re-render with latest config (v3.26.0 — /refresh-panel parity)
 *   DELETE /guilds/:id/panels/:panelId           → delete panel + message (v3.26.0 — /delete-panel parity)
 *   POST   /guilds/:id/giveaway/end             → end + announce winners (v3.26.0 — /giveaway end parity)
 *   POST   /guilds/:id/giveaway/reroll          → reroll a winner (v3.26.0 — /giveaway reroll parity)
 *   POST   /guilds/:id/poll/close               → close + final results (v3.26.0 — /poll close parity)
 *   POST   /guilds/:id/verify-panel             → install THE verification panel (v3.28.0 — /setup-verify parity: one-way + Verified role)
 *   DELETE /guilds/:id/tempvoice                → detach the temp voice setup (config only)
 *
 * Actor audit: every write operation receives `actor: { id, tag }` (the
 * logged-in dashboard user) — logged to console + audit log where possible,
 * so the trail of "who changed what from the web" is always preserved.
 */

const http = require('http');
const crypto = require('crypto');

// Data layer — the SAME single source of truth as the slash commands.
const { getConfig, saveConfig, setField, DEFAULTS } = require('../data/configManager');
const automodManager = require('../data/automodManager');
const responderManager = require('../data/responderManager');
const selfRoleManager = require('../data/selfRoleManager');
const tempVoiceManager = require('../data/tempVoiceManager');
const announcements = require('../data/scheduledAnnouncements');
const serverstatsManager = require('../data/serverstatsManager');
const { buildPanelEmbed, buildPanelComponents } = require('../ui/selfRolePanelBuilder');
const { normalizeNewlines, isValidEmoji } = require('./text');
// v3.19.0: new modules for the Command Manager + web Giveaway / Poll /
// Embed / Backup / Moderation / Keys modules.
const giveawayManager = require('../data/giveawayManager');
const pollManager = require('../data/pollManager');
const backupManager = require('../data/backupManager');
const warnManager = require('../data/warnManager');
const modLogManager = require('../data/modLogManager');
const keyManager = require('../data/keyManager');
const roleScheduler = require('../data/roleScheduler');
const { getCommands } = require('../commands/registry');
const { normalizeDisabledList, PROTECTED_COMMANDS } = require('../commands/commands');
const { COMMAND_TO_DOMAIN } = require('../commands/index.js');
// v3.20.0: Custom Commands (created on the web -> real slash commands on the
// server) + full embed builder (validation centralized in embedPayload.js).
const customCommandManager = require('../data/customCommandManager');
const { syncGuildCustomCommands } = require('../services/customCommandSync');
const { normalizeEmbedDef, buildEmbedFromDef, isEmbedEmpty } = require('./embedPayload');
// v3.21.0: Quick Start module (web) — install ticket + verification panels.
// The SAME builder + storage as the slash commands (full two-way parity:
// a panel installed from the web = a panel installed from /setup-ticket-panel).
const panelManager = require('../data/panelManager');
// v3.24.0: full feature parity — VIEW data that used to be Discord-only
// (/stats /leaderboard /boosters /afk-list /midman-deals /leaderboard-level)
// now ships with the dashboard payload.
const statsManager = require('../data/statsManager');
const afkManager = require('../data/afkManager');
const boostManager = require('../data/boostManager');
const midmanManager = require('../data/midmanManager');
const levelManager = require('../data/levelManager');
// v3.24.0: /test-welcome from the web — the SAME builder as the real event.
const { buildWelcomeEmbed, buildGoodbyeEmbed } = require('../bot/memberHandler');
const { buildTicketPanel, parseColor, validateUrl, findEmptyCategoryWarnings } = require('../commands/panels');
// v3.24.4: full slash-command parity from the web — moderation guards
// (hierarchy/timeout/purge validation, the SAME rules as the slash commands),
// the boost preview builders, and the audit logger for the new mutation
// endpoints (reset-message/reset-config/warn/send-message/booster-test/
// moderate/purge).
const {
    validateModerationTarget,
    validateTimeoutDuration,
    validatePurgeAmount,
    filterBulkDeletable,
    isValidUserId,
    BAN_DELETE_DAYS_MAX
} = require('./moderationGuards');
const { buildBoostAddEmbed, buildBoostRemoveEmbed } = require('../bot/boostHandler');
const { logAudit } = require('./auditLog');
// v3.26.0: full parity for giveaway end/reroll + poll close from the web —
// the SAME locks + announce helpers the slash commands use, so a web end
// and a Discord end can never double-pick winners.
const { withLock: withUserLock } = require('./userLock');
const {
    isGiveawayProcessing,
    processGiveawayEnd,
    announceRerollWinner
} = require('../services/schedulerTasks');
const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionFlagsBits
} = require('discord.js');

// Version straight from package.json — never goes stale (v3.17.0).
const BOT_VERSION = require('../../package.json').version;

const MAX_BODY_BYTES = 256 * 1024; // 256KB — enough for long messages, small for abuse
const SNOWFLAKE_RE = /^\d{5,25}$/;
const BUTTON_STYLES = ['Primary', 'Secondary', 'Success', 'Danger'];

// ============================================================
// === Config field validation (whitelist per section) ===
// ============================================================

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSnowflakeOrNull(v) {
    return v === null || v === '' || (typeof v === 'string' && SNOWFLAKE_RE.test(v));
}

function isStr(v, max) {
    return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/**
 * Validator per top-level config section. Each validator returns
 * { ok: true, value } (the normalized value) or { ok: false, error }.
 */
const SECTION_VALIDATORS = {
    roles: (key, value) => {
        // v3.23.0: the unverified marker concept was REMOVED — reject with a
        // message pointing to the replacement (autorole + removeOnNewRole).
        if (key === 'unverified') {
            return { ok: false, error: 'roles.unverified was removed in v3.23.0 — join roles are now managed via autorole (list + removeOnNewRole toggle)' };
        }
        // v3.28.0: roles.verified is back (set by /setup-verify and the
        // verify-panel endpoint). The panel link (verifyPanelId) stays
        // managed-only: pointing it at an arbitrary panel by hand could
        // desync the verified-role lifecycle.
        if (key === 'verifyPanelId') {
            return { ok: false, error: 'roles.verifyPanelId is managed by /setup-verify (or POST verify-panel) — install or delete the verification panel there' };
        }
        if (!/^[a-z][a-zA-Z0-9_-]{0,39}$/.test(key)) return { ok: false, error: `Invalid role key name: ${key}` };
        if (!isSnowflakeOrNull(value)) return { ok: false, error: `roles.${key} must be a Discord ID or null` };
        return { ok: true, value: value || null };
    },
    channels: (key, value) => {
        if (!/^[a-z][a-zA-Z0-9_-]{0,39}$/.test(key)) return { ok: false, error: `Invalid channel key name: ${key}` };
        if (!isSnowflakeOrNull(value)) return { ok: false, error: `channels.${key} must be a Discord ID or null` };
        return { ok: true, value: value || null };
    },
    messages: (key, value) => {
        if (!/^[a-zA-Z0-9_-]{1,60}$/.test(key)) return { ok: false, error: `Invalid message name: ${key}` };
        if (!isStr(value, 4000)) return { ok: false, error: `messages.${key} must be text of 1-4000 characters` };
        return { ok: true, value };
    },
    colors: (key, value) => {
        if (!/^(success|danger|primary|warning|info)$/.test(key)) return { ok: false, error: `Unknown color: ${key}` };
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 0xffffff) return { ok: false, error: `colors.${key} must be an integer 0-16777215` };
        return { ok: true, value: n };
    },
    // v3.22.0: verifyButton section REMOVED — the verification feature was
    // deleted (self-role panels now). Old dashboard builds that still send
    // verifyButton.* get a clean "Unknown section" 422.
    // v3.23.0: autorole — the join auto-role list (web parity with
    // /set-autorole) + the removeOnNewRole toggle (keyed path, see
    // validateUpdate).
    autorole: (key, value) => {
        if (key !== '__array__') return { ok: false, error: 'autorole can only be set as a whole array (autorole.roleIds) or the autorole.removeOnNewRole toggle' };
        if (!Array.isArray(value)) return { ok: false, error: 'autorole must be an array of role IDs' };
        if (value.length > 10) return { ok: false, error: 'autorole accepts at most 10 roles' };
        for (const id of value) {
            if (!isSnowflakeOrNull(id) || !id) return { ok: false, error: 'autorole must contain Discord role IDs (no nulls)' };
        }
        return { ok: true, value: { roleIds: value } };
    },
    leveling: (key, value) => {
        switch (key) {
            case 'enabled':
                return { ok: true, value: !!value };
            case 'xpPerMessage': {
                const n = Number(value);
                if (!Number.isInteger(n) || n < 1 || n > 1000) return { ok: false, error: 'xpPerMessage must be 1-1000' };
                return { ok: true, value: n };
            }
            case 'cooldownMs': {
                const n = Number(value);
                if (!Number.isInteger(n) || n < 1000 || n > 3600000) return { ok: false, error: 'cooldownMs must be 1000-3600000' };
                return { ok: true, value: n };
            }
            case 'announceLevelUp':
                return { ok: true, value: !!value };
            case 'levelUpChannel':
                if (!isSnowflakeOrNull(value)) return { ok: false, error: 'levelUpChannel must be a channel ID or null' };
                return { ok: true, value: value || null };
            default:
                return { ok: false, error: `leveling.${key} is unknown` };
        }
    },
    levelRoles: (key, value) => {
        // levelRoles is ALWAYS set as a whole array (dotPath "levelRoles")
        if (key !== '__array__') return { ok: false, error: 'levelRoles can only be set as a whole array' };
        if (!Array.isArray(value)) return { ok: false, error: 'levelRoles must be an array' };
        if (value.length > 50) return { ok: false, error: 'Maximum 50 level roles' };
        for (const entry of value) {
            if (!entry || typeof entry !== 'object') return { ok: false, error: 'Invalid levelRoles entry' };
            const lvl = Number(entry.level);
            if (!Number.isInteger(lvl) || lvl < 1 || lvl > 1000) return { ok: false, error: 'Level must be 1-1000' };
            if (!SNOWFLAKE_RE.test(String(entry.roleId || ''))) return { ok: false, error: 'Invalid roleId' };
        }
        return { ok: true, value: value.map(e => ({ level: Number(e.level), roleId: String(e.roleId) })) };
    },
    midman: (key, value) => {
        if (key === 'feeMode') {
            if (!['percent', 'flat'].includes(value)) return { ok: false, error: 'feeMode: percent | flat' };
            return { ok: true, value };
        }
        if (key === 'feeValue') {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0 || n > 1e9) return { ok: false, error: 'feeValue must be 0 - 1 billion' };
            return { ok: true, value: n };
        }
        if (key === 'category') {
            if (!isStr(value, 100)) return { ok: false, error: 'Category name must be 1-100 characters' };
            return { ok: true, value };
        }
        return { ok: false, error: `midman.${key} is unknown` };
    },
    ticketCategories: (key, value) => {
        if (key !== '__array__') return { ok: false, error: 'ticketCategories can only be set as a whole array' };
        if (!Array.isArray(value)) return { ok: false, error: 'ticketCategories must be an array' };
        if (value.length === 0) return { ok: false, error: 'At least 1 ticket category is required' };
        if (value.length > 25) return { ok: false, error: 'Maximum 25 categories' };
        const seen = new Set();
        for (const cat of value) {
            if (!cat || typeof cat !== 'object') return { ok: false, error: 'Invalid category' };
            if (!/^[a-z0-9_-]{2,32}$/.test(String(cat.id || ''))) return { ok: false, error: `Category id must be a 2-32 char slug: ${cat.id}` };
            if (seen.has(cat.id)) return { ok: false, error: `Duplicate category id: ${cat.id}` };
            seen.add(cat.id);
            if (!isStr(String(cat.label || ''), 80)) return { ok: false, error: `Category label ${cat.id} must be 1-80 characters` };
            if (cat.emoji && !isStr(String(cat.emoji), 64)) return { ok: false, error: 'Invalid category emoji' };
            if (cat.style && !BUTTON_STYLES.includes(cat.style)) return { ok: false, error: `Unknown style for category ${cat.id}` };
            if (cat.requiresKey !== undefined && typeof cat.requiresKey !== 'boolean') return { ok: false, error: 'requiresKey must be a boolean' };
        }
        return {
            ok: true,
            value: value.map(c => ({
                id: String(c.id),
                label: String(c.label),
                emoji: String(c.emoji || '🎫'),
                style: c.style || 'Primary',
                requiresKey: !!c.requiresKey,
                ...(c.isDefault !== undefined ? { isDefault: !!c.isDefault } : {})
            }))
        };
    },
    products: (key, value) => {
        if (key !== '__array__') return { ok: false, error: 'products can only be set as a whole array' };
        if (!Array.isArray(value)) return { ok: false, error: 'products must be an array' };
        if (value.length > 25) return { ok: false, error: 'Maximum 25 products (Discord dropdown limit)' };
        for (const p of value) {
            if (!p || typeof p !== 'object') return { ok: false, error: 'Invalid product' };
            if (!isStr(String(p.label || ''), 100)) return { ok: false, error: 'Product label must be 1-100 characters' };
            if (!isStr(String(p.value || ''), 100)) return { ok: false, error: 'Product value must be 1-100 characters' };
            if (!isStr(String(p.price || ''), 100)) return { ok: false, error: 'Product price must be 1-100 characters' };
            if (p.duration && !isStr(String(p.duration), 100)) return { ok: false, error: 'Invalid duration' };
            if (p.category && !/^[a-z0-9_-]{2,32}$/.test(String(p.category))) return { ok: false, error: 'Invalid product category' };
            if (p.requiresKey !== undefined && typeof p.requiresKey !== 'boolean') return { ok: false, error: 'requiresKey must be a boolean' };
            // v3.19.0 FIX (data loss): roleId + days used to be STRIPPED when
            // products were saved from the web — even though /set-product-role
            // stores them on the product object. Editing the price list via
            // web silently dropped every auto-role mapping. Both are now
            // preserved + validated (full Discord ↔ web parity).
            if (p.roleId !== undefined && p.roleId !== null && !SNOWFLAKE_RE.test(String(p.roleId))) {
                return { ok: false, error: 'Product roleId must be a valid Discord ID' };
            }
            if (p.days !== undefined && p.days !== null && (!Number.isInteger(Number(p.days)) || Number(p.days) < 0 || Number(p.days) > 3650)) {
                return { ok: false, error: 'Product days must be an integer 0-3650 (0 = permanent)' };
            }
        }
        return {
            ok: true,
            value: value.map(p => {
                const out = {
                    label: String(p.label),
                    value: String(p.value),
                    price: String(p.price),
                    category: p.category ? String(p.category) : 'transaction',
                    requiresKey: !!p.requiresKey
                };
                if (p.duration) out.duration = String(p.duration);
                // v3.19.0: keep the role mapping (set via /set-product-role).
                if (p.roleId) out.roleId = String(p.roleId);
                if (p.days !== undefined && p.days !== null) out.days = Number(p.days);
                return out;
            })
        };
    }
};

/**
 * Validate a single { dotPath, value } update.
 * @returns {{ ok: true, section, key, value } | { ok: false, error }}
 */
function validateUpdate(dotPath, value) {
    if (typeof dotPath !== 'string' || dotPath.length > 120 || !/^[a-zA-Z0-9_.-]+$/.test(dotPath)) {
        return { ok: false, error: 'Invalid dotPath' };
    }
    const parts = dotPath.split('.');
    for (const p of parts) {
        if (FORBIDDEN_KEYS.has(p)) return { ok: false, error: `Forbidden path: ${dotPath}` };
    }
    const section = parts[0];
    const validator = SECTION_VALIDATORS[section];
    if (!validator) return { ok: false, error: `Unknown section: ${section}` };

    // Array sections (levelRoles / ticketCategories / products) — always a whole array.
    // v3.23.0: autorole has TWO shapes: a whole array (the join role list)
    // and the keyed path `autorole.removeOnNewRole` (boolean toggle). Both
    // can arrive together in a single PUT from the SaveBar.
    if (section === 'autorole' && parts.length === 2 && parts[1] === 'removeOnNewRole') {
        if (typeof value !== 'boolean') return { ok: false, error: 'autorole.removeOnNewRole must be a boolean (true/false)' };
        return { ok: true, section: 'autorole', key: 'removeOnNewRole', value };
    }
    if (['levelRoles', 'ticketCategories', 'products', 'autorole'].includes(section)) {
        if (parts.length !== 1) return { ok: false, error: `${section} can only be set as a whole array` };
        const r = validator('__array__', value);
        return r.ok ? { ok: true, section, key: null, value: r.value } : r;
    }
    if (parts.length !== 2) return { ok: false, error: `Path must be ${section}.<field>` };

    const r = validator(parts[1], value);
    return r.ok ? { ok: true, section, key: parts[1], value: r.value } : r;
}

/** Apply a set of validated updates to the in-memory config object + save once. */
function applyUpdates(config, updates) {
    const errors = [];
    const applied = [];
    for (const [dotPath, rawValue] of Object.entries(updates)) {
        const v = validateUpdate(dotPath, rawValue);
        if (!v.ok) {
            errors.push(`${dotPath}: ${v.error}`);
            continue;
        }
        if (v.key === null) {
            // v3.23.0: setting the autorole whole array must NOT wipe the
            // removeOnNewRole toggle — both paths (autorole +
            // autorole.removeOnNewRole) can arrive together in one PUT;
            // merge, don't replace.
            if (v.section === 'autorole') {
                config.autorole = { ...(config.autorole || {}), ...v.value };
            } else {
                config[v.section] = v.value; // whole array
            }
            // /remove-category semantics: the built-in claim_giveaway & midman
            // categories are automatically re-added by getConfig() as long as
            // the dismissal flag is not set. The dashboard must set/unset the
            // same flags so the saved result is EXACTLY what the admin sees
            // on the web.
            if (v.section === 'ticketCategories') {
                const ids = new Set(v.value.map((c) => c.id));
                if (ids.has('claim_giveaway')) delete config.claimGiveawayDismissed;
                else config.claimGiveawayDismissed = true;
                if (ids.has('midman')) delete config.midmanCategoryDismissed;
                else config.midmanCategoryDismissed = true;
                // v3.24.2 PARITY FIX: /remove-category (Discord) remaps products
                // orphaned by a deleted category to 'transaction' so they never
                // silently vanish from every panel dropdown. The web path used to
                // skip this — deleting a category from the web left its products
                // as orphans. Now both paths behave the same: any product whose
                // category no longer exists falls back to 'transaction' (or the
                // first remaining category if 'transaction' itself was deleted).
                if (Array.isArray(config.products) && v.value.length > 0) {
                    const fallback = ids.has('transaction') ? 'transaction' : String(v.value[0].id);
                    config.products = config.products.map((p) =>
                        p && typeof p.category === 'string' && !ids.has(p.category)
                            ? { ...p, category: fallback }
                            : p
                    );
                }
            }
        } else if (config[v.section] && typeof config[v.section] === 'object') {
            config[v.section][v.key] = v.value;
        } else {
            config[v.section] = { [v.key]: v.value };
        }
        applied.push(dotPath);
    }
    return { errors, applied };
}

// ============================================================
// === Automod validation (partial merge) ===
// ============================================================

function validateAutomodPatch(patch) {
    const out = {};
    const errs = [];
    const boolKeys = ['enabled', 'blockLinks'];
    const intRules = {
        spamThreshold: [1, 100],
        spamWindowMs: [1000, 600000],
        maxMentions: [1, 50]
    };
    const actionValues = ['warn', 'mute_10m', 'mute_1h', 'kick', 'delete_only'];
    const arrayStrKeys = ['linkAllowedChannels', 'linkAllowedRoles', 'exemptWords'];

    for (const [k, v] of Object.entries(patch)) {
        if (boolKeys.includes(k)) {
            if (typeof v !== 'boolean') { errs.push(`${k} must be a boolean`); continue; }
            out[k] = v;
        } else if (intRules[k]) {
            const n = Number(v);
            const [min, max] = intRules[k];
            if (!Number.isInteger(n) || n < min || n > max) { errs.push(`${k} must be an integer ${min}-${max}`); continue; }
            out[k] = n;
        } else if (k === 'spamAction' || k === 'wordAction' || k === 'mentionAction') {
            if (!actionValues.includes(v)) { errs.push(`${k} is unknown`); continue; }
            out[k] = v;
        } else if (arrayStrKeys.includes(k)) {
            if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || x.length > 200)) { errs.push(`${k} must be an array of strings`); continue; }
            out[k] = v;
        } else if (k === 'wordMatchMode') {
            if (!['whole_word', 'substring'].includes(v)) { errs.push('wordMatchMode: whole_word | substring'); continue; }
            out[k] = v;
        } else if (k === 'wordRules') {
            // Whole wordRules array: [{ word, action, addedBy? }]
            if (!Array.isArray(v) || v.length > 500) { errs.push('wordRules must be an array (max 500)'); continue; }
            const rules = [];
            for (const w of v) {
                if (!w || !isStr(String(w.word || ''), 100)) { errs.push('wordRules: invalid word (1-100 chars)'); continue; }
                const action = w.action && actionValues.includes(w.action) ? w.action : null;
                rules.push({ word: String(w.word).toLowerCase(), action, addedBy: w.addedBy ? String(w.addedBy) : 'dash', addedAt: w.addedAt || Date.now() });
            }
            out.wordRules = rules;
        } else {
            errs.push(`Unknown automod field: ${k}`);
        }
    }
    return { out, errs };
}

// ============================================================
// === Core handler ===
// ============================================================

/**
 * Create the request handler (pure — easy to unit-test without listening).
 * @param {Object} opts
 *   - client: the discord.js Client instance (used for guild meta + sending/
 *     editing the self-role panel message; unit tests inject a mock).
 *   - token: the secret string (required; the handler dies if empty).
 *   - log: optional log function (default console.log).
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>}
 */
function createDashHandler({ client, token, log = () => {} }) {
    if (!token || typeof token !== 'string') {
        throw new Error('createDashHandler: token is required (without a token the server must not run)');
    }

    const expected = Buffer.from(token);

    function authOk(req) {
        const got = req.headers['x-dash-token'];
        if (!got || typeof got !== 'string') return false;
        const b = Buffer.from(got);
        if (b.length !== expected.length) return false;
        return crypto.timingSafeEqual(b, expected);
    }

    function sendJson(res, code, obj) {
        const body = JSON.stringify(obj);
        res.writeHead(code, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store'
        });
        res.end(body);
    }

    function readBody(req, res) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', (c) => {
                size += c.length;
                if (size > MAX_BODY_BYTES) {
                    // v3.24.1 FIX (L2): reply 413 BEFORE destroying the socket — the
                    // old code destroyed the connection first, so the 500 sent by the
                    // caller's catch block never reached the client (socket hang up).
                    reject(new Error('Body too large'));
                    if (res && !res.headersSent) {
                        try {
                            res.writeHead(413, { 'content-type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Body too large' }));
                            return;
                        } catch (_) { /* already gone */ }
                    }
                    req.destroy();
                    return;
                }
                chunks.push(c);
            });
            req.on('end', () => {
                if (chunks.length === 0) return resolve({});
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch {
                    reject(new Error('Body is not valid JSON'));
                }
            });
            req.on('error', reject);
        });
    }

    /** Guild from the client cache; null if the bot is not in that guild. */
    function getGuild(guildId) {
        if (!client?.guilds?.cache) return null;
        return client.guilds.cache.get(guildId) || null;
    }

    function guildSummaries() {
        if (!client?.guilds?.cache) return [];
        return [...client.guilds.cache.values()].map((g) => ({
            id: g.id,
            name: g.name,
            icon: g.icon ?? null,
            memberCount: typeof g.memberCount === 'number' ? g.memberCount : null,
            ownerId: g.ownerId ?? null
        }));
    }

    function guildMeta(g) {
        const channels = [...(g.channels?.cache?.values() || [])]
            .map((c) => ({ id: c.id, name: c.name, type: c.type, position: c.rawPosition ?? 0 }))
            .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
        const roles = [...(g.roles?.cache?.values() || [])]
            .map((r) => ({ id: r.id, name: r.name, color: r.color ?? 0, position: r.position ?? 0 }))
            .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
        return {
            id: g.id,
            name: g.name,
            icon: g.icon ?? null,
            memberCount: typeof g.memberCount === 'number' ? g.memberCount : null,
            channels,
            roles
        };
    }

    function dashboardPayload(guildId) {
        const tempVoiceCfg = tempVoiceManager.getGuildConfig(guildId);
        const config = getConfig(guildId);
        return {
            config,
            // v3.23.1: a guild that never touched AutoMod makes
            // getGuildConfig() return null — that null payload crashed the
            // web Overview & AutoMod pages (reading .enabled off null).
            // Fallback: default config with enabled=false (honest: for a
            // fresh guild messageCreate skips automod because cfg is null,
            // so show "off", not the default enabled=true).
            automod:
                automodManager.getGuildConfig(guildId) ||
                { ...automodManager.getDefaultConfig(), enabled: false },
            responders: responderManager.getGuildResponders(guildId),
            selfroles: selfRoleManager.getPanelsByGuild(guildId),
            tempvoice: tempVoiceCfg
                ? {
                      creatorChannelId: tempVoiceCfg.creatorChannelId || null,
                      categoryId: tempVoiceCfg.categoryId || null,
                      activeChannels: tempVoiceCfg.channels ? Object.keys(tempVoiceCfg.channels).length : 0
                  }
                : null,
            announces: announcements.getByGuild(guildId),
            serverstats: {
                enabled: serverstatsManager.isEnabled(),
                config: serverstatsManager.getConfig()
            },
            // v3.19.0: Command Manager — the command list (from the registry,
            // single source of truth) + per-guild disabled state. `protected`
            // = commands that can never be disabled (the management door).
            commands: {
                // v3.20.0: this guild's custom commands are appended to the
                // list (domain 'custom') so they can be toggled from the web
                // Command Manager — full parity with /commands toggle.
                list: [
                    ...getCommands().map((c) => ({
                        name: c.name,
                        description: c.description,
                        domain: COMMAND_TO_DOMAIN[c.name] || 'other'
                    })),
                    ...customCommandManager.getGuildCommands(guildId).map((c) => ({
                        name: c.name,
                        description: c.description,
                        domain: 'custom',
                        custom: true
                    }))
                ],
                disabled: Array.isArray(config?.disabledCommands) ? config.disabledCommands : [],
                protected: PROTECTED_COMMANDS
            },
            // v3.20.0: full custom command definitions (Custom Command module —
            // create/edit/delete here, writes go through the endpoints below).
            customCommands: customCommandManager.getGuildCommands(guildId),
            // v3.19.0: new module data (read-only; writes go through endpoints).
            giveaways: giveawayManager.getByGuild(guildId),
            polls: pollManager.getByGuild(guildId),
            backups: backupManager.listBackups().slice(0, 25),
            warns: warnManager.getGuildWarns(guildId, 50),
            modlogs: modLogManager.getGuildModLogs(guildId, 50),
            keys: keyManager
                .getAllKeys()
                .filter((k) => k.guildId === guildId)
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
                .slice(0, 100),
            // v3.21.0: installed ticket panels — used by the Quick Start module
            // as the checklist status (the "install ticket panel" step).
            // Slim shape so the payload stays light (a panel body can be 4000 chars).
            panels: panelManager
                .getPanelsByGuild(guildId)
                .slice(0, 50)
                .map((p) => ({
                    id: p.id,
                    channelId: p.channelId,
                    messageId: p.messageId,
                    title: p.title,
                    categoryIds: Array.isArray(p.categoryIds) ? p.categoryIds : [],
                    useDropdown: !!p.useDropdown,
                    createdAt: p.createdAt || null
                })),
            // v3.24.0: full feature parity — the web Statistics module now
            // reads the SAME data as /stats, /leaderboard, /boosters,
            // /afk-list, /midman-deals, /leaderboard-level. All read-only,
            // slim shapes, best-effort tags from the user cache (no bulk
            // fetch — the dashboard shows the ID when no tag is available).
            stats: {
                server: statsManager.getServerStats(guildId),
                top: {
                    messages: statsManager.getTopUsers(guildId, 'messages', 10),
                    purchases: statsManager.getTopUsers(guildId, 'vipPurchases', 10),
                    spends: statsManager.getTopUsers(guildId, 'totalSpent', 10),
                    wins: statsManager.getTopUsers(guildId, 'giveawaysWon', 10)
                }
            },
            levelTop: levelManager.getTopUsers(guildId, 10),
            afk: afkManager.listGuildAFK(guildId).slice(0, 100),
            midmanDeals: midmanManager
                .getActiveDealsByGuild(guildId)
                .slice(0, 25)
                .map((d) => {
                    const totals = midmanManager.calcTotals(d.priceNum, d.fee);
                    return {
                        id: d.id,
                        channelId: d.channelId,
                        state: d.state,
                        stateLabel: midmanManager.STATES[d.state]?.label || d.state,
                        buyerId: d.buyerId,
                        sellerId: d.sellerId,
                        item: String(d.item || '').slice(0, 60),
                        buyerPays: totals.buyerPays,
                        sellerGets: totals.sellerGets,
                        fee: totals.midmanKeeps,
                        createdAt: d.createdAt || null
                    };
                }),
            boosters: {
                live: (() => {
                    const g = client.guilds.cache.get(guildId);
                    // Guard: a partial/mock guild may lack members.cache.
                    const members = [...(g?.members?.cache?.values() || [])];
                    return members
                        .filter((m) => m.premiumSinceTimestamp)
                        .sort((a, b) => a.premiumSinceTimestamp - b.premiumSinceTimestamp)
                        .slice(0, 50)
                        .map((m) => ({
                            userId: m.id,
                            tag: m.user?.tag || null,
                            since: m.premiumSinceTimestamp
                        }));
                })(),
                recent: boostManager.getRecentEvents(guildId, 10)
            }
        };
    }

    /** Re-render the panel message after its roles changed (best-effort). */
    async function reRenderPanel(panelId) {
        const panel = selfRoleManager.getPanel(panelId);
        if (!panel || !panel.messageId || !panel.channelId) return;
        try {
            const channel = await client.channels.fetch(panel.channelId);
            const msg = await channel.messages.fetch(panel.messageId);
            await msg.edit({ embeds: [buildPanelEmbed(panel, client)], components: buildPanelComponents(panel) });
        } catch (err) {
            log(`[dash] re-render panel ${panelId} failed (best-effort): ${err.message}`);
        }
    }

    return async function handler(req, res) {
        // v3.24.1 FIX (M1): URL parsing moved INSIDE try/catch — a malformed
        // request target (e.g. absolute-form URL with an out-of-range port)
        // used to throw before the auth check, producing an unhandled
        // rejection and a hung socket (no response until requestTimeout).
        let url;
        try {
            url = new URL(req.url, 'http://localhost');
        } catch {
            return sendJson(res, 400, { error: 'Invalid request target' });
        }
        const parts = url.pathname.split('/').filter(Boolean); // ["guilds", id, ...]
        const method = req.method;

        // Health endpoint WITHOUT auth (for liveness checks from the same
        // host; it leaks nothing but the numbers).
        if (method === 'GET' && url.pathname === '/health') {
            return sendJson(res, 200, {
                ok: true,
                ready: !!client?.isReady?.() || !!client?.ws?.status,
                guildCount: guildSummaries().length,
                uptimeSec: Math.floor(process.uptime()),
                version: BOT_VERSION
            });
        }

        if (!authOk(req)) return sendJson(res, 401, { error: 'Invalid token' });

        try {
            // ---- GET /guilds ----
            if (method === 'GET' && parts[0] === 'guilds' && parts.length === 1) {
                return sendJson(res, 200, { guilds: guildSummaries() });
            }

            // ---- /guilds/:id/... ----
            if (parts[0] === 'guilds' && parts.length >= 2) {
                const guildId = parts[1];
                if (!SNOWFLAKE_RE.test(guildId)) return sendJson(res, 400, { error: 'Invalid guildId' });
                const g = getGuild(guildId);
                const rest = parts.slice(2); // e.g. ["meta"] / ["responders"]

                // GET meta — the bot must be in the guild
                if (method === 'GET' && rest[0] === 'meta') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    return sendJson(res, 200, guildMeta(g));
                }

                // GET dashboard — module data is readable even while the guild
                // cache is still cold (config does not depend on the Discord cache).
                if (method === 'GET' && rest[0] === 'dashboard') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    return sendJson(res, 200, dashboardPayload(guildId));
                }

                // ---- PUT /guilds/:id/config ----
                if (method === 'PUT' && rest[0] === 'config') {
                    const body = await readBody(req, res);
                    const updates = body?.updates;
                    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
                        return sendJson(res, 400, { error: 'Body must be { updates: { dotPath: value } }' });
                    }
                    const keys = Object.keys(updates);
                    if (keys.length === 0) return sendJson(res, 400, { error: 'updates is empty' });
                    if (keys.length > 100) return sendJson(res, 400, { error: 'Maximum 100 fields per request' });

                    const config = getConfig(guildId);
                    const { errors, applied } = applyUpdates(config, updates);
                    if (errors.length > 0) {
                        return sendJson(res, 422, { error: 'Validation failed', details: errors });
                    }
                    saveConfig(guildId, config);

                    // Invalidate the permission cache if the admin role changed
                    // (the setField pattern).
                    if (applied.some((p) => p.startsWith('roles.admin'))) {
                        try {
                            const { invalidateAdminRoleCache } = require('./permissions');
                            invalidateAdminRoleCache();
                        } catch (_) { /* not loaded yet — ignore */ }
                    }
                    log(`[dash] config ${guildId} updated (${applied.length} fields) by ${body?.actor?.tag || body?.actor?.id || 'unknown'}`);
                    return sendJson(res, 200, { ok: true, applied, config: getConfig(guildId) });
                }

                // ---- PUT /guilds/:id/automod ----
                if (method === 'PUT' && rest[0] === 'automod') {
                    const body = await readBody(req, res);
                    if (!body || typeof body !== 'object' || Array.isArray(body)) {
                        return sendJson(res, 400, { error: 'Body must be an automod object' });
                    }
                    // v3.24.1 FIX (L1): capture the actor BEFORE deleting it from the
                    // body — the old code read `out.__actor` which never existed, so the
                    // audit trail always logged "unknown" for automod changes.
                    const automodActor = body?.actor?.tag || body?.actor?.id || 'unknown';
                    delete body.actor; // actor is not an automod field
                    const { out, errs } = validateAutomodPatch(body);
                    if (errs.length > 0) return sendJson(res, 422, { error: 'Validation failed', details: errs });
                    const merged = automodManager.setGuildConfig(guildId, out);
                    log(`[dash] automod ${guildId} updated by ${automodActor}`);
                    return sendJson(res, 200, { ok: true, automod: merged });
                }

                // ---- Responders ----
                if (rest[0] === 'responders') {
                    if (method === 'POST' && rest.length === 1) {
                        const body = await readBody(req, res);
                        const trigger = String(body?.trigger || '').trim();
                        const reply = String(body?.reply || '').trim();
                        if (!isStr(trigger, 50)) return sendJson(res, 400, { error: 'Trigger must be 1-50 characters' });
                        if (!isStr(reply, 2000)) return sendJson(res, 400, { error: 'Reply must be 1-2000 characters' });
                        const matchMode = ['contains', 'exact'].includes(body?.matchMode) ? body.matchMode : 'contains';
                        const replyType = ['text', 'embed'].includes(body?.replyType) ? body.replyType : 'text';
                        const cooldownMs = Number(body?.cooldownMs ?? 3000);
                        if (!Number.isInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > 600000) {
                            return sendJson(res, 400, { error: 'cooldownMs must be 0-600000' });
                        }
                        const result = responderManager.addResponder(guildId, {
                            trigger,
                            reply,
                            matchMode,
                            replyType,
                            cooldownMs,
                            createdBy: body?.actor?.id || 'dash',
                            createdByTag: body?.actor?.tag || 'Dashboard'
                        });
                        if (!result.ok) return sendJson(res, 409, { error: result.error });
                        log(`[dash] responder "${trigger}" added in ${guildId}`);
                        return sendJson(res, 201, { ok: true, responders: responderManager.getGuildResponders(guildId) });
                    }
                    if (method === 'DELETE' && rest.length === 1) {
                        const trigger = url.searchParams.get('trigger');
                        if (!trigger) return sendJson(res, 400, { error: 'The trigger parameter is required' });
                        const result = responderManager.removeResponder(guildId, trigger);
                        if (!result.ok) return sendJson(res, 404, { error: result.error });
                        return sendJson(res, 200, { ok: true, responders: responderManager.getGuildResponders(guildId) });
                    }
                }

                // ---- Announce (scheduled) ----
                if (rest[0] === 'announce') {
                    if (method === 'POST' && rest.length === 1) {
                        const body = await readBody(req, res);
                        const channelId = String(body?.channelId || '');
                        if (!SNOWFLAKE_RE.test(channelId)) return sendJson(res, 400, { error: 'Invalid channelId' });
                        if (!isStr(String(body?.title || ''), 256)) return sendJson(res, 400, { error: 'Title must be 1-256 characters' });
                        if (!isStr(String(body?.description || ''), 4000)) return sendJson(res, 400, { error: 'Description must be 1-4000 characters' });
                        // sendAt: epoch ms or an ISO string; must be in the future.
                        let sendAt = body?.sendAt;
                        if (typeof sendAt === 'string' && sendAt) {
                            const parsed = Date.parse(sendAt);
                            if (Number.isNaN(parsed)) return sendJson(res, 400, { error: 'Invalid sendAt' });
                            sendAt = parsed;
                        }
                        sendAt = Number(sendAt);
                        if (!Number.isFinite(sendAt) || sendAt < Date.now() - 60000 || sendAt > Date.now() + 1000 * 60 * 60 * 24 * 365) {
                            return sendJson(res, 400, { error: 'Send time must be between now and 1 year from now' });
                        }
                        const recurring = [null, 'daily', 'weekly', 'monthly'].includes(body?.recurring ?? null)
                            ? (body?.recurring ?? null)
                            : null;
                        const entry = announcements.create({
                            guildId,
                            channelId,
                            sendAt,
                            title: String(body.title),
                            description: String(body.description),
                            color: Number.isInteger(body?.color) ? body.color : 0x5865f2,
                            image: body?.image ? String(body.image).slice(0, 500) : null,
                            thumbnail: body?.thumbnail ? String(body.thumbnail).slice(0, 500) : null,
                            mention: body?.mention ? String(body.mention).slice(0, 200) : null,
                            recurring,
                            authorId: body?.actor?.id || 'dash',
                            authorTag: body?.actor?.tag || 'Dashboard'
                        });
                        log(`[dash] announcement scheduled in ${guildId} (${entry.id})`);
                        return sendJson(res, 201, { ok: true, announcement: entry });
                    }
                    if (method === 'DELETE' && rest.length === 2) {
                        // v3.24.1 SECURITY FIX (H1): the announcement ID must belong to
                        // THIS guild — otherwise an admin of guild A could delete an
                        // announcement of guild B by ID (cross-guild IDOR).
                        const ann = announcements.get(rest[1]);
                        if (!ann) return sendJson(res, 404, { error: 'Announcement not found' });
                        if (ann.guildId !== guildId) return sendJson(res, 404, { error: 'Announcement not found' });
                        const ok = announcements.remove(rest[1]);
                        if (!ok) return sendJson(res, 404, { error: 'Announcement not found' });
                        return sendJson(res, 200, { ok: true });
                    }
                }

                // ---- Self-role panels ----
                if (rest[0] === 'selfroles') {
                    // v3.26.0: PUT — edit a live panel (parity with the NEW
                    // /selfrole-update slash command + the web "Edit panel" form).
                    // Same guild-IDOR guard as every other selfroles route.
                    if (method === 'PUT' && rest.length === 2) {
                        const body = await readBody(req, res);
                        const target = selfRoleManager.getPanel(rest[1]);
                        if (!target || target.guildId !== guildId) {
                            return sendJson(res, 404, { error: 'Panel not found' });
                        }
                        // At least one editable field must be present.
                        const hasTitle = body?.title !== undefined;
                        const hasDescription = body?.description !== undefined;
                        const hasType = body?.type !== undefined;
                        const hasExclusive = body?.exclusive !== undefined;
                        // v3.27.0: one-way (verification) mode.
                        const hasOnce = body?.once !== undefined;
                        if (!hasTitle && !hasDescription && !hasType && !hasExclusive && !hasOnce) {
                            return sendJson(res, 400, { error: 'Provide at least one of: title, description, type, exclusive, once' });
                        }
                        const updates = {};
                        if (hasTitle) {
                            const t = String(body.title).trim();
                            if (!t || t.length > 256) return sendJson(res, 400, { error: 'Title must be 1-256 characters' });
                            updates.title = t;
                        }
                        if (hasDescription) {
                            const d = normalizeNewlines(String(body.description));
                            if (d.length > 4000) return sendJson(res, 400, { error: 'Description must be at most 4000 characters' });
                            updates.description = d;
                        }
                        if (hasType) {
                            if (body.type !== 'button' && body.type !== 'select') {
                                return sendJson(res, 400, { error: 'type must be button | select' });
                            }
                            updates.type = body.type;
                        }
                        if (hasExclusive) updates.exclusive = !!body.exclusive;
                        if (hasOnce) updates.once = !!body.once;

                        const updated = selfRoleManager.updatePanel(rest[1], updates);
                        if (!updated) {
                            return sendJson(res, 422, { error: 'Failed to update the panel (empty title?) — nothing was changed' });
                        }
                        await reRenderPanel(rest[1]);
                        await logAudit(client, {
                            action: 'SELFROLE_UPDATE',
                            actorId: String(body?.actor?.id || ''),
                            actorTag: String(body?.actor?.tag || 'web dashboard'),
                            details: `Update self-role panel **${updated.title}** (${rest[1]}) — ${Object.keys(updates).join(', ')}`,
                            guildId
                        }).catch(() => {});
                        log(`[dash] self-role panel ${rest[1]} updated in ${guildId} by ${body?.actor?.tag || 'unknown'}`);
                        return sendJson(res, 200, { ok: true, panel: selfRoleManager.getPanel(rest[1]) });
                    }

                    if (method === 'POST' && rest.length === 1) {
                        const body = await readBody(req, res);
                        const channelId = String(body?.channelId || '');
                        if (!SNOWFLAKE_RE.test(channelId)) return sendJson(res, 400, { error: 'Invalid channelId' });
                        const type = body?.type === 'select' ? 'select' : 'button';
                        const roles = Array.isArray(body?.roles) ? body.roles : [];
                        if (roles.length === 0 || roles.length > 25) return sendJson(res, 400, { error: 'A panel needs 1-25 roles' });

                        // Create the panel + fill its roles BEFORE sending the message.
                        const panel = selfRoleManager.createPanel({
                            guildId,
                            channelId,
                            title: String(body?.title || '🎭 Self Role').slice(0, 200),
                            description: normalizeNewlines(String(body?.description || 'Click to take / drop a role.').slice(0, 2000)),
                            type,
                            exclusive: !!body?.exclusive,
                            // v3.27.0: one-way (verification) panel.
                            once: !!body?.once
                        });
                        for (const r of roles) {
                            if (!SNOWFLAKE_RE.test(String(r?.roleId || ''))) {
                                selfRoleManager.deletePanel(panel.id);
                                return sendJson(res, 400, { error: 'Invalid roleId' });
                            }
                            const added = selfRoleManager.addRoleToPanel(panel.id, {
                                roleId: String(r.roleId),
                                label: String(r.label || 'Role').slice(0, 80),
                                emoji: r.emoji ? String(r.emoji).slice(0, 64) : undefined,
                                description: r.description ? String(r.description).slice(0, 100) : undefined,
                                style: BUTTON_STYLES.includes(r.style) ? r.style : 'Secondary'
                            });
                            if (!added.ok) {
                                selfRoleManager.deletePanel(panel.id);
                                return sendJson(res, 400, { error: added.error });
                            }
                        }

                        // Send the panel message (roll the entry back on failure — P0-5).
                        try {
                            const channel = await client.channels.fetch(channelId);
                            const fresh = selfRoleManager.getPanel(panel.id);
                            const panelMsg = await channel.send({
                                embeds: [buildPanelEmbed(fresh, client)],
                                components: buildPanelComponents(fresh)
                            });
                            selfRoleManager.setMessageId(panel.id, panelMsg.id);
                        } catch (err) {
                            selfRoleManager.deletePanel(panel.id);
                            return sendJson(res, 502, { error: `Failed to send the panel to the channel: ${err.message}` });
                        }
                        log(`[dash] self-role panel created in ${guildId} (${panel.id})`);
                        return sendJson(res, 201, { ok: true, panel: selfRoleManager.getPanel(panel.id) });
                    }

                    if (method === 'POST' && rest.length === 3 && rest[2] === 'roles') {
                        const body = await readBody(req, res);
                        if (!SNOWFLAKE_RE.test(String(body?.roleId || ''))) return sendJson(res, 400, { error: 'Invalid roleId' });
                        // v3.24.1 SECURITY FIX (H1): the panel must belong to THIS guild —
                        // otherwise an admin of guild A could add roles to guild B's panel
                        // by panel ID (cross-guild IDOR → privilege escalation via a
                        // self-role click in guild B).
                        const targetPanel = selfRoleManager.getPanel(rest[1]);
                        if (!targetPanel || targetPanel.guildId !== guildId) {
                            return sendJson(res, 404, { error: 'Panel not found' });
                        }
                        // v3.26.0: requiresRoleId — the conditional-role gate from
                        // /selfrole-add (only members already holding that role see the
                        // button). Optional + snowflake-validated, exactly like the slash option.
                        let requiresRoleId = null;
                        if (body?.requiresRoleId !== undefined && body?.requiresRoleId !== null && body?.requiresRoleId !== '') {
                            if (!SNOWFLAKE_RE.test(String(body.requiresRoleId))) {
                                return sendJson(res, 400, { error: 'Invalid requiresRoleId' });
                            }
                            requiresRoleId = String(body.requiresRoleId);
                        }
                        const added = selfRoleManager.addRoleToPanel(rest[1], {
                            roleId: String(body.roleId),
                            label: String(body?.label || 'Role').slice(0, 80),
                            emoji: body?.emoji ? String(body.emoji).slice(0, 64) : undefined,
                            description: body?.description ? String(body.description).slice(0, 100) : undefined,
                            style: BUTTON_STYLES.includes(body?.style) ? body.style : 'Secondary',
                            requiresRoleId
                        });
                        if (!added.ok) return sendJson(res, 409, { error: added.error });
                        await reRenderPanel(rest[1]);
                        return sendJson(res, 200, { ok: true, panel: selfRoleManager.getPanel(rest[1]) });
                    }

                    if (method === 'DELETE' && rest.length === 3 && rest[2] === 'roles') {
                        const roleId = url.searchParams.get('roleId');
                        if (!roleId) return sendJson(res, 400, { error: 'The roleId parameter is required' });
                        // v3.24.1 SECURITY FIX (H1): the panel must belong to THIS guild (cross-guild IDOR).
                        const rolesPanel = selfRoleManager.getPanel(rest[1]);
                        if (!rolesPanel || rolesPanel.guildId !== guildId) {
                            return sendJson(res, 404, { error: 'Panel not found' });
                        }
                        const removed = selfRoleManager.removeRoleFromPanel(rest[1], roleId);
                        if (!removed.ok) return sendJson(res, 404, { error: removed.error });
                        await reRenderPanel(rest[1]);
                        return sendJson(res, 200, { ok: true, panel: selfRoleManager.getPanel(rest[1]) });
                    }

                    if (method === 'DELETE' && rest.length === 2) {
                        const panel = selfRoleManager.getPanel(rest[1]);
                        if (!panel) return sendJson(res, 404, { error: 'Panel not found' });
                        // v3.24.1 SECURITY FIX (H1): the panel must belong to THIS guild (cross-guild IDOR).
                        if (panel.guildId !== guildId) return sendJson(res, 404, { error: 'Panel not found' });
                        // Delete the message best-effort (the panel entry is
                        // cleaned up regardless).
                        if (panel.messageId && panel.channelId) {
                            try {
                                const channel = await client.channels.fetch(panel.channelId);
                                const msg = await channel.messages.fetch(panel.messageId);
                                await msg.delete();
                            } catch (err) {
                                log(`[dash] deleting the panel message failed (proceeding to delete the entry): ${err.message}`);
                            }
                        }
                        selfRoleManager.deletePanel(rest[1]);
                        // v3.28.0: deleting THE verification panel also clears
                        // the Verified role (parity with /selfrole-delete) —
                        // otherwise the ticket/escrow verified-only gate would
                        // keep filtering members against a role nobody can
                        // obtain anymore.
                        const cfg = getConfig(guildId);
                        let verifyCleared = false;
                        if (cfg?.roles?.verifyPanelId === rest[1]) {
                            setField(guildId, 'roles.verifyPanelId', null);
                            setField(guildId, 'roles.verified', null);
                            verifyCleared = true;
                        }
                        return sendJson(res, 200, {
                            ok: true,
                            ...(verifyCleared ? { note: 'This was the verification panel — the Verified role was cleared. Reinstall it with POST verify-panel.' } : {})
                        });
                    }
                }

                // ---- v3.28.0: Verification wizard (parity with /setup-verify) ----
                // Creates THE one-way verification panel: one button = the
                // Verified role. Also remembers the role (config.roles.verified
                // — gates tickets/escrow) + the panel link (verifyPanelId).
                if (method === 'POST' && rest[0] === 'verify-panel' && rest.length === 1) {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    const body = await readBody(req, res);
                    const roleId = String(body?.roleId || '');
                    const channelId = String(body?.channelId || '');
                    if (!SNOWFLAKE_RE.test(roleId)) return sendJson(res, 400, { error: 'Invalid roleId' });
                    if (!SNOWFLAKE_RE.test(channelId)) return sendJson(res, 400, { error: 'Invalid channelId' });

                    // The role must exist in THIS guild (the web sends ids from
                    // meta.roles — this also blocks cross-guild ids).
                    const role = g.roles?.cache?.get(roleId);
                    if (!role) return sendJson(res, 400, { error: 'Role not found in this server' });
                    if (role.id === guildId) return sendJson(res, 400, { error: '@everyone cannot be used — pick a regular role' });
                    if (role.managed) return sendJson(res, 400, { error: 'This role is managed by another integration — it cannot be assigned' });
                    const botMember = g.members?.me;
                    const botHighest = botMember?.roles?.highest?.position ?? 0;
                    if ((role.position ?? 0) >= botHighest) {
                        return sendJson(res, 400, { error: 'This role is positioned ABOVE the bot — move the bot role up or pick another role' });
                    }

                    // One verification panel per guild.
                    const cfg = getConfig(guildId);
                    const existingId = cfg?.roles?.verifyPanelId;
                    if (existingId) {
                        const existingPanel = selfRoleManager.getPanel(existingId);
                        if (existingPanel && existingPanel.guildId === guildId) {
                            return sendJson(res, 409, {
                                error: 'A verification panel is already installed — edit it (PUT selfroles/' + existingId + '), or DELETE it first (that also clears the Verified role)'
                            });
                        }
                        setField(guildId, 'roles.verifyPanelId', null);
                        setField(guildId, 'roles.verified', null);
                    }

                    const title = String(body?.title || '✅ Verification').slice(0, 256);
                    const description = normalizeNewlines(
                        String(body?.description || `Welcome to **${g.name}**!\nClick the button below to verify yourself and get full access.`)
                    ).slice(0, 4000);
                    const label = String(body?.label || 'Verify Me').slice(0, 80);
                    const emoji = body?.emoji ? String(body.emoji).slice(0, 64) : '✅';
                    const style = BUTTON_STYLES.includes(body?.style) ? body.style : 'Success';

                    // Create the ONE-WAY panel + its single role button.
                    const panel = selfRoleManager.createPanel({
                        guildId,
                        channelId,
                        title,
                        description,
                        type: 'button',
                        exclusive: false,
                        once: true
                    });
                    const added = selfRoleManager.addRoleToPanel(panel.id, {
                        roleId,
                        label,
                        emoji,
                        style
                    });
                    if (!added.ok) {
                        selfRoleManager.deletePanel(panel.id);
                        return sendJson(res, 400, { error: added.error });
                    }

                    // Send the panel message (P0-5 rollback on failure).
                    try {
                        const channel = await client.channels.fetch(channelId);
                        const fresh = selfRoleManager.getPanel(panel.id);
                        const panelMsg = await channel.send({
                            embeds: [buildPanelEmbed(fresh, client)],
                            components: buildPanelComponents(fresh)
                        });
                        selfRoleManager.setMessageId(panel.id, panelMsg.id);
                    } catch (err) {
                        selfRoleManager.deletePanel(panel.id);
                        return sendJson(res, 502, { error: `Failed to send the panel to the channel: ${err.message}` });
                    }

                    // Remember the Verified role + the panel link.
                    setField(guildId, 'roles.verified', roleId);
                    setField(guildId, 'roles.verifyPanelId', panel.id);

                    await logAudit(client, {
                        action: 'SETUP_VERIFY',
                        actorId: String(body?.actor?.id || ''),
                        actorTag: String(body?.actor?.tag || 'web dashboard'),
                        details: `Install verification panel **${title}** (${panel.id}) in <#${channelId}> — Verified role: ${role.name} (one-way)`,
                        guildId
                    }).catch(() => {});
                    log(`[dash] verification panel installed in ${guildId} (${panel.id})`);
                    return sendJson(res, 201, { ok: true, panel: selfRoleManager.getPanel(panel.id) });
                }

                // ---- Serverstats: force refresh ----
                if (method === 'POST' && rest[0] === 'serverstats' && rest[1] === 'refresh') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    const result = await serverstatsManager.refreshServerStats(g, { force: true });
                    return sendJson(res, 200, { ok: true, result });
                }

                // ---- Tempvoice: detach the setup ----
                if (method === 'DELETE' && rest[0] === 'tempvoice') {
                    const ok = tempVoiceManager.removeGuild(guildId);
                    if (!ok) return sendJson(res, 404, { error: 'Temp voice setup not found' });
                    return sendJson(res, 200, { ok: true, note: 'Config detached; physical channels are not deleted — remove them manually if needed.' });
                }

                // ---- v3.24.0: Test welcome/goodbye (parity with /test-welcome) ----
                // Diagnosis + sends the REAL embed (the same builder as the
                // genuine join event) to the configured channel. The member
                // playing "the new member" is the dashboard user (the actor).
                if (method === 'POST' && rest[0] === 'welcome-test' && rest.length === 1) {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    const body = await readBody(req, res);
                    const tipe = body?.type === 'goodbye' ? 'goodbye' : body?.type === 'welcome' ? 'welcome' : null;
                    if (!tipe) return sendJson(res, 400, { error: 'type must be welcome | goodbye' });
                    const actorId = String(body?.actor?.id || '');
                    if (!SNOWFLAKE_RE.test(actorId)) return sendJson(res, 400, { error: 'Invalid actor.id' });

                    const config = getConfig(guildId);
                    const configuredId = config.channels[tipe];
                    const lines = [];
                    let channel = null;
                    if (!configuredId) {
                        lines.push(`❌ ${tipe} channel: not set yet — configure it in the General module.`);
                    } else {
                        channel = g.channels.cache.get(configuredId) || null;
                        if (!channel) {
                            lines.push(`❌ ${tipe} channel: not found (ID ${configuredId}) — deleted? Set it again in the General module.`);
                        } else {
                            lines.push(`✅ ${tipe} channel: #${channel.name}`);
                            const perms = channel.permissionsFor?.(g.members?.me ?? null);
                            const canSend = perms?.has?.(PermissionFlagsBits.SendMessages) ?? false;
                            const canEmbed = perms?.has?.(PermissionFlagsBits.EmbedLinks) ?? false;
                            lines.push(`${canSend ? '✅' : '❌'} Send Messages · ${canEmbed ? '✅' : '❌'} Embed Links (bot permissions)`);
                        }
                    }

                    // The actor's member when possible; otherwise a synthetic
                    // member (the builder only needs user.id/tag/avatar +
                    // guild.name/icon/count). The displayAvatarURL check also
                    // guards against partial/mock members.
                    let member = null;
                    try { member = await g.members.fetch(actorId).catch(() => null); } catch { /* mock/test */ }
                    if (!member || typeof member.user?.displayAvatarURL !== 'function') {
                        member = {
                            user: {
                                id: actorId,
                                tag: String(body?.actor?.tag || `user-${actorId}`),
                                displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png'
                            },
                            guild: {
                                name: g.name,
                                iconURL: () => null,
                                memberCount: typeof g.memberCount === 'number' ? g.memberCount : 0
                            }
                        };
                    }

                    if (!channel) {
                        return sendJson(res, 422, { ok: false, lines, error: `The ${tipe} channel is not ready — fix it first.` });
                    }

                    try {
                        const embed =
                            tipe === 'welcome' ? buildWelcomeEmbed(member, config) : buildGoodbyeEmbed(member, config);
                        await channel.send({ embeds: [embed] });
                        log(`[dash] welcome-test (${tipe}) sent by ${body?.actor?.tag || actorId}`);
                        return sendJson(res, 200, { ok: true, lines, sent: true, channelId: channel.id });
                    } catch (err) {
                        lines.push(`⚠️ Failed to send to the channel: ${err.message}`);
                        return sendJson(res, 502, { ok: false, lines, error: `The bot cannot send to the ${tipe} channel: ${err.message}` });
                    }
                }

                // ---- v3.24.0: Clear a member's AFK status (parity with /afk-clear) ----
                if (method === 'DELETE' && rest[0] === 'afk' && rest.length === 2) {
                    const userId = rest[1];
                    if (!SNOWFLAKE_RE.test(userId)) return sendJson(res, 400, { error: 'Invalid userId' });
                    const ok = afkManager.clearAFK(guildId, userId);
                    if (!ok) return sendJson(res, 404, { error: 'That member is not currently AFK' });
                    log(`[dash] afk ${userId} cleared in ${guildId}`);
                    return sendJson(res, 200, { ok: true });
                }

                // ========================================================
                // ==== v3.19.0: COMMAND MANAGER + NEW WEB MODULES       ====
                // ========================================================

                // ---- Command Manager: save the disabled list ----
                // Same rules as /commands toggle (normalizeDisabledList is
                // shared — one source of truth across both interfaces).
                if (method === 'PUT' && rest[0] === 'commands' && rest.length === 1) {
                    const body = await readBody(req, res);
                    // v3.20.0: this guild's custom command names are allowed
                    // in the disabled list too (same rules as /commands toggle).
                    const customNames = customCommandManager.getGuildCommands(guildId).map((c) => c.name);
                    const normalized = normalizeDisabledList(body?.disabled ?? [], customNames);
                    if (!normalized.ok) return sendJson(res, 422, { error: normalized.error });
                    const config = getConfig(guildId);
                    config.disabledCommands = normalized.value;
                    saveConfig(guildId, config);
                    log(`[dash] command manager ${guildId}: ${normalized.value.length} command(s) disabled by ${body?.actor?.tag || 'unknown'}`);
                    return sendJson(res, 200, {
                        ok: true,
                        disabled: normalized.value,
                        total: getCommands().length + customNames.length
                    });
                }

                // ---- v3.20.0: Custom Commands — create/update from the web ----
                // Definition -> data/customCommands/<guildId>.json -> Discord
                // registration sync (guild.commands.set) -> the command shows
                // up as a REAL slash command on the server within seconds.
                if (method === 'POST' && rest[0] === 'custom-commands' && rest.length === 1) {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                    const body = await readBody(req, res);
                    const builtinNames = getCommands().map((c) => c.name);
                    const result = customCommandManager.upsertCommand(guildId, body, builtinNames, {
                        id: String(body?.actor?.id || 'web'),
                        tag: String(body?.actor?.tag || 'web dashboard')
                    });
                    if (!result.ok) return sendJson(res, 422, { error: result.error });

                    // Sync to Discord (best-effort: data is already saved;
                    // sync failure is reported but doesn't roll anything back).
                    const sync = await syncGuildCustomCommands(client, guildId);
                    log(
                        `[dash] custom command ${result.created ? 'created' : 'updated'}: /${result.command.name} (${guildId}) by ${body?.actor?.tag || 'unknown'}` +
                            (sync.ok ? '' : ` — SYNC FAILED: ${sync.error}`)
                    );
                    return sendJson(res, result.created ? 201 : 200, {
                        ok: true,
                        command: result.command,
                        synced: sync.ok,
                        syncError: sync.ok ? undefined : sync.error
                    });
                }

                // ---- v3.20.0: Custom Commands — delete from the web ----
                if (method === 'DELETE' && rest[0] === 'custom-commands' && rest.length === 2) {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                    const name = decodeURIComponent(rest[1]);
                    const result = customCommandManager.deleteCommand(guildId, name);
                    if (!result.ok) return sendJson(res, 404, { error: result.error });
                    const sync = await syncGuildCustomCommands(client, guildId);
                    log(`[dash] custom command deleted: /${name} (${guildId})` + (sync.ok ? '' : ` — SYNC FAILED: ${sync.error}`));
                    return sendJson(res, 200, { ok: true, synced: sync.ok, syncError: sync.ok ? undefined : sync.error });
                }

                // ---- Giveaway: create from the web (parity with /giveaway create) ----
                if (method === 'POST' && rest[0] === 'giveaway' && rest.length === 1) {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                    const body = await readBody(req, res);
                    const channelId = String(body?.channelId || '');
                    const prize = String(body?.prize || '').trim();
                    const winners = Number(body?.winners ?? 1);
                    const durationMin = Number(body?.durationMin);
                    const requiredRoleId = body?.requiredRoleId ? String(body.requiredRoleId) : null;

                    // Validation identical to /giveaway create (so web and
                    // Discord behavior can never diverge).
                    if (!SNOWFLAKE_RE.test(channelId)) return sendJson(res, 400, { error: 'Invalid channelId' });
                    if (!isStr(prize, 200)) return sendJson(res, 400, { error: 'Prize is required, max 200 characters' });
                    if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 60 * 24 * 30) {
                        return sendJson(res, 400, { error: 'Duration must be 1 minute to 30 days (43200 minutes)' });
                    }
                    if (!Number.isInteger(winners) || winners < 1 || winners > 20) {
                        return sendJson(res, 400, { error: 'Winners must be 1-20' });
                    }
                    if (requiredRoleId && !SNOWFLAKE_RE.test(requiredRoleId)) {
                        return sendJson(res, 400, { error: 'Invalid requiredRoleId' });
                    }

                    const channel = await client.channels.fetch(channelId).catch(() => null);
                    if (!channel || channel.type !== ChannelType.GuildText) {
                        return sendJson(res, 400, { error: 'Channel must be a text channel' });
                    }

                    const endsAt = Date.now() + durationMin * 60000;
                    const gw = giveawayManager.create({
                        guildId,
                        channelId,
                        prize,
                        winnersCount: winners,
                        endsAt,
                        hostId: String(body?.actor?.id || 'dash'),
                        hostTag: String(body?.actor?.tag || 'Dashboard'),
                        requiredRoleId
                    });

                    // Embed + buttons identical to the Discord version.
                    const embed = new EmbedBuilder()
                        .setTitle('🎉 GIVEAWAY!')
                        .setDescription(
                            `🎁 **Prize:** ${prize}\n\n` +
                                `👥 **Winners:** ${winners}\n` +
                                `⏰ **Ends:** <t:${Math.floor(endsAt / 1000)}:R> (<t:${Math.floor(endsAt / 1000)}:F>)\n` +
                                `🎟️ **Entries:** 0\n` +
                                (requiredRoleId ? `🔐 **Requirement:** Must have role <@&${requiredRoleId}>\n` : '') +
                                `\n👇 Click the **🎉 Join** button below to enter!`
                        )
                        .setColor(0xf1c40f)
                        .setFooter({ text: `Host: ${body?.actor?.tag || 'Dashboard'} | ID: ${gw.id}` })
                        .setTimestamp();
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`gw_join:${gw.id}`).setLabel('🎉 Join').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`gw_leave:${gw.id}`).setLabel('🚪 Leave').setStyle(ButtonStyle.Secondary)
                    );
                    const msg = await channel
                        .send({ embeds: [embed], components: [row], content: '🎉 **NEW GIVEAWAY!**' })
                        .catch(() => null);
                    if (!msg) {
                        // Roll back the entry (P0-5 pattern — same as /giveaway create).
                        try {
                            giveawayManager.remove(gw.id);
                        } catch (_) { /* best-effort */ }
                        return sendJson(res, 502, { error: 'Failed to send the giveaway message — check the bot permissions in that channel. Entry cancelled.' });
                    }
                    giveawayManager.setMessageId(gw.id, msg.id);
                    log(`[dash] giveaway created in ${guildId} (${gw.id}) by ${body?.actor?.tag || 'unknown'}`);
                    return sendJson(res, 201, { ok: true, giveaway: giveawayManager.get(gw.id) });
                }

                // ---- v3.26.0: Giveaway END from the web (parity with /giveaway end) ----
                // Same rules as the slash command: guild check, already-ended
                // check, scheduler in-flight check, withUserLock + skipPick so
                // winners are picked exactly once even if Discord + web race.
                if (method === 'POST' && rest[0] === 'giveaway' && rest[1] === 'end') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                    const body = await readBody(req, res);
                    const id = String(body?.id || '');
                    const gw = giveawayManager.get(id);
                    if (!gw || gw.guildId !== guildId) return sendJson(res, 404, { error: 'Giveaway not found' });
                    if (gw.ended) return sendJson(res, 409, { error: 'This giveaway has already ended' });
                    if (isGiveawayProcessing(id)) {
                        return sendJson(res, 423, { error: 'This giveaway is being auto-processed by the scheduler (natural end). Try again in a few seconds.' });
                    }

                    const lockResult = await withUserLock('gw_end', id, async () => {
                        const gwFresh = giveawayManager.get(id);
                        if (!gwFresh) return { type: 'notfound' };
                        if (gwFresh.ended) return { type: 'ended' };
                        const winnerIds = giveawayManager.pickWinners(gwFresh.participantIds, gwFresh.winnersCount);
                        giveawayManager.end(id, winnerIds);
                        const updatedGw = giveawayManager.get(id);
                        try {
                            await processGiveawayEnd(client, updatedGw, { skipPick: true });
                        } catch (err) {
                            log(`[dash] giveaway end announce failed (state saved): ${err.message}`);
                        }
                        return { type: 'ok', winnerIds, gw: gwFresh };
                    });
                    if (lockResult === null) {
                        return sendJson(res, 423, { error: 'Giveaway end is in progress — try again shortly.' });
                    }
                    if (lockResult.type === 'notfound') return sendJson(res, 404, { error: 'Giveaway not found' });
                    if (lockResult.type === 'ended') return sendJson(res, 409, { error: 'This giveaway has already ended' });

                    await logAudit(client, {
                        action: 'GIVEAWAY_END',
                        actorId: String(body?.actor?.id || ''),
                        actorTag: String(body?.actor?.tag || 'web dashboard'),
                        details: `End giveaway \`${id}\` (${lockResult.gw.prize}). Winners: ${lockResult.winnerIds.join(', ') || 'no participants'}`,
                        guildId
                    }).catch(() => {});
                    log(`[dash] giveaway ${id} ended in ${guildId} by ${body?.actor?.tag || 'unknown'}`);
                    return sendJson(res, 200, { ok: true, winnerIds: lockResult.winnerIds, giveaway: giveawayManager.get(id) });
                }

                // ---- v3.26.0: Giveaway REROLL from the web (parity with /giveaway reroll) ----
                // Same rules as the slash command: must be ended, guild check,
                // withUserLock, announce + DM best-effort after the winner is persisted.
                if (method === 'POST' && rest[0] === 'giveaway' && rest[1] === 'reroll') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                    const body = await readBody(req, res);
                    const id = String(body?.id || '');
                    const gw = giveawayManager.get(id);
                    if (!gw || gw.guildId !== guildId) return sendJson(res, 404, { error: 'Giveaway not found' });
                    if (!gw.ended) {
                        return sendJson(res, 409, { error: "This giveaway hasn't ended yet — end it first." });
                    }

                    const result = await withUserLock('gw_reroll', id, async () => giveawayManager.reroll(id));
                    if (!result) {
                        return sendJson(res, 409, { error: "Reroll failed — giveaway not found, not ended yet, or another reroll is running. Try again shortly." });
                    }
                    if (!result.winnerId) return sendJson(res, 422, { error: 'No participants to reroll' });

                    try {
                        await announceRerollWinner(client, result.gw, result.winnerId);
                    } catch (err) {
                        log(`[dash] reroll announce failed (winner saved): ${err.message}`);
                    }
                    await logAudit(client, {
                        action: 'GIVEAWAY_REROLL',
                        actorId: String(body?.actor?.id || ''),
                        actorTag: String(body?.actor?.tag || 'web dashboard'),
                        details: `Reroll giveaway \`${id}\` → new winner: ${result.winnerId}${result.reused ? ' (reused)' : ''}`,
                        guildId
                    }).catch(() => {});
                    log(`[dash] giveaway ${id} rerolled in ${guildId} by ${body?.actor?.tag || 'unknown'}`);
                    return sendJson(res, 200, { ok: true, winnerId: result.winnerId, reused: !!result.reused, giveaway: giveawayManager.get(id) });
                }

                // ---- v3.26.0: Poll CLOSE from the web (parity with /poll close) ----
                // Closes the poll + re-renders the message with the final bars
                // + disabled buttons (the same updatePollMessage behavior).
                if (method === 'POST' && rest[0] === 'poll' && rest[1] === 'close') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                    const body = await readBody(req, res);
                    const id = String(body?.id || '');
                    const poll = pollManager.get(id);
                    if (!poll || poll.guildId !== guildId) return sendJson(res, 404, { error: 'Poll not found' });
                    if (poll.closed) return sendJson(res, 409, { error: 'This poll is already closed' });

                    const updated = pollManager.close(id);
                    if (!updated) return sendJson(res, 404, { error: 'Poll no longer exists' });

                    // Re-render the poll message with the final results +
                    // disabled buttons (best-effort — the poll stays closed).
                    try {
                        const channel = await client.channels.fetch(updated.channelId).catch(() => null);
                        const msg = updated.messageId && channel
                            ? await channel.messages.fetch(updated.messageId).catch(() => null)
                            : null;
                        if (channel && msg) {
                            const total = pollManager.getTotalVotes(updated);
                            const lines = updated.options
                                .map((opt) => {
                                    const pct = total > 0 ? Math.round((opt.votes.length / total) * 100) : 0;
                                    const bar = '█'.repeat(Math.floor(pct / 10)).padEnd(10, '░');
                                    return `${opt.emoji} **${opt.label}** — ${opt.votes.length} votes (${pct}%)\n\`${bar}\``;
                                })
                                .join('\n\n');
                            const embed = new EmbedBuilder()
                                .setTitle(`📊 ${updated.question}`)
                                .setDescription(
                                    `${lines}\n\n🗳️ Total votes: **${total}**\n` +
                                        `🔒 Status: **Closed** <t:${Math.floor(updated.closedAt / 1000)}:R>`
                                )
                                .setColor(0x95a5a6)
                                .setFooter({ text: `Poll by ${updated.creatorTag} | Closed` })
                                .setTimestamp();
                            const disabledRows = msg.components.map((row) => {
                                const newRow = new ActionRowBuilder();
                                for (const comp of row.components) {
                                    newRow.addComponents(ButtonBuilder.from(comp).setDisabled(true));
                                }
                                return newRow;
                            });
                            await msg.edit({ embeds: [embed], components: disabledRows });
                        }
                    } catch (err) {
                        log(`[dash] poll message update failed (poll still closed): ${err.message}`);
                    }
                    await logAudit(client, {
                        action: 'POLL_CLOSE',
                        actorId: String(body?.actor?.id || ''),
                        actorTag: String(body?.actor?.tag || 'web dashboard'),
                        details: `Close poll \`${id}\` ("${updated.question}")`,
                        guildId
                    }).catch(() => {});
                    log(`[dash] poll ${id} closed in ${guildId} by ${body?.actor?.tag || 'unknown'}`);
                    return sendJson(res, 200, { ok: true, poll: pollManager.get(id) });
                }

                // ---- Poll: create from the web (parity with /poll create via modal) ----
                if (method === 'POST' && rest[0] === 'poll' && rest.length === 1) {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                    const body = await readBody(req, res);
                    const channelId = String(body?.channelId || '');
                    const question = String(body?.question || '').trim();
                    const multiple = !!body?.multiple;
                    const rawOptions = Array.isArray(body?.options) ? body.options : [];

                    if (!SNOWFLAKE_RE.test(channelId)) return sendJson(res, 400, { error: 'Invalid channelId' });
                    if (!isStr(question, 250)) return sendJson(res, 400, { error: 'Question is required, max 250 characters' });
                    if (rawOptions.length < 2 || rawOptions.length > 10) {
                        return sendJson(res, 400, { error: 'A poll needs 2-10 options' });
                    }
                    const options = [];
                    for (const [i, o] of rawOptions.entries()) {
                        const label = String(o?.label || '').trim();
                        const emoji = o?.emoji ? String(o.emoji).slice(0, 64) : `${i + 1}️⃣`;
                        if (!isStr(label, 80)) return sendJson(res, 400, { error: `Option #${i + 1}: label must be 1-80 characters` });
                        // v3.24.1 FIX (L3): validate the emoji up front — an invalid
                        // emoji used to fail only at send time (Discord 50035), which
                        // surfaced as a misleading 502 "check the bot permissions".
                        if (!isValidEmoji(emoji)) {
                            return sendJson(res, 400, { error: `Option #${i + 1}: invalid emoji (use a standard Unicode emoji or a custom emoji like :name:12345)` });
                        }
                        options.push({ label, emoji });
                    }

                    const channel = await client.channels.fetch(channelId).catch(() => null);
                    if (!channel || channel.type !== ChannelType.GuildText) {
                        return sendJson(res, 400, { error: 'Channel must be a text channel' });
                    }

                    // Render-first (v3.9.26 pattern): the entry persists only
                    // AFTER the embed builds; the id is generated up front so
                    // buttons stay consistent.
                    const pollId = `poll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    const createdAt = Date.now();
                    const lines = options
                        .map((opt) => `${opt.emoji} **${opt.label}** — 0 votes (0%)\n\`${'░'.repeat(10)}\``)
                        .join('\n\n');
                    const embed = new EmbedBuilder()
                        .setTitle(`📊 ${question}`)
                        .setDescription(
                            `${lines}\n\n` +
                                `🗳️ Total votes: **0**\n` +
                                `🔄 Mode: ${multiple ? 'Multi-vote (pick as many as you like)' : 'Single-vote (pick one)'}\n` +
                                `⏰ Created: <t:${Math.floor(createdAt / 1000)}:R>\n\n` +
                                `👇 Click a button below to vote (toggle)`
                        )
                        .setColor(0x5865f2)
                        .setFooter({ text: `Poll by ${body?.actor?.tag || 'Dashboard'} | ID: ${pollId}` })
                        .setTimestamp();
                    const rows = [];
                    for (let i = 0; i < options.length; i += 5) {
                        const row = new ActionRowBuilder();
                        for (let j = i; j < Math.min(i + 5, options.length); j++) {
                            row.addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`poll_vote:${pollId}:${j}`)
                                    .setLabel(options[j].label.slice(0, 80))
                                    .setEmoji(options[j].emoji)
                                    .setStyle(ButtonStyle.Primary)
                            );
                        }
                        rows.push(row);
                    }

                    const poll = pollManager.create({
                        id: pollId,
                        guildId,
                        channelId,
                        question,
                        options,
                        multiple,
                        creatorId: String(body?.actor?.id || 'dash'),
                        creatorTag: String(body?.actor?.tag || 'Dashboard')
                    });
                    const msg = await channel
                        .send({
                            embeds: [embed],
                            components: rows,
                            content: `📊 **NEW POLL** by ${body?.actor?.tag || 'Dashboard'}`
                        })
                        .catch(() => null);
                    if (!msg) {
                        try {
                            pollManager.remove(poll.id);
                        } catch (_) { /* best-effort */ }
                        return sendJson(res, 502, { error: 'Failed to send the poll message — check the bot permissions in that channel. Entry cancelled.' });
                    }
                    pollManager.setMessageId(poll.id, msg.id);
                    log(`[dash] poll created in ${guildId} (${poll.id}) by ${body?.actor?.tag || 'unknown'}`);
                    return sendJson(res, 201, { ok: true, poll: pollManager.get(poll.id) });
                }

                // ---- Embed: send a FULL embed to a channel (parity with /embed-builder) ----
                // v3.20.0: accepts the complete shape (content + embed {title,
                // description, color, authorName, authorIconURL, fields[],
                // thumbnail, image, footerText, footerIconURL, timestamp}).
                // Legacy flat fields (title/description/footer/color/image/
                // thumbnail on the body root) still work — older web modules
                // and third-party clients don't break.
                if (method === 'POST' && rest[0] === 'embed' && rest.length === 1) {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                    const body = await readBody(req, res);
                    const channelId = String(body?.channelId || '');
                    if (!SNOWFLAKE_RE.test(channelId)) return sendJson(res, 400, { error: 'Invalid channelId' });

                    const content = body?.content ? String(body.content).slice(0, 2000).trim() : '';

                    // Legacy shape -> folded into the new embed (backward compat).
                    const rawEmbed =
                        body?.embed && typeof body.embed === 'object'
                            ? body.embed
                            : {
                                  title: body?.title,
                                  description: body?.description,
                                  color: body?.color,
                                  footerText: body?.footer ? String(body.footer).slice(0, 2048) : undefined,
                                  image: body?.image,
                                  thumbnail: body?.thumbnail
                              };

                    const embedRes = normalizeEmbedDef(rawEmbed);
                    if (!embedRes.ok) return sendJson(res, 400, { error: embedRes.error });
                    const def = embedRes.value;

                    if (!content && isEmbedEmpty(def)) {
                        return sendJson(res, 400, { error: 'At least a title, description, or content is required' });
                    }

                    const channel = await client.channels.fetch(channelId).catch(() => null);
                    if (!channel || channel.type !== ChannelType.GuildText) {
                        return sendJson(res, 400, { error: 'Channel must be a text channel' });
                    }

                    const embed = buildEmbedFromDef(def, EmbedBuilder);
                    const payload = {};
                    if (content) payload.content = normalizeNewlines(content);
                    if (!isEmbedEmpty(def)) payload.embeds = [embed];

                    const msg = await channel.send(payload).catch(() => null);
                    if (!msg) return sendJson(res, 502, { error: 'Failed to send the embed — check the bot permissions in that channel' });
                    log(`[dash] embed sent to ${channelId} (${guildId}) by ${body?.actor?.tag || 'unknown'}`);
                    return sendJson(res, 201, { ok: true, messageId: msg.id, url: msg.url });
                }

                // ---- Backup: create now + restore (parity with /backup-now, /restore-backup) ----
                if (rest[0] === 'backups') {
                    if (method === 'POST' && rest.length === 1) {
                        const body = await readBody(req, res);
                        const result = backupManager.createBackup();
                        if (!result.ok) {
                            return sendJson(res, 500, {
                                error: `Backup ${result.partial ? 'partially failed' : 'failed'}: ${result.errors.join('; ') || 'unknown'}`
                            });
                        }
                        log(`[dash] backup created for ${guildId} (${result.backupName}) by ${body?.actor?.tag || 'unknown'}`);
                        return sendJson(res, 201, { ok: true, backupName: result.backupName, filesCopied: result.filesCopied });
                    }
                    if (method === 'POST' && rest.length === 3 && rest[2] === 'restore') {
                        const body = await readBody(req, res);
                        const result = await backupManager.restoreBackup(rest[1]);
                        if (!result.ok) {
                            return sendJson(res, 422, { error: `Restore failed: ${result.errors.join('; ') || 'backup not found / invalid name format'}` });
                        }
                        log(`[dash] backup ${rest[1]} restored (guild ${guildId}) by ${body?.actor?.tag || 'unknown'}`);
                        return sendJson(res, 200, { ok: true, filesRestored: result.filesRestored, note: 'Bot data restored from the backup. The dashboard reloads fresh data on refresh.' });
                    }
                }

                // ---- Keys: manage VIP keys from the web (parity with /set-key & /clear-schedule) ----
                if (rest[0] === 'keys') {
                    if (method === 'POST' && rest.length === 1) {
                        if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                        const body = await readBody(req, res);
                        const userId = String(body?.userId || '');
                        const value = String(body?.value || '');
                        if (!SNOWFLAKE_RE.test(userId)) return sendJson(res, 400, { error: 'Invalid userId (Discord ID)' });

                        // The product must exist + have a role (same rules as
                        // /set-key — the web cannot conjure roles from thin air).
                        const config = getConfig(guildId);
                        const product = (config.products || []).find((p) => p.value === value);
                        if (!product) return sendJson(res, 404, { error: `Product value "${value}" not found` });
                        if (!product.roleId) {
                            return sendJson(res, 422, { error: `Product ${product.label} has no role yet — set one in the Tickets & Products module first` });
                        }

                        const member = await g.members.fetch(userId).catch(() => null);
                        if (!member) return sendJson(res, 404, { error: 'That user is not on this server' });

                        // Custom key (optional) or auto-generate XXXXX-XXXXX-XXXXX.
                        const keyValue = (typeof body?.key === 'string' ? body.key.trim() : '') ||
                            Array.from({ length: 3 }, () =>
                                Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('')
                            ).join('-');

                        let keyEntry;
                        try {
                            keyEntry = keyManager.addKey({
                                key: keyValue,
                                userId: member.id,
                                username: member.user?.tag || member.id,
                                roleId: product.roleId,
                                productName: product.label,
                                days: product.days || 0,
                                guildId
                            });
                        } catch (err) {
                            return sendJson(res, 500, { error: `Failed to save the key: ${err.message}` });
                        }

                        // Grant the role (if the bot has permission) + schedule
                        // expiry — best-effort with warnings (the /set-key pattern).
                        const warnings = [];
                        try {
                            if (!member.roles.cache.has(product.roleId)) await member.roles.add(product.roleId);
                        } catch (_) {
                            warnings.push('Key saved WITHOUT the role — the bot role must be ABOVE the product role.');
                        }
                        try {
                            roleScheduler.scheduleRoleRemoval({
                                userId: member.id,
                                roleId: product.roleId,
                                guildId,
                                days: product.days || 0,
                                expireAt: keyEntry.expireAt,
                                productName: product.label
                            });
                        } catch (err) {
                            warnings.push(`Failed to schedule auto-expiry: ${err.message}`);
                        }

                        log(`[dash] key created for user ${userId} in ${guildId} by ${body?.actor?.tag || 'unknown'}`);
                        return sendJson(res, 201, { ok: true, key: keyEntry.key, expireAt: keyEntry.expireAt, warnings });
                    }

                    if (method === 'DELETE' && rest.length === 1) {
                        if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                        const userId = url.searchParams.get('userId');
                        if (!userId || !SNOWFLAKE_RE.test(userId)) {
                            return sendJson(res, 400, { error: 'The userId (Discord ID) parameter is required' });
                        }
                        const removedSched = roleScheduler.removeAllByUser(userId, guildId);
                        const removedKeys = keyManager.removeAllKeysByUser(userId, guildId);
                        if (removedKeys === 0 && removedSched === 0) {
                            return sendJson(res, 404, { error: 'No keys / schedules for that user on this server' });
                        }
                        // Remove the user's product roles (best-effort) — /clear-schedule pattern.
                        const warnings = [];
                        try {
                            const member = await g.members.fetch(userId).catch(() => null);
                            const config = getConfig(guildId);
                            if (member) {
                                const productRoleIds = new Set((config.products || []).map((p) => p.roleId).filter(Boolean));
                                for (const roleId of member.roles.cache.map((r) => r.id)) {
                                    if (productRoleIds.has(roleId)) {
                                        await member.roles.remove(roleId).catch(() => {
                                            warnings.push(`Failed to remove role <@&${roleId}> — remove it manually.`);
                                        });
                                    }
                                }
                            }
                        } catch (_) { /* best-effort */ }
                        log(`[dash] ${removedKeys} key(s) + ${removedSched} schedule(s) removed for user ${userId} in ${guildId}`);
                        return sendJson(res, 200, { ok: true, removedKeys, removedSchedules: removedSched, warnings });
                    }
                }

                // ========================================================
                // ==== v3.21.0: QUICK START (WEB)                      ====
                // ==== Parity with /setup-ticket-panel  ====
                // ========================================================

                // ---- Install a ticket panel to a channel (parity with /setup-ticket-panel) ----
                // Business validation IDENTICAL to the slash command: roles.admin
                // required, at least 1 category, target must be a text channel.
                // Same builder (buildTicketPanel) → web panel = Discord panel, one storage.
                if (method === 'POST' && rest[0] === 'panels' && rest.length === 1) {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                    const body = await readBody(req, res);
                    const config = getConfig(guildId);

                    if (!config.roles.admin) {
                        return sendJson(res, 422, { error: 'The Bot Admin role is not set yet — fill in Quick Start step 1 (Admin Role) first.' });
                    }
                    const allCategories = config.ticketCategories || [];
                    if (allCategories.length === 0) {
                        return sendJson(res, 422, { error: 'No ticket categories yet — add one in Quick Start step 3 / the Tickets & Products module first.' });
                    }

                    const channelId = String(body?.channelId || '');
                    if (!SNOWFLAKE_RE.test(channelId)) return sendJson(res, 400, { error: 'channelId is not valid' });

                    // Optional category filter (array of ids); without it = all.
                    const requested = Array.isArray(body?.categoryIds) ? body.categoryIds.map(String) : null;
                    const categoriesToShow = requested ? allCategories.filter((c) => requested.includes(c.id)) : allCategories;
                    if (categoriesToShow.length === 0) {
                        return sendJson(res, 400, { error: 'No category matches the requested categoryIds' });
                    }

                    // Optional customization (all safe-default, exactly like the slash command).
                    const title = body?.title ? String(body.title).slice(0, 256) : null;
                    const panelBody = body?.body ? normalizeNewlines(String(body.body).slice(0, 4000)) : null;
                    const useDropdown = body?.useDropdown === true;
                    let color = null;
                    if (body?.color !== undefined && body?.color !== null && body?.color !== '') {
                        const raw = String(body.color).replace('#', '');
                        if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
                            return sendJson(res, 400, { error: 'color must be 6 hex digits (e.g. #e67e22)' });
                        }
                        color = parseInt(raw, 16);
                    }

                    const channel = await client.channels.fetch(channelId).catch(() => null);
                    if (!channel || channel.type !== ChannelType.GuildText) {
                        return sendJson(res, 400, { error: 'The channel must be a text channel' });
                    }

                    const panelMeta = {
                        guildId,
                        channelId,
                        title,
                        body: panelBody,
                        color,
                        imageUrl: null,
                        thumbnailUrl: null,
                        footerText: null,
                        categoryIds: categoriesToShow.map((c) => c.id),
                        useDropdown,
                        createdBy: String(body?.actor?.id || 'dash')
                    };

                    let build;
                    try {
                        build = buildTicketPanel(panelMeta, { guild: g, client, config });
                    } catch (err) {
                        return sendJson(res, 422, { error: `Failed to build the panel: ${err.message}` });
                    }

                    // Render-first + rollback (P0-5 pattern): the entry is only
                    // persisted if the message actually got sent — no ghost panels.
                    const sent = await channel
                        .send({ embeds: [build.embed], components: build.components })
                        .catch(() => null);
                    if (!sent) {
                        return sendJson(res, 502, { error: 'Failed to send the panel — make sure the bot has Send Messages + Embed Links permissions in that channel.' });
                    }
                    const saved = panelManager.upsertPanel({ ...panelMeta, messageId: sent.id });
                    log(`[dash] ticket panel installed in ${channelId} (${guildId}, panel ${saved.id}) by ${body?.actor?.tag || 'unknown'}`);
                    return sendJson(res, 201, { ok: true, panel: saved, url: sent.url });
                }

                // ========================================================
                // ==== v3.26.0: TICKET PANEL MANAGEMENT (web)           ====
                // ==== Parity with /update-panel /refresh-panel /delete-panel ====
                // ========================================================

                // Shared guard: the panel must exist + belong to THIS guild
                // (the same cross-guild protection as the slash commands).
                function findGuildPanel(panelId) {
                    const p = panelManager.getPanel(panelId);
                    return p && p.guildId === guildId ? p : null;
                }

                /** Re-render a ticket panel message with the latest config (best-effort). */
                async function reRenderTicketPanel(panel, actorLabel) {
                    const config = getConfig(guildId);
                    const build = buildTicketPanel(panel, { guild: g, client, config });
                    const channel = await client.channels.fetch(panel.channelId).catch(() => null);
                    if (!channel) return { ok: false, note: 'Panel channel not found — metadata still updated.' };
                    const msg = panel.messageId ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
                    if (!msg) return { ok: false, note: 'Panel message not found (deleted?) — metadata still updated.' };
                    await msg.edit({ embeds: [build.embed], components: build.components });
                    return { ok: true, note: 'Panel message refreshed.', warnings: findEmptyCategoryWarnings(panel, config) };
                }

                // ---- PUT /panels/:panelId — edit fields (parity with /update-panel) ----
                // Field mapping + validation is IDENTICAL to the modal handler in
                // panels-mgmt.js (FIELD_TO_STORAGE_KEY): title / body / color /
                // image / thumbnail / footer. An explicit null CLEARS a field
                // (falls back to the global config value).
                if (method === 'PUT' && rest[0] === 'panels' && rest.length === 2) {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                    const body = await readBody(req, res);
                    const panel = findGuildPanel(rest[1]);
                    if (!panel) return sendJson(res, 404, { error: 'Panel not found' });

                    const EDITABLE = ['title', 'body', 'color', 'image', 'thumbnail', 'footer'];
                    const wanted = EDITABLE.filter((f) => body?.[f] !== undefined);
                    if (wanted.length === 0) {
                        return sendJson(res, 400, { error: `Provide at least one of: ${EDITABLE.join(', ')}` });
                    }

                    // v3.9.26 pattern: write to the STORAGE key, not the field name.
                    const STORAGE = { title: 'title', body: 'body', color: 'color', image: 'imageUrl', thumbnail: 'thumbnailUrl', footer: 'footerText' };
                    const patch = {};
                    for (const field of wanted) {
                        const raw = body[field];
                        if (raw === null || String(raw).trim() === '') {
                            patch[STORAGE[field]] = null; // clear → fall back to global
                            continue;
                        }
                        const value = String(raw).trim();
                        if (field === 'color') {
                            try {
                                patch.color = parseColor(value);
                            } catch (err) {
                                return sendJson(res, 400, { error: err.message });
                            }
                        } else if (field === 'image' || field === 'thumbnail') {
                            if (value.length > 2048) {
                                return sendJson(res, 400, { error: `The ${field} URL is too long (${value.length} char, max 2048 — Discord embed limit).` });
                            }
                            const validated = validateUrl(value);
                            if (!validated) return sendJson(res, 400, { error: `Invalid ${field} URL — must be http(s)://...` });
                            patch[STORAGE[field]] = validated;
                        } else if (field === 'title') {
                            if (value.length > 256) return sendJson(res, 400, { error: 'Title must be at most 256 characters' });
                            patch.title = value;
                        } else if (field === 'footer') {
                            if (value.length > 2048) return sendJson(res, 400, { error: 'Footer must be at most 2048 characters' });
                            patch.footerText = value;
                        } else {
                            if (value.length > 4000) return sendJson(res, 400, { error: 'Body must be at most 4000 characters' });
                            patch.body = normalizeNewlines(value);
                        }
                    }

                    const updated = panelManager.patchPanel(rest[1], patch);
                    if (!updated) return sendJson(res, 422, { error: 'Failed to update the panel' });

                    let renderNote = '';
                    try {
                        const rendered = await reRenderTicketPanel(updated, body?.actor?.tag);
                        renderNote = rendered.ok ? ' Panel message refreshed.' : ` ${rendered.note}`;
                    } catch (err) {
                        renderNote = ` Failed to refresh the message: ${err.message} (metadata still updated).`;
                    }
                    await logAudit(client, {
                        action: 'UPDATE_PANEL',
                        actorId: String(body?.actor?.id || ''),
                        actorTag: String(body?.actor?.tag || 'web dashboard'),
                        details: `Update panel \`${rest[1]}\` — ${wanted.join(', ')}`,
                        guildId
                    }).catch(() => {});
                    log(`[dash] ticket panel ${rest[1]} updated in ${guildId} by ${body?.actor?.tag || 'unknown'}`);
                    return sendJson(res, 200, { ok: true, panel: panelManager.getPanel(rest[1]), note: renderNote.trim() });
                }

                // ---- POST /panels/:panelId/refresh — re-render (parity with /refresh-panel) ----
                if (method === 'POST' && rest[0] === 'panels' && rest.length === 3 && rest[2] === 'refresh') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                    const panel = findGuildPanel(rest[1]);
                    if (!panel) return sendJson(res, 404, { error: 'Panel not found' });
                    if (!panel.channelId || !panel.messageId) {
                        return sendJson(res, 422, { error: 'This panel has no message reference (possibly corrupt) — delete it and set it up again.' });
                    }
                    try {
                        const rendered = await reRenderTicketPanel(panel, 'web');
                        if (!rendered.ok) return sendJson(res, 422, { error: rendered.note });
                        await logAudit(client, {
                            action: 'REFRESH_PANEL',
                            actorId: '',
                            actorTag: 'web dashboard',
                            details: `Refreshed panel \`${rest[1]}\` — re-rendered with the latest categories/products`,
                            guildId
                        }).catch(() => {});
                        log(`[dash] ticket panel ${rest[1]} refreshed in ${guildId}`);
                        return sendJson(res, 200, {
                            ok: true,
                            note: rendered.note,
                            emptyCategoryWarnings: rendered.warnings || []
                        });
                    } catch (err) {
                        return sendJson(res, 422, { error: `Failed to rebuild the panel: ${err.message}` });
                    }
                }

                // ---- DELETE /panels/:panelId — delete message + metadata (parity with /delete-panel) ----
                if (method === 'DELETE' && rest[0] === 'panels' && rest.length === 2) {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not on this server' });
                    const panel = findGuildPanel(rest[1]);
                    if (!panel) return sendJson(res, 404, { error: 'Panel not found' });

                    // Delete the channel message best-effort (it may already be gone).
                    let messageDeleted = false;
                    if (panel.channelId && panel.messageId) {
                        try {
                            const channel = await client.channels.fetch(panel.channelId).catch(() => null);
                            const msg = channel ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
                            if (msg) {
                                await msg.delete();
                                messageDeleted = true;
                            }
                        } catch (err) {
                            log(`[dash] deleting the panel message failed (proceeding): ${err.message}`);
                        }
                    }
                    const removed = panelManager.deletePanel(rest[1]);
                    if (!removed) return sendJson(res, 422, { error: 'Failed to delete the panel metadata' });
                    await logAudit(client, {
                        action: 'DELETE_PANEL',
                        actorId: '',
                        actorTag: 'web dashboard',
                        details: `Deleted ticket panel \`${rest[1]}\` (message ${messageDeleted ? 'deleted' : 'already gone'})`,
                        guildId
                    }).catch(() => {});
                    log(`[dash] ticket panel ${rest[1]} deleted in ${guildId}`);
                    return sendJson(res, 200, { ok: true, messageDeleted });
                }

                // ---- v3.24.4: Reset messages (parity with /reset-message) ----
                // type: 'welcome' | 'goodbye' | 'ticket' | 'ALL' — resets that
                // message group to the factory defaults and returns the new
                // values so the web draft updates in place.
                if (method === 'POST' && rest[0] === 'messages' && rest[1] === 'reset') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    const body = await readBody(req, res);
                    const GROUPS = {
                        welcome: ['welcomeTitle', 'welcomeBody'],
                        goodbye: ['goodbyeTitle', 'goodbyeBody'],
                        ticket: ['ticketTitle', 'ticketBody', 'ticketPriceHeader'],
                        ALL: Object.keys(DEFAULTS.messages)
                    };
                    const type = String(body?.type || '');
                    const keys = GROUPS[type];
                    if (!keys) {
                        return sendJson(res, 400, { error: 'type must be one of: welcome, goodbye, ticket, ALL' });
                    }
                    const config = getConfig(guildId);
                    const messages = { ...config.messages };
                    for (const k of keys) messages[k] = DEFAULTS.messages[k];
                    config.messages = messages;
                    saveConfig(guildId, config);
                    await logAudit(client, {
                        action: 'RESET_MESSAGE',
                        actorId: String(body?.actor?.id || ''),
                        actorTag: String(body?.actor?.tag || 'web dashboard'),
                        details: `Reset ${type === 'ALL' ? 'ALL messages' : `the ${type} message group`} to default`,
                        guildId
                    }).catch(() => {});
                    log(`[dash] messages/${type} reset in ${guildId} by ${body?.actor?.tag || 'unknown'}`);
                    return sendJson(res, 200, { ok: true, type, messages });
                }

                // ---- v3.24.4: FULL config reset (parity with /reset-config) ----
                // Dangerous by design — requires the explicit confirm string.
                // Rebuilds the config from DEFAULTS (only the dashboard-mode
                // essentials survive: nothing — this is a true factory reset).
                if (method === 'POST' && rest[0] === 'config' && rest[1] === 'reset') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    const body = await readBody(req, res);
                    if (body?.confirm !== 'RESET') {
                        return sendJson(res, 400, { error: 'Confirmation required — send { confirm: "RESET" }' });
                    }
                    const fresh = JSON.parse(JSON.stringify(DEFAULTS));
                    saveConfig(guildId, fresh);
                    await logAudit(client, {
                        action: 'RESET_CONFIG',
                        actorId: String(body?.actor?.id || ''),
                        actorTag: String(body?.actor?.tag || 'web dashboard'),
                        details: 'FULL config reset from the web dashboard — all settings back to factory defaults',
                        guildId
                    }).catch(() => {});
                    log(`[dash] FULL config reset in ${guildId} by ${body?.actor?.tag || 'unknown'}`);
                    return sendJson(res, 200, { ok: true, config: getConfig(guildId) });
                }

                // ---- v3.24.4: Warn a member (parity with /warn) ----
                // Same rules as the slash command: hierarchy guard, the warn
                // threshold auto-actions (3=timeout 1h, 5=timeout 1d, 7=kick),
                // a DM to the member, and an audit entry.
                if (method === 'POST' && rest[0] === 'warn' && rest.length === 1) {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    const body = await readBody(req, res);
                    const userId = String(body?.userId || '');
                    const reason = normalizeNewlines(String(body?.reason || '')).trim();
                    if (!SNOWFLAKE_RE.test(userId)) return sendJson(res, 400, { error: 'Invalid userId (Discord ID)' });
                    if (!reason) return sendJson(res, 400, { error: 'A reason is required' });
                    if (reason.length > 500) return sendJson(res, 400, { error: 'Reason too long (max 500 chars)' });

                    const actorId = String(body?.actor?.id || '');
                    const actorTag = String(body?.actor?.tag || 'web dashboard');
                    if (!SNOWFLAKE_RE.test(actorId)) return sendJson(res, 400, { error: 'Invalid actor.id' });

                    const member = await g.members.fetch(userId).catch(() => null);
                    if (!member) return sendJson(res, 404, { error: 'That user is not on this server' });
                    const actorMember = await g.members.fetch(actorId).catch(() => null);
                    if (!actorMember) return sendJson(res, 404, { error: 'You are not on this server (actor)' });
                    const guard = validateModerationTarget({
                        moderatorMember: actorMember,
                        targetMember: member,
                        botMember: g.members?.me || null
                    });
                    if (!guard.ok) {
                        const GUARD_MSG = {
                            'not-in-guild': 'That user is not on this server.',
                            self: 'You cannot warn yourself.',
                            'bot-self': 'You cannot warn the bot.',
                            'target-bot': 'You cannot warn a bot.',
                            hierarchy: 'You cannot warn a member with a role equal to or higher than yours.',
                            'bot-hierarchy': "The bot's role is lower than the target's highest role — move it up in Server Settings → Roles."
                        };
                        return sendJson(res, 403, { error: GUARD_MSG[guard.error] || guard.error });
                    }

                    const result = warnManager.addWarn(guildId, userId, {
                        reason,
                        warnedBy: actorId,
                        warnedByTag: actorTag,
                        guildId
                    });

                    // Auto-action chain (identical thresholds to /warn).
                    let actionMsg = '';
                    let botHierarchyWarning = false;
                    const botMember = g.members?.me || null;
                    if (botMember && member.roles?.highest?.position >= (botMember.roles?.highest?.position ?? 0)) {
                        botHierarchyWarning = true;
                    }
                    if (result.actionAlreadyTaken) {
                        actionMsg = 'Auto-action not repeated (the user already received the same action before).';
                    } else if (result.actionToTake) {
                        try {
                            if (result.actionToTake === 'mute_1h' || result.actionToTake === 'mute_1d') {
                                const durationMin = result.actionToTake === 'mute_1h' ? 60 : 1440;
                                await member.timeout(durationMin * 60 * 1000, `Auto-action: ${result.count} warnings`);
                                warnManager.markActionTaken(guildId, userId, result.warnEntry.id, result.actionToTake);
                                actionMsg = `Auto-action: timeout ${durationMin === 60 ? '1 hour' : '1 day'} (${result.count} warnings)`;
                            } else if (result.actionToTake === 'kick') {
                                await member.kick(`Auto-action: ${result.count} warnings`);
                                warnManager.markActionTaken(guildId, userId, result.warnEntry.id, result.actionToTake);
                                actionMsg = `Auto-action: kicked (${result.count} warnings)`;
                            }
                        } catch (err) {
                            actionMsg = `Auto-action failed: ${err.message}`;
                        }
                    }

                    // DM the member (best-effort, like /warn).
                    let dmOk = true;
                    try {
                        await member.send(
                            `⚠️ **You received a warning in ${g.name}**\n\nReason: ${reason}\nTotal warnings: ${result.count}\n${result.actionToTake ? `Action: ${result.actionToTake}` : 'No auto-action yet (thresholds: 3=mute 1h, 5=mute 1d, 7=kick)'}`
                        );
                    } catch (_) { dmOk = false; }

                    await logAudit(client, {
                        action: 'WARN_ADD',
                        actorId,
                        actorTag,
                        details: `Warn <@${userId}> — Reason: "${reason}" — Total: ${result.count} warn (from the web)`,
                        guildId
                    }).catch(() => {});
                    log(`[dash] warn ${userId} in ${guildId} by ${actorTag} (count: ${result.count})`);
                    return sendJson(res, 200, {
                        ok: true,
                        count: result.count,
                        actionMsg,
                        dmOk,
                        botHierarchyWarning
                    });
                }

                // ---- v3.24.4: Remove one warn (parity with /warn-remove) ----
                if (method === 'POST' && rest[0] === 'warns' && rest[1] === 'remove') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    const body = await readBody(req, res);
                    const userId = String(body?.userId || '');
                    const warnId = String(body?.warnId || '');
                    if (!SNOWFLAKE_RE.test(userId)) return sendJson(res, 400, { error: 'Invalid userId (Discord ID)' });
                    if (!warnId) return sendJson(res, 400, { error: 'warnId is required' });
                    const ok = warnManager.removeWarn(guildId, userId, warnId);
                    if (!ok) return sendJson(res, 404, { error: 'Warn not found' });
                    await logAudit(client, {
                        action: 'WARN_REMOVE',
                        actorId: String(body?.actor?.id || ''),
                        actorTag: String(body?.actor?.tag || 'web dashboard'),
                        details: `Remove warn \`${warnId}\` from <@${userId}> (from the web)`,
                        guildId
                    }).catch(() => {});
                    return sendJson(res, 200, { ok: true });
                }

                // ---- v3.24.4: Clear all warns of a member (parity with /warn-clear) ----
                if (method === 'POST' && rest[0] === 'warns' && rest[1] === 'clear') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    const body = await readBody(req, res);
                    const userId = String(body?.userId || '');
                    if (!SNOWFLAKE_RE.test(userId)) return sendJson(res, 400, { error: 'Invalid userId (Discord ID)' });
                    const removed = warnManager.clearWarns(guildId, userId);
                    await logAudit(client, {
                        action: 'WARN_CLEAR',
                        actorId: String(body?.actor?.id || ''),
                        actorTag: String(body?.actor?.tag || 'web dashboard'),
                        details: `Clear all warns of <@${userId}> (${removed} removed, from the web)`,
                        guildId
                    }).catch(() => {});
                    return sendJson(res, 200, { ok: true, removed });
                }

                // ---- v3.24.4: Send a plain message (parity with /send-message) ----
                if (method === 'POST' && rest[0] === 'send-message') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    const body = await readBody(req, res);
                    const channelId = String(body?.channelId || '');
                    const rawMessage = String(body?.message || '');
                    const mention = body?.mention ? String(body.mention) : '';
                    if (!SNOWFLAKE_RE.test(channelId)) return sendJson(res, 400, { error: 'Invalid channelId' });

                    const channel = g.channels.cache.get(channelId);
                    if (!channel) return sendJson(res, 404, { error: 'Channel not found in this guild' });
                    if (channel.type !== ChannelType.GuildText) {
                        return sendJson(res, 400, { error: 'Channel must be a text channel (not voice/category/forum)' });
                    }
                    const perms = channel.permissionsFor?.(g.members?.me ?? null);
                    if (!perms?.has?.(PermissionFlagsBits.SendMessages)) {
                        return sendJson(res, 403, { error: 'The bot lacks the Send Messages permission in that channel' });
                    }

                    // Same mention whitelist as /send-message (anti injection).
                    let mentionContent = '';
                    if (mention) {
                        const m = mention.trim().toLowerCase();
                        if (m === 'everyone' || m === '@everyone') mentionContent = '@everyone';
                        else if (m === 'here' || m === '@here') mentionContent = '@here';
                        else if (/^<@&\d{17,20}>$/.test(mention)) mentionContent = mention;
                        else if (/^<@!?\d{17,20}>$/.test(mention)) mentionContent = mention;
                        else return sendJson(res, 400, { error: 'Invalid mention format — use @everyone, @here, or a pasted <@&id> / <@id> mention' });
                    }

                    const message = normalizeNewlines(rawMessage);
                    if (message.length > 2000) {
                        return sendJson(res, 400, { error: `Message too long (${message.length} chars, max 2000)` });
                    }
                    if (message.trim().length === 0 && !mentionContent) {
                        return sendJson(res, 400, { error: 'Message cannot be empty' });
                    }

                    try {
                        const sent = await channel.send({ content: (mentionContent ? `${mentionContent} ` : '') + message });
                        await logAudit(client, {
                            action: 'SEND_MESSAGE',
                            actorId: String(body?.actor?.id || ''),
                            actorTag: String(body?.actor?.tag || 'web dashboard'),
                            details: `Send a message to <#${channelId}> from the web (${message.length} chars${mentionContent ? `, mention: ${mentionContent}` : ''})`,
                            guildId
                        }).catch(() => {});
                        log(`[dash] send-message → #${channel.name} in ${guildId} by ${body?.actor?.tag || 'unknown'}`);
                        return sendJson(res, 200, { ok: true, messageId: sent.id, channelId });
                    } catch (err) {
                        return sendJson(res, 502, { error: `Failed to send: ${err.message}` });
                    }
                }

                // ---- v3.24.4: Test the boost notification (parity with /test-booster) ----
                // Pure simulation by default (nothing recorded); live:true ALSO
                // delivers the preview to the REAL server-booster channel.
                if (method === 'POST' && rest[0] === 'booster-test') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    const body = await readBody(req, res);
                    const tipe = body?.type === 'remove' ? 'remove' : 'add';
                    const live = body?.live === true;
                    const actorId = String(body?.actor?.id || '');
                    if (!SNOWFLAKE_RE.test(actorId)) return sendJson(res, 400, { error: 'Invalid actor.id' });

                    const config = getConfig(guildId);
                    const configuredId = config.channels['server-booster'];
                    const me = g.members?.me || null;
                    const lines = [];
                    let channel = null;
                    if (!configuredId) {
                        lines.push('❌ booster channel: not set yet — configure it in the General module (System Channels).');
                    } else {
                        channel = g.channels.cache.get(configuredId) || null;
                        if (!channel) {
                            lines.push(`❌ booster channel: not found (ID ${configuredId}) — deleted? Set it again in the General module.`);
                        } else {
                            lines.push(`✅ booster channel: #${channel.name}`);
                            const perms = channel.permissionsFor?.(me ?? null);
                            const canSend = perms?.has?.(PermissionFlagsBits.SendMessages) ?? false;
                            const canEmbed = perms?.has?.(PermissionFlagsBits.EmbedLinks) ?? false;
                            lines.push(`${canSend ? '✅' : '❌'} Send Messages · ${canEmbed ? '✅' : '❌'} Embed Links (bot permissions)`);
                        }
                    }
                    lines.push(`ℹ️ Server now: Level ${g.premiumTier ?? 0} · ${g.premiumSubscriptionCount ?? 0} boost(s)`);

                    // The actor plays the booster. Same builders as the live event.
                    let member = await g.members.fetch(actorId).catch(() => null);
                    if (!member || typeof member.user?.displayAvatarURL !== 'function') {
                        member = {
                            user: {
                                id: actorId,
                                tag: String(body?.actor?.tag || `user-${actorId}`),
                                displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png'
                            }
                        };
                    }
                    const embed = tipe === 'add' ? buildBoostAddEmbed(member) : buildBoostRemoveEmbed(member, Date.now() - 86400000);

                    if (!live) {
                        return sendJson(res, 200, { ok: true, lines, live: false, note: 'Preview built — nothing was sent or recorded (pure simulation).' });
                    }
                    if (!channel) {
                        return sendJson(res, 422, { ok: false, lines, error: 'The booster channel is not ready — fix it first.' });
                    }
                    try {
                        await channel.send({ embeds: [embed] });
                        log(`[dash] booster-test (${tipe}, live) sent by ${body?.actor?.tag || actorId}`);
                        return sendJson(res, 200, { ok: true, lines, live: true, sent: true, channelId: channel.id });
                    } catch (err) {
                        lines.push(`⚠️ Failed to send to the channel: ${err.message}`);
                        return sendJson(res, 502, { ok: false, lines, error: `The bot cannot send to the booster channel: ${err.message}` });
                    }
                }

                // ---- v3.24.4: Moderation actions (parity with /kick /ban /unban /timeout /untimeout) ----
                if (method === 'POST' && rest[0] === 'moderate') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    const body = await readBody(req, res);
                    const ACTIONS = ['kick', 'ban', 'unban', 'timeout', 'untimeout'];
                    const action = String(body?.action || '');
                    if (!ACTIONS.includes(action)) {
                        return sendJson(res, 400, { error: `action must be one of: ${ACTIONS.join(', ')}` });
                    }
                    const userId = String(body?.userId || '');
                    const reason = normalizeNewlines(String(body?.reason || '(no reason given)')).slice(0, 500);
                    const actorId = String(body?.actor?.id || '');
                    const actorTag = String(body?.actor?.tag || 'web dashboard');
                    if (!SNOWFLAKE_RE.test(actorId)) return sendJson(res, 400, { error: 'Invalid actor.id' });
                    if (!isValidUserId(userId)) return sendJson(res, 400, { error: 'Invalid userId (Discord ID)' });

                    const actorMember = await g.members.fetch(actorId).catch(() => null);
                    if (!actorMember) return sendJson(res, 404, { error: 'You are not on this server (actor)' });
                    const botMember = g.members?.me || null;

                    // unban works on users NOT in the guild — separate path.
                    if (action === 'unban') {
                        if (userId === actorId) return sendJson(res, 403, { error: 'You cannot unban yourself.' });
                        if (userId === botMember?.id) return sendJson(res, 403, { error: 'You cannot unban the bot.' });
                        if (!botMember?.permissions?.has?.(PermissionFlagsBits.BanMembers)) {
                            return sendJson(res, 403, { error: 'The bot is missing the Ban Members permission.' });
                        }
                        const banInfo = await g.bans.fetch(userId).catch(() => null);
                        if (!banInfo) return sendJson(res, 404, { error: 'That user is not on this server\u2019s ban list.' });
                        await g.bans.remove(userId, ` by ${actorTag}: ${reason}`.slice(0, 512));
                        modLogManager.addModLog(guildId, userId, { type: 'unban', reason, moderatorId: actorId, moderatorTag: actorTag });
                        await logAudit(client, {
                            action: 'MOD_UNBAN',
                            actorId,
                            actorTag,
                            details: `Unban \`${userId}\`${banInfo.user?.tag ? ` (${banInfo.user.tag})` : ''} — Reason: "${reason}" (from the web)`,
                            guildId
                        }).catch(() => {});
                        log(`[dash] unban ${userId} in ${guildId} by ${actorTag}`);
                        return sendJson(res, 200, { ok: true, action, userId });
                    }

                    // In-guild actions need the member + the hierarchy guard.
                    const member = await g.members.fetch(userId).catch(() => null);
                    const guard = validateModerationTarget({
                        moderatorMember: actorMember,
                        targetMember: member,
                        botMember
                    });
                    if (!guard.ok) {
                        const GUARD_MSG = {
                            'not-in-guild': 'That user is not on this server.',
                            self: 'You cannot moderate yourself.',
                            'bot-self': 'You cannot moderate the bot.',
                            'target-bot': 'You cannot moderate a bot.',
                            hierarchy: 'You cannot moderate a member with a role equal to or higher than yours.',
                            'bot-hierarchy': "The bot's role is lower than the target's highest role — move it up in Server Settings → Roles."
                        };
                        return sendJson(res, 403, { error: GUARD_MSG[guard.error] || guard.error });
                    }

                    const dmTarget = async (text) => {
                        try { await member.send(text); return true; } catch (_) { return false; }
                    };

                    if (action === 'kick') {
                        if (!botMember.permissions.has(PermissionFlagsBits.KickMembers)) {
                            return sendJson(res, 403, { error: 'The bot is missing the Kick Members permission.' });
                        }
                        const dmOk = await dmTarget(`👢 **You were kicked from ${g.name}**\n\nReason: ${reason}\nBy: ${actorTag}\n\nYou can rejoin using the server's invite link.`);
                        await member.kick(` by ${actorTag}: ${reason}`.slice(0, 512));
                        modLogManager.addModLog(guildId, userId, { type: 'kick', reason, moderatorId: actorId, moderatorTag: actorTag });
                        await logAudit(client, {
                            action: 'MOD_KICK', actorId, actorTag,
                            details: `Kick <@${userId}> — Reason: "${reason}" (from the web)`, guildId
                        }).catch(() => {});
                        log(`[dash] kick ${userId} in ${guildId} by ${actorTag}`);
                        return sendJson(res, 200, { ok: true, action, userId, dmOk });
                    }

                    if (action === 'ban') {
                        const deleteDays = Number(body?.deleteDays || 0);
                        if (!Number.isInteger(deleteDays) || deleteDays < 0 || deleteDays > BAN_DELETE_DAYS_MAX) {
                            return sendJson(res, 400, { error: `deleteDays must be 0–${BAN_DELETE_DAYS_MAX}` });
                        }
                        if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
                            return sendJson(res, 403, { error: 'The bot is missing the Ban Members permission.' });
                        }
                        const dmOk = await dmTarget(`🔨 **You were BANNED from ${g.name}**\n\nReason: ${reason}\nBy: ${actorTag}${deleteDays > 0 ? `\nYour messages from the last ${deleteDays} days were also deleted.` : ''}`);
                        await member.ban({
                            deleteMessageSeconds: deleteDays * 86400,
                            reason: ` by ${actorTag}: ${reason}`.slice(0, 512)
                        });
                        modLogManager.addModLog(guildId, userId, { type: 'ban', reason, moderatorId: actorId, moderatorTag: actorTag });
                        await logAudit(client, {
                            action: 'MOD_BAN', actorId, actorTag,
                            details: `Ban <@${userId}>${deleteDays > 0 ? ` + delete ${deleteDays} days of messages` : ''} — Reason: "${reason}" (from the web)`, guildId
                        }).catch(() => {});
                        log(`[dash] ban ${userId} in ${guildId} by ${actorTag}`);
                        return sendJson(res, 200, { ok: true, action, userId, dmOk });
                    }

                    if (action === 'timeout') {
                        const minutes = Number(body?.minutes || 0);
                        const dur = validateTimeoutDuration(minutes);
                        if (!dur.ok) {
                            return sendJson(res, 400, {
                                error: dur.error === 'too-long'
                                    ? `The maximum timeout duration is 28 days (43200 minutes).`
                                    : 'The minimum duration is 1 minute.'
                            });
                        }
                        if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
                            return sendJson(res, 403, { error: 'The bot is missing the Moderate Members permission.' });
                        }
                        await member.timeout(dur.ms, ` by ${actorTag}: ${reason}`.slice(0, 512));
                        modLogManager.addModLog(guildId, userId, { type: 'timeout', reason, durationMs: dur.ms, moderatorId: actorId, moderatorTag: actorTag });
                        await logAudit(client, {
                            action: 'MOD_TIMEOUT', actorId, actorTag,
                            details: `Timeout <@${userId}> for ${minutes} minutes — Reason: "${reason}" (from the web)`, guildId
                        }).catch(() => {});
                        log(`[dash] timeout ${userId} (${minutes}m) in ${guildId} by ${actorTag}`);
                        return sendJson(res, 200, { ok: true, action, userId, minutes });
                    }

                    if (action === 'untimeout') {
                        if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
                            return sendJson(res, 403, { error: 'The bot is missing the Moderate Members permission.' });
                        }
                        if (!member.isCommunicationDisabled?.()) {
                            return sendJson(res, 200, { ok: true, action, userId, note: 'That member is not timed out.' });
                        }
                        await member.timeout(null, ` by ${actorTag}: ${reason}`.slice(0, 512));
                        modLogManager.addModLog(guildId, userId, { type: 'untimeout', reason, moderatorId: actorId, moderatorTag: actorTag });
                        await logAudit(client, {
                            action: 'MOD_UNTIMEOUT', actorId, actorTag,
                            details: `Remove the timeout of <@${userId}> — Reason: "${reason}" (from the web)`, guildId
                        }).catch(() => {});
                        log(`[dash] untimeout ${userId} in ${guildId} by ${actorTag}`);
                        return sendJson(res, 200, { ok: true, action, userId });
                    }
                }

                // ---- v3.24.4: Purge messages (parity with /purge) ----
                if (method === 'POST' && rest[0] === 'purge') {
                    if (!g) return sendJson(res, 404, { error: 'The bot is not in this server' });
                    const body = await readBody(req, res);
                    const channelId = String(body?.channelId || '');
                    const amount = Number(body?.amount || 0);
                    const filterUserId = body?.userId ? String(body.userId) : '';
                    if (!SNOWFLAKE_RE.test(channelId)) return sendJson(res, 400, { error: 'Invalid channelId' });
                    if (filterUserId && !SNOWFLAKE_RE.test(filterUserId)) return sendJson(res, 400, { error: 'Invalid userId filter' });
                    const check = validatePurgeAmount(amount);
                    if (!check.ok) {
                        return sendJson(res, 400, { error: check.error === 'too-large' ? 'Maximum 100 messages per purge (Discord limit).' : 'Minimum 1 message.' });
                    }

                    const channel = g.channels.cache.get(channelId);
                    if (!channel) return sendJson(res, 404, { error: 'Channel not found in this guild' });
                    if (channel.type !== ChannelType.GuildText) {
                        return sendJson(res, 400, { error: 'Purge only works in text channels.' });
                    }
                    const botMember = g.members?.me || null;
                    if (!botMember?.permissions?.has?.(PermissionFlagsBits.ManageMessages)) {
                        return sendJson(res, 403, { error: 'The bot is missing the Manage Messages permission.' });
                    }

                    const fetched = await channel.messages.fetch({ limit: 100 });
                    let pool = [...fetched.values()];
                    if (filterUserId) pool = pool.filter((m) => m.author?.id === filterUserId);
                    pool = pool.slice(0, amount);
                    const deletable = filterBulkDeletable(pool);
                    const skippedOld = pool.length - deletable.length;

                    if (deletable.length === 0) {
                        return sendJson(res, 200, {
                            ok: true,
                            deleted: 0,
                            note: filterUserId
                                ? 'No deletable messages from that user found (within the last 100 messages).'
                                : 'No deletable messages found (messages older than 14 days cannot be bulk-deleted).'
                        });
                    }
                    if (deletable.length === 1) {
                        await deletable[0].delete().catch(() => null);
                    } else {
                        await channel.bulkDelete(deletable, true);
                    }

                    await logAudit(client, {
                        action: 'MOD_PURGE',
                        actorId: String(body?.actor?.id || ''),
                        actorTag: String(body?.actor?.tag || 'web dashboard'),
                        details: `Purged ${deletable.length} messages in #${channel.name}${filterUserId ? ` (only <@${filterUserId}>'s messages)` : ''}${skippedOld > 0 ? ` — ${skippedOld} skipped (>14 days old)` : ''} (from the web)`,
                        guildId
                    }).catch(() => {});
                    log(`[dash] purge ${deletable.length} in #${channel.name} (${guildId}) by ${body?.actor?.tag || 'unknown'}`);
                    return sendJson(res, 200, { ok: true, deleted: deletable.length, skippedOld });
                }

                // ---- v3.22.0: POST /guilds/:id/verify-panel REMOVED ----
                // The dedicated verification feature was deleted — "verified"
                // is now a role on a self-role panel (install via the ticket
                // panel pattern or /setup-selfrole). Old dashboard builds that
                // still call this endpoint get the generic 404 below.
            }

            return sendJson(res, 404, { error: 'Endpoint not found' });
        } catch (err) {
            log(`[dash] error ${method} ${url.pathname}: ${err.message}`);
            return sendJson(res, 500, { error: `Internal error: ${err.message}` });
        }
    };
}

// ============================================================
// === Lifecycle (production) ===
// ============================================================

let activeServer = null;

/**
 * Run the DASH API server. Without DASH_API_TOKEN → it does not run (safe
 * default).
 * @param {import('discord.js').Client} client
 * @returns {http.Server | null}
 */
function startDashServer(client) {
    if (activeServer) return activeServer; // idempotent — never double-listen
    const token = (process.env.DASH_API_TOKEN || '').trim();
    if (!token) {
        console.log('ℹ️  DASH API is not active (DASH_API_TOKEN is empty). The web dashboard cannot connect.');
        return null;
    }
    const host = process.env.DASH_API_HOST || '127.0.0.1';
    const port = Number(process.env.DASH_API_PORT) || 8788;

    const handler = createDashHandler({ client, token, log: (m) => console.log(m) });
    activeServer = http.createServer(handler);
    activeServer.on('error', (err) => {
        console.error(`❌ DASH API error: ${err.message}`);
        activeServer = null;
    });
    activeServer.listen(port, host, () => {
        console.log(`🔌 DASH API ready: http://${host}:${port} (for the web dashboard, token-secured)`);
    });
    return activeServer;
}

function stopDashServer() {
    if (!activeServer) return;
    activeServer.close();
    activeServer = null;
}

module.exports = {
    createDashHandler,
    startDashServer,
    stopDashServer,
    // Exports for unit tests
    _internal: { validateUpdate, applyUpdates, validateAutomodPatch, SECTION_VALIDATORS, DEFAULTS }
};
