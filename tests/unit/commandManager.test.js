/**
 * Unit tests for the v3.19.0 Command Manager.
 *
 * Verifies:
 *   - normalizeDisabledList: valid + dedupe, unknown command, protected
 *     command (/commands), non-array, >100 entries
 *   - Router gate: disabled commands are rejected with a clear ephemeral
 *     message; /commands itself is NEVER blocked by the gate (anti-lockout);
 *     enabled commands pass through the gate as usual
 *   - Discord ↔ web contract: normalizeDisabledList is used by the DASH API
 *     (see dashServer.test.js) — identical rules in both interfaces
 *
 * The test guild's config file is snapshotted & restored (dashServer.test.js pattern).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataConfigDir = path.join(__dirname, '..', '..', 'data', 'config');
const GUILD_ID = '999555999555999555';
const CONFIG_PATH = path.join(dataConfigDir, `${GUILD_ID}.json`);

// Snapshot & restore
const hadConfig = fs.existsSync(CONFIG_PATH);
const configBackup = hadConfig ? fs.readFileSync(CONFIG_PATH) : null;
if (hadConfig) fs.unlinkSync(CONFIG_PATH);

process.on('exit', () => {
    try {
        if (hadConfig) fs.writeFileSync(CONFIG_PATH, configBackup);
        else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    } catch (_) {}
});

const { getCommands } = require('../../src/commands/registry');
const commandsHandler = require('../../src/commands/commands');
const { normalizeDisabledList, getDisabledCommands, PROTECTED_COMMANDS } = commandsHandler;
const { getConfig, saveConfig } = require('../../src/data/configManager');
const routeCommand = require('../../src/commands');

// ====================================================
// === normalizeDisabledList (shared rules Discord & web) ===
// ====================================================

test('cmdmgr: normalize — valid + dedupe', () => {
    const result = normalizeDisabledList(['giveaway', 'poll', 'giveaway', 'warn']);
    assert.ok(result.ok);
    assert.deepStrictEqual(result.value, ['giveaway', 'poll', 'warn']);
});

test('cmdmgr: normalize — unknown command rejected', () => {
    const result = normalizeDisabledList(['giveaway', 'hocus-pocus']);
    assert.ok(!result.ok);
    assert.match(result.error, /hocus-pocus/);
});

test('cmdmgr: normalize — protected command (/commands) rejected', () => {
    const result = normalizeDisabledList(['commands']);
    assert.ok(!result.ok);
    assert.match(result.error, /cannot be disabled/);
});

test('cmdmgr: normalize — non-array rejected', () => {
    assert.ok(!normalizeDisabledList('giveaway').ok);
    assert.ok(!normalizeDisabledList(null).ok);
});

test('cmdmgr: normalize — more than 100 entries rejected', () => {
    const list = Array.from({ length: 101 }, (_, i) => `cmd-${i}`);
    // cmd-* are not registered — but check guard order: the limit is checked
    // BEFORE name lookup, so the error must be about the count, not unknown names.
    const result = normalizeDisabledList(list);
    assert.ok(!result.ok);
    assert.match(result.error, /100/);
});

test('cmdmgr: registry — /commands registered (92) & mapped to its own domain', () => {
    const cmds = getCommands();
    assert.strictEqual(cmds.length, 92);
    assert.ok(cmds.some((c) => c.name === 'commands'));
    assert.strictEqual(routeCommand.COMMAND_TO_DOMAIN.commands, 'commands');
});

// ====================================================
// === Router gate ===
// ====================================================

function makeMockInteraction({ commandName, isAdmin = true, guildId = GUILD_ID }) {
    const replies = [];
    return {
        isChatInputCommand: () => true,
        commandName,
        guildId,
        isRepliable: () => true,
        replied: false,
        deferred: false,
        member: {
            permissions: { has: () => isAdmin },
            roles: { cache: { has: () => false } }
        },
        reply: async (opts) => {
            replies.push({ type: 'reply', opts });
            return {};
        },
        editReply: async (opts) => {
            replies.push({ type: 'editReply', opts });
            return {};
        },
        _replies: replies
    };
}

function setDisabled(list) {
    const config = getConfig(GUILD_ID);
    config.disabledCommands = list;
    saveConfig(GUILD_ID, config);
}

test('cmdmgr: router — a disabled command is rejected with a clear message', async () => {
    setDisabled(['giveaway']);
    const interaction = makeMockInteraction({ commandName: 'giveaway' });
    await routeCommand(interaction);
    assert.strictEqual(interaction._replies.length, 1);
    assert.match(interaction._replies[0].opts.content, /disabled/);
    assert.match(interaction._replies[0].opts.content, /\/commands toggle/);
    assert.ok(interaction._replies[0].opts.flags, 'ephemeral');
});

test('cmdmgr: router — /commands itself is never blocked by the gate (anti-lockout)', async () => {
    // Simulate a "naughty" config: /commands present in the disabled list
    // (can happen if the file is edited by hand). The gate must still let it through.
    setDisabled(['giveaway', 'commands']);
    const interaction = makeMockInteraction({ commandName: 'commands' });
    try {
        await routeCommand(interaction);
    } catch (_) {
        // The /commands handler needs full interaction.options — throwing here
        // is fine; what matters is that NO "disabled" reply happened.
    }
    const blocked = interaction._replies.find((r) => /disabled/.test(r.opts?.content || ''));
    assert.ok(!blocked, '/commands must never be blocked by the gate');
});

test('cmdmgr: router — an enabled command passes the gate', async () => {
    setDisabled(['giveaway']);
    const interaction = makeMockInteraction({ commandName: 'backup-now' });
    try {
        await routeCommand(interaction);
    } catch (_) {
        // The backup-now handler needs interaction.options/client — throwing is fine.
    }
    const blocked = interaction._replies.find((r) => /disabled/.test(r.opts?.content || ''));
    assert.ok(!blocked, 'an enabled command must not get caught by the gate');
});

test('cmdmgr: router — interaction without guildId (DM) passes the gate', async () => {
    setDisabled(['giveaway']);
    const interaction = makeMockInteraction({ commandName: 'giveaway', guildId: null });
    try {
        await routeCommand(interaction);
    } catch (_) {
        // Handler throws because guild is undefined — fine, the gate did not crash.
    }
    const blocked = interaction._replies.find((r) => /disabled by/.test(r.opts?.content || ''));
    assert.ok(!blocked, 'DMs have no guild config — must not be blocked');
});

test('cmdmgr: getDisabledCommands — config without the field → empty array', () => {
    assert.deepStrictEqual(getDisabledCommands({}), []);
    assert.deepStrictEqual(getDisabledCommands(null), []);
    assert.deepStrictEqual(getDisabledCommands({ disabledCommands: ['poll'] }), ['poll']);
});

test('cmdmgr: PROTECTED_COMMANDS contains /commands', () => {
    assert.deepStrictEqual(PROTECTED_COMMANDS, ['commands']);
});
