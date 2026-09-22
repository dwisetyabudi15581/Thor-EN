"use client";

// Thor Dashboard home page — one route, two faces:
// - not logged in -> public landing (free-features + web dashboard showcase)
// - logged in     -> immediately redirected to /app (server picker)

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Hammer } from "lucide-react";
import { Landing } from "@/components/dashboard/landing";
import type { MeResponse } from "@/components/dashboard/types";

export default function Page() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  // v3.24.1 FIX (5.3): a failed /api/me fetch used to leave the page on
  // "Preparing the dashboard…" forever (plus an unhandled rejection).
  const [netError, setNetError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // ?_= with a full timestamp forces stale proxy/old-tab caches to fetch a
    // fresh copy from the server; the no-store header closes Next-side caching.
    const res = await fetch(`/api/me?_=${Date.now()}`, { cache: "no-store" });
    setMe((await res.json()) as MeResponse);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await refresh();
      } catch {
        setNetError("Could not reach the dashboard server. Check your connection and retry.");
      } finally {
        setBooting(false);
      }
    })();
  }, [refresh]);

  // Already logged in -> move to the server dashboard ( picker).
  useEffect(() => {
    if (me?.user) router.replace("/app");
  }, [me, router]);

  async function loginDemo(role: "member" | "admin") {
    setBusy(true);
    try {
      await fetch("/api/auth/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (booting || !me) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-dbg-0 text-dtx-0 gap-4">
        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-blurple/10 border border-blurple/25">
          <Hammer className="h-6 w-6 text-blurple-soft" aria-hidden="true" />
          <span className="absolute inset-0 rounded-2xl border border-blurple/40 animate-ping opacity-30" aria-hidden="true" />
        </div>
        <p className="text-sm text-dtx-3">Preparing the dashboard…</p>
      </div>
    );
  }

  // v3.24.1 FIX (5.3): retry UI instead of a dead spinner when the boot fetch failed.
  if (netError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-dbg-0 text-dtx-0 gap-4 px-6 text-center">
        <p className="text-sm text-dtx-2">{netError}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg border border-white/[0.1] bg-transparent px-4 py-2 text-sm text-dtx-2 hover:bg-dbg-3 hover:text-dtx-0"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!me.user) {
    return (
      <Landing
        config={me.config}
        busy={busy}
        onLoginDiscord={() => {
          window.location.href = "/api/auth/discord";
        }}
        onLoginDemo={loginDemo}
      />
    );
  }

  // User is logged in — the redirect effect above is in flight.
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-dbg-0 text-dtx-0 gap-4">
      <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-blurple/10 border border-blurple/25">
        <Hammer className="h-6 w-6 text-blurple-soft" aria-hidden="true" />
        <span className="absolute inset-0 rounded-2xl border border-blurple/40 animate-ping opacity-30" aria-hidden="true" />
      </div>
      <p className="text-sm text-dtx-3">Heading to the dashboard…</p>
    </div>
  );
}
