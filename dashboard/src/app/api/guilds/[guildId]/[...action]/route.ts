// Write proxy /api/guilds/[guildId]/[...action] — a single gate for ALL
// dashboard write operations to the bot DASH API (v3.16.0).
//
// Peta route → DASH API (bot):
//   PUT    config                                → PUT  /guilds/:id/config
//   PUT    automod                               → PUT  /guilds/:id/automod
//   POST   responders                            → POST /guilds/:id/responders
//   DELETE responders?trigger=...                → DELETE /guilds/:id/responders?trigger=...
//   POST   announce                              → POST /guilds/:id/announce
//   DELETE announce/:annId                       → DELETE /guilds/:id/announce/:annId
//   POST   selfroles                             → POST /guilds/:id/selfroles
//   POST   selfroles/:panelId/roles              → POST /guilds/:id/selfroles/:panelId/roles
//   DELETE selfroles/:panelId/roles?roleId=...   → DELETE .../roles?roleId=...
//   DELETE selfroles/:panelId                    → DELETE /guilds/:id/selfroles/:panelId
//   POST   serverstats/refresh                   → POST /guilds/:id/serverstats/refresh
//   DELETE tempvoice                             → DELETE /guilds/:id/tempvoice
//
// Security:
//   1. Session login (currentUser) + LIVE ManageGuild/owner verification
//      against Discord (guild-access) — users cannot write to other servers.
//   2. The body is read, the logged-in user's `actor: { id, tag }` is
//      injected (bot-side audit), then forwarded to the DASH API on
//      localhost with the secret token.
//   3. The bot re-validates EVERY field (section whitelist + types) —
//      the web is never trusted about the shape of data.

import { currentUser, json, jsonError } from "@/lib/api-auth";
import { botApi, BotOfflineError, BotApiError } from "@/lib/bot-api";
import { checkGuildAccess } from "@/lib/guild-access";

type Ctx = { params: Promise<{ guildId: string; action: string[] }> };

async function handle(req: Request, ctx: Ctx, method: "POST" | "PUT" | "DELETE") {
  const user = await currentUser(req);
  if (!user) return jsonError("Not logged in.", 401);

  const { guildId, action } = await ctx.params;
  if (!/^\d{5,25}$/.test(guildId)) return jsonError("Invalid server ID.", 400);
  const actionPath = action.join("/");
  if (!/^[a-zA-Z0-9_\/-]{1,80}$/.test(actionPath)) return jsonError("Invalid action.", 400);

  const access = await checkGuildAccess(user.id, guildId);
  if (!access.ok) return jsonError(access.error, access.status);

  // Read the JSON body (if any) + inject the actor.
  let body: Record<string, unknown> = {};
  if (method !== "DELETE" && req.headers.get("content-type")?.includes("application/json")) {
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError("The body is not valid JSON.", 400);
    }
  }

  const url = new URL(req.url);
  const target = `/guilds/${guildId}/${actionPath}${url.search}`;

  try {
    const data = await botApi(target, {
      method,
      body: method === "DELETE" ? undefined : { ...body, actor: { id: user.discordId, tag: user.username } },
    });
    return json(data);
  } catch (err) {
    if (err instanceof BotOfflineError) {
      return jsonError("The bot is not connected — changes were not saved.", 503);
    }
    if (err instanceof BotApiError) {
      return json({ error: err.message, details: err.details }, err.status >= 400 && err.status < 600 ? err.status : 502);
    }
    return jsonError("Unknown error while contacting the bot.", 502);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  return handle(req, ctx, "POST");
}

export async function PUT(req: Request, ctx: Ctx) {
  return handle(req, ctx, "PUT");
}

export async function DELETE(req: Request, ctx: Ctx) {
  return handle(req, ctx, "DELETE");
}
