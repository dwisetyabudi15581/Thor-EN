/**
 * Unit tests v3.9.41-en — safety net for Discord component length limits.
 *
 * Root cause (user-reported production crash in Thor-EN v3.9.40):
 *   TextInputBuilder.setLabel('Message outside the embed (optional, supports @)')
 *   = 48 chars > Discord limit 45 → shapeshift ExpectedConstraintError on EVERY
 *   open of the embed send modal → "Interaction Error" log spam.
 *   The earlier v3.9.27 fix only guarded the ticket flows; this embed.js file
 *   slipped through because the Indonesian twin happened to stay ≤ 45.
 *
 * What is tested (3 layers):
 *   (1) STATIC SCAN: zero literal component-limit violations across all of
 *       src/ + index.js — TextInput label ≤45, modal title ≤45,
 *       TextInput placeholder ≤100, button label ≤80, select option
 *       label/description ≤100, TextInput setMaxLength ≤4000.
 *       (Classification via nearest constructor found backwards.)
 *   (2) RUNTIME CONTRACT: every TextInput label & Modal title literal in
 *       src/interactions/embed.js must pass REAL discord.js builders
 *       (not mocks) — exactly like production.
 *   (3) LIMIT DOCUMENTATION: a 46-char label throws, 45 passes — so future
 *       devs understand why this test exists.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

const REPO_ROOT = path.join(__dirname, '..', '..');

// ============================================================
// Layer 1 — static scan of the whole codebase (literals only)
// ============================================================
const LIMITS = {
    'ModalBuilder.setTitle': 45,
    'TextInputBuilder.setLabel': 45,
    'TextInputBuilder.setPlaceholder': 100,
    'ButtonBuilder.setLabel': 80,
    'SelectOption.setLabel': 100,
    'SelectOption.setDescription': 100
};

const CTOR_KIND = [
    ['TextInputBuilder', 'TextInputBuilder'],
    ['ModalBuilder', 'ModalBuilder'],
    ['ButtonBuilder', 'ButtonBuilder'],
    ['StringSelectMenuOptionBuilder', 'SelectOption'],
    ['UserSelectMenuOptionBuilder', 'SelectOption'],
    ['RoleSelectMenuOptionBuilder', 'SelectOption'],
    ['MentionableSelectMenuOptionBuilder', 'SelectOption'],
    ['ChannelSelectMenuOptionBuilder', 'SelectOption'],
    ['EmbedBuilder', 'EmbedBuilder'],
    ['StringSelectMenuBuilder', 'SelectMenu']
];

function classifyBackward(back) {
    let best = null, bestIdx = -1;
    for (const [ctor, kind] of CTOR_KIND) {
        const idx = back.lastIndexOf('new ' + ctor);
        if (idx > bestIdx) { bestIdx = idx; best = kind; }
    }
    return best;
}

function limitFor(kind, method) {
    if (kind === 'ModalBuilder' && method === 'setTitle') return LIMITS['ModalBuilder.setTitle'];
    if (kind === 'TextInputBuilder' && method === 'setLabel') return LIMITS['TextInputBuilder.setLabel'];
    if (kind === 'TextInputBuilder' && method === 'setPlaceholder') return LIMITS['TextInputBuilder.setPlaceholder'];
    if (kind === 'ButtonBuilder' && method === 'setLabel') return LIMITS['ButtonBuilder.setLabel'];
    if (kind === 'SelectOption' && method === 'setLabel') return LIMITS['SelectOption.setLabel'];
    if (kind === 'SelectOption' && method === 'setDescription') return LIMITS['SelectOption.setDescription'];
    return null;
}

function collectSourceFiles() {
    const files = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) files.push(p);
        }
    })(path.join(REPO_ROOT, 'src'));
    const idx = path.join(REPO_ROOT, 'index.js');
    if (fs.existsSync(idx)) files.push(idx);
    return files;
}

function scanLiteralViolations() {
    const violations = [];
    for (const file of collectSourceFiles()) {
        const src = fs.readFileSync(file, 'utf8');
        const lines = src.split('\n');
        const offs = [0];
        for (let i = 0; i < lines.length; i++) offs.push(offs[i] + lines[i].length + 1);

        for (let i = 0; i < lines.length; i++) {
            const re = /\.(setLabel|setPlaceholder|setTitle|setDescription|setMaxLength)\s*\(/g;
            let m;
            while ((m = re.exec(lines[i])) !== null) {
                const method = m[1];
                const abs = offs[i] + m.index;
                const chunk = src.slice(abs, Math.min(src.length, abs + 400));
                const am = chunk.match(/\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`|(\d+))/);
                if (!am) continue;
                let literal = null;
                if (am[1] !== undefined) literal = am[1];
                else if (am[2] !== undefined) literal = am[2];
                else if (am[3] !== undefined) literal = am[3];
                if (literal === null) {
                    const num = parseInt(am[4], 10);
                    const backNum = src.slice(Math.max(0, abs - 500), abs);
                    if (classifyBackward(backNum) === 'TextInputBuilder' && num > 4000) {
                        violations.push(`${path.relative(REPO_ROOT, file)}:${i + 1} TextInputBuilder.setMaxLength=${num} > 4000`);
                    }
                    continue;
                }
                if (/\$\{/.test(literal)) continue; // dynamic — guarded separately at runtime
                const displayLen = literal.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\').length;
                const kind = classifyBackward(src.slice(Math.max(0, abs - 500), abs));
                const limit = limitFor(kind, method);
                if (limit && displayLen > limit) {
                    violations.push(`${path.relative(REPO_ROOT, file)}:${i + 1} ${kind}.${method} len=${displayLen} > ${limit} | ${literal.slice(0, 60)}`);
                }
            }
        }
    }
    return violations;
}

test('v3.9.41 #1 static scan: 0 literal Discord component-limit violations across src/', () => {
    const violations = scanLiteralViolations();
    assert.strictEqual(violations.length, 0,
        `Found component labels/placeholders/titles EXCEEDING Discord limits (builders throw ExpectedConstraintError at runtime):\n  - ${violations.join('\n  - ')}\nFix: shorten the literal or move detail into the placeholder (limit 100) / description.`);
});

// ============================================================
// Layer 2 — runtime contract: embed.js modals pass REAL builders
// ============================================================
test('v3.9.41 #2 every TextInput label & Modal title literal in embed.js passes real discord.js builders', () => {
    const embedSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'interactions', 'embed.js'), 'utf8');

    const textLabels = [];
    for (const m of embedSrc.matchAll(/new TextInputBuilder\(\)[\s\S]{0,400}?\.setLabel\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) {
        textLabels.push(m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
    }
    const modalTitles = [];
    for (const m of embedSrc.matchAll(/new ModalBuilder\(\)(?:[\s\S]{0,200}?)\.setTitle\(\s*'((?:[^'\\]|\\.)*)'\s*\)|\.setTitle\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) {
        const t = m[1] !== undefined ? m[1] : m[2];
        if (t !== undefined) modalTitles.push(t);
    }
    assert.ok(textLabels.length >= 6, `expected many TextInput labels in embed.js (got ${textLabels.length})`);
    assert.ok(modalTitles.length >= 3, `expected several modal titles in embed.js (got ${modalTitles.length})`);

    for (const label of textLabels) {
        assert.doesNotThrow(
            () => new TextInputBuilder().setCustomId('t').setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(false),
            `TextInput label exceeds Discord 45-char limit: ${JSON.stringify(label)} (${label.length} chars)`
        );
    }
    for (const title of modalTitles) {
        assert.doesNotThrow(
            () => new ModalBuilder().setCustomId('m').setTitle(title),
            `Modal title exceeds Discord 45-char limit: ${JSON.stringify(title)} (${title.length} chars)`
        );
    }
});

// ============================================================
// Layer 3 — limit documentation (class-of-bug regression guard)
// ============================================================
test('v3.9.41 #3 TextInput label limit: 46 chars throws, 45 chars passes (limit documentation)', () => {
    const ok45 = 'a'.repeat(45);
    assert.doesNotThrow(() => new TextInputBuilder().setCustomId('x').setLabel(ok45).setStyle(TextInputStyle.Short), 'a 45-char label MUST pass (Discord limit)');
    const bad46 = 'a'.repeat(46);
    assert.throws(() => new TextInputBuilder().setCustomId('x').setLabel(bad46).setStyle(TextInputStyle.Short), /length|constraint|ExpectedConstraint/i, 'a 46-char label MUST throw (Discord limit) — if this fails, discord.js changed the limit and the static scan needs updating');
});

test('v3.9.41 #4 specific regression: the embed send modal (formerly crashing flow) builds cleanly', () => {
    // Replica of the emb_modal_send modal — exactly the production structure.
    const modal = new ModalBuilder().setCustomId('emb_modal_send:test').setTitle('Send Embed to Channel');
    assert.doesNotThrow(() => {
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('channel')
                    .setLabel('Target channel (#mention or ID)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder('#announcements or 123456789012345678')
                    .setMaxLength(100)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('message')
                    .setLabel('Message outside the embed (optional)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(2000)
                    .setPlaceholder('Leave empty = embed only. Fill in = text + embed.\nSupports @everyone, @here, <@&role>, <@user>')
                    .setValue('')
            )
        );
    }, 'the embed send modal must build — regression for the v3.9.41 crash');
});
