/**
 * Event: guildRoleDelete — marks the server stats counters dirty (v3.9.51).
 *
 * A role being deleted changes the "Roles" counter → mark dirty, the 60s
 * scheduler tick renames the channel (rate-limit safe). Cheap no-op when
 * the counters are not set up.
 */

const { Events } = require('discord.js');
const { markStatsDirty } = require('../../data/serverstatsManager');

module.exports = {
    name: Events.GuildRoleDelete,
    execute(role) {
        try {
            markStatsDirty(role?.guild?.id);
        } catch (_) {}
    }
};
