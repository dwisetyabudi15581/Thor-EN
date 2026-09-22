/**
 * Event: channelCreate — marks the server stats counters dirty (v3.9.51).
 *
 * A channel being created changes the "Channels" counter — mark dirty and
 * let the 60s scheduler tick do the actual rename (rate-limit safe: the
 * rename only happens when the number actually changed + the per-channel
 * cooldown allows it). Cheap no-op when the counters are not set up.
 */

const { Events } = require('discord.js');
const { markStatsDirty } = require('../../data/serverstatsManager');

module.exports = {
    name: Events.ChannelCreate,
    execute(channel) {
        try {
            markStatsDirty(channel?.guild?.id);
        } catch (_) {} // never break the event pipeline over a counter
    }
};
