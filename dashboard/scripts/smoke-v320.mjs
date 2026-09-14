#!/usr/bin/env node
/**
 * Smoke test v3.20.0 — Custom Commands + full Embed endpoints against the
 * MOCK DASH API (fake server, no real bot needed).
 *
 * Run the mock first in another terminal:
 *   node scripts/mock-dash-api.mjs
 * then:
 *   node scripts/smoke-v320.mjs
 *
 * Checks:
 *   1. GET  /health                                 → online
 *   2. GET  /guilds/:id/dashboard                   → payload has customCommands
 *                                                     + custom entries in commands.list
 *   3. POST /guilds/:id/custom-commands             → create (valid) 201
 *   4. POST /guilds/:id/custom-commands             → update (same name) 200
 *   5. POST /guilds/:id/custom-commands             → built-in name rejected 422
 *   6. POST /guilds/:id/embed (full shape)          → 201
 *   7. PUT  /guilds/:id/commands (disable custom)   → 200 + total grows
 *   8. DELETE /guilds/:id/custom-commands/:name     → 200
 *   9. POST /guilds/:id/custom-commands (empty)     → 422 (content/embed required)
 */

const BASE = process.env.MOCK_BASE_URL || "http://127.0.0.1:8788";
const TOKEN = process.env.MOCK_DASH_TOKEN || "dash-dev-token-thor-local-8788";

// ID guild demo pertama — didapat dari /guilds.
const health = await fetch(`${BASE}/health`, { headers: { "x-dash-token": TOKEN } }).then((r) => r.json());
if (!health.ok) throw new Error("mock is not online — run: node scripts/mock-dash-api.mjs");
// ID guild demo — buat via /__demo/adopt (pola yang sama dipakai login demo web).
await fetch(`${BASE}/__demo/adopt`, {
  method: "POST",
  headers: { "x-dash-token": TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ guilds: [{ id: "111222333444555666", name: "Smoke Test Server", memberCount: 42 }] }),
}).catch(() => {});
const guilds = await fetch(`${BASE}/guilds`, { headers: { "x-dash-token": TOKEN } }).then((r) => r.json());
const guildId = guilds.guilds[0].id;
console.log(`✅ 1. health OK — demo guild: ${guildId}`);

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
    console.log(`❌ ${n} — status ${got.status} (harus ${wantStatus})`, got.data);
  }
}

// 2. payload dashboard
const dash = await call("GET", "/dashboard");
check("2. dashboard payload has customCommands + custom entries in commands.list", dash, 200, (d) => {
  const custom = (d.commands.list || []).filter((c) => c.custom);
  return Array.isArray(d.customCommands) && d.customCommands.length > 0 && custom.length === d.customCommands.length;
});

// 3. create
const created = await call("POST", "/custom-commands", {
  name: "smoke-test",
  description: "v3.20.0 endpoint test",
  ephemeral: false,
  content: "Hello from the smoke test",
  embed: { title: "SMOKE", description: "test", color: 3066993, fields: [{ name: "A", value: "1", inline: true }] },
  actor: { id: "smoke", tag: "smoke" },
});
check("3. create custom command", created, 201, (d) => d.ok === true && d.command?.name === "smoke-test");

// 4. update (nama sama)
const updated = await call("POST", "/custom-commands", {
  name: "smoke-test",
  description: "Version two",
  ephemeral: true,
  content: "",
  embed: { title: "SMOKE v2", description: "changed", color: 15158332 },
  actor: { id: "smoke", tag: "smoke" },
});
check("4. update custom command (same name) → 200", updated, 200, (d) => d.command?.description === "Version two");

// 5. nama bawaan ditolak
const builtin = await call("POST", "/custom-commands", { name: "giveaway", description: "sneaky", content: "x" });
check("5. built-in command name rejected", builtin, 422, (d) => /built-in/.test(d.error));

// 6. embed bentuk lengkap
const embed = await call("POST", "/embed", {
  channelId: "444444444444444444",
  content: "outer text",
  embed: { title: "T", description: "D", color: 255, authorName: "A", footerText: "F", timestamp: true, fields: [{ name: "N", value: "V", inline: true }] },
  actor: { id: "smoke", tag: "smoke" },
});
check("6. send full-shape embed", embed, 201);

// 7. disable custom command via Command Manager
const putCmds = await call("PUT", "/commands", { disabled: ["smoke-test"] });
check("7. disable custom command via Command Manager", putCmds, 200, (d) => d.disabled?.includes("smoke-test"));

// 8. delete
const removed = await call("DELETE", `/custom-commands/${encodeURIComponent("smoke-test")}`);
check("8. delete custom command", removed, 200, (d) => d.ok === true);

// 9. validasi minimal
const empty = await call("POST", "/custom-commands", { name: "empty", description: "d", content: "", embed: {} });
check("9. command without a reply rejected", empty, 422, (d) => /at least/i.test(d.error));

console.log(`\n${fail === 0 ? "🎉 ALL PASSED" : "💥 FAILURES DETECTED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
