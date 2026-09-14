// POST /api/auth/logout — clear the session cookie.

import { clearedSessionCookie } from "@/lib/session";

export async function POST() {
  const cookie = clearedSessionCookie();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${cookie.name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
}
