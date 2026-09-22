/**
 * Unit tests v3.30.0 — the RBAC tier resolver (src/infra/permissions.js).
 *
 * The three tiers MUST resolve identically to what the slash-command router,
 * the ticket guards and the DASH API use — this file locks the ladder:
 *   3 admin: Discord ManageGuild/Administrator, legacy roles.admin,
 *            access.adminRoleIds, access.adminUserIds
 *   2 staff: access.staffRoleIds, access.staffUserIds, Discord mod bits
 *   1 member: everyone else
 * Plus: hot invalidation (config changes apply without the 30s TTL wait)
 * and defensive shapes (config.access garbage never crashes the resolver).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');

const dataDir = path.join(__dirname, '..', '..', 'data');
const configDir = path.join(dataDir, 'config');

// Snapshot & restore the config dir (the resolver reads data/config/<id>.json).
let configDirBackup = null;
if (fs.existsSync(configDir)) {
    configDirBackup = fs.readdirSync(configDir).map(f => ({
        name: f,
        content: fs.readFileSync(path.join(configDir, f))
    }));
}
process.on('exit', () => {
    try {
        if (configDirBackup !== null) {
            const now = fs.existsSync(configDir) ? fs.readdirSync(configDir) : [];
            for (const f of now) {
                if (!configDirBackup.some(b => b.name === f)) fs.unlinkSync(path.join(configDir, f));
            }
            for (const b of configDirBackup) {
                fs.writeFileSync(path.join(configDir, b.name), b.content);
            }
        }
    } catch (_) {}
});

const {
    TIER,
    isAdmin,
    isStaff,
    getAccessTier,
    resolveAccessTier,
    getAccessConfig,
    invalidateAdminRoleCache
} = require('../../src/infra/permissions');
const { setField } = require('../../src/data/configManager');

const GUILD = '100100100100100100';
const ROLE_STAFF = '200200200200200200';
const ROLE_ADMIN = '300300300300300300';
const U_STAFF_ROLE = '400400400400400400';
const U_STAFF_ID = '500500500500500500';
const U_ADMIN_ID = '600600600600600600';
const U_PLAIN = '700700700700700700';

/** A minimal discord.js-shaped member for the resolver. */
function makeMember({ id, guildId = GUILD, bits = [], roleIds = [] }) {
    const bitSet = new Set(bits);
    return {
        id,
        guild: { id: guildId },
        permissions: { has: bit => bitSet.has(bit) },
        roles: { cache: new Map(roleIds.map(r => [r, { id: r }])) },
        user: { id, tag: `user#${id.slice(-4)}` }
    };
}

function writeConfig(cfg) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, `${GUILD}.json`), JSON.stringify(cfg));
    invalidateAdminRoleCache();
}

test.beforeEach(() => {
    writeConfig({}); // clean slate per test
});

test('v3.30.0: plain member resolves to tier 1 (member)', () => {
    const r = resolveAccessTier(makeMember({ id: U_PLAIN }));
    assert.strictEqual(r.tier, TIER.MEMBER);
    assert.strictEqual(r.label, 'member');
    assert.strictEqual(isStaff(makeMember({ id: U_PLAIN })), false);
    assert.strictEqual(isAdmin(makeMember({ id: U_PLAIN })), false);
});

test('v3.30.0: Discord ManageGuild resolves to tier 3 (admin)', () => {
    const m = makeMember({ id: U_PLAIN, bits: [PermissionFlagsBits.ManageGuild] });
    const r = resolveAccessTier(m);
    assert.strictEqual(r.tier, TIER.ADMIN);
    assert.ok(r.sources.some(s => s.startsWith('discord:ManageGuild')));
});

test('v3.30.0: Discord Administrator resolves to tier 3 (admin)', () => {
    const m = makeMember({ id: U_PLAIN, bits: [PermissionFlagsBits.Administrator] });
    assert.strictEqual(getAccessTier(m), TIER.ADMIN);
});

test('v3.30.0: a Discord moderation bit resolves to tier 2 (staff) — pre-RBAC compatibility', () => {
    for (const bit of [
        PermissionFlagsBits.ModerateMembers,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.ManageMessages
    ]) {
        const m = makeMember({ id: U_PLAIN, bits: [bit] });
        assert.strictEqual(getAccessTier(m), TIER.STAFF, `bit ${bit} should be staff`);
        assert.strictEqual(isStaff(m), true);
        assert.strictEqual(isAdmin(m), false, 'a mod bit alone is NOT admin');
    }
});

test('v3.30.0: legacy roles.admin (from /set-role admin) still grants tier 3', () => {
    writeConfig({ roles: { admin: ROLE_ADMIN } });
    const m = makeMember({ id: U_PLAIN, roleIds: [ROLE_ADMIN] });
    const r = resolveAccessTier(m);
    assert.strictEqual(r.tier, TIER.ADMIN);
    assert.ok(
        r.sources.some(s => s.startsWith('roles:admin')),
        'source names the legacy role'
    );
});

test('v3.30.0: access.adminRoleIds grants tier 3', () => {
    writeConfig({ access: { adminRoleIds: [ROLE_ADMIN] } });
    const m = makeMember({ id: U_PLAIN, roleIds: [ROLE_ADMIN] });
    assert.strictEqual(getAccessTier(m), TIER.ADMIN);
});

test('v3.30.0: access.staffRoleIds grants tier 2', () => {
    writeConfig({ access: { staffRoleIds: [ROLE_STAFF] } });
    const m = makeMember({ id: U_STAFF_ROLE, roleIds: [ROLE_STAFF] });
    assert.strictEqual(getAccessTier(m), TIER.STAFF);
});

test('v3.30.0: access.staffUserIds grants tier 2 without any role', () => {
    writeConfig({ access: { staffUserIds: [U_STAFF_ID] } });
    const m = makeMember({ id: U_STAFF_ID });
    assert.strictEqual(getAccessTier(m), TIER.STAFF);
});

test('v3.30.0: access.adminUserIds grants tier 3 without any role', () => {
    writeConfig({ access: { adminUserIds: [U_ADMIN_ID] } });
    const m = makeMember({ id: U_ADMIN_ID });
    assert.strictEqual(getAccessTier(m), TIER.ADMIN);
    assert.strictEqual(isAdmin(m), true);
});

test('v3.30.0: admin beats staff when both apply (tier 3 wins)', () => {
    writeConfig({ access: { staffRoleIds: [ROLE_STAFF], adminUserIds: [U_ADMIN_ID] } });
    const m = makeMember({ id: U_ADMIN_ID, roleIds: [ROLE_STAFF] });
    assert.strictEqual(getAccessTier(m), TIER.ADMIN);
});

test('v3.30.0: no guild context (DM / test mock) never crashes — tier from Discord bits only', () => {
    const plain = makeMember({ id: U_PLAIN, guildId: null });
    assert.strictEqual(getAccessTier(plain), TIER.MEMBER);
    const mod = makeMember({ id: U_PLAIN, guildId: null, bits: [PermissionFlagsBits.ModerateMembers] });
    assert.strictEqual(getAccessTier(mod), TIER.STAFF);
});

test('v3.30.0: null/undefined member resolves to member (defensive)', () => {
    assert.strictEqual(getAccessTier(null), TIER.MEMBER);
    assert.strictEqual(isAdmin(undefined), false);
    assert.strictEqual(isStaff(undefined), false);
});

test('v3.30.0: defensive access shapes — garbage never crashes, never grants', () => {
    writeConfig({ access: { staffRoleIds: 'not-an-array', adminUserIds: [null, 42, 'short'] } });
    const cfg = getAccessConfig(GUILD);
    assert.deepStrictEqual(cfg.adminUserIds, [], 'non-snowflake entries filtered out');
    assert.deepStrictEqual(cfg.staffRoleIds, [], 'non-array becomes []');
    // A member with NO roles still resolves to member (no accidental grant).
    assert.strictEqual(getAccessTier(makeMember({ id: U_PLAIN })), TIER.MEMBER);
});

test('v3.30.0: HOT RELOAD — setField(access.*) applies instantly (no 30s TTL wait, no restart)', () => {
    // Before: plain member.
    assert.strictEqual(getAccessTier(makeMember({ id: U_STAFF_ID })), TIER.MEMBER);
    // setField writes the config AND invalidates the resolver cache.
    setField(GUILD, 'access.staffUserIds', [U_STAFF_ID]);
    assert.strictEqual(
        getAccessTier(makeMember({ id: U_STAFF_ID })),
        TIER.STAFF,
        'the grant must be live immediately after setField'
    );
    // Removing it is live too.
    setField(GUILD, 'access.staffUserIds', []);
    assert.strictEqual(getAccessTier(makeMember({ id: U_STAFF_ID })), TIER.MEMBER);
});

test('v3.30.0: HOT RELOAD — setField(roles.admin) invalidation still works (legacy path)', () => {
    setField(GUILD, 'roles.admin', ROLE_ADMIN);
    assert.strictEqual(getAccessTier(makeMember({ id: U_PLAIN, roleIds: [ROLE_ADMIN] })), TIER.ADMIN);
});

test('v3.30.0: TIER constants & labels are stable (the wire contract with the dashboard)', () => {
    assert.strictEqual(TIER.MEMBER, 1);
    assert.strictEqual(TIER.STAFF, 2);
    assert.strictEqual(TIER.ADMIN, 3);
    const r = resolveAccessTier(makeMember({ id: U_PLAIN }));
    assert.strictEqual(typeof r.label, 'string');
    assert.ok(Array.isArray(r.sources));
});
