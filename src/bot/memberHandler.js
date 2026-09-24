/**
 * Member Handler — welcome/goodbye + the Unverified role on join.
 *
 * Called by:
 *   - src/bot/events/guildMemberAdd.js
 *   - src/bot/events/guildMemberRemove.js
 *   - src/commands/config.js (/test-welcome preview, v3.9.48)
 *
 * Logic:
 *   - onMemberAdd: grant the Unverified role (config.roles.unverified — the
 *     classic CHRONOS marker, restored in v4.3.0 with the auto-role deletion)
 *     via the Role Engine + send a welcome embed to the welcome channel.
 *   - onMemberRemove: check the audit log (kick/ban vs voluntary leave) + send a goodbye embed.
 *
 * v4.3.0: the /set-autorole join list + the removeOnNewRole toggle were
 * DELETED (owner's request — CHRONOS parity). The marker is again ONE role:
 * set it with `/set-role tipe:unverified`, it disappears automatically when
 * the member verifies (btn_verify / the verify panel's button).
 *
 * v3.9.0 FIX: skip bot accounts.
 * v3.9.8 FIX: AuditLogEvent enum (not magic number 20/22), 10s window (was 5s),
 *   separate fetchAuditLogs for kick & ban (more accurate, less data).
 * v3.9.48 FIX (user report: "welcome doesn't appear"): the embed builders are
 *   extracted (buildWelcomeEmbed / buildGoodbyeEmbed) so /test-welcome previews
 *   the EXACT same embed as the live event — and every silent failure now logs
 *   an actionable hint. Previously, when channels.welcome was not set, a member
 *   joined with NO welcome and NO log line at all — the admin had zero clues.
 */

const { EmbedBuilder, AuditLogEvent } = require('discord.js');
const { getConfig, fillTemplate } = require('../data/configManager');
// v3.22.0: the Role Engine — single gateway for every role grant/revoke.
const { grantRoles } = require('../services/roleEngine');

/**
 * Template variables for the welcome/goodbye embeds (v3.9.48 — shared by the
 * live event AND the /test-welcome preview so both stay identical).
 */
function memberVars(member, action = 'left') {
    const { guild, user } = member;
    return {
        user: `<@${user.id}>`,
        username: user.tag,
        server: guild.name,
        count: guild.memberCount,
        action
    };
}

/**
 * Build the welcome embed (v3.9.48). Pure — no side effects, no send.
 * Used by onMemberAdd (live) and /test-welcome (preview).
 */
function buildWelcomeEmbed(member, config) {
    const { guild, user } = member;
    const vars = memberVars(member);
    return new EmbedBuilder()
        .setTitle(fillTemplate(config.messages.welcomeTitle, vars))
        .setDescription(fillTemplate(config.messages.welcomeBody, vars))
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setColor(0x2ecc71)
        .setFooter({ text: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
        .setTimestamp();
}

/**
 * Build the goodbye embed (v3.9.48). Pure — no side effects, no send.
 * `action` = 'left' | 'kicked' | 'banned' (the live event detects it via the
 * audit log; the /test-welcome preview uses 'left').
 */
function buildGoodbyeEmbed(member, config, action = 'left') {
    const { guild, user } = member;
    const vars = memberVars(member, action);
    return new EmbedBuilder()
        .setTitle(fillTemplate(config.messages.goodbyeTitle, vars))
        .setDescription(fillTemplate(config.messages.goodbyeBody, vars))
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setColor(0xe74c3c)
        .setFooter({ text: guild.name, iconURL: guild.iconURL({ dynamic: true }) || undefined })
        .setTimestamp();
}

async function onMemberAdd(member) {
    const { guild, user } = member;

    if (user.bot) return;

    const config = getConfig(guild.id);

    try {
        const { recordJoin } = require('../data/statsManager');
        recordJoin(guild.id, user.id);
    } catch (_) {}

    // v4.3.0: the classic CHRONOS marker — the Unverified role
    // (config.roles.unverified) is granted in ONE engine call. Hierarchy /
    // managed / @everyone checks and actionable failure logs live in the
    // engine, so this handler stays tiny. The role is removed automatically
    // by the verify click (btn_verify handler / the verify panel's button).
    const unverifiedId = config.roles?.unverified;
    if (unverifiedId) {
        const res = await grantRoles(member, [unverifiedId], { reason: 'unverified role on join (until verification)' });
        if (res.granted.length > 0) {
            console.log(`🎭 Unverified role granted to ${user.tag} (until they verify).`);
        }
    }

    // v3.9.48: silent-failure fix — "welcome doesn't appear" with NO log line
    // was the #1 unexplainable support report. Every skip reason now says why
    // + the exact command to fix it. (The send error path already logged.)
    const welcomeId = config.channels.welcome;
    if (!welcomeId) {
        console.warn(
            `⚠️ ${user.tag} joined, but the welcome channel is NOT set — the welcome message was skipped silently. ` +
                `Fix: /set-channel welcome #channel`
        );
        return;
    }
    const welcomeChannel = guild.channels.cache.get(welcomeId);
    if (!welcomeChannel) {
        console.warn(
            `⚠️ Welcome channel (ID: ${welcomeId}) not found — deleted, or the ID belongs to another server. ` +
                `Fix: /set-channel welcome #channel`
        );
        return;
    }

    const embed = buildWelcomeEmbed(member, config);

    try {
        await welcomeChannel.send({ content: `<@${user.id}>`, embeds: [embed] });
        console.log(`👋 Welcome sent for ${user.tag} in #${welcomeChannel.name || welcomeChannel.id}`);
    } catch (err) {
        console.error(
            `❌ Failed to send welcome message in #${welcomeChannel.name || welcomeChannel.id}: ${err.message}\n` +
                `   Check the bot's Send Messages + Embed Links permissions in that channel. `
        );
    }
}

async function onMemberRemove(member) {
    const { guild, user } = member;

    if (user.bot) return;

    const config = getConfig(guild.id);

    // v3.9.48: silent-failure fix (same pattern as the welcome above) — a leave
    // with no goodbye AND no log line left the admin guessing.
    if (!config.channels.goodbye) {
        console.warn(
            `⚠️ ${user.tag} left, but the goodbye channel is NOT set — the goodbye message was skipped silently. ` +
                `Fix: /set-channel goodbye #channel`
        );
        return;
    }
    const goodbyeChannel = guild.channels.cache.get(config.channels.goodbye);
    if (!goodbyeChannel) {
        console.warn(
            `⚠️ Goodbye channel (ID: ${config.channels.goodbye}) not found — deleted, or the ID belongs to another server. ` +
                `Fix: /set-channel goodbye #channel`
        );
        return;
    }

    let action = 'left';
    const AUDIT_WINDOW_MS = 10 * 1000;
    try {
        const audits = await guild.fetchAuditLogs({
            type: AuditLogEvent.MemberKick,
            limit: 5
        });
        const kickEntry = audits.entries.find(
            e => e.target?.id === user.id && Date.now() - e.createdTimestamp < AUDIT_WINDOW_MS
        );
        if (kickEntry) {
            action = 'kicked';
        } else {
            const banAudits = await guild.fetchAuditLogs({
                type: AuditLogEvent.MemberBanAdd,
                limit: 5
            });
            const banEntry = banAudits.entries.find(
                e => e.target?.id === user.id && Date.now() - e.createdTimestamp < AUDIT_WINDOW_MS
            );
            if (banEntry) {
                action = 'banned';
            }
        }
    } catch (err) {
        console.warn(
            `⚠️ Could not access the audit log for <@${user.id}>'s goodbye message: ${err.message?.slice(0, 80)}. ` +
                `Make sure the bot has the View Audit Log permission.`
        );
    }

    const embed = buildGoodbyeEmbed(member, config, action);

    try {
        await goodbyeChannel.send({ embeds: [embed] });
        console.log(`👋 Goodbye sent for ${user.tag} in #${goodbyeChannel.name || goodbyeChannel.id}`);
    } catch (err) {
        console.error(
            `❌ Failed to send goodbye message in #${goodbyeChannel.name || goodbyeChannel.id}: ${err.message}\n` +
                `   Check the bot's Send Messages + Embed Links permissions in that channel. `
        );
    }
}

module.exports = { onMemberAdd, onMemberRemove, buildWelcomeEmbed, buildGoodbyeEmbed };
