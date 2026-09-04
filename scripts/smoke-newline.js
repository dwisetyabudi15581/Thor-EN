/**
 * Smoke test for the v3.9.24/v3.9.25 newline feature — makes sure the command handlers
 * really turn a literal \n into a real newline in the output they send/store.
 *
 * Scope (v3.9.24): /send-message, /announce
 * Scope (v3.9.25): /set-message (Body; Title is intentionally NOT converted), /afk,
 *                  /warn, /setup-selfrole
 *
 * Sandbox (P0-4 pattern): the production data files are snapshotted at the start and
 * restored in finally — the smoke test must not leave any residue in data/.
 *
 * Run: node scripts/smoke-newline.js
 */

const fs = require('fs');
const path = require('path');

const handler = require('../src/commands/send-message');
const announceHandler = require('../src/commands/announce');
const configHandler = require('../src/commands/config');
const afkHandler = require('../src/commands/afk');
const warnHandler = require('../src/commands/warn');
const selfroleHandler = require('../src/commands/selfrole');

const DATA_DIR = path.join(__dirname, '..', 'data');
// selfRoles.json = self-role panels (selfRoleManager); panels.json = ticket panels
// (panelManager). Both are sandboxed so the /setup-selfrole scenario is safe.
const SANDBOX_FILES = ['config.json', 'afk.json', 'warns.json', 'panels.json', 'selfRoles.json'];

// --- sandbox: snapshot → restore (so production data stays safe) ---
const snapshots = new Map();
for (const f of SANDBOX_FILES) {
    const p = path.join(DATA_DIR, f);
    snapshots.set(f, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
}
function restoreSandbox() {
    for (const [f, content] of snapshots) {
        const p = path.join(DATA_DIR, f);
        if (content === null) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } else {
            fs.writeFileSync(p, content);
        }
    }
}
function readDataJSON(name) {
    const p = path.join(DATA_DIR, name);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// Unique guild ID per run (communityFeatures pattern) — leftover data doesn't clash between runs
const RUN = Date.now().toString(36);
const auditChannel = { id: 'audit_nl', send: async () => ({}) };
function mockClient() {
    return {
        user: { username: 'Thor', displayAvatarURL: () => 'https://example.com/a.png' },
        channels: { cache: { get: () => auditChannel } }
    };
}

(async () => {
    try {
        // === 1. /send-message message with \n ===
        let sentContent = null;
        const channel = {
            id: 'chan_nl',
            type: 0,
            toString: () => '<#chan_nl>',
            permissionsFor: () => ({ has: () => true }),
            send: async opts => {
                sentContent = opts.content;
                return { id: 'msg1' };
            }
        };
        const i1 = {
            commandName: 'send-message',
            deferred: false,
            replied: false,
            guild: {
                id: `smoke_nl_${RUN}`,
                members: { me: { id: 'bot1' } },
                channels: { cache: { get: () => channel } }
            },
            member: { roles: { cache: new Map() } },
            user: { id: 'u1', tag: 'SmokeUser' },
            client: mockClient(),
            options: {
                getString: name => (name === 'message' ? 'Baris 1\\nBaris 2\\n\\nBaris 4' : null),
                getChannel: name => (name === 'channel' ? { id: 'chan_nl', type: 0 } : null)
            },
            deferReply: async () => {},
            editReply: async () => ({})
        };
        await handler(i1);
        if (sentContent !== 'Baris 1\nBaris 2\n\nBaris 4') {
            throw new Error(
                'FAIL: send-message does not convert \\n to a newline. Got: ' + JSON.stringify(sentContent)
            );
        }
        console.log('✅ 1. /send-message: \\n → real newline (4 lines, including the empty line)');

        // === 2. /announce description with \n ===
        let sentEmbed = null;
        const channel2 = {
            id: 'chan_nl',
            type: 0,
            toString: () => '<#chan_nl>',
            send: async opts => {
                sentEmbed = opts.embeds[0];
                return { id: 'msg2' };
            }
        };
        const i2 = {
            commandName: 'announce',
            deferred: false,
            replied: false,
            guild: {
                id: `smoke_nl_${RUN}`,
                members: { me: { id: 'bot1' } },
                channels: { cache: { get: () => channel2 } }
            },
            member: { roles: { cache: new Map() } },
            user: { id: 'u1', tag: 'SmokeUser', displayAvatarURL: () => 'https://example.com/a.png' },
            client: mockClient(),
            options: {
                getString: name => (name === 'title' ? 'Judul' : name === 'description' ? 'Poi 1\\nPoi 2' : null),
                getChannel: name => (name === 'channel' ? { id: 'chan_nl', type: 0 } : null)
            },
            deferReply: async () => {},
            editReply: async () => ({})
        };
        await announceHandler(i2);
        const desc = sentEmbed ? sentEmbed.data.description : null;
        if (desc !== 'Poi 1\nPoi 2') {
            throw new Error('FAIL: announce description does not convert \\n. Got: ' + JSON.stringify(desc));
        }
        console.log('✅ 2. /announce: description \\n → real newline');

        // === 3. /set-message tipe BODY (welcomeBody) — must be converted ===
        const i3 = {
            commandName: 'set-message',
            deferred: false,
            replied: false,
            guild: { id: `smoke_nl_${RUN}`, name: 'Smoke Guild' },
            member: { roles: { cache: new Map() } },
            user: { id: 'u1', tag: 'SmokeUser' },
            client: mockClient(),
            options: {
                getString: name =>
                    name === 'tipe' ? 'welcomeBody' : name === 'teks' ? 'Halo\\nSelamat datang\\n\\nSemoga betah' : null
            },
            deferReply: async () => {},
            editReply: async () => ({})
        };
        await configHandler(i3);
        const cfgAfterBody = readDataJSON('config.json');
        const storedBody = cfgAfterBody?.messages?.welcomeBody;
        if (storedBody !== 'Halo\nSelamat datang\n\nSemoga betah') {
            throw new Error('FAIL: set-message Body does not convert \\n. Got: ' + JSON.stringify(storedBody));
        }
        console.log('✅ 3. /set-message (Body): \\n → real newline, stored in config.json');

        // === 4. /set-message tipe TITLE (welcomeTitle) — intentionally NOT converted ===
        // Discord embed titles reject newlines; converting them would break panel/welcome sends.
        const i4 = {
            commandName: 'set-message',
            deferred: false,
            replied: false,
            guild: { id: `smoke_nl_${RUN}`, name: 'Smoke Guild' },
            member: { roles: { cache: new Map() } },
            user: { id: 'u1', tag: 'SmokeUser' },
            client: mockClient(),
            options: {
                getString: name => (name === 'tipe' ? 'welcomeTitle' : name === 'teks' ? 'Judul\\nGenap' : null)
            },
            deferReply: async () => {},
            editReply: async () => ({})
        };
        await configHandler(i4);
        const cfgAfterTitle = readDataJSON('config.json');
        const storedTitle = cfgAfterTitle?.messages?.welcomeTitle;
        if (storedTitle !== 'Judul\\nGenap') {
            throw new Error(
                'FAIL: set-message Title MUST stay literal (embed titles cannot contain newlines). Got: ' +
                    JSON.stringify(storedTitle)
            );
        }
        console.log('✅ 4. /set-message (Title): \\n STAYS literal — embed title safe from newlines');

        // === 5. /afk reason — converted ===
        let afkEmbed = null;
        const i5 = {
            commandName: 'afk',
            guild: { id: `smoke_nl_afk_${RUN}` },
            user: { id: 'u_afk', tag: 'SmokeAfk' },
            client: mockClient(),
            options: { getString: name => (name === 'reason' ? 'Tidur\\nJangan ganggu\\n\\nSampai pagi' : null) },
            reply: async opts => {
                afkEmbed = opts.embeds[0];
                return {};
            }
        };
        await afkHandler(i5);
        const afkDesc = afkEmbed ? afkEmbed.data.description : null;
        if (!afkDesc || !afkDesc.includes('📝 Reason: Tidur\nJangan ganggu\n\nSampai pagi')) {
            throw new Error('FAIL: afk reason does not convert \\n. Got: ' + JSON.stringify(afkDesc));
        }
        console.log('✅ 5. /afk: reason \\n → real newline');

        // === 6. /warn reason — converted (DM to the user + record in warns.json) ===
        let dmContent = null;
        const targetUser = {
            id: `u_warn_${RUN}`,
            tag: 'SmokeTarget',
            bot: false,
            send: async content => {
                dmContent = content;
                return {};
            }
        };
        const targetMember = {
            roles: { highest: { position: 5 } },
            timeout: async () => {},
            kick: async () => {}
        };
        const i6 = {
            commandName: 'warn',
            deferred: false,
            replied: false,
            guild: {
                id: `smoke_nl_warn_${RUN}`,
                name: 'Smoke Guild',
                members: {
                    fetch: async () => targetMember,
                    me: { id: 'bot1', roles: { highest: { position: 20 } } }
                }
            },
            member: { roles: { highest: { position: 10 } } },
            user: { id: 'u_admin', tag: 'SmokeAdmin' },
            client: mockClient(),
            options: {
                getUser: () => targetUser,
                getString: name => (name === 'reason' ? 'Pelanggaran A\\nPelanggaran B\\n\\nBaca rule 3' : null)
            },
            deferReply: async () => {},
            editReply: async () => ({})
        };
        await warnHandler(i6);
        if (!dmContent || !dmContent.includes('Reason: Pelanggaran A\nPelanggaran B\n\nBaca rule 3')) {
            throw new Error('FAIL: warn reason does not convert \\n in the DM. Got: ' + JSON.stringify(dmContent));
        }
        console.log('✅ 6. /warn: reason \\n → real newline (user DM)');

        // === 7. /setup-selfrole description — converted ===
        let panelEmbed = null;
        const panelChannel = {
            id: 'chan_panel_nl',
            send: async opts => {
                panelEmbed = opts.embeds[0];
                return { id: 'panel_msg_1' };
            }
        };
        const i7 = {
            commandName: 'setup-selfrole',
            deferred: false,
            replied: false,
            guild: { id: `smoke_nl_sr_${RUN}`, name: 'Smoke Guild' },
            channel: panelChannel,
            member: { roles: { cache: new Map() } },
            user: { id: 'u_admin', tag: 'SmokeAdmin' },
            client: mockClient(),
            options: {
                getString: name =>
                    name === 'title'
                        ? 'Panel Uji'
                        : name === 'description'
                          ? 'Baris A\\nBaris B\\n\\nPilih role di bawah'
                          : name === 'type'
                            ? 'button'
                            : null,
                getBoolean: () => false
            },
            deferReply: async () => {},
            editReply: async () => ({})
        };
        await selfroleHandler(i7);
        const panelDesc = panelEmbed ? panelEmbed.data.description : null;
        if (!panelDesc || !panelDesc.startsWith('Baris A\nBaris B\n\nPilih role di bawah\n\n')) {
            throw new Error('FAIL: setup-selfrole description does not convert \\n. Got: ' + JSON.stringify(panelDesc));
        }
        console.log('✅ 7. /setup-selfrole: description \\n → real newline');

        console.log('\n✅ SMOKE NEWLINE PASS — the \\n feature works end-to-end across 7 handlers');
    } finally {
        restoreSandbox();
    }
})().catch(err => {
    restoreSandbox();
    console.error('❌ SMOKE NEWLINE FAIL:', err.message);
    process.exit(1);
});
