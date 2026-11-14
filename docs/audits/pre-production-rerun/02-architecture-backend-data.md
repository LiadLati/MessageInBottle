# 02 — Architecture, backend and data integrity (pre-production re-audit)

Agent 2 of 4. Audited commit **`a04526f`** (merged `main`), private worktree
`scratchpad/rerun/wt-2`. All paths below are relative to the repository root of that checkout.
Probe scripts and every temporary database live in `scratchpad/rerun/a2/` (abbreviated `a2/`).
Nothing in `/home/user/messageinbottle` was read or written; no application code, schema,
migration, dependency or configuration was changed; no commit, branch or push.

## Verdict for this scope: **CONDITIONAL GO**

The engineering core is sound and was verified by behaviour, not by reading claims: the
production artefact builds, installs production-only and runs; configuration fails closed on dev
mode, outbox mail, http app URL and relative database paths; risk policy v4 is deterministic
(incremental worker ≡ one catch-up after downtime, across three randomized 40-day runs with 215–252
zone-change requests each), never rolls twice inside 24 hours, never decides in daytime, never
duplicates or rewrites a recorded decision, and commits multi-bottle storms atomically; current
account deletion leaves no residue; databases from the original `5ba32c2` schema and from the
pre-0015 state upgrade and boot; backup-while-live and restore work. The API suite passes
(54 files, 442 tests, run by me).

**Conditions for GO** (all must hold):

1. **ARCH-R-001 (P1)** closed in code (boot refuses/neutralises development seed accounts in a
   production runtime), or — at minimum — the production database is proven to be created fresh by
   the artefact and the deployment contract says so.
2. **ARCH-R-002 (P1)** closed: letters already at sea from a suspended/banned sender are not
   delivered (or the product owner explicitly accepts and the Terms are corrected).
3. Deployment mitigations for **ARCH-R-003** (one container, recreate strategy, never two
   containers on the volume; documented stale-lock procedure) and **ARCH-R-004** (API port
   firewalled / not published; only the proxy can reach it) are in the runbook.
4. The production-configuration dependencies in §5 are provided (host, domain, SMTP secret,
   backup schedule + off-host copy, external append-only moderation audit sink, log retention).

## Counts

| Severity | Count | IDs                     |
| -------- | ----- | ----------------------- |
| P0       | 0     | —                       |
| P1       | 2     | ARCH-R-001, ARCH-R-002  |
| P2       | 6     | ARCH-R-003 … ARCH-R-008 |
| P3       | 6     | ARCH-R-009 … ARCH-R-014 |

---

## 1. What was run (evidence index)

| Probe                                                                                               | What it proves                                                                                                                                                                                                                                                                   | Result                                   |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `pnpm build`; `pnpm --filter @mib/api deploy --prod --legacy a2/art`                                | Artefact builds; production-only install contains only `@hono/*`, `better-sqlite3`, `drizzle-orm`, `hono`, `nodemailer`, `zod`                                                                                                                                                   | OK                                       |
| `node apps/api/scripts/smoke-artefact.mjs --artefact a2/art --prod-only --port 3211` (TMPDIR in a2) | 47 checks: no tsx/ts/src/.env/db shipped, dev mode refused, relative DB path refused, fresh migrate, online backup, second process refused (same PID namespace), headers, 413, legal pages, seed users 401, register/login/core API, `/api/dev/*` 404, forgot 202, SIGTERM clean | **all PASS**                             |
| a2/`cfg.sqlite` config matrix on the artefact                                                       | fail-closed behaviour of `loadConfig`                                                                                                                                                                                                                                            | see ARCH-R-011                           |
| `a2/p1-weather-determinism.ts` seeds 1–3 (`a2/p1-out{1,2,3}.txt`)                                   | v4 invariants, catch-up ≡ incremental, retries                                                                                                                                                                                                                                   | PASS (see §3)                            |
| `a2/p2-zone-scenarios.ts`                                                                           | zone changes can't reroll; storm cancelled by day stays consumed; harbour path unlimited                                                                                                                                                                                         | see §3, ARCH-R-010                       |
| `a2/p3-populate-old.ts` + `a2/upgrade.sh` + `a2/residue.mjs`                                        | real old code (`5ba32c2`, `f722dc1` = pre-0015) creates data incl. a deleted account; artefact migrates, boots, v4 activates, backfill dry-run/apply                                                                                                                             | upgrade OK; backfill gaps (ARCH-R-006)   |
| `a2/p4-mid0015.ts`                                                                                  | DB migrated at `2e8a4a5` (original 0015) → current migrator                                                                                                                                                                                                                      | FAILS (ARCH-R-007)                       |
| `a2/p5-late-worker-race.ts`, `a2/p12-harbour-cancels-due-storm.ts`                                  | same events, different worker latency                                                                                                                                                                                                                                            | different outcomes (ARCH-R-005)          |
| `a2/p6-poison.ts`                                                                                   | fault isolation of the tick                                                                                                                                                                                                                                                      | global stall (ARCH-R-009)                |
| `a2/p7-storm-atomicity.ts`                                                                          | failure injected mid-storm, retry vs control                                                                                                                                                                                                                                     | atomic, identical (PASS)                 |
| `a2/p8-banned-outbound.ts`                                                                          | banned sender's in-flight letters                                                                                                                                                                                                                                                | delivered + openable (ARCH-R-002)        |
| `a2/p9-current-deletion.ts` + `residue.mjs`                                                         | current deletion across every letter state                                                                                                                                                                                                                                       | zero residue (PASS)                      |
| `a2/p10-post-deletion-notices.ts`                                                                   | rows written for a deleted account after deletion                                                                                                                                                                                                                                | yes (ARCH-R-013)                         |
| `a2/p11-tick-cost.ts`, `p11-tick-cost-split.ts`                                                     | tick cost vs active senders                                                                                                                                                                                                                                                      | linear, 0.55–0.6 ms/account (ARCH-R-008) |
| two `unshare --pid` namespaces, ports 3211 + 5311, `a2/ns.sqlite`                                   | process lock across containers                                                                                                                                                                                                                                                   | both start (ARCH-R-003)                  |
| stale lock with PID 1, `a2/lock.sqlite`                                                             | restart after unclean stop                                                                                                                                                                                                                                                       | refused (ARCH-R-003)                     |
| `a2/bind.sqlite` with `MIB_TRUST_PROXY=true`                                                        | bind address, XFF bucket choice                                                                                                                                                                                                                                                  | ARCH-R-004                               |
| backup of a live DB with a fresh write in the WAL → restore → boot → login (`a2/bk/`)               | backup/restore                                                                                                                                                                                                                                                                   | PASS (login 200 on restored copy)        |
| `a2/promo.sqlite` (dev-seeded DB) on the production artefact                                        | seeded credentials in production                                                                                                                                                                                                                                                 | sign-in 200 (ARCH-R-001)                 |
| `vitest run` in `apps/api` (`a2/vitest-api.txt`)                                                    | suite                                                                                                                                                                                                                                                                            | 54 files / 442 tests passed              |

---

## 2. Findings

### ARCH-R-001 — The production artefact runs happily on a database that contains the development seed accounts (published password)

- **Severity:** P1 · **Status:** newly discovered (gap left by the DEPLOY-001 fix) · **Confirmed**
- **Evidence:** `apps/api/src/db/seed.ts:158-162` refuses only to _create_ seed accounts in a
  production build; `prepareDatabase` (`seed.ts:232-240`) and `server.ts:30-56` never check for
  existing ones. The seed password is published twice in `README.md` (lines 59 and 68, value
  redacted here) and `seed-data.ts:95-96` / `README.md` show `admin:grant -- --username ada`.
  `docs/DEPLOYMENT.md` never says production must start from an empty database, while
  `docs/REMEDIATION.md` D10 / DEPLOYMENT decision 7 talk about running the backfill "on the real
  database" — i.e. an existing database is expected to be carried forward.
- **Reproduction:** copy a dev-seeded temp DB (`a2/p10.sqlite` → `a2/promo.sqlite`), start
  `node a2/art/dist/server.js` (production build, `MIB_DATABASE_PATH` absolute, https app URL),
  `POST /api/auth/login` as `bo`, `cy`, `dee` with the README password → **200, 200, 200**. The
  smoke test only proves the absence of seed accounts in a _fresh_ database.
- **Impact:** if the pilot/dev database is promoted (the documented backfill step suggests it
  will be), anyone who has read the README signs in as those accounts; any of them that was granted
  `admin` (the README tells developers to grant ada) is a full moderation-console takeover.
- **Fix:** in a production runtime, refuse to boot (or lock the accounts: clear `password_hash`,
  revoke sessions and roles) when any `users` row still verifies against `DEV_SEED_PASSWORD` or
  carries a seed username with the seed hash; state in DEPLOYMENT.md that production starts from a
  database created by `dist/migrate.js`, or give the one-shot purge command.
- **Regression test:** artefact smoke step that boots on a dev-seeded copy and asserts a refusal
  (or 401 for every seed account and no `admin` role on them).
- **Related:** DEPLOY-001 / ARCH-001 / SEC-001.

### ARCH-R-002 — Letters already at sea from a suspended or banned sender (including a critical child-safety ban) are still delivered and can be opened

- **Severity:** P1 · **Status:** newly discovered · **Confirmed** (`a2/p8-banned-outbound.ts`)
- **Evidence:** `services/restriction.ts:57-59` `applyStandingEffects` ends only journeys
  travelling **to** the restricted account; `services/journey.ts:93-125` `commitArrival` checks
  blocks and the **recipient's** status/standing only; `services/bottles.ts:369-386` `openBottle`
  checks moderation status, hide and deleted sender, not sender standing. Terms (`packages/shared/src/policies.ts:323`):
  _"While suspended or banned, the account cannot send or receive bottles"_.
- **Reproduction output:**
  `ada standing after decision: banned` →
  `ada -> cy letters released before the ban, after their journeys: [{"state":"delivered","n":3}] | cy arrival notices: 3` →
  `cy opens one after the ban: text length 14`.
- **Impact:** a person banned immediately for child safety keeps reaching other people, unreviewed,
  for the rest of every journey (measured routes up to ~17 days), each with an arrival notification;
  lost ones also enter the public ocean for strangers to read. Suspension has the same behaviour.
- **Fix:** in `applyStandingEffects`, when the subject becomes suspended/banned, also end (cancel,
  release slot once, notify nobody or the sender only) the subject's own `at_sea` bottles — or at
  minimum re-check sender standing in `commitArrival` and in the public listing. Needs a one-line
  product confirmation for suspensions (ban is clear-cut).
- **Regression test:** critical decision → advance past arrival → sender's in-flight bottles are
  not `delivered`, recipients get no `received_arrived`, `openBottle` 404.
- **Related:** D14, ARCH-014, SEC-010.

### ARCH-R-003 — The single-process lock does not work across containers and can block a restart after an unclean stop

- **Severity:** P2 · **Status:** unresolved previous finding (fix incomplete) · **Confirmed**
- **Evidence:** `apps/api/src/lib/process-lock.ts:15-48` decides liveness by PID in the caller's
  own PID namespace: `holder !== pid && alive(holder)`.
  1. Two API processes in separate PID namespaces (what two containers sharing one volume are),
     `unshare --pid --fork --mount-proc`, ports 3211 and 5311, one DB `a2/ns.sqlite`: lock content
     `1` after A **and** after B; `A: {"ok":true…} B: {"ok":true…}` — both serve and both run the
     workers. Each is PID 1, so `holder === pid` is read as "my own stale lock"; a different PID
     from another namespace is `ESRCH` here and is also taken over.
  2. A lock left by an unclean stop (SIGKILL/OOM/power loss) whose PID now belongs to another live
     process (lock file `1`): the artefact refuses to start —
     `Another SeaYou API process (pid 1) is already running … Stop the other process first.`
  3. TOCTOU: two starters that both see a stale lock both `rmSync` then `wx` (lines 40-47); the
     second removes the first's fresh lock.
- **Impact:** the defence behind "exactly one process" (ARCH-004) is absent in the most likely
  topology (a container platform doing a rolling/overlapping deploy or `replicas: 2` by mistake) —
  double workers, doubled in-memory limits, `SQLITE_BUSY_SNAPSHOT` 500s. Conversely a host reboot
  can leave the API down until someone deletes `<db>.lock`; DEPLOYMENT.md §3/§5 never mention it.
- **Fix:** use an OS-level lock that follows the file, not the PID: hold an exclusive lock on the
  database itself (e.g. a dedicated SQLite lock database opened with `locking_mode=EXCLUSIVE` and a
  `BEGIN IMMEDIATE` held for the process lifetime) or `flock` via a small native helper; record
  hostname + boot id + start time in the lock for diagnostics; document stale-lock handling.
- **Regression test:** two processes in different PID namespaces (CI can `unshare`) → the second
  exits non-zero; a lock naming a live unrelated PID does not block start.
- **Related:** ARCH-004, QA-022.

### ARCH-R-004 — "Bind the API to 127.0.0.1" is required by the deployment contract but impossible to configure; with a reachable port the proxy-trust fix is bypassable

- **Severity:** P2 · **Status:** unresolved previous finding · **Confirmed**
- **Evidence:** `apps/api/src/server.ts:108` `serve({ fetch: app.fetch, port: config.port })` —
  no hostname, no `MIB_HOST` anywhere (`config.ts`, `.env.example`). `docs/DEPLOYMENT.md:28`:
  _"`MIB_TRUST_PROXY` … then bind the API to `127.0.0.1`"_. `http/client-address.ts:20-29` takes the
  entry `trustedProxyHops` from the right — correct behind the proxy, but a direct client's own
  header is then the right-most entry.
- **Reproduction** (`a2/bind.sqlite`, `MIB_TRUST_PROXY=true`): `/api/health` answers on the
  non-loopback address `192.0.2.2:3211`; 14 failed logins for one account with a different
  `X-Forwarded-For` each → `401 ×14`; without the header → `401 ×10, 429 ×4`.
- **Impact:** per-address budgets (registration, forgot-password, per-(account,address) sign-in,
  reports) become per-request when the port is reachable (published container port, VM without
  firewall). Per-account budgets still bound brute force.
- **Fix:** add `MIB_HOST` (default `127.0.0.1` in production, `0.0.0.0` only by explicit choice) and
  pass it to `serve`; or refuse `MIB_TRUST_PROXY=true` unless the socket peer is in a configured
  proxy CIDR.
- **Regression test:** config test for the default bind in production; HTTP test that a request
  whose socket peer is not a trusted proxy ignores `X-Forwarded-For`.
- **Related:** ARCH-018, SEC-005.

### ARCH-R-005 — Catch-up is not deterministic when another code path ends a journey or moves the harbour clock after a storm midpoint the worker has not processed yet

- **Severity:** P2 · **Status:** newly discovered · **Confirmed** (two paths)
- **Evidence:** only the device-zone path settles due storms first (`services/weather.ts:123-127`
  `settleDue` → `decideDueStorms`). These do not:
  - `services/weather.ts:140-151` `harbourChanged` → `cancelPendingStorms` (`:153-165`) cancels
    every undecided storm, **including one whose midpoint already passed**;
  - `services/deletion.ts:158-182, 304-369` and `services/restriction.ts:24-52`
    (`endInboundJourneys`, used by deletion and by every standing change) cancel `at_sea` bottles
    directly; `decideStorm` then skips them (`risk.ts:136-150` selects `state='at_sea'`).
    Spec §9.3: _"a midpoint that has passed on server time is always decided under the clock it
    happened in"_; _"a worker that was offline catches up the same rolls and decisions"_.
- **Reproduction:** identical DB copies, identical external events, only worker latency differs.
  - `p5` (recipient deletes account 5 min after a midpoint; 400 bottles):
    `X-on-time: … {"state":"lost","loss_reason":"adrift","n":9} | decisions at midpoint {"n":400,"l":9}`
    vs `Y-late: {"state":"cancelled","n":400} | decisions {"n":0}`.
  - `p12` (sender on harbour clock changes harbour 1 min after the midpoint):
    `X-worker-on-time: cancelled=0 decided=1; decisions 200 (eligible 200)` vs
    `Y-worker-1min-late: cancelled=1 (daytime) decided=0; decisions 0`.
- **Impact:** outcomes (adrift vs cancelled; eligible decisions consumed or not) depend on worker
  timing; with the normal 15 s tick the window is small, after downtime it is the whole outage.
  Recorded outcomes are never rewritten; the defect is in which outcome gets recorded.
- **Fix:** a single "settle due" helper (decide due storms for the affected senders, then due
  arrivals, both at their original instants) called at the start of `harbourChanged`,
  `deleteAccount`/`sweepDeletedAccount` and `applyStandingEffects`; and make `cancelPendingStorms`
  touch only `decision_at > now`.
- **Regression test:** the two probes above as vitest cases asserting X ≡ Y.
- **Related:** ARCH-007, QA-024; spec §9.3.

### ARCH-R-006 — The historical deletion backfill does not apply today's deletion rules, and reports "nothing to do" for pre-0015 databases

- **Severity:** P2 · **Status:** newly discovered · **Confirmed** (upgrade drill with the old code itself)
- **Evidence:** `apps/api/src/tools/deletion-backfill.ts:43-49` runs only `sweepDeletedAccount`
  (`services/deletion.ts:304-416`). The parts of `deleteAccount` that are not in the sweep —
  clearing the text of **every** authored letter incl. delivered/opened (`deletion.ts:184-215`),
  releasing slots of authored delivered letters (`:216`), deleting `policy_acceptances` (`:240`),
  notifications, zone history and rolls (`:228-235`) — never reach accounts deleted by older code.
  Privacy Policy v1.1 (`packages/shared/src/policies.ts:547,549`): _"The text of every letter you
  wrote is erased … Your time zone, preferences, notifications, document acceptances … are removed."_
- **Reproduction:** `a2/p3-populate-old.ts` with the real code of `5ba32c2` and of `f722dc1`
  (pre-0015) creates and deletes account `cy`; `a2/upgrade.sh` migrates with `dist/migrate.js`,
  boots the artefact, then runs `dist/deletion-backfill.js` dry-run and `--apply`. Residue
  (`a2/residue.mjs`, counts only) after `--apply`:
  - `5ba32c2`: `authoredDeliveredOrOpenedWithText: 1, heldSlotsAuthoredDelivered: 1, policyAcceptances: 3`
    (adrift listing and inbound journeys _were_ fixed: 1→0, 2→0);
  - pre-0015: backfill totals all `0`, residue still `authoredDeliveredOrOpenedWithText: 1,
heldSlotsAuthoredDelivered: 1, policyAcceptances: 3`.
    The app now hides such letters from the recipient (`bottles.ts:315-333`), so the held slot can
    never be released by opening — a permanent capacity leak — and the text stays in the database
    and every backup.
- **Impact:** privacy-policy non-compliance for every account deleted before the fix, while the
  operator's tool says the job is done.
- **Fix:** make the backfill call the same idempotent routine as `deleteAccount` for steps 2–6
  (factor them out of `deleteAccount`), including notifications created after deletion
  (ARCH-R-013); keep dry-run default.
- **Regression test:** fixture DB produced by old deletion semantics (as in the probe) → backfill →
  residue query all zeros except retained moderation records.
- **Related:** ARCH-002, ARCH-014, SEC-012, D10.

### ARCH-R-007 — Migration 0015 was edited after it was first applied; databases migrated at those commits cannot start `main`

- **Severity:** P2 · **Status:** regression (migration history) · **Confirmed**; exposure = any
  database that ran `0c43d30`…`2e8a4a5` (development/pilot DBs; no production exists)
- **Evidence:** `git diff 0c43d30 529cb97 -- apps/api/drizzle/0015_product_decisions.sql` adds
  `ALTER TABLE blocks ADD found_bottle_id` and `_journal.json` changes `when` 1790344208425 → 1790347616245. Drizzle's migrator applies every migration newer than the last recorded
  `created_at`, so 0015 is re-run. `db/compat.ts` handles only the renumbered 0012.
- **Reproduction** (`a2/p4-mid0015.ts`): DB migrated by `2e8a4a5`'s own migrator
  (`{ n: 16, m: 1790344208425 }`) → current `runMigrations`:
  `current migrator FAILED … cause: duplicate column name: ai_child_safety` (the transaction rolls
  back; `server.js` would exit via `fatal`).
- **Impact:** an existing dev/pilot database — plausibly the owner's "real database" of D10 —
  cannot be upgraded; the only path is manual SQL. The lead should check, on a _copy_, whether
  `select max(created_at) from __drizzle_migrations` equals 1790344208425.
- **Fix:** add a compat step like the 0012 one: if the recorded last migration is the old 0015
  timestamp and the 0015 columns exist, add `blocks.found_bottle_id` if missing and rewrite the
  bookkeeping row; and a CI rule that migration files and journal entries are append-only once merged.
- **Regression test:** `db/compat.test.ts` fixture migrated with the old 0015 → boots, schema complete.

### ARCH-R-008 — The journey tick's cost is linear in active senders and at-sea bottles and blocks the only thread

- **Severity:** P2 · **Status:** unresolved previous finding (reshaped by v4) · **Confirmed (measured)**
- **Evidence:** `services/risk.ts:64-79` opens one `ensureRolls` transaction per sender with a
  bottle at sea on **every** tick (each also attempts the `risk_policy_activations` insert,
  `weather.ts:40-50`); `services/journey.ts:200-223` then opens one `commitArrivalIfDue` transaction
  for **every** at-sea bottle whether due or not. Everything is synchronous on the API thread.
- **Measurement** (`a2/p11-tick-cost.ts`, 4-core container, other audits running):
  200 accounts → 111 ms median; 1 000 → 582 ms; 3 000 → 1 791 ms (max 2 043 ms) per 15 s tick;
  split at 1 000: risk part 300 ms of 577 ms.
- **Impact:** every HTTP request stalls for the tick's duration; at a few thousand active senders
  the API is unresponsive ~12 % of the time in 2 s bursts. Fine for a small pilot.
- **Fix:** select only bottles with `starts_at + planned_duration_ms <= now` for arrivals; keep a
  per-account "rolled through" watermark and skip `ensureRolls` until the next possible dusk; call
  `policyActivatedAt` once at boot and cache it.
- **Regression test:** an "idle tick prepares ≤ N statements" test (as batch4 does for risk) that
  scales with 1 000 senders.
- **Related:** ARCH-011.

### ARCH-R-009 — No fault isolation in the journey tick: one failing account stops arrivals and expiries for everyone, while health stays green

- **Severity:** P3 · **Status:** newly discovered · **Confirmed** (trigger simulated)
- **Evidence:** `services/journey.ts:198-225` runs risk, then arrivals, then expiry with no
  per-account/per-storm error isolation; `server.ts:59-65` only logs. `/api/health`
  (`http/app.ts:56-79`) reports only `select 1`.
- **Reproduction** (`a2/p6-poison.ts`): one account's stored zone is unusable by the runtime →
  `ada->bo planned arrival … state 2h later: at_sea; tick error: RangeError: Invalid time zone
specified`. Also seen in `p7`: an injected failure in one storm aborts that whole tick.
- **Impact:** any persistent exception (ICU change after a Node upgrade, a data inconsistency)
  halts all deliveries silently. **Fix:** try/catch per storm and per arrival with a counter;
  expose last-successful-tick and error count in `/api/health` (or a separate readiness field).
  **Test:** poison one account, assert other bottles arrive and health reports the failure.

### ARCH-R-010 — Harbour changes move the authoritative map clock without the four-a-day limit; the zone budget itself resets on restart

- **Severity:** P3 · **Status:** newly discovered · **Confirmed**
- **Evidence:** `http/routes/chart.ts:15-25` (`PUT /api/chart/my-shore`, no limiter) →
  `services/chart.ts:103-112` → `weather.ts:140-151` records a new zone for any account without a
  device zone. The limit (`http/routes/auth.ts:62,125`) lives in an in-memory `RateLimiter`
  (`lib/rate-limit.ts`). Spec §9.3: _"The four-changes-a-day limit on zone changes stays."_
- **Reproduction** (`a2/p2-zone-scenarios.ts` (c)): 12 harbour changes in 12 minutes → all `204`,
  13 map-clock rows (`Etc/GMT-9, Etc/GMT+8, …`); 6 device-zone changes → `200,200,200,200,429,429`.
- **Impact:** limited — rolls still obey the 24 h rule (probe (a): 1 roll after 4 zone changes) —
  but the limit the spec keeps is bypassable, and see ARCH-R-005 for the harbour path.
  **Fix:** charge the same budget on harbour changes that move the clock; persist the budget
  (count `account_zone_changes` in the last 24 h). **Test:** 5th clock move in 24 h via either path → 429.

### ARCH-R-011 — Numeric configuration is not range-checked

- **Severity:** P3 · **Status:** newly discovered · **Confirmed**
- **Evidence:** `config.ts:70-76` `envInt` accepts any finite number for `MIB_JOURNEY_TICK_MS`,
  `MIB_SESSION_TTL_MS`, `MIB_SHORE_CAPACITY`, `MIB_MS_PER_CHART_UNIT`, `MIB_MIN_JOURNEY_MS`,
  `MIB_PORT`, AI timeouts. The artefact started with `MIB_JOURNEY_TICK_MS=-5`,
  `MIB_SESSION_TTL_MS=-1`, `MIB_SHORE_CAPACITY=0`, `MIB_MS_PER_CHART_UNIT=0`; with the negative
  tick the process sat at **70–104 % CPU** idle (busy `setInterval`). Negative TTL makes every
  session expire at issue; capacity 0 refuses every release. (Booleans, provider, app URL, DB path,
  risk version and SMTP host _are_ validated — good.)
- **Fix:** `envPositiveInt` with sane minimums for every numeric. **Test:** config table test.

### ARCH-R-012 — Documented operator command lines fail as written

- **Severity:** P3 · **Status:** newly discovered · **Confirmed**
- **Evidence:** every compiled tool calls `loadConfig()`, which in production requires an https
  `MIB_APP_URL` (`config.ts:187-190`). `docs/DEPLOYMENT.md:115` (backup) and `:134-135` (grant)
  show only `MIB_DATABASE_PATH=…`. Running exactly that: `backup.js` → `MIB_APP_URL must be the
public https:// address…`, exit 1; `grant-admin.js` → uncaught `ConfigError` stack trace. A cron
  entry copied from the doc fails on every run (backups silently never happen unless monitored).
  `migrate.js` needs it too (CI commit `0444d7d` already had to add it).
- **Fix:** tools that do not build links should not require `MIB_APP_URL` (a `loadConfig`
  option), or the docs should say "run with the service's environment file". **Test:** artefact
  smoke runs `backup.js`/`grant-admin.js` with only `MIB_DATABASE_PATH`.

### ARCH-R-013 — Rows are still written for an account after it has been deleted

- **Severity:** P3 · **Status:** newly discovered · **Confirmed**
- **Evidence:** `services/notifications.ts:15-41` `enqueueNotification` has no status guard;
  `admin.ts` decisions notify the case's sender. `a2/p10-post-deletion-notices.ts`: report pending
  → sender deletes account → admin upholds → `notifications for the deleted account: right after
deletion 0; after an admin decision 1 (moderation_violation)`. D11 means it is never pruned and
  the backfill does not remove it; the message names the recipient.
- **Fix:** skip notifications for `status='deleted'` users in `enqueueNotification` (and have the
  backfill delete any). **Test:** the probe as a vitest case.

### ARCH-R-014 — `docs/ARCHITECTURE.md` still contradicts the system it describes

- **Severity:** P3 · **Status:** unresolved previous finding (documentation debt) · **Confirmed by reading**
- **Evidence:** `docs/ARCHITECTURE.md:1` "stage 3 foundation"; `:16` "Drizzle keeps a move to
  PostgreSQL a driver + migration change" (every service relies on synchronous better-sqlite3);
  `:18` worker "Can be moved to a separate process without code changes" (false: in-memory limits,
  process lock, per-process caches); `:22` weather row "**Cosmetic only** … never touches … risk …
  Day/night comes from … the browser's IANA zone … Ocean weather belongs to each bottle … No storage
  and no migration" — the opposite of risk policy v4 described at `:174-230` of the same file.
  `DEPLOYMENT.md:90-92` says CLI tools are safe alongside the server via `busy_timeout`, which does
  not cover `SQLITE_BUSY_SNAPSHOT` (ARCH-004's original repro).
- **Fix:** rewrite those rows. **Related:** ARCH doc-debt list, QA-025.

---

## 3. Specific verifications requested

| Requirement                                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A time-zone change cannot reroll weather                                     | **Holds**                                                                                                                                                                                                                                                                                                                                                                                                                           | `p2` (a): four changes within 24 h of a roll, including a day→night entry (Los Angeles→Kolkata) → still 1 roll. `p1`: min gap between rolls = 24.00 h in all 6 worlds with 215–252 random zone requests                                                                                                                                                                                                           |
| One rolling-24 h rule, transactional, racing paths                           | **Holds** within one process: `weather.ts:181-216` reads the last roll and inserts inside one synchronous transaction; both paths (`acceptDeviceZone`, worker, weather GET, harbour change) go through `ensureRollsIn`; unique `(user_id, rolled_at)` (`0016:40`). Cross-process races are prevented only by the lock (see ARCH-R-003); SQLite's serialisable writer would still reject a stale second writer rather than duplicate | `p1` interleaves zone requests between worker ticks                                                                                                                                                                                                                                                                                                                                                               |
| Daytime cannot receive a newly scheduled storm decision                      | **Holds**                                                                                                                                                                                                                                                                                                                                                                                                                           | `nextRollSlot` rolls only on night entries with ≥ 100 min left (`packages/shared/src/weather.ts:394-446`); `decideStorm` cancels if any daytime lies between roll and midpoint (`risk.ts:124-133`). `p1`: "rolls not at night: 0; decided storms with daytime before midpoint: 0" in all worlds; `p2` (b): storm turned to day → `cancelled=true (daytime)`, 0 decisions, no replacement roll, map shows no storm |
| Downtime catches up deterministically                                        | **Holds for the worker alone**: `p1` seeds 1 and 3 identical rolls/decisions/bottles (seed 3: 412 decisions, 296 eligible, 6 losses); seed 2 differs only in a `decided` flag on a storm with no eligible bottle (rolls are materialised lazily per account — no outcome difference). **Breaks** when other paths act first — ARCH-R-005                                                                                            | `a2/p1-out{1,2,3}.txt`, `p5`, `p12`                                                                                                                                                                                                                                                                                                                                                                               |
| Already-recorded outcomes never change                                       | **Holds**: nothing updates `risk_decisions` (only insert, `risk.ts:180`); `p1` re-running the tick at the same instant and later changes no recorded row; deletion keeps decisions                                                                                                                                                                                                                                                  | `p1` "retry leaves recorded rows unchanged: true"                                                                                                                                                                                                                                                                                                                                                                 |
| Retries cannot duplicate rolls or decisions                                  | **Holds**: unique `(bottle_id, night_key)` + in-tx re-read of the roll; a failure mid-storm rolls back the whole storm and the retry equals an uninterrupted control                                                                                                                                                                                                                                                                | `p7`: `after failure: decisions=0, lost=0, roll decided=false`; `after retry: … identical to control: true`                                                                                                                                                                                                                                                                                                       |
| Multiple bottles in one storm                                                | **Atomic** (one transaction per storm, `risk.ts:107-118`), independent per-bottle draws                                                                                                                                                                                                                                                                                                                                             | `p7` (300 bottles), `p5` (400 bottles, 9 losses ≈ 1 %)                                                                                                                                                                                                                                                                                                                                                            |
| Arrival vs risk                                                              | Order is fixed risk → arrivals (`journey.ts:187-199`) and a bottle due ashore by the midpoint is skipped (`risk.ts:163`), so arrival wins identically in catch-up. Deletion/standing/harbour paths: ARCH-R-005                                                                                                                                                                                                                      | `p1` bottle states identical                                                                                                                                                                                                                                                                                                                                                                                      |
| Account deletion removes/anonymises what is promised                         | **Holds for current deletion**: residue all zeros across at-sea, delivered, opened, adrift, inbound at-sea and inbound delivered (`p9`); backfill after it is a no-op. Gaps: post-deletion notifications (ARCH-R-013) and historical accounts (ARCH-R-006)                                                                                                                                                                          | `p9` output, `residue.mjs`                                                                                                                                                                                                                                                                                                                                                                                        |
| Old deleted accounts handled by the documented backfill (dry-run default)    | **Partly**: dry-run is the default and rolls back (`deletion-backfill.ts:43-52`), apply fixes adrift listings and inbound journeys, but not letter text, authored delivered slots or acceptances (ARCH-R-006). It takes no process lock and runs in one transaction (fine while the API is up, adds write load)                                                                                                                     | `upgrade.sh` outputs                                                                                                                                                                                                                                                                                                                                                                                              |
| Production cannot run with dev mode, dev mail exposure or seeded credentials | Dev mode: refused (`config.ts:168-174`, smoke). Outbox: refused outside dev mode (`config.ts:238-239`; artefact exits). Seed creation: refused (`seed.ts:161`). **Existing seed accounts: not refused — ARCH-R-001**                                                                                                                                                                                                                | smoke; `a2/promo.sqlite`                                                                                                                                                                                                                                                                                                                                                                                          |
| Artefact works after production-only install                                 | **Holds**                                                                                                                                                                                                                                                                                                                                                                                                                           | smoke `--prod-only` all PASS; upgrade drills boot the artefact from `a2/art`                                                                                                                                                                                                                                                                                                                                      |
| Shore capacity under concurrency                                             | **Holds by construction**: count and insert inside one synchronous transaction (`release.ts:218-223, 132-134, 307-316`); `http/shore-capacity.test.ts` (110 → 100) passes in my run                                                                                                                                                                                                                                                 | vitest                                                                                                                                                                                                                                                                                                                                                                                                            |
| Notification retention                                                       | Holds: housekeeping never touches `notifications` (`services/housekeeping.ts:13-56`); pagination in place                                                                                                                                                                                                                                                                                                                           | code + tests                                                                                                                                                                                                                                                                                                                                                                                                      |
| Evidence retention and holds                                                 | Holds: `finalityOf` (`services/retention.ts:80-110`), holds via `holdOf`, deletion keeps held letters (`deletion.ts:196-210`); stale AI claims released at boot (`server.ts:40`)                                                                                                                                                                                                                                                    | tests pass                                                                                                                                                                                                                                                                                                                                                                                                        |
| Suspension/ban and automatic restoration                                     | Restoration is derived from server time (`moderation.ts:261-275`), inbound journeys ended once. Outbound gap: ARCH-R-002                                                                                                                                                                                                                                                                                                            | `p8`                                                                                                                                                                                                                                                                                                                                                                                                              |
| Migrations 0015/0016/0017, fresh and historical upgrade                      | Fresh: 18 migrations (smoke). From `5ba32c2` and from pre-0015 (`f722dc1`) with data written by that code: migrate + boot OK, `risk_policy_activations` = v4 at first boot, 0017 back-filled 2 device zones (deleted account excluded), v3 decisions kept (7 eligible v3 rows), v4 rolls start. From intermediate 0015: fails (ARCH-R-007)                                                                                          | `upgrade.sh`, `p4`                                                                                                                                                                                                                                                                                                                                                                                                |
| Backup/restore                                                               | Holds: live backup with a pending WAL (41 KB) → `integrity ok`, users 5 → restored copy boots, the account written just before the backup signs in (200). Documented command line is incomplete (ARCH-R-012)                                                                                                                                                                                                                        | `a2/bk/`                                                                                                                                                                                                                                                                                                                                                                                                          |
| Health/readiness, shutdown                                                   | `select 1` health (503 on failure); SIGTERM closes server, workers and SQLite, exit 0 (smoke, and every probe run here). No worker liveness (ARCH-R-009)                                                                                                                                                                                                                                                                            | smoke                                                                                                                                                                                                                                                                                                                                                                                                             |

## 4. Previous ARCH / DEPLOY P0–P1 findings — closure check

| Old ID                                                          | Old sev  | Now                                                                                       | Evidence                                                                                                                                                                              |
| --------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEPLOY-001 = ARCH-001                                           | P0       | **Closed** (residual: ARCH-R-001)                                                         | `config.ts:163-174` default false + refused in production; `http/app.ts:100` dev routes unmounted; `seed.ts:161`; smoke: `MIB_DEV_MODE=true` exit 1, `/api/dev/*` 404, seed users 401 |
| ARCH-006                                                        | P0       | **Closed (engineering)**; hosting items are production dependencies                       | artefact build/deploy/prod-only smoke; absolute DB path enforced (`config.ts:175-182`); backup tool + restore drill; DEPLOYMENT.md + Caddyfile exist                                  |
| ARCH-002                                                        | P1       | **Closed** for new deletions; historical via backfill (adrift withdrawn 1→0)              | `deletion.ts:304-357`; `p9`; `upgrade.sh 5ba32c2`                                                                                                                                     |
| ARCH-003                                                        | P1 (→P2) | **Closed**                                                                                | `ai-review.ts:156-174`, called at boot with lease 0 (`server.ts:40`) and per tick                                                                                                     |
| ARCH-004                                                        | P1 (→P2) | **Partly** — works in one PID namespace only                                              | smoke "second process refused"; ARCH-R-003                                                                                                                                            |
| ARCH-005                                                        | P1       | **Closed by decision D6** (100 per recipient)                                             | `release.ts:62-75,132-134`; shore-capacity test                                                                                                                                       |
| ARCH-008                                                        | P1       | **Closed**                                                                                | `routes/auth.ts:98-106` answers before mail (`void requestPasswordReset`), failure withdraws only the new link (`auth.ts:196-260`); smoke forgot 202                                  |
| ARCH-014                                                        | P1       | **Closed**                                                                                | `journey.ts:93-125` refuses inactive/restricted recipient and either-direction block; `endInboundJourneys`; `p9` inboundAtSea 0; `5ba32c2` upgrade 2→0 after backfill                 |
| ARCH-007, ARCH-011, ARCH-012, ARCH-016, ARCH-017, ARCH-018 (P2) | P2       | 007, 012, 016, 017 closed (p7; limits; smoke; health); 011 → ARCH-R-008; 018 → ARCH-R-004 | as cited                                                                                                                                                                              |

## 5. Production-configuration dependencies (not defects unless noted)

Host and region; public domain / `MIB_APP_URL`; Gmail App Password (`MIB_SMTP_*`) — without it
`MIB_MAIL_PROVIDER` defaults to `disabled` and password recovery silently sends nothing (logged at
start; `DEPLOYMENT.md:30` says so); backup schedule, off-host copy and retention (tool works; command
line in docs incomplete — ARCH-R-012); **external append-only moderation audit sink** (D4 — no
export hook exists in code; DEPLOYMENT.md §2b correctly says launch is blocked on it); log
destination/retention; firewalling the API port (needed because of ARCH-R-004); one container with
recreate deploys (needed because of ARCH-R-003); GitHub branch protection; store packaging / Data
Safety form; granting the first administrator. None of these is mishandled by code except where a
finding says so.

## 6. Accepted and documented product decisions (not reopened)

- **Storm dodging by zone change** (spec §9.3, D7): a change that turns the map to day before the
  midpoint cancels the storm. `GET /api/ocean/weather` returns the rolled storm window from dusk,
  before it starts (`weather.ts:259-269`), so a scripted client can always dodge with one change per
  storm night — within the accepted policy. Recorded here only so nobody mistakes it for a defect.
- Per-recipient capacity 100 (D6); forward-only migrations with restore as rollback; v3 decisions
  not yet taken at v4 activation are never taken; `MIB_RISK_POLICY_VERSION=0` affects only new
  journeys.

## 7. Limitations

Single host, 4 cores shared with three other audits (timings indicative; scaling shape is the
finding). "Containers" were emulated with `unshare --pid`; no real orchestrator. No SMTP, Ollama or
network filesystem tested. The poison-zone trigger in ARCH-R-009 is simulated by writing an
invalid zone row. The owner's real/dev database was deliberately not opened, so exposure for
ARCH-R-001/ARCH-R-007 is stated conditionally.
