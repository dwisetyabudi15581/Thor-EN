#!/usr/bin/env node
/**
 * Production start server — prisma db push (absolute URL) + Next standalone.
 *
 * Run by `npm run start` from the dashboard/ folder. Steps:
 *   1. A relative DATABASE_URL is turned ABSOLUTE (anchored to the
 *      dashboard/ folder) — neutralizing the path resolution differences
 *      between the prisma CLI (schema-relative) and the standalone runtime
 *      (chdir at boot).
 *   2. prisma db push — creates/migrates the SQLite tables.
 *   3. Runs .next/standalone/server.js with the same absolute URL.
 */
import { spawnSync, spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd(); // the dashboard/ folder (npm run start always runs here)

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
