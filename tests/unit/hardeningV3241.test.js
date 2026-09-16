/**
 * Unit tests for the v3.24.1 debugging fixes.
 *
 * Covers the fixes introduced by the full-codebase review:
 *   1. parseTime: combined relative units ("1h30m", "1d12h") — documented
 *      since v3.9.1 but previously rejected by the single-unit regex.
 *   2. computeNextRecurring('monthly'): no more setMonth overflow drift
 *      (Jan 31 → Feb 28 → Mar 31, and Dec 31 → Jan 31 next year).
 *   3. joinCappedLines: embed list building capped under 4096 with "+N more".
 *   4. isValidEmoji: keycap sequences ("1️⃣") are valid emoji; plain digits stay
 *      rejected.
 *   5. snip (serverLog): code-point-aware truncation never splits a surrogate
 *      pair.
 *   6. dashServer IDOR (H1): panel/announcement IDs from ANOTHER guild are
 *      rejected with 404 (self-role panel add-role / delete-panel / delete-role,
 *      scheduled announcement delete).
 *   7. dashServer (M1): a malformed request target gets a clean 400 instead of
 *      a hung socket + unhandled rejection.
 *
 * The dashServer part runs on an ephemeral port with a mocked client —
 * Discord is never touched. Production data files are snapshotted & restored.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

// === Snapshot & restore the data files touched by the dashServer part ===
const dataDir = path.join(__dirname, '..', '..', 'data');
const TOUCHED = ['selfRoles.json', 'scheduledAnnouncements.json'];
const INIT_CONTENT = { 'selfRoles.json': '[]', 'scheduledAnnouncements.json': '[]' };
const backups = {}; // path -> old content (null = did not exist)

for (const f of TOUCHED) {
    const p = path.join(dataDir, f);
    backups[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
    if (backups[p] === null) fs.writeFileSync(p, INIT_CONTENT[f] ?? '[]');
}
process.on('exit', () => {
    try {
        for (const [p, content] of Object.entries(backups)) {
            if (content === null) {
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } else {
                fs.writeFileSync(p, content);
            }
        }
    } catch (_) {}
});

// ====================================================
// === 1. parseTime: combined relative units ===
// ====================================================

const { parseTime, computeNextRecurring } = require('../../src/data/scheduledAnnouncements');

test('v3.24.1 parseTime: "1h30m" → now + 90 minutes (documented since v3.9.1)', () => {
    const now = Date.now();
    const result = parseTime('1h30m');
    assert.ok(result !== null, '1h30m must parse');
    assert.ok(result >= now + 89 * 60000 && result <= now + 91 * 60000, `got delta ${result - now}ms`);
});

test('v3.24.1 parseTime: "1d12h" → now + 36 hours', () => {
    const now = Date.now();
    const result = parseTime('1d12h');
    assert.ok(result !== null, '1d12h must parse');
    assert.ok(result >= now + 35 * 3600000 && result <= now + 37 * 3600000, `got delta ${result - now}ms`);
});

test('v3.24.1 parseTime: "2d5h30m" → now + 2d5h30m', () => {
    const now = Date.now();
    const expected = 2 * 86400000 + 5 * 3600000 + 30 * 60000;
    const result = parseTime('2d5h30m');
    assert.ok(result !== null);
    assert.ok(Math.abs(result - (now + expected)) < 2000, `got delta ${result - now}ms`);
});

test('v3.24.1 parseTime: single units still work ("30m", "2h", "1d")', () => {
    assert.ok(parseTime('30m') !== null);
    assert.ok(parseTime('2h') !== null);
    assert.ok(parseTime('1d') !== null);
});

test('v3.24.1 parseTime: "0h0m" → null (zero duration)', () => {
    assert.strictEqual(parseTime('0h0m'), null);
});

// ====================================================
// === 2. computeNextRecurring: monthly drift fix ===
// ====================================================

test('v3.24.1 monthly: Jan 31 → Feb 28 → Mar 31 (no more overflow drift)', () => {
    let ts = new Date('2026-01-31T10:00:00Z').getTime();
    ts = computeNextRecurring(ts, 'monthly', 31);
    assert.strictEqual(new Date(ts).toISOString(), '2026-02-28T10:00:00.000Z');
    ts = computeNextRecurring(ts, 'monthly', 31);
    assert.strictEqual(new Date(ts).toISOString(), '2026-03-31T10:00:00.000Z');
    ts = computeNextRecurring(ts, 'monthly', 31);
    assert.strictEqual(new Date(ts).toISOString(), '2026-04-30T10:00:00.000Z');
});

test('v3.24.1 monthly: Dec 31 → Jan 31 next year (year rollover)', () => {
    let ts = new Date('2026-12-31T10:00:00Z').getTime();
    ts = computeNextRecurring(ts, 'monthly', 31);
    assert.strictEqual(new Date(ts).toISOString(), '2027-01-31T10:00:00.000Z');
});

test('v3.24.1 monthly: legacy entries (no origDay) clamp instead of overflowing', () => {
    const ts = new Date('2026-01-31T10:00:00Z').getTime();
    const next = computeNextRecurring(ts, 'monthly');
    assert.strictEqual(new Date(next).toISOString(), '2026-02-28T10:00:00.000Z');
});

test('v3.24.1 monthly: daily/weekly recurrence unchanged', () => {
    const ts = new Date('2026-01-31T10:00:00Z').getTime();
    assert.strictEqual(
        new Date(computeNextRecurring(ts, 'daily')).toISOString(),
        '2026-02-01T10:00:00.000Z'
    );
    assert.strictEqual(
        new Date(computeNextRecurring(ts, 'weekly')).toISOString(),
        '2026-02-07T10:00:00.000Z'
    );
});

// ====================================================
// === 3. joinCappedLines ===
// ====================================================

const { joinCappedLines } = require('../../src/infra/text');

test('v3.24.1 joinCappedLines: small lists pass through untouched', () => {
    const out = joinCappedLines(['a', 'b', 'c'], (x) => `• ${x}`);
    assert.strictEqual(out, '• a\n• b\n• c');
});

test('v3.24.1 joinCappedLines: long lists are capped with a "+N more" suffix', () => {
    const items = Array.from({ length: 500 }, (_, i) => `entry-${i}`);
    const out = joinCappedLines(items, (x) => `${x} `.repeat(10).trim(), 4000);
    assert.ok(out.length <= 4096, `length ${out.length} must stay under the Discord limit`);
    assert.match(out, /\+\d+ more$/);
    // The hidden count must be exactly the entries that did NOT fit.
    const shown = (out.match(/^entry-/gm) || []).length;
    assert.strictEqual(shown + Number(out.match(/\+(\d+) more$/)[1]), 500);
});

test('v3.24.1 joinCappedLines: a single oversized entry is hard-truncated, never overflows', () => {
    const out = joinCappedLines(['one-huge-entry'], () => 'x'.repeat(9000), 4000);
    assert.ok(out.length <= 4096, `length ${out.length}`);
    assert.ok(out.includes('…'), 'the truncation ellipsis must be present');
    assert.ok(out.includes('+1 more'), 'the hidden-entry suffix must be present');
});

test('v3.24.1 joinCappedLines: empty input → empty string', () => {
    assert.strictEqual(joinCappedLines([], () => ''), '');
    assert.strictEqual(joinCappedLines(null, () => ''), '');
});

// ====================================================
// === 4. isValidEmoji: keycap sequences ===
// ====================================================

const { isValidEmoji } = require('../../src/infra/text');

test('v3.24.1 isValidEmoji: keycap sequences are valid ("1️⃣" — the default poll emoji)', () => {
    for (const kc of ['1️⃣', '2️⃣', '0️⃣', '#️⃣', '*️⃣']) {
        assert.strictEqual(isValidEmoji(kc), true, `${kc} must be valid`);
    }
});

test('v3.24.1 isValidEmoji: plain digits are still rejected (no poisoning)', () => {
    assert.strictEqual(isValidEmoji('123'), false);
    assert.strictEqual(isValidEmoji('1'), false);
});

// ====================================================
// === 5. snip: surrogate-pair-safe truncation ===
// ====================================================

test('v3.24.1 snip: truncation never splits a surrogate pair', () => {
    const { snip } = require('../../src/infra/serverLog');
    const long = '👍'.repeat(600); // 1200 code units
    const out = snip(long, 1000);
    // With 2-code-unit emojis the cap can land at max-1 — a lone surrogate is
    // never emitted (exactly the point of the fix).
    assert.ok(out.length <= 1000, `length ${out.length} must stay within the cap`);
    assert.ok(out.length >= 998, `length ${out.length} should be within one emoji of the cap`);
    assert.ok(out.endsWith('…'));
    // The char before the ellipsis must not be a LONE HIGH surrogate — a string
    // of complete emojis legitimately ends with the LOW surrogate of its last
    // pair; only an unpaired high surrogate would mean a split emoji.
    const body = out.slice(0, -1);
    const lastCode = body.charCodeAt(body.length - 1);
    assert.ok(
        lastCode < 0xd800 || lastCode > 0xdbff,
        'must not end on a lone high surrogate (split emoji)'
    );
    // ... and the total must decode cleanly as text (no replacement boxes)
    assert.ok(!/\uFFFD/.test(out));
});

// ====================================================
// === 6 & 7. dashServer: cross-guild IDOR + malformed URL ===
// ====================================================

const { createDashHandler } = require('../../src/infra/dashServer');

const TOKEN = 'unit-test-token-v3241';
const GUILD_A = '999111222333444555'; // in the mock client cache
const GUILD_B = '999999000000000002'; // a DIFFERENT valid snowflake (not in cache)

function makeMockClient() {
    const guild = {
        id: GUILD_A,
        name: 'Guild A',
        icon: null,
        memberCount: 42,
        ownerId: '111000111000111000',
        channels: {
            cache: new Map([
                ['777000111222333444', { id: '777000111222333444', name: 'general', type: 0, rawPosition: 1 }]
            ])
        },
        roles: {
            cache: new Map([
                ['888000111222333444', { id: '888000111222333444', name: 'Member', color: 0, position: 1 }]
            ])
        }
    };
    return {
        isReady: () => true,
        guilds: { cache: new Map([[GUILD_A, guild]]) },
        channels: {
            fetch: async (id) => ({
                id,
                type: 0,
                send: async (opts) => ({ id: `msg_${Date.now()}`, opts }),
                messages: { fetch: async () => ({ edit: async () => {}, delete: async () => {} }) }
            })
        }
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

function api(method, pathname, { token = TOKEN, body } = {}) {
    return fetch(baseUrl + pathname, {
        method,
        headers: {
            ...(token ? { 'x-dash-token': token } : {}),
            ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
}

// ---- setup: one panel + one announcement in GUILD A ----

let panelIdA;
let annIdA;

test('v3.24.1 setup: create a self-role panel in guild A', async () => {
    const res = await api('POST', `/guilds/${GUILD_A}/selfroles`, {
        body: {
            channelId: '777000111222333444',
            title: 'A panel',
            description: 'guild A panel',
            type: 'button',
            roles: [{ roleId: '888000111222333444', label: 'Member' }]
        }
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    panelIdA = data.panel.id;
    assert.ok(panelIdA);
});

test('v3.24.1 setup: schedule an announcement in guild A', async () => {
    const res = await api('POST', `/guilds/${GUILD_A}/announce`, {
        body: {
            channelId: '777000111222333444',
            title: 'A announce',
            description: 'guild A announcement',
            sendAt: Date.now() + 3600000
        }
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    annIdA = data.announcement.id;
    assert.ok(annIdA);
});

// ---- the IDOR probes: guild B URLs targeting guild A's objects ----

test('v3.24.1 IDOR: adding a role to guild A\'s panel via guild B\'s URL → 404', async () => {
    const res = await api('POST', `/guilds/${GUILD_B}/selfroles/${panelIdA}/roles`, {
        body: { roleId: '888000111222333555', label: 'Sneaky' }
    });
    assert.strictEqual(res.status, 404, 'cross-guild panel role-add must be rejected');
});

test('v3.24.1 IDOR: removing a role from guild A\'s panel via guild B\'s URL → 404', async () => {
    const res = await api('DELETE', `/guilds/${GUILD_B}/selfroles/${panelIdA}/roles?roleId=888000111222333444`);
    assert.strictEqual(res.status, 404, 'cross-guild panel role-remove must be rejected');
});

test('v3.24.1 IDOR: deleting guild A\'s panel via guild B\'s URL → 404', async () => {
    const res = await api('DELETE', `/guilds/${GUILD_B}/selfroles/${panelIdA}`);
    assert.strictEqual(res.status, 404, 'cross-guild panel delete must be rejected');
});

test('v3.24.1 IDOR: deleting guild A\'s announcement via guild B\'s URL → 404 (still there)', async () => {
    const res = await api('DELETE', `/guilds/${GUILD_B}/announce/${annIdA}`);
    assert.strictEqual(res.status, 404, 'cross-guild announcement delete must be rejected');
});

// ---- the same operations through the OWNING guild still work ----

test('v3.24.1 IDOR: adding a role via guild A\'s own URL → 200 (legit path intact)', async () => {
    const res = await api('POST', `/guilds/${GUILD_A}/selfroles/${panelIdA}/roles`, {
        body: { roleId: '888000111222333555', label: 'Second' }
    });
    assert.strictEqual(res.status, 200);
});

test('v3.24.1 IDOR: deleting guild A\'s announcement via guild A\'s URL → 200', async () => {
    const res = await api('DELETE', `/guilds/${GUILD_A}/announce/${annIdA}`);
    assert.strictEqual(res.status, 200);
});

test('v3.24.1 IDOR: deleting guild A\'s panel via guild A\'s URL → 200', async () => {
    const res = await api('DELETE', `/guilds/${GUILD_A}/selfroles/${panelIdA}`);
    assert.strictEqual(res.status, 200);
});

// ---- M1: malformed request target ----

test('v3.24.1 M1: a malformed request target gets a clean 400 (no hung socket)', async () => {
    // Absolute-form request target with an out-of-range port — makes
    // new URL() throw. Sent over a raw socket to prove a response arrives.
    const port = server.address().port;
    const ok = await new Promise((resolve) => {
        const sock = require('net').connect(port, '127.0.0.1', () => {
            sock.on('data', (buf) => {
                const head = buf.toString().split('\r\n')[0] || '';
                sock.destroy();
                resolve(head.includes('400'));
            });
            sock.on('error', () => resolve(false));
            sock.on('close', () => resolve(false));
            sock.write(`GET http://example.com:99999/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        });
        setTimeout(() => resolve(false), 3000).unref();
    });
    assert.ok(ok, 'the server must reply 400 instead of hanging the socket');
});
