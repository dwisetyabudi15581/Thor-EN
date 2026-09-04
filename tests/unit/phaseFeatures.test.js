/**
 * Unit tests untuk Phase 1+2+3 features:
 * - config.verifyButton (custom label/emoji/style)
 * - config.ticketCategories (default + custom)
 * - config.messages.ticketPriceHeader
 * - ticketManager.createTicket with category & isHelp flag
 * - selfRoleManager.addRoleToPanel with style & requiresRoleId
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

test('configManager: verifyButton defaults applied', () => {
    const { getConfig, DEFAULTS } = require('../../src/data/configManager');
    const config = getConfig();
    assert.ok(config.verifyButton, 'verifyButton should exist');
    assert.ok(typeof config.verifyButton === 'object');
    assert.ok('label' in config.verifyButton);
    assert.ok('emoji' in config.verifyButton);
    assert.ok('style' in config.verifyButton);
});

test('configManager: ticketCategories defaults applied', () => {
    const { getConfig } = require('../../src/data/configManager');
    const config = getConfig();
    assert.ok(Array.isArray(config.ticketCategories));
    assert.ok(config.ticketCategories.length >= 3, 'should have at least 3 default categories');
    const ids = config.ticketCategories.map(c => c.id);
    assert.ok(ids.includes('transaction'));
    assert.ok(ids.includes('help'));
    assert.ok(ids.includes('report'));
});

test('configManager: ticketPriceHeader default exists', () => {
    const { getConfig } = require('../../src/data/configManager');
    const config = getConfig();
    assert.ok(config.messages.ticketPriceHeader, 'ticketPriceHeader should exist in messages');
    assert.ok(typeof config.messages.ticketPriceHeader === 'string');
});

test('configManager: ticketCategories have valid structure', () => {
    const { getConfig } = require('../../src/data/configManager');
    const config = getConfig();
    for (const cat of config.ticketCategories) {
        assert.ok(cat.id, 'category should have id');
        assert.ok(cat.label, 'category should have label');
        assert.ok(cat.emoji, 'category should have emoji');
        assert.ok(
            ['Primary', 'Secondary', 'Success', 'Danger'].includes(cat.style),
            `category ${cat.id} should have valid style, got: ${cat.style}`
        );
        assert.ok('requiresKey' in cat, `category ${cat.id} should have requiresKey field`);
    }
});

test('selfRoleManager: addRoleToPanel accepts style & requiresRoleId (Phase 3)', () => {
    const { createPanel, addRoleToPanel, deletePanel } = require('../../src/data/selfRoleManager');

    const panel = createPanel({
        guildId: 'test_guild_phase3',
        channelId: 'test_channel',
        title: 'Test Panel Phase 3',
        description: 'Test',
        type: 'button',
        exclusive: false
    });

    // Add role with custom style & requiresRoleId
    const result = addRoleToPanel(panel.id, {
        roleId: 'role_test_vip',
        label: 'VIP',
        emoji: '👑',
        description: 'VIP only',
        style: 'Success',
        requiresRoleId: 'role_verified'
    });

    assert.ok(result.ok, 'should succeed');
    const addedRole = result.panel.roles.find(r => r.roleId === 'role_test_vip');
    assert.strictEqual(addedRole.style, 'Success');
    assert.strictEqual(addedRole.requiresRoleId, 'role_verified');

    deletePanel(panel.id);
});

test('selfRoleManager: addRoleToPanel defaults style to Secondary when invalid', () => {
    const { createPanel, addRoleToPanel, deletePanel } = require('../../src/data/selfRoleManager');

    const panel = createPanel({
        guildId: 'test_guild_phase3b',
        channelId: 'test_channel',
        title: 'Test',
        description: 'Test',
        type: 'button',
        exclusive: false
    });

    const result = addRoleToPanel(panel.id, {
        roleId: 'role_test_default',
        label: 'Default',
        style: 'InvalidStyleName' // should default to Secondary
    });

    assert.ok(result.ok);
    const addedRole = result.panel.roles.find(r => r.roleId === 'role_test_default');
    assert.strictEqual(addedRole.style, 'Secondary');
    assert.strictEqual(addedRole.requiresRoleId, null);

    deletePanel(panel.id);
});

test('selfRolePanelBuilder: buildPanelComponents uses per-role style', () => {
    const { buildPanelComponents, STYLE_MAP } = require('../../src/ui/selfRolePanelBuilder');
    const { ButtonStyle } = require('discord.js');

    // Verify STYLE_MAP exports correctly
    assert.strictEqual(STYLE_MAP.Primary, ButtonStyle.Primary);
    assert.strictEqual(STYLE_MAP.Success, ButtonStyle.Success);
    assert.strictEqual(STYLE_MAP.Danger, ButtonStyle.Danger);
    assert.strictEqual(STYLE_MAP.Secondary, ButtonStyle.Secondary);

    const panel = {
        type: 'button',
        roles: [
            { roleId: '1', label: 'A', style: 'Primary', emoji: '' },
            { roleId: '2', label: 'B', style: 'Success', emoji: '' },
            { roleId: '3', label: 'C', style: 'Danger', emoji: '' }
        ]
    };

    const components = buildPanelComponents(panel);
    assert.ok(components.length > 0);
    const row = components[0];
    const buttons = row.components;
    assert.strictEqual(buttons[0].data.style, ButtonStyle.Primary);
    assert.strictEqual(buttons[1].data.style, ButtonStyle.Success);
    assert.strictEqual(buttons[2].data.style, ButtonStyle.Danger);
});

test('ticketManager: setTicketMeta accepts category & requiresKey (Phase 2)', () => {
    const { setTicketMeta, getTicketMeta, removeTicketMeta } = require('../../src/data/ticketManager');

    const testChannelId = `test_channel_phase2_${Date.now()}`;
    setTicketMeta(testChannelId, {
        userId: 'test_user',
        productName: 'VIP 30 Hari',
        price: 'Rp 50.000',
        guildId: 'test_guild',
        category: 'transaction',
        requiresKey: true
    });

    const meta = getTicketMeta(testChannelId);
    assert.strictEqual(meta.category, 'transaction');
    assert.strictEqual(meta.requiresKey, true);

    removeTicketMeta(testChannelId);
});

test('ticketManager: setTicketMeta accepts null category (help/report)', () => {
    const { setTicketMeta, getTicketMeta, removeTicketMeta } = require('../../src/data/ticketManager');

    const testChannelId = `test_channel_help_${Date.now()}`;
    setTicketMeta(testChannelId, {
        userId: 'test_user',
        productName: 'Bantuan Staff',
        price: '-',
        guildId: 'test_guild',
        category: 'help',
        requiresKey: false
    });

    const meta = getTicketMeta(testChannelId);
    assert.strictEqual(meta.category, 'help');
    assert.strictEqual(meta.requiresKey, false);

    removeTicketMeta(testChannelId);
});
