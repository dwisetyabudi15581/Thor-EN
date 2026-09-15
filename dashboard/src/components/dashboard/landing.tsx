"use client";

// Public landing page for Thor Dashboard — showcase of the FREE bot + Dyno-style web control.
// v2 (overhaul): the premium subscription model was DROPPED — every bot feature
// is free for everyone. The new value proposition: "two ways to control" (slash
// commands in Discord OR the web dashboard) + all modules fully open.
// Design stays dark editorial (asymmetric, generous whitespace, single gold accent).

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Hammer,
  ArrowRight,
  Loader2,
  Copy,
  Check,
  Lock,
  Terminal,
  LayoutDashboard,
  ShieldCheck,
  Ticket,
  Handshake,
  BarChart3,
  MessageSquareReply,
  Palette,
  Mic,
  Megaphone,
  Activity,
  Hash,
  UserCheck,
  Bot,
  Globe,
  Gift,
  KeyRound,
  Vote,
  SquarePen,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

type LandingProps = {
  config: {
    authReady: boolean;
    demoMode: boolean;
    inviteUrl: string;
    serverTime?: string;
    oauthRedirectUri?: string;
  };
  busy: boolean;
  onLoginDiscord: () => void;
  onLoginDemo: (role: "member" | "admin") => void;
};

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.5 },
};

/* ---------------- Diagnostic elements (rendered in the footer) ---------------- */

function OwnerSetupNote({ serverUri }: { serverUri?: string }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOrigin(serverUri ?? window.location.origin + "/api/auth/discord/callback");
  }, [serverUri]);

  if (!origin) return null;
  const differsFromBrowser =
    serverUri && !serverUri.startsWith(window.location.origin) ? true : false;

  async function copyUri() {
    try {
      await navigator.clipboard.writeText(origin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked? the text can still be selected manually
    }
  }

  return (
    <details className="group rounded-xl border border-zinc-800/80 bg-zinc-900/30">
      <summary className="cursor-pointer list-none px-4 py-3 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors flex items-center gap-2 [&::-webkit-details-marker]:hidden">
        <Lock className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
        Bot owner setup — OAuth redirect address
        <ArrowRight className="ml-auto h-3.5 w-3.5 text-zinc-500 transition-transform group-open:rotate-90" aria-hidden="true" />
      </summary>
      <div className="px-4 pb-4 pt-1">
        <p className="text-xs text-zinc-400 leading-relaxed">
          Register this address once in the Discord Developer Portal (OAuth2 → Redirects)
          so Discord login works:
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 text-[11px] leading-relaxed text-amber-200/90 break-all select-all">
            {origin}
          </code>
          <button
            type="button"
            onClick={copyUri}
            className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {differsFromBrowser ? (
          <p className="text-[10px] text-amber-500/80 mt-2 leading-relaxed">
            Note: the address above (used by the server during login) differs from this
            page&apos;s domain — register the address above, not the one in your address bar.
          </p>
        ) : null}
      </div>
    </details>
  );
}

// Connection health indicator: pulsing green dot when data is fresh.
function ServerStatus({ serverTime }: { serverTime?: string }) {
  if (!serverTime) return null;
  const t = new Date(serverTime);
  const time = t.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const ageSeconds = Math.max(0, Math.round((Date.now() - t.getTime()) / 1000));
  const fresh = ageSeconds < 120;
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-zinc-800/80 bg-zinc-900/40 px-3 py-1.5 text-[11px] text-zinc-400"
      title={fresh ? `Data fresh (${ageSeconds}s ago)` : `STALE DATA ${ageSeconds}s — reload the page`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {fresh ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />
        ) : null}
        <span
          className={`relative inline-flex h-1.5 w-1.5 rounded-full ${fresh ? "bg-emerald-400" : "bg-red-400"}`}
        />
      </span>
      {fresh ? "All systems normal" : "Stale data — reload"}
      <span className="text-zinc-500">· server {time}</span>
    </span>
  );
}

// Login status banner carried by the callback route via ?error=<reason>.
const AUTH_ERRORS: Record<string, { title: string; hint?: string }> = {
  oauth_belum_disiapkan: { title: "Discord login is not set up on the server yet." },
  login_dibatalkan: { title: "Login canceled." },
  sesi_kedaluwarsa: {
    title: "Login session expired — please log in again.",
    hint: "The popup stayed open too long or the state cookie was removed. Click login again.",
  },
  login_gagal: {
    title: "Failed to complete Discord login.",
    hint: "If this keeps happening, make sure the redirect address in the “Bot owner setup” section (footer) is registered in the Discord Developer Portal — exactly identical, no spaces.",
  },
  profil_tidak_terbaca: { title: "Could not read your Discord profile — please try again." },
};

function AuthErrorBanner() {
  const [info, setInfo] = useState<{ title: string; hint?: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get("error");
    if (!reason) return;
    setInfo(AUTH_ERRORS[reason] ?? { title: "Login failed — please try again." });
    params.delete("error");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  }, []);

  if (!info) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-6 p-4 rounded-xl border border-red-900/60 bg-red-950/30"
      role="alert"
    >
      <p className="text-sm font-medium text-red-200">{info.title}</p>
      {info.hint ? <p className="text-xs text-red-200/70 mt-1.5 leading-relaxed">{info.hint}</p> : null}
    </motion.div>
  );
}

/* ---------------- Hero ---------------- */

function Hero({ config, busy, onLoginDiscord }: LandingProps) {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto max-w-6xl px-6 pt-14 pb-16 md:pt-20 md:pb-24">
        <AuthErrorBanner />
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
          {/* Left copy */}
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[11px] font-medium text-amber-300">
              <Bot className="h-3.5 w-3.5" aria-hidden="true" />
              Free · No subscription · Every feature unlocked
            </div>
            <h1 className="mt-5 text-4xl md:text-5xl font-semibold tracking-tight text-zinc-50 leading-[1.08]">
              One bot for your entire server.
              <span className="block text-zinc-400 mt-2">Control it from Discord or the web — whichever feels right.</span>
            </h1>
            <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-zinc-400">
              Thor combines moderation, tickets, a shop, leveling, and community
              automation in a single bot. Configure everything with slash commands, or open
              the web dashboard for full-scale configuration — both write to the same
              data source, so they never conflict.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                onClick={onLoginDiscord}
                disabled={busy}
                className="bg-amber-400 text-zinc-950 hover:bg-amber-300 h-11 px-6 font-semibold"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Open Dashboard
              </Button>
              <a href={config.inviteUrl} target="_blank" rel="noreferrer">
                <Button
                  size="lg"
                  variant="outline"
                  className="h-11 px-6 border-zinc-700 bg-transparent hover:bg-zinc-800/60 hover:text-zinc-100"
                >
                  Invite to Server
                  <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden="true" />
                </Button>
              </a>
            </div>
            <p className="mt-4 text-xs text-zinc-500 leading-relaxed">
              Secure login via Discord OAuth — the bot only reads your server list and
              identity, with no dangerous permissions.
            </p>
          </div>

          {/* Right mockup: two control panels */}
          <div className="hidden lg:block">
            <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-1.5 shadow-2xl shadow-black/40">
              <div className="rounded-xl bg-zinc-950/80 p-4">
                <div className="flex items-center gap-1.5 pb-3 border-b border-zinc-800/60">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
                  <span className="ml-3 text-[11px] text-zinc-500">thor dashboard — #general</span>
                </div>
                <div className="pt-3 space-y-3 font-mono text-[11.5px] leading-relaxed">
                  <p className="text-zinc-500">
                    <span className="text-zinc-300">admin</span> today at 2:02 PM
                  </p>
                  <p>
                    <span className="text-amber-300">/setup-ticket</span>{" "}
                    <span className="text-zinc-400">channel:#🎫create-ticket</span>
                  </p>
                  <p className="text-zinc-600">✅ Ticket panel installed — 4 categories active</p>
                  <p className="text-zinc-500 pt-1">
                    <span className="text-zinc-300">you</span> today at 2:05 PM
                  </p>
                  <p>
                    <span className="text-amber-300">/add-product</span>{" "}
                    <span className="text-zinc-400">label:"VIP 30 Days" price:15,000 IDR</span>
                  </p>
                  <p className="text-zinc-600">✅ Product saved in the transaction category</p>
                </div>
                <div className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2.5">
                  <p className="text-[11px] text-amber-200/90 leading-snug">
                    ↻ The same changes can be made from the web dashboard —
                    data syncs automatically, no restart needed.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Stats strip */}
        <div className="mt-14 grid grid-cols-2 divide-zinc-800/70 border-y border-zinc-800/70 md:grid-cols-4 md:divide-x">
          {[
            { v: "90+", l: "slash commands ready to use" },
            { v: "18", l: "modules configurable from the web" },
            { v: "670+", l: "unit tests — stable & battle-tested" },
            { v: "$0", l: "free forever, no tiers" },
          ].map((s) => (
            <div key={s.l} className="py-5 px-4 text-center md:text-left">
              <p className="text-2xl font-semibold text-zinc-100 tabular-nums">{s.v}</p>
              <p className="mt-1 text-xs text-zinc-500">{s.l}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Two ways to control ---------------- */

const CONTROL_WAYS = [
  {
    icon: Terminal,
    title: "Slash Commands",
    desc: "Fast, right inside Discord. Type / and every command is available — complete with autocomplete, permission checks, and previews. Perfect for quick changes on the spot.",
    points: ["/setup-ticket, /add-product, /set-automod", "Discord permissions still apply", "Instant, no browser needed"],
    accent: false,
  },
  {
    icon: LayoutDashboard,
    title: "Web Dashboard",
    desc: "Full-scale configuration with clean forms — pick channels from a dropdown, edit category lists, schedule announcements. Changes take effect in the bot immediately.",
    points: ["Secure login via Discord OAuth", "Validated forms + live data preview", "Manage many servers from one place"],
    accent: true,
  },
];

function ControlSection() {
  return (
    <section className="border-t border-zinc-900">
      <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
        <motion.p {...fadeUp} className="text-xs font-medium uppercase tracking-widest text-amber-400/90">
          Two Ways to Control
        </motion.p>
        <motion.h2 {...fadeUp} className="mt-3 max-w-2xl text-2xl md:text-3xl font-semibold tracking-tight text-zinc-50">
          One data source, two doors in.
        </motion.h2>
        <motion.p {...fadeUp} className="mt-4 max-w-2xl text-[15px] leading-relaxed text-zinc-400">
          Whatever you change on the web is instantly visible to slash commands —
          and vice versa. No manual syncing, no restarts.
        </motion.p>
        <div className="mt-10 grid gap-5 md:grid-cols-2">
          {CONTROL_WAYS.map((w) => (
            <motion.div
              key={w.title}
              {...fadeUp}
              className={`relative rounded-2xl border p-6 ${
                w.accent
                  ? "border-amber-400/30 bg-gradient-to-b from-amber-400/[0.07] to-transparent"
                  : "border-zinc-800/80 bg-zinc-900/30"
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl border ${
                  w.accent ? "border-amber-400/40 bg-amber-400/10" : "border-zinc-700/60 bg-zinc-800/60"
                }`}>
                  <w.icon className={`h-5 w-5 ${w.accent ? "text-amber-300" : "text-zinc-300"}`} aria-hidden="true" />
                </div>
                <h3 className="text-lg font-semibold text-zinc-100">{w.title}</h3>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-zinc-400">{w.desc}</p>
              <ul className="mt-4 space-y-2">
                {w.points.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-[13px] text-zinc-400">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400/80" aria-hidden="true" />
                    {p}
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Module grid ---------------- */

const MODULES = [
  { icon: ShieldCheck, name: "Moderation & Warnings", desc: "Timeout, purge, kick/ban, and a warning system with history." },
  { icon: Hash, name: "AutoMod", desc: "Anti-spam, link & word blocking, mention limits, whitelists." },
  { icon: Ticket, name: "Tickets & Shop", desc: "Multi-category ticket panels, products, automatic invoices." },
  { icon: Handshake, name: "Middleman (Escrow)", desc: "Three-way buyer–seller–midman deals with a deal board." },
  { icon: BarChart3, name: "Leveling", desc: "XP per message, role rewards per level, leaderboards." },
  { icon: MessageSquareReply, name: "Auto-Responder", desc: "Word triggers → automatic replies, with anti-spam cooldown." },
  { icon: Palette, name: "Self Roles", desc: "Button/select panels for members to pick and drop roles." },
  { icon: Mic, name: "Temporary Voice", desc: "Private voice channels per member, controlled via buttons." },
  { icon: Megaphone, name: "Scheduled Announcements", desc: "One-shot or recurring daily/weekly announcements." },
  { icon: Activity, name: "Server Stats", desc: "Live member/boost/role counters in channel names." },
  { icon: Gift, name: "Auto-Role & Unverified", desc: "Roles granted on join; the Unverified marker disappears on a member's first role." },
  { icon: Globe, name: "Backup", desc: "Server structure snapshots, restore in emergencies." },
  { icon: Terminal, name: "Command Manager", desc: "Enable/disable each slash command per server — Dyno-style." },
  { icon: Gift, name: "Giveaway", desc: "Start giveaways with Join/Leave buttons from the web." },
  { icon: KeyRound, name: "VIP Keys", desc: "Grant product keys — role + auto-expiry included." },
  { icon: SquarePen, name: "Embed Builder", desc: "Build complete embeds with a Discord-style live preview, send them to any channel." },
  { icon: Wand2, name: "Custom Command", desc: "Build your own slash command from the web — instantly registered on Discord for members." },
  { icon: Vote, name: "Poll", desc: "Interactive polls with vote buttons." },
];

function ModulesSection() {
  return (
    <section className="border-t border-zinc-900">
      <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
        <motion.p {...fadeUp} className="text-xs font-medium uppercase tracking-widest text-amber-400/90">
          All Modules
        </motion.p>
        <motion.h2 {...fadeUp} className="mt-3 max-w-2xl text-2xl md:text-3xl font-semibold tracking-tight text-zinc-50">
          18 modules. All free. All configurable from the web.
        </motion.h2>
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <motion.div
              key={m.name}
              {...fadeUp}
              className="group rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4 hover:border-zinc-700 hover:bg-zinc-900/60 transition-colors"
            >
              <m.icon className="h-5 w-5 text-amber-300/90" aria-hidden="true" />
              <h3 className="mt-3 text-sm font-semibold text-zinc-100">{m.name}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">{m.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- How to use ---------------- */

const STEPS = [
  { n: "01", title: "Invite the bot", desc: "Click “Invite to Server”, pick your server, done — slash commands are installed instantly with zero setup." },
  { n: "02", title: "Log in to the dashboard", desc: "Open the dashboard and sign in with Discord. The servers where you are an admin appear automatically." },
  { n: "03", title: "Manage it your way", desc: "Enable modules, set channels and roles, write welcome messages — from the web or slash commands." },
];

function HowSection() {
  return (
    <section className="border-t border-zinc-900">
      <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
        <motion.p {...fadeUp} className="text-xs font-medium uppercase tracking-widest text-amber-400/90">
          Start in 3 Steps
        </motion.p>
        <motion.h2 {...fadeUp} className="mt-3 max-w-2xl text-2xl md:text-3xl font-semibold tracking-tight text-zinc-50">
          From invite to running — in under 5 minutes.
        </motion.h2>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {STEPS.map((s) => (
            <motion.div key={s.n} {...fadeUp} className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-6">
              <p className="font-mono text-xs text-amber-400/80">{s.n}</p>
              <h3 className="mt-3 text-base font-semibold text-zinc-100">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">{s.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- FAQ ---------------- */

const FAQ_ITEMS = [
  {
    q: "Is it really free? Which features are limited?",
    a: "There are no limits. Every module — moderation, tickets, the shop, middleman deals, leveling, automod, even backups — is fully open for all servers, with no paid tiers and no activation keys.",
  },
  {
    q: "What's the difference between configuring via the web vs slash commands?",
    a: "The end result is identical — both write to the same data. The web is more comfortable for long configuration (editing category lists, announcement schedules, welcome messages), while slash commands are faster for small changes right inside Discord.",
  },
  {
    q: "Can the bot change my server without permission?",
    a: "No. The dashboard only shows servers where you have the Manage Server permission on Discord, and every change is re-verified by Discord before it is applied. The bot also only runs commands within the channel permissions you have granted.",
  },
  {
    q: "Where is the configuration data stored?",
    a: "On the server where your bot runs (one JSON file per server) — not in a third-party cloud. If you self-host, the data is 100% yours and can be backed up at any time.",
  },
  {
    q: "Can it be used for many servers at once?",
    a: "Yes. Each server's configuration is fully isolated — server A's settings never leak into server B. The dashboard shows every server where you are an admin.",
  },
];

function FaqSection() {
  return (
    <section id="faq" className="border-t border-zinc-900">
      <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
        <motion.p {...fadeUp} className="text-xs font-medium uppercase tracking-widest text-amber-400/90">
          FAQ
        </motion.p>
        <motion.h2 {...fadeUp} className="mt-3 text-2xl md:text-3xl font-semibold tracking-tight text-zinc-50">
          Frequently asked questions.
        </motion.h2>
        <motion.div {...fadeUp} className="mt-8">
          <Accordion type="single" collapsible className="w-full">
            {FAQ_ITEMS.map((f, i) => (
              <AccordionItem key={f.q} value={`item-${i}`} className="border-zinc-800/80">
                <AccordionTrigger className="text-left text-[15px] text-zinc-200 hover:text-zinc-50 hover:no-underline">
                  {f.q}
                </AccordionTrigger>
                <AccordionContent className="text-sm leading-relaxed text-zinc-400">{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>
      </div>
    </section>
  );
}

/* ---------------- CTA + Footer ---------------- */

function CtaSection({ onLoginDiscord, inviteUrl }: { onLoginDiscord: () => void; inviteUrl: string }) {
  return (
    <section className="border-t border-zinc-900">
      <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
        <motion.div
          {...fadeUp}
          className="relative overflow-hidden rounded-3xl border border-amber-400/25 bg-gradient-to-b from-amber-400/[0.08] to-transparent px-6 py-12 text-center md:px-12"
        >
          <div className="pointer-events-none absolute -top-24 left-1/2 h-48 w-96 -translate-x-1/2 rounded-full bg-amber-400/10 blur-3xl" aria-hidden="true" />
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-zinc-50">
            Your server, ready for a new way to be managed.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-zinc-400">
            Invite the bot, log in, and start configuring your favorite modules. No
            subscription required — everything is open from the very first minute.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button
              onClick={onLoginDiscord}
              className="bg-amber-400 text-zinc-950 hover:bg-amber-300 h-11 px-6 font-semibold"
            >
              Login with Discord
            </Button>
            <a href={inviteUrl} target="_blank" rel="noreferrer">
              <Button variant="outline" className="h-11 px-6 border-zinc-700 bg-transparent hover:bg-zinc-800/60 hover:text-zinc-100">
                Invite Bot
              </Button>
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/* ---------------- Root ---------------- */

export function Landing(props: LandingProps) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-zinc-900/80 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-400/10 border border-amber-400/25">
              <Hammer className="h-4 w-4 text-amber-400" aria-hidden="true" />
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold text-zinc-100">Thor</p>
              <p className="text-[10px] text-zinc-500">Community Bot Dashboard</p>
            </div>
          </div>
          <nav className="hidden items-center gap-6 text-sm text-zinc-400 md:flex">
            <a href="#modules" className="hover:text-zinc-100 transition-colors">Modules</a>
            <a href="#how" className="hover:text-zinc-100 transition-colors">How to Use</a>
            <a href="#faq" className="hover:text-zinc-100 transition-colors">FAQ</a>
          </nav>
          <Button
            onClick={props.onLoginDiscord}
            disabled={props.busy}
            size="sm"
            className="bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold"
          >
            {props.busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Login
          </Button>
        </div>
      </header>

      <main>
        <Hero {...props} />
        <ControlSection />
        <div id="modules">
          <ModulesSection />
        </div>
        <div id="how">
          <HowSection />
        </div>
        <FaqSection />
        <CtaSection onLoginDiscord={props.onLoginDiscord} inviteUrl={props.config.inviteUrl} />
      </main>

      <footer className="border-t border-zinc-900/80">
        <div className="mx-auto max-w-6xl px-6 py-10 space-y-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-amber-400/10 border border-amber-400/25">
                <Hammer className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
              </div>
              <p className="text-xs text-zinc-500">
                Thor Community Bot — free for every server, full control via Discord &amp; the web.
              </p>
            </div>
            <ServerStatus serverTime={props.config.serverTime} />
          </div>
          <OwnerSetupNote serverUri={props.config.oauthRedirectUri} />
        </div>
      </footer>
    </div>
  );
}
