const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

/**
 * Helper untuk render panel self-role:
 * - Embed (title, description, footer = panel ID + mode)
 * - Komponen: tombol (≤25) atau select menu (1, ≤25 option)
 *
 * Custom ID format:
 * - Button: sr_btn:<panelId>:<roleId>
 * - Select : sr_sel:<panelId>
 *
 * v3.9.11 Phase 3: per-role button style (Primary/Secondary/Success/Danger).
 * v3.9.11 Phase 3: conditional role (requiresRoleId) — role disembunyikan dari
 *   user yang belum punya requiresRoleId. Filter dilakukan di interaction handler,
 *   bukan di sini (karena builder tidak punya context user).
 */

const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5; // batas Discord: 5 ActionRow per message
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
        ? '🔒 **Mode eksklusif** — hanya boleh 1 role pada satu waktu.'
        : '✅ **Mode multi** — boleh ambil lebih dari 1 role.';

    const rolesText =
        panel.roles.length === 0
            ? '_Belum ada role. Admin bisa tambah via `/selfrole-add`._'
            : panel.roles
                  .map(r => {
                      const emojiStr = r.emoji ? `${r.emoji} ` : '';
                      const descStr = r.description ? ` — ${r.description}` : '';
                      // v3.9.11 Phase 3: tampilkan badge kalau role butuh prerequisite
                      const reqStr = r.requiresRoleId ? ` _(butuh <@&${r.requiresRoleId}>)_` : '';
                      return `• ${emojiStr}**${r.label}** <@&${r.roleId}>${descStr}${reqStr}`;
                  })
                  .join('\n');

    // Discord embed description limit 4096 char. Kalau panel punya 25 role dengan
    // label/description panjang, total description bisa exceed limit → Discord reject.
    // Truncate supaya tetap dalam batas, dengan indikator "+N lainnya".
    // v3.9.17 FIX: hitung jumlah role yang BENAR-BENAR ditampilkan, bukan total role.
    // Sebelumnya, pesan bilang "+25 lainnya" padahal mungkin 15 sudah ditampilkan.
    const MAX_DESC = 4000; // 96 char margin
    const header = `${panel.description}\n\n${modeText}\n\n**Role tersedia:**\n`;
    let fullDesc;
    if (header.length + rolesText.length > MAX_DESC) {
        const remaining = MAX_DESC - header.length - 50;
        const truncated = rolesText.slice(0, Math.max(0, remaining));
        // Hitung berapa role yang berhasil ditampilkan (count bullet points)
        const displayedCount = (truncated.match(/^• /gm) || []).length;
        const hiddenCount = Math.max(0, panel.roles.length - displayedCount);
        fullDesc = header + truncated + `\n... +${hiddenCount} lainnya (lihat via /selfrole-list)`;
    } else {
        fullDesc = header + rolesText;
    }

    const embed = new EmbedBuilder()
        .setTitle(panel.title)
        .setDescription(fullDesc)
        .setColor(0x9b59b6)
        .setFooter({
            text: `${client?.user?.username || 'Bot'} • Panel ID: ${panel.id} • ${panel.exclusive ? 'Eksklusif' : 'Multi'}`,
            iconURL: client?.user?.displayAvatarURL?.({ dynamic: true })
        })
        .setTimestamp();

    return embed;
}

/**
 * Bangun ActionRow[] untuk panel.
 * - Type "button": maksimal 25 button (5 row × 5 button). Kalau 0 role → return [] (panel embed aja).
 * - Type "select": 1 StringSelectMenu dengan maksimal 25 option.
 *
 * Untuk mode exclusive + select, set minValues=1, maxValues=1.
 * Untuk mode multi + select, set minValues=0, maxValues=roles.length.
 *
 * v3.9.11 Phase 3: pakai per-role style (default Secondary kalau gak di-set).
 */
function buildPanelComponents(panel) {
    if (panel.roles.length === 0) return [];

    if (panel.type === 'select') {
        const select = new StringSelectMenuBuilder()
            .setCustomId(`sr_sel:${panel.id}`)
            .setPlaceholder('Pilih role...')
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

    // Type button
    const rows = [];
    const total = Math.min(panel.roles.length, MAX_BUTTONS);
    for (let i = 0; i < total; i += MAX_BUTTONS_PER_ROW) {
        const row = new ActionRowBuilder();
        for (let j = i; j < Math.min(i + MAX_BUTTONS_PER_ROW, total); j++) {
            const r = panel.roles[j];
            // v3.9.11 Phase 3: pakai per-role style, default Secondary
            const btnStyle = STYLE_MAP[r.style] || ButtonStyle.Secondary;
            const btn = new ButtonBuilder()
                .setCustomId(`sr_btn:${panel.id}:${r.roleId}`)
                .setLabel(r.label)
                .setStyle(btnStyle);
            if (r.emoji) {
                try {
                    btn.setEmoji(r.emoji);
                } catch (_) {
                    /* emoji invalid, skip */
                }
            }
            row.addComponents(btn);
        }
        rows.push(row);
    }
    return rows;
}

module.exports = { buildPanelEmbed, buildPanelComponents, STYLE_MAP };
