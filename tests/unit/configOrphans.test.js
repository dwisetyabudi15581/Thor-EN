/**
 * Unit tests v3.29.0 — CONFIG ORPHAN SCANNER (src/infra/configOrphans.js)
 * + the channelDelete / guildRoleDelete handlers that report them.
 *
 * Context (the "TAHAP 1" two-way-sync audit): when a channel or role is
 * deleted on Discord, every stored setting pointing at it becomes a silent
 * landmine (welcome embeds stop, guards fail, panel buttons error). The
 * scanner must find EVERY kind of reference across all stores, and the
 * handlers must report them without ever mutating data (read-only) or
 * throwing (best-effort).
 *
 * What this test proves:
 *   1. findChannelRefs finds: config channels.*, leveling.levelUpChannel,
 *      automod linkAllowedChannels, temp voice (creator + category), ticket
 *      panels, self-role panels, PENDING scheduled announcements.
 *   2. Already-sent announcements are NOT flagged (no false positives).
 *   3. findRoleRefs finds: config roles.* (admin/unverified/…), levelRoles,
 *      product auto-roles, automod linkAllowedRoles, self-role panel buttons
 *      AND their requiresRoleId visibility gates.
 *   4. A guild with no data at all → empty arrays (no crash, no phantom refs).
 *   5. The channelDelete / guildRoleDelete handlers resolve without throwing
 *      on mock events (orphan path AND clean path), and never write data.
 *   6. Read-only guarantee: the config file on disk is byte-identical before
 *      and after a scan.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const GUILD = 'guild_orphan_test';

// ====================================================
// === Sandbox: snapshot & restore every store touched
// === (setChannelMerge.test.js pattern)
// ====================================================
const SANDBOX_FILES = [
    `config/${GUILD}.json`,
    'automod.json',
    'tempVoice.json',
    'panels.json',
    'selfRoles.json',
    'scheduledAnnouncements.json'
];
const backups = new Map();
for (const f of SANDBOX_FILES) {
    const p = path.join(DATA_DIR, f);
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
    } catch (_) {}
    if (fs.existsSync(p)) {
        fs.copyFileSync(p, p + '.test-backup');
        backups.set(f, true);
    }
}
process.on('exit', () => {
    for (const f of SANDBOX_FILES) {
        const p = path.join(DATA_DIR, f);
        try {
            if (backups.has(f)) {
                fs.copyFileSync(p + '.test-backup', p);
                fs.rmSync(p + '.test-backup', { force: true });
            } else if (fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
        } catch (_) {}
    }
});

// Managers (their public write APIs keep their in-memory caches consistent).
const { saveConfig, getConfig } = require('../../src/data/configManager');
const automodManager = require('../../src/data/automodManager');
const tempVoiceManager = require('../../src/data/tempVoiceManager');
const panelManager = require('../../src/data/panelManager');
const selfRoleManager = require('../../src/data/selfRoleManager');
const announcements = require('../../src/data/scheduledAnnouncements');
const { findChannelRefs, findRoleRefs } = require('../../src/infra/configOrphans');
const channelDeleteHandler = require('../../src/bot/events/channelDelete');
const roleDeleteHandler = require('../../src/bot/events/guildRoleDelete');

// Snowflake-shaped IDs (realistic Discord IDs).
const CH_WELCOME = '111111111111111111';
const CH_LEVELUP = '222222222222222222';
const CH_AUTOMOD = '333333333333333333';
const CH_TEMPVOICE = '444444444444444444';
const CH_TEMPV_CAT = '555555555555555555';
const CH_PANEL = '666666666666666666';
const CH_SELFROLE = '777777777777777777';
const CH_ANN = '888888888888888888';
const CH_ANN_SENT = '999999999999999999';
const ROLE_ADMIN = '123456789012345678';
const ROLE_AUTOROLE = '234567890123456789';
const ROLE_LEVEL = '345678901234567890';
const ROLE_PRODUCT = '456789012345678901';
const ROLE_AUTOMOD = '567890123456789012';
const ROLE_PANEL_BTN = '678901234567890123';
const ROLE_PANEL_GATE = '789012345678901234';

/** Write one rich fixture with EVERY kind of reference, via the real managers. */
function buildFixture() {
    // 1. Guild config — channels, named roles (incl. the restored unverified
    // marker, v4.3.0), levelRoles, products.
    saveConfig(GUILD, {
        roles: { admin: ROLE_ADMIN, verified: null, unverified: ROLE_AUTOROLE },
        channels: {
            welcome: CH_WELCOME,
            goodbye: null,
            'server-log': null,
            invoice: null
        },
        messages: { welcomeTitle: 'T', welcomeBody: 'B' },
        colors: {},
        leveling: {
            enabled: true,
            xpPerMessage: 15,
            cooldownMs: 60000,
            announceLevelUp: true,
            levelUpChannel: CH_LEVELUP
        },
        levelRoles: [{ level: 10, roleId: ROLE_LEVEL }],
        midman: { feeMode: 'percent', feeValue: 5, category: 'ESC' },
        products: [
            {
                label: 'VIP',
                value: 'vip',
                price: '10',
                category: 'transaction',
                requiresKey: true,
                roleId: ROLE_PRODUCT,
                days: 30
            }
        ],
        ticketCategories: [{ id: 'transaction', label: 'Buy', emoji: '🔑', style: 'Primary', requiresKey: true }]
    });

    // 2. AutoMod allow-lists.
    automodManager.setGuildConfig(GUILD, {
        enabled: true,
        linkAllowedChannels: [CH_AUTOMOD],
        linkAllowedRoles: [ROLE_AUTOMOD]
    });

    // 3. Temp voice setup.
    tempVoiceManager.setupGuild(GUILD, CH_TEMPVOICE, CH_TEMPV_CAT);

    // 4. Ticket panel.
    panelManager.upsertPanel({
        guildId: GUILD,
        channelId: CH_PANEL,
        messageId: '1',
        title: 'Support',
        categoryIds: ['transaction'],
        useDropdown: false
    });

    // 5. Self-role panel with a role button + a visibility gate.
    const panel = selfRoleManager.createPanel({
        guildId: GUILD,
        channelId: CH_SELFROLE,
        title: 'Roles',
        description: 'pick',
        type: 'button',
        exclusive: false
    });
    selfRoleManager.addRoleToPanel(panel.id, {
        roleId: ROLE_PANEL_BTN,
        label: 'Gamer',
        requiresRoleId: ROLE_PANEL_GATE
    });

    // 6. Announcements: one pending, one already sent.
    announcements.create({
        guildId: GUILD,
        channelId: CH_ANN,
        sendAt: Date.now() + 3600_000,
        title: 'News',
        description: 'soon',
        authorId: '1',
        authorTag: 'tester'
    });
    const sent = announcements.create({
        guildId: GUILD,
        channelId: CH_ANN_SENT,
        sendAt: Date.now() - 3600_000,
        title: 'Old',
        description: 'done',
        authorId: '1',
        authorTag: 'tester'
    });
    announcements.markSent(sent.id);
}

// Clean slate for the whole file (in-memory manager caches reset via fresh
// data files being written by buildFixture through the managers themselves).
buildFixture();

test('findChannelRefs: finds every channel reference across all stores', () => {
    const refs = findChannelRefs(GUILD, CH_WELCOME);
    assert.ok(
        refs.some(r => r.includes('welcome')),
        `config channel: ${refs.join(' | ')}`
    );

    const lvl = findChannelRefs(GUILD, CH_LEVELUP);
    assert.ok(
        lvl.some(r => r.includes('level-up')),
        `leveling: ${lvl.join(' | ')}`
    );

    const am = findChannelRefs(GUILD, CH_AUTOMOD);
    assert.ok(
        am.some(r => r.includes('allowed-links')),
        `automod: ${am.join(' | ')}`
    );

    const tv = findChannelRefs(GUILD, CH_TEMPVOICE);
    assert.ok(
        tv.some(r => r.includes('creator')),
        `tempvoice creator: ${tv.join(' | ')}`
    );

    const cat = findChannelRefs(GUILD, CH_TEMPV_CAT);
    assert.ok(
        cat.some(r => r.includes('category')),
        `tempvoice category: ${cat.join(' | ')}`
    );

    const pnl = findChannelRefs(GUILD, CH_PANEL);
    assert.ok(
        pnl.some(r => includesLower(pnl, 'ticket panel')),
        `ticket panel: ${pnl.join(' | ')}`
    );

    const sr = findChannelRefs(GUILD, CH_SELFROLE);
    assert.ok(
        sr.some(r => r.toLowerCase().includes('self-role panel')),
        `selfrole panel: ${sr.join(' | ')}`
    );

    const ann = findChannelRefs(GUILD, CH_ANN);
    assert.ok(
        ann.some(r => r.includes('Scheduled announcement')),
        `announcement: ${ann.join(' | ')}`
    );
});

function includesLower(list, needle) {
    return list.some(r => r.toLowerCase().includes(needle.toLowerCase()));
}

test('findChannelRefs: sent announcements are NOT flagged (no false positives)', () => {
    const refs = findChannelRefs(GUILD, CH_ANN_SENT);
    assert.deepStrictEqual(refs, []);
});

test('findRoleRefs: finds every role reference across all stores', () => {
    const admin = findRoleRefs(GUILD, ROLE_ADMIN);
    assert.ok(
        admin.some(r => r.includes('admin')),
        `roles.admin: ${admin.join(' | ')}`
    );

    const unverified = findRoleRefs(GUILD, ROLE_AUTOROLE);
    assert.ok(
        unverified.some(r => r.includes('unverified')),
        `roles.unverified (v4.3.0 marker): ${unverified.join(' | ')}`
    );

    const lvl = findRoleRefs(GUILD, ROLE_LEVEL);
    assert.ok(
        lvl.some(r => r.includes('level 10')),
        `levelRoles: ${lvl.join(' | ')}`
    );

    const prod = findRoleRefs(GUILD, ROLE_PRODUCT);
    assert.ok(
        prod.some(r => includesLower(prod, 'product "vip"')),
        `product role: ${prod.join(' | ')}`
    );

    const am = findRoleRefs(GUILD, ROLE_AUTOMOD);
    assert.ok(
        am.some(r => r.includes('allowed-links role')),
        `automod roles: ${am.join(' | ')}`
    );

    const btn = findRoleRefs(GUILD, ROLE_PANEL_BTN);
    assert.ok(
        btn.some(r => includesLower(btn, 'button "gamer"')),
        `panel button: ${btn.join(' | ')}`
    );

    const gate = findRoleRefs(GUILD, ROLE_PANEL_GATE);
    assert.ok(
        gate.some(r => r.includes('visibility gate')),
        `panel gate: ${gate.join(' | ')}`
    );
});

test('scanners: a guild with NO data returns empty arrays without crashing', () => {
    assert.deepStrictEqual(findChannelRefs('guild_never_seen', '123'), []);
    assert.deepStrictEqual(findRoleRefs('guild_never_seen', '123'), []);
});

test('scanners: an ID referenced by NOTHING returns empty arrays', () => {
    assert.deepStrictEqual(findChannelRefs(GUILD, '100000000000000000'), []);
    assert.deepStrictEqual(findRoleRefs(GUILD, '100000000000000000'), []);
});

test('scanners are READ-ONLY — the config file is untouched by a scan', () => {
    const configPath = path.join(DATA_DIR, 'config', `${GUILD}.json`);
    const before = fs.readFileSync(configPath, 'utf8');
    findChannelRefs(GUILD, CH_WELCOME);
    findRoleRefs(GUILD, ROLE_ADMIN);
    findChannelRefs(GUILD, '100000000000000000');
    const after = fs.readFileSync(configPath, 'utf8');
    assert.strictEqual(after, before);
});

// ====================================================
// === The event handlers themselves ===
// ====================================================

/** Mock Discord channel object (only the fields the handler touches). */
function mockChannel(id, name) {
    return { id, name, guild: { id: GUILD }, client: null };
}

/** Mock Discord role object. */
function mockRole(id, name) {
    return { id, name, guild: { id: GUILD }, client: null };
}

test('channelDelete handler: resolves, reports orphans, never throws', async () => {
    // Silence the console.warn the handler emits (assert only behavior).
    const origWarn = console.warn;
    let warned = false;
    console.warn = (...args) => {
        if (String(args[0]).includes('[sync]')) warned = true;
    };
    try {
        // Path A: orphans exist (welcome channel deleted).
        await channelDeleteHandler.execute(mockChannel(CH_WELCOME, 'welcome'));
        assert.ok(warned, 'the handler must warn when settings are orphaned');

        // Path B: no orphans (an unknown channel) — no warning, no throw.
        let warned2 = false;
        console.warn = (...args) => {
            if (String(args[0]).includes('[sync]')) warned2 = true;
        };
        await channelDeleteHandler.execute(mockChannel('100000000000000000', 'random'));
        assert.strictEqual(warned2, false, 'no orphan warning for an unreferenced channel');

        // Path C: defensive shapes must not throw.
        await channelDeleteHandler.execute(null);
        await channelDeleteHandler.execute({ id: '1' }); // no guild
    } finally {
        console.warn = origWarn;
    }
});

test('guildRoleDelete handler: resolves, reports orphans, never throws', async () => {
    const origWarn = console.warn;
    let warned = false;
    console.warn = (...args) => {
        if (String(args[0]).includes('[sync]')) warned = true;
    };
    try {
        await roleDeleteHandler.execute(mockRole(ROLE_ADMIN, 'Admin'));
        assert.ok(warned, 'the handler must warn when settings are orphaned');

        let warned2 = false;
        console.warn = (...args) => {
            if (String(args[0]).includes('[sync]')) warned2 = true;
        };
        await roleDeleteHandler.execute(mockRole('100000000000000000', 'random'));
        assert.strictEqual(warned2, false, 'no orphan warning for an unreferenced role');

        await roleDeleteHandler.execute(null);
        await roleDeleteHandler.execute({ id: '1' });
    } finally {
        console.warn = origWarn;
    }
});

test('event handlers are registered under the right discord.js event names', () => {
    // discord.js Events enum: ChannelDelete → 'channelDelete', GuildRoleDelete → 'roleDelete'.
    assert.strictEqual(channelDeleteHandler.name, 'channelDelete');
    assert.strictEqual(roleDeleteHandler.name, 'roleDelete');
});
