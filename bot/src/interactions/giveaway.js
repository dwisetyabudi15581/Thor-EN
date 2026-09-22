/**
 * Giveaway domain handler — button `gw_join:*` & `gw_leave:*`.
 *
 * Extracted from handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior preserved as-is — just moved to a new file.
 *
 * Helpers `handleGiveawayButton` and `updateGiveawayMessage` are LOCAL
 * functions in this file.
 *
 * The router (src/interactions/index.js) already applies:
 *   - dedup (checkAndMark)
 *   - `replied/deferred` guard
 *   - interaction type check (button/select/modal)
 *   - routing by customId prefix
 * So the domain handler can focus on its logic alone.
 */

const { EmbedBuilder, MessageFlags } = require('discord.js');
const { withUserLock } = require('../commands/_shared');
// addParticipant / removeParticipant are not exported from _shared — import them directly.
const {
    get: getGiveaway,
    addParticipant: gwAddParticipant,
    removeParticipant: gwRemoveParticipant
} = require('../data/giveawayManager');

module.exports = async function (interaction) {
    // ====================================================
    // === GIVEAWAY: JOIN / LEAVE BUTTONS ===
    // ====================================================
    if (
        interaction.isButton() &&
        (interaction.customId.startsWith('gw_join:') || interaction.customId.startsWith('gw_leave:'))
    ) {
        return handleGiveawayButton(interaction);
    }
};

// ====================================================
// === HELPER: GIVEAWAY JOIN / LEAVE BUTTON HANDLER ===
// ====================================================
async function handleGiveawayButton(interaction) {
    try {
        const [action, gwId] = interaction.customId.split(':');
        const gw = getGiveaway(gwId);
        if (!gw) {
            return interaction.reply({
                content: '❌ Giveaway not found (it may have been deleted).',
                flags: MessageFlags.Ephemeral
            });
        }
        if (gw.ended) {
            return interaction.reply({ content: '❌ This giveaway has already ended.', flags: MessageFlags.Ephemeral });
        }
        if (gw.guildId !== interaction.guild.id) {
            return interaction.reply({
                content: '❌ This giveaway does not belong to this guild.',
                flags: MessageFlags.Ephemeral
            });
        }

        // Required role check — ONLY for join.
        // v3.9.24 FIX: previously this check also applied to LEAVE, so a member
        // who lost the required role COULD NOT leave the giveaway (stuck).
        if (gw.requiredRoleId && action === 'gw_join') {
            const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            if (!member || !member.roles.cache.has(gw.requiredRoleId)) {
                const role = interaction.guild.roles.cache.get(gw.requiredRoleId);
                return interaction.reply({
                    content: `❌ You must have the ${role || '`' + gw.requiredRoleId + '`'} role to join this giveaway.`,
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        // v3.9.2 FIX: wrap join/leave in a per-user lock to prevent a
        // TOCTOU race condition. Previously, 2 quick clicks (<100ms) could
        // both pass the `includes()` check, then both push userId →
        // duplicate participant. The lock forces the second click to wait for
        // the first to finish (by which point save() has written the latest data to disk).
        const lockResult = await withUserLock('gw', interaction.user.id, async () => {
            // Refresh gw from disk inside the lock so we read the latest data
            const gwFresh = getGiveaway(gwId);
            if (!gwFresh) return { type: 'notfound' };
            if (gwFresh.ended) return { type: 'ended' };

            // JOIN
            if (action === 'gw_join') {
                if (gwFresh.participantIds.includes(interaction.user.id)) {
                    return { type: 'already_joined' };
                }
                const updated = gwAddParticipant(gwId, interaction.user.id);
                await updateGiveawayMessage(interaction, updated);
                return { type: 'joined', total: updated.participantIds.length };
            }

            // LEAVE
            if (action === 'gw_leave') {
                if (!gwFresh.participantIds.includes(interaction.user.id)) {
                    return { type: 'not_joined' };
                }
                const updated = gwRemoveParticipant(gwId, interaction.user.id);
                await updateGiveawayMessage(interaction, updated);
                return { type: 'left' };
            }
            return { type: 'noop' };
        });

        if (lockResult === null) {
            // Lock acquisition failed — user clicked too fast
            return interaction.reply({
                content: '⏳ Hold on, you are clicking too fast. Try again in 1 second.',
                flags: MessageFlags.Ephemeral
            });
        }

        switch (lockResult.type) {
            case 'notfound':
                return interaction.reply({
                    content: '❌ Giveaway not found (it may have been deleted).',
                    flags: MessageFlags.Ephemeral
                });
            case 'ended':
                return interaction.reply({ content: '❌ This giveaway has already ended.', flags: MessageFlags.Ephemeral });
            case 'already_joined':
                return interaction.reply({
                    content: 'ℹ️ You have already joined this giveaway.',
                    flags: MessageFlags.Ephemeral
                });
            case 'not_joined':
                return interaction.reply({
                    content: 'ℹ️ You have not joined this giveaway yet.',
                    flags: MessageFlags.Ephemeral
                });
            case 'joined':
                return interaction.reply({
                    content: `✅ You joined the giveaway **${gw.prize}**! 🎉\n👥 Total participants: ${lockResult.total}`,
                    flags: MessageFlags.Ephemeral
                });
            case 'left':
                return interaction.reply({
                    content: `🚪 You left the giveaway **${gw.prize}**.`,
                    flags: MessageFlags.Ephemeral
                });
            default:
                return interaction.reply({
                    content: '❌ No action was taken.',
                    flags: MessageFlags.Ephemeral
                });
        }
    } catch (err) {
        console.error('Giveaway button error:', err);
        if (interaction.isRepliable() && !interaction.replied) {
            await interaction.reply({ content: '❌ An error occurred.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }
}

async function updateGiveawayMessage(interaction, gw) {
    try {
        const channel = interaction.guild.channels.cache.get(gw.channelId);
        if (!channel) return;
        const msg = await channel.messages.fetch(gw.messageId).catch(() => null);
        if (!msg) return;

        const timeLeft = gw.endsAt - Date.now();
        const embed = new EmbedBuilder()
            .setTitle('🎉 GIVEAWAY!')
            .setDescription(
                `🎁 **Prize:** ${gw.prize}\n\n` +
                    `👥 **Winners:** ${gw.winnersCount}\n` +
                    `⏰ **Ends:** <t:${Math.floor(gw.endsAt / 1000)}:R> (<t:${Math.floor(gw.endsAt / 1000)}:F>)\n` +
                    `🎟️ **Participants:** ${gw.participantIds.length}\n` +
                    (gw.requiredRoleId ? `🔐 **Requirement:** <@&${gw.requiredRoleId}>\n` : '') +
                    `\n👇 Click the **🎉 Join** button below to enter!`
            )
            .setColor(timeLeft < 60000 ? 0xe67e22 : 0xf1c40f)
            .setFooter({ text: `Host: ${gw.hostTag} | ID: ${gw.id}` })
            .setTimestamp();
        await msg.edit({ embeds: [embed] });
    } catch (err) {
        console.warn('Failed to update giveaway message:', err.message);
    }
}
