/**
 * Validate semua command option description di registry.
 * Discord API require: 1-100 char per option description.
 */
const { getCommands } = require('../src/commands/registry');

const commands = getCommands();
const problems = [];

commands.forEach((cmd, cmdIdx) => {
    // v3.9.17: cek root command description juga (Discord max 1-100 char).
    if (!cmd.description) {
        problems.push({
            cmdIdx,
            cmdName: cmd.name,
            optIdx: -1,
            optName: '(root command)',
            issue: 'MISSING root description',
            desc: cmd.description
        });
    } else {
        const rootLen = cmd.description.length;
        if (rootLen < 1 || rootLen > 100) {
            problems.push({
                cmdIdx,
                cmdName: cmd.name,
                optIdx: -1,
                optName: '(root command)',
                issue: `ROOT LENGTH ${rootLen} (must be 1-100)`,
                desc: cmd.description
            });
        }
    }
    if (!cmd.options) return;
    cmd.options.forEach((opt, optIdx) => {
        if (!opt.description) {
            problems.push({
                cmdIdx,
                cmdName: cmd.name,
                optIdx,
                optName: opt.name,
                issue: 'MISSING description',
                desc: opt.description
            });
        } else {
            const len = opt.description.length;
            if (len < 1 || len > 100) {
                problems.push({
                    cmdIdx,
                    cmdName: cmd.name,
                    optIdx,
                    optName: opt.name,
                    issue: `LENGTH ${len} (must be 1-100)`,
                    desc: opt.description
                });
            }
        }
        // Check nested choices
        if (opt.choices) {
            opt.choices.forEach((choice, choiceIdx) => {
                if (!choice.description) return; // choice description optional
                const len = choice.description.length;
                if (len > 100) {
                    problems.push({
                        cmdIdx,
                        cmdName: cmd.name,
                        optIdx,
                        optName: opt.name,
                        choiceIdx,
                        choiceName: choice.name,
                        issue: `CHOICE LENGTH ${len} (must be <=100)`,
                        desc: choice.description
                    });
                }
            });
        }
    });
});

if (problems.length === 0) {
    console.log('✅ Semua option description valid (1-100 char)');
} else {
    console.log(`❌ Ditemukan ${problems.length} problem:\n`);
    problems.forEach((p, i) => {
        console.log(`${i + 1}. Command #${p.cmdIdx} "${p.cmdName}" option[${p.optIdx}] "${p.optName}"`);
        console.log(`   Issue: ${p.issue}`);
        console.log(`   Desc: "${p.desc}"`);
        console.log('');
    });
}

// Bonus: print semua command index dengan nama, supaya gampang cari #10
console.log('=== Command index → name mapping ===');
commands.forEach((c, i) => {
    console.log(`${i}: ${c.name} (${c.options ? c.options.length : 0} options)`);
});
