// POST /api/auth/demo — demo login so the dashboard can be explored before
// Discord OAuth credentials are filled in. Automatically disabled once OAuth
// is ready (unless DEMO_MODE=true is forced).

import { db } from "@/lib/db";
import { jsonError, json } from "@/lib/api-auth";
import { isDemoMode } from "@/lib/config";
import { createSessionToken, sessionCookie } from "@/lib/session";

const DEMO_USERS = {
  member: { discordId: "demo-member", username: "Demo Member", isAdmin: false },
  admin: { discordId: "demo-admin", username: "Demo Admin", isAdmin: true },
} as const;

export async function POST(req: Request) {
  if (!isDemoMode()) {
    return jsonError("Demo login is disabled — Discord OAuth is already active.", 403);
  }
  let role: keyof typeof DEMO_USERS = "member";
  try {
    const body = (await req.json()) as { role?: string };
    if (body.role === "admin") role = "admin";
  } catch {
    // empty body -> default member
  }

  const spec = DEMO_USERS[role];
  const user = await db.user.upsert({
    where: { discordId: spec.discordId },
    create: { discordId: spec.discordId, username: spec.username, isAdmin: spec.isAdmin },
    update: { isAdmin: spec.isAdmin },
  });

  const cookie = sessionCookie(createSessionToken(user));
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cookie.maxAge}${
        cookie.secure ? "; Secure" : ""
      }`,
    },
  });
}

export async function GET() {
  return json({ ok: true, hint: "POST { role: 'member' | 'admin' }" });
}
