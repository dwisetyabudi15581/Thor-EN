/**
 * Unit tests untuk scheduledAnnouncements.parseTime
 *
 * v3.9.38: absolute time kini diparse dengan offset eksplisit zona bot
 * (default WITA +8, env TZ_OFFSET_HOURS) — BUKAN timezone host lagi.
 * Assertion absolute dihitung: Date.UTC(...) - offset jam.
 */

const test = require('node:test');
const assert = require('node:assert');
const { parseTime, getTzOffsetHours } = require('../../src/data/scheduledAnnouncements');

// v3.9.38: pastikan default (+8) yang aktif — env luar tidak boleh mengacaukan test.
delete process.env.TZ_OFFSET_HOURS;

test('parseTime: null/empty/invalid returns null', () => {
    assert.strictEqual(parseTime(null), null);
    assert.strictEqual(parseTime(''), null);
    assert.strictEqual(parseTime('   '), null);
    assert.strictEqual(parseTime('invalid'), null);
});

test('parseTime: relative minutes', () => {
    const now = Date.now();
    const result = parseTime('30m');
    assert.ok(result !== null);
    assert.ok(result >= now + 29 * 60000 && result <= now + 31 * 60000);
});

test('parseTime: relative hours', () => {
    const now = Date.now();
    const result = parseTime('2h');
    assert.ok(result !== null);
    assert.ok(result >= now + 119 * 60000 && result <= now + 121 * 60000);
});

test('parseTime: relative days', () => {
    const now = Date.now();
    const result = parseTime('1d');
    assert.ok(result !== null);
    assert.ok(result >= now + 23 * 3600000 && result <= now + 25 * 3600000);
});

test('parseTime: relative too far (caps at 365 days)', () => {
    // 400 days > 365 day cap → null
    assert.strictEqual(parseTime('400d'), null);
    assert.strictEqual(parseTime('100000d'), null);
});

test('parseTime: relative 0 or negative', () => {
    assert.strictEqual(parseTime('0m'), null);
    assert.strictEqual(parseTime('-5m'), null);
});

test('parseTime: ISO absolute future date (v3.9.38 — offset zona bot, bukan timezone host)', () => {
    const nextYear = new Date().getFullYear() + 1;
    const result = parseTime(`${nextYear}-06-15 20:00`);
    assert.ok(result !== null);
    // v3.9.38: wall-clock 20:00 zona bot (default +8) → UTC 12:00.
    // Dulu: new Date(y,5,15,20,0) → tergantung timezone host (VPS UTC → telat 8 jam).
    const expected = Date.UTC(nextYear, 5, 15, 20, 0) - getTzOffsetHours() * 3600 * 1000;
    assert.strictEqual(result, expected);
});

test('parseTime: v3.9.38 — env TZ_OFFSET_HOURS=0 → absolute diparse sebagai UTC', () => {
    process.env.TZ_OFFSET_HOURS = '0';
    try {
        const nextYear = new Date().getFullYear() + 1;
        const result = parseTime(`${nextYear}-06-15 20:00`);
        assert.ok(result !== null);
        assert.strictEqual(result, Date.UTC(nextYear, 5, 15, 20, 0));
    } finally {
        delete process.env.TZ_OFFSET_HOURS;
    }
});

test('parseTime: v3.9.8 FIX — invalid date components rejected', () => {
    // Sebelum v3.9.8: "2026-13-40 99:99" di-rollover oleh Date constructor
    // jadi valid date di tahun 2027. Sekarang harus return null.
    assert.strictEqual(parseTime('2026-13-40 99:99'), null);
    assert.strictEqual(parseTime('2026-00-15 20:00'), null); // month 0 invalid
    assert.strictEqual(parseTime('2026-01-32 20:00'), null); // day 32 invalid
    assert.strictEqual(parseTime('2026-01-15 25:00'), null); // hour 25 invalid
    assert.strictEqual(parseTime('2026-01-15 20:61'), null); // minute 61 invalid
});

test('parseTime: past date rejected', () => {
    const lastYear = new Date().getFullYear() - 1;
    assert.strictEqual(parseTime(`${lastYear}-06-15 20:00`), null);
});

test('parseTime: too far future (caps at 5 years)', () => {
    const farFuture = new Date().getFullYear() + 10;
    assert.strictEqual(parseTime(`${farFuture}-06-15 20:00`), null);
});
