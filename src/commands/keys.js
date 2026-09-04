/**
 * Domain: keys
 * Slash commands: /set-key, /list-keys, /clear-schedule
 *
 * Split from handlers/commandHandler.js (v3.9.9 refactor).
 * Behavior: give a user a key + role + extended schedule, list keys, delete schedules/keys.
 *
 * v3.9.0: scoped per guild (clear-schedule does not wipe cross-guild).
 * v3.9.8: track roles that failed to be removed in clear-schedule.
 */

const {
    EmbedBuilder,
    MessageFlags,
    getConfig,
    addKey,
    findAllByUser,
    findAllSchedulesByUser,
    formatKeysForUser,
    removeAllKeysByUser,
    scheduleRoleRemoval,
    removeAllSchedulesByUser,
    parsePriceNum,
    trackPurchase,
    sendInvoice,
    logAudit,
    safeEditReply,
    getActiveKeysByUserAndRole
} = require('./_shared');
// v3.9.22: formatRemaining is imported directly from keyManager (not in _shared).
const { formatRemaining } = require('../data/keyManager');

module.exports = async function (interaction) {
    const config = getConfig();

    // ====================================================
    // === /set-key — GIVE KEY + ROLE + EXTEND SCHEDULE ===
    // ====================================================
    if (interaction.commandName === 'set-key') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const value = interaction.options.getString('value');
        // v3.9.38 FIX (FIX 5b): trim input + reject empty/whitespace keys BEFORE
        // any side effects (addKey/role/DM/invoice). Discord only validates
        // required/minLength as a client-side string check — "   " (spaces only) slips through.
        const keyValue = (interaction.options.getString('key') || '').trim();
        if (!keyValue) {
            return safeEditReply(interaction, { content: '❌ Key cannot be empty.' });
        }

        const product = config.products.find(p => p.value === value);
        if (!product) {
            return safeEditReply(interaction, {
                content: `❌ Product value \`${value}\` not found. Use \`/list-products\` to see the list.`
            });
        }
        if (!product.roleId) {
            return safeEditReply(interaction, {
                content: `❌ Product **${product.label}** has no auto-role yet. Use \`/set-product-role\` first.`
            });
        }

        const guild = interaction.guild;
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member) {
            return safeEditReply(interaction, { content: `❌ User <@${user.id}> is not on this server.` });
        }
        const role = guild.roles.cache.get(product.roleId);
        if (!role) {
            return safeEditReply(interaction, {
                content: `❌ Role ID \`${product.roleId}\` not found in this guild.`
            });
        }

        // 1. Save the key to the database. Wrap in try/catch so the admin gets a clear error
        // (if it fails, no role granted, no schedule created — state is still clean).
        let keyEntry;
        try {
            keyEntry = addKey({
                key: keyValue,
                userId: member.id,
                username: member.user.tag,
                roleId: role.id,
                productName: product.label,
                days: product.days || 0,
                guildId: interaction.guild.id
            });
        } catch (keyErr) {
            console.error('addKey failed:', keyErr);
            return safeEditReply(interaction, {
                content: `❌ Failed to save the key to the database: ${keyErr.message}\n\nCheck disk space and file permissions for \`data/keys.json\`. No role was granted, no schedule was created.`
            });
        }

        // 2. Give the member the role
        try {
            if (!member.roles.cache.has(role.id)) {
                await member.roles.add(role);
            }
        } catch (_err) {
            return safeEditReply(interaction, {
                content:
                    `❌ Failed to add role ${role}. Make sure the bot role is ABOVE that role.\n\n` +
                    `⚠️ **Key saved WITHOUT the role.** Once the bot role is fixed, an admin can:\n` +
                    `• Manually add the role to the member, or\n` +
                    `• Delete this key via \`/clear-schedule clear_keys:true\` then set the key again.`
            });
        }

        // 3. Schedule auto-expire (MAX EXTEND). Wrap in try/catch — if it fails, the role + key
        // are already saved. Show a warning so the admin knows the role won't auto-expire.
        let schedResult;
        let scheduleWarning = '';
        try {
            schedResult = scheduleRoleRemoval({
                userId: member.id,
                roleId: role.id,
                guildId: guild.id,
                days: product.days || 0,
                expireAt: keyEntry.expireAt,
                productName: product.label
            });
        } catch (schedErr) {
            console.error('scheduleRoleRemoval failed:', schedErr);
            schedResult = { extended: false, permanent: false };
            scheduleWarning = `\n⚠️ **Failed to create the auto-expire schedule:** ${schedErr.message}. The role will not auto-expire — an admin must remove it manually.`;
        }

        // 4. DM the member
        // v3.9.22: /set-key was originally meant for GIFTs (a present from admin to member),
        // NOT a purchase transaction. So the DM says "you got a gift" — not
        // "transaction complete" (that's only for the ticket Set Key flow).
        // Format stays the same: emoji + role.name (not a mention) + inline code
        // for the key (mobile-friendly tap-to-copy).
        let dmSent = false;
        try {
            let expireInfo;
            if (keyEntry.expireAt === null) {
                expireInfo = 'permanent (never expires)';
            } else {
                const days = Math.ceil((keyEntry.expireAt - Date.now()) / 86400000);
                expireInfo = `${days} days left`;
            }

            // Check all active keys for extra info
            // v3.9.31: pass guildId (optional) so it stays guild-scoped, consistent with the other patterns.
            const activeKeys = getActiveKeysByUserAndRole(member.id, role.id, Date.now(), guild.id);
            const keyList = activeKeys
                .map((k, i) => {
                    const rem = formatRemaining(k);
                    return `${i + 1}. \`${k.key}\` (${rem} left)`;
                })
                .join('\n');

            // v3.9.17 FIX: sanitize backticks in keyValue.
            const safeKey = keyValue.replace(/`/g, "'");

            await member.send({
                content:
                    `Hi ${member.user.username}! You got a gift from the admin 🎁\n\n` +
                    `📦 Product: ${product.label}\n` +
                    `🌐 Server: ${guild.name}\n\n` +
                    `🔑 KEY:\n` +
                    `\`${safeKey}\`\n\n` +
                    `🎭 Role: ${role.name}\n` +
                    `⏰ Expires: ${expireInfo}\n\n` +
                    `📋 Your active keys for this role:\n${keyList}\n\n` +
                    `💡 Keep your key safe. If the role suddenly disappears while your key is still active, contact an admin.`
            });
            dmSent = true;
        } catch (_) {}

        // 5. P2-1 FIX: send an invoice too (previously only the set key modal sent one,
        //    the /set-key slash command skipped it — inconsistent transaction records).
        let invoiceSent = false;
        try {
            // Use a pseudo-channel from the guild to access invoiceChannel.
            // sendInvoice gets the channel from channel.guild.channels.cache,
            // so we pass interaction.channel (the channel the command ran in).
            if (interaction.channel && interaction.channel.guild) {
                invoiceSent = await sendInvoice(
                    interaction.channel,
                    member.id,
                    product.label,
                    product.price,
                    interaction.user
                );
            }
        } catch (err) {
            console.warn('Failed to send invoice from /set-key:', err.message);
        }

        // 6. Track the purchase for stats
        // v3.9.4: scoped per guild
        try {
            trackPurchase(interaction.guild.id, member.id, parsePriceNum(product.price));
        } catch (_) {}

        // 7. Audit log (P1-10 FIX: previously there was no logAudit for SET_KEY)
        // v3.9.1 FIX: don't leak the key (even partially) to the audit log channel.
        // Previously `keyValue.slice(0, 8)` leaked the first 8 chars of the key, which
        // could be guessed by anyone with access to the audit-log channel. Now
        // only the key length is shown (for debugging); the key value is hidden.
        await logAudit(interaction.client, {
            action: 'SET_KEY',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Set key for <@${member.id}> — product: **${product.label}**, role: ${role.name}, key: \`***\` (len=${keyValue.length})`,
            guildId: interaction.guild.id
        });

        const expireStr =
            keyEntry.expireAt === null ? 'permanent' : `${Math.ceil((keyEntry.expireAt - Date.now()) / 86400000)} days`;
        // v3.9.26 FIX: show a truncated key in the confirmation reply. A key can be
        // 200 char; the reply wrapper (+other info) pushes it past 2000 → 50035 AFTER all
        // operations succeed → the admin sees a generic error and might retry (duplicate key).
        const keyDisplay = keyValue.length > 80 ? `${keyValue.slice(0, 60)}…(${keyValue.length} char)` : keyValue;
        return safeEditReply(interaction, {
            content:
                `✅ **Set Key successful!**\n\n` +
                `👤 User: ${member}\n` +
                `📦 Product: ${product.label}\n` +
                `🔑 Key: \`${keyDisplay}\`\n` +
                `🎭 Role: ${role}\n` +
                `⏰ Expires: ${expireStr}\n` +
                `${schedResult.extended ? '↳ Schedule extended (MAX EXTEND).' : schedResult.permanent ? '↳ Permanent, old schedule removed.' : '↳ New schedule created.'}\n` +
                `${dmSent ? '📬 DM sent.' : '⚠️ DM failed (DMs closed).'}\n` +
                `${invoiceSent ? '🧾 Invoice sent.' : '⚠️ Invoice not sent (invoice channel not set yet).'}` +
                scheduleWarning
        });
    }

    // ====================================================
    // === /list-keys — VIEW ALL OF A USER'S KEYS ===
    // ====================================================
    if (interaction.commandName === 'list-keys') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');

        // v3.9.8 FIX: guild-scoped. Previously it used findAllByUser(userId) which
        // returned ALL of the user's keys across ALL guilds → a Guild A admin could see
        // keys the user bought in Guild B (cross-guild information disclosure).
        const allKeys = findAllByUser(user.id, interaction.guild.id);
        if (allKeys.length === 0) {
            return safeEditReply(interaction, { content: `📭 <@${user.id}> has no keys on this server.` });
        }

        // Split into active & expired
        const now = Date.now();
        const active = allKeys.filter(k => k.expireAt === null || k.expireAt > now);
        const expired = allKeys.filter(k => k.expireAt !== null && k.expireAt <= now);

        const fields = [];
        if (active.length > 0) {
            fields.push({
                name: `✅ Active Keys (${active.length})`,
                value: formatKeysForUser(active, now).slice(0, 1024),
                inline: false
            });
        }
        if (expired.length > 0) {
            fields.push({
                name: `⏰ Expired Keys (${expired.length}) — will be auto-deleted`,
                value: formatKeysForUser(expired, now).slice(0, 1024),
                inline: false
            });
        }

        const embed = new EmbedBuilder()
            .setTitle(`🔑 Key List — ${user.tag}`)
            .setDescription(`Total: **${allKeys.length}** key (${active.length} active, ${expired.length} expired)`)
            .setColor(0x5865f2)
            .addFields(fields)
            .setFooter({
                text: interaction.client.user.username,
                iconURL: interaction.client.user.displayAvatarURL({ dynamic: true })
            })
            .setTimestamp();
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ====================================================
    // === /clear-schedule — DELETE SCHEDULES (+ KEYS) ===
    // ====================================================
    // v3.9.0 FIX: pass guildId so a cross-guild wipe can't happen.
    // Previously, removeAllByUser/removeAllKeysByUser only filtered by userId,
    // meaning a Guild A admin could wipe a user's keys + schedules in Guild B.
    if (interaction.commandName === 'clear-schedule') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('user');
        const clearKeys = interaction.options.getBoolean('clear_keys') || false;
        const guildId = interaction.guild.id; // v3.9.0: scope to this guild only

        // v3.9.31 FIX: snapshot this user's roleIds BEFORE the schedules/keys are deleted
        // (via the data layer API). Used below to know which roles need to be
        // removed. Taking the snapshot AFTER deletion is too late (the data is
        // already gone) — that's what triggered the old fs workaround.
        const userScheduledRoleIds = new Set(
            findAllSchedulesByUser(user.id)
                .filter(e => e && e.roleId && (!e.guildId || e.guildId === guildId))
                .map(e => e.roleId)
        );
        const userKeyRoleIds = new Set(
            findAllByUser(user.id, guildId)
                .filter(k => k && k.roleId)
                .map(k => k.roleId)
        );

        // Delete all of the user's schedules IN THIS GUILD only
        const removedSched = removeAllSchedulesByUser(user.id, guildId);

        // Delete keys if requested (also scoped to guild)
        let removedKeys = 0;
        if (clearKeys) {
            removedKeys = removeAllKeysByUser(user.id, guildId);
        }

        // Optional: remove all roles tied to schedules?
        // v3.9.17: scan config.products TOO (not just scheduledRoles), because
        // a user's schedule may already have been deleted/expired — the old role sticks
        // around forever if the product was removed from config.
        const rolesRemoved = [];
        const rolesFailed = []; // v3.9.8: track roles that failed to be removed
        if (clearKeys) {
            const guild = interaction.guild;
            const member = await guild.members.fetch(user.id).catch(() => null);
            if (member) {
                // v3.9.17: collect roleIds from 2 sources:
                //   1. config.products (still present in config)
                //   2. this user's schedules/keys (snapshot before deletion — see above)
                //      — may contain roleIds for products already removed from config
                //
                // v3.9.31 FIX (two problems at once, replacing the old fs block):
                //   1. LAYERING — the old block read data/scheduledRoles.json DIRECTLY
                //      via fs + a hardcoded path, bypassing the roleScheduler API. If the
                //      path/schema changed, the code failed silently (catch ignore).
                //   2. HEURISTIC TOO BROAD — the old block collected roleIds from
                //      ALL scheduledRoles entries (including OTHER USERS') → a member's
                //      manual role that happened to match another user's scheduled VIP role
                //      got removed too. Now: role candidates = this user's own
                //      snapshot (schedules + keys), plus config.products.
                const productRoleIds = new Set((config.products || []).filter(p => p.roleId).map(p => p.roleId));
                for (const rid of userScheduledRoleIds) productRoleIds.add(rid);
                for (const rid of userKeyRoleIds) productRoleIds.add(rid);

                for (const rid of productRoleIds) {
                    if (member.roles.cache.has(rid)) {
                        try {
                            await member.roles.remove(rid);
                            const r = guild.roles.cache.get(rid);
                            rolesRemoved.push(r ? r.name : rid);
                        } catch (_err) {
                            // v3.9.8 FIX: track failures. Previously the catch swallowed the
                            // error silently → the admin was told "Clear complete" while the role
                            // stayed forever (the schedule was already deleted, no auto-expire).
                            const r = guild.roles.cache.get(rid);
                            rolesFailed.push(r ? r.name : rid);
                        }
                    }
                }
            }
        }

        const msg =
            `🧹 **Clear complete!**\n\n` +
            `👤 User: <@${user.id}>\n` +
            `📋 Schedules removed (this guild): **${removedSched}**\n` +
            (clearKeys
                ? `🔑 Keys removed (this guild): **${removedKeys}**\n` +
                  (rolesRemoved.length > 0
                      ? `🎭 Roles removed: ${rolesRemoved.map(n => `\`${n}\``).join(', ')}\n`
                      : '') +
                  (rolesFailed.length > 0
                      ? `⚠️ Roles FAILED to remove (bot hierarchy / permissions): ${rolesFailed.map(n => `\`${n}\``).join(', ')} — REMOVE THEM MANUALLY!\n`
                      : '')
                : `ℹ️ Keys NOT removed (clear_keys=false). Use \`clear_keys:true\` for a full VIP reset.\n`);

        await logAudit(interaction.client, {
            action: 'CLEAR_SCHEDULE',
            actorId: interaction.user.id,
            actorTag: interaction.user.tag,
            details: `Clear schedules for <@${user.id}> in guild ${guildId}: ${removedSched} schedule(s)${clearKeys ? ` + ${removedKeys} key(s)${rolesRemoved.length > 0 ? ` + ${rolesRemoved.length} role(s)` : ''}` : ' (without keys)'}`,
            guildId: interaction.guild.id
        });

        return safeEditReply(interaction, { content: msg });
    }
};
