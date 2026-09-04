const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

/**
 * Helper for rendering self-role panels:
 * - Embed (title, description, footer = panel ID + mode)
 * - Components: buttons (≤25) or a select menu (1, ≤25 options)
 *
 * Custom ID format:
 * - Button: sr_btn:<panelId>:<roleId>
 * - Select : sr_sel:<panelId>
 *
 * v3.9.11 Phase 3: per-role button style (Primary/Secondary/Success/Danger).
 * v3.9.11 Phase 3: conditional role (requiresRoleId) — the role is hidden from
 *   users who don't have requiresRoleId yet. The filter is done in the interaction handler,
 *   not here (because the builder has no user context).
 */

const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5; // Discord limit: 5 ActionRows per message
const MAX_BUTTONS = MAX_BUTTONS_PER_ROW * MAX_ROWS; // 25

// v3.9.11 Phase 3: map style string → ButtonStyle enum
const STYLE_MAP = {
    Primary: ButtonStyle.Primary,
    Secondary: ButtonStyle.Secondary,
    Success: ButtonStyle.Success,
    Danger: ButtonStyle.Danger
};

function buildPanelEmbed(panel, client) {
    const modeText = panel.exclusive
        ? '🔒 **Exclusive mode** — you may only hold 1 role at a time.'
        : '✅ **Multi mode** — you may take more than 1 role.';

    const rolesText =
        panel.roles.length === 0
            ? '_No roles yet. Admins can add them via `/selfrole-add`._'
            : panel.roles
                  .map(r => {
                      const emojiStr = r.emoji ? `${r.emoji} ` : '';
                      const descStr = r.description ? ` — ${r.description}` : '';
                      // v3.9.11 Phase 3: show a badge if the role requires a prerequisite
                      const reqStr = r.requiresRoleId ? ` _(requires <@&${r.requiresRoleId}>)_` : '';
                      return `• ${emojiStr}**${r.label}** <@&${r.roleId}>${descStr}${reqStr}`;
                  })
                  .join('\n');

    // Discord embed description limit is 4096 chars. If a panel has 25 roles with
    // long labels/descriptions, the total description can exceed the limit → Discord rejects it.
    // Truncate to stay within the limit, with a "+N more" indicator.
    // v3.9.17 FIX: count the roles that are ACTUALLY displayed, not the total role count.
    // Previously, the message said "+25 more" even though maybe 15 were already displayed.
    const MAX_DESC = 4000; // 96 char margin
    const header = `${panel.description}\n\n${modeText}\n\n**Available roles:**\n`;
    let fullDesc;
    if (header.length + rolesText.length > MAX_DESC) {
        const remaining = MAX_DESC - header.length - 50;
        const truncated = rolesText.slice(0, Math.max(0, remaining));
        // Count how many roles actually got displayed (count bullet points)
        const displayedCount = (truncated.match(/^• /gm) || []).length;
        const hiddenCount = Math.max(0, panel.roles.length - displayedCount);
        fullDesc = header + truncated + `\n... +${hiddenCount} more (see /selfrole-list)`;
    } else {
        fullDesc = header + rolesText;
    }

    const embed = new EmbedBuilder()
        .setTitle(panel.title)
        .setDescription(fullDesc)
        .setColor(0x9b59b6)
        .setFooter({
            text: `${client?.user?.username || 'Bot'} • Panel ID: ${panel.id} • ${panel.exclusive ? 'Exclusive' : 'Multi'}`,
            iconURL: client?.user?.displayAvatarURL?.({ dynamic: true })
        })
        .setTimestamp();

    return embed;
}

/**
 * Build the ActionRow[] for a panel.
 * - Type "button": max 25 buttons (5 rows × 5 buttons). If 0 roles → return [] (embed-only panel).
 * - Type "select": 1 StringSelectMenu with max 25 options.
 *
 * For exclusive mode + select, set minValues=1, maxValues=1.
 * For multi mode + select, set minValues=0, maxValues=roles.length.
 *
 * v3.9.11 Phase 3: uses per-role style (defaults to Secondary if not set).
 */
function buildPanelComponents(panel) {
    if (panel.roles.length === 0) return [];

    if (panel.type === 'select') {
        const select = new StringSelectMenuBuilder()
            .setCustomId(`sr_sel:${panel.id}`)
            .setPlaceholder('Select a role...')
            .setMinValues(0)
            .setMaxValues(panel.exclusive ? 1 : Math.min(panel.roles.length, 25))
            .addOptions(
                panel.roles.map(r => ({
                    label: r.label,
                    value: r.roleId,
                    ...(r.emoji ? { emoji: r.emoji } : {}),
                    ...(r.description ? { description: r.description } : {})
                }))
            );
        return [new ActionRowBuilder().addComponents(select)];
    }

    // Button type
    const rows = [];
    const total = Math.min(panel.roles.length, MAX_BUTTONS);
    for (let i = 0; i < total; i += MAX_BUTTONS_PER_ROW) {
        const row = new ActionRowBuilder();
        for (let j = i; j < Math.min(i + MAX_BUTTONS_PER_ROW, total); j++) {
            const r = panel.roles[j];
            // v3.9.11 Phase 3: use per-role style, default Secondary
            const btnStyle = STYLE_MAP[r.style] || ButtonStyle.Secondary;
            const btn = new ButtonBuilder()
                .setCustomId(`sr_btn:${panel.id}:${r.roleId}`)
                .setLabel(r.label)
                .setStyle(btnStyle);
            if (r.emoji) {
                try {
                    btn.setEmoji(r.emoji);
                } catch (_) {
                    /* invalid emoji, skip */
                }
            }
            row.addComponents(btn);
        }
        rows.push(row);
    }
    return rows;
}

module.exports = { buildPanelEmbed, buildPanelComponents, STYLE_MAP };
