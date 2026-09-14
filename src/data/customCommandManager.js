/**
 * Custom Command Manager — admin-made slash commands, created from the WEB (v3.20.0).
 *
 * Dyno's "Custom Commands" model: an admin builds their own command on the
 * web dashboard (name, description, text/embed reply), and the bot registers
 * it as a REAL per-server slash command -> members just use /name.
 * Edits/deletes from the web re-sync registration automatically
 * (customCommandSync.js).
 *
 * File: data/customCommands/<guildId>.json
 * {
 *   "commands": [
 *     {
 *       "name": "socials",                       // lowercase a-z 0-9 - _, 1-32
 *       "description": "All our social media links", // 1-100
 *       "ephemeral": false,                      // true = reply visible only to the user
 *       "content": "Follow us!",                 // text outside the embed, <=2000, optional
 *       "embed": { ...embedPayload.js def },     // optional (content OR embed required)
 *       "createdBy": "userId",
 *       "createdByTag": "Admin",
 *       "createdAt": 1735689600000,
 *       "updatedAt": 1735689600000,
 *       "useCount": 0
 *     }
 *   ]
 * }
 *
 * Limits:
 *   - Max 20 custom commands per guild (keeps the list sane).
 *   - Names must not collide with built-in commands (registry) — if they
 *     do, the built-in wins and the admin gets a clear error.
 *
 * Pattern: 15s read-through cache + invalidate-on-save (see
 * responderManager.js) — cheap to read on every interaction.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteJSON, quarantineCorruptFile } = require('../infra/safeWrite');
const { normalizeEmbedDef, isEmbedEmpty } = require('../infra/embedPayload');

const dirPath = path.join(__dirname, '..', '..', 'data', 'customCommands');
const MAX_CUSTOM_COMMANDS = 20;
const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_CONTENT = 2000;

const CACHE_TTL_MS = 15 * 1000;
const _guildCache = new Map(); // guildId -> { data, at }

function guildFile(guildId) {
    return path.join(dirPath, `${guildId}.json`);
}

function loadGuild(guildId) {
    const cached = _guildCache.get(guildId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
    let data = { commands: [] };
    try {
        if (fs.existsSync(guildFile(guildId))) {
            const parsed = JSON.parse(fs.readFileSync(guildFile(guildId), 'utf8'));
            if (parsed && Array.isArray(parsed.commands)) data = parsed;
        }
    } catch (_err) {
        // safeWrite pattern: quarantine the corrupt file, continue empty.
        quarantineCorruptFile(guildFile(guildId));
        data = { commands: [] };
    }
    _guildCache.set(guildId, { data, at: Date.now() });
    return data;
}

function saveGuild(guildId, data) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    safeWriteJSON(guildFile(guildId), data);
    _guildCache.set(guildId, { data, at: Date.now() });
}

/** Force a fresh read next time (backup restore / tests). */
function invalidateCache() {
    _guildCache.clear();
}

/** This guild's custom commands (array — do not mutate directly). */
function getGuildCommands(guildId) {
    return loadGuild(guildId).commands;
}

/** Find one command by name (lowercase). null when absent. */
function getCommand(guildId, name) {
    const n = String(name || '').toLowerCase();
    return getGuildCommands(guildId).find((c) => c.name === n) || null;
}

/**
 * Discord-ready defs (application command shape).
 * Everyone may use them (no defaultMemberPermissions) — public info
 * commands; admins can still disable them via /commands toggle or the web
 * Command Manager (the router's disabledCommands gate applies).
 */
function toApplicationCommands(guildId) {
    return getGuildCommands(guildId).map((c) => ({
        name: c.name,
        description: c.description
    }));
}

/**
 * Validate + normalize a command definition from raw input (web / API).
 *
 * @param {*} input  { name, description, ephemeral, content, embed }
 * @param {string[]} builtinNames  built-in command names (collision guard)
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
function validateDefinition(input, builtinNames = []) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid command definition' };

    const name = String(input.name || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) {
        return { ok: false, error: 'Command name may only use lowercase letters, numbers, - and _ (1-32 characters)' };
    }
    const builtins = new Set(builtinNames);
    if (builtins.has(name)) {
        return { ok: false, error: `The name \`/${name}\` is already used by a built-in bot command — pick another name` };
    }

    const description = String(input.description || '').trim();
    if (!description || description.length > 100) {
        return { ok: false, error: 'Description is required (1-100 characters)' };
    }

    const content = String(input.content || '').trim();
    if (content.length > MAX_CONTENT) {
        return { ok: false, error: `Reply text is limited to ${MAX_CONTENT} characters` };
    }

    const embedRes = normalizeEmbedDef(input.embed);
    if (!embedRes.ok) return { ok: false, error: `Embed: ${embedRes.error}` };
    const embed = embedRes.value;

    if (!content && isEmbedEmpty(embed)) {
        return { ok: false, error: 'Set at least reply text OR an embed — both are empty' };
    }

    return {
        ok: true,
        value: {
            name,
            description,
            ephemeral: input.ephemeral === true,
            content,
            embed,
            updatedAt: Date.now()
        }
    };
}

/**
 * Create / update a command (upsert by name). `actor` = { id, tag } of the
 * logged-in web user.
 * @returns {{ ok: true, command: object } | { ok: false, error: string }}
 */
function upsertCommand(guildId, input, builtinNames = [], actor = null) {
    const validated = validateDefinition(input, builtinNames);
    if (!validated.ok) return { ok: false, error: validated.error };
    const def = validated.value;

    const data = loadGuild(guildId);
    const existing = data.commands.find((c) => c.name === def.name);

    if (!existing && data.commands.length >= MAX_CUSTOM_COMMANDS) {
        return { ok: false, error: `Maximum ${MAX_CUSTOM_COMMANDS} custom commands per server` };
    }

    if (existing) {
        existing.description = def.description;
        existing.ephemeral = def.ephemeral;
        existing.content = def.content;
        existing.embed = def.embed;
        existing.updatedAt = def.updatedAt;
        existing.updatedBy = actor?.id || null;
        existing.updatedByTag = actor?.tag || null;
        saveGuild(guildId, data);
        return { ok: true, command: existing, created: false };
    }

    const command = {
        name: def.name,
        description: def.description,
        ephemeral: def.ephemeral,
        content: def.content,
        embed: def.embed,
        createdBy: actor?.id || null,
        createdByTag: actor?.tag || null,
        createdAt: def.updatedAt,
        updatedAt: def.updatedAt,
        updatedBy: null,
        updatedByTag: null,
        useCount: 0
    };
    data.commands.push(command);
    saveGuild(guildId, data);
    return { ok: true, command, created: true };
}

/** Delete a command by name. */
function deleteCommand(guildId, name) {
    const n = String(name || '').toLowerCase();
    const data = loadGuild(guildId);
    const before = data.commands.length;
    data.commands = data.commands.filter((c) => c.name !== n);
    if (data.commands.length === before) {
        return { ok: false, error: `Custom command \`/${n}\` not found` };
    }
    saveGuild(guildId, data);
    return { ok: true };
}

/** Record usage (best-effort, called by the router when used). */
function incrementUse(guildId, name) {
    try {
        const n = String(name || '').toLowerCase();
        const data = loadGuild(guildId);
        const cmd = data.commands.find((c) => c.name === n);
        if (!cmd) return;
        cmd.useCount = (cmd.useCount || 0) + 1;
        saveGuild(guildId, data);
    } catch (_err) {
        /* stats must never break the command reply */
    }
}

module.exports = {
    MAX_CUSTOM_COMMANDS,
    validateDefinition,
    getGuildCommands,
    getCommand,
    toApplicationCommands,
    upsertCommand,
    deleteCommand,
    incrementUse,
    invalidateCache
};
