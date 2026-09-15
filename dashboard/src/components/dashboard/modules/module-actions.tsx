"use client";

// Dashboard action modules: panels with DIRECT operations (CRUD via the bot
// API, no SaveBar) — responders, self-role panels, scheduled announcements,
// temp voice, server stats.
//
// Contract: call(action, method, body) → promise from the web proxy to the
// DASH API, followed by refresh() to pull the payload from the bot again.

import { useState } from "react";
import { Plus, Trash2, Loader2, RefreshCw, Clock, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Field, Section, TextInput, TextArea, Toggle, Select, ChannelSelect, RoleSelect, Pill, channelLabel, roleLabel,
} from "../fields";
import type { DashboardPayload, GuildMeta } from "@/lib/bot-api";

export type ModuleActionProps = {
  draft: DashboardPayload;
  meta: GuildMeta;
  call: (action: string, method: "POST" | "PUT" | "DELETE", body?: unknown) => Promise<unknown>;
  refresh: () => Promise<void>;
  toast: (msg: string, tone?: "ok" | "err") => void;
};

/* ============================================================
 * MODULE: Auto-Responder
 * ============================================================ */

export function RespondersModule({ draft, call, refresh, toast }: ModuleActionProps) {
  const [trigger, setTrigger] = useState("");
  const [reply, setReply] = useState("");
  const [matchMode, setMatchMode] = useState("contains");
  const [replyType, setReplyType] = useState("text");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!trigger.trim() || !reply.trim()) {
      toast("Trigger and reply are both required.", "err");
      return;
    }
    setBusy(true);
    try {
      await call("responders", "POST", { trigger: trigger.trim(), reply: reply.trim(), matchMode, replyType, cooldownMs: 3000 });
      setTrigger("");
      setReply("");
      await refresh();
      toast("Responder added.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to add the responder.", "err");
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: string) {
    try {
      await call(`responders?trigger=${encodeURIComponent(t)}`, "DELETE");
      await refresh();
      toast(`Responder "${t}" deleted.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to delete.", "err");
    }
  }

  return (
    <div className="space-y-5">
      <Section title="Add a Responder" desc="Trigger word → the bot replies automatically. A 3-second per-user cooldown prevents spam.">
        <Field label="Trigger Word" hint="Case-insensitive. “contains” matches as a whole word anywhere.">
          <TextInput value={trigger} onChange={setTrigger} placeholder="e.g. price" />
        </Field>
        <Field label="Match Mode">
          <Select
            value={matchMode}
            onChange={setMatchMode}
            options={[
              { value: "contains", label: "Contains the word (whole)" },
              { value: "exact", label: "Starts with the word (exact)" },
            ]}
          />
        </Field>
        <div className="md:col-span-2">
          <Field label="Bot Reply" hint="Can be multi-line. Embed = rendered as a neat card.">
            <TextArea value={reply} onChange={setReply} rows={3} placeholder="Check the #prices channel!" />
          </Field>
        </div>
        <Field label="Reply Format">
          <Select
            value={replyType}
            onChange={setReplyType}
            options={[
              { value: "text", label: "Plain text" },
              { value: "embed", label: "Embed" },
            ]}
          />
        </Field>
        <div className="flex items-end">
          <Button onClick={add} disabled={busy} className="w-full bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
            Add Responder
          </Button>
        </div>
      </Section>

      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Responder List ({draft.responders.length})</h3>
        <div className="mt-4 space-y-2">
          {draft.responders.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
              No automatic responders yet.
            </p>
          ) : null}
          {draft.responders.map((r) => (
            <div key={r.id} className="flex items-start gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-xs text-amber-300">{r.trigger}</code>
                  <Pill>{r.matchMode === "exact" ? "exact" : "contains"}</Pill>
                  <Pill>{r.replyType}</Pill>
                  {r.useCount ? <Pill tone="green">{r.useCount}× used</Pill> : null}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-zinc-400 line-clamp-3">{r.reply}</p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => remove(r.trigger)}
                className="h-8 w-8 shrink-0 text-zinc-500 hover:text-red-400 hover:bg-red-950/30"
                title="Delete responder"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ============================================================
 * MODULE: Self Roles
 * ============================================================ */

const STYLE_OPTS = [
  { value: "Primary", label: "Blue" },
  { value: "Secondary", label: "Gray" },
  { value: "Success", label: "Green" },
  { value: "Danger", label: "Red" },
];

export function SelfRolesModule({ draft, meta, call, refresh, toast }: ModuleActionProps) {
  const [open, setOpen] = useState(false);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [title, setTitle] = useState("🎭 Pick Your Roles");
  const [description, setDescription] = useState("Click a button to get or remove a role.");
  const [type, setType] = useState("button");
  const [exclusive, setExclusive] = useState(false);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [roleLabel, setRoleLabel] = useState("");
  const [roleEmoji, setRoleEmoji] = useState("");
  const [roles, setRoles] = useState<Array<{ roleId: string; label: string; emoji?: string; style: string }>>([]);
  const [busy, setBusy] = useState(false);

  async function createPanel() {
    if (!channelId) {
      toast("Pick the target channel for the panel.", "err");
      return;
    }
    if (roles.length === 0) {
      toast("Add at least 1 role to the panel.", "err");
      return;
    }
    setBusy(true);
    try {
      await call("selfroles", "POST", { channelId, title, description, type, exclusive, roles });
      setOpen(false);
      setRoles([]);
      await refresh();
      toast("Self-role panel sent.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to create the panel.", "err");
    } finally {
      setBusy(false);
    }
  }

  async function deletePanel(id: string) {
    try {
      await call(`selfroles/${id}`, "DELETE");
      await refresh();
      toast("Panel deleted.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to delete the panel.", "err");
    }
  }

  return (
    <div className="space-y-5">
      {!open ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Self-Role Panels</h3>
            <p className="mt-1 text-xs text-zinc-500">Create a button/select panel — members grab roles themselves, no admin needed.</p>
          </div>
          <Button size="sm" onClick={() => setOpen(true)} className="bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold">
            <Plus className="h-4 w-4" aria-hidden="true" /> New Panel
          </Button>
        </div>
      ) : (
        <Section title="New Self-Role Panel" desc="The panel is sent as a message to the channel you pick — members just click.">
          <Field label="Target Channel">
            <ChannelSelect value={channelId} onChange={setChannelId} channels={meta.channels} placeholder="Pick a channel…" />
          </Field>
          <Field label="Panel Title">
            <TextInput value={title} onChange={setTitle} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Description">
              <TextArea value={description} onChange={setDescription} rows={2} />
            </Field>
          </div>
          <Field label="Panel Format">
            <Select
              value={type}
              onChange={setType}
              options={[
                { value: "button", label: "Buttons (max 25 roles)" },
                { value: "select", label: "Dropdown select" },
              ]}
            />
          </Field>
          <div className="flex items-end">
            <div className="w-full">
              <Toggle
                checked={exclusive}
                onChange={setExclusive}
                label="Exclusive"
                desc="Members may only hold one role from this panel."
              />
            </div>
          </div>
          <div className="md:col-span-2 space-y-2">
            <p className="text-[13px] font-medium text-zinc-300">Roles in the panel ({roles.length})</p>
            <div className="flex flex-wrap gap-2">
              {roles.map((r, i) => (
                <span key={`${r.roleId}-${i}`} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700/60 bg-zinc-800/40 py-1 pl-3 pr-1.5 text-xs text-zinc-300">
                  {r.emoji ? <span>{r.emoji}</span> : null}
                  {r.label}
                  <button
                    type="button"
                    onClick={() => setRoles(roles.filter((_, idx) => idx !== i))}
                    className="flex h-4 w-4 items-center justify-center rounded-full text-zinc-500 hover:bg-red-950/40 hover:text-red-400"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_90px_1fr_auto]">
              <RoleSelect value={roleId} onChange={setRoleId} roles={meta.roles} placeholder="Pick a role…" />
              <TextInput value={roleEmoji} onChange={setRoleEmoji} placeholder="🔔" />
              <TextInput value={roleLabel} onChange={setRoleLabel} placeholder="Button label" />
              <Button
                size="sm"
                variant="outline"
                className="h-10 shrink-0 border-zinc-700 bg-transparent hover:bg-zinc-800 hover:text-zinc-100"
                onClick={() => {
                  if (!roleId) {
                    toast("Pick a role first.", "err");
                    return;
                  }
                  if (roles.some((r) => r.roleId === roleId)) {
                    toast("That role is already in the panel.", "err");
                    return;
                  }
                  setRoles([...roles, { roleId, label: roleLabel.trim() || meta.roles.find((r) => r.id === roleId)?.name || "Role", emoji: roleEmoji.trim() || undefined, style: "Secondary" }]);
                  setRoleId(null);
                  setRoleLabel("");
                  setRoleEmoji("");
                }}
              >
                <Plus className="h-4 w-4" aria-hidden="true" /> Role
              </Button>
            </div>
          </div>
          <div className="flex items-end gap-2 md:col-span-2">
            <Button onClick={createPanel} disabled={busy} className="bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Send Panel
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-100">
              Cancel
            </Button>
          </div>
        </Section>
      )}

      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Active Panels ({draft.selfroles.length})</h3>
        <div className="mt-4 space-y-2">
          {draft.selfroles.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
              No self-role panels on this server yet.
            </p>
          ) : null}
          {draft.selfroles.map((p) => (
            <div key={p.id} className="flex items-start gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-zinc-200">{p.title}</p>
                  <Pill>{p.type === "select" ? "dropdown" : "buttons"}</Pill>
                  {p.exclusive ? <Pill tone="amber">exclusive</Pill> : null}
                  <span className="text-[11px] text-zinc-500">{channelLabel(meta.channels, p.channelId)}</span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">{p.description}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {p.roles.map((r) => (
                    <span key={r.roleId} className="rounded-full bg-zinc-800/50 px-2 py-0.5 text-[10px] text-zinc-400">
                      {r.emoji ? `${r.emoji} ` : ""}{r.label}
                    </span>
                  ))}
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => deletePanel(p.id)}
                className="h-8 w-8 shrink-0 text-zinc-500 hover:text-red-400 hover:bg-red-950/30"
                title="Delete panel + message"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ============================================================
 * MODULE: Scheduled Announcements
 * ============================================================ */

export function AnnounceModule({ draft, meta, call, refresh, toast }: ModuleActionProps) {
  const [channelId, setChannelId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [when, setWhen] = useState("");
  const [recurring, setRecurring] = useState("");
  const [mention, setMention] = useState("");
  const [busy, setBusy] = useState(false);

  const pending = draft.announces.filter((a) => !a.sent);

  async function schedule() {
    if (!channelId || !title.trim() || !description.trim() || !when) {
      toast("Fill in the channel, title, body, and send time.", "err");
      return;
    }
    const ts = new Date(when).getTime();
    if (Number.isNaN(ts) || ts < Date.now() - 60000) {
      toast("The send time must be in the future.", "err");
      return;
    }
    setBusy(true);
    try {
      await call("announce", "POST", {
        channelId,
        sendAt: ts,
        title: title.trim(),
        description: description.trim(),
        recurring: recurring || null,
        mention: mention.trim() || null,
      });
      setTitle("");
      setDescription("");
      setWhen("");
      setRecurring("");
      setMention("");
      await refresh();
      toast("Announcement scheduled.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to schedule.", "err");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    try {
      await call(`announce/${id}`, "DELETE");
      await refresh();
      toast("Announcement canceled.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to cancel.", "err");
    }
  }

  return (
    <div className="space-y-5">
      <Section title="Schedule an Announcement" desc="An embed sent automatically at the chosen time — once or recurring.">
        <Field label="Target Channel">
          <ChannelSelect value={channelId} onChange={setChannelId} channels={meta.channels} placeholder="Pick a channel…" />
        </Field>
        <Field label="Send Time" hint="Uses your device's timezone.">
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="w-full h-10 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 text-sm text-zinc-100 focus:outline-none focus:border-amber-400/50 [color-scheme:dark]"
          />
        </Field>
        <div className="md:col-span-2">
          <Field label="Title">
            <TextInput value={title} onChange={setTitle} placeholder="e.g. 🎉 Weekend Event" />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Announcement Body">
            <TextArea value={description} onChange={setDescription} rows={3} placeholder="Event details, links, etc." />
          </Field>
        </div>
        <Field label="Recurrence">
          <Select
            value={recurring}
            onChange={setRecurring}
            options={[
              { value: "", label: "Send once" },
              { value: "daily", label: "Every day" },
              { value: "weekly", label: "Every week" },
              { value: "monthly", label: "Every month" },
            ]}
          />
        </Field>
        <Field label="Mention (optional)" hint="e.g. @everyone or <@&roleId>">
          <TextInput value={mention} onChange={setMention} placeholder="@everyone" />
        </Field>
        <div className="md:col-span-2">
          <Button onClick={schedule} disabled={busy} className="bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Clock className="h-4 w-4" aria-hidden="true" />}
            Schedule
          </Button>
        </div>
      </Section>

      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Waiting to Send ({pending.length})</h3>
        <div className="mt-4 space-y-2">
          {pending.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
              No scheduled announcements.
            </p>
          ) : null}
          {pending.map((a) => (
            <div key={a.id} className="flex items-start gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-zinc-200">{a.data.title}</p>
                  {a.recurring ? <Pill tone="amber">{a.recurring}</Pill> : null}
                </div>
                <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{a.data.description}</p>
                <p className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
                  <Clock className="h-3 w-3" aria-hidden="true" />
                  {new Date(a.sendAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                  <span className="text-zinc-600">·</span>
                  {channelLabel(meta.channels, a.channelId)}
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => cancel(a.id)}
                className="h-8 w-8 shrink-0 text-zinc-500 hover:text-red-400 hover:bg-red-950/30"
                title="Cancel the announcement"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ============================================================
 * MODULE: Temp Voice & Server Stats (status + actions)
 * ============================================================ */

export function TempVoiceModule({ draft, meta, call, refresh, toast }: ModuleActionProps) {
  const tv = draft.tempvoice;
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-5">
      <Section title="Temporary Voice" desc="Private voice channels per member — created automatically when a member joins the trigger channel.">
        {tv ? (
          <>
            <Field label="Trigger Channel" hint="A member joins this channel → the bot creates their private channel.">
              <div className="flex h-10 items-center rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 text-sm text-zinc-300">
                🔊 {channelLabel(meta.channels, tv.creatorChannelId)}
              </div>
            </Field>
            <Field label="Category">
              <div className="flex h-10 items-center rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 text-sm text-zinc-300">
                {tv.categoryId ? `Category ${tv.categoryId.slice(0, 10)}…` : "—"}
              </div>
            </Field>
            <div className="flex items-end">
              <div className="w-full rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4 text-xs leading-relaxed text-zinc-500">
                <p><b className="text-zinc-300">{tv.activeChannels}</b> active voice channels right now.</p>
                <p className="mt-1.5">Change the channel/category via <code className="text-amber-300/80">/setup-tempvoice</code> in Discord — the setup creates the category + control panel in one go.</p>
              </div>
            </div>
            <div className="flex items-end">
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await call("tempvoice", "DELETE");
                    await refresh();
                    toast("Temp voice setup removed (physical channels are not deleted).");
                  } catch (e) {
                    toast(e instanceof Error ? e.message : "Failed to remove the setup.", "err");
                  } finally {
                    setBusy(false);
                  }
                }}
                className="w-full border-red-900/60 bg-transparent text-red-300 hover:bg-red-950/30 hover:text-red-200"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
                Remove Setup
              </Button>
            </div>
          </>
        ) : (
          <div className="md:col-span-2 rounded-xl border border-dashed border-zinc-800 p-6 text-center">
            <p className="text-xs text-zinc-400">Temp voice is not set up on this server yet.</p>
            <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
              Run <code className="text-amber-300/80">/setup-tempvoice</code> in Discord — the bot creates the category,
              trigger channel, and control panel automatically (orphan-safe: a mid-way failure rolls back).
            </p>
          </div>
        )}
      </Section>
    </div>
  );
}

export function ServerStatsModule({ draft, call, refresh, toast }: ModuleActionProps) {
  const enabled = draft.serverstats?.enabled;
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-5">
      <Section title="Live Server Stats" desc="Counters in channel names: members, bots, boosts, roles, channels — updated automatically (Discord rate-limit safe).">
        <div className="md:col-span-2 flex items-center gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4">
          <span className={`relative flex h-2 w-2 ${enabled ? "" : "grayscale"}`}>
            {enabled ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" /> : null}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${enabled ? "bg-emerald-400" : "bg-zinc-600"}`} />
          </span>
          <p className="text-sm text-zinc-300">{enabled ? "Counters are active and running." : "Counters are not set up yet."}</p>
        </div>
        {enabled ? (
          <div className="md:col-span-2 flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await call("serverstats/refresh", "POST");
                  await refresh();
                  toast("Counters refreshed.");
                } catch (e) {
                  toast(e instanceof Error ? e.message : "Failed to refresh.", "err");
                } finally {
                  setBusy(false);
                }
              }}
              className="border-zinc-700 bg-transparent hover:bg-zinc-800 hover:text-zinc-100"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
              Refresh Now
            </Button>
            <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
              Set up / change counter selection: <code className="text-amber-300/80">/serverstats setup</code> in Discord.
            </p>
          </div>
        ) : (
          <div className="md:col-span-2 rounded-xl border border-dashed border-zinc-800 p-6 text-center">
            <p className="text-xs leading-relaxed text-zinc-500">
              Run <code className="text-amber-300/80">/serverstats setup</code> in Discord to create the category
              + 5 counter channels. Once active, you can force a refresh from here.
            </p>
          </div>
        )}
      </Section>
    </div>
  );
}

/* ============================================================
 * MODULE: Overview summary (used by guild-dashboard)
 * ============================================================ */

export function ModuleOverview({ draft, meta }: { draft: DashboardPayload; meta: GuildMeta }) {
  const c = draft.config;
  const mods = [
    { name: "AutoMod", on: draft.automod.enabled, note: draft.automod.blockLinks ? "spam + links + words" : "spam + words" },
    { name: "Leveling", on: c.leveling.enabled, note: `${c.levelRoles.length} role rewards` },
    { name: "Auto-Role", on: Boolean(c.roles.unverified) || (c.autorole?.roleIds?.length ?? 0) > 0, note: c.roles.unverified ? `marker set${(c.autorole?.roleIds?.length ?? 0) > 0 ? ` + ${(c.autorole?.roleIds?.length ?? 0)} join roles` : ""}` : `${c.autorole?.roleIds?.length ?? 0} join roles` },
    { name: "Tickets", on: c.ticketCategories.length > 0, note: `${c.ticketCategories.length} categories · ${c.products.length} products` },
    { name: "Middleman", on: true, note: `${c.midman.feeMode === "percent" ? `${c.midman.feeValue}%` : `flat ${c.midman.feeValue}`} fee` },
    { name: "Responders", on: draft.responders.length > 0, note: `${draft.responders.length} triggers` },
    { name: "Self Roles", on: draft.selfroles.length > 0, note: `${draft.selfroles.length} panels` },
    { name: "Temp Voice", on: Boolean(draft.tempvoice), note: draft.tempvoice ? `${draft.tempvoice.activeChannels} active channels` : "not set up" },
    { name: "Server Stats", on: Boolean(draft.serverstats?.enabled), note: draft.serverstats?.enabled ? "live counters" : "not set up" },
    { name: "Announcements", on: draft.announces.filter((a) => !a.sent).length > 0, note: `${draft.announces.filter((a) => !a.sent).length} scheduled` },
  ];
  const textChannels = meta.channels.filter((ch) => ch.type === 0).length;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { l: "Members", v: meta.memberCount?.toLocaleString("en-US") ?? "—" },
          { l: "Channels", v: `${meta.channels.length} (${textChannels} text)` },
          { l: "Roles", v: String(meta.roles.length) },
        ].map((s) => (
          <div key={s.l} className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5">
            <p className="text-xs text-zinc-500">{s.l}</p>
            <p className="mt-1.5 text-2xl font-semibold tabular-nums text-zinc-100">{s.v}</p>
          </div>
        ))}
      </div>
      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Module Status</h3>
        <p className="mt-1 text-xs text-zinc-500">A summary of active modules — click a module in the sidebar to configure it.</p>
        <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
          {mods.map((m) => (
            <div key={m.name} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/40 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-zinc-200">{m.name}</p>
                <p className="mt-0.5 truncate text-[11px] text-zinc-500">{m.note}</p>
              </div>
              {m.on ? <Pill tone="green">on</Pill> : <Pill tone="red">off</Pill>}
            </div>
          ))}
        </div>
      </section>
      <p className="px-1 text-[11px] text-zinc-600">
        Configuration changes are collected as a draft and only applied once you press Save.
      </p>
    </div>
  );
}
