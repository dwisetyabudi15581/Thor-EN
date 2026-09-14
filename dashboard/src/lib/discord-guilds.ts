// The user's guild list via Discord OAuth (the `guilds` scope) — for the
// Dyno-style Server Picker page. Guilds are fetched LIVE from Discord (never
// copied into the DB) so servers the user just created/left are always
// accurate.
//
// Flow:
//   1. GET /users/@me/guilds with the user's access token (stored at login).
//   2. Expired token → one automatic refresh (refresh_token grant).
//   3. Filter manageable guilds: owner OR the MANAGE_GUILD permission
//      (0x20) — the same standard used by Dyno and other dashboards.
//   4. Intersect with the bot's guild list (DASH API) → mark which ones
//      already have the bot (manageable now) vs not (invite button).

import { db } from "./db";
import { cfg } from "./config";

const MANAGE_GUILD = 0x20;

export type UserGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  manageable: boolean; // owner || MANAGE_GUILD
};

type DiscordGuildEntry = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string; // bitfield string
};

type TokenRow = { id: string; accessToken: string | null; refreshToken: string | null; tokenExpiresAt: Date | null };

async function fetchUserGuilds(accessToken: string): Promise<DiscordGuildEntry[]> {
  const res = await fetch("https://discord.com/api/users/@me/guilds", {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw Object.assign(new Error(`discord_guilds_${res.status}`), { status: res.status });
  }
  return (await res.json()) as DiscordGuildEntry[];
}

/** Refresh the access token via the refresh_token grant; update the DB. Returns the new token. */
async function refreshAccessToken(userId: string, refreshToken: string): Promise<string> {
  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.discordClientId,
      client_secret: cfg.discordClientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`discord_refresh_${res.status}`), { status: res.status });
  }
  const tok = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!tok.access_token) throw new Error("discord_refresh_empty");
  await db.user.update({
    where: { id: userId },
    data: {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? refreshToken,
      tokenExpiresAt: new Date(Date.now() + (tok.expires_in ?? 604800) * 1000),
    },
  });
  return tok.access_token;
}

export type GuildListResult =
  | { ok: true; guilds: UserGuild[] }
  | { ok: false; reason: "no-token" | "relogin" | "discord-error" };

/**
 * Fetch the guilds the user can manage. If the user has no access token yet
 * (an old-era login without the guilds scope) → reason "no-token" (the UI
 * asks to re-login). If the refresh fails (token revoked) → "relogin".
 */
export async function getManageableGuilds(userId: string): Promise<GuildListResult> {
  const row: TokenRow | null = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, accessToken: true, refreshToken: true, tokenExpiresAt: true },
  });
  if (!row?.accessToken) return { ok: false, reason: "no-token" };

  const expired = row.tokenExpiresAt ? row.tokenExpiresAt.getTime() < Date.now() + 30_000 : false;

  let entries: DiscordGuildEntry[];
  try {
    if (!expired) {
      entries = await fetchUserGuilds(row.accessToken);
    } else {
      // Access token expired → refresh first (once).
      if (!row.refreshToken) return { ok: false, reason: "relogin" };
      const fresh = await refreshAccessToken(userId, row.refreshToken);
      entries = await fetchUserGuilds(fresh);
    }
  } catch (err) {
    const status = (err as { status?: number }).status;
    // 401 = the access token died before its expiry → try one more refresh.
    if (status === 401 && row.refreshToken) {
      try {
        const fresh = await refreshAccessToken(userId, row.refreshToken);
        entries = await fetchUserGuilds(fresh);
      } catch {
        return { ok: false, reason: "relogin" };
      }
    } else if (status === 403) {
      // The guilds scope was not granted (old session) → the user must re-login.
      return { ok: false, reason: "relogin" };
    } else {
      return { ok: false, reason: "discord-error" };
    }
  }

  const guilds: UserGuild[] = entries
    .map((g) => {
      const perms = BigInt(g.permissions || "0");
      const manageable = g.owner || (perms & BigInt(MANAGE_GUILD)) !== BigInt(0);
      return { id: g.id, name: g.name, icon: g.icon, owner: g.owner, manageable };
    })
    .filter((g) => g.manageable)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { ok: true, guilds };
}

/** Guild icon from the Discord CDN (the UI falls back to the first letter). */
export function guildIconUrl(guildId: string, icon: string | null, size = 64): string | null {
  if (!icon) return null;
  return `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=${size}`;
}
