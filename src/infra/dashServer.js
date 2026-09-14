/**
 * Dashboard API Server (v3.17.0) — a small HTTP API for the WEB DASHBOARD.
 *
 * Concept (Dyno-style): every bot setting can be controlled through TWO
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
 *   POST   /guilds/:id/selfroles/:panelId/roles → add a role to a panel (re-renders)
 *   DELETE /guilds/:id/selfroles/:panelId/roles?roleId=... → remove a role from a panel
 *   DELETE /guilds/:id/selfroles/:panelId       → delete the panel + its message
 *   POST   /guilds/:id/serverstats/refresh      → force-refresh the counters
 *   DELETE /guilds/:id/tempvoice                → detach the temp voice setup (config only)
 *
 * Actor audit: every write operation receives `actor: { id, tag }` (the
 * logged-in dashboard user) — logged to console + audit log where possible,
 * so the trail of "who changed what from the web" is always preserved.
 */

const http = require('http');
const crypto = require('crypto');

// Data layer — the SAME single source of truth as the slash commands.
const { getConfig, saveConfig, DEFAULTS } = require('../data/configManager');
const automodManager = require('../data/automodManager');
const responderManager = require('../data/responderManager');
const selfRoleManager = require('../data/selfRoleManager');
const tempVoiceManager = require('../data/tempVoiceManager');
const announcements = require('../data/scheduledAnnouncements');
const serverstatsManager = require('../data/serverstatsManager');
const { buildPanelEmbed, buildPanelComponents } = require('../ui/selfRolePanelBuilder');
const { normalizeNewlines } = require('./text');

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
    verifyButton: (key, value) => {
        if (key === 'label') {
            if (!isStr(value, 80)) return { ok: false, error: 'Button label must be 1-80 characters' };
            return { ok: true, value };
        }
        if (key === 'emoji') {
            if (!isStr(value, 64)) return { ok: false, error: 'Invalid emoji' };
            return { ok: true, value };
        }
        if (key === 'style') {
            if (!BUTTON_STYLES.includes(value)) return { ok: false, error: `Style must be one of: ${BUTTON_STYLES.join(', ')}` };
            return { ok: true, value };
        }
        return { ok: false, error: `verifyButton.${key} is unknown` };
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
    if (['levelRoles', 'ticketCategories', 'products'].includes(section)) {
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
            config[v.section] = v.value; // whole array
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

    function readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', (c) => {
                size += c.length;
                if (size > MAX_BODY_BYTES) {
                    reject(new Error('Body too large'));
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
        return {
            config: getConfig(guildId),
            automod: automodManager.getGuildConfig(guildId),
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
        const url = new URL(req.url, 'http://localhost');
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
                    const body = await readBody(req);
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
                    const body = await readBody(req);
                    if (!body || typeof body !== 'object' || Array.isArray(body)) {
                        return sendJson(res, 400, { error: 'Body must be an automod object' });
                    }
                    delete body.actor; // actor is not an automod field
                    const { out, errs } = validateAutomodPatch(body);
                    if (errs.length > 0) return sendJson(res, 422, { error: 'Validation failed', details: errs });
                    const merged = automodManager.setGuildConfig(guildId, out);
                    log(`[dash] automod ${guildId} updated by ${out.__actor || 'unknown'}`);
                    return sendJson(res, 200, { ok: true, automod: merged });
                }

                // ---- Responders ----
                if (rest[0] === 'responders') {
                    if (method === 'POST' && rest.length === 1) {
                        const body = await readBody(req);
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
                        const body = await readBody(req);
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
                        const ok = announcements.remove(rest[1]);
                        if (!ok) return sendJson(res, 404, { error: 'Announcement not found' });
                        return sendJson(res, 200, { ok: true });
                    }
                }

                // ---- Self-role panels ----
                if (rest[0] === 'selfroles') {
                    if (method === 'POST' && rest.length === 1) {
                        const body = await readBody(req);
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
                            exclusive: !!body?.exclusive
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
                        const body = await readBody(req);
                        if (!SNOWFLAKE_RE.test(String(body?.roleId || ''))) return sendJson(res, 400, { error: 'Invalid roleId' });
                        const added = selfRoleManager.addRoleToPanel(rest[1], {
                            roleId: String(body.roleId),
                            label: String(body?.label || 'Role').slice(0, 80),
                            emoji: body?.emoji ? String(body.emoji).slice(0, 64) : undefined,
                            description: body?.description ? String(body.description).slice(0, 100) : undefined,
                            style: BUTTON_STYLES.includes(body?.style) ? body.style : 'Secondary'
                        });
                        if (!added.ok) return sendJson(res, 409, { error: added.error });
                        await reRenderPanel(rest[1]);
                        return sendJson(res, 200, { ok: true, panel: selfRoleManager.getPanel(rest[1]) });
                    }

                    if (method === 'DELETE' && rest.length === 3 && rest[2] === 'roles') {
                        const roleId = url.searchParams.get('roleId');
                        if (!roleId) return sendJson(res, 400, { error: 'The roleId parameter is required' });
                        const removed = selfRoleManager.removeRoleFromPanel(rest[1], roleId);
                        if (!removed.ok) return sendJson(res, 404, { error: removed.error });
                        await reRenderPanel(rest[1]);
                        return sendJson(res, 200, { ok: true, panel: selfRoleManager.getPanel(rest[1]) });
                    }

                    if (method === 'DELETE' && rest.length === 2) {
                        const panel = selfRoleManager.getPanel(rest[1]);
                        if (!panel) return sendJson(res, 404, { error: 'Panel not found' });
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
                        return sendJson(res, 200, { ok: true });
                    }
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
