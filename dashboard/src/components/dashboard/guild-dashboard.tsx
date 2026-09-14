"use client";

// GuildDashboard — main per-server dashboard shell (Dyno-style).
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
  Hammer, Loader2, ArrowLeft, Save, X, CheckCircle2, AlertTriangle,
  LayoutDashboard, Settings2, Ticket, Hash, TrendingUp, MessageSquareReply,
  Palette, Mic, Megaphone, Handshake, BarChart3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AutoModConfig, DashboardPayload, GuildMeta } from "@/lib/bot-api";
import {
  GeneralModule, TicketsModule, AutoModModule, LevelingModule, MidmanModule, type ModuleFormProps,
} from "./modules/module-forms";
import {
  RespondersModule, SelfRolesModule, AnnounceModule, TempVoiceModule, ServerStatsModule, ModuleOverview,
  type ModuleActionProps,
} from "./modules/module-actions";

type ToastState = { msg: string; tone: "ok" | "err"; id: number } | null;

type ModuleId =
  | "overview" | "general" | "tickets" | "automod" | "leveling"
  | "responders" | "selfroles" | "announce" | "tempvoice" | "midman" | "serverstats";

const MODULES: Array<{ id: ModuleId; label: string; icon: typeof LayoutDashboard; group: string }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, group: "Server" },
  { id: "general", label: "General", icon: Settings2, group: "Server" },
  { id: "automod", label: "AutoMod", icon: Hash, group: "Protection" },
  { id: "midman", label: "Middleman", icon: Handshake, group: "Protection" },
  { id: "tickets", label: "Tickets & Products", icon: Ticket, group: "Community" },
  { id: "leveling", label: "Leveling", icon: TrendingUp, group: "Community" },
  { id: "responders", label: "Auto-Responder", icon: MessageSquareReply, group: "Community" },
  { id: "selfroles", label: "Self Roles", icon: Palette, group: "Community" },
  { id: "announce", label: "Announcements", icon: Megaphone, group: "Community" },
  { id: "tempvoice", label: "Temp Voice", icon: Mic, group: "Community" },
  { id: "serverstats", label: "Server Stats", icon: BarChart3, group: "Community" },
];

const MODULE_DESC: Record<ModuleId, { title: string; desc: string }> = {
  overview: { title: "Overview", desc: "A status snapshot of every module on this server." },
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

  // Draft + dirty tracking
  const [draft, setDraft] = useState<DashboardPayload | null>(null);
  const [configUpdates, setConfigUpdates] = useState<Record<string, unknown>>({});
  const [automodPatch, setAutomodPatch] = useState<Partial<AutoModConfig>>({});
  const [saving, setSaving] = useState(false);

  const showToast = useCallback((msg: string, tone: "ok" | "err" = "ok") => {
    setToast({ msg, tone, id: Date.now() });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3800);
  }, []);

  const load = useCallback(async () => {
    const res = await fetch(`/api/guilds/${guildId}/dashboard?_=${Date.now()}`, { cache: "no-store" });
    if (res.status === 401) {
      router.replace("/");
      return;
    }
    if (res.status === 403) {
      setLoadError("You don't have permission to manage this server.");
      setLoading(false);
      return;
    }
    if (res.status === 503) {
      setLoadError("The bot is not connected — make sure it's running, then reload.");
      setLoading(false);
      return;
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setLoadError(data?.error ?? `Failed to load the dashboard (${res.status}).`);
      setLoading(false);
      return;
    }
    const data = (await res.json()) as DashboardPayload & { meta: GuildMeta };
    setPayload(data);
    setMeta(data.meta);
    // Draft = in-memory copy; dirty state resets (a fresh draft always comes from the bot).
    setDraft({ ...data, meta: undefined } as DashboardPayload);
    setConfigUpdates({});
    setAutomodPatch({});
    setLoadError(null);
  }, [guildId, router]);

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
    await load();
  }, [load]);

  // ---- Save ----
  const dirtyCount = Object.keys(configUpdates).length + (Object.keys(automodPatch).length > 0 ? 1 : 0);

  async function save() {
    setSaving(true);
    try {
      if (Object.keys(configUpdates).length > 0) {
        await call("config", "PUT", { updates: configUpdates });
      }
      if (Object.keys(automodPatch).length > 0) {
        await call("automod", "PUT", automodPatch);
      }
      await load();
      showToast("Changes saved — effective in the bot immediately.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to save.", "err");
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (!payload) return;
    setDraft({ ...payload });
    setConfigUpdates({});
    setAutomodPatch({});
    showToast("Draft discarded — back to the bot's data.");
  }

  const formProps: ModuleFormProps | null = useMemo(
    () => (draft && meta ? { draft, meta, setConfig, setAutomod, toast: showToast } : null),
    [draft, meta, setConfig, setAutomod, showToast]
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

  const groups = [...new Set(MODULES.map((m) => m.group))];
  const currentDesc = MODULE_DESC[module];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Guild header */}
      <header className="sticky top-0 z-40 border-b border-zinc-900/80 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => router.push("/app")} className="h-9 w-9 shrink-0 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60" title="Pick another server">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            {meta.icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`https://cdn.discordapp.com/icons/${guildId}/${meta.icon}.png?size=64`} alt="" className="h-9 w-9 rounded-lg" />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800 text-xs font-semibold text-zinc-300">
                {meta.name.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold text-zinc-100">{meta.name}</p>
              <p className="hidden sm:block text-[10px] text-zinc-500">
                Thor Dashboard · {meta.memberCount?.toLocaleString("en-US") ?? "—"} members
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => void refresh()} className="h-9 w-9 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60" title="Reload data">
              <Hammer className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6 md:px-6">
        {/* Module sidebar (desktop) */}
        <aside className="sticky top-[88px] hidden h-fit w-56 shrink-0 lg:block">
          <nav className="space-y-5">
            {groups.map((g) => (
              <div key={g}>
                <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">{g}</p>
                <div className="space-y-0.5">
                  {MODULES.filter((m) => m.group === g).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setModule(m.id)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
                        module === m.id
                          ? "bg-amber-400/10 text-amber-300 border border-amber-400/25"
                          : "text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200 border border-transparent"
                      }`}
                    >
                      <m.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1 pb-28">
          {/* Mobile module nav */}
          <div className="-mx-4 mb-5 overflow-x-auto px-4 lg:hidden">
            <div className="flex w-max gap-1.5">
              {MODULES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setModule(m.id)}
                  className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    module === m.id
                      ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                      : "border-zinc-800 bg-zinc-900/40 text-zinc-400"
                  }`}
                >
                  <m.icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-5">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-50">{currentDesc.title}</h1>
            <p className="mt-1 text-sm text-zinc-400">{currentDesc.desc}</p>
          </div>

          {module === "overview" ? <ModuleOverview draft={draft} meta={meta} /> : null}
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
        </main>
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
