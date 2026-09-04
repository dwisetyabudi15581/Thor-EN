/**
 * Test script untuk reproduksi masalah auto-responder.
 * Simulasi: add responder → findMatch → markUsed → findMatch again.
 */

const responderManager = require('../src/data/responderManager');

const GUILD_ID = 'test-debug-guild';
const USER_ID = 'test-debug-user';

console.log('=== TEST AUTO-RESPONDER ===\n');

// 1. Tambah responder
console.log('1. Add responder...');
const addResult = responderManager.addResponder(GUILD_ID, {
    trigger: '!sosmed',
    reply: 'IG: @test\nTikTok: @test',
    replyType: 'text',
    cooldownMs: 3000,
    createdBy: USER_ID,
    createdByTag: 'TestUser#1234'
});
console.log('   Result:', JSON.stringify(addResult, null, 2));

// 2. Get guild responders
console.log('\n2. Get guild responders...');
const responders = responderManager.getGuildResponders(GUILD_ID);
console.log(`   Count: ${responders.length}`);
responders.forEach((r, i) => {
    console.log(`   [${i}] id=${r.id}, trigger="${r.trigger}", replyType="${r.replyType}", cooldownMs=${r.cooldownMs}`);
});

// 3. findMatch dengan trigger persis
console.log('\n3. findMatch dengan content="!sosmed" (exact match)...');
const match1 = responderManager.findMatch(GUILD_ID, '!sosmed', USER_ID);
console.log('   Result:', match1 ? `FOUND id=${match1.id}, trigger="${match1.trigger}"` : 'NULL');

// 4. findMatch dengan trigger + spasi + argumen
console.log('\n4. findMatch dengan content="!sosmed halo" (trigger + args)...');
const match2 = responderManager.findMatch(GUILD_ID, '!sosmed halo', USER_ID);
console.log('   Result:', match2 ? `FOUND id=${match2.id}, trigger="${match2.trigger}"` : 'NULL');

// 5. findMatch dengan case berbeda
console.log('\n5. findMatch dengan content="!SOSMED" (case berbeda)...');
const match3 = responderManager.findMatch(GUILD_ID, '!SOSMED', USER_ID);
console.log('   Result:', match3 ? `FOUND id=${match3.id}, trigger="${match3.trigger}"` : 'NULL');

// 6. findMatch dengan trigger yang tidak ada
console.log('\n6. findMatch dengan content="!lain" (tidak ada responder)...');
const match4 = responderManager.findMatch(GUILD_ID, '!lain', USER_ID);
console.log('   Result:', match4 ? `FOUND` : 'NULL (expected)');

// 7. markUsed lalu findMatch lagi (test cooldown)
if (match1) {
    console.log('\n7. markUsed lalu findMatch lagi (test cooldown)...');
    responderManager.markUsed(GUILD_ID, match1.id, USER_ID);
    const match5 = responderManager.findMatch(GUILD_ID, '!sosmed', USER_ID);
    console.log(
        '   Result after markUsed:',
        match5 ? 'FOUND (cooldown NOT working!)' : 'NULL (cooldown working — expected)'
    );
}

// 8. Cleanup
console.log('\n8. Cleanup...');
const removeResult = responderManager.removeResponder(GUILD_ID, '!sosmed');
console.log('   Remove result:', removeResult);

console.log('\n=== TEST SELESAI ===');
