/**
 * Unit tests v3.9.43 — Server Log (server events → server-log channel).
 *
 * What is guarded:
 *   A. logServerEvent (behavioral, configManager injected via require.cache):
 *      - channel not configured → false (silent skip, the auditLog contract)
 *      - successful send → true, the embed has the right title/color per type
 *      - field values >1024 truncated; >25 fields sliced to 25 (Discord limits)
 *      - channel.send throwing → false WITHOUT throwing (handlers stay safe)
 *   B. snip (behavioral): newline collapse, ellipsis truncation, empty.
 *   C. findAuditExecutor (behavioral): most recent entry with a matching
 *      target within the 60-second window; stale / other-target → not found.
 *   D. Event registration (static): index.js registers the 6 new events +
 *      the GuildBans intent is on (without it guildBanAdd/Remove NEVER fire).
 *   E. Guards per event file (static): single-guild GUILD_ID, bot skips,
 *      best-effort audit log fetches.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function readSrc(rel) {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// ====================================================
// === A. logServerEvent (behavioral) ===
// ====================================================

// configManager is mocked via require.cache — logServerEvent requires it
// LAZILY inside the function, so injecting before the call takes effect.
const configManagerPath = require.resolve('../../src/data/configManager');
const originalConfigExports = require.cache[configManagerPath]
    ? require.cache[configManagerPath].exports
    : undefined;

function injectConfig(channels) {
    require.cache[configManagerPath] = {
        id: configManagerPath,
        filename: configManagerPath,
        loaded: true,
        exports: { getConfig: () => ({ channels }) }
    };
}

function restoreConfig() {
    if (originalConfigExports) {
        require.cache[configManagerPath].exports = originalConfigExports;
    } else {
        delete require.cache[configManagerPath];
    }
}

function makeClientWithChannel(channelId, sendImpl) {
    const channel = { id: channelId, send: sendImpl };
    return {
        channels: {
            cache: new Map([[channelId, channel]]),
            fetch: async () => channel
        }
    };
}

test('v3.9.43 #13 serverLog: channel not configured → false (silent skip); unknown type → false', async () => {
    const { logServerEvent } = require('../../src/infra/serverLog');
    injectConfig({}); // no server-log
    try {
        const client = makeClientWithChannel('chan1', async () => { throw new Error('must not send'); });
        const r = await logServerEvent(client, { type: 'MSG_DELETE', guildId: 'g1', fields: [{ name: 'a', value: 'b' }] });
        assert.strictEqual(r, false, 'unconfigured must skip without sending');

        const bad = await logServerEvent(client, { type: 'DOES_NOT_EXIST', guildId: 'g1', fields: [] });
        assert.strictEqual(bad, false, 'unknown type → false');
    } finally {
        restoreConfig();
    }
});

test('v3.9.43 #14 serverLog: successful send → true; embed title + color match the type; fields delivered', async () => {
    const { logServerEvent } = require('../../src/infra/serverLog');
    injectConfig({ 'server-log': 'chan1' });
    try {
        const sent = [];
        const client = makeClientWithChannel('chan1', async payload => {
            sent.push(payload);
            return { id: 'x' };
        });
        const r = await logServerEvent(client, {
            type: 'MSG_DELETE',
            guildId: 'g1',
            fields: [
                { name: '✍️ Author', value: '<@123> (`user`)', inline: true },
                { name: '📄 Content', value: 'test message' }
            ],
            footer: 'User ID: 123'
        });
        assert.strictEqual(r, true);
        assert.strictEqual(sent.length, 1);
        const embed = sent[0].embeds[0];
        assert.strictEqual(embed.data.title, '🗑️ Message Deleted');
        assert.strictEqual(embed.data.color, 0xed4245);
        assert.strictEqual(embed.data.fields.length, 2);
        assert.strictEqual(embed.data.fields[0].name, '✍️ Author');
        assert.ok(embed.data.timestamp, 'timestamp set automatically');
    } finally {
        restoreConfig();
    }
});

test('v3.9.43 #15 serverLog: field values >1024 truncated; >25 fields sliced to 25 (Discord limits)', async () => {
    const { logServerEvent } = require('../../src/infra/serverLog');
    injectConfig({ 'server-log': 'chan1' });
    try {
        let captured = null;
        const client = makeClientWithChannel('chan1', async payload => {
            captured = payload;
            return {};
        });
        const bigVal = 'x'.repeat(3000);
        const manyFields = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, value: 'v' }));
        const r = await logServerEvent(client, {
            type: 'MSG_EDIT',
            guildId: 'g1',
            fields: [{ name: 'big', value: bigVal }, ...manyFields]
        });
        assert.strictEqual(r, true);
        const fields = captured.embeds[0].data.fields;
        assert.strictEqual(fields.length, 25, 'at most 25 fields');
        assert.ok(fields.every(f => f.value.length <= 1024), 'all values ≤ 1024');
        assert.ok(fields.every(f => f.name.length <= 256), 'all names ≤ 256');
        // The big value is truncated safely + excess fields dropped (not a crash).
        assert.ok(fields[0].value.length <= 1024 && fields[0].value.length > 1000, 'big value truncated safely');
    } finally {
        restoreConfig();
    }
});

test('v3.9.43 #16 serverLog: channel.send throws → false, does NOT re-throw (handlers stay safe)', async () => {
    const { logServerEvent } = require('../../src/infra/serverLog');
    injectConfig({ 'server-log': 'chan1' });
    try {
        const client = makeClientWithChannel('chan1', async () => {
            throw new Error('Missing Permissions');
        });
        const r = await logServerEvent(client, { type: 'BAN_ADD', guildId: 'g1', fields: [{ name: 'a', value: 'b' }] });
        assert.strictEqual(r, false, 'failed send → false, no throw');
    } finally {
        restoreConfig();
    }
});

// ====================================================
// === B. snip ===
// ====================================================

test('v3.9.43 #17 snip: newline collapse, ellipsis truncation, empty → placeholder', () => {
    const { snip } = require('../../src/infra/serverLog');
    assert.strictEqual(snip('line1\n\nline2  \n line3'), 'line1 line2 line3');
    const long = snip('a'.repeat(1500), 1000);
    assert.strictEqual(long.length, 1000);
    assert.ok(long.endsWith('…'));
    assert.strictEqual(snip(null), '');
    assert.strictEqual(snip('   '), '_(empty)_');
});

// ====================================================
// === C. findAuditExecutor ===
// ====================================================

test('v3.9.43 #18 findAuditExecutor: most recent + matching target + 60s window; stale/wrong target → null', () => {
    const { findAuditExecutor } = require('../../src/infra/serverLog');
    const now = Date.now();
    const entries = [
        { executorId: 'old-admin', targetId: 'victim', createdTimestamp: now - 120000 }, // stale
        { executorId: 'right-admin', targetId: 'victim', createdTimestamp: now - 3000 },
        { executorId: 'right-admin', targetId: 'someone-else', createdTimestamp: now - 1000 } // wrong target
    ];
    const r = findAuditExecutor({ entries, targetId: 'victim', now });
    assert.strictEqual(r.executorId, 'right-admin', 'must pick the fresh entry with the matching target');

    assert.strictEqual(
        findAuditExecutor({ entries: [], targetId: 'victim' }).executorId,
        null,
        'empty entries → null'
    );
    // Default window: entries older than 60 seconds are not this action's executor.
    assert.strictEqual(
        findAuditExecutor({ entries: [entries[0]], targetId: 'victim', now }).executorId,
        null,
        'stale entry → null'
    );
    // Channel filter (MessageDelete entries carry entry.extra.channel).
    const withChannel = [
        { executorId: 'admin-ch', targetId: 'victim', createdTimestamp: now - 1000, extra: { channel: { id: 'chA' } } },
        { executorId: 'admin-ch2', targetId: 'victim', createdTimestamp: now - 500, extra: { channel: { id: 'chB' } } }
    ];
    const rc = findAuditExecutor({ entries: withChannel, targetId: 'victim', channelId: 'chA', now });
    assert.strictEqual(rc.executorId, 'admin-ch', 'the channel filter must select the matching channel entry');
});

// ====================================================
// === D. Event registration + intent ===
// ====================================================

test('v3.9.43 #19 index.js: 6 server-log events registered + GuildBans intent on', () => {
    const src = readSrc('index.js');
    for (const ev of ['messageDelete', 'messageUpdate', 'messageBulkDelete', 'guildBanAdd', 'guildBanRemove', 'guildMemberUpdate']) {
        assert.ok(src.includes(`events/${ev}`), `event ${ev} must be required in index.js`);
    }
    // GuildBans is MANDATORY — without this intent guildBanAdd/guildBanRemove never fire.
    assert.ok(src.includes('GatewayIntentBits.GuildBans'), 'the GuildBans intent must be on');
});

// ====================================================
// === E. Guards per event file (static) ===
// ====================================================

test('v3.9.43 #20 event files: single-guild guard + bot skips + best-effort audit log', () => {
    // Single-guild guard in all new event files.
    for (const rel of [
        'src/bot/events/messageDelete.js',
        'src/bot/events/messageUpdate.js',
        'src/bot/events/messageBulkDelete.js',
        'src/bot/events/guildBanAdd.js',
        'src/bot/events/guildBanRemove.js',
        'src/bot/events/guildMemberUpdate.js'
    ]) {
        const src = readSrc(rel);
        assert.ok(src.includes('process.env.GUILD_ID'), `${rel}: the single-guild guard is mandatory (v3.9.26 pattern)`);
        assert.ok(src.includes('try'), `${rel}: the handler must use try/catch (event errors must not crash the bot)`);
    }

    // Bot message skips in message events (the log must not drown in the bot's own embeds).
    const del = readSrc('src/bot/events/messageDelete.js');
    assert.ok(del.includes('message.author?.bot'), 'messageDelete: skip bot messages');
    assert.ok(del.includes('AuditLogEvent.MessageDelete'), 'messageDelete: executor detection via the audit log');
    assert.ok(del.includes('findAuditExecutor('), 'messageDelete: uses findAuditExecutor');

    const upd = readSrc('src/bot/events/messageUpdate.js');
    assert.ok(upd.includes('oldC === newC'), 'messageUpdate: skip edits without content changes (pin/embed)');
    assert.ok(upd.includes('msg.url'), 'messageUpdate: include the message link');

    const memUpd = readSrc('src/bot/events/guildMemberUpdate.js');
    assert.ok(memUpd.includes('oldMember.roles.cache'), 'guildMemberUpdate: the role diff needs the cached old state');
    assert.ok(memUpd.includes('newMember.user?.bot'), 'guildMemberUpdate: skip bot members');

    const remove = readSrc('src/bot/events/guildMemberRemove.js');
    assert.ok(remove.includes('AuditLogEvent.MemberKick'), 'guildMemberRemove: manual kicks detected via the audit log');
    assert.ok(remove.includes('logServerEvent('), 'guildMemberRemove: log the leave');

    const add = readSrc('src/bot/events/guildMemberAdd.js');
    assert.ok(add.includes('logServerEvent('), 'guildMemberAdd: log the join');
});

test('v3.9.43 #21 server-log channel contract: set-channel accepts the type, serverLog reads the right config', () => {
    const src = readSrc('src/infra/serverLog.js');
    assert.ok(src.includes("config.channels['server-log']"), 'serverLog must read channels[server-log] — consistent with set-channel');
    assert.ok(src.includes("config.channels && config.channels['server-log']"), 'channel access must be null-safe');

    // helpCatalog advertises how to enable the server log.
    const cat = readSrc('src/ui/helpCatalog.js');
    assert.ok(cat.includes('set-channel server-log'), 'helpCatalog must show how to set the server-log channel');
});
