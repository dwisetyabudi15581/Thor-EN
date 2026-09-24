/**
 * v4.4.0 — the classic CHRONOS verify-panel TEXT sync.
 *
 * CHRONOS parity (owner: "tinggal copy code dari repo CHRONOS"): the
 * verification panel text lives in CONFIG — `messages.verifyTitle` /
 * `messages.verifyBody` (template with `{server}`) — exactly like CHRONOS
 * v3.9.59. The live self-role panel is a PROJECTION of that config:
 *
 *   config change  (/set-message, /edit-message modal, DASH PUT config)
 *        → syncVerifyPanelFromConfig() → panel updated + live message re-rendered
 *   panel change   (/selfrole-update, DASH PUT selfroles/:id title/description)
 *        → writeVerifyTextToConfig()  → config keys kept honest (/list-messages)
 *
 * `{server}` resolves at install/sync time with the live guild name — the
 * exact CHRONOS pattern (its setup-verify resolves when building the embed;
 * the config keeps the template). Render code is untouched.
 */

const { getConfig, setField } = require('../data/configManager');
const selfRoleManager = require('../data/selfRoleManager');
const { buildPanelEmbed, buildPanelComponents } = require('../ui/selfRolePanelBuilder');

/** The two classic text keys (also the /set-message choice values). */
const VERIFY_TEXT_KEYS = new Set(['verifyTitle', 'verifyBody']);

/** True when a message key is one of the verify panel text keys. */
function isVerifyTextKey(tipe) {
    return VERIFY_TEXT_KEYS.has(tipe);
}

/** Resolve {server} exactly like CHRONOS's setup-verify (global replace). */
function resolveServer(text, guildName) {
    return String(text ?? '').replace(/\{server\}/g, guildName || '');
}

/**
 * Push config.messages.verifyTitle/verifyBody into the LIVE verify panel
 * (when one is installed) and re-render its Discord message.
 *
 * Best-effort by design (the /set-verify-button pattern): a missing message
 * or a permissions failure NEVER fails the caller — the config is already
 * saved; only the note for the admin differs.
 *
 * @returns {{ synced: boolean, note: string }} — note is '' or a status line.
 */
async function syncVerifyPanelFromConfig(guildId, client) {
    const config = getConfig(guildId);
    const panelId = config?.roles?.verifyPanelId;
    if (!panelId) return { synced: false, note: '' };

    const panel = selfRoleManager.getPanel(panelId);
    if (!panel || panel.guildId !== guildId) return { synced: false, note: '' };

    // Resolve {server} with the live guild name (CHRONOS behavior).
    const guildName = client?.guilds?.cache?.get?.(guildId)?.name || '';
    const updated = selfRoleManager.updatePanel(panelId, {
        title: resolveServer(config.messages?.verifyTitle, guildName) || panel.title,
        description: resolveServer(config.messages?.verifyBody, guildName) || panel.description
    });
    if (!updated) return { synced: false, note: '' };

    // Re-render the live panel message (best-effort).
    let rendered = false;
    try {
        const channel = client?.channels?.cache?.get?.(updated.channelId)
            || (updated.channelId && client?.channels?.fetch
                ? await client.channels.fetch(updated.channelId).catch(() => null)
                : null);
        const msg = updated.messageId && channel
            ? await channel.messages.fetch(updated.messageId).catch(() => null)
            : null;
        if (msg) {
            await msg.edit({
                embeds: [buildPanelEmbed(updated, client)],
                components: buildPanelComponents(updated)
            });
            rendered = true;
        }
    } catch (_) {
        /* best-effort — the config is already saved */
    }
    return {
        synced: true,
        note: rendered
            ? '\n\n✅ The live verification panel has been re-rendered with the new text.'
            : '\n\n⚠️ Config saved, but the live panel message could not be re-rendered (deleted? or the bot lacks permission) — reinstall it with `/setup-verify` if it looks wrong.'
    };
}

/**
 * Write a verify panel's text BACK to config (panel-first edits:
 * /selfrole-update, DASH PUT selfroles/:id). Keeps /list-messages honest —
 * the config and the live panel never drift apart.
 *
 * @returns {boolean} true when the writeback happened.
 */
function writeVerifyTextToConfig(guildId, panel) {
    if (!panel || panel.guildId !== guildId || panel.kind !== 'verify') return false;
    setField(guildId, 'messages.verifyTitle', String(panel.title ?? ''));
    setField(guildId, 'messages.verifyBody', String(panel.description ?? ''));
    return true;
}

module.exports = {
    VERIFY_TEXT_KEYS,
    isVerifyTextKey,
    resolveServer,
    syncVerifyPanelFromConfig,
    writeVerifyTextToConfig
};
