"use client";

// v3.31.0 — Access Control, redesigned as the simple table the admin asked
// for: every grant (role OR user) is ONE row with a tier switch and a remove
// button; adding is one line (role picker / Discord User ID + tier).
//
// ONE source of truth (unchanged since v3.30.0): config.access in the bot's
// database (the same file /set-role staff and the slash-command router
// read). Saving here writes access.adminRoleIds / staffRoleIds /
// adminUserIds / staffUserIds via the standard SaveBar (PUT config) — the
// bot invalidates its tier cache on write, so grants apply INSTANTLY
// (no restart, no re-login).
//
// Resolution ladder (shown to the admin as a legend, enforced by the bot):
//   3 Super Admin / Owner — Discord Administrator / ManageGuild / owner, the
//     legacy /set-role admin role, access.adminRoleIds, access.adminUserIds
//   2 Moderator / Staff   — access.staffRoleIds, access.staffUserIds, or any
//     Discord moderation bit (ModerateMembers/Ban/Kick/ManageMessages)
//   1 Member              — everyone else: public commands + their own
//     dashboard profile (stats/level/warns)

import { useState } from "react";
import { Info, Plus, ShieldCheck, ShieldHalf, Trash2, User, Wrench } from "lucide-react";
import { RoleSelect, TextInput } from "../fields";
import type { ModuleFormProps } from "./module-forms";

const ID_RE = /^\d{5,25}$/;
const MAX_LIST = 20;

/** One row of the access table — a role or user granted tier 3 or 2. */
type GrantRow = {
  id: string;
  kind: "role" | "user";
  tier: 3 | 2;
};

export function AccessControlModule({ draft, meta, setConfig, toast }: ModuleFormProps) {
  const access = draft.config.access ?? {};
  const adminRoleIds = access.adminRoleIds ?? [];
  const staffRoleIds = access.staffRoleIds ?? [];
  const adminUserIds = access.adminUserIds ?? [];
  const staffUserIds = access.staffUserIds ?? [];

  const legacyAdminRoleId = draft.config.roles?.admin ?? null;

  // ---- Add-row local state ----
  const [addKind, setAddKind] = useState<"role" | "user">("role");
  const [addRole, setAddRole] = useState<string | null>(null);
  const [addUserId, setAddUserId] = useState("");
  const [addTier, setAddTier] = useState<"3" | "2">("2");

  // The unified grant table (roles first, then users; admin tier first).
  const rows: GrantRow[] = [
    ...adminRoleIds.map((id): GrantRow => ({ id, kind: "role", tier: 3 })),
    ...staffRoleIds.map((id): GrantRow => ({ id, kind: "role", tier: 2 })),
    ...adminUserIds.map((id): GrantRow => ({ id, kind: "user", tier: 3 })),
    ...staffUserIds.map((id): GrantRow => ({ id, kind: "user", tier: 2 })),
  ];

  function roleName(id: string): string | null {
    const role = meta.roles.find((r) => r.id === id);
    return role ? role.name : null;
  }

  /** Write the four lists in one go (two dotPaths at most change). */
  function writeLists(next: { adminRoleIds?: string[]; staffRoleIds?: string[]; adminUserIds?: string[]; staffUserIds?: string[] }) {
    const merged = {
      adminRoleIds: next.adminRoleIds ?? adminRoleIds,
      staffRoleIds: next.staffRoleIds ?? staffRoleIds,
      adminUserIds: next.adminUserIds ?? adminUserIds,
      staffUserIds: next.staffUserIds ?? staffUserIds,
    };
    const total = merged.adminRoleIds.length + merged.staffRoleIds.length + merged.adminUserIds.length + merged.staffUserIds.length;
    if (total > MAX_LIST * 2) {
      toast(`That is too many grants — keep the lists under ${MAX_LIST * 2} entries total.`, "err");
      return;
    }
    setConfig("access.adminRoleIds", merged.adminRoleIds);
    setConfig("access.staffRoleIds", merged.staffRoleIds);
    setConfig("access.adminUserIds", merged.adminUserIds);
    setConfig("access.staffUserIds", merged.staffUserIds);
  }

  /** Remove one grant row. */
  function removeGrant(row: GrantRow) {
    writeLists({
      adminRoleIds: row.kind === "role" && row.tier === 3 ? adminRoleIds.filter((x) => x !== row.id) : adminRoleIds,
      staffRoleIds: row.kind === "role" && row.tier === 2 ? staffRoleIds.filter((x) => x !== row.id) : staffRoleIds,
      adminUserIds: row.kind === "user" && row.tier === 3 ? adminUserIds.filter((x) => x !== row.id) : adminUserIds,
      staffUserIds: row.kind === "user" && row.tier === 2 ? staffUserIds.filter((x) => x !== row.id) : staffUserIds,
    });
  }

  /** Flip one grant's tier (admin <-> staff): remove from one list, add to the other. */
  function flipTier(row: GrantRow, to: 3 | 2) {
    if (row.tier === to) return;
    if (row.kind === "role") {
      writeLists({
        adminRoleIds: to === 3 ? [...adminRoleIds.filter((x) => x !== row.id), row.id] : adminRoleIds.filter((x) => x !== row.id),
        staffRoleIds: to === 2 ? [...staffRoleIds.filter((x) => x !== row.id), row.id] : staffRoleIds.filter((x) => x !== row.id),
      });
    } else {
      writeLists({
        adminUserIds: to === 3 ? [...adminUserIds.filter((x) => x !== row.id), row.id] : adminUserIds.filter((x) => x !== row.id),
        staffUserIds: to === 2 ? [...staffUserIds.filter((x) => x !== row.id), row.id] : staffUserIds.filter((x) => x !== row.id),
      });
    }
  }

  function addGrant() {
    const tier = addTier === "3" ? 3 : 2;
    if (addKind === "role") {
      if (!addRole) {
        toast("Pick a role first (or switch to “User ID”).", "err");
        return;
      }
      if (adminRoleIds.includes(addRole) || staffRoleIds.includes(addRole)) {
        toast("That role is already in the table.", "err");
        return;
      }
      writeLists(tier === 3 ? { adminRoleIds: [...adminRoleIds, addRole] } : { staffRoleIds: [...staffRoleIds, addRole] });
      setAddRole(null);
      return;
    }
    const id = addUserId.trim();
    if (!ID_RE.test(id)) {
      toast("Enter a Discord User ID (17-20 digits — Developer Mode → Copy User ID).", "err");
      return;
    }
    if (adminUserIds.includes(id) || staffUserIds.includes(id)) {
      toast("That user is already in the table.", "err");
      return;
    }
    writeLists(tier === 3 ? { adminUserIds: [...adminUserIds, id] } : { staffUserIds: [...staffUserIds, id] });
    setAddUserId("");
  }

  return (
    <div className="space-y-5">
      {/* ---- Tier legend (what each level can do) ---- */}
      <section className="rounded-xl border border-white/[0.06] bg-dbg-1 p-5 md:p-6">
        <h3 className="text-sm font-semibold text-dtx-0">The three access levels</h3>
        <p className="mt-1 text-xs leading-relaxed text-dtx-3">
          One resolver for Discord commands AND this dashboard — Discord permissions always apply on top.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-blurple/30 bg-blurple/[0.06] p-3.5">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-blurple-soft">
              <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" /> Super Admin / Owner
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-dtx-2">
              Everything, everywhere. Automatic for Discord Administrator / Manage&nbsp;Server / owners —
              plus the roles &amp; users in the table below.
            </p>
          </div>
          <div className="rounded-xl border border-sky-400/25 bg-sky-400/[0.05] p-3.5">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-sky-200">
              <ShieldHalf className="h-4 w-4 shrink-0" aria-hidden="true" /> Moderator / Staff
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-dtx-2">
              Daily moderation on Discord AND the web: <code>/timeout</code> <code>/kick</code> <code>/ban</code>{" "}
              <code>/unban</code> <code>/purge</code> <code>/warn</code>, ticket close, and the dashboard
              Moderation module.
            </p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-dbg-0/60 p-3.5">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-dtx-1">
              <User className="h-4 w-4 shrink-0" aria-hidden="true" /> Member
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-dtx-2">
              Public commands only. On the dashboard: their own profile — stats, level &amp; rank, warnings,
              moderation history. Read-only.
            </p>
          </div>
        </div>
        {legacyAdminRoleId ? (
          <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-dtx-3">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-dtx-3" aria-hidden="true" />
            <span>
              Legacy admin role from <code className="rounded bg-dbg-3 px-1 py-0.5 text-[10px] text-blurple-soft">/set-role admin</code>{" "}
              is still honored:{" "}
              <span className="rounded border border-white/[0.08] bg-dbg-0 px-1.5 py-0.5 text-dtx-1">
                @{roleName(legacyAdminRoleId) ?? legacyAdminRoleId}
              </span>
            </span>
          </p>
        ) : null}
      </section>

      {/* ---- The access table ---- */}
      <section className="rounded-xl border border-white/[0.06] bg-dbg-1 p-5 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-dtx-0">Who can access this dashboard</h3>
            <p className="mt-1 text-xs leading-relaxed text-dtx-3">
              Switch a row between <span className="font-medium text-blurple-soft">Admin</span> and{" "}
              <span className="font-medium text-sky-300">Staff</span>, or remove it entirely.
            </p>
          </div>
          <span className="rounded-full border border-white/[0.08] bg-dbg-0 px-2.5 py-1 text-[11px] font-medium tabular-nums text-dtx-3">
            {rows.length} grant{rows.length === 1 ? "" : "s"}
          </span>
        </div>

        {/* Rows — flex-wrap keeps every control reachable on phones too
            (the remove button is NEVER hidden on mobile). */}
        <div className="mt-2 space-y-1.5">
          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-white/[0.1] px-4 py-6 text-center text-xs leading-relaxed text-dtx-3">
              No extra grants yet — only Discord Administrator / Manage Server / owners can manage this server.
              Add a staff role below to give moderators daily-moderation access.
            </p>
          ) : null}
          {rows.map((row) => {
            const name = row.kind === "role" ? roleName(row.id) : null;
            return (
              <div
                key={`${row.kind}-${row.id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-white/[0.06] bg-dbg-0/50 px-3 py-2.5"
              >
                {/* Who */}
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${row.kind === "role" ? "bg-blurple/15 text-blurple-soft" : "bg-dbg-3 text-dtx-2"}`} title={row.kind === "role" ? "Role grant" : "User grant"}>
                    {row.kind === "role" ? <Wrench className="h-4 w-4" aria-hidden="true" /> : <User className="h-4 w-4" aria-hidden="true" />}
                  </span>
                  <div className="min-w-0 leading-tight" title={row.id}>
                    <p className={`truncate text-[13px] font-medium ${name ? "text-dtx-1" : "text-dtx-3"}`}>
                      {name ? `@${name}` : row.kind === "user" ? `User ${row.id}` : `Deleted role (${row.id.slice(0, 8)}…)`}
                    </p>
                    <p className="truncate text-[10px] text-dtx-4">
                      {row.kind === "role" ? `Role · ID ${row.id}` : `User · ID ${row.id}`}
                    </p>
                  </div>
                </div>

                {/* Tier switch (Admin <-> Staff) + remove */}
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center gap-1 rounded-lg bg-dbg-0 p-1">
                    <button
                      type="button"
                      onClick={() => flipTier(row, 3)}
                      aria-pressed={row.tier === 3}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                        row.tier === 3 ? "bg-blurple text-white" : "text-dtx-3 hover:text-dtx-1"
                      }`}
                    >
                      Admin
                    </button>
                    <button
                      type="button"
                      onClick={() => flipTier(row, 2)}
                      aria-pressed={row.tier === 2}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                        row.tier === 2 ? "bg-sky-500 text-white" : "text-dtx-3 hover:text-dtx-1"
                      }`}
                    >
                      Staff
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeGrant(row)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-dtx-3 transition-colors hover:bg-dred/15 hover:text-dred"
                    title="Remove this grant"
                    aria-label={`Remove ${name ?? row.id}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* ---- Add a grant ---- */}
        <div className="mt-4 rounded-xl border border-white/[0.06] bg-dbg-0/50 p-4">
          <p className="text-[13px] font-semibold text-dtx-1">Add access</p>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_130px_auto]">
            <div className="space-y-2">
              {/* Role / User switch */}
              <div className="flex items-center gap-1 rounded-lg bg-dbg-1 p-1 md:w-fit">
                {(["role", "user"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setAddKind(k)}
                    aria-pressed={addKind === k}
                    className={`rounded-md px-3 py-1 text-[11px] font-semibold transition-colors ${
                      addKind === k ? "bg-blurple text-white" : "text-dtx-3 hover:text-dtx-1"
                    }`}
                  >
                    {k === "role" ? "By role" : "By User ID"}
                  </button>
                ))}
              </div>
              {addKind === "role" ? (
                <RoleSelect value={addRole} onChange={setAddRole} roles={meta.roles} placeholder="— pick a role —" />
              ) : (
                <TextInput
                  value={addUserId}
                  onChange={setAddUserId}
                  placeholder="User ID (e.g. 123456789012345678)"
                  invalid={addUserId.trim().length > 0 && !ID_RE.test(addUserId.trim())}
                />
              )}
            </div>
            {/* Tier for the new grant */}
            <div className="flex items-center gap-1 self-end rounded-lg bg-dbg-1 p-1">
              {([
                { v: "3", label: "Admin" },
                { v: "2", label: "Staff" },
              ] as const).map((t) => (
                <button
                  key={t.v}
                  type="button"
                  onClick={() => setAddTier(t.v)}
                  aria-pressed={addTier === t.v}
                  className={`flex-1 rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                    addTier === t.v
                      ? t.v === "3" ? "bg-blurple text-white" : "bg-sky-500 text-white"
                      : "text-dtx-3 hover:text-dtx-1"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={addGrant}
              disabled={addKind === "role" ? !addRole : !addUserId.trim()}
              className="flex h-10 items-center justify-center gap-1.5 self-end rounded-lg bg-dgreen px-4 text-[13px] font-semibold text-white transition-colors hover:bg-dgreen-dark disabled:opacity-40"
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Add
            </button>
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-dtx-4">
            Role grant: everyone holding the role · User ID grant: that one person (Developer Mode →
            right-click → Copy User ID).
          </p>
        </div>
      </section>

      <p className="text-[11px] leading-relaxed text-dtx-3">
        Changes are part of the dashboard draft — press <span className="text-dtx-1">Save Changes</span> to write them
        to the bot&apos;s database. The bot applies them immediately (its permission cache is invalidated on write);
        staff will see their new access on their next dashboard request or command, without a restart.
      </p>
    </div>
  );
}
