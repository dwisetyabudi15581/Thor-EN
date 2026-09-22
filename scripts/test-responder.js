/**
 * Test script for reproducing the auto-responder issue.
 * Simulation: add responder → findMatch → markUsed → findMatch again.
 */

const responderManager = require('../src/data/responderManager');

const GUILD_ID = 'test-debug-guild';
const USER_ID = 'test-debug-user';

console.log('=== TEST AUTO-RESPONDER ===\n');

// 1. Add a responder
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

// 3. findMatch with the exact trigger
console.log('\n3. findMatch with content="!sosmed" (exact match)...');
const match1 = responderManager.findMatch(GUILD_ID, '!sosmed', USER_ID);
console.log('   Result:', match1 ? `FOUND id=${match1.id}, trigger="${match1.trigger}"` : 'NULL');

// 4. findMatch with trigger + space + arguments
console.log('\n4. findMatch with content="!sosmed halo" (trigger + args)...');
const match2 = responderManager.findMatch(GUILD_ID, '!sosmed halo', USER_ID);
console.log('   Result:', match2 ? `FOUND id=${match2.id}, trigger="${match2.trigger}"` : 'NULL');

// 5. findMatch with different casing
console.log('\n5. findMatch with content="!SOSMED" (different casing)...');
const match3 = responderManager.findMatch(GUILD_ID, '!SOSMED', USER_ID);
console.log('   Result:', match3 ? `FOUND id=${match3.id}, trigger="${match3.trigger}"` : 'NULL');

// 6. findMatch with a trigger that doesn't exist
console.log('\n6. findMatch with content="!other" (no such responder)...');
const match4 = responderManager.findMatch(GUILD_ID, '!other', USER_ID);
console.log('   Result:', match4 ? `FOUND` : 'NULL (expected)');

// 7. markUsed, then findMatch again (cooldown test)
if (match1) {
    console.log('\n7. markUsed, then findMatch again (cooldown test)...');
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

console.log('\n=== TEST COMPLETE ===');
