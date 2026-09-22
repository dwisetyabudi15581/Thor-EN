/**
 * Unit tests for Custom Commands v3.20.0 (created from the web -> real
 * slash commands on Discord).
 *
 * Verifies:
 *   - embedPayload.normalizeEmbedDef: Discord caps (title/desc/footer/fields),
 *     URL validation, 6000 total, hex color, empty shape
 *   - embedPayload.isEmbedEmpty + buildEmbedFromDef (builder honors every
 *     property: author, footer, inline fields, timestamp)
 *   - customCommandManager.validateDefinition: valid/invalid names, built-in
 *     collisions, description rules, content OR embed required
 *   - upsertCommand: create, update (same name), 20-per-guild cap, actor
 *     recorded
 *   - deleteCommand: success + not found
 *   - toApplicationCommands: Discord registration shape { name, description }
 *   - Command Manager parity: normalizeDisabledList accepts that guild's
 *     custom command names (extraNames) — identical rules web <-> Discord
 *
 * The test's data/customCommands/<guildId>.json file is snapshotted and
 * restored (commandManager.test.js pattern).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data', 'customCommands');
const GUILD_ID = '999777999777999777';
const GUILD_FILE = path.join(dataDir, `${GUILD_ID}.json`);
const OTHER_GUILD_ID = '999888999888999888';

// Snapshot & restore
const hadDir = fs.existsSync(dataDir);
const hadFile = fs.existsSync(GUILD_FILE);
const fileBackup = hadFile ? fs.readFileSync(GUILD_FILE) : null;
if (hadFile) fs.unlinkSync(GUILD_FILE);

process.on('exit', () => {
    try {
        if (hadFile) fs.writeFileSync(GUILD_FILE, fileBackup);
        else if (fs.existsSync(GUILD_FILE)) fs.unlinkSync(GUILD_FILE);
        if (!hadDir) return;
        // Clean up other test guild files this suite may have created.
        const other = path.join(dataDir, `${OTHER_GUILD_ID}.json`);
        if (fs.existsSync(other) && !hadFile) fs.unlinkSync(other);
    } catch (_) {}
});

const { CAPS, normalizeEmbedDef, buildEmbedFromDef, isEmbedEmpty, totalEmbedLength } = require('../../src/infra/embedPayload');
const customCommandManager = require('../../src/data/customCommandManager');
const { getCommands } = require('../../src/commands/registry');
const { normalizeDisabledList } = require('../../src/commands/commands');

function freshEmbed() {
    return {
        title: 'Title',
        description: 'Body',
        color: 0xff0000,
        fields: [{ name: 'A', value: '1', inline: true }]
    };
}

// ====================================================
// === embedPayload.normalizeEmbedDef ===
// ====================================================

test('embedPayload: empty shape -> ok + empty value', () => {
    const res = normalizeEmbedDef(undefined);
    assert.ok(res.ok);
    assert.strictEqual(res.value.title, '');
    assert.strictEqual(res.value.fields.length, 0);
    assert.strictEqual(res.value.color, 0x5865f2);
});

test('embedPayload: all valid properties are normalized', () => {
    const res = normalizeEmbedDef({
        title: 'Hello',
        description: 'World',
        color: '#00ff00',
        authorName: 'Thor',
        authorIconURL: 'https://example.com/a.png',
        thumbnail: 'https://example.com/t.png',
        image: 'https://example.com/i.png',
        footerText: 'Bye',
        footerIconURL: 'https://example.com/f.png',
        timestamp: true,
        fields: [{ name: 'F1', value: 'V1', inline: false }, { name: '', value: '' }]
    });
    assert.ok(res.ok);
    assert.strictEqual(res.value.color, 0x00ff00);
    assert.strictEqual(res.value.authorName, 'Thor');
    assert.strictEqual(res.value.fields.length, 1); // empty field dropped
    assert.strictEqual(res.value.fields[0].inline, false);
    assert.strictEqual(res.value.timestamp, true);
});

test('embedPayload: Discord caps enforced (title/desc/footer/field)', () => {
    assert.ok(!normalizeEmbedDef({ title: 'x'.repeat(257) }).ok);
    assert.ok(!normalizeEmbedDef({ description: 'x'.repeat(4097) }).ok);
    assert.ok(!normalizeEmbedDef({ footerText: 'x'.repeat(2049) }).ok);
    assert.ok(!normalizeEmbedDef({ authorName: 'x'.repeat(257) }).ok);
    assert.ok(!normalizeEmbedDef({ fields: [{ name: 'x'.repeat(257), value: 'v' }] }).ok);
    assert.ok(!normalizeEmbedDef({ fields: [{ name: 'n', value: 'x'.repeat(1025) }] }).ok);
});

test('embedPayload: max 25 fields', () => {
    const fields = Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, value: 'v' }));
    const res = normalizeEmbedDef({ fields });
    assert.ok(!res.ok);
    assert.match(res.error, /25/);
});

test('embedPayload: non-http URLs rejected', () => {
    assert.ok(!normalizeEmbedDef({ image: 'ftp://example.com/x.png' }).ok);
    assert.ok(!normalizeEmbedDef({ thumbnail: 'not-a-url' }).ok);
    assert.ok(normalizeEmbedDef({ image: 'https://example.com/x.png' }).ok);
});

test('embedPayload: 6000-character total enforced', () => {
    // Each field is valid (name+value within caps) but the total is far over 6000.
    const fields = Array.from({ length: 8 }, () => ({ name: 'n'.repeat(200), value: 'v'.repeat(1000) }));
    const res = normalizeEmbedDef({ fields });
    assert.ok(!res.ok);
    assert.match(res.error, /6000/);
});

test('embedPayload: invalid color rejected, valid integer accepted', () => {
    assert.ok(!normalizeEmbedDef({ color: 'green' }).ok);
    assert.ok(!normalizeEmbedDef({ color: 0x1000000 }).ok);
    const ok = normalizeEmbedDef({ color: 3066993 });
    assert.ok(ok.ok);
    assert.strictEqual(ok.value.color, 3066993);
});

test('embedPayload: isEmbedEmpty + totalEmbedLength', () => {
    assert.ok(isEmbedEmpty({}));
    assert.ok(isEmbedEmpty({ title: '', description: '', fields: [{ name: '', value: '' }] }));
    assert.ok(!isEmbedEmpty({ title: 'x' }));
    assert.ok(!isEmbedEmpty({ image: 'https://example.com/i.png' }));
    assert.strictEqual(totalEmbedLength({ title: 'ab', description: 'cde', fields: [{ name: 'f', value: 'gh' }] }), 8);
});

test('embedPayload: buildEmbedFromDef honors every property', () => {
    class FakeEmbedBuilder {
        constructor() { this.data = {}; }
        setColor(c) { this.data.color = c; return this; }
        setTitle(t) { this.data.title = t; return this; }
        setDescription(d) { this.data.description = d; return this; }
        setAuthor(a) { this.data.author = a; return this; }
        setThumbnail(u) { this.data.thumbnail = u; return this; }
        setImage(u) { this.data.image = u; return this; }
        setFooter(f) { this.data.footer = f; return this; }
        setTimestamp() { this.data.timestamp = 'set'; return this; }
        addFields(...fs) { this.data.fields = fs; return this; }
    }
    const def = normalizeEmbedDef({
        title: 'T', description: 'D', color: 255,
        authorName: 'A', authorIconURL: 'https://e.com/a.png',
        thumbnail: 'https://e.com/t.png', image: 'https://e.com/i.png',
        footerText: 'F', footerIconURL: 'https://e.com/f.png',
        timestamp: true, fields: [{ name: 'N', value: 'V', inline: true }]
    }).value;
    const built = buildEmbedFromDef(def, FakeEmbedBuilder);
    assert.strictEqual(built.data.title, 'T');
    assert.strictEqual(built.data.author.name, 'A');
    assert.strictEqual(built.data.author.iconURL, 'https://e.com/a.png');
    assert.strictEqual(built.data.footer.text, 'F');
    assert.strictEqual(built.data.fields[0].inline, true);
    assert.strictEqual(built.data.timestamp, 'set');
});

// ====================================================
// === customCommandManager.validateDefinition ===
// ====================================================

test('custom: valid definition -> ok (content only)', () => {
    const res = customCommandManager.validateDefinition(
        { name: 'socials', description: 'Our social links', content: 'IG: @thor' },
        []
    );
    assert.ok(res.ok);
    assert.strictEqual(res.value.name, 'socials');
    assert.strictEqual(res.value.ephemeral, false);
});

test('custom: name lowercased + character validation', () => {
    assert.ok(customCommandManager.validateDefinition({ name: 'SOCIALS', description: 'd', content: 'x' }, []).ok);
    assert.ok(!customCommandManager.validateDefinition({ name: 'Name With Space', description: 'd', content: 'x' }, []).ok);
    assert.ok(!customCommandManager.validateDefinition({ name: '', description: 'd', content: 'x' }, []).ok);
    assert.ok(!customCommandManager.validateDefinition({ name: 'a'.repeat(33), description: 'd', content: 'x' }, []).ok);
});

test('custom: collision with built-in command names rejected', () => {
    const builtin = getCommands().map((c) => c.name);
    assert.ok(builtin.includes('giveaway'));
    const res = customCommandManager.validateDefinition(
        { name: 'giveaway', description: 'd', content: 'x' },
        builtin
    );
    assert.ok(!res.ok);
    assert.match(res.error, /built-in/);
});

test('custom: description required 1-100 + content <=2000', () => {
    assert.ok(!customCommandManager.validateDefinition({ name: 'x', description: '', content: 'x' }, []).ok);
    assert.ok(!customCommandManager.validateDefinition({ name: 'x', description: 'd'.repeat(101), content: 'x' }, []).ok);
    assert.ok(!customCommandManager.validateDefinition({ name: 'x', description: 'd', content: 'x'.repeat(2001) }, []).ok);
});

test('custom: content OR embed required', () => {
    const res = customCommandManager.validateDefinition({ name: 'x', description: 'd', content: '', embed: {} }, []);
    assert.ok(!res.ok);
    assert.match(res.error, /at least/i);
    // embed only (no content) is valid too
    assert.ok(customCommandManager.validateDefinition({ name: 'x', description: 'd', embed: freshEmbed() }, []).ok);
});

test('custom: invalid embed error is forwarded', () => {
    const res = customCommandManager.validateDefinition(
        { name: 'x', description: 'd', embed: { title: 'x'.repeat(300) } },
        []
    );
    assert.ok(!res.ok);
    assert.match(res.error, /Embed/);
});

// ====================================================
// === upsert / delete / toApplicationCommands ===
// ====================================================

const BUILTIN_NAMES = getCommands().map((c) => c.name);

test('custom: upsert create -> persist -> getCommand', () => {
    const res = customCommandManager.upsertCommand(
        GUILD_ID,
        { name: 'socials', description: 'All our social media links', content: 'IG: @thor', embed: freshEmbed(), ephemeral: true },
        BUILTIN_NAMES,
        { id: 'user1', tag: 'Admin#1' }
    );
    assert.ok(res.ok);
    assert.strictEqual(res.created, true);
    assert.strictEqual(res.command.name, 'socials');
    assert.strictEqual(res.command.ephemeral, true);
    assert.strictEqual(res.command.createdBy, 'user1');

    customCommandManager.invalidateCache(); // simulate another process writing
    const found = customCommandManager.getCommand(GUILD_ID, 'socials');
    assert.ok(found);
    assert.strictEqual(found.description, 'All our social media links');
    assert.strictEqual(found.embed.title, 'Title');
});

test('custom: upsert update (same name) -> created=false, updatedAt moves forward', async () => {
    await new Promise((r) => setTimeout(r, 5)); // ensure the timestamp differs
    const res = customCommandManager.upsertCommand(
        GUILD_ID,
        { name: 'socials', description: 'Our social links', content: 'IG: @thor' },
        BUILTIN_NAMES,
        { id: 'user2', tag: 'Admin#2' }
    );
    assert.ok(res.ok);
    assert.strictEqual(res.created, false);
    assert.strictEqual(res.command.description, 'Our social links');
    assert.strictEqual(res.command.embed.title, ''); // embed replaced by empty = gone
    assert.strictEqual(res.command.updatedByTag, 'Admin#2');
});

test('custom: toApplicationCommands -> Discord registration shape', () => {
    const apps = customCommandManager.toApplicationCommands(GUILD_ID);
    assert.ok(Array.isArray(apps));
    assert.strictEqual(apps.length, 1);
    assert.strictEqual(apps[0].name, 'socials');
    assert.strictEqual(apps[0].description, 'Our social links');
    assert.ok(!('content' in apps[0])); // the reply is NOT registered
});

test('custom: per-guild command cap enforced', () => {
    const manager = customCommandManager;
    for (let i = 0; i < manager.MAX_CUSTOM_COMMANDS; i++) {
        const r = manager.upsertCommand(OTHER_GUILD_ID, { name: `cmd-${i}`, description: 'd', content: 'x' }, BUILTIN_NAMES);
        assert.ok(r.ok, `command #${i} should succeed`);
    }
    const over = manager.upsertCommand(OTHER_GUILD_ID, { name: 'cmd-extra', description: 'd', content: 'x' }, BUILTIN_NAMES);
    assert.ok(!over.ok);
    assert.match(over.error, /Maximum/);
    // updating an existing entry still works at the cap
    const upd = manager.upsertCommand(OTHER_GUILD_ID, { name: 'cmd-0', description: 'new', content: 'x' }, BUILTIN_NAMES);
    assert.ok(upd.ok);
});

test('custom: deleteCommand + not found', () => {
    assert.ok(customCommandManager.deleteCommand(OTHER_GUILD_ID, 'cmd-0').ok);
    const miss = customCommandManager.deleteCommand(OTHER_GUILD_ID, 'cmd-0');
    assert.ok(!miss.ok);
    assert.match(miss.error, /not found/);
});

test('custom: guild isolation (other guilds never see this guild\'s commands)', () => {
    assert.strictEqual(customCommandManager.getGuildCommands(GUILD_ID).length, 1);
    assert.strictEqual(customCommandManager.getCommand(GUILD_ID, 'socials') !== null, true);
    assert.strictEqual(customCommandManager.getCommand(OTHER_GUILD_ID, 'socials'), null);
});

// ====================================================
// === Command Manager parity (web <-> Discord) ===
// ====================================================

test('custom: normalizeDisabledList accepts that guild\'s custom commands', () => {
    const customNames = customCommandManager.getGuildCommands(GUILD_ID).map((c) => c.name);
    assert.ok(customNames.includes('socials'));
    const ok = normalizeDisabledList(['socials'], customNames);
    assert.ok(ok.ok);
    assert.deepStrictEqual(ok.value, ['socials']);
    // without extraNames (old rules) -> rejected: proof the parameter works
    const legacy = normalizeDisabledList(['socials']);
    assert.ok(!legacy.ok);
});

// ====================================================
// === Test file cleanup ===
// ====================================================

test('custom: cleanup test files', () => {
    fs.rmSync(path.join(dataDir, `${OTHER_GUILD_ID}.json`), { force: true });
    assert.ok(true);
});
