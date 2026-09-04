/**
 * Unit tests v3.9.38 — hardening router/announce/config (task 3-e).
 *
 * Yang diuji (bug dari audit task 1-d yang difix di v3.9.38):
 *   1. parseTime absolute: offset eksplisit zona bot (default WITA +8) — bukan
 *      timezone host. VPS UTC sebelumnya bikin semua absolute announcement
 *      telat 8 jam dari yang dijanjikan teks bantuan. Configurable via env
 *      TZ_OFFSET_HOURS.
 *   2. Dedup router: mark() dipanggil SETELAH handler sukses — handler yang
 *      throw TIDAK ditandai supaya replay gateway Discord bisa retry (dulu:
 *      checkAndMark menandai sebelum handler jalan → crash menelan replay).
 *   3. truncateUtf8Safe: potong per code point — slice() biasa bisa motong
 *      surrogate pair emoji jadi lone surrogate (Discord reject 50035).
 *   4. /set-role: role managed / @everyone / posisi di atas bot DITOLAK
 *      (dulu lolos → auto-role gagal diam-diam).
 *   5. /announce & /announce-schedule: channel kategori (type 4) DITOLAK
 *      (dulu lolos → announce terjadwal gagal senyap saat fire time).
 */

const test = require('node:test');
const assert = require('node:assert');

// ====================================================
// === (a) parseTime absolute — offset eksplisit ===
// ====================================================

test('v3.9.38: parseTime absolute — offset default WITA +8 (host TZ tidak berpengaruh)', () => {
    delete process.env.TZ_OFFSET_HOURS;
    const { parseTime, getTzOffsetHours } = require('../../src/data/scheduledAnnouncements');
    assert.strictEqual(getTzOffsetHours(), 8, 'default offset = +8 (WITA)');
    const y = new Date().getFullYear() + 1; // selalu masa depan, < 5 tahun
    const result = parseTime(`${y}-01-15 20:00`);
    assert.ok(result !== null, 'waktu valid masa depan harus lolos');
    // Wall-clock 20:00 WITA = 12:00 UTC → timestamp = Date.UTC(...) - 8 jam.
    assert.strictEqual(result, Date.UTC(y, 0, 15, 20, 0, 0) - 8 * 3600 * 1000);
});

test('v3.9.38: parseTime absolute — env TZ_OFFSET_HOURS=0 → absolute diparse sebagai UTC', () => {
    process.env.TZ_OFFSET_HOURS = '0';
    try {
        const { parseTime, getTzOffsetHours } = require('../../src/data/scheduledAnnouncements');
        assert.strictEqual(getTzOffsetHours(), 0, 'env override aktif');
        const y = new Date().getFullYear() + 1;
        const result = parseTime(`${y}-01-15 20:00`);
        assert.ok(result !== null);
        assert.strictEqual(result, Date.UTC(y, 0, 15, 20, 0, 0));
    } finally {
        delete process.env.TZ_OFFSET_HOURS;
    }
});

test('v3.9.38: parseTime absolute — validasi rollover v3.9.8 tetap utuh dengan offset baru', () => {
    delete process.env.TZ_OFFSET_HOURS;
    const { parseTime } = require('../../src/data/scheduledAnnouncements');
    assert.strictEqual(parseTime('2027-13-40 99:99'), null, 'month 13 / day 40 / jam 99 invalid');
    assert.strictEqual(parseTime('2027-00-15 20:00'), null, 'month 0 invalid');
    assert.strictEqual(parseTime('2027-01-32 20:00'), null, 'day 32 invalid');
    assert.strictEqual(parseTime('2027-01-15 25:00'), null, 'jam 25 invalid');
});

// ====================================================
// === (b) dedup router — check sebelum, mark SETELAH sukses ===
// ====================================================

test('v3.9.38: dedup — handler sukses → baru di-mark; check() true setelahnya; replay di-skip', async () => {
    const { check, mark, processedInteractions } = require('../../src/interactions/_dedup');
    // Unit langsung: mark() baru setelah sukses, check() membaca status.
    const unitId = `v3938-unit-${Date.now()}-${Math.random()}`;
    assert.strictEqual(check(unitId), false, 'belum diproses → check false');
    mark(unitId);
    assert.strictEqual(check(unitId), true, 'sudah di-mark → check true');
    processedInteractions.delete(unitId);

    // End-to-end via router: btn_verify + mock minimal → handler reply (sukses)
    // → router menandai SETELAH handler selesai → replay interaksi sama di-skip.
    const routeInteraction = require('../../src/interactions');
    const id = `v3938-dedup-${Date.now()}`;
    const replies = [];
    const makeInteraction = () => ({
        id,
        customId: 'btn_verify',
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
    });
    await routeInteraction(makeInteraction());
    assert.strictEqual(replies.length, 1, 'handler jalan 1x (1 reply)');
    assert.strictEqual(check(id), true, 'router menandai SETELAH handler sukses');
    const replayResult = await routeInteraction(makeInteraction());
    assert.strictEqual(replayResult, undefined, 'replay di-skip (check true)');
    assert.strictEqual(replies.length, 1, 'handler tidak jalan 2x');
    processedInteractions.delete(id);
});

test('v3.9.38: dedup — handler THROW → TIDAK di-mark → replay gateway diproses ulang', async () => {
    const { check, processedInteractions } = require('../../src/interactions/_dedup');
    const routeInteraction = require('../../src/interactions');
    const id = `v3938-dedup-throw-${Date.now()}`;
    // mm_pick_seller + mock tanpa deferReply → domain midman throw
    // ("interaction.deferReply is not a function") — probe manual.
    const makeInteraction = () => ({
        id,
        customId: 'mm_pick_seller',
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => false,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => true,
        isModalSubmit: () => false,
        reply: async () => ({}),
        editReply: async () => ({})
    });

    // Crash pertama: error propagate ke caller — entry TIDAK ditandai.
    await assert.rejects(() => routeInteraction(makeInteraction()));
    assert.strictEqual(check(id), false, 'handler throw → entry TIDAK ditandai');

    // Replay interaction yang sama: HARUS diproses lagi (throw lagi = handler
    // benar-benar jalan ulang). Kalau masih pre-mark (bug lama), replay di-skip
    // → assert.rejects gagal karena resolve undefined — test ini yang gagal.
    await assert.rejects(() => routeInteraction(makeInteraction()), 'replay harus menjalankan handler ulang');
    processedInteractions.delete(id);
});

// ====================================================
// === (c) truncateUtf8Safe — emoji tidak terpotong jadi lone surrogate ===
// ====================================================

test('v3.9.38: truncateUtf8Safe — emoji dipotong per code point, tanpa lone surrogate', () => {
    const { truncateUtf8Safe } = require('../../src/infra/text');
    const s = '👍'.repeat(300); // 600 code unit (2 per emoji)
    const out = truncateUtf8Safe(s, 256);
    assert.ok(out.length <= 257, `total (konten + ellipsis) ≤ 257 code unit, dapat ${out.length}`);
    assert.ok(out.endsWith('…'), 'dipotong → diakhiri ellipsis');

    // Inti bug: konten tidak boleh ada lone surrogate (high tanpa pasangan
    // low, atau sebaliknya). Cek semua pasangan utuh.
    const content = out.slice(0, -1); // buang ellipsis (bukan surrogate)
    for (let i = 0; i < content.length; i += 2) {
        const hi = content.charCodeAt(i);
        const lo = content.charCodeAt(i + 1);
        assert.ok(hi >= 0xd800 && hi <= 0xdbff, `posisi ${i}: harus high surrogate`);
        assert.ok(lo >= 0xdc00 && lo <= 0xdfff, `posisi ${i + 1}: harus low surrogate (pasangan utuh)`);
    }
    // Karakter terakhir konten bukan high surrogate yatim (bentuk lama: slice(0,256)
    // berhenti tepat SETELAH high surrogate → string rusak).
    const lastCode = content.charCodeAt(content.length - 1);
    assert.ok(lastCode >= 0xdc00 && lastCode <= 0xdfff, 'char terakhir konten = low surrogate berpasangan');

    // Regression ringan: teks pendek tidak diubah.
    assert.strictEqual(truncateUtf8Safe('halo', 10), 'halo');
});

// ====================================================
// === (d) /set-role — role unassignable ditolak ===
// ====================================================

function makeSetRoleInteraction({ role, botHighestPos = 10 }) {
    const replies = [];
    return {
        commandName: 'set-role',
        client: { user: { username: 'TestBot', displayAvatarURL: () => 'http://x/a.png' } },
        user: { id: 'admin1', tag: 'Admin#0001' },
        guild: {
            id: 'g_test',
            members: { me: { roles: { highest: { position: botHighestPos } } } }
        },
        options: {
            getString: () => 'verified',
            getRole: () => role
        },
        deferReply: async () => {
            replies.push({ type: 'defer' });
        },
        editReply: async opts => {
            replies.push({ type: 'edit', opts });
            return {};
        },
        _replies: replies
    };
}

test('v3.9.38: /set-role — role managed DITOLAK (dulu lolos → auto-role gagal senyap)', async () => {
    const configHandler = require('../../src/commands/config');
    const interaction = makeSetRoleInteraction({
        role: { id: 'r_managed', name: 'BotIntegrationRole', managed: true, position: 5 }
    });
    await configHandler(interaction);
    const edit = interaction._replies.find(r => r.type === 'edit');
    assert.ok(edit, 'harus membalas error ephemeral');
    assert.match(edit.opts.content, /managed|integrasi|bot lain/i);
});

test('v3.9.38: /set-role — @everyone DITOLAK', async () => {
    const configHandler = require('../../src/commands/config');
    // Role @everyone: id-nya sama dengan id guild.
    const interaction = makeSetRoleInteraction({
        role: { id: 'g_test', name: '@everyone', managed: false, position: 0 }
    });
    await configHandler(interaction);
    const edit = interaction._replies.find(r => r.type === 'edit');
    assert.ok(edit, 'harus membalas error ephemeral');
    assert.match(edit.opts.content, /@everyone/i);
});

test('v3.9.38: /set-role — role di ATAS role bot DITOLAK (bot tidak bisa assign)', async () => {
    const configHandler = require('../../src/commands/config');
    const interaction = makeSetRoleInteraction({
        role: { id: 'r_high', name: 'HighRole', managed: false, position: 10 },
        botHighestPos: 10 // sama-sama 10 → role.position >= bot → tidak bisa assign
    });
    await configHandler(interaction);
    const edit = interaction._replies.find(r => r.type === 'edit');
    assert.ok(edit, 'harus membalas error ephemeral');
    assert.match(edit.opts.content, /DI ATAS|posisinya/i);
});

// ====================================================
// === (e) /announce & /announce-schedule — tipe channel divalidasi ===
// ====================================================

test('v3.9.38: /announce & /announce-schedule — channel kategori (type 4) DITOLAK', async () => {
    const announceHandler = require('../../src/commands/announce');
    // Category channel: type 4 — tidak bisa menerima pesan announce.
    const makeCategoryInteraction = commandName => {
        const replies = [];
        return {
            commandName,
            client: { user: { username: 'TestBot', displayAvatarURL: () => 'http://x/a.png' } },
            user: { id: 'admin1', tag: 'Admin#0001' },
            guild: { id: 'g_test', channels: { cache: new Map() } },
            options: {
                getChannel: () => ({ id: 'ch_cat', type: 4, name: 'Kategori' }),
                // getString tidak boleh terpanggil — validasi channel harus duluan.
                getString: () => {
                    throw new Error('validasi channel harus menolak SEBELUM opsi lain dibaca');
                }
            },
            deferReply: async () => {
                replies.push({ type: 'defer' });
            },
            editReply: async opts => {
                replies.push({ type: 'edit', opts });
                return {};
            },
            _replies: replies
        };
    };

    for (const commandName of ['announce', 'announce-schedule']) {
        const interaction = makeCategoryInteraction(commandName);
        await announceHandler(interaction);
        const edit = interaction._replies.find(r => r.type === 'edit');
        assert.ok(edit, `${commandName}: harus membalas error ephemeral`);
        assert.match(edit.opts.content, /Channel harus text channel biasa/);
        assert.match(edit.opts.content, /kategori|forum|voice/);
    }
});
