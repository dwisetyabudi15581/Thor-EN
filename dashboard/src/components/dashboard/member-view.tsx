"use client";

// v3.30.0 RBAC — the MEMBER tier's dashboard view.
//
// A regular member opening the dashboard sees THEIR OWN profile: activity
// stats, level & rank, warnings and moderation history — read-only by
// construction (the member endpoints ship only the user's own data, and the
// write proxy 403s tier 1). This is the "one system" promise: the same data
// /my-stats, /rank and /warn-list show on Discord, from the same database.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, RefreshCw, ArrowLeft, Hammer, MessageSquare, ShoppingBag, Coins, Trophy,
  TrendingUp, AlertTriangle, ScrollText, Moon, Heart, CalendarDays,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GuildMeta, MemberProfile } from "@/lib/bot-api";

function fmtDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

function fmtNumber(n: number | null | undefined): string {
  const v = n ?? 0;
  return v.toLocaleString(undefined);
}

function StatCard({
  icon: Icon, label, value, accent,
}: {
  icon: typeof MessageSquare;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-4">
      <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-widest text-zinc-500">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {label}
      </p>
      <p className={`mt-2 text-2xl font-semibold tracking-tight ${accent}`}>{value}</p>
    </div>
  );
}

export function MemberView({ guildId, meDiscordId }: { guildId: string; meDiscordId?: string | null }) {
  const router = useRouter();
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [meta, setMeta] = useState<GuildMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/guilds/${guildId}/dashboard?_=${Date.now()}`, { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/");
        return;
      }
      if (res.status === 403) {
        setError("You no longer have access to this server.");
        setLoading(false);
        return;
      }
      if (res.status === 503) {
        setError("The bot is not connected — make sure it's running, then reload.");
        setLoading(false);
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Failed to load your profile (${res.status}).`);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as { tier?: number; member?: MemberProfile; meta?: GuildMeta | null };
      if (data.tier !== 1 || !data.member) {
        // The user's tier rose (promoted!) — reload into the full dashboard.
        router.replace(`/app/servers/${guildId}`);
        return;
      }
      setError(null);
      setProfile(data.member);
      setMeta(data.meta ?? null);
      setLoading(false);
    } catch {
      setError("Could not reach the dashboard server. Check your connection and retry.");
      setLoading(false);
    }
  }, [guildId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function doRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 text-zinc-100 gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-amber-400" aria-hidden="true" />
        <p className="text-sm text-zinc-400">Loading your profile…</p>
      </div>
    );
  }

  if (error && !profile) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 px-6 text-center text-zinc-100 gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 border border-red-500/25">
          <AlertTriangle className="h-6 w-6 text-red-400" aria-hidden="true" />
        </div>
        <p className="max-w-md text-sm text-zinc-300">{error}</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => window.location.reload()} className="border-zinc-700 bg-transparent hover:bg-zinc-800">
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry
          </Button>
          <Button variant="ghost" onClick={() => router.replace("/app")} className="text-zinc-400 hover:text-zinc-100">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All servers
          </Button>
        </div>
      </div>
    );
  }

  if (!profile) return null;

  const xpProgress = (() => {
    const into = profile.level.xp;
    const need = profile.level.xpToNext;
    if (!need || need <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((into / need) * 100)));
  })();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-zinc-900/80 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => router.replace("/app")} className="text-zinc-400 hover:text-zinc-100" title="All servers">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-400/10 border border-amber-400/25">
              <Hammer className="h-4 w-4 text-amber-400" aria-hidden="true" />
            </div>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold text-zinc-100">{meta?.name ?? "Your server"}</p>
              <p className="text-[10px] text-zinc-500">
                Member view — read-only{profile.tag ? ` · ${profile.tag}` : ""}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void doRefresh()}
            disabled={refreshing}
            className="border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800"
            title="Reload your profile"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-5 px-4 py-8 md:px-6">
        {error ? (
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
            <p className="text-sm text-amber-200">{error} Showing the last loaded data.</p>
          </div>
        ) : null}

        {/* Activity stats */}
        <section>
          <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-500">Your activity</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={MessageSquare} label="Messages" value={fmtNumber(profile.stats.messages)} accent="text-zinc-100" />
            <StatCard icon={ShoppingBag} label="Purchases" value={fmtNumber(profile.stats.vipPurchases)} accent="text-zinc-100" />
            <StatCard icon={Coins} label="Total spent" value={fmtNumber(profile.stats.totalSpent)} accent="text-amber-300" />
            <StatCard icon={Trophy} label="Giveaways won" value={fmtNumber(profile.stats.giveawaysWon)} accent="text-zinc-100" />
          </div>
        </section>

        {/* Level */}
        <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <TrendingUp className="h-4 w-4 text-amber-400" aria-hidden="true" /> Level {profile.level.level}
              {profile.level.rank ? (
                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
                  Rank #{profile.level.rank}
                </span>
              ) : null}
            </h2>
            <p className="text-xs text-zinc-500">
              {fmtNumber(profile.level.totalXp)} total XP
              {profile.level.xpToNext ? ` · ${fmtNumber(profile.level.xp)} / ${fmtNumber(profile.level.xpToNext)} to level ${profile.level.level + 1}` : ""}
            </p>
          </div>
          {xpProgress !== null ? (
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-800">
              <div className="h-full rounded-full bg-amber-400/80 transition-all" style={{ width: `${xpProgress}%` }} />
            </div>
          ) : null}
        </section>

        {/* Membership details */}
        <section className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-4">
            <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-widest text-zinc-500">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" /> Joined
            </p>
            <p className="mt-2 text-sm font-medium text-zinc-200">{fmtDate(profile.joinedAt)}</p>
          </div>
          <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-4">
            <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-widest text-zinc-500">
              <Heart className="h-3.5 w-3.5" aria-hidden="true" /> Boosting
            </p>
            <p className="mt-2 text-sm font-medium text-zinc-200">
              {profile.boostingSince ? `Since ${fmtDate(profile.boostingSince)}` : "Not boosting"}
            </p>
          </div>
          <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-4">
            <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-widest text-zinc-500">
              <Moon className="h-3.5 w-3.5" aria-hidden="true" /> AFK status
            </p>
            <p className="mt-2 truncate text-sm font-medium text-zinc-200">
              {profile.afk?.note ? `“${profile.afk.note}”` : "Active"}
            </p>
          </div>
        </section>

        {/* Warnings */}
        <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5">
          <h2 className="flex items-center justify-between text-sm font-semibold text-zinc-100">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden="true" /> Your warnings
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${profile.warnCount > 0 ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300"}`}>
              {profile.warnCount} total
            </span>
          </h2>
          {profile.warns.length === 0 ? (
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">
              Clean record — no warnings. (Auto-actions trigger at 3 / 5 / 7 warnings.)
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {profile.warns.map((w) => (
                <li key={w.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3.5 py-2.5">
                  <p className="text-xs leading-relaxed text-zinc-300">{w.reason}</p>
                  <p className="mt-1 text-[10px] text-zinc-500">
                    by {w.warnedByTag ?? w.warnedBy} · {fmtDate(w.createdAt)}
                    {w.actionTaken ? ` · action: ${w.actionTaken}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Moderation history */}
        <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <ScrollText className="h-4 w-4 text-zinc-400" aria-hidden="true" /> Your moderation history
          </h2>
          {profile.modlogs.length === 0 ? (
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">No moderation actions on your account.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {profile.modlogs.map((m) => (
                <li key={m.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3.5 py-2.5">
                  <p className="text-xs font-medium text-zinc-200">
                    {m.type} {m.durationMs ? `(${Math.round(m.durationMs / 60000)}m)` : ""}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">{m.reason}</p>
                  <p className="mt-1 text-[10px] text-zinc-500">
                    by {m.moderatorTag ?? m.moderatorId} · {fmtDate(m.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="pb-8 text-[11px] leading-relaxed text-zinc-600">
          This is your personal view. Staff and admins see the full moderation dashboard; ask an admin if you believe
          something here is wrong. Data is the same as <code className="rounded bg-zinc-800/60 px-1 py-0.5 text-zinc-400">/my-stats</code>,{" "}
          <code className="rounded bg-zinc-800/60 px-1 py-0.5 text-zinc-400">/rank</code> and{" "}
          <code className="rounded bg-zinc-800/60 px-1 py-0.5 text-zinc-400">/warn-list</code> on Discord.
        </p>
      </main>
    </div>
  );
}
