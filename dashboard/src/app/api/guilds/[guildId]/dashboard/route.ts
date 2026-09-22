// GET /api/guilds/[guildId]/dashboard — the per-server dashboard payload.
//
// v3.30.0 RBAC — the payload follows the caller's tier:
//   tier 3 (admin)  → the FULL payload (+ meta), exactly as before.
//   tier 2 (staff)  → the moderation subset (the bot filters server-side —
//                     least privilege: config/keys/products simply don't ship).
//   tier 1 (member) → { tier: 1, member: <own profile> } — the UI renders the
//                     personal MemberView instead of the server dashboard.
//
// Tier resolution: resolveGuildAccess() (OAuth manageable OR the bot's
// access endpoint). The bot re-resolves the tier from `?actor=` itself —
// both sides must agree before sensitive data is shipped.

import { currentUser, json, jsonError } from "@/lib/api-auth";
import { botApi, BotApiError, BotOfflineError } from "@/lib/bot-api";
import { resolveGuildAccess } from "@/lib/guild-access";
import type { DashboardPayload, GuildMeta } from "@/lib/bot-api";

export async function GET(req: Request, { params }: { params: Promise<{ guildId: string }> }) {
  const user = await currentUser(req);
  if (!user) return jsonError("Not logged in.", 401);

  const { guildId } = await params;
  if (!/^\d{5,25}$/.test(guildId)) return jsonError("Invalid server ID.", 400);

  const access = await resolveGuildAccess(user.id, user.discordId, guildId);
  if (!access.ok) {
    return jsonError(access.error, access.status);
  }

  try {
    // v3.30.0: members get their own profile, not the server payload.
    if (access.tier === 1) {
      const [member, meta] = await Promise.all([
        botApi<Record<string, unknown>>(`/guilds/${guildId}/member/${user.discordId}`),
        // Meta is public Discord data (guild name/icon/channel names) — the
        // member view shows the server header. A meta failure is tolerated.
        botApi<GuildMeta>(`/guilds/${guildId}/meta`).catch(() => null),
      ]);
      return json({ tier: 1, member, meta, botOnline: true });
    }

    // Staff & admin: the actor param lets the bot re-resolve the tier itself
    // (defense-in-depth) and filter the payload for tier 2.
    const actorParam = user.discordId ? `?actor=${encodeURIComponent(user.discordId)}` : "";
    const [payload, meta] = await Promise.all([
      botApi<DashboardPayload & { tier?: number }>(`/guilds/${guildId}/dashboard${actorParam}`),
      botApi<GuildMeta>(`/guilds/${guildId}/meta`),
    ]);
    return json({ ...payload, tier: payload.tier ?? access.tier, meta, botOnline: true });
  } catch (err) {
    if (err instanceof BotOfflineError) {
      return jsonError("The bot is not connected — check the bot status, then try again.", 503);
    }
    // v3.28.3: pass the bot's own status through (404 = bot not in this
    // server, 401/403/422 …) instead of rewriting EVERY error to 502 — the
    // same contract the [...action] proxy already uses. The UI can now tell
    // "bot kicked from server" apart from a gateway failure.
    if (err instanceof BotApiError) {
      return jsonError(err.message, err.status >= 400 && err.status < 600 ? err.status : 502);
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonError(message, 502);
  }
}
