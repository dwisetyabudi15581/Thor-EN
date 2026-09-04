/**
 * Unit tests untuk statsManager.parsePrice
 *
 * Run: npm test
 * atau: node --test tests/unit/parsePrice.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { parsePrice } = require('../../src/data/statsManager');

test('parsePrice: integer string', () => {
    assert.strictEqual(parsePrice('25000'), 25000);
    assert.strictEqual(parsePrice('0'), 0);
    assert.strictEqual(parsePrice('1000000'), 1000000);
});

test('parsePrice: number input (passthrough)', () => {
    assert.strictEqual(parsePrice(25000), 25000);
    assert.strictEqual(parsePrice(0), 0);
});

test('parsePrice: null/undefined/empty', () => {
    assert.strictEqual(parsePrice(null), 0);
    assert.strictEqual(parsePrice(undefined), 0);
    assert.strictEqual(parsePrice(''), 0);
});

test('parsePrice: "Rp" prefix', () => {
    assert.strictEqual(parsePrice('Rp 25000'), 25000);
    assert.strictEqual(parsePrice('Rp. 50.000'), 50000);
    assert.strictEqual(parsePrice('rp 100'), 100);
});

test('parsePrice: ID thousand separator (dot)', () => {
    // Format Indonesia: "50.000" = 50000
    assert.strictEqual(parsePrice('50.000'), 50000);
    assert.strictEqual(parsePrice('1.000.000'), 1000000);
    assert.strictEqual(parsePrice('99.999'), 99999);
});

test('parsePrice: v3.9.8 FIX — ID format with 2-digit suffix', () => {
    // v3.9.9 FIX: heuristic diperketat lagi. "1.50" sekarang → 150 (thousand),
    // bukan 1.5 (decimal). Untuk Rupiah, harga integer jauh lebih umum.
    assert.strictEqual(parsePrice('1.50'), 150);
    assert.strictEqual(parsePrice('10.50'), 1050);
    assert.strictEqual(parsePrice('100.00'), 10000);
    assert.strictEqual(parsePrice('99.99'), 9999);
});

test('parsePrice: actual decimal (only int < 10 + 1-digit fractional)', () => {
    // v3.9.9: hanya int part < 10 DAN fractional 1 digit → decimal.
    // Mis. "2.5" → 2.5 (rounded 3), "9.9" → 9.9 (rounded 10).
    assert.strictEqual(parsePrice('2.5'), 3);
    assert.strictEqual(parsePrice('9.9'), 10);
    // "9.99" sekarang → 999 (thousand), bukan 9.99 (decimal).
    // (Rupiah harga < 10 dengan 2-digit decimal sangat jarang.)
    assert.strictEqual(parsePrice('9.99'), 999);
});

test('parsePrice: comma as thousand separator', () => {
    assert.strictEqual(parsePrice('25,000'), 25000);
    assert.strictEqual(parsePrice('1,234,567'), 1234567);
});

test('parsePrice: comma as decimal (ID/EU)', () => {
    // "2,5" → decimal 2.5 → rounded jadi 3 (Rupiah)
    assert.strictEqual(parsePrice('2,5'), 3);
});

test('parsePrice: k/m suffix', () => {
    assert.strictEqual(parsePrice('25k'), 25000);
    assert.strictEqual(parsePrice('2.5m'), 2500000);
    assert.strictEqual(parsePrice('1m'), 1000000);
});

test('parsePrice: combined format (Rp + thousand + k)', () => {
    assert.strictEqual(parsePrice('Rp 25k'), 25000);
    assert.strictEqual(parsePrice('Rp 1.5m'), 1500000);
});

test('parsePrice: invalid string returns 0', () => {
    assert.strictEqual(parsePrice('abc'), 0);
    assert.strictEqual(parsePrice('Rp'), 0);
    assert.strictEqual(parsePrice('---'), 0);
});

test('parsePrice: mixed dot + comma (US format)', () => {
    // "1,234.56" → US format → 1234.56 → Math.round → 1235
    // (parsePrice selalu round ke integer karena Rupiah gak pakai sen)
    assert.strictEqual(parsePrice('1,234.56'), 1235);
});

test('parsePrice: mixed dot + comma (EU/ID format)', () => {
    // "1.234,56" → EU format → 1234.56 → Math.round → 1235
    assert.strictEqual(parsePrice('1.234,56'), 1235);
});
