#!/usr/bin/env node
/**
 * Smoke test v3.21.0 — Quick Start endpoints (panels + verify-panel) against the
 * MOCK DASH API (fake server, no real bot).
 *
 * Run the mock first in another terminal:
 *   node scripts/mock-dash-api.mjs
 * then:
 *   node scripts/smoke-v321.mjs
 *
 * What is tested:
 *   1. GET  /guilds/:id/dashboard          → payload memuat panels (array)
 *   2. PUT  /guilds/:id/config             → kosongkan roles.admin (setup ulang)
 *   3. POST /guilds/:id/panels             → tanpa roles.admin → 422
 *   4. PUT  /guilds/:id/config             → set roles.admin + roles.verified
 *   5. POST /guilds/:id/panels             → valid → 201 + panel di payload
 *   6. POST /guilds/:id/panels             → categoryIds with no match → 400
 *   7. PUT  /guilds/:id/config             → kosongkan roles.verified
 *   8. POST /guilds/:id/verify-panel       → tanpa roles.verified → 422
 *   9. PUT  /guilds/:id/config             → set roles.verified
 *   10. POST /guilds/:id/verify-panel      → valid → 201
 *   11. PUT  /guilds/:id/config            → channels.server-log via dotPath
 */

const BASE = process.env.MOCK_BASE_URL || "http://127.0.0.1:8788";
const TOKEN = process.env.MOCK_DASH_TOKEN || "dash-dev-token-thor-local-8788";

const health = await fetch(`${BASE}/health`, { headers: { "x-dash-token": TOKEN } }).then((r) => r.json());
if (!health.ok) throw new Error("mock not online — jalankan: node scripts/mock-dash-api.mjs");

// ID guild demo — buat via /__demo/adopt (pola yang sama dipakai login demo web).
await fetch(`${BASE}/__demo/adopt`, {
  method: "POST",
  headers: { "x-dash-token": TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ guilds: [{ id: "111222333444555777", name: "Smoke v3.21 Server", memberCount: 42 }] }),
}).catch(() => {});
const guilds = await fetch(`${BASE}/guilds`, { headers: { "x-dash-token": TOKEN } }).then((r) => r.json());
const guildId = guilds.guilds[0].id;
// ID channel demo di-generate ACAK oleh mock — ambil ID asli dari /meta.
const meta = await fetch(`${BASE}/guilds/${guildId}/meta`, { headers: { "x-dash-token": TOKEN } }).then((r) => r.json());
const textChannelId = meta.channels.find((c) => c.type === 0).id;
console.log(`✅ 0. health OK — demo guild: ${guildId} (test channel: ${textChannelId})`);

let pass = 0;
let fail = 0;
async function call(method, path, body) {
  const res = await fetch(`${BASE}/guilds/${guildId}${path}`, {
    method,
    headers: { "x-dash-token": TOKEN, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
function check(n, got, wantStatus, extra = () => true) {
  const ok = got.status === wantStatus && extra(got.data);
  if (ok) {
    pass++;
    console.log(`✅ ${n} (${got.status})`);
  } else {
    fail++;
    console.log(`❌ ${n} — status ${got.status} (expected ${wantStatus})`, got.data);
  }
}

// 1. payload dashboard memuat panels
const dash1 = await call("GET", "/dashboard");
check("1. dashboard payload contains panels", dash1, 200, (d) => Array.isArray(d.panels));

// 2. clear roles.admin (simulate an unconfigured server)
await call("PUT", "/config", { updates: { "roles.admin": null } });

// 3. panel tiket tanpa role admin → 422
const noAdmin = await call("POST", "/panels", { channelId: textChannelId });
check("3. ticket panel without roles.admin → 422", noAdmin, 422, (d) => /Admin [Rr]ole/i.test(d.error));

// 4. set prasyarat
await call("PUT", "/config", {
  updates: { "roles.admin": "333333333333333333", "roles.verified": "111111111111111111" },
});

// 5. install a valid ticket panel
const panel = await call("POST", "/panels", { channelId: textChannelId, useDropdown: true });
check("5. pasang panel tiket → 201", panel, 201, (d) => d.ok && d.panel?.id);
const dash2 = await call("GET", "/dashboard");
check(
  "5b. panel recorded in payload.panels",
  dash2,
  200,
  (d) => d.panels.some((p) => p.id === panel.data.panel.id && p.useDropdown === true)
);

// 6. categoryIds with no match → 400
const badCats = await call("POST", "/panels", { channelId: textChannelId, categoryIds: ["tidak-ada"] });
check("6. categoryIds with no match → 400", badCats, 400);

// 7. kosongkan roles.verified
await call("PUT", "/config", { updates: { "roles.verified": null } });

// 8. panel verifikasi tanpa role verified → 422
const noVerified = await call("POST", "/verify-panel", { channelId: textChannelId });
check("8. verification panel without roles.verified → 422", noVerified, 422, (d) => /Verified [Rr]ole/i.test(d.error));

// 9. set roles.verified again
await call("PUT", "/config", { updates: { "roles.verified": "111111111111111111" } });

// 10. install a valid verification panel
const verify = await call("POST", "/verify-panel", { channelId: textChannelId });
check("10. pasang panel verifikasi → 201", verify, 201, (d) => d.ok && d.messageId);

// 11. channel log via dotPath (langkah 6 Panduan Cepat)
const logCh = await call("PUT", "/config", { updates: { "channels.server-log": textChannelId } });
check("11. set channels.server-log (dotPath)", logCh, 200, (d) => d.config?.channels?.["server-log"] === textChannelId);

console.log(`\n${fail === 0 ? "🎉 ALL PASSED" : "💥 FAILURES DETECTED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
