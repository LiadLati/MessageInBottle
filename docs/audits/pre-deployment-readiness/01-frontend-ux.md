# Frontend, UX and accessibility

Audited commit `5ba32c2` (branch `audit/pre-deployment-readiness`, cut from `origin/main`).
Specialist: Agent 1. Lead review applied — see "Lead adjudication" at the end.

## Method

All of `apps/web/src` (~10.2k lines) read at code level: every screen, component and hook, the
design tokens and the full 2,727-line stylesheet, plus the API surfaces that decide what the UI
shows.

Browser work used Playwright/Chromium against a **temporary** database
(`MIB_DATABASE_PATH=/tmp/a1/audit.sqlite`), API on port 3011, web on 5181. Roles were granted on
that temporary database only. The development database was verified unchanged
(`687030b5…a047a49`) before and after.

Flows exercised in the browser: signed-out and sign-in; registration and policy consent; password
show/hide; the `?reset=` deep link; shore selection with and without WebGL; friends, requests and
blocking; compose, font listbox, draft persistence; preview and release, both normally and under
`prefers-reduced-motion`; release failure and rewind; Private and Public Ocean; marker selection
and camera recentre; the at-sea viewer; arrived bottle on My Shore; letter reader and Readable
Print; report sheet; Letters Sent/Received/Lost; Passport; the adrift finder flow including a
one-time reading surviving a reload; notifications; the full report → admin decision → decision
notice → appeal → waiver round trip; warned and suspended states; admin console; account sheet and
deletion; the public `/legal/*` and `/support` pages without authentication; offline, API-down,
HTTP 500 and lazy-chunk-404; refresh, direct URL, unknown routes and browser Back.

Viewports: 320×568, 360×800, 390×844, 1280×800, 1440×900, narrow landscape at 640×360, 667×375,
740×360, 800×420, 800×480, 844×390, 900×400, and 320×256 (≈400% zoom).

Contrast was measured from **rendered pixels** — each element screenshotted twice, once normally
and once with `color: transparent`, then the best solidly-covered text pixel compared against its
background pixel. That matters here because the text sits over gradients, scrims, a live map and a
3D scene, where CSS-only computation reports optimistic values.

**No P0 originated in the frontend.** Role gating is correct in both UI and API, no cross-account
data leakage was reproducible, and no data-loss path was found.

## Confirmed functional defects

### FE-001 — No React error boundary: a failed lazy chunk blanks the whole app

**P1 · confirmed · code defect (with deployment consequences) · small**

`grep -rn "componentDidCatch|ErrorBoundary|getDerivedStateFromError" apps/web/src` returns
**nothing** (independently re-verified by the lead). `apps/web/src/main.tsx:16-20` renders `<App/>`
with nothing above it; `apps/web/src/components/lazy.tsx:9-17` lazy-loads OceanMap, ShoreScene,
ReleaseSequence and SeaViewer behind `Suspense`, which handles _pending_ but never _rejected_.

Reproduction: sign in, fail the not-yet-loaded chunk
(`page.route(u => /ShoreScene/.test(u), r => r.fulfill({status:404}))`), click **My Shore**.
Observed `document.getElementById('root').innerHTML.length === 0`, nav count 0, empty
`document.body.innerText`, and a `pageerror` of `TypeError: Failed to fetch dynamically imported
module`. The same blank page appears offline when My Shore is opened for the first time.

Impact: every deploy that changes chunk hashes turns each already-open SPA into a white page the
moment the user opens My Shore, the Ocean, the release sequence or the sea viewer — no navigation,
no message, no recovery but a manual reload. The same applies to any uncaught render exception,
because React unmounts the root.

Why existing controls miss it: vitest covers pure modules only; typecheck and lint cannot see it.

Remediation direction: a root error boundary rendering a recoverable "something went wrong" state,
plus a chunk-load boundary around the lazy wrappers offering a reload.
Verification after fix: a test that rejects a lazy import and asserts the shell survives with a
recovery action, and one that throws from a screen component.

### FE-002 — A revoked or expired session leaves a dead shell reading "authentication required"

**P1 · confirmed · code defect · small**

`apps/web/src/api/client.ts:228-267` has no 401 handling — it throws an `ApiError` that screens
render verbatim. `apps/web/src/state/session.tsx:66-73` calls `refresh()` only on mount.
`useAsync` (`apps/web/src/lib/useAsync.ts:26-31`) records the error and keeps polling.

Reproduction: sign in, revoke that token from outside the browser (`POST /api/auth/logout` → 204),
click **Letters**. Observed body includes the raw string `authentication required` beside "Nothing
sent yet". After 22s all pollers had fired, 6 of 7 returned 401, and the shell was unchanged with a
stale nav badge.

Impact: the reset screen's own copy says "every signed-in device will need it", so after any
password reset every other open tab becomes a dead shell whose only feedback is an internal error
string. Same after deletion elsewhere, an admin revoke, or the 30-day TTL. The user is never
returned to sign-in.

Remediation direction: central handling in `request()` — on 401/`unauthorized`, clear the token and
drop to sign-in with an explanation.
Verification: a web test that revokes the session mid-poll and asserts the sign-in screen returns.

### FE-003 — A transient network failure at startup discards a valid 30-day session

**P2 · confirmed · code defect · small**

`apps/web/src/state/session.tsx:56-64` — `refresh()` catches **every** error including
`ApiError(0, 'unreachable')` and clears the stored token. It does not distinguish "the server
rejected this token" from "the server could not be reached".

Reproduction: sign in, block `/api/*`, reload → sign-in screen and
`sessionStorage.getItem('mib.session.token') === null`, though the token was never rejected.

Impact: flaky wifi, a captive portal, a server restart or a cold deploy on first load signs people
out permanently.
Remediation: only drop the token on an authentication failure; on `UNREACHABLE` keep it and retry.

### FE-004 — In landscape the sheet covers the map controls and the Private/Public switch

**P2 · confirmed · code defect · medium**

`apps/web/src/styles.css:1268` (`.mode-switch`) and `:1296` (`.zoom-cluster`) both pin
`top: calc(var(--header-pad-top) + 104px)`; `.sheet` (`:237`) is bottom-anchored with
`max-height: calc(100dvh - 200px - var(--nav-height))`. The two-pane escape only applies from
`@media (min-width: 900px)` (`:1666`).

Measured with `getBoundingClientRect` + `elementFromPoint`:

| viewport                             | zoom clickable | mode switch clickable |
| ------------------------------------ | -------------- | --------------------- |
| 667×375 (iPhone SE landscape)        | **no**         | **no**                |
| 740×360                              | **no**         | **no**                |
| 800×420                              | **no**         | **no**                |
| 844×390 (iPhone 13 landscape)        | **no**         | **no**                |
| 800×480                              | yes            | yes                   |
| 360×800, 390×844, 1280×800, 1440×900 | yes            | yes                   |

Impact: on any phone held in landscape, Zoom in/out/Recenter **and** the Private↔Public switch are
dead. Private↔Public is the only entry to the public ocean, so the entire adrift-bottle feature is
unreachable until the device is rotated. At 740×360 the sheet is also only 72px tall
(`scrollHeight 158 / clientHeight 70`).

Remediation: make the two-pane layout depend on available height as well as width, or move the
controls into the flow above the sheet on short viewports.

### FE-005 — The account sheet overflows short viewports and cannot be scrolled

**P2 · confirmed · code defect · small**

`apps/web/src/components/ProfileSheet.tsx:66-75` — inline `position:'absolute'`,
`top:'calc(var(--header-pad-top) + 60px)'`, `width:280`, with **no `max-height` and no `overflow`**.
The dialog is always `top 74, height 658 → bottom 732`, `dialogScrolls: false`.

| viewport                   | Sign out  | Delete account | Terms/Privacy links |
| -------------------------- | --------- | -------------- | ------------------- |
| 640×360, 740×360, 812×375  | reachable | **no**         | **no**              |
| 900×400                    | reachable | reachable      | **no**              |
| 360×800, 390×844, 1280×800 | reachable | reachable      | reachable           |

Impact: any phone in landscape or a short desktop window loses **Delete account** and all four
legal-document links from Settings, with nothing to scroll.
Remediation: `max-height: calc(100dvh - top - gutter); overflow: auto; overscroll-behavior: contain`.

### FE-006 — The no-WebGL fallback promises a list that does not exist, and is wrong on the shore picker

**P2 · confirmed · code defect · small/medium**

`apps/web/src/components/OceanMap.tsx:913-916` renders one hard-coded string for every screen that
mounts the map: _"The chart needs WebGL, which this browser cannot provide. Your bottles are listed
below."_ `apps/web/src/screens/OceanScreen.tsx:600-625` falls through to `null` when
`view.kind === 'clean'` with no load error.

(a) WebGL disabled, signed in with **2 bottles at sea**, Ocean tab: the fallback sentence renders,
`.sheet` count **0**, `.map-marker` count 0 — **no bottle is listed anywhere on the screen**.
(b) Same, signed in shoreless: the **shore-selection** screen shows the identical "Your bottles are
listed below" — wrong screen, wrong noun — and the only remaining control is the search field. The
flow is completable by typing a harbour name, but nothing tells the user that.

Remediation: render the bottle list in the sheet whenever the map cannot draw; make the fallback
message a prop so the shore picker says something true.

### FE-007 — Load failures are presented as "you have nothing"

**P2 · confirmed · code defect · small**

`apps/web/src/screens/LettersScreen.tsx:73-79` and `:219-228`, plus
`MyShoreScreen.tsx:120-129` and `OceanScreen.tsx:551-566`, test `list.length === 0` without first
testing `error`. Notably `LostHistory` (`:137`) and `NotificationsScreen.tsx:260` **do** guard
correctly, so the handling is inconsistent within the same files.

Reproduction: offline, open Letters → _"Nothing sent yet | Your sent bottles and their passports
will gather here. | Cannot reach the SeaYou server…"_ — an assertion about the user's data beside
the error proving it is unknown. Combined with FE-002, a person with an expired session is told
their entire history is empty.

Remediation: order the branches error → loading → empty consistently, and add a Retry affordance
(there is none anywhere; the Letters loaders do not poll, so the error state is permanent until the
user navigates away and back).

### FE-008 — The bottle passport always reports "Storms · None", contradicting its own copy

**P2 · confirmed · code defect (placeholder left in) · small**

`apps/web/src/screens/LettersScreen.tsx:311-312` — `<dt>Storms</dt><dd>None</dd>` is a literal,
never derived from `b.events` or `b.outcome`.

Observed on one screen for an adrift bottle: _"Passages | 16 | **Storms | None** | Adrift since … |
It was swept off course **in a storm** on the way to Cy … | Swept off course **in a storm** — adrift
in the public ocean"_. The passport is the sender's record of the journey and it states the opposite
of the event log directly above it.

### FE-009 — The admin decision dialog states a fixed, sometimes false sentence, and hides the consequence

**P2 · confirmed · code defect + product decision · medium**

`apps/web/src/screens/AdminScreen.tsx:314-316`:

```ts
function violationWord(_c: AdminCaseDetailDto): string {
  return 'a record you can check under Appeals';
}
```

The parameter is discarded (underscored so lint stays quiet), and `AdminCaseDetailSchema`
(`packages/shared/src/api.ts:546-596`) carries no prior-violation count, so the real number cannot
be computed client-side today.

Accepting a report against an account with **no** prior violations shows: _"…a violation recorded
against their account (**Ada currently has a record you can check under Appeals**)."_ The
administrator is not told whether accepting produces a warning, a seven-day suspension or a
**permanent ban** — the one fact that should govern the decision.

Related, same dialog: accept/reject of reports and appeals pass `reasonLabel` but **not**
`requireReason` (`AdminScreen.tsx:274`, `:602`), and the server schema allows it
(`packages/shared/src/api.ts:622-624`). Confirmed in the browser that the confirm button is enabled
with an empty reason, so a letter can be removed and a ban-track violation recorded with a blank
audit reason. `ConfirmDialog`'s own comment (`ConfirmDialog.tsx:11-13`) says the flag exists for
exactly this.

### FE-010 — The device time zone is never cleared on sign-out, contradicting the Privacy Policy

**P2 · confirmed · code defect + documentation mismatch · small**
_(Same defect as SEC-015 — found independently by two agents.)_

Published Privacy Policy, `packages/shared/src/policies.ts:491`: _"The time zone your device last
reported, in localStorage … **It is removed when you sign out.**"_

`apps/web/src/state/weather.tsx:63-70` defines `storeZone(zone)` whose
`else localStorage.removeItem(ZONE_KEY)` branch is reachable only with `null`, and the **only** call
site is `:91` — `if (accountZone) storeZone(accountZone)`. `logout()` (`state/session.tsx:93-110`)
clears only `sessionStorage`.

Reproduction: sign in → `localStorage {"mib.accountTimeZone":"UTC"}`. Sign out → `sessionStorage {}`
(token and draft correctly gone) but `localStorage` **still holds the zone**.

The test that supposedly guards this, `apps/web/src/storage.test.ts:92`, asserts
`expect(weather).toMatch(/localStorage\.removeItem\(ZONE_KEY\)/)` — a **source-text** match that
passes against the unreachable branch. See QA-008.

### FE-011 — Letters → Received promises to keep found-adrift letters; it does not

**P2 · confirmed · documentation mismatch / product decision · small**

`LettersScreen.tsx:211` subtitle _"Letters that reached you, and bottles you found adrift"_;
`:225-227` empty state _"Letters you pick up on your shore — **and bottles you open in the public
ocean** — are kept here."_

Reproduction: open an adrift bottle, read it, close it, then Letters → Received → **"Nothing opened
yet"**, and `GET /api/shore/received` returns `{"letters":[]}`.

Impact: the modal correctly warns it is a one-time reading, but two other places promise the
opposite. A finder may close the reader expecting to return; the loss is permanent.

### FE-012 — The account sheet survives sign-out and reopens over the next account

**P2 · confirmed · code defect · small**

`apps/web/src/App.tsx:93` — `profileOpen` is never reset when `user` becomes `null`.

Reproduction: sign in as A → avatar → Sign out → sign in as B in the same tab. At t+1.5s the shell
renders with the account sheet already open for **B**, and Playwright then failed for 30s on every
navigation click with `<div role="presentation">…</div> intercepts pointer events`.

Remediation: reset `profileOpen`, `admin`, `standingOpen`, `inboxOpen`, `deletingAccount`,
`choosingShore` and `passportId` when the session ends.

### FE-013 — Repeated and duplicate fetches of the same endpoint

**P3 · confirmed · tech debt · small**

Switching Letters folders Sent → Lost → Sent → Received issued `GET /api/bottles/sent` **six times
in ~7s**, because `SentHistory` (`LettersScreen.tsx:61`) and `LostHistory` (`:121`) each own an
independent `useAsync`. Separately `GET /api/shore` is fetched by the shell (`App.tsx:110-114`, 20s)
_and_ by `MyShoreScreen` (`:29`, 15s); `WriteScreen.tsx:69` re-fetches `/api/chart` the shell already
holds. The two `/shore` copies can briefly disagree, and the nav badge does not clear for up to 20s.

### FE-014 — 18 API requests per minute per open tab, with no visibility gating

**P2 · confirmed · operational weakness · small/medium**

60s idle on the Ocean tab, counted at the network layer: `bottles/sent ×4, notifications ×3,
shore ×3, friends ×3, moderation/standing ×3` = **18/min** ≈ 26,000 requests/day per idle tab, on an
app whose unit of change is hours. Five pollers: `App.tsx:100,110,119,128` (20s each) and
`OceanScreen.tsx:117` (15s). Nothing listens for `visibilitychange` to pause them — though the 1s
map ticker (`OceanMap.tsx:806`) does check `document.hidden`, so the pattern is known and simply not
applied to the pollers.

### FE-015 — Browser Back exits the app from any screen

**P3 · confirmed · UI backlog / product decision · medium**

There is no router; navigation is `useState` (`App.tsx:84`) and history is only touched via
`history.replaceState`. Sign in → Letters → Friends → Back lands on `about:blank`. On Android the
hardware Back button closes the app from any screen.

### FE-016 — Blocking uses native `confirm()`; there is no way to unblock

**P3 · confirmed · code defect + product decision · small / medium**
_(The unblock half is the same gap as ARCH-028.)_

`apps/web/src/screens/FriendsScreen.tsx:133-141` calls `confirm(...)` for a destructive action even
though `ConfirmDialog` is used for every admin decision. `apps/web/src/api/client.ts:302` exposes
`blockUser` with no counterpart, and there is no unblock anywhere in the API either.

### FE-017 — Doubled full stop in the release-failure message

**P3 · confirmed · small.** `WriteScreen.tsx:389-392` appends `.` to a message already ending in one.

### FE-018 — Unknown `/legal/*` slugs return raw JSON on the public legal namespace

**P3 · confirmed · code defect · small**

`GET /legal/nope` → `404 {"error":{"code":"not_found",…}}` as a bare `<pre>`, with no `lang`, title,
viewport meta or route back. These are the URLs app stores and regulators follow.

### FE-019 — The restricted-account screen omits Delete account and Support from its own copy

**P3 · confirmed · documentation mismatch · small**

Terms (`policies.ts:309`): _"While an account is suspended or banned it can still sign in to read the
decision, appeal it, **get support, delete the account** and sign out."_
`StandingScreen.tsx:68-72` prints: _"While {standing}, you can read this page, appeal, and sign out."_
A suspended account's visible controls are exactly `["Help & Support","Sign out"]`.

Mitigation, and why this is P3: `SupportLink` opens `/support`, which links to
`/legal/delete-account`, and that page is public and functional for a suspended account
(`POST /api/account/delete` returns `401 invalid_password` for a wrong password, not `403`). The
promise **is** met, in two clicks and a new tab — but the screen's own sentence says otherwise.

### FE-020 — Stale branding shipped as a public asset

**P3 · confirmed · deployment hygiene · small**

`apps/web/public/brand/wordmark.svg` (and its copy in `apps/web/dist/`) contains the literal text
**"Message in a Bottle"** — which `packages/shared/src/brand.ts:12-17` lists as a retired phrase that
"must never reach a rendered page again". Nothing in `apps/web/src` references the file, so it is
dead code — but `public/` is copied verbatim into the build and it is fetchable at
`https://<host>/brand/wordmark.svg`. `RETIRED_PRODUCT_PHRASES` is only enforced over the policy
documents (`policies.test.ts:114-121`), never over static assets.
_(Lead independently verified both the file contents and that no source file references it.)_

### FE-021 — Dev-only: every signed-in non-developer polls `/api/dev/status` and logs a 403 twice a minute

**P3 · confirmed · small.** `state/weather.tsx:117-133` polls `api.devStatus()` for any signed-in user
in `import.meta.env.DEV` builds; `requireDeveloper` 403s and `.catch(() => {})` swallows it. Not
shipped to production, but it is permanent console noise that masks real errors in development.

### FE-022 — Suspension notification prints a raw UTC string

**P3 · confirmed · UI backlog · small.** `apps/api/src/services/moderation.ts:546` embeds
`toUTCString()` (e.g. _"until Mon, 29 Sep 2026 23:15:41 GMT"_) while every other timestamp is
localised through `lib/format.ts`.

### FE-023 — "Before you continue" printed twice on the policy-update screen

**P3 · confirmed · small.** `PolicyUpdateScreen.tsx:174-177` — the eyebrow and, for a first-time
account, the `<h1>` are the same string.

## Accessibility failures

### A11Y-001 — Scrollable content regions are not keyboard-operable (WCAG 2.1.1)

**P2 · confirmed · accessibility failure · small**

Three scroll containers carry `overflow:auto` but no `tabindex`, and nothing focusable is inside:

| region                             | file                                                | measured                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| legal documents in the app dialog  | `components/PolicyDialog.tsx:88` (`.policy-scroll`) | `scrollHeight 5649 / clientHeight 713`; PageDown ×2, ArrowDown, End all leave `scrollTop 0`; **Space activates the focused Close button and closes the dialog** |
| a received letter                  | `components/LetterModal.tsx:159`                    | 1,000-char letter: `scrollHeight 1575 / clientHeight 603`; PageDown/ArrowDown/End/Tab+PageDown → `scrollTop 0`; wheel → 900                                     |
| the Ocean sheet on short viewports | `.sheet`, `styles.css:237`                          | at 740×360: `scrollHeight 158 / clientHeight 70`                                                                                                                |

Impact: a keyboard-only user without a pointer cannot read past the first screenful of the Terms,
Community Rules, Privacy Policy or Child Safety Standards **inside the app** — the documents
registration requires them to accept — nor past ~40% of a letter they received, which is the
product. Screen-reader users are less affected (a virtual cursor auto-scrolls); sighted
keyboard/switch users are fully blocked. Partial mitigation: the same documents are at `/legal/*` as
ordinary pages, but the dialog offers no link to them.

Remediation: `tabindex="0"` plus an accessible name and `role="group"`/`region` on each container.

### A11Y-002 — Colour contrast below 4.5:1 on live interactive text (WCAG 1.4.3)

**P2 · confirmed · accessibility failure · small**

Measured from rendered pixels:

| element                                                                  | file                                                                         | measured                                                          | required                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------- |
| inactive folder tabs (Letters Sent/Received/Lost, Admin Reports/Appeals) | `styles.css:1800-1806`, `--text-faint` = `rgba(215,231,228,.38)`, 13.5px/600 | **3.03:1**                                                        | 4.5:1                     |
| map subline in day mode ("Synced … · tap a bottle or route")             | `.world-header .t-meta`, `styles.css:90-95`+`:207`, 11.5px                   | **2.91:1**                                                        | 4.5:1                     |
| inactive bottom-nav labels                                               | `styles.css:917-929`, `rgba(222,234,233,.5)`, **9.5px**                      | night map 4.50; Letters deck 4.34; My Shore 3D 4.22; day map 4.18 | **fails 3 of 4 contexts** |
| inactive map-mode option (day)                                           | `styles.css:1279-1287`                                                       | 4.52:1                                                            | borderline pass           |

The tabs and nav labels are the app's primary navigation, and the map subline is the only
instruction saying the map is tappable. 9.5px is also below any reasonable minimum for UI text;
`--min-touch: 44px` exists as a token but there is no minimum-type-size token.

Explicitly **not** a defect: `--text-faint` on `:disabled` buttons is exempt under SC 1.4.3's
inactive-component exception, and it is used correctly there.

### A11Y-003 — The account sheet is a non-modal dialog; keyboard focus escapes behind its scrim

**P2 · confirmed · accessibility failure · small**

`components/ProfileSheet.tsx:66-67` uses `role="dialog"` with `aria-label` but **no `aria-modal`**,
no `inert` on the background and no Tab containment — unlike `ConfirmDialog`, `LetterModal`,
`SeaViewer`, `DeleteAccountDialog` and `PolicyDialog`, which all do it properly. Tabbing 14 times
from the open sheet lands on the five nav items behind the scrim: visually dimmed and
pointer-blocked, but keyboard-operable.

### A11Y-004 — The decision notice never announces its body

**P2 · confirmed · accessibility failure · small**

`components/DecisionNotice.tsx:86-91` sets `role="alertdialog"`, `aria-modal` and `aria-labelledby`
but **no `aria-describedby`** (`ConfirmDialog.tsx:87` has one). Focus moves to the first focusable
element, which is the **Help & Support** link, so a screen-reader user hears the title and that link
and **nothing** of the three paragraphs stating the violation, the enforcement ladder and the
one-appeal rule. This is the most consequential dialog in the product and the only one whose content
is legally significant.

### A11Y-005 — Escape and the Tab trap stop working when focus falls to `<body>`

**P2 · confirmed · accessibility failure · small**

Every dialog binds Escape and Tab as a React `onKeyDown` **on the dialog element**
(`LetterModal.tsx:85,104`; `ConfirmDialog.tsx:60,79`; `DeleteAccountDialog.tsx:182`;
`SeaViewer.tsx:62`; `PolicyDialog.tsx:136`). When the focused control unmounts the browser moves
focus to `document.body`, outside that element, and the handlers stop firing.

Reproduction: open a letter → **Report** → **Cancel** (Cancel unmounts) → focus is `BODY` → Escape
does nothing, modal still open. One Tab re-enters the dialog and Escape then works.
Remediation: bind to `document` while mounted, as `ProfileSheet.tsx:342` already does.

### A11Y-006 — Tab patterns are declared but not implemented

**P3 · confirmed · small.** `PolicyDialog.tsx:74-89` uses `role="tablist"`/`role="tab"` with **no
`aria-controls`**, and its `role="tabpanel"` has no accessible name and no `tabindex`.
`LettersScreen.tsx:34-49` sets `aria-controls="letters-panel-{sent|received|lost}"` but only the
active folder renders its panel, so two of three are **dangling references at all times**. Neither
tablist (nor the two in `AdminScreen.tsx:36-68`) implements arrow-key navigation or roving
`tabindex`.

### A11Y-007 — The admin menu cannot be dismissed

**P3 · confirmed · small.** `OceanScreen.tsx:907-955` declares `aria-haspopup="menu"`, `role="menu"`
and `role="menuitem"` but has no outside-click handler, no Escape, no arrow keys and no focus
management. Clicking the page centre and pressing Escape both leave it open; it closes only by
choosing an item or re-clicking the shield.

### A11Y-008 — The 3D scene's WebGL fallback message is inside `aria-hidden`

**P3 · confirmed · small.** `ShoreScene.tsx:1040` puts `aria-hidden` on the scene host and
`:1045-1050` renders the fallback inside it, so screen-reader users on My Shore, the release
sequence and the sea viewer are never told why the scene is missing.

### A11Y-009 — Shore selection: an unmanaged radiogroup, and ~96 map markers ahead of everything else

**P3 · confirmed · medium.** `ShoreSetupScreen.tsx:278-284` renders `role="radio"` buttons inside
`role="radiogroup"` with no roving `tabindex` and no arrow keys — up to **392** tab stops on desktop.
On a phone with WebGL, **35 shore pins + 61 clusters = 96 focusable map buttons** precede the search
field, and the screen reads as a wall of cluster counts.

### A11Y-010 — Status messages and one ARIA misuse

**P3 · confirmed · small.** `FriendsScreen.tsx:57` renders success notices as a bare `<p>` with no
`role="status"` (the adjacent `ErrorNote` does have `role="alert"`). `WriteScreen.tsx:256-264` — the
length-validation note is not a live region and **Seal the letter** is simply disabled;
likewise **Seal and throw** (`:374-383`) with no stated reason. `Nav.tsx:47` puts `aria-label` on a
bare `<span>` (role `generic`), where ARIA prohibits it, so the informative label may be dropped in
favour of the visible "3"/"9+".

### A11Y-011 — `ReleaseSequence` declares `role="dialog"` with no dialog behaviour

**P3 · confirmed · small.** `ReleaseSequence.tsx:85` — `role="dialog"` with no `aria-modal`, no focus
move, no trap and no Escape; the whole surface is `onClick={skip}` on a non-interactive `div`, so
"skip by tapping" is pointer-only. A real skip button at `:124` is the saving grace.
`aria-live="polite"` on the beat title fires nine announcements.

### A11Y-012 — The Ocean screen offers no list alternative to the map

**P2 · confirmed, largely mitigated when WebGL works · small/medium**

With bottles at sea and nothing selected the sheet renders `null` (`OceanScreen.tsx:600-625`) and the
only instruction, the hint pill (`:513-517`), carries `aria-hidden`.

Mitigation verified: MapLibre markers are real `<button>` elements with good accessible names and are
fully keyboard-operable — observed tab order `CANVAS:Map → "Bottle to Cy, at sea" → "Bottle to Bo, at
sea" → Write a letter → …`, and Enter on a marker opens the journey card. So with WebGL this is
usable, if unconventional. **Without WebGL it is a hard failure** (FE-006). Map markers also precede
the header in tab order despite sitting visually behind it.

### A11Y-013 — Focus restoration lands on `<body>` when the trigger has gone

**P3 · confirmed · small.** `LetterModal.tsx:66` restores focus to the previously focused element, but
after picking up a bottle that element ("Pick it up") no longer exists — observed
`focus restored to: BODY`.

## Deployment blockers and configuration requirements from the frontend

1. **FE-001** is the one to hold a release for: it converts every routine deploy into a white-screen
   event for users with the app already open. Small fix, large blast radius.
2. **FE-002** should ship with it — it is guaranteed to fire after any password reset, which the
   product documents as signing out every device.
3. **Map attribution is never rendered.** `OceanMap.tsx:160` attaches
   `attribution: import.meta.env.VITE_MIB_MAP_ATTRIBUTION` to the source, but `:580` sets
   `attributionControl: false`, and no custom attribution UI exists anywhere. `README.md:121` claims
   the text is "shown per their terms" — it is not. Harmless today (bundled public-domain Natural
   Earth data), but **any deployment that sets `VITE_MIB_MAP_TILES_URL` would silently breach the
   provider's attribution requirement.** P2, deployment-configuration, small.
4. **SPA fallback routing must be configured at the host.** The API serves only `/api`, `/legal` and
   `/support`; the Vite dev server answers `/letters` with `index.html`, which production will not do
   by default. No client router exists, so only `/` is ever produced by the app — but a typed or
   stale deep link will 404 without a catch-all rewrite.
5. **Remove `apps/web/public/brand/wordmark.svg`** before release (FE-020).
6. **Bundle.** Lazy-loading is correctly configured and verified at runtime: `maplibre`
   (1,024kB/279kB gz) and `three` (545kB/136kB gz) are separate chunks reachable only from `OceanMap`
   (16.9kB) and `ShoreScene` (17.6kB), both behind `React.lazy`; MapLibre's CSS is imported inside the
   lazy chunk so it is off the critical path. Sign-in ships `index` 444kB/**132.5kB gz** + 56.8kB CSS +
   six eagerly imported font faces (`main.tsx:5-11`). Defensible but not small for a first paint on a
   phone; the eager 500/600 weights and the Garamond italic are the cheapest thing to trim.
   **No action required for release.**

## Deferred UI polish / future backlog

FE-013, FE-015, FE-016 (dialog half), FE-017, FE-022, FE-023; A11Y-006, A11Y-007, A11Y-009,
A11Y-010, A11Y-011, A11Y-013. Plus: `ProfileSheet.tsx:322` uses `toLocaleDateString()` where the rest
of the app uses `lib/format.ts`; `.letter-modal` is `z-index: 30` with a comment claiming it is
"below the dev strip" which is `z-index: 25` (comment wrong, dev-only); `--min-touch: 44px` is
honoured by `.nav-item` but `.glass-control` and `.btn-ghost` are 34px (all clear WCAG 2.5.8's 24px
minimum, so this is token consistency, not a failure); and the release sequence still takes ~10s
end-to-end under `prefers-reduced-motion` because of a 2,500ms arming timeout.

## Checked and found FINE

- **Role separation is correct in UI and API.** member: no dev strip, no admin shield. developer:
  dev strip, no shield, `/api/dev/status` 200, `/api/admin/reports` **403**. admin: shield, no dev
  strip, `/api/dev/status` **403**, `/api/admin/reports` 200. `DevPanel` is behind three gates
  (`import.meta.env.DEV`, `user.role === 'developer'`, server `devMode`).
- **Browser storage matches the Privacy Policy's closed statement**, except FE-010's lifecycle claim:
  `localStorage` = `{mib.accountTimeZone}` only; `sessionStorage` = `{mib.session.token, mib.draft}`
  only; `document.cookie` empty; `indexedDB.databases()` `[]`; `caches.keys()` `[]`. MapLibre adds
  nothing. Token and draft are both cleared on sign-out; the draft is cleared on send.
- **No horizontal overflow anywhere** at 320/360/390/640/667/740/800/812/844/900/1280/1440, signed out
  and on all five tabs, and at 320×256 (≈400% zoom) on every public page. The policy dialog survives
  320px + 200% root font.
- **No missing accessible names, no duplicate `id`s, no touch targets under 24px.**
- **One `<h1>` per screen**, sensible heading order, `role="region"`/`aria-label` on the map.
- **Focus management in the serious dialogs is genuinely good** — `ConfirmDialog`,
  `DeleteAccountDialog`, `LetterModal` and `SeaViewer` all set `aria-modal`, mark siblings `inert`,
  trap Tab, close on Escape, restore focus and lock `body` overflow; each verified by tabbing.
  `DecisionNotice` correctly refuses Escape and backdrop dismissal by design.
- **No cross-account data bleed on sign-out/sign-in** — loaders resolve to `null` when `user` becomes
  `null`, verified by sampling the Friends badge every 700ms across an account switch with
  `/api/friends` delayed 4s.
- **No sensitive content in notifications, public-map cards or error messages.** Arrival notices carry
  no sender; moderation notices name the recipient and category but never the letter; the public card
  for someone else's bottle shows only "A lost bottle".
- **The whole moderation round trip works** end to end, including the waiver being irreversible.
- **The adrift-finder flow is exactly as specified** — one-time reading, survives a reload, closing
  ends it, the bottle disappears for everyone, re-opening refused. Only the Received copy is wrong
  (FE-011).
- **Release flow**: recipient list gates on `hasShore`; the counter is numeric not colour-coded; the
  font dropdown is a correctly implemented listbox with arrow keys, Home/End, type-ahead and
  `aria-activedescendant`; **a failed release rewinds to the sealed letter with the draft
  byte-identical** and reuses the same idempotency key.
- **Reduced motion is respected** — three stills, zero-duration map easing, disabled marker
  animations, single-frame 3D.
- **Public pages pass without auth** with correct `lang`, title, viewport, one `<h1>`, landmarks, no
  overflow at 320px and **no contrast failures**.
- **Deep links** — `?reset=` opens the reset screen and strips the token immediately; `#privacy` works
  signed out and in; unknown hashes are ignored safely.
- **Sign-in and registration scroll correctly** at every viewport including 740×360; field errors sit
  in a reserved slot so validation causes no layout shift; errors are `role="alert"` with
  `aria-describedby`/`aria-invalid`; the password reveal is a proper `aria-pressed` toggle; 429 is
  explained in minutes.
- **Registration consent** is two unchecked, independent, non-optional checkboxes with inline links
  that do not toggle the box, and no marketing control.
- **The sunk-bottle visibility rule works** — seen only when actually in the viewport, acknowledged on
  leaving the private map, both server-persisted.
- **Status is never colour alone** — every chip pairs a glyph with a word.
- **`assertMapStylePolicy`** is enforced at map construction and rejects symbol layers, labelled
  source-layers and non-line border layers.
- **No React key warnings, no hydration errors, no uncaught exceptions** in any flow.

## Limitations

1. **No real assistive technology.** ARIA findings come from the accessibility tree, the DOM and
   keyboard behaviour, not from listening. A NVDA/JAWS/VoiceOver pass could find announcement problems
   invisible here, particularly around the `aria-live` regions and the nav badge.
2. **No real device.** `env(safe-area-inset-*)` is used throughout but Chromium reports 0, so
   notch/home-indicator behaviour on iOS is unverified. Landscape findings were reproduced at the
   equivalent CSS pixel sizes, not by rotating a physical phone.
3. **No touch gestures** — pinch-zoom, two-finger pan and `touchZoomRotate` were not exercised.
4. **Background-tab throttling was simulated** by overriding `document.hidden`, so FE-014's figure is
   the un-throttled upper bound.
5. **Dev-server, not production build.** FE-001 was reproduced against dev module URLs; the failure
   mode is identical in a production build and in fact more likely there.
6. **Dev-clock artefacts** in transcripts (moderation uses the real clock, journeys the dev clock)
   were not treated as defects.
7. Backend behaviour was observed only where it shapes the UI.

## Lead adjudication

- **FE-010 is the same defect as SEC-015** (security agent) and its test critique is the same class as
  **QA-008**. Kept once here, cross-referenced in the other reports; counted once in the totals.
- **FE-009's "no recusal" observation and FE-016's "no unblock"** were each found independently by
  another agent (SEC-010 and ARCH-028). The frontend halves are retained here as UI defects; the
  authorization and product halves are owned by reports 03 and 02 respectively.
- Agent 1's own severity assignments were accepted without change. The lead independently re-verified
  FE-001 (no error boundary anywhere in `apps/web/src`) and FE-020 (retired branding present in both
  `public/` and `dist/`, referenced by no source file).
- Agent 1 disclosed that it twice ran `pkill -f vite` early in its run, which may have stopped a
  sibling auditor's dev server. No repository or database state was affected; the other agents'
  findings were unaffected, as each re-established its own environment.
