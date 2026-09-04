/**
 * Unit tests v3.9.31 — hardening hasil code review.
 *
 * Bug yang diuji:
 *   1. closeTicket: removeTicketMeta JALAN TERUS walau channel.delete() gagal
 *      non-10003 (Missing Permissions) → channel hidup tanpa meta → close
 *      berikutnya jatuh ke topic-parsing yang kehilangan isCompleted/
 *      isInvoiceSent → invoice dobel. (ticketManager.js)
 *   2. ticket_close / ticket_set_key: `interaction.channel.id` tanpa guard →
 *      TypeError kalau channel terhapus tepat sebelum klik. (interactions/ticket.js)
 *   3. clear-schedule: snapshot roleId diambil SEBELUM hapus + via API
 *      roleScheduler (bukan fs langsung, bukan entry user lain).
 *   4. getActiveKeysByUserAndRole: optional guildId filter (konsistensi pola).
 *   5. getTopUsers: userId selalu ter-resolve walau entry tanpa userId.
 *   6. _shared: createContext dead code dihapus.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: file data produksi di-snapshot & restore ===
// === (pola keyManager.test.js / ticketNonKey.test.js)  ===
// ====================================================
const SANDBOX_FILES = ['tickets.json', 'config.json', 'stats.json', 'scheduledRoles.json', 'keys.json'];
const backups = [];
for (const f of SANDBOX_FILES) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) {
        const b = p + '.v31-backup';
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
    // File yang TIDAK ada sebelum test → hapus hasil test.
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
// === 1. closeTicket — orphan meta guard (v3.9.31) ===
// ====================================================

const { closeTicket, setTicketMeta, getTicketMeta } = require('../../src/data/ticketManager');

function seedTicket(channelId) {
    resetDataFile('tickets.json', {});
    // config minimal → tanpa channels.transcript/invoice (skip transcript & invoice path).
    resetDataFile('config.json', {});
    setTicketMeta(channelId, {
        userId: 'u_v31',
        productName: 'VIP 30 Hari',
        price: 'Rp 30.000',
        guildId: 'g_v31',
        category: 'transaction',
        requiresKey: true,
        isTransaction: true
    });
}

function makeMockChannel({ id, deleteImpl }) {
    return { id, topic: '', delete: deleteImpl };
}

test('v3.9.31 FIX: closeTicket — delete gagal non-10003 → meta TIDAK dihapus', async () => {
    seedTicket('chan_v31_fail');
    const err = new Error('Missing Permissions');
    err.code = 50001; // bukan 10003 → channel dianggap MASIH ADA
    const ch = makeMockChannel({
        id: 'chan_v31_fail',
        deleteImpl: async () => {
            throw err;
        }
    });
    // isSuccess=false + isCompleted=false → invoice & transcript path dilewati.
    await closeTicket(ch, { id: 'admin', tag: 'Admin' }, false);
    const meta = getTicketMeta('chan_v31_fail', '');
    assert.ok(meta, 'meta harus TETAP ada selama channel masih hidup (anti orphan-meta)');
    assert.strictEqual(meta.userId, 'u_v31', 'isi meta utuh — tidak ter-reset ke topic-parsing');
});

test('v3.9.31: closeTicket — delete gagal 10003 (Unknown Channel) → meta dihapus', async () => {
    seedTicket('chan_v31_gone');
    const err = new Error('Unknown Channel');
    err.code = 10003;
    const ch = makeMockChannel({
        id: 'chan_v31_gone',
        deleteImpl: async () => {
            throw err;
        }
    });
    await closeTicket(ch, { id: 'admin', tag: 'Admin' }, false);
    assert.strictEqual(getTicketMeta('chan_v31_gone', ''), null, 'channel sudah tidak ada → meta dibersihkan');
});

test('v3.9.31: closeTicket — delete sukses → meta dihapus', async () => {
    seedTicket('chan_v31_ok');
    const ch = makeMockChannel({ id: 'chan_v31_ok', deleteImpl: async () => ({}) });
    await closeTicket(ch, { id: 'admin', tag: 'Admin' }, false);
    assert.strictEqual(getTicketMeta('chan_v31_ok', ''), null);
});

test('v3.9.31: closeTicket — self-healing: gagal dulu (permission), lalu sukses → meta terhapus', async () => {
    seedTicket('chan_v31_heal');
    const err = new Error('Missing Permissions');
    err.code = 50001;

    // Percobaan 1: delete gagal → meta harus selamat.
    const chFail = makeMockChannel({
        id: 'chan_v31_heal',
        deleteImpl: async () => {
            throw err;
        }
    });
    await closeTicket(chFail, { id: 'admin', tag: 'Admin' }, false);
    assert.ok(getTicketMeta('chan_v31_heal', ''), 'meta selamat setelah percobaan pertama gagal');

    // Percobaan 2 (admin klik close lagi setelah permission dibereskan): sukses.
    const chOk = makeMockChannel({ id: 'chan_v31_heal', deleteImpl: async () => ({}) });
    await closeTicket(chOk, { id: 'admin', tag: 'Admin' }, false);
    assert.strictEqual(getTicketMeta('chan_v31_heal', ''), null, 'percobaan kedua membersihkan meta');
});

// ====================================================
// === 2. Router tiket — guard channel null (v3.9.31) ===
// ====================================================

function makeNullChannelInteraction(customId) {
    const replies = [];
    const interaction = {
        id: `v31-${customId}-${Date.now()}-${Math.random()}`,
        customId,
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        // v3.9.33: router kini juga menerima user select menu.
        isUserSelectMenu: () => false,
        isModalSubmit: () => false,
        // Admin supaya lolos checkIsAdmin → guard channel yang diuji.
        member: {
            permissions: { has: () => true },
            roles: { cache: new Map() }
        },
        // interaction.channel SENGAJA tidak didefinisikan (channel terhapus / partial).
        reply: async opts => {
            replies.push(opts);
            interaction.replied = true;
            return {};
        },
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        _replies: replies
    };
    return interaction;
}

test('v3.9.31 FIX: ticket_close dengan channel null → pesan jelas, bukan TypeError', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeNullChannelInteraction('ticket_close');
    // Sebelum fix: TypeError "Cannot read properties of null (reading 'id')"
    // ditelan handler global sebagai error generik.
    await routeInteraction(interaction);
    assert.ok(interaction._replies.length > 0, 'handler merespon dengan pesan yang jelas');
    assert.match(interaction._replies[0].content, /Channel tiket sudah tidak ada/);
});

test('v3.9.31 FIX: ticket_set_key dengan channel null → pesan jelas, bukan TypeError', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeNullChannelInteraction('ticket_set_key');
    await routeInteraction(interaction);
    assert.ok(interaction._replies.length > 0, 'handler merespon dengan pesan yang jelas');
    assert.match(interaction._replies[0].content, /Channel tiket sudah tidak ada/);
});

// ====================================================
// === 3. clear-schedule — snapshot via API (v3.9.31) ===
// ====================================================
// Kontrak data-layer yang sekarang dipakai keys.js: snapshot roleId milik user
// target SEBELUM removeAllSchedulesByUser — via API roleScheduler, bukan fs
// langsung, dan TIDAK menyedot roleId milik user lain.

test('v3.9.31 FIX: snapshot schedule user → hanya roleId milik user itu (bukan user lain)', () => {
    resetDataFile('scheduledRoles.json', []);
    const {
        scheduleRoleRemoval,
        findAllByUser: findAllSchedules,
        removeAllByUser: removeAllSchedules
    } = require('../../src/data/roleScheduler');

    scheduleRoleRemoval({ userId: 'ua_v31', roleId: 'ra_v31', guildId: 'g1', days: 30 });
    scheduleRoleRemoval({ userId: 'ub_v31', roleId: 'rb_v31', guildId: 'g1', days: 30 }); // user LAIN
    scheduleRoleRemoval({ userId: 'ua_v31', roleId: 'ra_other', guildId: 'g2', days: 30 }); // guild lain

    // Pola snapshot baru keys.js (SEBELUM hapus):
    const snap = new Set(
        findAllSchedules('ua_v31')
            .filter(e => e && e.roleId && (!e.guildId || e.guildId === 'g1'))
            .map(e => e.roleId)
    );
    assert.deepStrictEqual(
        [...snap].sort(),
        ['ra_v31'],
        'snapshot hanya berisi roleId user target di guild ini — bukan rb_v31 (user lain), bukan ra_other (guild lain)'
    );

    const removed = removeAllSchedules('ua_v31', 'g1');
    assert.strictEqual(removed, 1, 'hanya 1 schedule user ini di guild ini yang dihapus');
    // Entry user lain + guild lain tetap utuh:
    assert.strictEqual(findAllSchedules('ub_v31').length, 1);
    assert.strictEqual(findAllSchedules('ua_v31').length, 1, 'entry guild lain milik user ini tidak tersentuh');
});

// ====================================================
// === 4. keyManager — getActiveKeysByUserAndRole guildId ===
// ====================================================

test('v3.9.31: getActiveKeysByUserAndRole dengan guildId → filter + backward compat legacy', () => {
    resetDataFile('keys.json', []);
    const { addKey, getActiveKeysByUserAndRole, removeAllKeysByUser } = require('../../src/data/keyManager');

    addKey({ key: 'V31-G1', userId: 'u_v31', roleId: 'r_v31', days: 30, guildId: 'g1' });
    addKey({ key: 'V31-G2', userId: 'u_v31', roleId: 'r_v31', days: 30, guildId: 'g2' });
    addKey({ key: 'V31-LEGACY', userId: 'u_v31', roleId: 'r_v31', days: 30 }); // tanpa guildId (schema lama)

    // Tanpa guildId → semua key (perilaku lama, backward compat):
    assert.strictEqual(getActiveKeysByUserAndRole('u_v31', 'r_v31').length, 3);

    // Dengan guildId='g1' → hanya g1 + legacy:
    const filtered = getActiveKeysByUserAndRole('u_v31', 'r_v31', Date.now(), 'g1');
    assert.strictEqual(filtered.length, 2, 'key g2 tidak ikut; legacy (tanpa guildId) tetap dihitung');
    assert.deepStrictEqual(
        filtered.map(k => k.key).sort(),
        ['V31-G1', 'V31-LEGACY']
    );

    removeAllKeysByUser('u_v31', null);
});

// ====================================================
// === 5. statsManager — getTopUsers userId resolved ===
// ====================================================

test('v3.9.31: getTopUsers — userId selalu ter-resolve (fallback dari composite key)', () => {
    // Ditulis SEBELUM require supaya cache statsManager terisi dari file ini.
    resetDataFile('stats.json', {
        'gv31:uv31a': { messages: 10 }, // tanpa field userId (entry lama/minimal)
        'gv31:uv31b': { messages: 5, userId: 'uv31b' } // dengan userId eksplisit
    });
    const { getTopUsers } = require('../../src/data/statsManager');
    const top = getTopUsers('gv31', 'messages', 10);
    assert.strictEqual(top.length, 2, 'kedua entry masuk leaderboard');
    const a = top.find(e => e.value === 10);
    const b = top.find(e => e.value === 5);
    assert.strictEqual(a.userId, 'uv31a', 'entry tanpa userId → fallback dari key');
    assert.strictEqual(b.userId, 'uv31b', 'entry dengan userId → dipakai apa adanya');
    assert.strictEqual(top[0].value, 10, 'urutan descending');
});

// ====================================================
// === 6. _shared — dead code dihapus ===
// ====================================================

test('v3.9.31: _shared — createContext (dead code) dihapus, eksport inti tetap utuh', () => {
    const shared = require('../../src/commands/_shared');
    assert.strictEqual(shared.createContext, undefined, 'createContext tidak lagi diekspor');
    assert.strictEqual(typeof shared.safeEditReply, 'function');
    assert.strictEqual(typeof shared.findAllSchedulesByUser, 'function', 'alias roleScheduler tetap tersedia');
    assert.strictEqual(typeof shared.findAllByUser, 'function', 'keyManager findAllByUser tetap tersedia');
});
