# Architecture notes — stage 3 foundation

This document records the decisions taken to start implementation from an empty repository. The
product specification (v0.2) remains the source of truth; where the specification leaves a decision
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
| Auth                | Username-only dev sign-in, opaque hashed session tokens | Real identity is out of scope for this stage; the session mechanism (bearer token, hashed at rest, TTL) is the shape the real one will keep.                                    |
| Geography           | Abstract 1000×600 chart with fictional shore names     | Spec §6: no countries, borders, or GPS anywhere. Shores/waypoints/islands are graph nodes with chart coordinates only. No coordinate ever reaches storage or logs.               |

## Layering

```
apps/web  (UI)            screens/, components/   → talks only to api/client.ts
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
  `state` (full v0.2 enum), optimistic `version`, `moderation_status`, timestamps, `loss_reason`,
  frozen `aging_profile`.
- `route_plans` — one active plan per bottle with `plan_version`, `graph_version`, node list,
  `starts_at`, `start_progress` (rescue continuity) and `planned_duration_ms`. Prior plans are kept.
- `journey_events` — append-only `(bottle_id, seq)` history.
- `capacity_reservations` — exactly one per bottle, `held|released`; released once at opening or a
  terminal outcome via a guarded update.
- `idempotency_keys` — `(user, scope, key)` with request fingerprint and stored response.
- `notifications` — with a unique `dedupe_key` so replays never duplicate.
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

## Deliberately not implemented (per task scope)

AI writing/rewriting, random recipients, appended notes, chat, GPS-assisted shore suggestion,
storms/loss, island publication, rescue/discard/expiry, moderation console, push notifications,
rate limiting, real authentication. Draft persistence is client-side (`sessionStorage`), as the
specification's Draft state has no live journey.
