"use client";

// /app/servers/[guildId] — per-server dashboard page (Dyno-style).
// Access verification (login + ManageGuild) happens in the API route;
// this page is just a thin shell for the GuildDashboard component.

import { useParams } from "next/navigation";
import { GuildDashboard } from "@/components/dashboard/guild-dashboard";

export default function ServerDashboardPage() {
  const params = useParams<{ guildId: string }>();
  const guildId = typeof params?.guildId === "string" ? params.guildId : "";

  if (!guildId) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 text-zinc-100 gap-2">
        <p className="text-sm text-zinc-400">Invalid server ID.</p>
      </div>
    );
  }

  return <GuildDashboard guildId={guildId} />;
}
