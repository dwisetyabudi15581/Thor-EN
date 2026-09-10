/**
 * Event: channelDelete — marks the server stats counters dirty (v3.9.51).
 *
 * Two effects:
 *   1. A channel being deleted changes the "Channels" counter → mark dirty
 *      (the scheduler tick does the rename).
 *   2. If the deleted channel IS one of the counter channels, the next
 *      refresh detects it as missing (warning + the fix command) and the
 *      feature auto-disables once ALL counters are gone.
 */

const { Events } = require('discord.js');
const { markStatsDirty } = require('../../data/serverstatsManager');

module.exports = {
    name: Events.ChannelDelete,
    execute(channel) {
        try {
            markStatsDirty(channel?.guild?.id);
        } catch (_) {}
    }
};
