/**
 * Unit tests for statsManager.parsePrice
 *
 * Run: npm test
 * or: node --test tests/unit/parsePrice.test.js
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
    // Indonesian format: "50.000" = 50000
    assert.strictEqual(parsePrice('50.000'), 50000);
    assert.strictEqual(parsePrice('1.000.000'), 1000000);
    assert.strictEqual(parsePrice('99.999'), 99999);
});

test('parsePrice: v3.9.8 FIX — ID format with 2-digit suffix', () => {
    // v3.9.9 FIX: the heuristic was tightened again. "1.50" now → 150 (thousand),
    // not 1.5 (decimal). For Rupiah, integer prices are far more common.
    assert.strictEqual(parsePrice('1.50'), 150);
    assert.strictEqual(parsePrice('10.50'), 1050);
    assert.strictEqual(parsePrice('100.00'), 10000);
    assert.strictEqual(parsePrice('99.99'), 9999);
});

test('parsePrice: actual decimal (only int < 10 + 1-digit fractional)', () => {
    // v3.9.9: only int part < 10 AND a 1-digit fractional part → decimal.
    // E.g. "2.5" → 2.5 (rounded 3), "9.9" → 9.9 (rounded 10).
    assert.strictEqual(parsePrice('2.5'), 3);
    assert.strictEqual(parsePrice('9.9'), 10);
    // "9.99" now → 999 (thousand), not 9.99 (decimal).
    // (Rupiah prices under 10 with a 2-digit decimal are very rare.)
    assert.strictEqual(parsePrice('9.99'), 999);
});

test('parsePrice: comma as thousand separator', () => {
    assert.strictEqual(parsePrice('25,000'), 25000);
    assert.strictEqual(parsePrice('1,234,567'), 1234567);
});

test('parsePrice: comma as decimal (ID/EU)', () => {
    // "2,5" → decimal 2.5 → rounded to 3 (Rupiah)
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
    // (parsePrice always rounds to an integer because Rupiah doesn't use cents)
    assert.strictEqual(parsePrice('1,234.56'), 1235);
});

test('parsePrice: mixed dot + comma (EU/ID format)', () => {
    // "1.234,56" → EU format → 1234.56 → Math.round → 1235
    assert.strictEqual(parsePrice('1.234,56'), 1235);
});

// ============ v3.9.49 — Indonesian suffixes (user report: "total revenue doesn't update") ============
// "25rb" used to record Rp 25 instead of Rp 25.000 — every sale added a
// near-invisible amount, so the revenue looked frozen.

test('parsePrice v3.9.49: rb suffix = ribu (×1.000)', () => {
    assert.strictEqual(parsePrice('25rb'), 25000);
    assert.strictEqual(parsePrice('Rp 25rb'), 25000);
    assert.strictEqual(parsePrice('Rp 25 rb'), 25000);
    assert.strictEqual(parsePrice('150rb'), 150000);
    // The USER-REPORT scenario end-to-end: revenue now moves by the right amount.
    assert.strictEqual(parsePrice('100rb'), 100000);
});

test('parsePrice v3.9.49: jt/juta suffix = juta (×1.000.000)', () => {
    assert.strictEqual(parsePrice('2jt'), 2000000);
    assert.strictEqual(parsePrice('2 juta'), 2000000);
    assert.strictEqual(parsePrice('Rp1.5juta'), 1500000);
    // Longest-first: "juta" wins over the "jt" prefix ambiguity.
    assert.strictEqual(parsePrice('3juta'), 3000000);
});

test('parsePrice v3.9.49: legacy formats unchanged (no regression)', () => {
    assert.strictEqual(parsePrice('25000'), 25000);
    assert.strictEqual(parsePrice('25.000'), 25000);
    assert.strictEqual(parsePrice('25k'), 25000);
    assert.strictEqual(parsePrice('2.5M'), 2500000);
    assert.strictEqual(parsePrice('murah'), 0); // still unparseable → 0
});

test('parsePriceNumber v3.9.49 (midman): escrow now accepts rb/jt/juta', () => {
    const mm = require('../../src/data/midmanManager');
    // Before: 0 = deal creation blocked with a confusing "invalid price".
    assert.strictEqual(mm.parsePriceNumber('25rb'), 25000);
    assert.strictEqual(mm.parsePriceNumber('2jt'), 2000000);
    assert.strictEqual(mm.parsePriceNumber('2juta'), 2000000);
    assert.strictEqual(mm.parsePriceNumber('Rp 25 rb'), 25000);
    // Strictness preserved: suffix + separators is still rejected (10x-price guard).
    assert.strictEqual(mm.parsePriceNumber('1.5rb'), 0);
    assert.strictEqual(mm.parsePriceNumber('1,5jt'), 0);
    // Legacy formats unchanged.
    assert.strictEqual(mm.parsePriceNumber('25.000'), 25000);
    assert.strictEqual(mm.parsePriceNumber('100k'), 100000);
    assert.strictEqual(mm.parsePriceNumber('2.5'), 0);
});
