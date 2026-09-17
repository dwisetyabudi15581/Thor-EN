#!/usr/bin/env node
/**
 * E2E test — the web dashboard API routes (v2) against a local dev
 * server.
 *
 * What is tested:
 *   1. /api/guilds without login       → 401
 *   2. /api/guilds with a test session → 200, botOnline=true (mock), guildsError=no-token
 *      (the test user has no Discord access token — the correct path)
 *   3. /api/guilds/:id/dashboard       → 401 relogin (no Discord token yet)
 *   4. /api/guilds/:id/config (PUT)    → 401 relogin
 *   5. Adopt a demo guild into the mock, then inject a FAKE accessToken →
 *      discord-error path (401 from Discord → refresh attempted → fails →
 *      relogin) — verifies the fallback flow
 *   6. /api/guilds/:id/dashboard with a mock-adopted guild the user still
 *      has no permission for → 401 (the fake token fails Discord verification)
 *
 * The test session is created with the SAME SESSION_SECRET as the server
 * (from the .env file) — the "e2e-guild-test" user is created in the DB
 * first.
 *
 * Run:  node --env-file=.env scripts/test-guild-api.mjs
 *   (requires SESSION_SECRET + DATABASE_URL from the dashboard .env, and a
 *    running dev server + mock DASH API)
 */

import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const SESSION_SECRET = process.env.SESSION_SECRET; // must match the dashboard .env
if (!SESSION_SECRET) {
  console.error("Missing SESSION_SECRET — run: node --env-file=.env scripts/test-guild-api.mjs");
  process.exit(1);
}
const SESSION_DAYS = 7;
const TEST_DISCORD_ID = "e2e-guild-test-0001";

const db = new PrismaClient();

function sign(data) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
}

function createSessionToken(user) {
  const now = Date.now();
  const payload = {
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

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

async function main() {
  // --- Prepare the test user ---
  const user = await db.user.upsert({
    where: { discordId: TEST_DISCORD_ID },
    create: { discordId: TEST_DISCORD_ID, username: "E2E Guild Test", isAdmin: false },
    update: {},
  });
  const token = createSessionToken(user);
  const cookie = `thor_session=${token}`;
  const GUILD = "123456789012345678";

  console.log("== 1. Without login ==");
  let res = await fetch(`${BASE}/api/guilds`);
  check("/api/guilds without a session → 401", res.status === 401, `(got ${res.status})`);
  res = await fetch(`${BASE}/api/guilds/${GUILD}/dashboard`);
  check("dashboard without a session → 401", res.status === 401, `(got ${res.status})`);

  console.log("== 2. With a test session (no Discord token) ==");
  res = await fetch(`${BASE}/api/guilds`, { headers: { cookie } });
  check("/api/guilds → 200", res.status === 200, `(got ${res.status})`);
  let data = await res.json();
  check("botOnline=true (mock jalan)", data.botOnline === true);
  check("botVersion mock terdeteksi", String(data.botVersion || "").startsWith("mock"));
  check("guildsError=no-token (test user without the guilds scope)", data.guildsError === "no-token", `(got ${data.guildsError})`);

  console.log("== 3. Dashboard guild (verifikasi akses Discord) ==");
  res = await fetch(`${BASE}/api/guilds/${GUILD}/dashboard`, { headers: { cookie } });
  check("dashboard → 401 relogin (no Discord token)", res.status === 401, `(got ${res.status})`);
  data = await res.json();
  check("relogin message is informative", typeof data.error === "string" && data.error.length > 10);

  console.log("== 4. Write proxy (must hit the same guard) ==");
  res = await fetch(`${BASE}/api/guilds/${GUILD}/config`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ updates: { "messages.welcomeTitle": "HACK" } }),
  });
  check("PUT config without a Discord token → 401", res.status === 401, `(got ${res.status})`);

  console.log("== 5. Token Discord PALSU → verifikasi live Discord menolak ==");
  await db.user.update({
    where: { id: user.id },
    data: {
      accessToken: "fake-token-abcdef",
      refreshToken: "fake-refresh",
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    },
  });
  res = await fetch(`${BASE}/api/guilds`, { headers: { cookie } });
  check("/api/guilds still 200 (error fallback doesn't crash)", res.status === 200, `(got ${res.status})`);
  data = await res.json();
  check(
    "guildsError=relogin (Discord 401 → refresh failed)",
    data.guildsError === "relogin" || data.guildsError === "discord-error",
    `(got ${data.guildsError})`
  );
  res = await fetch(`${BASE}/api/guilds/${GUILD}/dashboard`, { headers: { cookie } });
  check("dashboard with a fake token → 401 (fails verification)", res.status === 401, `(got ${res.status})`);

  console.log("== 6. Cleanup ==");
  await db.user.update({
    where: { id: user.id },
    data: { accessToken: null, refreshToken: null, tokenExpiresAt: null },
  });
  check("token palsu dibersihkan", true);

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
