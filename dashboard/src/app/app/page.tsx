"use client";

// /app — Server Picker : lists Discord guilds where the user is an
// admin (owner / ManageGuild), distinguishing servers that already have the bot
// (manageable right away) from those that don't (invite button). This is the
// dashboard's main gateway.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Hammer,
  Loader2,
  LogOut,
  Search,
  Plus,
  Settings2,
  Bot as BotIcon,
  AlertTriangle,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { MeResponse } from "@/components/dashboard/types";

type GuildItem = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  botIn: boolean;
  // v3.30.0 RBAC: the user's tier in this server (3 admin / 2 staff / 1 member).
  tier?: number;
};

type GuildsResponse = {
  botOnline: boolean;
  botVersion?: string;
  guilds: GuildItem[];
  inviteUrl: string;
  guildsError?: "no-token" | "relogin" | "discord-error";
};

function guildIcon(guild: GuildItem, size: number): string | null {
  if (!guild.icon) return null;
  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=${size}`;
}

export default function ServerPickerPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [data, setData] = useState<GuildsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  // v3.24.1 FIX (5.3): a failed fetch used to leave loading=true forever (the
  // "Loading your servers…" spinner with no recovery) + an unhandled rejection.
  const [netError, setNetError] = useState<string | null>(null);

  const loadGuilds = useCallback(async () => {
    const res = await fetch(`/api/guilds?_=${Date.now()}`, { cache: "no-store" });
    if (res.status === 401) {
      router.replace("/");
      return;
    }
    setData((await res.json()) as GuildsResponse);
  }, [router]);

  useEffect(() => {
    void (async () => {
      // v3.24.1 FIX (5.3): wrap the boot chain — one failed fetch used to leave
      // the page on the spinner forever.
      try {
        setNetError(null);
        const meRes = await fetch(`/api/me?_=${Date.now()}`, { cache: "no-store" });
        const meData = (await meRes.json()) as MeResponse;
        setMe(meData);
        if (!meData.user) {
          router.replace("/");
          return;
        }
        await loadGuilds();
        setLoading(false);
      } catch {
        setLoading(false);
        setNetError("Could not reach the dashboard server. Check your connection and retry.");
      }
    })();
  }, [loadGuilds, router]);

  async function refresh() {
    setRefreshing(true);
    try {
      await loadGuilds();
    } catch {
      // v3.24.1 FIX (5.3): surface the failure instead of an unhandled rejection.
      setNetError("Could not reach the dashboard server. Check your connection and retry.");
    } finally {
      setRefreshing(false);
    }
  }

  async function logout() {
    // v3.24.1 FIX (5.3): offline logout no longer leaves an unhandled rejection
    // behind — the redirect happens regardless.
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* proceed to the redirect anyway — the cookie is client-side too */
    }
    router.replace("/");
  }

  const filtered = useMemo(() => {
    const list = data?.guilds ?? [];
    if (!query.trim()) return list;
    const q = query.trim().toLowerCase();
    return list.filter((g) => g.name.toLowerCase().includes(q));
  }, [data, query]);

  const withBot = filtered.filter((g) => g.botIn);
  const withoutBot = filtered.filter((g) => !g.botIn);

  if (loading || !me?.user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-dbg-2 text-dtx-0 gap-4">
        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-blurple/10 border border-blurple/25">
          <Loader2 className="h-6 w-6 text-blurple animate-spin" aria-hidden="true" />
        </div>
        <p className="text-sm text-dtx-3">Loading your servers…</p>
      </div>
    );
  }

  // v3.24.1 FIX (5.3): retry UI instead of a dead spinner when the boot fetch failed.
  if (netError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-dbg-2 text-dtx-0 gap-4 px-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-dred/10 border border-dred/25">
          <WifiOff className="h-6 w-6 text-dred" aria-hidden="true" />
        </div>
        <p className="text-sm text-dtx-1">{netError}</p>
        <Button variant="outline" className="border-white/[0.1] bg-transparent hover:bg-dbg-3 hover:text-dtx-0" onClick={() => window.location.reload()}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Retry
        </Button>
      </div>
    );
  }

  const u = me.user;
  const avatar = u.avatar
    ? `https://cdn.discordapp.com/avatars/${u.discordId}/${u.avatar}.png?size=64`
    : null;

  return (
    <div className="min-h-screen bg-dbg-2 text-dtx-0">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-dbg-2/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <button
            type="button"
            onClick={() => router.replace("/")}
            className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blurple/10 border border-blurple/25">
              <Hammer className="h-4 w-4 text-blurple" aria-hidden="true" />
            </div>
            <div className="leading-tight text-left">
              <p className="text-sm font-semibold text-dtx-0">Thor Dashboard</p>
              <p className="text-[10px] text-dtx-3">Pick a server to get started</p>
            </div>
          </button>
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2.5 rounded-full border border-white/[0.08] bg-dbg-1 pl-1 pr-3 py-1">
              {avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatar} alt="" className="h-7 w-7 rounded-full" />
              ) : (
                <div className="h-7 w-7 rounded-full bg-blurple flex items-center justify-center text-xs font-semibold text-white">
                  {(u.globalName || u.username).slice(0, 1).toUpperCase()}
                </div>
              )}
              <span className="text-xs text-dtx-1 max-w-[140px] truncate">{u.globalName || u.username}</span>
              {u.isAdmin ? <Badge className="bg-blurple/15 text-blurple-soft border-blurple/30 text-[10px]">Admin</Badge> : null}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="text-dtx-3 hover:text-dtx-0 hover:bg-white/[0.06]"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Log out</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-dtx-0">Your Servers</h1>
            <p className="mt-1.5 text-sm text-dtx-3">
              Servers you manage, where you are <span className="text-sky-300">staff</span>, or where you are a member
              — your access level is shown on each card.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-dtx-4" aria-hidden="true" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search servers…"
                className="h-10 w-full sm:w-64 rounded-lg border border-white/[0.08] bg-dbg-0 pl-9 pr-3 text-sm text-dtx-0 placeholder:text-dtx-4 focus:outline-none focus:border-blurple"
              />
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={refresh}
              disabled={refreshing}
              className="h-10 w-10 shrink-0 border-white/[0.08] bg-dbg-0 hover:bg-dbg-3 hover:text-dtx-0"
              title="Reload the list"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
            </Button>
          </div>
        </div>

        {/* Status banners */}
        {data && !data.botOnline ? (
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-dyellow/30 bg-dyellow/[0.07] p-4">
            <WifiOff className="mt-0.5 h-5 w-5 shrink-0 text-dyellow" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-dyellow">The bot is currently offline.</p>
              <p className="mt-1 text-xs leading-relaxed text-dtx-2">
                The web dashboard connects to the bot over a local network. Make sure the Thor
                bot is running (and the <code className="text-dyellow">DASH_API_TOKEN</code> in its .env matches
                the web's), then reload the list.
              </p>
            </div>
          </div>
        ) : null}
        {data?.guildsError === "relogin" || data?.guildsError === "no-token" ? (
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-dred/40 bg-dred/10 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-dred" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-dred">You need to log in again to see your server list.</p>
              <p className="mt-1 text-xs leading-relaxed text-dtx-2">
                Your session doesn't cover the server-list permission yet (a new Discord
                scope). Log out and log back in — it only takes a few seconds.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 border-dred/50 bg-transparent text-dred hover:bg-dred/15 hover:text-dtx-0"
                onClick={() => (window.location.href = "/api/auth/discord")}
              >
                Log in again
              </Button>
            </div>
          </div>
        ) : null}
        {data?.botVersion?.startsWith("mock") ? (
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-sky-500/30 bg-sky-500/[0.07] p-4">
            <BotIcon className="mt-0.5 h-5 w-5 shrink-0 text-sky-400" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-sky-300">Preview mode (demo data).</p>
              <p className="mt-1 text-xs leading-relaxed text-dtx-2">
                The real bot isn't connected — you're viewing sample data on your actual
                servers. All views and forms work normally; changes do not affect your
                Discord servers.
              </p>
            </div>
          </div>
        ) : null}

        {/* Server grid: bot present */}
        {withBot.length > 0 ? (
          <>
            <h2 className="mt-10 text-xs font-medium uppercase tracking-widest text-dtx-4">
              Bot active — ready to manage
            </h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {withBot.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => router.push(`/app/servers/${g.id}`)}
                  className="group flex items-center gap-4 rounded-xl border border-white/[0.06] bg-dbg-1 p-4 text-left transition-all hover:border-blurple/50 hover:bg-dbg-3/60"
                >
                  {guildIcon(g, 64) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={guildIcon(g, 64)!} alt="" className="h-12 w-12 rounded-xl" />
                  ) : (
                    <div className="h-12 w-12 rounded-xl bg-dbg-3 flex items-center justify-center text-base font-semibold text-dtx-2">
                      {g.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-dtx-0">{g.name}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-dgreen">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-dgreen" />
                      Bot active
                    </p>
                  </div>
                  {/* v3.30.0 RBAC: the access tier badge */}
                  {g.tier === 2 ? (
                    <Badge className="shrink-0 bg-sky-500/15 text-sky-300 border-sky-500/30 text-[10px]">Staff</Badge>
                  ) : g.tier === 1 ? (
                    <Badge className="shrink-0 bg-dbg-3/80 text-dtx-3 border-white/[0.08] text-[10px]">Member</Badge>
                  ) : (
                    <Badge className="shrink-0 bg-blurple/15 text-blurple-soft border-blurple/30 text-[10px]">Admin</Badge>
                  )}
                  <Settings2 className="h-4 w-4 shrink-0 text-dtx-4 transition-colors group-hover:text-blurple-soft" aria-hidden="true" />
                </button>
              ))}
            </div>
          </>
        ) : null}

        {/* Server grid: bot not present yet */}
        {withoutBot.length > 0 ? (
          <>
            <h2 className="mt-10 text-xs font-medium uppercase tracking-widest text-dtx-4">
              No bot yet — invite it first
            </h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {withoutBot.map((g) => (
                <div
                  key={g.id}
                  className="flex items-center gap-4 rounded-xl border border-white/[0.04] bg-dbg-1/60 p-4"
                >
                  {guildIcon(g, 64) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={guildIcon(g, 64)!} alt="" className="h-12 w-12 rounded-xl grayscale-[35%] opacity-80" />
                  ) : (
                    <div className="h-12 w-12 rounded-xl bg-dbg-3/70 flex items-center justify-center text-base font-semibold text-dtx-3">
                      {g.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-dtx-1">{g.name}</p>
                    <p className="mt-0.5 text-xs text-dtx-3">Bot not invited yet</p>
                  </div>
                  <a href={data?.inviteUrl ?? "#"} target="_blank" rel="noreferrer" className="shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-white/[0.1] bg-transparent hover:bg-dbg-3 hover:text-dtx-0"
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      Invite
                    </Button>
                  </a>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {/* Empty */}
        {filtered.length === 0 && !data?.guildsError ? (
          <div className="mt-16 flex flex-col items-center text-center gap-3 rounded-xl border border-dashed border-white/[0.1] py-16">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-dbg-1">
              <Search className="h-5 w-5 text-dtx-3" aria-hidden="true" />
            </div>
            <p className="text-sm text-dtx-1">
              {query ? `No servers match “${query}”.` : "No manageable servers yet."}
            </p>
            <p className="max-w-sm text-xs leading-relaxed text-dtx-3">
              {query
                ? "Try a different keyword or reload the list."
                : "You need the Manage Server permission in a Discord server to manage it from here."}
            </p>
          </div>
        ) : null}
      </main>
    </div>
  );
}
