"use client";

// v3.30.0 RBAC — the Access Control module (Server group, tier 3 only).
//
// ONE source of truth: config.access in the bot's database (the same file
// /set-role staff and the slash-command router read). Saving here writes
// access.adminRoleIds / staffRoleIds / adminUserIds / staffUserIds via the
// standard SaveBar (PUT config) — the bot invalidates its tier cache on
// write, so grants apply INSTANTLY (no restart, no re-login).
//
// Resolution ladder (shown to the admin as a legend, enforced by the bot):
//   3 Super Admin / Owner — Discord Administrator / ManageGuild / owner, the
//     legacy /set-role admin role, access.adminRoleIds, access.adminUserIds
//   2 Moderator / Staff   — access.staffRoleIds, access.staffUserIds, or any
//     Discord moderation bit (ModerateMembers/Ban/Kick/ManageMessages)
//   1 Member              — everyone else: public commands + their own
//     dashboard profile (stats/level/warns)

import { useState } from "react";
import { Plus, ShieldCheck, ShieldHalf, User, X, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Section, RoleSelect, TextInput } from "../fields";
import type { ModuleFormProps } from "./module-forms";

const ID_RE = /^\d{5,25}$/;
const MAX_LIST = 20;

function roleName(meta: ModuleFormProps["meta"], id: string): string | null {
  const role = meta.roles.find((r) => r.id === id);
  return role ? role.name : null;
}

/** A removable chip list — the shared shape for all four access lists. */
function IdChips({
  ids, meta, onRemove, emptyLabel,
}: {
  ids: string[];
  meta: ModuleFormProps["meta"];
  onRemove: (id: string) => void;
  emptyLabel: string;
}) {
  if (ids.length === 0) {
    return <p className="text-xs leading-relaxed text-zinc-500">{emptyLabel}</p>;
  }
  return (
    <ul className="col-span-full flex flex-wrap gap-2">
      {ids.map((id) => {
        const name = roleName(meta, id);
        return (
          <li
            key={id}
            className={`group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
              name
                ? "border-zinc-700 bg-zinc-900/60 text-zinc-200"
                : "border-red-500/40 bg-red-950/20 text-red-200"
            }`}
            title={id}
          >
            {name ? `@${name}` : `Deleted role (${id.slice(0, 8)}…)`}
            <button
              type="button"
              onClick={() => onRemove(id)}
              className="rounded p-0.5 text-zinc-500 transition-colors hover:text-red-300"
              aria-label={`Remove ${name ?? id}`}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function AccessControlModule({ draft, meta, setConfig, toast }: ModuleFormProps) {
  const access = draft.config.access ?? {};
  const adminRoleIds = access.adminRoleIds ?? [];
  const staffRoleIds = access.staffRoleIds ?? [];
  const adminUserIds = access.adminUserIds ?? [];
  const staffUserIds = access.staffUserIds ?? [];

  // Local pickers/inputs (cleared after each Add).
  const [addAdminRole, setAddAdminRole] = useState<string | null>(null);
  const [addStaffRole, setAddStaffRole] = useState<string | null>(null);
  const [addAdminUser, setAddAdminUser] = useState("");
  const [addStaffUser, setAddStaffUser] = useState("");

  const legacyAdminRoleId = draft.config.roles?.admin ?? null;

  function setList(key: "adminRoleIds" | "staffRoleIds" | "adminUserIds" | "staffUserIds", next: string[]) {
    if (next.length > MAX_LIST) {
      toast(`Access lists accept at most ${MAX_LIST} entries.`, "err");
      return;
    }
    setConfig(`access.${key}`, next);
  }

  function addToList(key: "adminRoleIds" | "staffRoleIds" | "adminUserIds" | "staffUserIds", id: string): boolean {
    const current = (draft.config.access ?? {})[key] ?? [];
    if (current.includes(id)) {
      toast("That entry is already in the list.", "err");
      return false;
    }
    setList(key, [...current, id]);
    return true;
  }

  function removeFromList(key: "adminRoleIds" | "staffRoleIds" | "adminUserIds" | "staffUserIds", id: string) {
    const current = (draft.config.access ?? {})[key] ?? [];
    setList(key, current.filter((x) => x !== id));
  }

  function addUser(key: "adminUserIds" | "staffUserIds", raw: string, clear: () => void) {
    const id = raw.trim();
    if (!ID_RE.test(id)) {
      toast("Enter a Discord User ID (17-20 digits — Developer Mode → Copy User ID).", "err");
      return;
    }
    if (addToList(key, id)) clear();
  }

  return (
    <div className="space-y-5">
      {/* ---- Tier legend ---- */}
      <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-zinc-100">How access is resolved</h3>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          The bot and this dashboard share ONE resolver — Discord always wins for what Discord owns.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-3.5">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-200">
              <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" /> 3 · Super Admin / Owner
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400">
              Full access everywhere. Granted automatically by Discord Administrator / Manage&nbsp;Server / ownership —
              plus the roles &amp; users on the lists below.
            </p>
          </div>
          <div className="rounded-xl border border-sky-400/25 bg-sky-400/5 p-3.5">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-sky-200">
              <ShieldHalf className="h-4 w-4 shrink-0" aria-hidden="true" /> 2 · Moderator / Staff
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400">
              Daily moderation on Discord AND the web: <code>/timeout</code> <code>/kick</code> <code>/ban</code>{" "}
              <code>/unban</code> <code>/purge</code> <code>/warn</code>, ticket close, and the dashboard Moderation
              module. Also granted by Discord moderation permissions.
            </p>
          </div>
          <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/60 p-3.5">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-zinc-200">
              <User className="h-4 w-4 shrink-0" aria-hidden="true" /> 1 · Member
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400">
              Public commands only. On the dashboard they see their own profile — stats, level &amp; rank, warnings,
              moderation history. Read-only.
            </p>
          </div>
        </div>
        {legacyAdminRoleId ? (
          <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-zinc-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
            <span>
              Legacy admin role from <code className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-amber-200">/set-role admin</code>{" "}
              is still honored:{" "}
              <span className="rounded border border-zinc-700 bg-zinc-900/60 px-1.5 py-0.5 text-zinc-300">
                @{roleName(meta, legacyAdminRoleId) ?? legacyAdminRoleId}
              </span>
            </span>
          </p>
        ) : null}
      </section>

      {/* ---- Admin roles ---- */}
      <Section
        title="Admin roles (tier 3)"
        desc="Members holding one of these roles get FULL access — every command and every dashboard module. Discord Administrator / Manage Server always applies on top."
      >
        <Field label="Add an admin role" hint="Granted instantly on save — no restart, no re-login.">
          <RoleSelect value={addAdminRole} onChange={setAddAdminRole} roles={meta.roles} placeholder="— pick a role —" />
        </Field>
        <div className="flex items-end">
          <Button
            variant="outline"
            size="sm"
            disabled={!addAdminRole}
            onClick={() => {
              if (addAdminRole && addToList("adminRoleIds", addAdminRole)) setAddAdminRole(null);
            }}
            className="border-zinc-700 bg-transparent hover:bg-zinc-800"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Add role
          </Button>
        </div>
        <IdChips
          ids={adminRoleIds}
          meta={meta}
          onRemove={(id) => removeFromList("adminRoleIds", id)}
          emptyLabel="No extra admin roles — only Discord Administrator / Manage Server / owner can manage this server."
        />
      </Section>

      {/* ---- Staff roles ---- */}
      <Section
        title="Staff / Moderator roles (tier 2)"
        desc="Members holding one of these roles get daily-moderation access: /timeout /untimeout /kick /ban /unban /purge /warn, closing tickets, and the dashboard's Moderation module."
      >
        <Field label="Add a staff role" hint="Quick path on Discord: /set-role staff @role (sets the list to that single role).">
          <RoleSelect value={addStaffRole} onChange={setAddStaffRole} roles={meta.roles} placeholder="— pick a role —" />
        </Field>
        <div className="flex items-end">
          <Button
            variant="outline"
            size="sm"
            disabled={!addStaffRole}
            onClick={() => {
              if (addStaffRole && addToList("staffRoleIds", addStaffRole)) setAddStaffRole(null);
            }}
            className="border-zinc-700 bg-transparent hover:bg-zinc-800"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Add role
          </Button>
        </div>
        <IdChips
          ids={staffRoleIds}
          meta={meta}
          onRemove={(id) => removeFromList("staffRoleIds", id)}
          emptyLabel="No staff roles yet — moderation still works for anyone with Discord moderation permissions."
        />
      </Section>

      {/* ---- Users by ID ---- */}
      <Section
        title="Per-user access"
        desc="Grant a tier to a specific user ID — useful for staff without a dedicated role, or owners of partner servers. Developer Mode → right-click a user → Copy User ID."
      >
        <Field label="Add an admin user (tier 3)">
          <div className="flex gap-2">
            <TextInput
              value={addAdminUser}
              onChange={setAddAdminUser}
              placeholder="User ID (e.g. 123456789012345678)"
              invalid={addAdminUser.trim().length > 0 && !ID_RE.test(addAdminUser.trim())}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!addAdminUser.trim()}
              onClick={() => addUser("adminUserIds", addAdminUser, () => setAddAdminUser(""))}
              className="h-10 shrink-0 border-zinc-700 bg-transparent hover:bg-zinc-800"
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Add
            </Button>
          </div>
        </Field>
        <Field label="Add a staff user (tier 2)">
          <div className="flex gap-2">
            <TextInput
              value={addStaffUser}
              onChange={setAddStaffUser}
              placeholder="User ID (e.g. 123456789012345678)"
              invalid={addStaffUser.trim().length > 0 && !ID_RE.test(addStaffUser.trim())}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!addStaffUser.trim()}
              onClick={() => addUser("staffUserIds", addStaffUser, () => setAddStaffUser(""))}
              className="h-10 shrink-0 border-zinc-700 bg-transparent hover:bg-zinc-800"
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Add
            </Button>
          </div>
        </Field>
        <Field label={`Admin users (${adminUserIds.length})`}>
          <IdChips
            ids={adminUserIds}
            meta={meta}
            onRemove={(id) => removeFromList("adminUserIds", id)}
            emptyLabel="No per-user admins."
          />
        </Field>
        <Field label={`Staff users (${staffUserIds.length})`}>
          <IdChips
            ids={staffUserIds}
            meta={meta}
            onRemove={(id) => removeFromList("staffUserIds", id)}
            emptyLabel="No per-user staff."
          />
        </Field>
      </Section>

      <p className="text-[11px] leading-relaxed text-zinc-500">
        Changes are part of the dashboard draft — press <span className="text-zinc-300">Save Changes</span> to write them
        to the bot&apos;s database. The bot applies them immediately (its permission cache is invalidated on write);
        staff will see their new access on their next dashboard request or command, without a restart.
      </p>
    </div>
  );
}
