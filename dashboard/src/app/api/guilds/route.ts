// GET /api/guilds — the list of servers the user can manage .
//
// Merges THREE sources:
//   1. Discord API (user token) — guilds + ManageGuild/owner permission.
//   2. Bot DASH API — guilds where the bot is already present (for the
//      badge + "Manage" vs "Invite" buttons).
//   3. Bot health — connection status banner.
//
// Response: { botOnline, botVersion?, guilds: [{id,name,icon,owner,botIn}],
//             inviteUrl, guildsError?: "no-token" | "relogin" | "discord-error" }

import { currentUser, json, jsonError } from "@/lib/api-auth";
import { cfg } from "@/lib/config";
import { botApi, BotOfflineError, type BotGuild } from "@/lib/bot-api";
import { getManageableGuilds } from "@/lib/discord-guilds";

/**
 * Demo adoption (sandbox): if what runs at DASH_API_URL is the MOCK
 * (scripts/mock-dash-api.mjs), register the user's guilds so their real
 * servers can be previewed in the dashboard. The REAL bot has no
 * /__demo/adopt endpoint → 404 → silently ignored (self-detecting, safe
 * for production).
 */
async function tryDemoAdopt(guilds: Array<{ id: string; name: string; icon: string | null }>): Promise<void> {
  if (guilds.length === 0) return;
  try {
    await botApi("/__demo/adopt", {
      method: "POST",
      body: { guilds },
      timeoutMs: 2500,
    });
  } catch {
    // Real bot / offline — ignore (not an error).
  }
}

export async function GET(req: Request) {
  const user = await currentUser(req);
  if (!user) return jsonError("Not logged in.", 401);

  // Bot health + bot guild list (parallel, offline-tolerant).
  let botOnline = false;
  let botVersion: string | undefined;
  let botGuildIds = new Set<string>();
  try {
    const [health, guildsRes] = await Promise.all([
      botApi<{ ok: boolean; version: string }>("/health", { timeoutMs: 4000 }),
      botApi<{ guilds: BotGuild[] }>("/guilds", { timeoutMs: 4000 }),
    ]);
    botOnline = Boolean(health?.ok);
    botVersion = health?.version;
    if (Array.isArray(guildsRes?.guilds)) {
      botGuildIds = new Set(guildsRes.guilds.map((g) => g.id));
    }
  } catch (err) {
    if (!(err instanceof BotOfflineError)) {
      console.error("[api/guilds] DASH API error:", err instanceof Error ? err.message : err);
    }
  }

  const result = await getManageableGuilds(user.id);

  // Sandbox demo: if the DASH API target is the mock, adopt the user's
  // guilds for a realistic preview (real bot → 404 → no-op).
  if (botOnline && botVersion?.startsWith("mock") && result.ok) {
    await tryDemoAdopt(result.guilds);
    // Re-fetch the mock guild list, which now includes the user's guilds.
    try {
      const guildsRes = await botApi<{ guilds: BotGuild[] }>("/guilds", { timeoutMs: 4000 });
      if (Array.isArray(guildsRes?.guilds)) {
        botGuildIds = new Set(guildsRes.guilds.map((g) => g.id));
      }
    } catch { /* keep */ }
  }
  if (!result.ok) {
    // Still send bot info so the UI can render the status banner,
    // but with an empty guild list + error flag (UI asks to re-login if needed).
    return json({
      botOnline,
      botVersion,
      guilds: [],
      inviteUrl: cfg.inviteUrl,
      guildsError: result.reason,
    });
  }

  const guilds = result.guilds.map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    owner: g.owner,
    botIn: botGuildIds.has(g.id),
  }));

  return json({ botOnline, botVersion, guilds, inviteUrl: cfg.inviteUrl });
}
