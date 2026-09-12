/**
 * Unit tests for v3.9.49 — SERVER BOOSTER feature + product price guard.
 *
 * User request: "I want one more feature — server boosters, so I can know who
 * is boosting, and it gets sent to the server booster channel."
 *
 * Covered end-to-end via the REAL modules with stubs:
 *   1. boostManager (boosts.json): record add/remove, idempotency, history,
 *      recent events, offline reconcile (add/remove while offline).
 *   2. boostHandler: pure embed builders (add/remove/list).
 *   3. guildMemberUpdate event: premium_since diff → boost notification to the
 *      server-booster channel + BOOST_ADD server-log entry + history recorded;
 *      channel not set → the v3.9.48-style warning names the fix command.
 *   4. /boosters command: live list from the members cache + recent history.
 *   5. Registry/router contracts: command registered, channel choices,
 *      public command list, help catalog line.
 *   6. products price guard: /add-product rejects an unparseable price,
 *      /update-product rejects it too, valid prices pass with the revenue note.
 *
 * v3.9.56 (user request: "add booster tests too"): +6 tests —
 * (a) reconcile lapsed-&-restarted streak while offline: boostedAt refreshed
 * to the new premium_since WITHOUT inflating totalBoosts; (b) bot members are
 * skipped by reconcile; (c) null/broken guild guard; (d) offline add pins
 * boostedAt to the REAL premium_since (not the reconcile time); (e)
 * getRecentEvents limit + event shape; (f) $5.88 decimal price guard (v3.9.55
 * cents preservation).
 *
 * v3.9.57 (user request: "make the /add-product price support decimals, e.g.
 * 5.88"): +1 test — MARKER-LESS decimal price guard at the command level:
 * /add-product price:5.88 → saved + "Counted in stats as: 5.88" (without a
 * currency marker too, a 1-2 digit dot fraction now reads as a decimal).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { safeWriteJSON } = require('../../src/infra/safeWrite');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const BOOSTS_PATH = path.join(DATA_DIR, 'boosts.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const GUILD_ID = 'test_guild_boosters';
const USER_ID = 'test_user_booster';

function cleanBoostsFile() {
    if (fs.existsSync(BOOSTS_PATH)) {
        try {
            const data = JSON.parse(fs.readFileSync(BOOSTS_PATH, 'utf8'));
            if (data && typeof data === 'object') {
                let removed = 0;
                for (const key of Object.keys(data)) {
                    if (key.startsWith('test_guild')) {
                        delete data[key];
                        removed++;
                    }
                }
                if (removed > 0) safeWriteJSON(BOOSTS_PATH, data);
            }
        } catch (_) {}
    }
}

/** Stub guild/member shaped like what boostHandler + the event handler touch. */
function makeStubMember({ premiumSinceTimestamp = null, boosterChannelId = null, serverLogChannelId = null } = {}) {
    const sent = [];
    const channelsCache = new Map();
    if (boosterChannelId) {
        channelsCache.set(boosterChannelId, { id: boosterChannelId, name: 'boosters', send: async opts => { sent.push(opts); return {}; } });
    }
    if (serverLogChannelId) {
        channelsCache.set(serverLogChannelId, { id: serverLogChannelId, name: 'serverlog', send: async opts => { sent.push(opts); return {}; } });
    }
    // client.channels.cache mirrors guild.channels.cache (like real discord.js —
    // logServerEvent resolves channels through the CLIENT cache).
    const client = { channels: { cache: channelsCache, fetch: async () => null } };
    const guild = {
        id: GUILD_ID,
        name: 'Boost Test Server',
        premiumTier: 2,
        premiumSubscriptionCount: 4,
        iconURL: () => null,
        channels: { cache: channelsCache },
        members: { cache: new Map() }
    };
    const user = {
        id: USER_ID,
        tag: 'Booster#0001',
        bot: false,
        displayAvatarURL: () => 'https://example.com/a.png',
        // discord.js User stringifies to a <@id> mention.
        toString() { return `<@${USER_ID}>`; }
    };
    const member = {
        id: USER_ID,
        guild,
        user,
        premiumSinceTimestamp,
        client,
        roles: { cache: new Map() }
    };
    guild.members.cache.set(USER_ID, member);
    return { member, guild, sent, user };
}

/**
 * Write data/config.json directly (getConfig re-reads the file on every call —
 * mutating the returned object would be lost; this is the established test
 * pattern from welcomeDiagnostics.test.js).
 */
function writeTestConfig({ boosterChannel = null, serverLogChannel = null } = {}) {
    // v3.10.0: per-guild config — the boost handler reads this mock guild's config.
    const guildConfigPath = path.join(DATA_DIR, 'config', `${GUILD_ID}.json`);
    fs.mkdirSync(path.dirname(guildConfigPath), { recursive: true });
    fs.writeFileSync(
        guildConfigPath,
        JSON.stringify({
            channels: {
                ...(boosterChannel ? { 'server-booster': boosterChannel } : {}),
                ...(serverLogChannel ? { 'server-log': serverLogChannel } : {})
            },
            roles: {},
            products: []
        }, null, 4)
    );
    // Clean up the mock guild config file when the tests finish (no data/ pollution).
    process.on('exit', () => {
        try {
            fs.rmSync(guildConfigPath, { force: true });
        } catch (_) {}
    });
}

test('boostManager: record start → end → start tracks state + counts, idempotent', () => {
    cleanBoostsFile();
    const boostManager = require('../../src/data/boostManager');
    boostManager.reload();

    const t0 = 1700000000000;
    assert.strictEqual(boostManager.recordBoostStart(GUILD_ID, USER_ID, t0), true, 'first start recorded');
    assert.strictEqual(boostManager.recordBoostStart(GUILD_ID, USER_ID, t0 + 5), false, 'duplicate start ignored');

    assert.strictEqual(boostManager.recordBoostEnd(GUILD_ID, USER_ID, t0 + 1000), true, 'end recorded');
    assert.strictEqual(boostManager.recordBoostEnd(GUILD_ID, USER_ID, t0 + 2000), false, 'duplicate end ignored');

    assert.strictEqual(boostManager.recordBoostStart(GUILD_ID, USER_ID, t0 + 3000), true, 'second streak starts');
    const history = boostManager.getBoostHistory(GUILD_ID);
    assert.strictEqual(history.length, 1, 'one entry per user (state, not event log)');
    assert.strictEqual(history[0].totalBoosts, 2, 'two boost events counted');
    assert.strictEqual(history[0].lastEvent, 'add');
    assert.strictEqual(history[0].boostedAt, t0 + 3000);

    // Guild scoping.
    assert.strictEqual(boostManager.getBoostHistory('test_guild_other').length, 0);

    const recent = boostManager.getRecentEvents(GUILD_ID, 5);
    assert.strictEqual(recent[0].event, 'add');
    assert.strictEqual(recent[0].userId, USER_ID);
});

test('boostManager: reconcile — boost started while the bot was OFFLINE is detected', () => {
    cleanBoostsFile();
    const boostManager = require('../../src/data/boostManager');
    boostManager.reload();

    // The default member never boosted; offline_booster joined+boosted while offline.
    const { guild } = makeStubMember({ premiumSinceTimestamp: null });
    guild.members.cache.set('offline_booster', { id: 'offline_booster', user: { id: 'offline_booster', bot: false }, premiumSinceTimestamp: 1700005000000 });
    guild.members.cache.set('plain_user', { id: 'plain_user', user: { id: 'plain_user', bot: false }, premiumSinceTimestamp: null });

    const res = boostManager.reconcileBoosters(guild);
    assert.deepStrictEqual(res.added, ['offline_booster'], 'offline booster detected');
    assert.deepStrictEqual(res.removed, [], 'nobody stopped');

    // Second run: in sync, no duplicates.
    const res2 = boostManager.reconcileBoosters(guild);
    assert.deepStrictEqual(res2.added, [], 'idempotent on the second run');
});

test('boostManager: reconcile — boost stopped while offline is detected', () => {
    cleanBoostsFile();
    const boostManager = require('../../src/data/boostManager');
    boostManager.reload();

    // Stored state says the user IS boosting…
    boostManager.recordBoostStart(GUILD_ID, USER_ID, 1700000000000);
    // …but live they are not (boost ended while offline).
    const { guild } = makeStubMember({ premiumSinceTimestamp: null });

    const res = boostManager.reconcileBoosters(guild);
    assert.deepStrictEqual(res.removed, [USER_ID], 'stopped while offline detected');
    assert.strictEqual(boostManager.getRecentEvents(GUILD_ID, 1)[0].event, 'remove');
});

test('boostManager: reconcile — streak lapsed & RESTARTED while offline → boostedAt refreshed, totalBoosts NOT inflated', () => {
    cleanBoostsFile();
    const boostManager = require('../../src/data/boostManager');
    boostManager.reload();

    // The bot last saw the user start boosting at t0 (state still 'add' when it died).
    const t0 = 1700000000000;
    boostManager.recordBoostStart(GUILD_ID, USER_ID, t0);
    assert.strictEqual(boostManager.getBoostHistory(GUILD_ID)[0].totalBoosts, 1);

    // While offline: the boost lapsed, then the user RE-BOOSTED → a NEW premium_since (t1).
    const t1 = 1700009000000;
    const { guild } = makeStubMember({ premiumSinceTimestamp: t1 });

    const res = boostManager.reconcileBoosters(guild);
    assert.deepStrictEqual(res.added, [], 'stored active + still boosting live → not a new add');
    assert.deepStrictEqual(res.removed, [], 'still boosting live → not a remove');

    const entry = boostManager.getBoostHistory(GUILD_ID)[0];
    assert.strictEqual(entry.boostedAt, t1, 'streak start refreshed to the newest premium_since');
    assert.strictEqual(entry.lastEvent, 'add');
    assert.strictEqual(entry.totalBoosts, 1, 'totalBoosts NOT inflated (the gap is not observable)');

    // Second run: in sync — idempotent.
    boostManager.reconcileBoosters(guild);
    const entry2 = boostManager.getBoostHistory(GUILD_ID)[0];
    assert.strictEqual(entry2.totalBoosts, 1, 'still 1 after a re-reconcile');
    assert.strictEqual(entry2.boostedAt, t1);
});

test('boostManager: reconcile — BOT members are never counted as boosters', () => {
    cleanBoostsFile();
    const boostManager = require('../../src/data/boostManager');
    boostManager.reload();

    const { guild } = makeStubMember({ premiumSinceTimestamp: null });
    guild.members.cache.set('bot_booster', { id: 'bot_booster', user: { id: 'bot_booster', bot: true }, premiumSinceTimestamp: 1700007000000 });

    const res = boostManager.reconcileBoosters(guild);
    assert.deepStrictEqual(res.added, [], 'a bot member with premium_since is skipped');
    assert.deepStrictEqual(res.removed, []);
    assert.strictEqual(boostManager.getBoostHistory(GUILD_ID).length, 0, 'no history row for bots');
});

test('boostManager: reconcile — null/broken guild → empty changes, no crash', () => {
    const boostManager = require('../../src/data/boostManager');
    assert.deepStrictEqual(boostManager.reconcileBoosters(null), { added: [], removed: [] });
    assert.deepStrictEqual(boostManager.reconcileBoosters(undefined), { added: [], removed: [] });
    assert.deepStrictEqual(boostManager.reconcileBoosters({}), { added: [], removed: [] }, 'object without an id');
    assert.deepStrictEqual(boostManager.reconcileBoosters({ id: 'g1', members: {} }), { added: [], removed: [] }, 'members without a cache');
});

test('boostManager: reconcile — an offline add PINS boostedAt to the REAL premium_since (not the reconcile time)', () => {
    cleanBoostsFile();
    const boostManager = require('../../src/data/boostManager');
    boostManager.reload();

    const since = 1700005000000;
    const { guild } = makeStubMember({ premiumSinceTimestamp: null });
    guild.members.cache.set('late_booster', { id: 'late_booster', user: { id: 'late_booster', bot: false }, premiumSinceTimestamp: since });

    const res = boostManager.reconcileBoosters(guild);
    assert.deepStrictEqual(res.added, ['late_booster']);
    const entry = boostManager.getBoostHistory(GUILD_ID).find(e => e.userId === 'late_booster');
    assert.ok(entry, 'history row created');
    assert.strictEqual(entry.boostedAt, since, 'boostedAt = the real premium_since → streak duration stays accurate');
    assert.strictEqual(entry.totalBoosts, 1);
});

test('boostManager: getRecentEvents — limit respected, newest first, full event shape', () => {
    cleanBoostsFile();
    const boostManager = require('../../src/data/boostManager');
    boostManager.reload();

    boostManager.recordBoostStart(GUILD_ID, 'u1', 1700001000000);
    boostManager.recordBoostStart(GUILD_ID, 'u2', 1700002000000);
    boostManager.recordBoostStart(GUILD_ID, 'u3', 1700003000000);

    assert.strictEqual(boostManager.getRecentEvents(GUILD_ID, 10).length, 3, 'all events with a loose limit');
    const two = boostManager.getRecentEvents(GUILD_ID, 2);
    assert.strictEqual(two.length, 2, 'limit truncates');
    assert.strictEqual(two[0].userId, 'u3', 'newest lastEventAt first');
    assert.strictEqual(two[0].event, 'add');
    assert.strictEqual(two[0].at, 1700003000000, 'the at field = lastEventAt');
    assert.strictEqual(two[0].boostedAt, 1700003000000, 'the boostedAt field is carried along');
});

test('boostHandler: pure embed builders — boost add/remove', () => {
    const { buildBoostAddEmbed, buildBoostRemoveEmbed } = require('../../src/bot/boostHandler');
    const { member } = makeStubMember({ premiumSinceTimestamp: 1700000000000 });

    const add = buildBoostAddEmbed(member);
    assert.match(add.data.title, /NEW SERVER BOOST/);
    assert.match(add.data.description, new RegExp(`<@${USER_ID}>`));
    assert.strictEqual(add.data.color, 0xf472b6);
    assert.match(add.data.fields.find(f => f.name === '👤 Booster').value, /Booster#0001/);
    assert.match(add.data.fields.find(f => f.name === '📊 Server').value, /Level \*\*2\*\*/);

    const remove = buildBoostRemoveEmbed({ ...member, premiumSinceTimestamp: null }, 1700000000000);
    assert.match(remove.data.title, /BOOST ENDED/);
    assert.match(remove.data.description, /no longer boosting/);
    assert.match(remove.data.fields.find(f => f.name === '👤 Booster').value, /Booster#0001/);
});

test('EVENT guildMemberUpdate: premium_since null→date sends boost notification + server log + history', async () => {
    cleanBoostsFile();
    const boostManager = require('../../src/data/boostManager');
    boostManager.reload();

    const BOOST_CH = 'ch_booster_1';
    const LOG_CH = 'ch_serverlog_1';
    writeTestConfig({ boosterChannel: BOOST_CH, serverLogChannel: LOG_CH });

    const { member, sent } = makeStubMember({ premiumSinceTimestamp: null, boosterChannelId: BOOST_CH, serverLogChannelId: LOG_CH });
    const oldMember = { ...member, premiumSinceTimestamp: null };
    const newMember = { ...member, premiumSinceTimestamp: 1700000000000 };

    const eventHandler = require('../../src/bot/events/guildMemberUpdate');
    await eventHandler.execute(oldMember, newMember);

    // 1. The boost notification went to the server-booster channel (with mention).
    const boostMsg = sent.find(m => m.embeds?.[0]?.data?.title?.includes('NEW SERVER BOOST'));
    assert.ok(boostMsg, 'boost notification sent');
    assert.strictEqual(boostMsg.content, `<@${USER_ID}>`, 'booster is mentioned outside the embed');

    // 2. The server log got a BOOST_ADD entry.
    const logMsg = sent.find(m => m.embeds?.[0]?.data?.title?.includes('Boost Started'));
    assert.ok(logMsg, 'BOOST_ADD server-log entry sent');

    // 3. The history is recorded.
    assert.strictEqual(boostManager.getRecentEvents(GUILD_ID, 1)[0].event, 'add');
});

test('EVENT guildMemberUpdate: premium_since date→null notifies removal; no change → silent', async () => {
    cleanBoostsFile();
    const boostManager = require('../../src/data/boostManager');
    boostManager.reload();
    const BOOST_CH = 'ch_booster_2';
    writeTestConfig({ boosterChannel: BOOST_CH });

    const { member, sent } = makeStubMember({ premiumSinceTimestamp: 1700000000000, boosterChannelId: BOOST_CH });
    const newMember = { ...member, premiumSinceTimestamp: null };

    const eventHandler = require('../../src/bot/events/guildMemberUpdate');
    await eventHandler.execute(member, newMember);

    const removal = sent.find(m => m.embeds?.[0]?.data?.title?.includes('BOOST ENDED'));
    assert.ok(removal, 'boost removal notified');
    assert.strictEqual(boostManager.getRecentEvents(GUILD_ID, 1)[0].event, 'remove');

    // No change → nothing sent.
    sent.length = 0;
    await eventHandler.execute(newMember, { ...newMember });
    assert.strictEqual(sent.length, 0, 'no premium_since change → no notifications');
});

test('EVENT guildMemberUpdate: booster channel NOT set → console warning names the fix command', async () => {
    cleanBoostsFile();
    const boostManager = require('../../src/data/boostManager');
    boostManager.reload();
    writeTestConfig({});

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        const { member } = makeStubMember({ premiumSinceTimestamp: null });
        const eventHandler = require('../../src/bot/events/guildMemberUpdate');
        await eventHandler.execute(member, { ...member, premiumSinceTimestamp: 1700000000000 });
    } finally {
        console.warn = origWarn;
    }
    assert.ok(
        warnings.some(w => /server-booster channel is NOT set/.test(w) && /\/set-channel server-booster/.test(w)),
        `the silent skip is now a warning with the fix: ${warnings.join(' || ')}`
    );
    // The history is STILL recorded even without a channel (data first).
    assert.strictEqual(boostManager.getRecentEvents(GUILD_ID, 1)[0].event, 'add');
});

test('/boosters command: live list from the members cache + recent history + no boosters case', async () => {
    cleanBoostsFile();
    const boostManager = require('../../src/data/boostManager');
    boostManager.reload();
    boostManager.recordBoostStart(GUILD_ID, 'user_alpha', 1700001000000);
    boostManager.recordBoostStart(GUILD_ID, 'user_beta', 1700002000000);

    const replies = [];
    const membersCache = new Map();
    membersCache.set('user_alpha', { user: { id: 'user_alpha', bot: false }, premiumSinceTimestamp: 1700001000000 });
    membersCache.set('user_beta', { user: { id: 'user_beta', bot: false }, premiumSinceTimestamp: 1700002000000 });
    membersCache.set('plain', { user: { id: 'plain', bot: false }, premiumSinceTimestamp: null });
    membersCache.set('bot1', { user: { id: 'bot1', bot: true }, premiumSinceTimestamp: 1700003000000 });

    const interaction = {
        commandName: 'boosters',
        deferReply: async () => {},
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        guild: {
            id: GUILD_ID,
            name: 'Boost Test Server',
            premiumTier: 1,
            premiumSubscriptionCount: 2,
            iconURL: () => null,
            members: { cache: membersCache, fetch: async () => membersCache }
        }
    };

    const statsCommand = require('../../src/commands/stats');
    await statsCommand(interaction);

    assert.strictEqual(replies.length, 1, 'exactly one reply');
    const embed = replies[0].embeds[0];
    assert.match(embed.data.title, /SERVER BOOSTERS — Boost Test Server/);
    // Sorted by boost date ascending: alpha before beta; bots excluded.
    assert.match(embed.data.description, /<@user_alpha>/);
    assert.match(embed.data.description, /<@user_beta>/    );
    assert.ok(!embed.data.description.includes('<@bot1>'), 'bots excluded');
    const alphaPos = embed.data.description.indexOf('<@user_alpha>');
    const betaPos = embed.data.description.indexOf('<@user_beta>');
    assert.ok(alphaPos < betaPos, 'earliest booster listed first');
    const fields = Object.fromEntries((embed.data.fields || []).map(f => [f.name, f.value]));
    assert.strictEqual(fields['⭐ Boosters Listed'], '2');
    assert.match(fields['📊 Server Level'], /Level 1 \(2 boosts\)/);
    assert.match(fields['🕘 Recent Boost Activity'], /<@user_alpha>/);

    // No boosters → the friendly empty state.
    replies.length = 0;
    const emptyInteraction = {
        ...interaction,
        guild: { ...interaction.guild, premiumTier: 0, premiumSubscriptionCount: 0, members: { cache: new Map(), fetch: async () => new Map() } }
    };
    await statsCommand(emptyInteraction);
    assert.match(replies[0].embeds[0].data.description, /no active boosters/);
});

test('CONTRACT registry/router: /boosters registered, server-booster channel choices, public', () => {
    const { getCommands } = require('../../src/commands/registry');
    const cmds = getCommands();
    const boosters = cmds.find(c => c.name === 'boosters');
    assert.ok(boosters, '/boosters command exists');
    assert.ok(!boosters.defaultMemberPermissions, '/boosters is public (no permission gate)');

    const setChannel = cmds.find(c => c.name === 'set-channel');
    const tipe = setChannel.options.find(o => o.name === 'tipe');
    assert.ok(tipe.choices.some(c => c.value === 'server-booster'), 'set-channel has the server-booster choice');

    const removeChannel = cmds.find(c => c.name === 'remove-channel');
    const rtipe = removeChannel.options.find(o => o.name === 'tipe');
    assert.ok(rtipe.choices.some(c => c.value === 'server-booster'), 'remove-channel has the server-booster choice');

    const routeCommand = require('../../src/commands/index');
    assert.strictEqual(routeCommand.COMMAND_TO_DOMAIN.boosters, 'stats', 'boosters routed to the stats domain');
    assert.ok(routeCommand.PUBLIC_COMMANDS.includes('boosters'), 'boosters is public in the router');

    // Boost events exist in the server log catalog.
    const { SERVER_LOG_EVENTS } = require('../../src/infra/serverLog');
    assert.ok(SERVER_LOG_EVENTS.BOOST_ADD && SERVER_LOG_EVENTS.BOOST_REMOVE);

    // The help catalog documents /boosters.
    const { HELP_CATEGORIES, buildAllEmbeds, embedTotalChars } = require('../../src/ui/helpCatalog');
    assert.ok(
        HELP_CATEGORIES.find(c => c.id === 'stats').lines.some(l => l.includes('/boosters')),
        'help catalog mentions /boosters'
    );
    const all = buildAllEmbeds();
    const total = all.reduce((s, e) => s + embedTotalChars(e), 0);
    assert.strictEqual(all[0].data.fields.length, HELP_CATEGORIES.length, 'all categories still in the All view');
    assert.ok(total <= 5800, `All-Commands embed stays within the budget: ${total}`);
});

test('PRODUCT PRICE GUARD: /add-product rejects unparseable price, shows the parsed amount when valid', async () => {
    // Fresh config file so leftovers from earlier runs can't "already exist".
    writeTestConfig({});
    const replies = [];
    const makeInteraction = (price, commandName = 'add-product') => ({
        commandName,
        deferReply: async () => {},
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        guild: { id: GUILD_ID, name: 'Boost Test Server' },
        user: { id: 'admin_1', tag: 'Admin#0001' },
        client: { channels: { cache: new Map() } },
        options: {
            getString: name => (name === 'price' ? price : name === 'label' ? 'Test Product' : name === 'value' ? `tp_${price.replace(/[^a-z0-9]/gi, '')}` : null),
            getBoolean: () => null
        }
    });

    const productsCommand = require('../../src/commands/products');

    // 1. Unparseable price → rejected with the formats hint.
    await productsCommand(makeInteraction('murah banget'));
    assert.match(replies[0].content, /cannot be read as an amount/);
    assert.match(replies[0].content, /30rb/); // v3.9.54: international format list ($3 · €25 · Rp 30.000 · 30rb)
    assert.match(replies[0].content, /\$3/);
    const configAfterReject = require('../../src/data/configManager').getConfig(GUILD_ID);
    assert.strictEqual(configAfterReject.products.length, 0, 'nothing saved');

    // 2. Valid Indonesian suffix → saved + the stats amount is shown.
    replies.length = 0;
    await productsCommand(makeInteraction('25rb'));
    assert.match(replies[0].content, /✅ Product added/);
    assert.match(replies[0].content, /Counted in stats as: \*\*25,000\*\*/); // v3.9.54: no "Rp" prefix
    const configAfterAdd = require('../../src/data/configManager').getConfig(GUILD_ID);
    assert.strictEqual(configAfterAdd.products.length, 1);
    assert.strictEqual(configAfterAdd.products[0].price, '25rb');

    // 3. /update-product also rejects an unparseable price.
    replies.length = 0;
    const updInteraction = makeInteraction('negosiasi', 'update-product');
    updInteraction.options.getString = name => {
        if (name === 'value') return configAfterAdd.products[0].value;
        if (name === 'price') return 'negosiasi';
        return null;
    };
    await productsCommand(updInteraction);
    assert.match(replies[0].content, /cannot be read as an amount/);
    const configAfterUpdate = require('../../src/data/configManager').getConfig(GUILD_ID);
    assert.strictEqual(configAfterUpdate.products[0].price, '25rb', 'price unchanged after the rejection');
});

test('PRODUCT PRICE GUARD v3.9.55: /add-product accepts a $5.88 decimal → stats records 5.88 (cents preserved)', async () => {
    // Follow-up to the user's international-decimal-price question — pinned here
    // (same file as the v3.9.49 booster price guard) so the COMMAND-level path
    // is verified too, not just the parser in parsePrice.test.js.
    writeTestConfig({});
    const replies = [];
    const interaction = {
        commandName: 'add-product',
        deferReply: async () => {},
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        guild: { id: GUILD_ID, name: 'Boost Test Server' },
        user: { id: 'admin_1', tag: 'Admin#0001' },
        client: { channels: { cache: new Map() } },
        options: {
            getString: name => (name === 'price' ? '$5.88' : name === 'label' ? 'Decimal Product' : name === 'value' ? 'tp_decimal' : null),
            getBoolean: () => null
        }
    };

    const productsCommand = require('../../src/commands/products');
    await productsCommand(interaction);

    assert.match(replies[0].content, /✅ Product added/);
    // id-ID memakai koma desimal: 5.88 → "5,88" — BUKAN "588" (salah 100x di
    // era pra-v3.9.55 saat dot selalu dianggap pemisah ribuan).
    assert.match(replies[0].content, /Counted in stats as: \*\*5\.88\*\*/);
    const configAfter = require('../../src/data/configManager').getConfig(GUILD_ID);
    assert.strictEqual(configAfter.products.length, 1, 'produk tersimpan');
    assert.strictEqual(configAfter.products[0].price, '$5.88', 'harga tersimpan persis seperti input admin');
});

test('PRODUCT PRICE GUARD v3.9.57: /add-product marker-less decimal 5.88 → stats records 5.88', async () => {
    // User request: "make the /add-product price support decimals, e.g. 5.88" —
    // WITHOUT any currency marker too, a 1-2 digit dot fraction now reads as a
    // decimal (a bare "5.88" used to record as 588 in the stats — the dot was
    // read as a thousands separator, a silent 100x error; the admin had to
    // write "$5.88" or "5,88" to get 5.88).
    writeTestConfig({});
    const replies = [];
    const interaction = {
        commandName: 'add-product',
        deferReply: async () => {},
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        guild: { id: GUILD_ID, name: 'Boost Test Server' },
        user: { id: 'admin_1', tag: 'Admin#0001' },
        client: { channels: { cache: new Map() } },
        options: {
            getString: name => (name === 'price' ? '5.88' : name === 'label' ? 'Plain Decimal Product' : name === 'value' ? 'tp_plain_decimal' : null),
            getBoolean: () => null
        }
    };

    const productsCommand = require('../../src/commands/products');
    await productsCommand(interaction);

    assert.match(replies[0].content, /✅ Product added/);
    // "5.88" polos → 5,88 (id-ID koma desimal) — BUKAN 588 seperti era
    // pra-v3.9.57, dan bukan 5,9 (cents dipertahankan, maksimal 2 desimal).
    assert.match(replies[0].content, /Counted in stats as: \*\*5\.88\*\*/);
    const configAfter = require('../../src/data/configManager').getConfig(GUILD_ID);
    assert.strictEqual(configAfter.products.length, 1, 'produk tersimpan');
    assert.strictEqual(configAfter.products[0].price, '5.88', 'harga tersimpan persis seperti input admin');
});

// ============ CLEANUP ============
test('v3.9.49 cleanup: remove boosts.json test residue + reset test config channels', () => {
    cleanBoostsFile();
    const boostManager = require('../../src/data/boostManager');
    boostManager.reload();
    // Reset config.json to a clean state (channels + no products).
    writeTestConfig({});
    assert.ok(true, 'boosters cleanup done');
});
