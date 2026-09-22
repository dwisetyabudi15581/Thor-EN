"use client";

// MODULE: Overview (v3.31.0 — the "understand in 3 seconds" landing page).
//
// Three zones, top to bottom:
//   1. SUMMARY CARDS — the numbers an admin actually checks daily:
//      Total Members · Commands Executed · Bot Uptime · Total Messages.
//   2. QUICK TOGGLES — big green/red switches for the main modules
//      (Auto-Mod, Welcome Message, Economy & Leveling, Auto-Role on Join).
//      These are INSTANT: one click PUTs straight to the bot (no draft, no
//      SaveBar) and the payload refreshes right after — the module turns on
//      or off on Discord immediately, exactly like flipping a switch.
//      When a toggle needs a target (welcome channel / join role) the card
//      expands an inline picker instead of guessing.
//   3. MODULE STATUS — every other module as a one-glance on/off row that
//      jumps straight to its configuration page when clicked.

import { useRef, useState } from "react";
import {
  Activity, BarChart3, ChevronRight, Gift, Hash, KeyRound, Loader2,
  Megaphone, MessageSquare, MessageSquareReply, Mic, Moon, Palette,
  ShieldAlert, ShieldCheck, Terminal, TrendingUp, Users, Wand2, Handshake,
} from "lucide-react";
import { ChannelSelect, RoleSelect } from "../fields";
import type { AutoModConfig, BotStatus, DashboardPayload, GuildMeta } from "@/lib/bot-api";

export type OverviewProps = {
  draft: DashboardPayload;
  meta: GuildMeta;
  /** v3.31.0: live bot health (uptime card + "bot offline" hint). */
  botStatus: BotStatus | null;
  /** Instant-apply proxy: PUT straight to the bot, bypassing the draft. */
  call: (action: string, method: "POST" | "PUT" | "DELETE", body?: unknown) => Promise<unknown>;
  refresh: () => Promise<void>;
  toast: (msg: string, tone?: "ok" | "err") => void;
  /** Jump to a module's configuration page. */
  goTo: (moduleId: string) => void;
};

/* ---------------- helpers ---------------- */

function formatUptime(sec: number | undefined): string {
  if (typeof sec !== "number" || sec < 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatNumber(n: number | undefined | null): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : "—";
}

/** The big, unmissable ON/OFF switch used by every quick-toggle card. */
function BigSwitch({ on, busy }: { on: boolean; busy?: boolean }) {
  return (
    <span
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-dgreen" : "bg-dred/80"
      } ${busy ? "opacity-60" : ""}`}
    >
      {busy ? (
        <Loader2 className="absolute left-1/2 h-4 w-4 -translate-x-1/2 animate-spin text-white" aria-hidden="true" />
      ) : (
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
            on ? "translate-x-[26px]" : "translate-x-[4px]"
          }`}
        />
      )}
    </span>
  );
}

type ToggleCardProps = {
  icon: typeof Hash;
  title: string;
  desc: string;
  on: boolean;
  busy: boolean;
  statusLabel: string;
  onToggle: () => void;
  children?: React.ReactNode;
};

function ToggleCard({ icon: Icon, title, desc, on, busy, statusLabel, onToggle, children }: ToggleCardProps) {
  return (
    <div
      className={`rounded-xl border p-4 transition-colors ${
        on
          ? "border-dgreen/30 bg-dgreen/[0.06]"
          : "border-white/[0.06] bg-dbg-1"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
              on ? "bg-dgreen/15 text-dgreen" : "bg-dbg-3 text-dtx-3"
            }`}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-dtx-0">{title}</p>
            <p className="mt-0.5 text-[11px] leading-snug text-dtx-3">{desc}</p>
            <p className={`mt-1.5 text-[11px] font-semibold ${on ? "text-dgreen" : "text-dred"}`}>
              {on ? "ON" : "OFF"} <span className="font-normal text-dtx-3">· {statusLabel}</span>
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`Toggle ${title}`}
          disabled={busy}
          onClick={onToggle}
          className="mt-0.5"
        >
          <BigSwitch on={on} busy={busy} />
        </button>
      </div>
      {children ? <div className="mt-3 border-t border-white/[0.06] pt-3">{children}</div> : null}
    </div>
  );
}

/* ---------------- the module ---------------- */

export function ModuleOverview({ draft, meta, botStatus, call, refresh, toast, goTo }: OverviewProps) {
  const c = draft.config;
  const [busyToggle, setBusyToggle] = useState<string | null>(null);
  // Which card is in "pick a target" mode (welcome channel / join role).
  const [pickerFor, setPickerFor] = useState<"welcome" | "autorole" | null>(null);
  const [pickChannel, setPickChannel] = useState<string | null>(null);
  const [pickRole, setPickRole] = useState<string | null>(null);
  // Remember the channel/roles a toggle just cleared, so flipping back ON is
  // still one click during the same visit.
  const lastWelcomeChannel = useRef<string | null>(null);
  const lastAutoroleIds = useRef<string[]>([]);

  const welcomeChannel = c.channels.welcome ?? null;
  const welcomeOn = Boolean(welcomeChannel);
  const autoroleIds = c.autorole?.roleIds ?? [];
  const autoroleOn = autoroleIds.length > 0;
  const levelingOn = c.leveling?.enabled === true;
  const automodOn = draft.automod?.enabled === true;

  const welcomeChannelName = welcomeChannel
    ? meta.channels.find((ch) => ch.id === welcomeChannel)?.name ?? `deleted (${welcomeChannel.slice(0, 8)}…)`
    : "no channel set";

  /** Shared instant-apply wrapper: PUT → refresh → toast; never lies on failure. */
  async function applyInstant(
    key: string,
    action: string,
    method: "PUT" | "POST",
    body: unknown,
    okMsg: string
  ) {
    setBusyToggle(key);
    try {
      await call(action, method, body);
      await refresh();
      toast(okMsg);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to apply — nothing was changed.", "err");
    } finally {
      setBusyToggle(null);
      setPickerFor(null);
      setPickChannel(null);
      setPickRole(null);
    }
  }

  /* ---- Welcome Message toggle (target = the welcome channel) ---- */
  async function toggleWelcome(on: boolean) {
    if (on) {
      if (welcomeChannel) {
        await applyInstant("welcome", "config", "PUT", { updates: { "channels.welcome": welcomeChannel } }, "Welcome messages are ON.");
        return;
      }
      // Restoring a channel cleared earlier this visit = still one click.
      if (lastWelcomeChannel.current) {
        const restore = lastWelcomeChannel.current;
        await applyInstant("welcome", "config", "PUT", { updates: { "channels.welcome": restore } }, "Welcome messages are ON.");
        return;
      }
      setPickerFor(pickerFor === "welcome" ? null : "welcome"); // pick a channel
      return;
    }
    lastWelcomeChannel.current = welcomeChannel;
    await applyInstant("welcome", "config", "PUT", { updates: { "channels.welcome": null } }, "Welcome messages are OFF.");
  }

  /* ---- Auto-Role toggle (target = the join role list) ---- */
  async function toggleAutorole(on: boolean) {
    if (on) {
      if (lastAutoroleIds.current.length > 0) {
        const restore = lastAutoroleIds.current;
        await applyInstant("autorole", "config", "PUT", { updates: { autorole: restore } }, "Auto-role is ON.");
        return;
      }
      setPickerFor(pickerFor === "autorole" ? null : "autorole"); // pick a role
      return;
    }
    if (!window.confirm(`Remove all ${autoroleIds.length} join role${autoroleIds.length > 1 ? "s" : ""}? New members will stop receiving them.`)) {
      return;
    }
    lastAutoroleIds.current = autoroleIds;
    await applyInstant("autorole", "config", "PUT", { updates: { autorole: [] } }, "Auto-role is OFF.");
  }

  /* ---- Module status rows (everything else) ---- */
  const statusModules: Array<{ id: string; name: string; icon: typeof Hash; on: boolean; note: string }> = [
    { id: "tickets", name: "Tickets & Products", icon: ShieldCheck, on: c.ticketCategories.length > 0, note: `${c.ticketCategories.length} categories · ${c.products.length} products` },
    { id: "responders", name: "Auto-Responder", icon: MessageSquareReply, on: draft.responders.length > 0, note: `${draft.responders.length} triggers` },
    { id: "selfroles", name: "Self Roles", icon: Palette, on: draft.selfroles.length > 0, note: `${draft.selfroles.length} panels` },
    { id: "tempvoice", name: "Temp Voice", icon: Mic, on: Boolean(draft.tempvoice), note: draft.tempvoice ? `${draft.tempvoice.activeChannels} active channels` : "not set up" },
    { id: "serverstats", name: "Server Stats", icon: BarChart3, on: Boolean(draft.serverstats?.enabled), note: draft.serverstats?.enabled ? "live counters" : "not set up" },
    { id: "announce", name: "Announcements", icon: Megaphone, on: draft.announces.filter((a) => !a.sent).length > 0, note: `${draft.announces.filter((a) => !a.sent).length} scheduled` },
    { id: "midman", name: "Middleman / Escrow", icon: Handshake, on: true, note: `${c.midman.feeMode === "percent" ? `${c.midman.feeValue}%` : `flat ${c.midman.feeValue}`} fee` },
    { id: "giveaway", name: "Giveaway", icon: Gift, on: draft.giveaways.filter((g) => !g.ended).length > 0, note: `${draft.giveaways.filter((g) => !g.ended).length} running` },
    { id: "keys", name: "VIP Keys", icon: KeyRound, on: draft.keys.length > 0, note: `${draft.keys.length} active keys` },
    { id: "custom", name: "Custom Commands", icon: Wand2, on: (draft.customCommands ?? []).length > 0, note: `${(draft.customCommands ?? []).length} commands` },
    { id: "afk", name: "AFK", icon: Moon, on: (draft.afk ?? []).length > 0, note: `${(draft.afk ?? []).length} members AFK` },
    { id: "moderation", name: "Moderation", icon: ShieldAlert, on: true, note: `${draft.warns.length} warns · ${draft.modlogs.length} actions` },
  ];

  const summary = [
    { label: "Total Members", value: formatNumber(meta.memberCount), icon: Users, tint: "bg-blurple/15 text-blurple-soft" },
    { label: "Commands Executed", value: formatNumber(draft.stats?.server?.commandsExecuted ?? 0), icon: Terminal, tint: "bg-dgreen/15 text-dgreen" },
    { label: "Bot Uptime", value: botStatus?.online ? formatUptime(botStatus.uptimeSec) : "offline", icon: Activity, tint: "bg-dyellow/15 text-dyellow" },
    { label: "Total Messages", value: formatNumber(draft.stats?.server?.totalMessages), icon: MessageSquare, tint: "bg-sky-500/15 text-sky-300" },
  ];

  return (
    <div className="space-y-6">
      {/* ---- 1. Summary cards ---- */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summary.map((s) => (
          <div key={s.label} className="flex items-center gap-3.5 rounded-xl border border-white/[0.06] bg-dbg-1 p-4">
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${s.tint}`}>
              <s.icon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 leading-tight">
              <p className="text-[11px] font-medium uppercase tracking-wide text-dtx-3">{s.label}</p>
              <p className="mt-1 text-[22px] font-semibold tabular-nums text-dtx-0">{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ---- 2. Quick toggles (instant — no Save button involved) ---- */}
      <section className="rounded-xl border border-white/[0.06] bg-dbg-1 p-5 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-dtx-0">Quick Toggles</h3>
            <p className="mt-1 text-xs leading-relaxed text-dtx-3">
              Flip a module on or off — it applies to the bot on Discord <span className="text-dtx-1">immediately</span>. No save needed.
            </p>
          </div>
          {botStatus && !botStatus.online ? (
            <p className="flex items-center gap-1.5 rounded-full border border-dred/40 bg-dred/10 px-3 py-1 text-[11px] font-medium text-dred">
              Bot offline — toggles will fail until it&apos;s back
            </p>
          ) : null}
        </div>

        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          {/* Auto-Mod */}
          <ToggleCard
            icon={Hash}
            title="Auto-Mod"
            desc="Anti-spam, blocked words & links, mention limits."
            on={automodOn}
            busy={busyToggle === "automod"}
            statusLabel={automodOn ? (draft.automod.blockLinks ? "spam + links + words" : "spam + words") : "protection inactive"}
            onToggle={() =>
              applyInstant(
                "automod",
                "automod",
                "PUT",
                { enabled: !automodOn } satisfies Partial<AutoModConfig>,
                `Auto-Mod is ${automodOn ? "OFF" : "ON"}.`
              )
            }
          />

          {/* Welcome Message */}
          <ToggleCard
            icon={MessageSquare}
            title="Welcome Message"
            desc="Greet every new member in the welcome channel."
            on={welcomeOn}
            busy={busyToggle === "welcome"}
            statusLabel={welcomeOn ? `#${welcomeChannelName}` : "no welcome on join"}
            onToggle={() => void toggleWelcome(!welcomeOn)}
          >
            {pickerFor === "welcome" ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-dtx-3">Welcome channel:</span>
                <div className="min-w-0 flex-1">
                  <ChannelSelect value={pickChannel} onChange={setPickChannel} channels={meta.channels} placeholder="— pick a channel —" />
                </div>
                <button
                  type="button"
                  disabled={!pickChannel || busyToggle === "welcome"}
                  onClick={() =>
                    void applyInstant(
                      "welcome",
                      "config",
                      "PUT",
                      { updates: { "channels.welcome": pickChannel } },
                      "Welcome messages are ON."
                    )
                  }
                  className="shrink-0 rounded-lg bg-blurple px-3 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-blurple-dark disabled:opacity-50"
                >
                  Turn ON
                </button>
              </div>
            ) : null}
          </ToggleCard>

          {/* Economy & Leveling */}
          <ToggleCard
            icon={TrendingUp}
            title="Economy & Leveling"
            desc="XP per message, level-ups & role rewards."
            on={levelingOn}
            busy={busyToggle === "leveling"}
            statusLabel={
              levelingOn
                ? `${c.levelRoles.length} role rewards · ${c.leveling.xpPerMessage} XP/msg`
                : "members earn nothing"
            }
            onToggle={() =>
              applyInstant(
                "leveling",
                "config",
                "PUT",
                { updates: { "leveling.enabled": !levelingOn } },
                `Economy & Leveling is ${levelingOn ? "OFF" : "ON"}.`
              )
            }
          />

          {/* Auto-Role on Join */}
          <ToggleCard
            icon={Users}
            title="Auto-Role on Join"
            desc="Roles granted automatically to every new member."
            on={autoroleOn}
            busy={busyToggle === "autorole"}
            statusLabel={
              autoroleOn
                ? `${autoroleIds.length} join role${autoroleIds.length > 1 ? "s" : ""} · ${meta.roles.filter((r) => autoroleIds.includes(r.id)).map((r) => `@${r.name}`).slice(0, 2).join(", ") || "roles set"}`
                : "no roles on join"
            }
            onToggle={() => void toggleAutorole(!autoroleOn)}
          >
            {pickerFor === "autorole" ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-dtx-3">First join role:</span>
                <div className="min-w-0 flex-1">
                  <RoleSelect value={pickRole} onChange={setPickRole} roles={meta.roles} placeholder="— pick a role —" />
                </div>
                <button
                  type="button"
                  disabled={!pickRole || busyToggle === "autorole"}
                  onClick={() =>
                    void applyInstant(
                      "autorole",
                      "config",
                      "PUT",
                      { updates: { autorole: [pickRole] } },
                      "Auto-role is ON."
                    )
                  }
                  className="shrink-0 rounded-lg bg-blurple px-3 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-blurple-dark disabled:opacity-50"
                >
                  Turn ON
                </button>
              </div>
            ) : null}
          </ToggleCard>
        </div>
      </section>

      {/* ---- 3. Module status (click to configure) ---- */}
      <section className="rounded-xl border border-white/[0.06] bg-dbg-1 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-dtx-0">Module Status</h3>
        <p className="mt-1 text-xs leading-relaxed text-dtx-3">
          A live snapshot of every module — green means active, red means inactive. Click a row to configure it.
        </p>
        <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
          {statusModules.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => goTo(m.id)}
              className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
                m.on
                  ? "border-white/[0.06] bg-dbg-0/50 hover:border-blurple/40 hover:bg-dbg-0"
                  : "border-dred/20 bg-dbg-0/50 hover:border-dred/40 hover:bg-dbg-0"
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <m.icon className={`h-4 w-4 shrink-0 ${m.on ? "text-dtx-3" : "text-dtx-4"}`} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-dtx-1">{m.name}</p>
                  <p className="mt-0.5 truncate text-[11px] text-dtx-3">{m.note}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                  m.on ? "bg-dgreen/10 text-dgreen" : "bg-dred/10 text-dred"
                }`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${m.on ? "bg-dgreen" : "bg-dred"}`} aria-hidden="true" />
                  {m.on ? "on" : "off"}
                </span>
                <ChevronRight className="h-3.5 w-3.5 text-dtx-4" aria-hidden="true" />
              </div>
            </button>
          ))}
        </div>
      </section>

      <p className="px-1 text-[11px] leading-relaxed text-dtx-4">
        Quick Toggles apply instantly · other configuration changes are collected as a draft
        and take effect once you press Save. Data auto-refreshes every 15 seconds.
      </p>
    </div>
  );
}
