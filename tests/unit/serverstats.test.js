/**
 * Unit tests for v3.9.51 — LIVE SERVER STATS counter channels + Total Revenue
 * removal from /stats.
 *
 * User request: "I want a live server-stats feature like the ServerStats bots"
 * (channel names as auto-updating counters) — plus "just delete the total
 * revenue feature".
 *
 * Covered end-to-end via the REAL modules with stubs:
 *   1. serverstatsManager: pure builders (counter names, live values),
 *      persistence round-trip, refresh change-detection, the per-channel
 *      rename cooldown (+ force bypass), missing-channel warning +
 *      auto-disable when ALL counters are gone, dirty-driven scheduler tick
 *      + the 5-min catch-up.
 *   2. /serverstats setup: creates the category + 5 counter channels with
 *      the LIVE values, @everyone Connect denied, category at the top,
 *      config saved; refuses when already set up; auto-heals when all old
 *      channels are gone; refuses cleanly without bot permissions.
 *   3. /serverstats remove: deletes every channel + the category, clears
 *      the config.
 *   4. /serverstats refresh: forces one immediate update.
 *   5. Event wiring: guildMemberAdd marks the stats dirty; channelCreate
 *      marks them dirty.
 *   6. Contracts: registry (92 commands, 3 subcommands), router mapping +
 *      NOT public, FILES_TO_BACKUP, help catalog line + the 5800 budget,
 *      index.js registers the 4 new event files.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SERVERSTATS_PATH = path.join(DATA_DIR, 'serverstats.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const GUILD_ID = 'test_guild_serverstats';

const manager = require('../../src/data/serverstatsManager');
const serverstatsCommand = require('../../src/commands/serverstats');

/** Clean the persisted config + all in-memory state (before/after each use). */
function resetManager(cleanFile = true) {
    manager._resetForTests();
    if (cleanFile && fs.existsSync(SERVERSTATS_PATH)) {
        try {
            fs.unlinkSync(SERVERSTATS_PATH);
        } catch (_) {}
    }
    manager._resetForTests();
}

/**
 * Stub counter channel — records setName + delete calls (like the real
 * GuildChannel).
 */
function makeCounterChannel(id, name) {
    const calls = [];
    const ch = {
        id,
        name,
        setName: async (newName, reason) => {
            calls.push({ newName, reason });
            ch.name = newName;
            return ch;
        },
        delete: async () => {
            ch.__deleted = true;
            return ch;
        }
    };
    ch.__calls = calls;
    return ch;
}

/**
 * Stub guild shaped like what the manager + the command touch.
 * Live values are fixed: memberCount 5, 2 bots, 2 boosts, 9 roles, 7 channels.
 */
function makeStubGuild({ withCounters = false, botPermissions = true } = {}) {
    let idSeq = 0;
    const channelsCache = new Map();
    // 7 pre-existing channels (the "Channels" counter counts the cache size).
    for (let i = 0; i < 7; i++) {
        channelsCache.set(`pre_${i}`, makeCounterChannel(`pre_${i}`, `pre-${i}`));
    }
    const rolesCache = new Map();
    for (let i = 0; i < 9; i++) {
        rolesCache.set(`role_${i}`, { id: `role_${i}`, name: `Role${i}` });
    }
    const membersCache = new Map();
    for (let i = 0; i < 3; i++) {
        membersCache.set(`human_${i}`, { id: `human_${i}`, user: { id: `human_${i}`, bot: false } });
    }
    for (let i = 0; i < 2; i++) {
        membersCache.set(`bot_${i}`, { id: `bot_${i}`, user: { id: `bot_${i}`, bot: true } });
    }

    const created = [];
    const guild = {
        id: GUILD_ID,
        name: 'Counter Test Server',
        memberCount: 5,
        premiumSubscriptionCount: 2,
        channels: {
            cache: channelsCache,
            create: async opts => {
                const ch = makeCounterChannel(`ss_${++idSeq}`, opts.name);
                Object.assign(ch, { __opts: opts });
                created.push(ch);
                channelsCache.set(ch.id, ch);
                return ch;
            }
        },
        roles: {
            cache: rolesCache,
            everyone: { id: 'everyone_role' }
        },
        members: {
            cache: membersCache,
            me: { permissions: { has: () => botPermissions } }
        }
    };
    guild.__created = created;

    if (withCounters) {
        // A fake category in the cache so /serverstats remove can delete it.
        const category = makeCounterChannel('cat_1', '📊 SERVER STATS');
        channelsCache.set(category.id, category);

        const counters = {};
        for (const def of manager.COUNTER_DEFS) {
            const ch = makeCounterChannel(`cnt_${def.type}`, 'placeholder');
            channelsCache.set(ch.id, ch);
            counters[def.type] = ch.id;
        }
        // Counter names use the FINAL cache state (all channels registered
        // first — mirrors the change-detection expectations at refresh time).
        for (const def of manager.COUNTER_DEFS) {
            const ch = channelsCache.get(counters[def.type]);
            ch.name = manager.buildCounterName(def.type, manager.computeCounterValue(guild, def.type));
        }
        guild.__counterChannels = manager.COUNTER_DEFS.map(d => channelsCache.get(counters[d.type]));
        guild.__categoryChannel = category;
        manager.saveConfig({
            guildId: GUILD_ID,
            categoryId: category.id,
            counters,
            enabled: true,
            updatedAt: Date.now()
        });
    }
    return guild;
}

/** Stub interaction for the /serverstats command. `booleanOptions` feeds
 *  getBoolean (the v3.9.53 counter-selection flags — undefined = default on). */
function makeStubInteraction(sub, guild, booleanOptions = {}) {
    const replies = [];
    const interaction = {
        commandName: 'serverstats',
        options: {
            getSubcommand: () => sub,
            getBoolean: name => booleanOptions[name]
        },
        deferReply: async () => {},
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        guild,
        user: { id: 'admin_user', tag: 'Admin#0001' },
        client: { channels: { cache: new Map() } }
    };
    interaction.__replies = replies;
    return interaction;
}

test('pure builders: counter names + live values from the guild object', () => {
    resetManager();
    const guild = makeStubGuild();

    assert.deepStrictEqual(
        manager.COUNTER_DEFS.map(d => manager.buildCounterName(d.type, manager.computeCounterValue(guild, d.type))),
        ['👥 Members: 5', '🤖 Bots: 2', '🚀 Boosts: 2', '🎭 Roles: 9', '📺 Channels: 7']
    );
    // Unknown type → plain number (defensive).
    assert.strictEqual(manager.buildCounterName('nonsense', 3), '3');
    // Null guild → zeros (never throws).
    assert.strictEqual(manager.computeCounterValue(null, 'members'), 0);
    assert.strictEqual(manager.computeCounterValue(guild, 'unknown'), 0);
});

test('persistence: saveConfig → getConfig round-trip, isEnabled, clearConfig, reload', () => {
    resetManager();
    assert.strictEqual(manager.isEnabled(), false, 'not set up initially');

    manager.saveConfig({ guildId: GUILD_ID, categoryId: 'cat_1', counters: { members: 'ch_1' }, enabled: true, updatedAt: 1 });
    assert.strictEqual(manager.isEnabled(), true);
    assert.strictEqual(manager.getConfig().counters.members, 'ch_1');
    assert.ok(fs.existsSync(SERVERSTATS_PATH), 'config persisted to data/serverstats.json');

    // reload() re-reads from disk (the restore-backup staleness fix).
    fs.writeFileSync(SERVERSTATS_PATH, JSON.stringify({ guildId: GUILD_ID, categoryId: 'cat_2', counters: { members: 'ch_9' }, enabled: true }));
    const cfg = manager.reload();
    assert.strictEqual(cfg.counters.members, 'ch_9', 'reload drops the in-memory cache');

    manager.clearConfig();
    assert.strictEqual(manager.isEnabled(), false);
    assert.ok(!fs.existsSync(SERVERSTATS_PATH), 'clearConfig deletes the file');
});

test('refresh: change detection — unchanged name = ZERO setName calls', async () => {
    resetManager();
    const guild = makeStubGuild({ withCounters: true });
    // The counter channels were created with the CURRENT live values → nothing to rename.
    const result = await manager.refreshServerStats(guild);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.deferred, 0);
    assert.strictEqual(result.missing, 0);
    for (const ch of guild.__counterChannels) {
        assert.strictEqual(ch.__calls.length, 0, `no rename for an unchanged counter: ${ch.name}`);
    }
});

test('refresh: changed value → ONE rename with the new name (force bypasses the cooldown)', async () => {
    resetManager();
    const guild = makeStubGuild({ withCounters: true });
    guild.memberCount = 6; // a member joined.

    // First WITHOUT force → blocked by the cooldown (this is the first edit
    // though — no cooldown set yet, so it goes through).
    let result = await manager.refreshServerStats(guild);
    assert.strictEqual(result.updated, 1);
    const membersCh = guild.__counterChannels.find(c => c.id === 'cnt_members');
    assert.strictEqual(membersCh.__calls.length, 1);
    assert.strictEqual(membersCh.__calls[0].newName, '👥 Members: 6');
    assert.match(membersCh.__calls[0].reason, /counter/i);

    // Now WITH force → bypasses the just-set cooldown and renames again.
    guild.memberCount = 7;
    result = await manager.refreshServerStats(guild, { force: true });
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(membersCh.__calls.length, 2);
    assert.strictEqual(membersCh.__calls[0].newName, '👥 Members: 6');
    assert.strictEqual(membersCh.__calls[1].newName, '👥 Members: 7');
});

test('refresh: the per-channel cooldown DEFERS a non-forced rename (Discord 2/10min limit)', async () => {
    resetManager();
    const guild = makeStubGuild({ withCounters: true });

    // Edit 1 (no cooldown yet) goes through.
    guild.premiumSubscriptionCount = 3;
    let result = await manager.refreshServerStats(guild);
    assert.strictEqual(result.updated, 1);
    const boostsCh = guild.__counterChannels.find(c => c.id === 'cnt_boosts');
    assert.strictEqual(boostsCh.__calls[0].newName, '🚀 Boosts: 3');

    // Edit 2 within COOLDOWN_MS → deferred, NOT renamed.
    guild.premiumSubscriptionCount = 4;
    result = await manager.refreshServerStats(guild);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.deferred, 1);
    assert.strictEqual(boostsCh.__calls.length, 1, 'cooldown blocked the second rename');
    assert.strictEqual(boostsCh.name, '🚀 Boosts: 3');
});

test('refresh: setName failure → error counted, never thrown', async () => {
    resetManager();
    const guild = makeStubGuild({ withCounters: true });
    const membersCh = guild.__counterChannels.find(c => c.id === 'cnt_members');
    membersCh.setName = async () => {
        throw new Error('rate limit hit');
    };
    guild.memberCount = 8;
    const result = await manager.refreshServerStats(guild);
    assert.strictEqual(result.errors, 1);
    assert.strictEqual(result.updated, 0);
});

test('refresh: deleted channel → missing + warning; ALL gone → auto-disable', async () => {
    resetManager();
    const guild = makeStubGuild({ withCounters: true });
    // Delete 3 of the 5 counter channels (admin cleanup).
    for (const type of ['members', 'bots', 'boosts']) {
        guild.channels.cache.delete(manager.getConfig().counters[type]);
    }
    const warnings = [];
    const origWarn = console.warn;
    console.warn = msg => warnings.push(msg);
    try {
        const result = await manager.refreshServerStats(guild);
        assert.strictEqual(result.missing, 3);
        assert.strictEqual(manager.isEnabled(), true, 'still enabled while 2 counters live');
        assert.ok(warnings.some(w => /server stats counter/i.test(w)), 'the missing channel warns with a fix hint');
    } finally {
        console.warn = origWarn;
    }

    // Delete the rest → the feature auto-disables (no zombie scheduler work).
    warnings.length = 0;
    console.warn = msg => warnings.push(msg);
    try {
        for (const type of ['roles', 'channels']) {
            guild.channels.cache.delete(manager.getConfig().counters[type]);
        }
        const result = await manager.refreshServerStats(guild);
        assert.strictEqual(result.disabled, true);
        assert.strictEqual(manager.isEnabled(), false, 'auto-disabled when all counters are gone');
        assert.ok(!fs.existsSync(SERVERSTATS_PATH), 'dead config cleared');
    } finally {
        console.warn = origWarn;
    }
});

test('scheduler tick: dirty-driven refresh + the 5-tick catch-up + no-op when disabled', async () => {
    resetManager();

    // Not set up → skipped, even when dirty.
    manager.markStatsDirty(GUILD_ID);
    assert.strictEqual(manager.isDirty(), false, 'markStatsDirty is a no-op when disabled');
    let result = await manager.processSchedulerTick({ guilds: { cache: new Map() } });
    assert.strictEqual(result.skipped, true);

    // Set up → an event marks dirty → the very next tick refreshes.
    const guild = makeStubGuild({ withCounters: true });
    manager.markStatsDirty(GUILD_ID);
    assert.strictEqual(manager.isDirty(), true);
    const client = { guilds: { cache: new Map([[GUILD_ID, guild]]) } };
    guild.memberCount = 6;
    result = await manager.processSchedulerTick(client);
    assert.strictEqual(result.updated, 1, 'dirty flag triggers the refresh');
    assert.strictEqual(manager.isDirty(), false, 'dirty flag cleared after the refresh');

    // Not dirty + not the 5th tick → skipped.
    result = await manager.processSchedulerTick(client);
    assert.strictEqual(result.skipped, true);

    // Ticks 3-4 skipped, tick 5 = the catch-up refresh (value changed).
    // The per-channel cooldown was just armed by tick 1 — mock the clock
    // 6 minutes ahead so the cooldown has expired by tick 5.
    await manager.processSchedulerTick(client); // 3
    await manager.processSchedulerTick(client); // 4
    guild.memberCount = 7;
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
        result = await manager.processSchedulerTick(client); // 5
    } finally {
        Date.now = realNow;
    }
    assert.strictEqual(result.updated, 1, 'the 5th tick is the catch-up refresh');

    // markStatsDirty for a DIFFERENT guild is ignored (single-guild hardening).
    manager.markStatsDirty('other_guild');
    assert.strictEqual(manager.isDirty(), false);
});

test('/serverstats setup: creates the category + 5 counters with live values, @everyone locked out, config saved', async () => {
    resetManager();
    const guild = makeStubGuild();
    const interaction = makeStubInteraction('setup', guild);

    await serverstatsCommand(interaction);

    assert.strictEqual(interaction.__replies.length, 1, 'exactly one reply');
    const embed = interaction.__replies[0].embeds[0];
    assert.match(embed.data.title, /live counters created/);
    // v3.9.53: 5 counter fields + 1 "Not created" field (= all enabled).
    assert.strictEqual(embed.data.fields.length, 6);
    const notCreated = embed.data.fields[5];
    assert.match(notCreated.name, /Not created/);
    assert.match(notCreated.value, /all counters enabled/);

    // 6 creations: 1 category + 5 counters.
    assert.strictEqual(guild.__created.length, 6);
    const [category, ...counters] = guild.__created;

    // The category: top of the channel list, @everyone denied Connect.
    assert.strictEqual(category.__opts.name, '📊 SERVER STATS');
    assert.strictEqual(category.__opts.type, ChannelType.GuildCategory);
    assert.strictEqual(category.__opts.position, 0);
    assert.ok(
        category.__opts.permissionOverwrites.some(o => o.id === 'everyone_role' && o.deny.includes(PermissionFlagsBits.Connect)),
        '@everyone cannot join the counter category'
    );

    // The 5 counters: voice channels under the category, live names, locked.
    assert.deepStrictEqual(
        counters.map(c => c.__opts.name),
        ['👥 Members: 5', '🤖 Bots: 2', '🚀 Boosts: 2', '🎭 Roles: 9', '📺 Channels: 7']
    );
    for (const c of counters) {
        assert.strictEqual(c.__opts.type, ChannelType.GuildVoice);
        assert.strictEqual(c.__opts.parent, category.id);
        assert.ok(
            c.__opts.permissionOverwrites.some(o => o.id === 'everyone_role' && o.deny.includes(PermissionFlagsBits.Connect)),
            `@everyone cannot join ${c.__opts.name}`
        );
    }

    // The config points at the created channels.
    assert.strictEqual(manager.isEnabled(), true);
    const cfg = manager.getConfig();
    assert.strictEqual(cfg.guildId, GUILD_ID);
    assert.strictEqual(cfg.categoryId, category.id);
    assert.strictEqual(Object.keys(cfg.counters).length, 5);
    for (const c of counters) {
        assert.ok(Object.values(cfg.counters).includes(c.id));
    }
});

test('/serverstats setup: COUNTER SELECTION (v3.9.53) — False options are skipped, config + embed reflect the selection', async () => {
    resetManager();
    const guild = makeStubGuild();
    // Only boosts/roles/channels — members + bots turned OFF.
    const interaction = makeStubInteraction('setup', guild, { members: false, bots: false });

    await serverstatsCommand(interaction);

    assert.strictEqual(guild.__created.length, 4, '1 category + 3 selected counters');
    const [category, ...counters] = guild.__created;
    assert.deepStrictEqual(
        counters.map(c => c.__opts.name),
        ['🚀 Boosts: 2', '🎭 Roles: 9', '📺 Channels: 7']
    );

    // The config stores ONLY the selected counters — refresh iterates those.
    const cfg = manager.getConfig();
    assert.deepStrictEqual(Object.keys(cfg.counters).sort(), ['boosts', 'channels', 'roles']);

    // The confirmation lists the skipped counters.
    const embed = interaction.__replies[0].embeds[0];
    const notCreated = embed.data.fields.find(f => /Not created/.test(f.name));
    assert.ok(notCreated, 'a "Not created" field must exist');
    assert.match(notCreated.value, /Members/);
    assert.match(notCreated.value, /Bots/);
    assert.ok(!notCreated.value.includes('Boosts'), 'selected counters must not appear as skipped');
});

test('/serverstats setup: ALL counters set to False → friendly refusal, nothing created', async () => {
    resetManager();
    const guild = makeStubGuild();
    const interaction = makeStubInteraction('setup', guild, {
        members: false, bots: false, boosts: false, roles: false, channels: false
    });

    await serverstatsCommand(interaction);

    assert.strictEqual(guild.__created.length, 0, 'nothing created');
    assert.strictEqual(manager.isEnabled(), false, 'no config saved');
    const reply = interaction.__replies[0];
    assert.match(reply.content, /turned OFF every counter/);
    assert.match(reply.content, /at least one/i);
});

test('/serverstats refresh: lists ONLY the configured counters when the selection was partial', async () => {
    resetManager();
    const guild = makeStubGuild();
    // A partial setup (3 counters, like /serverstats setup members:false bots:false).
    const interaction = makeStubInteraction('setup', guild, { members: false, bots: false });
    await serverstatsCommand(interaction);

    const refreshInteraction = makeStubInteraction('refresh', guild);
    await serverstatsCommand(refreshInteraction);

    const desc = refreshInteraction.__replies[0].embeds[0].data.description;
    assert.match(desc, /Boosts/);
    assert.match(desc, /Roles/);
    assert.ok(!/Members: /.test(desc), 'unselected counters must not be listed');
    assert.ok(!/Bots: /.test(desc), 'unselected counters must not be listed');
});

test('/serverstats setup: refuses when already set up; auto-heals when all old channels are gone', async () => {
    // Case 1 — already set up + channels still exist → refusal with the fix commands.
    resetManager();
    const guild = makeStubGuild({ withCounters: true });
    let interaction = makeStubInteraction('setup', guild);
    await serverstatsCommand(interaction);
    assert.strictEqual(guild.__created.length, 0, 'nothing created on refusal');
    assert.match(interaction.__replies[0].content, /already set up/);
    assert.match(interaction.__replies[0].content, /\/serverstats refresh/);
    assert.match(interaction.__replies[0].content, /\/serverstats remove/);

    // Case 2 — enabled but ALL channels deleted → auto-heal into a fresh setup.
    resetManager();
    const guild2 = makeStubGuild({ withCounters: true });
    for (const ch of guild2.__counterChannels) {
        guild2.channels.cache.delete(ch.id);
    }
    interaction = makeStubInteraction('setup', guild2);
    await serverstatsCommand(interaction);
    assert.strictEqual(guild2.__created.length, 6, 'a fresh setup was created');
    assert.match(interaction.__replies[0].embeds[0].data.title, /live counters created/);
});

test('/serverstats setup: refuses cleanly without Manage Channels/Manage Roles', async () => {
    resetManager();
    const guild = makeStubGuild({ botPermissions: false });
    const interaction = makeStubInteraction('setup', guild);
    await serverstatsCommand(interaction);
    assert.strictEqual(guild.__created.length, 0, 'nothing created without permissions');
    assert.match(interaction.__replies[0].content, /Manage Channels/);
    assert.match(interaction.__replies[0].content, /Manage Roles/);
});

test('/serverstats setup: partial failure → ROLLBACK (no zombie channels)', async () => {
    resetManager();
    const guild = makeStubGuild();
    // The 3rd counter creation fails (e.g. channel limit reached).
    let created = 0;
    const realCreate = guild.channels.create;
    guild.channels.create = async opts => {
        created++;
        if (created === 4) throw new Error('Maximum channels reached');
        return realCreate(opts);
    };
    const interaction = makeStubInteraction('setup', guild);
    await serverstatsCommand(interaction);

    // Everything created before the failure was deleted (rollback).
    const rollbackDeletes = guild.__created.filter(c => c.__deleted).length;
    assert.ok(rollbackDeletes >= 3, `channels rolled back: ${rollbackDeletes}`);
    assert.strictEqual(manager.isEnabled(), false, 'no config saved on failure');
    assert.match(interaction.__replies[0].content, /rolled back/);
});

test('/serverstats remove: deletes the channels + category and clears the config', async () => {
    resetManager();
    const guild = makeStubGuild({ withCounters: true });
    // Track deletions.
    const deleted = [];
    for (const ch of guild.channels.cache.values()) {
        ch.delete = async () => {
            deleted.push(ch.id);
            return ch;
        };
    }
    const interaction = makeStubInteraction('remove', guild);
    await serverstatsCommand(interaction);

    // 5 counters + the category (resolved by ID from the config).
    assert.ok(deleted.length >= 6, `all counters + category deleted: ${deleted.length}`);
    assert.strictEqual(manager.isEnabled(), false);
    assert.ok(!fs.existsSync(SERVERSTATS_PATH));
    assert.match(interaction.__replies[0].content, /removed/);
});

test('/serverstats refresh: forces an immediate update + reports per-counter results', async () => {
    resetManager();
    const guild = makeStubGuild({ withCounters: true });
    guild.memberCount = 6;
    const interaction = makeStubInteraction('refresh', guild);
    await serverstatsCommand(interaction);

    const embed = interaction.__replies[0].embeds[0];
    assert.match(embed.data.title, /counters refreshed/);
    assert.match(embed.data.description, /👥 Members: \*\*6\*\*/);
    assert.match(embed.data.description, /Updated: \*\*1\*\*/);
    assert.match(embed.data.description, /Deferred by cooldown: \*\*0\*\*/);
});

test('/serverstats remove & refresh: friendly error when not set up', async () => {
    resetManager();
    const guild = makeStubGuild();
    for (const sub of ['remove', 'refresh']) {
        const interaction = makeStubInteraction(sub, guild);
        await serverstatsCommand(interaction);
        assert.match(interaction.__replies[0].content, /not set up/);
        assert.match(interaction.__replies[0].content, /\/serverstats setup/);
    }
});

test('event wiring: guildMemberAdd + channelCreate mark the stats dirty', async () => {
    resetManager();
    const guild = makeStubGuild({ withCounters: true });

    // guildMemberAdd — a BOT member (onMemberAdd returns immediately for bots,
    // but markStatsDirty must still run: memberCount includes bots).
    const savedGuildId = process.env.GUILD_ID;
    process.env.GUILD_ID = '';
    try {
        const memberEvent = require('../../src/bot/events/guildMemberAdd');
        await memberEvent.execute({
            guild,
            user: { id: 'bot_new', tag: 'Bot#0001', bot: true, createdTimestamp: Date.now() },
            client: { channels: { cache: new Map() } }
        });
        assert.strictEqual(manager.isDirty(), true, 'a join marks the stats dirty');
    } finally {
        process.env.GUILD_ID = savedGuildId;
    }

    // channelCreate — a channel was created (the Channels counter changes).
    manager._resetForTests(); // clears the dirty flag, keeps the file
    assert.strictEqual(manager.isDirty(), false);
    const channelCreateEvent = require('../../src/bot/events/channelCreate');
    channelCreateEvent.execute({ guild: { id: GUILD_ID } });
    assert.strictEqual(manager.isDirty(), true, 'a channel create marks the stats dirty');

    // markStatsDirty ignores other guilds (single-guild hardening).
    manager._resetForTests();
    channelCreateEvent.execute({ guild: { id: 'other_guild' } });
    assert.strictEqual(manager.isDirty(), false);
});

test('CONTRACT registry/router: /serverstats registered with 3 subcommands, admin-gated, routed, NOT public', () => {
    resetManager();
    const { getCommands } = require('../../src/commands/registry');
    const cmds = getCommands();
    assert.strictEqual(cmds.length, 92, '92 commands (91 + /test-booster v3.9.58)');

    const cmd = cmds.find(c => c.name === 'serverstats');
    assert.ok(cmd, '/serverstats exists in the registry');
    assert.ok(cmd.defaultMemberPermissions, '/serverstats is admin-gated (ManageGuild)');
    const subNames = cmd.options.map(o => o.name);
    assert.deepStrictEqual(subNames, ['setup', 'remove', 'refresh']);
    for (const o of cmd.options) {
        assert.strictEqual(o.type, 1, 'subcommand options');
        assert.ok(o.description.length <= 100, 'subcommand description ≤ 100');
    }

    // v3.9.53: setup carries the 5 counter-selection booleans (default on).
    const setup = cmd.options.find(o => o.name === 'setup');
    const selOpts = setup.options || [];
    assert.deepStrictEqual(
        selOpts.map(o => o.name),
        ['members', 'bots', 'boosts', 'roles', 'channels'],
        'setup exposes one boolean per counter'
    );
    for (const o of selOpts) {
        assert.strictEqual(o.type, 5, 'counter-selection options are booleans');
        assert.strictEqual(o.required, false, 'selection options are optional (default on)');
        assert.ok(o.description.length <= 100, 'option description ≤ 100');
    }

    const routeCommand = require('../../src/commands/index');
    assert.strictEqual(routeCommand.COMMAND_TO_DOMAIN.serverstats, 'serverstats', 'routed to the serverstats domain');
    assert.ok(!routeCommand.PUBLIC_COMMANDS.includes('serverstats'), '/serverstats is NOT public');

    // The 4 new event files are registered in index.js (source contract).
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
    for (const evt of ['channelCreate', 'channelDelete', 'guildRoleCreate', 'guildRoleDelete']) {
        assert.ok(
            indexSrc.includes(`src/bot/events/${evt}`),
            `index.js registers the ${evt} event`
        );
    }

    // serverstats.json is backed up (survives /restore-backup).
    const { FILES_TO_BACKUP } = require('../../src/data/backupManager');
    assert.ok(FILES_TO_BACKUP.includes('serverstats.json'), 'serverstats.json is in FILES_TO_BACKUP');

    // The help catalog documents /serverstats + the budget holds.
    const { HELP_CATEGORIES, buildAllEmbeds, embedTotalChars } = require('../../src/ui/helpCatalog');
    const statsCat = HELP_CATEGORIES.find(c => c.id === 'stats');
    assert.ok(statsCat.lines.some(l => l.includes('/serverstats')), 'help catalog mentions /serverstats');
    const all = buildAllEmbeds();
    const total = all.reduce((s, e) => s + embedTotalChars(e), 0);
    assert.strictEqual(all[0].data.fields.length, HELP_CATEGORIES.length, 'all categories still in the All view');
    assert.ok(total <= 5800, `All-Commands embed stays within the budget: ${total}`);

    // The manager exports the rate-limit constants (guards against accidental
    // changes that would break Discord's 2-renames-per-10-min limit).
    assert.strictEqual(manager.COOLDOWN_MS, 5 * 60 * 1000, '5-min per-channel cooldown');
    assert.strictEqual(manager.REFRESH_EVERY_TICKS, 5, '5-min catch-up (60s ticks)');
});

// === Cleanup: never leave the test config behind for other test files ===
test('cleanup: remove the test serverstats.json', () => {
    resetManager();
    assert.ok(!fs.existsSync(SERVERSTATS_PATH));
});
