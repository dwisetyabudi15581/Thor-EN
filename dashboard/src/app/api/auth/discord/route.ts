// GET /api/auth/discord — redirect to the Discord OAuth2 authorization page.
// A random state is stored in a short-lived cookie for CSRF protection on callback.

import crypto from "crypto";
import { cfg } from "@/lib/config";
import { appOrigin } from "@/lib/origin";

function redirectUri(req: Request): string {
  return `${appOrigin(req)}/api/auth/discord/callback`;
}

export async function GET(req: Request) {
  const state = crypto.randomBytes(16).toString("hex");
  const uri = redirectUri(req);
  console.log(`[oauth] redirect_uri=${uri}`);
  const params = new URLSearchParams({
    client_id: cfg.discordClientId,
    redirect_uri: uri,
    response_type: "code",
    // v2: the `guilds` scope — the dashboard needs the user's server list
    // (Dyno-style) for the Server Picker page + ManageGuild verification.
    scope: "identify guilds",
    state,
  });
  const res = new Response(null, {
    status: 302,
    headers: { Location: `https://discord.com/oauth2/authorize?${params.toString()}` },
  });
  res.headers.append(
    "set-cookie",
    `thor_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`
  );
  return res;
}
