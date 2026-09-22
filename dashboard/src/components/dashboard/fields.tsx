"use client";

// Reusable form controls for the dashboard modules (v3.31.0 — Discord design
// language). All fields use Discord's dark scheme (raised #2b2d31 cards,
// #1e1f22 inputs, blurple focus) and are reused by module-forms.tsx so the
// modules never build UI from scratch.
//
// v3.31.0 UX contract (the "understand in 3 seconds" rule):
//   - every Toggle switch is GREEN when ON, RED when OFF (high-contrast
//     status at a glance, no reading required)
//   - inputs sit on the deep #1e1f22 well color, exactly like Discord's
//     own settings forms
//   - destructive hints (deleted channel/role ghosts) stay red

import { useState, type ReactNode } from "react";
import type { BotChannel, BotRole } from "@/lib/bot-api";

/* ---------------- Shells ---------------- */

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-dtx-1">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11px] leading-relaxed text-dtx-3">{hint}</p> : null}
    </div>
  );
}

export function Section({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/[0.06] bg-dbg-1 p-5 md:p-6">
      <h3 className="text-sm font-semibold text-dtx-0">{title}</h3>
      {desc ? <p className="mt-1 text-xs leading-relaxed text-dtx-3">{desc}</p> : null}
      <div className="mt-5 grid gap-5 md:grid-cols-2">{children}</div>
    </section>
  );
}

/* ---------------- Basic inputs ---------------- */

const inputCls =
  "w-full h-10 rounded-lg border border-white/[0.08] bg-dbg-0 px-3 text-sm text-dtx-0 placeholder:text-dtx-4 focus:outline-none focus:border-blurple focus:ring-1 focus:ring-blurple/40 disabled:opacity-50";

export function TextInput({
  value, onChange, placeholder, disabled, id, type = "text", invalid,
}: {
  value: string | number;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  type?: string;
  invalid?: boolean;
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputCls} ${invalid ? "border-dred/70" : ""}`}
    />
  );
}

export function TextArea({
  value, onChange, rows = 4, placeholder, id,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  id?: string;
}) {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-white/[0.08] bg-dbg-0 px-3 py-2.5 text-sm leading-relaxed text-dtx-0 placeholder:text-dtx-4 focus:outline-none focus:border-blurple focus:ring-1 focus:ring-blurple/40 resize-y"
    />
  );
}

export function Toggle({
  checked, onChange, label, desc,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  desc?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 rounded-lg border border-white/[0.06] bg-dbg-0/50 px-3.5 py-3 text-left transition-colors hover:border-white/[0.12]"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-[13px] font-medium text-dtx-1">
          {label}
          {/* High-contrast ON/OFF word — green when on, red when off. */}
          <span className={`text-[10px] font-bold uppercase tracking-wide ${checked ? "text-dgreen" : "text-dred"}`}>
            {checked ? "ON" : "OFF"}
          </span>
        </span>
        {desc ? <span className="mt-0.5 block text-[11px] leading-snug text-dtx-3">{desc}</span> : null}
      </span>
      {/* The switch itself: green track when ON, red track when OFF —
          unmistakable at any glance distance. */}
      <span
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-dgreen" : "bg-dred/80"
        }`}
        style={{ height: 24, width: 44 }}
      >
        <span
          className={`inline-block h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-[22px]" : "translate-x-[3px]"
          }`}
        />
      </span>
    </button>
  );
}

export function Select({
  value, onChange, options, placeholder, id,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
  id?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputCls} appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23949ba4%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.75rem_center] bg-no-repeat pr-9`}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled === true}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/* ---------------- Discord pickers ---------------- */

export function ChannelSelect({
  value, onChange, channels, placeholder = "— not set —",
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  channels: BotChannel[];
  placeholder?: string;
}) {
  const text = channels.filter((c) => c.type === 0 || c.type === 5);
  const voice = channels.filter((c) => c.type !== 0 && c.type !== 5);
  // A channel that no longer exists stays visible (an explicit option) so the
  // old state doesn't "silently disappear" (same policy as MentionSelect).
  const ghost = value && !channels.some((c) => c.id === value);
  const opts: Array<{ value: string; label: string; disabled?: boolean }> = [
    { value: "", label: placeholder },
    ...(ghost && value ? [{ value, label: `Deleted channel (#${value.slice(0, 8)}…)` }] : []),
    ...text.map((c) => ({ value: c.id, label: `# ${c.name}` })),
    ...(voice.length ? [{ value: "__voice__", label: "— Voice —", disabled: true }] : []),
  ];
  return (
    <Select
      value={value ?? ""}
      onChange={(v) => {
        if (v === "__voice__") return; // group separator must never become a value
        onChange(v || null);
      }}
      options={opts}
    />
  );
}

export function RoleSelect({
  value, onChange, roles, placeholder = "— not set —",
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  roles: BotRole[];
  placeholder?: string;
}) {
  // A role that no longer exists stays visible (an explicit option) so the
  // old state doesn't "silently disappear" (same policy as MentionSelect).
  const ghost = value && !roles.some((r) => r.id === value);
  return (
    <Select
      value={value ?? ""}
      onChange={(v) => onChange(v || null)}
      options={[
        { value: "", label: placeholder },
        ...(ghost && value ? [{ value, label: `Deleted role (${value.slice(0, 8)}…)` }] : []),
        ...roles.map((r) => ({ value: r.id, label: r.name })),
      ]}
    />
  );
}

/**
 * v3.24.0: MentionSelect — pick a mention from a dropdown, no role ID typing.
 * The value is a ready-to-use mention string: "" | "@everyone" | "@here" | "<@&roleId>".
 * Used by Announce & the Embed Builder (parity with the role-picker-based
 * mention option of /announce, /send-message, /announce-schedule on Discord).
 */
export function MentionSelect({
  value, onChange, roles,
}: {
  value: string;
  onChange: (v: string) => void;
  roles: BotRole[];
}) {
  const isPlain = value === "" || value === "@everyone" || value === "@here";
  const selectedRoleId = value.startsWith("<@&") ? value.slice(3, -1) : "";
  // A role that no longer exists stays visible (an explicit option) so the
  // old state doesn't "silently disappear".
  const ghost = selectedRoleId && !roles.some((r) => r.id === selectedRoleId);
  return (
    <Select
      value={ghost ? "__ghost__" : isPlain ? value : selectedRoleId}
      onChange={(v) => {
        if (v === "__ghost__") return;
        onChange(v === "" ? "" : v === "@everyone" ? "@everyone" : v === "@here" ? "@here" : `<@&${v}>`);
      }}
      options={[
        { value: "", label: "No mention" },
        { value: "@everyone", label: "@everyone (all members)" },
        { value: "@here", label: "@here (online members)" },
        ...(ghost ? [{ value: "__ghost__", label: `Deleted role (${selectedRoleId})` }] : []),
        ...roles.map((r) => ({ value: r.id, label: `@${r.name}` })),
      ]}
    />
  );
}

/* ---------------- Color utility ---------------- */

export function ColorInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const hex = `#${value.toString(16).padStart(6, "0")}`;
  // v3.28.3: local string state — the text field is typable (intermediate
  // values like "f0" or "" no longer snap back). It commits on Enter/blur and
  // resyncs whenever the numeric value changes elsewhere (the color swatch),
  // using the React-recommended "adjust state during render" pattern (no
  // setState-in-effect cascading renders).
  const [text, setText] = useState(hex);
  const [focused, setFocused] = useState(false);
  const [renderedHex, setRenderedHex] = useState(hex);
  if (hex !== renderedHex) {
    setRenderedHex(hex);
    if (!focused) setText(hex);
  }
  const commit = () => {
    const v = text.replace("#", "").trim();
    if (/^[0-9a-fA-F]{6}$/.test(v)) onChange(parseInt(v, 16));
    else setText(hex); // invalid → snap back to the current value
  };
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(parseInt(e.target.value.slice(1), 16))}
        className="h-10 w-12 cursor-pointer rounded-lg border border-white/[0.08] bg-dbg-0 p-1"
        aria-label="Pick a color"
      />
      <input
        value={focused ? text : hex}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => {
          setFocused(true);
          setText(hex);
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`${inputCls} font-mono text-xs`}
      />
    </div>
  );
}

/* ---------------- Small chips ---------------- */

export function Pill({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "amber" | "green" | "red" }) {
  const tones = {
    zinc: "border-white/[0.08] bg-dbg-3/60 text-dtx-3",
    amber: "border-dyellow/30 bg-dyellow/10 text-dyellow",
    green: "border-dgreen/40 bg-dgreen/10 text-dgreen",
    red: "border-dred/40 bg-dred/10 text-dred",
  } as const;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Channel name from meta by id (short fallback). */
export function channelLabel(channels: BotChannel[], id: string | null): string {
  if (!id) return "—";
  const c = channels.find((x) => x.id === id);
  return c ? `#${c.name}` : `#${id.slice(0, 8)}…`;
}

/** Role name from meta by id. */
export function roleLabel(roles: BotRole[], id: string | null): string {
  if (!id) return "—";
  const r = roles.find((x) => x.id === id);
  return r ? r.name : `role ${id.slice(0, 8)}…`;
}
