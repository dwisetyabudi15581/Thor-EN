/**
 * Config interaction domain handler — modal submits for /edit-message.
 *
 * v3.9.12: Handle modal_edit_message:<type> — the modal editor for message config.
 * Admins use /edit-message to open the modal (multi-line textarea),
 * then submit → this handler applies the change to config.messages[type].
 *
 * CustomId: modal_edit_message:<type>
 * type: welcomeTitle, welcomeBody, goodbyeTitle, goodbyeBody,
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
    // === MODAL: edit_message:<type> ===
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_edit_message:')) {
        // Wrap the whole body in try/catch.
        // If setField or logAudit throws (disk error / permission),
        // reply with a clear error to the admin — don't let it propagate to the top-level handler.
        try {
            const tipe = interaction.customId.split(':')[1];

            // Validate type (defense-in-depth — admins could attempt customId manipulation)
            if (!VALID_TYPES.has(tipe)) {
                return interaction.reply({
                    content: `❌ Invalid message type \`${tipe}\`.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const newText = interaction.fields.getTextInputValue('message_text');
            if (!newText || newText.trim().length === 0) {
                return interaction.reply({
                    content: '❌ Text cannot be empty.',
                    flags: MessageFlags.Ephemeral
                });
            }

            // Validate length
            const isTitle = tipe.endsWith('Title');
            const limit = isTitle ? EMBED_LIMITS.TITLE : EMBED_LIMITS.DESCRIPTION;
            if (newText.length > limit) {
                return interaction.reply({
                    content: `❌ Text is too long (${newText.length} chars, max ${limit} chars for ${isTitle ? 'title' : 'body'}).`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // Apply the change
            const oldValue = getConfig().messages?.[tipe];
            setField(`messages.${tipe}`, newText);

            // logAudit is async — if it fails, the config is already saved. Still reply success,
            // but log a warning so it's visible in the console.
            try {
                await logAudit(interaction.client, {
                    action: 'SET_MESSAGE',
                    actorId: interaction.user.id,
                    actorTag: interaction.user.tag,
                    details: `Edit message **${tipe}** via modal (${newText.length} chars, previously ${oldValue?.length || 0} chars)`,
                    guildId: interaction.guild.id
                });
            } catch (auditErr) {
                console.warn(`⚠️ logAudit failed during edit-message (config is still saved): ${auditErr.message}`);
            }

            // Reply with a preview
            return interaction.reply({
                content: `✅ Message **${tipe}** updated via the modal editor.\n\n**Preview:**\n\`\`\`\n${newText.slice(0, 1500)}${newText.length > 1500 ? '\n...(truncated for preview)' : ''}\n\`\`\``,
                flags: MessageFlags.Ephemeral
            });
        } catch (err) {
            console.error('config modal error:', err);
            if (!interaction.replied && !interaction.deferred) {
                return interaction
                    .reply({
                        content: `❌ Failed to save the change: ${err.message}`,
                        flags: MessageFlags.Ephemeral
                    })
                    .catch(() => {});
            }
        }
    }
};
