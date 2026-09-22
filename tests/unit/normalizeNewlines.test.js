/**
 * Unit tests for normalizeNewlines (src/infra/text.js) — v3.9.24
 *
 * Feature: slash command input on Discord (PC) can't contain Enter (Enter = submit).
 * Users type the literal escape `\n` → the helper converts it to a real newline.
 */

const test = require('node:test');
const assert = require('node:assert');
const { normalizeNewlines } = require('../../src/infra/text');

test('normalizeNewlines: converts literal \\n into a real newline', () => {
    assert.strictEqual(normalizeNewlines('baris1\\nbaris2'), 'baris1\nbaris2');
});

test('normalizeNewlines: supports literal \\r\\n and \\r', () => {
    assert.strictEqual(normalizeNewlines('a\\r\\nb'), 'a\nb');
    assert.strictEqual(normalizeNewlines('a\\rb'), 'a\nb');
});

test('normalizeNewlines: multiple escapes at once', () => {
    assert.strictEqual(normalizeNewlines('L1\\nL2\\n\\nL4'), 'L1\nL2\n\nL4');
});

test('normalizeNewlines: real newlines in the input are preserved', () => {
    assert.strictEqual(normalizeNewlines('asli\nbaru\\nlagi'), 'asli\nbaru\nlagi');
});

test('normalizeNewlines: text without escapes passes through identically', () => {
    assert.strictEqual(normalizeNewlines('halo dunia'), 'halo dunia');
    assert.strictEqual(normalizeNewlines(''), '');
});

test('normalizeNewlines: non-string input passes through (defensive)', () => {
    assert.strictEqual(normalizeNewlines(null), null);
    assert.strictEqual(normalizeNewlines(undefined), undefined);
    assert.strictEqual(normalizeNewlines(42), 42);
});

test('normalizeNewlines: result is never longer than the input', () => {
    // Each escape (2 chars) is replaced by 1 newline char → length only shrinks.
    const inputs = ['a\\nb\\nc', 'xxxxxxxx\\n', '\\n\\n\\n\\n', 'plain'];
    for (const input of inputs) {
        assert.ok(
            normalizeNewlines(input).length <= input.length,
            `result "${normalizeNewlines(input)}" must not be longer than input "${input}"`
        );
    }
});

test('normalizeNewlines: a single backslash without n stays unchanged', () => {
    // Windows paths / other escapes must not break.
    assert.strictEqual(normalizeNewlines('C:\\path\\ke\\file'), 'C:\\path\\ke\\file');
    assert.strictEqual(normalizeNewlines('backslash \\ sendiri'), 'backslash \\ sendiri');
});
