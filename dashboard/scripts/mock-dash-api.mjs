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
    roles: { admin: "333333333333333333" },
    // v3.23.0: verify/unverified role concepts removed — autorole + toggle.
    autorole: { roleIds: ["555555555555555555"], removeOnNewRole: true },
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
      { label: "VIP 30 Days", value: "vip30", price: "15,000 IDR", duration: "30 days", category: "transaction", requiresKey: true, roleId: "111111111111111111", days: 30 },
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
      { id: "222222222222222222", name: "Newbie", color: 10070709, position: 2 },
      { id: "555555555555555555", name: "Member", color: 0, position: 1 },
    ],
  };
}

// v3.19.0: demo command catalog for the Command Manager module (a
// representative subset — the real bot ships all 93 from the registry).
const COMMAND_CATALOG = [
  ["help", "Help hub: pick a category or search commands", "help"],
  ["setup-verify", "Set up the member verification panel", "config"],
  ["setup-ticket", "Set up a 1-category ticket panel (legacy)", "config"],
  ["set-role", "Set system roles (verified/admin/midman/booster)", "config"],
  ["set-channel", "Set system channels (welcome/invoice/logs/etc)", "config"],
  ["set-message", "Set system message texts", "config"],
  ["config-show", "View the whole configuration", "config"],
  ["reset-config", "Reset all configuration (2-step)", "config"],
  ["test-welcome", "Diagnose + preview welcome/goodbye", "config"],
  ["add-product", "Add a product to the price list", "products"],
  ["list-products", "View the product list", "products"],
  ["set-product-role", "Set a product auto-role + duration", "products"],
  ["set-key", "Grant a product key to a member", "keys"],
  ["list-keys", "View a member's keys", "keys"],
  ["clear-schedule", "Remove a user's schedule/keys", "keys"],
  ["add-category", "Add a ticket category", "categories"],
  ["setup-ticket-panel", "Install a multi-category ticket panel", "panels"],
  ["list-panels", "View all panels", "panels-mgmt"],
  ["setup-selfrole", "Create a self-role panel", "selfrole"],
  ["selfrole-list", "View self-role panels", "selfrole"],
  ["announce", "Send an embed announcement", "announce"],
  ["announce-schedule", "Schedule an announcement", "announce"],
  ["embed-builder", "Build embeds interactively", "embed"],
  ["send-message", "Send an embed via a form", "send-message"],
  ["backup-now", "Back up data now", "backup"],
  ["restore-backup", "Restore from a backup", "backup"],
  ["giveaway", "Manage giveaways (create/list/end/reroll)", "giveaway"],
  ["poll", "Create a poll with vote buttons", "poll"],
  ["warn", "Warn a member", "warn"],
  ["warn-list", "A member's warn history", "warn"],
  ["timeout", "Temporarily mute a member", "moderation"],
  ["kick", "Remove a member", "moderation"],
  ["ban", "Block a member", "moderation"],
  ["purge", "Bulk delete messages", "moderation"],
  ["stats", "Live server statistics", "stats"],
  ["leaderboard", "Top 10 members", "stats"],
  ["boosters", "Booster list + history", "stats"],
  ["serverstats", "Live channel counters", "serverstats"],
  ["setup-tempvoice", "Set up temporary voice", "tempvoice"],
  ["add-responder", "Add an auto-responder", "responder"],
  ["set-automod", "Configure auto-mod", "automod"],
  ["afk", "Set AFK status", "afk"],
  ["setup-leveling", "Enable XP & levels", "leveling"],
  ["rank", "View your level & XP", "leveling"],
  ["set-midman-fee", "Set the middleman fee", "midman"],
  ["midman-deals", "View active escrow deals", "midman"],
  ["commands", "Manage enabled/disabled commands", "commands"],
];

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
    // v3.19.0: Command Manager + new modules (demo data).
    commands: {
      list: COMMAND_CATALOG.map(([name, description, domain]) => ({ name, description, domain })),
      disabled: ["giveaway", "afk-list"],
      protected: ["commands"],
    },
    giveaways: [
      {
        id: `gw_${id}_1`,
        guildId: id,
        channelId: meta.channels[0].id,
        messageId: "112233445566778899",
        prize: "30 Days VIP",
        winnersCount: 2,
        endsAt: Date.now() + 7200_000,
        ended: false,
        winnerIds: [],
        participantIds: ["111111111111111111", "222222222222222222", "333333333333333333"],
        hostId: "333333333333333333",
        hostTag: "Owner#0001",
        requiredRoleId: null,
        createdAt: Date.now() - 3600_000,
      },
      {
        id: `gw_${id}_2`,
        guildId: id,
        channelId: meta.channels[1].id,
        messageId: "112233445566778800",
        prize: "1 Month Nitro",
        winnersCount: 1,
        endsAt: Date.now() - 86400_000,
        ended: true,
        winnerIds: ["222222222222222222"],
        participantIds: ["111111111111111111", "222222222222222222"],
        hostId: "333333333333333333",
        hostTag: "Owner#0001",
        requiredRoleId: null,
        createdAt: Date.now() - 172800_000,
      },
    ],
    polls: [
      {
        id: `poll_${id}_1`,
        guildId: id,
        channelId: meta.channels[1].id,
        messageId: "998877665544332200",
        question: "What should we play next?",
        options: [
          { label: "Mobile Legends", emoji: "1\u20e3", votes: ["111111111111111111"] },
          { label: "Valorant", emoji: "2\u20e3", votes: ["222222222222222222", "333333333333333333"] },
        ],
        multiple: false,
        closed: false,
        createdAt: Date.now() - 1800_000,
        closedAt: null,
        creatorId: "333333333333333333",
        creatorTag: "Owner#0001",
      },
    ],
    backups: [
      { name: "2026-09-14_08-30-00", size: 24576, fileCount: 12, mtime: Date.now() - 86400_000 },
      { name: "2026-09-13_08-30-00", size: 23552, fileCount: 12, mtime: Date.now() - 172800_000 },
      { name: "pre-restore_2026-09-12_10-15-00", size: 23040, fileCount: 11, mtime: Date.now() - 259200_000 },
    ],
    warns: [
      {
        id: `warn_${id}_1`,
        reason: "Spam links in general chat",
        warnedBy: "333333333333333333",
        warnedByTag: "Owner#0001",
        guildId: id,
        userId: "999222999222999222",
        createdAt: Date.now() - 5400_000,
        actionTaken: null,
      },
      {
        id: `warn_${id}_2`,
        reason: "Rude language",
        warnedBy: "444444444444444444",
        warnedByTag: "Moderator#0002",
        guildId: id,
        userId: "888777888777888777",
        createdAt: Date.now() - 172800_000,
        actionTaken: null,
      },
    ],
    modlogs: [
      {
        id: `mod_${id}_1`,
        type: "timeout",
        reason: "Spam after a warning",
        durationMs: 3600000,
        moderatorId: "444444444444444444",
        moderatorTag: "Moderator#0002",
        guildId: id,
        userId: "999222999222999222",
        createdAt: Date.now() - 5300_000,
      },
      {
        id: `mod_${id}_2`,
        type: "kick",
        reason: "Advertising another server",
        durationMs: null,
        moderatorId: "333333333333333333",
        moderatorTag: "Owner#0001",
        guildId: id,
        userId: "777666777666777666",
        createdAt: Date.now() - 259200_000,
      },
    ],
    keys: [
      {
        id: `key_${id}_1`,
        key: "ABCDE-FGHIJ-KLMNO",
        userId: "111111111111111111",
        username: "Budi#1234",
        roleId: "111111111111111111",
        productName: "VIP 30 Days",
        days: 30,
        expireAt: Date.now() + 2592000_000,
        createdAt: Date.now() - 86400000,
        guildId: id,
      },
      {
        id: `key_${id}_2`,
        key: "PQRST-UVWXY-Z0123",
        userId: "222222222222222222",
        username: "Sari#5678",
        roleId: "111111111111111111",
        productName: "VIP 90 Days",
        days: 90,
        expireAt: null,
        createdAt: Date.now() - 172800000,
        guildId: id,
      },
    ],
    // v3.21.0: installed ticket panels (Quick Start checklist status).
    // Deliberately empty in the demo — the "install ticket panel" step shows
    // as pending, so the full quickstart flow can be tried from the web.
    panels: [],
    // v3.20.0: demo custom commands — a realistic sample of the Custom
    // Command module's output.
    customCommands: [
      {
        name: "socials",
        description: "All of our social media links",
        ephemeral: false,
        content: "Follow our socials!",
        embed: {
          title: "📱 SERVER SOCIAL MEDIA",
          description: "All of our official channels are here.",
          color: 5793266,
          authorName: "",
          authorIconURL: "",
          thumbnail: "",
          image: "",
          footerText: "Updated regularly by the admins",
          footerIconURL: "",
          timestamp: true,
          fields: [
            { name: "Instagram", value: "@thorbot", inline: true },
            { name: "TikTok", value: "@thorbot", inline: true },
            { name: "YouTube", value: "Thor Community", inline: true },
          ],
        },
        createdBy: "333333333333333333",
        createdByTag: "Owner#0001",
        createdAt: Date.now() - 345600000,
        updatedAt: Date.now() - 86400000,
        useCount: 47,
      },
      {
        name: "rules",
        description: "Short version of the server rules",
        ephemeral: true,
        content: "",
        embed: {
          title: "📜 SERVER RULES",
          description: "1. Be polite\n2. No spam\n3. No ads without permission\n4. Stay on topic per channel",
          color: 15105570,
          authorName: "",
          authorIconURL: "",
          thumbnail: "",
          image: "",
          footerText: "Violations = warn / mute / ban",
          footerIconURL: "",
          timestamp: false,
          fields: [],
        },
        createdBy: "333333333333333333",
        createdByTag: "Owner#0001",
        createdAt: Date.now() - 691200000,
        updatedAt: Date.now() - 691200000,
        useCount: 128,
      },
    ],
    // v3.24.0: insight modules — statistics + leaderboards + boosters + AFK + deals.
    stats: {
      server: { totalUsers: 128, totalMessages: 45210, totalPurchases: 89, totalRevenue: 12500000, totalGiveawaysWon: 34 },
      top: {
        messages: [
          { userId: "444444444444444444", value: 8214 },
          { userId: "555555555555555555", value: 6102 },
          { userId: "666666666666666666", value: 4550 },
        ],
        purchases: [
          { userId: "555555555555555555", value: 12 },
          { userId: "444444444444444444", value: 7 },
        ],
        spends: [
          { userId: "555555555555555555", value: 2400000 },
          { userId: "444444444444444444", value: 980000 },
        ],
        wins: [{ userId: "666666666666666666", value: 5 }],
      },
    },
    levelTop: [
      { userId: "444444444444444444", level: 42, totalXp: 28450, xp: 320 },
      { userId: "555555555555555555", level: 31, totalXp: 19120, xp: 80 },
    ],
    afk: [
      { userId: "666666666666666666", reason: "hard at work", since: Date.now() - 5400000 },
      { userId: "777777777777777777", reason: "lunch break", since: Date.now() - 1800000 },
    ],
    midmanDeals: [
      {
        id: "deal_demo_1",
        channelId: "111111111111111112",
        state: "locked",
        stateLabel: "Locked",
        buyerId: "444444444444444444",
        sellerId: "555555555555555555",
        item: "Radiant Valorant account",
        buyerPays: 105000,
        sellerGets: 100000,
        fee: 5000,
        createdAt: Date.now() - 7200000,
      },
    ],
    boosters: {
      live: [{ userId: "888888888888888888", tag: "Booster#0001", since: Date.now() - 2592000000 }],
      recent: [
        { userId: "888888888888888888", event: "boost_added", at: Date.now() - 2592000000 },
        { userId: "999999999999999999", event: "boost_removed", at: Date.now() - 86400000 },
      ],
    },
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
    if (!entry) return send(404, { error: "The bot is not in this server" });
    // v3.20.0: custom commands join the Command Manager list (domain
    // 'custom') — same as the real bot's payload (dashServer.js).
    const payload = {
      ...entry.data,
      commands: {
        ...entry.data.commands,
        list: [
          ...entry.data.commands.list,
          ...entry.data.customCommands.map((c) => ({ name: c.name, description: c.description, domain: "custom", custom: true })),
        ],
      },
    };
    return send(200, payload);
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

  // v3.24.0: test welcome/goodbye — the mock always "succeeds" + diagnosis lines.
  if (req.method === "POST" && rest[0] === "welcome-test" && rest.length === 1) {
    const body = await readBody();
    const tipe = body?.type === "goodbye" ? "goodbye" : body?.type === "welcome" ? "welcome" : null;
    if (!tipe) return send(400, { error: "type must be welcome | goodbye" });
    const channelId = entry.data.config.channels?.[tipe] ?? null;
    if (!channelId) {
      return send(422, { ok: false, lines: [`❌ ${tipe} channel: not set yet — configure it in the General module.`], error: `The ${tipe} channel is not ready — fix it first.` });
    }
    return send(200, {
      ok: true,
      sent: true,
      channelId,
      lines: [`✅ ${tipe} channel: ready`, "✅ Send Messages · ✅ Embed Links (bot permissions)"],
    });
  }

  // v3.24.0: clear a member's AFK status.
  if (req.method === "DELETE" && rest[0] === "afk" && rest.length === 2) {
    const before = entry.data.afk.length;
    entry.data.afk = entry.data.afk.filter((u) => u.userId !== rest[1]);
    if (entry.data.afk.length === before) return send(404, { error: "That member is not currently AFK" });
    return send(200, { ok: true });
  }

  // v3.19.0: Command Manager — save the disabled list
  // v3.20.0: this guild's custom commands may be disabled too.
  if (req.method === "PUT" && rest[0] === "commands" && rest.length === 1) {
    const body = await readBody();
    const disabled = Array.isArray(body?.disabled) ? body.disabled : null;
    if (!disabled) return send(422, { error: "Invalid command list (must be an array)" });
    const known = new Set([...entry.data.commands.list.map((c) => c.name), ...entry.data.customCommands.map((c) => c.name)]);
    const bad = disabled.filter((n) => !known.has(String(n)));
    if (bad.length) return send(422, { error: `Unknown command \`${bad[0]}\`` });
    if (disabled.includes("commands")) return send(422, { error: "The `/commands` command cannot be disabled — it is the command management door" });
    entry.data.commands.disabled = [...new Set(disabled.map(String))];
    return send(200, { ok: true, disabled: entry.data.commands.disabled, total: known.size });
  }

  // v3.20.0: Custom Commands — create/update + delete from the web
  if (rest[0] === "custom-commands") {
    if (req.method === "POST" && rest.length === 1) {
      const body = await readBody();
      const name = String(body?.name || "").trim().toLowerCase();
      const description = String(body?.description || "").trim();
      const content = String(body?.content || "").trim();
      const embed = body?.embed && typeof body.embed === "object" ? body.embed : {};
      if (!/^[a-z0-9_-]{1,32}$/.test(name)) return send(422, { error: "Command name may only use lowercase letters, numbers, - and _ (1-32 characters)" });
      if (entry.data.commands.list.some((c) => c.name === name)) return send(422, { error: `The name \`/${name}\` is already used by a built-in bot command — pick another name` });
      if (!description || description.length > 100) return send(422, { error: "Description is required (1-100 characters)" });
      const embedHasContent = [embed.title, embed.description, embed.authorName, embed.footerText, embed.image, embed.thumbnail].some((v) => String(v || "").trim()) || (Array.isArray(embed.fields) && embed.fields.length > 0);
      if (!content && !embedHasContent) return send(422, { error: "Set at least reply text OR an embed — both are empty" });
      if (!entry.data.customCommands.some((c) => c.name === name) && entry.data.customCommands.length >= 20) {
        return send(422, { error: "Maximum 20 custom commands per server" });
      }
      const now = Date.now();
      const existing = entry.data.customCommands.find((c) => c.name === name);
      const normalizedEmbed = {
        title: String(embed.title || ""),
        description: String(embed.description || ""),
        color: Number.isInteger(embed.color) ? embed.color : 0x5865f2,
        authorName: String(embed.authorName || ""),
        authorIconURL: String(embed.authorIconURL || ""),
        thumbnail: String(embed.thumbnail || ""),
        image: String(embed.image || ""),
        footerText: String(embed.footerText || ""),
        footerIconURL: String(embed.footerIconURL || ""),
        timestamp: embed.timestamp === true,
        fields: (Array.isArray(embed.fields) ? embed.fields : []).filter((f) => String(f?.name || "").trim() || String(f?.value || "").trim()).map((f) => ({ name: String(f.name || ""), value: String(f.value || ""), inline: f.inline === true })),
      };
      let command;
      if (existing) {
        Object.assign(existing, { description, ephemeral: body?.ephemeral === true, content, embed: normalizedEmbed, updatedAt: now });
        command = existing;
      } else {
        command = {
          name,
          description,
          ephemeral: body?.ephemeral === true,
          content,
          embed: normalizedEmbed,
          createdBy: String(body?.actor?.id || "mock"),
          createdByTag: String(body?.actor?.tag || "Dashboard"),
          createdAt: now,
          updatedAt: now,
          useCount: 0,
        };
        entry.data.customCommands.push(command);
      }
      return send(existing ? 200 : 201, { ok: true, command, synced: true });
    }
    if (req.method === "DELETE" && rest.length === 2) {
      const name = decodeURIComponent(rest[1]);
      const before = entry.data.customCommands.length;
      entry.data.customCommands = entry.data.customCommands.filter((c) => c.name !== name);
      if (entry.data.customCommands.length === before) return send(404, { error: `Custom command \`/${name}\` not found` });
      // Stale disable flags are cleaned from the disabled list too.
      entry.data.commands.disabled = entry.data.commands.disabled.filter((n) => n !== name);
      return send(200, { ok: true, synced: true });
    }
  }

  // v3.19.0: Giveaway from the web
  if (req.method === "POST" && rest[0] === "giveaway" && rest.length === 1) {
    const body = await readBody();
    const channelId = String(body?.channelId || "");
    const prize = String(body?.prize || "").trim();
    const winners = Number(body?.winners ?? 1);
    const durationMin = Number(body?.durationMin);
    if (!/^\d{5,25}$/.test(channelId)) return send(400, { error: "Invalid channelId" });
    if (!prize || prize.length > 200) return send(400, { error: "Prize is required, max 200 characters" });
    if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 43200) return send(400, { error: "Duration must be 1 minute to 30 days (43200 minutes)" });
    if (!Number.isInteger(winners) || winners < 1 || winners > 20) return send(400, { error: "Winners must be 1-20" });
    const gw = {
      id: `gw_${guildId}_${Date.now()}`,
      guildId,
      channelId,
      messageId: `mock_${Date.now()}`,
      prize,
      winnersCount: winners,
      endsAt: Date.now() + durationMin * 60000,
      ended: false,
      winnerIds: [],
      participantIds: [],
      hostId: String(body?.actor?.id || "dash"),
      hostTag: String(body?.actor?.tag || "Dashboard"),
      requiredRoleId: body?.requiredRoleId ? String(body.requiredRoleId) : null,
      createdAt: Date.now(),
    };
    entry.data.giveaways.unshift(gw);
    return send(201, { ok: true, giveaway: gw });
  }

  // v3.19.0: Poll from the web
  if (req.method === "POST" && rest[0] === "poll" && rest.length === 1) {
    const body = await readBody();
    const channelId = String(body?.channelId || "");
    const question = String(body?.question || "").trim();
    const rawOptions = Array.isArray(body?.options) ? body.options : [];
    if (!/^\d{5,25}$/.test(channelId)) return send(400, { error: "Invalid channelId" });
    if (!question || question.length > 250) return send(400, { error: "Question is required, max 250 characters" });
    if (rawOptions.length < 2 || rawOptions.length > 10) return send(400, { error: "A poll needs 2-10 options" });
    const poll = {
      id: `poll_${guildId}_${Date.now()}`,
      guildId,
      channelId,
      messageId: `mock_${Date.now()}`,
      question,
      options: rawOptions.map((o, i) => ({ label: String(o.label || "").slice(0, 80), emoji: o.emoji ? String(o.emoji).slice(0, 64) : `${i + 1}\u20e3`, votes: [] })),
      multiple: !!body?.multiple,
      closed: false,
      createdAt: Date.now(),
      closedAt: null,
      creatorId: String(body?.actor?.id || "dash"),
      creatorTag: String(body?.actor?.tag || "Dashboard"),
    };
    entry.data.polls.unshift(poll);
    return send(201, { ok: true, poll });
  }

  // v3.19.0: Embed from the web — v3.20.0: full shape (content + embed object)
  if (req.method === "POST" && rest[0] === "embed" && rest.length === 1) {
    const body = await readBody();
    const channelId = String(body?.channelId || "");
    if (!/^\d{5,25}$/.test(channelId)) return send(400, { error: "Invalid channelId" });
    const content = String(body?.content || "").trim();
    const embed = body?.embed && typeof body.embed === "object" ? body.embed : { title: body?.title, description: body?.description };
    const hasEmbed = [embed.title, embed.description, embed.authorName, embed.footerText, embed.image, embed.thumbnail].some((v) => String(v || "").trim()) || (Array.isArray(embed.fields) && embed.fields.some((f) => String(f?.name || "").trim() || String(f?.value || "").trim()));
    if (!content && !hasEmbed) return send(400, { error: "At least a title, description, or content is required" });
    return send(201, { ok: true, messageId: `mock_${Date.now()}`, url: "https://discord.com/channels/mock/mock" });
  }

  // v3.19.0: Backup from the web
  if (rest[0] === "backups") {
    if (req.method === "POST" && rest.length === 1) {
      await readBody();
      const name = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace(/[T:]/g, (c) => (c === "T" ? "_" : "-"));
      entry.data.backups.unshift({ name, size: 24000 + Math.floor(Math.random() * 4000), fileCount: 12, mtime: Date.now() });
      return send(201, { ok: true, backupName: name, filesCopied: 12 });
    }
    if (req.method === "POST" && rest.length === 3 && rest[2] === "restore") {
      await readBody();
      const name = rest[1];
      if (!entry.data.backups.some((b) => b.name === name)) return send(422, { error: `Restore failed: backup '${name}' not found` });
      return send(200, { ok: true, filesRestored: 12, note: "Bot data restored from the backup (mock)." });
    }
  }

  // v3.19.0: Keys from the web
  if (rest[0] === "keys") {
    if (req.method === "POST" && rest.length === 1) {
      const body = await readBody();
      const userId = String(body?.userId || "");
      const value = String(body?.value || "");
      if (!/^\d{5,25}$/.test(userId)) return send(400, { error: "Invalid userId (Discord ID)" });
      const product = entry.data.config.products.find((p) => p.value === value);
      if (!product) return send(404, { error: `Product value "${value}" not found` });
      if (!product.roleId) return send(422, { error: `Product ${product.label} has no role yet — set one in the Tickets & Products module first` });
      const keyValue =
        (typeof body?.key === "string" ? body.key.trim() : "") ||
        Array.from({ length: 3 }, () => Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("")).join("-");
      const days = product.days || 0;
      const keyEntry = {
        id: `key_${guildId}_${Date.now()}`,
        key: keyValue,
        userId,
        username: `User#${userId.slice(-4)}`,
        roleId: product.roleId,
        productName: product.label,
        days,
        expireAt: days > 0 ? Date.now() + days * 86400000 : null,
        createdAt: Date.now(),
        guildId,
      };
      entry.data.keys.unshift(keyEntry);
      return send(201, { ok: true, key: keyEntry.key, expireAt: keyEntry.expireAt, warnings: [] });
    }
    if (req.method === "DELETE" && rest.length === 1) {
      const userId = url.searchParams.get("userId");
      if (!userId || !/^\d{5,25}$/.test(userId)) return send(400, { error: "The userId (Discord ID) parameter is required" });
      const before = entry.data.keys.length;
      entry.data.keys = entry.data.keys.filter((k) => k.userId !== userId);
      const removedKeys = before - entry.data.keys.length;
      if (removedKeys === 0) return send(404, { error: "No keys / schedules for that user on this server" });
      return send(200, { ok: true, removedKeys, removedSchedules: removedKeys, warnings: [] });
    }
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

  // v3.21.0: Quick Start — install ticket + verification panels (in-memory demo).
  // Prerequisite validation matches the real bot so the checklist flow feels real.
  if (req.method === "POST" && rest[0] === "panels" && rest.length === 1) {
    const body = await readBody();
    if (!entry.data.config.roles?.admin) return send(422, { error: "The Bot Admin role is not set yet — fill in Quick Start step 1 (Admin Role) first." });
    const allCats = entry.data.config.ticketCategories ?? [];
    if (allCats.length === 0) return send(422, { error: "No ticket categories yet — add one in Quick Start step 3 / the Tickets & Products module first." });
    const channelId = String(body?.channelId || "");
    if (!/^\d{5,25}$/.test(channelId)) return send(400, { error: "channelId is not valid" });
    const ch = entry.meta.channels.find((c) => c.id === channelId && (c.type === 0 || c.type === 5));
    if (!ch) return send(400, { error: "The channel must be a text channel" });
    // Optional category filter — parity with the real bot (no matching categoryIds → 400).
    const requested = Array.isArray(body?.categoryIds) ? body.categoryIds.map(String) : null;
    const cats = requested ? allCats.filter((c) => requested.includes(c.id)) : allCats;
    if (cats.length === 0) return send(400, { error: "No category matches the requested categoryIds" });
    const panel = {
      id: `tp_demo_${Date.now().toString(36)}`,
      channelId,
      messageId: `msg_${Date.now()}`,
      title: body?.title ? String(body.title).slice(0, 256) : null,
      categoryIds: cats.map((c) => c.id),
      useDropdown: body?.useDropdown === true,
      createdAt: Date.now(),
    };
    entry.data.panels.push(panel);
    return send(201, { ok: true, panel, url: `https://discord.com/channels/${guildId}/${channelId}/demo` });
  }
  if (req.method === "POST" && rest[0] === "verify-panel" && rest.length === 1) {
    const body = await readBody();
    if (!entry.data.config.roles?.verified) return send(422, { error: "The Verified role is not set yet — fill in Quick Start step 2 (Verified Role) first." });
    const channelId = String(body?.channelId || "");
    if (!/^\d{5,25}$/.test(channelId)) return send(400, { error: "channelId is not valid" });
    const ch = entry.meta.channels.find((c) => c.id === channelId && (c.type === 0 || c.type === 5));
    if (!ch) return send(400, { error: "The channel must be a text channel" });
    return send(201, { ok: true, messageId: `msg_${Date.now()}`, url: `https://discord.com/channels/${guildId}/${channelId}/demo` });
  }

  return send(404, { error: "Endpoint not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`🧪 Mock DASH API ready: http://${HOST}:${PORT} (token-secured, in-memory demo data)`);
  console.log("   Used by the web dashboard while the real bot is not deployed. Production: turn this mock off.");
});
