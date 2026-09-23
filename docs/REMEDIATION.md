# Remediation status

Tracks fixes for findings from the pre-deployment readiness audit (branch
`audit/pre-deployment-readiness`, audited commit `5ba32c2`; reports `00`–`05` in
`docs/audits/pre-deployment-readiness/` on that branch). The audit's verdict was **NO-GO**.

Two branches carry the work:

- `fix/production-runtime` (Stage 1, merged to `main` as `f89e35c`) — recorded below under
  "Stage 1".
- `fix/audit-remediation` (from `f89e35c`, not merged, not deployed) — Batches 1–4 of
  `05-remediation-plan.md`, in dependency order, one commit group per batch.

**Status words.** *Fixed* — changed and verified by the named test or check. *Fixed by f89e35c*
— closed by Stage 1; re-checked against current code, not reimplemented. *Partly fixed* — the
independent part is done; the rest needs the decision named in "Decisions needed". *Open —
decision* — nothing that would pre-empt the decision was built. A finding is marked closed only
with the evidence in its row.

## Finding table (`fix/audit-remediation`)

Test paths are relative to `apps/api/src` (API), `apps/web/src` (web) or `packages/shared/src`
(shared) unless given in full.

### Deployment, configuration and the request edge (Batch 1)

| ID | Sev | Status | Fix | Verification |
| --- | --- | --- | --- | --- |
| DEPLOY-001 = ARCH-001 = SEC-001 = QA-002 | P0 | Fixed by f89e35c | Dev mode off by default, refused in production; dev routes (outbox included) behind `requireAuth`+`requireDeveloper`, unmounted in production | `config.test.ts`, `http/dev-mode.test.ts`; artefact smoke (`/api/dev/*` → 404) |
| SEC-003 | P2 | Fixed by f89e35c | Outbox behind the dev router's auth | `http/dev-mode.test.ts` |
| ARCH-016 | P2 | Fixed by f89e35c | Clean `SIGTERM` shutdown | artefact smoke (clean stop) |
| ARCH-006 | P0 | Fixed (engineering); hosting is a decision | f89e35c: compiled artefact. d31a69b: `docs/DEPLOYMENT.md` contract, `docs/deploy/Caddyfile`, online verified backup `db:backup` / `dist/backup.js` | `tools/backup.test.ts` (restore drill with writes in the WAL; a plain copy loses them); artefact smoke runs the backup. Host, domain, SMTP and backup schedule: see Decisions |
| QA-001 | P1 | Fixed; branch protection is an owner action | f89e35c: CI. d31a69b: web no longer `--passWithNoTests` | `.github/workflows/ci.yml`; web suite now 14 files |
| ARCH-018 = SEC-005 | P2 | Fixed | `http/client-address.ts`: right-most `X-Forwarded-For` minus `MIB_TRUSTED_PROXY_HOPS`; one helper for auth, moderation, legal | `http/hardening.test.ts` (spoofed left entries share one bucket) |
| ARCH-017 | P2 | Fixed | `/api/health` runs `select 1`; 503 `database_unavailable` | `http/hardening.test.ts` |
| SEC-014 | P2 | Fixed | API sets CSP, XFO DENY, nosniff, Referrer-Policy, COOP, Permissions-Policy, HSTS when https; production refuses non-https `MIB_APP_URL` | `http/hardening.test.ts`, `config.test.ts`, artefact smoke header check |
| ARCH-027 | P3 | Fixed | 64 KB body limit → 413 `payload_too_large` | `http/hardening.test.ts`, artefact smoke |
| ARCH-022 | P3 | Fixed | Fallback validation error no longer echoes raw issues/input | `http/hardening.test.ts` |

### Erasure and retention (Batch 2)

| ID | Sev | Status | Fix | Verification |
| --- | --- | --- | --- | --- |
| ARCH-002 = SEC-002 | P1 | Fixed | `services/deletion.ts` `sweepDeletedAccount()`: withdraws the deleted sender's adrift listings (closing readings), clears every lost letter's text | `services/deletion-sweep.test.ts` |
| ARCH-014 = QA-005 | P1 | Fixed | Inbound journeys to a deleted account end as cancelled ("Delivery unavailable"), capacity released; delivered-unopened slots released; `commitArrival` refuses inactive recipients and blocks in either direction | `services/deletion-sweep.test.ts`; arrival refusals in `services/recovery-paths.test.ts` |
| SEC-012 | P2 | Partly fixed | Deleting an account closes its unused appeal (system audit row `appeal_waived`), so the case becomes final and is redacted after seven days | `services/deletion-sweep.test.ts`. Absent-but-living senders: Decision D5 |
| ARCH-003 | P2 | Fixed | `releaseStaleAiClaims()` at startup and on every tick | `services/deletion-sweep.test.ts` (ARCH-003 describe) |
| ARCH-025 | P3 | Fixed | Dead states, loss reason and event types removed from shared model and web | `letter.test.ts` (transitions), typecheck |
| FE-010 = SEC-015 | P2 | Fixed | Sign-out clears `mib.accountTimeZone` and per-user session keys | `state/session.test.tsx` (behavioural; emptying the key list fails it) |
| SEC-016 | P3 | Fixed | `/api/*` defaults to `Cache-Control: no-store` | `http/hardening.test.ts` |
| — deletion backfill | — | Tool ready; running it is a decision | `deletion:backfill` (dry run by default, `--apply` in one transaction) | `services/deletion-sweep.test.ts`; see Decision D10 |

### Moderation integrity, sign-in abuse, recovering clients (Batch 3)

| ID | Sev | Status | Fix | Verification |
| --- | --- | --- | --- | --- |
| SEC-010 | P2 | Partly fixed | Recusal (403 `recused`) for sender/recipient/reporter admins on case, appeal and critical action; decisions echo the evidence SHA-256 (409 `stale_case`) | `http/moderation-integrity.test.ts`. Revoke/reopen and second-admin review: Decision D1 |
| FE-009 | P2 | Fixed | Server-computed consequence of upholding shown; accepting requires a reason (API 400 `reason_required` + dialog) | `http/moderation-integrity.test.ts` |
| SEC-009 | P2 | Fixed | Admin and dev routers also require good standing | `http/moderation-integrity.test.ts` |
| SEC-011 | P3 | Partly fixed | `GET /api/admin/audit?subject=|case=`, `audit:export --user` | `http/moderation-integrity.test.ts` (audit read). Tamper evidence: Decision D4 |
| SEC-020 | P2 | Fixed | `MIB_AI_AUTO_DECIDE=true` refused while a published document says a person decides every case | `http/moderation-integrity.test.ts` |
| SEC-008 | P2 | Fixed | Failed sign-ins limited per (account, address) = 10 and per account = 100 | `http/moderation-integrity.test.ts` |
| ARCH-009 | P2 | Fixed | Public deletion form spends the same per-account budgets through one shared limiter | `http/moderation-integrity.test.ts` |
| FE-001 | P1 | Fixed | Root error boundary; each lazy chunk contained and resettable | typecheck + browser check; `components/lazy.tsx` |
| FE-002 | P1 | Fixed | 401 `unauthorized` ends the session with an explanation | `state/session.test.tsx` |
| FE-003 | P2 | Fixed | Unreachable server at startup keeps the token and retries | `state/session.test.tsx` |
| FE-007 | P2 | Fixed | Failed lists say so with Try again | `components/ui.tsx` `LoadFailed`; browser check |
| FE-012 | P2 | Fixed | Per-account UI state reset when the account changes | `App.tsx`; browser check |
| QA-007 = ARCH-021 | P1 | Fixed | Every response parsed with its shared schema; stored draft schema-checked (`lib/draft.ts`) | `http/contract.test.ts`, `api/client.test.ts`, `lib/draft.test.ts` |
| ARCH-015 | P3 | Fixed | Undelivered own letter: `deliveredAt` null, duration ≥ 0 | `http/contract.test.ts` |

### Throughput, hardening, workers (Batch 4, backend)

| ID | Sev | Status | Fix | Verification |
| --- | --- | --- | --- | --- |
| QA-006 | P1 | Fixed | Graph cache keyed on the SQLite connection | `services/batch4-invariants.test.ts` (same graph object in every transaction; fails with the old per-transaction key); release ~300 ms → 8–15 ms measured; report-budget tests no longer need a 30 s timeout |
| SEC-006 | P2 | Fixed | Async scrypt, 2 concurrent, bounded queue → 503 `busy` | `lib/password.test.ts` |
| SEC-007 | P3 | Fixed | N = 2^16; old hashes verify and are re-hashed on sign-in | `lib/password.test.ts` |
| ARCH-004 (+ QA-022) | P2 | Fixed | Exclusive `<db>.lock`; second live process refused; stale lock taken over | `lib/process-lock.test.ts`; artefact smoke |
| ARCH-007 | P2 | Fixed | Risk decision and its loss commit in one transaction | `services/risk.test.ts` ARCH-007 (a trigger makes the loss write fail: no decision row is left, and the next tick decides and loses the bottle) |
| ARCH-011 | P2 | Fixed | Per-bottle cursor; cached `Intl` formatters (200 bottles ≈ 35 ms/tick) | `services/batch4-invariants.test.ts` (an idle tick prepares ≤ 6 statements; 18 without the cursor) |
| ARCH-012 | P2 | Fixed | Route plans cached per graph; 120 previews/releases per account per 15 min | `http/limits.test.ts` |
| ARCH-008 = QA-004, SEC-017 | P1 | Fixed (missing from the plan's batches) | Reset request answers before mail is sent; a new token supersedes older ones only once delivered | `http/recovery-delivery.test.ts` (202 for known and unknown with mail failing; no wait on slow mail) |
| SEC-013 | P2 | Fixed | Letter sent to the model as a JSON string; translation labelled untrusted | `services/moderation.test.ts` ("Letter (JSON string)") |
| ARCH-010 | P2 | Partly fixed | Zone changes limited to 4 per account per 24 h | `http/limits.test.ts`. Default zone: Decision D7 |
| ARCH-019 | P3 | Fixed | `MIB_RISK_POLICY_VERSION` accepts only 0 or the current version | `http/limits.test.ts` |
| ARCH-020 | P3 | Fixed | Schema check derived from `schema.ts` | `services/batch4-invariants.test.ts` (a dropped late column is named) |
| ARCH-023 | P3 | Fixed | Every published document readable by id | `http/limits.test.ts` |
| ARCH-024 | P3 | Fixed | Hourly pruning of expired sessions, spent resets, old idempotency keys | `services/housekeeping.test.ts` |
| ARCH-026 | P3 | Fixed | Moderation notifications use the real clock | `services/batch4-invariants.test.ts` |

### Frontend and accessibility (Batch 4, frontend)

Browser-verified at 667×375, 740×360, 844×390, 390×844 and 1280×800 with a script against a
fresh temporary database (37 checks, all passing), plus the jsdom tests named.

| ID | Sev | Status | Fix | Verification |
| --- | --- | --- | --- | --- |
| FE-004 | P2 | Fixed (missing from the plan's batches) | Short landscape uses the side-pane layout (`lib/layout.ts` + CSS) | browser: zoom and Private/Public clickable at 667×375, 740×360, 844×390 |
| FE-005 | P2 | Fixed (missing from the plan) | Account sheet capped to the viewport and scrolls | browser: Delete account reachable at three landscape sizes |
| FE-006 | P2 | Fixed (missing from the plan) | Per-screen fallback text; Ocean lists bottles when WebGL is absent | browser with WebGL disabled |
| FE-008 | P2 | Fixed (missing from the plan) | `stormsWeathered` from recorded risk decisions | `services/risk.test.ts` |
| FE-011 | P2 | Fixed (copy); keeping found letters is Decision D12 | Received copy states a found letter is read once | browser check |
| FE-013 | P3 | Fixed | Sent/Lost share one fetch | `screens/LettersScreen.tsx` |
| FE-014 | P2 | Fixed | Pollers pause while hidden, catch up once | `lib/useAsync.ts` |
| FE-015 | P3 | Fixed | History entries per screen; Back restores | browser: Back twice stays in the app |
| FE-016 | P3 | Partly fixed | Block confirms in the app dialog, stating it cannot be undone | `screens/screens.test.tsx`, browser. Unblock: Decision D8 (= ARCH-028) |
| FE-017 | P3 | Fixed | No doubled full stop | `screens/WriteScreen.tsx` |
| FE-018 | P3 | Fixed | HTML 404 (noindex) for unknown `/legal/*` | `http/support.test.ts`, browser |
| FE-019 | P3 | Fixed | Restricted screen offers Delete account; copy matches the Terms | `screens/screens.test.tsx` |
| FE-020 | P3 | Fixed | Retired wordmark deleted; assets test | `assets.test.ts` (fails with the old file restored) |
| FE-021 | P3 | Fixed | Dev clock polled only by developers | `state/weather.tsx` |
| FE-022 | P3 | Fixed | Suspension end in the account's zone | `services/moderation.test.ts` |
| FE-023 | P3 | Fixed | No repeated heading | `screens/PolicyUpdateScreen.tsx` |
| A11Y-001 | P2 | Fixed | Letter, document and sheet regions focusable | browser; `components/LetterModal.tsx`, `PolicyDialog.tsx` |
| A11Y-002 | P2 | Fixed | Inactive tabs and nav labels use `--text-secondary`; nav 11 px (`--min-type`); day subline shadowed | CSS; not re-measured with a contrast tool |
| A11Y-003 | P2 | Fixed | Account sheet portaled, `aria-modal`, background inert | browser: Tab ×20 stays inside; Escape returns focus |
| A11Y-004 | P2 | Fixed | `aria-describedby` on the decision text | `components/dialogs.test.tsx` |
| A11Y-005 | P2 | Fixed | `lib/modal.ts` document-level keys, topmost dialog only | `components/dialogs.test.tsx` (focus on body; stacked modals) |
| A11Y-006 | P3 | Fixed | `components/Tabs.tsx` roving tabindex, arrows, real panels | `components/dialogs.test.tsx`, browser |
| A11Y-007 | P3 | Fixed | Admin menu: Escape, outside click, arrows, focus | browser |
| A11Y-008 | P3 | Fixed | Fallback no longer `aria-hidden` | `components/ShoreScene.tsx` |
| A11Y-009 | P3 | Fixed | One tab stop per radiogroup with arrows; map shore pins out of the tab order | `screens/ShoreSetupScreen.tsx` |
| A11Y-010 | P3 | Fixed | Status roles; stated reasons for disabled release buttons; Nav badge text | `screens/screens.test.tsx` (status) |
| A11Y-011 | P3 | Fixed | Release sequence is a modal; focus on Skip; Escape skips | `components/ReleaseSequence.tsx` |
| A11Y-012 | P2 | Fixed | Bottle list toggle; always listed without WebGL | browser |
| A11Y-013 | P3 | Fixed | `restoreFocus()` falls back to the screen heading | `lib/modal.ts` |
| QA-003 | P1 | Fixed (component layer); no Playwright suite in CI | jsdom + Testing Library; tests for draft recovery, decision notice, deletion, consent, tabs, modals, restricted screen, block | 5 new web test files; the browser script is not in CI |
| QA-008 | P1 | Fixed | Sign-out and draft promises proven by behaviour; greps kept as backstop | `state/session.test.tsx`, `screens/WriteScreen.test.tsx`, `lib/draft.test.ts` |
| SEC-018 | P3 | Partly fixed | Admin evidence flags bidi/zero-width controls and shows them made visible | `letter.test.ts`. Refuse/strip: Decision D9 |
| SEC-019 | P3 | Fixed | Tile key documented as public; configured attribution rendered; CSP note in Caddyfile | `.env.example`, README |

### Test quality and the P3 tail (Batch 4, QA)

| ID | Sev | Status | Fix | Verification |
| --- | --- | --- | --- | --- |
| QA-009 | P2 | Fixed | Fresh temporary database per test in `grant-role.test.ts` | each of 7 tests passes alone (`-t`); 3 runs with `--sequence.shuffle` |
| QA-010 | P2 | Fixed | Coordinates regex replaced by closed key sets for `/auth/me`, `/friends`, `/notifications` (non-empty lists) | `http/app.test.ts` |
| QA-011 (+ QA-026 risk bullets) | P2 | Fixed | Bottle ids pinned in the risk suite; cap and 80 % cutoff asserted unconditionally and separately; catch-up test deterministic through a loss; FK-off rewiring, 5,000-iteration search and 30 s timeout removed | `services/risk.test.ts`: `maxRiskDecisions = 6` fails 3/3 runs; `progressCutoff = 0.9` fails; 5 consecutive clean runs |
| QA-012 | P2 | Fixed | Admin and dev route lists enumerated from the Hono router (12 admin, 7 dev); a probe proves a route registered before the middleware would be caught | `http/roles.test.ts` |
| QA-013 | P3 | Fixed | Temporary folders removed in `afterAll` / `onTestFinished` | `db/compat.test.ts`, `db/migration.test.ts`, `http/auth.test.ts` |
| — slow test | — | Fixed | `lib/password.test.ts` queue test hashed 69 times before starting and timed out under load; now hashes once | `lib/password.test.ts` |
| QA-014 | P2 | Fixed | One route-level test per uncovered route, incl. `POST /api/dev/arrive` | `http/routes-coverage.test.ts`, `http/friends-flows.test.ts` |
| QA-015 | P2 | Fixed | Tautological zone loop and two tautologies replaced by assertions that can fail | `apps/web/src/lib/oceanWeather.test.ts` |
| QA-016 | P2 | Fixed | `journeyDurationMs` unit tests + real-graph shorter-route assertion | `domain/routing-duration.test.ts` |
| QA-017 | P2 | Fixed | Mutual request, self/duplicate/friend/stranger refusals, block route | `http/friends-flows.test.ts` |
| QA-021 | P2 | Fixed | A failed migration rolls back whole and the schema check refuses to boot; recorded-but-missing objects refused | `db/partial-migration.test.ts` (15 historical populated cut points are still not each exercised) |
| QA-022/023/024 | P2 | Fixed where testable in-process | Release to a deleted recipient; suspended recipient (pins current behaviour, Decision D14); sender blocks after release (cancelled, counted as such); AI timeout vs refusal; per-address report/appeal budgets; UTC+14 and UTC−11 account nights. Two processes: prevented by the lock (ARCH-004) | `services/recovery-paths.test.ts`, `http/friends-flows.test.ts`, `http/routes-coverage.test.ts` |
| QA-019 | P3 | Fixed (naming); merge branch is Decision D13 | Two different reporters of one letter are unreachable (one recipient or one finder; unique reporter index); tests renamed to what they prove | `services/moderation.test.ts`, `http/appeals.test.ts` |
| QA-025 | P3 | Partly fixed | v0.2 citations retired (`bottle-state.ts`, README, ARCHITECTURE); spec §11 "As built" and §18 reconciled; `docs/FONTS.md` (Special Elite Apache-2.0, five OFL-1.1, verified from package licences); spec status line names the sections that still carry old wording | docs review. Remaining spec prose: open documentation debt |
| QA-026 | P3 | Fixed | Per-world idempotency counter in `moderation.test.ts`; risk-suite items under QA-011 | `services/moderation.test.ts` |
| — tick counting | — | Fixed (found during QA-024) | `runJourneyTick` reports refused arrivals as `cancelled`, not `delivered` | `http/friends-flows.test.ts` |
| ARCH-022 | P3 | Fixed | (Batch 1) | `http/hardening.test.ts` ARCH-022 (fails if raw issues are returned) |

## Decisions needed

Nothing below was decided by this work. Each item names what was built around it.

| # | Finding | Decision | What exists now |
| --- | --- | --- | --- |
| D1 | SEC-010 | May an administrator revoke or reopen a wrong decision outside the appeal, and must a second administrator confirm suspensions, bans or critical actions? Published Terms say only an accepted appeal removes a violation, so a revoke path needs a legal text change first. | Recusal and evidence-digest checks; no revoke path |
| D2 | ARCH-013 | When a waived warning is later escalated to a critical ban, does a new appeal opportunity open? | Unchanged behaviour: no new appeal |
| D3 | SEC-004 | Keep `email_taken` at registration (usability) or answer neutrally and verify by email (needs SMTP)? | Unchanged; the registration budget per address limits enumeration speed |
| D4 | SEC-011 | Is tamper evidence required for the moderation audit trail (hash chain, off-host append-only copy)? | Readable and exportable; not tamper-evident |
| D5 | SEC-012 | An absolute retention cap for evidence whose living sender never answers the decision notice (the case never becomes final). | Deleted senders are handled; living absent senders are not capped |
| D6 | ARCH-005 | Shore capacity semantics: should an unopened delivered letter hold a place forever, expire, or count per recipient rather than per shore? | Unchanged |
| D7 | ARCH-010 | Default zone (and so storm nights) for an account whose device never reports one. Today such journeys carry no risk. | Zone changes rate-limited |
| D8 | ARCH-028 / FE-016 | Offer unblock? The dialog currently says a block cannot be undone, which is true. | Confirmation dialog |
| D9 | SEC-018 | Refuse, strip or keep invisible bidi/zero-width controls in letters (they are legitimate in real RTL text). | Moderators are warned and shown them |
| D10 | ARCH-002 backfill | Run `deletion:backfill --apply` on the real database for accounts deleted before the fix? Dry run first; back up first. | Tool ready, dry run by default |
| D11 | Privacy | Retention periods for notifications and journey history, which the Privacy Policy does not bound. | Unchanged |
| D12 | FE-011 | Should a letter found adrift stay with the finder, or remain read-once? | Copy now says read-once |
| D13 | QA-019 | Keep or retire the multi-reporter merge branch (`reportCount`, `reports[]`, "reporters' explanations") that the model cannot reach. | Branch kept; tests renamed |
| D14 | QA-024 | A letter released to a suspended recipient is delivered and waits until the suspension ends. Intended? | Pinned by `services/recovery-paths.test.ts` |
| D15 | Legal wording | (a) A banned account can still read its notification inbox (Terms list what it may do; the inbox is not named). (b) For a shore letter the reporter is identifiable by construction; the Privacy wording promises anonymity without that qualification. | Unchanged |
| D16 | Operations | Host, domain, SMTP provider, backup schedule and off-site copy, log retention (`docs/DEPLOYMENT.md`, "Decisions this contract leaves to the operator"); enabling GitHub branch protection so CI blocks merges. | Contract and tooling in place |
| D17 | Product | Journey pace (`MIB_MS_PER_CHART_UNIT`, spec D01) and shore capacity default (spec D06). | Provisional defaults |

## Gaps in the remediation plan

`05-remediation-plan.md` assigned no batch to ARCH-008 (P1), FE-004, FE-005, FE-006, FE-008 or
FE-011 (P2). They were fixed here anyway (Batch 4) and are marked in the tables above.


## Stage 1 — production runtime and fail-closed development controls

Branch `fix/production-runtime`.

| Finding | Severity | Status after Stage 1 |
| --- | --- | --- |
| **DEPLOY-001** (= ARCH-001, SEC-001, QA-002) — development mode on by default; unauthenticated `/api/dev/outbox` exposing reset links; seeded accounts with a published password | P0 | **Fixed.** `MIB_DEV_MODE` defaults to `false` and must be exactly `true`/`false`; `true` is refused in production (compiled artefact or `NODE_ENV=production`). The outbox sits behind the same `requireAuth` + `requireDeveloper` gate as every other dev route (401 anonymous, 403 member/admin), and in production `/api/dev/*` is not mounted (404). Development accounts are created only in explicit dev mode, and never by a production build. The signed-out outbox reader was removed from the web recovery screen. Regression tests: `apps/api/src/config.test.ts`, `apps/api/src/http/dev-mode.test.ts`. |
| **SEC-003** — outbox registered before authentication | P2 | **Fixed** as part of DEPLOY-001. |
| **ARCH-006** — no deployable artefact, no host, no backup, no persistent-storage contract | P0 | **Partly fixed.** The API now builds to runnable JavaScript (`apps/api/dist`, `node dist/server.js`), `pnpm --filter @mib/api deploy --prod --legacy <dir>` produces a production-only artefact with no TypeScript runtime, production requires an absolute `MIB_DATABASE_PATH`, and the server stops cleanly on `SIGTERM`. **Still open (Stage 2):** hosting, reverse proxy and TLS, serving the web bundle, persistent volume, backup and restore drill, SMTP. |
| **ARCH-016** — no graceful shutdown | P2 | **Fixed** (needed for the artefact's clean-stop proof). |
| **QA-001** — no CI | P1 | **Partly fixed.** `.github/workflows/ci.yml` runs format, lint, typecheck, the test suite, both production builds, a fresh migration with the compiled migrator, and the production-artefact smoke on every pull request and push to `main`. **Still open:** `apps/web` still runs `vitest --passWithNoTests`; branch protection must be enabled in GitHub for CI to block merges. |

Supporting changes in this stage:

- `esbuild` is now a direct devDependency of `@mib/api`, pinned to 0.28.2, the version the
  lockfile already installed for `tsx` and Vite. No package was upgraded or newly downloaded.
- `@mib/shared` moved from `dependencies` to `devDependencies` of `@mib/api`: it is bundled into
  the artefact, so production installs no longer need the workspace link.
- The four `report budgets` tests in `apps/api/src/services/moderation.test.ts` have an explicit
  30-second timeout. They took about 4.7–5.1 s against the 5 s default on unmodified `main` too
  (every release rebuilds the sea graph: QA-006), so CI failed at random. No assertion changed.
  Remove the timeout once QA-006 is fixed. *(Removed on `fix/audit-remediation`: with QA-006
  fixed each test takes about a second.)*

Everything else in the audit is unchanged by this stage.
