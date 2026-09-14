// GET /api/me — the active user's identity + public config info.
// Used by the home page to decide between the landing view and the dashboard.

import { db } from "@/lib/db";
import { currentUser, json } from "@/lib/api-auth";
import { isDiscordOAuthReady, isDemoMode, cfg } from "@/lib/config";
import { appOrigin } from "@/lib/origin";
import os from "os";

export async function GET(req: Request) {
  // Log the access domain (OAuth redirect diagnosis + onboarding)
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host && host !== "localhost:3000") console.log(`[host] ${host}`);

  const user = await currentUser(req);

  // Instance diagnostics (development / sandbox mode only — automatically
  // stripped from production builds). Used to map which instance is serving
  // the multi-instance preview path.
  const diag =
    process.env.NODE_ENV === "development"
      ? {
          host: os.hostname(),
          users: await db.user.count(),
          uptimeMin: Math.round(process.uptime() / 60),
        }
      : undefined;

  const config = {
    authReady: isDiscordOAuthReady(),
    demoMode: isDemoMode(),
    inviteUrl: cfg.inviteUrl,
    // Server timestamp (cache diagnosis): if this clock is older than when
    // the browser opened the page, a stale cache layer sits in the path.
    serverTime: new Date().toISOString(),
    // The OAuth redirect URI the server ACTUALLY uses (locked to
    // PUBLIC_ORIGIN) — shown in the "Bot owner setup" box so what the user
    // registers in the Discord Portal always matches exactly what is sent
    // at login.
    oauthRedirectUri: `${appOrigin(req)}/api/auth/discord/callback`,
  };

  if (!user) return json({ user: null, config, diag });

  return json({
    user: {
      id: user.id,
      discordId: user.discordId,
      username: user.username,
      globalName: user.globalName,
      avatar: user.avatar,
      isAdmin: user.isAdmin,
    },
    config,
    diag,
  });
}
