// GET /api/auth/discord/callback — exchange the code for a token, fetch the
// profile, upsert the user, then set the session cookie and return home.

import { db } from "@/lib/db";
import { cfg, isDiscordOAuthReady } from "@/lib/config";
import { appOrigin } from "@/lib/origin";
import { createSessionToken, sessionCookie } from "@/lib/session";

function redirectUri(req: Request): string {
  return `${appOrigin(req)}/api/auth/discord/callback`;
}

function fail(req: Request, reason: string): Response {
  return Response.redirect(new URL(`/?error=${reason}`, appOrigin(req)), 302);
}

function readStateCookie(req: Request): string | null {
  const raw = req.headers.get("cookie") ?? "";
  const match = raw
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("thor_oauth_state="));
  return match ? match.slice("thor_oauth_state=".length) : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!isDiscordOAuthReady()) {
    return fail(req, "oauth_belum_disiapkan");
  }
  if (!code) {
    return fail(req, "login_dibatalkan");
  }

  // Validate the CSRF state
  const expected = readStateCookie(req);
  if (!state || !expected || state !== expected) {
    return fail(req, "sesi_kedaluwarsa");
  }

  // Exchange code -> access token
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.discordClientId,
      client_secret: cfg.discordClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(req),
    }),
  });
  if (!tokenRes.ok) {
    return fail(req, "login_gagal");
  }
  const token = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number; // seconds
  };
  if (!token.access_token) {
    return fail(req, "login_gagal");
  }

  // Fetch the Discord profile
  const meRes = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!meRes.ok) {
    return fail(req, "profil_tidak_terbaca");
  }
  const profile = (await meRes.json()) as {
    id: string;
    username: string;
    global_name?: string;
    avatar?: string;
  };

  // The ADMIN_DISCORD_IDS list in env is the source of truth: re-login
  // refreshes admin status (removed from env = demoted automatically at login)
  const isAdmin = cfg.adminDiscordIds.includes(profile.id);
  // v2: store the user's OAuth token (identify+guilds scope) for the Server
  // Picker page — the guild list is fetched live from Discord, never copied.
  const tokenExpiresAt = new Date(Date.now() + (token.expires_in ?? 604800) * 1000);
  const user = await db.user.upsert({
    where: { discordId: profile.id },
    create: {
      discordId: profile.id,
      username: profile.username,
      globalName: profile.global_name ?? null,
      avatar: profile.avatar ?? null,
      isAdmin,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      tokenExpiresAt,
    },
    update: {
      username: profile.username,
      globalName: profile.global_name ?? null,
      avatar: profile.avatar ?? null,
      isAdmin,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      tokenExpiresAt,
    },
  });

  // Profile-carrying token: the session stays valid across sandbox instances
  // (see session.ts) — any instance can complete the callback.
  // v3.24.1 SECURITY FIX (1.1): createSessionToken throws when SESSION_SECRET is
  // empty while OAuth is ready — surface it as a clear redirect instead of a 500.
  let sessionToken: string;
  try {
    sessionToken = createSessionToken(user);
  } catch (err) {
    console.error("[oauth] refusing to create a session token:", (err as Error).message);
    return fail(req, "konfigurasi_tidak_aman");
  }
  const cookie = sessionCookie(sessionToken);
  const res = new Response(null, { status: 302, headers: { Location: "/" } });
  res.headers.append(
    "set-cookie",
    `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cookie.maxAge}${
      cookie.secure ? "; Secure" : ""
    }`
  );
  // Clear the state cookie
  res.headers.append("set-cookie", "thor_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  return res;
}
