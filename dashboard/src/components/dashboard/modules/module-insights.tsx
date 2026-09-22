"use client";

// v3.24.0 dashboard insight modules — full feature parity for the VIEW
// commands that used to be Discord-only:
//   StatsModule → /stats, /leaderboard (4 metrics), /boosters
//   AfkModule  → /afk-list + /afk-clear (the clear action from the web)
//
// All data is read-only from the dashboard payload (the stats/boosters/afk
// fields — defensively normalized in GuildDashboard so an older bot stays
// safe). Exactly one write action exists: DELETE /guilds/:id/afk/:userId.

import { useState } from "react";
import { Trash2, Loader2, Trophy, TrendingUp, Users, MessageSquare, ShoppingBag, Coins, PartyPopper, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Section, Pill, Select } from "../fields";
import type { ModuleActionProps } from "./module-actions";

function fmtDate(ts: number | null | undefined) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function fmtDuration(ms: number) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/* ============================================================
 * MODULE: Statistics (parity with /stats + /leaderboard + /boosters)
 * ============================================================ */

const METRICS = [
  { key: "messages", label: "Top Messages", icon: MessageSquare, fmt: (v: number) => `${v.toLocaleString("en-US")} messages` },
  { key: "purchases", label: "Top Buyer", icon: ShoppingBag, fmt: (v: number) => `${v} purchases` },
  { key: "spends", label: "Top Spender", icon: Coins, fmt: (v: number) => v.toLocaleString("en-US") },
  { key: "wins", label: "Top Winner", icon: PartyPopper, fmt: (v: number) => `${v} wins` },
] as const;

export function StatsModule({ draft }: ModuleActionProps) {
  const [metric, setMetric] = useState<string>("messages");
  // Defensive fallback — an older bot doesn't send this field yet.
  const stats =
    draft.stats ??
    { server: { totalUsers: 0, totalMessages: 0, totalPurchases: 0, totalRevenue: 0, totalGiveawaysWon: 0 }, top: { messages: [], purchases: [], spends: [], wins: [] } };
  const rows = stats.top[metric as keyof typeof stats.top] ?? [];
  const MetricIcon = METRICS.find((m) => m.key === metric)?.icon ?? TrendingUp;
  const metricFmt = METRICS.find((m) => m.key === metric)?.fmt ?? ((v: number) => String(v));
  const boosters = draft.boosters ?? { live: [], recent: [] };

  return (
    <div className="space-y-5">
      <Section title="Server Aggregates" desc="Activity summary since tracking began — the same data as /stats.">
        <div className="grid gap-3 sm:grid-cols-2 md:col-span-2 lg:grid-cols-5">
          {[
            { l: "Tracked Members", v: stats.server.totalUsers.toLocaleString("en-US"), icon: Users },
            { l: "Total Messages", v: stats.server.totalMessages.toLocaleString("en-US"), icon: MessageSquare },
            { l: "Purchases", v: stats.server.totalPurchases.toLocaleString("en-US"), icon: ShoppingBag },
            { l: "Total Revenue", v: stats.server.totalRevenue.toLocaleString("en-US"), icon: Coins },
            { l: "Giveaways Won", v: stats.server.totalGiveawaysWon.toLocaleString("en-US"), icon: PartyPopper },
          ].map((s) => (
            <div key={s.l} className="rounded-xl border border-white/[0.06] bg-dbg-0/40 p-4">
              <p className="flex items-center gap-1.5 text-[11px] text-dtx-3">
                <s.icon className="h-3.5 w-3.5" aria-hidden="true" /> {s.l}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-dtx-0">{s.v}</p>
            </div>
          ))}
        </div>
      </Section>

      <section className="rounded-2xl border border-white/[0.06] bg-dbg-1/30 p-5 md:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-dtx-0">
              <Trophy className="h-4 w-4 text-blurple-soft" aria-hidden="true" /> Leaderboard
            </h3>
            <p className="mt-1 text-xs text-dtx-3">Top 10 members — the same data as /leaderboard.</p>
          </div>
          <div className="w-full sm:w-64">
            <Field label="Metric">
              <Select
                value={metric}
                onChange={setMetric}
                options={METRICS.map((m) => ({ value: m.key, label: m.label }))}
              />
            </Field>
          </div>
        </div>
        <div className="mt-4 divide-y divide-white/[0.06]">
          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/[0.06] p-6 text-center text-xs text-dtx-3">
              No data for this metric yet.
            </p>
          ) : (
            rows.map((u, i) => (
              <div key={u.userId} className="flex items-center gap-3 py-2.5">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${i === 0 ? "bg-blurple/15 text-blurple-soft" : i < 3 ? "bg-dbg-3/40 text-dtx-2" : "bg-dbg-3/40 text-dtx-3"}`}>
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-dtx-2">{u.userId}</span>
                <span className="shrink-0 text-[13px] font-medium tabular-nums text-dtx-0">{metricFmt(u.value)}</span>
              </div>
            ))
          )}
        </div>
        <p className="mt-3 px-1 text-[11px] text-dtx-4">
          Rows show Discord IDs (plain numbers — currency-agnostic, exactly like /leaderboard).
        </p>
      </section>

      <section className="rounded-2xl border border-white/[0.06] bg-dbg-1/30 p-5 md:p-6">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-dtx-0">
          <Rocket className="h-4 w-4 text-fuchsia-400" aria-hidden="true" /> Server Boosters ({boosters.live.length})
        </h3>
        <p className="mt-1 text-xs text-dtx-3">Active boosters + activity history — the same data as /boosters.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-white/[0.06] bg-dbg-0/40 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-dtx-3">Active Now</p>
            <div className="mt-3 space-y-2">
              {boosters.live.length === 0 ? (
                <p className="text-xs text-dtx-3">No boosters yet.</p>
              ) : (
                boosters.live.map((b) => (
                  <div key={b.userId} className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-mono text-dtx-2">{b.tag ?? b.userId}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-dtx-3">{fmtDuration(Date.now() - b.since)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-dbg-0/40 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-dtx-3">Recent Activity</p>
            <div className="mt-3 space-y-2">
              {boosters.recent.length === 0 ? (
                <p className="text-xs text-dtx-3">No recorded boost activity yet.</p>
              ) : (
                boosters.recent.map((e, i) => (
                  <div key={`${e.userId}-${i}`} className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-mono text-dtx-2">{e.userId}</span>{" "}
                      <Pill tone={e.event === "boost_added" ? "green" : "zinc"}>{e.event === "boost_added" ? "boosted" : "stopped"}</Pill>
                    </span>
                    <span className="shrink-0 text-[11px] text-dtx-3">{fmtDate(e.at)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ============================================================
 * MODULE: AFK (parity with /afk-list + /afk-clear)
 * ============================================================ */

export function AfkModule({ draft, call, refresh, toast }: ModuleActionProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const afk = draft.afk ?? [];

  async function clear(userId: string) {
    setBusyId(userId);
    try {
      await call(`afk/${userId}`, "DELETE");
      await refresh();
      toast("AFK status cleared.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to clear the AFK status.", "err");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-white/[0.06] bg-dbg-1/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-dtx-0">AFK Members ({afk.length})</h3>
        <p className="mt-1 text-xs text-dtx-3">
          Members who marked themselves AFK via /afk — the bot auto-replies whenever they get mentioned. Clear a status once they're back (parity with /afk-clear).
        </p>
        <div className="mt-4 space-y-2">
          {afk.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/[0.06] p-6 text-center text-xs text-dtx-3">
              No members are AFK right now.
            </p>
          ) : (
            afk.map((u) => (
              <div key={u.userId} className="flex items-start gap-3 rounded-xl border border-white/[0.06] bg-dbg-0/40 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-dtx-1">
                    <span className="font-mono text-dtx-3">{u.userId}</span>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-dtx-3">
                    {u.reason} · {fmtDuration(Date.now() - u.since)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId === u.userId}
                  onClick={() => void clear(u.userId)}
                  className="h-8 shrink-0 border-white/[0.1] bg-transparent text-dtx-2 hover:bg-dred/10 hover:text-dred"
                >
                  {busyId === u.userId ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                  Clear
                </Button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
