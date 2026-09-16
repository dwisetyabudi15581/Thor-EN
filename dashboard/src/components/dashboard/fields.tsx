"use client";

// Reusable form controls for the dashboard modules (Dyno-style).
// All fields are dark-editorial (zinc + amber accent) and are reused by
// module-forms.tsx so the 12 modules never build UI from scratch.

import type { ReactNode } from "react";
import type { BotChannel, BotRole } from "@/lib/bot-api";

/* ---------------- Shells ---------------- */

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-zinc-300">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11px] leading-relaxed text-zinc-500">{hint}</p> : null}
    </div>
  );
}

export function Section({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
      <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
      {desc ? <p className="mt-1 text-xs leading-relaxed text-zinc-500">{desc}</p> : null}
      <div className="mt-5 grid gap-5 md:grid-cols-2">{children}</div>
    </section>
  );
}

/* ---------------- Basic inputs ---------------- */

const inputCls =
  "w-full h-10 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-amber-400/50 disabled:opacity-50";

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
      className={`${inputCls} ${invalid ? "border-red-500/60" : ""}`}
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
      className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-amber-400/50 resize-y"
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
      className="flex w-full items-center justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3.5 py-3 text-left transition-colors hover:border-zinc-700"
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-zinc-200">{label}</span>
        {desc ? <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">{desc}</span> : null}
      </span>
      <span
        className={`relative inline-flex h-5.5 w-10 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-amber-400" : "bg-zinc-700"
        }`}
        style={{ height: 22 }}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-zinc-950 transition-transform ${checked ? "translate-x-[22px]" : "translate-x-[3px]"}`}
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
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  id?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputCls} appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23a1a1aa%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.75rem_center] bg-no-repeat pr-9`}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
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
  const opts = [
    { value: "", label: placeholder },
    ...text.map((c) => ({ value: c.id, label: `# ${c.name}` })),
    ...(voice.length ? [{ value: "__voice__", label: "— Voice —", disabled: true as const }] : []),
  ];
  return (
    <Select
      value={value ?? ""}
      onChange={(v) => onChange(v || null)}
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
  return (
    <Select
      value={value ?? ""}
      onChange={(v) => onChange(v || null)}
      options={[
        { value: "", label: placeholder },
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
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(parseInt(e.target.value.slice(1), 16))}
        className="h-10 w-12 cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950/60 p-1"
        aria-label="Pick a color"
      />
      <input
        value={hex}
        onChange={(e) => {
          const v = e.target.value.replace("#", "");
          if (/^[0-9a-fA-F]{6}$/.test(v)) onChange(parseInt(v, 16));
        }}
        className={`${inputCls} font-mono text-xs`}
      />
    </div>
  );
}

/* ---------------- Small chips ---------------- */

export function Pill({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "amber" | "green" | "red" }) {
  const tones = {
    zinc: "border-zinc-700/60 bg-zinc-800/40 text-zinc-400",
    amber: "border-amber-400/30 bg-amber-400/10 text-amber-300",
    green: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    red: "border-red-400/30 bg-red-400/10 text-red-300",
  } as const;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${tones[tone]}`}>
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
