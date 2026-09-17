"use client";

// SideNav — the module navigation, rendered twice by GuildDashboard (v3.25.0):
//   • desktop (lg+): a permanent full-height sidebar on the left
//   • mobile       : a slide-in drawer opened from the ☰ button
// Both shells share this single component so the menu is IDENTICAL everywhere.
//
// Self-explanatory by design: every entry has an icon + full text label,
// entries are grouped (Server / Protection / Community / Tools), and a live
// search box sits on top — with 25 modules it is the fastest way to jump.

import { useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowLeft, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GuildMeta } from "@/lib/bot-api";

export type SideNavModule = {
  id: string;
  label: string;
  icon: LucideIcon;
  group: string;
};

// v3.28.1: inlined at BUILD time via next.config env — this string reflects
// the version of the BUNDLE being served, so a stale build (e.g. after a
// `git pull` without a rebuild) is visible at a glance in the footer below.

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";

type SideNavProps = {
  modules: SideNavModule[];
  /** Currently open module id (drives the active highlight). */
  current: string;
  onSelect: (id: string) => void;
  guildId: string;
  meta: GuildMeta;
  onBack: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** Present only in the mobile drawer — renders the ✕ button. */
  onClose?: () => void;
};

export function SideNav({
  modules,
  current,
  onSelect,
  guildId,
  meta,
  onBack,
  onRefresh,
  refreshing,
  onClose,
}: SideNavProps) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? modules.filter(
          (m) =>
            m.label.toLowerCase().includes(q) || m.group.toLowerCase().includes(q)
        )
      : modules;
    return [...new Set(matched.map((m) => m.group))].map((g) => ({
      group: g,
      items: matched.filter((m) => m.group === g),
    }));
  }, [modules, query]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      {/* Row 1 — back to the server picker (always the top-left escape hatch) */}
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-zinc-900/80 px-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="-ml-2 text-zinc-400 hover:text-zinc-100"
          title="Back to the server list"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          All servers
        </Button>
        {onClose ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="-mr-2 ml-auto h-9 w-9 text-zinc-400 hover:text-zinc-100"
            title="Close menu"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {/* Row 2 — server identity */}
      <div className="flex shrink-0 items-center gap-3 border-b border-zinc-900/80 px-4 py-3">
        {meta.icon ? (
          <img
            src={`https://cdn.discordapp.com/icons/${guildId}/${meta.icon}.png?size=128`}
            alt=""
            className="h-10 w-10 shrink-0 rounded-xl"
          />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-sm font-semibold text-zinc-300">
            {meta.name.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold text-zinc-100">{meta.name}</p>
          <p className="text-[11px] text-zinc-500">
            {meta.memberCount?.toLocaleString("en-US") ?? "—"} members
          </p>
        </div>
      </div>

      {/* Row 3 — live module search */}
      <div className="shrink-0 px-3 pb-2 pt-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search modules…"
            aria-label="Search modules"
            className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900/50 pl-9 pr-9 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:border-amber-400/50 focus:outline-none"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Rows 4 — the grouped module list (scrolls independently) */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="Modules">
        {groups.length === 0 ? (
          <p className="px-2 pt-4 text-xs leading-relaxed text-zinc-500">
            No module matches “{query.trim()}”.
          </p>
        ) : (
          groups.map(({ group, items }) => (
            <div key={group} className="mb-1.5">
              <p className="px-3 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                {group}
              </p>
              <div className="space-y-0.5">
                {items.map((m) => {
                  const active = m.id === current;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => onSelect(m.id)}
                      aria-current={active ? "page" : undefined}
                      className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium transition-colors sm:py-2 ${
                        active
                          ? "bg-amber-400/10 text-amber-300"
                          : "text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200"
                      }`}
                    >
                      {active ? (
                        <span
                          className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-full bg-amber-400"
                          aria-hidden="true"
                        />
                      ) : null}
                      <m.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{m.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </nav>

      {/* Row 5 — footer: refresh */}
      <div className="shrink-0 border-t border-zinc-900/80 p-3">
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          className="w-full border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          title="Reload the latest data from the bot"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {refreshing ? "Refreshing…" : "Refresh data"}
        </Button>
        {APP_VERSION ? (
          <p className="mt-2 select-none text-center text-[10px] leading-none text-zinc-600" title="Version of the dashboard build you are viewing">
            Dashboard v{APP_VERSION}
          </p>
        ) : null}
      </div>
    </div>
  );
}
