# Agent 4: QA, reliability and release readiness (re-audit)

- **Commit audited:** `a04526f` (merged `main`), in a private detached worktree. `git status --porcelain` was empty at the start and is empty at the end.
- **Scope:** inspect and report only. No commits, no branches, no pushes. The only source edits were temporary mutation hunks, and each one was restored with `git checkout -- <file>` straight after its run.
- **Data:** every database was `:memory:` or a temporary file under the scratch dir (`a4/`) or under `os.tmpdir()`, created by the repo's own tests and smoke script. `MIB_AI_ENABLED=false` throughout. I never opened `/home/user/messageinbottle`, and no mail was sent.
- **Ports:** the smoke ran with `--port 3231`. Two tools also opened other ports for a moment. The smoke's "second process is refused" check starts a process on `port+1` (3232). `smtp-reset.test.ts:70` binds an ephemeral fake-SMTP port on 127.0.0.1. Nothing was left listening afterwards (`ss` showed nothing on 3231/3232).
- **What I did not trust:** earlier audit text, `docs/REMEDIATION.md` and test counts are treated as claims. Every row below was re-verified.

## 1. Verdict

# CONDITIONAL GO (controlled pilot only; not a public launch)

**P0 and P1 status.** Nothing in QA/reliability scope is still at P0 or P1. Both previous P0s and 14 of the 15 previous P1s have a direct regression test that fails when the fix is removed (§3). FE-001 is the exception: it is fixed in code but has no test.

**Gates.** Every gate passes at `a04526f`: locally (§2), in the one green CI run (#9), and in a TZ/shuffle determinism probe.

**This agent raises no P0 and no P1.** New findings: **P2 × 4**, **P3 × 7**.

**Conditions that must all hold before the pilot. If any fails, the verdict is NO-GO.**

1. **Branch protection and a real PR run.** Enable branch protection on `main` so the `CI / Quality gates and production artefact` check is required. Then show at least one green run triggered by `pull_request` (QA-R-001). Today there is exactly **one** green run in the repository's history, and no PR-triggered run has ever happened.
2. **Single-process guarantee from the host.** The host must guarantee `replicas: 1` with a stop-then-start deploy. The `.lock` file is not a sufficient guard across containers or PID namespaces (QA-R-004). Record the host's guarantee in `docs/DEPLOYMENT.md`.
3. **Manual smoke of the built web bundle.** Before go-live, run a manual smoke of `apps/web/dist` served through the documented Caddy config and CSP, in a real browser: sign-in, write/release, open, report, the appeal notice, sign-out clearing, and a forced lazy-chunk failure showing the error boundary. Record it (QA-R-002, QA-R-003).
4. **Owner's open production items.** The production-configuration items still open with the owner (D16 hosting/TLS/SMTP/backup schedule, D4 external audit export, D10 backfill on the real DB) are closed or explicitly accepted. They are covered by the other agents; they are listed here because they gate release.

**When this becomes a plain GO:**

- QA-R-001 through QA-R-004 are closed.
- An automated browser smoke (Playwright or similar) runs in CI against the built bundle.
- FE-001 has a regression test that fails when the boundary is removed.

## 2. Gate results (run once, in order, `MIB_AI_ENABLED=false`)

| Gate                            | Exact command                                                                                                        | Duration | Result                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| Format                          | `pnpm format:check`                                                                                                  | 5.3 s    | PASS. "All matched files use Prettier code style!"                                                                 |
| Lint                            | `pnpm lint`                                                                                                          | 28.5 s   | PASS. 0 errors, 0 warnings                                                                                         |
| Typecheck                       | `pnpm typecheck`                                                                                                     | 10.5 s   | PASS. 3 packages                                                                                                   |
| Tests                           | `pnpm test`                                                                                                          | 133.1 s  | PASS. **623 tests in 75 files**: shared 87/6 (2.1 s), web 94/15 (6.7 s), api 442/54 (129.3 s wall, 325.7 s summed) |
| Build                           | `pnpm build`                                                                                                         | 17.9 s   | PASS. Web bundle plus `apps/api/dist`                                                                              |
| Artefact                        | `pnpm --filter @mib/api deploy --prod --legacy <scratch>/a4/art`                                                     | 1.4 s    | PASS                                                                                                               |
| Smoke                           | `node apps/api/scripts/smoke-artefact.mjs --artefact <scratch>/a4/art --prod-only --port 3231`                       | 6.0 s    | PASS. **47 PASS / 0 FAIL**                                                                                         |
| CI migration step (reproduced)  | `MIB_APP_URL=https://ci.invalid MIB_DATABASE_PATH=<scratch>/a4/migrate/fresh.sqlite node dist/migrate.js`, run twice | 0.93 s   | PASS. Applied 18, expected 18, 30 tables. Idempotent                                                               |
| Determinism probe (api)         | `TZ=Pacific/Kiritimati npx vitest run --sequence.shuffle` (seed `1790414342006`)                                     | 153 s    | PASS. 442/442                                                                                                      |
| Determinism probe (web, shared) | same flags (seeds `1790414499598`, `1790414504184`)                                                                  | ≈10 s    | PASS. 94/94, 87/87                                                                                                 |
| Temp leakage                    | `ls /tmp` diffed before the gates and after the mutation runs                                                        | —        | **No new entries.** The `mib-historic-*` / `mib-broken-*` dirs from 22–23 Sep predate this checkout (QA-013 fixed) |

**CI evidence (GitHub Actions, `LiadLati/messageinbottle`).**

- Runs #1–#8 all concluded `failure`. The run name is the file path, which is the signature of a workflow rejected before any job was created.
- Run #9 (`a04526f`, push to `main`) is `success`, and each of the 14 steps is green. The test step took 2 min 58 s.
- There are **9 runs in total, and every one was triggered by `push`**.

## 3. Previous P0/P1 → regression test → mutation check

Mutation checks work like this: a specific fix hunk is reverted, the named test files are run, and then the hunk is restored.

- Logs are in `a4/mutations/*.log` and `a4/mut13-*.log`.
- The harness is `a4/mutate.py`.
- "Fails-without-fix" means at least one named test goes red.

| Old ID (sev)                                  | Regression test (file:line)                                                                                                                                                                       | Mutation (hunk reverted)                                                                                                                      | Mutation result                                                                                                     | Closed?                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **DEPLOY-001** (P0) = ARCH-001/SEC-001/QA-002 | `apps/api/src/config.test.ts:19,25,74,80`; `apps/api/src/http/dev-mode.test.ts:115,138-160,223-267,276`; smoke `apps/api/scripts/smoke-artefact.mjs` (dev routes 404, seeded 401, takeover chain) | M01: `MIB_DEV_MODE` default back to `true`. M02: production refusal removed. M03: `/outbox` registered before `requireAuth` (the audited bug) | M01: **8 fail**. M02: **2 fail**. M03: **10 fail**                                                                  | **Yes**                                                                                                                               |
| **ARCH-006** (P0)                             | `config.test.ts:67-103`; `apps/api/src/tools/backup.test.ts:62`; smoke (47 checks); CI migration step                                                                                             | M04: `isProductionRuntime` ignores the compiled-build flag                                                                                    | **4 fail**                                                                                                          | **Engineering: yes.** Hosting, TLS, web serving, SMTP and backup schedule are an owner production dependency (D16), not testable here |
| **QA-001** (P1) no CI                         | `.github/workflows/ci.yml`                                                                                                                                                                        | n/a                                                                                                                                           | Run #9 green; runs #1–#8 never executed a job                                                                       | **Partly.** See QA-R-001                                                                                                              |
| **ARCH-002 = SEC-002** (P1)                   | `apps/api/src/services/deletion-sweep.test.ts:42,56,67`                                                                                                                                           | M05: adrift withdrawal skipped                                                                                                                | **3 fail**                                                                                                          | **Yes**                                                                                                                               |
| **SEC-012** (P1)                              | `deletion-sweep.test.ts:140`                                                                                                                                                                      | M07: unused appeal not closed on deletion                                                                                                     | **1 fails** (on the audit-row assertion; under D5 the 30-day window no longer depends on it)                        | **Yes**, under product decision D5                                                                                                    |
| **ARCH-003** (P1)                             | `deletion-sweep.test.ts:191` (function only)                                                                                                                                                      | M08: call removed from the AI tick (`services/ai-review.ts:187`)                                                                              | **Passes: not caught**                                                                                              | Code fixed; wiring untested (QA-R-005)                                                                                                |
| **ARCH-014 = QA-005** (P1)                    | `deletion-sweep.test.ts:77,105,115,129`                                                                                                                                                           | M06: `endInboundJourneys` skipped                                                                                                             | **1 fails**                                                                                                         | **Yes**                                                                                                                               |
| **SEC-010** (P1)                              | `apps/api/src/http/moderation-integrity.test.ts:63,81,107,147`; `apps/api/src/http/moderation-decisions.test.ts:181` (no revoke route)                                                            | M11: recusal check disabled                                                                                                                   | **3 fail**                                                                                                          | **Yes** for separation of duties. No correction path: **accepted and documented product decision D1**                                 |
| **FE-001** (P1)                               | **None** (`docs/REMEDIATION.md:64` cites "typecheck + browser check")                                                                                                                             | M17: `ErrorBoundary.render` always renders children                                                                                           | **All 94 web tests pass: not caught**                                                                               | Code present; **unverified** (QA-R-003)                                                                                               |
| **FE-002** (P1)                               | `apps/web/src/state/session.test.tsx:80`                                                                                                                                                          | M14b: `sessionEnded()` call in `api/client.ts` removed. M14: startup `refresh()` 401 branch disabled                                          | M14b: **1 fails**. M14: **passes**                                                                                  | **Yes** for the mid-session path. Startup path untested (QA-R-006)                                                                    |
| **QA-007 = ARCH-021** (P1)                    | `apps/web/src/api/client.test.ts:72`; `apps/api/src/http/contract.test.ts:48`; `apps/web/src/lib/draft.test.ts:38`                                                                                | M15: `return json as T` without parsing                                                                                                       | **1 fails**                                                                                                         | **Yes**                                                                                                                               |
| **QA-006** (P1)                               | `apps/api/src/services/batch4-invariants.test.ts:23`                                                                                                                                              | M10: graph cache keyed on the tx object again                                                                                                 | **1 fails**                                                                                                         | **Yes** (identity check; there is no latency budget test)                                                                             |
| **QA-008** (P1)                               | `session.test.tsx:55`; `apps/web/src/screens/WriteScreen.test.tsx:113`; `draft.test.ts:44`                                                                                                        | M16: exactly the audit's mutation (`PER_USER_SESSION_KEYS = []`)                                                                              | **2 fail**                                                                                                          | **Yes**                                                                                                                               |
| **QA-003** (P1) no UI tests                   | 6 jsdom files: `components/dialogs.test.tsx`, `screens/screens.test.tsx`, `screens/WriteScreen.test.tsx`, `state/session.test.tsx`, `state/weather.test.tsx`, `lib/draft.test.ts`                 | n/a                                                                                                                                           | Component layer exists. **No browser/e2e, no a11y tooling**                                                         | **Partly** (QA-R-002)                                                                                                                 |
| **ARCH-004** (P1)                             | `apps/api/src/lib/process-lock.test.ts:18,28`; smoke check "a second API process on the same database is refused"                                                                                 | M13: `acquireProcessLock` call removed from `server.ts`                                                                                       | `pnpm test`: **passes** (3 files green). Rebuilt artefact smoke: **FAIL** "a second API process … refused (exit 0)" | **Yes within one PID namespace.** Bypassable across containers (QA-R-004)                                                             |
| **ARCH-005** (P1)                             | `apps/api/src/http/shore-capacity.test.ts:32` (110 in-process concurrent → exactly 100 × 201 + 10 × 422), `:60`, `:75`                                                                            | M12: `>=` → `>` in `release.ts:132`                                                                                                           | **2 fail**                                                                                                          | **Yes** (D6). Not listed by ID in `REMEDIATION.md` (QA-R-009)                                                                         |
| **ARCH-008 = QA-004** (P1)                    | `apps/api/src/http/recovery-delivery.test.ts:30,39,64`                                                                                                                                            | M09b: forgot route `await`s the mail send                                                                                                     | **1 fails** (`412 ms` vs `< 200 ms`, a wall-clock assertion)                                                        | **Yes** (see QA-R-007 on timing)                                                                                                      |

**Score.**

- Mutation-checked: 17 of 17 previous P0/P1s, with 20 mutations in total.
- Caught by tests: 15, counting ARCH-004 as caught by the smoke.
- Not caught: FE-001 and the ARCH-003 wiring.
- Partial path gaps: FE-002 startup, and the notification tiebreak (M18, a D11 check outside this table).

## 4. Findings

### QA-R-001: CI has one green run in its history, never on a pull request; branch protection unverified

**P2 · unresolved previous finding (QA-001, partial) · confirmed**

**Evidence.**

- GitHub Actions: 9 runs of `ci.yml`, all `event: push`.
  - Runs #1–#8 (`51f0a2b` … `0444d7d`) concluded `failure` before any job was created.
  - Commit `a04526f` says: "job-level env used `${{ runner.temp }}` … Every run since the workflow was added failed with 0 jobs".
  - Run #9 (`a04526f`) is the first and only success.
- So every remediation batch was merged to `main` without CI ever executing: Batches 1–4, the product decisions, and merge `3a4ea92`.
- `docs/DEPLOYMENT.md:157` lists "Enabling GitHub branch protection so CI blocks merges" as an open owner task. I could not verify it from here.

**Impact.**

- CI's ability to block a bad change is unproven. It has never gated a PR.
- There is no history showing the suite is stable on GitHub runners. That matters because the suite has wall-clock assertions (QA-R-007) and a known storm-outcome flake class (QA-R-008).
- The release commit is green, but release confidence rests on one sample.

**Fix.**

- Enable branch protection with the `gates` job required.
- Open a trivial PR to prove the `pull_request` trigger runs.
- Re-run #9 a few times, or schedule a nightly run, to establish a stability baseline.

**Regression check:** the branch-protection setting, plus a PR showing a required check.

### QA-R-002: No automated browser, e2e, accessibility or built-web-bundle coverage; many UI fixes verified only by an uncommitted script

**P2 · unresolved previous finding (QA-003 partial; A11Y-\*, FE-004/005/006/015 verification) · confirmed**

**Evidence.**

- `git ls-files | grep -i 'e2e\|browser\|playwright'` returns nothing.
- No `playwright`, `axe`, `cypress` or `puppeteer` in any `package.json`.
- `docs/REMEDIATION.md:128` itself says "the browser script is not in CI". That script is also **not committed**.
- These rows cite only "browser" or "browser check" as verification: `REMEDIATION.md:64,67,68,94-106,115-126` (FE-001, FE-004, FE-005, FE-006, FE-007, FE-011, FE-012, FE-015, A11Y-001, A11Y-003, A11Y-007, A11Y-012 …).
- CI builds `apps/web/dist` but never loads it. The smoke covers only the API artefact.
- The reference `docs/deploy/Caddyfile` sets a strict CSP (`script-src 'self'`, `worker-src 'self' blob:`) for the bundle, and it has never been exercised against the built output.
- The only a11y signal is `getByRole` usage in three jsdom files (`dialogs.test.tsx` 32, `screens.test.tsx` 14, `WriteScreen.test.tsx` 7).

**Impact.**

- A regression in layout, focus management, the MapLibre worker under CSP, or lazy-chunk loading would pass every gate.
- The accessibility fixes can silently regress.

**Fix.**

- Commit the browser script as a Playwright suite.
- Run it in CI against `vite preview` or Caddy serving `dist`, with `@axe-core/playwright` on the main screens.
- Include one forced chunk-load failure.

**Regression test:** that suite itself.

### QA-R-003: FE-001 (P1) error boundary has no regression test

**P2 · unresolved previous finding (FE-001 verification) · confirmed by mutation**

**Evidence.**

- `apps/web/src/components/ErrorBoundary.tsx:29-31`. Mutation M17 changes `render()` to `return this.props.children;`.
- `pnpm --filter @mib/web test` then gives 15 files, 94 tests, **all pass**.
- No test imports `ErrorBoundary`, `lazy.tsx` or `main.tsx`. `WriteScreen.test.tsx:27` mocks `lazy.js` away.

**Impact.** The P1 blank-screen failure can return undetected, and it is exactly the kind of failure that appears after a deploy (stale hashed chunks).

**Fix.** Add a jsdom test that:

- renders `ErrorBoundary` with a throwing child and asserts the fallback, the `role="alert"` and a working reset;
- renders `LazyPart` with a rejecting import and asserts the contained, retryable fallback.

### QA-R-004: The single-process lock is bypassed across PID namespaces (containers)

**P2 · newly discovered · production-configuration dependency · confirmed (probe)**

**Evidence.**

- `apps/api/src/lib/process-lock.ts:41-48`. The lock treats the holder as stale if either:
  - `holder === pid`, or
  - `process.kill(holder, 0)` fails.
- Probe `a4/lockprobe/probe.ts`:
  - `same-PID second process: ACQUIRED (lock stolen)`: container A and container B are both PID 1.
  - `holder pid invisible in this namespace: ACQUIRED (lock stolen)`: the holder's PID does not exist in the new process's namespace.
- `docs/DEPLOYMENT.md:87-90` presents the lock as the enforcement of "one process per database file".

**Impact.**

- On a container host, overlap is the typical setup: a rolling or blue-green deploy, a second replica, or a restarted container while the old one lingers on a shared volume.
- In that case the second API starts, deletes the lock and runs a second set of workers: journey, risk, AI and retention.
- It also doubles every in-memory rate limit. That is the exact ARCH-004 failure.
- The first process keeps running. Its `release()` will not remove the lock (PID mismatch), so nothing alerts.

**Fix.** Use an OS-level exclusive lock rather than PID liveness. Two options:

- Hold an exclusive SQLite write transaction on a dedicated lock DB or table, or use `BEGIN EXCLUSIVE` on a sidecar file.
- Use `flock` through a native helper.

At minimum, also record a host and boot identity (hostname plus boot id) in the lock and refuse on mismatch unless an operator sets `--force-unlock`. Document "replicas: 1 + Recreate" as a hard host guarantee.

**Regression test:** a lock written with the current PID but a different host or boot id is refused. The smoke already covers the same-namespace case.

**Related:** ARCH-004, QA-022.

### QA-R-005: ARCH-003 stale-claim release is tested as a function, not where it runs

**P3 · unresolved previous finding (ARCH-003 verification) · confirmed by mutation**

**Evidence.**

- `deletion-sweep.test.ts:191-214` calls `releaseStaleAiClaims` directly.
- M08 deletes the per-tick call at `apps/api/src/services/ai-review.ts:187`. `deletion-sweep`, `recovery-paths` and `moderation` all still pass.
- The startup call at `apps/api/src/server.ts:40` is covered by nothing, since `server.ts` only runs in the smoke.

**Impact.** A refactor could drop the wiring. The failure would come back silently: evidence retention blocked forever after a crash mid-review.

**Fix and test.** In `runAiReviewTick`, set a case `aiStatus='running'` with an old `aiStartedAt`, run one tick, and assert it is re-queued or processed. Optionally add a smoke step that seeds a running claim before start.

### QA-R-006: Untested branches inside fixed behaviour (pagination tiebreak, FE-002 startup path, exact expiry boundary, backfill paths)

**P3 · newly discovered · confirmed by mutation (1, 2), by reading (3, 4)**

1. **Notification pagination, same millisecond.** `apps/api/src/services/notifications.ts:89-92` tiebreaks rows with equal `createdAt` by `rowid`. M18 removes that branch, and `notification-history.test.ts` plus `notifications.test.ts` still pass. The fixture (`notification-history.test.ts:26-35`) spaces notices one day apart. The code comment at `:96-98` names the real case: a suspension and the appeal that lifts it, written in the same millisecond. At a page boundary, the mutated code would skip notices silently.
2. **FE-002 on startup.** M14 disables the `refresh()` 401 branch at `apps/web/src/state/session.tsx:107` and `session.test.tsx` passes. Only the mid-session `client.ts` path is pinned.
3. **Suspension expiry boundary.** `suspension.test.ts:137` advances exactly `SUSPENSION_MS`. No assertion shows the account is still restricted at `SUSPENSION_MS - 1`. Appeal expiry is boundary-tested (`moderation-decisions.test.ts:218,226`).
4. **Deletion backfill.** `deletion-sweep.test.ts:217-256` exercises only the adrift/lost-letter path. The other counters are asserted only as `0`: `inboundJourneysEnded`, `harbourPlacesReleased`, `appealsClosed`. D10 (running the backfill on the real DB) is still open.

**Fix.**

1. Page size 50 with ≥ 3 notices at the same `createdAt` straddling the boundary.
2. Mount `SessionProvider` with a stored token and `api.me()` → 401.
3. Assert still restricted at −1 ms.
4. Seed an old-style deletion with an in-flight inbound bottle, a delivered-unopened bottle and an unappealed violation, then assert each counter is 1 and a second run gives 0.

### QA-R-007: Wall-clock timing assertions and tests close to the 5 s default timeout

**P3 · newly discovered (partly carried from QA-026) · confirmed (by reading); not observed failing**

**Evidence.**

- `apps/api/src/lib/password.test.ts:63-68`: event-loop tick `< 40 ms` while 8 scrypt hashes run.
- `recovery-delivery.test.ts:65-71`: `< 200 ms`, with a real 400 ms `setTimeout`. This is also the **only** test that catches the ARCH-008 mutation (M09b).
- `recovery-delivery.test.ts:22`: a fixed 20 ms `settle()`.
- `recovery-paths.test.ts:138-146`: real `Date.now()` elapsed time.
- `smtp-reset.test.ts:123,143,230`: real-time polling of a socket server.
- There is no vitest config, so the timeout is the 5 s default. Slowest individual tests in this run:
  - `risk.test.ts` "tags new journeys…": 3.2 s
  - `password.test.ts` queue: 2.8 s
  - `grant-role` × 3: 2.0–3.4 s (the file sets 60 s)
  - `migration.test.ts`: 3.9 s (sets 60 s)
- The determinism probe ran about 15% slower (389.8 s summed test time vs 325.7 s).

**Impact.** Flaky reds on a slower or shared GitHub runner. After enough of them, people stop trusting a red CI.

**Fix.**

- Replace elapsed-time thresholds with structural assertions. Examples: the handler resolved before the mail promise settled (a deferred you control); the event loop turned while a hash is pending (a counter, not milliseconds).
- Use `vi.useFakeTimers()` where possible.
- Set an explicit `testTimeout` in a checked-in vitest config.

### QA-R-008: Storm outcomes in unpinned tests depend on random seeded IDs

**P3 · newly discovered · theoretical (low probability)**

**Evidence.**

- Seeded users get `newId('usr')` (a random UUID, `apps/api/src/db/seed.ts:179`).
- Storm rolls are `rollAccountStorm(userId, slot)` (`apps/api/src/services/weather.ts:194`).
- Losses come from `bottleRiskDraws(bottleId, …)`.
- `runJourneyTick` runs risk decisions first (`apps/api/src/services/journey.ts:199`).
- 12 test files drive ticks or risk. Only `risk.test.ts` and `account-storms.test.ts` pin IDs (`vi.mock('../lib/ids.js')`).
- **Precedent:** commit `4355b5a`, "Make the ARCH-011 idle-tick test independent of storm outcomes … a world whose random account id rolled few storms failed the ratio". That is the same class of failure, and it reached CI (run #7).
- **Probe** (`a4/lockprobe/stormprobe.ts`): 400 fresh worlds, each releasing ada→bo (65 h plan), advancing 60 days and ticking, gave `{"delivered":400}`. That is 0 losses, so the risk per test is below about 0.75% at 95% confidence.

**Fix.** Pin user and bottle IDs in the harness by default, with deterministic sequential IDs in `createTestWorld`. Alternatively set `riskPolicyVersion: 0` in `testConfig`, and let only the risk suites opt in.

### QA-R-009: Remediation record drifts from the code and from the audit

**P3 · newly discovered (documentation) · confirmed**

- **Unexplained downgrades.** `docs/REMEDIATION.md:46,47,57,79` relabels SEC-012, ARCH-003, SEC-010 and ARCH-004 as **P2**, but the audit's summary and plan list them as **P1**. No rationale is given.
- **ARCH-005 missing.** The P1 appears nowhere in `REMEDIATION.md`. It is only implicitly closed by D6.
- **Stale QA-001 row.** `REMEDIATION.md:209` (Stage 1) still says "`apps/web` still runs `vitest --passWithNoTests`". That is false: there are no occurrences in the repo. It also contradicts `:33`.
- **Wrong file count.** `REMEDIATION.md:33` says "web suite now 14 files". The actual count is 15.
- **Stale seven-day rule.** `REMEDIATION.md:46` says "redacted after seven days". So does the test name `deletion-sweep.test.ts:140`, while the same test asserts `THIRTY_DAYS_MS` (`:163`). The code comment at `services/deletion.ts:373` still cites a "seven-day rule". D5 made it 30 days.

**Impact.** Anyone auditing closure from the record gets the wrong severity and the wrong rule.

**Fix.** Correct the rows and rename the test.

### QA-R-010: Fake SMTP exercises only the plaintext path; the documented production transport is never tested

**P3 · newly discovered · production-configuration dependency · confirmed (by reading)**

**Evidence.**

- `apps/api/src/http/smtp-reset.test.ts:23-78`. The fake server advertises only `AUTH PLAIN`: no `STARTTLS`, no implicit TLS. It always answers `250` or `235`. The mailer under test uses `secure: false` (`:102`).
- The documented production setting is `MIB_SMTP_PORT=465`, `MIB_SMTP_SECURE=true` (`docs/DEPLOYMENT.md:53-56`, `.env.example:54-56`). Nothing tests it.
- The code defaults are port 587 and `secure=false` (`apps/api/src/config.ts:245-246`). `SmtpMailer` sets no `requireTLS` (`apps/api/src/lib/mail.ts:55-62`). If an operator keeps the defaults and a network attacker strips STARTTLS, nodemailer would send the App Password in cleartext.
- No test covers a 4xx/5xx reply from a real SMTP dialogue. Failures are covered only by injected rejecting mailers.

**Fix.**

- Set `requireTLS: true` whenever `secure` is false and the host is not loopback, or refuse `secure=false` in production.
- Add a fake-server case that returns `535` and one that returns `451`, and assert the withdrawn-link behaviour.

### QA-R-011: Populated-upgrade coverage skips the schema real databases are on

**P3 · unresolved previous finding (QA-021, partial) · confirmed (by reading)**

**Evidence.**

- `apps/api/src/db/migration.test.ts:20-31,75` upgrades a populated DB from the **0007** cut point.
- `:185-214` covers 0016 → 0017.
- `compat.test.ts` covers the renumbered-policy history.
- `partial-migration.test.ts` covers a failed migration. The remediation row itself says the historical cut points "are still not each exercised" (`REMEDIATION.md:147`).
- No test upgrades a DB populated at **0014**, the audited-era schema. Such a DB would hold moderation cases, violations, appeals, holds and waivers, and would then run through 0015 (new moderation columns), 0016 and 0017 before the D5 and D7 rules read it.

**Impact.** These are the rows the new finality and retention code reads. `finalityOf` handles `appeal_window_starts_at = NULL`, but only by construction, never on migrated data. The only such database today is the development DB, and production will be fresh, so this stays P3.

**Fix.** A parameterised test over each journal cut point from 0007 onward. Seed representative rows per era, migrate to head, then run `planRetention`, `accountStanding` and `runJourneyTick` without error.

## 5. Coverage review of the requested areas

"OK" means covered by a test that I read and that asserts the behaviour.

| Area                                           | Status                                                       | Evidence                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic clocks                           | OK                                                           | `ManualClock`, with split `clock` and `realClock` (`apps/api/src/test/harness.ts:27-41,97-100`). Production code reads `Date.now()` only in `server.ts`, tools and `lib/clock.ts`                        |
| Deterministic IDs and seeds                    | Partial                                                      | Risk and storm suites pin IDs. Other suites do not (QA-R-008)                                                                                                                                            |
| Test isolation                                 | OK                                                           | Fresh `:memory:` world per test. `grant-role.test.ts` uses a fresh DB per test (QA-009). Shuffle probe green                                                                                             |
| Temp DB cleanup                                | OK                                                           | No `/tmp` delta after the full suite, the smoke and a failed smoke                                                                                                                                       |
| Ordering assumptions                           | OK                                                           | `--sequence.shuffle` green in all 3 packages. Notification order uses `rowid`, but its tiebreak is untested (QA-R-006)                                                                                   |
| Race and concurrency                           | In-process only                                              | 110 concurrent HTTP releases → exactly 100 (`shore-capacity.test.ts:32`); both orders of the arrival/loss race (`risk.test.ts:255`). Multiple processes are prevented by the lock, not tested (QA-R-004) |
| Shore capacity at 99, 100, 101                 | OK                                                           | The 110-burst yields 100 × 201 and the 101st onward gets 422. Mutating `>=` to `>` fails. Once-per-episode notice at `:75`                                                                               |
| Multiple simultaneous sends                    | OK (in-process)                                              | As above, plus idempotent replay (`app.test.ts`, `release.test.ts`)                                                                                                                                      |
| Multiple bottles in one storm                  | OK                                                           | `account-storms.test.ts:466`; `risk.test.ts:600`                                                                                                                                                         |
| Calm or storm selection                        | OK                                                           | `account-storms.test.ts:296,323` (same result in any DB)                                                                                                                                                 |
| Time-zone change before and after the midpoint | OK                                                           | `account-storms.test.ts:402,432,515,535,641,661`; DST at `risk.test.ts:689`; date line in `recovery-paths.test.ts`                                                                                       |
| Worker restart and catch-up                    | OK                                                           | `account-storms.test.ts:605,754`; `risk.test.ts:182`                                                                                                                                                     |
| Duplicate processing                           | OK                                                           | `journey.test.ts:63-64`; `risk.test.ts:147`; restart and migration re-run at `account-storms.test.ts:754`                                                                                                |
| Suspension expiry                              | OK, but no −1 ms check                                       | `suspension.test.ts:68` (QA-R-006)                                                                                                                                                                       |
| Appeal expiry                                  | OK                                                           | Boundary at `moderation-decisions.test.ts:208`, last day at `:248`                                                                                                                                       |
| Evidence retention                             | OK                                                           | `retention.test.ts:72-311` (30-day window, idempotent, disable)                                                                                                                                          |
| Legal hold release                             | OK                                                           | `retention.test.ts:319,344,353`                                                                                                                                                                          |
| Deletion and backfill                          | Mostly OK                                                    | Sweep fully covered. Backfill covers the adrift path only (QA-R-006)                                                                                                                                     |
| Notifications pagination                       | OK except ties                                               | `notification-history.test.ts:46` (QA-R-006)                                                                                                                                                             |
| Fresh and upgraded DB                          | Fresh OK (CI plus smoke, 18/18). Upgraded: partial           | QA-R-011                                                                                                                                                                                                 |
| Fake SMTP                                      | Plaintext path only                                          | QA-R-010                                                                                                                                                                                                 |
| Zero-test or skip risk                         | OK                                                           | No `.only`, `.skip`, `.todo`, `skipIf`, `runIf` or `passWithNoTests` anywhere. Vitest fails a file with no suite                                                                                         |
| Implementation-detail assertions               | Acceptable                                                   | QA-006 asserts object identity, with no latency budget. `storage.test.ts:85-106` / `legal.test.ts` greps remain only as a backstop; behaviour tests now exist (M16 fails)                                |
| Production artefact                            | API: strong (47-check smoke, CI migration). Web bundle: none | QA-R-002                                                                                                                                                                                                 |
| Browser, e2e and a11y                          | None automated                                               | QA-R-002                                                                                                                                                                                                 |

## 6. Finding index

| ID       | Sev | Title                                                                                            | Classification                                        |
| -------- | --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| QA-R-001 | P2  | CI has one green run, never on a PR; branch protection unverified                                | unresolved previous (QA-001)                          |
| QA-R-002 | P2  | No browser, e2e, a11y or built-web-bundle coverage; UI fixes verified by an uncommitted script   | unresolved previous (QA-003)                          |
| QA-R-003 | P2  | FE-001 error boundary has no regression test (mutation survives)                                 | unresolved previous (FE-001 verification)             |
| QA-R-004 | P2  | Process lock bypassed across PID namespaces / same PID                                           | newly discovered; production-configuration dependency |
| QA-R-005 | P3  | ARCH-003 stale-claim release wiring untested (mutation survives)                                 | unresolved previous (ARCH-003 verification)           |
| QA-R-006 | P3  | Untested branches: pagination tiebreak, FE-002 startup, suspension −1 ms, backfill paths         | newly discovered                                      |
| QA-R-007 | P3  | Wall-clock timing assertions and tests near the 5 s default timeout                              | newly discovered                                      |
| QA-R-008 | P3  | Storm outcomes in unpinned tests depend on random IDs (precedent `4355b5a`)                      | newly discovered (theoretical)                        |
| QA-R-009 | P3  | Remediation record drift (P1→P2 relabels, ARCH-005 missing, stale rows and test name)            | newly discovered (docs)                               |
| QA-R-010 | P3  | Fake SMTP covers plaintext only; production TLS path and error replies untested; no `requireTLS` | newly discovered; production-configuration dependency |
| QA-R-011 | P3  | No populated upgrade from the 0014-era schema through 0015–0017                                  | unresolved previous (QA-021)                          |

**Confirmed vs theoretical.**

- **Confirmed:** QA-R-001 through QA-R-007 and QA-R-009 through QA-R-011. QA-R-007 is confirmed by reading; none of those assertions was observed failing in this run.
- **Theoretical:** QA-R-008, with a measured upper bound.
