// Guild access verification for every /api/guilds/** route.
//
// Rule (Dyno standard): a user may only manage servers where they are the
// owner OR hold the MANAGE_GUILD permission on Discord — verified LIVE
// against the Discord API via the user's OAuth token, not just a claim in
// the request.
//
// In-memory 60-second cache per user so rapid-fire form saves don't hit
// the Discord API repeatedly (global rate limit of 50 guild-lists/sec).

import { getManageableGuilds } from "./discord-guilds";

type CacheEntry = { ids: Set<string>; ts: number };

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export type GuildAccess =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; error: string; relogin?: boolean };

export async function checkGuildAccess(userId: string, guildId: string): Promise<GuildAccess> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && now - hit.ts < TTL_MS) {
    return hit.ids.has(guildId)
      ? { ok: true }
      : { ok: false, status: 403, error: "You don't have permission to manage this server." };
  }

  const result = await getManageableGuilds(userId);
  if (!result.ok) {
    if (result.reason === "no-token") {
      return {
        ok: false,
        status: 401,
        error: "Your login session doesn't cover the server list yet — please log in again.",
        relogin: true,
      };
    }
    if (result.reason === "relogin") {
      return { ok: false, status: 401, error: "Your Discord login has expired — please log in again.", relogin: true };
    }
    return { ok: false, status: 503, error: "Discord is not responding right now — try again shortly." };
  }

  const ids = new Set(result.guilds.map((g) => g.id));
  cache.set(userId, { ids, ts: now });
  return ids.has(guildId)
    ? { ok: true }
    : { ok: false, status: 403, error: "You don't have permission to manage this server." };
}

/** Clear a user's guild cache (used when the user switches accounts). */
export function invalidateGuildAccessCache(userId: string): void {
  cache.delete(userId);
}
