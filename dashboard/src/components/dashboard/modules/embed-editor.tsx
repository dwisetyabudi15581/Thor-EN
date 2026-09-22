"use client";

// Embed Editor + Live Preview (v3.20.0) — shared by the Send Embed module
// and the Custom Command module.
//
// Full parity with /embed-builder on Discord: text outside the embed
// (content), author (name + icon), title, description, color, fields
// (inline/full + reorderable), thumbnail, image, footer (text + icon), and
// timestamp. The preview mimics Discord's chat (dark) so admins know
// exactly what will be sent before sending it.

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Section, TextInput, TextArea, ColorInput, Toggle } from "../fields";
import type { EmbedDef } from "@/lib/bot-api";

/* ============================================================
 * Draft shape (form state) + conversions
 * ============================================================ */

export type EmbedFieldDraft = { name: string; value: string; inline: boolean };

export type EmbedDraft = {
  content: string; // plain text outside the embed
  title: string;
  description: string;
  color: number;
  authorName: string;
  authorIconURL: string;
  thumbnail: string;
  image: string;
  footerText: string;
  footerIconURL: string;
  timestamp: boolean;
  fields: EmbedFieldDraft[];
};

export const EMPTY_EMBED: EmbedDraft = {
  content: "",
  title: "",
  description: "",
  color: 0x5865f2,
  authorName: "",
  authorIconURL: "",
  thumbnail: "",
  image: "",
  footerText: "",
  footerIconURL: "",
  timestamp: false,
  fields: [],
};

/** From a bot def (payload / stored custom command) -> form draft. */
export function embedDraftFromDef(def?: Partial<EmbedDef> | null): EmbedDraft {
  if (!def) return { ...EMPTY_EMBED, fields: [] };
  return {
    content: "",
    title: def.title ?? "",
    description: def.description ?? "",
    color: typeof def.color === "number" ? def.color : 0x5865f2,
    authorName: def.authorName ?? "",
    authorIconURL: def.authorIconURL ?? "",
    thumbnail: def.thumbnail ?? "",
    image: def.image ?? "",
    footerText: def.footerText ?? "",
    footerIconURL: def.footerIconURL ?? "",
    timestamp: def.timestamp === true,
    fields: (def.fields ?? []).map((f) => ({ name: f.name, value: f.value, inline: f.inline === true })),
  };
}

/** Draft form -> API body (empty embed dropped so bot validation passes). */
export function embedDraftToApi(d: EmbedDraft): { content: string; embed: Partial<EmbedDef> } {
  return {
    content: d.content.trim(),
    embed: {
      title: d.title.trim(),
      description: d.description.trim(),
      color: d.color,
      authorName: d.authorName.trim(),
      authorIconURL: d.authorIconURL.trim(),
      thumbnail: d.thumbnail.trim(),
      image: d.image.trim(),
      footerText: d.footerText.trim(),
      footerIconURL: d.footerIconURL.trim(),
      timestamp: d.timestamp,
      fields: d.fields
        .filter((f) => f.name.trim() || f.value.trim())
        .map((f) => ({ name: f.name.trim(), value: f.value.trim(), inline: f.inline })),
    },
  };
}

/** Is the EMBED part completely empty (content not counted)? */
export function isEmbedDraftEmpty(d: EmbedDraft): boolean {
  return (
    !d.title.trim() &&
    !d.description.trim() &&
    !d.authorName.trim() &&
    !d.footerText.trim() &&
    !d.thumbnail.trim() &&
    !d.image.trim() &&
    !d.fields.some((f) => f.name.trim() || f.value.trim())
  );
}

/* ============================================================
 * Editor
 * ============================================================ */

export function EmbedEditor({ value, onChange }: { value: EmbedDraft; onChange: (d: EmbedDraft) => void }) {
  const patch = (p: Partial<EmbedDraft>) => onChange({ ...value, ...p });

  function setField(i: number, p: Partial<EmbedFieldDraft>) {
    const fields = value.fields.map((f, idx) => (idx === i ? { ...f, ...p } : f));
    patch({ fields });
  }
  function moveField(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= value.fields.length) return;
    const fields = [...value.fields];
    [fields[i], fields[j]] = [fields[j], fields[i]];
    patch({ fields });
  }

  return (
    <div className="space-y-5">
      <Section
        title="Message"
        desc="Plain text outside the embed — great for pings (@everyone) or an intro line. One of (text or embed) must be filled."
      >
        <div className="md:col-span-2">
          <Field label="Text outside the embed (optional)" hint="Max 2000 characters. Supports **bold**, *italic*, and new lines.">
            <TextArea value={value.content} onChange={(v) => patch({ content: v })} rows={3} placeholder="e.g. @everyone check the announcement below!" />
          </Field>
        </div>
      </Section>

      <Section title="Embed — Top" desc="The author shows above the title; the thumbnail sits in the embed's top-right corner.">
        <Field label="Author Name (optional)" hint="Max 256.">
          <TextInput value={value.authorName} onChange={(v) => patch({ authorName: v })} placeholder="e.g. Thor Team" />
        </Field>
        <Field label="Author Icon (URL, optional)" hint="https://… (small image next to the name).">
          <TextInput value={value.authorIconURL} onChange={(v) => patch({ authorIconURL: v })} placeholder="https://cdn…/icon.png" />
        </Field>
        <Field label="Title" hint="Max 256. Optional when description is set.">
          <TextInput value={value.title} onChange={(v) => patch({ title: v })} placeholder="Embed title" />
        </Field>
        <Field label="Color" hint="The embed's left bar color in Discord.">
          <ColorInput value={value.color} onChange={(v) => patch({ color: v })} />
        </Field>
        <Field label="Thumbnail (URL, optional)" hint="Small image in the embed's top-right corner.">
          <TextInput value={value.thumbnail} onChange={(v) => patch({ thumbnail: v })} placeholder="https://…/small.png" />
        </Field>
        <Field label="Large Image (URL, optional)" hint="Shown below the embed body.">
          <TextInput value={value.image} onChange={(v) => patch({ image: v })} placeholder="https://…/banner.png" />
        </Field>
        <div className="md:col-span-2">
          <Field label="Body (description)" hint="Max 4096. Supports **bold**, *italic*, and new lines.">
            <TextArea value={value.description} onChange={(v) => patch({ description: v })} rows={5} placeholder="Write the message body here…" />
          </Field>
        </div>
      </Section>

      <Section
        title="Embed — Fields"
        desc="A field = a small box with a name + value inside the embed. 'Inline' shows 3 fields per row. Max 25 fields."
      >
        <div className="space-y-3 md:col-span-2">
          {value.fields.length === 0 ? (
            <p className="rounded-lg border border-dashed border-white/[0.06] px-4 py-3 text-xs text-dtx-3">
              No fields yet — body text above may be enough, or add fields for structured data (e.g. Price | Contact).
            </p>
          ) : null}
          {value.fields.map((f, i) => (
            <div key={i} className="rounded-xl border border-white/[0.06] bg-dbg-0/40 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-dtx-3">Field #{i + 1}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveField(i, -1)}
                    disabled={i === 0}
                    className="rounded-md p-1.5 text-dtx-3 hover:bg-dbg-3 hover:text-dtx-1 disabled:opacity-30"
                    title="Move up"
                    aria-label={`Move field ${i + 1} up`}
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveField(i, 1)}
                    disabled={i === value.fields.length - 1}
                    className="rounded-md p-1.5 text-dtx-3 hover:bg-dbg-3 hover:text-dtx-1 disabled:opacity-30"
                    title="Move down"
                    aria-label={`Move field ${i + 1} down`}
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setField(i, { inline: !f.inline })}
                    className={`rounded-md px-2 py-1 text-[10px] font-semibold ${
                      f.inline ? "bg-blurple/15 text-blurple-soft" : "bg-dbg-3 text-dtx-3"
                    }`}
                    title="Show inline (3 per row)"
                  >
                    {f.inline ? "INLINE" : "FULL"}
                  </button>
                  <button
                    type="button"
                    onClick={() => patch({ fields: value.fields.filter((_, idx) => idx !== i) })}
                    className="rounded-md p-1.5 text-dred hover:bg-dred/10 hover:text-dred"
                    title="Delete field"
                    aria-label={`Delete field ${i + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-3">
                <TextInput value={f.name} onChange={(v) => setField(i, { name: v })} placeholder="Field name (max 256)" />
                <div className="md:col-span-2">
                  <TextInput value={f.value} onChange={(v) => setField(i, { value: v })} placeholder="Field value (max 1024)" />
                </div>
              </div>
            </div>
          ))}
          <Button
            variant="outline"
            onClick={() => value.fields.length < 25 && patch({ fields: [...value.fields, { name: "", value: "", inline: false }] })}
            disabled={value.fields.length >= 25}
            className="w-full border-dashed border-white/[0.1] bg-transparent text-dtx-2 hover:bg-dbg-1 hover:text-dtx-0"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Add Field ({value.fields.length}/25)
          </Button>
        </div>
      </Section>

      <Section title="Embed — Bottom" desc="The footer sits at the base of the embed, next to the timestamp.">
        <Field label="Footer Text (optional)" hint="Max 2048.">
          <TextInput value={value.footerText} onChange={(v) => patch({ footerText: v })} placeholder="e.g. From the Admins • thor.bot" />
        </Field>
        <Field label="Footer Icon (URL, optional)">
          <TextInput value={value.footerIconURL} onChange={(v) => patch({ footerIconURL: v })} placeholder="https://…/icon.png" />
        </Field>
        <div className="md:col-span-2">
          <Toggle
            checked={value.timestamp}
            onChange={(v) => patch({ timestamp: v })}
            label="Show timestamp"
            desc="The send time appears in the embed footer (bot's local time)."
          />
        </div>
      </Section>
    </div>
  );
}

/* ============================================================
 * Live preview (mimics Discord chat)
 * ============================================================ */

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** "Today at 2.05 PM" Discord-style (static label — fine for a preview). */
function previewClock(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Today at ${pad(now.getHours())}.${pad(now.getMinutes())}`;
}

export function EmbedLivePreview({ draft, botName = "Thor" }: { draft: EmbedDraft; botName?: string }) {
  const hasEmbed = !isEmbedDraftEmpty(draft);
  return (
    <div className="rounded-xl bg-[#313338] p-4">
      <div className="flex gap-3">
        {/* Bot avatar */}
        <div className="flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-full bg-blurple text-sm font-black text-white">
          T
        </div>
        <div className="min-w-0 flex-1">
          {/* Name + BOT badge + time */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[15px] font-semibold leading-none text-white">{botName}</span>
            <span className="rounded bg-[#5865f2] px-1 py-px text-[9px] font-semibold uppercase leading-tight text-white">Bot</span>
            <span className="text-[11px] text-[#949ba4]">{previewClock()}</span>
          </div>

          {/* Text outside the embed */}
          {draft.content.trim() ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-[1.375rem] text-[#dbdee1]">{draft.content}</p>
          ) : null}

          {/* Embed */}
          {hasEmbed ? (
            <div
              className="mt-1 max-w-[520px] overflow-hidden rounded-[4px] bg-[#2b2d31] pl-4 pr-4 pt-3 pb-3"
              style={{ borderLeft: `4px solid ${hex(draft.color)}` }}
            >
              <div className="relative">
                {draft.thumbnail.trim() ? (
                  <img
                    src={draft.thumbnail}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="absolute right-0 top-0 h-20 w-20 rounded object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : null}

                {draft.authorName.trim() || draft.authorIconURL.trim() ? (
                  <div className="mb-2 flex items-center gap-2">
                    {draft.authorIconURL.trim() ? (
                      <img
                        src={draft.authorIconURL}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-6 w-6 rounded-full object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    ) : null}
                    {draft.authorName.trim() ? <span className="text-[14px] font-semibold text-white">{draft.authorName}</span> : null}
                  </div>
                ) : null}

                {draft.title.trim() ? <p className="text-[15px] font-semibold leading-snug text-[#00a8fc]">{draft.title}</p> : null}

                {draft.description.trim() ? (
                  <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-[#dbdee1]">{draft.description}</p>
                ) : null}

                {draft.fields.filter((f) => f.name.trim() || f.value.trim()).length > 0 ? (
                  <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-2">
                    {draft.fields
                      .filter((f) => f.name.trim() || f.value.trim())
                      .map((f, i) => (
                        <div key={i} className={f.inline ? "" : "col-span-3"}>
                          {f.name.trim() ? <p className="text-[13px] font-semibold text-white">{f.name}</p> : null}
                          {f.value.trim() ? <p className="text-[13px] leading-snug text-[#dbdee1]">{f.value}</p> : null}
                        </div>
                      ))}
                  </div>
                ) : null}

                {draft.image.trim() ? (
                  <img
                    src={draft.image}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="mt-3 max-h-72 w-auto max-w-full rounded object-contain"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : null}

                {draft.footerText.trim() || draft.timestamp ? (
                  <div className="mt-2 flex items-center gap-2">
                    {draft.footerIconURL.trim() ? (
                      <img
                        src={draft.footerIconURL}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-5 w-5 rounded-full object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    ) : null}
                    {draft.footerText.trim() ? <span className="text-[12px] font-medium text-[#949ba4]">{draft.footerText}</span> : null}
                    {draft.footerText.trim() && draft.timestamp ? <span className="text-[12px] text-[#949ba4]">•</span> : null}
                    {draft.timestamp ? <span className="text-[12px] text-[#949ba4]">{previewClock()}</span> : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {!draft.content.trim() && !hasEmbed ? (
            <p className="mt-1 text-[13px] italic text-[#949ba4]">(empty message — fill in text or the embed on the left)</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
