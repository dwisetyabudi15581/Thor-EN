/**
 * Boost Handler — server booster notifications (v3.9.49).
 *
 * Called by:
 *   - src/bot/events/guildMemberUpdate.js (live boost add/remove detection)
 *   - src/commands/stats.js (/boosters list — uses the same embed builders)
 *   - src/commands/config.js + src/bot/events/ready.js (booster role sync, v3.9.59)
 *
 * Logic:
 *   - Boost ADD   (premium_since: null → date): pink celebration embed to the
 *     server-booster channel + a BOOST_ADD entry in the server log.
 *   - Boost REMOVE (premium_since: date → null): gray embed + BOOST_REMOVE
 *     server-log entry.
 *   - BOOSTER AUTO ROLE (v3.9.59): the configured `roles.booster` role is
 *     granted automatically when a boost starts and removed when it ends —
 *     the same semantics as Discord's built-in "Server Booster" role (the
 *     perk tracks the ACTIVE boost, not a permanent badge: a member who
 *     stops paying loses the access). Discord's own role cannot be
 *     customized in order/color, so admins use their own via
 *     `/set-role booster @role`.
 *
 * v3.9.48 diagnosability pattern: every skip reason logs the cause + the fix
 * command, and send failures name the channel + the exact permissions to
 * check. A boost with no notification AND no log line must never happen.
 */

const { EmbedBuilder } = require('discord.js');
const { getConfig } = require('../data/configManager');
const { logServerEvent } = require('../infra/serverLog');

const BOOST_PINK = 0xf472b6;
const BOOST_GRAY = 0x95a5a6;

/**
 * Build the boost-started embed. Pure — no side effects, no send.
 * @param {Object} member - discord.js GuildMember
 */
function buildBoostAddEmbed(member) {
    const { guild, user } = member;
    const tierText =
        guild.premiumTier && guild.premiumTier > 0
            ? `Server Level **${guild.premiumTier}** · ${guild.premiumSubscriptionCount ?? 0} boost(s) total`
            : 'Server Level 0 (boosting toward Level 1!)';
    return new EmbedBuilder()
        .setTitle('🚀 NEW SERVER BOOST!')
        .setDescription(`**${user}** just boosted **${guild.name}**! Thank you for supporting the server 💖`)
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setColor(BOOST_PINK)
        .addFields(
            { name: '👤 Booster', value: `${user} (\`${user.tag}\`)`, inline: true },
            { name: '🚀 Boosting since', value: `<t:${Math.floor((member.premiumSinceTimestamp || Date.now()) / 1000)}:R>`, inline: true },
            { name: '📊 Server', value: tierText, inline: false }
        )
        .setFooter({ text: `${guild.name} — thank you!`, iconURL: guild.iconURL({ dynamic: true }) || undefined })
        .setTimestamp();
}

/**
 * Build the boost-ended embed. Pure — no side effects, no send.
 * @param {Object} member - the member AFTER the change (premiumSinceTimestamp
 *   already null — the handler passes the old streak via `sinceTs`)
 * @param {number|null} sinceTs - the premiumSinceTimestamp BEFORE the removal
 */
function buildBoostRemoveEmbed(member, sinceTs) {
    const { guild, user } = member;
    const since = sinceTs ? `\n\nThey had been boosting since <t:${Math.floor(sinceTs / 1000)}:D>.` : '';
    return new EmbedBuilder()
        .setTitle('💔 BOOST ENDED')
        .setDescription(`**${user}** is no longer boosting **${guild.name}**.${since}`)
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setColor(BOOST_GRAY)
        .addFields({ name: '👤 Booster', value: `${user} (\`${user.tag}\`)`, inline: true })
        .setFooter({ text: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
        .setTimestamp();
}

/**
 * Send the boost notification to the server-booster channel + record it in
 * the server log. Never throws — logs every failure with the fix (v3.9.48
 * silent-failure pattern).
 *
 * @param {Object} member - discord.js GuildMember (after the change)
 * @param {'add'|'remove'} action
 * @param {number|null} [oldSinceTs] - the premiumSinceTimestamp before the change
 */
async function onBoostChange(member, action, oldSinceTs = null) {
    const { guild, user } = member;
    // v3.10.0 multi-guild: booster channel & role from this guild's config.
    const config = getConfig(guild.id);

    // 1. Persist the history first (even if notifications fail, the data stays).
    try {
        const boostManager = require('../data/boostManager');
        if (action === 'add') boostManager.recordBoostStart(guild.id, user.id, member.premiumSinceTimestamp || Date.now());
        else boostManager.recordBoostEnd(guild.id, user.id);
    } catch (err) {
        console.warn(`⚠️ Failed to record the boost ${action} for ${user.tag}:`, err.message);
    }

    // 2. Server log entry (independent channel — the historical record).
    try {
        await logServerEvent(member.client, {
            type: action === 'add' ? 'BOOST_ADD' : 'BOOST_REMOVE',
            guildId: guild.id,
            fields: [
                { name: '👤 Booster', value: `<@${user.id}> (\`${user.tag}\`)`, inline: true },
                {
                    name: action === 'add' ? '🚀 Started' : '💔 Ended',
                    value:
                        action === 'add'
                            ? member.premiumSinceTimestamp
                                ? `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:R>`
                                : 'just now'
                            : oldSinceTs
                              ? `was since <t:${Math.floor(oldSinceTs / 1000)}:R>`
                              : 'unknown start'
                }
            ],
            footer: `User ID: ${user.id}`
        });
    } catch (_) {
        // logServerEvent never throws, but stay defensive.
    }

    // 3. The dedicated server-booster channel (the celebration embed).
    const channelId = config.channels['server-booster'];
    if (!channelId) {
        console.warn(
            `⚠️ ${user.tag} ${action === 'add' ? 'started' : 'stopped'} boosting, but the server-booster channel is NOT set — the boost notification was skipped. ` +
                `Fix: /set-channel server-booster #channel (the server log still records it if set)`
        );
        return;
    }
    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
        console.warn(
            `⚠️ Server-booster channel (ID: ${channelId}) not found — deleted, or the ID belongs to another server. ` +
                `Fix: /set-channel server-booster #channel`
        );
        return;
    }

    const embed = action === 'add' ? buildBoostAddEmbed(member) : buildBoostRemoveEmbed(member, oldSinceTs);

    try {
        const content = action === 'add' ? `<@${user.id}>` : undefined;
        await channel.send({ content, embeds: [embed] });
        console.log(`🚀 Boost ${action} notification sent for ${user.tag} in #${channel.name || channel.id}`);
    } catch (err) {
        console.error(
            `❌ Failed to send the boost ${action} notification in #${channel.name || channel.id}: ${err.message}\n` +
                `   Check the bot's Send Messages + Embed Links permissions in that channel.`
        );
    }
}

/**
 * Build the /boosters list embed. Pure — no side effects, no send.
 * @param {Object} guild - discord.js Guild
 * @param {Array<Object>} boosters - GuildMembers with premiumSinceTimestamp, sorted
 *   by boost date ASCENDING (earliest supporter first — caller sorts)
 * @param {Array<{userId, event, at, boostedAt}>} recentEvents - from boostManager.getRecentEvents
 */
function buildBoostersEmbed(guild, boosters, recentEvents = []) {
    const boostCount = guild.premiumSubscriptionCount ?? boosters.length;
    const tierText =
        guild.premiumTier && guild.premiumTier > 0 ? `Level ${guild.premiumTier}` : 'Level 0 (no boosts yet)';

    // Booster list — cap at 40 lines so the description always fits (4096 limit
    // with ~60 chars/line ≈ 2.400 + headroom; bigger boost rosters are unlikely
    // in community servers, but the guard stays).
    const MAX_LIST = 40;
    const lines = boosters.slice(0, MAX_LIST).map((m, i) => {
        const ts = Math.floor((m.premiumSinceTimestamp || 0) / 1000);
        return `${i + 1}. <@${m.user.id}> — since <t:${ts}:D> (<t:${ts}:R>)`;
    });
    const hidden = boosters.length - MAX_LIST;
    if (hidden > 0) lines.push(`… +${hidden} more booster(s) not shown`);

    const description =
        boosters.length === 0
            ? 'This server has no active boosters right now. 🌱\nBoosting the server unlocks perks for everyone — every boost counts!'
            : `These members are boosting **${guild.name}** right now 💖\n\n${lines.join('\n')}`;

    const recentLines = recentEvents
        .slice(0, 5)
        .map(e => `${e.event === 'add' ? '🚀' : '💔'} <@${e.userId}> — <t:${Math.floor((e.at || 0) / 1000)}:R>`)
        .join('\n');

    const embed = new EmbedBuilder()
        .setTitle(`🚀 SERVER BOOSTERS — ${guild.name}`)
        .setDescription(description)
        .setColor(BOOST_PINK)
        .addFields(
            { name: '📊 Server Level', value: `${tierText} (${boostCount} boost${boostCount === 1 ? '' : 's'})`, inline: true },
            { name: '⭐ Boosters Listed', value: `${boosters.length}`, inline: true }
        )
        .setFooter({ text: 'Booster list = live from Discord • boost history tracked by the bot' })
        .setTimestamp();

    if (recentLines) {
        embed.addFields({ name: '🕘 Recent Boost Activity', value: recentLines.slice(0, 1000) });
    }
    const icon = typeof guild.iconURL === 'function' ? guild.iconURL() : null;
    if (icon) embed.setThumbnail(icon);
    return embed;
}

/**
 * v3.9.59: BOOSTER AUTO ROLE — grant/remove the Booster role following the
 * boost status. Called by guildMemberUpdate.js right after onBoostChange
 * (live events).
 *
 * Semantics = Discord's built-in "Server Booster" role: the role exists WHILE
 * the member boosts. A member who stops boosting loses the role (boost perks
 * end with the subscription — not a permanent badge).
 *
 * Logging note: granting/removing the role fires guildMemberUpdate AGAIN
 * (role-only diff), which is automatically recorded as a ROLE_UPDATE server
 * log entry when server-log is set — no duplicate log entry needed here.
 *
 * Never throws — every failure/skip leaves a cause + fix log line
 * (the v3.9.48 pattern).
 *
 * @param {Object} member - discord.js GuildMember (after the change)
 * @param {'add'|'remove'} action
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
async function applyBoostRole(member, action) {
    try {
        if (!member?.guild?.id || !member.user || member.user.bot) {
            return { ok: false, reason: 'skip' };
        }
        const config = getConfig(member.guild.id);
        const roleId = config.roles && config.roles.booster;
        if (!roleId) {
            // Role not set = the optional feature is off. For a NEW boost leave
            // a hint once per event (the server-booster channel pattern); for
            // remove staying quiet is enough — without config the bot never
            // granted the role in the first place.
            if (action === 'add') {
                console.warn(
                    `⚠️ ${member.user.tag} started boosting, but the Booster role is NOT set — auto-role skipped. ` +
                        `Fix: /set-role booster @role`
                );
            }
            return { ok: false, reason: 'not-set' };
        }
        const role = member.guild.roles.cache.get(roleId);
        if (!role) {
            console.warn(
                `⚠️ Booster role (ID: ${roleId}) not found — deleted, or the ID belongs to another server. ` +
                    `Fix: /set-role booster @role`
            );
            return { ok: false, reason: 'ghost' };
        }
        const has = typeof member.roles?.cache?.has === 'function' ? member.roles.cache.has(roleId) : false;

        if (action === 'add') {
            if (has) return { ok: true, reason: 'already' }; // idempotent
            // Hierarchy pre-check (a clearer message than a raw API error; the
            // catch below still covers roles moving position mid-flight).
            const botPos = member.guild.members?.me?.roles?.highest?.position;
            if (typeof botPos === 'number' && (role.position ?? 0) >= botPos) {
                console.error(
                    `❌ The Booster role (${role.name}) is positioned ABOVE the bot's highest role — the bot cannot assign it to ${member.user.tag}. ` +
                        `Fix: move the Booster role below the bot role (Server Settings → Roles).`
                );
                return { ok: false, reason: 'position' };
            }
            await member.roles.add(role);
            console.log(`🎭 Booster role granted automatically to ${member.user.tag}`);
            return { ok: true, reason: 'added' };
        }

        // action === 'remove'
        if (!has) return { ok: true, reason: 'absent' }; // doesn't have it → no-op
        await member.roles.remove(role);
        console.log(`🎭 Booster role removed automatically from ${member.user.tag} (boost ended)`);
        return { ok: true, reason: 'removed' };
    } catch (err) {
        console.error(
            `❌ Failed to ${action === 'add' ? 'grant' : 'remove'} the Booster role for ${member?.user?.tag}: ${err.message}\n` +
                `   Check the bot's Manage Roles permission + the Booster role position BELOW the bot's highest role.`
        );
        return { ok: false, reason: 'error' };
    }
}

/**
 * v3.9.59: STATE sync of the Booster role (not event-based) — used by:
 *   - ready.js after reconcileBoosters: boosts that started/ended while the
 *     bot was offline still get/lose the role;
 *   - /set-role booster: retroactive application to the boosters that
 *     ALREADY exist.
 *
 * Safety rules:
 *   - EVERY member currently boosting but missing the role → GRANTED
 *     (covers offline boosts AND live assignments that once failed — e.g. the
 *     role was above the bot and got fixed since).
 *   - userIds in `removedUserIds` (boost ended while offline) still in the
 *     cache and holding the role → REMOVED.
 *   - REGULAR members who happen to hold the role (granted manually by an
 *     admin) are NEVER touched — the sync must not destroy manual grants.
 *
 * @param {Object} guild - discord.js Guild (members.cache should be fetched first)
 * @param {string[]} [removedUserIds=[]] - from boostManager.reconcileBoosters().removed
 * @returns {Promise<{applied: number, removed: number}>}
 */
async function syncBoostRoles(guild, removedUserIds = []) {
    const out = { applied: 0, removed: 0 };
    if (!guild?.id || !guild.members?.cache) return out;

    // v3.10.0 multi-guild: the booster role is read from this guild's config.
    const config = getConfig(guild.id);
    const roleId = config.roles && config.roles.booster;
    if (!roleId) return out; // feature off — silent no-op
    const role = guild.roles.cache?.get?.(roleId);
    if (!role) {
        console.warn(
            `⚠️ Booster role sync: role (ID: ${roleId}) not found — deleted, or the ID belongs to another server. ` +
                `Fix: /set-role booster @role`
        );
        return out;
    }

    // (1) Every live booster missing the role → grant it.
    for (const m of guild.members.cache.values()) {
        if (!m || m.user?.bot) continue;
        if (!m.premiumSinceTimestamp) continue;
        const has = typeof m.roles?.cache?.has === 'function' ? m.roles.cache.has(roleId) : false;
        if (!has) {
            const res = await applyBoostRole(m, 'add');
            if (res.ok) out.applied += 1;
        }
    }

    // (2) Boosts that ended while offline (still on the server) → remove the role.
    for (const uid of removedUserIds || []) {
        const m = guild.members.cache.get(uid);
        if (!m) continue; // already left — roles vanish with membership anyway
        const has = typeof m.roles?.cache?.has === 'function' ? m.roles.cache.has(roleId) : false;
        if (has) {
            const res = await applyBoostRole(m, 'remove');
            if (res.ok) out.removed += 1;
        }
    }

    return out;
}

module.exports = {
    onBoostChange,
    buildBoostAddEmbed,
    buildBoostRemoveEmbed,
    buildBoostersEmbed,
    applyBoostRole,
    syncBoostRoles,
    BOOST_PINK,
    BOOST_GRAY
};
