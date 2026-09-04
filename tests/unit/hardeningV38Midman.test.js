/**
 * Unit tests v3.9.38 — hardening domain midman/rekber (task 3-a).
 *
 * Bug yang diuji (semua fix v3.9.38 di src/interactions/midman.js +
 * src/data/midmanManager.js):
 *   1. FIX 3 — parsePriceNumber: "1.5m" tidak lagi jadi 15.000.000 (desimal
 *      dibaca sebagai digit ekstra = harga salah 10x). Dengan suffix k/m,
 *      sisa `.`/`,` = invalid. Tanpa suffix, `.`/`,` hanya boleh pemisah
 *      ribuan dengan jenis separator konsisten.
 *   2. FIX 1 — handlePickMember/handleRemovePick kini ikut transitionLocks
 *      (lock per-deal yang sama dengan handleEvent): saat lock dipegang,
 *      klik ditolak "sedang diproses" TANPA menyentuh permission channel.
 *   3. FIX 1 — fresh re-read: transisi state tervalidasi (fundin) yang
 *      tersimpan TEPAT selama await permissionOverwrites TIDAK di-revert
 *      oleh stale write observer (state + history tetap utuh).
 *   4. FIX 2 — anti double-submit: sesi pending dihapus SEBELUM await create
 *      channel → submit kedua dropdown penjual ditolak "kedaluwarsa" →
 *      hanya SATU deal yang terbentuk.
 *   5. FIX 2 — re-check "deal aktif" tepat sebelum setDeal: deal lain yang
 *      ter-commit di tengah await create → channel baru dibersihkan & deal
 *      TOCTOU tidak tersimpan.
 *   6. FIX 5 — creator pihak ketiga tercatat sebagai observer pertama deal
 *      (dulu hanya dapat akses channel, tidak bisa dikeluarkan lewat tombol ➖).
 *   7. FIX 4 — handleEvent deferReply di awal; konfirmasi/guard lewat
 *      editReply (safeEditReply), bukan interaction.reply setelah beberapa
 *      await (window ack 3 detik Discord).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MessageFlags } = require('discord.js');

const dataDir = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: file data produksi di-snapshot & restore ===
// === (pola hardeningV37.test.js / midman.test.js)      ===
// ====================================================
const SANDBOX_FILES = ['deals.json', 'config.json', 'tickets.json'];
const backups = [];
for (const f of SANDBOX_FILES) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) {
        const b = p + '.v3938-backup';
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

const mm = require('../../src/data/midmanManager');
const midmanDomain = require('../../src/interactions/midman');

// ====================================================
// === 1. FIX 3 — parsePriceNumber ===
// ====================================================

test('parsePriceNumber v3.9.38: desimal + suffix k/m → invalid (0), bukan 10x harga', () => {
    // Bug lama: "1.5m" → "15" × 1e6 = 15.000.000 (harga termakan 10x).
    assert.strictEqual(mm.parsePriceNumber('1.5m'), 0);
    assert.strictEqual(mm.parsePriceNumber('0.5k'), 0);
    assert.strictEqual(mm.parsePriceNumber('2.5k'), 0);
    assert.strictEqual(mm.parsePriceNumber('1,5m'), 0);
    assert.strictEqual(mm.parsePriceNumber('0.5M'), 0);
});

test('parsePriceNumber v3.9.38: tanpa suffix, separator harus pemisah ribuan konsisten', () => {
    assert.strictEqual(mm.parsePriceNumber('2.5'), 0); // desimal, bukan grup ribuan
    assert.strictEqual(mm.parsePriceNumber('1,5'), 0);
    assert.strictEqual(mm.parsePriceNumber('100.00'), 0); // grup 2 digit — bukan ribuan
    assert.strictEqual(mm.parsePriceNumber('1.000,000'), 0); // campur dua jenis separator
    assert.strictEqual(mm.parsePriceNumber('100000.'), 0); // trailing separator
});

test('parsePriceNumber v3.9.38 (regression): format sah tetap ter-parse benar', () => {
    assert.strictEqual(mm.parsePriceNumber('500000'), 500000);
    assert.strictEqual(mm.parsePriceNumber('500k'), 500000);
    assert.strictEqual(mm.parsePriceNumber('1m'), 1000000);
    assert.strictEqual(mm.parsePriceNumber('1.000.000'), 1000000);
    assert.strictEqual(mm.parsePriceNumber('1,000,000'), 1000000);
    assert.strictEqual(mm.parsePriceNumber('100.000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('100,000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('Rp100.000'), 100000);
    assert.strictEqual(mm.parsePriceNumber('rp 100000'), 100000);
    assert.strictEqual(mm.parsePriceNumber(50000), 50000);
    assert.strictEqual(mm.parsePriceNumber('abc'), 0);
    assert.strictEqual(mm.parsePriceNumber('0'), 0);
});

// ====================================================
// === 2. Mock infrastructure (pola hardeningV37) ===
// ====================================================

/** Collection palsu (Map + find — mirror discord.js Collection API). */
class FakeCollection extends Map {
    find(pred) {
        for (const v of this.values()) if (pred(v)) return v;
        return undefined;
    }
}

/**
 * Interaction mock — semua reply/edit/defer direkam ke array terpisah supaya
 * test FIX 4 bisa membedakan reply baru vs edit deferred reply.
 * Default aktor: user 'mid-1' dengan role midman 'rm' (bukan admin Discord).
 */
function makeInteraction({ type, customId, values, fields, channel, guild, userId, userTag }) {
    const replies = [];
    const edits = [];
    const defers = [];
    return {
        id: `v38-${customId}-${Date.now()}-${Math.random()}`,
        customId,
        values,
        fields,
        channel,
        guild,
        client: { user: { id: 'bot1' } },
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => type === 'button',
        isStringSelectMenu: () => type === 'select',
        isUserSelectMenu: () => type === 'userselect',
        isModalSubmit: () => type === 'modal',
        user: { id: userId || 'mid-1', tag: userTag || 'Midman#0001' },
        member: {
            permissions: { has: () => false },
            roles: { cache: new Map([['rm', { id: 'rm' }]]) }
        },
        deferReply: async opts => {
            defers.push(opts);
            return {};
        },
        reply: async opts => {
            replies.push(opts);
            return {};
        },
        editReply: async opts => {
            edits.push(opts);
            return {};
        },
        _replies: replies,
        _edits: edits,
        _defers: defers
    };
}

/** Channel deal mock — mencatat berapa kali permission & send disentuh. */
function makeDealChannel({ id, onPermEdit, onPermDelete }) {
    const sent = [];
    return {
        id,
        toString: () => `<#${id}>`,
        permissionOverwrites: {
            edit: async (...args) => {
                if (onPermEdit) await onPermEdit(...args);
            },
            delete: async (...args) => {
                if (onPermDelete) await onPermDelete(...args);
            }
        },
        send: async opts => {
            sent.push(opts);
            return { id: `msg-${id}` };
        },
        _sent: sent
    };
}

/** Guild mock — members (buyer1/seller1/witness1) + kategori rekber + create. */
function makeV38Guild({ guildId, createImpl }) {
    const members = new FakeCollection();
    members.set('buyer1', { id: 'buyer1', user: { id: 'buyer1', bot: false } });
    members.set('seller1', { id: 'seller1', user: { id: 'seller1', bot: false } });
    members.set('witness1', { id: 'witness1', user: { id: 'witness1', bot: false } });
    const channels = new FakeCollection();
    // Kategori rekber "sudah ada" → skip create kategori.
    channels.set('cat_rec', { id: 'cat_rec', name: '🤝 REKBER', type: 4 });
    return {
        id: guildId,
        roles: { everyone: { id: 'everyone1' } },
        client: { user: { id: 'bot1' } },
        members: { cache: members },
        channels: {
            cache: channels,
            create: createImpl || (async () => {
                throw new Error('channels.create tidak boleh dipanggil di test ini');
            })
        }
    };
}

/** Seed satu deal WAITING_PAYMENT ke deals.json. */
function seedDeal(channelId, overrides = {}) {
    const deal = {
        channelId,
        guildId: 'g_v38',
        buyerId: 'buyer1',
        sellerId: 'seller1',
        buyerAgreed: true,
        sellerAgreed: true,
        observers: [],
        item: 'Akun ML Mythic',
        priceNum: 100000,
        fee: 5000,
        feeMode: 'percent',
        feeValue: 5,
        state: 'WAITING_PAYMENT',
        boardMessageId: null, // null → refreshBoard no-op (skip mock board edit)
        createdBy: 'creator1',
        history: [],
        ...overrides
    };
    resetDataFile('deals.json', { [channelId]: deal });
    return deal;
}

function seedConfig() {
    resetDataFile('config.json', { roles: { admin: 'ra', midman: 'rm' }, channels: {} });
}

// ====================================================
// === 3. FIX 1 — lock per-deal pada kelola observer ===
// ====================================================

test('v3.9.38 FIX 1: mm_pick_member saat transitionLocks dipegang → ditolak tanpa menyentuh permission', async () => {
    seedConfig();
    seedDeal('ch_v38_lock', {});
    mm.transitionLocks.add('ch_v38_lock'); // handleEvent sedang memproses transisi
    try {
        let permEdits = 0;
        const dealChannel = makeDealChannel({
            id: 'ch_v38_lock',
            onPermEdit: () => {
                permEdits++;
            }
        });
        const guild = makeV38Guild({ guildId: 'g_v38' });
        const interaction = makeInteraction({
            type: 'userselect',
            customId: 'mm_pick_member',
            values: ['witness1'],
            channel: dealChannel,
            guild
        });
        await midmanDomain(interaction);

        const last = interaction._edits[interaction._edits.length - 1];
        assert.ok(last, 'harus ada balasan');
        assert.match(last.content, /sedang diproses/i);
        assert.strictEqual(permEdits, 0, 'permissionOverwrites.edit TIDAK boleh dipanggil saat lock dipegang');
        assert.deepStrictEqual(mm.getDeal('ch_v38_lock').observers, [], 'observers tidak berubah');
    } finally {
        mm.transitionLocks.delete('ch_v38_lock');
    }
});

test('v3.9.38 FIX 1: mm_remove_pick saat transitionLocks dipegang → ditolak tanpa menyentuh permission', async () => {
    seedConfig();
    seedDeal('ch_v38_lock2', { observers: ['witness1'] });
    mm.transitionLocks.add('ch_v38_lock2');
    try {
        let permDeletes = 0;
        const dealChannel = makeDealChannel({
            id: 'ch_v38_lock2',
            onPermDelete: () => {
                permDeletes++;
            }
        });
        const guild = makeV38Guild({ guildId: 'g_v38' });
        const interaction = makeInteraction({
            type: 'select',
            customId: 'mm_remove_pick',
            values: ['witness1'],
            channel: dealChannel,
            guild
        });
        await midmanDomain(interaction);

        const last = interaction._edits[interaction._edits.length - 1];
        assert.ok(last, 'harus ada balasan');
        assert.match(last.content, /sedang diproses/i);
        assert.strictEqual(permDeletes, 0, 'permissionOverwrites.delete TIDAK boleh dipanggil saat lock dipegang');
        assert.deepStrictEqual(mm.getDeal('ch_v38_lock2').observers, ['witness1'], 'observers tidak berubah');
    } finally {
        mm.transitionLocks.delete('ch_v38_lock2');
    }
});

// ====================================================
// === 4. FIX 1 — fresh re-read (transisi tidak di-revert) ===
// ====================================================

test('v3.9.38 FIX 1: mm_pick_member — transisi fundin di tengah await permission TIDAK di-revert (fresh re-read)', async () => {
    seedConfig();
    seedDeal('ch_v38_race', {});
    let permEdits = 0;
    const dealChannel = makeDealChannel({
        id: 'ch_v38_race',
        // Grant permission "lambat" — selama await, handleEvent lain (simulasi)
        // menyimpan transisi fundin tervalidasi ke deals.json.
        onPermEdit: async () => {
            permEdits++;
            await new Promise(r => setTimeout(r, 10));
            const concurrent = mm.getDeal('ch_v38_race');
            mm.recordTransition(concurrent, 'fundin', { id: 'mid-2', tag: 'Midman#2' });
            mm.setDeal('ch_v38_race', concurrent);
        }
    });
    const guild = makeV38Guild({ guildId: 'g_v38' });
    const interaction = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_member',
        values: ['witness1'],
        channel: dealChannel,
        guild
    });
    await midmanDomain(interaction);

    const after = mm.getDeal('ch_v38_race');
    // Sebelum fix: stale write menimpa fundin → state balik WAITING_PAYMENT.
    assert.strictEqual(after.state, 'WAITING_DELIVERY', 'fundin tetap utuh (tidak di-revert oleh stale write)');
    assert.ok(after.observers.includes('witness1'), 'observer tetap ditambahkan pada objek fresh');
    assert.strictEqual(after.history.filter(h => h.event === 'fundin').length, 1, 'history fundin tidak hilang');
    assert.ok(after.history.some(h => /Member ditambahkan/.test(h.event)), 'history member-add tercatat');
    assert.strictEqual(permEdits, 1);
    assert.strictEqual(mm.transitionLocks.has('ch_v38_race'), false, 'lock dilepas setelah selesai');
});

test('v3.9.38 FIX 1: mm_remove_pick — transisi fundin di tengah await permission TIDAK di-revert (fresh re-read)', async () => {
    seedConfig();
    seedDeal('ch_v38_rm', { observers: ['witness1'] });
    const dealChannel = makeDealChannel({
        id: 'ch_v38_rm',
        onPermDelete: async () => {
            await new Promise(r => setTimeout(r, 10));
            const concurrent = mm.getDeal('ch_v38_rm');
            mm.recordTransition(concurrent, 'fundin', { id: 'mid-2', tag: 'Midman#2' });
            mm.setDeal('ch_v38_rm', concurrent);
        }
    });
    const guild = makeV38Guild({ guildId: 'g_v38' });
    const interaction = makeInteraction({
        type: 'select',
        customId: 'mm_remove_pick',
        values: ['witness1'],
        channel: dealChannel,
        guild
    });
    await midmanDomain(interaction);

    const after = mm.getDeal('ch_v38_rm');
    assert.strictEqual(after.state, 'WAITING_DELIVERY', 'fundin tetap utuh (tidak di-revert oleh stale write)');
    assert.deepStrictEqual(after.observers, [], 'observer dikeluarkan dari objek fresh');
    assert.strictEqual(after.history.filter(h => h.event === 'fundin').length, 1, 'history fundin tidak hilang');
    assert.ok(after.history.some(h => /Member dikeluarkan/.test(h.event)), 'history member-remove tercatat');
    assert.strictEqual(mm.transitionLocks.has('ch_v38_rm'), false, 'lock dilepas setelah selesai');
});

// ====================================================
// === 5. FIX 2 — creation TOCTOU / double-submit ===
// ====================================================

test('v3.9.38 FIX 2: mm_pick_seller double-submit saat create masih jalan → submit kedua ditolak, hanya 1 deal', async () => {
    seedConfig();
    resetDataFile('deals.json', {});
    resetDataFile('tickets.json', {});

    // channels.create "lambat" (jaringan) — gate dikontrol manual dari test.
    let resolveCreate;
    const createGate = new Promise(res => {
        resolveCreate = res;
    });
    const guild = makeV38Guild({
        guildId: 'g_v38c',
        createImpl: async () => {
            await createGate;
            return {
                id: 'ch_new_deal_c',
                toString: () => '<#ch_new_deal_c>',
                send: async () => ({ id: 'msg_board' }),
                delete: async () => {}
            };
        }
    });

    // Langkah 1-2: modal item+harga, lalu pilih pembeli.
    const i1 = makeInteraction({
        type: 'modal',
        customId: 'modal_mm_create',
        fields: { getTextInputValue: id => (id === 'mm_field_item' ? 'Akun ML Mythic' : '100000') },
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i1);
    const i2 = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_buyer',
        values: ['buyer1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i2);

    // Langkah 3 pertama — jalan sampai suspends di await channels.create.
    const i3a = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_seller',
        values: ['seller1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    const p1 = midmanDomain(i3a);
    await new Promise(r => setImmediate(r)); // biarkan i3a lewat validasi + hapus sesi pending

    // Submit kedua (double-click dropdown) saat create masih berjalan.
    const i3b = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_seller',
        values: ['seller1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i3b);
    const lastB = i3b._edits[i3b._edits.length - 1];
    assert.ok(lastB, 'submit kedua harus dijawab');
    assert.match(lastB.content, /kedaluwarsa/i, 'sesi pending sudah dihapus sebelum await → ditolak sebagai expired');

    // Selesaikan create pertama.
    resolveCreate();
    await p1;

    const all = mm.loadDeals();
    assert.strictEqual(Object.keys(all).length, 1, 'hanya SATU deal yang terbentuk (tanpa duplikat)');
    assert.ok(all['ch_new_deal_c'], 'deal pertama tersimpan');
    const lastA = i3a._edits[i3a._edits.length - 1];
    assert.match(lastA.content, /Deal rekber dibuat/, 'submit pertama sukses normal');
});

test('v3.9.38 FIX 2: deal lain ter-commit di tengah await create → channel dibersihkan & deal TOCTOU tidak tersimpan', async () => {
    seedConfig();
    resetDataFile('deals.json', {});
    resetDataFile('tickets.json', {});

    let deleted = false;
    const guild = makeV38Guild({
        guildId: 'g_v38d',
        createImpl: async () => {
            // Deal LAIN untuk seller1 ter-commit saat create masih berjalan
            // (race nyata dua pembuat deal untuk penjual yang sama).
            await new Promise(r => setTimeout(r, 5));
            mm.setDeal('ch_other_v38d', {
                channelId: 'ch_other_v38d',
                guildId: 'g_v38d',
                buyerId: 'buyerX',
                sellerId: 'seller1',
                state: 'WAITING_PAYMENT'
            });
            return {
                id: 'ch_new_deal_d',
                toString: () => '<#ch_new_deal_d>',
                send: async () => ({ id: 'msg_board' }),
                delete: async () => {
                    deleted = true;
                }
            };
        }
    });

    const i1 = makeInteraction({
        type: 'modal',
        customId: 'modal_mm_create',
        fields: { getTextInputValue: id => (id === 'mm_field_item' ? 'Akun ML Mythic' : '100000') },
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i1);
    const i2 = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_buyer',
        values: ['buyer1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i2);
    const i3 = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_seller',
        values: ['seller1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i3);

    assert.strictEqual(deleted, true, 'channel yang baru dibuat dibersihkan (best-effort delete)');
    assert.strictEqual(mm.getDeal('ch_new_deal_d'), null, 'deal hasil TOCTOU TIDAK tersimpan');
    assert.ok(mm.getDeal('ch_other_v38d'), 'deal yang lebih dulu menang tetap utuh');
    const last = i3._edits[i3._edits.length - 1];
    assert.match(last.content, /terlibat deal aktif lain/, 'apology jelas ke user');
});

// ====================================================
// === 6. FIX 5 — creator pihak ketiga jadi observer ===
// ====================================================

test('v3.9.38 FIX 5: creator pihak ketiga tercatat sebagai observer deal (bisa dikeluarkan lewat tombol ➖)', async () => {
    seedConfig();
    resetDataFile('deals.json', {});
    resetDataFile('tickets.json', {});

    const guild = makeV38Guild({
        guildId: 'g_v38e',
        createImpl: async () => ({
            id: 'ch_new_deal_e',
            toString: () => '<#ch_new_deal_e>',
            send: async () => ({ id: 'msg_board' }),
            delete: async () => {}
        })
    });

    const i1 = makeInteraction({
        type: 'modal',
        customId: 'modal_mm_create',
        fields: { getTextInputValue: id => (id === 'mm_field_item' ? 'Akun ML Mythic' : '100000') },
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i1);
    const i2 = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_buyer',
        values: ['buyer1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i2);
    const i3 = makeInteraction({
        type: 'userselect',
        customId: 'mm_pick_seller',
        values: ['seller1'],
        guild,
        userId: 'creator1',
        userTag: 'Creator#0001'
    });
    await midmanDomain(i3);

    const deal = mm.getDeal('ch_new_deal_e');
    assert.ok(deal, 'deal dibuat');
    assert.deepStrictEqual(deal.observers, ['creator1'], 'creator pihak ketiga masuk daftar observer');
    // Creator sekarang bisa dikeluarkan lewat mekanisme observer biasa.
    assert.strictEqual(mm.removeObserver(deal, 'creator1'), true);
    // Slot observer tidak jebol: 1 dari MAX_OBSERVERS terpakai → masih bisa tambah.
    assert.strictEqual(mm.canAddObserver(mm.getDeal('ch_new_deal_e'), 'witness1').ok, true);
});

// ====================================================
// === 7. FIX 4 — handleEvent deferReply + safeEditReply ===
// ====================================================

test('v3.9.38 FIX 4: handleEvent mm_fundin → deferReply di awal, konfirmasi lewat editReply (bukan reply baru)', async () => {
    seedConfig();
    seedDeal('ch_v38_ev', {});
    const dealChannel = makeDealChannel({ id: 'ch_v38_ev' });
    const guild = makeV38Guild({ guildId: 'g_v38' });
    const interaction = makeInteraction({
        type: 'button',
        customId: 'mm_fundin',
        channel: dealChannel,
        guild
    });
    await midmanDomain(interaction);

    assert.strictEqual(interaction._defers.length, 1, 'deferReply dipanggil tepat sekali di awal');
    assert.strictEqual(interaction._defers[0].flags, MessageFlags.Ephemeral, 'defer ephemeral');
    assert.strictEqual(interaction._replies.length, 0, 'tidak ada interaction.reply setelah defer (window ack 3s aman)');
    assert.ok(interaction._edits.length > 0, 'konfirmasi lewat editReply deferred');
    assert.match(interaction._edits[interaction._edits.length - 1].content, /Dana dikonfirmasi masuk/);
    assert.strictEqual(mm.getDeal('ch_v38_ev').state, 'WAITING_DELIVERY', 'transisi tetap tersimpan');
    assert.strictEqual(mm.transitionLocks.has('ch_v38_ev'), false, 'lock dilepas setelah selesai');
});

test('v3.9.38 FIX 4: handleEvent saat lock dipegang → ditolak via editReply, state & channel tidak tersentuh', async () => {
    seedConfig();
    seedDeal('ch_v38_ev2', {});
    mm.transitionLocks.add('ch_v38_ev2'); // transisi lain sedang diproses
    try {
        const dealChannel = makeDealChannel({ id: 'ch_v38_ev2' });
        const guild = makeV38Guild({ guildId: 'g_v38' });
        const interaction = makeInteraction({
            type: 'button',
            customId: 'mm_fundin',
            channel: dealChannel,
            guild
        });
        await midmanDomain(interaction);

        assert.strictEqual(interaction._defers.length, 1, 'defer tetap dijalankan di awal');
        assert.ok(
            interaction._edits.some(e => /sedang diproses/.test(e.content)),
            'penolakan dikirim lewat editReply deferred'
        );
        assert.strictEqual(mm.getDeal('ch_v38_ev2').state, 'WAITING_PAYMENT', 'state tidak berubah');
        assert.strictEqual(dealChannel._sent.length, 0, 'tidak ada pengumuman terkirim');
    } finally {
        mm.transitionLocks.delete('ch_v38_ev2');
    }
});
