/**
 * v3.9.26 HARDENING TESTS — regression test untuk perbaikan audit single-guild:
 *   1. isValidEmoji (anti poison config)
 *   2. claimGiveawayDismissed (anti resurrection kategori)
 *   3. Migrasi v1→v2 preserve field modern
 *   4. Karantina file korup (quarantineCorruptFile)
 *   5. GC prune (giveaway/poll/announcement)
 *   6. Read-through cache + invalidateCache (automod/afk)
 *   7. /giveaway list & /poll list bounding
 *   8. /poll create validasi question + /giveaway subcommand hint
 *   9. Panel patch contract (imageUrl/thumbnailUrl/footerText)
 *
 * Sandbox: snapshot/restore semua file data yang disentuh (pola v3.9.24).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SANDBOX_FILES = [
    'config.json',
    'giveaways.json',
    'polls.json',
    'scheduledAnnouncements.json',
    'afk.json',
    'panels.json',
    'automod.json',
    'levels.json',
    'responders.json'
];

// --- sandbox setup/teardown ---
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

function writeDataJSON(name, data) {
    fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2));
}

function readDataJSON(name) {
    const p = path.join(DATA_DIR, name);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function clearQuarantineArtifacts() {
    // Hapus sisa file .corrupt-* dari test karantina
    if (!fs.existsSync(DATA_DIR)) return;
    for (const f of fs.readdirSync(DATA_DIR)) {
        if (f.includes('.corrupt-')) {
            try {
                fs.unlinkSync(path.join(DATA_DIR, f));
            } catch (_) {}
        }
    }
}

const { isValidEmoji } = require('../../src/infra/text');
const { quarantineCorruptFile } = require('../../src/infra/safeWrite');

test('v3.9.26 isValidEmoji: terima unicode & custom emoji', () => {
    assert.strictEqual(isValidEmoji('✅'), true);
    assert.strictEqual(isValidEmoji('🎫'), true);
    assert.strictEqual(isValidEmoji('👍🏽'), true); // skin tone modifier
    assert.strictEqual(isValidEmoji('<:coolname:123456789>'), true);
    assert.strictEqual(isValidEmoji('<a:anim:987654321>'), true);
    assert.strictEqual(isValidEmoji(':name:12345'), true);
});

test('v3.9.26 isValidEmoji: tolak string yang akan meracuni setEmoji()', () => {
    assert.strictEqual(isValidEmoji('notanemoji'), false);
    assert.strictEqual(isValidEmoji('a'.repeat(200)), false);
    assert.strictEqual(isValidEmoji('hello world'), false);
    assert.strictEqual(isValidEmoji(''), false);
    assert.strictEqual(isValidEmoji(null), false);
    assert.strictEqual(isValidEmoji(42), false);
    // Angka ASCII murni bukan emoji (walau non-printable check lolos)
    assert.strictEqual(isValidEmoji('123'), false);
});

test('v3.9.26 claim_giveaway: flag dismissed mencegah resurrection', () => {
    const { getConfig } = require('../../src/data/configManager');
    // Tulis config TANPA claim_giveaway + dengan flag dismissed
    writeDataJSON('config.json', {
        roles: { admin: 'r_admin' },
        ticketCategories: [
            { id: 'transaction', label: 'Beli Key', emoji: '🛒', style: 'Primary', requiresKey: true, isDefault: true },
            { id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false, isDefault: true }
        ],
        claimGiveawayDismissed: true,
        customFieldAdmin: 'jangan-hilang'
    });

    const config = getConfig();
    const ids = config.ticketCategories.map(c => c.id);
    assert.ok(!ids.includes('claim_giveaway'), 'claim_giveaway TIDAK boleh ditambah ulang kalau dismissed');
    // Field custom harus preserve
    assert.strictEqual(config.customFieldAdmin, 'jangan-hilang');
});

test('v3.9.26 claim_giveaway: tanpa flag, migration tetap nambah (backward compat)', () => {
    const { getConfig } = require('../../src/data/configManager');
    writeDataJSON('config.json', {
        roles: { admin: 'r_admin' },
        ticketCategories: [
            { id: 'transaction', label: 'Beli Key', emoji: '🛒', style: 'Primary', requiresKey: true, isDefault: true }
        ]
        // claimGiveawayDismissed TIDAK di-set
    });
    const config = getConfig();
    const ids = config.ticketCategories.map(c => c.id);
    assert.ok(ids.includes('claim_giveaway'), 'tanpa flag, kategori contoh tetap ditambah (perilaku lama)');
});

test('v3.9.26 migrasi v1→v2: field modern tidak lagi DROPPED', () => {
    const { getConfig } = require('../../src/data/configManager');
    // Config CAMPURAN: sisa flat key v1 + field modern v2 — sebelumnya auto-save
    // migrasi cuma nulis 5 key utama → ticketCategories/leveling hilang dari disk.
    writeDataJSON('config.json', {
        verifiedRoleId: 'r_verified_old',
        invoiceChannelId: 'c_invoice_old',
        roles: { admin: 'r_admin' },
        channels: {},
        messages: { welcomeTitle: 'Kustom' },
        ticketCategories: [
            { id: 'jasa', label: 'Jasa', emoji: '🛠️', style: 'Success', requiresKey: false, isDefault: false }
        ],
        leveling: { enabled: true, xpPerMessage: 25 },
        verifyButton: { label: 'Klik Aku', style: 'Danger' },
        customFieldAdmin: 'preserve-me'
    });

    const config = getConfig();
    // Flat v1 → dipindah ke nested
    assert.strictEqual(config.roles.verified, 'r_verified_old');
    assert.strictEqual(config.channels.invoice, 'c_invoice_old');
    // Field modern harus ada di hasil merge
    assert.strictEqual(config.leveling.enabled, true);
    assert.strictEqual(config.verifyButton.label, 'Klik Aku');
    assert.strictEqual(config.customFieldAdmin, 'preserve-me');
    const ids = config.ticketCategories.map(c => c.id);
    assert.ok(ids.includes('jasa'), 'ticketCategories custom harus preserve');

    // Dan yang tersimpan di disk harus BEBAS flat key v1 (idempotent)
    const saved = readDataJSON('config.json');
    assert.strictEqual(saved.verifiedRoleId, undefined, 'flat key v1 harus hilang dari disk setelah migrasi');
    assert.ok(Array.isArray(saved.ticketCategories));
});

test('v3.9.26 quarantineCorruptFile: file korup di-rename, bukan ditimpa', () => {
    const target = path.join(DATA_DIR, 'levels.json');
    writeDataJSON('levels.json', { 'g:u': { xp: 100 } });
    // Korupin file
    fs.writeFileSync(target, '{ ini bukan json valid !!!');

    // invalidate cache dulu (levelManager cache 15s)
    const levelManager = require('../../src/data/levelManager');
    levelManager.invalidateCache();

    // getUser → load gagal parse → karantina → return default user (bukan crash)
    const user = levelManager.getUser('g_quar', 'u_quar');
    assert.ok(user && typeof user === 'object', 'getUser harus return default object, bukan throw');
    assert.strictEqual(user.xp, 0);

    // File korup harus sudah di-rename jadi .corrupt-<ts>
    const leftovers = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('levels.json.corrupt-'));
    assert.strictEqual(leftovers.length, 1, 'harus ada tepat 1 file karantina');
    assert.ok(fs.readFileSync(path.join(DATA_DIR, leftovers[0]), 'utf8').includes('ini bukan json'));
    // File asli tidak ada lagi (akan ditulis ulang fresh oleh save berikutnya)
    assert.strictEqual(fs.existsSync(target), false);

    // Tulis ulang supaya manager lain (save) tidak bingung — file fresh
    writeDataJSON('levels.json', {});
    levelManager.invalidateCache();
});

test('v3.9.26 GC prune: giveaway ended >30 hari dihapus, aktif & baru tetap', () => {
    const { pruneEndedOlderThan, invalidateCacheNoop } = {
        pruneEndedOlderThan: require('../../src/data/giveawayManager').pruneEndedOlderThan,
        invalidateCacheNoop: null
    };
    const DAY = 86400000;
    const now = Date.now();
    writeDataJSON('giveaways.json', [
        {
            id: 'gw_old_ended',
            ended: true,
            endedAt: now - 40 * DAY,
            endsAt: now - 40 * DAY,
            winnerIds: [],
            participantIds: []
        },
        {
            id: 'gw_new_ended',
            ended: true,
            endedAt: now - 5 * DAY,
            endsAt: now - 5 * DAY,
            winnerIds: [],
            participantIds: []
        },
        { id: 'gw_active', ended: false, endsAt: now + 5 * DAY, winnerIds: [], participantIds: [] },
        { id: 'gw_old_active', ended: false, endsAt: now - 40 * DAY, winnerIds: [], participantIds: [] } // aneh tapi aktif → JANGAN dihapus
    ]);

    const removed = pruneEndedOlderThan(30 * DAY);
    assert.strictEqual(removed, 1, 'cuma gw_old_ended yang boleh kehapus');
    const remaining = readDataJSON('giveaways.json').map(g => g.id);
    assert.deepStrictEqual(remaining.sort(), ['gw_active', 'gw_new_ended', 'gw_old_active']);
});

test('v3.9.26 GC prune: poll closed >30 hari dihapus', () => {
    const { pruneClosedOlderThan } = require('../../src/data/pollManager');
    const DAY = 86400000;
    const now = Date.now();
    writeDataJSON('polls.json', [
        { id: 'p_old', closed: true, closedAt: now - 40 * DAY, createdAt: now - 45 * DAY, options: [] },
        { id: 'p_new', closed: true, closedAt: now - 2 * DAY, createdAt: now - 10 * DAY, options: [] },
        { id: 'p_open', closed: false, createdAt: now - 1 * DAY, options: [] }
    ]);
    const removed = pruneClosedOlderThan(30 * DAY);
    assert.strictEqual(removed, 1);
    const remaining = readDataJSON('polls.json').map(p => p.id);
    assert.deepStrictEqual(remaining.sort(), ['p_new', 'p_open']);
});

test('v3.9.26 GC prune: announcement terkirim >30 hari dihapus, pending tetap', () => {
    const { pruneSentOlderThan } = require('../../src/data/scheduledAnnouncements');
    const DAY = 86400000;
    const now = Date.now();
    writeDataJSON('scheduledAnnouncements.json', [
        { id: 'a_old', sent: true, sentAt: now - 40 * DAY, sendAt: now - 40 * DAY },
        { id: 'a_recent', sent: true, sentAt: now - 3 * DAY, sendAt: now - 3 * DAY },
        { id: 'a_pending', sent: false, sendAt: now + DAY }
    ]);
    const removed = pruneSentOlderThan(30 * DAY);
    assert.strictEqual(removed, 1);
    const remaining = readDataJSON('scheduledAnnouncements.json').map(a => a.id);
    assert.deepStrictEqual(remaining.sort(), ['a_pending', 'a_recent']);
});

test('v3.9.26 cache: automod update-on-save — read berikutnya lihat data baru', () => {
    const automodManager = require('../../src/data/automodManager');
    automodManager.invalidateCache();
    const gid = `test_guild_v26_${Date.now()}`;

    automodManager.setGuildConfig(gid, { enabled: true, spamThreshold: 3 });
    // Tanpa sleep — cache harus sudah sinkron dengan save terbaru (update-on-save)
    const cfg = automodManager.getGuildConfig(gid);
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.spamThreshold, 3);

    // invalidateCache → read fresh dari disk
    automodManager.setGuildConfig(gid, { spamThreshold: 9 });
    automodManager.invalidateCache();
    const cfg2 = automodManager.getGuildConfig(gid);
    assert.strictEqual(cfg2.spamThreshold, 9);

    // Cleanup entry test
    const data = readDataJSON('automod.json');
    delete data[gid];
    writeDataJSON('automod.json', data);
    automodManager.invalidateCache();
});

test('v3.9.26 cache: afkManager getAFKBatch — satu load untuk semua mention', () => {
    const afkManager = require('../../src/data/afkManager');
    afkManager.invalidateCache();
    const gid = `test_guild_v26_afk_${Date.now()}`;

    afkManager.setAFK(gid, 'u1', 'Tidur');
    afkManager.setAFK(gid, 'u2', 'Makan');
    const batch = afkManager.getAFKBatch(gid, ['u1', 'u2', 'u3']);
    assert.strictEqual(Object.keys(batch).length, 2);
    assert.strictEqual(batch.u1.reason, 'Tidur');
    assert.strictEqual(batch.u2.reason, 'Makan');
    assert.strictEqual(batch.u3, undefined);

    // Cleanup
    afkManager.clearAFK(gid, 'u1');
    afkManager.clearAFK(gid, 'u2');
});

test('v3.9.26 /giveaway list: dibatasi 15 terbaru kalau data banyak', async () => {
    const giveawayHandler = require('../../src/commands/giveaway');
    const DAY = 86400000;
    const now = Date.now();
    const gid = `test_guild_v26_gw_${Date.now()}`;
    const giveaways = [];
    for (let i = 0; i < 30; i++) {
        giveaways.push({
            id: `gw_list_${i}`,
            guildId: gid,
            channelId: 'c1',
            prize: `Prize ${i}`,
            winnersCount: 1,
            endsAt: now - i * DAY,
            ended: true,
            endedAt: now - i * DAY,
            winnerIds: ['u1'],
            participantIds: ['u1', 'u2'],
            hostId: 'h1',
            hostTag: 'Host'
        });
    }
    writeDataJSON('giveaways.json', giveaways);

    let replyPayload = null;
    const interaction = {
        commandName: 'giveaway',
        options: { getSubcommand: () => 'list', getString: () => null },
        guild: { id: gid },
        client: { user: { username: 'Thor', displayAvatarURL: () => 'https://x/a.png' } },
        user: { id: 'admin', tag: 'Admin' },
        deferReply: async () => {},
        editReply: async payload => {
            replyPayload = payload;
            return {};
        }
    };
    await giveawayHandler(interaction);

    assert.ok(replyPayload && replyPayload.embeds, 'harus membalas embed');
    const desc = replyPayload.embeds[0].data.description;
    assert.ok(desc.includes('Total **30** giveaway'), 'header harus menyebut total');
    assert.ok(desc.includes('terbaru'), 'harus ada indikator bounding');
    assert.ok(desc.includes('15 terbaru'), 'menampilkan 15 terbaru');
    assert.ok(!desc.includes('gw_list_0'), 'entry paling lama (0) disembunyikan');
    assert.ok(desc.includes('gw_list_29'), 'entry terbaru (29) tampil');
    assert.ok(desc.length <= 4096, 'description harus dalam limit Discord');
});

test('v3.9.26 /giveaway polos (tanpa subcommand): hint penggunaan, bukan crash', async () => {
    const giveawayHandler = require('../../src/commands/giveaway');
    let replyPayload = null;
    const interaction = {
        commandName: 'giveaway',
        options: { getSubcommand: () => null, getString: () => null },
        guild: { id: 'g1' },
        client: { user: {} },
        user: { id: 'admin', tag: 'Admin' },
        reply: async payload => {
            replyPayload = payload;
            return {};
        }
    };
    await giveawayHandler(interaction);
    assert.ok(replyPayload, 'harus membalas hint');
    assert.ok(replyPayload.content.includes('subcommand'));
});

test('v3.9.26 /poll create: question > 250 char ditolak SEBELUM modal/persist', async () => {
    const pollHandler = require('../../src/commands/poll');
    let replyPayload = null;
    let showModalCalled = false;
    const interaction = {
        commandName: 'poll',
        options: {
            getSubcommand: () => 'create',
            getChannel: () => ({ id: 'c1', type: 0 }),
            getString: name => (name === 'question' ? 'x'.repeat(300) : null),
            getBoolean: () => false
        },
        guild: { id: 'g1' },
        client: { user: {} },
        user: { id: 'admin', tag: 'Admin' },
        reply: async payload => {
            replyPayload = payload;
            return {};
        },
        showModal: async () => {
            showModalCalled = true;
        }
    };
    await pollHandler(interaction);
    assert.ok(replyPayload, 'harus membalas error validasi');
    assert.ok(replyPayload.content.includes('250'));
    assert.strictEqual(showModalCalled, false, 'modal TIDAK boleh dibuka untuk input invalid');
});

test('v3.9.26 /poll create: channel voice ditolak dengan pesan jelas', async () => {
    const pollHandler = require('../../src/commands/poll');
    let replyPayload = null;
    const interaction = {
        commandName: 'poll',
        options: {
            getSubcommand: () => 'create',
            getChannel: () => ({ id: 'c_voice', type: 2 }), // 2 = GuildVoice
            getString: name => (name === 'question' ? 'Pertanyaan valid?' : null),
            getBoolean: () => false
        },
        guild: { id: 'g1' },
        client: { user: {} },
        user: { id: 'admin', tag: 'Admin' },
        reply: async payload => {
            replyPayload = payload;
            return {};
        },
        showModal: async () => {}
    };
    await pollHandler(interaction);
    assert.ok(replyPayload.content.includes('text channel'));
});

test('v3.9.26 panel patch contract: imageUrl/thumbnailUrl/footerText sampai ke builder', () => {
    const panelManager = require('../../src/data/panelManager');
    const { buildTicketPanel } = require('../../src/commands/panels');
    panelManager.invalidateCache();

    const panelId = `tp_test_v26_${Date.now()}`;
    // Simulasi hasil /update-panel SETELAH fix mapping: patch pakai key penyimpanan
    panelManager.upsertPanel({
        id: panelId,
        guildId: 'g_test',
        channelId: 'c_test',
        messageId: 'm_test',
        title: 'Panel Test',
        categoryIds: ['transaction'],
        imageUrl: 'https://example.com/img.png',
        thumbnailUrl: 'https://example.com/thumb.png',
        footerText: 'Footer Kustom',
        createdAt: Date.now()
    });
    const patched = panelManager.patchPanel(panelId, { imageUrl: 'https://example.com/new.png' });
    assert.strictEqual(
        patched.imageUrl,
        'https://example.com/new.png',
        'patch imageUrl harus tersimpan di key yang benar'
    );

    // Builder harus ME-LOAD nilai yang sama (inilah bug v3.9.26: patch lama nulis
    // `image` tapi builder baca `imageUrl` → no-op diam-diam)
    const built = buildTicketPanel(patched, {
        guild: { name: 'Test Guild', members: { me: { id: 'bot' } } },
        client: { user: { username: 'Thor', displayAvatarURL: () => 'https://example.com/a.png' } }
    });
    // buildTicketPanel return { embed, components } (bukan EmbedBuilder langsung)
    const embedData = built.embed.data;
    assert.strictEqual(embedData.image.url, 'https://example.com/new.png');
    assert.strictEqual(embedData.thumbnail.url, 'https://example.com/thumb.png');
    assert.strictEqual(embedData.footer.text, 'Footer Kustom');

    // Cleanup
    panelManager.deletePanel(panelId);
    panelManager.invalidateCache();
});

// --- teardown global: restore semua file + buang artefak karantina ---
test('v3.9.26 teardown: restore sandbox', () => {
    restoreSandbox();
    clearQuarantineArtifacts();
    assert.ok(true);
});
