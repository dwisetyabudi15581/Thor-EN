import type { NextConfig } from "next";

import path from "node:path";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  output: "standalone",
  // Next 16 nests the standalone build under a subfolder when it detects a
  // parent workspace/git root (e.g. when dashboard/ lives inside the Thor
  // repo). Pinning the tracing root to this folder keeps server.js directly
  // under .next/standalone/ so `npm run start` stays simple.
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  // Disable the dev indicator button (the floating "N" circle) — on
  // sandboxes running `next dev`, this badge can cover content.
  devIndicators: false,
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
