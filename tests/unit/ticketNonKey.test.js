/**
 * Unit tests v3.9.27 — NON-KEY transactions (ML account sales, services, etc.).
 *
 * Bug under test: the old system conflated `requiresKey` (does the product
 * use keys?) with `isTransaction` (is this a buy/sell ticket?) → non-key
 * products:
 *   - close buttons used the help style (no "Order Successful")
 *   - invoice/testimonial was never sent
 *   - purchase stats were never recorded, auto-role was never granted
 *
 * What is tested here (pure data layer + router):
 *   1. resolveTicketType() — explicit flags, legacy fallback, null meta
 *   2. setTicketMeta/getTicketMeta — persist isTransaction/isInvoiceSent/
 *      deliveredAt/deliveredBy
 *   3. patchTicketMeta — partial patch of the new fields
 *   4. Interactions router — ticket_deliver & modal_deliver_order: dispatch
 *      to the ticket domain (without a PREFIX_TO_DOMAIN entry, the modal
 *      became a dead interaction).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ticketsPath = path.join(__dirname, '..', '..', 'data', 'tickets.json');

// ====================================================
// === Sandbox: production tickets.json is snapshotted & restored ===
// === (pattern from ticketFlexibility.test.js for panels.json) ===
// ====================================================
const ticketsBackupPath = ticketsPath + '.test-backup';
let ticketsBackedUp = false;
if (fs.existsSync(ticketsPath)) {
    fs.copyFileSync(ticketsPath, ticketsBackupPath);
    ticketsBackedUp = true;
}
process.on('exit', () => {
    try {
        if (ticketsBackedUp) {
            fs.copyFileSync(ticketsBackupPath, ticketsPath);
            fs.rmSync(ticketsBackupPath, { force: true });
        } else if (fs.existsSync(ticketsPath)) {
            fs.unlinkSync(ticketsPath);
        }
    } catch (_) {}
});

function resetTicketsFile() {
    if (fs.existsSync(ticketsPath)) {
        fs.unlinkSync(ticketsPath);
    }
}

const { resolveTicketType, setTicketMeta, getTicketMeta, patchTicketMeta } = require('../../src/data/ticketManager');

// ====================================================
// === 1. resolveTicketType — explicit flags (v3.9.27+) ===
// ====================================================

test('resolveTicketType: null meta → safe default (not a transaction)', () => {
    const t = resolveTicketType(null);
    assert.strictEqual(t.isTransaction, false);
    assert.strictEqual(t.requiresKey, false);
    assert.strictEqual(t.isCompleted, false);
});

test('resolveTicketType: explicit flag isTransaction=true, requiresKey=false (non-key product)', () => {
    // An "Akun ML Mythic" ticket created on v3.9.27+ — the core of the fixed bug.
    const t = resolveTicketType({ isTransaction: true, requiresKey: false, category: 'transaction' });
    assert.strictEqual(t.isTransaction, true, 'non-key product stays a TRANSACTION');
    assert.strictEqual(t.requiresKey, false);
    assert.strictEqual(t.isCompleted, false);
});

test('resolveTicketType: explicit flag isTransaction=true, requiresKey=true (key product)', () => {
    const t = resolveTicketType({ isTransaction: true, requiresKey: true, category: 'transaction' });
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, true);
});

test('resolveTicketType: explicit flag isTransaction=false (help/report)', () => {
    const t = resolveTicketType({ isTransaction: false, requiresKey: false, category: 'help' });
    assert.strictEqual(t.isTransaction, false);
    assert.strictEqual(t.requiresKey, false);
});

test('resolveTicketType: isCompleted is passed through', () => {
    const t = resolveTicketType({ isTransaction: true, requiresKey: true, isCompleted: true });
    assert.strictEqual(t.isCompleted, true);
});

// ====================================================
// === 2. resolveTicketType — legacy fallback ===
// ====================================================

test('resolveTicketType: legacy requiresKey=true → transaction (old key ticket)', () => {
    // Ticket created on v3.9.16–26 without the isTransaction flag.
    const t = resolveTicketType({ category: 'transaction', requiresKey: true });
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, true);
});

test('resolveTicketType: legacy requiresKey=false → NOT a transaction (old behavior preserved)', () => {
    // Old non-key tickets were misclassified as support — the old bug is
    // kept for still-open tickets (no regression; v3.9.27+ tickets always
    // have explicit flags).
    const t = resolveTicketType({ category: 'transaction', requiresKey: false });
    assert.strictEqual(t.isTransaction, false);
    assert.strictEqual(t.requiresKey, false);
});

test('resolveTicketType: ancient ticket without requiresKey — help/report category → support', () => {
    assert.strictEqual(resolveTicketType({ category: 'help' }).isTransaction, false);
    assert.strictEqual(resolveTicketType({ category: 'report' }).isTransaction, false);
});

test('resolveTicketType: ancient ticket without requiresKey — transaction category → transaction', () => {
    const t = resolveTicketType({ category: 'transaction', productName: 'VIP 30 Hari' });
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, true, 'requiresKey defaults to follow isTransaction');
});

test('resolveTicketType: ancient ticket — legacy magic string → support', () => {
    assert.strictEqual(resolveTicketType({ productName: 'Bantuan/Lapor' }).isTransaction, false);
    assert.strictEqual(resolveTicketType({ productName: 'Bantuan Staff' }).isTransaction, false);
    assert.strictEqual(resolveTicketType({ productName: 'Laporkan Member' }).isTransaction, false);
});

// ====================================================
// === 3. Persist meta: isTransaction / isInvoiceSent / delivered* ===
// ====================================================

test('setTicketMeta→getTicketMeta: roundtrip of the new v3.9.27 fields', () => {
    resetTicketsFile();
    setTicketMeta('chan_nonkey_1', {
        userId: '111',
        productName: 'Akun ML Mythic',
        price: 'Rp 150.000',
        guildId: 'g1',
        category: 'transaction',
        requiresKey: false,
        isTransaction: true
    });
    const meta = getTicketMeta('chan_nonkey_1');
    assert.strictEqual(meta.isTransaction, true);
    assert.strictEqual(meta.requiresKey, false);
    assert.strictEqual(meta.isInvoiceSent, false, 'default isInvoiceSent=false');
    assert.strictEqual(meta.deliveredAt, null);
    assert.strictEqual(meta.deliveredBy, null);
    assert.strictEqual(meta.isCompleted, false);
});

test('setTicketMeta: isTransaction=null when not provided (legacy-safe)', () => {
    resetTicketsFile();
    setTicketMeta('chan_legacy_1', {
        userId: '222',
        productName: 'VIP 30 Hari',
        price: 'Rp 30.000',
        guildId: 'g1',
        category: 'transaction',
        requiresKey: true
    });
    const meta = getTicketMeta('chan_legacy_1');
    assert.strictEqual(meta.isTransaction, null, 'not set → null (resolveTicketType legacy fallback)');
    // Resolve still works correctly for this legacy ticket:
    const t = resolveTicketType(meta);
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, true);
});

test('patchTicketMeta: patches isInvoiceSent + deliveredAt/deliveredBy without overwriting other fields', () => {
    resetTicketsFile();
    setTicketMeta('chan_deliver_1', {
        userId: '333',
        productName: 'Akun ML',
        price: 'Rp 100.000',
        guildId: 'g1',
        category: 'transaction',
        requiresKey: false,
        isTransaction: true
    });
    const ok = patchTicketMeta('chan_deliver_1', {
        isCompleted: true,
        deliveredAt: 12345,
        deliveredBy: 'admin999',
        isInvoiceSent: true
    });
    assert.strictEqual(ok, true);
    const meta = getTicketMeta('chan_deliver_1');
    assert.strictEqual(meta.isCompleted, true);
    assert.strictEqual(meta.deliveredAt, 12345);
    assert.strictEqual(meta.deliveredBy, 'admin999');
    assert.strictEqual(meta.isInvoiceSent, true);
    // Old fields remain intact:
    assert.strictEqual(meta.productName, 'Akun ML');
    assert.strictEqual(meta.userId, '333');
    assert.strictEqual(meta.isTransaction, true);
});

test('resolveTicketType after patch: non-key + isCompleted → "Done" button branch', () => {
    // Simulates a ticket that has already gone through 📦 Deliver Order:
    const t = resolveTicketType({
        isTransaction: true,
        requiresKey: false,
        isCompleted: true,
        deliveredAt: 123,
        isInvoiceSent: true
    });
    assert.strictEqual(t.isTransaction, true);
    assert.strictEqual(t.requiresKey, false);
    assert.strictEqual(t.isCompleted, true);
});

// ====================================================
// === 4. Interactions router — dispatch of the new customIds ===
// ====================================================

function makeMockInteraction({ customId, type = 'button', id = `t-${Date.now()}-${Math.random()}` }) {
    const replies = [];
    const interaction = {
        id,
        customId,
        replied: false,
        deferred: false,
        isRepliable: () => true,
        isChatInputCommand: () => false,
        isButton: () => type === 'button',
        isStringSelectMenu: () => type === 'select',
        // v3.9.33: the router now also accepts user select menus.
        isUserSelectMenu: () => type === 'userselect',
        isModalSubmit: () => type === 'modal',
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

test('router: ticket_deliver button dispatches to the ticket domain', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({ customId: 'ticket_deliver', type: 'button' });
    // The handler will reject (not an admin — mock without member) → that
    // proves the dispatch reaches the handler, not an "unknown customId".
    await routeInteraction(interaction);
    assert.ok(
        interaction._replies.length > 0,
        'handler responded (rejected as non-admin) → dispatch to the ticket domain succeeded'
    );
});

test('router: modal_deliver_order: dispatches to the ticket domain (routing gap fix)', async () => {
    const routeInteraction = require('../../src/interactions');
    const interaction = makeMockInteraction({
        customId: 'modal_deliver_order:akun_ml',
        type: 'modal'
    });
    await routeInteraction(interaction);
    assert.ok(
        interaction._replies.length > 0,
        'modal submit responded (rejected as non-admin) → modal_deliver_order: routing active'
    );
});
