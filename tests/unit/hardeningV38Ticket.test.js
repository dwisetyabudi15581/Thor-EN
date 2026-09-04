/**
 * Unit tests v3.9.38 — hardening domain tiket (Task 3-b).
 *
 * Bug yang diuji (semua terverifikasi audit task 1-b):
 *   FIX 1 (HIGH)   : findActiveTicketFor hapus meta tiket LIVE saat fetch
 *                    transient (429/5xx/network) — sekarang hanya 10003.
 *   FIX 2 (HIGH)   : flow Set Key tanpa gate isCompleted → invoice + stats +
 *                    key DOBEL — sekarang 3 layer (tombol, re-check modal,
 *                    completionLocks per channel).
 *   FIX 3 (MEDIUM) : meta tiket menyimpan LABEL produk (bukan value) → rename
 *                    produk mematahkan lookup; label duplikat resolve salah —
 *                    sekarang meta menyimpan productValue + resolveProduct().
 *   FIX 5 (LOW)    : key kosong/whitespace lolos tersimpan oleh addKey.
 *   FIX 6 (LOW)    : raw key bocor ke console log via pesan error duplikat.
 *   FIX 7 (LOW)    : transcript hanya mengarsipkan 100 pesan terakhir —
 *                    bukti pembayaran di AWAL tiket hilang (paginated sekarang).
 *
 * Sandbox: file data produksi di-snapshot & restore (pola ticketNonKey.test.js).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: snapshot & restore file data produksi ===
// ====================================================
const SANDBOX_FILES = ['tickets.json', 'config.json', 'keys.json', 'scheduledRoles.json', 'stats.json', 'deals.json'];
const backups = new Map();
for (const f of SANDBOX_FILES) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) {
        fs.copyFileSync(p, p + '.v3938-backup');
        backups.set(f, true);
    }
}
process.on('exit', () => {
    for (const f of SANDBOX_FILES) {
        const p = path.join(DATA_DIR, f);
        try {
            if (backups.has(f)) {
                fs.copyFileSync(p + '.v3938-backup', p);
                fs.rmSync(p + '.v3938-backup', { force: true });
            } else if (fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
        } catch (_) {}
    }
});

function resetDataFile(name, content) {
    const p = path.join(DATA_DIR, name);
    if (content === null || content === undefined) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
        fs.writeFileSync(p, JSON.stringify(content, null, 2));
    }
}

const { findActiveTicketFor, createTicket, getTicketMeta, setTicketMeta, resolveProduct, saveTranscript } =
    require('../../src/data/ticketManager');

// ====================================================
// === FIX 1: findActiveTicketFor — error transient vs 10003 ===
// ====================================================

function makeFetchGuild({ cachedEntries = [], fetchImpl }) {
    return {
        id: 'g38',
        channels: {
            cache: new Map(cachedEntries),
            fetch: fetchImpl
        }
    };
}

test('FIX 1: fetch throw code 429 (transient) → meta tiket LIVE DIPERTAHANKAN, return null', async () => {
    resetDataFile('tickets.json', {
        'ch-tr-429': { userId: 'user-429', guildId: 'g38', productName: 'VIP 30 Hari', productValue: 'vip30' }
    });
    const rateLimitErr = new Error('Too many requests');
    rateLimitErr.code = 429;
    const guild = makeFetchGuild({
        fetchImpl: async () => {
            throw rateLimitErr;
        }
    });

    const ch = await findActiveTicketFor(guild, 'user-429');
    assert.strictEqual(ch, null, 'blip transient → tidak ada channel aktif yang bisa di-return');
    // Inti fix: metadata JANGAN terhapus — channel masih hidup, cuma fetch-nya
    // gagal sesaat. Sebelum v3.9.38, meta terhapus → user bisa buka tiket ke-2.
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
    assert.ok(raw['ch-tr-429'], 'metadata tiket live tetap ada (retry percobaan berikutnya)');
});

test('FIX 1: fetch throw code 10003 (Unknown Channel) → meta zombie dihapus', async () => {
    resetDataFile('tickets.json', {
        'ch-zombie-10003': { userId: 'user-z', guildId: 'g38', productName: 'VIP 30 Hari' },
        'ch-other': { userId: 'user-lain', guildId: 'g38', productName: 'Lain' }
    });
    const unknownErr = new Error('Unknown Channel');
    unknownErr.code = 10003;
    const guild = makeFetchGuild({
        fetchImpl: async () => {
            throw unknownErr;
        }
    });

    const ch = await findActiveTicketFor(guild, 'user-z');
    assert.strictEqual(ch, null);
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
    assert.ok(!raw['ch-zombie-10003'], 'metadata zombie terhapus (channel benar-benar sudah tidak ada)');
    assert.ok(raw['ch-other'], 'metadata user lain tidak ikut terhapus');
});

// ====================================================
// === Mock interaction umum (pola ticketCloseButtons.test.js) ===
// ====================================================

const ADMIN_MEMBER = { permissions: { has: () => true }, roles: { cache: new Map() } };

function makeMockInteraction({ customId, type = 'button', id, channel, guild, components, member }) {
    const replies = [];
    const modals = [];
    const interaction = {
        id: id || `v3938-${customId}-${Date.now()}-${Math.random()}`,
        customId,
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => type === 'button',
        isStringSelectMenu: () => type === 'select',
        isUserSelectMenu: () => false,
        isModalSubmit: () => type === 'modal',
        member: member || ADMIN_MEMBER,
        user: { id: 'admin_v3938', tag: 'Admin#0001' },
        channel,
        guild,
        components: components || [],
        client: { user: { username: 'BotTest', displayAvatarURL: () => 'http://x' } },
        reply: async opts => {
            replies.push({ kind: 'reply', opts });
            interaction.replied = true;
            return {};
        },
        editReply: async opts => {
            replies.push({ kind: 'editReply', opts });
            return {};
        },
        followUp: async opts => {
            replies.push({ kind: 'followUp', opts });
            return {};
        },
        update: async opts => {
            replies.push({ kind: 'update', opts });
            interaction.replied = true;
            return {};
        },
        deferReply: async () => {
            interaction.deferred = true;
            return {};
        },
        deferUpdate: async () => {
            interaction.deferred = true;
            return {};
        },
        showModal: async modal => {
            modals.push(modal);
            return {};
        },
        _replies: replies,
        _modals: modals
    };
    return interaction;
}

function seedKeyTicketConfig() {
    resetDataFile('config.json', {
        roles: { admin: 'role-admin' },
        products: [
            {
                label: 'VIP 30 Hari',
                value: 'vip30',
                price: 'Rp 30.000',
                category: 'transaction',
                requiresKey: true,
                roleId: 'role-vip',
                days: 30
            }
        ]
    });
}

function makeTicketChannel(id) {
    return { id, topic: '', send: async () => ({}) };
}

// ====================================================
// === FIX 2: gate isCompleted + completionLocks ===
// ====================================================

test('FIX 2a: tombol ticket_set_key pada tiket isCompleted → modal TIDAK dibuka (ditolak)', async () => {
    seedKeyTicketConfig();
    resetDataFile('tickets.json', {});
    setTicketMeta('ch-done-1', {
        userId: 'buyer-1',
        productName: 'VIP 30 Hari',
        productValue: 'vip30',
        price: 'Rp 30.000',
        guildId: 'g38',
        category: 'transaction',
        requiresKey: true,
        isTransaction: true,
        isCompleted: true
    });

    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'ticket_set_key',
        channel: makeTicketChannel('ch-done-1')
    });
    await routeInteraction(interaction);

    assert.strictEqual(interaction._modals.length, 0, 'modal Set Key tidak boleh dibuka untuk tiket selesai');
    assert.ok(interaction._replies.length > 0, 'admin dapat jawaban');
    assert.match(interaction._replies[0].opts.content, /sudah di-set sebelumnya/);
});

test('FIX 2b: modal_set_key submit saat meta isCompleted → aborted SEBELUM side effect (tidak ada key/invoice)', async () => {
    seedKeyTicketConfig();
    resetDataFile('tickets.json', {});
    resetDataFile('keys.json', []);
    setTicketMeta('ch-done-2', {
        userId: 'buyer-2',
        productName: 'VIP 30 Hari',
        productValue: 'vip30',
        price: 'Rp 30.000',
        guildId: 'g38',
        category: 'transaction',
        requiresKey: true,
        isTransaction: true,
        isCompleted: true
    });

    let memberFetchCalled = false;
    const guild = {
        id: 'g38',
        roles: { cache: new Map([['role-vip', { id: 'role-vip', name: 'VIP' }]]) },
        members: {
            fetch: async () => {
                memberFetchCalled = true;
                throw new Error('members.fetch tidak boleh dipanggil — abort harus terjadi sebelum side effect');
            }
        }
    };

    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'modal_set_key:vip30',
        type: 'modal',
        channel: makeTicketChannel('ch-done-2'),
        guild,
        components: [{ components: [{ value: 'KEY-DOBEL-XYZ' }] }]
    });
    await routeInteraction(interaction);

    assert.ok(interaction._replies.length > 0, 'admin dapat jawaban');
    const msg = interaction._replies[interaction._replies.length - 1].opts.content;
    assert.match(msg, /sudah selesai diproses admin lain/);
    assert.strictEqual(memberFetchCalled, false, 'flow berhenti sebelum fetch member (belum ada side effect)');
    // Tidak ada key tersimpan — invoice juga tidak mungkin terkirim (flow aborted).
    assert.strictEqual(require('../../src/data/keyManager').getAllKeys().length, 0, 'keys.json tetap kosong');
});

test('FIX 2c: channel ter-lock oleh admin lain → submit kedua DITOLAK "⏳", submit pertama tetap selesai', async () => {
    seedKeyTicketConfig();
    resetDataFile('tickets.json', {});
    resetDataFile('keys.json', []);
    resetDataFile('scheduledRoles.json', []);
    resetDataFile('stats.json', {});
    setTicketMeta('ch-race-1', {
        userId: 'buyer-race',
        productName: 'VIP 30 Hari',
        productValue: 'vip30',
        price: 'Rp 30.000',
        guildId: 'g38',
        category: 'transaction',
        requiresKey: true,
        isTransaction: true
    });

    // Admin A: guild.members.fetch digantung (simulasi network lambat) — lock
    // ch-race-1 dipegang oleh A sampai promise ini di-resolve.
    let resolveMemberFetch;
    const memberFetchPromise = new Promise(res => {
        resolveMemberFetch = res;
    });
    const guildA = {
        id: 'g38',
        roles: { cache: new Map([['role-vip', { id: 'role-vip', name: 'VIP' }]]) },
        members: { fetch: () => memberFetchPromise }
    };
    const buyerMember = {
        id: 'buyer-race',
        user: { id: 'buyer-race', tag: 'Buyer#0001', username: 'buyerrace', displayAvatarURL: () => 'http://x' },
        roles: { cache: new Map(), add: async () => ({}) },
        send: async () => ({})
    };

    const routeInteraction = require('../../src/interactions');
    const interactionA = makeMockInteraction({
        customId: 'modal_set_key:vip30',
        type: 'modal',
        id: `v3938-race-A-${Date.now()}`,
        channel: makeTicketChannel('ch-race-1'),
        guild: guildA,
        components: [{ components: [{ value: 'KEY-RACE-1' }] }]
    });
    const promiseA = routeInteraction(interactionA);
    await new Promise(res => setImmediate(res)); // pastikan prefix sinkron A (lock acquire) jalan

    // Admin B submit untuk channel yang sama saat A masih memproses.
    const interactionB = makeMockInteraction({
        customId: 'modal_set_key:vip30',
        type: 'modal',
        id: `v3938-race-B-${Date.now()}`,
        channel: makeTicketChannel('ch-race-1'),
        guild: guildA,
        components: [{ components: [{ value: 'KEY-RACE-2' }] }]
    });
    await routeInteraction(interactionB);
    assert.ok(interactionB._replies.length > 0, 'submit B dapat jawaban');
    assert.match(interactionB._replies[0].opts.content, /sedang diproses admin lain/);

    // Selesaikan flow A → lock lepas, key A tersimpan.
    resolveMemberFetch(buyerMember);
    await promiseA;

    const { getAllKeys } = require('../../src/data/keyManager');
    const keys = getAllKeys();
    assert.strictEqual(keys.length, 1, 'hanya key dari submit A yang tersimpan (B ditolak)');
    assert.strictEqual(keys[0].key, 'KEY-RACE-1');
    const meta = getTicketMeta('ch-race-1', '');
    assert.strictEqual(meta.isCompleted, true, 'patch isCompleted oleh A jalan normal');
});

// ====================================================
// === FIX 3: productValue di meta + resolveProduct ===
// ====================================================

test('FIX 3a: createTicket menyimpan productValue (ID stabil) di samping productName (label)', async () => {
    resetDataFile('tickets.json', {});
    resetDataFile('config.json', { roles: { admin: 'role-admin' } });
    resetDataFile('deals.json', []);

    const created = [];
    const guild = {
        id: 'g-create',
        roles: { everyone: { id: 'role-everyone' } },
        client: { user: { id: 'bot-v3938' } },
        channels: {
            cache: {
                get: () => undefined,
                find: () => undefined
            },
            create: async opts => {
                const ch = {
                    id: `ch-created-${created.length + 1}`,
                    name: opts.name,
                    topic: opts.topic || '',
                    send: async () => ({})
                };
                created.push({ ch, opts });
                return ch;
            }
        }
    };
    const interaction = {
        guild,
        user: { id: 'user-create' },
        client: { user: { username: 'BotTest', displayAvatarURL: () => 'http://x' } },
        editReply: async () => ({})
    };

    await createTicket(interaction, {
        label: 'VIP 30 Hari',
        value: 'vip30',
        price: 'Rp 30.000',
        category: 'transaction',
        requiresKey: true
    });

    // created[0] = kategori, created[1] = channel tiket.
    assert.strictEqual(created.length, 2, 'kategori + channel tiket dibuat');
    const meta = getTicketMeta(created[1].ch.id, '');
    assert.ok(meta, 'meta tiket tersimpan');
    assert.strictEqual(meta.productName, 'VIP 30 Hari', 'label tetap disimpan (display/backward compat)');
    assert.strictEqual(meta.productValue, 'vip30', 'value stabil ikut disimpan — rename-proof');
});

test('FIX 3b: resolveProduct — label di-rename, productValue tetap resolve ke produk yang benar', () => {
    const config = {
        products: [
            // Admin me-rename "VIP 30 Hari" → "VIP 1 Bulan" via /update-product.
            { label: 'VIP 1 Bulan', value: 'vip30', price: 'Rp 30.000', roleId: 'r1' }
        ]
    };
    const meta = { productName: 'VIP 30 Hari', productValue: 'vip30' };
    const product = resolveProduct(config, meta);
    assert.ok(product, 'produk tetap ketemu lewat value walaupun label sudah berubah');
    assert.strictEqual(product.value, 'vip30');
    assert.strictEqual(product.label, 'VIP 1 Bulan', 'label TERKINI yang dipakai untuk display');
});

test('FIX 3c: resolveProduct — tiket legacy (tanpa productValue) tetap resolve by label', () => {
    const config = {
        products: [{ label: 'VIP 30 Hari', value: 'vip30', price: 'Rp 30.000', roleId: 'r1' }]
    };
    // Meta v3.9.1–v3.9.37: hanya punya productName (label beku).
    const product = resolveProduct(config, { productName: 'VIP 30 Hari' });
    assert.ok(product, 'tiket legacy tetap resolve (label fallback)');
    assert.strictEqual(product.value, 'vip30');
});

test('FIX 3d: resolveProduct — label duplikat antar produk → productValue menentukan produk yang benar', () => {
    const config = {
        products: [
            { label: 'Paket VIP', value: 'vip_a', roleId: 'r-a' },
            { label: 'Paket VIP', value: 'vip_b', roleId: 'r-b' }
        ]
    };
    // Lookup by label saja (perilaku lama) selalu ambil yang pertama → salah.
    const product = resolveProduct(config, { productName: 'Paket VIP', productValue: 'vip_b' });
    assert.ok(product);
    assert.strictEqual(product.value, 'vip_b', 'value di meta menentukan produk yang tepat (bukan urutan label)');
    assert.strictEqual(product.roleId, 'r-b');
    // resolveProduct(null) → null (defensive).
    assert.strictEqual(resolveProduct(config, null), null);
});

// ====================================================
// === FIX 5: key kosong/whitespace ===
// ====================================================

test('FIX 5c: addKey menolak key kosong/whitespace; key di-trim sebelum disimpan', () => {
    resetDataFile('keys.json', []);
    const { addKey, getAllKeys } = require('../../src/data/keyManager');
    const base = { userId: 'u-v38', roleId: 'r-v38', productName: 'P', days: 0 };

    assert.throws(() => addKey({ ...base, key: '' }), /Key tidak boleh kosong/);
    assert.throws(() => addKey({ ...base, key: '   ' }), /Key tidak boleh kosong/);
    assert.throws(() => addKey({ ...base, key: null }), /Key tidak boleh kosong/);
    assert.throws(() => addKey({ ...base }), /Key tidak boleh kosong/);
    assert.strictEqual(getAllKeys().length, 0, 'tidak ada key blank yang tersimpan');

    // Spasi di pinggir dibersihkan — dup-check & penyimpanan pakai versi trim.
    const entry = addKey({ ...base, key: '  ABC-123-XYZ  ' });
    assert.strictEqual(entry.key, 'ABC-123-XYZ', 'key disimpan versi ter-trim');
});

// ====================================================
// === FIX 6: raw key tidak bocor ke log lewat error duplikat ===
// ====================================================

test('FIX 6c: pesan error key duplikat TIDAK menyertakan nilai key', () => {
    resetDataFile('keys.json', []);
    const { addKey } = require('../../src/data/keyManager');
    const SECRET = 'SECRET-KEY-XYZ-987';
    addKey({ key: SECRET, userId: 'u1', roleId: 'r', productName: 'P', days: 0 });

    // Error ini mengalir ke console.warn handler → tidak boleh berisi key.
    assert.throws(
        () => addKey({ key: SECRET, userId: 'u2', roleId: 'r', productName: 'P', days: 0 }),
        err => {
            assert.ok(!err.message.includes(SECRET), 'pesan error tidak boleh menyertakan nilai key');
            assert.match(err.message, /sudah ada/i, 'tetap jelas ini duplikat');
            return true;
        }
    );
});

// ====================================================
// === FIX 7: transcript paginated — pesan AWAL ikut terarsip ===
// ====================================================

test('FIX 7: saveTranscript >100 pesan → bukti pembayaran di AWAL tiket ikut terarsip (paginated)', async () => {
    resetDataFile('config.json', { channels: { transcript: 'ch-trans' } });

    // 150 pesan: id naik seiring waktu (snowflake), konten pesan #1 = bukti bayar.
    const msgs = [];
    for (let i = 0; i < 150; i++) {
        msgs.push({
            id: String(100000 + i),
            createdTimestamp: 1700000000000 + i * 1000,
            author: { bot: false, tag: `user${i}#0001` },
            embeds: [],
            content: i === 0 ? 'bukti-transfer-mulai-tiket' : `isi-pesan-${i}`
        });
    }

    const sent = [];
    const transcriptChannel = {
        send: async opts => {
            sent.push(opts);
            return {};
        }
    };
    // Mock fetch mengikuti kontrak API Discord: urut terbaru→terlama, page of 100,
    // `before` = exclusive cursor ke pesan lebih lama.
    const ticketChannel = {
        id: 'ch-t7',
        name: 'ticket-t7',
        guild: { channels: { cache: new Map([['ch-trans', transcriptChannel]]) } },
        messages: {
            fetch: async opts => {
                const sorted = [...msgs].sort((a, b) => Number(b.id) - Number(a.id));
                const page = opts.before ? sorted.filter(m => Number(m.id) < Number(opts.before)) : sorted;
                return new Map(page.slice(0, 100).map(m => [m.id, m]));
            }
        }
    };

    const ok = await saveTranscript(
        ticketChannel,
        { userId: 'u-t7', productName: 'VIP 30 Hari', price: 'Rp 30.000', category: 'transaction', createdAt: Date.now() },
        { tag: 'Admin#0001', id: 'admin-t7' },
        true
    );

    assert.strictEqual(ok, true, 'transcript sukses terkirim');
    const text = sent
        .map(s => s.content || '')
        .join('\n');
    assert.match(text, /bukti-transfer-mulai-tiket/, 'pesan PERTAMA (bukti bayar) ikut — dulu hilang karena cap 100');
    assert.match(text, /isi-pesan-149/, 'pesan TERAKHIR juga ada');
    assert.match(text, /isi-pesan-50/, 'pesan di tengah ada');
});
