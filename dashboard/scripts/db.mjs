#!/usr/bin/env node
/**
 * Wrapper prisma yang DETERMINISTIK untuk DATABASE_URL SQLite.
 *
 * Why it exists: the prisma CLI and the prisma client resolve relative
 * file: paths against different locations (the prisma/ schema folder for
 * the CLI, the standalone build location at runtime) — the .env can point
 * "elsewhere" depending on context. This wrapper turns relative paths
 * into ABSOLUTE ones (anchored to the dashboard/ folder) before
 * delegating to prisma, so the CLI, the runtime, and dev mode ALWAYS
 * point at the same file:
 *
 *   file:db/custom.db  →  file:/.../dashboard/db/custom.db
 *
 * Usage (from the dashboard/ folder):
 *   node scripts/db.mjs db push --accept-data-loss
 *   node scripts/db.mjs studio
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2); // e.g. ["db", "push", "--accept-data-loss"]
if (args.length === 0) {
  console.error('Usage: node scripts/db.mjs <prisma command>  (e.g. "db push")');
  process.exit(1);
}

const raw = process.env.DATABASE_URL || "file:db/custom.db";
let url = raw;
if (raw.startsWith("file:") && !raw.startsWith("file:/")) {
  // relative path → absolute, anchored to the dashboard/ folder (this command's CWD)
  url = "file:" + path.resolve(process.cwd(), raw.slice(5));
}

const res = spawnSync("npx", ["prisma", ...args], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(res.status ?? 1);
