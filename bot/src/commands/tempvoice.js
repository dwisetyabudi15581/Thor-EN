/**
 * Domain: tempvoice
 * Slash commands: /setup-tempvoice, /tempvoice-remove
 *
 * Split off from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: set up the global temp voice category + trigger channel + control panel,
 *           remove the setup (including the category + all related channels).
 *
 * v3.8.2: /setup-tempvoice with no parameters — auto-creates the category + 2 channels.
 * v3.9.8: roll back already-created channels if any step fails (prevents orphans).
 */

const {
    MessageFlags,
    ChannelType,
    tempVoiceManager,
    buildGlobalControlPanel,
    logAudit,
    safeEditReply
} = require('./_shared');

module.exports = async function (interaction) {
    // ====================================================
    // === /setup-tempvoice ===
    // ====================================================
    // v3.8.2: /setup-tempvoice with no parameters.
    // The bot auto-creates 1 category containing:
    //   - 1 text channel "📋 control-panel" (where the global panel is installed)
    //   - 1 voice channel "🔊 Create Voice" (trigger — members join it to create a new voice channel)
    if (interaction.commandName === 'setup-tempvoice') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const guild = interaction.guild;

        // Check whether a setup already exists
        const existingConfig = tempVoiceManager.getGuildConfig(guild.id);

        // If a setup already exists, re-send the panel to the existing control channel.
        if (existingConfig?.controlChannelId && existingConfig?.creatorChannelId) {
            const existingControlChannel = guild.channels.cache.get(existingConfig.controlChannelId);
            // If the old control channel was already deleted, don't continue into a new setup (creates orphans).
            // Tell the admin to clean up first via /tempvoice-remove.
            if (!existingControlChannel) {
                return safeEditReply(interaction, {
                    content:
                        `❌ The old control channel (ID: \`${existingConfig.controlChannelId}\`) has been deleted from the server.\n\n` +
                        `Run \`/tempvoice-remove\` first to clean up the old config, then \`/setup-tempvoice\` again.`
                });
            }
            // Delete the old panel if it exists
            if (existingConfig.controlMessageId) {
                try {
                    const oldMsg = await existingControlChannel.messages
                        .fetch(existingConfig.controlMessageId)
                        .catch(() => null);
                    if (oldMsg) await oldMsg.delete().catch(() => {});
                } catch (_) {}
            }
            // Send the new panel
            const { embed, components } = buildGlobalControlPanel({
                activeOwners: [],
                guildName: guild.name
            });
            const panelMsg = await existingControlChannel.send({ embeds: [embed], components }).catch(err => {
                console.warn('Failed to refresh temp voice panel:', err?.message || err);
                return null;
            });
            // If the send fails, reply with an error — don't continue into a new setup (anti-orphan)
            if (!panelMsg) {
                return safeEditReply(interaction, {
                    content:
                        `❌ Failed to refresh the panel to ${existingControlChannel}. Check bot permissions (**Send Messages** + **Embed Links**).\n\n` +
                        `The existing setup was not changed.`
                });
            }
            tempVoiceManager.setControlMessageId(guild.id, panelMsg.id);
            return safeEditReply(interaction, {
                content: `✅ **Temp voice panel refreshed!**\n\n🎛️ ${panelMsg.url}\n\n💡 The existing setup is reused (category + trigger + control channel).`
            });
        }

        // === New setup: create the category + 2 channels ===
        // v3.9.8 FIX: add rollback if any step fails. Previously,
        // if creatorChannel creation failed after controlChannel was created,
        // controlChannel was orphaned (not registered, never cleaned up).
        let category, controlChannel, creatorChannel;
        try {
            // Create the "🎤 TEMP VOICE" category
            category = guild.channels.cache.find(
                c => c.name === '🎤 TEMP VOICE' && c.type === ChannelType.GuildCategory
            );
            if (!category) {
                category = await guild.channels.create({
                    name: '🎤 TEMP VOICE',
                    type: ChannelType.GuildCategory
                });
            }

            // Create the "📋 control-panel" text channel to hold the global panel
            controlChannel = await guild.channels.create({
                name: '📋 control-panel',
                type: ChannelType.GuildText,
                parent: category.id,
                topic: 'Global control panel for temp voice. Do not delete — the bot uses the message here to control voice channels.'
            });

            // Create the "🔊 Create Voice" voice channel as the trigger
            creatorChannel = await guild.channels.create({
                name: '🔊 Create Voice',
                type: ChannelType.GuildVoice,
                parent: category.id,
                bitrate: 64000
            });

            // Save the config
            tempVoiceManager.setupGuild(guild.id, creatorChannel.id, category.id, controlChannel.id);
        } catch (err) {
            console.error('Error setting up temp voice:', err);
            // v3.9.8: rollback — delete channels that were created but not yet registered
            // so they don't become orphans. Only delete ones definitely created in this try block.
            if (controlChannel) {
                try {
                    await controlChannel.delete('Rollback: setup-tempvoice failed');
                } catch (_) {}
            }
            if (creatorChannel) {
                try {
                    await creatorChannel.delete('Rollback: setup-tempvoice failed');
                } catch (_) {}
            }
            // The category is not deleted because it may have existed before / be used by other channels.
            return safeEditReply(interaction, {
                content: `❌ Failed to set up temp voice: ${err.message}\n\nMake sure the bot has **Manage Channels** and **Manage Roles** permissions.`
            });
        }

        // Send the GLOBAL control panel to the control channel
        const { embed, components } = buildGlobalControlPanel({
            activeOwners: [],
            guildName: guild.name
        });

        let panelMsg;
        try {
            panelMsg = await controlChannel.send({ embeds: [embed], components });
        } catch (err) {
            console.error('Failed to send the global panel:', err.message);
            return safeEditReply(interaction, {
                content: `❌ Failed to send the panel to ${controlChannel}. Check bot permissions (Send Messages + Embed Links).`
            });
        }

        // Save the controlMessageId
        tempVoiceManager.setControlMessageId(guild.id, panelMsg.id);

        await logAudit(interaction.client, {
            action: 'SETUP_TEMPVOICE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Setup Temp Voice — category: ${category.name}, trigger: ${creatorChannel} (\`${creatorChannel.id}\`), control panel: ${controlChannel} (\`${controlChannel.id}\`)`,
            guildId: guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ **Temp Voice is ready!**\n\n` +
                `📂 **Category:** ${category.name}\n` +
                `🎤 **Trigger channel:** ${creatorChannel} (members join here to create a new voice channel)\n` +
                `🎛️ **Control panel:** ${panelMsg.url}\n\n` +
                `💡 Members just click the **🎤 Create Voice** button on the control panel, or join the trigger channel directly. Once they become an owner, the panel updates automatically to show their channel controls.`
        });
    }

    // ====================================================
    // === /tempvoice-remove ===
    // ====================================================
    if (interaction.commandName === 'tempvoice-remove') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const config = tempVoiceManager.getGuildConfig(interaction.guild.id);
        if (!config) {
            return safeEditReply(interaction, { content: 'ℹ️ Temp voice isn\'t set up in this guild yet.' });
        }

        // Delete the global control panel message
        try {
            if (config.controlMessageId && config.controlChannelId) {
                const ctrlChannel = interaction.guild.channels.cache.get(config.controlChannelId);
                if (ctrlChannel) {
                    const ctrlMsg = await ctrlChannel.messages.fetch(config.controlMessageId).catch(() => null);
                    if (ctrlMsg) await ctrlMsg.delete().catch(() => {});
                }
            }
        } catch (_) {}

        // v3.8.2: delete ALL channels in the category (control, trigger, active temp voices, the category itself)
        try {
            const channelsToDelete = [];
            if (config.controlChannelId) channelsToDelete.push(config.controlChannelId);
            if (config.creatorChannelId) channelsToDelete.push(config.creatorChannelId);
            if (config.channels) {
                for (const channelId of Object.keys(config.channels)) {
                    channelsToDelete.push(channelId);
                }
            }
            for (const channelId of channelsToDelete) {
                const ch = interaction.guild.channels.cache.get(channelId);
                if (ch) await ch.delete('Temp voice setup removed').catch(() => {});
            }
            // Delete the category (should be empty now)
            if (config.categoryId) {
                const cat = interaction.guild.channels.cache.get(config.categoryId);
                if (cat) await cat.delete('Temp voice category deleted').catch(() => {});
            }
        } catch (_) {}

        tempVoiceManager.removeGuild(interaction.guild.id);
        await logAudit(interaction.client, {
            action: 'TEMPVOICE_REMOVE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Remove Temp Voice setup from the guild (category + all related channels deleted)`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                '✅ Temp Voice setup successfully removed. The category + control panel + trigger channel + all active temp voice channels were also deleted.'
        });
    }
};
