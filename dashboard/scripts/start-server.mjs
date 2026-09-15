#!/usr/bin/env node
/**
 * Production start server — .env loading + prisma db push + Next standalone.
 *
 * Run by `npm run start` from the dashboard/ folder. Steps:
 *   0. dashboard/.env is loaded into process.env (see loadDotEnv below).
 *   1. A relative DATABASE_URL is turned ABSOLUTE (anchored to the
 *      dashboard/ folder) — neutralizing the path resolution differences
 *      between the prisma CLI (schema-relative) and the standalone runtime
 *      (chdir at boot).
 *   2. prisma db push — creates/migrates the SQLite tables (skipped on
 *      Android — JSON storage).
 *   3. Runs .next/standalone/server.js with the same absolute URL.
 */
import { spawnSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd(); // the dashboard/ folder (npm run start always runs here)

// 0) Load dashboard/.env into process.env BEFORE the standalone server
// starts. Why: `next build` copies .env into .next/standalone/, and the
// standalone server loads THAT copy — so editing dashboard/.env after a
// build had no effect until a full rebuild. @next/env never overrides
// variables already present in process.env, so values injected here WIN
// over the stale build-time copy: editing .env + restarting is enough.
// (Variables exported in the shell still take precedence over the file.)
function loadDotEnv(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return; // no .env — nothing to load
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quote =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quote && value.length >= 2) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv(path.join(root, ".env"));

const raw = process.env.DATABASE_URL || "file:db/custom.db";
let dbUrl = raw;
if (raw.startsWith("file:") && !raw.startsWith("file:/")) {
  dbUrl = "file:" + path.resolve(root, raw.slice(5));
}

// 1) Prepare the database (create tables if missing)
if (process.platform === "android") {
  // Termux/Android: the Prisma schema engine is a glibc binary that cannot
  // run on Android. The dashboard automatically uses JSON storage for its
  // users (see src/lib/db.ts) — prisma db push is not needed.
  console.log("[Termux] Skipping prisma db push — user storage uses JSON (db/custom-users.json).");
} else {
  const push = spawnSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: dbUrl },
  });
  if (push.status !== 0) process.exit(push.status ?? 1);
}

// 2) Run the Next standalone server (inherits PORT from env when set)
const server = spawn(process.execPath, [".next/standalone/server.js"], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production", DATABASE_URL: dbUrl },
});
server.on("exit", (code) => process.exit(code ?? 0));
server.on("error", (err) => {
  console.error("Failed to run .next/standalone/server.js — run `npm run build` first.", err);
  process.exit(1);
});
