/**
 * Smoke test fitur newline v3.9.24/v3.9.25 — pastikan handler command benar-benar
 * mengubah \n literal jadi baris baru di output yang dikirim/disimpan.
 *
 * Scope (v3.9.24): /send-message, /announce
 * Scope (v3.9.25): /set-message (Body; Title sengaja TIDAK dikonversi), /afk,
 *                  /warn, /setup-selfrole
 *
 * Sandbox (pola P0-4): file data produksi di-snapshot di awal dan di-restore
 * di finally — smoke tidak boleh meninggalkan residue di data/.
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
// (panelManager). Keduanya di-sandbox supaya scenario /setup-selfrole aman.
const SANDBOX_FILES = ['config.json', 'afk.json', 'warns.json', 'panels.json', 'selfRoles.json'];

// --- sandbox: snapshot → restore (biar data produksi aman) ---
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

// Guild ID unik per run (pola communityFeatures) — sisa data tidak bentrok antar run
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
        // === 1. /send-message message dengan \n ===
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
                'FAIL: send-message tidak mengubah \\n jadi newline. Dapat: ' + JSON.stringify(sentContent)
            );
        }
        console.log('✅ 1. /send-message: \\n → newline asli (4 baris, termasuk baris kosong)');

        // === 2. /announce description dengan \n ===
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
                getChannel: name => (name === 'channel' ? { id: 'chan_nl' } : null)
            },
            deferReply: async () => {},
            editReply: async () => ({})
        };
        await announceHandler(i2);
        const desc = sentEmbed ? sentEmbed.data.description : null;
        if (desc !== 'Poi 1\nPoi 2') {
            throw new Error('FAIL: announce description tidak mengubah \\n. Dapat: ' + JSON.stringify(desc));
        }
        console.log('✅ 2. /announce: description \\n → newline asli');

        // === 3. /set-message tipe BODY (welcomeBody) — harus dikonversi ===
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
            throw new Error('FAIL: set-message Body tidak mengubah \\n. Dapat: ' + JSON.stringify(storedBody));
        }
        console.log('✅ 3. /set-message (Body): \\n → newline asli, tersimpan di config.json');

        // === 4. /set-message tipe TITLE (welcomeTitle) — sengaja TIDAK dikonversi ===
        // Embed title Discord menolak newline; kalau dikonversi panel/welcome gagal kirim.
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
                'FAIL: set-message Title HARUS tetap literal (embed title tidak boleh newline). Dapat: ' +
                    JSON.stringify(storedTitle)
            );
        }
        console.log('✅ 4. /set-message (Title): \\n TETAP literal — embed title aman dari newline');

        // === 5. /afk reason — dikonversi ===
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
            throw new Error('FAIL: afk reason tidak mengubah \\n. Dapat: ' + JSON.stringify(afkDesc));
        }
        console.log('✅ 5. /afk: reason \\n → newline asli');

        // === 6. /warn reason — dikonversi (DM ke user + record warns.json) ===
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
            throw new Error('FAIL: warn reason tidak mengubah \\n di DM. Dapat: ' + JSON.stringify(dmContent));
        }
        console.log('✅ 6. /warn: reason \\n → newline asli (DM user)');

        // === 7. /setup-selfrole description — dikonversi ===
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
            throw new Error('FAIL: setup-selfrole description tidak mengubah \\n. Dapat: ' + JSON.stringify(panelDesc));
        }
        console.log('✅ 7. /setup-selfrole: description \\n → newline asli');

        console.log('\n✅ SMOKE NEWLINE PASS — fitur \\n bekerja end-to-end di 7 handler');
    } finally {
        restoreSandbox();
    }
})().catch(err => {
    restoreSandbox();
    console.error('❌ SMOKE NEWLINE FAIL:', err.message);
    process.exit(1);
});
