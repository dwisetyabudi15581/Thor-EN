/**
 * Self-role domain handler — button `sr_btn:*` & select menu `sr_sel:*`.
 *
 * Di-ekstrak dari handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior dipertahankan apa adanya — hanya pindah file.
 *
 * Helper `handleSelfRoleButton` dan `handleSelfRoleSelect` jadi LOCAL function
 * di file ini (sebelumnya function-level di module lama).
 *
 * Router (src/interactions/index.js) sudah apply:
 *   - dedup (checkAndMark)
 *   - guard `replied/deferred`
 *   - cek tipe interaction (button/select/modal)
 *   - routing by customId prefix (sr_btn: / sr_sel:)
 * Jadi domain handler fokus ke logic-nya saja.
 */

const { MessageFlags } = require('discord.js');
const { getPanel, buildPanelComponents } = require('../commands/_shared');

module.exports = async function (interaction) {
    // ====================================================
    // === SELF-ROLE: BUTTON CLICK ===
    // ====================================================
    if (interaction.isButton() && interaction.customId.startsWith('sr_btn:')) {
        return handleSelfRoleButton(interaction);
    }

    // ====================================================
    // === SELF-ROLE: SELECT MENU ===
    // ====================================================
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sr_sel:')) {
        return handleSelfRoleSelect(interaction);
    }
};

// ====================================================
// === HELPER: SELF-ROLE BUTTON HANDLER ===
// ====================================================
async function handleSelfRoleButton(interaction) {
    const parts = interaction.customId.split(':');
    const panelId = parts[1];
    const roleId = parts[2];
    const panel = getPanel(panelId);
    if (!panel) {
        return interaction.reply({ content: '❌ Panel self-role sudah tidak ada.', flags: MessageFlags.Ephemeral });
    }
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
        return interaction.reply({ content: '❌ Role tidak ditemukan di server.', flags: MessageFlags.Ephemeral });
    }

    // v3.9.24 FIX: pastikan roleId benar-benar anggota panel ini. Sebelumnya
    // customId forged/legacy (sr_btn:<panel>:<roleLain>) bisa toggle role guild
    // apa pun selama role-nya ada — padahal role itu tidak pernah ditawarkan
    // panel (bot butuh role hierarchy, tapi tetap lubang yang tidak perlu).
    if (!panel.roles.some(r => r.roleId === roleId)) {
        return interaction.reply({
            content: '❌ Role ini tidak terdaftar di panel self-role tersebut.',
            flags: MessageFlags.Ephemeral
        });
    }

    // v3.9.11 Phase 3: conditional role check.
    // Kalau role punya requiresRoleId, user harus sudah punya role itu untuk bisa ambil.
    const roleConfig = panel.roles.find(r => r.roleId === roleId);
    if (roleConfig?.requiresRoleId) {
        const member = interaction.member;
        if (!member.roles.cache.has(roleConfig.requiresRoleId)) {
            const reqRole = interaction.guild.roles.cache.get(roleConfig.requiresRoleId);
            const reqName = reqRole ? reqRole.name : `<@&${roleConfig.requiresRoleId}>`;
            return interaction.reply({
                content:
                    `❌ Kamu butuh role **${reqName}** untuk bisa mengambil role ini.\n\n` +
                    `💡 Ambil role ${reqName} dulu lewat panel self-role yang sesuai.`,
                flags: MessageFlags.Ephemeral
            });
        }
    }

    const member = interaction.member;
    const hasRole = member.roles.cache.has(roleId);

    try {
        if (panel.exclusive && !hasRole) {
            // Mode exclusive: hapus semua role panel lain dulu, lalu tambahkan yang ini
            const toRemove = panel.roles
                .map(r => r.roleId)
                .filter(rid => rid !== roleId && member.roles.cache.has(rid));
            if (toRemove.length > 0) {
                await member.roles.remove(toRemove);
            }
            await member.roles.add(roleId);
            const removedMentions = toRemove.map(rid => `<@&${rid}>`).join(', ');
            return interaction.reply({
                content: `✅ Role ${role} ditambahkan.${toRemove.length > 0 ? `\n↳ Role lain dihapus: ${removedMentions}` : ''}`,
                flags: MessageFlags.Ephemeral
            });
        } else if (panel.exclusive && hasRole) {
            // Exclusive + sudah punya → lepas
            await member.roles.remove(roleId);
            return interaction.reply({ content: `✅ Role ${role} dilepas.`, flags: MessageFlags.Ephemeral });
        } else if (!panel.exclusive && !hasRole) {
            // Multi + belum punya → tambah
            await member.roles.add(roleId);
            return interaction.reply({ content: `✅ Role ${role} ditambahkan.`, flags: MessageFlags.Ephemeral });
        } else {
            // Multi + sudah punya → lepas (toggle)
            await member.roles.remove(roleId);
            return interaction.reply({ content: `✅ Role ${role} dilepas.`, flags: MessageFlags.Ephemeral });
        }
    } catch (err) {
        console.error('Self-role button error:', err.message);
        return interaction.reply({
            content: `❌ Gagal mengubah role. Pastikan role bot ada di ATAS role ${role}.`,
            flags: MessageFlags.Ephemeral
        });
    }
}

// ====================================================
// === HELPER: SELF-ROLE SELECT MENU HANDLER ===
// ====================================================
async function handleSelfRoleSelect(interaction) {
    const parts = interaction.customId.split(':');
    const panelId = parts[1];
    const panel = getPanel(panelId);
    if (!panel) {
        return interaction.reply({ content: '❌ Panel self-role sudah tidak ada.', flags: MessageFlags.Ephemeral });
    }

    const member = interaction.member;
    const selectedIds = new Set(interaction.values); // role IDs yang dipilih user
    const panelRoleIds = panel.roles.map(r => r.roleId);

    // === v3.9.0 FIX: Implementasi mode EXCLUSIVE yang sebelumnya missing ===
    // Mode exclusive: user hanya boleh punya 1 role dari panel pada satu waktu.
    // Behavior:
    //   - Kalau user pilih 1 role (atau lebih — Discord memungkinkan multi-select):
    //     * Ambil role pertama yang dipilih sebagai "role aktif".
    //     * Remove semua role panel lain yang sudah dimiliki user.
    //     * Add role yang dipilih.
    //   - Kalau user pilih 0 role (clear selection):
    //     * Remove semua role panel yang dimiliki.
    if (panel.exclusive) {
        const targetRoleId =
            selectedIds.size > 0
                ? interaction.values[0] // role pertama yang dipilih
                : null;

        const toRemoveExclusive = panelRoleIds.filter(rid => rid !== targetRoleId && member.roles.cache.has(rid));
        const toAddExclusive = targetRoleId && !member.roles.cache.has(targetRoleId) ? [targetRoleId] : [];

        try {
            if (toRemoveExclusive.length > 0) await member.roles.remove(toRemoveExclusive);
            if (toAddExclusive.length > 0) await member.roles.add(toAddExclusive);
        } catch (err) {
            console.error('Self-role select (exclusive) error:', err.message);
            return interaction.reply({
                content: `❌ Gagal mengubah role. Pastikan role bot ada di ATAS role yang dipilih.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const action = targetRoleId
            ? `**Ditambahkan:** <@&${targetRoleId}>${toRemoveExclusive.length > 0 ? `\n**Dilepas (karena mode exclusive):** ${toRemoveExclusive.map(rid => `<@&${rid}>`).join(', ')}` : ''}`
            : `**Dilepas:** ${toRemoveExclusive.length > 0 ? toRemoveExclusive.map(rid => `<@&${rid}>`).join(', ') : '(tidak ada)'}`;

        await interaction.reply({
            content: `✅ Role diperbarui (mode exclusive).\n${action}`,
            flags: MessageFlags.Ephemeral
        });

        // Update select menu supaya pilihan ter-sync dengan role yang sekarang dimiliki
        try {
            const newComponents = buildPanelComponents(panel);
            if (newComponents.length > 0) {
                await interaction.message.edit({ components: newComponents });
            }
        } catch (err) {
            console.warn('Gagal update select menu setelah pilih (exclusive):', err.message);
        }
        return;
    }

    // === Mode MULTI (default) — logic lama ===
    // v3.9.11 Phase 3: filter out roles yang user gak qualified (requiresRoleId).
    // Kalau user pilih role yang butuh prerequisite tapi belum punya, skip & warn.
    const skippedForPrereq = [];
    const qualifiedSelectedIds = new Set();
    for (const selId of selectedIds) {
        const rConfig = panel.roles.find(r => r.roleId === selId);
        if (rConfig?.requiresRoleId && !member.roles.cache.has(rConfig.requiresRoleId)) {
            skippedForPrereq.push(selId);
        } else {
            qualifiedSelectedIds.add(selId);
        }
    }

    const toAdd = panelRoleIds.filter(rid => qualifiedSelectedIds.has(rid) && !member.roles.cache.has(rid));
    const toRemove = panelRoleIds.filter(rid => !qualifiedSelectedIds.has(rid) && member.roles.cache.has(rid));

    try {
        if (toRemove.length > 0) await member.roles.remove(toRemove);
        if (toAdd.length > 0) await member.roles.add(toAdd);
    } catch (err) {
        console.error('Self-role select error:', err.message);
        return interaction.reply({
            content: `❌ Gagal mengubah role. Pastikan role bot ada di ATAS role yang dipilih.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const addedMentions = toAdd.map(rid => `<@&${rid}>`).join(', ') || '(tidak ada)';
    const removedMentions = toRemove.map(rid => `<@&${rid}>`).join(', ') || '(tidak ada)';

    await interaction.reply({
        content: `✅ Role diperbarui.\n**Ditambahkan:** ${addedMentions}\n**Dilepas:** ${removedMentions}`,
        flags: MessageFlags.Ephemeral
    });

    // Update select menu supaya pilihan ter-sync dengan role yang sekarang dimiliki
    try {
        const newComponents = buildPanelComponents(panel);
        if (newComponents.length > 0) {
            await interaction.message.edit({ components: newComponents });
        }
    } catch (err) {
        console.warn('Gagal update select menu setelah pilih:', err.message);
    }
}
