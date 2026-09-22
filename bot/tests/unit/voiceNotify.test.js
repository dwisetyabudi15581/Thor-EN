/**
 * Unit tests v3.9.42-en — new temp-voice owner notification via the voice channel's CHAT (not DM).
 *
 * The guarded change (user request: "notify the voice owner in the voice chat
 * instead of DM"):
 *   Before: whenever voice-channel ownership changed (auto-transfer when the
 *   owner left, or manual transfer via the panel), the bot DM'd the new owner —
 *   which often failed (user DMs closed, silently caught by `catch (_) {}`)
 *   or went unread.
 *   After: the bot posts the message in the voice channel's own TEXT CHAT +
 *   mentions the new owner (the ping notification still works).
 *
 * What is tested (static source contract, in the style of componentLimits.test.js):
 *   (1) voiceStateUpdate.js (auto-transfer): no `newOwner.send` (DM),
 *       has `voiceChannel.send` (channel chat), and a `<@${newOwner.id}>` mention.
 *   (2) tempvoice.js (manual transfer): no `newOwner.send`, has
 *       `found.channel.send`, a `<@${newOwnerId}>` mention, and `oldOwnerId`
 *       captured BEFORE `transferOwnership` (prevents a swapped message).
 *   (3) Regression: no new-owner DM left anywhere in the temp-voice domain.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function readSrc(rel) {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

test('v3.9.42 #1 auto-transfer (voiceStateUpdate.js): notification via the voice channel chat, not DM, with a new-owner mention', () => {
    const src = readSrc('src/bot/events/voiceStateUpdate.js');

    assert.ok(/function handleAutoTransferOwnership/.test(src), 'the auto-transfer function must exist');
    assert.ok(!src.includes('newOwner.send('), 'DMing the new owner (newOwner.send) must no longer be used in auto-transfer');
    assert.ok(src.includes('voiceChannel.send('), 'the notification must go through voiceChannel.send (voice channel text chat)');
    assert.ok(src.includes('<@${newOwner.id}>'), 'the message must mention the new owner <@newOwner.id> so the ping still works');
    assert.ok(src.includes('<@${oldOwnerId}>'), 'the auto-transfer message must reference the old owner');
});

test('v3.9.42 #2 manual transfer (tempvoice.js): notification via the voice channel chat, not DM; oldOwnerId captured before the transfer', () => {
    const src = readSrc('src/interactions/tempvoice.js');

    assert.ok(/function handleTempVoiceTransferExecute/.test(src), 'the manual transfer handler must exist');
    assert.ok(!src.includes('newOwner.send('), 'DMing the new owner (newOwner.send) must no longer be used in manual transfer');
    assert.ok(src.includes('found.channel.send('), 'the notification must go through found.channel.send (voice channel text chat)');
    assert.ok(src.includes('<@${newOwnerId}>'), 'the message must mention the new owner <@newOwnerId> so the ping still works');

    // oldOwnerId MUST be captured before transferOwnership overwrites the
    // registry — otherwise the "transferred by <@owner>" message could swap
    // to the NEW owner.
    const captureIdx = src.indexOf('const oldOwnerId = found.channelInfo.ownerId');
    const transferIdx = src.indexOf('tempVoiceManager.transferOwnership(found.guild.id');
    assert.ok(captureIdx !== -1, 'oldOwnerId must be captured explicitly before the transfer');
    assert.ok(transferIdx !== -1, 'the transferOwnership call must exist');
    assert.ok(captureIdx < transferIdx, 'the oldOwnerId capture must come BEFORE transferOwnership overwrites the registry');
});

test('v3.9.42 #3 regression: the temp-voice domain is free of new-owner DMs in both handler files', () => {
    for (const rel of ['src/bot/events/voiceStateUpdate.js', 'src/interactions/tempvoice.js']) {
        const src = readSrc(rel);
        assert.ok(!src.includes('newOwner.send('), `${rel} must not go back to DMing the new owner`);
    }
});
