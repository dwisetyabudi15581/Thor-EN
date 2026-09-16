// HMAC-SHA256 signed cookie sessions — lightweight, no external
// dependencies. Payload: { uid, iat, exp, p }.
//
// "p" (profile) stores the Discord login result: identity + admin status
// at login time. This makes the session SELF-CONTAINED: on multi-instance
// preview sandboxes (each instance may have a different DB copy), the
// session stays valid on any instance as long as SESSION_SECRET matches.
// currentUser() stays DB-first; the token profile is the fallback and the
// self-healing seed for re-planting the user row (see api-auth.ts).

import crypto from "crypto";
import { cfg, isDiscordOAuthReady } from "./config";

const COOKIE_NAME = "thor_session";
const SESSION_DAYS = 7;

// The profile embedded in the token — JSON-safe shape (dates as epoch ms)
export type SessionProfile = {
  discordId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  isAdmin: boolean;
};

export type SessionPayload = {
  uid: string;
  iat?: number;
  exp: number;
  p?: SessionProfile;
};

// The minimal user shape for creating a session — the Prisma User satisfies it
export type SessionUser = {
  id: string;
  discordId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  isAdmin: boolean;
};

function sign(data: string): string {
  // v3.24.1 SECURITY FIX (1.1): fail fast on an empty SESSION_SECRET once real
  // Discord OAuth credentials are configured. An empty HMAC key is deterministic
  // and publicly computable — anyone could forge { uid, exp, p:{isAdmin:true} }
  // and take over ANY account (the DB row is loaded by uid). Demo mode (OAuth
  // unconfigured, no real credentials to protect) may keep using the empty secret.
  if (!cfg.sessionSecret && isDiscordOAuthReady()) {
    throw new Error(
      "SESSION_SECRET is empty while Discord OAuth is configured — refusing to sign session tokens (they would be forgeable). Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" and set it in dashboard/.env"
    );
  }
  return crypto.createHmac("sha256", cfg.sessionSecret).update(data).digest("base64url");
}

export function createSessionToken(user: SessionUser): string {
  const now = Date.now();
  const payload: SessionPayload = {
    uid: user.id,
    iat: now,
    exp: now + SESSION_DAYS * 24 * 60 * 60 * 1000,
    p: {
      discordId: user.discordId,
      username: user.username,
      globalName: user.globalName,
      avatar: user.avatar,
      isAdmin: user.isAdmin,
    },
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  let expected: string;
  try {
    expected = sign(body);
  } catch {
    // Empty secret + OAuth ready → fail CLOSED: every existing token is
    // treated as invalid (a forgeable secret validates nothing).
    return null;
  }
  // constant-time comparison to prevent timing attacks
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.uid || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Reconstruct the user from the session payload (multi-instance fallback).
// Old tokens without "p" resolve to null — their owners simply log in ONCE
// more to get a profile-carrying token that survives instance moves.
export function userFromSession(session: SessionPayload): SessionUser | null {
  const p = session.p;
  if (!p) return null;
  return {
    id: session.uid,
    discordId: p.discordId,
    username: p.username,
    globalName: p.globalName,
    avatar: p.avatar,
    isAdmin: p.isAdmin,
  };
}

export function sessionCookie(token: string) {
  return {
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
    secure: process.env.NODE_ENV === "production",
  };
}

export function clearedSessionCookie() {
  return {
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
    secure: process.env.NODE_ENV === "production",
  };
}

// Read the session payload from a Request's cookie header (route handler)
export function readSession(req: Request): SessionPayload | null {
  const raw = req.headers.get("cookie") ?? "";
  const match = raw
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  return verifySessionToken(match.slice(COOKIE_NAME.length + 1));
}
