"use client";

// Dashboard tool modules (v3.19.0) — Command Manager (Dyno-style) + new
// modules: Giveaway, Poll, Embed, Backup, Moderation (warn/modlog), Keys (VIP).
//
// All actions go straight through call() → web proxy → the bot's DASH API
// (no SaveBar), following the ModuleActionProps contract from
// module-actions.tsx. Full parity with Discord: every action here has a
// matching command (/commands, /giveaway, /poll, /embed-builder,
// /backup-now, /warn-list, /set-key) — one data source, two interfaces.

import { useMemo, useState } from "react";
import {
  Plus, Trash2, Loader2, RefreshCw, Search, ToggleLeft, ToggleRight,
  CheckCircle2, XCircle, KeyRound, Gift, BarChart3, ShieldAlert, Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Field, Section, TextInput, TextArea, Toggle, Select, ChannelSelect,
  RoleSelect, ColorInput, Pill, channelLabel, roleLabel,
} from "../fields";
import type { DashboardPayload, GuildMeta } from "@/lib/bot-api";
import type { ModuleActionProps } from "./module-actions";

/* ============================================================
 * Command domain labels (Dyno-style grouping)
 * ============================================================ */

const DOMAIN_META: Array<{ key: string; label: string }> = [
  { key: "help", label: "Help" },
  { key: "commands", label: "Command Management" },
  { key: "config", label: "Server Settings" },
  { key: "categories", label: "Ticket Categories" },
  { key: "panels", label: "Ticket Panels" },
  { key: "panels-mgmt", label: "Panel Management" },
  { key: "products", label: "Products" },
  { key: "keys", label: "VIP Keys" },
  { key: "midman", label: "Middleman" },
  { key: "moderation", label: "Moderation" },
  { key: "warn", label: "Warnings" },
  { key: "automod", label: "AutoMod" },
  { key: "responder", label: "Auto-Responder" },
  { key: "selfrole", label: "Self Roles" },
  { key: "leveling", label: "Leveling" },
  { key: "announce", label: "Announcements" },
  { key: "embed", label: "Embed Builder" },
  { key: "send-message", label: "Send Messages" },
  { key: "giveaway", label: "Giveaway" },
  { key: "poll", label: "Poll" },
  { key: "backup", label: "Backup" },
  { key: "stats", label: "Statistics" },
  { key: "serverstats", label: "Server Stats" },
  { key: "tempvoice", label: "Temp Voice" },
  { key: "afk", label: "AFK" },
];

function domainLabel(key: string) {
  return DOMAIN_META.find((d) => d.key === key)?.label ?? "Other";
}

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
 * MODULE: Command Manager (Dyno-style)
 * ============================================================ */

export function CommandManagerModule({ draft, call, refresh, toast }: ModuleActionProps) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const disabled = useMemo(() => new Set(draft.commands.disabled), [draft.commands]);
  const protectedSet = useMemo(() => new Set(draft.commands.protected), [draft.commands]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = draft.commands.list.filter(
      (c) => !q || c.name.includes(q) || c.description.toLowerCase().includes(q) || domainLabel(c.domain).toLowerCase().includes(q)
    );
    const map = new Map<string, typeof filtered>();
    for (const c of filtered) {
      if (!map.has(c.domain)) map.set(c.domain, []);
      map.get(c.domain)!.push(c);
    }
    // Order follows DOMAIN_META; unknown domains go last.
    const order = DOMAIN_META.map((d) => d.key);
    return [...map.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
  }, [draft.commands.list, query]);

  async function save(next: Iterable<string>, okMsg: string) {
    setBusy(true);
    try {
      await call("commands", "PUT", { disabled: [...new Set(next)] });
      await refresh();
      toast(okMsg);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to save.", "err");
    } finally {
      setBusy(false);
    }
  }

  function toggle(name: string) {
    if (protectedSet.has(name)) return;
    const next = new Set(disabled);
    if (next.has(name)) {
      next.delete(name);
      void save(next, `/${name} enabled.`);
    } else {
      next.add(name);
      void save(next, `/${name} disabled — the bot will reject this command on Discord.`);
    }
  }

  function toggleGroup(domain: string, commands: Array<{ name: string }>, targetDisabled: boolean) {
    const next = new Set(disabled);
    for (const c of commands) {
      if (protectedSet.has(c.name)) continue;
      if (targetDisabled) next.add(c.name);
      else next.delete(c.name);
    }
    void save(next, `Group "${domainLabel(domain)}" ${targetDisabled ? "disabled" : "enabled"}.`);
  }

  return (
    <div className="space-y-5">
      <Section
        title="Command Manager"
        desc={
          <>
            Disable the commands you do not use on this server — exactly the Dyno philosophy. Disabled commands are
            rejected by the bot with a clear message to members.{" "}
            <span className="text-zinc-400">Also manageable from Discord: </span>
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-amber-200">/commands toggle</code>
          </>
        }
      >
        <div className="md:col-span-2">
          <Field label="Search Commands" hint={`${draft.commands.list.length} commands total · ${disabled.size} disabled`}>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. giveaway, warn, backup…"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 py-2 pl-9 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-400/50 focus:outline-none"
              />
            </div>
          </Field>
        </div>
        <div className="flex items-end gap-2 md:col-span-2">
          <Button
            onClick={() => void save([], "All commands re-enabled.")}
            disabled={busy || disabled.size === 0}
            className="bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold"
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Enable All
          </Button>
          {disabled.size > 0 ? (
            <Pill tone="amber">{disabled.size} disabled</Pill>
          ) : (
            <Pill tone="green">All enabled</Pill>
          )}
        </div>
      </Section>

      {grouped.map(([domain, commands]) => {
        const disabledCount = commands.filter((c) => disabled.has(c.name)).length;
        return (
          <section key={domain} className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-zinc-100">
                {domainLabel(domain)}{" "}
                <span className="font-normal text-zinc-500">
                  ({commands.length} command{disabledCount > 0 ? `, ${disabledCount} off` : ""})
                </span>
              </h3>
              <div className="flex gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toggleGroup(domain, commands, false)}
                  disabled={busy || disabledCount === 0}
                  className="h-7 border-zinc-700 bg-transparent px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                >
                  Enable group
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toggleGroup(domain, commands, true)}
                  disabled={busy || disabledCount === commands.filter((c) => !protectedSet.has(c.name)).length}
                  className="h-7 border-zinc-700 bg-transparent px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                >
                  Disable group
                </Button>
              </div>
            </div>
            <div className="mt-3 divide-y divide-zinc-800/60">
              {commands.map((c) => {
                const isOn = !disabled.has(c.name);
                const isProtected = protectedSet.has(c.name);
                return (
                  <div key={c.name} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-[13px] font-medium text-zinc-100">
                        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-[12px] text-amber-200">/{c.name}</code>
                        {isProtected ? <Pill tone="green">disable-proof</Pill> : null}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-zinc-500">{c.description}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggle(c.name)}
                      disabled={busy || isProtected}
                      title={isProtected ? "Management commands cannot be disabled (anti-lockout)" : isOn ? "Disable" : "Enable"}
                      className={`shrink-0 transition-colors ${isProtected ? "cursor-not-allowed opacity-60" : ""} ${
                        isOn ? "text-emerald-400 hover:text-emerald-300" : "text-zinc-600 hover:text-zinc-400"
                      }`}
                      aria-label={`${isOn ? "Disable" : "Enable"} /${c.name}`}
                    >
                      {isOn ? <ToggleRight className="h-6 w-6" aria-hidden="true" /> : <ToggleLeft className="h-6 w-6" aria-hidden="true" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {grouped.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
          No commands match the search &ldquo;{query}&rdquo;.
        </p>
      ) : null}
    </div>
  );
}

/* ============================================================
 * MODULE: Giveaway
 * ============================================================ */

export function GiveawayModule({ draft, meta, call, refresh, toast }: ModuleActionProps) {
  const [channelId, setChannelId] = useState<string | null>(null);
  const [prize, setPrize] = useState("");
  const [winners, setWinners] = useState("1");
  const [durationMin, setDurationMin] = useState("60");
  const [requiredRoleId, setRequiredRoleId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const active = draft.giveaways.filter((g) => !g.ended);
  const finished = draft.giveaways.filter((g) => g.ended);

  async function create() {
    setBusy(true);
    try {
      await call("giveaway", "POST", {
        channelId,
        prize: prize.trim(),
        winners: Math.max(1, parseInt(winners) || 1),
        durationMin: Math.max(1, parseInt(durationMin) || 60),
        requiredRoleId,
      });
      setPrize("");
      await refresh();
      toast("Giveaway created — message sent to the channel.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to create the giveaway.", "err");
    } finally {
      setBusy(false);
    }
  }

  function renderRow(g: (typeof draft.giveaways)[number]) {
    return (
      <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[13px] font-medium text-zinc-100">
            <Gift className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
            {g.prize}
            {g.ended ? <Pill tone="zinc">finished</Pill> : <Pill tone="green">running</Pill>}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {g.winnersCount} winner(s) · {g.participantIds.length} entries · {channelLabel(meta.channels, g.channelId)} ·{" "}
            {g.ended ? `ended ${fmtDate(g.endsAt)}` : `ends ${fmtDate(g.endsAt)}`} · host {g.hostTag}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Section title="Create a Giveaway" desc="Same as /giveaway create — the bot sends the message + Join/Leave buttons to the channel.">
        <Field label="Channel">
          <ChannelSelect value={channelId} onChange={setChannelId} channels={meta.channels} />
        </Field>
        <Field label="Prize">
          <TextInput value={prize} onChange={setPrize} placeholder="e.g. 30 Days VIP" />
        </Field>
        <Field label="Number of Winners">
          <TextInput value={winners} onChange={(v) => setWinners(v.replace(/[^0-9]/g, ""))} placeholder="1" />
        </Field>
        <Field label="Duration (minutes)" hint="1 minute to 30 days (43200).">
          <TextInput value={durationMin} onChange={(v) => setDurationMin(v.replace(/[^0-9]/g, ""))} placeholder="60" />
        </Field>
        <Field label="Required Role (optional)">
          <RoleSelect value={requiredRoleId} onChange={setRequiredRoleId} roles={meta.roles} />
        </Field>
        <div className="flex items-end">
          <Button
            onClick={create}
            disabled={busy || !channelId || !prize.trim()}
            className="w-full bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
            Start Giveaway
          </Button>
        </div>
      </Section>

      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Running ({active.length})</h3>
        <div className="mt-4 space-y-2">
          {active.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
              No active giveaways. Create one with the form above or /giveaway create.
            </p>
          ) : (
            active.map(renderRow)
          )}
        </div>
        {finished.length > 0 ? (
          <>
            <h3 className="mt-6 text-sm font-semibold text-zinc-400">History ({finished.length})</h3>
            <div className="mt-3 space-y-2">{finished.slice(0, 10).map(renderRow)}</div>
          </>
        ) : null}
      </section>
    </div>
  );
}

/* ============================================================
 * MODULE: Poll
 * ============================================================ */

export function PollModule({ draft, meta, call, refresh, toast }: ModuleActionProps) {
  const [channelId, setChannelId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [multiple, setMultiple] = useState(false);
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [busy, setBusy] = useState(false);

  async function create() {
    const clean = options.map((o) => o.trim()).filter(Boolean);
    setBusy(true);
    try {
      await call("poll", "POST", { channelId, question: question.trim(), multiple, options: clean.map((label) => ({ label })) });
      setQuestion("");
      setOptions(["", ""]);
      await refresh();
      toast("Poll created — message + vote buttons sent.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to create the poll.", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Section title="Create a Poll" desc="Same as /poll create — members vote with buttons, results update live in the message.">
        <div className="md:col-span-2">
          <Field label="Channel">
            <ChannelSelect value={channelId} onChange={setChannelId} channels={meta.channels} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Question" hint="Max 250 characters.">
            <TextInput value={question} onChange={setQuestion} placeholder="e.g. What should we play next?" />
          </Field>
        </div>
        <Field label="Vote Mode">
          <Select
            value={multiple ? "multi" : "single"}
            onChange={(v) => setMultiple(v === "multi")}
            options={[
              { value: "single", label: "Single — pick one" },
              { value: "multi", label: "Multi — pick several" },
            ]}
          />
        </Field>
        <div className="md:col-span-2 space-y-2">
          <p className="text-xs font-medium text-zinc-300">Options (2–10)</p>
          {options.map((opt, i) => (
            <div key={i} className="flex gap-2">
              <TextInput
                value={opt}
                onChange={(v) => setOptions((prev) => prev.map((p, j) => (j === i ? v : p)))}
                placeholder={`Option ${i + 1}`}
              />
              {options.length > 2 ? (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                  className="shrink-0 border-zinc-700 bg-transparent hover:bg-zinc-800"
                  aria-label={`Remove option ${i + 1}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          ))}
          {options.length < 10 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOptions((prev) => [...prev, ""])}
              className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add option
            </Button>
          ) : null}
        </div>
        <div className="flex items-end">
          <Button
            onClick={create}
            disabled={busy || !channelId || !question.trim() || options.map((o) => o.trim()).filter(Boolean).length < 2}
            className="w-full bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <BarChart3 className="h-4 w-4" aria-hidden="true" />}
            Send Poll
          </Button>
        </div>
      </Section>

      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Polls on This Server ({draft.polls.length})</h3>
        <div className="mt-4 space-y-2">
          {draft.polls.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
              No polls yet. Create one with the form above or /poll create.
            </p>
          ) : (
            draft.polls.slice(0, 15).map((p) => {
              const total = p.options.reduce((s, o) => s + o.votes.length, 0);
              return (
                <div key={p.id} className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
                  <p className="flex items-center gap-2 text-[13px] font-medium text-zinc-100">
                    {p.question}
                    {p.closed ? <Pill tone="zinc">closed</Pill> : <Pill tone="green">open</Pill>}
                    {p.multiple ? <Pill tone="amber">multi</Pill> : null}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {p.options.length} options · {total} votes · {channelLabel(meta.channels, p.channelId)} · by {p.creatorTag} · {fmtDate(p.createdAt)}
                  </p>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

/* ============================================================
 * MODULE: Embed Builder (send embed)
 * ============================================================ */

export function EmbedModule({ meta, call, toast }: ModuleActionProps) {
  const [channelId, setChannelId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [footer, setFooter] = useState("");
  const [color, setColor] = useState(0x5865f2);
  const [busy, setBusy] = useState(false);
  const [lastUrl, setLastUrl] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    try {
      const res = (await call("embed", "POST", { channelId, title: title.trim(), description: description.trim(), footer: footer.trim() || undefined, color })) as {
        url?: string;
      };
      setLastUrl(res?.url ?? null);
      setTitle("");
      setDescription("");
      setFooter("");
      toast("Embed sent to the channel.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to send the embed.", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Section title="Send an Embed" desc="A quick alternative to /embed-builder & /send-message — perfect for one-off announcements.">
        <Field label="Channel">
          <ChannelSelect value={channelId} onChange={setChannelId} channels={meta.channels} />
        </Field>
        <Field label="Title" hint="Optional when a description is filled. Max 256.">
          <TextInput value={title} onChange={setTitle} placeholder="Embed title" />
        </Field>
        <Field label="Color">
          <ColorInput value={color} onChange={setColor} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Body (description)" hint="Supports **bold**, *italic*, and new lines. Max 4096.">
            <TextArea value={description} onChange={setDescription} rows={5} placeholder="Write the message content here…" />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Footer (optional)">
            <TextInput value={footer} onChange={setFooter} placeholder="e.g. From the Admins" />
          </Field>
        </div>
        <div className="flex items-end md:col-span-2">
          <Button
            onClick={send}
            disabled={busy || !channelId || (!title.trim() && !description.trim())}
            className="w-full bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
            Send Embed
          </Button>
        </div>
      </Section>

      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Preview</h3>
        <div className="mt-4 overflow-hidden rounded-lg border-l-4 bg-zinc-800/40 p-4" style={{ borderColor: `#${color.toString(16).padStart(6, "0")}` }}>
          <p className="text-sm font-semibold text-zinc-100">{title.trim() || <span className="text-zinc-600">(no title)</span>}</p>
          <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-300">
            {description.trim() || <span className="text-zinc-600">(no body)</span>}
          </p>
          {footer.trim() ? <p className="mt-3 text-[11px] text-zinc-500">{footer.trim()}</p> : null}
        </div>
        {lastUrl ? (
          <a href={lastUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-xs text-amber-300 hover:underline">
            Open the last message in Discord
          </a>
        ) : null}
      </section>
    </div>
  );
}

/* ============================================================
 * MODULE: Backup
 * ============================================================ */

export function BackupModule({ draft, call, refresh, toast }: ModuleActionProps) {
  const [busy, setBusy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);

  async function createNow() {
    setBusy(true);
    try {
      const res = (await call("backups", "POST", {})) as { backupName?: string };
      await refresh();
      toast(`Backup created: ${res?.backupName ?? "OK"}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to create the backup.", "err");
    } finally {
      setBusy(false);
    }
  }

  async function restore(name: string) {
    setBusy(true);
    try {
      await call(`backups/${encodeURIComponent(name)}/restore`, "POST", {});
      await refresh();
      toast(`Backup ${name} restored. Reload the page to see the restored data.`);
      setConfirmRestore(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to restore.", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Section
        title="Bot Data Backups"
        desc={
          <>
            Same as <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-amber-200">/backup-now</code> — a
            safety backup also runs automatically every 24h (max 7 slots, oldest falls off).
          </>
        }
      >
        <div className="flex items-end">
          <Button onClick={createNow} disabled={busy} className="w-full bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
            Back Up Now
          </Button>
        </div>
      </Section>

      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Backup Slots ({draft.backups.length})</h3>
        <div className="mt-4 space-y-2">
          {draft.backups.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
              No backups yet. Hit &ldquo;Back Up Now&rdquo; above.
            </p>
          ) : (
            draft.backups.map((b) => (
              <div key={b.name} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[13px] font-medium text-zinc-100">
                    {b.name.startsWith("pre-restore_") ? <Pill tone="amber">pre-restore</Pill> : null}
                    <code className="text-[12px] text-zinc-200">{b.name}</code>
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {fmtDate(b.mtime)} · {b.fileCount} files · {(b.size / 1024).toFixed(1)} KB
                  </p>
                </div>
                {confirmRestore === b.name ? (
                  <div className="flex items-center gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => setConfirmRestore(null)} disabled={busy} className="h-7 border-zinc-700 bg-transparent px-2.5 text-[11px]">
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void restore(b.name)}
                      disabled={busy}
                      className="h-7 bg-red-500 px-2.5 text-[11px] font-semibold text-white hover:bg-red-400"
                    >
                      Yes, restore
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmRestore(b.name)}
                    disabled={busy}
                    className="h-7 border-zinc-700 bg-transparent px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Restore
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
        <p className="mt-4 text-[11px] leading-relaxed text-zinc-500">
          Restoring overwrites the bot data with the state captured in that backup. A safety backup
          (&ldquo;pre-restore&rdquo;) is taken automatically before overwriting — you can always go back.
        </p>
      </section>
    </div>
  );
}

/* ============================================================
 * MODULE: Moderation (warn + modlog viewers)
 * ============================================================ */

const MODLOG_LABEL: Record<string, string> = {
  timeout: "🔇 Timeout",
  untimeout: "🔊 Timeout lifted",
  kick: "👢 Kick",
  ban: "🔨 Ban",
  unban: "♻️ Unban",
};

export function ModerationModule({ draft, toast }: ModuleActionProps) {
  const [warnFilter, setWarnFilter] = useState("");

  const warns = useMemo(() => {
    const q = warnFilter.trim().toLowerCase();
    if (!q) return draft.warns;
    return draft.warns.filter((w) => w.reason.toLowerCase().includes(q) || w.userId.includes(q) || w.warnedByTag.toLowerCase().includes(q));
  }, [draft.warns, warnFilter]);

  return (
    <div className="space-y-5">
      <Section
        title="Moderation History"
        desc={
          <>
            Combines <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-amber-200">/warn-list</code> and
            moderator actions (timeout/kick/ban) — the 50 most recent entries, read-only. Actions stay on Discord.
          </>
        }
      >
        <div className="md:col-span-2">
          <Field label="Search Warns" hint="Filter by reason, user ID, or moderator.">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
              <input
                value={warnFilter}
                onChange={(e) => setWarnFilter(e.target.value)}
                placeholder="e.g. spam, 123456789…"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 py-2 pl-9 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-400/50 focus:outline-none"
              />
            </div>
          </Field>
        </div>
      </Section>

      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <ShieldAlert className="h-4 w-4 text-amber-300" aria-hidden="true" />
          Warns ({warns.length} most recent)
        </h3>
        <div className="mt-4 space-y-2">
          {warns.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
              {draft.warns.length === 0 ? "No warns recorded on this server. A clean server is a happy server." : "No warns match your search."}
            </p>
          ) : (
            warns.map((w) => (
              <div key={w.id} className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
                <p className="text-[13px] text-zinc-100">
                  <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">{w.userId}</code>{" "}
                  — {w.reason}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  by {w.warnedByTag} · {fmtDate(w.createdAt)}
                  {w.actionTaken ? ` · automatic action: ${w.actionTaken}` : ""}
                </p>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Moderator Actions ({draft.modlogs.length} most recent)</h3>
        <div className="mt-4 space-y-2">
          {draft.modlogs.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
              No timeout/kick/ban actions recorded yet.
            </p>
          ) : (
            draft.modlogs.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[13px] text-zinc-100">
                    {MODLOG_LABEL[m.type] ?? m.type} — <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">{m.userId}</code>
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {m.reason} · by {m.moderatorTag} · {fmtDate(m.createdAt)}
                  </p>
                </div>
                {m.durationMs ? <Pill tone="amber">{fmtDuration(m.durationMs)}</Pill> : null}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

/* ============================================================
 * MODULE: Keys (VIP)
 * ============================================================ */

export function KeysModule({ draft, meta, call, refresh, toast }: ModuleActionProps) {
  const [userId, setUserId] = useState("");
  const [value, setValue] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);

  const productsWithRole = draft.config.products.filter((p) => p.roleId);

  async function generate() {
    setBusy(true);
    try {
      const res = (await call("keys", "POST", {
        userId: userId.trim(),
        value,
        key: customKey.trim() || undefined,
      })) as { key?: string; warnings?: string[] };
      setLastKey(res?.key ?? null);
      setUserId("");
      setCustomKey("");
      await refresh();
      toast(res?.warnings?.length ? `Key created, but: ${res.warnings.join(" ")}` : "Key created & role granted.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to create the key.", "err");
    } finally {
      setBusy(false);
    }
  }

  async function clearUser(uid: string) {
    setBusy(true);
    try {
      await call(`keys?userId=${encodeURIComponent(uid)}`, "DELETE");
      await refresh();
      toast(`All keys for ${uid} removed + product roles lifted.`);
      setConfirmClear(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to remove the keys.", "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Section
        title="Grant a VIP Key"
        desc={
          <>
            Same as <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-amber-200">/set-key</code> — the
            key is created, the product role is granted to the member, and auto-expiry is scheduled automatically.
          </>
        }
      >
        <Field label="Discord User ID" hint="Right-click the user in Discord → Copy User ID (enable Developer Mode).">
          <TextInput value={userId} onChange={(v) => setUserId(v.replace(/[^0-9]/g, ""))} placeholder="e.g. 123456789012345678" />
        </Field>
        <Field label="Product" hint={productsWithRole.length === 0 ? "No products with a role yet — set one in the Tickets & Products module." : undefined}>
          <Select
            value={value}
            onChange={setValue}
            options={[
              { value: "", label: "— pick a product —" },
              ...productsWithRole.map((p) => ({ value: p.value, label: `${p.label} (${p.days ? `${p.days} days` : "permanent"})` })),
            ]}
          />
        </Field>
        <Field label="Custom Key Code (optional)" hint="Empty = auto-generated in XXXXX-XXXXX-XXXXX format.">
          <TextInput value={customKey} onChange={setCustomKey} placeholder="GIFT-2026-THOR" />
        </Field>
        <div className="flex items-end">
          <Button
            onClick={generate}
            disabled={busy || !userId.trim() || !value}
            className="w-full bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <KeyRound className="h-4 w-4" aria-hidden="true" />}
            Create Key
          </Button>
        </div>
      </Section>

      {lastKey ? (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/20 p-4">
          <p className="text-xs text-emerald-300">The most recently created key — send it to the member:</p>
          <code className="mt-1.5 block select-all rounded-lg bg-zinc-900 px-3 py-2 font-mono text-sm text-emerald-200">{lastKey}</code>
        </div>
      ) : null}

      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Active Keys on This Server ({draft.keys.length})</h3>
        <div className="mt-4 space-y-2">
          {draft.keys.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
              No keys for this server yet. Create one with the form above or /set-key.
            </p>
          ) : (
            draft.keys.map((k) => {
              const expired = k.expireAt !== null && k.expireAt < Date.now();
              return (
                <div key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-[13px] text-zinc-100">
                      <code className="select-all rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[12px] text-amber-200">{k.key}</code>
                      {k.expireAt === null ? <Pill tone="green">permanent</Pill> : expired ? <Pill tone="red">expired</Pill> : <Pill tone="zinc">{fmtDate(k.expireAt)}</Pill>}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {k.username || k.userId} · {k.productName} · {roleLabel(meta.roles, k.roleId)} · created {fmtDate(k.createdAt)}
                    </p>
                  </div>
                  {confirmClear === k.userId ? (
                    <div className="flex items-center gap-1.5">
                      <Button variant="outline" size="sm" onClick={() => setConfirmClear(null)} disabled={busy} className="h-7 border-zinc-700 bg-transparent px-2.5 text-[11px]">
                        Cancel
                      </Button>
                      <Button size="sm" onClick={() => void clearUser(k.userId)} disabled={busy} className="h-7 bg-red-500 px-2.5 text-[11px] font-semibold text-white hover:bg-red-400">
                        Yes, remove all
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmClear(k.userId)}
                      disabled={busy}
                      className="h-7 border-zinc-700 bg-transparent px-2.5 text-[11px] text-red-300 hover:bg-red-950/30"
                      title="Remove all of this user's keys + lift product roles (parity with /clear-schedule)"
                    >
                      <XCircle className="h-3.5 w-3.5" aria-hidden="true" /> Clear
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
