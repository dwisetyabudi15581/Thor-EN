/**
 * Event: guildRoleDelete — live sync + orphaned-setting detection (v3.29.0).
 *
 * Two effects:
 *   1. A role being deleted changes the "Roles" counter → mark the
 *      serverstats counters dirty, the 60s scheduler tick renames the
 *      channel (rate-limit safe). Cheap no-op when /serverstats is not
 *      set up.
 *   2. v3.29.0 (TAHAP 1 sync audit): every stored setting that still POINTS
 *      at the deleted role (admin/booster/verified/unverified role, level
 *      reward roles, product auto-roles, automod exempt list,
 *      self-role panel buttons + visibility gates) is reported IMMEDIATELY
 *      — console + the server-log channel. READ-ONLY: nothing is
 *      auto-cleared; the admin fixes what matters via the dashboard, where
 *      the deleted role already renders as an explicit "Deleted …" ghost
 *      option.
 */

const { Events } = require('discord.js');
const { markStatsDirty } = require('../../data/serverstatsManager');
const { findRoleRefs } = require('../../infra/configOrphans');
const { logServerEvent, snip } = require('../../infra/serverLog');

module.exports = {
    name: Events.GuildRoleDelete,
    async execute(role) {
        const guildId = role?.guild?.id;
        try {
            markStatsDirty(guildId);
        } catch (_) {}

        // v3.29.0: orphaned-reference report (best-effort — never breaks the event).
        try {
            if (!guildId || !role?.id) return;
            const refs = findRoleRefs(guildId, role.id);
            if (refs.length === 0) return;

            const list = refs.map(r => `• ${r}`).join('\n');
            console.warn(
                `🗑️ [sync] Role "${role.name || role.id}" was deleted, but ${refs.length} setting(s) still point at it:\n${list}`
            );

            await logServerEvent(role.client, {
                type: 'ROLE_DELETE',
                guildId,
                fields: [
                    { name: '🗑️ Deleted role', value: `@${role.name || role.id} (\`${role.id}\`)`, inline: false },
                    { name: `⚠️ ${refs.length} setting(s) now orphaned`, value: snip(list, 1000), inline: false }
                ],
                footer: 'Re-point or clear them in the web dashboard (they show as "Deleted …" options).'
            });
        } catch (err) {
            console.error('[guildRoleDelete] orphan scan failed:', err.message);
        }
    }
};
