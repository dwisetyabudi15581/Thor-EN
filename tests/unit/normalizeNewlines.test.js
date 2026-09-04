/**
 * Unit tests untuk normalizeNewlines (src/infra/text.js) — v3.9.24
 *
 * Fitur: input slash command di Discord (PC) tidak bisa Enter (Enter = submit).
 * User nulis escape literal `\n` → helper konversi jadi newline asli.
 */

const test = require('node:test');
const assert = require('node:assert');
const { normalizeNewlines } = require('../../src/infra/text');

test('normalizeNewlines: konversi literal \\n jadi newline asli', () => {
    assert.strictEqual(normalizeNewlines('baris1\\nbaris2'), 'baris1\nbaris2');
});

test('normalizeNewlines: dukung \\r\\n dan \\r literal', () => {
    assert.strictEqual(normalizeNewlines('a\\r\\nb'), 'a\nb');
    assert.strictEqual(normalizeNewlines('a\\rb'), 'a\nb');
});

test('normalizeNewlines: banyak escape sekaligus', () => {
    assert.strictEqual(normalizeNewlines('L1\\nL2\\n\\nL4'), 'L1\nL2\n\nL4');
});

test('normalizeNewlines: newline asli di input tetap dipertahankan', () => {
    assert.strictEqual(normalizeNewlines('asli\nbaru\\nlagi'), 'asli\nbaru\nlagi');
});

test('normalizeNewlines: teks tanpa escape di-pass through identik', () => {
    assert.strictEqual(normalizeNewlines('halo dunia'), 'halo dunia');
    assert.strictEqual(normalizeNewlines(''), '');
});

test('normalizeNewlines: input non-string di-pass through (defensive)', () => {
    assert.strictEqual(normalizeNewlines(null), null);
    assert.strictEqual(normalizeNewlines(undefined), undefined);
    assert.strictEqual(normalizeNewlines(42), 42);
});

test('normalizeNewlines: hasil tidak pernah lebih panjang dari input', () => {
    // Tiap escape (2 char) diganti 1 char newline → panjang makin pendek.
    const inputs = ['a\\nb\\nc', 'xxxxxxxx\\n', '\\n\\n\\n\\n', 'plain'];
    for (const input of inputs) {
        assert.ok(
            normalizeNewlines(input).length <= input.length,
            `hasil "${normalizeNewlines(input)}" tidak boleh lebih panjang dari input "${input}"`
        );
    }
});

test('normalizeNewlines: backslash tunggal tanpa n tidak diubah', () => {
    // Path Windows / escape lain tidak boleh rusak.
    assert.strictEqual(normalizeNewlines('C:\\path\\ke\\file'), 'C:\\path\\ke\\file');
    assert.strictEqual(normalizeNewlines('backslash \\ sendiri'), 'backslash \\ sendiri');
});
