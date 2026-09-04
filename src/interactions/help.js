/**
 * Domain: help — interactive /help navigation (v3.9.39).
 *
 * Handles every component interaction on an /help ephemeral message:
 *   - help_cat            (StringSelectMenu) → show category details
 *   - help_search         (button)           → open the search modal
 *   - help_search_modal   (modal submit)     → show search results
 *   - help_home           (button)           → back to the main menu
 *   - help_all            (button)           → the full command list
 *
 * All navigation uses interaction.update() → the SAME message gets edited
 * (no new-message spam while switching categories).
 *
 * customIds are STABLE (no user/message ids) → old /help messages that are
 * still open remain clickable after a bot restart.
 */

const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } = require('discord.js');
const {
    HELP_IDS,
    buildHomeEmbed,
    buildCategoryEmbed,
    buildAllEmbeds,
    buildSearchEmbed,
    buildHelpComponents
} = require('../ui/helpCatalog');

function makeSearchModal() {
    const input = new TextInputBuilder()
        .setCustomId(HELP_IDS.SEARCH_INPUT)
        .setLabel('Keyword')
        .setPlaceholder('e.g. key, escrow, panel, giveaway')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);
    return new ModalBuilder()
        .setCustomId(HELP_IDS.SEARCH_MODAL)
        .setTitle('🔍 Search Commands')
        .addComponents(new ActionRowBuilder().addComponents(input));
}

module.exports = async function handleHelpInteraction(interaction) {
    const id = interaction.customId;

    // === 📂 Category dropdown ===
    if (id === HELP_IDS.SELECT) {
        const catId = interaction.values?.[0];
        const embed = buildCategoryEmbed(interaction.client, catId);
        if (!embed) {
            // Unknown category (old message after a catalog update) —
            // never fail silently, fall back to the main menu.
            return interaction.update({
                embeds: [buildHomeEmbed(interaction.client, interaction.user)],
                components: buildHelpComponents('home')
            });
        }
        return interaction.update({ embeds: [embed], components: buildHelpComponents('cat') });
    }

    // === 🔍 Search button → open modal ===
    if (id === HELP_IDS.SEARCH_BUTTON) {
        return interaction.showModal(makeSearchModal());
    }

    // === 🔍 Search modal submit ===
    if (id === HELP_IDS.SEARCH_MODAL) {
        const query = (interaction.fields?.getTextInputValue?.(HELP_IDS.SEARCH_INPUT) || '').trim();
        // An empty query is impossible from the modal (input required) — still
        // defensive: the search embed handles emptyQuery.
        return interaction.update({
            embeds: [buildSearchEmbed(query)],
            components: buildHelpComponents('search')
        });
    }

    // === 🏠 Main menu ===
    if (id === HELP_IDS.HOME_BUTTON) {
        return interaction.update({
            embeds: [buildHomeEmbed(interaction.client, interaction.user)],
            components: buildHelpComponents('home')
        });
    }

    // === 📖 All commands ===
    if (id === HELP_IDS.ALL_BUTTON) {
        return interaction.update({ embeds: buildAllEmbeds(), components: buildHelpComponents('all') });
    }

    // Any other help_* customId (should not happen) — v3.9.40: acknowledge
    // with an ephemeral reply instead of warn-only. Without an ack, users see
    // a red "This interaction failed" in Discord (old /help messages from a
    // previous bot version whose customIds are no longer recognized).
    console.warn(`[help] unrecognized help customId: ${id}`);
    if (typeof interaction.reply === 'function' && !interaction.replied) {
        return interaction
            .reply({ content: '❓ Unrecognized help component (possibly from an old message). Run `/help` again for the latest menu.', flags: MessageFlags.Ephemeral })
            .catch(() => {});
    }
};
