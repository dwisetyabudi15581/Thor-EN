// DASH API client — the bridge between the Next.js dashboard and the Thor
// bot (v3.16.0, Dyno-style).
//
// The bot runs a small HTTP API (src/infra/dashServer.js, default
// 127.0.0.1:8788). The dashboard NEVER writes bot files directly — every
// read/write goes through here so that:
//   1. Business validation stays in ONE place (inside the bot — shared with
//      slash commands); rules can never diverge between web vs Discord.
//   2. Hot-reload: the bot reads fresh config per operation; changes from
//      the web take effect immediately, no restart.
//   3. The secret DASH_API_TOKEN never leaves the server.

import { cfg } from "./config";

export class BotOfflineError extends Error {
  constructor(message = "The bot is not connected.") {
    super(message);
    this.name = "BotOfflineError";
  }
}

export class BotApiError extends Error {
  status: number;
  details?: string[];

  constructor(message: string, status: number, details?: string[]) {
    super(message);
    this.name = "BotApiError";
    this.status = status;
    this.details = details;
  }
}

type BotApiOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
};

/** Call the bot DASH API. Throws BotOfflineError when unreachable. */
export async function botApi<T = unknown>(pathname: string, opts: BotApiOptions = {}): Promise<T> {
  const { method = "GET", body, timeoutMs = 8000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.dashApiUrl}${pathname}`, {
      method,
      headers: {
        "x-dash-token": cfg.dashApiToken,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await res.text();
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!res.ok) {
      const message = typeof data.error === "string" ? data.error : `Bot API error ${res.status}`;
      throw new BotApiError(message, res.status, Array.isArray(data.details) ? (data.details as string[]) : undefined);
    }
    return data as T;
  } catch (err) {
    if (err instanceof BotApiError) throw err;
    // abort / fetch failure / connection refused → bot offline
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || msg.includes("abort") || msg.includes("aborted")) {
      throw new BotOfflineError();
    }
    throw new BotApiError(msg, 500);
  } finally {
    clearTimeout(timer);
  }
}

/** Check bot health without throwing (for the status banner). */
export async function botHealth(): Promise<{ online: boolean; guildCount?: number; version?: string }> {
  try {
    const data = await botApi<{ ok: boolean; guildCount: number; version: string }>("/health", { timeoutMs: 4000 });
    return { online: true, guildCount: data.guildCount, version: data.version };
  } catch {
    return { online: false };
  }
}

// === Bot data shapes (the subset used by the UI) ===

export type BotGuild = {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number | null;
  ownerId: string | null;
};

export type BotChannel = { id: string; name: string; type: number; position: number };
export type BotRole = { id: string; name: string; color: number; position: number };

export type TicketCategory = {
  id: string;
  label: string;
  emoji: string;
  style: string;
  requiresKey: boolean;
  isDefault?: boolean;
};

export type Product = {
  label: string;
  value: string;
  price: string;
  duration?: string;
  category: string;
  requiresKey: boolean;
  /** v3.19.0: auto-role mapping from /set-product-role — preserved when saved from the web. */
  roleId?: string;
  days?: number;
};

export type LevelRole = { level: number; roleId: string };

export type GuildConfig = {
  roles: Record<string, string | null>;
  channels: Record<string, string | null>;
  messages: Record<string, string>;
  colors: Record<string, number>;
  // v3.22.0: verifyButton REMOVED — verification is now a self-role panel.
  // autorole = the join auto-role list (/set-autorole parity).
  autorole: { roleIds: string[] };
  ticketCategories: TicketCategory[];
  leveling: {
    enabled: boolean;
    xpPerMessage: number;
    cooldownMs: number;
    announceLevelUp: boolean;
    levelUpChannel: string | null;
  };
  levelRoles: LevelRole[];
  midman: { feeMode: "percent" | "flat"; feeValue: number; category: string };
  products: Product[];
};

export type WordRule = { word: string; action: string | null; addedBy?: string; addedAt?: number };

export type AutoModConfig = {
  enabled: boolean;
  spamThreshold: number;
  spamWindowMs: number;
  spamAction: string;
  blockLinks: boolean;
  linkAllowedChannels: string[];
  linkAllowedRoles: string[];
  wordRules: WordRule[];
  exemptWords: string[];
  wordMatchMode: string;
  wordAction: string;
  maxMentions: number;
  mentionAction: string;
};

export type Responder = {
  id: string;
  trigger: string;
  matchMode: string;
  reply: string;
  replyType: string;
  cooldownMs: number;
  useCount?: number;
};

export type SelfRolePanel = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  title: string;
  description: string;
  type: string;
  exclusive: boolean;
  roles: Array<{ roleId: string; label: string; emoji?: string; description?: string; style?: string }>;
};

export type Announcement = {
  id: string;
  guildId: string;
  channelId: string;
  sendAt: number;
  sent: boolean;
  sentAt: number | null;
  recurring: string | null;
  data: {
    title: string;
    description: string;
    color?: number;
    image?: string | null;
    thumbnail?: string | null;
    mention?: string | null;
    authorId?: string;
    authorTag?: string;
  };
};

// ==== v3.19.0: new modules (Command Manager, Giveaway, Poll, Backup, Moderation, Keys) ====

export type CommandInfo = { name: string; description: string; domain: string; custom?: boolean };

export type CommandsSection = {
  list: CommandInfo[];
  disabled: string[];
  protected: string[];
};

export type Giveaway = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  prize: string;
  winnersCount: number;
  endsAt: number;
  ended: boolean;
  winnerIds: string[];
  participantIds: string[];
  hostId: string;
  hostTag: string;
  requiredRoleId: string | null;
  createdAt: number;
};

export type Poll = {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  question: string;
  options: Array<{ label: string; emoji: string; votes: string[] }>;
  multiple: boolean;
  closed: boolean;
  createdAt: number;
  closedAt: number | null;
  creatorId: string;
  creatorTag: string;
};

export type BackupEntry = { name: string; size: number; fileCount: number; mtime: number };

export type WarnRecord = {
  id: string;
  reason: string;
  warnedBy: string;
  warnedByTag: string;
  guildId: string;
  userId: string;
  createdAt: number;
  actionTaken: string | null;
};

export type ModLogRecord = {
  id: string;
  type: string;
  reason: string;
  durationMs: number | null;
  moderatorId: string;
  moderatorTag: string;
  guildId: string;
  userId: string;
  createdAt: number;
};

export type KeyRecord = {
  id: string;
  key: string;
  userId: string;
  username: string;
  roleId: string;
  productName: string;
  days: number;
  expireAt: number | null;
  createdAt: number;
  guildId: string;
};

// ==== v3.20.0: Custom Commands + full Embed Builder ====

/** Normalized embed def — the same shape the bot uses (embedPayload.js). */
export type EmbedDef = {
  title: string;
  description: string;
  color: number;
  authorName: string;
  authorIconURL: string;
  thumbnail: string;
  image: string;
  footerText: string;
  footerIconURL: string;
  timestamp: boolean;
  fields: Array<{ name: string; value: string; inline: boolean }>;
};

/** Admin-made custom command (created on the web -> real slash command on the server). */
export type CustomCommand = {
  name: string;
  description: string;
  ephemeral: boolean;
  content: string;
  embed: EmbedDef;
  createdBy: string | null;
  createdByTag: string | null;
  createdAt: number;
  updatedAt: number;
  useCount?: number;
};

// ==== v3.21.0: Quick Start — installed ticket panels (checklist status) ====

/** Installed ticket panel (slim shape — no big body; used for the checklist). */
export type TicketPanelInfo = {
  id: string;
  channelId: string;
  messageId: string | null;
  title: string | null;
  categoryIds: string[];
  useDropdown: boolean;
  createdAt: number | null;
};

export type DashboardPayload = {
  config: GuildConfig;
  automod: AutoModConfig;
  responders: Responder[];
  selfroles: SelfRolePanel[];
  tempvoice: { creatorChannelId: string | null; categoryId: string | null; activeChannels: number } | null;
  announces: Announcement[];
  serverstats: { enabled: boolean; config: unknown };
  commands: CommandsSection;
  giveaways: Giveaway[];
  polls: Poll[];
  backups: BackupEntry[];
  warns: WarnRecord[];
  modlogs: ModLogRecord[];
  keys: KeyRecord[];
  // v3.20.0
  customCommands: CustomCommand[];
  // v3.21.0: installed ticket panels — status of the "install ticket panel" step.
  panels: TicketPanelInfo[];
};

export type GuildMeta = {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number | null;
  channels: BotChannel[];
  roles: BotRole[];
};
