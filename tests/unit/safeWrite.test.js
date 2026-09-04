/**
 * Unit tests untuk safeWrite (atomic JSON write)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeWriteJSON, safeWriteText, safeWriteJSONWithBackup } = require('../../src/infra/safeWrite');

function tmpFile(suffix = '.json') {
    return path.join(os.tmpdir(), `thor-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
}

test('safeWriteJSON: writes valid JSON', () => {
    const f = tmpFile();
    safeWriteJSON(f, { foo: 'bar', num: 42 });
    const content = fs.readFileSync(f, 'utf8');
    assert.deepStrictEqual(JSON.parse(content), { foo: 'bar', num: 42 });
    fs.unlinkSync(f);
});

test('safeWriteJSON: pretty-printed by default (2 spaces)', () => {
    const f = tmpFile();
    safeWriteJSON(f, { a: 1 });
    const content = fs.readFileSync(f, 'utf8');
    assert.ok(content.includes('  "a": 1'), 'should be pretty-printed with 2 spaces');
    fs.unlinkSync(f);
});

test('safeWriteJSON: minified when spaces=0', () => {
    const f = tmpFile();
    safeWriteJSON(f, { a: 1 }, { spaces: 0 });
    const content = fs.readFileSync(f, 'utf8');
    assert.strictEqual(content, '{"a":1}');
    fs.unlinkSync(f);
});

test('safeWriteJSON: handles arrays', () => {
    const f = tmpFile();
    const arr = [1, 2, 3, { nested: true }];
    safeWriteJSON(f, arr);
    const content = fs.readFileSync(f, 'utf8');
    assert.deepStrictEqual(JSON.parse(content), arr);
    fs.unlinkSync(f);
});

test('safeWriteJSON: handles nested objects', () => {
    const f = tmpFile();
    const data = { outer: { inner: { deep: 'value' } } };
    safeWriteJSON(f, data);
    const content = fs.readFileSync(f, 'utf8');
    assert.deepStrictEqual(JSON.parse(content), data);
    fs.unlinkSync(f);
});

test('safeWriteJSON: overwrites existing file', () => {
    const f = tmpFile();
    safeWriteJSON(f, { version: 1 });
    safeWriteJSON(f, { version: 2 });
    const content = fs.readFileSync(f, 'utf8');
    assert.deepStrictEqual(JSON.parse(content), { version: 2 });
    fs.unlinkSync(f);
});

test('safeWriteJSON: no leftover .tmp files', () => {
    const f = tmpFile();
    safeWriteJSON(f, { foo: 'bar' });
    const tmpPath = `${f}.tmp`;
    assert.ok(!fs.existsSync(tmpPath), 'should not leave .tmp file behind');
    fs.unlinkSync(f);
});

test('safeWriteText: writes raw text', () => {
    const f = tmpFile('.txt');
    safeWriteText(f, 'hello world');
    const content = fs.readFileSync(f, 'utf8');
    assert.strictEqual(content, 'hello world');
    fs.unlinkSync(f);
});

test('safeWriteJSONWithBackup: creates .bak file', () => {
    const f = tmpFile();
    const bakPath = `${f}.bak`;

    // First write
    safeWriteJSONWithBackup(f, { version: 1 });
    assert.ok(fs.existsSync(f));

    // Second write should create .bak
    safeWriteJSONWithBackup(f, { version: 2 });
    assert.ok(fs.existsSync(bakPath), 'should create .bak file');
    const bakContent = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
    assert.deepStrictEqual(bakContent, { version: 1 });

    fs.unlinkSync(f);
    fs.unlinkSync(bakPath);
});

test('safeWriteJSON: throws on invalid path', () => {
    assert.throws(() => {
        safeWriteJSON('/nonexistent/path/that/does/not/exist/file.json', { foo: 'bar' });
    });
});
