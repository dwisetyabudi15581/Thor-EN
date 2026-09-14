/**
 * Domain: commands
 * Slash command: /commands (subcommands: list, toggle, enable-all)
 *
 * v3.19.0 — Dyno-style Command Manager:
 *   Admins can enable/disable the bot's commands per server, either from
 *   Discord (this command) or from the web dashboard (Command Manager
 *   module). Both interfaces write to the same config field:
 *   `disabledCommands` (an array of command names), and the router
 *   (src/commands/index.js) rejects disabled commands with an ephemeral
 *   message.
 *
 * Safety design:
 *   - `/commands` itself can NEVER be disabled (guarded here and in the
 *     DASH API validator) — prevents admins from locking themselves out of
 *     the Discord side. The web dashboard can always restore everything.
 *   - Only bot admins (router permission check) may use this command;
 *     defaultMemberPermissions is ManageGuild in the registry.
 */

const { EmbedBuilder, MessageFlags } = require('discord.js');
const { getCommands } = require('./registry');
const { getConfig, saveConfig } = require('../data/configManager');
const { logAudit, safeEditReply } = require('./_shared');
// v3.20.0: custom commands are managed by the Command Manager too (list/toggle).
const customCommandManager = require('../data/customCommandManager');

// Commands that can never be disabled — the management door stays open.
const PROTECTED_COMMANDS = ['commands'];

/**
 * Normalize + validate a disabled list. Used by this handler AND
 * dashServer.js (re-exported below) so the rules are identical on Discord
 * and the web — single source of truth.
 *
 * v3.20.0: second parameter `extraNames` — the custom command names of the
 * guild in question (from customCommandManager). Custom commands can be
 * disabled via /commands toggle AND the web Command Manager too.
 *
 * @returns {{ ok: true, value: string[] } | { ok: false, error: string }}
 */
function normalizeDisabledList(list, extraNames = []) {
    if (!Array.isArray(list)) return { ok: false, error: 'Invalid command list (must be an array)' };
    if (list.length > 100) return { ok: false, error: 'At most 100 commands can be disabled' };
    const known = new Set([...getCommands().map((c) => c.name), ...extraNames]);
    const seen = new Set();
    for (const raw of list) {
        const name = String(raw);
        if (!known.has(name)) return { ok: false, error: `Unknown command \`${name}\`` };
        if (PROTECTED_COMMANDS.includes(name)) {
            return { ok: false, error: `The \`/${name}\` command cannot be disabled — it is the command management door` };
        }
        seen.add(name);
    }
    return { ok: true, value: [...seen] };
}

/** Read the disabled list from a guild config (always an array, never undefined). */
function getDisabledCommands(config) {
    return Array.isArray(config?.disabledCommands) ? config.disabledCommands : [];
}

module.exports = async function (interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;
    const config = getConfig(guildId);

    // === /commands list ===
    if (sub === 'list') {
        const disabled = getDisabledCommands(config);
        const customCommands = customCommandManager.getGuildCommands(guildId);
        const total = getCommands().length + customCommands.length;
        const embed = new EmbedBuilder()
            .setTitle('🧩 Command Manager')
            .setColor(disabled.length > 0 ? 0xe67e22 : 0x2ecc71)
            .setDescription(
                (disabled.length === 0
                    ? `✅ All **${total} commands are enabled** on this server.\n\nDisable them via \`/commands toggle\` or the web dashboard.`
                    : `⚠️ **${disabled.length}/${total} commands disabled**:\n\n` +
                      disabled.map((c) => `• \`/${c}\``).join('\n') +
                      `\n\nRe-enable them via \`/commands toggle\` or \`/commands enable-all\`.`) +
                (customCommands.length > 0
                    ? `\n\n🧪 **${customCommands.length} custom commands** (created via the web): ${customCommands
                        .map((c) => `\`/${c.name}\``)
                        .join(' ')}`
                    : '')
            )
            .setFooter({ text: `Disabled commands are rejected by the bot · /commands` })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === /commands toggle ===
    if (sub === 'toggle') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const name = (interaction.options.getString('command') || '').trim().toLowerCase();
        const enabled = interaction.options.getBoolean('enabled');

        const known = new Set([
            ...getCommands().map((c) => c.name),
            ...customCommandManager.getGuildCommands(guildId).map((c) => c.name)
        ]);
        if (!known.has(name)) {
            return safeEditReply(interaction, {
                content: `❌ Unknown command \`/${name || '(empty)'}\`. Check the spelling in \`/help\`.`
            });
        }
        if (PROTECTED_COMMANDS.includes(name)) {
            return safeEditReply(interaction, {
                content: `❌ \`/${name}\` cannot be disabled — it is the command management door (like not being able to remove the keyhole from inside the vault).`
            });
        }

        const disabled = getDisabledCommands(config);
        const next = enabled ? disabled.filter((c) => c !== name) : [...new Set([...disabled, name])];
        const normalized = normalizeDisabledList(
            next,
            customCommandManager.getGuildCommands(guildId).map((c) => c.name)
        );
        if (!normalized.ok) {
            return safeEditReply(interaction, { content: `❌ ${normalized.error}` });
        }

        config.disabledCommands = normalized.value;
        saveConfig(guildId, config);

        await logAudit(interaction.client, {
            guildId,
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            action: 'command_toggle',
            details: `\`/${name}\` **${enabled ? 'enabled' : 'disabled'}** via /commands`
        });

        return safeEditReply(interaction, {
            content: `${enabled ? '✅' : '⛔'} Command \`/${name}\` ${enabled ? 'enabled' : 'disabled'} on this server.${enabled ? '' : ' Members who try it will see a "disabled by admin" message.'}`
        });
    }

    // === /commands enable-all ===
    if (sub === 'enable-all') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const before = getDisabledCommands(config).length;
        if (before === 0) {
            return safeEditReply(interaction, { content: 'ℹ️ All commands are already enabled — nothing to change.' });
        }
        config.disabledCommands = [];
        saveConfig(guildId, config);

        await logAudit(interaction.client, {
            guildId,
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            action: 'command_enable_all',
            details: `All commands re-enabled (${before} were disabled) via /commands`
        });

        return safeEditReply(interaction, {
            content: `✅ All commands re-enabled (${before} were disabled).`
        });
    }

    return safeEditReply(interaction, { content: '❌ Unknown subcommand. Use `/commands list`, `toggle`, or `enable-all`.' });
};

// Exports for dashServer + unit tests — the SAME rules in both interfaces.
module.exports.PROTECTED_COMMANDS = PROTECTED_COMMANDS;
module.exports.normalizeDisabledList = normalizeDisabledList;
module.exports.getDisabledCommands = getDisabledCommands;
