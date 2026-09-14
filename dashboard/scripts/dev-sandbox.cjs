#!/usr/bin/env node
/**
 * Dev/Sandbox helper — full dashboard preview WITHOUT real Discord OAuth.
 *
 * Two usage modes (can be combined):
 *
 * 1) Discord interceptor (via --require — ONLY runs when loaded explicitly):
 *      NODE_OPTIONS="--require ./scripts/dev-sandbox.cjs" npm run dev
 *    Intercepts the fetch to https://discord.com/api/users/@me/guilds and
 *    returns 1 sandbox guild (owner) — so the /app page can open the guild
 *    dashboard. WITHOUT being loaded via --require, this file does
 *    NOTHING (safe to keep in the repo).
 *
 * 2) Demo user seeder (run directly):
 *      node scripts/dev-sandbox.cjs seed
 *    Gives the demo-admin user a sandbox accessToken (not expired) so the
 *    getManageableGuilds → checkGuildAccess path passes with the interceptor.
 *
 * Full sandbox preview combination:
 *   node scripts/mock-dash-api.mjs                                # terminal 1
 *   node scripts/dev-sandbox.cjs seed                             # sekali saja
 *   NODE_OPTIONS="--require ./scripts/dev-sandbox.cjs" npm run dev # terminal 2
 *
 * Production: NOT used — no env var silently enables the interceptor;
 * it requires an explicit --require from the developer.
 */

// === Mode 1: interceptor (active only when loaded via --require) ===
if (process.env.NODE_OPTIONS && process.env.NODE_OPTIONS.includes("dev-sandbox")) {
  // Sandbox env — set from inside --require because some sandbox
  // supervisors strip the env of background processes (proven: NODE_OPTIONS
  // is consumed by node at start, but the route handler's process.env is empty).
  // This file only activates via an EXPLICIT --require — safe for production.
  const SANDBOX_ENV = {
    DATABASE_URL: "file:/home/z/my-project/Thor/dashboard/db/custom.db",
    SESSION_SECRET: "sandbox-dev-secret-thor-0123456789abcdef",
    DEMO_MODE: "true",
    DASH_API_URL: "http://127.0.0.1:8788",
    DASH_API_TOKEN: "dash-dev-token-thor-local-8788",
  };
  for (const [k, v] of Object.entries(SANDBOX_ENV)) {
    if (!process.env[k]) process.env[k] = v;
  }

  const ORIG_FETCH = globalThis.fetch;
  const SANDBOX_GUILD = {
    id: "111222333444555666",
    name: "Sandbox Preview Server",
    icon: null,
    owner: true,
    permissions: "2147483647", // all permissions including MANAGE_GUILD
  };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url === "https://discord.com/api/users/@me/guilds") {
      console.log("[dev-sandbox] intercept GET /users/@me/guilds → 1 sandbox guild");
      return new Response(JSON.stringify([SANDBOX_GUILD]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return ORIG_FETCH(input, init);
  };
  console.log("[dev-sandbox] Discord API interceptor active (sandbox only)");
}

// === Mode 2: demo user seeder ===
if (process.argv[2] === "seed") {
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  const user = db.user.upsert({
    where: { discordId: "demo-admin" },
    create: {
      discordId: "demo-admin",
      username: "Demo Admin",
      isAdmin: true,
      accessToken: "sandbox-demo-token",
      refreshToken: null,
      tokenExpiresAt: new Date(Date.now() + 24 * 3600_000),
    },
    update: {
      accessToken: "sandbox-demo-token",
      tokenExpiresAt: new Date(Date.now() + 24 * 3600_000),
    },
  });
  user
    .then((u) => {
      console.log(`✓ demo-admin user ready (id ${u.id}, sandbox token active for 24 hours)`);
      return db.$disconnect();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("seed failed:", err.message);
      process.exit(1);
    });
}
