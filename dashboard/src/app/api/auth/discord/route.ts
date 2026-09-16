// GET /api/auth/discord — redirect to the Discord OAuth2 authorization page.
// A random state is stored in a short-lived cookie for CSRF protection on callback.

import crypto from "crypto";
import { cfg, isDiscordOAuthReady } from "@/lib/config";
import { appOrigin } from "@/lib/origin";

function redirectUri(req: Request): string {
  return `${appOrigin(req)}/api/auth/discord/callback`;
}

export async function GET(req: Request) {
  // v3.24.1 FIX (5.4, defense in depth): when OAuth credentials are not
  // configured, redirecting to Discord with an EMPTY client_id lands the user
  // on a broken Discord error page. Send them back to the landing page with a
  // clear error banner instead (the UI also swaps the primary button to the
  // demo login in that case).
  if (!isDiscordOAuthReady()) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/?error=oauth_belum_disiapkan" },
    });
  }
  const state = crypto.randomBytes(16).toString("hex");
  const uri = redirectUri(req);
  console.log(`[oauth] redirect_uri=${uri}`);
  const params = new URLSearchParams({
    client_id: cfg.discordClientId,
    redirect_uri: uri,
    response_type: "code",
    // v2: the `guilds` scope — the dashboard needs the user's server list
    //  for the Server Picker page + ManageGuild verification.
    scope: "identify guilds",
    state,
  });
  const res = new Response(null, {
    status: 302,
    headers: { Location: `https://discord.com/oauth2/authorize?${params.toString()}` },
  });
  // v3.24.1 FIX (1.3): Secure flag in production, consistent with the session
  // cookie (the OAuth state is exactly as security-relevant as the session).
  res.headers.append(
    "set-cookie",
    `thor_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`
  );
  return res;
}
