# Changelog

All notable changes to this project are documented in this file. Format based on [Keep a Changelog](https://keepachangelog.com/id/1.1.0/).

Legend: 🔴 critical · 🟠 high · 🟡 medium · 🟢 improvement

## [3.9.38] — 2026-09-04

### Fixed — 🛡️ Full audit v3: 34 bugs/issues fixed across every domain (escrow, tickets, data layer, automod, router)

A full audit of the entire codebase (~23,400 lines) uncovered 34 real issues — every one of them verified against code evidence before being fixed. Two of them directly affected the escrow money flow.

- 🔴 **Observer add/remove bypassed `transitionLocks`** — the 👥 Add Member / ➖ Remove Member handlers wrote a STALE deal snapshot to disk after awaiting permissions, so a validated transition (e.g. Funds Received) could be REVERTED: the deal rolled back a state, history was lost, and a DISPUTE could unfreeze without an admin resolving it. Now: the transition lock is acquired and the deal is RE-READ fresh after the await, before anything is written.
- 🔴 (follow-up) **Double-submit race in the deal form** — re-submitting the seller dropdown while a submission was still in flight created 2 deals + 2 channels for the same buyer/seller pair. Now: the pending session is deleted BEFORE the await + `hasActiveDealFor` is re-checked right before `setDeal`.
- 🟠 **Ticket self-healing deleted the meta of an ACTIVE ticket on transient errors** — `findActiveTicketFor` treated 429/5xx as "the channel is gone" → the meta was deleted → the user could open a second ticket + the invoice/isCompleted guards were lost. Now only error code 10003 (Unknown Channel) triggers cleanup (mirroring the escrow pattern).
- 🟠 **Set Key had no `isCompleted` gate** → a duplicate invoice in the testimonial channel + duplicate stats + the buyer getting 2 keys. Now: gated on the button + re-checked in the modal + a per-channel lock (`completionLocks`) that also protects Deliver Order and the ✅ Order Successful button (2-admin race → duplicate recordPurchase).
- 🟠 **Giveaway double-end** — the scheduler worked from a stale snapshot while a manual `/giveaway end` ran under a different lock namespace → the winner got overwritten + the announce/DM fired 2×. Now: a fresh re-load from disk after acquiring the lock + `/giveaway end` checks `isGiveawayProcessing()` first.
- 🟠 **`linkAllowedRoles` acted as a whitelist for ALL of automod** — roles whitelisted for links became exempt from spam, blocked words, and mass-mention checks too. Now: split into `isUserWhitelisted` (admin-only) vs `isLinkAllowed` (link checks only).
- 🟡 **`parsePriceNumber("1.5m")` → 15,000,000** (the decimal point became an extra digit — 10× inflation) — now the separator is only valid as a thousands separator (`1.000.000` ✓, `1.5m` → rejected).
- 🟡 **Ticket meta stored the product label, not the value** — renaming a product broke Set Key in every open ticket (the v3.9.26 fix was ineffective); duplicate labels → the wrong role granted. Now the meta stores `productValue` + a `resolveProduct()` helper (value-first, with a label fallback for old tickets).
- 🟡 **Multi-choice polls: unvote never worked** (clicking an already-voted option was a silent no-op) — now it properly toggles for both single & multi choice.
- 🟡 **Cooldown 0 couldn't turn a responder off** (`0 || 3000`) & **leveling** (`0 || 60000`) — now `??` (nullish coalescing): 0 = off, as documented.
- 🟡 **`containsLink` missed bare domains** (`discord.gg/xxx`, `t.me/x`) — now a curated-TLD regex matches domains without a scheme or www.
- 🟡 **Exempt words masked separate blocked words** (`"asus asu"` slipped through) — now exemptions are masked per-occurrence BEFORE detection.
- 🟡 **`/setup-ticket` crashed when body + `{price_list}` > 4096** — now validated pre-send with a clear message.
- 🟡 **`/config-show` crashed at ~12 products** (field > 1024) & **`/announce-list` crashed at ~27 entries** — now capped with a "+N more" note.
- 🟡 **`/announce-schedule` claimed WITA (UTC+8) but parsed the host timezone** — a UTC VPS = 8 hours late. Now an explicit offset defaults to +8, configurable via the `TZ_OFFSET_HOURS` env var.
- 🟢 **Transcripts only kept the last 100 messages** (transfer proof near the top was lost) — now paginated up to 1000 messages + a truncation note.
- 🟢 Empty (whitespace-only) keys rejected at 3 layers; **raw keys no longer leak to the console** (length-only masking; duplicate-key error messages carry no key value).
- 🟢 `endGiveaway` now sets `endedAt` (accurate GC); **AFK entries are GC'd** (entries older than 30 days pruned by `pruneStaleData`); `parsePrice` rejects negative prices.
- 🟢 Zombie terminal deals (channel deletion failed with something other than 10003) are reconciled too; third-party creators are placed in `observers` (removable via the button); `handleEvent` calls deferReply up front (no more "interaction failed" after >3s).
- 🟢 Temp voice orphans when a music bot leaves last — bot events now still run the empty-channel cleanup.
- 🟢 `/set-role` validates that the role is assignable (@everyone, managed roles, and roles above the bot are rejected); `/announce` + `/announce-schedule` validate channel type (categories/forums rejected); `/help` auto-splits into 2 embeds past 5800 chars; the router marks dedup AFTER success (a crashed interaction replay can retry); whole-word boundaries are unicode-aware (Cyrillic/CJK); truncation is surrogate-safe (`truncateUtf8Safe`).

### Tests

- 🟢 +62 unit tests (total **386**, up from 324) across 5 new files: `hardeningV38Midman` (12 — lock interleaving, TOCTOU, parsing), `hardeningV38Ticket` (12 — transient fetch, the 2-admin race, productValue, 150-message transcripts), `hardeningV38Data` (12 — giveaway double-end, poll toggle, cooldown 0, AFK GC), `hardeningV38Automod` (14 — bare domains, exempt masking, the whitelist split, unicode, bot voice cleanup), `hardeningV38Router` (12 — TZ offset, dedup retry, set-role validation, truncateUtf8Safe). Full suite: 386/386 green, ESLint 0 warnings.

## [3.9.37] — 2026-09-02

### Fixed — 🐛 Outdated /help + full audit v2: 5 bugs/issues following the escrow feature (user-reported: "auto split still 2")

User request: an error in `/help` (the middleman feature existed but Auto-Split still said **2 categories**) plus a full read-through of the code to sync everything. The `/help` fix came along with a second audit that found 5 real issues — two of them seriously affecting the escrow flow.

- 🟠 **/help Auto-Split 2 → 3 categories** (user-reported bug): now mentions **🎫 TRANSACTION / 🎫 SUPPORT / 🤝 ESCROW** + the custom key `midman.category`; adds a **🤝 Midman / Escrow** section (`/set-role midman`, `/set-midman-fee`, `/midman-deals` + a summary of the 3-step flow); the role list now mentions `midman`; typo "TAU" → "ATAU".
- 🟢 **The /help embed version is now dynamic**, pulled from `package.json` (footer + description) — it was previously hardcoded as `v3.9.26` even though the bot was far newer; it can't go stale again.
- 🔴 **`deals.json` was missing from FILES_TO_BACKUP** — `/backup-now` & `/restore-backup` did NOT back up escrow deal data (the v3.9.32 feature). Consequence: a restore severed every active escrow deal (meta gone; the buyer/seller locked out forever). Caught by the "live files must be backed up" guard test as soon as deals.json landed in `data/`. Now fully backed up.
- 🟠 **Zombie deals locked forever → self-healing** (parity with tickets): a non-terminal deal whose channel had been deleted manually from the Discord UI used to leave the buyer/seller **unable to open regular tickets or be picked for a new deal** forever, and `/midman-deals` showed dead links. Now reconciled automatically: at **startup** (ready.js 6b) + **daily** by the scheduler tick (with a per-day guard). Transient errors (5xx/network) do NOT delete a deal — only channels that are truly gone (null / error 10003) are cleaned up.
- 🟠 **Router `ticket_cat:midman` is now exact-match** — custom categories whose id starts with `midman` (e.g. `midman_jual`, valid per CATEGORY_ID_REGEX) previously hit a prefix-match → fell into the midman domain fallback → the button **died without a reply** ("interaction failed"). Now routed correctly back to the ticket domain.
- 🟡 **Deal sellers are now checked for active tickets too** — previously only the buyer was checked (an asymmetry in the 1-active-channel-per-user policy): a user with an open ticket could still become a deal seller.
- 🟢 **Panel text no longer misleads**: the escrow category dropdown description "Support / open a ticket directly" → "3-party escrow deal"; the `findEmptyCategoryWarnings` warning no longer suggests "add products to the midman category" (products in the midman category genuinely never show — a click always opens a deal); the `/list-categories` empty-config message "Default 4 categories" → **5** (including midman); the config migration console message now mentions midman; ADMIN_GUIDE "4 default buttons" → 5.
- 🟢 **Audit log labels for MIDMAN_xxx + SET_MIDMAN_FEE** — previously rendered as raw action strings in the audit log channel (inconsistent with the label convention from v3.9.4/v3.9.17).
- 🟢 **Minor hardening**: `<@&undefined>` guard in dispute announcements when the admin role isn't set yet (falls back to **Admin**); non-array `deal.history` guard in remove-member (mirroring the other handlers' guards); empty transcript chunks (a blank code block when the hard-split remainder is exactly 1900 chars) are no longer sent.

### Tests

- 🟢 +12 unit tests (total **324**, up from 312): `tests/unit/hardeningV37.test.js` — router exact-match (category `midman_jual` → ticket domain, button `ticket_cat:midman` → midman domain), the escrow panel warning/description, audit labels, /help contents (3 categories + the midman section + the dynamic version), zombie deal reconciliation (null/10003/transient/terminal + the daily wrapper), the 3-step deal form (a seller with an active ticket rejected + a happy-path regression), transcripts without empty chunks, pinning `deals.json` in FILES_TO_BACKUP.
- 🟢 Old tests that pinned the literal `v3.9.26` in /help were updated: they now compare against `package.json` (future-proof).

## [3.9.36] — 2026-09-02

### Changed — 🧹 Code cleanup: a full audit (37 lint warnings → 0), dead code removed, message typo fixed

A final full audit of the codebase (requested as "check the whole thing again"): all 37 ESLint warnings cleaned up to **0 errors 0 warnings**, junk code removed (dead code, unused variables/imports, redundant requires), and one truncated warning message fixed. No behavior changes — the 312 unit tests stayed green with no test modifications.

- 🟢 **Dead code removed** — functions never called/exported: a duplicate `formatTimeLeft` in `giveawayManager.js` AND in `scheduledAnnouncements.js` (both with zero callers — leftovers from the v3.9.26 refactor), `findOwnerVoiceChannel` in `tempvoice.js` (its comment claimed "kept for backward compat / used in a few handlers" — turns out it wasn't used anywhere), and a legacy `save()` in `statsManager.js` (not exported, never called).
- 🟢 **Junk variables/assignments removed** — `timeLeft` (announce), `newConfig` (automod-toggle), `found` + `newName` (the tempvoice rename path), `prefix` (afkManager listGuildAFK), `total = 0` + `pct = 0` (poll create — the template already hardcodes "0 votes (0%)"), and unused `i`/`k` parameters in map/filter.
- 🟢 **Unused imports cleaned up** — `ChannelType` (panels-mgmt, poll), `createPoll` (commands/poll), `ModalBuilder`/`TextInputBuilder`/`TextInputStyle`/`saveConfig`/`DEFAULTS`/`safeEditReply` (interactions/config), `getConfig`/`saveConfig` (responder), `path` (safeWrite).
- 🟢 **Redundant requires consolidated** — the double `require('./_shared')` in `leveling.js` merged; lazy `require('discord.js')` 2× inside functions in `schedulerTasks.js` hoisted to top-level (discord.js is always already loaded when the bot starts); the `PFB` alias in `voiceStateUpdate.js` removed (uses the `PermissionFlagsBits` import already at the top); lazy `require('../data/statsManager')` 3× in `ticket.js` hoisted into the main import (`_shared` already loads statsManager transitively — the lazy requires were purely redundant).
- 🟡 **Message typo fixed** — the `completeNonKeyOrder` warning in `ticket.js`: `"product X not found in config — auto-role & not processed"` was truncated & awkward → `"auto-role not processed"` (accurate: stats are still recorded, only the auto-role is skipped).
- 🟢 `catch (err)` with an unused `err` → `catch (_err)` in 8 places (afk/automod/level/responderManager, levelManager, keys ×2, auditLog, permissions) — consistent with the `^_` convention the codebase already uses.
- 🟢 Unnecessary escapes removed: `\`` inside single-quoted strings (the giveaway reroll hint).

## [3.9.35] — 2026-09-02

### Fixed — 🎫 Tickets: the "Close Without Completing" button didn't work (both buttons just cancelled the close)

A user-reported bug on non-transaction tickets (**support / help / report / claim / giveaway**): when an admin clicked 🔒 Close Ticket, the ephemeral confirmation showed 3 buttons — ✅ Done, ❌ Close Without Completing, ⏏️ Cancel Close. But the **❌ Close Without Completing** button was mis-wired to the customId `ticket_close_abort` — **the same customId as ⏏️ Cancel Close**. As a result both buttons behaved identically (they only cancelled the close): a non-transaction ticket **could not be closed without being completed** — the only ways out were ✅ Done (the transcript recorded as successful, even though it wasn't) or deleting the channel manually from the Discord UI (no transcript, no meta cleanup).

- 🟠 **The "❌ Close Without Completing" button now actually closes the ticket** — it uses the new customId `ticket_close_cancel`, handled together with `ticket_close_cancel_trans` (one shared behavior: `closeTicket(channel, user, isSuccess=false)` — the transcript is saved & marked **not completed**, the channel deleted, the tickets.json metadata cleaned up, no invoice). Before: both merely displayed "❌ Ticket closing cancelled."
- 🟢 **"⏏️ Cancel Close" is now consistent in every scenario** — it uses `ticket_close_abort` in the help/report branch too (previously `ticket_close_abort2`). The `_abort2` customId **is still handled** for old ephemeral confirmations that remain open while the bot updates (no dead buttons).
- 🟢 **The help/report confirmation message now details each button** (the same pattern as the non-key transaction branch): "✅ Done — completed, transcript marked successful / ❌ Close Without Completing — close the ticket now, transcript marked not completed".
- 🟢 Defense-in-depth still applies to the new button: an admin re-check (non-admins rejected) + validation that the channel is a registered ticket (a forged customId can't delete arbitrary channels).

### Tests

- 🟢 +7 unit tests (total **312**, up from 305): `tests/unit/ticketCloseButtons.test.js` — the confirmation row composition for help & claim_giveaway tickets (correct, unique customIds and correct labels), clicking `ticket_close_cancel` on a help/report ticket → channel deleted + meta clean, clicking `ticket_close_abort` → the ticket stays alive, non-admin rejected, and compatibility with the old `ticket_close_abort2` customId.

## [3.9.34] — 2026-09-02

### Changed — 🤝 Escrow: anyone can create a deal (explicit form) + dual consent + member management inside the deal channel

A redesign of the deal-creation flow based on user direction: **anyone may open an escrow ticket** (the buyer, the seller, or a helper) — what matters is that **the form explicitly states who the buyer and the seller are**, and **members can be added/removed inside the deal channel**.

- 🟢 **3-step form (explicit roles)** — previously, whoever clicked the 🤝 Escrow button was automatically treated as the buyer (a seller couldn't open a deal; if they tried anyway, the roles were reversed and the money flow could go the wrong way). Now: (1) an item + price modal, (2) **pick the 🛒 BUYER** via a searchable member dropdown (`mm_pick_buyer`), (3) **pick the 🏷️ SELLER** (`mm_pick_seller`) → the deal channel is created with the correct roles. Every choice still only requires typing a name — no mentions, no copying IDs. Validation (member exists, not a bot, holds no active deal/ticket) runs on the selected party; if validation fails → the dropdown re-renders in the same ephemeral message (no need to re-fill the modal). Third-party creators (e.g. a middleman helping out) still get access to their deal channel.
- 🟡 **Dual consent (state `WAITING_AGREE`)** — replaces `WAITING_SELLER`. Since the creator can now be anyone, the terms (item + price) are locked ONLY after **both the buyer and the seller** click **🤝 Agree to Deal** (`applyAgreement()` is pure — the first click = partial consent: recorded in history, the board updates with ✅/⏳ per party, and the party that hasn't agreed gets pinged; the second click = the `join` transition → `WAITING_PAYMENT`). The join actor guard is now `buyer` + `seller`. Old `WAITING_SELLER` deals are **migrated automatically** on load (buyerAgreed=true — the original buyer wrote the terms, so consent is implicit; sellerAgreed=false; the `observers` field filled with `[]`).
- 🟢 **👥 Add Member / ➖ Remove Member inside the deal channel** — new buttons on row 2 of the Deal Board (all non-terminal states, middleman/admin only; observers & participants are rejected with a clear message). Add: a searchable member dropdown (`mm_pick_member`) → grants view/chat/attach access (they are not transaction participants — `resolveActor` doesn't recognize them, so they can't move the deal forward; max 10 per deal). Remove: a dropdown listing the current observers (`mm_remove_pick`) → revokes access. **The buyer/seller cannot be removed** — their matters go through deal cancel/dispute. Every add/remove is recorded in the deal history + audit log (`MIDMAN_MEMBER_ADD`/`MIDMAN_MEMBER_REMOVE`) + a new **👀 Extra Members** field on the Deal Board. This is also the official remedy for "accidentally added the wrong member": remove them via the button (recorded), not by manually editing permissions in the Discord UI (unrecorded).
- 🟢 Router: the `mm_` prefix now handles user selects (`mm_pick_buyer`, `mm_pick_member`) + string selects (`mm_remove_pick`) — the `isUserSelectMenu`/`isStringSelectMenu` filters already existed; only the domain mapping was added.

### Security

- 🔴 Fixed a potential issue when building the deal channel's permissionOverwrites: the third-party creator's overwrite is now built **conditionally** in the array (not inlined with `allow: undefined`) — the earlier draft's pattern risked overwriting the `@everyone` deny and exposing the channel; the final version never touches the `@everyone` overwrite.

### Tests

- 🟢 +14 unit tests (total **305**, up from 291): `applyAgreement` (partial/both/double-click/non-participant/seller-first order), the `applyAgreement`+`recordTransition` caller contract, observers (add/remove/principal/duplicate/limit 10/invalid), the `WAITING_SELLER` deal migration (disk verified in the new shape + idempotent + other deals untouched), router dispatch of `mm_pick_buyer`/`mm_pick_member`/`mm_remove_pick`, and persistence adapting to the normalized fields.

## [3.9.33] — 2026-09-02

### Changed — 🤝 Escrow: pick the seller via a dropdown + the fee is added on top of the price

Two design revisions to the v3.9.32 escrow feature, both driven by real-world usage feedback:

- 🟢 **Pick the seller from a member dropdown (User Select Menu)** — previously the buyer had to type the seller's mention/user ID into the modal (`parseSellerInput`), which tripped up users with hard-to-type names or who didn't know how to copy an ID. Deal creation is now **2 steps**: (1) an item + price modal, (2) a **Discord member dropdown** with a search box, avatars, and names — just type a name, no mention, no ID copying. Step-1 data is held temporarily (in-memory, TTL 15 minutes = the ephemeral lifetime, auto-pruned). The router now also accepts `isUserSelectMenu()` interactions (`mm_pick_seller`). Full validation still runs when the seller is picked (re-check for active deals/tickets, anti-self, anti-bot, the member must exist).
- 🟢 **ADDITIVE fee model — added on top of the price, not deducted from the seller's funds.** Example: price 100,000 + a 5% fee (5,000) → the buyer transfers **105,000**, the seller receives the **full 100,000**, and the middleman keeps 5,000. Implementation: `calcTotals(price, fee)` (pure, unit-tested) is the single source of the calculation; the `Math.min(fee, price)` cap in `calcFee` was removed (irrelevant for an additive fee); `/set-midman-fee` still caps the percentage at 90% as a sanity guard.
- 🟢 **Deal Board & messaging adjusted**: a new field `💳 Total Paid by Buyer` (price + fee), and `🏷️ Received by Seller` showing the full price "— no deductions"; the `WAITING_PAYMENT`/`WAITING_RELEASE` state descriptions now display the exact amounts (the transfer total / the full payout + the middleman fee); the `fundin` announcement states the amount received; the `release` announcement states the full payout + the fee; the fee mode & value are snapshotted onto the deal record (`feeMode`, `feeValue`) so a running deal's board doesn't change when an admin edits the config.
- 🟢 **Invoices & stats record the buyer's actual outlay** (price + fee), and the transcript captures the `total (price + fee)` breakdown.
- 🟢 `parseSellerInput` removed from `midmanManager` (dead code — replaced by the dropdown). `/midman-deals` now shows the total (price + fee) per deal.

### Fixed

- 🟡 Mock interactions in 4 test files (`interactionsRouter`, `ticketNonKey`, `panelEdit`, `hardeningV31`) gained the `isUserSelectMenu` method — without it, the new router threw `TypeError: interaction.isUserSelectMenu is not a function` when the old tests ran.

## [3.9.32] — 2026-09-02

### Added — 🤝 NEW FEATURE: Midman / Escrow (3-Party Escrow Deals)

A middleman (escrow) service for member-to-member transactions: the buyer, the seller, and the middleman share one deal channel with a **Deal Board** (a bot embed) as the source of truth and a **state machine** that enforces the order — the money moves first → the goods arrive → only then are the funds released, and every step must be confirmed by a different party.

- **Escrow state machine** (`src/data/midmanManager.js`): `WAITING_SELLER → WAITING_PAYMENT → WAITING_DELIVERY → WAITING_RELEASE → COMPLETED`, plus `DISPUTE` (frozen; only an admin resolves it: release/refund) and `CANCELLED`/`REFUNDED`. Every button click is double-validated — (1) the state order must allow the event (`canTransition`), (2) the clicker must hold the allowed actor role (`actorAllowed`). The bot structurally rejects classic fraud schemes: releasing before the goods are delivered, a buyer clicking "Funds Received" while impersonating the middleman, or any action during a dispute.
- **Deal Board**: a bot embed (item, price, fee, the seller's take, status, per-state instructions) edited automatically on every transition — the terms lock once the seller agrees (changing them = cancel & recreate). If an admin deletes the board → self-healing (it is re-sent). Each state renders only the buttons for valid actions.
- **3-party deal channel**: the `🤝 ESCROW` category, with overwrites for the buyer, the seller, the middleman role, and the admin role. A full per-click history (who, when, which event) is stored in `data/deals.json` + sent as a summary before close (and included in the transcript).
- **Thor ecosystem integration**: an invoice to the testimonial channel + `recordPurchase` stats when a deal reaches COMPLETED (reusing `sendInvoice`), automatic transcripts (reusing `saveTranscript`), an audit log entry on every transition (`MIDMAN_*`), a per-channel anti-double-click lock, and meta cleanup only when the channel is truly gone (the v3.9.31 pattern).
- **Anti-bypass**: a user with an active deal (as buyer/seller) can't open a regular ticket; a buyer with an active ticket can't create a deal; 1 active deal per person (as buyer or seller). The ticket-check loop in `createTicket` was extracted into `findActiveTicketFor()` (and reused).
- **Commands**: `/set-role midman`, `/remove-role midman`, `/set-midman-fee` (a 0–90% percentage or a flat amount; the fee is computed automatically from the config — it can't be negotiated per deal), `/midman-deals` (list active deals), plus an escrow view in `/config-show`. Total **80 → 82 slash commands**.
- **The `Midman / Escrow` panel category** is added automatically (a one-shot migration, the claim_giveaway pattern): its button is intercepted by the router → the midman domain; its dropdown is redirected from the ticket handler. Don't want the escrow feature? `/remove-category midman` — the `midmanCategoryDismissed` flag keeps the category from "coming back to life".
- 31 new unit tests (`tests/unit/midman.test.js`): the state machine matrix (happy path, double gates, dispute, terminal), the actor matrix, fees (percentage/flat/cap/invalid), the modal input parser, deals.json persistence, the category migration + the dismissed flag, and `findActiveTicketFor` (active/zombie cleanup). Total **258 → 289 unit tests**.

### Fixed

- 🟡 **`actorAllowed` key mismatch** (slipped through untested): the transition actor lists use the names `buyer`/`seller`/... while callers passed flags `isBuyer`/`isSeller`/... — the `ACTOR_KEY_MAP` mapping unifies the two (caught by the actor tests).

## [3.9.31] — 2026-09-01

### Fixed

- 🔴 **Orphaned meta on ticket close** — `removeTicketMeta` still ran even when `channel.delete()` failed for a non-10003 reason (Missing Permissions / network). The channel was still alive but its meta was gone → the next close fell into the topic-parsing fallback, losing the `isCompleted`/`isInvoiceSent`/`isTransaction` flags → **the invoice was sent twice** + the wrong close-button scenario. Now the meta is only deleted once the channel is truly gone; if the delete fails, the admin just clicks close again after fixing permissions (self-healing).
- 🟠 **TypeError in `ticket_close` / `ticket_set_key` when the channel is null** — `interaction.channel.id` without a guard (inconsistent with the modal, which already had the P1-8 guard). If the channel was deleted right before an admin clicked the button (partial/uncached), the global handler swallowed the error as a generic one. Now there's a guard + a clear ephemeral message.
- 🟠 **The `/clear-schedule` role-removal heuristic was too broad** — role candidates were collected from ALL `scheduledRoles.json` entries (including other users') → a member's manually granted role that happened to match another user's scheduled VIP role got removed too. Now: a snapshot of only the target user's roleIds (schedule + key, taken BEFORE the deletion).
- 🟡 **Layering violation in `/clear-schedule`** — the old block read `data/scheduledRoles.json` directly via `fs.readFileSync` + a hardcoded path, bypassing the `roleScheduler` API (failing silently if the path/schema changed). Now it goes through the `findAllSchedulesByUser` API + a key snapshot via `findAllByUser`; a 45-line stream-of-consciousness comment was condensed.
- 🟡 **`getTopUsers` spread order overwrote the fallback userId** — `{ userId: ..., ...stats }` could produce `userId: undefined` for entries with an explicit undefined property; the order is now reversed to `{ ...stats, userId: ..., value: ... }`.

### Changed

- 🟢 `getActiveKeysByUserAndRole` now accepts an optional `guildId` (4th param) — pattern-consistent with `findAllByUser`; legacy keys without a guildId still count (backward compat). Called with the guild from the Set Key flow (command & modal).
- 🟢 Dead code `createContext()` removed from `src/commands/_shared.js` (never called by any handler).

### Added

- 10 new unit tests (`tests/unit/hardeningV31.test.js`): the orphan-meta guard (delete failing non-10003 / 10003 / success / self-healing), the null-channel guard via the interaction router, the schedule snapshot contract (only the target user's roleIds), the guildId filter + legacy backward compat, the leaderboard userId fallback, and `_shared` exports intact. Total **258 unit tests**.

## [3.9.30] — 2026-09-01

### Changed

- 🟢 **`/set-transcript-channel` merged into `/set-channel tipe:transcript`** — an admin request: two similar channel commands were confusing. Now **one command, `/set-channel`**, manages every channel: `invoice`, `welcome`, `goodbye`, `audit-log`, `transcript`. The separate command was removed from the registry (total **81 → 80 slash commands**); `ready.js` re-registers automatically on restart, so the old command disappears from Discord with no manual steps. The data is unchanged (still `config.channels.transcript`).
- `/remove-channel` now also has a `transcript` choice — a consistent set/remove pattern for every channel type.
- `/config-show` displays Audit Log + Ticket Transcript in the Channels field (previously only welcome/goodbye/invoice).
- `/set-channel` now rejects non-text channels (voice/category) for **all** types — a guard that previously existed only in the transcript handler.

### Added

- 10 new unit tests (`tests/unit/setChannelMerge.test.js`): registry (the old command gone, the exact total of 80, the new choice), router (the old command → "not supported"), handler (set transcript + the dedicated tip, voice-channel rejection, regressions on the other types, remove transcript, and the round-trip key read by `saveTranscript`).

## [3.9.29] — 2026-09-01

### Fixed

- 🔴 **`/update-panel` — image/thumbnail URLs rejected on input**: the modal input length cap for `image`/`thumbnail` was only 500 characters, while signed Discord CDN URLs typically run 300–450 — Discord rejected the input before it could even be submitted. The cap was raised to **2048 characters** (Discord's embed URL limit), plus a 2048 guard with a clear error message in `/update-panel` (modal) and `/setup-ticket-panel` (slash command).
- 🟠 **The `/update-panel` audit log displayed `undefined`** for the image/thumbnail/footer fields — it read `patch[field]` while the data is stored under the keys `imageUrl`/`thumbnailUrl`/`footerText`.
- Note: the image/thumbnail key-mapping bug (changes saved but never shown on the panel) has been fixed since v3.9.26 — make sure the bot is running the latest code (restart the bot).

### Added

- ✅ **Empty-category safety net** — `/setup-ticket-panel` & `/refresh-panel` now warn when a panel category has no products yet ("clicking an empty category button opens a SUPPORT ticket, not a transaction — add products via `/add-product`"). The `help`/`report` categories are not warned about (they are quick actions by design).
- 14 new unit tests (`tests/unit/panelEdit.test.js`): the end-to-end modal flow (CDN URL saved & rendered, the 2048 guard, clearing, an invalid URL, the cross-guild guard), the safety net across 5 scenarios, and input-length guard regressions.

## [3.9.28] — 2026-09-01

### Added

- ✅ **`classifyProduct()`** — a pure function extracted from `createTicket`. Classification rule: only the `help`/`report` categories and products flagged `isHelp` count as **SUPPORT**; **every other category id, whatever it is (`akun_ml`, `lisensi_key`, `jasa`, `topup`, custom...), is automatically a TRANSACTION**. Adding a new category requires zero code changes.
- 14 new unit tests (`tests/unit/newCategorySafety.test.js`): a non-key `akun_ml` scenario (📦 Deliver Order), `lisensi_key` (🔑 Set Key), the meta → resolveTicketType → button-matrix round trip, `requires_key` inheritance from category→product in `/add-product`, and dropdown descriptions.

### Fixed

- 🟠 **Panel dropdown descriptions for mixed categories** — previously they used the category's `requiresKey` flag (misleading when a category mixes key & non-key products). Now computed from the actual products: all keyed → "with keys", all non-key → "without keys", mixed → "N without keys / M with keys".

### Documented

- Gotcha: a transaction product **without** the `requires_key` flag is treated as keyed (the Set Key button). For account/service products: set `requires_key:false` on the **category** — new products inherit it automatically.

## [3.9.27] — 2026-09-01

### Fixed

- 🔴 **Non-key products (account/service sales) were treated as SUPPORT tickets** — the old system confused `requiresKey` (is the product key-based?) with `isTransaction` (is this a buy/sell ticket?). Fixed with an explicit `isTransaction` flag via `resolveTicketType()` (one source of truth, 5 close-button scenarios).
- 🔴 **Non-key products used the help-style close buttons** — "✅ Order Successful / ❌ Purchase Cancelled" never appeared.
- 🔴 **Invoices/testimonials were never sent for non-key products** — `requiresKey=false` was wrongly treated as "help/report" in `closeTicket`.
- 🔴 **Stats/leaderboards didn't record non-key sales** — `recordPurchase` only ran in the Set Key flow.
- 🔴 **Non-key product auto-roles were never granted** even though `/set-product-role` promised them (now granted via Deliver Order OR Order Successful).
- 🔴 **`modal_deliver_order:` routing was missing** — a modal prefix with no generic fallback in the router → the modal submit became a dead interaction.
- 🟠 **Double invoice for key transactions** — sent at Set Key AND again at the "Done" close. Fixed with an `isInvoiceSent` flag on the ticket meta.
- 🟠 **Modal titles > 45 characters made `showModal` throw** — "Set Key — <product label>" could reach 89 characters → the Set Key button died silently. Fixed (sliced to 45).
- 🟠 **Misleading panel dropdown descriptions** — product-bearing non-key categories were labeled "Support / non-transaction". Now based on the actual content.

### Added

- ✅ **The 📦 Deliver Order button** for non-key products (mirrors Set Key): the admin fills in the order details (multi-line) in a modal → the bot **DMs the details to the buyer** (the ticket chat is deleted at close — the DM becomes the only permanent copy) + auto-role + auto-expire + invoice + stats + an `ORDER_DELIVERED` audit log entry.
- The product dropdown emoji now distinguishes 🔑 (keyed) vs 📦 (non-key).
- `resolveTicketType()` is backward-compatible: old tickets (without flags) keep the old classification — no regressions; new tickets are always correct.

## [3.9.26] — 2026-08-31

A re-audit of the entire codebase with the context that **the bot serves a single guild** — 6 new findings fixed + hardening + a garbage collector.

### Fixed

- 🔴 **`/update-panel` image/thumbnail/footer never worked** — patches were saved under the wrong key (`image`) while the builder reads `imageUrl` → 3 of the 6 advertised fields were silent no-ops. Fixed (key mapping) + the modal is now pre-filled.
- 🔴 **`/giveaway list` & `/poll list` permanently dead at ~30 entries** — an embed description > 4096 → throw. Now: the 15 most recent + a summary + daily GC (entries older than 30 days pruned automatically).
- 🔴 **A poll with a long question = zombie + the admin stuck on "Bot is thinking..."** — the entry persisted before the render threw. Fixed: validation in the command (max 250) + render-first + safeEditReply.
- 🔴 **`claim_giveaway` couldn't be removed permanently** — the migration in `getConfig()` (which runs per message) re-added the category after `/remove-category`. Fixed with the `claimGiveawayDismissed` flag.
- 🟠 **Long product labels/prices killed the ticket flow** — the dropdown threw on `addOptions` (the 100-option limit). Fixed: caps in the registry + handler + defensive slicing in 3 dropdowns.
- 🟠 **Free-form stored emojis could poison panels** — non-emoji strings broke `/setup-verify` & every ticket panel. Fixed: emoji validation in set-verify-button, add-category, and update-category.

### Changed (Hardening & Performance)

- 🟢 **Corrupt file quarantine** — 16 data files are renamed `.corrupt-<ts>` before falling back to defaults (previously: corrupt contents were silently overwritten by the next save).
- 🟢 **Hot-path caching** — automod/afk/responders/levels now use a read-through cache (previously 5–7 synchronous `readFileSync` calls per message). AFK mentions are batched.
- 🟢 **A `GUILD_ID` guard on every event** — messages/commands/members/voice from other guilds are ignored.
- 🟢 **The v1→v2 config migration no longer drops modern fields** (ticketCategories/leveling/verifyButton preserved).
- 🟡 messageCreate per-hook try/catch; `getSubcommand(false)` + hints; prize/question/key max_length; a reroll guild-check; the backup cancel button handled; logAudit tolerates long details; set-key DMs & transcripts tolerate long data; the Set Key product lookup uses `value` (rename-proof); an admin re-check in the update-panel modal; leveling value clamping.

### Docs

- `docs/ADMIN_GUIDE.md` + `docs/README.md` synced — to the real `src/` folder structure (previously still the old pre-refactor structure + 47 commands).

## [3.9.25] — 2026-08-31

### Added

- `\n` (newline) support added to the fields missed in v3.9.24: `/set-message` (Body type), `/afk reason`, `/warn reason`, and the `/setup-selfrole` & `/selfrole-add` descriptions. A `(supports \n)` hint appears in the command option descriptions.
- Note: the **Title** type deliberately isn't converted — Discord embed titles reject newlines. **Modal** inputs don't need `\n` (Enter produces a real newline).

## [3.9.24] — 2026-08-31

### Added

- **`\n` (newline) feature for all multi-line text input** — slash command inputs in Discord can't press Enter (Enter = submit the form): `/send-message`, `/announce`, `/announce-schedule`, `/setup-ticket-panel body`, `/add-responder reply`.

### Fixed

- 🔴 **`/update-category` & `/update-product` never worked** — registered in the registry + advertised in /help, but not mapped in the router. Fixed + a guard test.
- 🔴 **Backup holes** — `automod.json`, `levels.json`, `responders.json`, `afk.json`, `panels.json` were never backed up. Fixed + a guard test.
- 🔴 **Crashes exited with code 0** — PM2/systemd/Docker wouldn't restart the bot after a crash. Now `exit(1)` + a shutdown guard against double-flushing.
- 🔴 **Tests wrote to/deleted production data** — `npm test` on a live server deleted `panels.json` & evicted real backups. Tests now run sandboxed (snapshot/restore).
- 🟠 ready.js: one giant try/catch → per-step; userLock could delete a stale holder → owner-token; the ticket close button & the set key modal lacked an admin re-check → fixed (defense-in-depth); AFK reasons could mass-ping → `parse: []`; a member losing the required role couldn't leave a giveaway → the role is checked only at join; `/giveaway end` had no lock → withUserLock; phantom devDeps; engines node; a webhook filter in messageCreate; poll modal defer.

## [3.9.23] — 2026-08-31

### Added — Auto-mod WORD FLEX

- **Flexible word filter**: per-word `wordRules` `{word, action, addedBy, addedAt}` + `exemptWords` + `wordMatchMode` (`whole_word` by default).
- **Whole-word** matching with regex escaping — "asu" doesn't match "asus" (anti false-positive).
- **Per-word actions** — mild words can just be deleted; severe words go straight to mute/kick.
- 4 new commands: `/add-word` (appends, doesn't replace), `/remove-word`, `/list-words`, `/remove-link-whitelist` — 81 slash commands total.
- Automatic migration of legacy `blockWords` → `wordRules` (idempotent, lazy persist).

## [3.9.22] — 2026-08-16

### Changed

- **Set-key DMs use emojis** (📦🌐🔑🎭⏰📋💡) and the **role name** (not a mention — role mentions don't resolve in DMs).
- The ticket-channel notification is shorter & addressed to the user ("your key has been sent via DM"), with a manual fallback if the DM fails.
- The `/set-key` DM is consistent with ticket Set Key, framed as a gift ("you got a gift") — a gift context for the member.

## [3.9.21] — 2026-08-16

### Changed

- DMs to members use inline code (`` `key` ``) instead of a code block — a long-press on Discord mobile instantly brings up the Copy menu. More natural wording.
- In the ticket channel, the bot only sends a short message for the user (not a new panel for admins).

## [3.9.20] — 2026-08-16

### Changed

- **Set Key success → the ticket channel stays open** (previously auto-deleted → the transcript wasn't saved and the member had no time to ask questions). The bot sends a short "your key has been sent to your DMs" message.
- Admin & member can Q&A first; on Close Ticket with `meta.isCompleted=true`, only the "✅ Done" button appears (without "Purchase Cancelled").
- The transcript is automatically saved to the transcript channel at close + the invoice is sent if it hasn't been already.

## [3.9.19] — 2026-08-16

### Added — MAX FLEXIBILITY

- **Ticket routing based on "does the category have products"** — a category with products → a TRANSACTION ticket + a product dropdown; an empty category → a straight SUPPORT ticket (quick action).
- `/update-category` & `/update-product` — edit without delete + re-add (all fields optional; only the filled ones change).

## [3.9.18] — 2026-08-16

### Changed

- The default ticket button labels changed to **Help** & **Report** (previously "Staff Help" & "Report a Member") + the example category **Claim Giveaway** was added (permanently removable since v3.9.26).
- Fixed a `requiresKey` over-generalization bug in categories.
- Automatic migration of old labels at bot startup (only if the admin hasn't customized them).

## [3.9.17] — 2026-08-06

### Fixed

- Fixed 38+ audit findings (CRITICAL + HIGH + MEDIUM + LOW).
- Hotfix: `DiscordAPIError 50035` — command option descriptions > 100 characters.
- Hotfix: the `/help` embed exceeded the 6000-character limit.

## [3.9.15] — 2026-08-02

### Fixed

- Audit round 2 — 16 bugs across commands/interactions/data/events/services/ui.
- 🔴 CRITICAL: the auto-responder didn't work because the **Message Content Intent** wasn't enabled — added a console hint + documentation.

## [3.9.14] — 2026-08-06

### Added

- **Persistent multi-panel tickets** — different panels with different category subsets in different channels, saved to `data/panels.json` (included in backups). Fixed 10 runtime bugs.

## [3.9.13] — 2026-08-01

### Added

- 4 new community features: **Auto-Responder**, **Anti-Spam & Auto-Mod**, **AFK System**, **Leveling System** (XP, role rewards, leaderboard) + a rebrand to a generic Community Bot.

## [3.9.12] — 2026-08-01

### Added

- A flexible ticket body via a modal editor + template variables (`{server}`, `{price_list}`) + an updated `/help`.

## [3.9.11] — 2026-08-01

### Added

- Flexible ticket panel: custom categories, multi-panel, transcripts, conditional roles (Phases 1+2+3).

## [3.9.10] — 2026-08-01

### Changed

- A full per-domain refactor (commands/interactions/data/services/ui/infra), no legacy code + CI/CD (GitHub Actions) — 71 tests at the time.

## [3.9.9] — 2026-08-01

### Changed

- Refactor to a professional folder structure + more tests.

## [3.9.8] — 2026-08-01

### Fixed

- 30+ bugs across CRITICAL/HIGH/MEDIUM (rounds 1 + 2: constants sync, audit retry logic, genId entropy).

## [3.9.7] — 2026-08-01

### Fixed

- 🔴 Crash on the embed builder's **Send** button (`ExpectedConstraintError`, label > 45 characters).
- 🟠 `InteractionNotReplied` in the modal-submit handler fallback.

## [3.9.6] — 2026-08-01

### Added

- A **💬 Message (plain text)** option in the embed builder — intro text outside the embed (`@everyone`, mentions, `\n`, max 2000 chars) + a pre-filled Send modal.

## [3.9.5] — 2026-08-01

### Added

- The `/send-message` command — send plain text to a channel (supports `\n` & valid mentions).
- `/embed-list` displays the summary message.

## [3.9.4] — 2026-07-31

### Fixed

- 🔴 CRITICAL: `stats.json` cross-guild data leak — now a composite key `${guildId}:${userId}`.
- 🔴 CRITICAL: the `safeEditReply` helper with a `followUp` fallback for 10008/10062/40060.
- 🟠 ticket close + set key now use `getTicketMeta` (anti-spoof via the channel topic); temp voice orphan cleanup; warn auto-actions only mark on API success; the auto voice-ownership transfer filters bots; `restoreBackup` invalidates the permissions cache; `/config-show` is guild-scoped.

## [3.9.3] — 2026-07-31

### Fixed

- 🔴 CRITICAL: `removeAllKeysByUser` cross-guild wipe — now scoped per guild.
- Title (256) & description (4096) validation in `/announce` & `/announce-schedule`.

## [3.9.2] — 2026-07-31

### Fixed

- Per-user locks for giveaway join/leave & poll votes (anti-double-click TOCTOU).
- A 30s TTL cache for the admin role check; a 1× audit log retry; embed builder length validation; a `.env.example` with security notes.

## [3.9.1] — 2026-07-31

### Fixed — Security & Race Condition Hardening

- 🔴 **Keys masked in the audit log** (previously the first 8 characters leaked).
- 2-step confirmation for `/restore-backup`; poll modal customIds use a session store (beats the 100-char limit); ticket metadata moved to `tickets.json` (previously in the channel topic — spoofable); strict mention validation; removed the hardcoded `@everyone` ping in giveaways; `Math.max(...spread)` replaced with a loop (anti-RangeError); a restore lock + path traversal guard; `statsManager.reload()` after a restore; `parseTime` range validation (max 365 relative days / 5 absolute years).

## [3.9.0] — 2026-07-31

### Fixed — Critical Bug Fixes & Data Integrity

- 🔴 **Atomic writes** (`safeWriteJSON`, tmp+rename) for every JSON store — corruption-proof against crashes and power loss.
- `/clear-schedule` is guild-scoped; 2-step confirmation for `/reset-config`; exclusive mode for the self-role select; a prototype pollution guard in `configManager.setField`; `warnManager` keyed by `(guildId, userId)` + auto-migration; `processExpiredRole` doesn't delete schedules on transient errors; a ghost-loop fix for recurring announcements; skip bots + a single audit log fetch in memberHandler.
