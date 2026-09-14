// App origin helper behind a reverse proxy.
// Gateways/hosting usually terminate TLS before requests reach the server
// (the server only sees "http"), while the visitor's browser uses https.
// Therefore: a non-localhost host is ALWAYS treated as https; localhost
// stays http so local development keeps working.
// PUBLIC_ORIGIN (optional) pins the origin, e.g.
//   PUBLIC_ORIGIN=https://thor.example.com
// useful when deploying on hosting with your own domain or a LAN address.
// In the sandbox, the preview panel rewrites Host to the internal FC domain
// while the visitor's browser is on the preview domain — so the
// PUBLIC_ORIGIN fallback from thor-credentials pins the origin to that
// preview domain.

import { SANDBOX_DEFAULTS } from "./thor-credentials";

export function appOrigin(req: Request): string {
  const fixed = process.env.PUBLIC_ORIGIN?.trim() || SANDBOX_DEFAULTS.PUBLIC_ORIGIN;
  if (fixed) return fixed.replace(/\/+$/, "");

  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  return `${isLocal ? "http" : "https"}://${host}`;
}
