/**
 * Domain: premium
 * Slash commands: /gen-key, /redeem, /list-stock, /revoke-key
 *
 * v3.13.0: PREMIUM SAAS — stock keys + SELF-SERVICE redemption.
 * Complements /set-key (the old model: an admin hand-crafts a key and
 * assigns it directly to a user). With the public v3.12.0 mode
 * (Dyno-style), admins can't be online 24/7 waiting for buyers, so:
 *
 *   /gen-key  (admin)  : the bot mints a crypto-secure random key
 *                        (XXXXX-XXXXX-XXXXX) → stored as STOCK.
 *   /redeem   (public) : members redeem the key THEMSELVES → role +
 *                        expiry schedule are automated. Duration starts
 *                        AT REDEMPTION.
 *   /list-stock (admin) : view this guild's unredeemed stock keys.
 *   /revoke-key (admin) : cancel a stock key that leaked / was minted
 *                        by mistake.
 *
 * Security (anti-abuse for /redeem — the first public command that
 * touches money-valued key data):
 *   1. Rate limiter in the data layer (keyManager): 5 failures / 10
 *      minutes per user → cooldown. Blocks brute-forcing 31^15 keys.
 *   2. Every /redeem failure returns the SAME GENERIC message ("Key is
 *      invalid or already used") — keys cannot be enumerated (no
 *      leaking which keys are valid-but-unused vs used vs owned by
 *      another guild).
 *   3. Key consumption is ATOMIC in redeemKey (load→validate→mutate→
 *      save with no await in between) — two concurrent redeems: only
 *      one succeeds.
 *   4. Audit logs NEVER contain key values (the v3.9.1 FIX pattern) —
 *      length/count + product are enough.
 *
 * /redeem operation order (after the rate-limit check):
 *   redeemKey (atomic consumption) → add role → schedule → DM → audit.
 *   If the role add fails AFTER the key was consumed: the key stays
 *   stored (same as /set-key failing mid-way) — the member is told to
 *   contact an admin; the admin can add the role manually, no key data
 *   is lost.
 */

const {
    EmbedBuilder,
    MessageFlags,
    getConfig,
    resolveGuildId,
    createStockKey,
    redeemKey,
    listStockKeys,
    revokeStockKey,
    isRedeemRateLimited,
    noteRedeemFailure,
    noteRedeemSuccess,
    scheduleRoleRemoval,
    logAudit,
    safeEditReply
} = require('./_shared');

// Generic /redeem message convention — ONE string for ALL key validation
// failures so keys can't be enumerated (must match the message thrown by
// keyManager.redeemKey).
const GENERIC_KEY_ERROR = '❌ Key is invalid or already used.';

// /gen-key: keys minted per invocation (1-10). More than 10 → the admin
// runs it again (a small cap keeps the reply short and avoids mass typos).
const GEN_KEY_MAX_COUNT = 10;

// /list-stock: display cap per embed (Discord field values max out at
// 1024 chars — 15 compact entries fit safely; the rest becomes "… and
// N more").
const LIST_STOCK_PAGE = 15;

module.exports = async function (interaction) {
    // v3.10.0 multi-guild: stock & redemption are always scoped to this guild.
    const guildId = resolveGuildId(interaction);
    const config = getConfig(guildId);

    // ====================================================
    // === /gen-key — ADMIN MINTS STOCK KEYS ===
    // ====================================================
    if (interaction.commandName === 'gen-key') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const value = interaction.options.getString('value');
        // Discord only validates min/max on the client side — the server
        // must re-validate (the v3.9.38 FIX pattern: never trust input).
        const count = Math.min(
            Math.max(Math.floor(interaction.options.getInteger('count') || 1), 1),
            GEN_KEY_MAX_COUNT
        );
        const note = interaction.options.getString('note') || '';

        const product = config.products.find(p => p.value === value);
        if (!product) {
            return safeEditReply(interaction, {
                content: `❌ Product value \`${value}\` not found. Use \`/list-products\` to see the list.`
            });
        }
        // Same as /set-key: without a roleId the key can't be redeemed
        // correctly later (redeem needs the role to grant).
        if (!product.roleId) {
            return safeEditReply(interaction, {
                content: `❌ Product **${product.label}** has no auto-role yet. Run \`/set-product-role\` first.`
            });
        }

        const entries = [];
        try {
            for (let i = 0; i < count; i++) {
                entries.push(
                    createStockKey({
                        productName: product.label,
                        roleId: product.roleId,
                        days: product.days || 0,
                        guildId: interaction.guild.id,
                        note,
                        createdBy: interaction.user.tag
                    })
                );
            }
        } catch (err) {
            // Some keys may already be stored if the loop failed midway —
            // show the ones that succeeded plus the error so the admin
            // knows the exact stock state (no silent failure).
            console.error('createStockKey failed:', err);
            const successList = entries.map(e => `\`${e.key}\``).join('\n') || '(none)';
            return safeEditReply(interaction, {
                content:
                    `⚠️ Failed to mint stock keys: ${err.message}\n\n` +
                    `Keys that were stored (${entries.length}):\n${successList}\n\n` +
                    `Check disk space / file permissions for \`data/keys.json\`, then run it again.`
            });
        }

        const durationStr =
            (product.days || 0) > 0 ? `${product.days} days since REDEMPTION` : 'permanent once redeemed';

        // Audit log: NEVER leak key values (the v3.9.1 FIX pattern) —
        // count + product + key length are enough.
        await logAudit(interaction.client, {
            action: 'GEN_KEY',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Generated ${count} stock keys — product: **${product.label}**, duration: ${durationStr}, key: \`***\` (len=${entries[0].key.length})${note ? `, note: ${note}` : ''}`,
            guildId: interaction.guild.id
        });

        // Ephemeral reply (only the admin sees the key values — the same
        // security rationale as /set-key being ephemeral).
        const keyBlock = entries.map(e => `\`${e.key}\``).join('\n');
        return safeEditReply(interaction, {
            content:
                `✅ **${count} stock keys minted!**\n\n` +
                `📦 Product: ${product.label}\n` +
                `⏰ Duration: ${durationStr}\n` +
                (note ? `📝 Note: ${note}\n` : '') +
                `\n🔑 **Keys (send to buyers — never post them in public channels):**\n${keyBlock}\n\n` +
                `Buyers redeem them themselves via \`/redeem\`. View the stock anytime: \`/list-stock\`.`
        });
    }

    // ====================================================
    // === /redeem — MEMBER REDEEMS A KEY (PUBLIC) ===
    // ====================================================
    if (interaction.commandName === 'redeem') {
        const keyValue = (interaction.options.getString('key') || '').trim();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // 1. Rate limiter — checked BEFORE touching the file (a user on
        //    cooldown must not generate file I/O).
        if (isRedeemRateLimited(interaction.user.id)) {
            return safeEditReply(interaction, {
                content:
                    '⏳ You have tried too many times. Wait ±10 minutes before trying to redeem a key again.\n\n' +
                    '💡 Make sure the key is copied in full (format `XXXXX-XXXXX-XXXXX`, uppercase, no spaces).'
            });
        }

        // 2. Consume the key (ATOMIC). All validation failures → the same
        //    generic message (anti-enumeration), then record the failure
        //    with the rate limiter.
        let entry;
        try {
            entry = redeemKey(keyValue, {
                userId: interaction.user.id,
                username: interaction.user.tag,
                guildId: interaction.guild.id
            });
        } catch (_err) {
            noteRedeemFailure(interaction.user.id);
            // Generic message — never echo the validation err.message
            // (redeemKey deliberately throws a generic message, but a raw
            // echo is risky if some non-generic error path appears, like
            // empty input).
            return safeEditReply(interaction, { content: GENERIC_KEY_ERROR });
        }

        // 3. Key is valid & consumed — record the success (resets the
        //    limiter: a user who succeeded is clearly not brute-forcing).
        noteRedeemSuccess(interaction.user.id);

        const guild = interaction.guild;
        const member = interaction.member;
        const role = guild.roles.cache.get(entry.roleId);

        let roleWarning = '';
        let dmSent = false;
        if (role) {
            // 3a. Grant the role. If it fails (bot hierarchy/permissions),
            //     the key is ALREADY stored — don't roll back (the user's
            //     purchase is legitimate), show a "contact admin" note
            //     (the /set-key pattern).
            try {
                if (!member.roles.cache.has(role.id)) {
                    await member.roles.add(role);
                }
            } catch (_err) {
                roleWarning =
                    `\n⚠️ **Failed to grant the role \`${role.name}\` automatically** — contact an admin/server owner ` +
                    `to have the role added manually (your purchase is stored and won't be lost).`;
            }
        } else {
            // The product role was deleted from Discord after the key was
            // minted. The buyer can't do anything — escalate to the admin.
            roleWarning =
                '\n⚠️ **The product role no longer exists on this server** — contact an admin; your purchase is stored, and an admin can grant a replacement role.';
        }

        // 3b. Auto-expiry schedule (MAX EXTEND — same as /set-key; the
        //     expireAt was already computed by redeemKey: duration SINCE
        //     REDEMPTION).
        let scheduleWarning = '';
        try {
            scheduleRoleRemoval({
                userId: interaction.user.id,
                roleId: entry.roleId,
                guildId: guild.id,
                days: entry.days,
                expireAt: entry.expireAt,
                productName: entry.productName
            });
        } catch (schedErr) {
            console.error('scheduleRoleRemoval failed (redeem):', schedErr);
            scheduleWarning =
                '\n⚠️ Failed to create the auto-expiry schedule — the role will not auto-expire. Contact an admin.';
        }

        // 3c. DM confirmation (best-effort — closed DMs are not fatal,
        //     the ephemeral reply still shows).
        const expireInfo =
            entry.expireAt === null
                ? 'permanent (will not expire)'
                : `${Math.ceil((entry.expireAt - Date.now()) / 86400000)} days remaining`;
        try {
            await interaction.user.send(
                `Thank you! Your key was redeemed successfully in **${guild.name}** 🎉\n\n` +
                    `📦 Product: ${entry.productName}\n` +
                    `🎭 Role: ${role ? role.name : 'having issues — contact an admin'}\n` +
                    `⏰ Expiry: ${expireInfo}\n\n` +
                    `💡 Keep this message as your proof of purchase.`
            );
            dmSent = true;
        } catch (_) {}

        // 3d. Audit log — WITHOUT the key value (product + length are enough).
        await logAudit(interaction.client, {
            action: 'REDEEM_KEY',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Self-service key redemption — product: **${entry.productName}**, key: \`***\` (len=${keyValue.length})`,
            guildId: guild.id
        });

        return safeEditReply(interaction, {
            content:
                `🎉 **Key redeemed successfully!**\n\n` +
                `📦 Product: ${entry.productName}\n` +
                `🎭 Role: ${role ? role : '⚠️ having issues — see the note below'}\n` +
                `⏰ Expiry: ${expireInfo}\n` +
                `${dmSent ? '📬 Check your DMs for the proof of purchase.' : 'ℹ️ DM not delivered (your DMs are closed) — keep this message as proof.'}` +
                roleWarning +
                scheduleWarning
        });
    }

    // ====================================================
    // === /list-stock — ADMIN VIEWS THIS GUILD'S STOCK ===
    // ====================================================
    if (interaction.commandName === 'list-stock') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const stock = listStockKeys(guildId);
        if (stock.length === 0) {
            return safeEditReply(interaction, {
                content: '📭 No stock keys on this server yet. Create some with `/gen-key`.'
            });
        }

        const shown = stock.slice(0, LIST_STOCK_PAGE);
        const hidden = stock.length - shown.length;
        const lines = shown.map(k => {
            const duration = (Number(k.days) || 0) > 0 ? `${k.days}d` : 'permanent';
            const noteStr = k.note ? ` · ${k.note}` : '';
            return `\`${k.key}\` — ${k.productName} · ${duration} since redemption${noteStr}`;
        });
        if (hidden > 0) lines.push(`… and ${hidden} more keys (total ${stock.length}).`);

        const embed = new EmbedBuilder()
            .setTitle(`🏷️ Stock Keys — ${stock.length} unredeemed`)
            .setDescription(
                `The keys below have **not been used by anyone** — safe to send to buyers. ` +
                    `Their duration only starts when the key is REDEEMED (\`/redeem\`), not now.`
            )
            .addFields({ name: `🔑 Keys (${shown.length} shown)`, value: lines.join('\n').slice(0, 1024), inline: false })
            .setColor(0x57f287)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /revoke-key — ADMIN CANCELS A STOCK KEY ===
    // ====================================================
    if (interaction.commandName === 'revoke-key') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const keyValue = (interaction.options.getString('key') || '').trim();

        const removed = revokeStockKey(keyValue, guildId);
        if (!removed) {
            return safeEditReply(interaction, {
                content:
                    '❌ That key cannot be revoked: it is not in this guild\'s stock, or it was ALREADY redeemed by a member ' +
                    '(a legitimate redemption — to take it back from the member, use `/clear-schedule user clear_keys:true`).'
            });
        }

        await logAudit(interaction.client, {
            action: 'REVOKE_KEY',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Revoked a stock key — product: **${removed.productName}**, key: \`***\` (len=${keyValue.length})`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, {
            content:
                `🗑️ **Stock key revoked.**\n\n` +
                `📦 Product: ${removed.productName}\n` +
                `🔑 Key: \`***\` (len=${keyValue.length})\n\n` +
                `Nobody can redeem that key anymore. If it leaked, this prevents abuse.`
        });
    }
};
