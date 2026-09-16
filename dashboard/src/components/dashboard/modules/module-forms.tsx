"use client";

// Dashboard form modules: panels that edit the BOT CONFIG (changes are collected
// as a draft and then saved all at once via the SaveBar — draft pattern).
//
// Contract with guild-dashboard.tsx:
//   draft     — editable copy of the payload (config/automod mutated via setters)
//   setConfig — mark dirty + change draft.config via dotPath
//   setAutomod— mark dirty + merge a patch into draft.automod
//   meta      — guild channels/roles (for pickers)
//   toast     — small notifications

import { useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, ChevronDown, Info, FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Field, Section, TextInput, TextArea, Toggle, Select, ChannelSelect, RoleSelect, ColorInput, Pill, channelLabel, roleLabel,
} from "../fields";
import type { AutoModConfig, DashboardPayload, GuildMeta, Product, TicketCategory } from "@/lib/bot-api";

export type ModuleFormProps = {
  draft: DashboardPayload;
  meta: GuildMeta;
  setConfig: (dotPath: string, value: unknown) => void;
  setAutomod: (patch: Partial<AutoModConfig>) => void;
  // v3.24.1 FIX (5.1): dedicated setter for the auto-role join list — writes
  // autorole.roleIds into the DRAFT but queues the whole-array `autorole`
  // update for the bot wire (see guild-dashboard.tsx for the split reasoning).
  setAutoroleRoleIds: (roleIds: string[]) => void;
  toast: (msg: string, tone?: "ok" | "err") => void;
  // v3.24.0: direct actions for forms that need a dedicated endpoint (e.g. the
  // "Test Welcome" button in the General module → POST welcome-test).
  // Optional so the other modules don't have to declare it.
  call?: (action: string, method: "POST" | "PUT" | "DELETE", body?: unknown) => Promise<Record<string, unknown>>;
  refresh?: () => Promise<void>;
};

/* ============================================================
 * MODULE: General (roles, channels, messages, auto-role on join, colors)
 * v3.22.0: the verify button section was REPLACED by the Auto-Role editor
 * (parity with /set-autorole) and the Unverified marker explanation.
 * ============================================================ */

const TEMPLATE_VARS = (
  <span>
    Available variables: <code className="text-amber-300/80">{"{user}"}</code>{" "}
    <code className="text-amber-300/80">{"{username}"}</code>{" "}
    <code className="text-amber-300/80">{"{server}"}</code>{" "}
    <code className="text-amber-300/80">{"{count}"}</code>{" "}
    <code className="text-amber-300/80">{"{action}"}</code>
  </span>
);

export function GeneralModule({ draft, meta, setConfig, setAutoroleRoleIds, call, toast }: ModuleFormProps) {
  const c = draft.config;
  // v3.22.0: local picker state for the auto-role list editor.
  const [autorolePick, setAutorolePick] = useState<string | null>(null);
  // v3.24.0: Test Welcome/Goodbye buttons — POST welcome-test (parity with
  // /test-welcome): diagnosis + send the REAL embed to the configured channel.
  const [testing, setTesting] = useState<string | null>(null);
  const autoroleIds = c.autorole?.roleIds ?? [];
  // v3.23.0: the "join roles removed on another role" toggle —
  // replacement for the removed Unverified marker concept.
  const removeOnNewRole = c.autorole?.removeOnNewRole ?? false;

  // v3.24.1 FIX (5.1): route Add/Remove through setAutoroleRoleIds (draft keeps
  // the { roleIds, removeOnNewRole } object; the wire update stays a whole
  // array). The old setConfig("autorole", array) corrupted the draft.
  const addAutorole = () => {
    if (!autorolePick || autoroleIds.includes(autorolePick)) return;
    setAutoroleRoleIds([...autoroleIds, autorolePick]);
    setAutorolePick(null);
  };
  const removeAutorole = (id: string) => {
    setAutoroleRoleIds(autoroleIds.filter((r) => r !== id));
  };

  return (
    <div className="space-y-5">
      <Section title="Key Roles" desc="The bot admin role. Pick from the server's role list.">
        <Field label="Bot Admin Role" hint="Holders of this role can use every admin command on this server.">
          <RoleSelect value={c.roles.admin ?? null} onChange={(v) => setConfig("roles.admin", v)} roles={meta.roles} />
        </Field>
      </Section>

      <Section title="Auto-Role on Join" desc="Roles granted automatically to every new member (≙ /set-autorole, max 10). Turn the toggle below on if you want them gone once the member gets another role.">
        <div className="md:col-span-2">
          <div className="flex flex-wrap gap-2">
            {autoroleIds.length === 0 ? (
              <span className="text-xs text-zinc-500">No join roles yet — add one below (e.g. @Member, or @Unverified as a new-member marker).</span>
            ) : (
              autoroleIds.map((id) => (
                <span key={id} className="flex items-center gap-1 rounded-lg border border-zinc-700/70 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-300">
                  <span className="text-zinc-500">@</span>
                  {meta.roles.find((r) => r.id === id)?.name ?? id}
                  <button type="button" onClick={() => removeAutorole(id)} className="ml-1 text-zinc-500 hover:text-red-400" aria-label="Remove role">×</button>
                </span>
              ))
            )}
          </div>
        </div>
        <Field label="Add a role to the join list" hint={`${autoroleIds.length}/10 roles`}>
          <div className="flex gap-2">
            <RoleSelect value={autorolePick} onChange={setAutorolePick} roles={meta.roles} placeholder="— pick a role —" />
            <Button
              type="button"
              onClick={addAutorole}
              disabled={!autorolePick || autoroleIds.includes(autorolePick) || autoroleIds.length >= 10}
              className="shrink-0 bg-amber-400 font-semibold text-zinc-950 hover:bg-amber-300"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add
            </Button>
          </div>
        </Field>
        <div className="md:col-span-2">
          <Toggle
            checked={removeOnNewRole}
            onChange={(v) => setConfig("autorole.removeOnNewRole", v)}
            label="Remove join roles when the member gets another role"
            desc="While ON: EVERY role in the list above is stripped automatically once the member receives any other role (self-role panels, level rewards, admin grants, other bots…). Perfect for a new-member marker role. While OFF: join roles are permanent."
          />
        </div>
      </Section>

      <Section title="System Channels" desc="Where the bot's automatic messages are sent.">
        <Field label="Welcome Channel" hint="Welcome messages are sent here.">
          <ChannelSelect value={c.channels.welcome ?? null} onChange={(v) => setConfig("channels.welcome", v)} channels={meta.channels} />
        </Field>
        <Field label="Goodbye Channel" hint="Farewell messages are sent here.">
          <ChannelSelect value={c.channels.goodbye ?? null} onChange={(v) => setConfig("channels.goodbye", v)} channels={meta.channels} />
        </Field>
        <Field label="Invoice Channel" hint="Transaction invoices (tickets + middleman deals) are sent here.">
          <ChannelSelect value={c.channels.invoice ?? null} onChange={(v) => setConfig("channels.invoice", v)} channels={meta.channels} />
        </Field>
        {/* v3.21.0: full parity with the "Log & Channel" category (/set-channel all
            types) — previously server-log / server-booster / transcript could only
            be set via slash commands. */}
        <Field label="Server Log Channel" hint="Joins/leaves, deleted messages, bans, moderation actions (≙ /set-channel server-log).">
          <ChannelSelect value={c.channels["server-log"] ?? null} onChange={(v) => setConfig("channels.server-log", v)} channels={meta.channels} />
        </Field>
        <Field label="Booster Channel" hint="Pink embed every time someone boosts the server (≙ /set-channel server-booster).">
          <ChannelSelect value={c.channels["server-booster"] ?? null} onChange={(v) => setConfig("channels.server-booster", v)} channels={meta.channels} />
        </Field>
        <Field label="Ticket Transcript Channel" hint="Chat archive of closed tickets (≙ /set-channel transcript).">
          <ChannelSelect value={c.channels.transcript ?? null} onChange={(v) => setConfig("channels.transcript", v)} channels={meta.channels} />
        </Field>
      </Section>

      <Section title="Welcome & Goodbye Messages" desc={TEMPLATE_VARS}>
        <Field label="Welcome Title">
          <TextInput value={c.messages.welcomeTitle} onChange={(v) => setConfig("messages.welcomeTitle", v)} placeholder="👋 WELCOME!" />
        </Field>
        <Field label="Goodbye Title">
          <TextInput value={c.messages.goodbyeTitle} onChange={(v) => setConfig("messages.goodbyeTitle", v)} placeholder="👋 FAREWELL" />
        </Field>
        <div className="md:col-span-2">
          <Field label="Welcome Body" hint={TEMPLATE_VARS}>
            <TextArea value={c.messages.welcomeBody} onChange={(v) => setConfig("messages.welcomeBody", v)} rows={5} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Goodbye Body" hint={TEMPLATE_VARS}>
            <TextArea value={c.messages.goodbyeBody} onChange={(v) => setConfig("messages.goodbyeBody", v)} rows={4} />
          </Field>
        </div>
      </Section>

      <Section title="Bot Embed Colors" desc="Embed edge colors used by all of the bot's notifications on this server.">
        {(["success", "danger", "primary", "warning", "info"] as const).map((k) => (
          <Field key={k} label={k.charAt(0).toUpperCase() + k.slice(1)}>
            <ColorInput value={c.colors[k] ?? 0} onChange={(v) => setConfig(`colors.${k}`, v)} />
          </Field>
        ))}
      </Section>

      {/* v3.24.0: Test Welcome/Goodbye — /test-welcome parity from the web. */}
      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <FlaskConical className="h-4 w-4 text-emerald-400" aria-hidden="true" /> Test Automated Messages
        </h3>
        <p className="mt-1 text-xs text-zinc-500">
          Send the REAL welcome/goodbye embed (the same builder as the genuine join event) to the configured channel — using your own data as "the new member". Save first if you just changed the channel/message.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {["welcome", "goodbye"].map((tipe) => (
            <Button
              key={tipe}
              size="sm"
              variant="outline"
              disabled={testing !== null || !call}
              onClick={async () => {
                if (!call) return;
                setTesting(tipe);
                try {
                  const res = (await call("welcome-test", "POST", { type: tipe })) as { lines?: string[] };
                  toast(`${tipe} test sent — check the channel. ${res?.lines?.[0] ?? ""}`);
                } catch (e) {
                  toast(e instanceof Error ? e.message : `Failed to test ${tipe}.`, "err");
                } finally {
                  setTesting(null);
                }
              }}
              className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            >
              {testing === tipe ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />}
              Test {tipe === "welcome" ? "Welcome" : "Goodbye"}
            </Button>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ============================================================
 * MODULE: Tickets & Products
 * ============================================================ */

const STYLE_OPTS = [
  { value: "Primary", label: "Blue" },
  { value: "Secondary", label: "Gray" },
  { value: "Success", label: "Green" },
  { value: "Danger", label: "Red" },
];

// The bot's factory ticket categories (mirrors DEFAULTS.ticketCategories in
// src/data/configManager.js). Used by the "Restore" menu so an admin who
// deleted a built-in category from the web can bring it back exactly as it
// was (same id / emoji / style) instead of rebuilding it by hand.
const DEFAULT_CATEGORIES: TicketCategory[] = [
  { id: "transaction", label: "Buy Key / Transaction", emoji: "🔑", style: "Primary", requiresKey: true, isDefault: true },
  { id: "help", label: "Help", emoji: "📞", style: "Secondary", requiresKey: false, isDefault: true },
  { id: "report", label: "Report", emoji: "⚠️", style: "Danger", requiresKey: false, isDefault: true },
  { id: "claim_giveaway", label: "Claim Giveaway", emoji: "🎁", style: "Success", requiresKey: false },
  { id: "midman", label: "Midman / Escrow", emoji: "🤝", style: "Success", requiresKey: false },
];

export function TicketsModule({ draft, meta, setConfig, toast }: ModuleFormProps) {
  const c = draft.config;
  const cats = c.ticketCategories;
  const products = c.products;
  const [restoreOpen, setRestoreOpen] = useState(false);
  const missingDefaults = DEFAULT_CATEGORIES.filter((d) => !cats.some((cat) => cat.id === d.id));

  function updateCat(idx: number, patch: Partial<TicketCategory>) {
    const next = cats.map((cat, i) => (i === idx ? { ...cat, ...patch } : cat));
    setConfig("ticketCategories", next);
  }
  function addCat() {
    if (cats.length >= 25) {
      toast("Maximum of 25 categories (Discord limit).", "err");
      return;
    }
    const id = `cat${Date.now().toString(36).slice(-4)}`;
    setConfig("ticketCategories", [...cats, { id, label: "New Category", emoji: "🎫", style: "Primary", requiresKey: false }]);
  }
  function restoreDefault(def: TicketCategory) {
    if (cats.length >= 25) {
      toast("Maximum of 25 categories (Discord limit).", "err");
      return;
    }
    setConfig("ticketCategories", [...cats, { ...def }]);
    setRestoreOpen(false);
    toast(`Restored "${def.label}" — press Save to apply.`);
  }
  function moveCat(idx: number, dir: -1 | 1) {
    const to = idx + dir;
    if (to < 0 || to >= cats.length) return;
    const next = [...cats];
    [next[idx], next[to]] = [next[to], next[idx]];
    setConfig("ticketCategories", next);
  }
  function removeCat(idx: number) {
    if (cats.length <= 1) {
      toast("At least 1 category is required.", "err");
      return;
    }
    const cat = cats[idx];
    // Built-in categories (transaction / help / report…) are protected on
    // Discord via /remove-category, but the WEB allows deleting them — just
    // confirm first so it can't happen by accident (they stay deleted and can
    // be re-added manually anytime with the "+ Category" button).
    if (cat.isDefault || cat.id === "claim_giveaway" || cat.id === "midman") {
      const ok = window.confirm(
        `Delete the "${cat.label}" category?\n\n` +
          (cat.isDefault
            ? "This is a built-in category — it will stay deleted until you re-add it (Restore menu).\n"
            : "") +
          "Products linked to it are moved to the transaction category.",
      );
      if (!ok) return;
    }
    const nextCats = cats.filter((_, i) => i !== idx);
    // Parity with /remove-category: products of the deleted category are
    // remapped (transaction, or the first remaining category if transaction
    // itself is gone) so they never become orphans hidden from every panel.
    // The bot applies the same rule on save — this keeps the draft identical
    // to what will actually be stored.
    const fallback = nextCats.some((c) => c.id === "transaction") ? "transaction" : (nextCats[0]?.id ?? "transaction");
    const nextProducts = products.map((p) => (p.category === cat.id ? { ...p, category: fallback } : p));
    setConfig("ticketCategories", nextCats);
    setConfig("products", nextProducts);
  }
  function updateProduct(idx: number, patch: Partial<Product>) {
    const next = products.map((p, i) => (i === idx ? { ...p, ...patch } : p));
    setConfig("products", next);
  }
  function addProduct() {
    if (products.length >= 25) {
      toast("Maximum of 25 products (Discord dropdown limit).", "err");
      return;
    }
    const cat = cats[0]?.id ?? "transaction";
    setConfig("products", [
      ...products,
      { label: "New Product", value: `prd${Date.now().toString(36).slice(-4)}`, price: "10,000 IDR", category: cat, requiresKey: true },
    ]);
  }

  return (
    <div className="space-y-5">
      <Section title="Ticket Panel" desc="The ticket panel embed the bot sends to the ticket channel.">
        <Field label="Panel Title">
          <TextInput value={c.messages.ticketTitle} onChange={(v) => setConfig("messages.ticketTitle", v)} />
        </Field>
        <Field label="Price List Header">
          <TextInput value={c.messages.ticketPriceHeader} onChange={(v) => setConfig("messages.ticketPriceHeader", v)} />
        </Field>
        <div className="md:col-span-2">
          <Field
            label="Ticket Panel Body"
            hint={
              <span>
                Variables: <code className="text-amber-300/80">{"{price_list}"}</code>{" "}
                <code className="text-amber-300/80">{"{price_list:<category>}"}</code>{" "}
                <code className="text-amber-300/80">{"{price_header}"}</code>{" "}
                <code className="text-amber-300/80">{"{categories_list}"}</code>
              </span>
            }
          >
            <TextArea value={c.messages.ticketBody} onChange={(v) => setConfig("messages.ticketBody", v)} rows={5} />
          </Field>
        </div>
      </Section>

      {/* Ticket categories */}
      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Ticket Categories</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Each category becomes a button on the panel — members click to open a ticket. Built-in categories can be
              deleted here too (they stay deleted); re-add one anytime with the button on the right.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {missingDefaults.length > 0 && (
              <div className="relative">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRestoreOpen((o) => !o)}
                  className="border-zinc-700 bg-transparent hover:bg-zinc-800 hover:text-zinc-100"
                  title="Bring back a deleted built-in category"
                >
                  Restore <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                {restoreOpen && (
                  <div className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
                    <p className="border-b border-zinc-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                      Built-in categories not in use
                    </p>
                    {missingDefaults.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => restoreDefault(d)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                      >
                        <span aria-hidden="true">{d.emoji}</span> {d.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <Button size="sm" variant="outline" onClick={addCat} className="border-zinc-700 bg-transparent hover:bg-zinc-800 hover:text-zinc-100">
              <Plus className="h-4 w-4" aria-hidden="true" /> Category
            </Button>
          </div>
        </div>
        <div className="mt-5 space-y-3">
          {cats.map((cat, idx) => (
            <div key={`${cat.id}-${idx}`} className="rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4">
              <div className="grid gap-3 sm:grid-cols-[76px_1fr_1fr_140px]">
                <div className="min-w-0">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Emoji</p>
                  <TextInput value={cat.emoji} onChange={(v) => updateCat(idx, { emoji: v })} placeholder="🎫" />
                </div>
                <div className="min-w-0">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Label — button text members see</p>
                  <TextInput value={cat.label} onChange={(v) => updateCat(idx, { label: v })} placeholder="Category label" />
                </div>
                <div className="min-w-0">
                  <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                    <span className="truncate">ID — links products</span>
                    {cat.isDefault ? <Pill tone="amber">built-in</Pill> : null}
                  </p>
                  <TextInput value={cat.id} onChange={(v) => updateCat(idx, { id: v.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} placeholder="id-slug" />
                </div>
                <div className="min-w-0">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Button color</p>
                  <Select value={cat.style} onChange={(v) => updateCat(idx, { style: v })} options={STYLE_OPTS} />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800/60 pt-3">
                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => moveCat(idx, -1)}
                    disabled={idx === 0}
                    className="h-8 w-8 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"
                    title="Move up (changes the button order on the panel)"
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => moveCat(idx, 1)}
                    disabled={idx === cats.length - 1}
                    className="h-8 w-8 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"
                    title="Move down (changes the button order on the panel)"
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
                <button
                  type="button"
                  onClick={() => updateCat(idx, { requiresKey: !cat.requiresKey })}
                  title="A VIP key is required to open a ticket in this category"
                  className={`h-9 rounded-lg border px-2.5 text-[11px] font-medium transition-colors ${
                    cat.requiresKey
                      ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                      : "border-zinc-800 bg-zinc-900/50 text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  needs key
                </button>
                <span className="flex-1" />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => removeCat(idx)}
                  className="h-9 w-9 text-zinc-500 hover:text-red-400 hover:bg-red-950/30"
                  title={cat.isDefault ? "Delete this built-in category (stays deleted)" : "Delete category"}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Products */}
      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Products / Price List</h3>
            <p className="mt-1 text-xs text-zinc-500">Shown in the transaction ticket dropdown + the automatic price list.</p>
          </div>
          <Button size="sm" variant="outline" onClick={addProduct} className="border-zinc-700 bg-transparent hover:bg-zinc-800 hover:text-zinc-100">
            <Plus className="h-4 w-4" aria-hidden="true" /> Product
          </Button>
        </div>
        <div className="mt-5 space-y-3">
          {products.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
              No products yet — add one to start selling through tickets.
            </p>
          ) : null}
          {products.map((p, idx) => (
            <div key={`${p.value}-${idx}`} className="rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_110px_1fr_150px]">
                <div className="min-w-0">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Product name</p>
                  <TextInput value={p.label} onChange={(v) => updateProduct(idx, { label: v })} placeholder="Product name" />
                </div>
                <div className="min-w-0">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Price</p>
                  <TextInput value={p.price} onChange={(v) => updateProduct(idx, { price: v })} placeholder="10,000 IDR" />
                </div>
                <div className="min-w-0">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Ticket category</p>
                  <Select
                    value={p.category}
                    onChange={(v) => updateProduct(idx, { category: v })}
                    options={cats.map((cat) => ({ value: cat.id, label: cat.label }))}
                  />
                </div>
                <div className="min-w-0">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Delivery</p>
                  <button
                    type="button"
                    onClick={() => updateProduct(idx, { requiresKey: !p.requiresKey })}
                    title={
                      p.requiresKey
                        ? "Key-based: a VIP key is generated and the product's role is granted automatically on purchase"
                        : "Manual delivery: the details are sent by staff inside the ticket"
                    }
                    className={`h-9 w-full rounded-lg border px-2.5 text-[11px] font-medium transition-colors ${
                      p.requiresKey
                        ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                        : "border-zinc-800 bg-zinc-900/50 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {p.requiresKey ? "send key" : "manual delivery"}
                  </button>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-end border-t border-zinc-800/60 pt-3">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(`Delete the product "${p.label}"? This cannot be undone after saving.`)) {
                      setConfig("products", products.filter((_, i) => i !== idx));
                    }
                  }}
                  className="h-9 w-9 text-zinc-500 hover:text-red-400 hover:bg-red-950/30"
                  title="Delete product"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ============================================================
 * MODULE: AutoMod
 * ============================================================ */

const ACTION_OPTS = [
  { value: "delete_only", label: "Delete message only" },
  { value: "warn", label: "Warn" },
  { value: "mute_10m", label: "Mute 10 minutes" },
  { value: "mute_1h", label: "Mute 1 hour" },
  { value: "kick", label: "Kick" },
];

export function AutoModModule({ draft, meta, setAutomod }: ModuleFormProps) {
  const a = draft.automod;
  const [wordInput, setWordInput] = useState("");
  const [wordAction, setWordAction] = useState("delete_only");
  const [exemptInput, setExemptInput] = useState("");
  // v3.24.0: link whitelist via picker (channel/role dropdowns) — previously
  // you had to paste IDs one per line into a TextArea.
  const [linkChannelPick, setLinkChannelPick] = useState<string | null>(null);
  const [linkRolePick, setLinkRolePick] = useState<string | null>(null);

  function addWord() {
    const w = wordInput.trim().toLowerCase();
    if (!w) return;
    if (a.wordRules.some((r) => r.word === w)) return;
    setAutomod({ wordRules: [...a.wordRules, { word: w, action: wordAction === "none" ? null : wordAction }] });
    setWordInput("");
  }

  return (
    <div className="space-y-5">
      <Section title="Status & Anti-Spam" desc="The automatic message watchdog — enable it to protect the server without manual moderation.">
        <div className="md:col-span-2">
          <Toggle
            checked={a.enabled}
            onChange={(v) => setAutomod({ enabled: v })}
            label="AutoMod enabled"
            desc="Turn off to disable ALL automatic monitoring instantly."
          />
        </div>
        <Field label="Spam Threshold" hint="Number of messages within the window below that counts as spam.">
          <TextInput type="number" value={a.spamThreshold} onChange={(v) => setAutomod({ spamThreshold: Number(v) || 1 })} />
        </Field>
        <Field label="Spam Window (seconds)">
          <TextInput type="number" value={Math.round(a.spamWindowMs / 1000)} onChange={(v) => setAutomod({ spamWindowMs: (Number(v) || 1) * 1000 })} />
        </Field>
        <Field label="Spam Action">
          <Select value={a.spamAction} onChange={(v) => setAutomod({ spamAction: v })} options={ACTION_OPTS} />
        </Field>
        <Field label="Mention Limit" hint="More than this per message triggers action.">
          <TextInput type="number" value={a.maxMentions} onChange={(v) => setAutomod({ maxMentions: Number(v) || 1 })} />
        </Field>
        <Field label="Excess Mention Action">
          <Select value={a.mentionAction} onChange={(v) => setAutomod({ mentionAction: v })} options={ACTION_OPTS.slice(0, 3)} />
        </Field>
      </Section>

      <Section title="Link Blocking" desc="Delete messages containing links — except in allowed channels/roles.">
        <div className="md:col-span-2">
          <Toggle
            checked={a.blockLinks}
            onChange={(v) => setAutomod({ blockLinks: v })}
            label="Block all links"
            desc="Except for the whitelisted channels & roles below."
          />
        </div>
        {/* v3.24.0: picker + chips (parity with add-link-whitelist) — no ID typing. */}
        <div className="md:col-span-2 space-y-2">
          <Field label="Link-Allowed Channels" hint="Channels listed here may contain links.">
            <div className="flex flex-col gap-2 sm:flex-row">
              <ChannelSelect
                value={linkChannelPick}
                onChange={(v) => {
                  if (!v || a.linkAllowedChannels.includes(v)) return;
                  setAutomod({ linkAllowedChannels: [...a.linkAllowedChannels, v] });
                  setLinkChannelPick(null);
                }}
                channels={meta.channels}
                placeholder="Add a link-allowed channel…"
              />
            </div>
          </Field>
          {a.linkAllowedChannels.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {a.linkAllowedChannels.map((id) => (
                <span key={id} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700/60 bg-zinc-800/40 py-1 pl-3 pr-1.5 text-xs text-zinc-300">
                  <span>#{channelLabel(meta.channels, id)}</span>
                  <button
                    type="button"
                    onClick={() => setAutomod({ linkAllowedChannels: a.linkAllowedChannels.filter((x) => x !== id) })}
                    className="flex h-4 w-4 items-center justify-center rounded-full text-zinc-500 hover:bg-red-950/40 hover:text-red-400"
                    title="Remove the channel from the whitelist"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="md:col-span-2 space-y-2">
          <Field label="Link-Allowed Roles" hint="Members holding these roles may post links anywhere.">
            <div className="flex flex-col gap-2 sm:flex-row">
              <RoleSelect
                value={linkRolePick}
                onChange={(v) => {
                  if (!v || a.linkAllowedRoles.includes(v)) return;
                  setAutomod({ linkAllowedRoles: [...a.linkAllowedRoles, v] });
                  setLinkRolePick(null);
                }}
                roles={meta.roles}
                placeholder="Add a link-allowed role…"
              />
            </div>
          </Field>
          {a.linkAllowedRoles.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {a.linkAllowedRoles.map((id) => (
                <span key={id} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700/60 bg-zinc-800/40 py-1 pl-3 pr-1.5 text-xs text-zinc-300">
                  <span>@{roleLabel(meta.roles, id)}</span>
                  <button
                    type="button"
                    onClick={() => setAutomod({ linkAllowedRoles: a.linkAllowedRoles.filter((x) => x !== id) })}
                    className="flex h-4 w-4 items-center justify-center rounded-full text-zinc-500 hover:bg-red-950/40 hover:text-red-400"
                    title="Remove the role from the whitelist"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </Section>

      <Section title="Word Blocking" desc="Whole-word matching by default — “scam” does not match “scammer”.">
        <Field label="Matching Mode">
          <Select
            value={a.wordMatchMode}
            onChange={(v) => setAutomod({ wordMatchMode: v })}
            options={[
              { value: "whole_word", label: "Whole word (fewer false positives)" },
              { value: "substring", label: "Contains substring (stricter)" },
            ]}
          />
        </Field>
        <Field label="Default Word Action" hint="Used for words without a specific action.">
          <Select value={a.wordAction} onChange={(v) => setAutomod({ wordAction: v })} options={ACTION_OPTS} />
        </Field>
        <div className="md:col-span-2 space-y-2">
          <div className="flex flex-wrap gap-2">
            {a.wordRules.length === 0 ? <p className="text-xs text-zinc-500">No blocked words yet.</p> : null}
            {a.wordRules.map((r, i) => (
              <span key={`${r.word}-${i}`} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700/60 bg-zinc-800/40 py-1 pl-3 pr-1.5 text-xs text-zinc-300">
                <span className="font-mono">{r.word}</span>
                <span className="text-[10px] text-zinc-500">{r.action ?? "default"}</span>
                <button
                  type="button"
                  onClick={() => setAutomod({ wordRules: a.wordRules.filter((_, idx) => idx !== i) })}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-zinc-500 hover:bg-red-950/40 hover:text-red-400"
                  title="Remove word"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <TextInput value={wordInput} onChange={setWordInput} placeholder="word to block…" />
            <Select value={wordAction} onChange={setWordAction} options={ACTION_OPTS} />
            <Button size="sm" onClick={addWord} className="bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold shrink-0 h-10">
              <Plus className="h-4 w-4" aria-hidden="true" /> Block
            </Button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <p className="text-[11px] text-zinc-500">
                Exempt words — cancel out a match (e.g. block “scam”, exempt “scamming_help”).
              </p>
              <TextInput value={exemptInput} onChange={setExemptInput} placeholder="add an exempt word…" />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-10 shrink-0 border-zinc-700 bg-transparent hover:bg-zinc-800 hover:text-zinc-100"
              onClick={() => {
                const w = exemptInput.trim().toLowerCase();
                if (!w || a.exemptWords.includes(w)) return;
                setAutomod({ exemptWords: [...a.exemptWords, w] });
                setExemptInput("");
              }}
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Exempt
            </Button>
          </div>
          {a.exemptWords.length > 0 ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {a.exemptWords.map((w, i) => (
                <span key={`${w}-${i}`} className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-400/5 py-1 pl-3 pr-1.5 text-xs text-emerald-300">
                  <span className="font-mono">{w}</span>
                  <button
                    type="button"
                    onClick={() => setAutomod({ exemptWords: a.exemptWords.filter((_, idx) => idx !== i) })}
                    className="flex h-4 w-4 items-center justify-center rounded-full text-emerald-500/70 hover:bg-red-950/40 hover:text-red-400"
                    title="Remove exemption"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </Section>
    </div>
  );
}

/* ============================================================
 * MODULE: Leveling
 * ============================================================ */

export function LevelingModule({ draft, meta, setConfig, toast }: ModuleFormProps) {
  const c = draft.config;
  const lv = c.leveling;
  const [newLevel, setNewLevel] = useState("");
  const [newRole, setNewRole] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <Section title="Level System" desc="XP is awarded per chat message; levels rise automatically + role rewards.">
        <div className="md:col-span-2">
          <Toggle
            checked={lv.enabled}
            onChange={(v) => setConfig("leveling.enabled", v)}
            label="Leveling enabled"
            desc="Turn off to stop counting XP (existing data stays saved)."
          />
        </div>
        <Field label="XP per Message">
          <TextInput type="number" value={lv.xpPerMessage} onChange={(v) => setConfig("leveling.xpPerMessage", Number(v) || 1)} />
        </Field>
        <Field label="XP Cooldown (seconds)" hint="Gap between counted messages — anti XP spam.">
          <TextInput type="number" value={Math.round(lv.cooldownMs / 1000)} onChange={(v) => setConfig("leveling.cooldownMs", (Number(v) || 1) * 1000)} />
        </Field>
        <div className="md:col-span-2">
          <Toggle
            checked={lv.announceLevelUp}
            onChange={(v) => setConfig("leveling.announceLevelUp", v)}
            label="Announce level-ups"
            desc="The bot sends a congratulation message each time a member levels up."
          />
        </div>
        <Field label="Level-Up Channel" hint="Leave empty = in the channel where the member chatted.">
          <ChannelSelect value={lv.levelUpChannel} onChange={(v) => setConfig("leveling.levelUpChannel", v)} channels={meta.channels} placeholder="— member chat channel —" />
        </Field>
      </Section>

      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Role Rewards per Level</h3>
        <p className="mt-1 text-xs text-zinc-500">Roles granted automatically when a member reaches a certain level.</p>
        <div className="mt-5 space-y-2">
          {c.levelRoles.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-5 text-center text-xs text-zinc-500">
              No role rewards yet — add one to appreciate active members.
            </p>
          ) : null}
          {c.levelRoles
            .slice()
            .sort((x, y) => x.level - y.level)
            .map((lr, i) => (
              <div key={`${lr.level}-${lr.roleId}-${i}`} className="flex items-center gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-3">
                <Pill tone="amber">Lv {lr.level}</Pill>
                <span className="flex-1 truncate text-sm text-zinc-300">
                  {meta.roles.find((r) => r.id === lr.roleId)?.name ?? `role ${lr.roleId.slice(0, 10)}…`}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setConfig("levelRoles", c.levelRoles.filter((x) => x !== lr))}
                  className="h-8 w-8 text-zinc-500 hover:text-red-400 hover:bg-red-950/30"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            ))}
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <TextInput type="number" value={newLevel} onChange={setNewLevel} placeholder="Level (e.g. 10)" />
          <RoleSelect value={newRole} onChange={setNewRole} roles={meta.roles} placeholder="Pick a reward role…" />
          <Button
            size="sm"
            className="h-10 shrink-0 bg-amber-400 text-zinc-950 hover:bg-amber-300 font-semibold"
            onClick={() => {
              const level = Number(newLevel);
              if (!Number.isInteger(level) || level < 1 || level > 1000) {
                toast("Level must be a number between 1 and 1000.", "err");
                return;
              }
              if (!newRole) {
                toast("Pick a reward role first.", "err");
                return;
              }
              if (c.levelRoles.some((x) => x.level === level)) {
                toast(`Level ${level} already has a reward.`, "err");
                return;
              }
              setConfig("levelRoles", [...c.levelRoles, { level, roleId: newRole }]);
              setNewLevel("");
              setNewRole(null);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Add Reward
          </Button>
        </div>
      </section>

      {/* v3.24.0: leveling leaderboard — the same data as /leaderboard-level. */}
      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Leveling Leaderboard</h3>
        <p className="mt-1 text-xs text-zinc-500">Top 10 members by total XP.</p>
        <div className="mt-4 divide-y divide-zinc-800/60">
          {(draft.levelTop ?? []).length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-5 text-center text-xs text-zinc-500">
              No XP data yet — enable leveling and let members chat.
            </p>
          ) : (
            (draft.levelTop ?? []).map((u, i) => (
              <div key={u.userId} className="flex items-center gap-3 py-2.5">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${i === 0 ? "bg-amber-400/15 text-amber-300" : i < 3 ? "bg-zinc-700/40 text-zinc-300" : "bg-zinc-800/40 text-zinc-500"}`}>
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-zinc-300">{u.userId}</span>
                <span className="shrink-0"><Pill tone="amber">Lv {u.level}</Pill></span>
                <span className="w-24 shrink-0 text-right text-[13px] font-medium tabular-nums text-zinc-100">{u.totalXp.toLocaleString("en-US")} XP</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

/* ============================================================
 * MODULE: Middleman (Escrow)
 * ============================================================ */

export function MidmanModule({ draft, meta, setConfig }: ModuleFormProps) {
  const m = draft.config.midman;
  // v3.24.0: active deals list — /midman-deals parity (read-only payload).
  const deals = draft.midmanDeals ?? [];
  return (
    <div className="space-y-5">
      <Section
        title="Escrow / Middleman"
        desc="Three-party deals: buyer — middleman — seller. The fee is calculated automatically when a deal is created."
      >
        <Field label="Fee Mode">
          <Select
            value={m.feeMode}
            onChange={(v) => setConfig("midman.feeMode", v)}
            options={[
              { value: "percent", label: "Percentage of the deal price" },
              { value: "flat", label: "Flat amount" },
            ]}
          />
        </Field>
        <Field
          label={m.feeMode === "percent" ? "Fee Amount (%)" : "Fee Amount (flat)"}
          hint={m.feeMode === "percent" ? "Example: 5 → a 5% fee of the price. The buyer pays price + fee." : "Example: 5000 → a flat 5,000 fee per deal."}
        >
          <TextInput type="number" value={m.feeValue} onChange={(v) => setConfig("midman.feeValue", Number(v) || 0)} />
        </Field>
        <Field label="Deal Channel Category Name" hint="The category where middleman deal channels are created.">
          <TextInput value={m.category} onChange={(v) => setConfig("midman.category", v)} />
        </Field>
        <div className="md:col-span-2 flex items-start gap-3 rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400/80" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-zinc-500">
            Middleman flow: anyone can open a deal via the <b className="text-zinc-300">Middleman</b> category in the
            ticket panel → pick the buyer &amp; seller → the middleman locks the deal → the goods are delivered → the
            middleman releases the funds. Every click is recorded in the deal history.
          </p>
        </div>
      </Section>

      {/* v3.24.0: Active deals — the same data as /midman-deals. */}
      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">Active Deals ({deals.length})</h3>
        <p className="mt-1 text-xs text-zinc-500">Unfinished middleman deals — the buyer's total = price + fee.</p>
        <div className="mt-4 space-y-2">
          {deals.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
              No active middleman deals on this server.
            </p>
          ) : (
            deals.map((d) => (
              <div key={d.id} className="rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13px] font-medium text-zinc-100">#{channelLabel(meta.channels, d.channelId)}</p>
                  <Pill tone="green">{d.stateLabel}</Pill>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  <span className="font-mono">{d.buyerId}</span> ⇄ <span className="font-mono">{d.sellerId}</span> · {d.item}
                </p>
                <p className="mt-0.5 text-xs text-zinc-400">
                  Buyer pays <b>{d.buyerPays.toLocaleString("en-US")}</b> · seller receives {d.sellerGets.toLocaleString("en-US")} · fee {d.fee.toLocaleString("en-US")}
                </p>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
