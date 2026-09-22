"use client";

// GuildDashboard — main per-server dashboard shell .
// State architecture:
//   payload  — fresh data from the bot (via /api/guilds/:id/dashboard)
//   draft    — an editable copy (config + automod). Setters mark changes
//              dirty via a set of dotPaths; the SaveBar saves them all at
//              once: PUT config {updates}, then PUT automod (patch) if changed.
//   CRUD actions (responder/announce/selfrole/etc.) do NOT go through the
//   draft — they call() the proxy directly, then refresh the payload from the bot.
//
// Two UX guarantees:
//   1. No change is ever lost silently: the SaveBar is always visible while
//      dirty > 0; switching modules never discards the draft.
//   2. Bot errors are shown as-is (business messages from bot validation),
//      and the payload is NOT reset when a save fails.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, ArrowLeft, Menu, RefreshCw, Save, X, CheckCircle2, AlertTriangle,
  LayoutDashboard, Settings2, Ticket, Hash, TrendingUp, MessageSquareReply,
  Palette, Mic, Megaphone, Handshake, BarChart3, Terminal, Archive,
  ShieldAlert, KeyRound, Gift, SquarePen, Vote, Wand2, Rocket, Trophy, Moon, Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AutoModConfig, DashboardPayload, GuildMeta } from "@/lib/bot-api";
import {
  GeneralModule, TicketsModule, AutoModModule, LevelingModule, MidmanModule, type ModuleFormProps,
} from "./modules/module-forms";
// v3.21.0: Quick Start — server setup checklist from the web (mirrors the 🚀
// category in /help): a form per step → the bot applies it directly.
import { QuickStartModule } from "./modules/module-quickstart";
// v3.24.0: insight modules — Statistics (parity with /stats /leaderboard
// /boosters) + AFK (parity with /afk-list /afk-clear).
import { StatsModule, AfkModule } from "./modules/module-insights";
import {
  RespondersModule, SelfRolesModule, AnnounceModule, TempVoiceModule, ServerStatsModule, ModuleOverview,
  type ModuleActionProps,
} from "./modules/module-actions";
// v3.19.0: new modules — Command Manager + Giveaway/Poll/Embed/
// Backup/Moderation/Keys. All actions go straight through call() (Discord ↔ web parity).
import {
  CommandManagerModule, GiveawayModule, PollModule, EmbedModule,
  BackupModule, ModerationModule, KeysModule, CustomCommandsModule, SendMessageModule,
} from "./modules/module-tools";
// v3.25.0: sidebar navigation — one menu shared by the desktop sidebar & the mobile drawer.
import { SideNav } from "./side-nav";

type ToastState = { msg: string; tone: "ok" | "err"; id: number } | null;

type ModuleId =
  | "overview" | "quickstart" | "general" | "tickets" | "automod" | "leveling"
  | "responders" | "selfroles" | "announce" | "tempvoice" | "midman" | "serverstats"
  // v3.19.0
  | "commands" | "backup" | "moderation" | "keys" | "giveaway" | "embed" | "poll"
  // v3.20.0
  | "custom"
  // v3.24.0
  | "stats" | "afk"
  // v3.24.4
  | "send-message";

const MODULES: Array<{ id: ModuleId; label: string; icon: typeof LayoutDashboard; group: string }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, group: "Server" },
  // v3.21.0: mirrors the 🚀 Quick Start category (/help) — setup forms right from the web.
  { id: "quickstart", label: "Quick Start", icon: Rocket, group: "Server" },
  { id: "general", label: "General", icon: Settings2, group: "Server" },
  { id: "commands", label: "Command Manager", icon: Terminal, group: "Server" },
  { id: "backup", label: "Backup", icon: Archive, group: "Server" },
  // v3.24.0: Statistics — leaderboards + boosters (parity with /stats /leaderboard /boosters).
  { id: "stats", label: "Statistics", icon: Trophy, group: "Server" },
  { id: "automod", label: "AutoMod", icon: Hash, group: "Protection" },
  { id: "midman", label: "Middleman", icon: Handshake, group: "Protection" },
  { id: "moderation", label: "Moderation", icon: ShieldAlert, group: "Protection" },
  { id: "tickets", label: "Tickets & Products", icon: Ticket, group: "Community" },
  { id: "keys", label: "VIP Keys", icon: KeyRound, group: "Community" },
  { id: "leveling", label: "Leveling", icon: TrendingUp, group: "Community" },
  { id: "responders", label: "Auto-Responder", icon: MessageSquareReply, group: "Community" },
  { id: "selfroles", label: "Self Roles", icon: Palette, group: "Community" },
  { id: "announce", label: "Announcements", icon: Megaphone, group: "Community" },
  { id: "giveaway", label: "Giveaway", icon: Gift, group: "Community" },
  { id: "tempvoice", label: "Temp Voice", icon: Mic, group: "Community" },
  { id: "serverstats", label: "Server Stats", icon: BarChart3, group: "Community" },
  // v3.24.0: AFK — list + clear (parity with /afk-list /afk-clear).
  { id: "afk", label: "AFK", icon: Moon, group: "Community" },
  { id: "embed", label: "Embed", icon: SquarePen, group: "Tools" },
  { id: "custom", label: "Custom Command", icon: Wand2, group: "Tools" },
  { id: "poll", label: "Poll", icon: Vote, group: "Tools" },
  // v3.24.4: /send-message parity — plain text (complements the Embed Builder).
  { id: "send-message", label: "Send Message", icon: Send, group: "Tools" },
];

const MODULE_DESC: Record<ModuleId, { title: string; desc: string }> = {
  overview: { title: "Overview", desc: "A status snapshot of every module on this server." },
  quickstart: { title: "Quick Start", desc: "Set up your server from scratch via a 6-step checklist — roles (pick or paste the ID), products, ticket & verification panels, log channel. Every form is applied by the bot to the server instantly, exactly like the 🚀 category in /help." },
  general: { title: "General Settings", desc: "Key roles, system channels, automatic messages, and embed colors." },
  tickets: { title: "Tickets & Products", desc: "Ticket panel, categories, and the product/price list." },
  automod: { title: "AutoMod", desc: "Anti-spam, link & word blocking, mention limits." },
  leveling: { title: "Leveling", desc: "XP, level-up announcements, and role rewards." },
  responders: { title: "Auto-Responder", desc: "Trigger words → automatic replies from the bot." },
  selfroles: { title: "Self Roles", desc: "Panels where members pick their own roles." },
  announce: { title: "Scheduled Announcements", desc: "Send embeds automatically at a set time." },
  tempvoice: { title: "Temporary Voice", desc: "Private voice channels per member." },
  midman: { title: "Middleman / Escrow", desc: "Fees and three-party deal categories." },
  serverstats: { title: "Server Stats", desc: "Live counters in channel names." },
  commands: { title: "Command Manager", desc: "Enable/disable each slash command on this server. Applies to Discord usage." },
  backup: { title: "Backup", desc: "Create a backup now and restore previous slots." },
  moderation: { title: "Moderation", desc: "Warn history and moderator actions (timeout/kick/ban)." },
  keys: { title: "VIP Keys", desc: "Grant product keys to members — role + auto-expiry included." },
  giveaway: { title: "Giveaway", desc: "Start a giveaway with Join/Leave buttons straight from the web." },
  embed: { title: "Embed Builder", desc: "Build a complete embed (author, fields, images, footer) with a Discord-style live preview, then send it to any channel." },
  custom: { title: "Custom Command", desc: "Build your own slash command from the web — automatically registered on Discord and usable by every member." },
  poll: { title: "Poll", desc: "Create a poll with interactive vote buttons." },
  // v3.24.0
  stats: { title: "Statistics", desc: "Server aggregates, a 4-metric leaderboard (messages, purchases, spending, giveaways), and the booster list — the same data as /stats, /leaderboard, /boosters." },
  afk: { title: "AFK", desc: "Members who marked themselves AFK — view the list and clear finished statuses (parity with /afk-list & /afk-clear)." },
  // v3.24.4
  "send-message": { title: "Send Message", desc: "Send plain text to any channel as the bot (parity with /send-message) — complements the Embed Builder for embeds." },
};

function setPath(obj: Record<string, unknown>, dotPath: string, value: unknown) {
  const parts = dotPath.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (typeof next !== "object" || next === null) cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

export function GuildDashboard({ guildId }: { guildId: string }) {
  const router = useRouter();
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [meta, setMeta] = useState<GuildMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [module, setModule] = useState<ModuleId>("overview");
  const [toast, setToast] = useState<ToastState>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // v3.21.0: Quick Start auto-landing — once per visit only.
  const landingChecked = useRef(false);

  // Draft + dirty tracking
  const [draft, setDraft] = useState<DashboardPayload | null>(null);
  const [configUpdates, setConfigUpdates] = useState<Record<string, unknown>>({});
  const [automodPatch, setAutomodPatch] = useState<Partial<AutoModConfig>>({});
  const [saving, setSaving] = useState(false);
  // v3.25.0: sidebar navigation state — mobile drawer + refresh spinner.
  const [navOpen, setNavOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  const drawerPanelRef = useRef<HTMLDivElement | null>(null);
  const navWasOpen = useRef(false);
  // v3.28.3: refs mirroring the pending-edit state + payload, so load() can
  // read the CURRENT values without stale-closure races (see load below).
  const configUpdatesRef = useRef<Record<string, unknown>>({});
  const automodPatchRef = useRef<Partial<AutoModConfig>>({});
  const payloadRef = useRef<DashboardPayload | null>(null);
  const loadSeqRef = useRef(0);

  useEffect(() => { configUpdatesRef.current = configUpdates; }, [configUpdates]);
  useEffect(() => { automodPatchRef.current = automodPatch; }, [automodPatch]);
  useEffect(() => { payloadRef.current = payload; }, [payload]);
  // v3.28.3: clear the pending toast timer when the dashboard unmounts.
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const openNav = useCallback(() => {
    navWasOpen.current = true;
    setNavOpen(true);
  }, []);

  const showToast = useCallback((msg: string, tone: "ok" | "err" = "ok") => {
    setToast({ msg, tone, id: Date.now() });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3800);
  }, []);

  const load = useCallback(async (opts?: { preserveDraft?: boolean }) => {
    // v3.28.3: every load gets a sequence number — if a newer load starts
    // before this one finishes, this response is silently dropped (an older
    // response can never overwrite newer data; double-clicks are harmless).
    const seq = ++loadSeqRef.current;
    // v3.28.3: a failed refresh keeps the data on screen when the dashboard
    // already shows something (toast + last-known data) instead of replacing
    // the whole screen — and any dirty draft — with a fatal error.
    const softFail = (msg: string) => {
      if (payloadRef.current) {
        showToast(`${msg} Showing the last loaded data.`, "err");
      } else {
        setLoadError(msg);
        setLoading(false);
      }
    };
    try {
      const res = await fetch(`/api/guilds/${guildId}/dashboard?_=${Date.now()}`, { cache: "no-store" });
      if (seq !== loadSeqRef.current) return;
      if (res.status === 401) {
        router.replace("/");
        return;
      }
      if (res.status === 403) {
        // Permission loss is a hard stop — never soft.
        setLoadError("You don't have permission to manage this server.");
        setLoading(false);
        return;
      }
      if (res.status === 503) {
        softFail("The bot is not connected — make sure it's running, then reload.");
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        if (seq !== loadSeqRef.current) return;
        softFail(data?.error ?? `Failed to load the dashboard (${res.status}).`);
        return;
      }
      const data = (await res.json()) as DashboardPayload & { meta: GuildMeta };
    // v3.23.1: defensive normalization — older bots send `automod: null` for
    // guilds that never configured AutoMod, which crashed the Overview &
    // AutoMod pages in the browser. This fallback guarantees the payload is
    // always a complete object even if the bot has not been updated yet.
    if (!data.automod) {
      data.automod = {
        enabled: false,
        spamThreshold: 5,
        spamWindowMs: 10000,
        spamAction: "mute_10m",
        blockLinks: false,
        linkAllowedChannels: [],
        linkAllowedRoles: [],
        wordRules: [],
        exemptWords: [],
        wordMatchMode: "whole_word",
        wordAction: "delete_only",
        maxMentions: 5,
        mentionAction: "warn",
      };
    }
    if (!Array.isArray(data.responders)) data.responders = [];
    if (!Array.isArray(data.selfroles)) data.selfroles = [];
    if (!Array.isArray(data.announces)) data.announces = [];
    // v3.24.0: new VIEW fields — normalized so an older bot (fields undefined)
    // stays safe: the Statistics/AFK/Middleman/Leveling modules show "empty"
    // instead of crashing.
    if (!data.stats || typeof data.stats !== "object" || !data.stats.server || !data.stats.top) {
      data.stats = {
        server: { totalUsers: 0, totalMessages: 0, totalPurchases: 0, totalRevenue: 0, totalGiveawaysWon: 0 },
        top: { messages: [], purchases: [], spends: [], wins: [] },
      };
    }
    if (!Array.isArray(data.levelTop)) data.levelTop = [];
    if (!Array.isArray(data.afk)) data.afk = [];
    if (!Array.isArray(data.midmanDeals)) data.midmanDeals = [];
    if (!data.boosters || !Array.isArray(data.boosters.live) || !Array.isArray(data.boosters.recent)) {
      data.boosters = { live: [], recent: [] };
    }
    if (seq !== loadSeqRef.current) return;
    setPayload(data);
    setMeta(data.meta);
    // v3.28.3: refreshes triggered by module CRUD actions and by save() pass
    // preserveDraft — unsaved edits are RE-APPLIED onto the fresh data instead
    // of being silently wiped (the old behavior contradicted guarantee #1:
    // "No change is ever lost silently"). A plain load() (initial mount, a
    // confirmed manual refresh) still yields a clean draft.
    const pending = configUpdatesRef.current;
    const pendingAutomod = automodPatchRef.current;
    const hasPending = Object.keys(pending).length > 0 || Object.keys(pendingAutomod).length > 0;
    let nextDraft = { ...data, meta: undefined } as DashboardPayload;
    if (opts?.preserveDraft && hasPending) {
      nextDraft = structuredClone(nextDraft);
      for (const [p, v] of Object.entries(pending)) {
        // The autorole wire update is a whole array; the draft path is the
        // roleIds member (v3.24.1 draft/wire split).
        setPath(nextDraft.config as unknown as Record<string, unknown>, p === "autorole" && Array.isArray(v) ? "autorole.roleIds" : p, v);
      }
      if (Object.keys(pendingAutomod).length > 0) {
        nextDraft.automod = { ...nextDraft.automod, ...pendingAutomod };
      }
    } else {
      configUpdatesRef.current = {};
      automodPatchRef.current = {};
      setConfigUpdates({});
      setAutomodPatch({});
    }
    setDraft(nextDraft);
    setLoadError(null);

    // v3.21.0: Quick Start auto-landing — servers that aren't set up yet (no
    // admin role & no products) are taken straight to the setup checklist.
    // Once per visit — later refreshes/saves never override the user's
    // chosen module.
    if (!landingChecked.current) {
      landingChecked.current = true;
      if (!data.config.roles?.admin && (data.config.products?.length ?? 0) === 0) {
        setModule("quickstart");
      }
    }
    } catch {
      // Network-level rejection (fetch threw / body parse failed) — never an
      // unhandled rejection, never a silent failure.
      if (seq !== loadSeqRef.current) return;
      softFail("Network error — could not reach the dashboard API.");
    }
  }, [guildId, router, showToast]);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  // ---- Draft setters (mark dirty) ----
  const setConfig = useCallback((dotPath: string, value: unknown) => {
    setDraft((d) => {
      if (!d) return d;
      const next: DashboardPayload = structuredClone(d);
      setPath(next.config as unknown as Record<string, unknown>, dotPath, value);
      return next;
    });
    setConfigUpdates((u) => ({ ...u, [dotPath]: value }));
  }, []);

  const setAutomod = useCallback((patch: Partial<AutoModConfig>) => {
    setDraft((d) => {
      if (!d) return d;
      return { ...d, automod: { ...d.automod, ...patch } };
    });
    setAutomodPatch((p) => ({ ...p, ...patch }));
  }, []);

  // v3.24.1 FIX (5.1): the Auto-Role editor needs a draft-path / wire-path split.
  // The draft stores autorole = { roleIds: string[], removeOnNewRole: boolean },
  // but the bot's wire update is { autorole: roleIds[] } (a whole array — see
  // dashServer's SECTION_VALIDATORS). The old call setConfig("autorole", array)
  // replaced the DRAFT OBJECT with a plain array → roleIds became undefined →
  // the chips list instantly reset, removeOnNewRole displayed OFF, and a second
  // Add silently dropped the first role from the pending update.
  const setAutoroleRoleIds = useCallback((roleIds: string[]) => {
    setDraft((d) => {
      if (!d) return d;
      const next: DashboardPayload = structuredClone(d);
      setPath(next.config as unknown as Record<string, unknown>, "autorole.roleIds", roleIds);
      return next;
    });
    setConfigUpdates((u) => ({ ...u, autorole: roleIds }));
  }, []);

  // ---- Direct actions (CRUD) ----
  const call = useCallback(
    async (action: string, method: "POST" | "PUT" | "DELETE", body?: unknown) => {
      const res = await fetch(`/api/guilds/${guildId}/${action}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; details?: string[] };
      if (!res.ok) {
        const details = data.details?.length ? ` (${data.details.slice(0, 3).join("; ")})` : "";
        throw new Error(`${data.error ?? `Failed (${res.status})`}${details}`);
      }
      return data;
    },
    [guildId]
  );

  const refresh = useCallback(async () => {
    // v3.28.3: module CRUD refreshes preserve the draft — unsaved edits in
    // OTHER modules survive (they used to be wiped silently).
    await load({ preserveDraft: true });
  }, [load]);

  // ---- Save ----
  const dirtyCount = Object.keys(configUpdates).length + (Object.keys(automodPatch).length > 0 ? 1 : 0);

  // User-friendly safety net: with unsaved changes, closing / reloading the
  // tab shows the browser's "leave site?" confirmation instead of silently
  // throwing away the draft (the SaveBar is easy to miss when rushing).
  useEffect(() => {
    if (dirtyCount === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy requirement for Chrome/Edge/Firefox to actually show the dialog
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  // v3.25.0: drawer keyboard & focus handling — Escape closes, focus moves
  // into the drawer on open and returns to the ☰ button on close.
  useEffect(() => {
    if (navOpen) {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setNavOpen(false);
      };
      window.addEventListener("keydown", onKey);
      drawerPanelRef.current?.focus();
      return () => window.removeEventListener("keydown", onKey);
    }
    if (navWasOpen.current) {
      navWasOpen.current = false;
      menuBtnRef.current?.focus();
    }
  }, [navOpen]);

  async function save() {
    setSaving(true);
    // v3.28.3: snapshot what is being sent NOW — edits typed while the PUTs
    // are in flight must survive the post-save reload (they used to be
    // wiped by load() clearing the dirty state).
    const sentConfig = { ...configUpdates };
    const sentAutomod = { ...automodPatch };
    try {
      if (Object.keys(sentConfig).length > 0) {
        await call("config", "PUT", { updates: sentConfig });
      }
      if (Object.keys(sentAutomod).length > 0) {
        await call("automod", "PUT", sentAutomod);
      }
    } catch (e) {
      // Save failed — the draft stays dirty so the user can retry (the
      // payload was never reset; bot business errors are shown as-is).
      showToast(e instanceof Error ? e.message : "Failed to save.", "err");
      return;
    } finally {
      setSaving(false);
    }
    // The PUTs succeeded — clear exactly the keys that were saved. A key
    // re-edited during the save (new value ≠ sent value) stays dirty.
    setConfigUpdates((u) => {
      const next = { ...u };
      for (const [k, v] of Object.entries(sentConfig)) {
        if (k in next && JSON.stringify(next[k]) === JSON.stringify(v)) delete next[k];
      }
      return next;
    });
    setAutomodPatch((p) => {
      const next = { ...p };
      for (const [k, v] of Object.entries(sentAutomod)) {
        if (k in next && JSON.stringify((next as Record<string, unknown>)[k]) === JSON.stringify(v)) delete (next as Record<string, unknown>)[k];
      }
      return next;
    });
    // Reload the latest data, keeping any edits made during the save. A
    // reload failure is reported by load() itself (toast) and does NOT
    // masquerade as "Failed to save" anymore — the changes ARE saved.
    await load({ preserveDraft: true });
    showToast("Changes saved — effective in the bot immediately.");
  }

  function discard() {
    if (!payload) return;
    setDraft({ ...payload, meta: undefined } as DashboardPayload);
    setConfigUpdates({});
    setAutomodPatch({});
    showToast("Draft discarded — back to the bot's data.");
  }

  // v3.25.0: Refresh and "All servers" are SPA-side navigations, so
  // beforeunload can't help — with unsaved changes, ask instead of silently
  // dropping the draft (the old refresh button discarded it without warning).
  function confirmIfDirty(action: string): boolean {
    if (dirtyCount === 0) return true;
    return window.confirm(
      `You have ${dirtyCount} unsaved change${dirtyCount > 1 ? "s" : ""} — ${action} will discard them.`
    );
  }

  async function doRefresh() {
    if (!confirmIfDirty("refreshing")) return;
    setRefreshing(true);
    try {
      // v3.28.3: the manual Refresh discards the draft ONLY after the user
      // confirmed the warning above (matches its wording). Module CRUD
      // refreshes use the draft-preserving refresh() instead.
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  function goBack() {
    if (!confirmIfDirty("leaving")) return;
    router.push("/app");
  }

  const formProps: ModuleFormProps | null = useMemo(
    () => (draft && meta ? { draft, meta, setConfig, setAutomod, setAutoroleRoleIds, toast: showToast, call, refresh } : null),
    [draft, meta, setConfig, setAutomod, setAutoroleRoleIds, showToast, call, refresh]
  );
  const actionProps: ModuleActionProps | null = useMemo(
    () => (draft && meta ? { draft, meta, call, refresh, toast: showToast } : null),
    [draft, meta, call, refresh, showToast]
  );

  // ---- Render ----
  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 text-zinc-100 gap-4">
        <Loader2 className="h-8 w-8 text-amber-400 animate-spin" aria-hidden="true" />
        <p className="text-sm text-zinc-400">Loading server data…</p>
      </div>
    );
  }

  if (loadError || !payload || !draft || !meta) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 text-zinc-100 gap-4 px-6">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-950/40 border border-red-900/50">
          <AlertTriangle className="h-5 w-5 text-red-400" aria-hidden="true" />
        </div>
        <p className="max-w-md text-center text-sm leading-relaxed text-zinc-300">{loadError ?? "Data unavailable."}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push("/app")} className="border-zinc-700 bg-transparent hover:bg-zinc-800 hover:text-zinc-100">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
          </Button>
          <Button onClick={() => { setLoading(true); void load().finally(() => setLoading(false)); }} className="bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold">
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  const currentDesc = MODULE_DESC[module];
  const currentModule = MODULES.find((m) => m.id === module);

  return (
    <div className="flex h-dvh overflow-hidden bg-zinc-950 text-zinc-100">
      {/* Desktop sidebar — permanent, full height (v3.25.0) */}
      <aside className="hidden w-64 shrink-0 border-r border-zinc-900/80 lg:block">
        <SideNav
          modules={MODULES}
          current={module}
          onSelect={(id) => setModule(id as ModuleId)}
          guildId={guildId}
          meta={meta}
          onBack={goBack}
          onRefresh={() => void doRefresh()}
          refreshing={refreshing}
        />
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header — ☰ opens the navigation drawer */}
        <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-zinc-900/80 bg-zinc-950 px-2.5 lg:hidden">
          <Button
            ref={menuBtnRef}
            variant="ghost"
            size="icon"
            onClick={openNav}
            className="h-10 w-10 text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100"
            aria-label="Open navigation menu"
            aria-expanded={navOpen}
            aria-controls="mobile-nav-drawer"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </Button>
          {meta.icon ? (
            <img src={`https://cdn.discordapp.com/icons/${guildId}/${meta.icon}.png?size=64`} alt="" className="h-8 w-8 shrink-0 rounded-lg" />
          ) : (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-xs font-semibold text-zinc-300">
              {meta.name.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-semibold text-zinc-100">{meta.name}</p>
            <p className="truncate text-[10px] text-zinc-500">{currentModule?.label ?? ""}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void doRefresh()}
            disabled={refreshing}
            className="h-10 w-10 text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100"
            title="Reload data"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
          </Button>
        </header>

        {/* Content — scrolls independently of the sidebar */}
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-6xl px-4 pb-32 pt-5 md:px-8 md:pt-7">
            <div className="mb-5">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-amber-400/80">
                {currentModule?.group}
              </p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight text-zinc-50">{currentDesc.title}</h1>
              <p className="mt-1 text-sm leading-relaxed text-zinc-400">{currentDesc.desc}</p>
            </div>

            {module === "overview" ? <ModuleOverview draft={draft} meta={meta} /> : null}
            {/* v3.21.0: Quick Start — all actions are immediate (call → refresh). */}
            {module === "quickstart" && actionProps ? <QuickStartModule {...actionProps} goTo={(m) => setModule(m as ModuleId)} /> : null}
            {module === "general" && formProps ? <GeneralModule {...formProps} /> : null}
            {module === "tickets" && formProps ? <TicketsModule {...formProps} /> : null}
            {module === "automod" && formProps ? <AutoModModule {...formProps} /> : null}
            {module === "leveling" && formProps ? <LevelingModule {...formProps} /> : null}
            {module === "midman" && formProps ? <MidmanModule {...formProps} /> : null}
            {module === "responders" && actionProps ? <RespondersModule {...actionProps} /> : null}
            {module === "selfroles" && actionProps ? <SelfRolesModule {...actionProps} /> : null}
            {module === "announce" && actionProps ? <AnnounceModule {...actionProps} /> : null}
            {module === "tempvoice" && actionProps ? <TempVoiceModule {...actionProps} /> : null}
            {module === "serverstats" && actionProps ? <ServerStatsModule {...actionProps} /> : null}
            {/* v3.19.0 */}
            {module === "commands" && actionProps ? <CommandManagerModule {...actionProps} /> : null}
            {module === "backup" && actionProps ? <BackupModule {...actionProps} /> : null}
            {module === "moderation" && actionProps ? <ModerationModule {...actionProps} /> : null}
            {module === "keys" && actionProps ? <KeysModule {...actionProps} /> : null}
            {module === "giveaway" && actionProps ? <GiveawayModule {...actionProps} /> : null}
            {module === "embed" && actionProps ? <EmbedModule {...actionProps} /> : null}
            {/* v3.20.0 */}
            {module === "custom" && actionProps ? <CustomCommandsModule {...actionProps} /> : null}
            {module === "poll" && actionProps ? <PollModule {...actionProps} /> : null}
            {/* v3.24.4: /send-message parity. */}
            {module === "send-message" && actionProps ? <SendMessageModule {...actionProps} /> : null}
            {/* v3.24.0: insight modules — VIEW data + the clear-AFK action. */}
            {module === "stats" && actionProps ? <StatsModule {...actionProps} /> : null}
            {module === "afk" && actionProps ? <AfkModule {...actionProps} /> : null}
          </div>
        </main>
      </div>

      {/* Mobile navigation drawer (v3.25.0) — same menu as the desktop sidebar */}
      <div
        id="mobile-nav-drawer"
        className={`fixed inset-0 z-[60] lg:hidden ${navOpen ? "" : "pointer-events-none"}`}
        inert={!navOpen}
      >
        <div
          onClick={() => setNavOpen(false)}
          className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${navOpen ? "opacity-100" : "opacity-0"}`}
          aria-hidden="true"
        />
        <div
          ref={drawerPanelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          tabIndex={-1}
          className={`absolute inset-y-0 left-0 flex w-[300px] max-w-[85vw] flex-col border-r border-zinc-800 bg-zinc-950 shadow-2xl transition-transform duration-200 ease-out ${
            navOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <SideNav
            modules={MODULES}
            current={module}
            onSelect={(id) => {
              setModule(id as ModuleId);
              setNavOpen(false);
            }}
            guildId={guildId}
            meta={meta}
            onBack={goBack}
            onRefresh={() => void doRefresh()}
            refreshing={refreshing}
            onClose={() => setNavOpen(false)}
          />
        </div>
      </div>

      {/* SaveBar */}
      {dirtyCount > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-amber-400/25 bg-zinc-950/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
            <p className="text-[13px] text-zinc-300">
              <span className="font-semibold text-amber-300">{dirtyCount}</span> unsaved change{dirtyCount > 1 ? "s" : ""}
              <span className="hidden sm:inline text-zinc-500"> — changes only take effect once saved.</span>
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={discard} disabled={saving} className="text-zinc-400 hover:text-zinc-100">
                <X className="h-4 w-4" aria-hidden="true" /> Discard
              </Button>
              <Button onClick={save} disabled={saving} className="bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
                Save Changes
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Toast */}
      {toast ? (
        <div
          key={toast.id}
          className={`fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2.5 rounded-xl border px-4 py-3 text-sm shadow-xl ${
            toast.tone === "ok"
              ? "border-emerald-500/40 bg-zinc-900 text-emerald-200"
              : "border-red-500/40 bg-zinc-900 text-red-200"
          }`}
          role="status"
        >
          {toast.tone === "ok" ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" /> : <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />}
          {toast.msg}
        </div>
      ) : null}
    </div>
  );
}
