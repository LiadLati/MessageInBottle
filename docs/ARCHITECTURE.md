# Architecture notes — stage 3 foundation

This document records the decisions taken to start implementation from an empty repository. The
product specification (`docs/SeaYou_Product_Specification.md`) remains the source of truth; where the specification leaves a decision
open (D01–D13) the code uses a clearly labelled, configurable placeholder and does not pretend the
decision has been made.

## Decisions

| Area                | Choice                                                | Why                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository          | pnpm workspace monorepo, TypeScript everywhere        | One typed contract (`@mib/shared`) consumed by both API and client; identical letter validation on both sides.                                                                 |
| Client              | Vite + React 19, mobile-first, no UI framework yet    | D12 (web/PWA vs native) is open. A responsive web client is the cheapest way to validate flows and is PWA-ready; visual design is a placeholder until the Claude Design phase.  |
| API                 | Hono on Node (`@hono/node-server`)                    | Small, typed, standards-based `fetch` handlers that are trivially testable in-process (`app.request`) and portable to other runtimes if hosting changes.                          |
| Validation          | zod v4 schemas in `@mib/shared`                       | Shared DTOs, request validation at the HTTP boundary, and runtime parsing of stored JSON (aging profile).                                                                        |
| Database            | SQLite via `better-sqlite3` + Drizzle ORM             | Zero-service local persistence with real transactions and migrations. Synchronous transactions make the release/arrival/open commits naturally serial. Drizzle keeps a move to PostgreSQL a driver + migration change. |
| Time                | Server `Clock` abstraction (`SystemClock` / `DevClock`) | Spec §11 invariant 7: only server time drives travel. Dev mode persists a forward-only offset so journeys can be advanced deterministically and survive restarts.               |
| Worker              | In-process interval calling `runJourneyTick`          | Arrival is a pure function of persisted plan + server time, so a missed or repeated tick is harmless. Can be moved to a separate process without code changes.                   |
| Auth                | Username + password (+ e-mail for recovery) accounts in the `users` table (salted scrypt hash), opaque hashed session tokens, single-use hashed reset tokens in `password_resets`, provider-neutral mail adapter | No identity provider or e-mail is required for the product; scrypt is in Node's standard library (no dependency), the hash string is self-describing so parameters can be raised later. Sessions are bearer tokens hashed at rest with a TTL; sign-out revokes one token. Sign-in and registration are rate limited in-process. Seed accounts exist only in dev mode. |
| Geography           | Global shore catalogue (`apps/api/src/db/geo/shores.ts`, ~390 real harbours keyed to Natural Earth geometries) plus the six original fictional shores; versioned sea-route graph, version 2 generated offline (`apps/api/src/tools/geo/build-world.ts`) | Spec §6 (amended 2026-09-14). The graph is a 1° water grid checked against a 0.05° land mask, authored straits/canals and per-shore connectors; lengths are great-circle km (50 km per chart unit ≈ v1 pace). Graphs are immutable and cached per version in memory; route plans record their graph version, so version 1 rows and every released bottle's snapshot stay untouched. Shores carry the dataset's country attribution server-side only (validation, coverage, routing) and expose their sea to clients; country names never reach the UI. Users are never located. |
| World map           | MapLibre GL JS with day and night land + borders styles; bundled Natural Earth 50m land polygons and admin-0 boundary lines (via `world-atlas` 2.0.2, ISC; data public domain) | Open source, no credentials, offline. The style has a sea background, land fill, coastline and thin border lines only; `assertMapStylePolicy` rejects symbol/label layers and any border drawn as more than a line. Routes are unwrapped across the antimeridian client-side. Day↔night and calm↔storm are per-layer `setPaintProperty` tweens on the live map — never `setStyle`, which would reload sources, drop the markers and blink the camera. The only weather element on the map is the per-bottle marker glyph; there are no storm regions, fog patches, map-wide rain, or any circle drawn around a bottle marker (selection reads as a size change, and the only ring is the keyboard focus one). A licensed vector source can be supplied via `VITE_MIB_MAP_*`. |
| Time of day & weather | Deterministic, versioned schedule in `packages/shared/src/weather.ts`; presentation in `apps/web/src/state/weather.tsx`, `lib/oceanWeather.ts`, `lib/shoreWeather.ts`; the sea viewer in `components/SeaViewer.tsx` over `ShoreScene` `mode="sea"` | **Cosmetic only** (spec §9.1): never touches a route, duration, arrival or risk. Day/night comes from the local hour in the browser's IANA zone (07:00–19:00, configurable, midnight-wrapping supported). Ocean weather belongs to **each bottle** (night-only, at-sea only): two bottles on one route may differ, the marker carries a small storm glyph, the card says `In a storm`, and `View at sea` opens a lazy-loaded three.js view of that bottle as a modal over the still-mounted, paused map — so Back to map restores camera, zoom and selection by construction. My Shore runs an independent schedule keyed on the user. No storage and no migration: the same bottle/user id, schedule version and time window always reproduce the same weather, so a refresh, a re-selection or a server restart cannot reroll it. The module is shaped so it can move behind an API endpoint unchanged. |
| Clocks              | `ctx.clock` (journey; the dev clock in development) and `ctx.realClock` (always `SystemClock`) | Sessions, session expiry and password-reset tokens use `realClock`, so advancing the development clock lands bottles and moves weather but can never expire a session. Rate limiting was already on real time. |
| 3D shore & release  | three.js scene ported from the design handoff's `shore3d.js`, driven from React | Real geometry, refractive glass bottle, displaced water, textured sand/foam/clouds from the handoff. The parent owns the nine-beat release timeline (`seek(t)`), so UI beats and the request lifecycle stay in sync. |

## Design integration (cinematic direction, handoff 2026-09-07)

Every screen is built from three layers that never mix: a **world layer** (MapLibre map or
three.js scene, `position: absolute; inset: 0`), a **scrim** (non-interactive gradients that
guarantee contrast) and a **UI layer** (plain DOM glass panels, buttons and nav — never inside the
GL context, so text scaling, RTL and screen readers work). Tokens from `DESIGN_TOKENS.json` live
in `apps/web/src/design/tokens.css`; icons and markers from the handoff are in
`apps/web/src/design/icons.generated.ts` and `apps/web/public/markers`; the sky, sand, foam and
cloud textures feed the 3D scene from `apps/web/public/textures`.

Rules the integration keeps: the map shows land geometry only; the bottle marker is a DOM element
with a 44px hit area; the release request and the release animation are independent (the map only
appears on server commit, a failure rewinds to the sealed letter with the draft intact); parchment
appears only on letter surfaces; Readable Print changes typeface only; every sequence is skippable
and has a reduced-motion equivalent; the map SDK and the 3D engine are lazy chunks that never load
with sign-in.

## Layering

```
apps/web  (UI)            screens/, components/   → talks only to api/client.ts
  design/                 tokens.css, Icon + generated icon paths from the handoff
  components/OceanMap     MapLibre world map (routes, trail, anchors, DOM bottle marker)
  components/ShoreScene   three.js coast / throw scene (ported from handoff shore3d.js)
  components/ReleaseSequence  nine-beat release timeline over the throw scene
  lib/mapGeometry         style policy guard + client-side route interpolation (unit-tested)
@mib/shared (contracts)   DTO schemas, BottleState + transitions, letter + font rules
apps/api
  http/                   Hono routes: auth, validation, DTO shaping. No business rules.
  services/               Journey logic: eligibility, release, worker, opening, visibility.
  domain/                 Pure functions: route planning, position interpolation, aging.
  db/                     Drizzle schema, migrations, seed chart/users.
  lib/                    Clock, ids/hashing, error types.
```

Rules live in `services/` and are tested directly against an in-memory database
(`src/test/harness.ts`); HTTP tests cover authorization and wire-level behaviour.

## Data model (stage 3 tables, designed for stage 4/5)

- `users`, `sessions`, `friendships` (canonical pair, `pending|accepted`), `blocks` (directional).
- `shores` (neutral name, chart position, capacity), `route_graph_versions`, `route_nodes`
  (`shore|waypoint|island`), `route_edges` — a versioned connected water graph. Islands are stranding
  targets and are never used as through-passages by the planner.
- `letters` — immutable text, character count, original font, disclosure version.
- `bottles` — sender/recipient/letter refs, **snapshots** of names and shores taken at release,
  `state` (`at_sea`, `delivered`, `opened`, `lost`, `cancelled`), optimistic `version`, `moderation_status`, timestamps, `loss_reason`,
  frozen `aging_profile`, and the persisted outcome (`outcome_at`, `outcome_progress`, chart/geo
  position) once the sea ends a journey.
- `bottle_outcome_views` — per (user, bottle): when a terminal marker was first seen inside the
  sender's viewport and when the sender left the map after seeing it.
- `public_openings` — one row per bottle found adrift and opened (`bottle_id` primary key, the
  finder and the moment). Its primary key is what makes the opening race-free.
- `route_plans` — one active plan per bottle with `plan_version`, `graph_version`, node list,
  `starts_at`, `start_progress` (rescue continuity) and `planned_duration_ms`. Prior plans are kept.
- `journey_events` — append-only `(bottle_id, seq)` history.
- `capacity_reservations` — exactly one per bottle, `held|released`; released once at opening or a
  terminal outcome via a guarded update.
- `idempotency_keys` — `(user, scope, key)` with request fingerprint and stored response.
- `notifications` — with a unique `dedupe_key` so replays never duplicate, and a `kind`
  (`received_arrived`, `sent_arrived`, `sent_adrift`, `sent_sunk`, `sent_found`,
  `sent_cancelled`) for the inbox icon; rows written before `kind` existed are classified from
  their dedupe key when listed. Migration `0007_notification_kinds` is additive.
- `password_resets` — hashed single-use reset tokens with expiry/used/invalidated timestamps.
- `dev_clock` — persisted dev offset (dev mode only).

Ready-to-add for stage 4 without schema churn: `public_listings` (island, published_at, expires_at,
winning action), `storms` (region, interval, version), `risk_resolutions` (per bottle/exposure so
retries cannot re-roll fate). States `stranded_public`, `public_expired`, `lost`, `discarded` and
event types for them are already declared in `@mib/shared`.

## Invariants implemented

1. **Release is atomic**: letter, bottle, route plan, capacity reservation, first event and
   idempotency record commit in one transaction; capacity is counted inside that transaction.
2. **Duplicate release protection**: same user + key ⇒ the original bottle is returned (HTTP 200
   instead of 201); same key with a different payload ⇒ 409.
3. **Optimistic transitions**: every state change is `UPDATE … WHERE id = ? AND state = ? AND
   version = ?` and checked against the shared transition table.
4. **Server time only**: position and elapsed time derive from `released_at`/`starts_at` and the
   server clock; polling frequency is irrelevant; a long downtime is caught up in one tick.
5. **Recipient surprise**: `/shore` filters by `state IN (delivered, opened)` at the query; passport,
   open and read endpoints return 404 to anyone who is not the correct party in the correct state;
   the arrival notification is written in the same transaction as the arrival.
6. **Blocks**: checked at release (generic "recipient unavailable" — the block is not disclosed) and
   re-checked transactionally before arrival (`cancelled`, slot released once, generic notice).
7. **Immutability**: letter text and font are never updated; Readable Print is a client-side
   presentation switch over the same string. Aging parameters are derived once at arrival and stored.
8. **Capacity**: held through travel and while delivered-unopened; released exactly once.

## Journey outcomes: loss, sinking and the public ocean (stage 4, first slice)

Weather stays cosmetic (§9.1 above); this is the first *real* outcome path, kept deliberately
narrow.

- **Model.** `bottles.state = lost` with `loss_reason ∈ {adrift, sunk}` (`destroyed` is declared,
  never produced), plus the persisted outcome: `outcome_at`, `outcome_progress`, chart and geo
  position. `bottle_outcome_views (user_id, bottle_id, seen_at, acknowledged_at)` records the
  private-map visibility of a terminal marker per account. Migration `0005_bottle_outcomes` is
  additive only.
- **Commit.** `services/outcomes.ts → commitLoss(bottleId, reason, at)` runs in one transaction:
  the position is computed from the persisted plan at `at` and written to the row, the state
  moves through the optimistic `transitionBottle` (state + version), the destination slot is
  released once, a `lost` event is appended with reason/position/progress, and one sender
  notification is queued under a dedupe key. The route plan row is kept as the journey snapshot.
  A retry, a later read, a clock jump or the sea viewer can never move or reroll it.
- **Arrival vs loss.** Both are `at_sea → X` optimistic transitions inside SQLite's single writer,
  so exactly one commits. `commitLoss` also refuses (`arrival_due`) once the planned arrival has
  passed, and `commitArrivalIfDue` only acts on `at_sea`, so a lost journey never delivers and
  never produces an arrival notification. The recipient is never told anything.
- **Public ocean.** `GET /api/ocean/public` (signed-in users) returns the strict
  `PublicBottleSchema` — `id, reason, lostAt, position.geo, mine` — for adrift bottles only.
  Letter, sender, recipient, destination and route never leave the server through it; pairs with
  a block in either direction are hidden; `mine` is computed per caller. Sunk bottles are private.
- **Opening a bottle found adrift.** `POST /api/ocean/public/:id/open` is one transaction in
  `openPublicBottle`: insert into `public_openings` (the bottle id is the primary key, so the
  insert itself elects the single winner of a race), freeze the aging profile, append an
  `opened` event with `{scope:'public'}`, and notify the sender once — never naming the finder
  (spec D03). The bottle leaves the public list for everyone (`listPublicOcean` excludes any
  bottle with an opening) and the finder reads the letter in the ordinary reader. It is
  idempotent for the finder and a `409 already_opened` with no content for anyone else; the
  sender is refused (`400 own_bottle`), blocked pairs and non-adrift bottles get `404`.
  **The journey outcome is untouched**: the bottle stays `lost`, so the sender keeps letter,
  passport and Lost entry, and the intended recipient is never delivered to — no arrival path
  acts on a bottle that is not `at_sea`. Nothing else is granted: no rescue, re-release, further
  travel or transfer of ownership.
- **Reading afterwards.** The finder gets one reading session (see *Journey rules* below);
  nothing is archived for them and `GET /api/shore/received` lists shore deliveries only. The
  sender reads their own letter with `GET /api/bottles/sent/:id/letter`, a pure read they may
  repeat at will: it never claims the bottle, never removes it from the map and never touches
  the outcome or the listing deadline.
- **Private marker visibility.** `POST /api/bottles/sent/:id/seen` is called by the map the first
  time a sunk marker is actually inside the visible viewport while the page is visible and the
  map is not covered; `POST …/acknowledge` when the sender leaves the private map (another
  application screen, or the Public switch) and only if the marker was seen. Fetching, opening
  Ocean with the marker off screen, opening/closing a card, the sea viewer and a refresh never
  count. After acknowledgement the marker is gone from later private-map visits; the letter,
  passport and history are untouched (Letters → Lost).
- **What triggers a loss** is the versioned risk policy in the next section; the development
  control `POST /api/dev/lose` (owner only, dev mode only) goes through the same `commitLoss`.

## Journey rules: automatic storm outcomes, 72-hour listing, one-time reading, same harbour

Approved 2026-09-19 and shipped behind an explicit policy version. Migration `0008_journey_rules`
is additive: `bottles.risk_policy_version`, `bottles.public_deadline_at`,
`bottles.public_expired_at`, `public_openings.session_expires_at`, `public_openings.closed_at`
and the new `risk_decisions` table (one row per bottle per storm night, unique on both).

- **Policy v3** (`RISK_POLICY`, `RISK_POLICY_VERSION = 3` in `packages/shared/src/weather.ts`):
  each night (19:00→07:00, the existing day/night convention, in the sender's own time zone —
  see *One night rule* below) every at-sea bottle has, independently, a 25 % chance
  of a storm of 40–100 minutes; calm nights carry no risk. A storm night yields at most one
  **risk decision**, taken at the midpoint of the storm window (a stable moment after the storm
  has become visible). The decision is *eligible*
  only if the bottle is still at sea at that moment and its planned progress is below 80 %; only
  the first five eligible decisions of a journey carry risk (cap 1 − 0.99⁵ ≈ 4.9 %). An eligible
  decision loses the bottle with probability 1 %; conditional on loss it is adrift with 75 % and
  sunk with 25 %. The 80 % cutoff is internal protection and appears in no user-facing copy;
  storms may still be shown after the cap or the cutoff — they are cosmetic then. Same-harbour
  journeys never sail and have no exposure.
- **Determinism.** Every draw is `hashSeed(policyVersion, 'risk', bottleId, nightKey)` →
  `draw(seed, i)`; the storm window, decision time, loss and reason are functions of the bottle
  id, the night and the policy version alone. Retries, restarts, clock jumps, selection, the sea
  viewer and refreshes cannot reroll anything, and a new policy version reshuffles nothing for
  bottles stamped with an older one.
- **One night rule** (policy v3, 2026-09-19). A bottle's night is *its sender's night*: 19:00–
  07:00 in the account's persisted IANA zone (`users.time_zone`, migration
  `0009_account_time_zone`) — the phase the account's Ocean map is drawn in, whatever water the
  bottle is on. The zone is first learned from the device and re-sent on every app start and
  resume (`PUT /api/auth/time-zone`, a no-op when unchanged); `users.time_zone_since` records
  the journey-clock instant the current zone took effect, and nights are only ever walked from
  that instant on (`journeyNights` in `services/risk.ts`, the one place a night is chosen, for
  the worker and the map alike). So a zone change moves the nights ahead and never the ones
  behind: past `risk_decisions` rows stand, no decision is taken for a night that began under
  the old zone, and no loss can appear retroactively. Daylight saving is simply the zone's own:
  a 13-hour or 11-hour night on a clock-change date is the same night on the map and for the
  worker. An account no device has spoken for yet has **no nights** — no storms and no risk —
  until its first sync. Bottles share the account's phase but keep independent storms (the
  draws are per bottle id). Journey timing is untouched by any of this: duration and arrival
  are fixed by the route and elapsed server time, and public expiry stays 72 elapsed hours.
- **Visibility is the same rule.** `apps/web/src/lib/oceanWeather.ts` shows a storm iff the
  server's window covers the instant, and the map's palette, the Bottle at Sea lighting and My
  Shore's own cosmetic weather all read the phase from the same account zone
  (`state/weather.tsx`: the account's zone, the last known one while offline, the device's own
  before any account). Every window lies inside a night of that zone, so **a daytime map never
  holds a bottle in a risk-bearing storm**; no second clock gates the glyph.
- **Legacy journeys.** Two earlier rules shipped on this branch and are removed: v1 counted
  nights in a server-configured zone (`MIB_TIME_ZONE`, gone), v2 at the bottle's own meridian
  (mean solar time, gone). Journeys stamped 1 or 2 keep their stamp and every decision row they
  have (`risk_decisions.policy_version` records the version each decision was taken under);
  from activation on they walk the account nights like everyone else, from the sender's
  `time_zone_since`. Nothing is rerolled and nothing is hidden: until the sender's device has
  reported a zone they have no nights, and afterwards only nights that begin after that moment.
- **Worker.** `runJourneyTick` runs `processRiskDecisions → arrivals → expirePublicListings`.
  For each at-sea bottle with a non-null `risk_policy_version` it walks the account nights that
  began after release (and after the zone's start) up to now, skips storms whose decision is
  still in the future, and inserts one `risk_decisions` row per night inside a transaction (the unique key
  makes a concurrent tick a no-op); a losing decision calls `commitLoss(id, reason, decisionAt)`
  — the same transactional service as before, so arrival and loss still race on the optimistic
  `at_sea → X` transition, the reservation is released once and the sender is told once. Decisions
  that fell due while nothing was running are taken deterministically on the next tick, at their
  original decision time (progress and arrival are evaluated at that time, not at catch-up).
- **Activation.** `MIB_RISK_POLICY_VERSION` (default `3`) is stamped on each bottle at release;
  `0` stamps `null`. Bottles released before this migration have `risk_policy_version = NULL`
  and are never put at risk, however long they sail; nothing is backfilled, and no schedule that
  has already been given out is recomputed. The client no longer computes bottle storms:
  `SentBottleSummaryDto.storms` carries the server's windows for the nights around now.
- **72-hour public listing.** `commitLoss(…, 'adrift')` sets `public_deadline_at = outcome_at +
  72 h`. `listPublicOcean` and `openPublicBottle` enforce the deadline themselves (`>` now to
  list, `409 listing_expired` at or after it), so the rule holds even if no worker runs;
  `expirePublicListings` then records the fact once — `public_expired_at`, a `public_expired`
  event and one `sent_expired` notification (dedupe `public_expired:<id>`, clock icon): *72
  hours passed and the bottle you sent to [recipient] was not opened. It was removed from the
  public map.* The bottle stays `lost` with letter and passport in the sender's Lost, whose
  action reads *Removed from the public map after 72 hours* instead of *Show on public map*.
  Sender reads never move the deadline; an opening before the deadline is the winner and is
  atomic against expiry (both are `public_openings`/`bottles` writes in SQLite's single writer,
  and expiry refuses a bottle with an opening). Adrift bottles from before the migration have
  no deadline; `activatePublicListings` at API boot gives each of them 72 h from that moment
  (idempotent, journey clock), and logs how many it activated.
- **One-time reading.** The opening row gets `session_expires_at = now + 15 min`. While the
  session is open the finder can recover the same reading after a refresh or a dropped
  connection through `GET /api/ocean/reading` or by re-posting the open; `POST
  /api/ocean/public/:id/close` sets `closed_at` and ends access at once, and a stale session is
  refused the same way (`409 reading_closed`, no content). The finder is never given a shore or
  received entry, `GET /api/shore/received` is shore deliveries only and
  `GET /api/shore/bottles/:id/letter` is recipient-only. The one-time responses are
  `Cache-Control: no-store`; the client keeps the letter in React state only (no localStorage,
  sessionStorage or other durable storage). Openings recorded before this change keep their
  rows and events; with both session columns `NULL` they grant no further reads — the finder
  archive entries they used to produce simply disappear from the Received list. The sender's
  own reads stay unlimited.
- **Same harbour.** When origin and destination shore are the same, `releaseBottle` stamps
  `risk_policy_version = NULL`, plans the route snapshot with `plannedDurationMs = 0` and calls
  `commitArrival` inside the release transaction: the bottle is `delivered` at `releasedAt`, the
  shore bottle, badge, aging profile, `arrived` event and both ordinary notifications
  (`received_arrived`, `sent_arrived`) are produced exactly as for any arrival, and the
  idempotency key replays the same delivered bottle. No sea journey, storm risk, reminder or
  separate opening rule exists for it, and no notification about the recipient opening it.

## Notifications inbox and the My Shore badge

- **Events.** Four approved events, each one row per account per bottle under its own dedupe
  key: the recipient's *A new bottle has arrived at your shore* (`arrived:`), and the sender's
  *reached its destination* (`sent_arrived:`), *lost at sea and drifted into the public ocean*
  (`lost:` + reason adrift) and *sank at sea* (`lost:` + reason sunk). The two arrival events
  are written in the same transaction as the arrival, for two different accounts. Worker
  retries, repeated ticks and replayed requests insert nothing new. Older sender events
  (`cancelled:`, `public_opened:`) stay in history with their own icons.
- **Inbox.** The envelope beside the `+` control shows the unread count; opening it marks all of
  this account's notifications read (`POST /api/notifications/read-all`), which is persisted, so
  a reload or another session shows the same state. Rows are newest first, information only:
  no row opens a bottle, navigates, or touches a marker. Reading a sinking notice is not seeing
  the marker — `bottle_outcome_views` is written only by the map viewport, as before.
- **My Shore badge.** It was `unread.length` over *every* notification, so a sender's own lost,
  sunk or cancelled events lit My Shore with nothing to open there, and only a visit to the
  (possibly empty) shore cleared them. It is now the shore's own count of sealed bottles
  (`GET /api/shore`), refreshed on each visit: it lights only while a bottle is waiting to be
  opened, and clears when that bottle is opened — never by reading the inbox. The top strip
  remains an *arrival* banner and reacts to unread `received_arrived` events only.

## Legal documents, consent, and account deletion

- **One source.** `packages/shared/src/policies.ts` holds the Terms of Use, Community Rules,
  Privacy Policy and Child Safety Standards as structured blocks (headings, paragraphs, lists —
  never raw HTML), in English left-to-right, at `POLICY_VERSION`. The API validates acceptances
  against it, renders the public pages from it, and the web renders the in-app views from it.
  `validatePolicySet` rejects a document that is not released, is not English, lacks an
  effective statement, or contains unfinished text; it runs in the tests and at API boot.
- **Consent.** `RegisterRequestSchema.policies` requires three literal `true` flags
  (`acceptTerms`, `acceptGuidelines`, `acknowledgePrivacy`) and the versions the form showed.
  `recordAcceptances` writes one `policy_acceptances` row per document (version, action, source,
  real-clock time) inside the same transaction as the `users` row; `409 policy_version_stale`
  when the versions are not current. Existing accounts accept through `POST /api/policies/accept`
  with the same payload. Rows are append-only.
- **The upgrade gate.** `accountPolicies` derives, per document, the latest accepted version
  beside the current one; `required` is true when any differs, never-accepted included.
  `requirePolicies` follows `requireAuth` on chart, friends, bottles, shore, ocean and
  notifications and answers `403 policies_required`. Auth, `/api/policies/*`, `/api/account/*`
  and sign-out stay open, so a gated account can always read, accept, appeal or delete.
- **Public pages.** `http/legal-pages.ts` renders the documents to self-contained HTML with an
  inline stylesheet, and `http/routes/legal.ts` serves them under `/legal` — unauthenticated,
  JavaScript-free, responsive, indexable. `/legal/delete-account` is a form post: credentials
  plus a required confirmation, rate-limited per address, reusing `login` and the same deletion
  service as SeaYou.
- **Deletion.** `services/deletion.ts` is one transaction and is idempotent. It revokes sessions,
  clears identifiers, drops friendships, blocks, notifications and idempotency records, cancels
  in-flight letters (releasing the harbour reservation, recording a `cancelled` event and
  clearing the text), keeps delivered letters with their recipient under the name
  "Deleted account", and leaves moderation evidence to `services/retention.ts`. The `users` row
  survives anonymised with `deleted_at` set, because letters other people hold reference it.
  `login` and `resolveSession` already refuse a non-active account, so the status change alone
  ends access.
- **Support.** `packages/shared/src/support.ts` holds the identity, the five categories and
  their subjects, and `supportMailto` (percent-encoded subject). `http/legal-pages.ts` renders
  `/support` from it with the address from `config.supportEmail` (`MIB_SUPPORT_EMAIL`), so an
  override reaches every link on the page. It is a `mailto:` surface only: no form, no sender,
  no store, and no credential anywhere. `SupportLink` in the web app is an ordinary link out to
  the page, which is what keeps it reachable from the policy gate, a suspended account, the
  decision notice and the deletion dialog alike.
- **Roles.** `users.role` holds exactly one of `member`, `admin`, `developer`, read from the row
  on every request and never from anything a client sends. `requireAdmin` guards `/api/admin/*`;
  `requireDeveloper` guards every `/api/dev/*` route — the mail outbox included — and demands
  the role **and** `devMode`, so an anonymous caller gets 401, a member or an administrator 403,
  and in production the router is not mounted at all (404). `tools/grant-role.ts` (behind `admin:grant` and `developer:grant`) is the only grant
  surface: lookup, then `--confirm <stable id>`. Granting one role replaces the other, and no
  account is seeded with either.
- **The decision notice and the single appeal.** `violations.notice_presented_at` and
  `appeal_waived_at` carry the one appeal opportunity. `presentDecisionNotice` records that the
  notice reached the sender (idempotent; first value wins) — the server opens the appeal, the
  client never asserts it. `waiveAppeal` is the only thing besides appealing that closes the
  offer, is permanent and idempotent, and refuses once an appeal exists. Nothing about closing,
  reloading or timing resolves a notice: `accountStanding.pendingDecision` is derived from the
  rows, so an unanswered notice simply comes back. Every one of these writes a
  `moderation_audit` row in the same transaction.
- **Violations never expire.** `standingOf` counts violations with `revoked_at IS NULL` — an
  accepted appeal is the only thing that removes one. Serving a suspension changes the standing
  it produces, never the count. `severity = 'critical'` bans on its own: `decideCaseCritical`
  takes a required `AuthUser`, so the review worker (which passes `null`) has no path to it, and
  it records the administrator, the reason, the classification and the time.
- **Evidence retention.** `services/retention.ts` redacts a case's content evidence seven days
  after `finalityOf` says it is final — rejected, waived, or appeal decided — and is enabled by
  default. `planRetention` is a pure dry run; `applyRetention` re-checks every case inside the
  transaction, so an appeal or hold that arrived since the plan wins. A documented `legal` or
  `child_safety` hold outranks the timer and is the only way past it; releasing it returns the
  case to the ordinary calculation. Redaction clears the evidence copy and the reporters'
  explanations only: the decision, the violation and the audit trail outlive them, because an
  upheld violation does.
- **Audit.** `moderation_audit` is append-only and written inside the transaction of the action
  it describes, so there is no path that changes what a person may do without leaving a row —
  and the trail survives the evidence it describes being redacted.
- **No age data.** Nothing in the schema, the API or the interface collects or asserts an age;
  a test walks every production source file to keep it that way.

## Production artefact and fail-closed development mode

- **Artefact.** `apps/api/scripts/build.mjs` bundles each runtime entry (`server`, `migrate`,
  `grant-admin`, `grant-developer`, `retention`) with esbuild into `apps/api/dist/<entry>.js`:
  ESM, Node 22, `@mib/shared` bundled (it is TypeScript source), every npm dependency external,
  no source maps, no splitting. All entries sit one directory below the API root, exactly as
  `src/config.ts` does, so `API_ROOT`, the migrations folder (`apps/api/drizzle`) and the default
  `.env` resolve identically from source and from `dist`; `dist/data/sea-graph.v2.json` is copied
  beside them for `new URL('./data/…', import.meta.url)`. Nothing depends on the working
  directory. The build refuses to bundle any npm package by accident. `package.json` `files`
  limits `pnpm deploy --prod` to `dist`, the SQL migrations and the journal. `@mib/shared`, `tsx`
  and `esbuild` are devDependencies only.
- **Production by construction.** The build defines `__MIB_PRODUCTION_BUILD__`, so
  `PRODUCTION_BUILD` is true only in the compiled artefact. `isProductionRuntime` is that flag or
  `NODE_ENV=production`. `loadConfig(env)` validates everything before the server listens:
  booleans are exactly `true`/`false` (anything else is a `ConfigError`), `MIB_DEV_MODE`
  defaults to `false`, `MIB_DEV_MODE=true` is refused in production, production requires an
  absolute `MIB_DATABASE_PATH`, and the outbox mail provider is refused outside dev mode.
- **Seeding.** `prepareDatabase` (migrate, seed the chart, and seed development users only when
  `devMode`) is what the server runs on start; `seedUsers` additionally throws inside a
  production build. `db:seed` / `db:reset` are source-only tools (`seed-cli.ts`, `reset.ts`) and
  are not in the artefact; `db:reset` requires dev mode.
- **Web.** The DEV bar renders only in a Vite development build, only for the `developer` role,
  and only while `/api/dev/status` reports dev mode; the password-recovery screen never reads the
  outbox for a signed-out visitor. In a production bundle the panel is compiled out.
- **Shutdown.** `SIGTERM`/`SIGINT` close the HTTP server, stop the workers and close SQLite.
- **Proof.** `apps/api/src/config.test.ts` and `src/http/dev-mode.test.ts` pin the configuration
  and the route gates (including the audited reset-link takeover chain);
  `apps/api/scripts/smoke-artefact.mjs` starts `node dist/server.js` from a `pnpm deploy --prod`
  output on a temporary database; `.github/workflows/ci.yml` runs all of it on every pull request.

## Deliberately not implemented (per task scope)

AI writing/rewriting, random recipients, appended notes, chat, GPS-assisted shore suggestion,
island publication, rescue/discard, push notifications. Draft persistence is client-side (`sessionStorage`), as the
specification's Draft state has no live journey.
