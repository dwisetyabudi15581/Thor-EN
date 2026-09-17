/**
 * Unit tests v3.27.0 — ONE-WAY (VERIFICATION) SELF-ROLE PANELS.
 *
 * The problem this feature solves: verification panels are usually the FIRST
 * thing a Discord newcomer interacts with, and newcomers tend to click the
 * button several times. On a classic toggle panel every extra click silently
 * REMOVED the role they had just claimed → they ended up "unverified" without
 * noticing. The `once` panel flag turns a panel one-way: clicking only GIVES
 * the role; a repeat click is a friendly no-op.
 *
 * Covered here:
 *   1. Registry: `once` option on /setup-selfrole + /selfrole-update.
 *   2. selfRoleManager: createPanel stores `once`, updatePanel flips it.
 *   3. Button handler (once, multi):
 *        - repeat click with the role  → no-op "all set" reply, no removal.
 *        - click without the role       → grant (twice-click stays granted).
 *   4. Button handler (once + exclusive): switching to another panel role
 *      still works; the newly claimed role can never be toggled off.
 *   5. Select handler (once, multi): selecting adds missing roles,
 *      deselecting/clearing NEVER strips anything.
 *   6. Panel embed: "One-way mode" line + footer badge.
 *   7. DASH API: POST creates a one-way panel, PUT { once } edits a live one.
 *
 * Data safety: selfRoles.json is snapshotted & restored (established pattern).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

// === Snapshot & restore selfRoles.json ===
const dataDir = path.join(__dirname, '..', '..', 'data');
const selfRolesPath = path.join(dataDir, 'selfRoles.json');
const backup = fs.existsSync(selfRolesPath) ? fs.readFileSync(selfRolesPath) : null;
if (backup === null) fs.writeFileSync(selfRolesPath, '[]');
process.on('exit', () => {
    try {
        if (backup === null) {
            if (fs.existsSync(selfRolesPath)) fs.unlinkSync(selfRolesPath);
        } else {
            fs.writeFileSync(selfRolesPath, backup);
        }
    } catch (_) {}
});

const selfRoleManager = require('../../src/data/selfRoleManager');
const selfroleHandler = require('../../src/interactions/selfrole');
const { buildPanelEmbed } = require('../../src/ui/selfRolePanelBuilder');
const { createDashHandler } = require('../../src/infra/dashServer');

// 18-digit snowflake-shaped IDs (SNOWFLAKE_RE: ^\d{5,25}$)
const GUILD_ID = '999111222333444555';
const CHANNEL_ID = '555444333222111000';
const ROLE_VERIFIED = '111222333444555666';
const ROLE_A = '222333444555666777';
const ROLE_B = '333444555666777888';

// === Guild role cache shared by every member mock ===
const guildRoles = new Map();
for (const [id, name] of [
    [ROLE_VERIFIED, 'Verified'],
    [ROLE_A, 'ColorA'],
    [ROLE_B, 'ColorB']
]) {
    guildRoles.set(id, { id, name, managed: false, position: 1 });
}
guildRoles.set(GUILD_ID, { id: GUILD_ID, name: '@everyone', managed: false, position: 0 });

/**
 * Member mock shaped for BOTH the interaction handler and the role engine:
 * `roles.cache` is a Set (has()), `roles.add/remove` are recorded + applied,
 * and `guild.members.me` is null → the hierarchy check falls back to "let
 * Discord decide" (the engine's documented warm-up behavior).
 */
function makeMember({ has = [] } = {}) {
    const state = new Set(has);
    const calls = { add: [], remove: [] };
    const guild = {
        id: GUILD_ID,
        roles: { cache: guildRoles },
        members: { me: null }
    };
    return {
        state,
        calls,
        member: {
            id: 'member_once_test',
            user: { tag: 'tester#0001' },
            guild,
            roles: {
                cache: state,
                add: async (ids) => {
                    calls.add.push(ids);
                    for (const i of Array.isArray(ids) ? ids : [ids]) state.add(i);
                },
                remove: async (ids) => {
                    calls.remove.push(ids);
                    for (const i of Array.isArray(ids) ? ids : [ids]) state.delete(i);
                }
            }
        }
    };
}

/** Interaction mock (button or select) that records replies + message edits. */
function makeInteraction({ customId, memberMock, isSelect = false, values = [] }) {
    const replies = [];
    const edits = [];
    return {
        replies,
        edits,
        isButton: () => !isSelect,
        isStringSelectMenu: () => isSelect,
        customId,
        values,
        member: memberMock.member,
        guild: memberMock.member.guild,
        reply: async (opts) => {
            replies.push(opts);
            return {};
        },
        message: {
            edit: async (opts) => {
                edits.push(opts);
                return {};
            }
        }
    };
}

/** Create a real panel with the 3 canonical roles via the manager. */
function seedPanel({ once, exclusive = false, type = 'button' }) {
    const panel = selfRoleManager.createPanel({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        title: 'Verification',
        description: 'Click to verify',
        type,
        exclusive,
        once
    });
    selfRoleManager.addRoleToPanel(panel.id, { roleId: ROLE_VERIFIED, label: 'Verify Me', emoji: '✅', style: 'Success' });
    selfRoleManager.addRoleToPanel(panel.id, { roleId: ROLE_A, label: 'Color A', emoji: '🎨' });
    selfRoleManager.addRoleToPanel(panel.id, { roleId: ROLE_B, label: 'Color B', emoji: '🖌' });
    return selfRoleManager.getPanel(panel.id);
}

// ====================================================
// === 1. Registry contract ===
// ====================================================

test('contract: /setup-selfrole and /selfrole-update expose a `once` boolean option', () => {
    const { getCommands } = require('../../src/commands/registry');
    const cmds = getCommands();
    assert.strictEqual(cmds.length, 94, 'command count unchanged (no new commands in v3.27.0)');
    for (const name of ['setup-selfrole', 'selfrole-update']) {
        const cmd = cmds.find((c) => c.name === name);
        assert.ok(cmd, `${name} is registered`);
        const onceOpt = (cmd.options || []).find((o) => o.name === 'once');
        assert.ok(onceOpt, `${name} has a once option`);
        assert.strictEqual(onceOpt.type, 5, 'once is a boolean');
        assert.notStrictEqual(onceOpt.required, true, 'once is optional');
        assert.match(onceOpt.description, /never removes/i, 'the description explains one-way behavior');
    }
});

// ====================================================
// === 2. Manager contract ===
// ====================================================

test('manager: createPanel stores `once`, updatePanel flips it, legacy panels read falsy', () => {
    const p = seedPanel({ once: true });
    assert.strictEqual(p.once, true, 'created as one-way');
    // Flip OFF on a live panel (the /selfrole-update once:false path).
    const off = selfRoleManager.updatePanel(p.id, { once: false });
    assert.strictEqual(off.once, false);
    // Flip back ON.
    const on = selfRoleManager.updatePanel(p.id, { once: true });
    assert.strictEqual(on.once, true);
    // Legacy panel (created without the field) → falsy → classic toggle.
    const legacy = selfRoleManager.createPanel({
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        title: 'Legacy',
        description: 'old panel',
        type: 'button'
    });
    assert.ok(!legacy.once, 'legacy panels default to toggle behavior');
    selfRoleManager.deletePanel(p.id);
    selfRoleManager.deletePanel(legacy.id);
});

// ====================================================
// === 3. Button handler — THE regression test ===
// ====================================================

test('button once: repeat click with the role → friendly no-op, NOTHING removed', async () => {
    const panel = seedPanel({ once: true });
    const mm = makeMember({ has: [ROLE_VERIFIED] });
    const ix = makeInteraction({ customId: `sr_btn:${panel.id}:${ROLE_VERIFIED}`, memberMock: mm });

    await selfroleHandler(ix);

    // The newcomer's 2nd/3rd/10th click must never strip the role.
    await selfroleHandler(ix);
    await selfroleHandler(ix);

    assert.strictEqual(mm.calls.remove.length, 0, 'no removal ever fired');
    assert.strictEqual(ix.replies.length, 3, 'every click was answered (no "interaction failed")');
    assert.match(ix.replies[0].content, /You're all set/i, 'friendly no-op wording');
    assert.match(ix.replies[0].content, /already have/i, 'mentions the role is already held');
    assert.ok(mm.state.has(ROLE_VERIFIED), 'the member still holds the role');
    selfRoleManager.deletePanel(panel.id);
});

test('button once: click without the role → grant; a second click keeps it (spam-proof)', async () => {
    const panel = seedPanel({ once: true });
    const mm = makeMember({ has: [] });
    const ix = makeInteraction({ customId: `sr_btn:${panel.id}:${ROLE_VERIFIED}`, memberMock: mm });

    // First click → granted.
    await selfroleHandler(ix);
    assert.strictEqual(mm.calls.add.length, 1, 'the role was granted exactly once');
    assert.ok(mm.state.has(ROLE_VERIFIED));

    // The newcomer keeps clicking…
    await selfroleHandler(ix);
    await selfroleHandler(ix);

    assert.strictEqual(mm.calls.add.length, 1, 'no duplicate grant calls');
    assert.strictEqual(mm.calls.remove.length, 0, 'CRITICAL: the repeat clicks never removed the role');
    assert.ok(mm.state.has(ROLE_VERIFIED), 'still verified after the click spam');
    assert.match(ix.replies[1].content, /You're all set/i);
    selfRoleManager.deletePanel(panel.id);
});

test('button once + exclusive: switching to another panel role still works, the new one can never be toggled off', async () => {
    const panel = seedPanel({ once: true, exclusive: true });
    // Member already holds ColorA from this exclusive panel.
    const mm = makeMember({ has: [ROLE_A] });
    const ix = makeInteraction({ customId: `sr_btn:${panel.id}:${ROLE_VERIFIED}`, memberMock: mm });

    await selfroleHandler(ix);
    // Exclusive switch happened: A out, Verified in.
    assert.ok(!mm.state.has(ROLE_A), 'the old exclusive role was switched away');
    assert.ok(mm.state.has(ROLE_VERIFIED), 'the new role was granted');

    // Clicking the newly-claimed role again → no-op (not a toggle-off!).
    await selfroleHandler(ix);
    assert.strictEqual(mm.calls.remove.length, 1, 'only the exclusive switch removal, nothing else');
    assert.ok(mm.state.has(ROLE_VERIFIED), 'the claimed role survives repeat clicks');
    assert.match(ix.replies[1].content, /You're all set/i);
    selfRoleManager.deletePanel(panel.id);
});

// ====================================================
// === 4. Select handler ===
// ====================================================

test('select once (multi): selecting adds missing roles, deselecting NEVER strips', async () => {
    const panel = seedPanel({ once: true, type: 'select' });
    const mm = makeMember({ has: [ROLE_A] });
    // The user picks Verified + ColorB and LEAVES ColorA deselected.
    const ix = makeInteraction({
        customId: `sr_sel:${panel.id}`,
        memberMock: mm,
        isSelect: true,
        values: [ROLE_VERIFIED, ROLE_B]
    });

    await selfroleHandler(ix);

    assert.ok(mm.state.has(ROLE_VERIFIED) && mm.state.has(ROLE_B), 'the selected missing roles were added');
    assert.ok(mm.state.has(ROLE_A), 'CRITICAL: the deselected role was NOT removed (one-way)');
    assert.strictEqual(mm.calls.remove.length, 0, 'no removal call at all');
    assert.match(ix.replies[0].content, /Roles added/i);
    assert.strictEqual(ix.edits.length, 1, 'the menu was re-rendered (selection reset)');
    selfRoleManager.deletePanel(panel.id);
});

test('select once (multi): cleared selection → friendly no-op, roles stay', async () => {
    const panel = seedPanel({ once: true, type: 'select' });
    const mm = makeMember({ has: [ROLE_A, ROLE_VERIFIED] });
    const ix = makeInteraction({
        customId: `sr_sel:${panel.id}`,
        memberMock: mm,
        isSelect: true,
        values: []
    });

    await selfroleHandler(ix);

    assert.ok(mm.state.has(ROLE_A) && mm.state.has(ROLE_VERIFIED), 'nothing was stripped');
    assert.strictEqual(mm.calls.add.length + mm.calls.remove.length, 0, 'zero role API calls');
    assert.match(ix.replies[0].content, /all set/i, 'the newcomer gets a friendly answer, not silence');
    selfRoleManager.deletePanel(panel.id);
});

test('select once + exclusive: picking a role you already have → no-op (not a toggle-off)', async () => {
    const panel = seedPanel({ once: true, exclusive: true, type: 'select' });
    const mm = makeMember({ has: [ROLE_VERIFIED] });
    const ix = makeInteraction({
        customId: `sr_sel:${panel.id}`,
        memberMock: mm,
        isSelect: true,
        values: [ROLE_VERIFIED]
    });

    await selfroleHandler(ix);

    assert.ok(mm.state.has(ROLE_VERIFIED), 'the held role survives re-selecting it');
    assert.strictEqual(mm.calls.remove.length, 0);
    assert.match(ix.replies[0].content, /all set/i);
    selfRoleManager.deletePanel(panel.id);
});

// ====================================================
// === 5. Panel embed ===
// ====================================================

test('embed: a one-way panel announces "One-way mode" + footer badge', () => {
    const panel = seedPanel({ once: true });
    const fakeClient = { user: { username: 'ThorTest', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' } };
    const embed = buildPanelEmbed(panel, fakeClient);
    assert.match(embed.data.description, /One-way mode/i);
    assert.match(embed.data.description, /never be removed/i);
    assert.match(embed.data.footer.text, /One-way/);

    // once + exclusive → both badges in the footer.
    const p2 = seedPanel({ once: true, exclusive: true });
    const e2 = buildPanelEmbed(p2, fakeClient);
    assert.match(e2.data.footer.text, /One-way \+ Exclusive/);

    // Classic panels are unchanged.
    const p3 = seedPanel({ once: false, exclusive: false });
    const e3 = buildPanelEmbed(p3, fakeClient);
    assert.doesNotMatch(e3.data.description, /One-way/i);
    assert.match(e3.data.footer.text, /Multi/);

    selfRoleManager.deletePanel(panel.id);
    selfRoleManager.deletePanel(p2.id);
    selfRoleManager.deletePanel(p3.id);
});

// ====================================================
// === 6. DASH API (web dashboard parity) ===
// ====================================================

const TOKEN = 'unit-test-token-v327';

function makeMockClient() {
    const guild = {
        id: GUILD_ID,
        name: 'Once Test Server',
        channels: {
            cache: new Map([
                [CHANNEL_ID, {
                    id: CHANNEL_ID,
                    name: 'verify',
                    type: 0,
                    send: async () => ({ id: `msg_${Date.now()}` }),
                    messages: { fetch: async () => ({ edit: async () => {}, delete: async () => {} }) }
                }]
            ])
        },
        roles: { cache: guildRoles },
        members: { fetch: async () => null }
    };
    return {
        isReady: () => true,
        guilds: {
            cache: new Map([[GUILD_ID, guild]]),
            fetch: async () => guild
        },
        channels: {
            fetch: async (id) => {
                const ch = guild.channels.cache.get(id);
                if (!ch) throw new Error('Unknown Channel');
                return ch;
            }
        },
        user: { username: 'ThorTest', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
        users: { fetch: async () => null }
    };
}

let server;
let baseUrl;

test.before(async () => {
    server = http.createServer(createDashHandler({ client: makeMockClient(), token: TOKEN }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

function api(method, pathname, { body } = {}) {
    return fetch(baseUrl + pathname, {
        method,
        headers: { 'x-dash-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
}

test('dash API: PUT { once: true } alone flips a live panel into one-way mode', async () => {
    // Start from a classic toggle panel.
    const panel = seedPanel({ once: false });
    assert.strictEqual(panel.once, false);

    // The web edit form sends ONLY the once field.
    const res = await api('PUT', `/guilds/${GUILD_ID}/selfroles/${panel.id}`, {
        body: { once: true }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.panel.once, true, 'the API persisted the one-way flag');

    // Persisted — a fresh read sees it too.
    assert.strictEqual(selfRoleManager.getPanel(panel.id).once, true);

    // And it flips back off.
    const off = await api('PUT', `/guilds/${GUILD_ID}/selfroles/${panel.id}`, {
        body: { once: false }
    });
    assert.strictEqual(off.status, 200);
    assert.strictEqual((await off.json()).panel.once, false);
    selfRoleManager.deletePanel(panel.id);
});

test('dash API: POST creates a one-way panel when once:true is sent', async () => {
    const res = await api('POST', `/guilds/${GUILD_ID}/selfroles`, {
        body: {
            channelId: CHANNEL_ID,
            title: 'Verify Panel',
            description: 'Click to verify — one way.',
            type: 'button',
            exclusive: false,
            once: true,
            roles: [{ roleId: ROLE_VERIFIED, label: 'Verify Me', emoji: '✅', style: 'Success' }]
        }
    });
    assert.strictEqual(res.status, 201);
    const { panel } = await res.json();
    assert.strictEqual(panel.once, true, 'the created panel is one-way');
    assert.ok(panel.messageId, 'the panel message was sent');
    selfRoleManager.deletePanel(panel.id);
});
