# Remediation plan

Audited commit `5ba32c2`. Ordered by dependency and risk, not by severity alone: a fix that another fix
depends on comes first even when it is smaller, and a fix that is unverifiable until CI exists is
scheduled after CI.

**Nothing in this plan was implemented.** This audit changed no application source, added no migration,
altered no data, granted no role and deployed nothing. Sizes are engineering estimates for the SeaYou
codebase as it stands, not commitments.

Legend: **S** ≤ half a day · **M** ≤ two days · **L** more than two days or needing a product decision
first.

---

## Batch 1 — Make it deployable and safe by default

**Findings:** DEPLOY-001 (ARCH-001 = SEC-001 = QA-002, P0) · ARCH-006 (P0) · QA-001 (P1) ·
SEC-003 (P2) · ARCH-018 = SEC-005 (P2) · ARCH-016 (P2) · ARCH-017 (P2) · SEC-014 (P2) · ARCH-027 (P3)

**Why these together, and why first.** Every other batch is unverifiable without them. There is currently
no artefact to deploy and no pipeline to prove a fix works, and the default configuration is unsafe — so
any fix shipped before this batch would be shipped blind, onto a host that does not exist, into a
configuration that leaks reset links. Everything here is deployment plumbing and configuration: no schema
change, no product decision, no behaviour change for a correctly configured instance. It is also the
batch that protects all the others, because after it a regression is caught by CI instead of by a user.

**Work.**

1. **Invert the dev-mode default** (`apps/api/src/config.ts:101`): require explicit opt-in, and refuse to
   start when `NODE_ENV === 'production'` and dev mode is on. Consider a second explicit flag for
   `seedUsers` so seeding can never follow from one variable. Add the first-ever test of `loadConfig()`'s
   defaults. **S**
2. **Put `GET /api/dev/outbox` behind the router's auth middleware** (`routes/dev.ts:36` currently
   registers before `:51`), or bind it to loopback / require a locally-printed token if the signed-out use
   case must survive. **S**
3. **Produce a real artefact.** Replace `tsc --noEmit` in `apps/api` with an actual build (bundle or emit),
   move `tsx` out of the runtime path, and verify `pnpm install --prod` yields a tree that starts.
   Add a container image or an equivalent reproducible start. **M**
4. **Write the deployment contract** — the 16 requirements in report 02 are the specification. At minimum:
   absolute `MIB_DATABASE_PATH` on a persistent volume outside the application directory; exactly one API
   process (`replicas: 1`, recreate-not-rolling); reverse proxy terminating HTTPS, serving
   `apps/web/dist` at `/` and proxying `/api`, `/legal`, `/support` **same-origin**; API bound to
   `127.0.0.1`; a request body size limit; security headers including `frame-ancestors` and `form-action`
   for the public deletion form; `MIB_APP_URL` equal to the public origin; a `VACUUM INTO` /
   `sqlite3 .backup` backup with a **tested restore drill**. **M**
5. **Fix the `X-Forwarded-For` parse** (three identical copies at `routes/auth.ts:47`,
   `routes/moderation.ts:36`, `routes/legal.ts:69`): take the right-most entry minus a configured trusted
   hop count, factor into one helper, and document the required proxy behaviour. Do this in the same batch
   as the proxy, because the proxy is what makes the current code exploitable. **S**
6. **Graceful shutdown and a real health check**: close the HTTP server and the database on `SIGTERM`
   (ARCH-016); make `/api/health` touch the database so a load balancer learns something (ARCH-017). **S**
7. **CI**: format → lint → typecheck → test → build on every pull request and on the release branch. Drop
   `--passWithNoTests` from `apps/web` or pin a minimum test count. **S**

**Expected files.** `apps/api/src/config.ts`, `apps/api/src/http/routes/dev.ts`,
`apps/api/src/http/routes/{auth,moderation,legal}.ts` (+ a new shared client-IP helper),
`apps/api/src/server.ts`, `apps/api/src/http/app.ts`, `apps/api/package.json`, a new
`apps/api/src/config.test.ts`, `.github/workflows/*`, `README.md`, `.env.example`, `docs/ARCHITECTURE.md`,
plus new deployment files (Dockerfile / compose / proxy config).

**Migration and data risk.** None. No schema change, no data change. The one operational risk is
procedural: after inverting the default, an existing developer whose `.env` omits `MIB_DEV_MODE` loses dev
mode — call that out in the README rather than softening the default.

**Verification.** Start with an empty environment and assert `/api/dev/*` all 404, that signing in as a
seeded username with the README password is 401, that `db:reset` refuses, and that the mail provider
resolves to `disabled`. `pnpm install --prod` then start the artefact and complete the core flow.
Restore a backup into a scratch location and boot against it. Rotating `X-Forwarded-For` must no longer
reset the rate-limit budget. A deliberately broken test must block a merge.

**Product decision required?** No.

---

## Batch 2 — Stop the published-policy falsehoods and the data that cannot be erased

**Findings:** ARCH-002 = SEC-002 (P1) · SEC-012 (P1) · ARCH-003 (P1) · ARCH-014 = QA-005 (P1) ·
FE-010 = SEC-015 (P2) · ARCH-025 (P3) · SEC-016 (P3)

**Why these together.** All five are the same failure in different places: **something that the published
legal documents promise is erased, is not erased.** They share a root shape (a state or a finality
condition that no code path ever reaches) and they share a verification harness — a deletion test that
follows the data all the way out. Fixing them separately means writing that harness four times. They are
second because each is a real defect whose fix must be provable, and Batch 1 is what makes proof possible.

**Work.**

1. **ARCH-002/SEC-002** — `services/deletion.ts:62` sweeps `['at_sea','stranded_public','public_expired']`
   but an adrift bottle is `state='lost'` with `lossReason='adrift'`; the latter two states are **never
   written**. Sweep the states the code actually produces, and delete the dead states from
   `packages/shared/src/bottle-state.ts` (ARCH-025) so the same mistake cannot recur. **S**
2. **SEC-012** — treat account deletion as resolving the appeal opportunity: stamp `appealWaivedAt` (or an
   equivalent finality marker) at deletion with an audit row recording why, so `retention.ts` stops
   returning `notice_unresolved` forever. Consider an absolute cap on `notice_unresolved` for living but
   absent senders; if a cap is adopted, Privacy Policy §3 must say so. **S–M**
3. **ARCH-003** — a crash mid-AI-review leaves the case claimed forever and blocks retention. Add a claim
   timeout or a reaper so a stale claim is released. **S**
4. **ARCH-014/QA-005** — cancel or redirect inbound in-flight bottles on deletion, **and** re-check
   `recipient.status === 'active'` inside `commitArrival` alongside the block check that is already there.
   Free the shore slot; write no notification to a deleted account. **M**
5. **FE-010/SEC-015** — call `storeZone(null)` on sign-out (`apps/web/src/state/weather.tsx:63,91`); the
   `else` branch that does the work already exists and is simply unreachable. **S**
6. **SEC-016** — add `Cache-Control: no-store` to the authenticated letter and evidence responses, matching
   what `routes/ocean.ts:29,34` already does correctly for the finder's reading. **S**

**Expected files.** `apps/api/src/services/{deletion,retention,journey,moderation}.ts`,
`apps/api/src/services/ai-review.ts` or `server.ts` (claim reaper),
`apps/api/src/http/routes/{shore,bottles,admin}.ts`, `packages/shared/src/bottle-state.ts`,
`apps/web/src/state/weather.tsx`, plus tests in `apps/api/src/services/{deletion,retention}.test.ts` and
`apps/web/src/storage.test.ts`.

**Migration and data risk. This is the batch that touches real data, and it needs care.**

- No schema change is strictly required; the columns already exist (`appeal_waived_at` from migration
  0014). If a finality marker distinct from a waiver is preferred, that is an **additive** column and must
  use the next available migration number — never an edit to an applied file, which would change its
  drizzle hash and trip the compatibility guard.
- **Back-fill is a product decision, not a technical one.** Accounts already deleted may have adrift
  letters still public and evidence with no finality. Decide explicitly whether to sweep historical rows
  or only fix behaviour going forward, and record the decision.
- Deletion is irreversible by design. Every change here must be developed against a **copy** of the
  database, and the first production run should follow a fresh backup and a tested restore.

**Verification.** A deletion test that follows the data out: release an adrift bottle, delete the sender,
assert it is absent from `/api/ocean/public` and unopenable by a stranger. Delete a sender with an
undecided notice and assert `planRetention` reports it redactable after seven days rather than
`notice_unresolved`. Kill the process mid-AI-review and assert the case is re-queued and retention
proceeds. Delete a recipient mid-journey and assert the slot is freed, no notification is written and the
inbound cancellation is reported. Sign out in a browser and assert `localStorage` holds no time zone.

**Product decision required?** Yes — two: the historical back-fill above, and whether
`notice_unresolved` gets an absolute cap (which changes published text).

---

## Batch 3 — Moderation integrity, admin containment and the flows a user can get stuck in

**Findings:** SEC-010 (P1) · SEC-009 (P2) · SEC-011 (P2) · ARCH-013 (P2) · FE-009 (P2) · FE-001 (P1) ·
FE-002 (P1) · QA-007 (P1) · FE-003 (P2) · FE-007 (P2) · FE-012 (P2) · SEC-020 (P2) · SEC-004 (P2) ·
ARCH-009 (P2) · SEC-008 (P2)

**Why these together.** Two themes that share reviewers and test surfaces. (a) **Moderation is
unreversible and uncontainable**: there is no recusal, no revoke, no way to read the audit trail, and a
banned administrator keeps every power — and because upheld violations never expire by approved design,
an honest misclick is permanent. (b) **The client has no way to recover from a bad state**: no error
boundary, a dead shell on a revoked session, no runtime validation at the boundary, and load failures
presented as emptiness. Both themes are "the system cannot recover from a mistake", and both are best
fixed once the deployment and erasure batches are behind them.

**Work.**

1. **SEC-010, three separable changes** — refuse a decision where the acting admin is the sender, recipient
   or a reporter on that case; add an administrator-side **revoke/reopen** path that writes an audit row
   and recalculates standing (distinct from an accepted appeal); require accept/reject to carry the case's
   current status or an evidence digest so a stale UI cannot decide the wrong case. **M–L**
2. **SEC-009** — apply `requireGoodStanding` to the admin and dev routers, or make a suspension or ban
   suspend the role; document a one-command containment path for a compromised moderator. **S**
3. **SEC-011** — expose the audit trail: an admin read endpoint and a per-account export path, so Privacy
   Policy §2's promise can actually be answered. Tamper-evidence (hash chaining or off-box shipping) is a
   separate, larger decision. **M**
4. **ARCH-013** — escalating an already-waived warning to a critical ban currently leaves the account with
   no appeal at all. Decide and implement the rule. **S** after the decision.
5. **FE-009** — the admin decision dialog states a fixed, sometimes false sentence and hides the
   consequence of the decision. Make the copy reflect the actual outcome, including the ban threshold. **S**
6. **FE-001** — add a React error boundary (there is none anywhere in `apps/web/src`), so a failed lazy
   chunk stops blanking the whole app. **S**
7. **FE-002, FE-003, FE-007, FE-012** — a revoked session must return the user to sign-in rather than a dead
   shell; a transient network failure at startup must not discard a valid 30-day session; load failures
   must read as failures, not as "you have nothing"; the account sheet must not survive sign-out. **M**
8. **QA-007** — parse API responses and the stored draft with the 91 shared zod schemas at the web
   boundary, instead of `return json as T`. Pairs naturally with FE-001: validation produces the error the
   boundary catches. **M**
9. **SEC-020** — refuse to boot with `MIB_AI_AUTO_DECIDE=true` while the published documents say every case
   is decided by a person. **S**
10. **SEC-004, ARCH-009, SEC-008** — stop disclosing `email_taken` at registration; apply the per-account
    sign-in budget to the public deletion form; make the login lockout cost the attacker rather than the
    account owner (a banned user's route to their appeal must never be blockable by a third party). **M**

**Expected files.** `apps/api/src/services/{admin,moderation,auth}.ts`,
`apps/api/src/http/routes/{admin,auth,legal,moderation}.ts`, `apps/api/src/http/middleware/admin.ts`,
`apps/api/src/services/audit.ts`, `apps/api/src/config.ts`, `apps/web/src/App.tsx` (+ a new
`ErrorBoundary`), `apps/web/src/api/client.ts`, `apps/web/src/state/session.tsx`,
`apps/web/src/screens/AdminScreen.tsx`, plus tests across `services/admin.test.ts`, `http/roles.test.ts`,
`http/auth.test.ts`.

**Migration and data risk.** A revoke/reopen path needs an **additive** column or a new audit action — next
available migration number only. Standing recalculation after a revoke must be written so that re-running
it is idempotent; test it against a copy first. No destructive change.

**Verification.** An admin who is the sender, recipient or reporter on a case is refused (403), and the
refusal is audited. A revoked violation removes the account from the ban threshold and writes an audit row;
revoking twice changes nothing. A suspended or banned admin gets 403 on every `/api/admin/*` route. The
audit trail is readable through an endpoint and covers every standing-changing action. A forced lazy-chunk
404 shows an error state, not a blank page. A revoked session lands on sign-in. A 200 with a wrong-shaped
body surfaces as an `ApiError`. Registration returns the same answer for a known and an unknown address.

**Product decision required?** Yes — four: whether revoke is an administrator power or requires a second
administrator; what escalation after a waiver does to the appeal right (ARCH-013); whether the audit trail
needs tamper-evidence before launch; and whether `email_taken` should ever be disclosed.

---

## Batch 4 — Capacity, throughput, operability and the test layers that do not exist

**Findings:** QA-006 (P1) · QA-008 (P1) · QA-003 (P1) · ARCH-004 (P1) · ARCH-005 (P1) · ARCH-007 (P2) ·
ARCH-010 (P2) · ARCH-011 (P2) · ARCH-012 (P2) · ARCH-015 (P2) · SEC-006 (P2) · SEC-007 (P2) ·
SEC-013 (P2) · FE-014 (P2) · the accessibility set (A11Y-001…A11Y-005, A11Y-012, P2) ·
QA-009…QA-024 (test quality and coverage, P2) · the P3 tail

**Why last.** None of it prevents a controlled pilot, and all of it becomes cheaper once CI exists to hold
it. Two items here are genuinely large — a UI test layer and the accessibility work — and starting them
before the P0/P1 defects are closed would delay the fixes that matter more.

**Work, in rough priority order.**

1. **QA-006** — key the graph cache on the underlying `better-sqlite3` handle rather than the per-transaction
   proxy (`services/chart.ts:12` vs `release.ts:187,212`), or resolve the route **before** opening the write
   transaction. One small change, roughly 50× on release latency and a large cut in API test CPU. Highest
   value-per-line in the whole plan. **S**
2. **SEC-006 then SEC-007** — move scrypt off the event loop (async `crypto.scrypt` or a worker pool) with a
   small cap on in-flight KDF operations, **then** raise the parameters to N=2^16–2^17 with opportunistic
   re-hash on sign-in. Order matters: raising cost first makes the stall worse. **M**
3. **ARCH-004, ARCH-005** — enforce and document single-process operation (a lock file or an advisory lock),
   and resolve shore capacity: it is a shared global resource and a delivered-unopened bottle holds its slot
   indefinitely. **Needs a product decision** on what capacity means before it can be implemented. **L**
4. **ARCH-011, ARCH-012, FE-014** — the risk worker re-walks every night of every journey every 15 seconds;
   route planning costs ~105 ms of blocking CPU per unrate-limited request; each open tab makes 18 requests
   per minute with no visibility gating. All three are the same shape: work proportional to something other
   than what changed. **M**
5. **QA-003 + the accessibility set** — add jsdom and Testing Library, cover the five highest-consequence
   screens (`DecisionNotice`, `PolicyConsent`, `WriteScreen` draft recovery, `DeleteAccountDialog`,
   `LettersScreen`), add axe to the component layer, and fix A11Y-001…A11Y-005 and A11Y-012 with those
   tests in place. Add a small Playwright smoke path. **L**
6. **QA-008** — once a DOM environment exists, replace the source-grep tests that certify privacy promises
   with behavioural ones. Emptying `PER_USER_KEYS` must fail the suite. **M**
7. **SEC-013** — pass the letter to the AI reviewer as a JSON string field (exactly as reporter explanations
   already are) instead of inside a fixed `<letter>` delimiter, and label the model's translation as
   untrusted in the admin UI. Re-run `ai:eval` with adversarial samples. **S**
8. **The remaining test-quality and coverage work** — QA-009 (shared mutable DB), QA-010 (a test whose name
   certifies a false guarantee), QA-011 (random-UUID-seeded assertions skipped ~1 run in 18), QA-012 (route
   lists generated from the Hono router), QA-014, QA-016, QA-017, QA-021, QA-024. **M**
9. **The P3 tail** — ARCH-015's 1970 date and negative duration, ARCH-019…ARCH-027, FE-013, FE-015…FE-023,
   A11Y-006…A11Y-013, SEC-017, SEC-018, SEC-019, QA-013, QA-019, and the documentation debt in QA-025
   (retire the v0.2 citations, reconcile specification §18 with the shipped product, delete or implement the
   dead states, and add the missing `FONTS.md` with the correct per-font licences). **M**

**Expected files.** Broad — `apps/api/src/services/{chart,release,risk,journey}.ts`,
`apps/api/src/lib/password.ts`, `apps/api/src/services/ai-review.ts`, `apps/api/src/server.ts`,
much of `apps/web/src`, `apps/web/vite.config.ts` (a `test` block with jsdom), new
`apps/web/src/**/*.test.tsx`, new Playwright specs, `docs/SeaYou_Product_Specification.md`,
`packages/shared/src/bottle-state.ts`, `README.md`, a new `FONTS.md`.

**Migration and data risk.** None expected, unless the shore-capacity decision changes the model — in which
case it is an additive migration plus an explicit back-fill decision, handled like Batch 2.

**Verification.** Release p50 well under 50 ms and 20 concurrent releases without linear queueing. Sign-in
concurrency no longer stalls `/api/health`. A second API process is refused or clearly documented as
unsupported. The release smoke suite in report 04 runs green against a built artefact in under four
minutes. Axe reports no violations on the covered screens, and keyboard-only traversal completes the core
flows. `buildUserPrompt` with a letter containing `</letter>` produces no second top-level instruction
block.

**Product decision required?** Yes — shore capacity (ARCH-005), journey pace defaults (measured at
Lisbon→Nagasaki 15.3 days with shipped values), the time-zone risk exemption (ARCH-010), unblocking
(FE-016/ARCH-028), and long-outage public windows.

---

## Product decisions that gate the plan

Collected so they can be answered in one sitting; several block work that is otherwise ready.

| #   | Decision                                                                                                                                           | Blocks  | Report |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ |
| 1   | Back-fill or forward-fix for already-deleted accounts' public letters and unfinalised evidence                                                     | Batch 2 | 02, 03 |
| 2   | Absolute cap on `notice_unresolved` (changes Privacy Policy §3)                                                                                    | Batch 2 | 03     |
| 3   | Is revoke an administrator power, or does it need a second administrator?                                                                          | Batch 3 | 03     |
| 4   | What escalation after a waiver does to the appeal right                                                                                            | Batch 3 | 02     |
| 5   | Does the audit trail need tamper-evidence before launch?                                                                                           | Batch 3 | 03     |
| 6   | Should `email_taken` ever be disclosed at registration?                                                                                            | Batch 3 | 03     |
| 7   | Shore capacity: what it means, and what happens to a slot held by a delivered-unopened bottle                                                      | Batch 4 | 02     |
| 8   | Journey pace defaults                                                                                                                              | Batch 4 | 02     |
| 9   | Time-zone risk exemption                                                                                                                           | Batch 4 | 02     |
| 10  | Unblocking: should it exist?                                                                                                                       | Batch 4 | 01, 02 |
| 11  | Single-administrator operation: if that is the intent, the Terms should say so rather than leaving "every case is decided by a person" to carry it | Batch 3 | 03     |

---

## Recommended first implementation batch

**Batch 1, exactly as scoped above** — and it is recommended without qualification, because it is the only
batch that is entirely non-negotiable, needs no product decision, touches no user data, changes no
behaviour for a correctly configured instance, and is a precondition for proving every other fix.

Concretely, the first pull request should:

1. Invert the `MIB_DEV_MODE` default and refuse to start in production with dev mode on, with the first
   `loadConfig()` test asserting safe defaults.
2. Move `GET /api/dev/outbox` behind the dev router's auth middleware.
3. Produce a real API artefact and verify `pnpm install --prod` yields a tree that starts.
4. Add CI running format → lint → typecheck → test → build, with `--passWithNoTests` removed.
5. Fix the `X-Forwarded-For` parse in all three copies and document the required proxy behaviour.
6. Add graceful shutdown and a health check that touches the database.
7. Write the deployment contract from report 02's 16 requirements, including an absolute database path on a
   persistent volume and a **tested** backup/restore drill.

After it merges, the verdict moves from **NO-GO** to a defensible **GO AFTER P1 FIXES**, and Batch 2 — the
batch that stops the published legal documents from being false — becomes provable rather than hopeful.

**This batch was deliberately not implemented as part of the audit**, per the audit-only rule.
