/**
 * Unit tests v3.9.35 — fix for the close-confirmation buttons on non-transaction tickets.
 *
 * Bug under test (user-reported):
 *   On help/report/claim/giveaway tickets, the close-confirmation button
 *   "❌ Close Without Completing" was mis-wired to the customId `ticket_close_abort`
 *   — the same as "⏏️ Cancel Close". As a result, BOTH buttons only cancelled
 *   the closing; non-transaction tickets could not be closed without being
 *   completed (interactions/ticket.js).
 *
 * Fix: the "Close Without Completing" button now uses the customId `ticket_close_cancel`,
 *   which actually closes the ticket (closeTicket isSuccess=false → transcript
 *   marked not completed, channel deleted, meta cleaned up).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');

// ====================================================
// === Sandbox: production data files are snapshotted & restored ===
// === (pattern from hardeningV31.test.js)                 ===
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

// Seed a non-transaction ticket (help / claim_giveaway).
// v3.9.19+: categories without products → synthetic product isHelp:true, requiresKey:false,
// without the isTransaction flag → resolveTicketType → isTransaction=false.
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
        // Admin via Discord permission (bypasses the role-config path).
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
// === 1. Close confirmation row — non-transaction ticket ===
// ====================================================

test('v3.9.35 FIX: help ticket — "Close Without Completing" button uses customId ticket_close_cancel (not abort)', async () => {
    seedNonTransactionTicket('chan_help_close', 'help');
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'ticket_close',
        channel: makeMockChannel({ id: 'chan_help_close', deleteImpl: async () => ({}) })
    });
    await routeInteraction(interaction);

    assert.ok(interaction._replies.length > 0, 'close confirmation responded');
    const reply = interaction._replies[0];
    assert.ok(reply.components?.length > 0, 'close confirmation button row exists');

    const btns = reply.components[0].components;
    assert.strictEqual(btns.length, 3, 'help: 3 buttons (Done / Close Without Completing / Cancel Close)');

    const ids = btns.map(b => b.data.custom_id);
    // Core fix: the close-without-completing button NO LONGER uses the abort customId.
    assert.ok(ids.includes('ticket_close_success'), 'Done button exists');
    assert.ok(ids.includes('ticket_close_cancel'), 'Close Without Completing button → customId ticket_close_cancel');
    assert.ok(ids.includes('ticket_close_abort'), 'Cancel Close button exists');

    // There must be no duplicate customIds in a single row (Discord rejects duplicates).
    assert.strictEqual(new Set(ids).size, ids.length, 'all customIds unique');

    // Button labels are correct.
    const cancelBtn = btns.find(b => b.data.custom_id === 'ticket_close_cancel');
    assert.strictEqual(cancelBtn.data.label, '❌ Close Without Completing');
});

test('v3.9.35 FIX: claim_giveaway ticket — same confirmation row (help-style), cancel button available', async () => {
    seedNonTransactionTicket('chan_claim_close', 'claim_giveaway');
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'ticket_close',
        channel: makeMockChannel({ id: 'chan_claim_close', deleteImpl: async () => ({}) })
    });
    await routeInteraction(interaction);

    const btns = interaction._replies[0].components[0].components;
    const ids = btns.map(b => b.data.custom_id);
    assert.ok(ids.includes('ticket_close_cancel'), 'claim/giveaway gets the Close Without Completing button');
    assert.ok(ids.includes('ticket_close_abort'), 'claim/giveaway gets the Cancel Close button');
});

// ====================================================
// === 2. Click ticket_close_cancel → ticket is REALLY closed ===
// ====================================================

test('v3.9.35 FIX: clicking "Close Without Completing" → channel deleted + meta cleaned up (ticket closed)', async () => {
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

    assert.strictEqual(deleted, true, 'ticket channel deleted → ticket is REALLY closed');
    assert.strictEqual(getTicketMeta('chan_help_cancel', ''), null, 'ticket meta cleaned up from tickets.json');
});

test('v3.9.35: clicking "Close Without Completing" on a report ticket → also closes (all non-transaction categories)', async () => {
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

    assert.strictEqual(deleted, true, 'report ticket closed');
    assert.strictEqual(getTicketMeta('chan_report_cancel', ''), null);
});

// ====================================================
// === 3. Click ticket_close_abort → ticket NOT closed ===
// ====================================================

test('v3.9.35: clicking "Cancel Close" (ticket_close_abort) → ticket NOT closed, meta intact', async () => {
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

    assert.strictEqual(deleted, false, 'channel NOT deleted');
    assert.ok(getTicketMeta('chan_help_abort', ''), 'ticket meta still exists');
    assert.ok(
        interaction._updates.length > 0 && /cancelled/.test(interaction._updates[0].content),
        'confirmation message: closing cancelled'
    );
});

// ====================================================
// === 4. Non-admin cannot close without completing (defense) ===
// ====================================================

test('v3.9.35: non-admin clicks "Close Without Completing" → rejected, ticket stays alive', async () => {
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
    // Non-admin: no ManageGuild/Administrator permission & no admin role.
    interaction.member = {
        permissions: { has: () => false },
        roles: { cache: new Map() }
    };
    await routeInteraction(interaction);

    assert.strictEqual(deleted, false, 'channel not deleted');
    assert.ok(getTicketMeta('chan_help_noadmin', ''), 'meta still exists');
    assert.match(interaction._replies[0].content, /Only Admin\/Staff/);
});

// ====================================================
// === 5. Legacy: old ephemerals still have the abort2 button ===
// ===    → the handler still catches it (no dead button) ===
// ====================================================

test('v3.9.35 compat: legacy customId ticket_close_abort2 (old ephemeral) still handled → cancel, no error', async () => {
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

    assert.strictEqual(deleted, false, 'channel not deleted (cancel behavior)');
    assert.ok(getTicketMeta('chan_help_abort2', ''), 'meta still exists');
});
