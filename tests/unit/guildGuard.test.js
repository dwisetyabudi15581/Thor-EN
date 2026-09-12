/**
 * Unit tests v3.12.0 — ONE GUILD ID (no more confusion).
 *
 * What these tests prove:
 *   1. src/infra/guild.js — getPrimaryGuildId(): the GUILD_ID from .env
 *      (trimmed) or null. There is NO multi-server allowlist anymore
 *      (the v3.11.0 list is removed).
 *   2. isGuildAllowed(): empty GUILD_ID = public mode (every guild —
 *      unchanged v3.10.0/v3.11.0 open-mode behavior), null/DM = false,
 *      GUILD_ID set = only that guild.
 *   3. Event handler guards: guildMemberAdd/Remove from another guild are
 *      ignored + LOGGED mentioning GUILD_ID (why); interactionCreate from
 *      a foreign guild is never routed.
 *   4. The configManager legacy claim gate: GUILD_ID set → another guild
 *      cannot "steal" the old config.json; the matching guild can claim.
 *   5. ready.js: startup picks the guild from GUILD_ID (_startupGuilds) +
 *      static registration contract (single guild instant / global public).
 *   6. ANTI-CONFUSION PINS: ALLOWED_GUILD_IDS must never reappear in
 *      src/, .env.example, or the exported guild.js contract.
 *
 * Env is snapshotted & restored in finally() so these tests never leak
 * into other tests (the welcomeDiagnostics.test.js pattern).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { getPrimaryGuildId, isGuildAllowed, resolveGuildId } = require('../../src/infra/guild');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const LEGACY = path.join(DATA_DIR, 'config.json');

/** Snapshot the env, restore it after the test. */
async function withEnv(guild, fn) {
    const savedGuild = process.env.GUILD_ID;
    if (guild === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = guild;
    try {
        await fn();
    } finally {
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
// === 1. getPrimaryGuildId() — ONE variable         ===
// ====================================================

test('getPrimaryGuildId: empty GUILD_ID → null (public mode)', async () => {
    await withEnv(undefined, () => {
        assert.strictEqual(getPrimaryGuildId(), null, 'no GUILD_ID = public mode');
    });
});

test('getPrimaryGuildId: GUILD_ID set → its value (trimmed)', async () => {
    await withEnv('  guild_main  ', () => {
        assert.strictEqual(getPrimaryGuildId(), 'guild_main');
    });
});

test('getPrimaryGuildId: whitespace-only GUILD_ID → null', async () => {
    await withEnv('   ', () => {
        assert.strictEqual(getPrimaryGuildId(), null, 'whitespace-only counts as empty');
    });
});

// ====================================================
// === 2. Pure isGuildAllowed() guard                ===
// ====================================================

test('isGuildAllowed: empty GUILD_ID (public mode) → every guild allowed', async () => {
    await withEnv(undefined, () => {
        assert.strictEqual(isGuildAllowed('111'), true);
        assert.strictEqual(isGuildAllowed('foreign_server'), true, 'public mode does not filter');
    });
});

test('isGuildAllowed: GUILD_ID set → matching guild true, other guilds false', async () => {
    await withEnv('guild_main', () => {
        assert.strictEqual(isGuildAllowed('guild_main'), true);
        assert.strictEqual(isGuildAllowed('guild_other'), false, 'guilds outside GUILD_ID are blocked');
    });
});

test('isGuildAllowed: null / undefined (DM) → false', async () => {
    await withEnv('guild_main', () => {
        assert.strictEqual(isGuildAllowed(null), false);
        assert.strictEqual(isGuildAllowed(undefined), false);
    });
});

test('resolveGuildId: v3.10.0 contract unchanged by v3.12.0', () => {
    assert.strictEqual(resolveGuildId({ guildId: '111', guild: { id: '999' } }), '111');
    assert.strictEqual(resolveGuildId({ guild: { id: '999' } }), '999');
    assert.strictEqual(resolveGuildId(null), null);
});

// ====================================================
// === 3. Event handler guards use GUILD_ID          ===
// ====================================================

test('guildMemberAdd guard: a join from another guild is ignored + logged (mentions GUILD_ID)', async () => {
    await withEnv('guild_main', async () => {
        const ev = require('../../src/bot/events/guildMemberAdd');
        const member = { guild: { id: 'guild_foreign' } };
        const rows = await captureConsole(() => ev.execute(member));
        assert.ok(
            rows.some((r) => r[0] === 'warn' && /guild_foreign/.test(r[1]) && /GUILD_ID/.test(r[1])),
            'the skip must be visible + mention GUILD_ID (the v3.9.48 pattern)'
        );
    });
});

test('guildMemberRemove guard: a leave from another guild is ignored + logged (mentions GUILD_ID)', async () => {
    await withEnv('guild_main', async () => {
        const ev = require('../../src/bot/events/guildMemberRemove');
        const member = { guild: { id: 'guild_foreign' } };
        const rows = await captureConsole(() => ev.execute(member));
        assert.ok(
            rows.some((r) => r[0] === 'warn' && /guild_foreign/.test(r[1]) && /GUILD_ID/.test(r[1])),
            'the goodbye skip must be visible + mention GUILD_ID'
        );
    });
});

test('interactionCreate guard: an interaction from a foreign guild is never routed', async () => {
    await withEnv('guild_main', async () => {
        const ev = require('../../src/bot/events/interactionCreate');
        let routed = false;
        const interaction = {
            guildId: 'guild_foreign',
            isChatInputCommand() {
                routed = true; // if the guard leaks, this definitely runs
                return true;
            }
        };
        await captureConsole(() => ev.execute(interaction));
        assert.strictEqual(routed, false, 'an interaction from a foreign guild must be blocked before routing');
    });
});

// ====================================================
// === 4. The legacy claim gate uses GUILD_ID        ===
// ====================================================

test('v3.12.0 legacy claim: GUILD_ID set — a foreign guild gets DEFAULTS, the matching guild claims', async () => {
    // Sandbox: snapshot the old config state (if any), then plant a fresh legacy.
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const hadLegacy = fs.existsSync(LEGACY);
    if (hadLegacy) fs.copyFileSync(LEGACY, LEGACY + '.test-backup');
    const hadMigrated = fs.existsSync(LEGACY + '.migrated');
    if (hadMigrated) fs.copyFileSync(LEGACY + '.migrated', LEGACY + '.migrated.test-backup');
    const ownerPath = path.join(CONFIG_DIR, 'guild_owner_312.json');
    const strangerPath = path.join(CONFIG_DIR, 'guild_stranger_312.json');
    const hadOwner = fs.existsSync(ownerPath);
    const hadStranger = fs.existsSync(strangerPath);
    if (hadOwner) fs.copyFileSync(ownerPath, ownerPath + '.test-backup');
    if (hadStranger) fs.copyFileSync(strangerPath, strangerPath + '.test-backup');

    try {
        fs.writeFileSync(LEGACY, JSON.stringify({ channels: { welcome: 'ch_legacy_312' } }, null, 2));
        fs.rmSync(ownerPath, { force: true });
        fs.rmSync(strangerPath, { force: true });
        fs.rmSync(LEGACY + '.migrated', { force: true });
        // Reset the in-process flag so the claim can be tested from scratch.
        const cm = require('../../src/data/configManager');
        if (typeof cm._resetLegacyClaimForTest === 'function') cm._resetLegacyClaimForTest();

        await withEnv('guild_owner_312', async () => {
            // 1) The foreign guild calls first — it must NOT steal the legacy.
            const strangerConfig = cm.getConfig('guild_stranger_312');
            assert.notStrictEqual(
                strangerConfig.channels.welcome,
                'ch_legacy_312',
                'the foreign guild gets pure DEFAULTS, not the legacy config'
            );
            assert.ok(fs.existsSync(LEGACY), 'the legacy file is still intact (not claimed yet)');

            // 2) The guild matching GUILD_ID claims the legacy.
            const ownerConfig = cm.getConfig('guild_owner_312');
            assert.strictEqual(
                ownerConfig.channels.welcome,
                'ch_legacy_312',
                'the GUILD_ID guild claims the legacy config'
            );
            assert.ok(fs.existsSync(ownerPath), 'config/guild_owner_312.json is created');
            assert.ok(fs.existsSync(LEGACY + '.migrated'), 'legacy renamed to .migrated (audit trail)');
            assert.ok(!fs.existsSync(LEGACY), 'the original legacy file has moved');
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
// === 5. ready.js: startup guild + registration     ===
// ====================================================

test('_startupGuilds: GUILD_ID set → only that cached guild', async () => {
    const ready = require('../../src/bot/events/ready');
    const gA = { id: 'guild_main', name: 'A' };
    const gB = { id: 'guild_other', name: 'B' };
    const client = { guilds: { cache: new Map([['guild_main', gA], ['guild_other', gB]]) } };
    await withEnv('guild_main', () => {
        const picked = ready._startupGuilds(client);
        assert.deepStrictEqual(picked.map((g) => g.id), ['guild_main'], 'the other guild is not included');
    });
});

test('_startupGuilds: empty GUILD_ID → every cached guild (public mode)', async () => {
    const ready = require('../../src/bot/events/ready');
    const gA = { id: '111', name: 'A' };
    const gB = { id: '222', name: 'B' };
    const client = { guilds: { cache: new Map([['111', gA], ['222', gB]]) } };
    await withEnv(undefined, () => {
        const picked = ready._startupGuilds(client);
        assert.strictEqual(picked.length, 2, 'public mode = every guild');
    });
});

test('_startupGuilds: a GUILD_ID that is not cached (bot not invited) → [] without throwing', async () => {
    const ready = require('../../src/bot/events/ready');
    const gA = { id: '111', name: 'A' };
    const client = { guilds: { cache: new Map([['111', gA]]) } };
    await withEnv('999', () => {
        const picked = ready._startupGuilds(client);
        assert.deepStrictEqual(picked, [], '999 (not invited) is skipped');
    });
});

test('ready.js static contract: single guild instant + global in public mode', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bot', 'events', 'ready.js'), 'utf8');
    assert.match(src, /getPrimaryGuildId\(\)/, 'ready.js uses the single GUILD_ID');
    assert.match(src, /guild\.commands\.set\(getCommands\(\)\)/, 'single-server mode: per-guild registration (instant)');
    assert.match(src, /client\.application\.commands\.set\(getCommands\(\)\)/, 'public mode: global commands');
    assert.ok(!/ALLOWED_GUILD_IDS/.test(src), 'no allowlist references left');
    assert.ok(!/getAllowedGuildIds/.test(src), 'the old allowlist function is not used');
});

// ====================================================
// === 6. ANTI-CONFUSION PINS: no allowlist comeback ===
// ====================================================

test('PIN v3.12.0: ALLOWED_GUILD_IDS must not appear anywhere in src/', () => {
    const srcRoot = path.join(__dirname, '..', '..', 'src');
    let violations = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) {
                const content = fs.readFileSync(full, 'utf8');
                if (content.includes('ALLOWED_GUILD_IDS') || content.includes('getAllowedGuildIds')) {
                    violations.push(path.relative(srcRoot, full));
                }
            }
        }
    };
    walk(srcRoot);
    assert.deepStrictEqual(violations, [], 'the v3.11.0 allowlist must be fully gone from src/');
});

test('PIN v3.12.0: .env.example only has GUILD_ID + documents public mode', () => {
    const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
    assert.ok(env.includes('GUILD_ID='), 'the GUILD_ID variable exists');
    assert.ok(/public mode/i.test(env), 'public mode (Dyno-style) is documented');
    assert.ok(!env.includes('ALLOWED_GUILD_IDS'), 'the env example does not mention the old allowlist');
    assert.strictEqual((env.match(/^GUILD_ID=/gm) || []).length, 1, 'exactly one active GUILD_ID variable');
});

test('PIN v3.12.0: guild.js exports exactly resolveGuildId, getPrimaryGuildId, isGuildAllowed', () => {
    const guild = require('../../src/infra/guild');
    assert.deepStrictEqual(
        Object.keys(guild).sort(),
        ['getPrimaryGuildId', 'isGuildAllowed', 'resolveGuildId'],
        'the v3.12.0 export contract (no allowlist)'
    );
});
