/**
 * Role Engine — THE single gateway for every role grant/revoke in Thor.
 *
 * v3.22.0: before this module, 13+ call sites did raw `member.roles.add/remove`
 * each with its own try/catch and error message (verify button, self-role
 * panels, the unverified join grant, booster role, VIP keys, product
 * delivery, leveling, temp-role scheduler, the DASH API…). The engine
 * centralizes what they all duplicated:
 *
 *   - resolve the role (skip gracefully when the guild cache is unavailable)
 *   - reject @everyone, integration-managed roles, and roles positioned
 *     above the bot's highest role (the #1 "silent failure" support report)
 *   - skip roles the member already has / doesn't have (idempotent)
 *   - log ONE actionable console line per failure
 *
 * Callers keep their own user-facing messages — the engine only returns a
 * structured result:
 *
 *   grantRoles(member, ['id1','id2'], { reason }) →
 *     { ok: boolean, granted: Role[]|string[], skipped: [...], failed: [...] }
 *
 * `ok` is true when NOTHING failed (skips are not failures). Test-friendly:
 * when `member.guild.roles.cache` is missing (unit-test fakes), the role
 * object checks are skipped and the raw id is passed to discord.js.
 */

// ---------- internal helpers ----------

/** Resolve a role object from the guild cache — null when unavailable. */
function resolveRole(member, roleId) {
    try {
        return member?.guild?.roles?.cache?.get(roleId) || null;
    } catch (_) {
        return null;
    }
}

/**
 * The bot's highest role position in this guild — null when UNKNOWN
 * (members.me not cached yet / partial state). The hierarchy check is only
 * enforced when the position is actually known — a null must fall back to
 * "let Discord's API decide" (the pre-engine behavior), otherwise every
 * grant would be rejected right after startup while the member cache is
 * still warming up.
 */
function botHighestPosition(member) {
    try {
        const pos = member?.guild?.members?.me?.roles?.highest?.position;
        return typeof pos === 'number' ? pos : null;
    } catch (_) {
        return null;
    }
}

/** Standard per-role validation shared by grant & revoke. */
function validateRole(member, roleId, role) {
    if (role && role.id === member.guild.id) return '@everyone cannot be assigned.';
    if (role && role.managed) return `"${role.name}" is managed by another integration — the bot cannot assign it.`;
    // Hierarchy: only enforced when the bot's position is KNOWN (see
    // botHighestPosition) — unknown → let Discord's API decide.
    const botPos = botHighestPosition(member);
    if (role && botPos !== null && (role.position ?? 0) >= botPos) {
        return `"${role.name}" is positioned ABOVE the bot's highest role — move the bot role up first.`;
    }
    return null; // valid
}

/**
 * Apply add/remove for a list of role ids through ONE discord.js call each.
 * `mode` = 'add' | 'remove'. Never throws — failures land in `failed`.
 */
async function apply(member, roleIds, mode, options = {}) {
    const reason = options.reason ? String(options.reason).slice(0, 400) : undefined;
    const quiet = options.quiet === true;
    const result = { ok: true, granted: [], revoked: [], skipped: [], failed: [] };

    if (!member || !member.roles || typeof member.roles[mode] !== 'function') {
        result.ok = false;
        result.failed.push({ roleId: String(roleIds || ''), error: 'member object is not usable' });
        return result;
    }
    if (!Array.isArray(roleIds) || roleIds.length === 0) return result;

    // Dedupe while preserving order (a join list may repeat an id).
    const seen = new Set();
    const ids = roleIds.filter(id => {
        if (id == null || seen.has(id)) return false;
        seen.add(id);
        return true;
    });

    const toApply = [];
    for (const roleId of ids) {
        const role = resolveRole(member, roleId);

        // Idempotency: already-has (add) / doesn't-have (remove) → skip silently.
        try {
            const has = member.roles.cache?.has?.(roleId);
            if (has === true && mode === 'add') {
                result.skipped.push(roleId);
                continue;
            }
            if (has === false && mode === 'remove') {
                result.skipped.push(roleId);
                continue;
            }
        } catch (_) {
            /* cache unavailable → let discord.js decide */
        }

        const invalid = validateRole(member, roleId, role);
        if (invalid) {
            result.ok = false;
            result.failed.push({ roleId, error: invalid });
            continue;
        }
        toApply.push(roleId);
    }

    let appliedViaRetry = false;
    if (toApply.length > 0) {
        try {
            await member.roles[mode](toApply.length === 1 ? toApply[0] : toApply, reason ? { reason } : undefined);
        } catch (err) {
            // One bad role in a batch can fail the whole API call — retry
            // per-role so the good roles still land.
            if (toApply.length > 1) {
                appliedViaRetry = true;
                for (const roleId of toApply) {
                    try {
                        await member.roles[mode](roleId, reason ? { reason } : undefined);
                        if (mode === 'add') result.granted.push(roleId);
                        else result.revoked.push(roleId);
                    } catch (perErr) {
                        result.ok = false;
                        result.failed.push({ roleId, error: perErr.message });
                    }
                }
            } else {
                result.ok = false;
                result.failed.push({ roleId: toApply[0], error: err.message });
            }
        }
    }

    // The single batch call succeeded → everything in toApply landed.
    if (!appliedViaRetry) {
        if (mode === 'add') result.granted.push(...toApply);
        else result.revoked.push(...toApply);
    }

    if (!quiet && result.failed.length > 0) {
        console.error(
            `❌ [roleEngine] ${mode} failed for ${member.user?.tag ?? member.id ?? '?'}: ` +
                result.failed.map(f => `${f.roleId} (${f.error})`).join(', ')
        );
    }
    return result;
}

// ---------- public API ----------

/** Grant roles to a member. Returns { ok, granted, skipped, failed }. */
function grantRoles(member, roleIds, options = {}) {
    return apply(member, roleIds, 'add', options);
}

/** Revoke roles from a member. Returns { ok, revoked, skipped, failed }. */
function revokeRoles(member, roleIds, options = {}) {
    return apply(member, roleIds, 'remove', options);
}

module.exports = { grantRoles, revokeRoles };
