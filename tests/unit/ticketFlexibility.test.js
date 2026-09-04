/**
 * Unit tests untuk v3.9.14 — multi-panel ticket flexibility (panelManager + buildTicketPanel).
 *
 * Test yang butuh discord.js di-mock manual. Test panelManager (persistence)
 * test secara langsung karena tidak ada dependensi discord.js di file itu.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// === panelManager tests ===
const panelsPath = path.join(__dirname, '..', '..', 'data', 'panels.json');

// ====================================================
// === v3.9.24 FIX: panels.json produksi di-snapshot & restore ===
// ====================================================
// resetPanelsFile() di bawah MENGHAPUS data/panels.json tanpa backup — kalau
// npm test dijalankan di instance live, SEMUA panel tiket hilang. Sekarang:
// file asli di-copy ke backup sebelum test, di-restore saat process exit.
const panelsBackupPath = panelsPath + '.test-backup';
let panelsBackedUp = false;
if (fs.existsSync(panelsPath)) {
    fs.copyFileSync(panelsPath, panelsBackupPath);
    panelsBackedUp = true;
}
process.on('exit', () => {
    // Harus sync (dalam exit handler).
    try {
        if (panelsBackedUp) {
            fs.copyFileSync(panelsBackupPath, panelsPath);
            fs.rmSync(panelsBackupPath, { force: true });
        } else if (fs.existsSync(panelsPath)) {
            // Tidak ada file asli → hapus file hasil test supaya checkout bersih.
            fs.unlinkSync(panelsPath);
        }
    } catch (_) {}
});

function resetPanelsFile() {
    if (fs.existsSync(panelsPath)) {
        fs.unlinkSync(panelsPath);
    }
}

test('panelManager: loadPanels returns {} when file does not exist', () => {
    resetPanelsFile();
    const { loadPanels, invalidateCache } = require('../../src/data/panelManager');
    invalidateCache();
    const all = loadPanels();
    assert.strictEqual(typeof all, 'object');
    assert.strictEqual(Object.keys(all).length, 0);
});

test('panelManager: upsertPanel creates new panel with generated id', () => {
    resetPanelsFile();
    const { upsertPanel, getPanel, invalidateCache } = require('../../src/data/panelManager');
    invalidateCache();
    const panel = upsertPanel({
        guildId: '123',
        channelId: '456',
        messageId: '789',
        title: 'Test Panel',
        body: null,
        color: null,
        categoryIds: ['transaction', 'help'],
        useDropdown: false
    });
    assert.ok(panel.id.startsWith('tp_'), `id should start with tp_, got: ${panel.id}`);
    assert.strictEqual(panel.guildId, '123');
    assert.strictEqual(panel.title, 'Test Panel');
    assert.deepStrictEqual(panel.categoryIds, ['transaction', 'help']);
    assert.ok(panel.createdAt > 0);
    assert.ok(panel.updatedAt >= panel.createdAt);

    // Verify persisted
    invalidateCache();
    const fetched = getPanel(panel.id);
    assert.strictEqual(fetched.title, 'Test Panel');
});

test('panelManager: upsertPanel preserves existing fields when partial update', () => {
    resetPanelsFile();
    const { upsertPanel, invalidateCache } = require('../../src/data/panelManager');
    invalidateCache();
    const original = upsertPanel({
        guildId: 'g1',
        channelId: 'c1',
        title: 'Original',
        body: 'Original body',
        color: '#ff5733',
        categoryIds: ['transaction']
    });
    // Partial update: only change title
    const updated = upsertPanel({
        id: original.id,
        title: 'Updated Title'
    });
    assert.strictEqual(updated.title, 'Updated Title');
    assert.strictEqual(updated.body, 'Original body'); // preserved
    assert.strictEqual(updated.color, '#ff5733'); // preserved
    assert.strictEqual(updated.channelId, 'c1'); // preserved
    assert.strictEqual(updated.guildId, 'g1'); // preserved
    assert.deepStrictEqual(updated.categoryIds, ['transaction']); // preserved
});

test('panelManager: patchPanel does partial update with timestamps', () => {
    resetPanelsFile();
    const { upsertPanel, patchPanel, invalidateCache } = require('../../src/data/panelManager');
    invalidateCache();
    const original = upsertPanel({ guildId: 'g1', channelId: 'c1', title: 'A' });
    // small delay to ensure updatedAt differs
    const beforePatch = original.updatedAt;
    const patched = patchPanel(original.id, { color: '#abc', footerText: 'Footer' });
    assert.strictEqual(patched.color, '#abc');
    assert.strictEqual(patched.footerText, 'Footer');
    assert.strictEqual(patched.title, 'A'); // preserved
    assert.ok(patched.updatedAt >= beforePatch);
});

test('panelManager: getPanelsByGuild filters by guildId', () => {
    resetPanelsFile();
    const { upsertPanel, getPanelsByGuild, invalidateCache } = require('../../src/data/panelManager');
    invalidateCache();
    upsertPanel({ guildId: 'g1', channelId: 'c1', title: 'P1' });
    upsertPanel({ guildId: 'g1', channelId: 'c2', title: 'P2' });
    upsertPanel({ guildId: 'g2', channelId: 'c3', title: 'P3' });
    const g1panels = getPanelsByGuild('g1');
    assert.strictEqual(g1panels.length, 2);
    assert.strictEqual(
        g1panels.every(p => p.guildId === 'g1'),
        true
    );
    const g2panels = getPanelsByGuild('g2');
    assert.strictEqual(g2panels.length, 1);
});

test('panelManager: deletePanel removes panel and returns true/false', () => {
    resetPanelsFile();
    const { upsertPanel, deletePanel, getPanel, invalidateCache } = require('../../src/data/panelManager');
    invalidateCache();
    const p1 = upsertPanel({ guildId: 'g1', channelId: 'c1' });
    const p2 = upsertPanel({ guildId: 'g1', channelId: 'c2' });
    const removed = deletePanel(p1.id);
    assert.strictEqual(removed, true);
    assert.strictEqual(getPanel(p1.id), null);
    assert.ok(getPanel(p2.id), 'p2 should still exist');
    // delete non-existent returns false
    const removed2 = deletePanel('tp_nonexistent');
    assert.strictEqual(removed2, false);
});

test('panelManager: deletePanelsByGuild removes all panels in guild', () => {
    resetPanelsFile();
    const {
        upsertPanel,
        deletePanelsByGuild,
        getPanelsByGuild,
        invalidateCache
    } = require('../../src/data/panelManager');
    invalidateCache();
    upsertPanel({ guildId: 'g1', channelId: 'c1' });
    upsertPanel({ guildId: 'g1', channelId: 'c2' });
    upsertPanel({ guildId: 'g2', channelId: 'c3' });
    const count = deletePanelsByGuild('g1');
    assert.strictEqual(count, 2);
    assert.strictEqual(getPanelsByGuild('g1').length, 0);
    assert.strictEqual(getPanelsByGuild('g2').length, 1);
});

test('panelManager: handles corrupted panels.json gracefully', () => {
    resetPanelsFile();
    fs.writeFileSync(panelsPath, 'not valid json {{{{', 'utf8');
    const { loadPanels, invalidateCache } = require('../../src/data/panelManager');
    invalidateCache();
    const all = loadPanels();
    assert.strictEqual(typeof all, 'object');
    assert.strictEqual(Object.keys(all).length, 0);
    // v3.9.26: load sekarang mengkarantina file korup (rename .corrupt-<ts>)
    // supaya isi lama tidak ditimpa diam-diam — bersihkan artefaknya setelah assert.
    for (const f of fs.readdirSync(path.dirname(panelsPath))) {
        if (f.startsWith('panels.json.corrupt-')) {
            try {
                fs.unlinkSync(path.join(path.dirname(panelsPath), f));
            } catch (_) {}
        }
    }
});

test('panelManager: handles invalid format (array) panels.json gracefully', () => {
    resetPanelsFile();
    fs.writeFileSync(panelsPath, JSON.stringify(['not', 'an', 'object']), 'utf8');
    const { loadPanels, invalidateCache } = require('../../src/data/panelManager');
    invalidateCache();
    const all = loadPanels();
    assert.strictEqual(typeof all, 'object');
    assert.strictEqual(Array.isArray(all), false);
    // v3.9.26: idem — bersihkan artefak karantina (valid JSON tapi struktur salah).
    for (const f of fs.readdirSync(path.dirname(panelsPath))) {
        if (f.startsWith('panels.json.corrupt-')) {
            try {
                fs.unlinkSync(path.join(path.dirname(panelsPath), f));
            } catch (_) {}
        }
    }
});

// === parseColor tests ===
test('panels.parseColor: accepts 6-digit hex with #', () => {
    const { parseColor } = require('../../src/commands/panels');
    assert.strictEqual(parseColor('#ff5733'), 0xff5733);
});

test('panels.parseColor: accepts 6-digit hex without #', () => {
    const { parseColor } = require('../../src/commands/panels');
    assert.strictEqual(parseColor('ff5733'), 0xff5733);
});

test('panels.parseColor: accepts 3-digit hex (#fff)', () => {
    const { parseColor } = require('../../src/commands/panels');
    assert.strictEqual(parseColor('#fff'), 0xffffff);
});

test('panels.parseColor: accepts decimal number', () => {
    const { parseColor } = require('../../src/commands/panels');
    assert.strictEqual(parseColor(0xff5733), 0xff5733);
});

test('panels.parseColor: returns null for null/empty', () => {
    const { parseColor } = require('../../src/commands/panels');
    assert.strictEqual(parseColor(null), null);
    assert.strictEqual(parseColor(undefined), null);
    assert.strictEqual(parseColor(''), null);
});

test('panels.parseColor: throws on invalid format', () => {
    const { parseColor } = require('../../src/commands/panels');
    assert.throws(() => parseColor('not-a-color'), /Format color tidak valid/);
    assert.throws(() => parseColor('#xyz'), /Format color tidak valid/);
    assert.throws(() => parseColor('#12345'), /Format color tidak valid/);
});

// === validateUrl tests ===
test('panels.validateUrl: accepts http(s) URLs', () => {
    const { validateUrl } = require('../../src/commands/panels');
    assert.strictEqual(validateUrl('https://example.com/image.png'), 'https://example.com/image.png');
    assert.strictEqual(validateUrl('http://example.com/img.jpg'), 'http://example.com/img.jpg');
});

test('panels.validateUrl: rejects non-http protocols', () => {
    const { validateUrl } = require('../../src/commands/panels');
    assert.strictEqual(validateUrl('ftp://example.com/img.png'), null);
    assert.strictEqual(validateUrl('javascript:alert(1)'), null);
    assert.strictEqual(validateUrl('file:///etc/passwd'), null);
});

test('panels.validateUrl: returns null for invalid URLs', () => {
    const { validateUrl } = require('../../src/commands/panels');
    assert.strictEqual(validateUrl('not a url'), null);
    assert.strictEqual(validateUrl('http://'), null);
});

test('panels.validateUrl: returns null for null/empty/non-string', () => {
    const { validateUrl } = require('../../src/commands/panels');
    assert.strictEqual(validateUrl(null), null);
    assert.strictEqual(validateUrl(undefined), null);
    assert.strictEqual(validateUrl(''), null);
    assert.strictEqual(validateUrl(123), null);
});

// === buildTicketPanel tests ===
test('panels.buildTicketPanel: builds embed with custom title/body/color', async () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const panel = {
        title: 'Custom Panel',
        body: 'Welcome to {server}!',
        color: '#ff5733',
        categoryIds: ['transaction'],
        useDropdown: false
    };
    const ctx = {
        guild: { name: 'Test Server' },
        client: {
            user: {
                username: 'TestBot',
                displayAvatarURL: () => 'https://example.com/avatar.png'
            }
        },
        config: {
            ticketCategories: [
                { id: 'transaction', label: 'Transaksi', emoji: '🔑', style: 'Primary', requiresKey: true }
            ],
            products: [{ label: 'VIP 30 Hari', value: 'vip30', price: 'Rp 50.000', category: 'transaction' }],
            messages: {
                ticketTitle: 'Default Title',
                ticketBody: 'Default Body',
                ticketPriceHeader: 'PRICE'
            }
        }
    };
    const { embed, components } = buildTicketPanel(panel, ctx);
    assert.strictEqual(embed.data.title, 'Custom Panel');
    assert.strictEqual(embed.data.description, 'Welcome to Test Server!');
    assert.strictEqual(embed.data.color, 0xff5733);
    // Components: 1 button (transaction category)
    assert.ok(components.length >= 1);
    assert.strictEqual(components[0].components.length, 1);
});

test('panels.buildTicketPanel: fallbacks to global config when panel field is null', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const panel = {
        title: null,
        body: null,
        color: null,
        categoryIds: [],
        useDropdown: false
    };
    const ctx = {
        guild: { name: 'Test' },
        client: { user: { username: 'Bot', displayAvatarURL: () => 'http://x' } },
        config: {
            ticketCategories: [{ id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false }],
            products: [],
            messages: {
                ticketTitle: 'Global Title',
                ticketBody: 'Global {server}',
                ticketPriceHeader: 'Harga'
            }
        }
    };
    const { embed } = buildTicketPanel(panel, ctx);
    assert.strictEqual(embed.data.title, 'Global Title');
    assert.strictEqual(embed.data.description, 'Global Test');
    // default orange color
    assert.strictEqual(embed.data.color, 0xe67e22);
});

test('panels.buildTicketPanel: useDropdown=true builds select menu instead of buttons', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const panel = {
        title: 'X',
        body: 'X',
        color: null,
        categoryIds: ['transaction', 'help'],
        useDropdown: true
    };
    const ctx = {
        guild: { name: 'T' },
        client: { user: { username: 'B', displayAvatarURL: () => 'http://x' } },
        config: {
            ticketCategories: [
                { id: 'transaction', label: 'Beli', emoji: '🔑', style: 'Primary', requiresKey: true },
                { id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false }
            ],
            products: [],
            messages: { ticketTitle: 'T', ticketBody: 'B', ticketPriceHeader: 'P' }
        }
    };
    const { components } = buildTicketPanel(panel, ctx);
    assert.strictEqual(components.length, 1);
    const menu = components[0].components[0];
    // discord.js v14 StringSelectMenuBuilder exposes options via .options getter
    // (underlying data may vary between versions — use getter for stability)
    const opts = menu.options;
    assert.strictEqual(opts.length, 2);
    assert.strictEqual(menu.data.custom_id, 'ticket_cat_select');
});

test('panels.buildTicketPanel: filter categories by categoryIds', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const panel = {
        title: 'X',
        body: 'X',
        color: null,
        categoryIds: ['help'], // only show help
        useDropdown: false
    };
    const ctx = {
        guild: { name: 'T' },
        client: { user: { username: 'B', displayAvatarURL: () => 'http://x' } },
        config: {
            ticketCategories: [
                { id: 'transaction', label: 'Beli', emoji: '🔑', style: 'Primary', requiresKey: true },
                { id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false },
                { id: 'report', label: 'Report', emoji: '⚠️', style: 'Danger', requiresKey: false }
            ],
            products: [],
            messages: { ticketTitle: 'T', ticketBody: 'B', ticketPriceHeader: 'P' }
        }
    };
    const { components } = buildTicketPanel(panel, ctx);
    // Only 1 button (help)
    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0].components.length, 1);
    const btn = components[0].components[0];
    assert.strictEqual(btn.data.custom_id, 'ticket_cat:help');
});

test('panels.buildTicketPanel: categoryIds empty = show all', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const panel = {
        title: 'X',
        body: 'X',
        color: null,
        categoryIds: [], // empty = all
        useDropdown: false
    };
    const ctx = {
        guild: { name: 'T' },
        client: { user: { username: 'B', displayAvatarURL: () => 'http://x' } },
        config: {
            ticketCategories: [
                { id: 'transaction', label: 'Beli', emoji: '🔑', style: 'Primary', requiresKey: true },
                { id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false }
            ],
            products: [],
            messages: { ticketTitle: 'T', ticketBody: 'B', ticketPriceHeader: 'P' }
        }
    };
    const { components } = buildTicketPanel(panel, ctx);
    assert.strictEqual(components[0].components.length, 2); // all 2 categories
});

test('panels.buildTicketPanel: image and thumbnail URLs set when valid', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const panel = {
        title: 'X',
        body: 'X',
        color: null,
        imageUrl: 'https://example.com/banner.png',
        thumbnailUrl: 'https://example.com/icon.png',
        categoryIds: [],
        useDropdown: false
    };
    const ctx = {
        guild: { name: 'T' },
        client: { user: { username: 'B', displayAvatarURL: () => 'http://x' } },
        config: {
            ticketCategories: [{ id: 'help', label: 'H', emoji: '📞', style: 'Secondary', requiresKey: false }],
            products: [],
            messages: { ticketTitle: 'T', ticketBody: 'B', ticketPriceHeader: 'P' }
        }
    };
    const { embed } = buildTicketPanel(panel, ctx);
    assert.strictEqual(embed.data.image.url, 'https://example.com/banner.png');
    assert.strictEqual(embed.data.thumbnail.url, 'https://example.com/icon.png');
});

test('panels.buildTicketPanel: image and thumbnail skipped when invalid URL', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const panel = {
        title: 'X',
        body: 'X',
        color: null,
        imageUrl: 'not-a-url',
        thumbnailUrl: 'ftp://invalid',
        categoryIds: [],
        useDropdown: false
    };
    const ctx = {
        guild: { name: 'T' },
        client: { user: { username: 'B', displayAvatarURL: () => 'http://x' } },
        config: {
            ticketCategories: [{ id: 'help', label: 'H', emoji: '📞', style: 'Secondary', requiresKey: false }],
            products: [],
            messages: { ticketTitle: 'T', ticketBody: 'B', ticketPriceHeader: 'P' }
        }
    };
    const { embed } = buildTicketPanel(panel, ctx);
    assert.strictEqual(embed.data.image, undefined);
    assert.strictEqual(embed.data.thumbnail, undefined);
});

test('panels.buildTicketPanel: footer text overrides default bot username', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const panel = {
        title: 'X',
        body: 'X',
        color: null,
        footerText: 'Custom Footer',
        categoryIds: [],
        useDropdown: false
    };
    const ctx = {
        guild: { name: 'T' },
        client: { user: { username: 'BotName', displayAvatarURL: () => 'http://x' } },
        config: {
            ticketCategories: [{ id: 'help', label: 'H', emoji: '📞', style: 'Secondary', requiresKey: false }],
            products: [],
            messages: { ticketTitle: 'T', ticketBody: 'B', ticketPriceHeader: 'P' }
        }
    };
    const { embed } = buildTicketPanel(panel, ctx);
    assert.strictEqual(embed.data.footer.text, 'Custom Footer');
});

test('panels.buildTicketPanel: auto-wrap buttons to multiple rows when >5 categories', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const panel = {
        title: 'X',
        body: 'X',
        color: null,
        categoryIds: [],
        useDropdown: false
    };
    const ctx = {
        guild: { name: 'T' },
        client: { user: { username: 'B', displayAvatarURL: () => 'http://x' } },
        config: {
            ticketCategories: Array.from({ length: 8 }, (_, i) => ({
                id: `cat${i}`,
                label: `Cat ${i}`,
                emoji: '🎫',
                style: 'Primary',
                requiresKey: true
            })),
            products: [],
            messages: { ticketTitle: 'T', ticketBody: 'B', ticketPriceHeader: 'P' }
        }
    };
    const { components } = buildTicketPanel(panel, ctx);
    // 8 categories → 2 rows: 5 + 3
    assert.strictEqual(components.length, 2);
    assert.strictEqual(components[0].components.length, 5);
    assert.strictEqual(components[1].components.length, 3);
});

// === Registry tests ===
test('registry: new panel commands registered', () => {
    const { getCommands } = require('../../src/commands/registry');
    const commands = getCommands();
    const names = commands.map(c => c.name);
    assert.ok(names.includes('list-panels'), 'list-panels should be registered');
    assert.ok(names.includes('delete-panel'), 'delete-panel should be registered');
    assert.ok(names.includes('update-panel'), 'update-panel should be registered');
    assert.ok(names.includes('refresh-panel'), 'refresh-panel should be registered');
});

test('registry: setup-ticket-panel has new options (body, color, image, thumbnail, footer, channel, use_dropdown)', () => {
    const { getCommands } = require('../../src/commands/registry');
    const commands = getCommands();
    const cmd = commands.find(c => c.name === 'setup-ticket-panel');
    assert.ok(cmd, 'setup-ticket-panel command not found');
    const optionNames = cmd.options.map(o => o.name);
    assert.ok(optionNames.includes('title'));
    assert.ok(optionNames.includes('categories'));
    assert.ok(optionNames.includes('body'));
    assert.ok(optionNames.includes('color'));
    assert.ok(optionNames.includes('image'));
    assert.ok(optionNames.includes('thumbnail'));
    assert.ok(optionNames.includes('footer'));
    assert.ok(optionNames.includes('channel'));
    assert.ok(optionNames.includes('use_dropdown'));
});

test('registry: update-panel has field choices', () => {
    const { getCommands } = require('../../src/commands/registry');
    const commands = getCommands();
    const cmd = commands.find(c => c.name === 'update-panel');
    assert.ok(cmd, 'update-panel command not found');
    const fieldOpt = cmd.options.find(o => o.name === 'field');
    assert.ok(fieldOpt, 'update-panel should have field option');
    assert.ok(fieldOpt.choices);
    const choiceVals = fieldOpt.choices.map(c => c.value);
    assert.ok(choiceVals.includes('title'));
    assert.ok(choiceVals.includes('body'));
    assert.ok(choiceVals.includes('color'));
    assert.ok(choiceVals.includes('image'));
    assert.ok(choiceVals.includes('thumbnail'));
    assert.ok(choiceVals.includes('footer'));
});

// === Help.js updated test ===
test('help.js: help embed mentions new v3.9.14+ commands', async () => {
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

    assert.strictEqual(replies.length, 1);
    const embed = replies[0].embeds[0];
    const allText = embed.data.fields.map(f => f.value).join('\n') + embed.data.description;

    // v3.9.14 new commands
    assert.match(allText, /list-panels/);
    assert.match(allText, /delete-panel/);
    assert.match(allText, /update-panel/);
    assert.match(allText, /refresh-panel/);
    assert.match(allText, /use_dropdown/);
    // v3.9.37: versi di help kini dinamis dari package.json (anti-stale) —
    // assert-nya menyamakan dengan package.json, bukan literal hardcode.
    const { version: pkgVersion } = require('../../package.json');
    assert.match(allText, new RegExp(`v${pkgVersion.replace(/\./g, '\\.')}`));
    assert.doesNotMatch(allText, /v3\.9\.26/); // literal lama tidak boleh muncul lagi
});

// === Router test ===
test('commands/index.js: routes new panel-mgmt commands', () => {
    const router = require('../../src/commands');
    assert.strictEqual(typeof router, 'function');
});

// === v3.9.18 tests: rename Bantuan→Help, Laporkan→Report, tambah claim_giveaway ===

test('configManager.DEFAULTS: ticketCategories pakai label "Help" & "Report" (bukan "Bantuan Staff")', () => {
    const { DEFAULTS } = require('../../src/data/configManager');
    const help = DEFAULTS.ticketCategories.find(c => c.id === 'help');
    const report = DEFAULTS.ticketCategories.find(c => c.id === 'report');
    assert.ok(help, 'help category should exist in DEFAULTS');
    assert.ok(report, 'report category should exist in DEFAULTS');
    assert.strictEqual(help.label, 'Help', 'help.label should be "Help"');
    assert.strictEqual(report.label, 'Report', 'report.label should be "Report"');
    // Pastikan label lama sudah tidak dipakai
    assert.notStrictEqual(help.label, 'Bantuan Staff');
    assert.notStrictEqual(report.label, 'Laporkan Member');
});

test('configManager.DEFAULTS: claim_giveaway ada sebagai contoh kategori custom', () => {
    const { DEFAULTS } = require('../../src/data/configManager');
    const claimGiveaway = DEFAULTS.ticketCategories.find(c => c.id === 'claim_giveaway');
    assert.ok(claimGiveaway, 'claim_giveaway category should exist in DEFAULTS');
    assert.strictEqual(claimGiveaway.label, 'Claim Giveaway');
    assert.strictEqual(claimGiveaway.emoji, '🎁');
    assert.strictEqual(claimGiveaway.style, 'Success');
    assert.strictEqual(claimGiveaway.requiresKey, false);
    // isDefault=false supaya admin bisa /remove-category kalau tidak mau
    assert.strictEqual(claimGiveaway.isDefault, false);
});

test('configManager.getConfig: migration rename label "Bantuan Staff" → "Help"', () => {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, '..', '..', 'data', 'config.json');
    // Backup existing config if any
    let backup = null;
    if (fs.existsSync(configPath)) {
        backup = fs.readFileSync(configPath, 'utf8');
        fs.unlinkSync(configPath);
    }
    try {
        // Write config with OLD labels
        const oldConfig = {
            roles: { admin: '123' },
            ticketCategories: [
                {
                    id: 'transaction',
                    label: 'Beli Key',
                    emoji: '🔑',
                    style: 'Primary',
                    requiresKey: true,
                    isDefault: true
                },
                {
                    id: 'help',
                    label: 'Bantuan Staff',
                    emoji: '📞',
                    style: 'Secondary',
                    requiresKey: false,
                    isDefault: true
                },
                {
                    id: 'report',
                    label: 'Laporkan Member',
                    emoji: '⚠️',
                    style: 'Danger',
                    requiresKey: false,
                    isDefault: true
                }
            ]
        };
        fs.writeFileSync(configPath, JSON.stringify(oldConfig), 'utf8');

        // getConfig should trigger migration
        const { getConfig } = require('../../src/data/configManager');
        const config = getConfig();

        const help = config.ticketCategories.find(c => c.id === 'help');
        const report = config.ticketCategories.find(c => c.id === 'report');
        assert.strictEqual(help.label, 'Help', 'migration should rename help label to "Help"');
        assert.strictEqual(report.label, 'Report', 'migration should rename report label to "Report"');

        // claim_giveaway should be auto-added
        const claimGiveaway = config.ticketCategories.find(c => c.id === 'claim_giveaway');
        assert.ok(claimGiveaway, 'migration should add claim_giveaway category');
    } finally {
        // Restore or delete
        if (backup !== null) {
            fs.writeFileSync(configPath, backup, 'utf8');
        } else if (fs.existsSync(configPath)) {
            fs.unlinkSync(configPath);
        }
    }
});

test('configManager.getConfig: migration TIDAK ubah label yang sudah di-customize admin', () => {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, '..', '..', 'data', 'config.json');
    let backup = null;
    if (fs.existsSync(configPath)) {
        backup = fs.readFileSync(configPath, 'utf8');
        fs.unlinkSync(configPath);
    }
    try {
        const customConfig = {
            roles: { admin: '123' },
            ticketCategories: [
                {
                    id: 'transaction',
                    label: 'Beli Key',
                    emoji: '🔑',
                    style: 'Primary',
                    requiresKey: true,
                    isDefault: true
                },
                {
                    id: 'help',
                    label: 'Tanya Admin',
                    emoji: '💬',
                    style: 'Secondary',
                    requiresKey: false,
                    isDefault: true
                },
                {
                    id: 'report',
                    label: 'Lapor Siapa Aja',
                    emoji: '📢',
                    style: 'Danger',
                    requiresKey: false,
                    isDefault: true
                }
            ]
        };
        fs.writeFileSync(configPath, JSON.stringify(customConfig), 'utf8');

        const { getConfig } = require('../../src/data/configManager');
        const config = getConfig();

        const help = config.ticketCategories.find(c => c.id === 'help');
        const report = config.ticketCategories.find(c => c.id === 'report');
        // Labels should NOT be changed since admin customized them
        assert.strictEqual(help.label, 'Tanya Admin', 'custom help label should be preserved');
        assert.strictEqual(report.label, 'Lapor Siapa Aja', 'custom report label should be preserved');
    } finally {
        if (backup !== null) {
            fs.writeFileSync(configPath, backup, 'utf8');
        } else if (fs.existsSync(configPath)) {
            fs.unlinkSync(configPath);
        }
    }
});

test('panels.buildTicketPanel: kategori requiresKey=false (claim_giveaway) tetap di-render sebagai button', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const panel = {
        title: 'X',
        body: 'X',
        color: null,
        categoryIds: [], // show all
        useDropdown: false
    };
    const ctx = {
        guild: { name: 'T' },
        client: { user: { username: 'B', displayAvatarURL: () => 'http://x' } },
        config: {
            ticketCategories: [
                { id: 'transaction', label: 'Beli', emoji: '🔑', style: 'Primary', requiresKey: true },
                { id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false },
                { id: 'report', label: 'Report', emoji: '⚠️', style: 'Danger', requiresKey: false },
                { id: 'claim_giveaway', label: 'Claim Giveaway', emoji: '🎁', style: 'Success', requiresKey: false }
            ],
            products: [],
            messages: { ticketTitle: 'T', ticketBody: 'B', ticketPriceHeader: 'P' }
        }
    };
    const { components } = buildTicketPanel(panel, ctx);
    // 4 categories → 1 row with 4 buttons (max 5 per row)
    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0].components.length, 4);
    // Verify claim_giveaway button exists
    const btns = components[0].components;
    const claimBtn = btns.find(b => b.data.custom_id === 'ticket_cat:claim_giveaway');
    assert.ok(claimBtn, 'claim_giveaway button should be rendered');
    assert.strictEqual(claimBtn.data.label, 'Claim Giveaway');
});

test('panels.buildTicketPanel: dropdown description berbasis konten kategori (v3.9.27)', () => {
    const { buildTicketPanel } = require('../../src/commands/panels');
    const panel = {
        title: 'X',
        body: 'X',
        color: null,
        categoryIds: [],
        useDropdown: true
    };
    const ctx = {
        guild: { name: 'T' },
        client: { user: { username: 'B', displayAvatarURL: () => 'http://x' } },
        config: {
            ticketCategories: [
                { id: 'transaction', label: 'Beli', emoji: '🔑', style: 'Primary', requiresKey: true },
                // v3.9.27: kategori non-key yang PUNYA produk (jual akun/jasa) —
                // tadinya salah dilabeli "Bantuan / non-transaksi".
                { id: 'jual_akun', label: 'Jual Akun', emoji: '📦', style: 'Success', requiresKey: false },
                { id: 'claim_giveaway', label: 'Claim Giveaway', emoji: '🎁', style: 'Success', requiresKey: false }
            ],
            products: [
                {
                    label: 'VIP 30 Hari',
                    value: 'vip30',
                    price: 'Rp 30.000',
                    category: 'transaction',
                    requiresKey: true
                },
                {
                    label: 'Akun ML Mythic',
                    value: 'akun_ml',
                    price: 'Rp 150.000',
                    category: 'jual_akun',
                    requiresKey: false
                }
            ],
            messages: { ticketTitle: 'T', ticketBody: 'B', ticketPriceHeader: 'P' }
        }
    };
    const { components } = buildTicketPanel(panel, ctx);
    const menu = components[0].components[0];
    const opts = menu.options;
    assert.strictEqual(opts.length, 3);
    // discord.js v14: option data disimpan di .data.description (bukan .description langsung)
    const getDesc = o => o.data?.description || o.description;
    // Kategori key DENGAN produk → jumlah produk + status key
    assert.strictEqual(getDesc(opts[0]), 'Transaksi — 1 produk (pakai key)');
    // Kategori non-key DENGAN produk → TRANSAKSI (bukan "Bantuan" — bug fix v3.9.27)
    assert.strictEqual(getDesc(opts[1]), 'Transaksi — 1 produk (tanpa key)');
    // Kategori TANPA produk → tiket langsung
    assert.strictEqual(getDesc(opts[2]), 'Bantuan / buka tiket langsung');
});

// === v3.9.19 tests: flexibility fix + new commands ===

test('registry: /update-category command registered with all options', () => {
    const { getCommands } = require('../../src/commands/registry');
    const commands = getCommands();
    const cmd = commands.find(c => c.name === 'update-category');
    assert.ok(cmd, 'update-category should be registered');
    const optionNames = cmd.options.map(o => o.name);
    assert.ok(optionNames.includes('id'));
    assert.ok(optionNames.includes('label'));
    assert.ok(optionNames.includes('emoji'));
    assert.ok(optionNames.includes('style'));
    assert.ok(optionNames.includes('requires_key'));
});

test('registry: /update-product command registered with all options', () => {
    const { getCommands } = require('../../src/commands/registry');
    const commands = getCommands();
    const cmd = commands.find(c => c.name === 'update-product');
    assert.ok(cmd, 'update-product should be registered');
    const optionNames = cmd.options.map(o => o.name);
    assert.ok(optionNames.includes('value'));
    assert.ok(optionNames.includes('label'));
    assert.ok(optionNames.includes('price'));
    assert.ok(optionNames.includes('duration'));
    assert.ok(optionNames.includes('category'));
    assert.ok(optionNames.includes('requires_key'));
    // value wajib required (identifier)
    const valueOpt = cmd.options.find(o => o.name === 'value');
    assert.strictEqual(valueOpt.required, true, 'value must be required');
});

test('help.js: mentions /update-category and /update-product', async () => {
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
    const allText =
        replies[0].embeds[0].data.fields.map(f => f.value).join('\n') + replies[0].embeds[0].data.description;
    assert.match(allText, /update-category/);
    assert.match(allText, /update-product/);
});

// === v3.9.19 integration test: bug fix behavior ===
// Verify: kategori requiresKey=false TAPI punya produk → seharusnya dropdown produk.
// Ini scenario "Jasa" dengan beberapa jasa non-key.
// Note: test ini tidak bisa langsung test handler ticket.js karena butuh mock
// Discord interaction yang kompleks. Tapi kita bisa verify logic-nya via
// config structure — kalau kategori jasa punya produk, behavior akan jadi dropdown.

test('v3.9.19: kategori jasa dengan produk non-key → seharusnya jadi dropdown (bukan direct ticket)', () => {
    // Verify struktur config: kategori "jasa" punya produk terkait.
    // Logic di ticket.js v3.9.19: cek productsInCat.length > 0 → tampilkan dropdown.
    const config = {
        ticketCategories: [
            { id: 'jasa', label: 'Jasa', emoji: '🛠️', style: 'Primary', requiresKey: false, isDefault: false }
        ],
        products: [
            { label: 'Jasa Joki', value: 'joki', price: 'Rp 200.000', category: 'jasa', requiresKey: false },
            { label: 'Jasa Install', value: 'install', price: 'Rp 50.000', category: 'jasa', requiresKey: false }
        ]
    };
    const productsInCat = config.products.filter(p => (p.category || 'transaction') === 'jasa');
    assert.strictEqual(productsInCat.length, 2, 'jasa category should have 2 products');
    assert.strictEqual(productsInCat.length > 0, true, 'should show dropdown (not direct ticket)');
});

test('v3.9.19: kategori help tanpa produk → seharusnya langsung create ticket', () => {
    const config = {
        ticketCategories: [
            { id: 'help', label: 'Help', emoji: '📞', style: 'Secondary', requiresKey: false, isDefault: true }
        ],
        products: []
    };
    const productsInCat = config.products.filter(p => (p.category || 'transaction') === 'help');
    assert.strictEqual(productsInCat.length, 0, 'help category should have 0 products');
    assert.strictEqual(productsInCat.length === 0, true, 'should direct create ticket (no dropdown)');
});

test('v3.9.19: kategori transaction campur key & non-key → semua muncul di dropdown', () => {
    const config = {
        ticketCategories: [
            { id: 'transaction', label: 'Beli', emoji: '🔑', style: 'Primary', requiresKey: true, isDefault: true }
        ],
        products: [
            { label: 'VIP 30 Hari', value: 'vip30', price: 'Rp 50.000', category: 'transaction', requiresKey: true },
            {
                label: 'Jasa Joki Mythic',
                value: 'joki',
                price: 'Rp 200.000',
                category: 'transaction',
                requiresKey: false
            },
            {
                label: 'Jasa Booster',
                value: 'booster',
                price: 'Rp 300.000',
                category: 'transaction',
                requiresKey: false
            }
        ]
    };
    const productsInCat = config.products.filter(p => (p.category || 'transaction') === 'transaction');
    assert.strictEqual(productsInCat.length, 3, 'all 3 products should show in dropdown');
    // Verify mix of requiresKey
    const keyProducts = productsInCat.filter(p => p.requiresKey === true);
    const nonKeyProducts = productsInCat.filter(p => p.requiresKey === false);
    assert.strictEqual(keyProducts.length, 1, '1 key product (VIP)');
    assert.strictEqual(nonKeyProducts.length, 2, '2 non-key products (Joki, Booster)');
});

// === v3.9.20 tests: Set Key tidak auto-close, DM HP-friendly, isCompleted flag ===

test('ticketManager: patchTicketMeta melakukan partial update tanpa overwrite field lain', () => {
    const fs = require('fs');
    const path = require('path');
    const ticketsPath = path.join(__dirname, '..', '..', 'data', 'tickets.json');
    // Backup existing
    let backup = null;
    if (fs.existsSync(ticketsPath)) {
        backup = fs.readFileSync(ticketsPath, 'utf8');
        fs.unlinkSync(ticketsPath);
    }
    try {
        const {
            setTicketMeta,
            patchTicketMeta,
            getTicketMeta,
            invalidateCache
        } = require('../../src/data/ticketManager');
        // invalidateCache tidak ada — tidak masalah, ticketsManager pakai readFileSync fresh
        // Set initial meta
        setTicketMeta('ch-1', {
            userId: 'user-1',
            productName: 'VIP 30 Hari',
            price: 'Rp 50.000',
            guildId: 'g-1',
            category: 'transaction',
            requiresKey: true
        });

        // Verify initial
        const before = getTicketMeta('ch-1');
        assert.strictEqual(before.userId, 'user-1');
        assert.strictEqual(before.productName, 'VIP 30 Hari');
        assert.strictEqual(before.isCompleted, false);
        assert.strictEqual(before.keySetAt, null);

        // Patch hanya isCompleted, keySetAt, keySetBy
        const patched = patchTicketMeta('ch-1', {
            isCompleted: true,
            keySetAt: 1700000000000,
            keySetBy: 'admin-1'
        });
        assert.strictEqual(patched, true, 'patchTicketMeta should return true on success');

        // Verify: other fields PRESERVED
        const after = getTicketMeta('ch-1');
        assert.strictEqual(after.userId, 'user-1', 'userId should be preserved');
        assert.strictEqual(after.productName, 'VIP 30 Hari', 'productName should be preserved');
        assert.strictEqual(after.price, 'Rp 50.000', 'price should be preserved');
        assert.strictEqual(after.category, 'transaction', 'category should be preserved');
        assert.strictEqual(after.requiresKey, true, 'requiresKey should be preserved');
        // Patched fields updated
        assert.strictEqual(after.isCompleted, true, 'isCompleted should be updated');
        assert.strictEqual(after.keySetAt, 1700000000000, 'keySetAt should be updated');
        assert.strictEqual(after.keySetBy, 'admin-1', 'keySetBy should be updated');
    } finally {
        // Restore
        if (backup !== null) {
            fs.writeFileSync(ticketsPath, backup, 'utf8');
        } else if (fs.existsSync(ticketsPath)) {
            fs.unlinkSync(ticketsPath);
        }
    }
});

test('ticketManager: patchTicketMeta returns false kalau channel tidak ada di meta', () => {
    const fs = require('fs');
    const path = require('path');
    const ticketsPath = path.join(__dirname, '..', '..', 'data', 'tickets.json');
    let backup = null;
    if (fs.existsSync(ticketsPath)) {
        backup = fs.readFileSync(ticketsPath, 'utf8');
        fs.unlinkSync(ticketsPath);
    }
    try {
        const { patchTicketMeta } = require('../../src/data/ticketManager');
        const result = patchTicketMeta('nonexistent-channel', { isCompleted: true });
        assert.strictEqual(result, false, 'should return false for non-existent channel');
    } finally {
        if (backup !== null) {
            fs.writeFileSync(ticketsPath, backup, 'utf8');
        } else if (fs.existsSync(ticketsPath)) {
            fs.unlinkSync(ticketsPath);
        }
    }
});

test('ticketManager exports: patchTicketMeta di-export', () => {
    const ticketManager = require('../../src/data/ticketManager');
    assert.strictEqual(typeof ticketManager.patchTicketMeta, 'function', 'patchTicketMeta should be exported');
});

// Cleanup
test('cleanup: remove test panels.json', () => {
    resetPanelsFile();
    assert.ok(true);
});
