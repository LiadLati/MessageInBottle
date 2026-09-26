# 01 — Frontend, UX and accessibility (pre-production re-audit)

Agent 1 · scope: `apps/web` (and the API only where it decides what the UI shows) · commit `a04526f` (detached worktree `rerun/wt-1`). Inspect-and-report only: no application code, schema, config or dependency was changed; `git status` of the worktree is clean. The lead's checkout and its database were never opened.

## Verdict

**CONDITIONAL GO for the frontend/UX/a11y scope.**

- No P0 and no P1 was found. Every earlier frontend P1 (FE-001, FE-002) is closed and was re-verified in a browser.
- 9 P2 findings are open. The condition for GO is that the owner accepts them with dates. Two should be fixed before release because the fixes are small and the harm is concrete: **FE-R-001** (in phone landscape the report form cannot be submitted by touch or pointer) and **FE-R-002** (one stray tap permanently ends a finder's one-time reading).
- 10 P3 findings can go to the backlog.

Counts: **P0 0 · P1 0 · P2 9 · P3 10**.

## Method and environment

- Every web screen, component, hook and the relevant CSS was read at code level. `docs/REMEDIATION.md` claims were checked against code and against running behaviour, not taken on trust.
- Each browser run used an API on port 3201 and Vite on port 5301, always with a fresh temporary database under `rerun/a1/db/` and `MIB_AI_ENABLED=false`:
  - `main.sqlite`: dev mode, `MIB_SHORE_CAPACITY=8` so that a full shore could be reached quickly.
  - `storm.sqlite`: dev mode, capacity 100.
  - Production mode: `MIB_DEV_MODE=false` with the production web bundle (`vite build` + `vite preview`).
- Roles were granted only on the temporary databases, with the repo's `grant-developer.ts` and `grant-admin.ts`. Time was moved with the journey dev clock (`/dev/advance`, `/dev/arrive`) and outcomes with `/dev/lose`. No mail was delivered: the outbox or disabled provider was used.
- Browser: Chromium 1194 (playwright-core 1.50.1), with SwiftShader WebGL, and a second profile with `--disable-webgl --disable-3d-apis`.
- Viewports: 390×844, 667×375, 740×360, 844×390 and 1280×800.
- axe-core 4.10.2 was loaded from a scratch copy and injected into every screen and state checked.
- Contrast was measured from rendered pixels, using the same method as the previous audit: each element was screenshotted with and without its text colour and the best text pixel compared with the pixel behind it.
- Scripts: `rerun/a1/s1-public.mjs` through `s21-back.mjs`. Screenshots: `rerun/a1/shots/`. Paths below are relative to the repo root unless marked `a1/`.
- Password-reset links, tokens, e-mail addresses and letter text are not reproduced here. All test letters were synthetic.

## Findings

### FE-R-001 — In phone landscape the in-reader report form cannot be submitted by touch or pointer

- **Severity:** P2. **Status:** newly discovered. **Confirmed.**
- **Evidence:**
  - `apps/web/src/styles.css:1837-1845`: `.letter-modal-dialog` has `max-height:100%` and `overflow:hidden`. Only `.letter-modal-scroll` (`:1885-1890`) scrolls.
  - When `ReportSheet` opens inside the dialog (`components/LetterModal.tsx:149-152`), the form is taller than the dialog.
  - Hit-testing (`a1/s20-reportfit.mjs`, `a1/s7b.mjs`), with the dialog clipped at y≈343 in every case:

    | Viewport          | "Send report" position |
    | ----------------- | ---------------------- |
    | 667×375           | `offscreen(408,443)`   |
    | 740×360           | `offscreen(419,443)`   |
    | 844×390           | `offscreen(433,443)`   |
    | 390×844, 1280×800 | ok                     |

  - Mouse-wheel over the dialog leaves `scrollTop` at 0 (`after wheel: dialog scrollTop 0 send offscreen`).
  - Screenshots: `a1/shots/report-sheet-l667-after-wheel.png`, `a1/shots/bob-report-l667.png`.
  - The finder's one-time-reading notice (`.letter-modal-foot`) is also clipped off-screen in the same state.
  - Block confirmation still fits.
- **Reproduction:** as a recipient, or as a finder during a reading, hold the phone in landscape → Report → the Cancel and Send buttons are below the dialog edge and cannot be scrolled to by touch. Keyboard Tab does reach them, because focus scrolls hidden overflow.
- **Impact:** a user in landscape cannot submit a safety report until they rotate the device. Reporting is the Child Safety Standards' "fastest route".
- **Fix:** make the dialog itself the scroll container (`overflow:auto; overscroll-behavior:contain`), or let the report panel scroll inside a bounded region.
- **Regression test:** Playwright at 667×375, 740×360 and 844×390. Open Report and assert that `elementFromPoint` at the Send button's centre is the button without programmatic scrolling. Repeat after a wheel or touch scroll.
- **Relation:** same class as FE-004 and FE-005 (landscape reachability), on a surface they did not cover.

### FE-R-002 — A finder's irreversible one-time reading ends on a backdrop tap or Escape, with no confirmation

- **Severity:** P2. **Status:** newly discovered; this is about how D12 is implemented, not a challenge to D12. **Confirmed.**
- **Evidence:**
  - `components/LetterModal.tsx:95` (`<div className="letter-modal-backdrop" onClick={close} …>`) and `:91` (`useModalKeys(dialogRef, close)`).
  - `screens/OceanScreen.tsx:316-322`: `closeReader` calls `api.closeReading` for a `public` bottle.
  - `a1/s7-letters.mjs`: after opening a found bottle, a single tap at (10,5), outside the dialog box `{y:147…612}`, gave `reader open: 0` and `GET /api/ocean/reading → {"reading":null}`.
  - Re-opening is refused (`UnavailableCard` "You have already read this letter").
- **Impact:** D12 says closing the letter ends the reading. Here a stray tap or an Escape press counts as closing, although the letter is the only copy the finder will ever see. The same gestures are harmless in the recipient's reader, so users are trained to expect "tap outside = dismiss".
- **Fix:** for `oneTime` readings, make the backdrop inert and have Escape and "Close letter" ask for confirmation, or make only an explicit "End reading" button close it.
- **Regression test:** component test with `oneTime`: a backdrop click and Escape must not call `onClose` without a confirmation step. Browser test: `/api/ocean/reading` is still non-null after a backdrop tap.

### FE-R-003 — Day/night, the storm and the suspension countdown are computed from the device clock, not the server's

- **Severity:** P2. **Status:** newly discovered; it contradicts accepted decision D7 / spec §9.3. **Confirmed.**
- **Evidence:**
  - Spec §9.3: "every active session of the account draws the server's stored value, so the displayed map and the server's storm state cannot disagree."
  - `state/weather.tsx:100,186,204-218`: the phase comes from `phaseAt(Date.now() + devOffset, zone)`, and the storm counts as "active" by comparing the device `Date.now()` with `storm.startsAt/endsAt`.
  - The server's `phase` and `serverTime` (`packages/shared/src/api.ts:263,283`) are fetched every 20 s and ignored.
  - `a1/s13-storm.mjs`, with the device clock set 12 h ahead (`page.clock.install`): `server phase night | page palette day` (`a1/shots/storm-clock-skew-390.png`).
  - `screens/StandingScreen.tsx:24-32`: the suspension countdown also uses `Date.now()`, so a fast clock shows "0m left" while the server still suspends.
- **Impact:**
  - A phone with a wrong clock (manual time, a travel mistake) shows day while the server rolls and decides storms at night.
  - It hides a storm that is deciding its bottles, or shows one that is not.
  - A suspended user sees a countdown that disagrees with the server.
- **Fix:** derive the offset `serverTime - Date.now()` from each weather or standing response (the API already sends `serverTime`) and use the corrected instant. Better still, use the server's `phase` directly and derive only boundary timers locally.
- **Regression test:** `weather.test.tsx` with a mocked `Date.now()` skewed ±12 h against a fixed `serverTime`/`phase`: the map phase must equal the server phase. The same test for `useCountdown`.

### FE-R-004 — There is no Block on an incoming friend request, and Deny lets the same person ask again at once

- **Severity:** P2. **Status:** newly discovered (safety UX). **Confirmed.**
- **Evidence:**
  - `screens/FriendsScreen.tsx:96-131`: request rows offer only Deny and Accept. Block exists only for accepted friends (`:155-164`), and there is no block-by-username anywhere.
  - `apps/api/src/services/friends.ts:164-176`: Deny deletes the pending row, and `sendFriendRequest` (`:95-143`) has no cooldown.
  - `a1/s8-troll.mjs`, five Deny → re-request cycles: `deny:204 rerequest:204 …` ×5.
- **Impact:** a harasser can keep a request (and its nav badge) in front of the target indefinitely. The only way to stop it is to accept the request, which makes them friends and lets them address bottles, and then block. The spec asks for request rate limits and a blocked state on Friends (§8.1, §12).
- **Fix:** add "Block" to incoming-request rows, calling the existing `POST /friends/blocks` by username. Optionally stop repeat requests after a Deny (cooldown or silent suppression).
- **Regression test:** screen test: a request row exposes Block and calls `blockUser`. API test: a request after Deny within the cooldown is refused or suppressed.

### FE-R-005 — A reporter cannot flag child safety; without the AI model nothing is prioritised, and the console waits for a model that never comes

- **Severity:** P2. **Status:** newly discovered, with a production-configuration dependency. **Confirmed.**
- **Evidence:**
  - Reasons are `packages/shared/src/api.ts:500-508` and `components/ReportSheet.tsx:6-14`: harassment, hate, sexual, violence, self-harm, spam, other. There is no child-safety reason, and the default preselected reason is "Harassment or threats".
  - Only the model can set `urgentAt` (D2). Queue order is `apps/api/src/services/admin.ts:225`: urgent first, then **newest first** by `updatedAt`.
  - With `MIB_AI_ENABLED=false` (`services/ai-review.ts:188`) cases stay `queued` for good.
  - The console then says "AI: waiting for model" (`screens/AdminScreen.tsx:193`) and "Waiting for the local model. The case stays in the queue until it answers" (`:533`). Seen in `a1/s10-modui.mjs` ("AI: WAITING FOR MODEL" on every case).
- **Impact:** the Child Safety Standards (`packages/shared/src/policies.ts` §3) point users to in-app reporting as "the fastest route". Yet when the model is off or down, a child-safety report is indistinguishable from spam and sinks below newer reports, and the administrator is told to wait for a model that is not running. This does not reopen D2: AI still never decides. It is a gap in how urgency reaches the reviewer.
- **Fix:**
  - Add a "Involves a child / child safety" reason that marks the case urgent on its own.
  - Order the rest of the queue oldest-first.
  - Show "Automated review is off" when AI is disabled.
- **Regression test:** API test that a report with the child-safety reason sets `urgentAt` and lists first with AI disabled. Admin screen test for the AI-disabled label.

### FE-R-006 — Focus is dropped to `<body>` whenever a view changes in place

- **Severity:** P2. **Status:** newly discovered; partly the previous A11Y-005/A11Y-006/A11Y-013 area. **Confirmed.**
- **Evidence** (`document.activeElement` after each step, from `a1/s4-write.mjs`, `s7-letters.mjs`, `s10-modui.mjs`, `s15-misc.mjs`):

  | Step                           | Focus lands on | Code                                           |
  | ------------------------------ | -------------- | ---------------------------------------------- |
  | Write → choose recipient       | BODY           | `screens/WriteScreen.tsx:58-61`                |
  | → Seal the letter              | BODY           | `:63-73`                                       |
  | → release failed (rewind)      | BODY           | `:107`                                         |
  | → release completed            | BODY           | —                                              |
  | Finder reader → Block          | BODY           | `LetterModal.tsx:128-137` unmounts the trigger |
  | Report → Cancel                | BODY           | `LetterModal.tsx:151`                          |
  | Letters folder tabs, ArrowLeft | BODY           | see below                                      |
  | Friends → Block → confirm      | BODY           | `FriendsScreen.tsx:26-40`                      |
  | Decision notice answered       | BODY           | `DecisionNotice.tsx:47-53` has no restore      |
  - The Letters tab case is caused by `components/Tabs.tsx:62-63`, which focuses a button of a `TabList` that is unmounted, because `LettersScreen.tsx:58-64` renders a different component per folder. The same happens to AdminScreen's section tabs.

- **Impact:** keyboard and screen-reader users lose their place, and the new step or screen is not announced, on the core path (write → preview → release) and in the moderation notice. WCAG 2.4.3 Focus Order; 4.1.3.
- **Fix:**
  - On each step change, move focus to the new heading (`h1` with `tabIndex=-1`), as `restoreFocus` already does for dialogs.
  - Render one `TabList` above the folder panels so it is not remounted.
  - In the reader, focus the first control of the confirm or report panel on open, and the trigger on close.
- **Regression test:** Testing Library tests asserting `document.activeElement` after each Write step, after arrow keys in the Letters tabs, and after Cancel in the report panel.

### FE-R-007 — Load failures still read as "nothing here" in the Blocked users dialog and the admin queue

- **Severity:** P2. **Status:** unresolved previous finding (FE-007, partly fixed). **Confirmed.**
- **Evidence:**
  - `components/BlockedUsersDialog.tsx:126`: offline, the dialog shows "You have not blocked anyone." above the error, and offers no retry (`a1/shots/offline-blocked-390.png`).
  - `screens/AdminScreen.tsx:137` / `:594`: with `/api/admin/reports` returning 503, the queue shows "No pending cases" above "service unavailable" (`a1/shots/admin-queue-failing-390.png`).
  - Letters, Ocean and My Shore now use `LoadFailed` correctly (verified offline).
- **Impact:**
  - An administrator is told the moderation queue is empty when it could not be read.
  - A user is told they block nobody, which is safety-relevant state.
- **Fix:** order the branches error → loading → empty, using the existing `LoadFailed` with Try again.
- **Regression test:** component tests rendering both lists with a rejected loader: assert "Try again" is shown and the empty-state copy is not.

### FE-R-008 — A full shore is labelled "Room on their shore", and in landscape the real reason is clipped and not announced

- **Severity:** P2. **Status:** newly discovered. **Confirmed.**
- **Evidence:**
  - `screens/WriteScreen.tsx:159` labels every friend with a shore "Room on their shore" (`eligible = f.hasShore`, `:144`). The friend whose shore was full (capacity reached, release refused 422 `shore_full`) was listed as `fay|@fay · Room on their shore`.
  - In the preview, the specific reason (`:326-330`, "This friend's shore is full right now. Your letter is kept as a draft…") is a plain `<p>` with no live region.
  - The text under the button (`:359-366`) says only "This bottle cannot be released right now."
  - At 667×375 the preview's scroll area is 147 px tall and the reason is cut off below it (`a1/shots/write-preview-full-l667.png`).
  - The draft is preserved across a reload (verified), as D6 requires.
- **Impact:** the sender is promised room that does not exist, then gets a generic refusal whose actual reason is invisible in landscape and silent to screen readers.
- **Fix:** replace the label with neutral wording such as "Has a shore". Put the rejection in `role="status"`, or mirror it in `#throw-reason`.
- **Regression test:** WriteScreen test with preview `rejection: 'shore_full'`: the rejection copy is in a live region and referenced by `aria-describedby` on "Seal and throw", and the recipient row does not claim room.

### FE-R-009 — The notification history drops items when new ones arrive after "Load older", and unread state is never perceivable

- **Severity:** P2. **Status:** newly discovered. **Confirmed.**
- **Evidence:**
  - `screens/NotificationsScreen.tsx:51`: `cursor` and the older pages are fixed, while the first page is re-polled every 20 s (`App.tsx:102-106`). When N new notifications arrive, the N items that slide off the polled first page fall into a gap.
  - `a1/s5-notif.mjs`: "server total 64, on screen 62, missing from screen after poll: 2, duplicates 0", after two new events. D11 promises a complete, paginated history.
  - Unread state: `App.tsx:205-207` marks everything read as the inbox opens. `a1/s5b.mjs` showed unread rows `3` immediately and `0` after 80 ms.
  - The unread cue is only a CSS class (`NotificationsScreen.tsx:94`) and is never conveyed to assistive technology.
- **Impact:**
  - Notifications silently disappear from the list while it is open.
  - Users (and screen-reader users entirely) can never tell which notices are new. Spec §12 requires an unread/read state.
- **Fix:**
  - Merge pages by id and cursor: fetch newer items with an `after` cursor, or refetch from the oldest loaded cursor.
  - Snapshot the unread ids before marking them read, and render a visible "New" text on those rows.
- **Regression test:** component test: load an older page, push two new items into the first page, and assert the union equals the server's list. Assert unread rows carry a text marker after the mark-read reload.

### FE-R-010 — The Blocked users dialog reopens over the next account in the same tab

- **Severity:** P3. **Status:** regression of FE-012 (a state added later, `blockedOpen`, is missing from the reset list). **Confirmed.**
- **Evidence:** `App.tsx:96` declares `blockedOpen`; the account-change reset (`:146-160`) does not clear it. `a1/s18-stale.mjs`: open Blocked users → session revoked → sign in as another account → "dialog 1 … Blocked users". The content is the new account's own list, so there is no data bleed.
- **Fix:** add `setBlockedOpen(false)` to the reset.
- **Regression test:** extend the FE-012 browser or component check to every modal flag in `Shell`.

### FE-R-011 — While a decision notice is pending, Sign out and Delete account are unreachable in the app

- **Severity:** P3. **Status:** newly discovered. **Confirmed.**
- **Evidence:**
  - The restricted shell offers Help & Support, Delete account and Sign out (`StandingScreen.tsx`).
  - The `DecisionNotice` alertdialog on top (`App.tsx:284`) inerts everything and offers only Help & Support, Appeal and Continue without appealing.
  - `a1/s10-modui.mjs` (sam, 667×375): "signout covered-by:confirm-backdrop".
- **Impact:** a person who wants to leave or delete the account must first appeal or permanently waive. The Terms promise that a suspended account can sign out and delete (the public `/legal/delete-account` page, linked from Support, remains a workaround). On a shared device, closing the tab is the only way out.
- **Fix:** add "Sign out" (and possibly "Delete account") to the notice; neither resolves the notice.

### FE-R-012 — Shore selection: `<li>` inside `role="radiogroup"`, and an awkward keyboard path on phones

- **Severity:** P3. **Status:** newly discovered; the previous A11Y-009 fix introduced the structure. **Confirmed.**
- **Evidence:**
  - axe `listitem` fires 392× at 667×375 and 4× on search results at 390 and 1280, because `screens/ShoreSetupScreen.tsx:131` puts an `<li>` directly in `ul role="radiogroup"` (`:192`, `:249`).
  - On a phone, arrow-key selection keeps the search open, and the Anchor button only renders when `chosen && !searching` (`:206`). Enter on a result clears the list and drops focus to BODY (`a1/s16-setupkb.mjs`).
- **Fix:** add `role="none"` or `presentation` on the `<li>`. On phone, render the Anchor action with the results, or move focus to it after a pick.

### FE-R-013 — Side-pane layout: an empty right pane, and in phone landscape the only bottle can sit under it

- **Severity:** P3. **Status:** newly discovered (a side effect of the FE-004 fix). **Confirmed.**
- **Evidence:**
  - With nothing selected, `.world-screen.two-pane` (`styles.css:1696-1720`) reserves `--pane-width` on the right and leaves it blank at 667, 740, 844 and 1280 (`a1/shots/alice-Ocean-l667.png`, `alice-Ocean-d1280.png`). The map shrinks to about 295 px on phones.
  - Storm night at 667×375: the bottle marker is at x=486, under the empty pane ("marker covered-by: world-screen two-pane"). The own-harbour label is cut at the pane edge (`a1/shots/alice-Ocean-l844.png`).
- **Fix:** show the bottle list in the pane by default, or collapse the pane when empty, and fit with the pane width as padding.

### FE-R-014 — WebGL-less residuals: pointer instructions without a map, and sunk entries that can never clear

- **Severity:** P3. **Status:** follow-up to FE-006 (closed). **Confirmed.**
- **Evidence:**
  - Without WebGL, the Ocean still says "tap a bottle or route" (`OceanScreen.tsx:411`) and shows the hint pill (`:552`). Shore setup says "Tap a coast or search".
  - Sunk bottles are acknowledged only when the map reports them visible, so without a map they accumulate in the private list for good. The test account listed "68 bottles", most of them sunk (`a1/shots/nowebgl-ocean-390.png`).
  - `ShoreScene` still tries to create a WebGL renderer and logs errors.
- **Fix:** switch the copy when `!mapDrawable`. Treat an entry shown in the list (or its card opened) as seen.

### FE-R-015 — My Shore always says "dusk", and its empty-state text is below 4.5:1

- **Severity:** P3. **Status:** newly discovered; A11Y-002 (previous) was verified fixed elsewhere. **Confirmed.**
- **Evidence:**
  - `screens/MyShoreScreen.tsx:93` hard-codes "dusk" whatever the account's phase (the map showed day at the same moment).
  - The empty-state paragraph (12.5 px/400, `rgba(215,231,228,.6)` on the glass panel over the 3D scene) measured 4.30:1 at best from rendered pixels (`a1/s17-contrast.mjs`, `a1/shots/alice-shore-contrast.png`).
  - Every other surface measured passes. The inactive nav label is 7.7–8.4:1, inactive tabs 7.5:1, the day map subline 5.6:1, the inactive mode option 4.58:1.
- **Fix:** derive the label (and ideally the scene light) from `phase`, and raise the paragraph to `--text-secondary`.

### FE-R-016 — The weather poll still runs in hidden tabs

- **Severity:** P3. **Status:** unresolved remainder of FE-014.
- **Evidence:** `state/weather.tsx:126` uses `setInterval(refresh, 20 s)` with no `document.hidden` check. `a1/s21-back.mjs` counted 3× `/api/ocean/weather` in 61 s with the tab hidden. The other pollers are gated correctly (`lib/useAsync.ts`).
- **Fix:** use the same hidden/catch-up pattern as `useAsync`.

### FE-R-017 — Residual dialog semantics

- **Severity:** P3. **Status:** newly discovered.
- **Delete account dialog:** `components/DeleteAccountDialog.tsx:68` has `aria-labelledby` but no `aria-describedby`. Focus goes to the password field, so the paragraph saying the deletion is permanent is not announced (the same pattern as A11Y-004, which was fixed for the decision notice).
- **Stacked modals:** each modal adds `inert` to all its siblings on mount and removes it on unmount (`DecisionNotice.tsx:48-51`, `LetterModal.tsx:61-71`, `ConfirmDialog.tsx:49-57`). If a decision notice arrives while a letter is open and is then answered, it removes the letter modal's `inert` from the app shell. This is theoretical and was not reproduced.
- **Fix:** add `aria-describedby`, and use a reference-counted inert helper in `lib/modal.ts`.

### FE-R-018 — A truncated password-reset link reports "Please check the fields"

- **Severity:** P3. **Status:** newly discovered. **Confirmed.**
- **Evidence:** a token shorter than 32 characters fails schema validation with a 400 that is not `reset_invalid` (`packages/shared/src/auth.ts:45-48`). `LoginScreen.tsx:49` maps any 400 to "Please check the fields and try again." (`a1/s14-prod.mjs`). A well-formed expired token gets the correct message (`:40-41`).
- **Fix:** in reset mode, treat any 400 as "This reset link is invalid or has expired."

### FE-R-019 — The storm label wraps and floats over the map in the side-pane layout

- **Severity:** P3. **Status:** polish. **Confirmed.**
- **Evidence:** at 667, 740 and 844 the label "A storm is passing over your sea until 11:48 PM" wraps to three lines and sits in the middle of a 295 px map, between the controls and the hint pill (`a1/shots/storm-night-l667.png`).
- **Checked and correct:**
  - `pointer-events:none`, so it never blocks the map (`elementFromPoint` returns the canvas; zoom, list and Public all clickable).
  - `role="status"`, `aria-live="polite"`.
  - The rain animation is off under reduced motion.
  - The time shown equals the storm end in the account zone (23:48 in `Etc/GMT-11`).
- **Fix:** anchor it under the header, or shorten it on short viewports.

## Earlier FE P0/P1 findings (and relevant P2s), re-verified

| ID                                       | Old severity | Status now                      | Evidence                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FE-001 no error boundary                 | P1           | **Closed**                      | `main.tsx:205` root boundary; `components/lazy.tsx` contained, resettable chunks. With a 404 on the ShoreScene chunk the nav stayed and "The shore scene could not be loaded… Reload / Try again" appeared (`a1/shots/chunk-404-shore-390.png`).                                                 |
| FE-002 revoked session is a dead shell   | P1           | **Closed**                      | Token revoked by API → next request → sign-in with "You were signed out because this session ended…"; token removed; focus in Username (`a1/shots/session-ended-390.png`).                                                                                                                       |
| FE-003 offline start signs out           | P2           | Closed                          | `/api/*` aborted → "Cannot reach the SeaYou server right now. Still signed in; trying again…"; token kept; recovered after reconnect.                                                                                                                                                            |
| FE-004 landscape controls covered        | P2           | Closed                          | Zoom, list, Private/Public, write, inbox and avatar all `ok` at 667, 740 and 844 (`a1/s3-shell.mjs`). The new side effect is FE-R-013.                                                                                                                                                           |
| FE-005 account sheet unscrollable        | P2           | Closed                          | Delete account is hit-testable at all 5 viewports; Tab ×16 stays inside; Escape returns focus to the avatar.                                                                                                                                                                                     |
| FE-006 no-WebGL                          | P2           | Closed                          | Per-screen fallback text; bottles listed. Residuals in FE-R-014.                                                                                                                                                                                                                                 |
| FE-007 failure shown as empty            | P2           | **Partly closed**               | Letters, Ocean and My Shore are fixed; Blocked users and the admin queue are not (FE-R-007).                                                                                                                                                                                                     |
| FE-008 Storms · None                     | P2           | Closed                          | `LettersScreen.tsx:318` uses `stormsWeathered`.                                                                                                                                                                                                                                                  |
| FE-009 admin consequence / reason        | P2           | Closed                          | "carl has no violation in force, so this one is a warning…". Confirm disabled until a reason is given; critical also requires the acknowledgment box.                                                                                                                                            |
| FE-010 zone not cleared                  | P2           | Closed                          | After sign-out and after deletion, `localStorage` is `{}`.                                                                                                                                                                                                                                       |
| FE-011 Received copy                     | P2           | Closed                          | Copy states a found letter is read once.                                                                                                                                                                                                                                                         |
| FE-012 sheets survive account switch     | P2           | **Regressed for `blockedOpen`** | FE-R-010.                                                                                                                                                                                                                                                                                        |
| FE-014 polling while hidden              | P2           | Mostly closed                   | FE-R-016 remainder.                                                                                                                                                                                                                                                                              |
| FE-015 Back exits app                    | P3           | Closed                          | Letters → Friends → Back → Back gave "Letters", then "Ocean", staying in the app.                                                                                                                                                                                                                |
| A11Y-001/002/003/004/005/007/008/011/012 | P2/P3        | Closed as claimed               | Letter and document regions scroll with PageDown once focused; contrast re-measured (above); the account sheet is modal; the decision notice has `aria-describedby`; Escape works with focus on body; the admin menu closes on Escape with focus back on Admin; the release sequence is a modal. |
| A11Y-006 tabs                            | P3           | **Partly**                      | Roving tabindex exists, but arrow keys drop focus in Letters and the admin sections (FE-R-006).                                                                                                                                                                                                  |
| A11Y-009 shore picker                    | P3           | **Partly**                      | FE-R-012.                                                                                                                                                                                                                                                                                        |

## Checked and found fine (not findings)

- **Layout and axe:**
  - No horizontal overflow on any screen, dialog or state at 390, 667, 740, 844 or 1280.
  - axe shows 0 violations on sign-in, register (with errors), forgot, the policy dialog, all five tabs, compose, preview, the reader, inbox, standing, the restricted shell, the admin queue, the case and dialogs, the passport, policy re-acceptance and the Ocean without WebGL. The one exception is FE-R-012.
  - Every public `/legal/*` and `/support` page is 200 with `lang`, a title, one `h1` and 0 axe violations; an unknown slug returns an HTML 404.
- **Dev controls and roles:**
  - member: no dev strip or shield; dev and admin APIs 403.
  - admin: shield only; `/admin` 200 and `/dev` 403.
  - developer: dev strip only; `/admin` 403.
  - anonymous: `/dev/*` 401.
  - Production mode: `/api/dev/*` returns 404 even for a developer, no dev strip is rendered, and the dev-mail notice is absent from the production bundle. The unused dev API client paths remain in the bundle; this is harmless.
- **Storm and map clock with a correct device clock:**
  - Day map: no storm. Calm night: night palette, no storm. Storm night: exactly one overlay at every viewport.
  - Journey card: "In a storm / Water: Rough". My Shore: "storm · high water" and the scenery advisory.
  - Foreground zone change: the phone flips to day at once, the server cancels the pre-midpoint storm, and a second device follows within one poll.
- **Moderation:**
  - The warning, suspension (with countdown, `role="timer"`) and critical-ban notices cannot be dismissed by Escape or backdrop; focus stays trapped.
  - The waiver needs a second confirmation, with focus on "Go back".
  - Appeals submit; the restricted shell offers Help & Support, Delete account and Sign out, with no nav.
  - Admin dialogs scroll in landscape (wheel reaches Ban permanently at 740×360).
- **Write and release:**
  - Validation reasons for empty, too long (counter 1005/1000) and direction controls, in a live region with `aria-describedby`.
  - A friend without a shore is disabled with a reason.
  - A failed release rewinds to preview with the draft byte-identical and the acknowledgment kept.
  - The keyboard-only release works end to end (apart from the focus loss in FE-R-006).
  - Under reduced motion the release sequence finishes quickly.
- **Finder, block and unblock:**
  - The reading survives a reload.
  - Block-the-writer during the reading shows the entry named by the bottle in Settings → Blocked users.
  - Unblock asks first (alertdialog; Escape steps back to the list).
  - Account deletion clears storage and returns to sign-in with no misleading notice.

## Limitations

- No real assistive technology was used: live-region and announcement behaviour were inferred from the DOM and focus.
- No physical device: safe-area insets and touch gestures were not exercised, and phone landscape was emulated at CSS-pixel sizes.
- The dev-server bundle was used for most flows. The production bundle was checked for role and dev gating, recovery and axe.
- Dev-clock artefacts, such as release dates later than decision dates and "0m at sea" for bottles lost at once with `/dev/lose`, were not treated as defects.
- Blocking a sender while their bottles sit delivered and unread on the blocker's shore was observed to leave them delivered. The spec (§8.2) lists this as still requiring a decision, so it is not raised.
