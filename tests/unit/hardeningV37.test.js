/**
 * Unit tests v3.9.37 — hardening & konsistensi pasca-fitur midman/rekber.
 *
 * Yang diuji (bug/issue ditemukan audit menyeluruh "sync semuanya"):
 *   1. Router: `ticket_cat:midman` kini EXACT-match — kategori custom yang
 *      id-nya diawali "midman" (mis. midman_jual) tidak lagi "mati" di
 *      domain midman (fallback tanpa reply), tapi di-route benar ke ticket.
 *   2. findEmptyCategoryWarnings: kategori midman di-skip — warning lama
 *      menyarankan "tambah produk ke kategori midman" (menyesatkan: klik
 *      tombol rekber selalu buka deal, produk tidak pernah tampil).
 *   3. buildTicketPanel (use_dropdown): deskripsi option midman menyebut
 *      deal escrow — bukan "Bantuan / buka tiket langsung" (menyesatkan).
 *   4. auditLog ACTION_LABELS: action MIDMAN_xxx dan SET_MIDMAN_FEE punya label
 *      (sebelumnya fallback ke raw string — inkonsisten dgn konvensi label).
 *   5. /help: Auto-Split 3 kategori (TRANSAKSI/BANTUAN/REKBER), section
 *      Midman/Rekber ada, role midman disebut, versi dinamis dari
 *      package.json (anti stale — dulu hardcode v3.9.26).
 *   6. reconcileZombieDeals: deal non-terminal dengan channel yang sudah
 *      dihapus manual → meta dibersihkan (pembeli/penjual tidak terkunci
 *      selamanya); deal hidup & terminal tidak di-touch; wrapper harian
 *      hanya jalan 1x/hari.
 *   7. Formulir deal 3-langkah: penjual dengan tiket reguler aktif DITOLAK
 *      (v3.9.37 — dulu cuma pembeli yang dicek); happy path tetap jalan.
 *   8. saveTranscript: chunk kosong tidak dikirim (code block blank saat
 *      baris hard-split bersisa tepat CHUNK_SIZE).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: file data produksi di-snapshot & restore ===
// === (pola midman.test.js / ticketCloseButtons.test.js) ===
// ====================================================
const SANDBOX_FILES = ['deals.json', 'config.json', 'tickets.json'];
const backups = [];
for (const f of SANDBOX_FILES) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) {
        const b = p + '.v3937-backup';
        fs.copyFileSync(p, b);
        backups.push({ orig: p, backup: b });
    }
}
process.on('exit', () => {
    for (const { orig, backup } of backups) {
        try {
            fs.copyFileSync(backup, orig);
            fs.rmSync(backup, { force: true });
        } catch (_) {}
    }
    for (const f of SANDBOX_FILES) {
        const p = path.join(dataDir, f);
        if (!backups.some(b => b.orig === p) && fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
            } catch (_) {}
        }
    }
});

function resetDataFile(name, content) {
    const p = path.join(dataDir, name);
    if (content === null) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
        fs.writeFileSync(p, JSON.stringify(content, null, 2));
    }
}

// ====================================================
// === 1. ROUTER — exact match ticket_cat:midman ===
// ====================================================

test('router v3.9.37: kategori custom "midman_jual" (prefix midman) di-route ke TICKET, tidak mati di midman', async () => {
    resetDataFile('config.json', {}); // → DEFAULTS (midman_jual tidak terdaftar)
    const routeInteraction = require('../../src/interactions');
    const replies = [];
    const interaction = {
        id: `v3937-router-${Date.now()}-${Math.random()}`,
        customId: 'ticket_cat:midman_jual',
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => false,
        isModalSubmit: () => false,
        reply: async opts => {
            replies.push(opts);
            return {};
        },
        editReply: async opts => {
            replies.push(opts);
            return {};
        }
    };
    await routeInteraction(interaction);
    // Domain ticket menjawab "kategori tidak ditemukan" — BUKAN dead-air
    // (sebelum fix: jatuh ke fallback midman → console.warn, tanpa reply).
    assert.strictEqual(replies.length, 1, 'interaction harus di-reply domain ticket');
    assert.match(replies[0].content, /midman_jual/);
    assert.match(replies[0].content, /tidak ditemukan/);
});

test('router v3.9.37: tombol persis "ticket_cat:midman" tetap dispatch ke domain midman', async () => {
    resetDataFile('config.json', { roles: { admin: 'ra', midman: 'rm' } });
    const routeInteraction = require('../../src/interactions');
    const interaction = {
        id: `v3937-router2-${Date.now()}-${Math.random()}`,
        customId: 'ticket_cat:midman',
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => false,
        isModalSubmit: () => false,
        // openCreateModal pakai interaction.reply (bukan deferReply).
        user: { id: 'u1', tag: 'Creator#0001' },
        member: { roles: { cache: new Map() } },
        reply: async () => ({}),
        showModal: async () => ({})
    };
    let modalShown = false;
    interaction.showModal = () => {
        modalShown = true;
    };
    try {
        await routeInteraction(interaction);
    } catch (_) {
        // mock tidak lengkap boleh throw SETELAH showModal — yang penting
        // domain midman yang jalan (showModal terpanggil).
    }
    assert.ok(modalShown, 'openCreateModal (domain midman) harus terpanggil');
});

// ====================================================
// === 2. findEmptyCategoryWarnings — midman di-skip ===
// ====================================================

test('findEmptyCategoryWarnings v3.9.37: kategori midman tidak di-warn (bukan kategori produk)', () => {
    const { findEmptyCategoryWarnings } = require('../../src/commands/panels');
    const lines = findEmptyCategoryWarnings(
        { categoryIds: [] },
        {
            ticketCategories: [
                { id: 'midman', label: 'Rekber / Middleman', requiresKey: false, isDefault: false }
            ],
            products: []
        }
    );
    assert.strictEqual(lines.length, 0, 'midman bukan kategori jualan — tidak boleh ada warning "tambah produk"');
});

// ====================================================
// === 3. buildTicketPanel dropdown — deskripsi midman ===
// ====================================================

test('buildTicketPanel v3.9.37: option midman di dropdown menyebut deal/escrow (bukan "buka tiket")', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    resetDataFile('config.json', {});
    const build = buildTicketPanel(
        { useDropdown: true, categoryIds: [], title: 'Panel' },
        {
            client: { user: { username: 'Bot', displayAvatarURL: () => 'http://x/a.png' } }
        }
    );
    const menu = build.components[0].components[0].toJSON();
    const options = menu.options;
    const midmanOpt = options.find(o => o.value === 'midman');
    assert.ok(midmanOpt, 'option midman harus ada di dropdown (DEFAULTS)');
    assert.match(midmanOpt.description, /rekber|escrow|deal/i);
    assert.doesNotMatch(midmanOpt.description, /bantuan|tiket/i);
});

// ====================================================
// === 4. auditLog ACTION_LABELS — label midman ===
// ====================================================

test('auditLog v3.9.37: action MIDMAN_* dan SET_MIDMAN_FEE punya label (bukan raw string)', () => {
    const { ACTION_LABELS } = require('../../src/infra/auditLog');
    const expected = [
        'SET_MIDMAN_FEE',
        'MIDMAN_CREATE',
        'MIDMAN_AGREE',
        'MIDMAN_JOIN',
        'MIDMAN_CANCEL',
        'MIDMAN_FUNDIN',
        'MIDMAN_RECEIVED',
        'MIDMAN_RELEASE',
        'MIDMAN_DISPUTE',
        'MIDMAN_RESOLVE_RELEASE',
        'MIDMAN_RESOLVE_REFUND',
        'MIDMAN_MEMBER_ADD',
        'MIDMAN_MEMBER_REMOVE'
    ];
    for (const action of expected) {
        assert.ok(ACTION_LABELS[action], `ACTION_LABELS.${action} harus ada`);
    }
});

// v3.9.37 FIX: deals.json (data live rekber) bolong dari FILES_TO_BACKUP —
// guard test backupManager cuma memindai file yang ADA di data/ (di dev
// deals.json bisa absen), jadi pin eksplisit di sini supaya regresi
// future-proof. Restore tanpa deals.json = semua deal escrow aktif putus.
test('backup v3.9.37: FILES_TO_BACKUP wajib memuat deals.json (restore tidak boleh putuskan deal rekber)', () => {
    const fs2 = require('fs');
    const path2 = require('path');
    const src = fs2.readFileSync(
        path2.join(__dirname, '..', '..', 'src', 'data', 'backupManager.js'),
        'utf8'
    );
    assert.match(src, /'deals\.json'/, 'deals.json harus ada di FILES_TO_BACKUP');
});

// ====================================================
// === 5. /help — auto-split 3 kategori + midman ===
// ====================================================

test('help v3.9.37: Auto-Split 3 kategori (TRANSAKSI/BANTUAN/REKBER) + section Midman', async () => {
    const replies = [];
    const mockInteraction = {
        user: { toString: () => '<@test>' },
        client: {
            user: {
                username: 'TestBot',
                displayAvatarURL: () => 'http://example.com/avatar.png'
            }
        },
        reply: async opts => {
            replies.push(opts);
            return {};
        }
    };
    const helpHandler = require('../../src/commands/help');
    await helpHandler(mockInteraction);
    const embed = replies[0].embeds[0];
    const allText = embed.data.fields.map(f => f.value).join('\n') + '\n' + embed.data.description;

    // Auto-Split kini 3 kategori — bug user-reported ("masih 2").
    assert.match(allText, /3 kategori/);
    assert.doesNotMatch(allText, /2 kategori/);
    assert.match(allText, /REKBER/);
    assert.match(allText, /midman\.category/);

    // Section + command midman.
    assert.match(allText, /set-midman-fee/);
    assert.match(allText, /midman-deals/);
    assert.match(allText, /set-role midman/);

    // Role list menyebut midman.
    assert.match(allText, /verified\/unverified\/admin\/\*\*midman\*\*/);

    // Versi dinamis dari package.json.
    const { version: pkgVersion } = require('../../package.json');
    assert.match(embed.data.footer.text, new RegExp(`v${pkgVersion.replace(/\./g, '\\.')}`));
});

// ====================================================
// === 6. reconcileZombieDeals — self-healing deal ===
// ====================================================

const mm = require('../../src/data/midmanManager');
const { reconcileZombieDeals, reconcileZombieDealsDaily } = require('../../src/services/schedulerTasks');

function makeGuildForReconcile({ fetch }) {
    const cache = new Map();
    cache.set('ch_live', { id: 'ch_live' });
    return {
        id: 'g_rec',
        channels: {
            cache,
            fetch
        }
    };
}

test('reconcileZombieDeals v3.9.37: deal dengan channel hilang → meta dihapus; deal hidup & terminal tetap', async () => {
    resetDataFile('deals.json', {
        ch_live: { channelId: 'ch_live', guildId: 'g_rec', state: 'WAITING_PAYMENT', buyerId: 'b1', sellerId: 's1' },
        ch_dead: { channelId: 'ch_dead', guildId: 'g_rec', state: 'WAITING_PAYMENT', buyerId: 'b2', sellerId: 's2' },
        ch_terminal: { channelId: 'ch_terminal', guildId: 'g_rec', state: 'COMPLETED', buyerId: 'b3', sellerId: 's3' },
        ch_fetch_err: { channelId: 'ch_err', guildId: 'g_rec', state: 'WAITING_PAYMENT', buyerId: 'b4', sellerId: 's4' },
        // Discord fetch channel terhapus → throw code 10003 (bukan null).
        ch_10003: { channelId: 'ch_10003', guildId: 'g_rec', state: 'WAITING_PAYMENT', buyerId: 'b5', sellerId: 's5' }
    });
    const guild = makeGuildForReconcile({
        // ch_dead → null; ch_10003 → throw code 10003 (keduanya = channel hilang
        // → meta dihapus); ch_err → throw TANPA code (transient — entry tetap).
        fetch: async id => {
            if (id === 'ch_dead') return null;
            if (id === 'ch_err') throw new Error('transient 500');
            if (id === 'ch_10003') {
                const e = new Error('Unknown Channel');
                e.code = 10003;
                throw e;
            }
            return { id };
        }
    });
    const client = { guilds: { cache: new Map([['g_rec', guild]]) } };

    const removed = await reconcileZombieDeals(client);

    assert.strictEqual(removed, 2, 'ch_dead (null) + ch_10003 (error 10003) dibersihkan',
    );
    assert.ok(mm.getDeal('ch_live'), 'deal hidup tetap ada');
    assert.strictEqual(mm.getDeal('ch_dead'), null, 'meta deal zombie dihapus (getDeal → null)');
    assert.strictEqual(mm.getDeal('ch_10003'), null, 'meta deal 10003 dihapus');
    assert.ok(mm.getDeal('ch_terminal'), 'deal terminal tidak di-touch (tidak di daftar aktif)');
    assert.ok(mm.getDeal('ch_fetch_err'), 'transient fetch error → entry tetap, di-retry tick berikutnya');

    // Inti bug: user deal zombie tidak terkunci lagi.
    assert.strictEqual(mm.hasActiveDealFor('g_rec', 'b2'), false, 'buyer deal zombie dibebaskan');
    assert.strictEqual(mm.hasActiveDealFor('g_rec', 's2'), false, 'seller deal zombie dibebaskan');
    assert.strictEqual(mm.hasActiveDealFor('g_rec', 'b5'), false, 'buyer deal 10003 dibebaskan');
    assert.strictEqual(mm.hasActiveDealFor('g_rec', 'b1'), true, 'buyer deal hidup tetap terkunci (benar)');
});

test('reconcileZombieDealsDaily v3.9.37: wrapper harian hanya menjalankan reconcile 1x/hari', async () => {
    resetDataFile('deals.json', {});
    let calls = 0;
    // Spy lewat module registry tidak bisa (function internal) — hitung via
    // efek samping: guild fetch dipanggil per reconcile jalan.
    const guild = makeGuildForReconcile({ fetch: async () => null });
    const client = { guilds: { cache: new Map([['g_rec', guild]]) } };
    const origFetch = guild.channels.fetch;
    guild.channels.fetch = async id => {
        calls++;
        return origFetch(id);
    };
    await reconcileZombieDealsDaily(client);
    await reconcileZombieDealsDaily(client); // kedua kalinya → harus skip
    assert.strictEqual(calls, 0, 'deals.json kosong → tidak ada fetch sama sekali');
    resetDataFile('deals.json', {
        ch_dead: { channelId: 'ch_dead', guildId: 'g_rec', state: 'WAITING_PAYMENT', buyerId: 'b2', sellerId: 's2' }
    });
    await reconcileZombieDealsDaily(client); // hari sama → masih skip
    assert.ok(mm.getDeal('ch_dead'), 'guard harian: reconcile kedua di hari yang sama tidak jalan');
});

// ====================================================
// === 7. Formulir deal 3-langkah — cek tiket penjual ===
// ====================================================

/**
 * Collection palsu (Map + find — mirror discord.js Collection API yang
 * dipakai guild.channels.cache / guild.members.cache).
 */
class FakeCollection extends Map {
    find(pred) {
        for (const v of this.values()) if (pred(v)) return v;
        return undefined;
    }
}

function makeMidmanGuild({ sellerHasTicket }) {
    const members = new FakeCollection();
    members.set('buyer1', { id: 'buyer1', user: { id: 'buyer1', bot: false } });
    members.set('seller1', { id: 'seller1', user: { id: 'seller1', bot: false } });

    const channels = new FakeCollection();
    // Kategori rekber "sudah ada" → skip create kategori.
    channels.set('cat_rec', { id: 'cat_rec', name: '🤝 REKBER', type: 4 });
    if (sellerHasTicket) {
        // Tiket reguler aktif milik seller1 — findActiveTicketFor harus nemu ini.
        channels.set('ch_ticket_seller', {
            id: 'ch_ticket_seller',
            toString: () => '<#ch_ticket_seller>'
        });
    }

    return {
        id: 'g_deal',
        roles: { everyone: { id: 'everyone1' } },
        client: { user: { id: 'bot1' } },
        members: { cache: members },
        channels: {
            cache: channels,
            create: async () => {
                throw new Error('create tidak boleh dipanggil di test ini');
            }
        }
    };
}

function makeFlowInteraction({ type, customId, values, fields, guild }) {
    const replies = [];
    return {
        id: `v3937-${customId}-${Date.now()}-${Math.random()}`,
        customId,
        values,
        fields,
        guild,
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => type === 'button',
        isStringSelectMenu: () => type === 'select',
        isUserSelectMenu: () => type === 'userselect',
        isModalSubmit: () => type === 'modal',
        user: { id: 'creator1', tag: 'Creator#0001' },
        client: { user: { id: 'bot1' } },
        deferReply: async () => {},
        reply: async opts => {
            replies.push(opts);
            return {};
        },
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        _replies: replies
    };
}

test('deal flow v3.9.37: penjual dengan tiket reguler aktif DITOLAK (asimetri diperbaiki)', async () => {
    resetDataFile('config.json', { roles: { admin: 'ra', midman: 'rm' } });
    resetDataFile('deals.json', {});
    resetDataFile('tickets.json', {
        ch_ticket_seller: { userId: 'seller1', guildId: 'g_deal', productName: 'Help', category: 'help' }
    });
    const guild = makeMidmanGuild({ sellerHasTicket: true });
    const midmanDomain = require('../../src/interactions/midman');

    // Langkah 1 — modal item & harga.
    const i1 = makeFlowInteraction({
        type: 'modal',
        customId: 'modal_mm_create',
        fields: {
            getTextInputValue: id => (id === 'mm_field_item' ? 'Akun ML Mythic' : '100000')
        },
        guild
    });
    await midmanDomain(i1);

    // Langkah 2 — pilih pembeli.
    const i2 = makeFlowInteraction({ type: 'userselect', customId: 'mm_pick_buyer', values: ['buyer1'], guild });
    await midmanDomain(i2);

    // Langkah 3 — pilih penjual (punya tiket aktif) → harus ditolak.
    const i3 = makeFlowInteraction({ type: 'userselect', customId: 'mm_pick_seller', values: ['seller1'], guild });
    await midmanDomain(i3);

    const last = i3._replies[i3._replies.length - 1];
    assert.ok(last, 'harus ada reply');
    assert.match(last.content, /seller1.*tiket aktif/i, 'penolakan menyebut tiket aktif penjual');
    assert.match(last.content, /Pilih penjual lain/);
    assert.strictEqual(mm.getDeal('ch_new_deal'), null, 'deal TIDAK boleh dibuat (getDeal → null kalau tidak ada)');

    // Seller tetap tidak di-lock deal (belum ada deal sama sekali).
    assert.strictEqual(mm.hasActiveDealFor('g_deal', 'seller1'), false);
});

test('deal flow v3.9.37 (regression): penjual tanpa tiket aktif → deal tetap dibuat normal', async () => {
    resetDataFile('config.json', { roles: { admin: 'ra', midman: 'rm' }, channels: {} });
    resetDataFile('deals.json', {});
    resetDataFile('tickets.json', {});
    const guild = makeMidmanGuild({ sellerHasTicket: false });
    // Happy path perlu channel deal → allow create.
    guild.channels.create = async opts => {
        assert.ok(opts.name.startsWith('rekber-buyer1'), 'nama channel deal benar');
        return {
            id: 'ch_new_deal',
            send: async () => ({ id: 'msg_board' }),
            delete: async () => {},
            toString: () => '<#ch_new_deal>'
        };
    };
    const midmanDomain = require('../../src/interactions/midman');

    const i1 = makeFlowInteraction({
        type: 'modal',
        customId: 'modal_mm_create',
        fields: {
            getTextInputValue: id => (id === 'mm_field_item' ? 'Akun ML Mythic' : '100000')
        },
        guild
    });
    await midmanDomain(i1);
    const i2 = makeFlowInteraction({ type: 'userselect', customId: 'mm_pick_buyer', values: ['buyer1'], guild });
    await midmanDomain(i2);
    const i3 = makeFlowInteraction({ type: 'userselect', customId: 'mm_pick_seller', values: ['seller1'], guild });
    await midmanDomain(i3);

    const deal = mm.getDeal('ch_new_deal');
    assert.ok(deal, 'deal harus dibuat (happy path tidak rusak oleh cek baru)');
    assert.strictEqual(deal.buyerId, 'buyer1');
    assert.strictEqual(deal.sellerId, 'seller1');
    assert.strictEqual(deal.state, 'WAITING_AGREE');
    const last = i3._replies[i3._replies.length - 1];
    assert.match(last.content, /Deal rekber dibuat/);
});

// ====================================================
// === 8. saveTranscript — tidak ada chunk kosong ===
// ====================================================

test('saveTranscript v3.9.37: baris hard-split sisa tepat 1900 char tidak menghasilkan chunk kosong', async () => {
    const { saveTranscript } = require('../../src/data/ticketManager');
    resetDataFile('config.json', { channels: { transcript: 'ch_transcript' } });

    // Satu pesan user yang panjang: baris transcript-nya harus > CHUNK_SIZE
    // supaya jalur hard-split jalan. Sisa slice dibuat GENAP 1900 + header
    // kecil → kondisi yang dulu menghasilkan chunk '' (code block blank).
    const ts = 1700000000000;
    const author = 'Tester#0001';
    const time = new Date(ts).toLocaleString('id-ID');
    const prefix = `[${time}] ${author}: `;
    // 2×1900 supaya while loop hard-split dua kali, sisa persis 1900.
    const contentLen = 3 * 1900 - prefix.length;
    const content = 'X'.repeat(contentLen);

    const sent = [];
    const transcriptChannel = {
        id: 'ch_transcript',
        send: async opts => {
            sent.push(opts);
            return { id: `m${sent.length}` };
        }
    };
    const ticketChannel = {
        id: 'ch_ticket',
        name: 'ticket-u1',
        guild: { channels: { cache: new Map([['ch_transcript', transcriptChannel]]) } },
        messages: {
            fetch: async () =>
                new Map([
                    [
                        'm1',
                        { createdTimestamp: ts, author: { tag: author, bot: false }, content, embeds: [] }
                    ]
                ])
        }
    };

    const ok = await saveTranscript(ticketChannel, { userId: 'u1', productName: 'P', category: 'transaction' }, { tag: 'A#1', id: 'a1' }, true);
    assert.ok(ok, 'transcript terkirim');

    // Kirim pertama = embed summary; sisanya chunk code block.
    const chunkSends = sent.slice(1);
    assert.ok(chunkSends.length >= 2, 'pesan panjang harus dipecah jadi beberapa chunk');
    for (const s of chunkSends) {
        const m = s.content.match(/```\n([\s\S]*?)\n```/);
        assert.ok(m, 'format code block utuh');
        assert.ok(m[1].trim().length > 0, `chunk tidak boleh kosong (dapat: ${JSON.stringify(s.content.slice(0, 40))})`);
    }
});
