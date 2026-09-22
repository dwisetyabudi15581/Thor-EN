"use client";

// WelcomeLivePreview (v3.31.0) — a pixel-honest Discord chat simulation of
// the welcome/goodbye embed, rendered BESIDE the message form so the admin
// sees exactly what a new member will receive BEFORE saving anything.
//
// It mirrors src/bot/memberHandler.js 1:1 (the same builder /test-welcome
// uses): green #2ecc71 welcome · red #e74c3c goodbye · thumbnail = the
// "new member" avatar · footer = guild name (+ icon) · timestamp.
// Template variables are filled with the VIEWER's own data ({user},
// {username}, {server}, {count}, {action}) — identical to /test-welcome.

import { useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { GuildConfig, GuildMeta } from "@/lib/bot-api";

export type PreviewViewer = {
  /** Discord display name (used for {user}/{username}). */
  name: string;
  /** Avatar URL (used as the "new member" thumbnail). */
  avatar: string | null;
};

type WelcomePreviewProps = {
  config: GuildConfig;
  meta: GuildMeta;
  viewer: PreviewViewer | null;
};

/* ---------------- template filling (memberHandler parity) ---------------- */

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  if (!tpl) return "";
  return tpl.replace(/\{(user|username|server|count|action)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

/* ---------------- tiny markdown (bold / italic / mentions) ----------------
 * The welcome/goodbye bodies support **bold**, *italic* and new lines — the
 * preview renders them so the admin isn't surprised by raw asterisks. */

function renderInline(text: string, keyBase: string): ReactNode[] {
  // Split on **bold** first, then *italic* inside the plain spans.
  const out: ReactNode[] = [];
  const boldParts = text.split(/\*\*([^*]+)\*\*/g);
  boldParts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(<strong key={`${keyBase}-b${i}`} className="font-bold text-white">{part}</strong>);
      return;
    }
    if (!part) return;
    const italParts = part.split(/\*([^*]+)\*/g);
    italParts.forEach((ip, j) => {
      if (j % 2 === 1) {
        out.push(<em key={`${keyBase}-i${i}-${j}`} className="italic">{ip}</em>);
        return;
      }
      if (!ip) return;
      // @Mentions render like Discord: tinted pill-ish blue text.
      const mentionParts = ip.split(/(@[^\s@]+)/g);
      mentionParts.forEach((mp, k) => {
        if (mp.startsWith("@") && mp.length > 1) {
          out.push(
            <span key={`${keyBase}-m${i}-${j}-${k}`} className="rounded bg-blurple/25 px-0.5 font-medium text-[#c9cdfb]">
              {mp}
            </span>
          );
        } else if (mp) {
          out.push(<span key={`${keyBase}-t${i}-${j}-${k}`}>{mp}</span>);
        }
      });
    });
  });
  return out;
}

function renderBody(body: string): ReactNode {
  const lines = body.split("\n");
  return lines.map((line, i) => (
    <span key={i}>
      {i > 0 ? <br /> : null}
      {line ? renderInline(line, `l${i}`) : null}
    </span>
  ));
}

/* ---------------- clock label (Discord format) ---------------- */

function previewClock(): string {
  const now = new Date();
  const h = now.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `Today at ${h12}.${String(now.getMinutes()).padStart(2, "0")} ${ampm}`;
}

/* ---------------- the preview ---------------- */

export function WelcomeLivePreview({ config, meta, viewer }: WelcomePreviewProps) {
  const [tab, setTab] = useState<"welcome" | "goodbye">("welcome");

  const isWelcome = tab === "welcome";
  const channelKey = isWelcome ? "welcome" : "goodbye";
  const channelId = config.channels[channelKey] ?? null;
  const channelName = channelId
    ? meta.channels.find((ch) => ch.id === channelId)?.name ?? null
    : null;

  const memberName = viewer?.name ?? "NewMember";
  const vars: Record<string, string> = {
    user: `@${memberName}`,
    username: `${memberName}#0001`,
    server: meta.name,
    count: String((meta.memberCount ?? 0) + (isWelcome ? 1 : 0)),
    action: "left",
  };

  const title = fillTemplate(isWelcome ? config.messages.welcomeTitle : config.messages.goodbyeTitle, vars);
  const body = fillTemplate(isWelcome ? config.messages.welcomeBody : config.messages.goodbyeBody, vars);
  const accent = isWelcome ? "#2ecc71" : "#e74c3c";

  const guildIcon = meta.icon
    ? `https://cdn.discordapp.com/icons/${meta.id}/${meta.icon}.png?size=64`
    : null;

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06]">
      {/* Header: preview tabs + target channel */}
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] bg-dbg-1 px-3.5 py-2.5">
        <div className="flex items-center gap-1 rounded-lg bg-dbg-0 p-1">
          {(["welcome", "goodbye"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize transition-colors ${
                tab === t ? "bg-blurple text-white" : "text-dtx-3 hover:text-dtx-1"
              }`}
              aria-pressed={tab === t}
            >
              {t}
            </button>
          ))}
        </div>
        <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-dtx-3">
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${channelId ? "bg-dgreen" : "bg-dred"}`}
            aria-hidden="true"
          />
          <span className="truncate">
            {channelId
              ? channelName
                ? `→ #${channelName}`
                : `→ deleted channel`
              : `→ no ${channelKey} channel set`}
          </span>
        </p>
      </div>

      {/* The Discord chat simulation */}
      <div className="bg-dbg-2 p-4">
        <div className="flex gap-3">
          {/* Bot avatar */}
          <div className="flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-full bg-dbg-0 text-sm font-black text-blurple-soft ring-2 ring-dbg-2">
            T
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[15px] font-semibold leading-none text-white">Thor</span>
              <span className="rounded bg-blurple px-1 py-px text-[9px] font-semibold uppercase leading-tight text-white">Bot</span>
              <span className="text-[11px] text-dtx-3">{previewClock()}</span>
            </div>

            {/* The embed — the same layout memberHandler produces. */}
            <div
              className="mt-1 max-w-[520px] overflow-hidden rounded-[4px] bg-dbg-1 pl-4 pr-4 pt-3 pb-3"
              style={{ borderLeft: `4px solid ${accent}` }}
            >
              <div className="relative">
                {/* Thumbnail = the "new member" avatar */}
                <div className="absolute right-0 top-0 h-20 w-20">
                  {viewer?.avatar ? (
                    <img src={viewer.avatar} alt="" className="h-20 w-20 rounded object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <div className={`flex h-20 w-20 items-center justify-center rounded text-xl font-semibold ${isWelcome ? "bg-dgreen/20 text-dgreen" : "bg-dred/20 text-dred"}`}>
                      {memberName.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                </div>

                {title ? (
                  <p className="mr-24 text-[15px] font-semibold leading-snug text-white">{renderBody(title)}</p>
                ) : (
                  <p className="mr-24 text-[13px] italic text-dtx-4">(no title set)</p>
                )}

                {body ? (
                  <p className="mr-24 mt-1 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-dtx-1">
                    {renderBody(body)}
                  </p>
                ) : (
                  <p className="mr-24 mt-1 text-[13px] italic text-dtx-4">(no message body set)</p>
                )}

                {/* Footer: guild name + icon + timestamp (memberHandler parity). */}
                <div className="mt-2 flex items-center gap-2">
                  {guildIcon ? (
                    <img src={guildIcon} alt="" className="h-5 w-5 rounded-full object-cover" referrerPolicy="no-referrer" />
                  ) : null}
                  <span className="text-[12px] font-medium text-dtx-3">{meta.name}</span>
                  <span className="text-[12px] text-dtx-3">•</span>
                  <span className="text-[12px] text-dtx-3">{previewClock()}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Honest warning — mirrors the bot's own silent-failure hint. */}
        {!channelId ? (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-dyellow/30 bg-dyellow/10 p-2.5 text-[11px] leading-relaxed text-dyellow">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Without a {channelKey} channel this message is never sent — pick one in “System Channels”, then Test to verify.
          </p>
        ) : null}
      </div>
    </div>
  );
}
