# Architecture, backend and reliability

Audited commit `5ba32c2` (branch `audit/pre-deployment-readiness`, cut from `origin/main`).
Specialist: Agent 2. Lead review applied — see "Lead adjudication" at the end.

## Method

Every file under `apps/api/src` (config, server bootstrap, db client/schema/migrations/compat/seed,
all 9 route modules, 3 middlewares, 16 services, domain routing/aging, libs), `packages/shared`,
drizzle migrations 0000–0014 and `meta/_journal.json`, the vendored drizzle-orm migrator and
better-sqlite3 session (to establish transaction semantics), the docs, `.env.example`, and the web
`api/client.ts` + `vite.config.ts` (to establish the origin contract).

Empirical work ran against fresh `mktemp` databases or `:memory:` via the repo's own harness —
nothing in the repository, and the development database verified unchanged. Scripts proved:
migrations apply and are idempotent; two connections produce `SQLITE_BUSY_SNAPSHOT`; two processes
booting together crash one; a stuck AI claim blocks retention forever; a deleted account's adrift
letter stays readable; zone-hopping avoids all storm risk; an unapplied loss decision; graph and
Dijkstra costs; escalation after waiver.

Not done: no multi-host or container testing (no infrastructure exists), no load testing beyond
single-operation microbenchmarks, no vitest run, no listening server, no UI evaluation.

## Deployment dependency map

```
                    ┌──────────────── one origin (mandatory) ─────────────────┐
  browser  ──HTTPS──┤ TLS terminator / reverse proxy  ← DOES NOT EXIST YET    │
                    │   /            → static SPA (apps/web/dist)  ← no host  │
                    │   /api/*       → API :3001                              │
                    │   /legal/*     → API :3001  (server-rendered HTML)      │
                    │   /support     → API :3001                              │
                    └─────────────────────────────────────────────────────────┘
                                          │
                        exactly ONE Node process (hard constraint, ARCH-004)
                                          │
   ┌──────────────────────────────────────┴───────────────────────────────────┐
   │ apps/api  (tsx src/server.ts — no compiled artefact, tsx is a devDep)     │
   │                                                                           │
   │  boot: loadEnvFiles → loadConfig → assertPolicySetServeable               │
   │        → createDb → runMigrations(+compat) → seedChart                    │
   │        → [devMode] seedUsers → activatePublicListings → serve             │
   │                                                                           │
   │  in-process workers (setInterval, all unref'd, no shutdown handler):      │
   │    journey   15 s  → risk decisions → arrivals → public expiry            │
   │    ai-review 10 s  → HTTP → Ollama                                        │
   │    retention 60 m  → evidence redaction                                   │
   │                                                                           │
   │  in-process state LOST on restart and NOT shared across instances:        │
   │    RateLimiter ×3, OutboxMailer, the ~110 MB route-graph cache            │
   └──────────────────────────────────────┬───────────────────────────────────┘
                                          │
   ┌──────────────┬───────────────────────┼─────────────────┬─────────────────┐
   │ SQLite file  │ SMTP provider         │ Ollama          │ filesystem      │
   │ + -wal/-shm  │ (password reset only) │ 127.0.0.1:11434 │ drizzle/*.sql   │
   │ PERSISTENT   │ OPTIONAL but required │ OPTIONAL;       │ must ship with  │
   │ VOLUME       │ for account recovery  │ ~6–8 GB RAM     │ the app         │
   │ single writer│ failure ⇒ ARCH-008    │ for qwen2.5:7b  │ (API_ROOT rel.) │
   └──────────────┴───────────────────────┴─────────────────┴─────────────────┘

   out-of-band, needs shell + DB access on the live host:
     pnpm --filter @mib/api admin:grant / developer:grant   (role provisioning)
     pnpm --filter @mib/api retention:plan                  (dry-run)
     backup / restore                                        ← DOES NOT EXIST
```

**Hard couplings.** (a) The SPA calls `fetch('/api' + path)` with no configurable base
(`apps/web/src/api/client.ts:68`), so API and web **must** be same-origin, which makes
`MIB_CORS_ORIGIN` irrelevant. (b) Nothing in the repo serves `apps/web/dist` — the API has no static
middleware. (c) `MIB_APP_URL` must equal the public origin or every password-reset link is dead.
(d) Exactly one process may touch the database.

## Confirmed defects

### ARCH-001 — Unset environment boots production into development mode → account takeover

**P0 · confirmed (end-to-end) · code defect + deployment-configuration requirement · small**
_(Same root cause as SEC-001 and QA-002 — found independently by three agents; the takeover chain
was demonstrated by the security agent. See report 03 for the full exploit.)_

`apps/api/src/config.ts:101` — `const devMode = (process.env.MIB_DEV_MODE ?? 'true') === 'true';`
The **unsafe value is the default**. `config.ts:137` then defaults the mail provider to `outbox`;
`http/app.ts:70` mounts `/api/dev`; `server.ts:33` seeds four accounts with a README-published
password; `db/reset.ts:7` only refuses when `devMode` is false, so `pnpm db:reset` would wipe a
production database that forgot the variable.

Why existing controls don't prevent it: `README.md:94` says "Must be `false` for any shared
deployment" but nothing enforces it, there is no `NODE_ENV` cross-check anywhere, the failure is
silent (the server prints `devMode=true` and runs), and the 242 API tests construct their own
context and never exercise `loadConfig()`'s defaults.

Remediation direction: invert the default, or require an explicit `MIB_ENV` with no default and fail
boot if absent; independently gate `/api/dev/outbox` behind `requireAuth + requireDeveloper`.
Verification: a boot test with an empty environment asserting `devMode === false`, `/api/dev/*` 404,
no seed accounts, `mail.provider === 'disabled'`.

### ARCH-006 — No deployable artefact, no runtime host, no backup, no persistent-storage contract

**P0 · confirmed · deployment-configuration requirement · large**

Verified absences across the whole repo: no `Dockerfile`, no CI, no `fly.toml`/`Procfile`/systemd
unit, no nginx/Caddy config, no backup or restore script.

- `apps/api/package.json` — `"build": "tsc --noEmit"` (emits nothing) and `"start": "tsx
src/server.ts"`, while **`tsx` is a devDependency**: a `--prod` install cannot start the API.
- `apps/api/src/config.ts:104` — the database defaults to `path.join(API_ROOT, 'data', 'mib.sqlite')`,
  i.e. **inside the application directory**, which a container rebuild or an atomic-symlink deploy
  destroys.
- `.env.example:5` sets `MIB_DATABASE_PATH=./data/mib.sqlite` — **cwd-relative**, unlike the code
  default which is API_ROOT-relative. Starting from a different working directory silently creates a
  second, empty database and the app looks like it lost all data.
- `better-sqlite3` is a native module and must be rebuilt for the target Node/libc.

Impact: the system cannot be deployed as it stands, and the most likely naive attempt (copy the
repo, `pnpm start`) produces an app that loses its entire database on the next release.
Verification: a restore drill — stop, restore into a clean volume, boot, confirm
`assertSchemaComplete` passes and an in-flight journey still arrives.

### ARCH-002 — Account deletion leaves the deleted person's adrift letters publicly readable

**P1 · confirmed (repro) · code defect (privacy) + documentation mismatch · small**
_(Same defect as SEC-002 — found independently by two agents, both of whom exploited it.)_

`apps/api/src/services/deletion.ts:62` —
`const IN_FLIGHT: BottleState[] = ['at_sea', 'stranded_public', 'public_expired'];`

`stranded_public` and `public_expired` are **never written by any code path**. The real adrift state
is `state='lost'` + `loss_reason='adrift'` (`services/outcomes.ts:84-95`), which is what
`listPublicOcean` and `openPublicBottle` key on. _(Lead independently re-verified: the only non-test
occurrences of those two strings are the state enum, a web label, and an unrelated event name /
dedupe key in `risk.ts` — never a bottle state assignment.)_

Observed: public ocean before deletion 1 → `journeysCancelled: 0` → bottle still `lost`/`adrift` with
50 chars of text → **still listed after deletion** → a stranger opened it and read the full text.

This contradicts **live published text**, which is why it outranks a plain bug:

- `apps/api/src/http/legal-pages.ts:163`, the public `/legal/delete-account` page: _"letters of yours
  that are still at sea, **or adrift in the public ocean**, are cancelled and their text is cleared,
  so nobody can find or open them afterwards."_
- `packages/shared/src/policies.ts:528`, published Privacy Policy v1.0: _"Letters you wrote are
  removed from future reading in the app, and their text is cleared…"_
- `docs/ARCHITECTURE.md:340` and `docs/LEGAL_DOCUMENTS.md:92-93` repeat it.

Why existing controls don't prevent it: `deletion.test.ts` exercises only an `at_sea` bottle, and the
two states that would matter are unreachable, so the suite passes while the intent is unimplemented.
`transitionBottle` would refuse `lost → cancelled` anyway (`ALLOWED_TRANSITIONS.lost = []`) and
deletion bypasses it with a raw `UPDATE`, so a fix also needs a state-model decision.

Remediation: select bottles by the condition that actually means "nobody has received this" —
including `state='lost' AND loss_reason IN ('adrift','sunk')` — and delete the dead states so the
mistake cannot recur. Decide separately whether _delivered_ letters keep their text (the
implementation says yes at `deletion.ts:164`; the Privacy Policy bullet says no).

### ARCH-003 — A crash mid-AI-review permanently blocks seven-day evidence retention for that case

**P1 · confirmed (repro) · code defect · small**

`services/ai-review.ts:188-193` claims the case (`aiStatus = 'running'`) then awaits the model for up
to 60s. If the process dies in that window there is **no recovery**: `runAiReviewTick` selects only
`aiStatus = 'queued'` (`:164`), and `finalityOf` returns `{finalAt: null, hold: 'ai_in_queue'}` for
**any** case with `aiStatus === 'running'`, checked _before_ the case status
(`services/retention.ts:85`) — so the case can never become final.

Observed after a simulated crash, an admin decision and a year advanced: `ai tick: reviewed 0`,
`aiStatus: running`, `retention plan: held {ai_in_queue: 1}`, `evidenceRedactedAt: null`,
evidence still present, case status `rejected`.

Impact: the published seven-day rule is silently violated and the most sensitive content the system
stores is kept indefinitely. Nothing alerts anyone. Because there is no graceful shutdown (ARCH-016),
**every redeploy is a chance to create one of these.** `aiStartedAt` is written but never read.

Remediation: reclaim stale claims (`running AND aiStartedAt < now - lease`) back to `queued` on boot
and each tick; make `finalityOf` treat only a _live_ claim as a hold; add an operational counter.

### ARCH-004 — Single-process by construction, nothing says so, nothing enforces it

**P1 · confirmed (two repros) · code defect + deployment-configuration requirement · medium**

Every mutating path uses `ctx.db.transaction(cb)`, which drizzle runs as **`BEGIN` (deferred)**
(`drizzle-orm/better-sqlite3/session.js:37-41`), and every one of those transactions reads first and
writes second.

Repro A — two connections to one WAL file with `busy_timeout=5000`: `A FAILED: SQLITE_BUSY_SNAPSHOT`
after **1 ms**. `busy_timeout` does not apply to a stale-snapshot upgrade, and there is no retry
anywhere; the error surfaces as an unmapped 500.
Repro B — two processes booting together, replaying drizzle's own migrate sequence which reads the
bookkeeping **outside** the transaction: `process B FAILED -> SQLITE_ERROR table 'blocks' already
exists`, routed through `fatal()` → `process.exit(1)`.

Impact: two replicas behind a load balancer, a rolling deploy with overlap, a separate worker
process, or an operator running `db:migrate`/`retention:plan`/`admin:grant` while the API is live all
produce nondeterministic 500s and, at first boot or upgrade, a crash.

Why existing controls don't prevent it: every test runs in one process with one connection. Worse,
`docs/ARCHITECTURE.md:21` states the worker _"Can be moved to a separate process without code
changes"_, which is false.

Remediation: document and enforce single-process operation (an advisory lock row or lock file at
boot; `replicas: 1`, recreate-not-rolling). Horizontal scaling would be a PostgreSQL migration plus
making every service async — not a driver swap.

### ARCH-005 — Shore capacity is a shared global resource; a delivered-unopened bottle holds its slot forever

**P1 · confirmed (repro) · product decision + code defect · medium**

`services/release.ts:56-65,104` — `heldReservations(db, destinationShore.id) >= destinationShore.capacity`.
The count is **per shore**, not per recipient, and `setUserShore` places no uniqueness constraint, so
any number of users share a shore. Measured catalogue: **392 shores**, default capacity **5**.
Capacity is released only at `openBottle`, `commitLoss` and cancellation — **never at delivery**.

Observed (capacity 2): two delivered-unopened bottles held both slots, and an unrelated sender's
release to an unrelated recipient at that shore was rejected `shore_full`.

Impact: (a) natural accumulation — five abandoned, never-opened deliveries at a popular harbour
permanently close it for every user who chose it, with no expiry, no admin tool and no user-visible
reason beyond "Your friend's shore is full right now"; (b) deliberate griefing with five alt accounts;
(c) ARCH-014 makes it worse.

Note `docs/SeaYou_Product_Specification.md:204` explicitly blesses "A delivered unopened bottle still
occupies its slot", and §8.3/D06 ("Capacity value, sender-specific limits, and reservation behavior
need approval") is still **Open** — the mechanism is per spec, but its scope was never decided for a
392-shore shared catalogue. **Resolve D06 before launch.**

### ARCH-007 — A recorded losing risk decision whose commit fails is never retried

**P2 · confirmed (repro) · code defect · small**

`services/risk.ts:136-175` inserts the `risk_decisions` row in one transaction; `:181` calls
`commitLoss(...)` in a **separate** transaction. A crash or throw between them leaves
`lost = true, eligible = true` recorded while the bottle stays `at_sea`, and the next tick skips the
night (`:144`). Observed: _decision row says lost=true/sunk; bottle actually ended as delivered._

The error favours the user, but the audit record and the journey disagree permanently, the decision
consumed one of the five eligible slots, and analytics over `risk_decisions` are wrong.
Remediation: commit the loss in the same transaction as the decision row, or reconcile on tick.

### ARCH-008 — A failing mail transport turns password recovery into an enumeration oracle

**P1 · confirmed (repro) · code defect (security) · small**
_(Same defect as QA-004 — found independently by two agents. Severity raised from the specialist's
P2 to P1 by the lead; see adjudication.)_

`services/auth.ts:182` returns early (202) for an unknown address; `:206` awaits
`ctx.mailer.send(...)` for a known one, and an SMTP failure propagates to a 500. With a mailer
throwing `ECONNREFUSED`: `forgot(known) -> 500`, `forgot(unknown) -> 202`.

This defeats the property the code explicitly claims at `routes/auth.ts:84` — _"Same answer whether
or not the address is known: the response cannot be used to enumerate."_ Additionally the token is
committed and all earlier ones invalidated **before** the send (`:184-204`), so a failed send leaves
the user strictly worse off, and password recovery is simultaneously broken with no alerting.

Why existing controls don't prevent it: `recovery.test.ts` uses only `OutboxMailer` and
`DisabledMailer`, which always resolve.
Remediation: treat send failure as non-fatal for the response (log/queue), always answer 202; add a
health signal. Also set nodemailer `connectionTimeout`/`greetingTimeout`/`socketTimeout` — none are
configured, so a hung SMTP server blocks the single-threaded handler.

### ARCH-009 — The public deletion form bypasses the per-account sign-in budget

**P2 · confirmed · code defect (security) · small**

`routes/auth.ts:77` applies `LOGIN_PER_ACCOUNT` (10/15 min, keyed on username).
`routes/legal.ts:78` calls `login()` behind a limiter keyed **only on the client address**, and the
three routers each construct their own `RateLimiter`, so the budgets are entirely separate.

Impact: a distributed attacker guessing one account's password meets no account-level limit at all on
`/legal/delete-account`, and a successful guess **destroys the account** rather than merely signing
in. With ARCH-018, even the address budget collapses.

### ARCH-010 — Storm risk is effectively opt-in from the client

**P2 · confirmed (repro) · product decision / abuse-resistance gap · medium**

`services/risk.ts:46-56` — `accountNightZone` returns `null` when `users.time_zone` is null and
`journeyNights` then returns `[]`. `:69-70` floors nights at `max(fromMs, releasedAt, account.since)`.
`services/auth.ts:37-46` rewrites `timeZoneSince = now` on any _change_, and
`PUT /api/auth/time-zone` has **no rate limit** and no plausibility check.

Observed over 30 days at sea: a no-time-zone account took **0** risk decisions (control account: 7);
an account rotating 30 UTC-equivalent IANA aliases, one per evening, also took **0**. One request a
day buys permanent immunity.

Impact: the central product drama ("the sea determines whether the bottle arrives") becomes optional
for anyone with a modified client or a script. A fairness/integrity problem, not a data-safety one.
Both behaviours are _deliberate and tested_ (risk.test.ts pins "no zone ⇒ no nights" and "zone changes
move nights forward, never back") — the design correctly prevents retroactive risk; nobody considered
the abuse consequence. Note the loss parameters are **not** exposed: the built bundle contains none of
`stormNightChance|lossChance|progressCutoff|adriftShare`.

Remediation is a product decision: a server default zone when none is reported; rate-limit or debounce
zone changes; advance `timeZoneSince` only when the UTC _offset_ changes; or cap skippable nights.

### ARCH-011 — The risk worker re-walks every night of every journey every 15 seconds

**P2 · confirmed (measured) · code defect (scalability) · medium**

`services/risk.ts:131` computes `journeyNights(ctx, bottle, bottle.releasedAt, now)` — from
**release**, not from the last decision — for every at-sea bottle on every tick, and `nightWindow`
constructs a fresh `Intl.DateTimeFormat` ~4 times per night.

Measured on a 17-day journey (a realistic long route): 18 nights, **8.12 ms per bottle per tick** ⇒
200 at-sea bottles = 1,624 ms of blocking every tick; 1,000 bottles = 8.1 s, against a 15 s interval.
better-sqlite3 and the worker are synchronous, so this blocks **all** HTTP traffic.

Remediation: persist a per-bottle "nights walked to" cursor and walk forward only; memoise
`Intl.DateTimeFormat` per zone; bound the per-tick batch.

### ARCH-012 — Unrate-limited route planning costs ~105 ms of blocking CPU per request

**P2 · confirmed (measured) · code defect (availability) · small**

`services/release.ts:99` runs `planRoute` (Dijkstra over 35,984 nodes / 137,152 edges) inside both
`POST /api/bottles/preview` and `/release`, neither of which has any rate limit. Measured with the
graph already cached: Lisbon→Brisbane median **105 ms**, p90 140 ms (Lisbon→Barcelona 0 ms).
Cold `loadActiveGraph` is **495 ms** and holds ~**110 MB** resident for the process lifetime.

~9 long-route previews per second saturate the single-threaded API; reaching a long route needs only
two self-owned accounts with far-apart shores. Also a capacity-planning input: ≥ ~256 MB of heap just
for the graph.

### ARCH-013 — Escalating an already-waived warning to a critical ban leaves the account with no appeal

**P2 · confirmed (repro) · product decision / code defect (process fairness) · small**

`services/admin.ts:517-521` — `decideCaseCritical` sets `severity='critical'` and rewrites `reason` on
an existing violation but never clears `appealWaivedAt` or `noticePresentedAt`, so `appealAvailable`
(`services/moderation.ts:279-283`) stays false and `submitAppeal` refuses.

Observed: standing after waiver `warned` → escalation → `banned`, `severity: critical`,
`appealWaivedAt` still set, `pendingDecision` not offered, appeal refused with `appeal_waived`.

A person who accepted a warning and pressed "Skip appeal" can later be permanently banned for the
same case with **no route to review** — directly contradicting the module's own documented guarantee
at `admin.ts:450-452`: _"the single appeal opportunity is untouched… a ban is not a way around
review."_ The waived-then-escalated path is untested.

### ARCH-014 — A journey to an account that deletes itself still delivers

**P1 (raised from the specialist's P2 — see adjudication) · confirmed (repro) · code defect · medium**
_(= QA-005. Found independently by two agents.)_

`services/deletion.ts:139-142` sweeps only bottles where the deleted user is the **sender**.
`commitArrival` (`services/journey.ts:88-92`) checks only `blocks` where `blocker = recipient` — and
deletion has just removed all of that account's blocks — so nothing stops the delivery.

Observed: bottle `delivered`, recipient snapshot "Deleted account", **slot still held**, and **1 new
notification created for the deleted account** (`received_arrived`). `releaseCapacityOnce` is called
only on open, cancel or loss, and there is no sweeper — so the reservation is held **forever**. With
capacity 5, five such deletions permanently close a shore.

### ARCH-015 — `GET /api/bottles/sent/:id/letter` returns a 1970 date and a negative duration

**P2 · confirmed (repro) · code defect (UI-visible) · small**

`services/bottles.ts:216-228` — `const deliveredAt = bottle.deliveredAt!;` then `iso(deliveredAt)` and
`deliveredAt - bottle.releasedAt`. `readOwnLetter` (`:348-355`) routes every own-letter read through
the `'shore'` branch, including `lost` and `at_sea` bottles.

Observed for a sender's own adrift bottle:
`"state":"lost","deliveredAt":"1970-01-01T00:00:00.000Z","journeyDurationMs":-1788696000000`.
This is live: `apps/web/src/screens/OceanScreen.tsx:311-317` renders
`Your letter · ${formatDuration(...)} at sea`, and `formatDuration` on that negative value yields
**"0m"** — so the sender always sees "Your letter · 0m at sea".

Remediation: give the `'shore'` branch the same non-delivered handling the `'public'` branch already
has (`bottles.ts:199-211` uses `outcomeAt ?? releasedAt`).

### ARCH-016 — No graceful shutdown at all

**P2 · confirmed · code defect · small**

`apps/api/src/server.ts` registers no `SIGTERM`/`SIGINT` handler, never calls `server.close()`, never
clears the three worker intervals and never closes the SQLite handle.

Every `docker stop`/systemd restart/deploy drops in-flight requests mid-handler and can kill the AI
worker inside its `await` — which is **exactly how ARCH-003 is created**. SQLite itself is safe (all
writes are committed synchronous transactions), so this is not a corruption risk.

### ARCH-017 — `/api/health` never touches the database

**P2 · confirmed · code defect (operability) · small**

`http/app.ts:33-49` returns `{ok:true, serverTime}` computed purely from `ctx.clock`. A readiness
probe on this endpoint stays green while the volume is unmounted, the file is read-only or the schema
is broken. There is also no liveness signal for the three workers (last tick, queue depth, cases held
by `ai_in_queue`).

### ARCH-018 — `MIB_TRUST_PROXY=true` with a reachable port is a complete rate-limit bypass

**P2 · confirmed · deployment-configuration requirement · small**
_(Same defect as SEC-005, where the bypass was demonstrated.)_

`routes/auth.ts:46-49`, `routes/moderation.ts:35-38` and `routes/legal.ts:68-71` all take the **first**
`X-Forwarded-For` entry verbatim. `server.ts:92` calls `serve({ fetch, port })` with **no `hostname`**,
so the server listens on all interfaces. `config.ts:51-52` warns about this in a comment; nothing
enforces it.

### P3 findings

- **ARCH-019** — `MIB_RISK_POLICY_VERSION` is stamped on the bottle (`release.ts:254`) but the worker
  always draws with the compile-time `RISK_POLICY_VERSION` (`risk.ts:130`). Any value other than 0 or
  3 is silently meaningless and unvalidated. _Code defect, small._
- **ARCH-020** — `assertSchemaComplete`'s `REQUIRED_TABLES`/`REQUIRED_COLUMNS` (`db/compat.ts:278-301`)
  are hand-maintained; migration 0015+ will not be covered unless someone remembers. _Tech debt, small._
- **ARCH-021** — Response DTOs are TypeScript types only; nothing validates a response against its zod
  schema at runtime. **This is why ARCH-015 shipped.** _Tech debt, medium._
- **ARCH-022** — `http/validate.ts:7-15` deliberately strips `received` values so a password or letter
  is never echoed, but the fallback at `http/app.ts:80-84` returns raw `err.issues` for any `ZodError`
  reaching the handler. No current path feeds user input to a bare `.parse()`, so the risk is latent.
  _Code defect, small._
- **ARCH-023** — `GET /api/policies/` lists 4 published documents but `GET /api/policies/:id` accepts
  only the 3 `POLICY_IDS`, so `child-safety` 400s. The web renders from the bundle and never calls
  these, so nothing user-facing breaks. _Code defect, small._
- **ARCH-024** — Nothing prunes expired `sessions`, `idempotency_keys`, `password_resets`,
  `journey_events` or `notifications`; all grow monotonically. `planRetention` also full-scans
  `moderation_cases` hourly with two extra queries per case. _Tech debt, small._
- **ARCH-025** — Dead states `stranded_public`, `public_expired`, `discarded` and dead loss reason
  `destroyed` in `packages/shared/src/bottle-state.ts`, with live transitions declared for them, are the
  direct cause of ARCH-002. _Tech debt, small._
- **ARCH-026** — Moderation notifications are timestamped with `ctx.clock` while their decisions use
  `ctx.realClock` (`admin.ts:281,415,442`). Identical in production; in development, advancing the dev
  clock reorders the inbox. _Code defect, small._
- **ARCH-027** — No request body size limit anywhere. Must be handled at the reverse proxy.
  _Deployment-configuration, small._
- **ARCH-028** — **There is no unblock, anywhere.** No API route, no service function, no UI, no admin
  tool; the only `DELETE FROM blocks` is inside account deletion. `FriendsScreen.tsx:12` states the
  design explicitly ("blocked people never form a list"), so the blocker cannot even see whom they
  blocked, while the friendship row survives and `listFriends` hides it. A mis-tap is permanent for
  both accounts. Contradicts `docs/SeaYou_Product_Specification.md:91` and `:379`, which list "blocked
  users" under Settings in a document whose own rule is "Unmarked text is implemented".
  _Product decision / UI backlog, medium._ (See also FE-016.)

## High-confidence risks (not confirmed defects)

- **Worker downtime longer than 72 h silently consumes an adrift bottle's entire public window.**
  Confirmed behaviour: after a 5-day outage the bottle never appears on the public map, is expired at
  its original deadline, and the sender is told _"72 hours passed and the bottle you sent to X was not
  opened."_ This is the correct _effective-time_ semantics, but the notification is misleading and the
  discovery window is lost. Needs a product decision on whether a long outage should extend the
  deadline, as `activatePublicListings` already does for legacy rows.
- **Evidence for an upheld violation whose owner never returns is retained indefinitely.** By the
  approved rules a case becomes final only on appeal or explicit waiver, and a banned person has
  little reason to return. The published Privacy Policy presents seven days as the rule. A
  storage-limitation question for whoever signs off the privacy posture. _(Closely related to SEC-012,
  which is the confirmed deleted-sender case.)_
- **Two configuration switches can falsify published legal text.** `MIB_AI_AUTO_DECIDE=true` makes the
  model decide through `decideCase(ctx, null, …)` and record `decided_by='ai'`; `MIB_AI_ENDPOINT` is
  documented as changeable to "a cloud host — a URL change", which would send reported letter text to
  a third party. The defaults are correct and the _ban_ path is genuinely closed to the model. The gap
  is governance: nothing couples these flags to the published text. _(= SEC-020.)_
- **A block placed during an open finder reading does not revoke it.** `openPublicBottle` checks blocks
  at open, but `activeReading` filters only on `closedAt`/`sessionExpiresAt`/`moderationStatus`. Worst
  case 15 minutes.
- **Everything expensive is synchronous on one thread**: `scryptSync`, better-sqlite3 and Dijkstra.
  Latency couples across all users; there is no queue, no worker thread, no backpressure.
- **Default journey durations are long and unconfirmed.** Measured with shipped defaults:
  Lisbon→Barcelona 34 h, Lisbon→Nagasaki 15.3 d, Lisbon→Brisbane 16.7 d. D01 is still Open. Needs
  explicit product sign-off, because it also sets the ARCH-011 workload.

## Deployment / configuration requirements

1. **`MIB_DEV_MODE=false` — non-negotiable** (ARCH-001). Ideally fix the default too.
2. **Exactly one API process, ever** (ARCH-004): `replicas: 1`, recreate-not-rolling deploys, no
   separate worker process, no CLI tool run against the live database while the API is up.
3. **`MIB_DATABASE_PATH` absolute, on a persistent volume** (ARCH-006), plus a documented working
   directory.
4. **Backup and restore** using `VACUUM INTO` or `sqlite3 .backup` — **never a plain file copy**, the
   `-wal` makes that torn — with a tested restore drill. None exists today.
5. **Reverse proxy** terminating HTTPS, serving `apps/web/dist` at `/` and proxying `/api`, `/legal`,
   `/support` to the API on the **same origin**.
6. **Bind the API to `127.0.0.1`** (or firewall the port) before setting `MIB_TRUST_PROXY=true`
   (ARCH-018). Add a request body size limit at the proxy (ARCH-027).
7. **Security headers at the proxy** — the app sets none. The `/legal` and `/support` pages use an
   inline `<style>`, so any CSP must allow it.
8. **`MIB_APP_URL`** must equal the public origin, or every password-reset link is dead.
9. **Mail**: `MIB_MAIL_PROVIDER=smtp` with real credentials, or accept that password recovery does not
   work. Monitor send failures (ARCH-008).
10. **`MIB_SUPPORT_EMAIL`**: confirm the launch address; it is published in the Privacy Policy and
    Child Safety Standards.
11. **AI review**: run Ollama on the API host (~6–8 GB RAM on top of the API's ~110 MB graph cache) or
    set `MIB_AI_ENABLED=false`. Keep `MIB_AI_AUTO_DECIDE=false` and the endpoint operator-controlled,
    or change the Privacy Policy first.
12. **Role provisioning**: `admin:grant`/`developer:grant` need shell + database access on the live
    host. Decide who holds that, and grant at least one admin **before the first report arrives** —
    there is no bootstrap path and no admin exists by default.
13. **Open product decisions that gate launch**: D06 shore capacity (ARCH-005), D01 journey pace, the
    time-zone risk exemption (ARCH-010), escalation-after-waiver (ARCH-013), unblocking (ARCH-028),
    long-outage public windows.
14. **Rollback**: migrations are forward-only (no `down` files). A rollback to a previous application
    version against an already-migrated database is unsupported; the only recovery is a restore.
15. **Log retention and monitoring**: no metrics, no structured logs, no request ids, no error
    reporting. `MIB_LOG_REQUESTS` defaults to `true` and paths carry bottle and violation ids.
16. **Memory floor**: ~110 MB for the route graph plus Node baseline; a 512 MB instance is tight,
    especially with Ollama co-located.

## Documentation debt

- **`README.md:195-197` is factually wrong and dangerous**: _"Nothing loses a bottle on its own yet:
  the risk policy (spec D08) is not approved … production has no automatic outcomes."_
  `MIB_RISK_POLICY_VERSION` defaults to `3` and the journey worker loses bottles automatically.
- **`README.md:8`** names the source of truth as "v0.2, stage 3"; the current spec is
  `docs/SeaYou_Product_Specification.md` v1.0 and the v0.2 file **no longer exists in the repo**.
- **`docs/ARCHITECTURE.md:3-5`** — "The product specification (v0.2) remains the source of truth" —
  same dangling reference, and headed "stage 3 foundation" while describing a far later system.
- **`docs/ARCHITECTURE.md:21`** — the worker "Can be moved to a separate process without code changes"
  is **false** (ARCH-004).
- **`docs/ARCHITECTURE.md:17`** — "Drizzle keeps a move to PostgreSQL a driver + migration change" is
  optimistic: every service relies on better-sqlite3's synchronous `.get()/.run()/.all()` and on
  `db.transaction(cb)` returning synchronously. A Postgres move is an async rewrite of the service
  layer.
- **`docs/ARCHITECTURE.md:340`, `docs/LEGAL_DOCUMENTS.md:92-93`, `legal-pages.ts:163` and
  `policies.ts:528`** all promise adrift letters are cancelled and cleared on deletion. They are not
  (ARCH-002). The last two are **published legal text**.
- **`policies.ts:528`** also says letters the deleted person wrote have "their text cleared", while
  `deletion.ts:164` deliberately keeps delivered letters for their recipient. One must change.
- **`services/outcomes.ts:37-41`** — stale comment claiming "no worker ever loses a bottle on its own";
  `risk.ts:181` is now a caller.
- **`services/admin.ts:450-452`** — "the single appeal opportunity is untouched" is false after a
  waiver (ARCH-013).
- **`docs/SeaYou_Product_Specification.md:91, 379`** list "blocked users" in Settings; no such surface
  exists (ARCH-028).
- **`packages/shared/src/bottle-state.ts:1`** — "Journey state per spec v0.2 §11", a dangling citation.
- **No deployment documentation of any kind**: the README has 20 headings and none is about deploying,
  hosting, backing up or restoring.

## Checked and found FINE

- **Migrations from empty**: 0000–0014 apply cleanly (27 tables), and re-running on the same handle
  _and_ on a fresh connection is a no-op. WAL and `foreign_keys=ON` confirmed at runtime.
- **Partially-applied migrations are impossible in a single process**: drizzle runs the whole set in
  one `BEGIN…COMMIT` with `ROLLBACK` on error, and SQLite DDL is transactional.
- **The CRLF/renumbering compatibility work is genuinely solid.** `db/compat.ts` recognises both LF and
  CRLF hashes of the historical migration, refuses anything else, proves the existing table matches
  column-for-column and index-for-index before touching bookkeeping, counts acceptance rows before and
  after, and `assertSchemaComplete` catches a silently skipped migration afterwards. No finding.
- **Warm boot is cheap**: `runMigrations` 1–2 ms, `seedChart` 59–76 ms on an already-seeded database.
- **Release atomicity and idempotency**: letter, bottle, plan, reservation, first event and idempotency
  record commit together; a replayed key returns the same bottle; a reused key with a different payload
  409s; keys are scoped per user; the web keeps the key in the draft and regenerates only after success.
- **Optimistic transitions**: `transitionBottle` guards on `(id, state, version)` and the shared
  transition table; arrival and loss can never both commit.
- **Public open vs public expiry**: the `public_openings` primary key elects the single winner;
  `expirePublicListing` refuses any bottle with an opening and records the expiry **at the deadline**,
  not at worker time, so worker delay changes notification timing but not effective event time.
- **Time authority** is sound throughout: duration is `f(route length, config)` persisted at release;
  `progressAt`/`plannedArrivalAt` are pure functions of persisted plan + server time; no device value
  reaches any of it; sessions and reset tokens use `realClock` so the dev clock cannot sign anyone out;
  public expiry is exactly 72 elapsed hours enforced by the read paths themselves; finder recovery is
  exactly 15 elapsed minutes; suspension is 7 elapsed days from the second violation; same-harbour
  delivers inside the release transaction with `plannedDurationMs = 0`.
- **Risk determinism**: draws are `hashSeed(policyVersion,'risk',bottleId,nightKey)`; `risk_decisions`
  is unique on `(bottle_id, night_key)` so a decision is never rerolled; catch-up evaluates progress
  and arrival at the _original_ decision instant; zone changes provably move nights forward only.
- **Notification dedup**: `notifications.dedupe_key` unique with `onConflictDoNothing` on every enqueue.
- **Moderation concurrency**: `decideCase` and `decideAppeal` both use guarded
  `UPDATE … WHERE status='pending'` and 409 the loser; `moderation_cases.bottle_id`,
  `violations.case_id` and `appeals.violation_id` are unique; `letter_reports` is unique on
  `(case_id, reporter_id)`; every standing-changing action writes a `moderation_audit` row in the same
  transaction.
- **Report budgets are durable** — counted from persisted rows, so signing out or switching device
  hands nobody a fresh budget.
- **Retention atomicity**: `applyRetention` re-assesses every case inside the transaction, so an appeal
  or hold arriving after the plan wins; redaction is idempotent and never touches the audit trail.
- **Authorization placement**: enforced in middleware and re-checked in services; role read from the
  users row on every request; `requireAdmin` and `requireDeveloper` disjoint; DEV controls need the role
  **and** `devMode`; unknown-id reads return 404 rather than 403 throughout, so ids are not oracles.
- **`decideCaseCritical` genuinely cannot be reached by the model** — it takes a non-nullable
  `AuthUser` and the review worker passes `null`.
- **No sensitive data in logs.** Specifically tested whether drizzle's `DrizzleQueryError` (which
  formats params into its message) reaches `console.error`. It does not; the message is the bare SQLite
  text. Letter text, password hashes and tokens stay out of the logs.
- **No XSS in the server-rendered pages**: `legal-pages.ts:16` escapes `& < > "` and every
  interpolation goes through it with all attribute values double-quoted.
- **Password handling**: scrypt with per-password salt, a self-describing parameter string,
  constant-time compare, and a dummy hash so unknown usernames cost the same.
- **Environment inventory is consistent**: every `MIB_*`/`VITE_MIB_*` read by the code is documented in
  `.env.example` (diffed both directions).
- **Secrets hygiene**: `.gitignore` excludes `.env*` and `apps/api/data/`; `git ls-files` confirms no
  database and no env file is tracked.
- **Graph immutability**: plans record their `graph_version` and are rendered with it, so a newer active
  graph never moves a released bottle.

## Limitations

- No deployment topology could be tested, because none exists. Every deployment finding is derived from
  code and the absence of artefacts.
- Multi-process evidence uses two or three connections/processes against one file on **one host**. That
  is the correct model for SQLite locking, but a network filesystem was not tested — if the persistent
  volume is NFS/EFS-like, SQLite's locking is additionally unsafe and that is a separate, more serious
  problem to investigate.
- Performance numbers are single-operation microbenchmarks on this container. Treat the absolute
  milliseconds as indicative and the _scaling shape_ (linear in at-sea bottles, linear in route length)
  as the finding.
- The vitest suite was not run; the lead's single run is the baseline.
- The web app was assessed only where it defines the API contract.
- The AI review path was tested with stub reviewers; no real Ollama endpoint was contacted.

## Lead adjudication

- **ARCH-001 = SEC-001 = QA-002.** Three agents reached it independently; the security agent
  demonstrated the full anonymous account-takeover chain. Counted once, as **DEPLOY-001**, in the
  executive summary. The lead independently verified the default at `config.ts:101` and the route
  ordering at `dev.ts:36` vs `:51`.
- **ARCH-002 = SEC-002**, **ARCH-008 = QA-004**, **ARCH-014 = QA-005**, **ARCH-018 = SEC-005** — each
  found independently by two agents. Counted once each.
- **ARCH-014 severity raised P2 → P1.** The specialist rated it P2; the QA agent rated the same
  defect P1 after observing the notification written to the deleted account. The lead sides with P1: a
  shore slot held _permanently_ is unrecoverable state (only a hand-edit of SQLite frees it), five of
  them close a shore for every user routing there, and the same path writes to an account the Privacy
  Policy says is gone.
- **ARCH-008 severity raised P2 → P1.** The specialist rated it P2; the QA agent rated the same defect
  P1. The lead sides with P1: it has two independent failure modes (password recovery is wholly broken,
  _and_ it becomes an enumeration oracle) and it fires during ordinary SMTP outages, not only under
  attack.
- **ARCH-006 accepted as P0** — it literally prevents deployment, which is the stated P0 bar.
- The lead independently verified ARCH-002's dead-state claim and the `/legal/delete-account`
  published text.
