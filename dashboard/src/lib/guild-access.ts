// Guild access verification for every /api/guilds/** route.
//
// v3.30.0 RBAC — THREE tiers, resolved in this order:
//   1. Tier 3 (admin): owner OR MANAGE_GUILD on Discord — verified LIVE via
//      the user's OAuth token (the industry standard, unchanged since v3.16).
//   2. Otherwise the BOT decides: GET /guilds/:id/access/:discordId resolves
//      the tier from config.access (staff/admin role & user lists) + live
//      Discord permissions from the gateway cache. Tier 2 = staff
//      (moderation), tier 1 = member (personal profile view).
//   3. Tier 0 (not a member / bot not in guild) → 403.
//
// The bot is the single source of truth for tiers 2/1 — the same resolver
// the slash-command router uses — so the web and Discord can NEVER disagree.
//
// The manageable-guild list keeps its 60s cache (rapid-fire form saves);
// the bot tier lookup is NOT cached further: it is a localhost call and
// freshness matters (a role change should reflect on the next request).

import { getManageableGuilds } from "./discord-guilds";
import { botApi, BotOfflineError, BotApiError } from "./bot-api";

type CacheEntry = { ids: Set<string>; ts: number };

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export type GuildTier = 1 | 2 | 3;

export type GuildAccess =
  | { ok: true; tier: GuildTier }
  | { ok: false; status: 401 | 403 | 503; error: string; relogin?: boolean };

/** How the OAuth manageable-guild lookup went. */
type ManageableOutcome =
  | { kind: "ids"; ids: Set<string> } // got the list
  | { kind: "soft" } // no-token / discord-error → the bot path may still know the user
  | { kind: "relogin" }; // revoked/missing scope — hard stop

async function manageableOutcome(userId: string): Promise<ManageableOutcome> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && now - hit.ts < TTL_MS) return { kind: "ids", ids: hit.ids };

  const result = await getManageableGuilds(userId);
  if (!result.ok) {
    // "no-token": the session predates the guilds scope — that alone must NOT
    // lock out staff/member tiers (the bot resolves those by membership).
    // "relogin": the token was revoked / scope refused — a hard 401.
    // "discord-error": Discord is unreachable — try the bot before giving up.
    return result.reason === "relogin" ? { kind: "relogin" } : { kind: "soft" };
  }

  const ids = new Set(result.guilds.map((g) => g.id));
  cache.set(userId, { ids, ts: now });
  return { kind: "ids", ids };
}

/**
 * Resolve the user's access tier for one guild.
 * @param userId    the dashboard user row id (OAuth token lookup)
 * @param discordId the user's Discord ID (the bot resolves membership by this)
 */
export async function resolveGuildAccess(userId: string, discordId: string, guildId: string): Promise<GuildAccess> {
  if (!discordId) {
    return {
      ok: false,
      status: 401,
      error: "Your session has no Discord identity — please log in again.",
      relogin: true,
    };
  }

  // 1) OAuth fast path: owner / ManageGuild → tier 3 (admin).
  let oauth: ManageableOutcome;
  try {
    oauth = await manageableOutcome(userId);
  } catch {
    oauth = { kind: "soft" }; // unexpected OAuth failure — the bot still gets a chance
  }
  if (oauth.kind === "ids" && oauth.ids.has(guildId)) return { ok: true, tier: 3 };
  if (oauth.kind === "relogin") {
    return { ok: false, status: 401, error: "Your Discord login has expired — please log in again.", relogin: true };
  }

  // 2) The bot is the source of truth for staff/member tiers.
  try {
    const data = await botApi<{ tier: number; label?: string }>(`/guilds/${guildId}/access/${discordId}`, {
      timeoutMs: 6000,
    });
    if (data?.tier === 3) return { ok: true, tier: 3 };
    if (data?.tier === 2) return { ok: true, tier: 2 };
    if (data?.tier === 1) return { ok: true, tier: 1 };
    // tier 0 — the user is not a member of this server (or the bot is not in it)
    return { ok: false, status: 403, error: "You are not a member of this server (or the bot is not in it)." };
  } catch (err) {
    if (err instanceof BotOfflineError) {
      return { ok: false, status: 503, error: "The bot is not connected — your access tier cannot be verified. Try again shortly." };
    }
    if (err instanceof BotApiError && err.status === 404) {
      return { ok: false, status: 403, error: "The bot is not in this server." };
    }
    return { ok: false, status: 503, error: "Could not verify your access — try again shortly." };
  }
}

/**
 * Backward-compatible wrapper: the pre-RBAC admin-only gate (OAuth only —
 * no Discord identity needed). Used where tier 3 is genuinely required
 * and no discordId is available.
 */
export async function checkGuildAccess(userId: string, guildId: string): Promise<GuildAccess> {
  let oauth: ManageableOutcome;
  try {
    oauth = await manageableOutcome(userId);
  } catch {
    return { ok: false, status: 503, error: "Discord is not responding right now — try again shortly." };
  }
  if (oauth.kind === "ids") {
    return oauth.ids.has(guildId)
      ? { ok: true, tier: 3 }
      : { ok: false, status: 403, error: "You don't have permission to manage this server." };
  }
  if (oauth.kind === "relogin") {
    return { ok: false, status: 401, error: "Your Discord login has expired — please log in again.", relogin: true };
  }
  return { ok: false, status: 503, error: "Discord is not responding right now — try again shortly." };
}

/** Clear a user's guild cache (used when the user switches accounts). */
export function invalidateGuildAccessCache(userId: string): void {
  cache.delete(userId);
}
