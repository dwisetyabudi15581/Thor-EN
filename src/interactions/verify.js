/**
 * Verify domain handler — tombol `btn_verify`.
 *
 * Di-ekstrak dari handlers/interactionHandler.js (v3.9.9 refactor).
 * Behavior dipertahankan apa adanya — hanya pindah file.
 *
 * Router (src/interactions/index.js) sudah apply:
 *   - dedup (checkAndMark)
 *   - guard `replied/deferred`
 *   - cek tipe interaction (button/select/modal)
 *   - routing by customId prefix
 * Jadi domain handler fokus ke logic-nya saja.
 */

const { MessageFlags } = require('discord.js');
const { getConfig } = require('../commands/_shared');

module.exports = async function (interaction) {
    // Router memanggil handler ini HANYA untuk customId === 'btn_verify'.
    const config = getConfig();

    if (!config.roles.verified) {
        return interaction.reply({
            content: '❌ Role Verified belum di-set. Minta admin jalankan `/set-role verified @role`.',
            flags: MessageFlags.Ephemeral
        });
    }
    // v3.9.17 FIX: guard member.roles akses (partial member / user leave saat klik).
    if (!interaction.member?.roles?.cache) {
        return interaction.reply({
            content: '❌ Data member tidak lengkap. Coba lagi sebentar.',
            flags: MessageFlags.Ephemeral
        });
    }
    if (interaction.member.roles.cache.has(config.roles.verified)) {
        return interaction.reply({ content: '✅ Kamu sudah terverifikasi!', flags: MessageFlags.Ephemeral });
    }
    try {
        await interaction.member.roles.add(config.roles.verified);
    } catch (err) {
        console.error('Gagal add role verified:', err.message);
        return interaction.reply({
            content: '❌ Bot tidak bisa memberi role Verified. Pastikan role bot ada di ATAS role Verified.',
            flags: MessageFlags.Ephemeral
        });
    }
    // v3.9.17 FIX: track apakah unverified role berhasil dihapus. Sebelumnya,
    // pesan selalu bilang "role Unverified telah dihapus" padahal bisa gagal.
    let unverifiedRemoved = false;
    let unverifiedNote = '';
    if (config.roles.unverified) {
        try {
            await interaction.member.roles.remove(config.roles.unverified);
            unverifiedRemoved = true;
        } catch (err) {
            console.error('Gagal hapus role unverified:', err.message);
            unverifiedNote =
                '\n⚠️ Bot tidak bisa menghapus role Unverified. Pastikan role bot ada di ATAS role Unverified. Hubungi admin untuk hapus manual.';
        }
    } else {
        // unverified role belum di-set di config — bukan error, tapi pesan jangan bilang "dihapus".
        unverifiedNote = '\nℹ️ Role Unverified belum di-set di config — hanya role Verified yang diberikan.';
    }
    return interaction.reply({
        content:
            '✅ Verifikasi berhasil! Role Verified telah diberikan.' +
            (config.roles.unverified
                ? unverifiedRemoved
                    ? ' Role Unverified telah dihapus.'
                    : unverifiedNote
                : unverifiedNote),
        flags: MessageFlags.Ephemeral
    });
};
