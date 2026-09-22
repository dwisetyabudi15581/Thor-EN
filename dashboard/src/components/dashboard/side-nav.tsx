"use client";

// SideNav v3.31.0 — the Discord-style module navigation, rendered twice by
// GuildDashboard:
//   • desktop (lg+): a permanent full-height sidebar on the left
//   • mobile       : a slide-in drawer opened from the ☰ button
// Both shells share this single component so the menu is IDENTICAL everywhere.
//
// Layout (top → bottom), mirroring Discord's own app frame:
//   1. live module search (25 modules — the fastest way to jump)
//   2. SERVER SELECTOR — a dropdown listing every server the user can reach
//      (with tier badges); switching servers is one click, no round-trip
//      through the picker page
//   3. the grouped module list (Overview / Moderation / Automation /
//      Economy / Logs & Insights / Admin Settings — icon + label)
//   4. Refresh data
//   5. PROFILE CARD — avatar, name, access tier on this server, log out

import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Check, ChevronDown, LogOut, RefreshCw, Search, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GuildMeta } from "@/lib/bot-api";
import type { UserInfo } from "./types";

export type SideNavModule = {
  id: string;
  label: string;
  icon: LucideIcon;
  group: string;
};

/** One row of the server switcher (subset of /api/guilds items). */
export type ServerItem = {
  id: string;
  name: string;
  icon: string | null;
  botIn: boolean;
  tier?: number;
};

// v3.28.1: inlined at BUILD time via next.config env — this string reflects
// the version of the BUNDLE being served, so a stale build (e.g. after a
// `git pull` without a rebuild) is visible at a glance in the footer below.

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";

function guildIconUrl(id: string, icon: string | null, size: number): string | null {
  return icon ? `https://cdn.discordapp.com/icons/${id}/${icon}.png?size=${size}` : null;
}

function TierBadge({ tier }: { tier?: number }) {
  if (tier === 2) {
    return <span className="shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-[9px] font-semibold text-sky-300">Staff</span>;
  }
  if (tier === 1) {
    return <span className="shrink-0 rounded-full bg-dbg-3 px-2 py-0.5 text-[9px] font-semibold text-dtx-3">Member</span>;
  }
  return <span className="shrink-0 rounded-full bg-blurple/15 px-2 py-0.5 text-[9px] font-semibold text-blurple-soft">Admin</span>;
}

type SideNavProps = {
  modules: SideNavModule[];
  /** Currently open module id (drives the active highlight). */
  current: string;
  onSelect: (id: string) => void;
  guildId: string;
  meta: GuildMeta;
  /** v3.31.0: all reachable servers for the switcher dropdown. */
  servers: ServerItem[];
  /** v3.31.0: switch to another server (the shell guards unsaved edits). */
  onSwitchServer: (guildId: string) => void;
  /** v3.31.0: the logged-in user for the profile card. */
  user: UserInfo | null;
  onLogout: () => void;
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
  servers,
  onSwitchServer,
  user,
  onLogout,
  onBack,
  onRefresh,
  refreshing,
  onClose,
}: SideNavProps) {
  const [query, setQuery] = useState("");
  // v3.31.0: the server-switcher dropdown state.
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const serverMenuRef = useRef<HTMLDivElement | null>(null);

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

  // Close the server dropdown on outside clicks (the click-catcher below
  // handles pointer events; this covers edge cases like focus loss).
  useEffect(() => {
    if (!serverMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (serverMenuRef.current && !serverMenuRef.current.contains(e.target as Node)) {
        setServerMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [serverMenuOpen]);

  const currentServer = servers.find((s) => s.id === guildId) ?? null;
  const avatar = user?.avatar
    ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png?size=64`
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-dbg-1">
      {/* Row 1 — live module search */}
      <div className="shrink-0 px-3 pb-2 pt-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-dtx-3"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search modules…"
            aria-label="Search modules"
            className="h-9 w-full rounded-lg border border-white/[0.08] bg-dbg-0 pl-9 pr-9 text-[13px] text-dtx-0 placeholder:text-dtx-4 focus:border-blurple focus:outline-none focus:ring-1 focus:ring-blurple/40"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-dtx-3 hover:bg-dbg-3 hover:text-dtx-1"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Row 2 — SERVER SELECTOR (v3.31.0): switch servers without leaving
          the dashboard. The shell confirms unsaved edits first. */}
      <div className="relative shrink-0 px-3 pb-2" ref={serverMenuRef}>
        <button
          type="button"
          onClick={() => setServerMenuOpen((v) => !v)}
          aria-expanded={serverMenuOpen}
          aria-haspopup="listbox"
          className="flex w-full items-center gap-2.5 rounded-lg border border-white/[0.06] bg-dbg-0/70 px-2.5 py-2 text-left transition-colors hover:border-white/[0.12] hover:bg-dbg-0"
        >
          {meta.icon ? (
            <img
              src={`https://cdn.discordapp.com/icons/${guildId}/${meta.icon}.png?size=128`}
              alt=""
              className="h-8 w-8 shrink-0 rounded-lg"
            />
          ) : (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-dbg-3 text-xs font-semibold text-dtx-2">
              {meta.name.slice(0, 2).toUpperCase()}
            </div>
          )}
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[13px] font-semibold text-dtx-0">{meta.name}</span>
            <span className="block text-[10px] text-dtx-3">
              {meta.memberCount?.toLocaleString("en-US") ?? "—"} members
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-dtx-3 transition-transform ${serverMenuOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>

        {/* The dropdown itself — every reachable server, with tier badges. */}
        {serverMenuOpen ? (
          <div
            role="listbox"
            aria-label="Switch server"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation(); // don't let it close the whole mobile drawer
                setServerMenuOpen(false);
              }
            }}
            className="absolute left-3 right-3 top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-white/[0.08] bg-dbg-0 shadow-2xl"
          >
            <p className="border-b border-white/[0.06] px-3 pb-1.5 pt-2.5 text-[10px] font-semibold uppercase tracking-widest text-dtx-4">
              Your servers
            </p>
            <div className="max-h-72 overflow-y-auto overscroll-contain py-1">
              {servers.map((s) => {
                const active = s.id === guildId;
                const url = guildIconUrl(s.id, s.icon, 64);
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      setServerMenuOpen(false);
                      if (!active) onSwitchServer(s.id);
                    }}
                    className={`flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors ${
                      active ? "bg-blurple/15" : "hover:bg-dbg-3/70"
                    }`}
                  >
                    {url ? (
                      <img src={url} alt="" className="h-7 w-7 shrink-0 rounded-lg" />
                    ) : (
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-dbg-3 text-[10px] font-semibold text-dtx-2">
                        {s.name.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? "font-semibold text-dtx-0" : "text-dtx-1"}`}>
                      {s.name}
                    </span>
                    {!s.botIn ? (
                      <span className="shrink-0 text-[9px] font-medium text-dtx-4">no bot</span>
                    ) : null}
                    {active ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-blurple-soft" aria-hidden="true" />
                    ) : (
                      <TierBadge tier={s.tier} />
                    )}
                  </button>
                );
              })}
              {servers.length === 0 ? (
                <p className="px-3 py-3 text-xs leading-relaxed text-dtx-3">
                  Server list unavailable — use the picker page.
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => {
                setServerMenuOpen(false);
                onBack();
              }}
              className="flex w-full items-center justify-center gap-1.5 border-t border-white/[0.06] px-3 py-2 text-[11px] text-dtx-3 transition-colors hover:bg-dbg-3/70 hover:text-dtx-1"
            >
              View the full server list →
            </button>
          </div>
        ) : null}
      </div>

      {/* Row 3 — the grouped module list (scrolls independently) */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="Modules">
        {groups.length === 0 ? (
          <p className="px-2 pt-4 text-xs leading-relaxed text-dtx-3">
            No module matches “{query.trim()}”.
          </p>
        ) : (
          groups.map(({ group, items }) => (
            <div key={group} className="mb-1.5">
              <p className="px-3 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-widest text-dtx-4">
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
                          ? "bg-blurple/15 text-white"
                          : "text-dtx-2 hover:bg-white/[0.04] hover:text-dtx-0"
                      }`}
                    >
                      {active ? (
                        <span
                          className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-full bg-blurple"
                          aria-hidden="true"
                        />
                      ) : null}
                      <m.icon
                        className={`h-4 w-4 shrink-0 ${active ? "text-blurple-soft" : "text-dtx-3"}`}
                        aria-hidden="true"
                      />
                      <span className="truncate">{m.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </nav>

      {/* Row 4 — refresh */}
      <div className="shrink-0 border-t border-white/[0.06] p-3">
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          className="w-full border-white/[0.08] bg-dbg-0/40 text-dtx-2 hover:bg-dbg-3 hover:text-dtx-0"
          title="Reload the latest data from the bot"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {refreshing ? "Refreshing…" : "Refresh data"}
        </Button>
      </div>

      {/* Row 5 — PROFILE CARD (v3.31.0): who you are + your tier + log out. */}
      <div className="shrink-0 border-t border-white/[0.06] p-3">
        <div className="flex items-center gap-2.5 rounded-xl bg-dbg-0/70 p-2.5">
          {avatar ? (
            <img src={avatar} alt="" className="h-9 w-9 shrink-0 rounded-full" />
          ) : (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blurple text-sm font-semibold text-white">
              {(user?.globalName || user?.username || "?").slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13px] font-semibold text-dtx-0">
              {user?.globalName || user?.username || "Not signed in"}
            </p>
            <div className="mt-0.5 flex items-center gap-1.5">
              <TierBadge tier={currentServer?.tier ?? 3} />
              {APP_VERSION ? (
                <span className="text-[9px] text-dtx-4" title="Version of the dashboard build you are viewing">
                  v{APP_VERSION}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-dtx-3 transition-colors hover:bg-dred/15 hover:text-dred"
            title="Log out"
            aria-label="Log out"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
