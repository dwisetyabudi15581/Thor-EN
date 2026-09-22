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
//   1. Session login (currentUser) + LIVE tier resolution (guild-access):
//      v3.30.0 RBAC — tier 3 (owner/ManageGuild/bot admin) may write
//      everything; tier 2 (staff) may only call the moderation whitelist;
//      tier 1 (member) is read-only → 403.
//   2. The body is read, the logged-in user's `actor: { id, tag, tier }` is
//      injected (bot-side audit + defense-in-depth tier re-check), then
//      forwarded to the DASH API on localhost with the secret token.
//   3. The bot re-validates EVERY field (section whitelist + types) —
//      the web is never trusted about the shape of data.

import { currentUser, json, jsonError } from "@/lib/api-auth";
import { botApi, BotOfflineError, BotApiError } from "@/lib/bot-api";
import { resolveGuildAccess } from "@/lib/guild-access";

type Ctx = { params: Promise<{ guildId: string; action: string[] }> };

// v3.30.0 RBAC: the STAFF tier's write whitelist — the daily moderation
// actions, mirroring STAFF_COMMANDS on the Discord side (router gate).
// Everything else (config, products, keys, panels, giveaways...) is tier 3.
const STAFF_ACTIONS = new Set(["moderate", "purge", "warn", "warns/remove", "warns/clear"]);

async function handle(req: Request, ctx: Ctx, method: "POST" | "PUT" | "DELETE") {
  const user = await currentUser(req);
  if (!user) return jsonError("Not logged in.", 401);

  const { guildId, action } = await ctx.params;
  if (!/^\d{5,25}$/.test(guildId)) return jsonError("Invalid server ID.", 400);
  const actionPath = action.join("/");
  if (!/^[a-zA-Z0-9_\/-]{1,80}$/.test(actionPath)) return jsonError("Invalid action.", 400);

  // v3.30.0: three-tier resolution (OAuth manageable → bot access endpoint).
  const access = await resolveGuildAccess(user.id, user.discordId, guildId);
  if (!access.ok) return jsonError(access.error, access.status);

  if (access.tier === 1) {
    return jsonError("Members have a read-only profile view — ask an admin for staff access to moderate.", 403);
  }
  if (access.tier === 2 && !STAFF_ACTIONS.has(actionPath)) {
    return jsonError(
      "Staff access covers moderation actions only (warn, kick, ban, timeout, purge). Ask an admin for the rest.",
      403
    );
  }

  // Read the JSON body (if any) + inject the actor (with its tier — the bot
  // re-checks tiers it can resolve itself, defense-in-depth).
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
      body: method === "DELETE" ? undefined : { ...body, actor: { id: user.discordId, tag: user.username, tier: access.tier } },
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
