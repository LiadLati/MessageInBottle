# QA, test strategy and release readiness

Audited commit `5ba32c2` (branch `audit/pre-deployment-readiness`, cut from `origin/main`).
Specialist: Agent 4. Lead review applied — see "Lead adjudication" at the end.

All mutation ran against temporary SQLite databases via explicit `MIB_DATABASE_PATH`; the development
database `apps/api/data/mib.sqlite` was verified byte-identical
(sha256 `687030b5…0a047a49`) at the start, mid-run and at exit. Every process started for the audit was
stopped. Working tree clean.

## Scope and method

The expensive gates were run **once** by the lead and shared with all four agents rather than repeated
four times. Results at commit `5ba32c2`:

| Gate   | Command             | Result                                                                      |
| ------ | ------------------- | --------------------------------------------------------------------------- |
| Format | `pnpm format:check` | **PASS** (5.5s)                                                             |
| Lint   | `pnpm lint`         | **PASS**, 0 errors 0 warnings (28.7s)                                       |
| Types  | `pnpm typecheck`    | **PASS**, 3 packages                                                        |
| Tests  | `pnpm test`         | **PASS — 336 tests** (api 242, shared 49, web 45) in 85.6s wall / ~221s CPU |
| Build  | `pnpm build`        | **PASS**                                                                    |

Additional controlled execution performed for this report:

| #   | Command                                                                                                                 | Duration | Result                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------- |
| 1   | `MIB_DATABASE_PATH=$TMP/audit.sqlite npx tsx src/db/migrate.ts` (fresh temp DB)                                         | 1.21s    | **PASS** — 15 migrations, 27 tables, 360 KB |
| 2   | Production-mode smoke: `MIB_DEV_MODE=false MIB_PORT=3021 MIB_DATABASE_PATH=$TMP/… npx tsx src/server.ts` + ~35 requests | ~4 min   | **PASS** — see "Controlled execution"       |
| 3   | `npx vitest run src/tools/grant-role.test.ts -t "is a no-op when the account already holds the role"`                   | 2.12s    | **FAIL** — QA-009                           |
| 4   | `npx vitest run src/lib/focusTrap.test.ts --reporter=verbose` (web)                                                     | 0.34s    | PASS; confirms `environment 0ms` (no DOM)   |
| 5   | Instrumented timing of `createTestWorld`, `seedChart`, `hashPassword`, `releaseBottle`                                  | ~8s      | QA-006                                      |
| 6   | Authorization probe of every admin/dev route omitted from the test's hard-coded lists                                   | ~3s      | QA-012                                      |
| 7   | 20,000-sample simulation of the risk suite's storm schedule                                                             | ~6s      | QA-011                                      |
| 8   | Probes for SMTP failure and recipient-deletion-mid-journey                                                              | ~3s      | QA-004, QA-005                              |
| 9   | Probe of the coordinate-privacy test's actual scope                                                                     | ~3s      | QA-010                                      |

**Caveat that governs this whole report:** 336 passing tests are _evidence_ that the exercised paths
work, not _proof_ that the product is defect-free. Two of the highest-severity findings here (QA-004,
QA-005) are real defects in fully green code, found only by probing paths no test enters.

## Test inventory

| Suite             | Files | Tests | Runtime                 | What it actually covers                                                                                                                                                                                                                                                                             |
| ----------------- | ----- | ----- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | 5     | 49    | 0.97s                   | Letter validation (graphemes, emoji/RTL, byte cap); bottle-state machine; credential/email rules; day-night phase and storm scheduling; risk policy (80% cutoff, 5-decision cap, adrift/sunk split, 800k-sample statistics); **17 tests asserting the legal documents match implemented behaviour** |
| `apps/web`        | 8     | 45    | 1.86s                   | **Pure helpers only.** API error mapping (6), map geometry/antimeridian/clustering (11), ocean+shore weather (8), shore presentation (2), shore queue (3), focus-trap arithmetic (3), plus 12 **source-text grep** tests. **Zero rendering; runs in Node with no DOM**                              |
| `apps/api`        | 24    | 242   | 82.9s wall / 220.9s CPU | Everything else                                                                                                                                                                                                                                                                                     |

API files, slowest first: `services/moderation` (25 tests, 36.2s), `services/risk` (21, 32.2s),
`http/appeals` (15, 22.4s), `services/outcomes` (14, 21.7s), `services/retention` (20, 15.5s),
`tools/grant-role` (7, 12.1s — real subprocesses), `services/release` (13, 9.4s), `http/auth` (15, 9.1s),
`http/app` (8, 8.5s), `services/journey` (8, 8.2s), `http/legal` (11, 6.5s), `services/notifications`
(3, 5.1s), `services/authority` (7, 4.6s), `http/roles` (8, 4.5s), `db/migration` (1, 4.3s),
`services/deletion` (5, 3.9s), `http/policies` (6, 3.7s), `http/support` (8, 3.7s), `db/geo/geo`
(16, 3.4s), `http/recovery` (7, 3.0s), `http/friends` (**1**, 1.6s), `db/compat` (15, 1.2s),
`domain/routing` (5, 12ms), `lib/env` (3, 5ms).

**Categories that do not exist at all:** browser/e2e flows; accessibility checks; visual regression;
performance/load; contract tests between web and API; multi-process or restart tests; CI enforcement of
any of the above.

**Hygiene, verified by grep across all 37 test files and genuinely good:** no `.only`, `.skip` or
`.todo`; no fixed sleeps; no fake timers; no system-time mutation; no test binds a port, calls an
external service, or touches the development database. QA-009 and QA-013 are the only two exceptions,
one file each.

## Requirement → test coverage map

✅ covered · ⚠️ partial · ❌ gap

| Requirement                                      | Evidence                                                                                                             |                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Registration + policy acceptance                 | `http/policies.test.ts:58-119` (missing block/flag/false/wrong type → 400; stale version → 409; three rows recorded) | ✅                                                 |
| Re-acceptance after a version change             | `http/policies.test.ts:217-249` (old acceptance kept as history, gate closes, 2 privacy rows)                        | ✅                                                 |
| Sign-in / sign-out                               | `http/auth.test.ts:145-195`                                                                                          | ✅                                                 |
| Password reset                                   | `http/recovery.test.ts:99-153` (single use, supersede, session revocation, 30-min TTL on real time)                  | ⚠️ mail-failure path untested → **QA-004**         |
| Friends / requests / denial                      | `http/friends.test.ts` (1 test); accept path in `http/auth.test.ts:220-234`                                          | ⚠️ **QA-017**                                      |
| Blocks                                           | `services/authority.test.ts:18-49`, `outcomes.test.ts:167-176` (both directions, public ocean)                       | ⚠️ HTTP route untested; no unblock exists          |
| Letter drafting + draft recovery                 | web only, `WriteScreen.tsx:37-79`                                                                                    | ❌ **QA-003 / QA-007**                             |
| Release idempotency                              | `services/release.test.ts:154-191` (retry, mismatched key, per-user scope)                                           | ✅                                                 |
| Same-harbour immediate arrival                   | `services/risk.test.ts`                                                                                              | ✅                                                 |
| Different-harbour travel                         | `services/journey.test.ts:30-102`                                                                                    | ✅                                                 |
| **Distance-based timing**                        | no test calls `journeyDurationMs`; every test only _reads back_ `plannedDurationMs`                                  | ❌ **QA-016**                                      |
| Account-time-zone day/night                      | `services/risk.test.ts` (7 tests, incl. DST)                                                                         | ✅                                                 |
| Storm decisions + statistical boundaries         | `shared/risk.test.ts:64-121` (25% storms, 1% loss, 75/25 split, 800k deterministic samples)                          | ✅                                                 |
| 80% cutoff + 5-decision cap (unit)               | `shared/risk.test.ts:123-141`                                                                                        | ✅                                                 |
| …same, at integration level                      | `api risk.test.ts:176-215` — assertions conditional and confounded                                                   | ⚠️ **QA-011**                                      |
| Arrival/loss race, **both orders**               | `services/outcomes.test.ts:103-129`                                                                                  | ✅                                                 |
| Adrift/sunk split                                | `outcomes.test.ts:137-161` (sunk never public)                                                                       | ✅                                                 |
| Public projection privacy                        | `outcomes.test.ts:145-161` — closed key-set assertion                                                                | ✅                                                 |
| Public opening race                              | `outcomes.test.ts` (idempotent for the finder, plain 409 for everyone else)                                          | ✅                                                 |
| Public expiry boundary                           | `risk.test.ts` (listed until exactly the deadline; an opening just before it wins)                                   | ✅                                                 |
| Finder one-time read + 15-min resume             | `risk.test.ts` (4 tests incl. server-side expiry and legacy openings)                                                | ✅                                                 |
| Sender unlimited re-reading                      | `risk.test.ts`                                                                                                       | ✅                                                 |
| Sunk visibility acknowledgement                  | `outcomes.test.ts:313-335`                                                                                           | ✅                                                 |
| Lost list                                        | API data covered (`outcomes.test.ts:322`); the folder itself is `LettersScreen.tsx:110-160`                          | ⚠️ UI untested                                     |
| Notifications + dedup                            | `services/notifications.test.ts` (retries of every path produce no duplicates)                                       | ✅                                                 |
| Reports / duplicates / reporter privacy          | `moderation.test.ts:76-178`, `appeals.test.ts`                                                                       | ⚠️ multi-reporter merge → **QA-019**               |
| AI offline / malformed / uncertainty / injection | `moderation.test.ts:183-390` (7 tests)                                                                               | ⚠️ timeout untested; eval gate manual → **QA-024** |
| Admin accept/reject confirmations                | `appeals.test.ts`, `moderation.test.ts:406+`                                                                         | ✅                                                 |
| Immediate appeal + explicit waiver               | `appeals.test.ts:132-230`                                                                                            | ✅                                                 |
| **Closing or reloading resolves nothing**        | `appeals.test.ts:132-155` (presented, 30-day gap, re-login → notice still pending, `appealWaivedAt` null)            | ✅                                                 |
| 1st/2nd/3rd violation enforcement                | `moderation.test.ts`                                                                                                 | ✅                                                 |
| Critical child-safety ban                        | `retention.test.ts:335-405` (5 tests)                                                                                | ✅                                                 |
| Accepted / rejected appeals                      | `moderation.test.ts:571-641`, `appeals.test.ts`                                                                      | ✅                                                 |
| Seven-day evidence retention                     | `retention.test.ts:72-272` (12 tests, every finality path)                                                           | ✅                                                 |
| Holds + hold release                             | `retention.test.ts:275-333`                                                                                          | ✅                                                 |
| Account deletion                                 | `deletion.test.ts` + `legal.test.ts:155-317`                                                                         | ⚠️ recipient-side → **QA-005**                     |
| Admin/developer/member separation                | `http/roles.test.ts` (8 tests)                                                                                       | ⚠️ hand-maintained lists → **QA-012**              |
| Public legal + support pages                     | `legal.test.ts` (11) + `support.test.ts` (8); confirmed live in production mode                                      | ✅                                                 |
| Migration from historical shapes                 | `compat.test.ts` (15, LF+CRLF), `migration.test.ts`, `auth.test.ts:361-443`, `geo.test.ts:30-138`                    | ⚠️ 3 of 15 cut points → **QA-021**                 |

## Controlled execution results

**Fresh-database migration — PASS.** 1.21s, exit 0, 15 migrations, 27 tables, 360 KB.

**Production-mode start — PASS.**

```
SeaYou API listening on http://localhost:3021 (devMode=false, mail=disabled)
  AI review is OFF: reports wait for an admin.
  Mail is DISABLED: nothing is delivered.
```

| Check                                                    | Result                                                                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/health`                                            | 200 `{"ok":true,"serverTime":…}`                                                                                                                   |
| `/legal` + all four documents + `/legal/delete-account`  | all 200, 5.7–13 KB HTML                                                                                                                            |
| `/support`                                               | 200, 8 KB, **0 `<script>` tags**, 6 `mailto:` links                                                                                                |
| `/api/dev/outbox`, `/api/dev/status`                     | **404** — dev router not mounted ✅                                                                                                                |
| `/api/chart`, `/api/ocean/public` unauthenticated        | 401 ✅                                                                                                                                             |
| sign in as `ada` with the published dev password         | **401** — no seeded users outside dev mode ✅                                                                                                      |
| register → set shore → friend request → accept → release | all succeed ✅                                                                                                                                     |
| shore capacity under 5-way concurrency                   | exactly 5 bottles / 5 reservations / 5 route plans / 5 letters / 5 idempotency keys at `capacity=5`; 6th → 422 `shore_full`. **No over-commit** ✅ |
| idempotent replay of a used key                          | 200 in **5 ms** ✅                                                                                                                                 |

This is the strongest single piece of evidence in the audit: with the environment set correctly, the
product starts, migrates, serves its public legal surface, and executes the core correspondence flow
with its hard invariants intact. Every P0 in this audit is about what happens when the environment is
_not_ set correctly, or about the absence of a deployable artefact — not about the domain logic.

## Findings

### QA-002 — `MIB_DEV_MODE` defaults to `true`, `loadConfig()` has no tests, and `/api/dev/outbox` is unauthenticated

**P0 · confirmed · deployment-configuration requirement · small**
_(Canonical ID **DEPLOY-001**; = ARCH-001 = SEC-001. Found independently by three agents.)_

`config.ts:101` — `const devMode = (process.env.MIB_DEV_MODE ?? 'true') === 'true';` — the unsafe value
is the default. `loadConfig()` is called only by `server.ts:27` and is referenced by **no test**
(`lib/env.test.ts` tests `.env` _file parsing_ only). `routes/dev.ts:36` registers `GET /outbox` before
the auth middleware. Probe in dev mode:

```
200  GET /api/dev/outbox   (NO TOKEN)   <- captured mail, including live reset links
401  GET /api/dev/status   (NO TOKEN)
prod /api/dev/outbox -> 404
```

A deployment that forgets one variable ships seeded accounts with the README-published password, a
persisted dev clock, `/api/dev/*`, and an unauthenticated endpoint listing every password-reset link —
which the security agent chained into a full anonymous account takeover (SEC-001).

The _containment_ is tested (`recovery.test.ts:196` asserts 404 outside dev mode) — but nothing tests
the **defaults**, and `roles.test.ts`'s `DEV_ROUTES` list omits `/api/dev/outbox`, so its open access is
neither asserted nor forbidden. `README.md:92-93` and `.env.example` both say `MIB_DEV_MODE` "Must be
`false` for any shared deployment", and `config.ts:140` does refuse `MIB_MAIL_PROVIDER=outbox` outside
dev mode — good instincts that stop one step short.

**Remediation:** invert the default, or refuse to start when `NODE_ENV=production` and dev mode is on;
put `/api/dev/outbox` behind `requireDeveloper`; add a `loadConfig()` test asserting safe defaults.
**Verify:** a config test must fail if the default flips back.

### QA-001 — There is no CI. Every quality gate is manual.

**P1 (lowered from the specialist's P0 — see adjudication) · confirmed · deployment-configuration requirement · medium**

No `.github/`, `.gitlab-ci.yml`, `.circleci`, `Dockerfile`, `docker-compose*`, `Procfile` or service unit
anywhere (`find -maxdepth 3`, `ls -a` at root). Nothing runs the 336 tests, `eslint`, `tsc`,
`prettier --check` or `vite build` on a push, a branch or a merge. The gate results above are a snapshot
of one human invocation at one commit. Compounding it, `apps/web/package.json` runs
`vitest run --passWithNoTests`, so deleting or mis-naming every web test file leaves `pnpm test` green.

**Impact:** every quality signal in this audit is unenforced; the next merge can regress any of it
silently — including the P0 fixes this audit recommends. **Remediation:** a pipeline running
format → lint → typecheck → test → build on every pull request and on the release branch; drop
`--passWithNoTests` or pin a minimum test count. **Verify:** a deliberately broken test must block a
merge.

### QA-004 — Mail transport failure turns password recovery into a 500 _and_ an enumeration oracle

**P1 · confirmed · code defect · small**
_(= ARCH-008. Agent 2 rated it P2; raised to P1 — see adjudication.)_

`services/auth.ts:175-220` commits the reset token, **invalidating every earlier one**, at `:184-204`,
then `await ctx.mailer.send(...)` at `:206`. `routes/auth.ts:85-91` awaits with no catch;
`http/app.ts:86-87` maps the rejection to 500. Probe with a rejecting mailer
(`connect ECONNREFUSED smtp.example.com:587`):

```
KNOWN address,   SMTP down -> 500 {"error":{"code":"internal","message":"unexpected error"}}
UNKNOWN address, SMTP down -> 202 {"ok":true}
password_resets rows written despite the failure: 1
```

This defeats the property the code explicitly claims at `routes/auth.ts:84` — _"Same answer whether or
not the address is known: the response cannot be used to enumerate."_ During any SMTP outage, 500 vs 202
identifies which addresses have accounts. Worse for the legitimate user: their previously valid reset
link has already been invalidated, so a failed send leaves them strictly worse off with no route
forward.

**Why nothing catches it:** `http/recovery.test.ts:166-196` uses only `OutboxMailer` and
`DisabledMailer`; both always resolve. No test anywhere injects a failing mailer.
**Remediation:** catch and log send failures inside `requestPasswordReset` and return 202 regardless
(optionally with a retry queue); consider sending before committing, or committing only on success.
**Verify:** a rejecting mailer must yield 202 for both known and unknown addresses, and the failure must
be recorded.

### QA-005 — A recipient deleting their account mid-journey still receives the letter and leaks a shore slot permanently

**P1 · confirmed · code defect · medium**
_(= ARCH-014.)_

`services/deletion.ts:139-142` cancels only bottles where the deleted account is the **sender**
(`eq(t.bottles.senderId, userId)`); `:194-198` merely renames `recipientNameSnapshot`.
`services/journey.ts:88-93` re-checks exactly one thing before arrival — a block by recipient → sender —
not recipient status. Probe:

```
released; held slots at destination: 1
recipient deleted; journeysCancelled reported: 0
commitArrivalIfDue -> true | bottle state: delivered
held slots at destination AFTER arrival: 1
recipient row: status = deleted , deletedAt set = true
notifications written to the deleted account: 1 [ 'received_arrived' ]
```

`releaseCapacityOnce` is called only on open, cancel or loss (`journey.ts:96`, `bottles.ts:324`,
`outcomes.ts:99`) and there is **no sweeper** (grep confirms). A delivered bottle addressed to a deleted
account can never be opened, so the reservation is held **forever**. With
`MIB_DEFAULT_SHORE_CAPACITY=5`, five such deletions permanently close a shore for everyone who would
route to it. The letter text is also retained and a notification row is written to an account the
Privacy Policy says is gone.

**Why nothing catches it:** `journey.test.ts:172` covers the _block_-during-transit case only;
`deletion.test.ts` and `legal.test.ts:217` assert only the sender-side cancellation.
**Remediation:** cancel or redirect inbound in-flight bottles on deletion, **and** re-check
`recipient.status === 'active'` inside `commitArrival` next to the existing block check.
**Verify:** deleting a recipient mid-journey frees the slot, writes no notification to the deleted
account, and reports the inbound cancellations.

### QA-003 — 9,300 lines of UI, zero rendering tests

**P1 · confirmed · UI backlog · large**

`apps/web/src` is 15 screens and 20 components (`ShoreScene.tsx` 1054, `OceanScreen.tsx` 943,
`OceanMap.tsx` 929, `AdminScreen.tsx` 612, `LoginScreen.tsx` 521, `WriteScreen.tsx` 418,
`LettersScreen.tsx` 398, `App.tsx` 377, `DecisionNotice.tsx` 209, `PolicyConsent.tsx` 98, …). All 45 web
tests target pure helpers or grep source text. `apps/web/vite.config.ts` declares **no `test` block**, so
vitest defaults to the `node` environment — confirmed by running a web test and observing
`environment 0ms`. No jsdom, no Testing Library, no axe, no Playwright.

Consequently untested: draft recovery across reload and per-user draft isolation; the `DecisionNotice`
appeal flow — the product's most legally sensitive screen, whose API side is excellently covered and
whose UI is not; `PolicyConsent`; `DeleteAccountDialog`; `ReportSheet`; the Lost folder filtering;
Readable Print and font selection; aging presentation; reduced-motion behaviour (`styles.css` has six
`prefers-reduced-motion` blocks and `lib/format.ts:44` reads `matchMedia` — none tested); keyboard and
focus behaviour beyond the `nextTabTarget` arithmetic; every accessibility criterion; and
offline/slow-network/refresh handling.

**Remediation:** add jsdom + Testing Library and cover the five highest-consequence screens; add a small
Playwright smoke path. This is the largest single piece of work the audit recommends and it is scheduled
_after_ the P0s, not as a gate on them.

### QA-006 — Every release rebuilds the 173,000-element sea graph inside its write transaction

**P1 · confirmed (measured) · code defect · medium**

`services/chart.ts:12` caches graphs in a `WeakMap` **keyed on the db handle**; `release.ts:187` opens
`ctx.db.transaction((tx) => …)` and `release.ts:212` calls `checkEligibility(ctx, tx, …)` →
`loadActiveGraph(tx)` at `release.ts:97`. Drizzle hands a **new tx object per transaction**, so the cache
misses every single time.

```
same-db graph cached: true
tx graph reused across transactions: false | tx graph === db graph: false
one in-transaction loadActiveGraph: 292 ms
sea graph: nodes=35971 edges=137134
```

Live, production mode, on-disk SQLite:

```
preview (first call, cached on ctx.db):  200  0.283 s
release1 201 0.793 s | release2 201 0.697 s | release3 201 0.598 s
replay same key (no graph load):         200  0.005 s
5 concurrent releases: 0.41 / 0.85 / 1.23 / 1.64 / 2.05 s — total wall 2.06 s
```

Perfectly linear queueing: the rebuild happens while holding a SQLite **write** transaction, which
serializes all writers. Effective ceiling ≈ **2.4 releases per second for the whole service**, with p100
already at 2 s at five concurrent users. The 5 ms replay isolates the cost precisely.

Same root cause explains the suite's shape: `createTestWorld()` = ~400 ms (`seedChart` 337 ms inserting
35,971 nodes and 137,134 edges), `hashPassword`/`verifyPassword` = 39 ms each, `releaseBottle` = ~300 ms.
There are 87 static `createTestWorld()` sites and 71 static `releaseBottle` sites, with the three
report-budget tests alone performing ~32 releases in loops. At 83 s wall clock the suite is tolerable
today, but it scales with the number of tests rather than with what they assert.

**Remediation:** key the graph cache on the underlying `better-sqlite3` handle rather than the tx proxy,
or resolve the route **before** opening the transaction — this alone should cut release latency roughly
50× and API test CPU substantially. Separately, let the harness build the world graph once per worker.
**Verify:** release p50 well under 50 ms; 20 concurrent releases without linear queueing.

### QA-007 — Nothing entering the web app is validated at runtime

**P1 · confirmed · code defect · medium**

`apps/web/src/api/client.ts:98` — `return json as T;` — every success body is cast, never parsed.
`WriteScreen.tsx:37-49` — `JSON.parse(raw) as Draft` — the try/catch handles invalid JSON but not valid
JSON of the wrong shape. `packages/shared/src/api.ts` ships **91** zod schemas and **none** is used at
the web boundary. `api/client.test.ts` tests malformed _error_ bodies thoroughly (6 tests) but never a
malformed _success_ body.

A version-skewed API, a proxy that rewrites a body, or a tampered `sessionStorage` draft produces an
unhandled render-time exception rather than a recoverable error state — and with no error boundary
(FE-001) that is a white screen. **Remediation:** parse responses and the stored draft with the shared
schemas at the boundary; add negative tests.

### QA-008 — Source-grep tests certify privacy promises they cannot enforce

**P1 · confirmed · code defect (test) · medium**

`apps/web/src/storage.test.ts:85-93` asserts
`expect(session).toMatch(/sessionStorage\.removeItem\(key\)/)` against
`state/session.tsx:15,101-107`:

```js
const PER_USER_KEYS = ['mib.draft'];
...
for (const key of PER_USER_KEYS) { try { sessionStorage.removeItem(key); } catch {} }
```

Change line 15 to `const PER_USER_KEYS = [];` and the whole suite stays green: the `removeItem(key)`
regex still matches, `keysFor()` resolves to `[]` so `expect(resolved).toBeDefined()` still passes, and
the allowed-key assertion at `:67` still passes because the key is still _written_ by `WriteScreen`.
**User A's unsent letter then survives into user B's session on a shared device** — exactly the promise
the Privacy Policy makes and that `storage.test.ts:107` claims to assert.

Same class at `storage.test.ts:95-98` (one grep for `removeItem(DRAFT_KEY)`, which passes if the call
sits in an unreachable branch), at `legal.test.ts:89-109` (`expect(read(file)).toContain('SupportLink')`
— an unused import passes), and at `legal.test.ts:120-130` (asserts exact JSX source strings, proving the
file's text rather than that consent is rendered or enforced).

**This is the mechanism by which SEC-015/FE-010 went undetected**: the time-zone clean-up lives in an
unreachable `else` branch, and the guarding test greps for exactly that unreachable line.
**Remediation:** keep the greps as a cheap backstop but move the promises to behavioural tests once a
DOM environment exists (QA-003). **Verify:** emptying `PER_USER_KEYS` must fail the suite.

### QA-009 — `grant-role.test.ts` shares one mutable database across tests; order-dependent

**P2 · confirmed (reproduced) · code defect (test) · small**

`apps/api/src/tools/grant-role.test.ts:38-63` opens one SQLite file in `beforeAll` and every test mutates
it; `:119` comments _"sam is an admin at this point"_ and `:131-135` assumes rosa is admin from `:76-88`.

```
$ npx vitest run src/tools/grant-role.test.ts -t "is a no-op when the account already holds the role"
AssertionError: expected … to match /already has the admin role/
Received: "… role  member\n\nThe admin role was granted to rosa … by cli:root@vm."
 Test Files  1 failed (1) | Tests 1 failed | 6 skipped (7)   Duration 2.12s
```

Vitest runs a file's tests in declaration order, so the full run always passes. No test in this file can
be run, bisected or retried alone, and enabling `sequence.shuffle` or per-test isolation breaks the
build. **Remediation:** a fresh temp DB per test, or explicit setup inside each test.
**Verify:** each test passes alone with `-t` and under `--sequence.shuffle`.

### QA-010 — "user-facing responses never contain coordinates" passes because of what it omits

**P2 · confirmed · code defect (test) · small**

`apps/api/src/http/app.test.ts:388-396` checks exactly `/api/auth/me`, `/api/friends` and
`/api/notifications`:

```
/api/auth/me           matches /lat|lng|…/i ? false   <- the three the test checks
/api/friends           matches /lat|lng|…/i ? false
/api/notifications     matches /lat|lng|…/i ? false
/api/chart             matches /lat|lng|…/i ? true    <- NOT checked
/api/bottles/sent/:id  matches /lat|lng|…/i ? true    <- NOT checked
```

The stated property is **false for the product**: `/api/chart` returns `geo:{lng,lat}` per shore — the
test nine lines above at `:379` asserts `expect(s.geo).not.toBeNull()` — and `/api/bottles/sent/:id`
returns `route.geoPoints`. The test name certifies a guarantee that does not exist. The regex is also
over-broad: `"try again later"`, `"violation"` and `"translation"` all match, so one future notification
message turns it red. **Remediation:** rename it to what it proves, or replace it with a closed key-set
assertion per endpoint — the pattern already used well at `outcomes.test.ts:150-161`.

### QA-011 — The risk suite is seeded by random UUIDs; the five-decision-cap assertion is skipped in ~1 run in 18

**P2 · confirmed (simulated) · code defect (test) · medium**

`lib/ids.ts:3-5` makes `newId` a `randomUUID()`, and storm schedules are
`hashSeed(version,'risk',bottleId,nightKey)` (`shared/weather.ts:304`), so **every CI run exercises a
different storm schedule**. `services/risk.test.ts:176-194`:

```js
expect(eligible.length).toBeLessThanOrEqual(RISK_POLICY.maxRiskDecisions);  // trivially true at 0..5
if (eligible.length === RISK_POLICY.maxRiskDecisions) { … }                 // <- conditional
if (getSentBottle(...).state === 'at_sea') { expect(Array.isArray(...)) }   // <- near-tautology
```

Simulating the test's exact configuration (65-day journey, 40 nights) over 20,000 random ids:

```
eligible=1: 1.0%  =2: 1.1%  =3: 1.3%  =4: 2.1%  =5: 94.5%
journeys that lose the bottle: 4.74%  (then the cap branch is skipped)
=> 5.5% of runs produce no evidence for the cap and report green
```

The sibling test at `:197-215` is weaker still: its loop is vacuous on an empty array, and the late
decisions it does inspect are ineligible **because the five-cap was already spent**, not because of the
80% cutoff — so it cannot distinguish the two rules it is named for.

**Mitigating and important:** both rules _are_ properly pinned at the unit level
(`shared/risk.test.ts:134-138`), so this weakens the integration layer rather than leaving the
requirement uncovered. **Remediation:** pin the bottle id (or inject an id factory) and assert the cap
and the cutoff separately with ids chosen to hit each. **Verify:** mutating `maxRiskDecisions` to 6 must
fail the test on every run.

### QA-012 — Role separation is asserted against hand-maintained, incomplete route lists

**P2 · confirmed · code defect (test) · small**

`http/roles.test.ts:20-32` lists 5 of 11 admin routes and 4 of 7 dev routes. Missing:
`GET /api/admin/reports/:id`, `…/reject`, `…/hold/release`, `GET /api/admin/appeals/:id`, `…/accept`,
`…/reject`; `GET /api/dev/outbox`, `POST /api/dev/arrive`, `POST /api/dev/lose`.

Every omitted route was probed and **all currently enforce correctly** (403), because `adminRoutes()`
uses `r.use('*', requireAuth, requireAdmin)` at `routes/admin.ts:32`. So this is a **regression risk, not
a live hole** — except that `/api/dev/outbox` is already the exception that proves it (QA-002): a route
registered outside the router-level `use` is invisible to this test.
**Remediation:** enumerate routes from the Hono router at test time rather than by hand.

### QA-014 — Nine HTTP routes have service coverage but no route-level test

**P2 · confirmed · code defect (missing test) · small**

`POST /api/friends/blocks`, `POST /api/notifications/read-all`, `GET /api/ocean/reading`,
`POST /api/ocean/public/:id/close`, `GET /api/shore/received`, `GET /api/shore/bottles/:id/letter`,
`POST /api/bottles/sent/:id/acknowledge`, `POST /api/moderation/violations/:id/acknowledge` — all have
well-tested service functions but no test through the HTTP surface, so their middleware stack, validation
and status codes are unverified. `POST /api/dev/arrive` has **no coverage at any level** (its logic is
inline in `routes/dev.ts:72-86` rather than in a service).

### QA-015 — `oceanWeather.test.ts` zone loop asserts nothing about zones

**P2 · confirmed · code defect (test) · small**

`apps/web/src/lib/oceanWeather.test.ts:26-41`, named _"draws exactly the server window, with no second
clock gating it here"_:

```js
for (const zone of ['Asia/Tokyo', 'America/Los_Angeles', 'Europe/Berlin', 'UTC']) {
  expect(bottleWeatherAt(b, T)).toBe('storm'); // identical call every iteration
  void phaseAt(T, zone); // result discarded
}
```

`bottleWeatherAt(bottle, atMs, options)` takes **no time zone at all**, so the loop is four copies of one
assertion and cannot fail if the property were violated. The only remaining assertion (at least one of
four zones is in daylight at `T`) is a property of `Intl`, not of the app. Same file: `:79`
`expect(oceanish).not.toEqual(shoreish)` and `:91` `expect(SHORE_SCHEDULE.windowMs).not.toBe(OCEAN_SCHEDULE.windowMs)`
are both tautologies. **Remediation:** delete the loop — the property is enforced by the type signature.

### QA-016 — Distance-based travel time is never asserted

**P2 · confirmed · code defect (missing test) · small**

`journeyDurationMs(totalLength, msPerChartUnit, minJourneyMs)` (`domain/routing.ts`, used at
`release.ts:107`) has **no** test. Every test reads `plannedDurationMs` back from the row and uses it as
a reference point. Nothing asserts that a longer route takes longer, that `msPerChartUnit` scales it, or
that `minJourneyMs` floors it — yet `MIB_MS_PER_CHART_UNIT` and `MIB_MIN_JOURNEY_MS` are the two knobs an
operator will tune first, and a mis-set knob is invisible until users complain.
**Remediation:** a three-line unit test on the pure function plus one integration assertion
(Tokyo↔Yokohama shorter than Southampton↔Yokohama).

### QA-017 — Friends flows are thinly covered

**P2 · confirmed · code defect (missing test) · small**

`http/friends.test.ts` is **one test**. Untested: the mutual-approval shortcut (`friends.ts:111-119` — if
B requests A while A's request is pending they become friends instantly, with no notification);
`self_request` 400 (`:101`); `already_friends` 409 (`:110`); `request_pending` 409 (`:120`); and the whole
`POST /api/friends/blocks` **route** — every block test calls the `blockUser` _service_ directly. There is
also **no unblock capability anywhere in the API**, which is a product gap rather than a test gap
(= FE-016 / ARCH-028).

### QA-021 — Migration coverage exercises 3 of 15 historical cut points

**P2 · confirmed · code defect (missing test) · medium**

Covered: pre-`auth_credentials` (`auth.test.ts:361`), pre-`0008` with a populated active journey
(`migration.test.ts`), the renumbered `0010→0012` policy migration in **both LF and CRLF** renderings
(`compat.test.ts`, 15 tests — genuinely excellent), and the additive `graph v1→v2` upgrade with an at-sea
journey (`geo.test.ts:72`). Not covered: populated upgrades across `0001`–`0007`, and any partial or
interrupted migration (`assertSchemaComplete` runs only _after_ a successful `migrate()`).
**Mitigating:** the app has never been deployed, so in practice only the developer-database shape exists.
Not a release gate — but "every historical shape is covered" should not be claimed either.

### QA-024 / QA-022 / QA-023 — Recovery paths with no coverage at any level

**P2 · needs verification (behaviour unknown because untested) · deployment-configuration + code defect · medium**

| Scenario                                                                 | Status                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database lock / `SQLITE_BUSY` (`busy_timeout = 5000`, `db/client.ts:19`) | no test. Five concurrent releases serialized cleanly with no 5xx, so the happy path holds at 5-way concurrency; the timeout path is unexercised                                                                                                       |
| Duplicate worker execution (two API processes)                           | no test **and no guard**: `server.ts:48,62,77` start three `setInterval` workers in-process; a second instance double-runs journey, AI and retention ticks. The AI worker's only reentrancy guard is a process-local `let reviewing` (`server.ts:61`) |
| Rate limits across processes                                             | `lib/rate-limit.ts:15` is an in-process `Map`; two instances double every budget. The file's own comment concedes "the deployment shape of this stage (one API process)"                                                                              |
| Server restart                                                           | only an object-spread simulation (`risk.test.ts:123` — same in-memory DB, same cache), which is not a restart                                                                                                                                         |
| AI **timeout** as distinct from connection refusal                       | `config.ai.timeoutMs` has no test; only `ECONNREFUSED` is covered                                                                                                                                                                                     |
| Per-address report/appeal budgets (`routes/moderation.ts:23-24`)         | no test (per-_account_ budgets are well covered)                                                                                                                                                                                                      |
| Release to a deleted or suspended recipient (`release.ts:85-86`)         | no test                                                                                                                                                                                                                                               |
| Sender blocks recipient _after_ release                                  | `commitArrival` checks only recipient→sender; asymmetric with release's `isBlockedEitherWay`. Untested                                                                                                                                                |
| Browser refresh, offline→online, slow network, expired session in the UI | no UI tests at all (QA-003)                                                                                                                                                                                                                           |
| Partial migration failure                                                | no test                                                                                                                                                                                                                                               |
| International date line / extreme UTC offsets                            | zones used across the repo span only +9 to −8; no UTC+13/+14 or −11/−12 account zone. _(Antimeridian **routing** is covered — `geo.test.ts:235`.)_                                                                                                    |
| Concurrent administrative actions (two admins deciding one case)         | idempotent in sequence; no concurrent test                                                                                                                                                                                                            |

**Adequate in this category — do not spend budget here:** unauthorized roles ✅; invalid IDs ✅; blocked
pairs ✅; expired sessions ✅ (`auth.test.ts:320-336`); replayed requests ✅ (`release.test.ts:154-191`);
full shore capacity ✅ (`release.test.ts:86` **and confirmed live**); registration/login rate-limit
exhaustion ✅ (`auth.test.ts:289-317`); journey-clock time jumps ✅; DST ✅; empty/max-length/unicode/RTL/
emoji letters ✅.

### QA-013 — `compat.test.ts` never cleans up its temporary directories

**P3 · confirmed · code defect (test) · small**

`apps/api/src/db/compat.test.ts:59` calls `fs.mkdtempSync(…'mib-historic-')`;
`grep -n rmSync apps/api/src/db/compat.test.ts` → **no match**. Observed: 203 leaked directories
(~60 KB each), plus 12 `mib-legacy*` and 2 `mib-broken-*`; ~17 new directories per suite run. Ephemeral
CI runners are unaffected; long-lived developer machines and self-hosted runners accumulate.
Milder relatives: `auth.test.ts:441` and `migration.test.ts:173` call `rmSync` as the last statement of
the test body, so they leak whenever an assertion fails. **Remediation:** `afterAll` / `try…finally`.

### QA-019 — Two test names promise multi-reporter case merging that no test performs

**P3 · confirmed · documentation mismatch · small**

`moderation.test.ts:156-178` is titled _"…two reports of one letter make one"_ and its own comment
concedes the scenario is unreachable — _"A second finder-style report of `b` cannot exist (only one
finder)"_ — ending on `expect(getCase(...).reportCount).toBe(1)`. `appeals.test.ts:501-533`, titled
_"produces at most one violation from several reports about one letter"_, uses the **same** reporter
twice. Because a letter is only ever held by one recipient **or** one finder, two distinct reporters may
be structurally impossible — which would make the merge branch, `reportCount`, and retention's "clears
the **reporters'** explanations" describe a state the model cannot reach.
**Remediation:** decide whether multi-reporter is reachable; if not, retire the branch and rename the
tests; if yes, write the real test.

### QA-025 — Documentation debt

**P3 · confirmed · documentation mismatch · small**

- `docs/Message_in_a_Bottle_Product_Specification_v0.2.md` **is not in the repo** at this commit
  (`git ls-files docs/` lists 5 files and it is not among them) — yet
  `packages/shared/src/bottle-state.ts:1` says _"Journey state per spec v0.2 §11"_ and
  `packages/shared/src/letter.test.ts:33` is titled _"follows the v0.2 transitions"_. These cite a
  document nobody can read. _(The brief names this document as historical and outdated; it was not
  treated as an acceptance specification, and the current `docs/SeaYou_Product_Specification.md` was used
  instead.)_
- The **current** spec still carries v0.2 language: §18 acceptance criteria #11–#14 test "rescue",
  "discard" and "the chosen subsequent fate", and #17 mentions the "keep/re-release prompt" — all removed
  from the product. Meanwhile `bottle-state.ts:24` still permits `stranded_public → at_sea` ("rescued")
  and `letter.test.ts:38` **asserts that transition as a requirement**, though no production code performs
  it. `LOSS_REASONS` still declares `destroyed`, which `bottle-state.ts:44` concedes "is not produced by
  any code path yet".
- ~40 `spec §N` references across code and test names do resolve correctly against the current
  specification — those are fine.

**Remediation:** retire the v0.2 citations, reconcile §18 with the shipped product, and either implement
or delete the dead states.

### QA-026 — Minor quality notes

**P3 · all confirmed · small**

- `moderation.test.ts:565` `let n = 0` is a describe-scoped counter shared by four tests; harmless today
  (fresh world per test) but makes the file order-sensitive in key space.
- `risk.test.ts:181-259` rewires primary keys with `PRAGMA foreign_keys = OFF`, carries a bespoke
  30,000 ms timeout and a 5,000-iteration search loop — a heavy, fragile device for forcing a 1% outcome.
- `risk.test.ts:123-124` simulates a restart with `const restarted: AppContext = { ...w.ctx }` — the same
  in-memory DB and the same cache. It does not exercise a real process restart.
- `shared/policies.test.ts` (17 tests) and `http/support.test.ts` assert exact published copy. This is a
  deliberate product decision and is **not** reported as a defect, but it is the suite's main ongoing
  maintenance cost and the reason legal edits ripple into test changes.

## Recommended test pyramid and release smoke suite

Specification only — nothing below was implemented.

| Layer                                      | Target                       | Today                       | Direction                                                                                                                                                                          |
| ------------------------------------------ | ---------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit — pure domain**                     | ~55% of tests, layer < 5s    | 57 tests, ~1s               | Grow: `journeyDurationMs` (QA-016), `loadConfig()` defaults (QA-002), `deriveAgingProfile`, `fonts.ts`, rate-limit window arithmetic. ~1 ms each — the cheapest coverage available |
| **Service / integration**                  | ~30%, layer < 30s            | 242 tests, 221s CPU         | Shrink and speed up: one shared world per `describe` with per-test rollback; a pre-seeded world graph per worker (QA-006)                                                          |
| **HTTP contract — one per route**          | ~10%, < 10s                  | 9 routes have none (QA-014) | One status/shape/auth assertion per route, **generated from the Hono router** so a new route cannot be forgotten (also fixes QA-012)                                               |
| **UI component — jsdom + Testing Library** | ~5%, < 20s                   | **0**                       | New layer: `DecisionNotice`, `PolicyConsent`, `WriteScreen` draft recovery, `DeleteAccountDialog`, Lost folder, `ReportSheet`, focus trap in a real DOM, reduced motion            |
| **E2E — Playwright**                       | 6–10 specs, < 3 min          | **0**                       | Register→consent→befriend→write→release→arrive→open; report→decision→notice→appeal; sign-out clearing on a shared device; public legal/support pages with JS disabled              |
| **Accessibility**                          | axe on every rendered screen | **0**                       | Fold into the component layer; keyboard-only traversal in two E2E specs                                                                                                            |
| **Performance**                            | 2–3 assertions               | **0**                       | Guard release latency and a concurrency ceiling so QA-006 cannot regress                                                                                                           |

Two cross-cutting rules: **no test seeded by `randomUUID`** where the assertion depends on the seed
(QA-011), and **no assertion on source text** where behaviour is testable (QA-008, QA-010).

### Release smoke suite — target ≤ 4 minutes, against a real built artefact before every deploy

_Boot and configuration (~20s)_

1. Migrate a fresh database; assert exit 0 and the expected migration count.
2. Migrate a **restored copy of the production database**; assert exit 0 and unchanged row counts for
   `users`, `bottles`, `letters`, `policy_acceptances`.
3. Start with the real production environment; assert the log line reads `devMode=false` and `mail=smtp`.
4. `GET /api/health` → 200 with `serverTime` and no `devMode`/`mail` keys in the body.
5. `GET /api/dev/outbox`, `/api/dev/status`, `/api/dev/tick` → **404** each. _(Guards QA-002.)_
6. Sign in as a seeded dev username with the published dev password → **401**. _(Guards QA-002.)_

_Public surface, no account (~15s)_ 7. `/legal`, all four documents, `/legal/delete-account`, `/support` → 200; `/support` contains no
`<script>`; every legal page links to `/support`. 8. The web bundle is served and its entry `<script>` resolves — this needs an explicit static host and
reverse-proxy check, because **the API does not serve `apps/web/dist`** (verified). _(Guards ARCH-006.)_

_Core correspondence (~60s)_ 9. Register two accounts with full policy acceptance → 201, three acceptance rows each. 10. Friend request → accept → both see one friend. 11. Set a shore for each; release a letter → 201; **assert latency < 1 s**. _(Guards QA-006.)_ 12. Replay the same idempotency key → one bottle, one reservation. 13. Fill the destination shore to capacity → next release 422 `shore_full`; assert held reservations
equal capacity exactly. 14. Force arrival; recipient opens; assert the slot is freed and the text is byte-identical.

_Safety and legal (~45s)_ 15. Recipient reports the letter → case opens, letter hidden for the reporter only. 16. Admin accepts → one violation, sender warned once, reporter never named anywhere in the sender's view. 17. Sender fetches standing → decision notice pending; reload; still pending. _(Guards the approved
"closing resolves nothing" rule.)_ 18. Sender appeals → 201; a second appeal → 409. 19. A non-admin hits three admin routes and three dev routes → 403 each.

_Recovery and privacy (~40s)_ 20. `POST /api/auth/password/forgot` for a **known** and an **unknown** address with the mail transport
unreachable → **both 202**. _(Guards QA-004.)_ 21. Delete an account from `/legal/delete-account`; assert sessions ended, in-flight letters cancelled,
slots freed, and — once fixed — that no inbound bottle can still arrive. _(Guards QA-005, SEC-002.)_ 22. Sign out in a browser; assert `sessionStorage` holds neither `mib.session.token` nor `mib.draft`, and
`localStorage` holds no time zone. _(Guards QA-008, SEC-015.)_

_Load guard (~20s)_ 23. 20 concurrent releases; assert no 5xx, capacity is not over-committed, and p95 latency is within an
agreed budget. _(Guards QA-006, QA-024.)_

Steps 1–8 and 20–23 are worth automating first: they are cheap, they need no UI harness, and they cover
the P0 configuration failure and two of the four P1 defects.

## Coverage that is genuinely adequate

Stated plainly so remediation budget is not spent here:

- **Risk policy and storm statistics.** `shared/risk.test.ts` pins the 80% cutoff at `0.79`/`0.80`, the
  five-decision cap at `4`/`5`, arrival-wins, and the adrift/sunk branch, then validates distributions
  over 800,000 deterministic samples. Not flaky.
- **Journey outcomes and races.** `outcomes.test.ts` covers loss→arrival and arrival→loss, position and
  marker immutability under retries, clock jumps, slot release exactly once, and the public projection
  with a closed key-set assertion — the strongest test in the repository.
- **Moderation, appeals and retention.** 60 tests. The single-appeal rule, the waiver's explicitness and
  idempotency, reload-resolves-nothing, permanence of upheld violations, reporter anonymity, seven-day
  retention from every finality path, legal and child-safety holds, and critical child-safety bans are all
  covered by tests that would fail if the behaviour changed.
- **AI review.** Offline with exponential backoff, malformed output → `uncertain` → human, code-fenced
  JSON, mixed answers read conservatively, the letter fenced as data with no ids or names, `autoDecide`
  off by default, `uncertain` never auto-decided.
- **Policies and legal documents.** 42 tests across `shared/policies`, `http/policies`, `legal` and
  `support` assert the published documents match implemented behaviour — genuinely valuable drift
  protection that most codebases lack, and the reason this audit could compare policy text to behaviour at
  all.
- **Migration compatibility.** `compat.test.ts` reconstructs the historical migration file in both LF and
  CRLF renderings, derives both drizzle hashes from the file itself, refuses a wrong-schema table, is
  idempotent, and boots the API afterwards. Excellent work.
- **Authentication and the clock split.** Session TTL on real time while the journey clock jumps 100×,
  reset-token lifetime in real time, per-account login lockout, per-address registration limit, password
  never echoed, identical answers for a wrong password and an unknown user.
- **Geography.** Additive graph upgrade preserving at-sea plans, every supported coastal country
  reachable, no inland or lake nodes, islands never through-passages, antimeridian crossings routed the
  short way.

## Limitations

1. **No browser was exercised.** The repository has no Playwright/Puppeteer/Cypress/Testing-Library/jsdom/
   axe dependency (checked all four `package.json` files and `pnpm-lock.yaml`) and the audit rules forbade
   adding one, so every UI claim here is from source reading. _(The frontend agent worked around this
   separately; see report 01.)_
2. **The full suite was run once**, by the lead. Flakiness across runs was not sampled; where
   nondeterminism mattered (QA-011) the pure functions were simulated 20,000 times instead.
3. **Targeted vitest use was budgeted to one run**, spent on `grant-role.test.ts` (QA-009), which produced
   a decisive failure.
4. **Timings are from this container** (Node 22.22.2, VM shared with a sibling auditor's dev server on a
   separate port and a separate database). Absolute numbers will differ on CI; the ratios and the linear
   queueing shape are the durable findings.
5. **The concurrency probe reached 5 simultaneous requests**, not a load test. QA-006's 2.4 releases per
   second is extrapolated from a clean linear trend, not a measured saturation point.
6. **QA-022 (duplicate worker execution) is `needs verification`** — it was established that nothing
   guards or tests it, not that it misbehaves; proving that needs two processes against one database file.
7. Bundle size, dependency security and the map/3D rendering code were audited by the other agents.

## Lead adjudication

- **QA-001 lowered P0 → P1, and the reasoning is stated rather than buried.** The specialist rated the
  absence of CI as P0. The lead disagrees on the definition, not on the importance: the brief's P0 bar is
  "an exploitable authorization failure, sensitive-data exposure, destructive corruption, unrecoverable
  data loss, or something that prevents deployment". No CI prevents none of those — the product builds,
  migrates and runs without it, as the controlled execution above demonstrates. It is a serious
  process weakness that makes every other fix in this audit unenforceable, which is squarely P1. It
  remains in the first remediation batch precisely because it protects the P0 fixes.
- **QA-002 merged into DEPLOY-001 and kept at P0** — the canonical record of the finding is in report 03
  (SEC-001), where the takeover chain was demonstrated end to end. Counted once in the executive summary.
- **QA-004 raised to P1** over Agent 2's P2 (ARCH-008): it is simultaneously a broken account-recovery
  flow that leaves the user worse off than before they asked, and an enumeration oracle that defeats a
  property the code explicitly claims. Either alone is arguable at P2; together they are P1.
- **QA-005 = ARCH-014, P1** — both agents reached P1 independently; no adjudication needed.
- **QA-008 kept at P1.** A test that certifies a privacy promise it cannot enforce is not ordinary test
  debt here: it is the specific mechanism by which SEC-015/FE-010 shipped undetected, and the same pattern
  guards three more published promises.
- **QA-006 kept at P1** despite being invisible to current users: 2.4 releases per second is a ceiling the
  product would hit at very modest scale, and it is caused by a cache-key defect, not by an architectural
  limit — a small fix with a large effect.
- No other severity was changed. **No finding was downgraded to make the project appear ready.**
