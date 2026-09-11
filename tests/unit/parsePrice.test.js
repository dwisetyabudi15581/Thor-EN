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
    // v3.9.55: cents are PRESERVED (currency-agnostic stats) — "2.5" → 2.5
    // and "9.9" → 9.9, no longer rounded to 3 / 10.
    assert.strictEqual(parsePrice('2.5'), 2.5);
    assert.strictEqual(parsePrice('9.9'), 9.9);
    // "9.99" still → 999 (thousand), not 9.99 (decimal) — no marker, so the
    // Rp-centric heuristic applies (Rupiah prices under 10 with a 2-digit
    // decimal are very rare). With a marker, "$9.99" → 9.99 (v3.9.55 below).
    assert.strictEqual(parsePrice('9.99'), 999);
});

test('parsePrice: comma as thousand separator', () => {
    assert.strictEqual(parsePrice('25,000'), 25000);
    assert.strictEqual(parsePrice('1,234,567'), 1234567);
});

test('parsePrice: comma as decimal (ID/EU)', () => {
    // "2,5" → decimal 2.5 → 2.5 (v3.9.55: cents preserved, was rounded to 3)
    assert.strictEqual(parsePrice('2,5'), 2.5);
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
    // "1,234.56" → US format → 1234.56 (v3.9.55: cents preserved — was rounded
    // to 1235; stats are currency-AGNOSTIC since v3.9.54, so cents count)
    assert.strictEqual(parsePrice('1,234.56'), 1234.56);
});

test('parsePrice: mixed dot + comma (EU/ID format)', () => {
    // "1.234,56" → EU format → 1234.56 (v3.9.55: cents preserved, was 1235)
    assert.strictEqual(parsePrice('1.234,56'), 1234.56);
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

// ============ v3.9.50 — dual-currency prices (user report: "I set the price as 3$ USD | Rp. 25.000") ============
// The stats currency is Rupiah. Before this fix, parseFloat stopped at the '$'
// so the dual price recorded **Rp 3** per sale — the revenue looked frozen
// AGAIN, even after the v3.9.49 suffix fix.

test('parsePrice v3.9.50: dual-currency — the Rp half is recorded', () => {
    // The USER-REPORTED format, verbatim and in common variants.
    assert.strictEqual(parsePrice('3$ USD | Rp. 25.000'), 25000);
    assert.strictEqual(parsePrice('3$ USD | Rp 25.000'), 25000);
    assert.strictEqual(parsePrice('$3 USD | Rp 25.000'), 25000);
    assert.strictEqual(parsePrice('3 USD | Rp 25.000'), 25000);
    assert.strictEqual(parsePrice('Rp 25.000 | $3 USD'), 25000); // Rp first
    assert.strictEqual(parsePrice('3$ usd rp 25.000'), 25000);   // no pipe
    assert.strictEqual(parsePrice('$5 USD | Rp 150rb'), 150000); // suffix too
});

test('parsePrice v3.9.54: ANY currency marker is accepted (international)', () => {
    // User request: "the bot will be used by people outside Indonesia too".
    // The bot is currency-AGNOSTIC — it records the numeric amount in whatever
    // currency the admin prices their products (no conversion, no rejection).
    assert.strictEqual(parsePrice('$3'), 3);
    assert.strictEqual(parsePrice('3$'), 3);
    assert.strictEqual(parsePrice('3 usd'), 3);
    assert.strictEqual(parsePrice('USD 3'), 3);
    assert.strictEqual(parsePrice('3$ USD'), 3);
    assert.strictEqual(parsePrice('€25'), 25);
    assert.strictEqual(parsePrice('£ 20'), 20);
    assert.strictEqual(parsePrice('¥1000'), 1000);
    assert.strictEqual(parsePrice('₩25,000'), 25000);
    assert.strictEqual(parsePrice('₱500'), 500);
    assert.strictEqual(parsePrice('25 eur'), 25);
    assert.strictEqual(parsePrice('IDR 30.000'), 30000);
    // First amount wins when no Rp half exists ("$3 | €2" → 3).
    assert.strictEqual(parsePrice('$3 | €2'), 3);
    // A marker with no amount is still unparseable.
    assert.strictEqual(parsePrice('usd'), 0);
    // Word safety: the k/m suffix must be ATTACHED to count
    // ("buy 3 monkeys for $5" → 3, not "3 m" → 3000).
    assert.strictEqual(parsePrice('buy 3 monkeys for $5'), 3);
});

test('parsePrice v3.9.50: Rp formats keep working (no regression)', () => {
    assert.strictEqual(parsePrice('Rp 25.000'), 25000);
    assert.strictEqual(parsePrice('Rp. 50.000'), 50000);
    assert.strictEqual(parsePrice('Rp 25rb'), 25000);
    assert.strictEqual(parsePrice('25.000 rp'), 25000); // marker after the amount
    assert.strictEqual(parsePrice('rp'), 0);
});

test('parsePriceNumber v3.9.50 (midman): dual-currency accepted, strictness kept', () => {
    const mm = require('../../src/data/midmanManager');
    assert.strictEqual(mm.parsePriceNumber('3$ USD | Rp. 25.000'), 25000);
    assert.strictEqual(mm.parsePriceNumber('$3 | Rp 25.000'), 25000);
    // v3.9.54: USD-only now parses too (escrow is currency-agnostic).
    assert.strictEqual(mm.parsePriceNumber('3$'), 3);
    assert.strictEqual(mm.parsePriceNumber('3 usd'), 3);
    // Strict guard preserved: decimal + suffix in the Rp half still rejected.
    assert.strictEqual(mm.parsePriceNumber('3$ | Rp 1.5rb'), 0);
    // Legacy strictness unchanged.
    assert.strictEqual(mm.parsePriceNumber('1.5rb'), 0);
});

test('parsePriceNumber v3.9.54 (midman): international currencies, whole amounts', () => {
    const mm = require('../../src/data/midmanManager');
    assert.strictEqual(mm.parsePriceNumber('$25,000'), 25000);
    assert.strictEqual(mm.parsePriceNumber('€2.500'), 2500); // ID-style dot thousands (consistent groups)
    assert.strictEqual(mm.parsePriceNumber('¥1000'), 1000);
    // Escrow stays strict: decimals like "2.5" are ambiguous → rejected.
    assert.strictEqual(mm.parsePriceNumber('$2.5'), 0);
    // A marker with no amount → invalid.
    assert.strictEqual(mm.parsePriceNumber('usd'), 0);
});

test('priceValidationError v3.9.54 (products): any currency accepted', () => {
    const products = require('../../src/commands/products');
    // Dual-currency, plain Rp, and international prices are all valid.
    assert.strictEqual(products.priceValidationError('3$ USD | Rp. 25.000'), null);
    assert.strictEqual(products.priceValidationError('Rp 25rb'), null);
    assert.strictEqual(products.priceValidationError('25.000'), null);
    assert.strictEqual(products.priceValidationError('free'), null);
    // v3.9.54: USD-only is no longer rejected — the bot is currency-agnostic.
    assert.strictEqual(products.priceValidationError('3$ USD'), null);
    assert.strictEqual(products.priceValidationError('$3'), null);
    assert.strictEqual(products.priceValidationError('€25'), null);
    // Garbage still rejected with the accepted-format list.
    const junkErr = products.priceValidationError('murah');
    assert.ok(typeof junkErr === 'string' && junkErr.includes('cannot be read'));
    assert.ok(junkErr.includes('$3'), 'the format list shows international examples');
});

// ============ v3.9.55 — international DECIMALS (user question: "does it support decimals like $2.5 USD?") ============
// The Rp-centric dot heuristic used to read "$2.50" as 250 and "$9.99" as 999
// (a silent 100x error for every USD/EUR-priced server), and the final
// Math.round killed the cents ("$2.5" → 3). When a NON-Rp currency marker is
// present the price now parses with international rules: a single dot with a
// 1-2 digit fraction is a DECIMAL, a 3-digit fraction is a thousands group,
// and cents are PRESERVED in the recorded amount.

test('parsePrice v3.9.55: decimals with a currency marker keep their cents', () => {
    // The exact format the user asked about.
    assert.strictEqual(parsePrice('$2.5 USD'), 2.5);
    assert.strictEqual(parsePrice('$2.5'), 2.5);
    assert.strictEqual(parsePrice('$2.50'), 2.5);
    assert.strictEqual(parsePrice('$9.99'), 9.99);
    assert.strictEqual(parsePrice('$12.99'), 12.99);
    assert.strictEqual(parsePrice('$0.99'), 0.99);
    assert.strictEqual(parsePrice('$2.0'), 2);
    assert.strictEqual(parsePrice('£ 2.99'), 2.99);
    // EU decimal comma keeps its cents too (used to round 9,99 → 10).
    assert.strictEqual(parsePrice('€9,99'), 9.99);
});

test('parsePrice v3.9.55: 3-digit dot groups with a marker stay THOUSANDS', () => {
    // German-style thousands: "$50.000" is 50000, NOT 50.000 cents.
    assert.strictEqual(parsePrice('$50.000'), 50000);
    assert.strictEqual(parsePrice('$1.234.567'), 1234567);
    // Mixed separators keep working — cents preserved (used to round to 1235).
    assert.strictEqual(parsePrice('$1,234.56'), 1234.56);
    assert.strictEqual(parsePrice('$1.234,56'), 1234.56);
    // Suffix + decimal: "$2.5k" → 2.5 × 1000.
    assert.strictEqual(parsePrice('$2.5k'), 2500);
});

test('parsePrice v3.9.55: Rp & marker-less legacy formats unchanged (no regression)', () => {
    // The Rp branch never sets intl — dot heuristics stay Rupiah-centric.
    assert.strictEqual(parsePrice('Rp 2.5rb'), 2500);
    assert.strictEqual(parsePrice('Rp 25.000'), 25000);
    assert.strictEqual(parsePrice('50.000'), 50000);
    assert.strictEqual(parsePrice('1.50'), 150);
    assert.strictEqual(parsePrice('9.99'), 999);
    // Dual-currency still records the Rp half (v3.9.50, unchanged).
    assert.strictEqual(parsePrice('$2.5 USD | Rp 25.000'), 25000);
});

test('parsePriceNumber v3.9.55 (midman): escrow stays whole-amount only', () => {
    const mm = require('../../src/data/midmanManager');
    // Deliberate design: escrow deal amounts must be whole numbers — "$2.5" is
    // ambiguous between 2.5 and a mis-typed 2500, and deals move real money.
    assert.strictEqual(mm.parsePriceNumber('$2.5'), 0);
    assert.strictEqual(mm.parsePriceNumber('$2.50'), 0);
    assert.strictEqual(mm.parsePriceNumber('€2,50'), 0);
    assert.strictEqual(mm.parsePriceNumber('$25,000'), 25000); // still fine
});

test('priceValidationError v3.9.55 (products): decimal prices are valid', () => {
    const products = require('../../src/commands/products');
    assert.strictEqual(products.priceValidationError('$2.5 USD'), null);
    assert.strictEqual(products.priceValidationError('$2.50'), null);
    assert.strictEqual(products.priceValidationError('€9.99'), null);
    // The accepted-format list now shows a decimal example.
    const junkErr = products.priceValidationError('murah');
    assert.ok(junkErr.includes('$2.50'), 'the format list shows a decimal example');
});
