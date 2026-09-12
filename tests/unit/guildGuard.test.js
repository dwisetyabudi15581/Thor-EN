/**
 * Unit tests v3.11.0 — multi-guild phase 2: the ALLOWED_GUILD_IDS allowlist.
 *
 * What these tests prove:
 *   1. src/infra/guild.js — list parsing: comma + space separators, empty
 *      entries dropped, priority ALLOWED_GUILD_IDS > GUILD_ID (the fallback
 *      stays fully compatible with old admins' .env files that only set
 *      GUILD_ID).
 *   2. isGuildAllowed(): an empty list = open mode (every guild — the
 *      v3.10.0 behavior is unchanged); null/DM = false.
 *   3. Event handler guards use the allowlist: a guildMemberAdd from a guild
 *      outside the list is ignored AND LOGGED (why); an interactionCreate
 *      from a guild outside the list is never routed.
 *   4. The configManager legacy claim gate (v3.10.0) now uses the allowlist:
 *      a SINGLE-entry allowlist → another guild cannot "steal" the legacy
 *      config.json; the matching guild still claims it.
 *   5. ready.js: startup picks guilds from the allowlist (_startupGuilds) +
 *      a static contract for per-guild registration (loops every allowlisted
 *      guild, not just the first one).
 *
 * Env is snapshotted and restored in finally() so these tests never leak
 * into other tests (the welcomeDiagnostics.test.js pattern).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { getAllowedGuildIds, isGuildAllowed, resolveGuildId } = require('../../src/infra/guild');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const LEGACY = path.join(DATA_DIR, 'config.json');

/** Snapshot the allowlist env vars, restore after the test. */
async function withEnv(allow, guild, fn) {
    const savedAllow = process.env.ALLOWED_GUILD_IDS;
    const savedGuild = process.env.GUILD_ID;
    if (allow === undefined) delete process.env.ALLOWED_GUILD_IDS;
    else process.env.ALLOWED_GUILD_IDS = allow;
    if (guild === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = guild;
    try {
        await fn();
    } finally {
        if (savedAllow === undefined) delete process.env.ALLOWED_GUILD_IDS;
        else process.env.ALLOWED_GUILD_IDS = savedAllow;
        if (savedGuild === undefined) delete process.env.GUILD_ID;
        else process.env.GUILD_ID = savedGuild;
    }
}

/** Capture console.log/warn/error while fn runs (keeps output clean). */
async function captureConsole(fn) {
    const rows = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a) => rows.push(['log', a.join(' ')]);
    console.warn = (...a) => rows.push(['warn', a.join(' ')]);
    console.error = (...a) => rows.push(['error', a.join(' ')]);
    try {
        await fn();
    } finally {
        console.log = orig.log;
        console.warn = orig.warn;
        console.error = orig.error;
    }
    return rows;
}

// ====================================================
// === 1. Allowlist parsing                          ===
// ====================================================

test('getAllowedGuildIds: empty env → [] (open mode)', async () => {
    await withEnv(undefined, undefined, () => {
        assert.deepStrictEqual(getAllowedGuildIds(), [], 'no ALLOWED_GUILD_IDS & no GUILD_ID');
    });
});

test('getAllowedGuildIds: single GUILD_ID fallback (old .env compatible)', async () => {
    await withEnv(undefined, 'guild_main', () => {
        assert.deepStrictEqual(getAllowedGuildIds(), ['guild_main']);
    });
});

test('getAllowedGuildIds: multi ALLOWED_GUILD_IDS — commas + spaces + empty entries', async () => {
    await withEnv('111, 222 ,333,,', undefined, () => {
        assert.deepStrictEqual(getAllowedGuildIds(), ['111', '222', '333']);
    });
});

test('getAllowedGuildIds: ALLOWED_GUILD_IDS wins over GUILD_ID', async () => {
    await withEnv('111,222', '999', () => {
        assert.deepStrictEqual(getAllowedGuildIds(), ['111', '222'], 'GUILD_ID is ignored when the allowlist is set');
    });
});

// ====================================================
// === 2. The pure isGuildAllowed() guard            ===
// ====================================================

test('isGuildAllowed: empty list (open mode) → every guild allowed', async () => {
    await withEnv(undefined, undefined, () => {
        assert.strictEqual(isGuildAllowed('111'), true);
        assert.strictEqual(isGuildAllowed('foreign_server'), true, 'the v3.10.0 open mode is unchanged');
    });
});

test('isGuildAllowed: list members true, foreign guilds false', async () => {
    await withEnv('111,222', undefined, () => {
        assert.strictEqual(isGuildAllowed('111'), true);
        assert.strictEqual(isGuildAllowed('222'), true);
        assert.strictEqual(isGuildAllowed('333'), false, 'guilds outside the allowlist are blocked');
    });
});

test('isGuildAllowed: null / undefined (DMs) → false', async () => {
    await withEnv('111,222', undefined, () => {
        assert.strictEqual(isGuildAllowed(null), false);
        assert.strictEqual(isGuildAllowed(undefined), false);
    });
});

test('resolveGuildId: the v3.10.0 contract is unchanged by phase 2', () => {
    assert.strictEqual(resolveGuildId({ guildId: '111', guild: { id: '999' } }), '111');
    assert.strictEqual(resolveGuildId({ guild: { id: '999' } }), '999');
    assert.strictEqual(resolveGuildId(null), null);
});

// ====================================================
// === 3. Event handler guards use the allowlist    ===
// ====================================================

test('guildMemberAdd guard: a join from a guild outside the allowlist is ignored + logged', async () => {
    await withEnv('111,222', undefined, async () => {
        const ev = require('../../src/bot/events/guildMemberAdd');
        const member = { guild: { id: '333' } };
        const rows = await captureConsole(() => ev.execute(member));
        assert.ok(
            rows.some((r) => r[0] === 'warn' && /333/.test(r[1]) && /allowlist/i.test(r[1])),
            'the skip must be visible + mention the allowlist (the v3.9.48 pattern)'
        );
    });
});

test('interactionCreate guard: an interaction from a foreign guild is never routed', async () => {
    await withEnv('111,222', undefined, async () => {
        const ev = require('../../src/bot/events/interactionCreate');
        let routed = false;
        const interaction = {
            guildId: '333',
            isChatInputCommand() {
                routed = true; // would be called if the guard let it through
                return true;
            }
        };
        await captureConsole(() => ev.execute(interaction));
        assert.strictEqual(routed, false, 'the interaction from guild 333 must be blocked before routing');
    });
});

// ====================================================
// === 4. The legacy claim gate uses the allowlist  ===
// ====================================================

test('v3.11.0 legacy claim: single-entry allowlist — a foreign guild gets DEFAULTS, the matching guild claims', async () => {
    // Sandbox: snapshot the old config state (if any), then install a fresh legacy file.
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const hadLegacy = fs.existsSync(LEGACY);
    if (hadLegacy) fs.copyFileSync(LEGACY, LEGACY + '.test-backup');
    const hadMigrated = fs.existsSync(LEGACY + '.migrated');
    if (hadMigrated) fs.copyFileSync(LEGACY + '.migrated', LEGACY + '.migrated.test-backup');
    const ownerPath = path.join(CONFIG_DIR, 'guild_owner_311.json');
    const strangerPath = path.join(CONFIG_DIR, 'guild_stranger_311.json');
    const hadOwner = fs.existsSync(ownerPath);
    const hadStranger = fs.existsSync(strangerPath);
    if (hadOwner) fs.copyFileSync(ownerPath, ownerPath + '.test-backup');
    if (hadStranger) fs.copyFileSync(strangerPath, strangerPath + '.test-backup');

    try {
        fs.writeFileSync(LEGACY, JSON.stringify({ channels: { welcome: 'ch_legacy_311' } }, null, 2));
        fs.rmSync(ownerPath, { force: true });
        fs.rmSync(strangerPath, { force: true });
        fs.rmSync(LEGACY + '.migrated', { force: true });
        // Reset the in-process flag so the claim flow can be tested from scratch.
        const cm = require('../../src/data/configManager');
        if (typeof cm._resetLegacyClaimForTest === 'function') cm._resetLegacyClaimForTest();

        await withEnv('guild_owner_311', undefined, async () => {
            // 1) A foreign guild calls first — it must NOT steal the legacy.
            const strangerConfig = cm.getConfig('guild_stranger_311');
            assert.notStrictEqual(
                strangerConfig.channels.welcome,
                'ch_legacy_311',
                'the foreign guild gets pure DEFAULTS, not the legacy config'
            );
            assert.ok(fs.existsSync(LEGACY), 'the legacy file is still intact (unclaimed)');

            // 2) The matching guild (the only allowlist member) claims the legacy.
            const ownerConfig = cm.getConfig('guild_owner_311');
            assert.strictEqual(
                ownerConfig.channels.welcome,
                'ch_legacy_311',
                'the single allowlisted guild claims the legacy config'
            );
            assert.ok(fs.existsSync(ownerPath), 'config/guild_owner_311.json is created');
            assert.ok(fs.existsSync(LEGACY + '.migrated'), 'the legacy file is renamed .migrated (audit trail)');
            assert.ok(!fs.existsSync(LEGACY), 'the original legacy file is gone');
        });
    } finally {
        // Restore the sandbox exactly as it was.
        if (hadLegacy) fs.copyFileSync(LEGACY + '.test-backup', LEGACY);
        else fs.rmSync(LEGACY, { force: true });
        fs.rmSync(LEGACY + '.test-backup', { force: true });
        if (hadMigrated) fs.copyFileSync(LEGACY + '.migrated.test-backup', LEGACY + '.migrated');
        else fs.rmSync(LEGACY + '.migrated', { force: true });
        fs.rmSync(LEGACY + '.migrated.test-backup', { force: true });
        if (hadOwner) fs.copyFileSync(ownerPath + '.test-backup', ownerPath);
        else fs.rmSync(ownerPath, { force: true });
        fs.rmSync(ownerPath + '.test-backup', { force: true });
        if (hadStranger) fs.copyFileSync(strangerPath + '.test-backup', strangerPath);
        else fs.rmSync(strangerPath, { force: true });
        fs.rmSync(strangerPath + '.test-backup', { force: true });
    }
});

// ====================================================
// === 5. ready.js: startup guilds + registration   ===
// ====================================================

test('_startupGuilds: a filled allowlist → only the cached allowlist guilds', async () => {
    const ready = require('../../src/bot/events/ready');
    const gA = { id: '111', name: 'A' };
    const gB = { id: '222', name: 'B' };
    const gC = { id: '333', name: 'C-foreign' };
    const client = { guilds: { cache: new Map([['111', gA], ['222', gB], ['333', gC]]) } };
    await withEnv('111,222', undefined, () => {
        const picked = ready._startupGuilds(client);
        assert.deepStrictEqual(picked.map((g) => g.id).sort(), ['111', '222'], 'guild 333 is not picked');
    });
});

test('_startupGuilds: an empty allowlist → every cached guild (open mode)', async () => {
    const ready = require('../../src/bot/events/ready');
    const gA = { id: '111', name: 'A' };
    const gB = { id: '222', name: 'B' };
    const client = { guilds: { cache: new Map([['111', gA], ['222', gB]]) } };
    await withEnv(undefined, undefined, () => {
        const picked = ready._startupGuilds(client);
        assert.strictEqual(picked.length, 2, 'open mode = every guild');
    });
});

test('_startupGuilds: an allowlisted guild that is not cached is skipped without throwing', async () => {
    const ready = require('../../src/bot/events/ready');
    const gA = { id: '111', name: 'A' };
    const client = { guilds: { cache: new Map([['111', gA]]) } };
    await withEnv('111,999', undefined, () => {
        const picked = ready._startupGuilds(client);
        assert.deepStrictEqual(picked.map((g) => g.id), ['111'], '999 (not invited yet) is skipped');
    });
});

test('ready.js static contract: command registration loops EVERY allowlisted guild', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bot', 'events', 'ready.js'), 'utf8');
    assert.match(src, /getAllowedGuildIds\(\)/, 'ready.js uses the allowlist');
    assert.match(src, /for \(const gid of allowed\)/, 'registration loops per allowlisted guild');
    assert.match(src, /guild\.commands\.set\(getCommands\(\)\)/, 'still registers per-guild (instant)');
    assert.ok(!/const GUILD_ID = process\.env\.GUILD_ID/.test(src), 'the old GUILD_ID variable is gone');
});
