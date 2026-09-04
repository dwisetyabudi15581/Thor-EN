/**
 * Domain: automod
 * Slash commands: /set-automod, /automod-show, /automod-toggle,
 *                 /add-link-whitelist, /remove-link-whitelist,
 *                 /add-word, /remove-word, /list-words
 *
 * v3.9.13: Anti-Spam & Auto-Mod system.
 * - Spam detection (N messages in window)
 * - Link blocking (with whitelist channel/role)
 * - Word filter
 * - Mass-mention block
 *
 * v3.9.23 WORD FLEX:
 * - /add-word words action tipe — add words ONE BY ONE (append, does not replace
 *   the old list). Supports per-word actions + the exempt type.
 * - /remove-word word tipe — remove a specific word from the blocklist / exempt list.
 * - /list-words — view all words + per-word action + exempt + match mode.
 * - /remove-link-whitelist — remove a channel/role from the link whitelist.
 * - /set-automod block_words → BULK REPLACE (replaces everything). For granular
 *   edits (adding/removing 1 word), use /add-word or /remove-word.
 */

const { EmbedBuilder, MessageFlags } = require('discord.js');
const { logAudit, safeEditReply } = require('./_shared');

const automod = require('../data/automodManager');

// Display labels for actions in embeds.
const ACTION_LABELS = {
    delete_only: 'Delete only',
    warn: 'Warn (DM)',
    mute_10m: 'Mute 10m',
    mute_1h: 'Mute 1h',
    kick: 'Kick'
};

// Discord embed field value max is 1024 char — use 1000 for buffer.
const FIELD_VALUE_MAX = 1000;

/**
 * Join a list of items into 1 string with safe truncation.
 * Returns { text, truncated, total }.
 */
function joinTruncated(items, separator, maxLen = FIELD_VALUE_MAX) {
    const total = items.length;
    if (total === 0) return { text: '_(none)_', truncated: false, total: 0 };
    let text = '';
    let count = 0;
    for (const item of items) {
        const candidate = count === 0 ? item : text + separator + item;
        if (candidate.length > maxLen) break;
        text = candidate;
        count++;
    }
    const truncated = count < total;
    if (truncated) {
        const suffix = `\n…+${total - count} more`;
        text = (text + suffix).length > maxLen + 60 ? text.slice(0, maxLen) + suffix : text + suffix;
    }
    return { text, truncated, total };
}

/**
 * Format a wordRules list: "word → action" per line.
 * Words without a specific action use the "(global)" label.
 */
function formatWordRules(wordRules) {
    return wordRules.map(rule => {
        const action = rule.action ? ACTION_LABELS[rule.action] || rule.action : '(global)';
        return `\`${rule.word}\` → ${action}`;
    });
}

module.exports = async function (interaction) {
    // === SET AUTOMOD ===
    if (interaction.commandName === 'set-automod') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const updates = {};
        const spamThreshold = interaction.options.getInteger('spam_threshold');
        const spamAction = interaction.options.getString('spam_action');
        const blockLinks = interaction.options.getBoolean('block_links');
        const blockWords = interaction.options.getString('block_words');
        const wordAction = interaction.options.getString('word_action');
        const maxMentions = interaction.options.getInteger('max_mentions');
        const mentionAction = interaction.options.getString('mention_action');

        if (spamThreshold !== null) updates.spamThreshold = spamThreshold;
        if (spamAction) updates.spamAction = spamAction;
        if (blockLinks !== null) updates.blockLinks = blockLinks;
        if (blockWords !== null) {
            // v3.9.23: BULK REPLACE — the entire word list is replaced with this input.
            // To ADD words without removing the old ones → /add-word.
            // To REMOVE 1 word → /remove-word.
            const words = blockWords
                .split(',')
                .map(w => w.trim().toLowerCase())
                .filter(Boolean);
            updates.wordRules = words.map(w => ({
                word: w,
                action: null,
                addedBy: interaction.user.id,
                addedAt: Date.now()
            }));
            updates.blockWords = []; // clear the legacy field
        }
        if (wordAction) updates.wordAction = wordAction;
        if (maxMentions !== null) updates.maxMentions = maxMentions;
        if (mentionAction) updates.mentionAction = mentionAction;

        const newConfig = automod.setGuildConfig(interaction.guild.id, updates);

        await logAudit(interaction.client, {
            action: 'SET_AUTOMOD',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Update auto-mod config: ${Object.keys(updates).join(', ')}`,
            guildId: interaction.guild.id
        });

        const embed = new EmbedBuilder()
            .setTitle('🛡️ AUTO-MOD CONFIG UPDATED')
            .setColor(0x57f287)
            .addFields(
                { name: '✅ Status', value: newConfig.enabled ? 'Enabled' : 'Disabled', inline: true },
                {
                    name: '⚡ Spam Threshold',
                    value: `${newConfig.spamThreshold} msg / ${newConfig.spamWindowMs / 1000}s`,
                    inline: true
                },
                { name: '🔨 Spam Action', value: newConfig.spamAction, inline: true },
                { name: '🔗 Block Links', value: newConfig.blockLinks ? 'Yes' : 'No', inline: true },
                {
                    name: '📝 Word Filter',
                    value: `${newConfig.wordRules.length} words (+${newConfig.exemptWords.length} exempt)`,
                    inline: true
                },
                {
                    name: '🎯 Match Mode',
                    value: newConfig.wordMatchMode === 'whole_word' ? 'Whole word' : 'Substring',
                    inline: true
                },
                {
                    name: '🔨 Word Action (fallback)',
                    value: ACTION_LABELS[newConfig.wordAction] || newConfig.wordAction,
                    inline: true
                },
                { name: '👥 Max Mentions', value: `${newConfig.maxMentions}`, inline: true },
                { name: '🔨 Mention Action', value: newConfig.mentionAction, inline: true }
            )
            .setFooter({
                text: 'Use /add-word /remove-word /list-words to manage words. /automod-show for details.'
            });

        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === AUTOMOD SHOW ===
    if (interaction.commandName === 'automod-show') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const config = automod.getGuildConfig(interaction.guild.id);
        if (!config) {
            return safeEditReply(interaction, {
                content:
                    'ℹ️ Auto-mod is not configured yet. Use `/set-automod` to set it up, then `/automod-toggle enabled:true`.'
            });
        }

        const wordList = joinTruncated(formatWordRules(config.wordRules || []), '\n');
        const exemptList = joinTruncated(
            (config.exemptWords || []).map(w => `\`${w}\``),
            ', '
        );
        const linkChannels = joinTruncated(
            (config.linkAllowedChannels || []).map(id => `<#${id}>`),
            ', '
        );
        const linkRoles = joinTruncated(
            (config.linkAllowedRoles || []).map(id => `<@&${id}>`),
            ', '
        );

        const embed = new EmbedBuilder()
            .setTitle('🛡️ AUTO-MOD CONFIG')
            .setColor(config.enabled ? 0x57f287 : 0x95a5a6)
            .addFields(
                { name: '✅ Status', value: config.enabled ? 'Enabled ✅' : 'Disabled ❌', inline: true },
                {
                    name: '⚡ Spam Detection',
                    value: `${config.spamThreshold} msg in ${(config.spamWindowMs || 10000) / 1000}s → ${config.spamAction || 'mute_10m'}`,
                    inline: false
                },
                {
                    name: '🔗 Link Blocking',
                    value: config.blockLinks
                        ? `Yes\nWhitelist channel: ${linkChannels.text}\nWhitelist role: ${linkRoles.text}`
                        : 'No',
                    inline: false
                },
                {
                    name: `📝 Word Filter (${wordList.total} words)`,
                    value: wordList.text,
                    inline: false
                },
                {
                    name: '🎯 Match Mode',
                    value:
                        config.wordMatchMode === 'whole_word'
                            ? '**Whole word** — the word must stand on its own ("asu" does not match "asus")'
                            : '**Substring** — matches anywhere (can cause false positives)',
                    inline: false
                },
                {
                    name: `🛡️ Exempt Words (${exemptList.total})`,
                    value: exemptList.text,
                    inline: false
                },
                {
                    name: '👥 Mention Limit',
                    value: `Max ${config.maxMentions || 5} mentions → ${config.mentionAction || 'warn'}`,
                    inline: false
                }
            )
            .setFooter({
                text: `Manage words: /add-word, /remove-word, /list-words • Updated: ${config.updatedAt ? new Date(config.updatedAt).toLocaleString('en-US') : 'unknown'}`
            });

        return safeEditReply(interaction, { embeds: [embed] });
    }

    // === AUTOMOD TOGGLE ===
    if (interaction.commandName === 'automod-toggle') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const enabled = interaction.options.getBoolean('enabled');
        automod.enableAutoMod(interaction.guild.id, enabled);

        await logAudit(interaction.client, {
            action: 'TOGGLE_AUTOMOD',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Auto-mod ${enabled ? 'ENABLED' : 'DISABLED'}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `${enabled ? '✅' : '❌'} Auto-mod ${enabled ? 'enabled' : 'disabled'}.\n\n` +
                `💡 Your current config is still saved. Enable it again later and it works right away — no re-setup needed.`
        });
    }

    // === ADD LINK WHITELIST ===
    if (interaction.commandName === 'add-link-whitelist') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const channel = interaction.options.getChannel('channel');
        const role = interaction.options.getRole('role');

        const config = automod.getGuildConfig(interaction.guild.id) || automod.getDefaultConfig();
        const updates = {};

        if (channel) {
            const list = config.linkAllowedChannels || [];
            if (!list.includes(channel.id)) list.push(channel.id);
            updates.linkAllowedChannels = list;
        }
        if (role) {
            const list = config.linkAllowedRoles || [];
            if (!list.includes(role.id)) list.push(role.id);
            updates.linkAllowedRoles = list;
        }

        if (Object.keys(updates).length === 0) {
            return safeEditReply(interaction, { content: '❌ Pick a channel or role to whitelist.' });
        }

        const newConfig = automod.setGuildConfig(interaction.guild.id, updates);

        await logAudit(interaction.client, {
            action: 'AUTOMOD_WHITELIST',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Add link whitelist: ${channel ? `#${channel.name}` : ''} ${role ? `@${role.name}` : ''}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ Whitelist added!\n\n` +
                `📢 Channels: ${newConfig.linkAllowedChannels.map(id => `<#${id}>`).join(', ') || '_(none)_'}\n` +
                `🎭 Roles: ${newConfig.linkAllowedRoles.map(id => `<@&${id}>`).join(', ') || '_(none)_'}`
        });
    }

    // === REMOVE LINK WHITELIST (v3.9.23) ===
    if (interaction.commandName === 'remove-link-whitelist') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const channel = interaction.options.getChannel('channel');
        const role = interaction.options.getRole('role');

        if (!channel && !role) {
            return safeEditReply(interaction, {
                content: '❌ Pick the channel or role to remove from the whitelist.'
            });
        }

        const config = automod.getGuildConfig(interaction.guild.id) || automod.getDefaultConfig();
        const updates = {};
        const removedParts = [];

        if (channel) {
            const list = config.linkAllowedChannels || [];
            if (list.includes(channel.id)) {
                updates.linkAllowedChannels = list.filter(id => id !== channel.id);
                removedParts.push(`#${channel.name}`);
            }
        }
        if (role) {
            const list = config.linkAllowedRoles || [];
            if (list.includes(role.id)) {
                updates.linkAllowedRoles = list.filter(id => id !== role.id);
                removedParts.push(`@${role.name}`);
            }
        }

        if (removedParts.length === 0) {
            return safeEditReply(interaction, {
                content: `ℹ️ ${channel ? `<#${channel.id}> ` : ''}${role ? `<@&${role.id}>` : ''} is not in the link whitelist.`
            });
        }

        const newConfig = automod.setGuildConfig(interaction.guild.id, updates);

        await logAudit(interaction.client, {
            action: 'AUTOMOD_WHITELIST',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Remove link whitelist: ${removedParts.join(' ')}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `✅ Removed from the link whitelist: **${removedParts.join(', ')}**\n\n` +
                `📢 Channels: ${newConfig.linkAllowedChannels.map(id => `<#${id}>`).join(', ') || '_(none)_'}\n` +
                `🎭 Roles: ${newConfig.linkAllowedRoles.map(id => `<@&${id}>`).join(', ') || '_(none)_'}`
        });
    }

    // === ADD WORD (v3.9.23) ===
    if (interaction.commandName === 'add-word') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const wordsInput = interaction.options.getString('words');
        const action = interaction.options.getString('action'); // null = global fallback
        const tipe = interaction.options.getString('tipe') || 'blocklist';

        // tipe=exempt → add to the list of EXEMPT words (not flagged)
        if (tipe === 'exempt') {
            const result = automod.addExemptWords(interaction.guild.id, wordsInput);

            await logAudit(interaction.client, {
                action: 'AUTOMOD_WORD',
                actorId: interaction.user.id,
                actorTag: interaction.user.tag,
                details: `Add ${result.added.length} exempt word(s): ${result.added.join(', ') || '(none)'} (skipped: ${result.skipped.join(', ') || 'none'})`,
                guildId: interaction.guild.id
            });

            const config = automod.getGuildConfig(interaction.guild.id);
            const lines = [];
            if (result.added.length > 0)
                lines.push(`✅ Added to **exempt**: ${result.added.map(w => `\`${w}\``).join(', ')}`);
            if (result.skipped.length > 0)
                lines.push(`⏭️ Skipped (already exists): ${result.skipped.map(w => `\`${w}\``).join(', ')}`);
            if (result.added.length === 0 && result.skipped.length === 0)
                lines.push('❌ No valid words to add.');
            lines.push(
                `\n🛡️ Exempt now: **${config.exemptWords.length} words** — messages containing these words are not flagged by auto-mod.`
            );

            return safeEditReply(interaction, { content: lines.join('\n') });
        }

        // tipe=blocklist (default) → add to the list of BLOCKED words
        const result = automod.addWords(interaction.guild.id, wordsInput, action, interaction.user.id);
        if (result.error) {
            return safeEditReply(interaction, { content: `❌ ${result.error}` });
        }

        await logAudit(interaction.client, {
            action: 'AUTOMOD_WORD',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Add ${result.added.length} blocklist word(s): ${result.added.join(', ') || '(none)'} (action: ${action || 'global fallback'}, skipped: ${result.skipped.join(', ') || 'none'})`,
            guildId: interaction.guild.id
        });

        const config = automod.getGuildConfig(interaction.guild.id);
        const lines = [];
        if (result.added.length > 0) {
            const actionLabel = action ? ` (action: **${ACTION_LABELS[action] || action}**)` : '';
            lines.push(`✅ Added to **blocklist**: ${result.added.map(w => `\`${w}\``).join(', ')}${actionLabel}`);
        }
        if (result.skipped.length > 0)
            lines.push(
                `⏭️ Skipped (already exists — use /remove-word first if you want to change it): ${result.skipped.map(w => `\`${w}\``).join(', ')}`
            );
        if (result.added.length === 0 && result.skipped.length === 0)
            lines.push('❌ No valid words to add.');
        lines.push(
            `\n📝 Blocklist now: **${config.wordRules.length} words** • match: ${config.wordMatchMode === 'whole_word' ? 'whole word' : 'substring'} • exempt: ${config.exemptWords.length} words`
        );
        lines.push('💡 View all: `/list-words`');

        return safeEditReply(interaction, { content: lines.join('\n') });
    }

    // === REMOVE WORD (v3.9.23) ===
    if (interaction.commandName === 'remove-word') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const word = interaction.options.getString('word');
        const tipe = interaction.options.getString('tipe') || 'blocklist';

        let result;
        let listLabel;
        if (tipe === 'exempt') {
            result = automod.removeExemptWord(interaction.guild.id, word);
            listLabel = 'exempt';
        } else {
            result = automod.removeWord(interaction.guild.id, word);
            listLabel = 'blocklist';
        }

        if (result.error) {
            return safeEditReply(interaction, { content: `❌ ${result.error}` });
        }
        if (!result.ok) {
            return safeEditReply(interaction, {
                content: `ℹ️ The word \`${word.toLowerCase()}\` isn't in the ${listLabel}. Check the list: \`/list-words\`.`
            });
        }

        await logAudit(interaction.client, {
            action: 'AUTOMOD_WORD',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Remove ${listLabel} word: ${result.removed}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content: `✅ Word \`${result.removed}\` removed from the **${listLabel}**.\n\n💡 To add it back: \`/add-word words:${result.removed}\``
        });
    }

    // === LIST WORDS (v3.9.23) ===
    if (interaction.commandName === 'list-words') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const config = automod.getGuildConfig(interaction.guild.id);
        if (!config) {
            return safeEditReply(interaction, {
                content:
                    'ℹ️ Auto-mod is not configured yet — no blocked words.\n\nAdd your first words: `/add-word words:word1,word2`'
            });
        }

        const wordList = joinTruncated(formatWordRules(config.wordRules || []), '\n');
        const exemptList = joinTruncated(
            (config.exemptWords || []).map(w => `\`${w}\``),
            ', '
        );

        const embed = new EmbedBuilder()
            .setTitle(`📝 WORD FILTER — ${wordList.total} words`)
            .setColor(0x5865f2)
            .addFields(
                {
                    name: '🎯 Match Mode',
                    value:
                        config.wordMatchMode === 'whole_word'
                            ? '**Whole word** — "asu" does not match "asus"'
                            : '**Substring** — matches anywhere',
                    inline: false
                },
                {
                    name: `⛔ Blocklist (${wordList.total})`,
                    value: wordList.text,
                    inline: false
                },
                {
                    name: `🛡️ Exempt (${exemptList.total})`,
                    value: exemptList.text,
                    inline: false
                },
                {
                    name: '🔨 Fallback Action',
                    value: `${ACTION_LABELS[config.wordAction] || config.wordAction} — used for words without a specific action`,
                    inline: false
                }
            )
            .setFooter({
                text: 'Add: /add-word • Remove: /remove-word • Bulk replace: /set-automod block_words'
            });

        return safeEditReply(interaction, { embeds: [embed] });
    }
};
