/**
 * Unit tests v3.9.35 — fix tombol konfirmasi close tiket non-transaksi.
 *
 * Bug yang diuji (user-reported):
 *   Di tiket bantuan/help/report/claim/giveaway, tombol konfirmasi close
 *   "❌ Tutup Tanpa Selesai" salah wiring ke customId `ticket_close_abort`
 *   — sama dengan "⏏️ Batal Tutup". Akibatnya KEDUA tombol sama-sama hanya
 *   membatalkan penutupan; tiket non-transaksi tidak bisa ditutup tanpa
 *   diselesaikan (interactions/ticket.js).
 *
 * Fix: tombol "Tutup Tanpa Selesai" kini pakai customId `ticket_close_cancel`
 *   yang benar-benar menutup tiket (closeTicket isSuccess=false → transcript
 *   ditandai tidak selesai, channel dihapus, meta dibersihkan).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: file data produksi di-snapshot & restore ===
// === (pola hardeningV31.test.js)                    ===
// ====================================================
const SANDBOX_FILES = ['tickets.json', 'config.json', 'stats.json'];
const backups = [];
for (const f of SANDBOX_FILES) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) {
        const b = p + '.v3935-backup';
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

const { setTicketMeta, getTicketMeta } = require('../../src/data/ticketManager');

// Seed tiket non-transaksi (help / claim_giveaway).
// v3.9.19+: kategori tanpa produk → produk sintetis isHelp:true, requiresKey:false,
// tanpa flag isTransaction → resolveTicketType → isTransaction=false.
function seedNonTransactionTicket(channelId, category) {
    resetDataFile('tickets.json', {});
    resetDataFile('config.json', {});
    setTicketMeta(channelId, {
        userId: 'u_v3935',
        productName: 'Help',
        price: '-',
        guildId: 'g_v3935',
        category,
        requiresKey: false
    });
}

function makeMockChannel({ id, deleteImpl }) {
    return { id, topic: '', delete: deleteImpl, isTextBased: () => true };
}

function makeMockInteraction({ customId, channel }) {
    const replies = [];
    const updates = [];
    const interaction = {
        id: `v3935-${customId}-${Date.now()}-${Math.random()}`,
        customId,
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => false,
        isModalSubmit: () => false,
        // Admin via Discord permission (bypass role-config path).
        member: {
            permissions: { has: () => true },
            roles: { cache: new Map() }
        },
        user: { id: 'admin_v3935', tag: 'Admin#0001' },
        channel,
        reply: async opts => {
            replies.push(opts);
            interaction.replied = true;
            return {};
        },
        editReply: async opts => {
            replies.push(opts);
            return {};
        },
        update: async opts => {
            updates.push(opts);
            interaction.replied = true;
            return {};
        },
        deferUpdate: async () => {
            interaction.deferred = true;
            return {};
        },
        _replies: replies,
        _updates: updates
    };
    return interaction;
}

// ====================================================
// === 1. Row konfirmasi close — tiket non-transaksi ===
// ====================================================

test('v3.9.35 FIX: tiket help — tombol "Tutup Tanpa Selesai" pakai customId ticket_close_cancel (bukan abort)', async () => {
    seedNonTransactionTicket('chan_help_close', 'help');
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'ticket_close',
        channel: makeMockChannel({ id: 'chan_help_close', deleteImpl: async () => ({}) })
    });
    await routeInteraction(interaction);

    assert.ok(interaction._replies.length > 0, 'konfirmasi close merespon');
    const reply = interaction._replies[0];
    assert.ok(reply.components?.length > 0, 'row tombol konfirmasi ada');

    const btns = reply.components[0].components;
    assert.strictEqual(btns.length, 3, 'help: 3 tombol (Selesai / Tutup Tanpa Selesai / Batal Tutup)');

    const ids = btns.map(b => b.data.custom_id);
    // Inti fix: tombol close-tanpa-selesai TIDAK lagi memakai customId abort.
    assert.ok(ids.includes('ticket_close_success'), 'tombol Selesai ada');
    assert.ok(ids.includes('ticket_close_cancel'), 'tombol Tutup Tanpa Selesai → customId ticket_close_cancel');
    assert.ok(ids.includes('ticket_close_abort'), 'tombol Batal Tutup ada');

    // Tidak boleh ada customId ganda di satu row (Discord menolak duplikat).
    assert.strictEqual(new Set(ids).size, ids.length, 'semua customId unik');

    // Label tombol benar.
    const cancelBtn = btns.find(b => b.data.custom_id === 'ticket_close_cancel');
    assert.strictEqual(cancelBtn.data.label, '❌ Tutup Tanpa Selesai');
});

test('v3.9.35 FIX: tiket claim_giveaway — row konfirmasi sama (help-style), tombol cancel tersedia', async () => {
    seedNonTransactionTicket('chan_claim_close', 'claim_giveaway');
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'ticket_close',
        channel: makeMockChannel({ id: 'chan_claim_close', deleteImpl: async () => ({}) })
    });
    await routeInteraction(interaction);

    const btns = interaction._replies[0].components[0].components;
    const ids = btns.map(b => b.data.custom_id);
    assert.ok(ids.includes('ticket_close_cancel'), 'claim/giveaway dapat tombol Tutup Tanpa Selesai');
    assert.ok(ids.includes('ticket_close_abort'), 'claim/giveaway dapat tombol Batal Tutup');
});

// ====================================================
// === 2. Klik ticket_close_cancel → tiket BENAR-BENAR ditutup ===
// ====================================================

test('v3.9.35 FIX: klik "Tutup Tanpa Selesai" → channel dihapus + meta dibersihkan (tiket tertutup)', async () => {
    seedNonTransactionTicket('chan_help_cancel', 'help');
    let deleted = false;
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'ticket_close_cancel',
        channel: makeMockChannel({
            id: 'chan_help_cancel',
            deleteImpl: async () => {
                deleted = true;
                return {};
            }
        })
    });
    await routeInteraction(interaction);

    assert.strictEqual(deleted, true, 'channel tiket dihapus → tiket BENAR-BENAR tertutup');
    assert.strictEqual(getTicketMeta('chan_help_cancel', ''), null, 'meta tiket dibersihkan dari tickets.json');
});

test('v3.9.35: klik "Tutup Tanpa Selesai" pada tiket report → juga menutup (semua kategori non-transaksi)', async () => {
    seedNonTransactionTicket('chan_report_cancel', 'report');
    let deleted = false;
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'ticket_close_cancel',
        channel: makeMockChannel({
            id: 'chan_report_cancel',
            deleteImpl: async () => {
                deleted = true;
                return {};
            }
        })
    });
    await routeInteraction(interaction);

    assert.strictEqual(deleted, true, 'tiket report tertutup');
    assert.strictEqual(getTicketMeta('chan_report_cancel', ''), null);
});

// ====================================================
// === 3. Klik ticket_close_abort → tiket TIDAK ditutup ===
// ====================================================

test('v3.9.35: klik "Batal Tutup" (ticket_close_abort) → tiket TIDAK ditutup, meta utuh', async () => {
    seedNonTransactionTicket('chan_help_abort', 'help');
    let deleted = false;
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'ticket_close_abort',
        channel: makeMockChannel({
            id: 'chan_help_abort',
            deleteImpl: async () => {
                deleted = true;
                return {};
            }
        })
    });
    await routeInteraction(interaction);

    assert.strictEqual(deleted, false, 'channel TIDAK dihapus');
    assert.ok(getTicketMeta('chan_help_abort', ''), 'meta tiket tetap ada');
    assert.ok(
        interaction._updates.length > 0 && /dibatalkan/.test(interaction._updates[0].content),
        'pesan konfirmasi: penutupan dibatalkan'
    );
});

// ====================================================
// === 4. Non-admin tidak bisa tutup tanpa selesai (defense) ===
// ====================================================

test('v3.9.35: non-admin klik "Tutup Tanpa Selesai" → ditolak, tiket tetap hidup', async () => {
    seedNonTransactionTicket('chan_help_noadmin', 'help');
    let deleted = false;
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'ticket_close_cancel',
        channel: makeMockChannel({
            id: 'chan_help_noadmin',
            deleteImpl: async () => {
                deleted = true;
                return {};
            }
        })
    });
    // Non-admin: tidak punya permission ManageGuild/Administrator & tanpa role admin.
    interaction.member = {
        permissions: { has: () => false },
        roles: { cache: new Map() }
    };
    await routeInteraction(interaction);

    assert.strictEqual(deleted, false, 'channel tidak dihapus');
    assert.ok(getTicketMeta('chan_help_noadmin', ''), 'meta tetap ada');
    assert.match(interaction._replies[0].content, /Hanya Admin/);
});

// ====================================================
// === 5. Legacy: ephemeral lama masih punya tombol abort2 ===
// ===    → handler tetap menangkap (tidak dead button) ===
// ====================================================

test('v3.9.35 compat: customId lama ticket_close_abort2 (ephemeral lama) tetap di-handle → batal, tidak error', async () => {
    seedNonTransactionTicket('chan_help_abort2', 'help');
    let deleted = false;
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'ticket_close_abort2',
        channel: makeMockChannel({
            id: 'chan_help_abort2',
            deleteImpl: async () => {
                deleted = true;
                return {};
            }
        })
    });
    await routeInteraction(interaction);

    assert.strictEqual(deleted, false, 'channel tidak dihapus (perilaku batal)');
    assert.ok(getTicketMeta('chan_help_abort2', ''), 'meta tetap ada');
});
