// Thor Dashboard runtime configuration — all sensitive values come from env.
// Priority: process.env (production/hosting) -> SANDBOX_DEFAULTS (sandbox
// multi-instance fallback, see thor-credentials.ts for the reasoning).

import { SANDBOX_DEFAULTS } from "./thor-credentials";

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  // an empty string counts as "not set" so the fallback still applies
  return v && v.trim() !== "" ? v : fallback;
}

export const cfg = {
  // Discord OAuth2 (Developer Portal -> aplikasi bot -> OAuth2)
  discordClientId: envOr("DISCORD_CLIENT_ID", SANDBOX_DEFAULTS.DISCORD_CLIENT_ID),
  discordClientSecret: envOr("DISCORD_CLIENT_SECRET", SANDBOX_DEFAULTS.DISCORD_CLIENT_SECRET),

  // Session cookie signing key (change in production!)
  sessionSecret: envOr("SESSION_SECRET", SANDBOX_DEFAULTS.SESSION_SECRET),

  // Discord IDs (comma-separated) that automatically become dashboard admins
  adminDiscordIds: envOr("ADMIN_DISCORD_IDS", SANDBOX_DEFAULTS.ADMIN_DISCORD_IDS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Bot invite link (default: the owner's Thor, least-privilege permissions)
  inviteUrl:
    process.env.NEXT_PUBLIC_INVITE_URL ??
    "https://discord.com/oauth2/authorize?client_id=1548297613969985546&permissions=1099800112150&integration_type=0&scope=bot+applications.commands",

  // v3.16.0: DASH API — a small HTTP server inside the bot process
  // (web dashboard). All server config reads/writes are routed
  // through it; the token must MATCH the DASH_API_TOKEN in the Thor bot's
  // .env.
  dashApiUrl: envOr("DASH_API_URL", SANDBOX_DEFAULTS.DASH_API_URL).replace(/\/$/, ""),
  dashApiToken: envOr("DASH_API_TOKEN", SANDBOX_DEFAULTS.DASH_API_TOKEN),
};

// Discord OAuth is only active when credentials are filled in
export function isDiscordOAuthReady(): boolean {
  return Boolean(cfg.discordClientId && cfg.discordClientSecret);
}

// Demo mode activates automatically while OAuth is not configured (so the
// dashboard can still be explored before Discord credentials are filled in)
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true" || !isDiscordOAuthReady();
}
