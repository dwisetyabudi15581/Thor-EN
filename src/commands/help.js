/**
 * Domain: help
 * Slash commands: /help [search]
 *
 * v3.9.39 REDESIGN (user request: "/help was one giant embed, finding a
 * command meant scrolling"):
 *   /help now renders an interactive navigator — no longer one giant embed:
 *     - 🏠 Home     : 19-category index + 📂 dropdown + 🔍/📖 buttons
 *     - 📂 Category : command details per category (small embed)
 *     - 🔍 Search   : keyword modal OR `/help search:<keyword>` directly
 *     - 📖 All      : the full list (classic view, still available)
 *   All navigation goes through interaction.update() on ONE ephemeral message.
 *   Interaction handler: src/interactions/help.js (customId prefix `help_`).
 *
 * v3.9.38: (history) auto-split into 2 embeds when > 5800 chars — the split
 * logic now lives in helpCatalog.buildAllEmbeds() (the 📖 All Commands view).
 * v3.9.37: dynamic version from package.json.
 */

const { MessageFlags } = require('./_shared');
const { buildHomeEmbed, buildSearchEmbed, buildHelpComponents } = require('../ui/helpCatalog');

module.exports = async function (interaction) {
    // /help search:<keyword> → jump straight to search results.
    // (optional chaining: old unit-test mocks have no interaction.options)
    const query = interaction.options?.getString?.('search');

    if (query && query.trim()) {
        return interaction.reply({
            embeds: [buildSearchEmbed(query.trim())],
            components: buildHelpComponents('search'),
            flags: MessageFlags.Ephemeral
        });
    }

    return interaction.reply({
        embeds: [buildHomeEmbed(interaction.client, interaction.user)],
        components: buildHelpComponents('home'),
        flags: MessageFlags.Ephemeral
    });
};
