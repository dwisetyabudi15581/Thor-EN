// GET /api/guilds/[guildId]/dashboard — the full payload of all modules for
// the server dashboard (config, automod, responders, selfroles, tempvoice,
// announces, serverstats) + guild meta (channels/roles for pickers).
//
// Access: the user MUST be owner / ManageGuild on that server (verified
// live against Discord, see lib/guild-access.ts).

import { currentUser, json, jsonError } from "@/lib/api-auth";
import { botApi, BotOfflineError } from "@/lib/bot-api";
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
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonError(message, 502);
  }
}
