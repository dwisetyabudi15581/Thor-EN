import type { NextConfig } from "next";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// v3.28.1: read once at build time. NEXT_PUBLIC_* values are INLINED into
// the client bundle by the build, so the dashboard can display exactly which
// version it was built from — the instant answer to "is my build stale?"
// (the recurring "feature not showing" after `git pull` on Termux).
const dashboardVersion: string = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json"),
    "utf8",
  ),
).version;

const nextConfig: NextConfig = {
  output: "standalone",
  // Next 16 nests the standalone build under a subfolder when it detects a
  // parent workspace/git root (e.g. when dashboard/ lives inside the Thor
  // repo). Pinning the tracing root to this folder keeps server.js directly
  // under .next/standalone/ so `npm run start` stays simple.
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  // v3.19.0: Turbopack (Next 16's default build engine) has its own root
  // detection and also gets confused when .git exists in MULTIPLE parent
  // folders (real case: Thor-EN/.git + my-project/.git). Without this the
  // build fails with "We couldn't find the Next.js package from src/app".
  turbopack: {
    root: path.dirname(fileURLToPath(import.meta.url)),
  },
  // Disable the dev indicator button (the floating "N" circle) — on
  // sandboxes running `next dev`, this badge can cover content.
  devIndicators: false,
  env: {
    // Inlined at BUILD time (see comment at the top) — shown in the SideNav
    // footer as "Dashboard vX.Y.Z" so a stale build is visible at a glance.
    NEXT_PUBLIC_APP_VERSION: dashboardVersion,
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // The API & home page must not be cached by gateway/CDN/browser:
  // demo/login status must always be fresh (prevents stale "snapshots")
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
      {
        source: "/",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
