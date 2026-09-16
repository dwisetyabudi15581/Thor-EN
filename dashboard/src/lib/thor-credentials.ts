// Credential fallback for multi-instance PREVIEW environments — NOT for production.
//
// Background: some preview platforms can run more than one server instance
// from the same code, and .env* files are not guaranteed to be available on
// freshly spawned instances. Without a fallback, a new instance starts with
// an empty environment -> the dashboard "reverts to demo" even though
// credentials were already configured.
//
// Priority order: process.env first (production just sets environment
// variables; the values in this file are ignored), then the defaults below.
// Because this file ships with the source code, every instance automatically
// has consistent credentials (cookie sessions stay consistent too, since
// SESSION_SECRET matches across instances).
//
// IMPORTANT: the values below are intentionally EMPTY in the public repo —
// NEVER put real secrets here (client secret, session secret, API tokens).
// Fill them only for a private preview, and never commit the result.

export const SANDBOX_DEFAULTS = {
  SESSION_SECRET: "",
  DEMO_MODE: "false",
  DISCORD_CLIENT_ID: "",
  DISCORD_CLIENT_SECRET: "",
  ADMIN_DISCORD_IDS: "",
  PUBLIC_ORIGIN: "",
  // Thor bot DASH API (web dashboard) — a small HTTP server inside
  // the bot process. DASH_API_TOKEN must MATCH the one in the Thor bot's
  // .env.
  DASH_API_URL: "",
  DASH_API_TOKEN: "",
};
