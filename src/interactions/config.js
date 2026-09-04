/**
 * Config interaction domain handler — modal submit untuk /edit-message.
 *
 * v3.9.12: Handle modal_edit_message:<tipe> — modal editor untuk message config.
 * Admin pakai /edit-message untuk buka modal (textarea multi-line),
 * lalu submit → handler ini apply perubahan ke config.messages[tipe].
 *
 * CustomId: modal_edit_message:<tipe>
 * tipe: welcomeTitle, welcomeBody, goodbyeTitle, goodbyeBody,
 *       verifyTitle, verifyBody, ticketTitle, ticketBody, ticketPriceHeader
 */

const { MessageFlags } = require('discord.js');
const {
    getConfig,
    setField,
    logAudit,
    EMBED_LIMITS
} = require('../commands/_shared');

const VALID_TYPES = new Set([
    'welcomeTitle',
    'welcomeBody',
    'goodbyeTitle',
    'goodbyeBody',
    'verifyTitle',
    'verifyBody',
    'ticketTitle',
    'ticketBody',
    'ticketPriceHeader'
]);

module.exports = async function (interaction) {
    // === MODAL: edit_message:<tipe> ===
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_edit_message:')) {
        // Bungkus seluruh body dalam try/catch.
        // Kalau setField atau logAudit throw (disk error / permission),
        // balas error jelas ke admin — jangan biarin error propagate ke top-level handler.
        try {
            const tipe = interaction.customId.split(':')[1];

            // Validate tipe (defense-in-depth — admin bisa attempt customId manipulation)
            if (!VALID_TYPES.has(tipe)) {
                return interaction.reply({
                    content: `❌ Tipe pesan \`${tipe}\` tidak valid.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const newText = interaction.fields.getTextInputValue('message_text');
            if (!newText || newText.trim().length === 0) {
                return interaction.reply({
                    content: '❌ Teks tidak boleh kosong.',
                    flags: MessageFlags.Ephemeral
                });
            }

            // Validate length
            const isTitle = tipe.endsWith('Title');
            const limit = isTitle ? EMBED_LIMITS.TITLE : EMBED_LIMITS.DESCRIPTION;
            if (newText.length > limit) {
                return interaction.reply({
                    content: `❌ Teks terlalu panjang (${newText.length} char, maks ${limit} char untuk ${isTitle ? 'title' : 'body'}).`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // Apply perubahan
            const oldValue = getConfig().messages?.[tipe];
            setField(`messages.${tipe}`, newText);

            // logAudit async — kalau gagal, config udah tersimpan. Tetap balas sukses,
            // tapi log warning biar kelihatan di console.
            try {
                await logAudit(interaction.client, {
                    action: 'SET_MESSAGE',
                    actorId: interaction.user.id,
                    actorTag: interaction.user.tag,
                    details: `Edit pesan **${tipe}** via modal (${newText.length} char, sebelumnya ${oldValue?.length || 0} char)`,
                    guildId: interaction.guild.id
                });
            } catch (auditErr) {
                console.warn(`⚠️ logAudit gagal saat edit-message (config tetap tersimpan): ${auditErr.message}`);
            }

            // Reply dengan preview
            return interaction.reply({
                content: `✅ Pesan **${tipe}** diperbarui via modal editor.\n\n**Preview:**\n\`\`\`\n${newText.slice(0, 1500)}${newText.length > 1500 ? '\n...(dipotong untuk preview)' : ''}\n\`\`\``,
                flags: MessageFlags.Ephemeral
            });
        } catch (err) {
            console.error('config modal error:', err);
            if (!interaction.replied && !interaction.deferred) {
                return interaction
                    .reply({
                        content: `❌ Gagal menyimpan perubahan: ${err.message}`,
                        flags: MessageFlags.Ephemeral
                    })
                    .catch(() => {});
            }
        }
    }
};
