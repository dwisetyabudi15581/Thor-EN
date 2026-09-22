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
  // v3.28.3: allSettled — /health is unauthenticated on the bot while
  // /guilds requires the token. With Promise.all, a token mismatch (the #1
  // setup mistake) rejected BOTH and the UI reported "bot offline" — the
  // opposite of the truth. Now botOnline derives from /health alone and a
  // /guilds failure is logged distinctly.
  let botOnline = false;
  let botVersion: string | undefined;
  let botGuildIds = new Set<string>();
  // v3.30.0: the bot's guild summaries as a map (id -> name/icon) — used to
  // enrich the bot-known member guilds that OAuth didn't list.
  let botGuildMetaById = new Map<string, BotGuild>();
  const [healthRes, guildsRes] = await Promise.allSettled([
    botApi<{ ok: boolean; version: string }>("/health", { timeoutMs: 4000 }),
    botApi<{ guilds: BotGuild[] }>("/guilds", { timeoutMs: 4000 }),
  ]);
  if (healthRes.status === "fulfilled") {
    botOnline = Boolean(healthRes.value?.ok);
    botVersion = healthRes.value?.version;
  } else if (!(healthRes.reason instanceof BotOfflineError)) {
    console.error("[api/guilds] DASH /health error:", healthRes.reason instanceof Error ? healthRes.reason.message : healthRes.reason);
  }
  if (guildsRes.status === "fulfilled" && Array.isArray(guildsRes.value?.guilds)) {
    botGuildIds = new Set(guildsRes.value.guilds.map((g) => g.id));
    botGuildMetaById = new Map(guildsRes.value.guilds.map((g) => [g.id, g]));
  } else if (guildsRes.status === "rejected" && !(guildsRes.reason instanceof BotOfflineError)) {
    console.error("[api/guilds] DASH /guilds error (is DASH_API_TOKEN correct?):", guildsRes.reason instanceof Error ? guildsRes.reason.message : guildsRes.reason);
  }

  const result = await getManageableGuilds(user.id);

  // v3.30.0 RBAC: guilds where the user is a MEMBER (any tier) according to
  // the bot — staff/member servers join the OAuth-manageable ones in the
  // picker. Best-effort: a bot offline / old-bot 404 keeps the OAuth-only
  // list (exactly the pre-RBAC behavior).
  let botUserGuilds: Array<{ id: string; tier: number }> = [];
  if (botOnline) {
    try {
      const res = await botApi<{ guilds: Array<{ id: string; tier: number }> }>(`/users/${user.discordId}/guilds`, {
        timeoutMs: 6000,
      });
      if (Array.isArray(res?.guilds)) botUserGuilds = res.guilds;
    } catch {
      // An old bot (pre-v3.30.0) 404s here, or the member lookup failed —
      // silently fall back to the OAuth-only list.
    }
  }

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
    // OAuth could not produce the list (no-token / relogin / discord-error).
    // v3.30.0: bot-known guilds still populate the picker (staff/member
    // tiers are resolvable by membership, not by OAuth) — the OAuth banner
    // is only shown when there is ALSO nothing from the bot.
    const fromBot = botUserGuilds
      .map((g) => {
        const base = botGuildMetaById.get(g.id);
        return base ? { id: g.id, name: base.name, icon: base.icon, owner: false, botIn: true, tier: g.tier } : null;
      })
      .filter((g): g is { id: string; name: string; icon: string | null; owner: boolean; botIn: boolean; tier: number } => g !== null);
    if (fromBot.length > 0) {
      return json({ botOnline, botVersion, guilds: fromBot, inviteUrl: cfg.inviteUrl });
    }
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

  // Union: OAuth-manageable (tier 3) + bot-known member guilds (tier 1-3).
  // A guild known to BOTH keeps the OAuth entry (richer: owner flag) — the
  // OAuth path already implies tier 3.
  const guilds = result.guilds.map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    owner: g.owner,
    botIn: botGuildIds.has(g.id),
    tier: 3,
  }));
  const seen = new Set(guilds.map((g) => g.id));
  for (const bg of botUserGuilds) {
    if (seen.has(bg.id)) continue;
    const meta = botGuildMetaById.get(bg.id);
    if (!meta) continue; // not in the bot guild list? cannot happen, but stay defensive
    guilds.push({
      id: bg.id,
      name: meta.name,
      icon: meta.icon,
      owner: false,
      botIn: true,
      tier: bg.tier,
    });
  }
  guilds.sort((a, b) => a.name.localeCompare(b.name));

  return json({ botOnline, botVersion, guilds, inviteUrl: cfg.inviteUrl });
}
