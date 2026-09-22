"use client";

// MODULE: Quick Start (v3.21.0) — mirrors the 🚀 "Quick Start" category from
// /help into the web dashboard. Exactly what the user asked for: "on the web
// there's a quick start slash command category, you configure it right on the
// web — e.g. add role gets a text field to enter the role ID to register".
//
// Shape: a 6-step server setup CHECKLIST. Each step has a live form (quick
// dropdown + manual ID text field) → Apply/Install button → DIRECT action via
// call() (no SaveBar) → the bot applies it to the Discord server. Full
// parity with the slash commands:
//
//   Step 1  Bot Admin Role          ≙ /set-role admin
//   Step 2  Auto-Role on Join       ≙ /set-autorole             (v3.23.0)
//   Step 3  Categories & Products   ≙ /add-category + /add-product
//   Step 4  Install Ticket Panel    ≙ /setup-ticket-panel
//   Step 5  Self-Role Panel         ≙ /setup-selfrole           (v3.22.0)
//   Step 6  Server Log Channel      ≙ /set-channel server-log
//
// v3.23.0: the Unverified marker concept was REMOVED — Step 2 is now purely
// auto-role on join + the "join roles removed once the member gets another
// role" toggle (the Unverified replacement); Step 5 sends the admin to the
// Self Roles module to mount a panel (e.g. a Verification panel).
//
// Below that: "Next steps" — shortcuts to the other category modules
// (serverstats / leveling / tempvoice / responder / selfrole) so the web
// truly connects ALL slash command categories.
//
// Contract: ModuleActionProps (draft/meta/call/refresh/toast) + goTo(module)
// for cross-module navigation (provided by guild-dashboard).

import { useState, type ReactNode } from "react";
import { CheckCircle2, Circle, Loader2, Plus, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Field, TextInput, Select, ChannelSelect, RoleSelect, Pill, Toggle, channelLabel, roleLabel,
} from "../fields";
import type { ModuleActionProps } from "./module-actions";

const SNOWFLAKE_RE = /^\d{5,25}$/;

const ID_HINT = (
  <span>
    Paste the role ID (right-click the role in Discord → <b>Copy ID</b>, requires
    Developer Mode) — <b>or</b> pick one from the list beside it.
  </span>
);

const CHANNEL_ID_HINT = (
  <span>
    Paste the channel ID (right-click the channel → <b>Copy ID</b>) — <b>or</b> pick
    one from the list.
  </span>
);

/* ---------------- Checklist step card ---------------- */

function StepCard({
  n, title, desc, done, children,
}: {
  n: number;
  title: string;
  desc: ReactNode;
  done: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`rounded-2xl border p-5 transition-colors md:p-6 ${
        done ? "border-emerald-500/30 bg-emerald-950/10" : "border-zinc-800/80 bg-zinc-900/30"
      }`}
    >
      <div className="flex items-start gap-3">
        {done ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
        ) : (
          <Circle className="mt-0.5 h-5 w-5 shrink-0 text-zinc-600" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-100">
            <span className="text-zinc-500">{n}.</span>
            {title}
            {done ? <Pill tone="green">done</Pill> : <Pill>pending</Pill>}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">{desc}</p>
        </div>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

/* ============================================================
 * MODULE: Quick Start
 * ============================================================ */

export function QuickStartModule({
  draft, meta, call, refresh, toast, goTo,
}: ModuleActionProps & { goTo: (module: string) => void }) {
  const c = draft.config;
  const [busy, setBusy] = useState<string | null>(null);

  // Steps 1-2: roles (dropdown + manual ID field — initial value = saved one)
  const [adminPick, setAdminPick] = useState<string | null>(c.roles.admin ?? null);
  const [adminId, setAdminId] = useState("");
  const [joinPick, setJoinPick] = useState<string | null>(null);
  const [joinId, setJoinId] = useState("");

  // Step 3: quick product add
  const [prdLabel, setPrdLabel] = useState("");
  const [prdValue, setPrdValue] = useState("");
  const [prdPrice, setPrdPrice] = useState("");
  const [prdCat, setPrdCat] = useState(c.ticketCategories[0]?.id ?? "transaction");
  const [prdKey, setPrdKey] = useState(true);

  // Steps 4-5: panels
  const [panelChannel, setPanelChannel] = useState<string | null>(null);
  const [panelDropdown, setPanelDropdown] = useState(false);

  // Step 6: log channel
  const [logPick, setLogPick] = useState<string | null>(c.channels["server-log"] ?? null);
  const [logId, setLogId] = useState("");

  const cats = c.ticketCategories;
  const products = c.products;
  const panels = draft.panels ?? [];
  const selfrolePanels = draft.selfroles ?? [];

  const done = {
    admin: !!c.roles.admin,
    autorole: (c.autorole?.roleIds?.length ?? 0) > 0,
    catalog: products.length > 0,
    panel: panels.length > 0,
    selfrole: selfrolePanels.length > 0,
    log: !!c.channels["server-log"],
  };
  const doneCount = Object.values(done).filter(Boolean).length;

  /* ---------------- Actions ---------------- */

  async function applyUpdates(step: string, updates: Record<string, unknown>, okMsg: string) {
    setBusy(step);
    try {
      await call("config", "PUT", { updates });
      await refresh();
      toast(okMsg);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to save.", "err");
    } finally {
      setBusy(null);
    }
  }

  /** Apply a role: the manual ID field wins over the dropdown. */
  function applyRole(step: string, dotPath: string, pick: string | null, manualId: string, okMsg: string) {
    const v = manualId.trim() || pick || "";
    if (!v) {
      toast("Pick a role from the list or paste its ID first.", "err");
      return;
    }
    if (!SNOWFLAKE_RE.test(v)) {
      toast("Invalid role ID — must be 5-25 digits. Enable Developer Mode in Discord, right-click the role → Copy ID.", "err");
      return;
    }
    void applyUpdates(step, { [dotPath]: v }, okMsg);
  }

  /** Apply a channel: the manual ID field wins over the dropdown. */
  function applyChannel(step: string, dotPath: string, pick: string | null, manualId: string, okMsg: string) {
    const v = manualId.trim() || pick || "";
    if (!v) {
      toast("Pick a channel from the list or paste its ID first.", "err");
      return;
    }
    if (!SNOWFLAKE_RE.test(v)) {
      toast("Invalid channel ID — must be 5-25 digits. Right-click the channel in Discord → Copy ID.", "err");
      return;
    }
    void applyUpdates(step, { [dotPath]: v }, okMsg);
  }

  /** Step 2: add a role to the join auto-role list (whole array, duplicate-safe). */
  function applyJoinRole(pick: string | null, manualId: string) {
    const v = manualId.trim() || pick || "";
    if (!v) {
      toast("Pick a role from the list or paste its ID first.", "err");
      return;
    }
    if (!SNOWFLAKE_RE.test(v)) {
      toast("Invalid role ID — 5-25 digits. Enable Developer Mode in Discord, right-click the role → Copy ID.", "err");
      return;
    }
    const current = c.autorole?.roleIds ?? [];
    if (current.includes(v)) {
      toast("That role is already in the auto-role list.", "err");
      return;
    }
    void applyUpdates("autorole", { autorole: [...current, v] }, "Join role registered — every new member now receives it automatically.");
  }

  /** Step 2: flip the "remove join roles on another role" toggle. */
  function toggleRemoveOnNewRole() {
    const next = !(c.autorole?.removeOnNewRole ?? false);
    void applyUpdates(
      "autoroleToggle",
      { "autorole.removeOnNewRole": next },
      next
        ? "Toggle ON — join roles disappear automatically once the member gets another role."
        : "Toggle OFF — join roles are permanent."
    );
  }

  async function installTicketPanel() {
    if (!panelChannel) {
      toast("Pick the target channel for the ticket panel first.", "err");
      return;
    }
    setBusy("panel");
    try {
      await call("panels", "POST", { channelId: panelChannel, useDropdown: panelDropdown });
      await refresh();
      toast(`Ticket panel installed in ${channelLabel(meta.channels, panelChannel)} — check Discord.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to install the panel.", "err");
    } finally {
      setBusy(null);
    }
  }

  /** Quick add product (parity with /add-product — whole array + bot validation). */
  async function quickAddProduct() {
    if (!prdLabel.trim() || !prdValue.trim() || !prdPrice.trim()) {
      toast("Label, value, and price are all required.", "err");
      return;
    }
    // v3.28.3: duplicate-value guard — /add-product on Discord rejects a
    // duplicate value (it is the modal customId + lookup key); the web path
    // used to create exactly that state silently.
    const value = prdValue.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (products.some((p) => p.value === value)) {
      toast(`A product with value "${value}" already exists — values must be unique.`, "err");
      return;
    }
    setBusy("product");
    try {
      const next = [
        ...products,
        {
          label: prdLabel.trim(),
          value,
          price: prdPrice.trim(),
          category: prdCat,
          requiresKey: prdKey,
        },
      ];
      await call("config", "PUT", { updates: { products: next } });
      setPrdLabel("");
      setPrdValue("");
      setPrdPrice("");
      await refresh();
      toast("Product added to the price list.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to add the product.", "err");
    } finally {
      setBusy(null);
    }
  }

  /* ---------------- Render ---------------- */

  return (
    <div className="space-y-5">
      {/* Progress */}
      <div className="rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-400/10 to-transparent p-5 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Set up your server from scratch — all from the web</h3>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              Follow the steps below; every form is applied by the bot to your Discord server
              instantly (no slash commands needed). Exactly like the 🚀 Quick Start category in /help.
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-amber-300">
              {doneCount}<span className="text-sm text-zinc-500">/6</span>
            </p>
            <p className="text-[10px] uppercase tracking-widest text-zinc-500">core steps</p>
          </div>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuenow={doneCount} aria-valuemin={0} aria-valuemax={6} aria-label="Setup progress">
          <div
            className="h-full rounded-full bg-amber-400 transition-all duration-500"
            style={{ width: `${(doneCount / 6) * 100}%` }}
          />
        </div>
      </div>

      {/* Step 1 — Admin role */}
      <StepCard
        n={1}
        title="Bot Admin Role"
        desc={<>Members holding this role can use every admin command of the bot. Required before installing the ticket panel. ≙ <code className="text-amber-300/80">/set-role admin</code></>}
        done={done.admin}
      >
        <Field label="Pick from the role list" hint={done.admin ? `Saved: ${roleLabel(meta.roles, c.roles.admin)}` : undefined}>
          <RoleSelect value={adminPick} onChange={setAdminPick} roles={meta.roles} />
        </Field>
        <Field label="…or enter the role ID manually" hint={ID_HINT}>
          <div className="flex gap-2">
            <TextInput value={adminId} onChange={setAdminId} placeholder="e.g. 888000111222333555" />
            <Button
              onClick={() => applyRole("admin", "roles.admin", adminPick, adminId, "Admin role registered — effective in the bot immediately.")}
              disabled={busy === "admin"}
              className="shrink-0 bg-amber-400 font-semibold text-zinc-950 hover:bg-amber-300"
            >
              {busy === "admin" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Register
            </Button>
          </div>
        </Field>
      </StepCard>

      {/* Step 2 — Auto-role on join + toggle (v3.23.0) */}
      <StepCard
        n={2}
        title="Auto-Role on Join"
        desc={<>Roles granted automatically to every new member. Turn the toggle below on if you want them gone once the member gets any other role (self-role, level role, admin grant) — the Unverified replacement, with no separate setup. ≙ <code className="text-amber-300/80">/set-autorole</code></>}
        done={done.autorole}
      >
        <Field label="Pick from the role list" hint={done.autorole ? `Saved: ${(c.autorole?.roleIds ?? []).map((id) => roleLabel(meta.roles, id)).join(", ")}` : undefined}>
          <RoleSelect value={joinPick} onChange={setJoinPick} roles={meta.roles} />
        </Field>
        <Field label="…or enter the role ID manually" hint={ID_HINT}>
          <div className="flex gap-2">
            <TextInput value={joinId} onChange={setJoinId} placeholder="e.g. 888000111222333444" />
            <Button
              onClick={() => applyJoinRole(joinPick, joinId)}
              disabled={busy === "autorole"}
              className="shrink-0 bg-amber-400 font-semibold text-zinc-950 hover:bg-amber-300"
            >
              {busy === "autorole" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Register
            </Button>
          </div>
        </Field>
        <div className="md:col-span-2">
          <Toggle
            checked={c.autorole?.removeOnNewRole ?? false}
            onChange={() => toggleRemoveOnNewRole()}
            label="Remove join roles when the member gets another role"
            desc="ON: every role in the list is stripped automatically once the member receives any other role — perfect for a new-member marker. OFF: join roles are permanent."
          />
        </div>
      </StepCard>

      {/* Step 3 — Categories & products */}
      <StepCard
        n={3}
        title="Ticket Categories & Products"
        desc={<>Prepare your store catalog: every product shows up in the ticket panel's price list. ≙ <code className="text-amber-300/80">/add-product</code> — manage everything in the Tickets &amp; Products module.</>}
        done={done.catalog}
      >
        <div className="md:col-span-2">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800/70 bg-zinc-950/40 px-4 py-3">
            <Pill tone={cats.length > 0 ? "green" : "red"}>{cats.length} categories</Pill>
            <Pill tone={products.length > 0 ? "green" : "red"}>{products.length} products</Pill>
            <span className="text-[11px] text-zinc-500">
              {done.catalog
                ? "Catalog ready — the ticket panel will display this price list."
                : "Add at least 1 product so the ticket panel shows a price list."}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => goTo("tickets")}
              className="ml-auto border-zinc-700 bg-transparent hover:bg-zinc-800 hover:text-zinc-100"
            >
              Manage catalog <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>

        {/* Quick add product */}
        <div className="md:col-span-2 grid gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4 md:grid-cols-6">
          <div className="md:col-span-2">
            <Field label="Product label">
              <TextInput value={prdLabel} onChange={setPrdLabel} placeholder="e.g. VIP 30 Days" />
            </Field>
          </div>
          <div>
            <Field label="Value (unique ID)">
              <TextInput value={prdValue} onChange={setPrdValue} placeholder="vip30" />
            </Field>
          </div>
          <div>
            <Field label="Price">
              <TextInput value={prdPrice} onChange={setPrdPrice} placeholder="$5" />
            </Field>
          </div>
          <div>
            <Field label="Category">
              <Select
                value={prdCat}
                onChange={setPrdCat}
                options={cats.map((cat) => ({ value: cat.id, label: cat.label }))}
              />
            </Field>
          </div>
          <div className="flex items-end">
            <Button
              onClick={quickAddProduct}
              disabled={busy === "product"}
              className="w-full bg-amber-400 font-semibold text-zinc-950 hover:bg-amber-300"
            >
              {busy === "product" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
              Add
            </Button>
          </div>
          <div className="md:col-span-6">
            <button
              type="button"
              onClick={() => setPrdKey(!prdKey)}
              className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                prdKey
                  ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                  : "border-zinc-800 bg-zinc-900/50 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {prdKey ? "key-based (VIP role — granted via /set-key)" : "no key (service/account — details via DM)"}
            </button>
          </div>
        </div>
      </StepCard>

      {/* Step 4 — Ticket panel */}
      <StepCard
        n={4}
        title="Install Ticket Panel"
        desc={<>The bot sends the order panel (embed + category buttons + price list) to the channel you pick — members click to buy. ≙ <code className="text-amber-300/80">/setup-ticket-panel</code></>}
        done={done.panel}
      >
        <Field label="Target channel" hint={done.panel ? `Installed in: ${panels.map((p) => channelLabel(meta.channels, p.channelId)).join(", ")}` : "Pick the channel where the panel should be installed."}>
          <ChannelSelect value={panelChannel} onChange={setPanelChannel} channels={meta.channels} placeholder="— pick a channel —" />
        </Field>
        <Field label="Panel layout" hint="Dropdown saves space for many categories; buttons are more prominent.">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPanelDropdown(false)}
              className={`h-10 flex-1 rounded-lg border text-xs font-medium transition-colors ${
                !panelDropdown ? "border-amber-400/40 bg-amber-400/10 text-amber-300" : "border-zinc-800 bg-zinc-900/50 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              🔘 Buttons
            </button>
            <button
              type="button"
              onClick={() => setPanelDropdown(true)}
              className={`h-10 flex-1 rounded-lg border text-xs font-medium transition-colors ${
                panelDropdown ? "border-amber-400/40 bg-amber-400/10 text-amber-300" : "border-zinc-800 bg-zinc-900/50 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              📋 Dropdown
            </button>
            <Button
              onClick={installTicketPanel}
              disabled={busy === "panel"}
              className="shrink-0 bg-amber-400 font-semibold text-zinc-950 hover:bg-amber-300"
            >
              {busy === "panel" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Install
            </Button>
          </div>
        </Field>
      </StepCard>

      {/* Step 5 — Self-role panel (v3.22.0: replaces the old verification panel) */}
      <StepCard
        n={5}
        title="Self-Role Panel (e.g. Verification)"
        desc={<>A panel where members pick their own roles by clicking buttons — add your Verified role here and it becomes your verification gate, with the style/label/emoji you want. ≙ <code className="text-amber-300/80">/setup-selfrole</code> + <code className="text-amber-300/80">/selfrole-add</code></>}
        done={done.selfrole}
      >
        <Field
          label="Self-role panels"
          hint={done.selfrole ? `${selfrolePanels.length} panel(s) installed — manage them in the Self Roles module.` : "None yet — create one in the Self Roles module."}
        >
          <div className="flex items-center">
            <span className="mr-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300">
              🎭 {selfrolePanels.length} panel{selfrolePanels.length === 1 ? "" : "s"}
            </span>
            <Button
              onClick={() => goTo("selfroles")}
              className="ml-auto bg-amber-400 font-semibold text-zinc-950 hover:bg-amber-300"
            >
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
              Create / Manage
            </Button>
          </div>
        </Field>
      </StepCard>

      {/* Step 6 — Log channel */}
      <StepCard
        n={6}
        title="Server Log Channel"
        desc={<>Records joins/leaves, deleted messages, bans, and every moderation action. ≙ <code className="text-amber-300/80">/set-channel server-log</code></>}
        done={done.log}
      >
        <Field label="Pick from the channel list" hint={done.log ? `Saved: ${channelLabel(meta.channels, c.channels["server-log"])}` : undefined}>
          <ChannelSelect value={logPick} onChange={setLogPick} channels={meta.channels} />
        </Field>
        <Field label="…or enter the channel ID manually" hint={CHANNEL_ID_HINT}>
          <div className="flex gap-2">
            <TextInput value={logId} onChange={setLogId} placeholder="e.g. 777000111222333444" />
            <Button
              onClick={() => applyChannel("log", "channels.server-log", logPick, logId, "Log channel registered — server activity starts being recorded.")}
              disabled={busy === "log"}
              className="shrink-0 bg-amber-400 font-semibold text-zinc-950 hover:bg-amber-300"
            >
              {busy === "log" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Register
            </Button>
          </div>
        </Field>
      </StepCard>

      {/* Next steps — connecting the other categories */}
      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Next steps (optional)</h3>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          Basics running? Every slash command category of this bot has its own module in this
          dashboard — configure everything from the web without opening Discord:
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {[
            { id: "serverstats", label: "Server Stats", desc: "Live member/boost counters at the top of the channel list" },
            { id: "leveling", label: "Leveling", desc: "XP per message + role rewards per level" },
            { id: "tempvoice", label: "Temp Voice", desc: "Private voice channels created by members themselves" },
            { id: "responders", label: "Auto-Responder", desc: "Auto-replies for frequently asked questions" },
            { id: "selfroles", label: "Self Roles", desc: "Panel where members pick their own roles" },
            { id: "automod", label: "AutoMod", desc: "Anti-spam, link & blocked word filtering" },
            { id: "giveaway", label: "Giveaway & Poll", desc: "Interactive contests with join/vote buttons" },
            { id: "embed", label: "Embed Builder", desc: "Build embeds on the web, the bot sends them" },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => goTo(item.id)}
              className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/40 px-4 py-3 text-left transition-colors hover:border-amber-400/30 hover:bg-zinc-900/60"
            >
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-zinc-200">{item.label}</span>
                <span className="mt-0.5 block truncate text-[11px] text-zinc-500">{item.desc}</span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-zinc-600" aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
