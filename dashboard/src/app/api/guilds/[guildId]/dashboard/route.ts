// GET /api/guilds/[guildId]/dashboard — the full payload of all modules for
// the server dashboard (config, automod, responders, selfroles, tempvoice,
// announces, serverstats) + guild meta (channels/roles for pickers).
//
// Access: the user MUST be owner / ManageGuild on that server (verified
// live against Discord, see lib/guild-access.ts).

import { currentUser, json, jsonError } from "@/lib/api-auth";
import { botApi, BotApiError, BotOfflineError } from "@/lib/bot-api";
import { checkGuildAccess } from "@/lib/guild-access";
import type { DashboardPayload, GuildMeta } from "@/lib/bot-api";

export async function GET(req: Request, { params }: { params: Promise<{ guildId: string }> }) {
  const user = await currentUser(req);
  if (!user) return jsonError("Not logged in.", 401);

  const { guildId } = await params;
  if (!/^\d{5,25}$/.test(guildId)) return jsonError("Invalid server ID.", 400);

  const access = await checkGuildAccess(user.id, guildId);
  if (!access.ok) {
    return jsonError(access.error, access.status);
  }

  try {
    const [payload, meta] = await Promise.all([
      botApi<DashboardPayload>(`/guilds/${guildId}/dashboard`),
      botApi<GuildMeta>(`/guilds/${guildId}/meta`),
    ]);
    return json({ ...payload, meta, botOnline: true });
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
