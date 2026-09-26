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
| Time                | Server `Clock` abstraction (`SystemClock` / `DevClock`) | Spec §11 invariant 7: only server time drives travel. Dev mode persists one shared offset so journeys can be advanced deterministically and survive restarts. It moves forward, except that a developer can confirm "Return to real time" (`POST /api/dev/reset-clock`), which sets the offset to zero for every account and changes nothing else: settled arrivals, losses, notifications and storm rolls stay settled even when their timestamps are ahead of the clock, and a bottle released in the simulated future stays at sea until real time reaches it.               |
| Worker              | In-process interval calling `runJourneyTick`          | Arrival is a pure function of persisted plan + server time, so a missed or repeated tick is harmless. Can be moved to a separate process without code changes.                   |
| Auth                | Username + password (+ e-mail for recovery) accounts in the `users` table (salted scrypt hash), opaque hashed session tokens, single-use hashed reset tokens in `password_resets`, provider-neutral mail adapter | No identity provider or e-mail is required for the product; scrypt is in Node's standard library (no dependency), the hash string is self-describing so parameters can be raised later. Sessions are bearer tokens hashed at rest with a TTL; sign-out revokes one token. Sign-in and registration are rate limited in-process. Seed accounts exist only in dev mode. |
| Geography           | Global shore catalogue (`apps/api/src/db/geo/shores.ts`, ~390 real harbours keyed to Natural Earth geometries) plus the six original fictional shores; versioned sea-route graph, version 2 generated offline (`apps/api/src/tools/geo/build-world.ts`) | Spec §6 (amended 2026-09-14). The graph is a 1° water grid checked against a 0.05° land mask, authored straits/canals and per-shore connectors; lengths are great-circle km (50 km per chart unit ≈ v1 pace). Graphs are immutable and cached per version in memory; route plans record their graph version, so version 1 rows and every released bottle's snapshot stay untouched. Shores carry the dataset's country attribution server-side only (validation, coverage, routing) and expose their sea to clients; country names never reach the UI. Users are never located. |
| World map           | MapLibre GL JS with day and night land + borders styles; bundled Natural Earth 50m land polygons and admin-0 boundary lines (via `world-atlas` 2.0.2, ISC; data public domain) | Open source, no credentials, offline. The style has a sea background, land fill, coastline and thin border lines only; `assertMapStylePolicy` rejects symbol/label layers and any border drawn as more than a line. Routes are unwrapped across the antimeridian client-side and drawn with rounded corners (`smoothRoute` in `@mib/shared`, manual review round 1): each corner of the one-degree waypoint chain takes the largest curve whose every point keeps about 5 km from land in a 0.05° raster of the map's own land file, a smaller one otherwise, and none where no curve fits; harbour-approach corners get only a tiny blind-safe cut. It is rendering only — the marker rides the drawn line, while progress, route, duration, storms and risk stay the server's — and `db/geo/geo.test.ts` checks it across the shore catalogue against the independent build-time land mask. Private views label the origin ("From") and the destination ("To", a hollow ring) of the journey in focus; the public ocean names no harbour. Day↔night and calm↔storm are per-layer `setPaintProperty` tweens on the live map — never `setStyle`, which would reload sources, drop the markers and blink the camera. The only weather element on the map is the storm-cloud glyph above each bottle at sea while the account's storm lasts at night (restored in manual review round 1), with the storm stated in words; there is no map-wide rain or stripe overlay, no storm regions, no fog patches, and no circle drawn around a bottle marker (selection reads as a size change, and the only ring is the keyboard focus one). A licensed vector source can be supplied via `VITE_MIB_MAP_*`. |
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
  bottle with an opening) and the finder reads the letter in the ordinary reader. A second open
  is `409 reading_closed` for the finder and `409 already_opened` for anyone else, with no
  content either way; the
  sender is refused (`400 own_bottle`), blocked pairs and non-adrift bottles get `404`.
  **The journey outcome is untouched**: the bottle stays `lost`, so the sender keeps letter,
  passport and Lost entry, and the intended recipient is never delivered to — no arrival path
  acts on a bottle that is not `at_sea`. Nothing else is granted: no rescue, re-release, further
  travel or transfer of ownership.
- **Reading afterwards.** The finder gets one reading, once (see *Journey rules* below);
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

- **Risk policy v4: one map clock, account storms** (`RISK_POLICY_VERSION = 4`,
  `packages/shared/src/weather.ts`; server in `services/weather.ts` and `services/risk.ts`;
  migrations `0016_account_storms` and `0017_account_zone_backfill`).
  - *The map clock.* Each account has one authoritative IANA zone: the latest valid device zone
    the server accepted (`PUT /api/auth/time-zone`, validated before it spends the four-a-day
    change budget), before any the chosen harbour's nautical zone (`Etc/GMT±N` from its
    longitude), else UTC. Every accepted change is a row of `account_zone_changes` with the
    journey-clock instant it took effect (`users.time_zone`/`time_zone_since` mirror the latest
    device report). The zone in force at any past instant is therefore a recorded fact.
    `GET /api/ocean/weather` returns the zone, its source, the phase, tonight's visible storm and
    the last roll; every device of the account draws that answer (`state/weather.tsx`), so a
    phone and a desktop never disagree, and the reporting device redraws as soon as the server
    accepts its change.
  - *Rolls.* A roll happens only when the map *enters* a night: at 19:00 in the zone in force,
    when an accepted zone change turns a daytime map to night, or when the clock starts at night
    (v4's activation, recorded once in `risk_policy_activations`, or the account's first zone).
    An entry less than 24 hours after the previous roll gets no roll — so a zone change, a
    local date boundary, reopening SeaYou or restarting the worker can never add one — and
    neither does an entry with less than 100 minutes of night left. Each roll is
    `hashSeed(4, 'account-storm', userId, rolledAt)`: a 25 % storm, 40–100 minutes, placed wholly
    between the roll and the morning of that night, decision at its midpoint. Rolls are written to
    `weather_rolls` (unique on account and instant) the first time they are needed — by the
    worker for accounts with journeys at risk, by the weather endpoint, before a zone change —
    and only up to "now", from history already recorded, so computing them early, late or twice
    writes the same rows. One late entry (a clock that starts mid-night, an eastward zone change,
    a spring-forward night) costs at most that night: the next dusk ≥ 24 hours later rolls at
    19:00 again.
  - *Decisions.* At the midpoint (`decideDueStorms`, one transaction per storm) every at-sea,
    versioned bottle of the account that had set out by then and is not due ashore by then gets
    its own decision from `bottleRiskDraws(bottleId, rolledAt)`, under the unchanged rules:
    eligible only below 80 % progress, before arrival and within the first five eligible
    decisions of the journey (any policy's decisions count); 1 % loss, adrift 75 % / sunk 25 %,
    committed through `commitLossIn` so arrival and loss still race on the optimistic
    `at_sea → X` transition. The rows (`risk_decisions.night_key` = the roll id, unique per
    bottle) and `weather_rolls.decided_at` commit together; a retry, a restart or a second
    worker decides nothing twice, and a worker catching up after downtime writes the same rows
    as one that never stopped.
  - *Zone changes.* Before a change takes effect, storms whose midpoint has already passed on
    server time are decided under the clock they happened in. If the new zone turns the map to
    day while a storm's midpoint is still ahead, the roll is marked cancelled (`cancelled_at`,
    `cancel_reason = 'daytime'`): the storm disappears, no decision is taken and the roll stays
    consumed. A night-to-night change whose morning comes before the midpoint is cancelled the
    same way when the worker reaches the midpoint (`firstDaytime`). Nothing already decided is
    touched; release, route, duration, arrival, notifications, deadlines and rate limits never
    read the zone.
  - *Display.* One storm per account: the Ocean screen draws it once over the map
    (`.map-storm`), only while it lasts and only at night — judged on the server's clock: the
    web takes each answer's `serverTime` and advances it with `performance.now()`, so a wrong or
    changed device clock cannot move day, night or a storm (`apps/web/src/lib/serverClock.ts`,
    audit FE-R-003); bottles at sea show they are in it,
    and My Shore shows the same weather. `SentBottleDto.storms` carries the account storm's
    visible windows for a bottle at sea (clipped at the first daytime moment).
- **Earlier policies.** v1 counted nights in a server zone, v2 at the bottle's meridian, v3 gave
  every bottle its own 25 % storm on each of its sender's nights. Their `risk_decisions` rows,
  stamps and outcomes are kept exactly as recorded. From v4's activation, every journey still at
  sea with any non-null stamp is decided by its account's storms; its earlier eligible decisions
  count toward the five. v3 decisions not yet taken when v4 activated are never taken — that
  schedule no longer exists on any map, so no hidden decision can happen under a calm or
  daytime map. Bottles with a null stamp are never put at risk. No transition tool is needed:
  nothing is rewritten or backfilled except the device-zone history (0017, additive).
- **Worker.** `runJourneyTick` runs `processRiskDecisions → arrivals → expirePublicListings`.
  Risk first rolls every account that has a versioned journey at sea, then takes every due
  midpoint in order; a tick with nothing new costs a constant handful of statements per
  account.
- **Activation.** `MIB_RISK_POLICY_VERSION` (default `4`; `0` disables) is stamped on each bottle
  at release. Bottles released before automatic outcomes existed have `NULL` and never sail
  into risk.
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
- **One-time reading.** The letter is served once, in the `POST /api/ocean/public/:id/open`
  response, and never again: a second open is `409 reading_closed` with no content, and no
  endpoint returns it later (the 15-minute `GET /api/ocean/reading` recovery was removed on
  2026-09-26). `POST /api/ocean/public/:id/close` records the explicit, confirmed finish in
  `closed_at`, after which the finder can no longer block the writer from it; leaving the Ocean
  also finishes it, and the browser is asked to warn before a reload while it is open.
  `session_expires_at` is kept for older rows only and is always `NULL` now (no migration). The
  finder is never given a shore or received entry, `GET /api/shore/received` is shore
  deliveries only and `GET /api/shore/bottles/:id/letter` is recipient-only. The one-time
  response is `Cache-Control: no-store`; the client keeps the letter in React state only (no
  localStorage, sessionStorage or other durable storage). The sender's own reads stay unlimited.
- **Same harbour.** When origin and destination shore are the same, `releaseBottle` stamps
  `risk_policy_version = NULL`, plans the route snapshot with `plannedDurationMs = 0` and calls
  `commitArrival` inside the release transaction: the bottle is `delivered` at `releasedAt`, the
  shore bottle, badge, aging profile, `arrived` event and both ordinary notifications
  (`received_arrived`, `sent_arrived`) are produced exactly as for any arrival, and the
  idempotency key replays the same delivered bottle. No sea journey, storm risk, reminder or
  separate opening rule exists for it, and no notification about the recipient opening it.

## Product decisions: capacity, notifications, blocks, letters and time zone

- **Shore capacity** is 100 bottles per recipient account (`MIB_SHORE_CAPACITY`), counted as
  `capacity_reservations` in state `held` for that recipient — travelling plus delivered-unread —
  inside the release transaction, so concurrent releases cannot overfill it. A full shore
  refuses with `shore_full` and creates nothing. `users.shore_full_since` marks a full episode:
  set with one `shore_full` notification, cleared when `releaseCapacityOnce` frees a slot.
- **Notifications** are user history and are never pruned; `notificationPage` pages them with a
  `createdAt.rowid` cursor and returns the unread count. `services/housekeeping.ts` prunes only
  operational data (worker retry state older than 90 days).
- **Blocks and unblocks.** `listBlocked` shows only blocks the caller placed. `unblockUser`
  removes the block and any friendship row, restoring nothing. A finder's block of an anonymous
  writer stores `blocks.found_bottle_id` and is listed and undone by that bottle only.
- **Direction controls.** `validateLetterText` rejects U+202A–U+202E and U+2066–U+2069 on client
  and server (`letter_direction_controls`); other invisible characters used by real RTL and
  emoji text stay allowed.
- **Time zone.** The web app reports a validated IANA zone after sign-in, on start, on return
  to the foreground and when it changes (`packages/shared/src/timezone.ts`). The server's
  authoritative zone is the account's map clock for day, night and storms (risk policy v4,
  above); journey duration, arrival and every deadline ignore it.

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
- **Appeal results.** Deciding an appeal writes one `moderation_appeal_accepted` or
  `moderation_appeal_rejected` notice (dedupe key per appeal). The inbox stays closed to a
  suspended or banned account (product decision 14), so the result also has its own route:
  `GET /api/moderation/appeal-results` returns the unread appeal-result notices whatever the
  standing, and the web shows the oldest as a one-time popup, in the app or over the standing
  screen. `POST /api/moderation/appeal-results/:id/seen` marks that one notice read, which is
  the same state opening the inbox writes, so the popup, the badge and the history never
  disagree, and nothing is deleted.

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
- **Restriction.** Every decision that can change standing runs `applyStandingEffects`
  (`services/restriction.ts`) inside that decision's transaction. While the account is suspended or banned,
  journeys to it end (D14) and so do its own: storm midpoints and arrivals already due are
  settled first, then every bottle still travelling from it is cancelled (slot released once,
  neutral event) and its unopened adrift listings are withdrawn. Guarded writes make it safe to
  repeat (audit ARCH-R-002).
- **Account deletion attempts.** `POST /api/account/delete` is limited per account and per
  client address before the password check, so it cannot fill the shared password-hashing queue
  (audit SEC-R-001).
- **Deletion.** `services/deletion.ts` is one transaction and is idempotent. It revokes sessions,
  clears identifiers and preferences, drops friendships, blocks, notifications, acceptances and
  idempotency records, cancels in-flight letters (releasing each reservation once and recording
  a `cancelled` event), erases the text of every letter the account wrote unless its case has an
  active hold, hides deleted authors' letters from recipients (`bottles.ts` `deletedSenders`),
  shows the account as "Deleted user" in other people's Sent history, and leaves moderation
  evidence to `services/retention.ts`. The `users` row
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
- **Evidence retention.** `services/retention.ts` redacts a case's content evidence 30 days
  after the human decision — the appeal window, anchored at the later of the decision and a
  reopened window (`violations.appeal_window_starts_at`) — or when a timely appeal is decided,
  whichever is later. A pending appeal holds it; an unopened notice does not. It is enabled by
  default. `planRetention` is a pure dry run; `applyRetention` re-checks every case inside the
  transaction, so an appeal or hold that arrived since the plan wins. A documented `legal` or
  `child_safety` hold outranks the timer and is the only way past it; releasing it returns the
  case to the ordinary calculation. Redaction clears the evidence copy, the reporters'
  explanations and the AI translation, reason and uncertainty only: the decision, the violation and the audit trail outlive them, because an
  upheld violation does.
- **Finality and the three decisions.** An administrator rejects, upholds an ordinary
  violation, or confirms a critical child-safety violation; each needs a written reason, and
  none can be revoked or reopened (there is no route for it). Escalating an unappealed ordinary
  violation to critical restarts its 30-day appeal window once (`appeal_reopened` audit row).
  Appeals close 30 days after the decision on the real clock (`appealDeadline`).
- **Automated review recommends only.** The model labels the *letter* (`violation`,
  `no_violation` or `uncertain`, plus `threat` and `childSafety` flags); `parseReviewOutput`
  maps that to the stored verdict about the report. The earlier accept/reject-the-report
  answer was easy to invert, and a well-formed "reject" was trusted whatever it said (manual
  review round 1). A clearance now stands only if it is confident (≥ 0.8), states no doubt,
  flags nothing, and the letter trips no deterministic English threat backstop
  (`looksLikeExplicitThreat`); otherwise it is stored as `uncertain` with the reason. A child
  safety flag or a possible threat sets `moderation_cases.urgent_at` once, sorting the case
  first in `listCases`, with an `urgent_child_safety_review` or `urgent_threat_review` audit
  row; the admin DTO derives `urgentReason` from `ai_child_safety`. Cases are listed before the
  model answers. `MIB_AI_AUTO_DECIDE=true` is a configuration error.
- **Restricted accounts.** `services/restriction.ts`: when a suspension or ban takes effect,
  bottles travelling to the account are cancelled with capacity released once and the sender
  told only "Delivery unavailable"; `commitArrival` refuses delivery to a restricted recipient;
  restricted accounts vanish from friend lists and requests while friendships stay stored; the
  notification inbox is closed to them (`requireGoodStanding`). Standing is derived from the
  violations and the real clock, so a suspension ends by itself.
- **Audit.** `moderation_audit` is append-only through every application route, but it lives
  in the same SQLite file as everything else and is **not tamper-evident** on its own: someone
  with write access to the database file could alter it. Production must also export each
  moderation event to an external append-only or immutable log (a deployment dependency; see
  `docs/DEPLOYMENT.md`). Each row is written inside the transaction of the action it describes,
  so there is no path that changes what a person may do without leaving a row —
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
