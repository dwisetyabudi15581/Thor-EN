/**
 * Unit tests for v3.9.48 — welcome/goodbye diagnostics.
 *
 * User report: "there's a bug — the Welcome doesn't appear".
 * Investigation: the CODE path was proven working (end-to-end simulation with
 * the real modules). The real bug = SILENT FAILURES — when the welcome channel
 * was not set / deleted / wrong guild, the bot logged NOTHING at startup, and
 * NOTHING when a member actually joined. The admin had zero clues, and there
 * was no way to test the welcome without a real member joining.
 *
 * What v3.9.48 changes (all covered here):
 *   1. memberHandler: embed builders extracted (buildWelcomeEmbed /
 *      buildGoodbyeEmbed — shared with /test-welcome so preview === real).
 *   2. memberHandler: every skip reason logs an actionable hint
 *      ("/set-channel welcome #channel").
 *   3. guildMemberAdd/Remove: a member event from another guild (GUILD_ID
 *      mismatch) is now VISIBLE (was a silent return).
 *   4. ready.js: startup check for welcome/goodbye (static contract).
 *   5. NEW /test-welcome: diagnoses config → channel → bot permissions and
 *      sends a live preview embed (real command module, stubbed interaction).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ====================================================
// === Sandbox: snapshot & restore config.json       ===
// === (setChannelMerge.test.js pattern)             ===
// ====================================================
const hadConfig = fs.existsSync(configPath);
if (hadConfig) fs.copyFileSync(configPath, configPath + '.test-backup');
process.on('exit', () => {
    try {
        if (hadConfig) {
            fs.copyFileSync(configPath + '.test-backup', configPath);
            fs.rmSync(configPath + '.test-backup', { force: true });
        } else if (fs.existsSync(configPath)) {
            fs.rmSync(configPath, { force: true });
        }
    } catch (_) {}
});

// ====================================================
// === Helpers                                       ===
// ====================================================

/** Write config.json with the given channels/roles. */
function writeConfig(partial = {}) {
    fs.writeFileSync(
        configPath,
        JSON.stringify(
            {
                channels: partial.channels || {},
                roles: partial.roles || {},
                messages: {
                    welcomeTitle: '👋 WELCOME!',
                    welcomeBody: 'Hello {user}! Welcome to **{server}** — member #{count}',
                    goodbyeTitle: '👋 FAREWELL',
                    goodbyeBody: '**{username}** has {action}. Remaining: {count}'
                }
            },
            null,
            4
        )
    );
}

/** Capture console.log/warn/error during a callback; return [level, text] rows. */
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

/** Stub channel that records everything sent to it. */
function makeChannel(id, { fail } = {}) {
    const sent = [];
    return {
        id,
        name: `chan-${id}`,
        sent,
        send: async payload => {
            if (fail) throw new Error(fail);
            sent.push(payload);
            return { id: `msg_${id}_${sent.length}` };
        },
        __toString: `#chan-${id}`
    };
}

/**
 * Stub guild + member shaped exactly like what memberHandler touches.
 * `extraChannels` are added to the cache; `auditEntries` feeds fetchAuditLogs
 * (real discord.js returns a Collection — an Array also has .find, which is
 * all the handler uses).
 */
function makeWorld({ channels = {}, auditEntries = [] } = {}) {
    const cache = new Map();
    for (const ch of Object.values(channels)) cache.set(ch.id, ch);

    const guild = {
        id: 'guild_w',
        name: 'Chronos',
        memberCount: 42,
        iconURL: () => null,
        roles: { cache: new Map([['role_unverified', { id: 'role_unverified', name: 'Unverified' }]]) },
        channels: { cache },
        members: { me: null },
        fetchAuditLogs: async () => ({ entries: auditEntries })
    };

    const roleAdds = [];
    const member = {
        guild,
        user: {
            id: 'user_new',
            bot: false,
            tag: 'Newbie#0001',
            createdTimestamp: Date.now() - 90 * 86400000,
            displayAvatarURL: () => 'https://cdn.example/avatar.png'
        },
        roles: { add: async r => roleAdds.push(r.id) }
    };
    return { guild, member, roleAdds };
}

// ====================================================
// === 1. Pure embed builders (shared preview path)  ===
// ====================================================

test('buildWelcomeEmbed: template vars filled from the member (same builder as /test-welcome preview)', () => {
    writeConfig({});
    const { buildWelcomeEmbed } = require('../../src/bot/memberHandler');
    const { member } = makeWorld();

    const embed = buildWelcomeEmbed(member, require('../../src/data/configManager').getConfig());
    assert.strictEqual(embed.data.title, '👋 WELCOME!');
    assert.strictEqual(embed.data.description, 'Hello <@user_new>! Welcome to **Chronos** — member #42');
    assert.strictEqual(embed.data.thumbnail.url, 'https://cdn.example/avatar.png');
});

test('buildGoodbyeEmbed: action var filled (kicked/left)', () => {
    writeConfig({});
    const { buildGoodbyeEmbed } = require('../../src/bot/memberHandler');
    const { member } = makeWorld();
    const config = require('../../src/data/configManager').getConfig();

    const left = buildGoodbyeEmbed(member, config, 'left');
    assert.match(left.data.description, /\*\*Newbie#0001\*\* has left\./);
    const kicked = buildGoodbyeEmbed(member, config, 'kicked');
    assert.match(kicked.data.description, /\*\*Newbie#0001\*\* has kicked\./);
});

// ====================================================
// === 2. Live events: happy path regression         ===
// ====================================================

test('onMemberAdd end-to-end: welcome sent to the configured channel', async () => {
    const welcome = makeChannel('ch_w');
    writeConfig({ channels: { welcome: 'ch_w' }, roles: { unverified: 'role_unverified' } });
    const world = makeWorld({ channels: { welcome } });

    const rows = await captureConsole(() => require('../../src/bot/memberHandler').onMemberAdd(world.member));

    assert.strictEqual(welcome.sent.length, 1, 'exactly one welcome message');
    assert.strictEqual(welcome.sent[0].content, '<@user_new>');
    assert.match(welcome.sent[0].embeds[0].data.title, /WELCOME/);
    assert.deepStrictEqual(world.roleAdds, ['role_unverified'], 'unverified role granted');
    assert.ok(rows.some(r => r[0] === 'log' && /Welcome sent/.test(r[1])), 'success is logged (visible)');
});

test('onMemberRemove end-to-end: goodbye sent (kick detected via audit log)', async () => {
    const goodbye = makeChannel('ch_g');
    writeConfig({ channels: { goodbye: 'ch_g' } });
    const world = makeWorld({
        channels: { goodbye },
        auditEntries: [{ target: { id: 'user_new' }, executorId: 'mod_1', createdTimestamp: Date.now(), reason: 'spam' }]
    });

    const rows = await captureConsole(() => require('../../src/bot/memberHandler').onMemberRemove(world.member));

    assert.strictEqual(goodbye.sent.length, 1, 'exactly one goodbye message');
    assert.ok(rows.some(r => r[0] === 'log' && /Goodbye sent/.test(r[1])));
});

// ====================================================
// === 3. THE BUG: silent skips now speak up          ===
// ====================================================

test('USER REPORT — welcome channel NOT set: actionable warning instead of silence', async () => {
    writeConfig({}); // no channels at all
    const world = makeWorld();

    const rows = await captureConsole(() => require('../../src/bot/memberHandler').onMemberAdd(world.member));

    assert.ok(
        rows.some(r => r[0] === 'warn' && /welcome channel is NOT set/.test(r[1]) && /\/set-channel welcome/.test(r[1])),
        'the warning names the problem AND the fix command'
    );
});

test('welcome channel set but not in cache (deleted / other server): actionable warning', async () => {
    writeConfig({ channels: { welcome: 'ch_ghost' } });
    const world = makeWorld(); // cache empty — ID unknown

    const rows = await captureConsole(() => require('../../src/bot/memberHandler').onMemberAdd(world.member));

    assert.ok(
        rows.some(r => r[0] === 'warn' && /Welcome channel.*not found/.test(r[1]) && /\/set-channel welcome/.test(r[1])),
        'not-found warning + fix command'
    );
});

test('welcome send failure (permissions): error names the channel + the permissions to fix', async () => {
    const welcome = makeChannel('ch_w', { fail: 'Missing Permissions' });
    writeConfig({ channels: { welcome: 'ch_w' } });
    const world = makeWorld({ channels: { welcome } });

    const rows = await captureConsole(() => require('../../src/bot/memberHandler').onMemberAdd(world.member));

    assert.ok(
        rows.some(r => r[0] === 'error' && /Failed to send welcome/.test(r[1]) && /Embed Links/.test(r[1])),
        'send failure explains which permissions to check'
    );
});

test('goodbye channel NOT set: actionable warning instead of silence', async () => {
    writeConfig({});
    const world = makeWorld();

    const rows = await captureConsole(() => require('../../src/bot/memberHandler').onMemberRemove(world.member));

    assert.ok(
        rows.some(r => r[0] === 'warn' && /goodbye channel is NOT set/.test(r[1]) && /\/set-channel goodbye/.test(r[1]))
    );
});

// ====================================================
// === 4. GUILD_ID guard is visible now              ===
// ====================================================

test('guildMemberAdd event: a join from ANOTHER guild (GUILD_ID mismatch) logs why it is ignored', async () => {
    const saved = process.env.GUILD_ID;
    process.env.GUILD_ID = 'guild_main';
    try {
        const welcome = makeChannel('ch_w');
        writeConfig({ channels: { welcome: 'ch_w' } });
        const world = makeWorld({ channels: { welcome } });

        const rows = await captureConsole(async () => {
            const ev = require('../../src/bot/events/guildMemberAdd');
            world.member.client = { channels: { cache: world.guild.channels.cache } };
            await ev.execute(world.member);
        });

        assert.strictEqual(welcome.sent.length, 0, 'no welcome for a foreign guild');
        assert.ok(
            rows.some(r => r[0] === 'warn' && /another guild/.test(r[1]) && /GUILD_ID/.test(r[1])),
            'the skip is now visible'
        );
    } finally {
        if (saved === undefined) delete process.env.GUILD_ID;
        else process.env.GUILD_ID = saved;
    }
});

// ====================================================
// === 5. /test-welcome — the diagnostic command      ===
// ====================================================

/** Interaction stub shaped for src/commands/config.js (/test-welcome path). */
function makeTestWelcomeInteraction({ tipe = 'welcome', configChannels = {}, perms = {} } = {}) {
    const welcomeCh = makeChannel('ch_w');
    const currentCh = makeChannel('ch_cur');
    const me = { id: 'bot_me' };
    for (const [id, ch] of Object.entries({ ch_w: welcomeCh, ch_cur: currentCh })) {
        ch.permissionsFor = () => ({
            has: bit => {
                if (bit === require('discord.js').PermissionFlagsBits.SendMessages) return perms.send !== false;
                if (bit === require('discord.js').PermissionFlagsBits.EmbedLinks) return perms.embed !== false;
                if (bit === require('discord.js').PermissionFlagsBits.ViewChannel) return perms.view !== false;
                return true;
            }
        });
    }

    const cache = new Map();
    if (configChannels.welcome) cache.set('ch_w', welcomeCh); // only cached when the ID matches
    cache.set('ch_cur', currentCh);

    const replies = [];
    const { guild, member } = makeWorld();
    guild.channels.cache = cache;
    guild.members.me = me;

    const interaction = {
        commandName: 'test-welcome',
        client: {},
        deferReply: async () => {},
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        guild,
        member,
        user: member.user,
        channel: currentCh,
        options: { getString: () => tipe }
    };
    interaction.__replies = replies;
    interaction.__currentChannel = currentCh;
    return interaction;
}

test('/test-welcome (welcome, all healthy): status ✅ + live preview sent to the current channel', async () => {
    writeConfig({ channels: { welcome: 'ch_w' } });
    const interaction = makeTestWelcomeInteraction({ tipe: 'welcome', configChannels: { welcome: 'ch_w' } });

    await require('../../src/commands/config')(interaction);

    assert.strictEqual(interaction.__replies.length, 1, 'exactly one ephemeral reply');
    const reply = interaction.__replies[0].content;
    assert.match(reply, /welcome channel:/);
    assert.match(reply, /✅ Send Messages · ✅ Embed Links/);
    assert.match(reply, /GuildMembers intent/);
    assert.strictEqual(interaction.__currentChannel.sent.length, 1, 'preview embed sent');
    assert.strictEqual(interaction.__currentChannel.sent[0].content, '<@user_new>');
    assert.match(interaction.__currentChannel.sent[0].embeds[0].data.title, /WELCOME/);
    assert.match(reply, /Preview sent/);
});

test('/test-welcome (welcome, channel NOT set): the reply names the fix command', async () => {
    writeConfig({}); // nothing set
    const interaction = makeTestWelcomeInteraction({ tipe: 'welcome', configChannels: {} });

    await require('../../src/commands/config')(interaction);

    const reply = interaction.__replies[0].content;
    assert.match(reply, /not set/);
    assert.match(reply, /\/set-channel welcome #channel/);
    // The preview still sends — the admin sees the embed format.
    assert.strictEqual(interaction.__currentChannel.sent.length, 1, 'preview still sent');
});

test('/test-welcome (channel ID unknown): reply explains deleted / other-server', async () => {
    writeConfig({ channels: { welcome: 'ch_ghost' } });
    const interaction = makeTestWelcomeInteraction({ tipe: 'welcome', configChannels: {} }); // ghost → not cached

    await require('../../src/commands/config')(interaction);

    const reply = interaction.__replies[0].content;
    assert.match(reply, /not found/);
    assert.match(reply, /ch_ghost/);
    assert.match(reply, /\/set-channel welcome #channel/);
});

test('/test-welcome (bot lacks Send Messages): the permission line flips to ❌ + fix hint', async () => {
    writeConfig({ channels: { welcome: 'ch_w' } });
    const interaction = makeTestWelcomeInteraction({
        tipe: 'welcome',
        configChannels: { welcome: 'ch_w' },
        perms: { send: false }
    });

    await require('../../src/commands/config')(interaction);

    const reply = interaction.__replies[0].content;
    assert.match(reply, /❌ Send Messages/);
    assert.match(reply, /Send Messages/);
});

test('/test-welcome tipe:goodbye — same diagnostics for the goodbye channel', async () => {
    writeConfig({ channels: { goodbye: 'ch_w' } });
    const interaction = makeTestWelcomeInteraction({ tipe: 'goodbye', configChannels: {} });

    await require('../../src/commands/config')(interaction);

    const reply = interaction.__replies[0].content;
    assert.match(reply, /goodbye channel:/);
    assert.strictEqual(interaction.__currentChannel.sent[0].embeds[0].data.color, 0xe74c3c, 'red goodbye embed');
});

// ====================================================
// === 6. Contracts: registry + router + ready.js    ===
// ====================================================

test('registry contract: /test-welcome exists with welcome|goodbye choices + ManageGuild', () => {
    const { getCommands } = require('../../src/commands/registry');
    const cmd = getCommands().find(c => c.name === 'test-welcome');
    assert.ok(cmd, 'command registered');
    const tipe = cmd.options.find(o => o.name === 'tipe');
    assert.deepStrictEqual(
        tipe.choices.map(c => c.value).sort(),
        ['goodbye', 'welcome']
    );
    assert.ok(cmd.defaultMemberPermissions, 'admin-gated');
});

test('router contract: test-welcome routes to the config domain', () => {
    const { COMMAND_TO_DOMAIN } = require('../../src/commands/index');
    assert.strictEqual(COMMAND_TO_DOMAIN['test-welcome'], 'config');
});

test('ready.js contract: startup speaks up when the welcome channel is not configured', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bot', 'events', 'ready.js'), 'utf8');
    // The startup check must cover BOTH keys and name the fix command.
    // v3.9.49: the keys moved into CHANNEL_LABELS (unquoted object keys) + the
    // server-booster channel joined the same check.
    assert.match(src, /welcome:\s*'welcome messages'/, 'welcome checked at startup');
    assert.match(src, /goodbye:\s*'goodbye messages'/, 'goodbye checked at startup');
    assert.match(src, /'server-booster':\s*'boost notifications'/, 'server-booster checked at startup (v3.9.49)');
    assert.match(src, /\/set-channel \$\{key\} #channel/);
});
