/**
 * Domain: serverstats
 * Slash commands: /serverstats setup, /serverstats remove, /serverstats refresh
 *
 * v3.9.51 (user request: "live server stats like the ServerStats bots"):
 * creates a "📊 SERVER STATS" category with 5 auto-updating counter
 * channels (Members, Bots, Boosts, Roles, Channels). The channel NAMES are
 * the live numbers — they update automatically on member/boost/role/channel
 * changes (see src/data/serverstatsManager.js for the rate-limit strategy:
 * change detection + 5-min per-channel cooldown + dirty-driven refresh).
 *
 * setup   — creates the category + counters (rollback on partial failure,
 *           anti-orphan, same pattern as /setup-tempvoice)
 * remove  — deletes every counter channel + the category + the config
 * refresh — forces an immediate update (admin-invoked, bypasses the
 *           cooldown once — safe because it is rare)
 *
 * Permission notes:
 *   - Router-level: admins only (defaultMemberPermissions: ManageGuild).
 *   - Bot-side: needs Manage Channels + Manage Roles — creating channels
 *     WITH permission overwrites (denying @everyone Connect) requires both.
 *     Checked up front with a specific fix hint instead of failing halfway.
 *   - @everyone is denied Connect on every counter channel so they are
 *     display-only — members see the numbers but cannot join the channels.
 */

const {
    MessageFlags,
    ChannelType,
    PermissionFlagsBits,
    EmbedBuilder,
    serverstatsManager,
    logAudit,
    safeEditReply
} = require('./_shared');

const { COUNTER_DEFS, buildCounterName, computeCounterValue } = serverstatsManager;

const CATEGORY_NAME = '📊 SERVER STATS';

module.exports = async function (interaction) {
    const sub = interaction.options.getSubcommand();

    // ====================================================
    // === /serverstats setup ===
    // ====================================================
    if (sub === 'setup') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = interaction.guild;

        // Bot permission check — BEFORE creating anything (anti-orphan).
        const me = guild.members?.me;
        const myPerms = me?.permissions || interaction.appPermissions;
        if (!myPerms?.has(PermissionFlagsBits.ManageChannels) || !myPerms?.has(PermissionFlagsBits.ManageRoles)) {
            return safeEditReply(interaction, {
                content:
                    '❌ I need the **Manage Channels** + **Manage Roles** permissions to create the counter channels (Manage Roles is required for the @everyone overwrites).\n\n' +
                    'Fix: Server Settings → Roles → **the bot\'s role** → enable both, then run `/serverstats setup` again.'
            });
        }

        // Already set up? Reuse is NOT automatic — the admin must explicitly
        // remove first (otherwise we'd create a second set of counters).
        if (serverstatsManager.isEnabled()) {
            const cfg = serverstatsManager.getConfig();
            const existing = Object.values(cfg.counters || {})
                .map(id => guild.channels.cache.get(id))
                .filter(Boolean);
            if (existing.length > 0) {
                return safeEditReply(interaction, {
                    content:
                        '⚠️ The server stats counters are already set up.\n\n' +
                        `• To update the numbers right now: \`/serverstats refresh\`\n` +
                        `• To delete them and start over: \`/serverstats remove\` first`
                });
            }
            // Enabled but ALL channels are gone (deleted by an admin) → the
            // config is dead weight: clear it and fall through to a fresh setup.
            serverstatsManager.clearConfig();
        }

        // === Create the category + 5 counter channels ===
        // v3.9.8 anti-orphan pattern (same as /setup-tempvoice): if any step
        // fails, everything created so far is rolled back — no zombie channels.
        //
        // All live values are computed UP FRONT (before creating anything):
        // creating the counters themselves grows guild.channels.cache, so
        // computing "Channels" mid-loop would count the half-created counters
        // (a self-referential number that jumps again on the next refresh).
        const liveValues = {};
        for (const def of COUNTER_DEFS) {
            liveValues[def.type] = computeCounterValue(guild, def.type);
        }

        const everyoneId = guild.roles.everyone.id;
        const created = [];
        let category = null;
        try {
            category = await guild.channels.create({
                name: CATEGORY_NAME,
                type: ChannelType.GuildCategory,
                // Top of the channel list — the counters are the first thing
                // members see (same placement as the popular ServerStats bots).
                position: 0,
                permissionOverwrites: [
                    { id: everyoneId, deny: [PermissionFlagsBits.Connect] }
                ],
                reason: 'Server stats counters (live channel-name counters)'
            });
            created.push(category);

            const counters = {};
            for (const def of COUNTER_DEFS) {
                const ch = await guild.channels.create({
                    name: buildCounterName(def.type, liveValues[def.type]),
                    type: ChannelType.GuildVoice,
                    parent: category.id,
                    permissionOverwrites: [
                        { id: everyoneId, deny: [PermissionFlagsBits.Connect] }
                    ],
                    reason: `Server stats counter: ${def.label}`
                });
                counters[def.type] = ch.id;
                created.push(ch);
            }

            serverstatsManager.saveConfig({
                guildId: guild.id,
                categoryId: category.id,
                counters,
                enabled: true,
                updatedAt: Date.now()
            });

            await logAudit(interaction.client, {
                action: 'SETUP_SERVER_STATS',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Setup server stats counters — category: ${CATEGORY_NAME}, ${COUNTER_DEFS.length} counter channels (members/bots/boosts/roles/channels)`,
                guildId: guild.id
            });

            const embed = new EmbedBuilder()
                .setTitle('📊 Server Stats — live counters created!')
                .setDescription(
                    'The channel names below are **live counters** — they update automatically when members join/leave, boost, or roles/channels change.'
                )
                .setColor(0x5865f2)
                .addFields(
                    ...COUNTER_DEFS.map(def => ({
                        name: `${def.emoji} ${def.label}`,
                        value: `\`${buildCounterName(def.type, liveValues[def.type])}\``,
                        inline: true
                    }))
                )
                .setFooter({
                    text: 'Counters refresh automatically (rate-limit safe) • /serverstats refresh forces an update now'
                })
                .setTimestamp();
            return safeEditReply(interaction, { embeds: [embed] });
        } catch (err) {
            // Rollback — best effort, must never throw out of the handler.
            for (const ch of created.reverse()) {
                try {
                    await ch.delete('Server stats setup failed — rollback');
                } catch (_) {}
            }
            console.error('Server stats setup failed:', err);
            return safeEditReply(interaction, {
                content:
                    `❌ Setup failed: ${err.message}\n\n` +
                    'Any half-created channels were rolled back. Check the bot\'s **Manage Channels** + **Manage Roles** permissions and try again.'
            });
        }
    }

    // ====================================================
    // === /serverstats remove ===
    // ====================================================
    if (sub === 'remove') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = interaction.guild;

        if (!serverstatsManager.isEnabled()) {
            return safeEditReply(interaction, {
                content: '⚠️ The server stats counters are not set up. Run `/serverstats setup` first.'
            });
        }

        const cfg = serverstatsManager.getConfig();
        let deleted = 0;
        let failed = 0;

        // Best-effort deletion of every counter channel + the category.
        for (const id of Object.values(cfg.counters || {})) {
            const ch = guild.channels.cache.get(id);
            if (!ch) continue; // already gone — clearConfig still runs below
            try {
                await ch.delete('Server stats removal');
                deleted++;
            } catch (err) {
                failed++;
                console.warn(`⚠️ Server stats remove: could not delete channel ${id}: ${err.message}`);
            }
        }
        const category = cfg.categoryId ? guild.channels.cache.get(cfg.categoryId) : null;
        if (category) {
            try {
                await category.delete('Server stats removal');
                deleted++;
            } catch (err) {
                failed++;
                console.warn(`⚠️ Server stats remove: could not delete the category: ${err.message}`);
            }
        }

        serverstatsManager.clearConfig();

        await logAudit(interaction.client, {
            action: 'REMOVE_SERVER_STATS',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Removed server stats counters — ${deleted} channel(s) deleted${failed > 0 ? `, ${failed} failed (delete manually)` : ''}`,
            guildId: guild.id
        });

        const content =
            failed > 0
                ? `✅ Server stats counters removed (${deleted} deleted, ${failed} could not be deleted — please delete those channels manually).\n\nThe config is cleared — run \`/serverstats setup\` to recreate them anytime.`
                : '✅ Server stats counters removed.\n\nThe config is cleared — run `/serverstats setup` to recreate them anytime.';
        return safeEditReply(interaction, { content });
    }

    // ====================================================
    // === /serverstats refresh ===
    // ====================================================
    if (sub === 'refresh') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = interaction.guild;

        if (!serverstatsManager.isEnabled()) {
            return safeEditReply(interaction, {
                content: '⚠️ The server stats counters are not set up. Run `/serverstats setup` first.'
            });
        }

        // force: bypass the cooldown ONCE (admin-invoked, rare — safe within
        // Discord's 2-renames-per-10-min limit).
        const result = await serverstatsManager.refreshServerStats(guild, { force: true });

        const lines = COUNTER_DEFS.map(def => {
            const value = computeCounterValue(guild, def.type);
            return `${def.emoji} ${def.label}: **${value}**`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setTitle('📊 Server Stats — counters refreshed')
            .setDescription(
                `${lines}\n\n` +
                `📤 Updated: **${result.updated}** • ⏳ Deferred by cooldown: **${result.deferred}** • ⚠️ Missing channels: **${result.missing}** • ❌ Errors: **${result.errors}**`
            )
            .setColor(0x57f287)
            .setFooter({
                text: 'Unchanged counters make zero API calls • counters also update automatically on member/boost/role/channel changes'
            })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }
};
