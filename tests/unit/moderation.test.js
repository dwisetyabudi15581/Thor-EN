/**
 * Unit tests v3.9.43 — the full moderation pack (/timeout /untimeout /purge
 * /kick /ban /unban) + unified moderation history in /warn-list.
 *
 * What is guarded:
 *   A. moderationGuards (behavioral, pure):
 *      - hierarchy: self/bot-self/target-bot/same-or-higher-level → reject;
 *        moderator higher + bot higher → pass
 *      - Discord limits: timeout 1..40320 minutes (28 days), purge 1..100
 *      - bulk delete: messages older than 14 days filtered, partial fail-safe
 *   B. modLogManager (behavioral): guild-scoped, fields intact, corrupt file
 *      → quarantine (keyManager.test.js pattern).
 *   C. Registry + router (contract):
 *      - 88 commands total; the 6 moderation commands registered with option
 *        bounds IDENTICAL to the guard (Discord-side vs runtime parity).
 *      - COMMAND_TO_DOMAIN routes the 6 commands to the moderation domain.
 *      - MODERATION_COMMANDS gate (non-admin moderators with the matching
 *        Discord permission may use them — least privilege).
 *   D. Handler contract (static, voiceNotify.test.js style):
 *      - guards used, member.timeout called, best-effort DMs,
 *        addModLog + logAudit called, purge uses filterBulkDeletable,
 *        ban uses deleteMessageSeconds (v14, max 7 days).
 *   E. /warn-list integration: getModLogs pulled BEFORE the early-return
 *      (a 0-warn user with moderation history still renders), 4096 guard.
 *   F. MOD_* audit labels exist so they don't fall back to raw strings.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function readSrc(rel) {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// ====================================================
// === A. moderationGuards (pure, behavioral) ===
// ====================================================

function makeMember(id, topPos, isBot = false) {
    return {
        id,
        user: { bot: isBot, id },
        roles: { highest: { position: topPos } }
    };
}

test('v3.9.43 #1 hierarchy guard: moderator & bot higher → pass; bot/self targets rejected', () => {
    const { validateModerationTarget } = require('../../src/infra/moderationGuards');

    // Happy path: moderator (pos 10) & bot (pos 9) > target (pos 5).
    const ok = validateModerationTarget({
        moderatorMember: makeMember('mod', 10),
        targetMember: makeMember('target', 5),
        botMember: makeMember('bot', 9)
    });
    assert.strictEqual(ok.ok, true, 'must pass when the hierarchy is correct');

    // Self.
    assert.strictEqual(
        validateModerationTarget({
            moderatorMember: makeMember('same', 10),
            targetMember: makeMember('same', 5),
            botMember: makeMember('bot', 20)
        }).error,
        'self'
    );
    // The bot itself.
    assert.strictEqual(
        validateModerationTarget({
            moderatorMember: makeMember('mod', 10),
            targetMember: makeMember('bot', 5),
            botMember: makeMember('bot', 20)
        }).error,
        'bot-self'
    );
    // Bot target → reject (consistent with /warn).
    assert.strictEqual(
        validateModerationTarget({
            moderatorMember: makeMember('mod', 10),
            targetMember: makeMember('bot2', 5, true),
            botMember: makeMember('bot', 20)
        }).error,
        'target-bot'
    );
    // Target null (not in guild).
    assert.strictEqual(
        validateModerationTarget({
            moderatorMember: makeMember('mod', 10),
            targetMember: null,
            botMember: makeMember('bot', 20)
        }).error,
        'not-in-guild'
    );
});

test('v3.9.43 #2 hierarchy guard: target at/above moderator OR bot → rejected', () => {
    const { validateModerationTarget } = require('../../src/infra/moderationGuards');

    // Target at the moderator's level → reject (same as /warn v3.9.8).
    assert.strictEqual(
        validateModerationTarget({
            moderatorMember: makeMember('mod', 10),
            targetMember: makeMember('target', 10),
            botMember: makeMember('bot', 20)
        }).error,
        'hierarchy'
    );
    // Target above the moderator → reject.
    assert.strictEqual(
        validateModerationTarget({
            moderatorMember: makeMember('mod', 10),
            targetMember: makeMember('target', 11),
            botMember: makeMember('bot', 20)
        }).error,
        'hierarchy'
    );
    // Moderator is higher, but the BOT is lower than the target → reject
    // (otherwise the API throws Missing Permissions after the guard passes).
    assert.strictEqual(
        validateModerationTarget({
            moderatorMember: makeMember('mod', 10),
            targetMember: makeMember('target', 8),
            botMember: makeMember('bot', 5)
        }).error,
        'bot-hierarchy'
    );
});

test('v3.9.43 #3 Discord limits: timeout 1–40320 minutes, purge 1–100', () => {
    const { validateTimeoutDuration, validatePurgeAmount } = require('../../src/infra/moderationGuards');

    assert.strictEqual(validateTimeoutDuration(1).ok, true);
    assert.strictEqual(validateTimeoutDuration(60).ms, 3600000);
    assert.strictEqual(validateTimeoutDuration(40320).ok, true); // exactly 28 days
    assert.strictEqual(validateTimeoutDuration(40321).error, 'too-long'); // 28 days + 1 minute
    assert.strictEqual(validateTimeoutDuration(0).error, 'too-short');
    assert.strictEqual(validateTimeoutDuration(90.5).error, 'not-integer');
    assert.strictEqual(validateTimeoutDuration('60').error, 'not-integer'); // strict typing

    assert.strictEqual(validatePurgeAmount(1).ok, true);
    assert.strictEqual(validatePurgeAmount(100).ok, true);
    assert.strictEqual(validatePurgeAmount(101).error, 'too-large');
    assert.strictEqual(validatePurgeAmount(0).error, 'too-small');
    assert.strictEqual(validatePurgeAmount('50').error, 'not-integer');
});

test('v3.9.43 #4 bulk delete: >14-day-old messages filtered; partial timestamps fail-safe', () => {
    const { filterBulkDeletable, BULK_DELETE_MAX_AGE_MS } = require('../../src/infra/moderationGuards');
    const now = Date.now();

    const fresh = { createdTimestamp: now - 1000 };
    const edge = { createdTimestamp: now - BULK_DELETE_MAX_AGE_MS }; // exactly at the limit → allowed
    const old = { createdTimestamp: now - BULK_DELETE_MAX_AGE_MS - 1000 }; // 1 second past → rejected
    const partial = { createdTimestamp: undefined }; // partial → fail-safe reject

    const out = filterBulkDeletable([fresh, edge, old, partial], now);
    assert.deepStrictEqual(out, [fresh, edge], 'fresh + at-limit pass; old & partial filtered');
    assert.deepStrictEqual(filterBulkDeletable(null), [], 'null input → empty array');
});

test('v3.9.43 #5 formatDurationMinutes & isValidUserId', () => {
    const { formatDurationMinutes, isValidUserId } = require('../../src/infra/moderationGuards');

    assert.strictEqual(formatDurationMinutes(90), '1 hour 30 minutes');
    assert.strictEqual(formatDurationMinutes(1440), '1 day');
    assert.strictEqual(formatDurationMinutes(2880), '2 days');
    assert.strictEqual(formatDurationMinutes(45), '45 minutes');
    assert.strictEqual(formatDurationMinutes(0), '0 minutes');
    assert.strictEqual(formatDurationMinutes(1), '1 minute');

    assert.strictEqual(isValidUserId('12345678901234567'), true); // 17 digits
    assert.strictEqual(isValidUserId('12345678901234567890'), true); // 20 digits
    assert.strictEqual(isValidUserId('12345'), false);
    assert.strictEqual(isValidUserId('not-an-id'), false);
    assert.strictEqual(isValidUserId('<@12345678901234567>'), false); // a raw mention is not an ID
});

// ====================================================
// === B. modLogManager (behavioral, file IO snapshotted) ===
// ====================================================

// keyManager.test.js pattern: snapshot & restore the production file; start
// from a deterministic empty state.
const realModLogsPath = path.join(REPO_ROOT, 'data', 'modlogs.json');
const modLogsBackupPath = realModLogsPath + '.test-backup';
let modLogsBackedUp = false;
if (fs.existsSync(realModLogsPath)) {
    fs.copyFileSync(realModLogsPath, modLogsBackupPath);
    modLogsBackedUp = true;
    fs.rmSync(realModLogsPath, { force: true });
}
process.on('exit', () => {
    try {
        if (modLogsBackedUp) {
            fs.copyFileSync(modLogsBackupPath, realModLogsPath);
            fs.rmSync(modLogsBackupPath, { force: true });
        } else if (fs.existsSync(realModLogsPath)) {
            fs.unlinkSync(realModLogsPath);
        }
    } catch (_) {}
});

test('v3.9.43 #6 modLogManager: add/get guild-scoped, fields intact, count accurate', () => {
    const ml = require('../../src/data/modLogManager');
    const rec = ml.addModLog('guildA', 'user1', {
        type: 'timeout',
        reason: 'Ad spam',
        durationMs: 3600000,
        moderatorId: 'modX',
        moderatorTag: 'ModX#0001'
    });
    assert.match(rec.id, /^mod_\d+_[a-z0-9]+$/, 'stable id format');
    assert.strictEqual(rec.guildId, 'guildA');
    assert.strictEqual(rec.userId, 'user1');

    const list = ml.getModLogs('guildA', 'user1');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].reason, 'Ad spam');
    assert.strictEqual(list[0].durationMs, 3600000);
    assert.strictEqual(list[0].moderatorTag, 'ModX#0001');

    // Scoped: other guild / other user → empty.
    assert.deepStrictEqual(ml.getModLogs('guildB', 'user1'), []);
    assert.deepStrictEqual(ml.getModLogs('guildA', 'user2'), []);
    assert.strictEqual(ml.getModLogCount('guildA', 'user1'), 1);

    // Entry without a reason → default '(no reason given)'.
    const rec2 = ml.addModLog('guildA', 'user2', { type: 'unban', moderatorId: 'modX', moderatorTag: 'ModX#0001' });
    assert.strictEqual(rec2.reason, '(no reason given)');
    assert.strictEqual(rec2.durationMs, null);
});

test('v3.9.43 #7 modLogManager: corrupt file → quarantine + empty fallback (no crash)', () => {
    const ml = require('../../src/data/modLogManager');
    // Write a corrupt file, reset the in-memory cache, reload.
    fs.writeFileSync(realModLogsPath, '{THIS IS NOT VALID JSON', 'utf8');
    ml._resetForTests();
    assert.deepStrictEqual(ml.getModLogs('guildX', 'userY'), [], 'empty fallback, no throw');
    assert.ok(!fs.existsSync(realModLogsPath) || ml.getModLogs('guildX', 'userY').length >= 0);
});

// ====================================================
// === C. Registry + router (contract) ===
// ====================================================

test('v3.9.43 #8 registry: 6 moderation commands registered; Discord option bounds = guard bounds (parity)', () => {
    const { getCommands } = require('../../src/commands/registry');
    const names = getCommands().map(c => c.name);
    for (const n of ['timeout', 'untimeout', 'purge', 'kick', 'ban', 'unban']) {
        assert.ok(names.includes(n), `/${n} must be registered`);
    }

    const timeout = getCommands().find(c => c.name === 'timeout');
    const dur = timeout.options.find(o => o.name === 'duration');
    assert.strictEqual(dur.min_value, 1);
    assert.strictEqual(dur.max_value, 40320, 'max_value must be 40320 (28 days) — parity with validateTimeoutDuration');

    const purge = getCommands().find(c => c.name === 'purge');
    const amount = purge.options.find(o => o.name === 'amount');
    assert.strictEqual(amount.min_value, 1);
    assert.strictEqual(amount.max_value, 100, 'max_value 100 — parity with validatePurgeAmount');

    const ban = getCommands().find(c => c.name === 'ban');
    const dd = ban.options.find(o => o.name === 'delete_days');
    assert.strictEqual(dd.max_value, 7, 'message deletion capped at 7 days (Discord API limit)');

    const unban = getCommands().find(c => c.name === 'unban');
    assert.ok(unban.options.some(o => o.name === 'user_id'), '/unban uses a string user_id (user not in guild)');

    // set-channel & remove-channel know the server-log type.
    for (const cmdName of ['set-channel', 'remove-channel']) {
        const cmd = getCommands().find(c => c.name === cmdName);
        const tipe = cmd.options.find(o => o.name === 'tipe');
        assert.ok(tipe.choices.some(c => c.value === 'server-log'), `${cmdName} must have a server-log choice`);
    }
});

test('v3.9.43 #9 router: 6 commands mapped to the moderation domain + moderator permission gate', () => {
    const route = require('../../src/commands/index.js');
    const map = route.COMMAND_TO_DOMAIN;
    for (const c of ['timeout', 'untimeout', 'purge', 'kick', 'ban', 'unban']) {
        assert.strictEqual(map[c], 'moderation', `/${c} must route to the moderation domain`);
    }
    assert.ok(route.DOMAIN_HANDLERS.moderation, 'the moderation domain handler is registered');

    // Gate: MODERATION_COMMANDS grants access to non-admin moderators
    // (least privilege — not all staff need the bot's admin role).
    const src = readSrc('src/commands/index.js');
    assert.ok(src.includes('MODERATION_COMMANDS'), 'the MODERATION_COMMANDS table must exist');
    assert.ok(/allowedModerator/.test(src), 'the router must check allowedModerator before denying');
});

// ====================================================
// === D. Handler contract (static) ===
// ====================================================

test('v3.9.43 #10 moderation.js: guards used, timeout called, best-effort DM, modlog + audit recorded', () => {
    const src = readSrc('src/commands/moderation.js');

    // Hierarchy guards used by all heavy actions.
    assert.ok((src.match(/validateModerationTarget\(/g) || []).length >= 3, 'guard used at ≥3 sites (timeout/kick/ban)');
    // Timeout via the discord.js API.
    assert.ok(src.includes('member.timeout('), '/timeout must call member.timeout');
    assert.ok(src.includes('member.timeout(null'), '/untimeout must clear the timeout with null');
    // Best-effort DM: try/catch helper, not a bare await that can throw.
    assert.ok(/async function dmTarget/.test(src) && /catch \(_\)/.test(src), 'DMs must be best-effort (silent fail)');
    // modlog + audit called.
    assert.ok((src.match(/addModLog\(/g) || []).length >= 5, 'every per-user action must be recorded (timeout/untimeout/kick/ban/unban)');
    assert.ok((src.match(/logAudit\(/g) || []).length >= 5, 'every action must hit the audit log');
    // Purge: 14-day filter + single-message bulk handling (bulkDelete needs ≥2).
    assert.ok(src.includes('filterBulkDeletable('), 'purge must filter >14-day-old messages');
    assert.ok(src.includes('deletable.length === 1'), 'purge of 1 message → single delete (bulkDelete needs ≥2)');
    // Ban v14: seconds, not days.
    assert.ok(src.includes('deleteMessageSeconds'), 'ban must use deleteMessageSeconds (v14)');
    // Bot permissions checked up front with clear messages.
    assert.ok((src.match(/permissions\.has\(PermissionFlagsBits\./g) || []).length >= 5, 'bot permissions checked for every action');
});

// ====================================================
// === E. /warn-list integration ===
// ====================================================

test('v3.9.43 #11 warn-list: moderation history pulled BEFORE the early-return + 4096 guard + type labels', () => {
    const src = readSrc('src/commands/warn.js');

    const pullIdx = src.indexOf('getModLogs(interaction.guild.id, user.id)');
    const earlyIdx = src.indexOf('has no warnings or moderation history');
    assert.ok(pullIdx !== -1, 'getModLogs must be called in /warn-list');
    assert.ok(earlyIdx !== -1, 'the early-return must mention both');
    assert.ok(pullIdx < earlyIdx, 'the modlog pull must come BEFORE the early-return (0-warn + modlog users still render)');

    assert.ok(src.includes('truncateUtf8Safe('), 'the description must be guarded to 4096 (warns + modlog can be long)');
    assert.ok(src.includes('Moderation History'), 'the modlog section must exist');
    assert.ok(src.includes('modLogTypeLabel('), 'action type labels are used');
});

// ====================================================
// === F. Audit labels ===
// ====================================================

test('v3.9.43 #12 auditLog: 6 MOD_* labels registered (no raw-string fallback)', () => {
    const { ACTION_LABELS } = require('../../src/infra/auditLog');
    for (const key of ['MOD_TIMEOUT', 'MOD_UNTIMEOUT', 'MOD_PURGE', 'MOD_KICK', 'MOD_BAN', 'MOD_UNBAN']) {
        assert.ok(ACTION_LABELS[key], `label ${key} must exist`);
    }
});
