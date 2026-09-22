/**
 * Event: channelDelete — live sync + orphaned-setting detection (v3.29.0).
 *
 * Three effects:
 *   1. A channel being deleted changes the "Channels" counter → mark the
 *      serverstats counters dirty (the scheduler tick does the rename).
 *   2. If the deleted channel IS one of the counter channels, the next
 *      refresh detects it as missing (warning + the fix command) and the
 *      feature auto-disables once ALL counters are gone.
 *   3. v3.29.0 (TAHAP 1 sync audit): every stored setting that still POINTS
 *      at the deleted channel (welcome/goodbye/server-log channel, automod
 *      allow-list, temp voice, ticket/self-role panels, pending
 *      announcements) is reported IMMEDIATELY — console + the server-log
 *      channel — instead of failing silently for weeks. READ-ONLY: nothing
 *      is auto-cleared; the web dashboard shows the same orphans as
 *      "Deleted …" ghost options (and its v3.29.0 auto-refresh surfaces them
 *      within seconds), so the admin decides what to re-point or clear.
 */

const { Events } = require('discord.js');
const { markStatsDirty } = require('../../data/serverstatsManager');
const { findChannelRefs } = require('../../infra/configOrphans');
const { logServerEvent, snip } = require('../../infra/serverLog');

module.exports = {
    name: Events.ChannelDelete,
    async execute(channel) {
        const guildId = channel?.guild?.id;
        try {
            markStatsDirty(guildId);
        } catch (_) {}

        // v3.29.0: orphaned-reference report (best-effort — never breaks the event).
        try {
            if (!guildId || !channel?.id) return;
            const refs = findChannelRefs(guildId, channel.id);
            if (refs.length === 0) return;

            const label = `#${channel.name || channel.id}`;
            const list = refs.map(r => `• ${r}`).join('\n');
            console.warn(
                `🗑️ [sync] Channel ${label} was deleted, but ${refs.length} setting(s) still point at it:\n${list}`
            );

            // The server log entry is best-effort: it lands in the configured
            // server-log channel — which may itself be the deleted channel
            // (then logServerEvent silently no-ops, the console warn above
            // still stands).
            await logServerEvent(channel.client, {
                type: 'CHANNEL_DELETE',
                guildId,
                fields: [
                    { name: '🗑️ Deleted channel', value: `${label} (\`${channel.id}\`)`, inline: false },
                    { name: `⚠️ ${refs.length} setting(s) now orphaned`, value: snip(list, 1000), inline: false }
                ],
                footer: 'Re-point or clear them in the web dashboard (they show as "Deleted …" options).'
            });
        } catch (err) {
            console.error('[channelDelete] orphan scan failed:', err.message);
        }
    }
};
