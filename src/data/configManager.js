const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');
// v3.11.0 phase 2: the legacy claim gate now uses the allowlist.
const { getAllowedGuildIds } = require('../infra/guild');

// ============================================================
// v3.10.0 MULTI-GUILD: config is now PER-GUILD.
//   Previously: a single global data/config.json shared by EVERY server
//   that invited the bot — admin of server A runs /set-channel welcome,
//   server B changes too (overwrite each other).
//   Now: data/config/<guildId>.json — one file per server.
//
//   One-time automatic migration: the old data/config.json (single-guild
//   era) is moved to data/config/<guildId>.json when the rightful guild
//   first reads its config (see _claimLegacyConfigIfNeeded). The old file
//   is renamed to config.json.migrated as an audit trail, not deleted.
// ============================================================
const configDir = path.join(__dirname, '..', '..', 'data', 'config');
const LEGACY_CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'config.json');

/** Path of a single guild's config file. */
function configPathFor(guildId) {
    return path.join(configDir, `${guildId}.json`);
}

// Default structure (used when config.json is empty / corrupt / old format)
const DEFAULTS = {
    roles: {},
    channels: {},
    messages: {
        welcomeTitle: '👋 WELCOME!',
        welcomeBody:
            'Hello {user}!\n\nWelcome to **{server}** 🎉\n\n🔐 Please verify yourself to get full access to the server.\n\n📊 You are member #**{count}**!',
        goodbyeTitle: '👋 FAREWELL',
        goodbyeBody:
            '**{username}** has {action} the server.\n\nSee you again! 👋\n\n📊 Remaining members: **{count}**',
        verifyTitle: '✅ SERVER VERIFICATION',
        verifyBody:
            'Welcome to **{server}**!\n\nClick the button below to get verified and gain full access to all channels.',
        ticketTitle: '🎫 TICKET SYSTEM & PRICE LIST',
        // v3.9.12: the ticket body now supports template variables.
        // Available variables: {server}, {price_list}, {price_list:<category>}, {price_header}, {categories_list}
        ticketBody:
            'Need help or want to buy something?\n\nClick a category button below to get started.\n\n**{price_header}**\n{price_list}',
        // v3.9.11 Phase 1: ticket header is configurable (previously hardcoded "PRICE LIST KEY")
        ticketPriceHeader: '💰 PRICE LIST 💰'
    },
    // v3.9.11 Phase 1: verify button is configurable (previously hardcoded label/emoji/style)
    verifyButton: {
        label: 'Verify Me',
        emoji: '✅',
        style: 'Success' // Primary | Secondary | Success | Danger
    },
    // v3.9.18: ticket categories (4 built-in default categories)
    // - "Bantuan Staff" → "Help" (rename, simpler & international)
    // - "Laporkan Member" → "Report" (rename)
    // - Extra: "Claim Giveaway" as an example custom category without products.
    //   Admins can remove it with /remove-category (isDefault=false) or add
    //   other new categories via /add-category.
    ticketCategories: [
        {
            id: 'transaction',
            label: 'Buy Key / Transaction',
            emoji: '🔑',
            style: 'Primary',
            requiresKey: true,
            isDefault: true
        },
        { id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false, isDefault: true },
        { id: 'report', label: 'Report', emoji: '⚠️', style: 'Danger', requiresKey: false, isDefault: true },
        {
            id: 'claim_giveaway',
            label: 'Claim Giveaway',
            emoji: '🎁',
            style: 'Success',
            requiresKey: false,
            isDefault: false
        },
        // v3.9.32: escrow category — 3-party escrow deals (buyer/seller/midman).
        // Intercepted by the router (ticket_cat:midman → midman domain), NOT via
        // createTicket. isDefault: false + the midmanCategoryDismissed flag so an
        // admin who doesn't want the escrow feature can remove it via /remove-category
        // without the category "coming back to life" on the next getConfig().
        {
            id: 'midman',
            label: 'Midman / Escrow',
            emoji: '🤝',
            style: 'Success',
            requiresKey: false,
            isDefault: false
        }
    ],
    // v3.9.32: midman/escrow configuration.
    //   feeMode  : 'percent' (feeValue = percent) | 'flat' (feeValue = fixed Rp amount)
    //   feeValue : the fee value — computed AUTOMATICALLY when a deal is created (not manual).
    //   category : the deal channel category name (customizable).
    midman: {
        feeMode: 'percent',
        feeValue: 5,
        category: '🤝 ESCROW'
    },
    // v3.9.13: Leveling system config
    leveling: {
        enabled: false, // off by default — an admin must enable it via /setup-leveling
        xpPerMessage: 15,
        cooldownMs: 60000, // 1-minute anti-spam XP cooldown
        announceLevelUp: true,
        levelUpChannel: null // null = the channel where the user chatted
    },
    levelRoles: [], // [{ level: 10, roleId: "123" }, ...]
    colors: {
        success: 3066993,
        danger: 15158332,
        primary: 3447003,
        warning: 15105570,
        info: 5793266
    },
    products: []
};

// ============================================================
// === v3.10.0: LEGACY MIGRATION (config.json → config/<guildId>.json) ===
// ============================================================
// In-process flag: the legacy claim may only happen once — after the move
// the old file is renamed to config.json.migrated so existsSync returns
// false; this flag is a second safety net in case the rename fails.
let legacyClaimed = false;

/**
 * Claim the old data/config.json (single-guild era) for this guild.
 * Called ONLY from the ENOENT branch of getConfig() — the per-guild file
 * doesn't exist yet, so there's no risk of overwriting a live guild config.
 *
 * Claim rules (prevent another server from "stealing" the old config):
 *   - If the allowlist holds EXACTLY ONE guild (a single ALLOWED_GUILD_IDS
 *     entry or the GUILD_ID fallback — the v3.9.26 single-guild mode): only
 *     the matching guild may claim. Other guilds get pure DEFAULTS, not a
 *     copy of the main server's config.
 *   - If the allowlist is empty / holds several guilds (multi-guild mode):
 *     the FIRST guild to call getConfig() claims the legacy. For a bot that
 *     has been used on one server and then opened up to multi-guild, that old
 *     server is almost certainly the first caller (ready/interaction events).
 *     A clear log is printed so the admin can audit who claimed it.
 *
 * @returns {Object} the old raw config (not merged yet), or {} if none.
 */
function _claimLegacyConfigIfNeeded(guildId) {
    if (legacyClaimed) return {};
    if (!fs.existsSync(LEGACY_CONFIG_PATH)) return {};

    // v3.11.0: the claim gate uses the allowlist — a single guild (from a
    // single ALLOWED_GUILD_IDS entry / the GUILD_ID fallback) means only it
    // may claim; empty / several guilds means the first caller claims.
    const allowed = getAllowedGuildIds();
    if (allowed.length === 1 && allowed[0] !== guildId) return {};

    try {
        const raw = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, 'utf8'));
        fs.mkdirSync(configDir, { recursive: true });
        // Write the new guild file via writeFileSync directly (not
        // safeWriteJSON) — the data is still raw; full normalization +
        // save is continued by the getConfig() pipeline after return.
        fs.writeFileSync(configPathFor(guildId), JSON.stringify(raw, null, 2));
        // Rename legacy → .migrated: audit trail + prevents re-claiming.
        try {
            fs.renameSync(LEGACY_CONFIG_PATH, `${LEGACY_CONFIG_PATH}.migrated`);
        } catch (renameErr) {
            // Rename failed (e.g. a Windows FS lock) — the old file remains
            // but the legacyClaimed flag prevents a second claim in this process.
            console.warn('⚠️ Failed to rename the old config.json:', renameErr.message);
        }
        legacyClaimed = true;
        console.log(
            `✅ Multi-guild v3.10.0 migration: old config.json moved to data/config/${guildId}.json ` +
                '(the old file was renamed to config.json.migrated as a trail).'
        );
        return raw;
    } catch (err) {
        console.warn('⚠️ Failed to migrate the legacy config (using DEFAULTS):', err.message);
        return {};
    }
}

/**
 * Read a guild's config (always fresh - no caching).
 * - If the file is missing / corrupt -> use DEFAULTS
 * - If v1 format (flat) -> auto-migrate to v2 (nested)
 * - If v2 format -> merge with DEFAULTS so new fields still exist
 *
 * P2-4 FIX: previously used `delete require.cache` + `require()` which
 * was prone to race conditions and was an anti-pattern. Now uses readFileSync + JSON.parse
 * like the other managers.
 *
 * v3.10.0: signature is getConfig(guildId). guildId is REQUIRED — without it
 * this function throws (fail-fast). A silent fallback to a global file is a
 * hard-to-trace cross-guild bug (server A reading server B's config);
 * better to crash immediately in dev/test than fail silently in production.
 *
 * @param {string} guildId - Discord guild ID (required)
 */
function getConfig(guildId) {
    if (!guildId || typeof guildId !== 'string') {
        throw new Error('getConfig(guildId): guildId is required — multi-guild v3.10.0 (call resolveGuildId(interaction) in the caller)');
    }
    const configPath = configPathFor(guildId);

    let raw = {};
    try {
        const fileContent = fs.readFileSync(configPath, 'utf8');
        raw = JSON.parse(fileContent);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            // File exists but is corrupt — log a warning. If ENOENT, try the legacy migration.
            console.warn(`⚠️ config/${guildId}.json is corrupt, using DEFAULTS. Message:`, err.message);
            // v3.9.26: quarantine the corrupt file BEFORE continuing with DEFAULTS. Without this,
            // a subsequent setField()/saveConfig() would write a NEW config over the corrupt
            // file — all settings (roles/channels/products) permanently lost without a
            // trace. With quarantine, the old contents are preserved as
            // config.json.corrupt-<ts> for inspection/manual recovery.
            quarantineCorruptFile(configPath);
        } else {
            // v3.10.0: this guild's file doesn't exist yet — possibly a
            // migration from the single-guild era config.json.
            raw = _claimLegacyConfigIfNeeded(guildId);
        }
    }

    // === AUTO-MIGRATE v1 -> v2 ===
    // v1 has flat fields: verifiedRoleId, unverifiedRoleId, invoiceChannelId, welcomeChannelId, goodbyeChannelId
    let didV1Migration = false;
    if (raw.verifiedRoleId || raw.invoiceChannelId) {
        if (!raw.roles) raw.roles = {};
        if (raw.verifiedRoleId && !raw.roles.verified) raw.roles.verified = raw.verifiedRoleId;
        if (raw.unverifiedRoleId && !raw.roles.unverified) raw.roles.unverified = raw.unverifiedRoleId;
        if (raw.adminRoleId && !raw.roles.admin) raw.roles.admin = raw.adminRoleId;

        if (!raw.channels) raw.channels = {};
        if (raw.invoiceChannelId && !raw.channels.invoice) raw.channels.invoice = raw.invoiceChannelId;
        if (raw.welcomeChannelId && !raw.channels.welcome) raw.channels.welcome = raw.welcomeChannelId;
        if (raw.goodbyeChannelId && !raw.channels.goodbye) raw.channels.goodbye = raw.goodbyeChannelId;

        // v3.9.26 FIX: remove the v1 flat keys from raw — before, the migration save only
        // wrote {roles, channels, messages, colors, products} to disk, so a MIXED file
        // (v2 + leftover v1 flat keys, e.g. from manual edits / an old restore)
        // lost ticketCategories, leveling, levelRoles, verifyButton, and
        // custom admin fields on auto-save. Now: flat keys are deleted from raw,
        // and the save happens AFTER the full merge (below) → no fields get dropped.
        for (const flatKey of [
            'verifiedRoleId',
            'unverifiedRoleId',
            'adminRoleId',
            'invoiceChannelId',
            'welcomeChannelId',
            'goodbyeChannelId'
        ]) {
            delete raw[flatKey];
        }
        didV1Migration = true;
    }

    // === MERGE with DEFAULTS (deep for messages) ===
    // v3.9.11: added merge for verifyButton & ticketCategories
    // v3.9.13: added merge for leveling & levelRoles
    // v3.9.17 FIX: preserve custom fields (ticketCategoryKey, ticketCategoryNoKey,
    //   and other non-standard fields). Before, only keys present in DEFAULTS were
    //   merged — fields an admin added manually to config.json got DROPPED.
    //   Now: spread `...raw` at the end so custom fields are preserved, BUT
    //   keys already merged explicitly will override (since the spread comes first).
    const config = {
        ...raw, // preserve unknown fields (v3.9.17)
        roles: { ...DEFAULTS.roles, ...(raw.roles || {}) },
        channels: { ...DEFAULTS.channels, ...(raw.channels || {}) },
        messages: { ...DEFAULTS.messages, ...(raw.messages || {}) },
        colors: { ...DEFAULTS.colors, ...(raw.colors || {}) },
        verifyButton: { ...DEFAULTS.verifyButton, ...(raw.verifyButton || {}) },
        ticketCategories:
            Array.isArray(raw.ticketCategories) && raw.ticketCategories.length > 0
                ? raw.ticketCategories
                : DEFAULTS.ticketCategories,
        leveling: { ...DEFAULTS.leveling, ...(raw.leveling || {}) },
        levelRoles: Array.isArray(raw.levelRoles) ? raw.levelRoles : DEFAULTS.levelRoles,
        // v3.9.32: merge midman config (custom admin fields preserved).
        midman: { ...DEFAULTS.midman, ...(raw.midman || {}) },
        products: Array.isArray(raw.products) ? raw.products : DEFAULTS.products
    };

    // Backward compat: rename the 'mlbb_key' category (old) → 'transaction' (new).
    // Applies to ticketCategories and product.category.
    // Old configs still using 'mlbb_key' keep working, but the next save will replace it.
    if (Array.isArray(config.ticketCategories)) {
        config.ticketCategories = config.ticketCategories.map(cat =>
            cat.id === 'mlbb_key' ? { ...cat, id: 'transaction' } : cat
        );
    }
    if (Array.isArray(config.products)) {
        config.products = config.products.map(p =>
            p && p.category === 'mlbb_key' ? { ...p, category: 'transaction' } : p
        );
    }

    // === v3.9.18 MIGRATION: rename default labels & add claim_giveaway ===
    // Goal: existing servers with an old config.json automatically get the
    // new "Help"/"Report" labels (replacing "Bantuan Staff"/"Laporkan Member"),
    // and the example "Claim Giveaway" category is added if missing.
    //
    // This migration is conservative:
    //   - Only renames the label if it still uses the old default label. If the
    //     admin already customized the label (e.g. "Ask an Admin"), it's NOT touched.
    //   - claim_giveaway is only added if no category with that id exists.
    //     If the admin already removed it, it won't be added again.
    let _migrationChanged = false;
    if (Array.isArray(config.ticketCategories)) {
        config.ticketCategories = config.ticketCategories.map(cat => {
            if (cat && cat.id === 'help' && (cat.label === 'Bantuan Staff' || cat.label === 'Bantuan')) {
                _migrationChanged = true;
                return { ...cat, label: 'Help' };
            }
            if (cat && cat.id === 'report' && (cat.label === 'Laporkan Member' || cat.label === 'Laporkan')) {
                _migrationChanged = true;
                return { ...cat, label: 'Report' };
            }
            return cat;
        });
        // Add claim_giveaway if missing (once only — if the admin removed it,
        // it won't be added again because the claimGiveawayDismissed flag is set by
        // /remove-category, see categories.js)
        // v3.9.26 FIX: the comment above used to LIE — there was no flag,
        // /remove-category claim_giveaway succeeded, then the very next getConfig()
        // (which runs on every message!) re-added the category + auto-saved the config. The
        // category "came back to life" silently — impossible to remove permanently.
        const hasClaimGiveaway = config.ticketCategories.some(c => c && c.id === 'claim_giveaway');
        if (!hasClaimGiveaway && !config.claimGiveawayDismissed) {
            config.ticketCategories.push({
                id: 'claim_giveaway',
                label: 'Claim Giveaway',
                emoji: '🎁',
                style: 'Success',
                requiresKey: false,
                isDefault: false
            });
            _migrationChanged = true;
        }
        // v3.9.32: add the midman/escrow category to old configs (the same pattern as
        // claim_giveaway — once only; if the admin removed it via
        // /remove-category, the midmanCategoryDismissed flag prevents re-adding).
        const hasMidmanCat = config.ticketCategories.some(c => c && c.id === 'midman');
        if (!hasMidmanCat && !config.midmanCategoryDismissed) {
            config.ticketCategories.push({
                id: 'midman',
                label: 'Midman / Escrow',
                emoji: '🤝',
                style: 'Success',
                requiresKey: false,
                isDefault: false
            });
            _migrationChanged = true;
        }
    }
    // v3.9.26: the v1→v2 migration save now happens AFTER the full merge — the saved
    // result contains the complete schema (ticketCategories, leveling, levelRoles, verifyButton,
    // custom fields), not just the 5 main keys.
    if (didV1Migration) {
        try {
            saveConfig(guildId, config);
            console.log(`✅ Old (v1) config for guild ${guildId} auto-migrated to v2 (modern fields preserved).`);
        } catch (e) {
            console.warn('⚠️ Failed to auto-save the v1 migration:', e.message);
        }
    }
    if (_migrationChanged) {
        try {
            saveConfig(guildId, config);
            // v3.9.37: message updated — this block now also adds the
            // midman category (v3.9.32), not just the Help/Report rename +
            // claim_giveaway (v3.9.18) like the old message said.
            console.log(
                `📦 Ticket category migration (guild ${guildId}): Help/Report rename + claim_giveaway + midman (escrow) added.`
            );
        } catch (migErr) {
            console.warn('⚠️ Failed to save the ticket category migration:', migErr.message);
        }
    }

    return config;
}

/**
 * Save a guild's config in a pretty format.
 * v3.9.0 FIX: uses safeWriteJSON (atomic write via tmp+rename) so that
 * if the bot crashes / OOMs / loses power during the write, the config file
 * doesn't corrupt (truncated / empty). Previously it used fs.writeFileSync directly.
 *
 * v3.10.0: signature is saveConfig(guildId, config) — the data/config/
 * directory is created automatically (recursive) if missing.
 *
 * @param {string} guildId - Discord guild ID (required)
 * @param {Object} config - the full config object
 */
function saveConfig(guildId, config) {
    if (!guildId || typeof guildId !== 'string') {
        throw new Error('saveConfig(guildId, config): guildId is required — multi-guild v3.10.0');
    }
    fs.mkdirSync(configDir, { recursive: true });
    safeWriteJSON(configPathFor(guildId), config);
}

/**
 * Set a nested value (e.g. 'roles.admin' or 'channels.welcome').
 * v3.9.0 FIX: sanitize the dotPath to prevent prototype pollution
 * (e.g. '__proto__.polluted' or 'constructor.prototype.x').
 *
 * v3.10.0: signature is setField(guildId, dotPath, value) — only the
 * config of that guild is modified.
 *
 * @param {string} guildId - Discord guild ID (required)
 * @param {string} dotPath - nested path, e.g. 'roles.admin'
 * @param {*} value
 */
function setField(guildId, dotPath, value) {
    const config = getConfig(guildId);
    const keys = dotPath.split('.');

    // Reject keys that could touch Object.prototype
    const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    for (const k of keys) {
        if (FORBIDDEN_KEYS.has(k)) {
            throw new Error(`Path "${dotPath}" contains a forbidden key: ${k}`);
        }
    }

    let cur = config;
    for (let i = 0; i < keys.length - 1; i++) {
        if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) {
            cur[keys[i]] = {};
        }
        cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = value;
    saveConfig(guildId, config);

    // v3.9.2: invalidate the permissions cache when the admin role changes,
    // so the change takes effect immediately without waiting for the 30-second TTL.
    if (keys[0] === 'roles' && keys[1] === 'admin') {
        try {
            const { invalidateAdminRoleCache } = require('../infra/permissions');
            invalidateAdminRoleCache();
        } catch (_) {
            /* permissions not loaded yet — ignore */
        }
    }

    return config;
}

/**
 * Replace template variable placeholders in text.
 *
 * Supported variables:
 *   - {user}          → user mention (e.g. <@123>)
 *   - {username}      → user tag (e.g. User#1234)
 *   - {server}        → guild name
 *   - {count}         → member count
 *   - {action}        → 'left' / 'was banned' / 'was kicked' (for goodbye)
 *
 * v3.9.12: Extra variables for the ticket body (used by /setup-ticket):
 *   - {price_list}        → list of all products (auto-generated from config.products)
 *   - {price_list:<cat>}  → product list filtered by category (e.g. {price_list:transaction})
 *   - {categories_list}   → list of all ticket categories (auto-generated from config.ticketCategories)
 *   - {price_header}      → contents of config.messages.ticketPriceHeader
 */
function fillTemplate(text, vars = {}) {
    let result = text
        .replace(/\{user\}/g, vars.user || '')
        .replace(/\{username\}/g, vars.username || '')
        .replace(/\{server\}/g, vars.server || '')
        .replace(/\{count\}/g, vars.count || '0')
        .replace(/\{action\}/g, vars.action || 'left');

    // v3.9.12: ticket-specific variables
    if (vars.priceList !== undefined) {
        result = result.replace(/\{price_list\}/g, vars.priceList);
    }
    if (vars.priceHeader !== undefined) {
        result = result.replace(/\{price_header\}/g, vars.priceHeader);
    }
    if (vars.categoriesList !== undefined) {
        result = result.replace(/\{categories_list\}/g, vars.categoriesList);
    }
    // {price_list:<categoryId>} — filtered by category
    if (vars.priceListByCategory && typeof vars.priceListByCategory === 'object') {
        result = result.replace(/\{price_list:([a-zA-Z0-9_-]+)\}/g, (match, catId) => {
            return vars.priceListByCategory[catId] || `_(no products in category \`${catId}\` yet)_`;
        });
    }

    return result;
}

module.exports = {
    getConfig,
    saveConfig,
    setField,
    fillTemplate,
    DEFAULTS,
    configPathFor,
    // v3.11.0: unit-test only — resets the in-process claim flag so the
    // migration flow can be exercised repeatedly within one process. Production never uses this.
    _resetLegacyClaimForTest: () => {
        legacyClaimed = false;
    }
};
