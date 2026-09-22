// GET /api/auth/discord/callback — exchange the code for a token, fetch the
// profile, upsert the user, then set the session cookie and return home.

import crypto from "crypto";
import { db } from "@/lib/db";
import { cfg, isDiscordOAuthReady } from "@/lib/config";
import { appOrigin } from "@/lib/origin";
import { createSessionToken, sessionCookie } from "@/lib/session";

// v3.28.3: every Discord.com fetch gets an 8s timeout — a hung connection
// used to hang the OAuth callback indefinitely (browser spinner forever).
const DISCORD_FETCH_TIMEOUT_MS = 8000;

async function discordFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCORD_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

function redirectUri(req: Request): string {
  return `${appOrigin(req)}/api/auth/discord/callback`;
}

function fail(req: Request, reason: string): Response {
  // v3.28.3: always clear the one-shot state cookie on failure — it used to
  // linger up to 600s after failed attempts.
  const res = Response.redirect(new URL(`/?error=${reason}`, appOrigin(req)), 302);
  res.headers.append("set-cookie", "thor_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  return res;
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

  // Validate the CSRF state — v3.28.3: timing-safe comparison (same rigor
  // as the session HMAC right next door).
  const expected = readStateCookie(req);
  if (!state || !expected || !timingSafeEqualHex(state, expected)) {
    return fail(req, "sesi_kedaluwarsa");
  }

  // v3.28.3: the whole exchange → profile → upsert chain used to run WITHOUT
  // a try/catch — a transient network error, a non-JSON error body or a DB
  // failure (SQLite lock / read-only FS on Termux) produced a raw 500 page
  // mid-login instead of the graceful /?error=... redirect every other
  // failure path uses.
  try {
    // Exchange code -> access token
    const tokenRes = await discordFetch("https://discord.com/api/oauth2/token", {
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
    const meRes = await discordFetch("https://discord.com/api/users/@me", {
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
  } catch (err) {
    console.error("[oauth] callback failed:", err instanceof Error ? err.message : err);
    return fail(req, "login_gagal");
  }
}

// Constant-time hex comparison — both sides are random 32-char hex strings
// from our own cookie/param, so lengths always match; guard anyway.
function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
