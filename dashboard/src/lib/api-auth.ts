// Authentication helpers for API route handlers: read the session -> load
// the user, plus consistent JSON response utilities.
//
// User resolution order ( currentUser ):
// 1. The user row in this instance's database — by session id, then by
//    discordId. Primary source: admin status is always fresh from the DB.
// 2. Multi-instance fallback: the profile embedded in the session token.
//    Platform preview sandboxes can run more than one server instance with
//    different DB copies; the token profile keeps the login alive on any
//    instance (SESSION_SECRET just has to match — locked in
//    thor-credentials.ts).
// 3. Self-healing: when the fallback is used, the user row is re-planted
//    into this instance's DB with the same id so redeem/admin/history
//    features come alive too. Old tokens (without a profile) cannot be
//    recovered — the user logs in once more to get a new profile-carrying
//    token.

import { db } from "@/lib/db";
import { readSession, userFromSession, type SessionUser } from "@/lib/session";
import type { User } from "@prisma/client";

// A token-derived shape for when re-planting the row fails (read-only DB
// or a race with another instance) — identity is still readable; the user
// row will fully live once it is actually available.
function shadowUser(profile: SessionUser): User {
  const stamp = new Date();
  return {
    id: profile.id,
    discordId: profile.discordId,
    username: profile.username,
    globalName: profile.globalName,
    avatar: profile.avatar,
    isAdmin: profile.isAdmin,
    // v2: the OAuth token is not embedded in the session — a shadow user
    // cannot call /users/@me/guilds (the UI will ask to re-login if needed).
    accessToken: null,
    refreshToken: null,
    tokenExpiresAt: null,
    createdAt: stamp,
    updatedAt: stamp,
  } as User;
}

export async function currentUser(req: Request): Promise<User | null> {
  const session = readSession(req);
  if (!session) return null;

  // 1) DB-first: look up the user row in this instance
  const byId = await db.user.findUnique({ where: { id: session.uid } });
  if (byId) return byId;

  // 2) Fallback: the profile embedded in the token
  const profile = userFromSession(session);
  if (!profile) return null;

  // The local DB may already have the same row under a different id (the
  // first login happened on this instance via another path) — match by
  // discordId to avoid duplicates
  const byDiscordId = await db.user.findUnique({
    where: { discordId: profile.discordId },
  });
  if (byDiscordId) return byDiscordId;

  // 3) Self-healing: re-plant the user row (exact same id so relations
  //    stay consistent). Failure is swallowed — the shadow user is used.
  try {
    const created = await db.user.create({
      data: {
        id: profile.id,
        discordId: profile.discordId,
        username: profile.username,
        globalName: profile.globalName,
        avatar: profile.avatar,
        isAdmin: profile.isAdmin,
      },
    });
    return created;
  } catch {
    return shadowUser(profile);
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonError(message: string, status = 400): Response {
  return json({ error: message }, status);
}
