#!/usr/bin/env node
/**
 * Mock DASH API — a fake Thor bot DASH API server for SANDBOX/DEMO use.
 *
 * Why it exists: the web dashboard needs a running bot to display data. In
 * a sandbox the bot doesn't run (no DISCORD_TOKEN) — this mock serves the
 * SAME endpoints (health/guilds/meta/dashboard/config/automod/
 * responders/announce/selfroles) with realistic demo data, so:
 *   1. The dashboard UI can be developed + tested + screenshotted fully.
 *   2. USERS can preview the dashboard with their own real Discord servers
 *      before the bot is deployed (see /__demo/adopt).
 *
 * Production: NOT used. The web automatically ignores the mock (the
 * /__demo/adopt endpoint doesn't exist on the real bot → 404 → ignored).
 * Run the real bot + set DASH_API_URL/TOKEN in the web .env instead.
 *
 * Run: node scripts/mock-dash-api.mjs   (default 127.0.0.1:8788)
 * Env: MOCK_DASH_PORT, MOCK_DASH_TOKEN, MOCK_DASH_HOST
 */

import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.MOCK_DASH_PORT || process.env.DASH_API_PORT || 8788);
const HOST = process.env.MOCK_DASH_HOST || "127.0.0.1";
const TOKEN = process.env.MOCK_DASH_TOKEN || "dash-dev-token-thor-local-8788";

// ============================================================
// === In-memory store per guild ===
// ============================================================

const guilds = new Map(); // guildId -> { meta, data }

function defaultConfig() {
  return {
    roles: { verified: "111111111111111111", unverified: "222222222222222222", admin: "333333333333333333" },
    channels: { welcome: "444444444444444444", goodbye: null, invoice: "555555555555555555" },
    messages: {
      welcomeTitle: "👋 WELCOME!",
      welcomeBody: "Hi {user}!\n\nWelcome to **{server}** 🎉\n\n🔐 Please verify yourself to gain full access to the server.\n\n📊 You are member number **{count}**!",
      goodbyeTitle: "👋 FAREWELL",
      goodbyeBody: "**{username}** has {action} the server.\n\nSee you again! 👋",
      verifyTitle: "✅ SERVER VERIFICATION",
      verifyBody: "Welcome to **{server}**!\nClick the button below to get verified and gain full access to every channel.",
      ticketTitle: "🎫 TICKET SYSTEM & PRICE LIST",
      ticketBody: "Need help or want to buy something?\n\nClick a category button below to get started.\n\n**{price_header}**\n{price_list}",
      ticketPriceHeader: "💰 PRICE LIST 💰",
    },
    colors: { success: 3066993, danger: 15158332, primary: 3447003, warning: 15105570, info: 5793266 },
    verifyButton: { label: "Verify Me", emoji: "✅", style: "Success" },
    ticketCategories: [
      { id: "transaction", label: "Buy Key / Transaction", emoji: "🔑", style: "Primary", requiresKey: true, isDefault: true },
      { id: "help", label: "Help", emoji: "📞", style: "Secondary", requiresKey: false, isDefault: true },
      { id: "report", label: "Report", emoji: "⚠️", style: "Danger", requiresKey: false, isDefault: true },
    ],
    leveling: { enabled: true, xpPerMessage: 15, cooldownMs: 60000, announceLevelUp: true, levelUpChannel: null },
    levelRoles: [
      { level: 5, roleId: "333333333333333333" },
      { level: 10, roleId: "111111111111111111" },
    ],
    midman: { feeMode: "percent", feeValue: 5, category: "🤝 MIDDLEMAN" },
    products: [
      { label: "VIP 30 Days", value: "vip30", price: "15,000 IDR", duration: "30 days", category: "transaction", requiresKey: true },
      { label: "VIP 90 Days", value: "vip90", price: "35,000 IDR", duration: "90 days", category: "transaction", requiresKey: true },
      { label: "Bot Setup Service", value: "setup", price: "50,000 IDR", category: "transaction", requiresKey: false },
    ],
  };
}

function defaultAutomod() {
  return {
    enabled: true,
    spamThreshold: 5,
    spamWindowMs: 10000,
    spamAction: "mute_10m",
    blockLinks: false,
    linkAllowedChannels: [],
    linkAllowedRoles: [],
    wordRules: [
      { word: "scam", action: "delete_only", addedBy: "mock", addedAt: Date.now() },
      { word: "account selling", action: "mute_10m", addedBy: "mock", addedAt: Date.now() },
    ],
    exemptWords: ["scammer-alert"],
    wordMatchMode: "whole_word",
    wordAction: "delete_only",
    maxMentions: 5,
    mentionAction: "warn",
  };
}

function makeMeta({ id, name, icon, memberCount }) {
  const ch = (n, t, p) => ({ id: crypto.randomBytes(8).toString("hex").padEnd(18, "4").replace(/[^0-9]/g, "7").slice(0, 18), name: n, type: t, position: p });
  return {
    id,
    name,
    icon: icon ?? null,
    memberCount: memberCount ?? 128,
    channels: [
      ch("📢 announcements", 0, 0),
      ch("💬 general", 0, 1),
      ch("🎫 create-ticket", 0, 2),
      ch("🏆 leaderboard", 0, 3),
      ch("🎧 Lounge", 2, 4),
    ],
    roles: [
      { id: "333333333333333333", name: "Admin", color: 15548997, position: 5 },
      { id: "444444444444444444", name: "Moderator", color: 3447003, position: 4 },
      { id: "111111111111111111", name: "VIP", color: 15844367, position: 3 },
      { id: "222222222222222222", name: "Unverified", color: 10070709, position: 2 },
      { id: "555555555555555555", name: "Member", color: 0, position: 1 },
    ],
  };
}

function seedGuild({ id, name, icon, memberCount }) {
  const meta = makeMeta({ id, name, icon, memberCount });
  const data = {
    config: defaultConfig(),
    automod: defaultAutomod(),
    responders: [
      {
        id: `resp_${id}_1`,
        trigger: "price",
        matchMode: "contains",
        reply: "Check the price list in 📢 announcements!",
        replyType: "text",
        cooldownMs: 3000,
        useCount: 12,
      },
      {
        id: `resp_${id}_2`,
        trigger: "!sosmed",
        matchMode: "exact",
        reply: "Instagram: @thorbot • TikTok: @thorbot",
        replyType: "text",
        cooldownMs: 5000,
        useCount: 3,
      },
    ],
    selfroles: [
      {
        id: `srp_${id}_1`,
        guildId: id,
        channelId: meta.channels[1].id,
        messageId: "998877665544332211",
        title: "🎭 Pick Your Roles",
        description: "Click a button to get or remove a role.",
        type: "button",
        exclusive: false,
        roles: [
          { roleId: "111111111111111111", label: "VIP", emoji: "⭐", description: "VIP role", style: "Success" },
          { roleId: "555555555555555555", label: "Notifs", emoji: "🔔", description: "Announcement ping", style: "Secondary" },
        ],
      },
    ],
    tempvoice: { creatorChannelId: meta.channels[4].id, categoryId: "777777777777777777", activeChannels: 2 },
    announces: [
      {
        id: `sa_${id}_1`,
        guildId: id,
        channelId: meta.channels[0].id,
        sendAt: Date.now() + 3600_000,
        sent: false,
        sentAt: null,
        recurring: null,
        data: { title: "Weekend Event 🎉", description: "Don't forget to join this week's event!", color: 5793266, mention: "@everyone" },
      },
    ],
    serverstats: { enabled: true, config: { enabled: true } },
  };
  guilds.set(id, { meta, data });
  return guilds.get(id);
}

function setPath(obj, dotPath, value) {
  const parts = dotPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// ============================================================
// === HTTP server ===
// ============================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };
  const readBody = () =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
        } catch {
          resolve({});
        }
      });
    });

  if (req.method === "GET" && url.pathname === "/health") {
    return send(200, { ok: true, ready: true, guildCount: guilds.size, uptimeSec: Math.floor(process.uptime()), version: "mock-3.16.0" });
  }

  // Token auth
  const got = req.headers["x-dash-token"];
  if (!got || got.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN))) {
    return send(401, { error: "Invalid token" });
  }

  // --- Demo-only endpoint: adopt the user's guilds so they can be previewed ---
  if (req.method === "POST" && url.pathname === "/__demo/adopt") {
    const body = await readBody();
    const list = Array.isArray(body?.guilds) ? body.guilds : [];
    for (const g of list) {
      if (!g?.id || !/^\d{5,25}$/.test(String(g.id))) continue;
      if (!guilds.has(g.id)) seedGuild({ id: String(g.id), name: String(g.name || "Server"), icon: g.icon ?? null, memberCount: g.memberCount ?? null });
    }
    return send(200, { ok: true, adopted: list.length });
  }

  if (parts[0] !== "guilds") return send(404, { error: "Endpoint not found" });

  if (req.method === "GET" && parts.length === 1) {
    return send(200, { guilds: [...guilds.values()].map(({ meta }) => ({ id: meta.id, name: meta.name, icon: meta.icon, memberCount: meta.memberCount, ownerId: null })) });
  }

  const guildId = parts[1];
  const entry = guilds.get(guildId);
  const rest = parts.slice(2);

  if (req.method === "GET" && rest[0] === "meta") {
    return entry ? send(200, entry.meta) : send(404, { error: "The bot is not in this server" });
  }
  if (req.method === "GET" && rest[0] === "dashboard") {
    return entry ? send(200, entry.data) : send(404, { error: "The bot is not in this server" });
  }

  if (!entry) return send(404, { error: "The bot is not in this server" });

  if (req.method === "PUT" && rest[0] === "config") {
    const body = await readBody();
    const updates = body?.updates ?? {};
    for (const [p, v] of Object.entries(updates)) setPath(entry.data.config, p, v);
    console.log(`[m[mock-dash] config ${guildId} += ${Object.keys(updates).length} field (actor ${body?.actor?.tag ?? "?"})`);
    return send(200, { ok: true, applied: Object.keys(updates), config: entry.data.config });
  }

  if (req.method === "PUT" && rest[0] === "automod") {
    const body = await readBody();
    delete body.actor;
    entry.data.automod = { ...entry.data.automod, ...body };
    return send(200, { ok: true, automod: entry.data.automod });
  }

  if (rest[0] === "responders") {
    if (req.method === "POST" && rest.length === 1) {
      const body = await readBody();
      if (entry.data.responders.some((r) => r.trigger.toLowerCase() === String(body.trigger).toLowerCase())) {
        return send(409, { error: `Trigger "${body.trigger}" already exists.` });
      }
      entry.data.responders.push({
        id: `resp_${Date.now()}`,
        trigger: String(body.trigger),
        matchMode: body.matchMode ?? "contains",
        reply: String(body.reply),
        replyType: body.replyType ?? "text",
        cooldownMs: body.cooldownMs ?? 3000,
        useCount: 0,
      });
      return send(201, { ok: true, responders: entry.data.responders });
    }
    if (req.method === "DELETE" && rest.length === 1) {
      const trigger = url.searchParams.get("trigger");
      const before = entry.data.responders.length;
      entry.data.responders = entry.data.responders.filter((r) => r.trigger.toLowerCase() !== trigger?.toLowerCase());
      if (entry.data.responders.length === before) return send(404, { error: "Trigger not found." });
      return send(200, { ok: true, responders: entry.data.responders });
    }
  }

  if (rest[0] === "announce") {
    if (req.method === "POST" && rest.length === 1) {
      const body = await readBody();
      const ann = {
        id: `sa_${Date.now()}`,
        guildId,
        channelId: body.channelId,
        sendAt: typeof body.sendAt === "string" ? Date.parse(body.sendAt) : Number(body.sendAt),
        sent: false,
        sentAt: null,
        recurring: body.recurring ?? null,
        data: { title: body.title, description: body.description, color: body.color ?? 5793266, mention: body.mention ?? null },
      };
      entry.data.announces.push(ann);
      return send(201, { ok: true, announcement: ann });
    }
    if (req.method === "DELETE" && rest.length === 2) {
      const before = entry.data.announces.length;
      entry.data.announces = entry.data.announces.filter((a) => a.id !== rest[1]);
      if (entry.data.announces.length === before) return send(404, { error: "Announcement not found" });
      return send(200, { ok: true });
    }
  }

  if (rest[0] === "selfroles") {
    if (req.method === "POST" && rest.length === 1) {
      const body = await readBody();
      const panel = {
        id: `srp_${Date.now()}`,
        guildId,
        channelId: body.channelId,
        messageId: `mock_${Date.now()}`,
        title: body.title ?? "🎭 Self Role",
        description: body.description ?? "Click to get or remove a role.",
        type: body.type ?? "button",
        exclusive: !!body.exclusive,
        roles: (body.roles ?? []).map((r) => ({ roleId: r.roleId, label: r.label, emoji: r.emoji, description: r.description, style: r.style ?? "Secondary" })),
      };
      entry.data.selfroles.push(panel);
      return send(201, { ok: true, panel });
    }
    if (req.method === "DELETE" && rest.length === 2) {
      entry.data.selfroles = entry.data.selfroles.filter((p) => p.id !== rest[1]);
      return send(200, { ok: true });
    }
    if (req.method === "POST" && rest.length === 3 && rest[2] === "roles") {
      const body = await readBody();
      const panel = entry.data.selfroles.find((p) => p.id === rest[1]);
      if (!panel) return send(404, { error: "Panel not found" });
      panel.roles.push({ roleId: body.roleId, label: body.label, emoji: body.emoji, description: body.description, style: body.style ?? "Secondary" });
      return send(200, { ok: true, panel });
    }
    if (req.method === "DELETE" && rest.length === 3 && rest[2] === "roles") {
      const roleId = url.searchParams.get("roleId");
      const panel = entry.data.selfroles.find((p) => p.id === rest[1]);
      if (!panel) return send(404, { error: "Panel not found" });
      panel.roles = panel.roles.filter((r) => r.roleId !== roleId);
      return send(200, { ok: true, panel });
    }
  }

  if (req.method === "POST" && rest[0] === "serverstats" && rest[1] === "refresh") {
    return send(200, { ok: true, result: { updated: 5, deferred: 0, missing: 0, errors: 0 } });
  }
  if (req.method === "DELETE" && rest[0] === "tempvoice") {
    if (!entry.data.tempvoice) return send(404, { error: "Temp voice setup not found" });
    entry.data.tempvoice = null;
    return send(200, { ok: true, note: "(demo) config detached." });
  }

  return send(404, { error: "Endpoint not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`🧪 Mock DASH API ready: http://${HOST}:${PORT} (token-secured, in-memory demo data)`);
  console.log("   Used by the web dashboard while the real bot is not deployed. Production: turn this mock off.");
});
