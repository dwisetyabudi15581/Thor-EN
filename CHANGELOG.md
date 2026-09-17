# Changelog

All notable changes to this project are documented in this file. Format based on [Keep a Changelog](https://keepachangelog.com/id/1.1.0/).

Legend: 🔴 critical · 🟠 high · 🟡 medium · 🟢 improvement

## [3.27.0] — 2026-09-17

### Changed — 🎟️ ONE-WAY (VERIFICATION) SELF-ROLE PANELS — REPEAT CLICKS CAN NEVER REMOVE THE ROLE

Owner's request: *"I have a problem with selfrole and autorole — when I use them for a verification system, the panel button can be clicked repeatedly, which troubles people who are new to Discord."* Root cause: self-role buttons are TOGGLES — a newcomer who clicks "Verify" twice (they often do) silently LOSES the role they just claimed and ends up unverified without noticing. The fix: a **`once` (one-way) mode** for self-role panels, built exactly for verification use.

**How it works:**

- 🟠 **`once:true` = one-way panel** — clicking a button only GIVES the role. A member who already has it gets a friendly ephemeral **"✅ You're all set — you already have this role. No need to click again: this panel never removes it."** instead of a silent toggle-off. Same for dropdown panels: selecting adds missing roles; deselecting or clearing the menu never strips anything.
- 🟠 **Slash commands** — `/setup-selfrole … once:true` creates a one-way panel from the start, and `/selfrole-update panel_id once:true|false` flips the mode on a LIVE panel (no delete + recreate; the panel message is re-rendered). `/selfrole-list` and the setup/update confirmations show the mode. Existing panels are untouched (classic toggle behavior unless flipped).
- 🟠 **Web dashboard** — a "One-way (verification)" toggle in BOTH the New Panel form and the per-panel Manage editor (`POST /guilds/:id/selfroles` + `PUT /guilds/:id/selfroles/:panelId` accept `once`), plus a green `one-way` badge on every panel card.
- 🟡 **Panel embed announces the mode** — one-way panels display "🎟️ **One-way mode** — clicking only GIVES you the role. It can never be removed from this panel." with an One-way / One-way + Exclusive footer badge, so members know repeat clicks are safe.
- 🟢 **Compatibility matrix preserved** — `once` composes with `exclusive` (switching to another panel role still works; the newly claimed role can never be toggled off) and with `requires_role` gates; the Role Engine + autorole "remove join roles on another role" toggle (v3.23.0) still fire normally, so the full verification chain — autorole on join → one-way verify click → join role auto-removed — works end to end.
- 🟢 **Tests** — `tests/unit/selfroleOnce.test.js` adds **11 new tests**: the spam-click regression (3 clicks → role still held, zero removal calls), grant-then-spam, exclusive switching, dropdown add-without-strip, cleared-menu no-op, embed badges, manager round-trips, and the two DASH API routes. The `dashParityV326` contract was extended for the new option. Total suite: **814 tests, all passing**.

**Recommended verification setup for newcomer-heavy servers:** `/set-autorole action:add role:@Member` → `/set-autorole action:toggle` (join roles vanish once the member gets another role) → `/setup-selfrole title:Verification once:true` → `/selfrole-add panel_id:<id> role:@Verified label:Verify Me emoji:✅ style:Success`.

## [3.26.0] — 2026-09-17

### Changed — 🌐 FULL WEB CONTROL, ROUND 2 — EVERY REMAINING SLASH COMMAND NOW HAS A DASHBOARD TWIN

Owner's request: *"Audit all commands again — like /set-product-role, and editing a self-role panel doesn't exist yet. Audit everything so ALL commands can be fully controlled from the web dashboard."* A full re-audit of all 93 commands against the web modules + DASH API found **8 remaining gaps** (v3.24.4's audit covered moderation/reset/send-message but missed the product auto-role, self-role panel editing, ticket panel management, and giveaway/poll lifecycle). All 8 are closed — every command now has a web equivalent (registry grows to **94** with the new `/selfrole-update`).

**The 8 closed gaps:**

- 🟠 **Product auto-role on the web (parity with /set-product-role, /remove-product-role, /list-product-roles)** — every product card in Tickets & Products now has an "Auto-role on purchase" role picker + an "Auto-remove after (days)" field. The mapping was already preserved by the API since v3.19.0; the UI simply never showed or let you edit it. A live hint explains when the role is granted (🔑 Set Key / 📦 Deliver Order / ✅ Order Success) and whether it's permanent or auto-expiring.
- 🟠 **Self-role panel EDITING (parity with the NEW /selfrole-update command + the web "Manage" form)** — the biggest hole: `selfRoleManager.updatePanel()` existed as dead code with NO command, NO endpoint, and NO UI. Now: a new `/selfrole-update panel_id title/description/type/exclusive` slash command (edits a live panel in place, re-renders the message, audit-logged), a `PUT /guilds/:id/selfroles/:panelId` endpoint (title/description/type/exclusive, guild-IDOR guarded), and a per-panel "Manage" editor on the web. A panel no longer has to be deleted + recreated to change its title or switch buttons ⇄ dropdown.
- 🟠 **Add/remove roles on a LIVE self-role panel (parity with /selfrole-add & /selfrole-remove)** — the endpoints existed since v3.19.0 but the web UI never exposed them. Each panel now shows its roles as chips (× removes instantly), plus a full add-role form: role picker, label, emoji, **button color**, **dropdown description**, and the conditional **"Requires role"** gate (`requiresRoleId` — also newly accepted by the API endpoint, matching the slash command's hidden `requires_role` option).
- 🟠 **Ticket panel management on the web (parity with /update-panel, /refresh-panel, /delete-panel, /list-panels, /setup-ticket-panel)** — a new "Installed Ticket Panels" section in Tickets & Products: install a panel (channel + category chips + dropdown toggle — full form, not just the Quick Start step), restyle it (title/body/color/image/thumbnail/footer with the same validation + storage-key mapping as the modal, empty = clear override), refresh it (re-render with the latest categories/products + empty-category warnings), or delete it (message + metadata).
- 🟠 **Giveaway end & reroll from the web (parity with /giveaway end & reroll)** — "End now" on running giveaways (picks winners, edits the message, announces + DMs, exactly the slash command's `processGiveawayEnd` path with the same `withUserLock` + scheduler in-flight guard so a web end and a Discord end can never double-pick) and 🎲 Reroll on finished ones (new winner from non-winners, announce + DM + stats).
- 🟠 **Poll close from the web (parity with /poll close)** — "Close" on open polls: stops voting, renders the final result bars + disables the buttons in the channel message (the same `updatePollMessage` behavior).
- 🟢 **`/selfrole-update` help documentation** — added to the 🎭 Roles & Self-Roles category (compact + full guide) while keeping the All-Commands embed inside the 5.800-char budget (5799/5800, all 20 categories still load).
- 🟢 **Endpoint docs + tests** — the DASH API header now documents all 9 new routes, and `tests/unit/dashParityV326.test.js` adds **10 new tests** (endpoint round-trips: panel edit/re-render, gated role add/remove, giveaway end double-guard 409, reroll persistence, poll close 409, panel style edit + clear + refresh + delete, product roleId/days round-trip, registry/router/manager contracts). Total suite: **803 tests, all passing**.

**Explicitly N/A by design (documented for completeness):** `/help` (the dashboard IS the help), `/config-show` (the Overview + every module shows the config), `/edit-message` (the General module's textareas are the modal's better twin), `/embed-list` & `/embed-cancel` (the web sends embeds directly — no sessions exist to list or cancel), `/rank` & `/my-stats` & `/afk` (per-member personal views; the admin sides — /afk-list, /afk-clear, leaderboards — are all on the web).

**Verification:** `npm test` → 803/803 (was 793; +10 new parity tests, count assertions in 5 files updated 93→94), `npx tsc --noEmit` clean, ESLint 0 errors, `npm run build` (dashboard standalone) complete. One bug caught by the new contract tests during development: `updatePanel` was destructured from `_shared` before being exported (now fixed) — the sharedExports guard proved its worth again.

## [3.25.0] — 2026-09-17

### Changed — 🧭 SIDEBAR NAVIGATION — SIDE MENU ON EVERY SCREEN, BUILT FOR MOBILE & DESKTOP

Owner's request: *"I want the menu moved to the side instead of the top so it's tidy and easy to access. Make the UI as optimal as possible for mobile and desktop — user-friendly enough that every visitor understands it immediately without long explanations."* The module menu now lives on the side on every device: a permanent left sidebar on desktop and a slide-in drawer behind the ☰ button on mobile. The old mobile experience — a horizontal pill strip at the top of the page that had to be swiped sideways, with no grouping and no search — is gone.

**One menu, two shells (new `side-nav.tsx`):**

- 🟢 **Desktop (lg+): permanent full-height left sidebar** — the module list is always visible, exactly where the eye expects it. The page no longer needs a top header: the server identity, search, and refresh all moved into the sidebar, giving the content the full viewport height.
- 🟢 **Mobile: ☰ → slide-in drawer** — the header keeps only what matters on a small screen (menu button, server avatar + name, refresh) and shows the **active module name** as the subtitle so you always know where you are while scrolling. Touch targets in the menu are ≥40px tall.
- 🟢 **Live module search** — with 25 modules the fastest way to jump: type "give" → the list filters to Giveaway instantly, with a ✕ clear button and a friendly empty state. Works in both the desktop sidebar and the mobile drawer.
- 🟢 **Grouped, self-explanatory menu** — SERVER / PROTECTION / COMMUNITY / TOOLS sections with an icon + full text label on every entry (no icon-only guessing), an amber highlight + left accent bar on the active module, the server identity (icon, name, member count) pinned above the list, an explicit "← All servers" escape hatch at the top, and a "Refresh data" footer button.
- 🟢 **Breadcrumb above the module title** — the group name (e.g. PROTECTION) now appears above the page title, and the sidebar/drawer selection matches it, so orientation survives even with the drawer closed on mobile.

**Safety & accessibility:**

- 🟡 **Refresh & "All servers" now confirm before discarding unsaved changes** — both are SPA-side navigations that `beforeunload` cannot intercept, and the old refresh silently threw the draft away. Now: `You have N unsaved changes — refreshing will discard them.`
- 🟢 **Drawer a11y done right** — `aria-expanded`/`aria-controls` wiring, `role="dialog"` + `aria-modal`, Escape closes, focus moves into the drawer on open and returns to the ☰ button on close, and the closed drawer is `inert` (invisible to keyboard/screen readers, `pointer-events` off) while still animating smoothly in/out via transforms.
- 🟢 Content scrolls independently of the sidebar (`overscroll-contain`, `100dvh` app shell — no more rubber-banding the whole page on iOS), the SaveBar and toasts layer correctly above/below the drawer, and the empty `aria-controls` reference found during verification was fixed.

**Verification:** full browser walkthrough on the production standalone build against the mock DASH API (desktop: module switching, search filtering; mobile: drawer open → search → select Middleman → drawer auto-closes + title switches to "Middleman / Escrow", Escape close; screenshots in `download/ui-*.png`). TypeScript, ESLint, the dashboard production build, and the full bot test suite (793) all pass. No bot-side changes — dashboard-only release.

## [3.24.4] — 2026-09-17

### Added — 🌐 FULL SLASH-COMMAND PARITY FROM THE WEB — THE COMPLETE AUDIT

Owner's request: *"where is the Restore menu? Give me a restore for messages too, like /reset-message — and if possible make ALL slash commands accessible from the web dashboard. Do a full audit."* A complete audit of all 93 registered commands against the dashboard found every CONFIG command was already 100% manageable from the web (v3.24.0), and this release closes every remaining ACTION gap. After v3.24.4, every admin-capable slash command has a web twin. Only personal commands stay Discord-only by design: `/help`, `/afk` (set your own status), `/rank`, `/my-stats`.

**New web capabilities (9 new DASH API endpoints + UI):**

- 🟢 **Reset Messages (parity with `/reset-message`)** — the General module now has a "Reset Messages to Default" section: reset the welcome, goodbye, or ticket message group (or ALL of them) back to the exact factory text in one click, audit-logged. Previously a mis-edited message had to be rebuilt by hand.
- 🟢 **Danger Zone — Full Reset (parity with `/reset-config`)** — the same 2-step protection as the slash command: type `RESET` to enable the single red button. Rebuilds the config from factory DEFAULTS and refreshes the whole dashboard.
- 🟢 **Test Booster (parity with `/test-booster`)** — a "Test Booster (add)" button in Test Automated Messages: pure simulation by default (channel + permission + role-chain diagnostics, nothing recorded), or flip "Deliver to the booster channel" for the full end-to-end delivery test using the same builders as the live boost event.
- 🟢 **Moderation module reworked — every moderation command now works from the web:**
  - **Take Action** form: warn (with the same auto-action thresholds — 3=timeout 1h, 5=timeout 1d, 7=kick), timeout, untimeout, kick, ban (with the 0–7 day message-delete option), and unban by ID. All the same guards as Discord: role hierarchy (actor vs target vs bot), self/bot protection, and bot permission checks. Every action lands in the moderation history + audit log, and DMs the member (kick/ban) with a "DM not delivered" warning when closed.
  - **Purge Messages**: channel picker + amount (1–100) + optional per-user filter — the same 14-day bulk-delete limit handling as `/purge`.
  - **Warn management**: each warn in the list now has Remove (with confirm) and Clear-all-per-user buttons (parity with `/warn-remove` / `/warn-clear`).
- 🟢 **Send Message module (NEW, Tools group — parity with `/send-message`)** — send plain text as the bot to any channel: channel picker, the strict mention whitelist (no @everyone/@here/role mention injection — only the exact validated formats), a live 2000-char counter, and `\n` newline support. Complements the Embed Builder, which handles embeds.

**Audit results (93 commands → web coverage):**

- ✅ 89 admin commands: ALL now fully manageable from the web (config + view + actions).
- ℹ️ 4 personal commands stay Discord-only by design (`/help`, `/afk`, `/rank`, `/my-stats`) — they act as the invoking member.
- ℹ️ `/list-messages` + `/config-show` are inherently covered — the dashboard IS the live config view.

**Tests:** 14 new endpoint tests (793 total, all passing) — messages/reset (group + ALL + invalid type 400), config/reset (confirm required + full rebuild), warn (hierarchy guard both ways, validation, count), warns/remove + clear (incl. unknown warn 404), send-message (5 guard paths + valid mention), booster-test (simulation + live + broken channel 422), moderate (timeout bounds, self-hierarchy 403, unban 404/200, unknown action/member), purge (4 validation paths + a real filtered bulk delete).

## [3.24.3] — 2026-09-17

### Added — ♻️ /restore-category — THE DISCORD-SIDE TWIN OF THE DASHBOARD'S "RESTORE" MENU

Owner's request: *"make a restore menu on the web AND a slash command."* The web side already existed since v3.24.2 (the "Restore" dropdown in Ticket Categories); this release adds its Discord twin + a one-click "Restore all" on both sides.

**New slash command:**

- 🟢 **`/restore-category id:<transaction|help|report|claim_giveaway|midman|all>`** — brings a deleted built-in category back **exactly as it shipped** (same id / emoji / label / style / requiresKey as a fresh install) instead of rebuilding it by hand with `/add-category`. The `id` option is a **choice dropdown** (no typos possible), and **`all`** restores every missing built-in in one command.
- 🟢 **Symmetric with the web:** restoring clears the dismissal flags (`claimGiveawayDismissed` / `midmanCategoryDismissed`) so `getConfig()`'s migration keeps the category after restarts — delete stays deleted, restore stays restored (no see-saw, both directions covered by tests).
- 🟢 Guard rails: a custom id is rejected with a clear message (custom categories cannot be restored — rebuild them), an already-present built-in replies "nothing to restore" without touching the config, and the 25-category Discord limit is enforced on both the single and `all` paths.
- 🟢 Audit trail: every restore logs a `RESTORE_CATEGORY` entry (single or the full list).

**Dashboard (web):**

- 🟢 The "Restore" dropdown now offers **"♻️ Restore all (N)"** when more than one built-in category is missing — parity with `/restore-category id:all`.

**Under the hood:**

- 🟢 `configManager.getBuiltInCategories()` — the factory list (cloned per access, mutation-proof) is now the single source of truth for both the Discord command and future consumers; the dashboard keeps its typed copy pinned by a test.
- 🟢 `/help` (categories section, both the compact All-Commands listing and the full detail guide) now documents `/restore-category`. The compact listing was kept inside the strict 5,800-character All-Commands budget (20/20 categories still listed).

**Tests:** 10 new regression tests (779 total, all passing) — registry/router contracts (6 choices incl. `all`), factory-definition restore for midman & claim_giveaway with flag clearing + cold re-read stability, `id:all` (all 5 built-ins, no duplicates, custom categories untouched, both flags cleared), nothing-to-restore info path, custom-id rejection, 25-limit refusal, and `getBuiltInCategories` mirroring `DEFAULTS`.

## [3.24.2] — 2026-09-17

### Fixed & Improved — 🎨 DASHBOARD UX PASS: TICKET CATEGORIES REWORK + BRAND CLEANUP

Owner's request: *"fix all bugs; make the web dashboard more user friendly; remove every word related to a certain third-party bot brand (no brand sponsorship); make the 'built-in' label one line; and make the bot's default categories (middleman etc.) deletable from the web."*

**Ticket Categories & Products (dashboard):**

- 🟡 **Orphaned products when a category is deleted from the web (parity bug):** `/remove-category` (Discord) remaps products of the deleted category to `transaction`, but the web path never did — deleting a category from the web left its products invisible in every panel dropdown. The DASH API config validator now applies the exact same rule (fallback: `transaction`, or the first remaining category if `transaction` itself was deleted), and the dashboard draft applies it too so what you see is what gets saved.
- 🟢 **"Built-in" badge is now a single line** (`whitespace-nowrap` + `shrink-0` on the Pill component — it used to wrap to "built-"/"in" in narrow columns).
- 🟢 **Category cards reworked for clarity:** every input now has a label (Emoji / Label / ID / Button color) instead of five unlabeled fields; the decorative drag-grip (which implied drag-and-drop that never existed) is replaced by real Move up / Move down buttons that change the panel button order.
- 🟢 **Deleting a built-in category (transaction / help / report / claim giveaway / midman) now asks for confirmation** and explains that it stays deleted — this capability existed at the API level (the dismissed flags are synced so `getConfig()` never resurrects the category) but the UI never communicated it.
- 🟢 **New "Restore" menu** in the Ticket Categories header: re-add any deleted built-in category exactly as it shipped (same id / emoji / style) in one click, instead of rebuilding it by hand.
- 🟢 **Product cards also got labels + a delete confirmation**, and the key/delivery toggle explains what it does on hover.

**Dashboard (general UX):**

- 🟢 **Unsaved-changes guard:** closing or reloading the tab with a dirty draft now shows the browser's "Leave site?" confirmation instead of silently throwing the changes away.

**Brand cleanup:**

- 🟢 **Every reference to the old third-party bot brand removed** (user-facing strings first: landing page, module descriptions, autorole/embed/command-manager hints, SEO title/keywords, the `/commands` slash-command description, `/set-autorole list` output, `/help` catalog — then comments, docs, package.json descriptions, and test titles). Markdown anchors that contained the old word were updated so the ADMIN_GUIDE table of contents still links correctly.

**Tests:** 3 new regression tests (769 total, all passing) — web deletion of `claim_giveaway`/`midman` sets the dismissed flags and the categories stay deleted on a cold re-read; re-adding clears the flag; orphaned products fall back to `transaction` (including when `transaction` itself is deleted).

## [3.24.1] — 2026-09-17

### Fixed — 🔍 FULL-CODEBASE DEBUGGING PASS (766 tests, +26 regression tests)

Owner's request: *"please read and debug all my code on GitHub."* A complete review of the bot (`index.js`, `src/**`), the dashboard (`dashboard/src/**`), and the tests — every finding below was verified against the live code before fixing. All 740 existing tests keep passing; 26 new regression tests lock the fixes in.

**Security:**

- 🔴 **DASH API cross-guild IDOR (H1):** the self-role panel + scheduled-announcement endpoints resolved objects **by ID only** — an admin of guild A could add a privileged role to guild B's panel (the panel ID is printed in the panel message footer) and then claim it via the panel click in guild B. Every endpoint (`POST/DELETE /selfroles/:panelId/roles`, `DELETE /selfroles/:panelId`, `DELETE /announce/:annId`) now verifies the object's `guildId` matches the URL guild → 404 otherwise.
- 🔴 **Dashboard: forgeable session tokens when `SESSION_SECRET` is empty (1.1):** an empty HMAC key is deterministic and publicly computable — a forged `{uid, exp, p:{isAdmin:true}}` token gave full account takeover while OAuth was configured but the secret was not. `sign()` now refuses (fail-fast, loud error with the fix command) when OAuth is ready and the secret is empty; existing tokens fail closed (logged out); the OAuth callback surfaces `konfigurasi_tidak_aman` instead of a 500.
- 🟠 **Dashboard: OAuth tokens leaking into stdout (7.1):** Prisma `log: ['query']` printed SQL with bound parameters — including the User row's live Discord `accessToken`/`refreshToken` — on every login/refresh. Query logging is now development-only.
- 🟡 **DASH API: unauthenticated URL-parse crash (M1):** a malformed absolute-form request target made `new URL()` throw BEFORE the auth check → unhandled rejection + a hung socket until the 300 s request timeout. Now a clean 400 (verified with a raw-socket probe).
- 🟡 **Dashboard: OAuth state cookie now `Secure` in production (1.3)**, consistent with the session cookie.

**Bot correctness:**

- 🟠 **Self-role exclusive select bypassed the prerequisite (H-1):** the exclusive branch of `handleSelfRoleSelect` enforced neither the panel-membership check nor `requiresRoleId` — a member could pick a conditional role from an exclusive dropdown without meeting its prerequisite (and a forged value could grant any role ID). Both guards now match the button path.
- 🟡 **Spam threshold off-by-one (6a):** `checkSpam` compared `> threshold` — with the documented default 5, the SIXTH message was flagged. Now trips exactly at N messages in the window, matching the option description; the codified-bug test was updated.
- 🟡 **Monthly recurrence drift (4a):** `setMonth(+1)` overflowed — an announcement scheduled Jan 31 ran Mar 3, Apr 3, May 3… forever, never returning to the month-end. Entries now carry `monthlyDay`; the next date is built from components and clamps only in short months (Jan 31 → Feb 28 → Mar 31; Dec 31 → Jan 31 next year). Legacy entries clamp from the current date.
- 🟡 **`parseTime` rejected documented combined units (4b):** `1h30m` (documented since v3.9.1) failed the single-unit regex. Combined `Nd Nh Nm` now works (`1d12h`, `2d5h30m`), single units unchanged, `0h0m` → invalid.
- 🟡 **`/setup-selfrole` zombie panel (M-1):** `createPanel()` persisted BEFORE the embed build — a title > 256 chars (Discord accepts up to 6000 in options) made `buildPanelEmbed` throw → permanent zombie entry. The build is now inside the rollback try/catch + the registry options carry `max_length` (256/4000), and `buildPanelEmbed` clamps a very long panel description that used to make the truncation math go negative.
- 🟡 **List commands dead at legitimate data volumes (M-2):** `/list-products` (~15-18 full products), `/list-responder` (~32), `/selfrole-list` (~5 populated panels) exceeded the 4096 embed description limit → `setDescription` threw → the command was dead until data was removed. New shared helper `joinCappedLines` caps the list with a "+N more" suffix (same pattern as the earlier `/config-show` fix).
- 🟡 **DASH API automod audit trail always logged "unknown" (L1):** the actor was deleted from the body before the log line read it from a field that never existed. Captured up front now.
- 🟡 **Ticket close: unguarded `interaction.channel.id` after `deferUpdate` (L-1):** a channel deleted by another admin during the await crashed the close flow; now guarded with an explicit "channel no longer exists" reply.
- 🟢 **Midman `cancel` is now announced in the deal channel (L-2)** — it was the only transition without a public notice in the transcript.
- 🟢 **Poll emoji from the web validated up front (L3)** with `isValidEmoji` → a clear 400 instead of a misleading 502 "check bot permissions" at send time; keycap sequences (`1️⃣`, the default) are now correctly recognized as valid emoji.
- 🟢 **Oversized DASH API bodies now get a real 413 (L2)** instead of a destroyed socket ("socket hang up" on the client).
- 🟢 **Surrogate-pair-safe truncation (L4/L5):** server-log `snip` + embed field slicing, audit-log details, and the temp-voice channel name all route through `truncateUtf8Safe` — an emoji at the cut boundary no longer kills the whole log entry or the room creation.
- 🟢 **Self-role select menu capped at 25 options (builder)** — matching the button path (legacy/edited data with >25 roles no longer breaks the panel render).

**Dashboard correctness:**

- 🟠 **Auto-Role editor corrupted its own draft (5.1):** `setConfig("autorole", array)` replaced the draft's `{roleIds, removeOnNewRole}` OBJECT with a plain array → the chips list instantly reset, the toggle displayed wrong, and a second Add silently dropped the first role. New dedicated `setAutoroleRoleIds` setter writes `autorole.roleIds` to the draft while queuing the whole-array wire update the bot expects.
- 🟡 **Demo mode was unreachable (5.4):** `onLoginDemo` was declared in the landing props but never rendered — while OAuth was unconfigured, the only login button redirected to Discord with an empty `client_id` (broken error page). The hero now swaps to "Explore in Demo Mode" when OAuth isn't ready (+ a "Try Demo" secondary button when it is), and `/api/auth/discord` redirects back with a clear error banner instead of leaving Discord.
- 🟡 **Dead spinners on failed boot fetches (5.3):** `/` and `/app` left the user on "Preparing the dashboard…"/"Loading your servers…" forever when `/api/me` or `/api/guilds` failed (plus unhandled rejections). Both pages now show an error state with a Retry button; offline logout still redirects.
- 🟢 **`UserDelegate.findUnique` type accepts `select`** — fixes the TS2353 in `discord-guilds.ts` (the runtime always supported it).
- 🟢 **Removed the dead `tailwind.config.ts`** (Tailwind v3 leftover importing the uninstalled `tailwindcss-animate` — the project is on Tailwind v4 via CSS; the file caused the only two `tsc` errors).
- 🟢 **Unused `saveConfig` import removed from `panels.js`.**

## [3.24.0] — 2026-09-16

### Added — 📊 FULL DASHBOARD PARITY: PICKER-BASED MENTIONS + STATISTICS & AFK MODULES + ALL VIEW DATA ON THE WEB

Owner's request: *"add an optional select-role mention to the announcement and embed builder so I don't have to type role IDs. Also badwords aren't in the dashboard — check every command so we can manage everything from the dashboard, like the big bots."* Audit of the 92 slash commands: **every setting (config) was already 100% manageable from the web** — including badwords (AutoMod module → the "Word Blocking" section, present for a long time; the page used to crash due to the v3.23.1 bug, which made it look missing). What was missing were the VIEW/operational features. This release closes all of those gaps + replaces every "paste the ID manually" input with a dropdown picker.

- 🟠 **`MentionSelect` (NEW):** a mention dropdown — No mention / @everyone / @here / the server's role list — used by the **Announcements** module (replacing the manual `<@&id>` text input) and the **Embed Builder** (the mention is merged into the outer text on send + appears in the preview). Deleted roles stay visible as an explicit option so the old state doesn't silently disappear.
- 🟠 **STATISTICS MODULE (NEW, Server group):** server aggregates (tracked members, total messages, purchases, revenue, giveaways won) + a **4-metric leaderboard** (messages / purchases / spending / giveaway wins) + the **booster list** (active + recent activity) — exactly the same data as `/stats`, `/leaderboard`, `/boosters`.
- 🟠 **AFK MODULE (NEW, Community group):** the AFK members list + a **Clear** button per member (parity with `/afk-list` + `/afk-clear`) — new DASH API endpoint `DELETE /guilds/:id/afk/:userId`.
- 🟡 **Middleman:** the module now shows **Active Deals** — channel, state, buyer⇄seller, item, the buyer's total (price+fee) — parity with `/midman-deals`.
- 🟡 **Leveling:** the module now shows the **Leveling Leaderboard** (top 10 by total XP + level) — parity with `/leaderboard-level`.
- 🟡 **General:** **Test Welcome / Test Goodbye** buttons — send the REAL embed (the same builder as the genuine join event) to the configured channel + permission diagnosis, using your own data as "the new member" — parity with `/test-welcome`. New DASH API endpoint `POST /guilds/:id/welcome-test`.
- 🟡 **AutoMod:** the "Link-Allowed Channels" & "Link-Allowed Roles" whitelists are now **dropdown pickers + chips** (with channel/role names) — replacing the TextArea that asked for one ID per line.
- 🟢 **Dashboard payload:** + `stats` (aggregates + 4 top-10s), `levelTop`, `afk`, `midmanDeals` (slim + fee totals), `boosters` (live from the guild cache + recent events) — all read-only, slim shapes, guarded for partial guilds; defensively normalized on the web so an older bot never crashes the dashboard.
- 🟢 Tests: **740** (from 736) — VIEW payload (shape & types), welcome-test success/400/422, DELETE afk (200/404 + gone from the payload); the dev mock API follows the new shape. Dashboard 20 → **22 modules**.

## [3.23.1] — 2026-09-16

### Fixed — 🔴 WEB OVERVIEW & AUTOMOD PAGES CRASH FOR SERVERS THAT NEVER CONFIGURED AUTOMOD

Owner's report: the dashboard's **Overview and AutoMod** pages showed *"This page couldn't load"* for servers that had never touched the AutoMod settings. Root cause: `automodManager.getGuildConfig()` returns **null** for a guild with no saved config, and the `GET /guilds/:id/dashboard` payload passed `automod: null` straight through — the web pages then read `.enabled`/`.wordRules` off null → browser exception. Other modules were unaffected because only Overview & AutoMod read `draft.automod`; the dev mock API always sent a full object, so tests never caught it.

- 🔴 **DASH API:** the dashboard payload now sends a **default-object fallback** (enabled=false, empty wordRules/exemptWords arrays, etc.) when the guild has no automod config — honest about the real behavior (fresh guild: automod is indeed inactive, not the default enabled=true). The Overview & AutoMod pages load immediately.
- 🟡 **Dashboard (defense in depth):** `GuildDashboard` normalizes the payload after fetch — a null `automod` is filled with defaults, non-array `responders`/`selfroles`/`announces` become `[]` — so the dashboard never crashes even if the bot still runs an older version.
- 🟢 Tests: **736** (from 735) — a new test asserts a fresh guild's automod payload is always an object (not null), enabled=false, with complete arrays.

## [3.23.0] — 2026-09-15

### Changed — 🎭 UNIFIED AUTO-ROLE: THE UNVERIFIED ROLE CONCEPT IS REMOVED — JUST A JOIN LIST + ONE TOGGLE

Owner's request: *"don't set an unverified role — just use auto-role on join, plus a toggle for the role to disappear when there's a new role."* Two separate settings (the `/set-autorole` list + the `/set-role unverified` marker) are now ONE: a "new-member marker" role simply goes into the auto-role list, and the toggle decides whether join roles are temporary or permanent.

- 🟠 **`/set-autorole action:toggle` (NEW, + `enabled` option):** turns **"remove join roles when the member gets another role"** on/off. While ON: EVERY join role the member holds is stripped automatically the moment they receive ANOTHER role — self-role panels, level-up rewards, VIP purchases, boosts, manual admin grants, even other bots (silent + the standard ROLE_UPDATE server log). While OFF (default): join roles are permanent, . Without the `enabled` option → the value is flipped (on↔off in one keystroke). `action:list` now shows the toggle state.
- 🟠 **THE UNVERIFIED ROLE CONCEPT IS REMOVED EVERYWHERE:** the `unverified`/`verified` choices in `/set-role` & `/remove-role` are gone; `roles.unverified` is cleaned automatically from old configs on load (the v1 `unverifiedRoleId` is no longer mapped either); the v3.22.0 universal-marker rule is replaced by the toggle rule above; `joinRoleIds()` = purely `autorole.roleIds`; `/config-show` no longer shows an Unverified line. **Migration for live servers:** put your old marker role (e.g. @Unverified) into `/set-autorole action:add`, then run `action:toggle` — the old behavior is preserved exactly.
- 🟡 **DASH API:** `PUT /guilds/:id/config` accepts the new path **`autorole.removeOnNewRole`** (boolean; 422 when not a boolean); whole-array `autorole` sets now MERGE (not replace) — both paths can arrive in one PUT without losing the toggle; `roles.unverified`/`roles.verified` are rejected with a **422 pointing to the replacement** (stale dashboards no longer save values that get silently cleaned).
- 🟢 **Dashboard:** General module — the Auto-Role on Join editor gains the **"Remove join roles when the member gets another role"** toggle and loses the Unverified role field; Quick Start Step 2 = "Auto-Role on Join" (role form + toggle applied instantly); the module overview & landing feature cards updated; the dev mock API follows.
- 🟢 **v3.22.0 leftover cleanup:** the `Verify Title`/`Verify Body` choices in `/set-message`, `/list-messages`, `/reset-message` (and the message-edit modal) are gone — those keys are auto-cleaned anyway, so offering them only misled admins.
- 🟢 Tests: **735** (from 727) — `unifiedRoles.test.js` rewritten for the toggle semantics (7 rule scenarios including the join exemption, boost, multi-role, toggle off), 2 `/set-autorole action:toggle` tests, 4 new DASH API tests (boolean valid/invalid, 422 roles.unverified, combined array+toggle PUT), anti-regression PINs updated.

## [3.22.0] — 2026-09-15

### Changed — 🎭 ONE UNIFIED ROLE SYSTEM: Unverified marker + auto-role on join + self-role panels

The three "ways to get a role" (verification, self-role, join auto-role) were systemically the same feature implemented three times. They are now ONE system: **every role grant flows through the Role Engine, and verification is simply "receiving your first role" — from any source.**

- 🟠 **UNIVERSAL UNVERIFIED RULE:** a member holding the **Unverified marker role** (`/set-role unverified`) is automatically unmarked the moment they receive **any other role** — a self-role panel click, a level-up reward, a VIP purchase, a boost, an admin granting it manually, or even another bot. Silent removal + the standard ROLE_UPDATE server log (admin's choice). Roles the system itself grants at join are exempt, so `@Member + @Unverified` at join doesn't "verify" everyone instantly.
- 🟠 **`/set-autorole` (NEW, ):** manage the roles granted automatically to every new member (`action:add / remove / list`, max 10, same validation as `/set-role`). The Unverified marker is granted on join on top of this list.
- 🟠 **`src/services/roleEngine.js` (NEW):** the single gateway for every role grant/revoke — @everyone / managed / hierarchy checks, idempotency, batch-with-per-role-retry, structured results, actionable failure logs. Migrated call sites: join auto-role, self-role buttons & selects, level-up rewards. (Booster/VIP/product flows keep their hardened custom logic by design.)
- 🟠 **THE DEDICATED VERIFICATION FEATURE WAS REMOVED** (admin's decision — "verified is just another role on a self-role panel"): `/setup-verify`, `/set-verify-button`, the `btn_verify` handler (now a deprecation stub that guides admins to `/setup-selfrole` + `/selfrole-add`), `POST /guilds/:id/verify-panel` on the DASH API, and the `verifyButton`/`verifyTitle`/`verifyBody` config (auto-cleaned from old configs on load; `roles.unverified` stays as the marker). **Migration for existing servers:** create a self-role panel and add your Verified role to it — 2 commands, detailed in the stub reply and in `/help`.
- 🟢 **Dashboard web parity:** Quick Start step 2 is now the Unverified marker, step 5 links to the Self Roles module (replaces "Install Verification"); the General module gained an **Auto-Role on Join** list editor and lost the verify-button section; `PUT /guilds/:id/config` accepts `autorole` as a whole array; the landing feature card was updated.
- 🟢 Default welcome text: "Please verify yourself" → "Pick up a role to gain full access" (verification is no longer button-based).
- 🟢 Tests: **727** (was 698) — new `tests/unit/unifiedRoles.test.js` (engine behaviors, the universal rule incl. join-exemption & boost counting, join grant, `/set-autorole` add/remove/list, the stub, anti-regression pins).

## [3.21.2] — 2026-09-15

### Fixed — 🟠 EDITING `.env` AFTER A BUILD NOW WORKS WITH A PLAIN RESTART

- 🟠 **`dashboard/scripts/start-server.mjs`:** the script now loads `dashboard/.env` into `process.env` before starting the standalone server. Until now the standalone server only read the `.env` **copy baked into `.next/standalone/` at build time**, so editing `dashboard/.env` (e.g. `PUBLIC_ORIGIN` after moving to a domain — real case: OAuth `redirect_uri` kept pointing at the old address and login failed with `DNS_PROBE_FINISHED_BAD_CONFIG`) had **no effect until a full rebuild**. Values already exported in the shell still take precedence; @next/env never overrides variables already in `process.env`, so the fresh file always wins over the stale build-time copy. Verified end-to-end: build with a stale `PUBLIC_ORIGIN`, edit the file, restart → `[oauth] redirect_uri=` immediately reflects the new value.

## [3.21.1] — 2026-09-15

### Added — 📱 TERMUX/ANDROID SUPPORT: BOT + DASHBOARD RUN ON YOUR PHONE

The web dashboard can now be built and run directly on an Android phone via Termux — no VPS needed. Detection is automatic via `process.platform === "android"`, no extra configuration.

- 🟢 **`dashboard/scripts/build.mjs`** replaces the shell build script: on Android the build automatically uses **Webpack** (`next build --webpack`) because Turbopack needs native binaries unavailable for android/arm64; Linux/VPS keeps Turbopack. Copying `static`/`public` into standalone now uses `fs.cpSync` (no more `cp -r`).
- 🟢 **`dashboard/src/lib/db.ts`:** on Android, dashboard user storage automatically switches to a **JSON file** (`db/custom-users.json` — same interface: findUnique/create/update/upsert/count, atomic writes) because the Prisma engine needs glibc binaries that cannot be loaded on Android (bionic libc). Other platforms keep Prisma SQLite — **zero behavior change**.
- 🟢 **`dashboard/scripts/start-server.mjs`:** `prisma db push` is skipped automatically on Android (not needed — JSON storage has no schema).
- 🟢 **`dashboard/scripts/dev.mjs`:** `next dev` with a `--webpack` fallback for Termux.
- 🟢 **DEPLOY.md:** new section **"Running on an Android phone (Termux)"** — install steps, `termux-wake-lock`, battery optimization, Termux:Boot, and tunnel access.

## [3.21.0] — 2026-09-15

### Added — 🚀 QUICK START MODULE: SERVER SETUP STRAIGHT FROM THE WEB (MIRRORS THE /HELP CATEGORY)

Exactly the concept the user asked for: "on the web there's a quick start slash command category, you configure it right on the web — e.g. add role gets a text field to enter the role ID to register". The new **Quick Start** dashboard module turns the 🚀 Quick Start category from `/help` into a 6-step setup checklist — every step has a live form on the web, and the bot applies it to the Discord server instantly, no slash commands needed.

- 🟢 **6-step checklist with a progress bar (X/6)**: 1) Bot Admin Role — *pick from the list OR paste the role ID into the text field* (`≙ /set-role admin`), 2) Verified Role — same (`≙ /set-role verified`), 3) Ticket Categories & Products + a quick add-product form (`≙ /add-product`), 4) Install Ticket Panel — pick channel + buttons/dropdown layout (`≙ /setup-ticket-panel`), 5) Install Verification Panel (`≙ /setup-verify`), 6) Server Log Channel (`≙ /set-channel server-log`). Each step's status (✓ done / pending) and progress are computed automatically from the bot's data.
- 🟢 **Manual ID text fields beside every dropdown** (the heart of the request): paste a role/channel ID (Developer Mode → Copy ID) to register roles that don't even show up in the list; snowflake validation on the web + always re-validated by the bot. Quick-pick dropdowns remain for convenience.
- 🟢 **Every action takes effect IMMEDIATELY** (call → refresh, no SaveBar): click "Register"/"Install" → the bot writes the config / sends the panel to the Discord channel within seconds — the confirmation toast names the target channel ("Ticket panel installed in #xxx — check Discord").
- 🟢 **Auto-landing**: servers that aren't set up yet (no admin role & no products) open straight into the Quick Start module — new admins don't have to hunt for it; ready servers still land on Overview.
- 🟢 **"Next steps" section**: shortcuts to 8 other modules (Server Stats, Leveling, Temp Voice, Auto-Responder, Self Roles, AutoMod, Giveaway & Poll, Embed Builder) — the web connects ALL slash command categories, not just quick start.
- 🟢 **New DASH API endpoints**: `POST /guilds/:id/panels` (install ticket panel — full parity with `/setup-ticket-panel`: roles.admin + non-empty categories prerequisites, the same `buildTicketPanel` builder, render-first + P0-5 rollback, the panel is recorded in `panels.json` so `/update-panel`/`/refresh-panel` work on it) and `POST /guilds/:id/verify-panel` (parity with `/setup-verify`: identical embed + button rendering from the same config). The dashboard payload now includes `panels` (slim shape without the 4000-char body).
- 🟢 **General module completed**: Server Log, Booster, and Transcript channels can now be set from the web (previously slash-command only) — full parity with the "Log & Channel" category.
- 🟢 **Tests & tooling**: 5 new dashServer unit tests (422 prerequisites, 201 success, 400 unmatched categoryIds, panel recorded + slim shape) — 698 tests passing in total; smoke test `scripts/smoke-v321.mjs` for the mock DASH API; the mock supports the new endpoints + seeds `panels: []`; `scripts/dev-sandbox.cjs` (full dashboard preview without real OAuth — Discord API interceptor + sandbox env, active ONLY via an explicit `--require`).

### Changed
- 🟢 Dashboard sidebar: new "Quick Start" module (Server group, second position after Overview) — 20 modules total.
- 🟢 `dashboard/package.json` now carries the monorepo version (3.18.0 → 3.21.0) so web & bot versions always stay in sync.

## [3.20.0] — 2026-09-15

### Added — 🪄 CUSTOM COMMANDS FROM THE WEB + FULL EMBED BUILDER (BUILD ON THE WEB, DELIVERED TO THE SERVER)

: admins can now CREATE content on the web dashboard and the bot delivers it to the server — custom commands become REAL slash commands, embeds are built in full with a Discord-style live preview.

- 🟢 **Custom Commands (new dashboard module, 18 → 19)**: build your own slash command on the web — name, description, text + embed reply, ephemeral option. Once saved, the command is **automatically registered on Discord** (per-guild registration via `guild.commands.set`, appears within ± 1 minute) and every member can use it. Max 20 per server; names must not collide with built-ins; all validation centralized in `customCommandManager`.
- 🟢 **Automatic two-way sync**: web create/update/delete → Discord registration refreshed instantly (`customCommandSync.js`); startup syncs too (anti-drift after a backup restore). Single-server mode: customs merge with built-ins on the primary guild; public mode: customs register per-guild (built-ins stay global).
- 🟢 **Command Manager parity**: custom commands appear in the web Command Manager list AND `/commands toggle` on Discord — temporarily disable them from either side (`normalizeDisabledList` now accepts that guild's custom names).
- 🟢 **Full Embed Builder (Embed module upgrade)**: complete parity with `/embed-builder` — text outside the embed, author (name + icon URL), title, color, **fields** (add/remove/reorder/inline 3-per-row, max 25), thumbnail, image, footer (text + icon), timestamp. **Live preview mimics Discord chat** (bot avatar, BOT badge, side color, inline field layout) — admins see exactly what will be sent.
- 🟢 **Centralized embed validation** (`embedPayload.js`): every Discord API limit enforced in ONE place (title 256, description 4096, footer 2048, fields 25×(256/1024), total 6000, http/https URLs) — shared by the web embed endpoint, custom commands, and the router — web and Discord can never disagree about the rules.
- 🟢 **New DASH API**: `POST /guilds/:id/custom-commands` (upsert + sync), `DELETE /guilds/:id/custom-commands/:name` (delete + sync); `POST /guilds/:id/embed` now accepts the full shape (`content` + `embed` object — legacy flat fields still compatible). Dashboard payload gains `customCommands` (full definitions) + custom entries in `commands.list`.
- 🟢 **`data/customCommands/<guildId>.json`** per-server storage (15s read-through cache, responderManager pattern); **included in backup/restore** (`FILES_TO_BACKUP` + post-restore cache invalidation — without this a restore would silently delete every custom command).

### Changed

- 🟢 Unit tests 670 → **693** (23 new: embed caps/URL/total validation, upsert/delete/guild isolation, normalizeDisabledList parity); landing page 16 → **18 module cards** (Embed Builder + Custom Command).

## [3.19.0] — 2026-09-15

### Added — 🧩 COMMAND MANAGER + 18 DASHBOARD MODULES (WEB = DISCORD, PICK EITHER)

Every slash command can now be managed from the web OR Discord — both write to the same config. Plus 7 new dashboard modules.

- 🟢 **Command Manager**: enable/disable **each slash command per server**. From the web: a new module with search + per-domain groups + bulk group actions + "Enable All". From Discord: the new **`/commands list|toggle|enable-all`** command. Disabled commands are rejected by the router with a clear ephemeral message.
- 🟢 **Anti-lockout by design**: `/commands` is disable-proof (guarded in the handler, router, and DASH API validator — one shared `normalizeDisabledList` rule). The web dashboard can always re-enable things — admins can never lock themselves out of either interface.
- 🟢 **7 new dashboard modules** (11 → 18): **Backup** (create now + restore + two-step confirmation), **Moderation** (warn + moderator action history, read-only), **VIP Keys** (grant product keys — role + auto-expiry scheduling, parity with `/set-key`), **Giveaway** (create from the web, embed + Join/Leave buttons identical to the Discord version), **Embed** (send embeds + live preview), **Poll** (2-10 options + multi-vote), and the Command Manager itself.
- 🟢 **New DASH API**: `PUT /guilds/:id/commands`, `POST /guilds/:id/giveaway`, `POST /guilds/:id/poll`, `POST /guilds/:id/embed`, `POST /guilds/:id/backups` (+ `/:name/restore`), `POST/DELETE /guilds/:id/keys` — all strictly validated (product whitelist, snowflakes, character limits) with the actor recorded.
- 🟢 **Richer dashboard payload**: `commands` (93-list + disabled + protected from the registry), `giveaways`, `polls`, `backups`, `warns` (50 latest), `modlogs` (50 latest), `keys` (per guild).

### Fixed

- 🟡 **Silent data loss in the `products` validator**: `roleId` + `days` (set via `/set-product-role`) were STRIPPED every time the product list was saved from the web — auto-role mappings vanished silently. Both are now preserved + validated (roleId = snowflake, days = 0-3650).
- 🟡 **Dashboard build inside a repo with double parent .git** (Thor-EN/.git + my-project/.git): Turbopack failed to detect the workspace root → fixed with an explicit `turbopack.root` in `next.config.ts`.

### Changed

- 🟢 Registry 92 → **93 commands** (`/commands`); unit tests 639 → **670** (31 new: 19 DASH API endpoint tests + 12 command manager & router gate tests). Help lines compacted so the "All Commands" embed stays ≤ 5800 characters with all 20 categories intact.
- 🟢 Dashboard landing page: 12 → **16 module cards** ("All Modules" grid).

## [3.18.0] — 2026-09-14

### Added — 🌐 WEB DASHBOARD MOVED INTO THE BOT REPO (ONE REPO, ONE SETUP)

Monorepo: the web dashboard now lives in this repository's `dashboard/` folder — no more separate repo. Clone once → `./setup.sh` → `./start.sh` → the bot and the dashboard run together.

- 🟢 **`dashboard/` — Next.js 16 + TypeScript + Tailwind 4 + Prisma SQLite** (Discord OAuth2 login, server picker, 11 configuration modules: Overview, General, Tickets & Products, AutoMod, Leveling, Midman, Responders, Self-Roles, Announcements, Temp Voice, Server Stats; direct CRUD + a draft SaveBar). Fully translated UI, comments, and docs.
- 🟢 **Dashboard dependencies slimmed drastically:** 60+ → 12 runtime packages (fresh install: 419 packages, ~46 seconds); 44 unused boilerplate UI components removed (only accordion/badge/button/toast/toaster remain); the sandbox-only `/api/me2` workaround removed → plain `/api/me`; sandbox credential fallbacks emptied (safe for a public repo).
- 🟢 **Root convenience scripts:** `setup.sh` (install bot + web + prepare both `.env` files), `start.sh` (production: both in one run, Ctrl+C stops both), `dev.sh` (nodemon + next dev), `ecosystem.config.cjs` (pm2 `thor-bot` + `thor-dash` 24/7), plus npm scripts `dash:install/dev/build/start/mock`.
- 🟢 **DEPLOY.md rewritten as the ONE-repo guide** (VPS + pm2 + Caddy + OAuth + end-to-end verification + troubleshooting); README updated (v3.18.0 badge, folder structure, script table, monorepo dashboard section, fixed the clone URL to this repo).
- 🟢 **Bot & tests unchanged:** 92 commands, 639/639 unit tests still green; `DASH_API_TOKEN` in the bot's `.env` must match `dashboard/.env`.

## [3.17.0] — 2026-09-14

### Added — 🌐 DASH API FOR THE WEB DASHBOARD + VERSION ALIGNMENT WITH THE INDONESIAN REPO (BOT 100% FREE)

This English repo is now **feature-identical to the Indonesian repo at v3.17.0**. The Indonesian repo added a per-server premium subscription system in its v3.15.0 and then **completely removed** it in its v3.17.0 (the owner decided to make the bot 100% free) — that system never existed in this English repo, so there is nothing to remove here; the version number simply jumps to 3.17.0 so both repos stay in lockstep.

- 🟢 **`src/infra/dashServer.js` (NEW — ported from the Indonesian v3.16.0):** the bot now runs a small HTTP API (default `127.0.0.1:8788`) that the Next.js web dashboard reads/writes — **two ways to configure the bot: slash commands in Discord OR the web dashboard**, both writing to the SAME data source (`data/config/<guildId>.json` + the managers). Timing-safe token auth (`DASH_API_TOKEN` — without the token the server does not run, safe by default). GET `health` / `guilds` / `guilds/:id/meta` / `guilds/:id/dashboard` (the all-module payload in one pull), PUT `config` (dot-path updates with a section whitelist + type validation + prototype-pollution guard), PUT `automod` (a validated merge patch), CRUD `responders` / `announce` / `selfroles`, POST `serverstats/refresh`, DELETE `tempvoice`. Every write injects the web actor's identity (`{ id, tag }`) for auditing.
- 🟢 **Business validation stays in the bot** — the dashboard can never write a data shape that would be invalid via slash commands either (single source of truth).
- 🟢 **`index.js`:** `startDashServer(client)` at boot + `stopDashServer()` during graceful shutdown.
- 🟢 **`.env.example`:** the new `DASH_API_HOST` / `DASH_API_PORT` / `DASH_API_TOKEN` block.
- 🟢 **`/health` reports the version straight from `package.json`** — it can never go stale.
- 🟢 **+23 unit tests** (`dashServer.test.js` — auth 401, payloads, config valid/invalid/pollution, automod, responders 409, announce past-time 400, selfrole + rollback, 404). Total tests 616 → **639**.
- 🟢 **`DEPLOY.md` (NEW):** a step-by-step VPS deployment guide (Node 18+, pm2, invite URL, the public-mode checklist, backup & update).

### Compatibility

- **No breaking changes.** Without `DASH_API_TOKEN` set, the behavior is identical to v3.14.0 (the API server simply never starts).
- The server shop features (`/set-key`, products, tickets) are untouched — those are each server admin's own shop features, not a bot subscription.

## [3.14.0] — 2026-09-13

### Removed — 🗑️ SELF-SERVICE STOCK KEYS REMOVED (USER REQUEST)

The user's premium keys are **minted by their external VIP website** (used for web login) — bot-minted keys are worthless there, so the entire v3.13.0 feature is removed.

- 🔴 **`/gen-key` `/redeem` `/list-stock` `/revoke-key` REMOVED** — the `src/commands/premium.js` handler, the 10 stock functions in `keyManager`, the `premium` router domain, the `/redeem` entry in `PUBLIC_COMMANDS`, the stock line in `/config-show`, and the 2-flow Key category in `/help` (back to the single classic flow).
- 🔴 **`tests/unit/premiumKeys.test.js` DELETED** — 28 feature tests removed with it. Registry 96 → **92 slash commands**; total tests 644 → **616**.
- 🟢 **The classic `/set-key` flow is UNTOUCHED** — it remains the official bridge from external web keys to Discord roles (admins enter a key from the VIP website in a transaction ticket).
- 🟢 Premium monetization moves to a **separate web dashboard** (Discord OAuth + web-key verification); bot roadmap: a REST API bridge for the dashboard.

## [3.13.0] — 2026-09-12

### Added — 💰 PREMIUM SAAS: STOCK KEYS + SELF-SERVICE REDEMPTION

Completing the public v3.12.0 mode: admins sell keys WITHOUT being online 24/7 waiting for buyers. The old model (`/set-key`) stays; this is a fully self-service flow on top.

- 🟢 **`/gen-key value count note` (admin)** — the bot mints crypto-secure random stock keys (`crypto.randomBytes`, NOT `Math.random`): `XXXXX-XXXXX-XXXXX` format, a 31-char alphabet without ambiguous letters (I/L/O/0/1 dropped — easy to read & copy manually), ~74 bits of entropy. `count` 1-10 per invocation. A stock key = `status: 'available'`, owned by nobody, **duration not running yet** (`expireAt` null) — computed later when the key is REDEEMED. Audit logs still never contain key values (the v3.9.1 pattern).
- 🟢 **`/redeem key` (PUBLIC — the first public command to touch key data)** — members redeem their purchased keys THEMSELVES: the role is granted + the auto-expiry schedule is created (MAX EXTEND; expireAt computed by `redeemKey` = duration SINCE REDEMPTION — stock never goes "stale" while unsold), a DM proof of purchase is sent, and a REDEEM_KEY audit entry is logged. If the role can't be granted (role deleted / bot hierarchy), the key stays stored + the member is pointed to an admin (the /set-key pattern).
- 🟢 **`/list-stock` (admin)** — all of this guild's unredeemed stock (key, product, duration, note), a green embed explaining "duration starts when redeemed".
- 🟢 **`/revoke-key key` (admin)** — cancel a stock key that leaked / was minted by mistake. ALREADY-redeemed keys cannot be revoked (a legitimate redemption) — for that use `/clear-schedule user clear_keys:true`.
- 🟢 **/redeem security (4 layers):** (1) a data-layer rate limiter — 5 failures / 10 minutes per user (sliding window, success resets it); (2) every validation failure returns ONE generic message "Key is invalid or already used" — keys cannot be enumerated; (3) ATOMIC consumption in `redeemKey` (load→validate→mutate→save with no await) — two concurrent redeems: only one succeeds; (4) stock keys are guild-scoped — a key for server A cannot be redeemed in server B (critical in public multi-server mode).
- 🟢 **`keyManager`: +10 new functions** (`generateKeyString`, `createStockKey`, `findKeyByString`, `redeemKey`, `listStockKeys`, `revokeStockKey`, `isRedeemRateLimited`, `noteRedeemFailure`, `noteRedeemSuccess`, `_resetRedeemRateLimitForTest`) + an `available` field in `getStats`/`getStatsByGuild` (stock counted SEPARATELY — not in active/permanent; `/config-show` now shows a stock line). `removeExpiredKeys` is stock-safe (expireAt null → always survives).
- 🟡 **Router:** a new `premium` domain (4 commands routed + the v3.9.24 GUARD contract); `/redeem` joins `PUBLIC_COMMANDS` (8 total). Registry 92 → **96 slash commands**.
- 🟡 **`/help`:** the 🔑 Key Manager category now documents BOTH flows (classic vs self-service) + a new FAQ ("can stock keys be used on another server?" — no). The `lines` are ultra-compact (the 📖 All Commands embed budget is tight) + minor compaction of the Moderation/Quick Start categories so all 20 categories stay intact within the 5,800-char budget.
- 🟢 **+28 unit tests (total 644):** `premiumKeys.test.js` — key format/uniqueness, stock fields, duration-since-redemption, atomic single-use, generic messages on every failure path, guild-scoping (list/revoke/redeem), the rate limiter (5 failures, 10-minute window, success reset, per-user isolation), separate available stats, stock surviving the cleaner, and 4 registry/router contracts (registered, routed, public vs admin-gated, command options).

### Compatibility

- **No breaking changes.** The classic `/set-key` model is untouched; legacy keys (pre-v3.13, no `status` field) remain valid and are treated as already claimed.
- Stock data lives in the same `data/keys.json` (new schema fields: `status`, `note`, `createdBy`, `redeemedAt`) — no migration needed.

## [3.12.0] — 2026-09-12

### Changed — 🎯 ONE GUILD ID + PHASE 3: PUBLIC MODE 

- 🟢 **`.env` now has exactly ONE server variable: `GUILD_ID`** (admin request: no more confusion). The v3.11.0 `ALLOWED_GUILD_IDS` allowlist is REMOVED — a multi-ID list only made switching servers confusing. Switching servers = edit the single `GUILD_ID` line in `.env`, done. Two modes: **set = single-server mode** (instant commands, events from other servers ignored) · **empty = public mode** (global commands — they appear automatically in every server that invites the bot within ~1 hour, with no manual guild id anywhere).
- 🟢 **`src/infra/guild.js` simplified:** `getAllowedGuildIds()` (the list) is replaced by `getPrimaryGuildId()` (the trimmed GUILD_ID, or null = public). `isGuildAllowed()` remains the guard for ALL 11 event handlers (the guard code is unchanged — only its source is now single). The foreign-guild join/leave skip logs now mention the `GUILD_ID .env` (still visible, the v3.9.48 pattern).
- 🟢 **Command registration (ready.js):** GUILD_ID set → instant registration to that guild (an uncached guild → a "double-check the ID" warning + global fallback, no crash); GUILD_ID empty → GLOBAL commands — exactly how the big public bots work: Discord propagates the commands to every server within ~1 hour, no manual guild id.
- 🟢 **The legacy config claim gate (configManager):** GUILD_ID set → only that guild may claim the old `config.json`; empty → the first caller (the v3.10.0 behavior is kept).
- 🟢 **PHASE 3 docs (ADMIN_GUIDE):** a new section **"Public Mode  + Developer Portal"** — how public bots work (global commands + per-server configs captured automatically from event IDs), the Developer Portal steps (Public Bot ON, the OAuth2 URL Generator with the `bot` + `applications.commands` scopes), Discord verification rules (mandatory past 100 servers), and a security checklist before going public.
- 🟡 **Test suite:** `guildGuard.test.js` rewritten for the v3.12.0 contract (18 tests, previously 15) — including **3 ANTI-CONFUSION PINS**: (1) `ALLOWED_GUILD_IDS`/`getAllowedGuildIds` must never reappear in `src/`, (2) `.env.example` has exactly one `GUILD_ID` variable + documents public mode, (3) the `guild.js` export contract is exactly 3 functions. Total **616**.
- 🟡 `serverLog.test.js`: the static guard contract v3.11.0 → v3.12.0 (still `isGuildAllowed`, now sourced from the single GUILD_ID).

### Compatibility

- **.env using only `GUILD_ID` (the common deployment): NOTHING needs to change** — the behavior is identical to the v3.9.26/v3.11.0 single-guild mode.
- **.env using `ALLOWED_GUILD_IDS` (v3.11.0):** that variable is now ignored. Move your main server's ID into `GUILD_ID` (one server per deployment). Serving many servers? Leave `GUILD_ID` empty → public mode, with per-server configs isolated automatically.

## [3.11.0] — 2026-09-12

### Added — 🛡️ MULTI-GUILD PHASE 2: the ALLOWED_GUILD_IDS allowlist

- 🟢 **The `ALLOWED_GUILD_IDS` guard** (`src/infra/guild.js` — `getAllowedGuildIds()` + `isGuildAllowed()`): a comma/space-separated list of server IDs allowed to use the bot (e.g. `ALLOWED_GUILD_IDS=111...,222...`). Priority: `ALLOWED_GUILD_IDS` > `GUILD_ID` > neither set (open mode = the v3.10.0 behavior). Phase 1 (v3.10.0) made per-server DATA safe, but any server that invited the bot was still served in full — phase 2 hands the admin a GATE: servers outside the list are ignored entirely (messages, joins, boosts, tickets, voice, interactions).
- 🟢 **All 11 event handlers migrated to the allowlist guard** (messageCreate, messageUpdate, messageDelete, messageBulkDelete, interactionCreate, guildMemberAdd, guildMemberRemove, guildMemberUpdate, guildBanAdd, guildBanRemove, voiceStateUpdate) — the `process.env.GUILD_ID && x !== process.env.GUILD_ID` pattern replaced by `!isGuildAllowed(x)`. The previously visible skips (joins/leaves from a foreign guild) stay visible and now name the allowlist.
- 🟢 **Slash command registration per-guild for EVERY allowlisted server** (ready.js): commands are registered to EACH guild on the list — instant in every listed server at once, and guilds outside the list never even see the commands (not merely blocked when used). An allowlisted guild that is not cached yet (not invited) → a clear warning, no crash; if NONE are reachable → the global-command fallback is kept (the old behavior).
- 🟢 **Startup now runs per-guild for every allowlisted server:** the welcome/goodbye/booster channel check, the offline boost catch-up, and the server-stats counter sync now run for EACH allowlisted guild (previously only the GUILD_ID / first guild was checked — a second guild was never reconciled).
- 🟢 **The v3.10.0 legacy config claim gate follows the allowlist:** a SINGLE-entry allowlist → only that guild may claim the old `config.json` (other servers cannot "steal" it); empty / multi-entry → the first caller (the v3.10.0 behavior).
- 🟢 **`.env.example`** fully documented: the 3-mode priority + examples + how to add a new server (invite → add the ID → restart).
- 🟢 **+15 unit tests (total 613):** `guildGuard.test.js` — list parsing (commas/spaces/empty entries/priority over GUILD_ID), the pure guard (open mode/members/null DMs), event handler guards (a foreign-guild join ignored + logged; a foreign interaction never routed), the legacy claim gate (a foreign guild gets DEFAULTS, the single allowlisted guild claims + `.migrated`), `startupGuilds` (allowlist/filter/skipping uncached guilds), and the ready.js static contract.

### Compatibility
- **Old .env files need NO changes** — without `ALLOWED_GUILD_IDS`, the old `GUILD_ID` automatically becomes a one-entry allowlist (exactly the v3.9.26/v3.10.0 behavior). Without either → open mode (exactly v3.10.0).
- Adding a server: invite the bot → add its ID to `ALLOWED_GUILD_IDS` → restart.

## [3.10.0] — 2026-09-12

### Added — 🌍 MULTI-GUILD PHASE 1: per-server config

- 🟢 **Config is now PER-GUILD: `data/config/<guildId>.json`.** Previously a single global `data/config.json` was shared by EVERY server that invited the bot — an admin of server A running `/set-channel welcome` would change server B too (mutual overwrites). Each server now owns its own config file. This is the foundation for opening the bot to the public (hosted multi-server): the other data layers (keys, warnings, stats, tickets, escrow deals) were already guild-scoped from the start — configManager was the last remaining global data point.
- 🟢 **One-time automatic migration:** the old `data/config.json` (single-guild era) is moved to `data/config/<guildId>.json` when the rightful guild first reads its config. The old file is renamed to `config.json.migrated` as an audit trail (not deleted). Claim rule: if `GUILD_ID` is set (v3.9.26 single-guild mode), only that guild may claim it — other servers get pure DEFAULTS.
- 🟢 **New API `resolveGuildId(interaction)`** (`src/infra/guild.js`) — a single resolution point for the guild ID of an interaction (checks `guildId` → falls back to `guild.id`), used by every command/interaction domain handler. `getConfig(guildId)` / `saveConfig(guildId, config)` / `setField(guildId, dotPath, value)` now REQUIRE a guildId — without one they throw with a clear message (fail-fast: cross-guild bugs surface in dev/test instead of failing silently in production).
- 🟢 **The admin-role permission cache is now PER-GUILD** (`src/infra/permissions.js`): previously a single global 30-second variable meant server A's admin role was read by server B. Now a per-guild Map with the same TTL.
- 🟢 **backupManager supports directories:** the `'config'` FILES_TO_BACKUP entry is copied recursively (all per-guild `*.json` files are included). Old backups (pre-3.10.0, flat `config.json`) can still be restored — the legacy file is placed back as `data/config.json` and claimed by the migration when read (it never overwrites an already-active guild config).
- 🟢 **`.gitignore`:** the `data/config/` folder is ignored (runtime per-guild data).
- 🟡 **19 test-suite files updated** to the per-guild pattern: sandboxes write `data/config/<guildId>.json`, interaction mocks carry `guildId`, and the `resetDataFile`/`writeDataJSON` helpers support nested paths. Total stays at 598 tests — all green.

### Behavior notes

- **An empty `GUILD_ID` = full multi-guild mode** — events & commands from every server are processed, slash commands register globally. If your bot is currently single-server, NOTHING changes: keep `GUILD_ID` set as usual, and the old config is migrated automatically when the bot starts.
- Phase 2 (next): an `ALLOWED_GUILD_IDS` guard (public server allowlist) + Discord verification prep (100-server limit).

## [3.9.60] — 2026-09-12

### Fixed — 🧪 code review: backup/restore subsystem audit (fresh-clone test run was red)

- 🟡 **`modlogs.json` was NEVER backed up — `/restore-backup` silently lost the whole moderation history.** `modLogManager` (v3.9.43) has written `data/modlogs.json` (per-user timeout/kick/ban history shown by `/warn-list`) for 17 versions, but the file was never added to `FILES_TO_BACKUP` — `/backup-now` skipped it, the pre-restore safety snapshot skipped it, and a restore (e.g. a server migration) dropped every moderation record with no warning. This violates the project's own v3.9.24 invariant ("every live data-layer file is in the list"); the live-file GUARD test never caught it because on a fresh clone `data/` holds no runtime JSON. Fixed: `'modlogs.json'` added to the list + a dedicated environment-independent regression test pins the whole registry (20 manager files) so a future manager without a backup entry fails CI deterministically.
- 🟡 **Post-restore stale-cache wipe for `boosts.json` — boostManager's permanent in-memory store was never invalidated.** `boosts.json` has been restored since v3.9.49, but the v3.9.26 restore-invalidation list (stats, serverstats, permissions, panels, automod/afk/responders/levels) was never extended when boosts were added: `boostManager.reload()` existed but was never called. After a restore, the first boost event (`guildMemberUpdate` premium diff) mutated the STALE pre-restore object and `save()` wrote it over the freshly restored `boosts.json` → silent loss of the restored boost history. Fixed: `reload()` is now called in `_restoreBackupImpl` (same guarded pattern as the other managers) + a regression test that primes the cache, restores, and asserts the cache now reflects the RESTORED data.
- 🟡 **Same latent landmine in `modLogManager` — defused.** With modlogs.json now restored, the identical permanent `store` cache would have reintroduced the bug above for moderation history (first `addModLog()` post-restore overwrites the restored file with the pre-restore snapshot). Fixed: public `reload()` added to modLogManager and called in the restore invalidation block, covered by the same regression test.
- 🟠 **`npm test` was RED on every fresh clone / CI (GUARD test environment assumption).** `v3.9.24 GUARD: FILES_TO_BACKUP covers every live JSON file in data/` asserted `data/` "should contain at least a few JSON files in this dev repo" — true on the dev machine (runtime files exist), false on a fresh clone or GitHub Actions runner (all `data/*.json` are gitignored; only `.gitkeep` is committed). Result: 1 failing test on every clean checkout, masking real failures in the suite output. Fixed: a fresh checkout now SKIPS the live-file scan (nothing on disk → nothing can be missing) and the registry completeness guarantee moved to the environment-independent regression tests above.
- 🟢 **+3 unit tests (total 598):** backupManager.test.js — modlogs.json in FILES_TO_BACKUP (the v3.9.43 hole pinned), full manager-file registry cross-check (20 files), and the post-restore cache invalidation integration test (prime caches → mutate live files → restore → assert both the files AND both managers' caches reflect the restored data; cleans up its own live-file edits). Fresh-clone suite result: 598/598 green, `npm run lint` clean.

## [3.9.59] — 2026-09-12

### Added — 💬 user request: "auto booster role — those who boost the server should get a role"

- 🟢 **NEW `tipe:booster` in `/set-role` — the Booster role AUTOMATICALLY follows the boost status.** `/set-role booster @Booster` enables the auto-role: a member who boosts the server is immediately **granted** that role, and when the boost ends the role is **removed** — the same semantics as Discord's built-in "Server Booster" role (the perk tracks the ACTIVE boost, not a permanent badge — a member who stops paying loses the access). Discord does not allow its built-in role to be re-ordered/re-colored, so admins use their own role for visible perks (exclusive channels, discounts, name color). The automatic grant/removal lands in the server log as a regular ROLE_UPDATE entry (the same role-diff event), keeping the audit trail intact without duplicate logging.
- 🟢 **RETROACTIVE application when set.** `/set-role booster @role` ALSO grants the role to everyone CURRENTLY boosting right away (the reply states the count: "🚀 N member(s) currently boosting got the role right away") — the admin doesn't have to wait for the next boost. `/remove-role booster` only turns the automation off; roles already on members are NOT revoked (consistent with the other role types).
- 🟢 **STATE sync at startup (offline boosts don't slip through).** `syncBoostRoles` runs after the boost reconcile in ready.js: every live booster missing the role → granted (covers offline boosts AND live assignments that once failed — e.g. the role was above the bot and got fixed since), boosts that ended while offline → role removed. **MANUAL grants by the admin to regular members are never touched** — the sync only adds to real boosters, it never strips non-boosters who were never boosters.
- 🟢 **Full diagnosability (the v3.9.48 pattern).** Every skip/failure leaves a cause + fix log line: role not set (a hint per new boost), role deleted/ghost ID, role above the bot role (position pre-check), missing Manage Roles permission, or an API error during assignment — never throws into the event. `/test-booster` now also checks the role chain (set → exists → position vs the bot role → Manage Roles permission) **without ever touching the role** — the simulation stays pure; the reply now states "the booster role is never touched".
- 🟢 **`/help`, `/config-show`, `/remove-role` updated:** the Roles compact line now includes booster (verified/unverified/admin/midman/**booster**), the Roles guide adds `tipe:booster` + its semantics, the Statistics guide explains the auto-role, `/remove-role` gains the Booster choice, and `/config-show` shows "Booster (auto)" in the Roles list. The All-Commands embed stays within budget (**5.794/5.800**).
- 🟢 **+18 unit tests (total 595) — boosterRole.test.js:** registry contract (booster choice in set-role & remove-role), applyBoostRole (healthy add, idempotent, remove, remove-without-role, ghost, not-set, roles.add-throwing never rejects, position guard), syncBoostRoles (booster-without-role granted, manual grant NOT revoked, boost-ended stripped, bots skipped), the live guildMemberUpdate add/remove events calling applyBoostRole + boost history still recorded, `/set-role booster` retroactive (config + role + count in reply), `/test-booster` diagnostics (healthy/ghost/not-set) + role purity, and help docs + budget. 2 regression pins (helpNav, hardeningV37) re-pinned to the new set-role line.

## [3.9.58] — 2026-09-12

### Added — 🧪 user request: "command test booster"

- 🟢 **NEW `/test-booster` (92nd command, admin) — the boost feature's `/test-welcome`.** Admins cannot simulate a real boost (it costs real money), so until now the whole notification chain was untestable until an actual booster showed up. `/test-booster tipe:add` (or `tipe:remove`) now diagnoses **every link in the chain** — server-booster channel set → exists → bot View/Send/Embed permissions — and sends a **live preview of the EXACT embed** a real boost sends (the same `buildBoostAddEmbed`/`buildBoostRemoveEmbed` the live event uses — no drift possible), with your own data playing "the booster". The reply also shows the live boost state (level + count) and the intent note (boost detection = the guildMemberUpdate premium_since diff; the bot being online proves the GuildMembers intent is ON).
- 🟢 **`live:true` option — the full end-to-end delivery test.** Also delivers the preview to the **REAL server-booster channel**, proving the embed actually arrives where real notifications go. Without the option nothing is sent there; with a broken/missing channel the live send is skipped with a clear reason (never crashes).
- 🟢 **PURE SIMULATION — nothing is recorded.** Boost history (`/boosters`), the server log and the live counters are untouched — the command is safe to run any time, and the unit tests pin `boosts.json` byte-identical after add + remove + live runs.
- 🟢 **`/help` updated (budget-safe):** the Statistics compact line list gains `/test-booster` (lines compacted to keep the All-Commands embed at **5.786/5.800** — 20 categories intact), the Statistics guide explains the command + `live:true`, and the Logging & Channels FAQ now points to `/test-booster` for boost channels.
- 🟢 **+11 unit tests (total 577):** registry contract (choices, ManageGuild, optional boolean), router mapping, all-healthy diagnostics + pink preview with mention content, remove → gray embed without mention, channel-not-set / ghost-ID / missing-permission diagnostics, `live:true` delivery + skip path, and the boosts.json purity guard.

## [3.9.57] — 2026-09-12

### Fixed — 💬 user request: "make the /add-product price support decimals, e.g. 5.88"

- 🟠 **MARKER-LESS decimals are now supported — "5.88" records as 5.88, not 588.** The v3.9.55 decimal rule that used to apply only when a currency marker was present (`$2.50`) now applies to marker-less inputs too: a single dot with a **1-2 digit fraction is a DECIMAL** (`5.88` → 5.88, `9.99` → 9.99, `0.99` → 0.99, `12.99` → 12.99), with or without a marker — the `intl` flag is gone, one rule for every input. Why it's safe: a VALID Indonesian thousands group is always **3 digits** (`50.000`), so `5.88` cannot be a correct Rupiah format — the most sensible reading is a decimal (the bot is currency-agnostic since v3.9.54). A 3-digit fraction (`50.000`, `5.880`) and multi-dot (`1.234.567`) stay THOUSANDS; the Rp branch, dual-currency prices, and escrow are untouched.
- 🟡 **Deliberately changed behavior (inputs that were never valid Rupiah):** `1.50` is now 1.5 (was 150), `100.00` is now 100 (was 10000), `2.50` is now 2.5 (was 250) — write those thousands as `150` / `10.000` / `250`. Bonus: suffix+decimal used to explode 100x and now matches the comma version (`1.50rb` → 1500, was 150,000; `9.99jt` → 9,990,000, was 999,000,000).
- 🟢 **`/add-product` / `/update-product`:** the accepted-format list now shows a marker-less decimal example (`5.88`), as do the slash-option descriptions (`Rp 50.000 / $3 / $2.50 / 5.88 / 25rb`). The `/help` "❓ Decimals?" FAQ is updated — marker-less decimals are valid, 3-digit groups stay thousands, escrow deal amounts stay whole-numbers-only.
- 🟢 **+3 unit tests (total 566):** parsePrice.test.js — a marker-less decimal matrix (`5.88`/`5,88`/`0.99`/`2.50`/`1.50rb`/`1,50rb`/`9.99jt`/`$5.88`/`5.88 usd`) and valid-thousands & multi-dot unchanged (`5.880`/`50.000`/`1.000.000`/`5.000rb` + escrow still rejects decimals); 3 legacy pins from the Rupiah-centric era re-pinned to the new decimal values; priceValidationError accepts marker-less decimals. boosters.test.js — a command-level price guard `/add-product price:5.88` → confirmation `💰 Counted in stats as: **5.88** per sale` (the FULL command path, not just the parser).

## [3.9.56] — 2026-09-12

### Added — 🧪 user request: "add booster tests too"

- 🟢 **+6 unit tests for the SERVER BOOSTER feature (v3.9.49) — total 563.** Five previously unpinned `boostManager.reconcileBoosters` paths are now verified: **a lapsed-&-restarted streak while the bot was offline** (boostedAt refreshed to the new premium_since WITHOUT inflating totalBoosts — the gap is not observable via Discord, so it must not count as a new event), **bot members are skipped** (a bot's premium_since never counts as a booster), **the null/broken-guild guard** (reconcile returns empty without crashing), **an offline add pins boostedAt to the REAL premium_since** (streak duration stays accurate instead of using the reconcile time), and **getRecentEvents** (limit respected, newest first, full `{userId, event, at, boostedAt}` shape). Plus one command-level price-guard test for the v3.9.55 international decimals: `/add-product price:$5.88` → saved + confirmation `💰 Counted in stats as: **5.88** per sale` — verifying the FULL command path, not just the parser in parsePrice.test.js. No runtime changes: 563/563 tests green against existing behavior (principle: tests pin the contract, they don't change it).

## [3.9.55] — 2026-09-11

### Fixed — 💬 user question: "does the number support decimals, e.g. $2.5 USD?"

- 🟠 **International DECIMAL prices now parse correctly — a silent 100x error is gone.** The dot heuristic in `statsManager.parsePrice` was written in the Rupiah era (an integer currency, no cents), so even after v3.9.54 a marker price like `$2.50` read as **250**, `$9.99` as **999**, `$12.99` as **1299** (dot = thousands), and the trailing `Math.round` killed the cents (`$2.5` → **3**, `$1,234.56` → **1235**). Now, when a NON-Rp currency marker is present: a single dot with a **1-2 digit fraction is a DECIMAL** (`$2.5 USD` → 2.5, `$2.50` → 2.5, `$9.99` → 9.99, `$12.99` → 12.99, `$0.99` → 0.99, `£ 2.99` → 2.99, EU comma `€9,99` → 9.99, `$2.5k` → 2500), a **3-digit fraction stays a thousands group** (`$50.000` German style → 50000, `$1.234.567` → 1234567), and **cents are PRESERVED** in the recorded amount (rounded to at most 2 decimals). Marker-less legacy inputs are unchanged (`50.000` → 50000, `1.50` → 150, `9.99` → 999); the Rp branch and dual-currency recording (`$2.5 USD | Rp 25.000` → 25000) are untouched.
- 🟢 **`/add-product` & `/update-product` accept decimal prices** (`$2.5 USD` → valid, `💰 Counted in stats as: 2.5 per sale`) and the accepted-format list now shows a decimal example (`$2.50`). Slash-option descriptions (`/add-product price`, `/update-product price`) show `$2.50` too.
- 🟢 **`/help` FAQ documents decimals (Products & Escrow categories):** new "❓ Decimals?" line — "Yes — `$2.5`, `$2.50`, `€9.99` all record with cents; a 3-digit dot group stays thousands (`$50.000` → 50.000)" — plus a new escrow FAQ "Deal amount format? Whole amounts only — decimals like `$2.5` are rejected as ambiguous on purpose (deal safety)."
- 🟢 **Escrow keeps its whole-amount strictness BY DESIGN** (`$2.5` / `$2.50` / `€2,50` → still rejected; `$25,000` / `€2.500` unchanged): a mis-typed decimal in a deal that moves real money between users is costlier than the convenience. Product prices can have cents; escrow deal amounts cannot.
- 🟢 Tests: 5 legacy pins re-pinned to the cent-preserving values (`2.5` → 2.5 was 3, `9.9` → 9.9 was 10, `2,5` → 2.5 was 3, `1,234.56` → 1234.56 was 1235, `1.234,56` → 1234.56 was 1235) + **5 new tests** (decimal-cents matrix, 3-digit groups stay thousands, Rp/marker-less no-regression, escrow whole-only, `priceValidationError` decimals). Total **557**.

## [3.9.54] — 2026-09-10

### Changed — 🌍 user request: "the bot will be used by people outside Indonesia too — remove the Rupiah-only stuff (or use your own idea)"

- 🟢 **Prices are now currency-AGNOSTIC: ANY currency marker is accepted** — `$3`, `€25`, `£ 20`, `¥1000`, `₩25,000`, `₱500`, `₹99`, `25 usd`, `IDR 30.000`, `3 eur`, … plus all the existing formats (`25000`, `25.000`, `25,000`, `Rp 30.000`, `30rb`, `3jt`). The bot records the **numeric amount** in whatever currency the admin prices their products — no conversion, no rejection. Dual-currency strings (`3$ USD | Rp 25.000`) still record the **Rp half** (v3.9.50 behavior, unchanged); when no Rp half exists the **first amount** wins (`$3 | €2` → 3). Applies to BOTH price parsers: `statsManager.parsePrice` (products/stats) and `midmanManager.parsePriceNumber` (escrow deals — the v3.9.50 "USD-only → rejected" branch is gone). Design choice (instead of deleting prices entirely): deleting the price system would also kill 💰 Total Spent / Top Spender stats — going currency-agnostic keeps every existing feature working for every country.
- 🟢 **USD-only prices are no longer rejected by `/add-product` & `/update-product`** — `priceValidationError` now accepts any currency; the error message (for genuinely unparseable strings) lists international examples (`$3` · `€25` · `Rp 30.000` · `30rb`). The confirmations show `💰 Counted in stats as: **25,000** per sale` — plain number, no hardcoded `Rp` prefix.
- 🟢 **`/my-stats` "Total Spent" and `/leaderboard` "Top Spender" show plain locale numbers** (no hardcoded `Rp` prefix) — correct for servers pricing in ANY currency. Buyers still see the admin's exact `label` + `price` text in the ticket panel (always was currency-agnostic).
- 🟢 **Escrow displays are currency-agnostic:** `midmanManager.formatRupiah` renamed to **`formatMoney`** (plain locale number, e.g. `95,000` instead of `Rp95,000`) — all ~20 display sites (deal board, WAITING_PAYMENT instructions, fee examples, audit details) updated. Escrow keeps its whole-amount strictness (`$2.5` → rejected as ambiguous; `$25,000` / `€2.500` → fine).
- 🟢 **`/help` FAQ rewritten (Products & Escrow categories):** "Price format?" now answers "ANY currency works" with international examples instead of "USD-only is rejected: stats are in Rupiah"; the escrow fee FAQ no longer says stats are in Rupiah. Slash-option descriptions (`/add-product price`, `/update-product price`, `/set-midman-fee`) now show mixed-currency examples.

## [3.9.53] — 2026-09-10

### Added — ⚙️ user request: "give /serverstats options for which counters to show"

- 🟢 **`/serverstats setup` now takes 5 boolean options — `members`, `bots`, `boosts`, `roles`, `channels`.** Every counter is ON by default; set one to **False** to skip it (e.g. `/serverstats setup bots:false channels:false` creates only 👥 · 🚀 · 🎭). Turning ALL of them off is refused with a friendly explanation. Only the selected counters are created, persisted in `serverstats.json`, and refreshed — and the confirmation embed gains a **"Not created"** field listing what was skipped. `/serverstats refresh` now lists exactly the CONFIGURED counters (same shape the setup confirmation showed). To change the selection: `remove` then `setup` again (documented in the footer of the confirmation embed).

### Changed — 📖 user request: "rewrite /help so every category's slash commands get explanations — members shouldn't have to ask"

- 🟢 **Every one of the 20 `/help` categories is now a full self-contained guide.** The v3.9.52 `detail` mechanism became the category view itself: when a category carries a guide, THAT is what the 📂 dropdown renders — per-command syntax, behavior, examples, and ❓ answers to the most common questions (why can't I moderate that member, why didn't the panel update, why didn't XP count…). The compact `lines` remain the content of the budget-critical 📖 All Commands embed (5.793/5.800 — untouched) and the 🔍 Search index, so nothing dropped and nothing overshot. Longest guide: Statistics at 1.539/4.096 chars.
- 🟢 Bonus accuracy fix found while writing the guides: the Auto-Mod help line said `/add-word type:Exempt_(word)` but the option is actually **`tipe:`** in the registry — fixed in the compact line (the guide now documents the real option name).
- 🟢 +3 unit tests (total **551**): `/serverstats setup` counter-selection end-to-end (False options skipped — only the selected channels created, config keys match the selection, "Not created" field lists the skipped ones), all-False refusal (nothing created, no config saved, friendly message), refresh with a partial selection lists only the configured counters; helpDetail.test.js re-pinned for the rewrite (every category has a guide, the category view renders the guide exactly, guides document real commands from `lines`, the All-Commands embed excludes guide text and keeps all 20 categories within budget, the stats guide documents the new selection options); the registry contract now pins the 5 boolean options (names, type 5, optional, ≤100-char descriptions).

## [3.9.52] — 2026-09-10

### Changed — 📖 user request: "update /help too so everything is in sync"

- 🟢 **`/help` now documents the new stats features in the category detail views.** A category can carry an optional `detail` block that renders ONLY in the 📂 category view — richer usage docs without touching the 📖 All Commands embed (its budget had 7 characters of slack — 5.793/5.800 — so a detail leak would have silently dropped the last category from the full listing) or the 🔍 Search index (which scans the compact `lines`). Categories without a `detail` block render byte-identically to before.
- 🟢 **Statistics category:** how to actually use the v3.9.51 live counters — `/serverstats setup` (creates the "📊 SERVER STATS" category at the top + the 5 display-only voice channels), `remove` / `refresh`, the auto-update triggers (join/leave, boost add/remove, channel & role create/delete), the rate-limit safety (2 renames per channel per 10 min — throttled + self-heal), the deleted-counter warning + auto-disable, and the boost-notification flow (pink embed → `/set-channel server-booster #ch`, always recorded in the server log + `/boosters` history).
- 🟢 **Quick Start:** an optional-extras line points fresh setups at `/serverstats setup` and the boost-announcement channel. **Logging & Channels:** the `server-booster` channel row now explains the auto-announcement behavior.
- 🟢 +8 unit tests (total **549**): `helpDetail.test.js` — stats detail documents setup/remove/refresh + counters + rate limit + boost guidance, quickstart/logging detail present, All-Commands embed excludes detail text and keeps all 20 categories within the 5800 budget, categories without detail render exactly as before, every category description ≤ 4096, search scans lines only (command findable, detail-only phrase never leaks).

## [3.9.51] — 2026-09-10

### Added — ✨ user request: "a live server-stats feature like the ServerStats bots"

**Live server stats counter channels (new):**

- 🟢 **NEW `/serverstats` command** (91 commands total, admin): channel NAMES are live counters that update automatically — the "ServerStats bot" experience without another bot. `setup` creates a **`📊 SERVER STATS`** category at the TOP of the channel list + 5 counter voice channels (`👥 Members`, `🤖 Bots`, `🚀 Boosts`, `🎭 Roles`, `📺 Channels`) with the current live values; `remove` deletes them all + clears the config; `refresh` forces an immediate update (bypasses the cooldown once — admin-invoked, rare, safe).
- 🟢 **@everyone is denied Connect** on every counter channel — they are display-only (members see the numbers, nobody joins them). Counter values are read straight from the guild object: `memberCount` (exact), members cache for bots, `premiumSubscriptionCount`, role & channel cache sizes.
- 🟢 **Auto-update, rate-limit safe:** member join/leave/boost changes (`guildMemberAdd/Remove/Update`), channel & role create/delete (4 new event files, registered in index.js) mark the stats *dirty* → the 60s scheduler tick refreshes them; every 5th tick (~5 min) is a catch-up so a missed event self-heals. Three guards keep it inside Discord's **2 renames per channel per 10 min** limit: (1) change detection — an unchanged name makes ZERO API calls, (2) a 5-min per-channel cooldown (deferred renames retry on later ticks), (3) dirty-driven refresh — a join burst = 1 refresh, not 1 rename each.
- 🟢 **Self-healing:** deleted counter channel → console warning naming the fix commands; ALL counters gone → the feature auto-disables (no zombie scheduler work) — re-run `/serverstats setup`. Setup refuses politely when already configured (points at `refresh`/`remove`), auto-heals into a fresh setup when all old channels are gone, and rolls back half-created channels on partial failure (the v3.9.8 anti-orphan pattern). One forced refresh at startup syncs offline changes.
- 🟢 `serverstats.json` is backed up by `/backup-now` & restore-able (the in-memory cache reloads after a restore — same staleness fix pattern as stats.json). No "online members" counter on purpose: it needs the GuildPresences privileged intent (not enabled — enabling it without the portal toggle would crash the login; without it the number would be a lie).

### Changed — ✂️ user request: "just delete the total revenue feature — I don't really use it"

- 🟢 **`/stats` no longer shows "Total Revenue":** the aggregate revenue line caused repeated confusion (v3.9.47/49/50 were all about it not matching) and the user doesn't use it — the server overview now shows live data (members, tickets, boosts) + tracked activity (messages, average, giveaway wins, transaction count) with NO revenue line. Personal spending stays where it is per-user and unambiguous: `/my-stats` "Total Spent" and `/leaderboard` "Top Spender".
- 🟢 +18 unit tests (total **541**): `serverstats.test.js` — pure builders + live values, persistence round-trip + reload, change detection (zero calls when unchanged), rename + force bypass + the per-channel cooldown, setName failure isolation, missing channel warning + auto-disable, dirty-driven scheduler tick + 5-tick catch-up + single-guild hardening, `/serverstats setup` end-to-end (live names, @everyone locked out, category at the top, config saved, refusal, auto-heal, no-permission refusal, partial-failure rollback), `remove` + `refresh` end-to-end + friendly not-set-up errors, event wiring (guildMemberAdd + channelCreate mark dirty), registry 91 + router + NOT-public + FILES_TO_BACKUP + help-catalog + 5800 budget + index.js event registration contracts; statsDisplay re-pinned: NO field may mention revenue. Help catalog: Statistics lines compacted so the All-Commands embed stays within budget (5.793 / 5.800, all 20 categories intact).

## [3.9.50] — 2026-09-10

### Fixed — 🐛 user report: "I set the price as 3$ USD | Rp. 25.000" (revenue still barely moved)

- 🔴 **Dual-currency prices recorded Rp 3 per sale:** the user's actual product price format (`3$ USD | Rp. 25.000`) stopped `parseFloat` at the `$` — the Rupiah half was never read, so every sale added a near-invisible amount and the revenue STILL looked frozen even after the v3.9.49 suffix fix. Both price parsers (`parsePrice` shop/tickets/keys + `parsePriceNumber` escrow) now read the amount attached to the `Rp` marker directly: `3$ USD | Rp. 25.000` → **Rp 25.000** recorded per sale — with or without a pipe, Rp first or USD first, with or without `rb`/`jt` suffixes.
- 🟡 **USD-only prices are rejected with a clear hint:** `$3` / `3 usd` cannot be converted to Rupiah reliably (before, `3$` silently recorded Rp 3). `/add-product` & `/update-product` now explain that revenue is recorded in **Rupiah** and ask for the Rp half, e.g. `3$ USD | Rp 25.000` — the accepted-format list shows the dual-currency example.
- 🟢 **`/update-product` now shows the counted amount too:** the confirmation lists `💰 counted in stats: Rp 25.000 per sale` whenever the price changes — the same visibility `/add-product` has, so a dual-currency typo is caught at update time, not after N invisible sales.
- 🟢 Escrow strictness preserved: a suffix + separator combination in the Rp half (`3$ | Rp 1.5rb`) is still rejected — the 10x-price guard stays intact.
- 🟢 +5 unit tests (total **523**): the verbatim user format + common variants (pipe, no pipe, Rp first, suffix), USD-only → 0, Rp formats no-regression, midman dual-currency + strictness, and the `priceValidationError` contract (dual OK / USD-only hint / garbage rejected).

## [3.9.49] — 2026-09-10

### Added — ✨ user request: "server boosters — know who boosts + send it to a server booster channel"

**Server Booster feature (new):**

- 🟢 **Boost add/remove detection:** Discord fires NO dedicated boost event — the bot derives it from the `guildMemberUpdate` `premium_since` diff (null → date = boost added, date → null = boost ended). Every boost sends a pink celebration embed (`🚀 NEW SERVER BOOST!` + mention + since date + server level) and every stop a gray one (`💔 BOOST ENDED`) to the **server-booster channel** — set it with `/set-channel tipe:server-booster #channel`.
- 🟢 **NEW `/boosters` command** (90 commands total, public): the live booster list straight from Discord (fetches the full roster — earliest supporter first, bots excluded, each with their boost date) + server level & boost count + a tracked "Recent Boost Activity" section. Empty state included ("no active boosters yet 🌱").
- 🟢 **`boostManager` (boosts.json):** persistent booster history per user (current streak, all-time `totalBoosts`, last event) — knowing who boosted survives restarts; **offline catch-up**: on startup the live state is reconciled against the history (fetches the member roster first), and missed changes are announced in ONE consolidated catch-up embed (anti-spam) + recorded in the server log (`BOOST_ADD` / `BOOST_REMOVE` event types) even when no booster channel is set.
- 🟢 Boost events also enter the **server log** (independent of the booster channel) + `boosts.json` is now backed up by `/backup-now` & restore-able.
- 🟢 v3.9.48 diagnosability pattern extended: booster channel not set / deleted → console warning with the exact fix command; send failures name the channel + permissions to check; `ready.js` startup check now covers `server-booster` alongside welcome/goodbye.

### Fixed — 🐛 user report: "the server stats still don't match — total revenue doesn't update, and member tracked vs member live: if they do the same thing, make it one"

- 🔴 **Total revenue barely moved — Indonesian price suffixes were silently mis-parsed:** `25rb` recorded **Rp 25** instead of **Rp 25.000** (the trailing `rb` was never stripped, `parseFloat` only picked the leading digits) — every sale added a near-invisible amount, so the revenue looked frozen. `parsePrice` (shop/tickets) and `parsePriceNumber` (escrow deals) now understand `rb`/`jt`/`juta` (`25rb` → 25.000, `2jt`/`2juta` → 2.000.000, `Rp 25 rb` → 25.000), longest-suffix first; legacy formats are unchanged, and the escrow strictness stays (suffix + separators like `1.5rb` is still rejected — the 10x-price guard).
- 🟡 **Product prices were never validated:** `/add-product price:murah` was accepted silently, and every later sale recorded Rp 0 into stats/leaderboard. Both `/add-product` and `/update-product` now reject an unparseable price with the accepted-format list, and the add confirmation shows how the price will be counted (`💰 Counted in stats as: Rp 25.000 per sale`) — a format mistake is visible at setup time, not after N invisible sales.
- 🟢 **One member field, not two:** "Members (live)" + "Members Tracked" merged into a single `👥 Members` (the live count from Discord), and "Avg Messages/Member" now divides by the LIVE count so the numbers match what the embed shows. Footer clarifies what revenue counts (ticket + escrow sales).
- 🟢 `/config-show` Channels section: **server-log was missing since v3.9.43** (set-able but invisible) — now shown, together with the new server-booster channel.
- 🟢 +15 unit tests (total 518): `boosters.test.js` (11 — boostManager state/idempotency/reconcile both directions, pure embed builders, live event end-to-end add/remove/silent, channel-not-set warning with the fix command, `/boosters` command end-to-end incl. sorting/bots/empty state, registry + router + PUBLIC + server-log + help-catalog + backup contracts) + `parsePrice` rb/jt/juta cases with the user-report scenario + no-regression guards + midman strictness; statsDisplay updated for the merged member field.

## [3.9.48] — 2026-09-09

### Changed — 🐛 user report: "there's a bug — the Welcome doesn't appear"

**Welcome & Goodbye diagnostics (silent failures now speak):**

- 🟡 **Investigation result:** the welcome code path was proven WORKING (end-to-end simulation with the real modules: join → role + embed + server log, leave → goodbye embed). The real bug was **diagnosability**: when the welcome channel was not set / deleted / from another server, the bot logged NOTHING at startup AND NOTHING when a member actually joined — the admin had zero clues, and no way to test without a real member joining.
- 🟢 **`memberHandler`:** every skip reason now logs an actionable line — channel not set → `Fix: /set-channel welcome #channel`; channel not found → same + "deleted, or the ID belongs to another server"; send failure → names the channel + the exact permissions to check (Send Messages + Embed Links). Successes are logged too (`👋 Welcome sent for X in #channel`) so the flow is visible.
- 🟢 **NEW `/test-welcome` command** (89 commands total): the direct answer to "why doesn't it appear?" — diagnoses every link in the chain (config → channel exists → bot permissions View/Send/Embed in that channel), notes that Join/Leave events are active (an online bot proves the GuildMembers intent is ON — a disabled privileged intent crashes the login instead), and **sends a live preview embed** to the current channel built by the SAME `buildWelcomeEmbed`/`buildGoodbyeEmbed` the real event uses (preview can never drift from reality). `tipe:welcome|goodbye`.
- 🟢 **`ready.js` startup check:** warns when the welcome/goodbye channel is not set, or the ID doesn't exist in the guild (with the fix command); confirms with one line each when configured — misconfigurations surface at boot, not at the next random join.
- 🟢 **`guildMemberAdd`/`guildMemberRemove`:** a member event from another guild (GUILD_ID mismatch) is now VISIBLE (was a silent return — a join in a second guild looked exactly like "welcome is broken").
- 🟢 Embed builders extracted (`buildWelcomeEmbed` / `buildGoodbyeEmbed`, exported) — single source of truth shared by the live event and the `/test-welcome` preview.
- 🟢 `/help` catalog: Logging & Channels documents `/test-welcome`; All-Commands embed re-measured within the 5.800 budget with all 20 categories intact (5.793 used).
- 🟢 +17 unit tests (`welcomeDiagnostics.test.js`, total 503): pure builders, end-to-end join/leave happy paths (real modules + stubs), every silent-failure warning, the GUILD_ID guard visibility, `/test-welcome` end-to-end via the real command module (healthy / not set / ghost ID / missing permission / goodbye), registry + router + ready.js contracts.

## [3.9.47] — 2026-09-09

### Changed — ✨ user request: "trigger 'beli' must also answer 'bagaimana cara beli' — and let me choose between exact and contains matching" + "the stats don't match"

**Auto-Responder match modes:**

- 🟡 **User report:** a trigger only fired when the message STARTED with it — trigger `beli` never matched `bagaimana cara beli`. Every responder now has a `matchMode`, and `/add-responder` gained a `match_mode` option:
  - **Contains (default, also applied to legacy entries without the field):** the trigger matches as a **whole word anywhere in the message** — `beli` fires on `bagaimana cara beli` / `mau beli?` — but NOT on `belian` / `membeli`. Word boundaries are letter/digit aware (`\p{L}\p{N}` via a Unicode regex, with all trigger metacharacters escaped), so longer words that merely CONTAIN the trigger as a substring don't cause false alarms. Multi-word triggers (`cara beli`) work, and message whitespace is collapsed so doubled spaces still match.
  - **Start of message (exact):** the legacy prefix behavior — `!sosmed` matches `!sosmed halo` but not `oi !sosmed halo`.
- 🟢 The add/list confirmations now show the match mode per entry (with the `beli` example in the hint), and `/list-responder` displays it per line.
- 🟢 Cooldown fix along the way: a responder on cooldown no longer aborts the whole scan (`return null`) — the loop continues, so an overlapping second trigger (e.g. `beli` + `cara beli` in one message) can still reply.

**Stats accuracy (user report: "the stats don't match"):**

- 🟡 `/stats` used to show only accumulated `stats.json` numbers: "Total Member Tracked" (only members the bot recorded — ≠ the real member count) and "Total VIP Purchases" (label said VIP, but it counts ALL transactions: ticket orders + escrow deals) — with no live server data, so the embed rarely matched what the admin sees in Discord. Now `/stats` leads with **live data straight from the guild object** (real member count, boost tier + count, open tickets via the new `ticketManager.getActiveTicketCount()`) followed by clearly-labeled tracked activity, the server name in the title, and the server icon as thumbnail. "VIP Purchases" renamed to **Transactions**.
- 🟡 `/my-stats` showed "Joined Tracking: not recorded" for everyone who joined before v3.2 — the embed now shows the REAL join date from `interaction.member.joinedTimestamp` (with the tracked value as a fallback for partial members).
- 🟢 `/help` catalog: the Statistics + Auto-Responder categories now describe what the commands actually do (the responder category also documents `match_mode`); the All-Commands embed was re-measured to stay under the 5,800-char budget with all 20 categories intact (5.777 used).
- 🟢 +22 unit tests (total **486**): `responderMatchMode.test.js` (14) — pure matcher (contains/word-boundary/exact/multi-word/regex-escape/invalid input), storage defaults, legacy-entry migration, the user's exact scenario, cooldown interplay incl. the continue-scan fix, registry contract; `statsDisplay.test.js` (8) — end-to-end `/stats` & `/my-stats` via the real command module with a stubbed interaction (live fields, transaction label rename regression, boost/ticket/join-date edges, guild-scoped ticket count, residue cleanup).

## [3.9.46] — 2026-09-09

### Fixed — 🟡 the "Message Content Intent" console hint fired FALSE alarms even with the intent fully enabled

- 🟡 **Production report:** `⚠️ [HINT] Message from thor064747 ... has empty content` appeared at startup while the bot was online and the intent was active. Proof the intent was on: `index.js` requests `GatewayIntentBits.MessageContent` in the IDENTIFY payload — with the portal toggle OFF, discord.js crashes at login (`Privileged intent provided is not enabled or whitelisted`), so an online bot means an enabled intent.
- 🟡 **Root cause:** the hint's trigger only excluded attachments/stickers/components. Legitimately text-less messages slipped through and were misdiagnosed: **native Discord polls** (`message.poll`), **Tenor GIF-picker messages** (a "gifv" embed with no content), and **system messages** (join notifications, pins — `message.type !== 0`). One such message from a member → the admin is told to "fix" a portal setting that is already correct.
- 🟢 **Fix:** the exclusion list is centralized in a pure, exported helper `isContentlessByDesign(message)` (attachments, stickers, components, embeds, poll, system, non-DEFAULT type). The hint now only fires for a message that genuinely should have text but arrived empty — a real intent problem.
- 🟢 +3 regression unit tests (total **464**, `messageContentHint.test.js`): pure helper coverage for all 7 sources; end-to-end `execute()` with a stubbed `console.warn` (poll/gif/system/attachment → 0 warnings); and the old contract intact — a plain empty message still warns exactly once per guild per 24h.

## [3.9.45] — 2026-09-07

### Fixed — 🔴 hotfix: every moderation command crashed at its first permission check ("TypeError: Cannot read properties of undefined (reading 'ManageMessages')")

- 🔴 **Production error report:** `npm start` → `/purge` → `Interaction Error: TypeError: Cannot read properties of undefined (reading 'ManageMessages') at moderation.js:193` — with the same landmine under `/timeout` `/untimeout` `/kick` `/ban`.
- 🔴 **Root cause:** `src/commands/moderation.js` (added in v3.9.43) destructured `PermissionFlagsBits` from `./_shared` — but `_shared.js` never imported or re-exported it. Destructuring a missing export is *silent*: the variable is simply `undefined` at require time, then detonates the first time a bot-permission check reads `.ManageMessages` / `.ModerateMembers` / `.KickMembers` / `.BanMembers`. One bug, six dead commands.
- 🔴 **Why every QC gate waved it through (457 green tests, ESLint 0):** a missing export is not a syntax error and not an undefined *variable* (the binding exists), and no unit test executed the moderation permission-check path against the real module graph — the handler contract tests were static.
- 🟢 **Fix (one line of export):** `_shared.js` now imports & re-exports `PermissionFlagsBits` from discord.js — the one-gateway `_shared` pattern stays intact, all six moderation commands work again.
- 🟢 +2 regression unit tests (total **461**, `sharedExports.test.js`): **(A)** `_shared` must export the real discord.js `PermissionFlagsBits` (same object reference + the 5 bits moderation/midman use); **(B)** a whole-class safety net — every identifier destructured from `require(..._shared)` anywhere in `src/**` is cross-checked at test time against the runtime exports, so the *next* missing export fails in CI instead of crashing in production the first time a user runs the command.

## [3.9.44] — 2026-09-06

### Changed — ✨ user request: "/warn lives under Scheduled Announce — please read & sync every feature and reorganize /help so it is easy to understand"

**Complete /help catalog redesign — 20 categories ordered by usage priority:**

- 🟢 **Main complaint fixed:** `/warn` `/warn-list` `/warn-remove` `/warn-clear` **moved to the Moderation category** (they used to sit under "Scheduled Announce & Warn" — illogical). Moderation is now one complete place: warn → timeout → kick → ban + purge, with the sanction ladder explained (3=mute 1h, 5=mute 1d, 7=kick).
- 🟢 **New category 🚀 Quick Start** — a fresh-server setup order in 5 steps (`/set-role verified` → categories & products → ticket panel → verification → server-log). New admins no longer have to guess where to begin.
- 🟢 **Structure reordered by how often things are used:** Quick Start → Moderation → Products → Keys → Panels → Categories → Escrow → Logging & Channels → Auto-Mod → Responder → Roles → Leveling → AFK → Giveaways → Announcements → Messages & Embeds → Voice → Backup → Stats → Info.
- 🟢 **Previously messy categories cleaned up:**
  - "Scheduled Announce & Warn" → **Scheduled Announcements** (pure announce, no warns).
  - "Announce, Embed & Backup" → split into **Messages & Embed Builder** + **Backup & Maintenance** (backups & reset-config are not "announcements").
  - "Stats & More" → pure **Statistics**; `audit-log` moved to **Logging & Channels**, `reset-config` moved to **Backup & Maintenance**.
  - **`/set-channel` was previously scattered across 3 categories** → now one place: **Logging & Channels** (server-log, audit-log, transcript, welcome, goodbye, invoice + an explanation of each type).
- 🟢 **New 🏠 home** — a "What do you need right now?" section (member trouble? → Moderation · setting up sales? → Quick Start · want oversight? → Logging & Channels · quiet server? → Giveaways & Leveling) routes admins straight to the right category without reading everything.
- 🟢 Every command now gets a **one-phrase explanation** — a new admin never has to guess a command's purpose from its name.
- 🟢 **"📖 All Commands" budget stays safe** — all 20 categories still fit in 1 embed (5.686 of the 5.800-char budget; the old version was 5.752) — the category-drop guard stays inactive, nothing is hidden.
- 🟢 Search follows the new structure automatically — `search:warn` now lands in **Moderation**; old category ids in still-open ephemeral messages remain safe to click (fallback to home, not a crash — the existing mechanism).
- 🟢 +2 regression contract unit tests (total **459**): `/warn*` must live in Moderation & the announce category must not mention warn; Quick Start first + new categories (logging/backup/stats/info) mandatory.

## [3.9.43] — 2026-09-06

### Added — 🛡️ user request: "add a complete moderation package and a server log for message delete/edit and more"

**Full moderation pack — 6 new commands (88 total):**

- 🟢 **`/timeout user duration reason`** — temporary mute; `duration` in **minutes** (60 = 1 hour, 1440 = 1 day, max 40320 = 28 days — the Discord limit); reason DM to the member (best-effort); recorded in the moderation history + audit log (`MOD_TIMEOUT`).
- 🟢 **`/untimeout user reason`** — lift a mute early; only runs if the user is actually muted (`isCommunicationDisabled()`), never overwrites someone else's timer.
- 🟢 **`/purge amount user?`** — bulk delete 1–100 messages; optional per-user filter; messages **older than 14 days are skipped automatically** (bulk delete API limit) with a skipped-count report; 1 message → single delete (bulkDelete needs ≥2); audit `MOD_PURGE`.
- 🟢 **`/kick user reason`** — the DM is sent BEFORE the kick (the member context still exists, most reliable delivery); recorded + audited.
- 🟢 **`/ban user reason delete_days?`** — `delete_days` 0–7 (the `deleteMessageSeconds` API limit); DM before the ban; recorded + audited.
- 🟢 **`/unban user_id reason`** — takes a User ID string (the user is not in the guild); 17–20 digit snowflake validation; checks the ban list first so the error message is clear; recorded + audited.

**Guards & design (unit-tested, `src/infra/moderationGuards.js`):**

- 🟢 **Two-way hierarchy**: the moderator's AND the bot's highest roles must be above the target's — same level = rejected (consistent with `/warn` v3.9.8); self/bot/bot-targets rejected.
- 🟢 **Two-sided limit parity**: slash command option bounds (min/max value) = runtime guard bounds (40320 minutes, 100 purge, 7 days) — neither side can leak.
- 🟢 **Bot permissions checked up front** (ModerateMembers/KickMembers/BanMembers/ManageMessages) with clear English messages — not a raw "Missing Permissions" API error.
- 🟢 **`MODERATION_COMMANDS` router gate**: non-admin moderators holding the matching Discord permission may now use the moderation commands — staff don't need the bot's admin role (least privilege; hierarchy guards still run in the handler).
- 🟢 **modLogManager (`data/modlogs.json`)** — actions are NOT counted as warns (no double punishment: 3 timeouts do not trigger an extra auto-mute); but they render in `/warn-list` in a **"⚡ Moderation History"** section — a 0-warn user with moderation history still shows (pulled before the early-return); description guarded with `truncateUtf8Safe` 4096.

**Server Log — 8 server events to a new `server-log` channel (separate from `audit-log`):**

- 🟢 **Message deleted** (`messageDelete`) — the content + **who deleted it** (executor detection via Discord's audit log, 60-second window — catches manual deletions from the Discord UI; the only way to see what a deleted message said); partial → "not cached" note.
- 🟢 **Message edited** (`messageUpdate`) — before/after + message link (proof of a seller changing the price after a deal); skips edits with no content change (pin/embed-only).
- 🟢 **Bulk purge** (`messageBulkDelete`) — count + executor; catches manual purges & AutoMod, not just the bot's `/purge`.
- 🟢 **Join/leave** (inside `guildMemberAdd`/`Remove`) — account age (new-account detection), member count; **manual kicks from the Discord UI are detected** via the MemberKick audit (labeled differently from a voluntary leave).
- 🟢 **Ban/unban** (`guildBanAdd`/`Remove`) — including manual bans from the Discord UI; executor + official reason from the audit log.
- 🟢 **Role & nickname changes** (`guildMemberUpdate`) — catch scammers switching identity / unexpected access changes; partial old state → per-section skip.
- 🟢 Every handler guarded: single-guild `GUILD_ID` (v3.9.26 pattern), bot skips (no flooding from the bot's own embeds), best-effort audit fetches (works without View Audit Log), `logServerEvent` **never throws** + field truncation 1024/25/6000 (an event error must never crash the bot); without a configured channel everything is a no-op.
- 🟡 **`GuildBans` intent enabled** in `index.js` — without it the ban/unban events NEVER fire (a regular intent, no Developer Portal toggle). WITHOUT THIS: the ban-log feature would be silently dead.
- 🟢 **`/set-channel` & `/remove-channel`** now know the `server-log` type; 6 `MOD_*` audit labels added.

### Tests

- 🟢 +21 unit tests (total **457**, up from 436): `tests/unit/moderation.test.js` (12) — behavioral hierarchy/limit guards, modLogManager roundtrip + corrupt-file quarantine, registry↔guard parity, router mapping + moderator gate, handler contracts (member.timeout called, best-effort DM, filterBulkDeletable, deleteMessageSeconds v14), /warn-list integration (pull order before the early-return, 4096 guard), audit labels; `tests/unit/serverLog.test.js` (9) — behavioral logServerEvent (unconfigured channel → false, embed title/color/fields, 1024 + 25-field truncation, send throwing → false without re-throw), snip, findAuditExecutor (window/target/channel), event registration + the GuildBans intent, per-event-file guards. Full suite 457/457 green, ESLint 0 warnings.

## [3.9.42] — 2026-09-05

### Changed — 🔔 user request: "don't DM the voice owner, just tell them in the voice chat"

The **temp-voice new-owner notification** is no longer sent via DM — it is now posted in the **voice channel's own text chat** with a mention of the new owner (the ping notification still works). Applies to both ownership-change paths:

- 🟢 **Auto-transfer (owner leaves the voice channel)** — previously a DM to the most senior member inheriting the channel; DMs often failed silently (user DMs closed — swallowed by `catch (_) {}`) or went unread. Now: a `🎁 <@newOwner> You are now the owner of voice channel...` message appears in the channel chat, visible to everyone inside.
- 🟢 **Manual transfer via the panel** — same pattern; plus `oldOwnerId` is now captured explicitly **before** `transferOwnership` overwrites the registry, so the "Ownership was transferred to you by <@oldOwner>" message no longer depends on an in-memory object that could change if `load()` ever gets cached.

### Tests

- 🟢 +3 unit tests (total **436**, up from 433): `tests/unit/voiceNotify.test.js` — static anti-regression contract: (1) auto-transfer goes through `voiceChannel.send`, not `newOwner.send`, with a new-owner mention, (2) manual transfer goes through `found.channel.send` + the `oldOwnerId` capture ordering before `transferOwnership`, (3) regression: the temp-voice domain stays free of new-owner DMs. Full suite 436/436 green, ESLint 0 warnings.

## [3.9.41] — 2026-09-05

### Fixed — 🔍 Full re-debug in response to a production error report ("Interaction Error: ExpectedConstraintError — s.string().lengthLessThanOrEqual()")

Trigger: the user reported error-log spam every time the **embed send modal** was opened in production. Root cause: `TextInputBuilder.setLabel` has a Discord limit of **45 characters** — the English labels `'Message outside the embed (optional, supports @)'` (48 chars) and `'Message outside the embed (leave empty to remove)'` (49 chars) **exceeded the limit**, so the builder threw before the modal could even render. The Indonesian twin happened to stay ≤ 45 (`Pesan di luar embed (opsional, support @)` = 40) — which is why this bug only surfaced in the EN repo: the earlier v3.9.27 limit fix only covered the ticket flows, and the EN embed file slipped through the audit because it was checked via its Indonesian twin.

- 🟠 **The "Send Embed to Channel" modal was completely dead in the EN repo** — the 48-char label caused an `ExpectedConstraintError` on EVERY send-button click, making the embed send flow unusable. Fix: the label was shortened to `'Message outside the embed (optional)'` (36 chars); the @-mention hint stays complete in the placeholder (limit 100).
- 🟠 **The "Set Message (Plain Text)" modal was completely dead in the EN repo** — the 49-char label caused the same throw. Fix: a 36-char label; the "leave empty to remove" hint was moved into the placeholder.

### Audit — 🛡️ full sweep of every Discord component limit (not just the crashing one)

An automated scan of the full source of both repos against ALL builder limits: TextInput label ≤ 45 / placeholder ≤ 100 / `setMaxLength` ≤ 4000, Modal title ≤ 45, Button label ≤ 80, Select option label & description ≤ 100 (call-sites classified by their nearest constructor). Result: **0 literal violations remain** in either repo; every dynamic site (template literals) was verified as already guarded by the v3.9.26/27 fixes (`.slice(0,45)` ticket modals, `.slice(0,100)` select placeholders) or bounded by input validation (product label ≤ 80, poll question ≤ 250, panel field ≤ 9 chars, config tipe ≤ 17 chars).

### Tests

- 🟢 +4 unit tests (total **433**, up from 429): `tests/unit/componentLimits.test.js` — (1) a static scan asserting zero literal violations across all of src/ (**a permanent safety net** — any future PR that adds an over-length label instantly goes red with a file:line message), (2) a runtime contract for every modal label/title in `embed.js` against REAL discord.js builders (not mocks), (3) limit documentation (46 chars throws / 45 passes), (4) a specific regression for the embed send modal. Full suite 433/433 green, ESLint 0 warnings.

## [3.9.40] — 2026-09-04

### Fixed — 🛡️ Post-v3.9.39 full audit ("check the whole codebase + sync the docs"): 6 real bugs + hardening + docs sync

A 3-domain parallel review (escrow/scheduler, tickets/automod/data-layer, /help redesign) of the v3.9.38 & v3.9.39 results — **all v3.9.38 fixes were confirmed correct** (transitionLocks, isCompleted gates, giveaway fresh re-read, etc.) and the **82-command registry vs help-catalog cross-check is clean** (0 missing/stale commands). New bugs found & fixed:

- 🟠 **`/help search:<long query>` crash** — a Discord STRING slash option can be up to 6,000 chars; a query ≥ ~3,875 chars was echoed into the results embed → description > 4096 → `EmbedBuilder.setDescription` THROWS (uncaught) → the feature silently errors. Now: `max_length: 100` in the registry (consistent with the modal, already 100) + a 100-char cap in `searchHelp` (defensive — closes both entry points at once); backticks in the query are sanitized so they can't break the embed header styling.
- 🟠 **Manual `/giveaway end` with 0 participants was silent** — `isManualAnnounce` required `winnerIds.length > 0`; a giveaway with no participants was skipped ENTIRELY: the giveaway message was never edited (the 🎉 Join button stayed live and clickable!), no "ended with no winners" announcement — even though the admin saw a success message claiming "message updated + winners DMed + announced". The correct manual marker is now `skipPick && ended` → the ended embed + disabled buttons + no-winner announcement are delivered.
- 🟠 **Transient ticket verification → duplicate ticket** — `findActiveTicketFor` still returned `null` on a 429/5xx error (the meta was safe on disk, but callers read "no active ticket") → `createTicket` created a SECOND channel for a user with a live ticket (2 live metas, the invoice/isCompleted guards split). Now it throws with code `TICKET_VERIFY_TRANSIENT`; `createTicket` + the 3 escrow call sites (pick buyer/seller) catch it and ask for a retry — the 1-active-ticket-per-user invariant holds.
- 🟠 **Close-ticket vs completion race** — admin B clicking "❌ Close Without Completing" / "✅ Done" while admin A was still processing Set Key / Deliver Order (holding `completionLocks`) → the channel + meta were deleted first → flow A wrote to a vanished meta → the buyer still received the key/role/invoice but the transcript was archived as "Cancelled" (contradictory records). Both close buttons now reject with "⏳ being processed by another admin" while the lock is held.
- 🟠 **PARALLEL interaction replay double-executed** — v3.9.38 moved the dedup mark to AFTER handler success (correct for crash retries), but that opened a window: a gateway replay arriving WHILE the first handler was still running passed check() + the replied guard → the handler ran 2x in parallel (a selfrole toggle could revert). Now: an `inFlightInteractions` guard (silent drop — the first instance owns the interaction token); the v3.9.38 crash-retry semantics stay intact.
- 🟡 **Zombie-deal reconcile could resurrect** — `reconcileZombieDeals` deleted the meta of a deal whose channel was gone WITHOUT checking `transitionLocks`; if a handler was mid-transition on that same channel, its `setDeal` rewrote the just-deleted meta → the zombie came back (buyer/seller locked out of `hasActiveDealFor` for up to 24h). Reconcile now skips locked deals.
- 🟢 **Minor hardening**: Discord limit guards on the "📖 All Commands" view for giant catalogs (field value ≤ 1024 + fields ≤ 25 + a guaranteed total ≤ 6,000 with a note pointing to dropdown/search — replacing the dead-code 2-embed split path from v3.9.39 that could overshoot); the "ghost member" channel permission is revoked when the escrow fresh-check fails after the grant; transcripts escape ``` in user content (the code fence no longer breaks); alien `help_*` customIds get an ephemeral ack (instead of a red "interaction failed"); the automodManager `require('discord.js')` was hoisted out of the per-message hot path.

### Docs — 📚 documentation synced to the actual code (docs audit findings)

- 🟢 Every stale version number fixed: `docs/ADMIN_GUIDE.md` header & footer (3.9.38 → 3.9.40), `docs/README.md` (3.9.38 → 3.9.40), unit test counts in all three docs (386/412 → **429**), "16 managers" → **18** (matching the actual `src/data/` files), "50 action types" → **63** (matching `ACTION_LABELS`).
- 🟢 New tip in ADMIN_GUIDE Section 1: how to use the `/help` interactive navigator (19-category dropdown + Search Commands + `/help search:`) — the v3.9.39 feature was previously undocumented in the guide body.

### Tests

- 🟢 +17 unit tests (total **429**, up from 412): `tests/unit/hardeningV40.test.js` — long/backtick queries (slash + modal), registry max_length, a 49-category & giant-field catalog stress test (1024/25/6000 guards + notes), manual giveaway end with 0 participants, the transient throw + createTicket abort (1-meta invariant), the close-vs-completionLocks race (2 buttons), the parallel in-flight replay + post-throw retry, reconcile skipping locked deals, transcript ``` fences, acknowledging alien help customIds; + the v3.9.38 transient test contract updated (null → throw `TICKET_VERIFY_TRANSIENT`). Full suite 429/429 green, ESLint 0 warnings.

## [3.9.39] — 2026-09-04

### Changed — 🚀 /help redesign: interactive navigator — find commands without scrolling (user-reported: "one giant embed, finding a command meant scrolling")

`/help` used to send ONE giant embed (~5,400 chars, 18+ categories on a single page) → admins had to scroll far to find a command. It is now an **interactive navigator** inside one clickable ephemeral message:

- 🟢 **🏠 Home (default)** — a condensed index of 19 categories (3 per line) + search instructions. The embed is only ~860 chars — fits one screen.
- 🟢 **📂 Category dropdown (String Select Menu)** — pick 1 of 19 categories (emoji + name + short description) → only that category's command details are shown (small embed). The dropdown stays attached to every view for jumping between categories without going back home.
- 🟢 **🔍 Search Commands (button + modal)** — type any free-form keyword (`key`, `escrow`, `vip`...) → instant results grouped by category, case-insensitive substring matching; if the keyword hits a category NAME, the whole category is displayed. Results are capped at 20 blocks (with a "+more results" note) so the embed stays small and scannable.
- 🟢 **`/help search:<keyword>` (new slash option)** — search directly without opening the menu (Discord autocomplete helps clients that already know what they want).
- 🟢 **📖 All Commands (button)** — the old full-list view is still available for those who prefer scrolling; auto-splits into 2 embeds if > 5,800 chars (combined total still ≤ 6,000 within 1 message).
- 🟢 All navigation uses `interaction.update()` → **the same single message gets edited**, no new-message spam while switching categories; customIds are stable (no id suffixes) → `/help` messages that are still open remain clickable after a bot restart.
- 🟢 **Architecture**: all help content now has a single source of truth in `src/ui/helpCatalog.js` (19-category catalog + embed builders + the search engine + component builders) — shared by the slash command (`src/commands/help.js`) and the new interaction handler (`src/interactions/help.js`, router prefix `help_`). Adding a category = adding 1 catalog entry; dropdown/home/search/all follow automatically.
- 🟢 **Defensive**: an unrecognized dropdown value (an old message after a catalog update) → safe fallback to home instead of "interaction failed"; empty queries / empty modals are handled with guidance text.

### Tests

- 🟢 +26 unit tests (total **412**, up from 386): `tests/unit/helpNav.test.js` — catalog integrity (unique ids, ≤25 select options, label/desc ≤100 chars, every view ≤ 4096/6000 chars), the search engine (case-insensitive, whole-category match, bullet blocks carrying continuation option lines, empty/no-result, result cap), the slash command (home/search/whitespace), the interaction handler (dropdown known/unknown, showModal required, modal submit, home/all buttons, foreign customId), `help_` prefix routing, old content regression (Auto-Split 3 categories, midman, use_dropdown, update-category/product) — 3 old tests that locked the giant-embed structure were updated to the navigator structure. Full suite 412/412 green, ESLint 0 warnings.

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
