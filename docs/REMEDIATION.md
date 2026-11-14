# Remediation status

Tracks fixes for findings from two audits, both kept in `docs/audits/` (see its README for
provenance):

- the pre-deployment readiness audit (audited commit `5ba32c2`; reports `00`–`05` in
  `docs/audits/pre-deployment-readiness/`), verdict **NO-GO**, 100 findings;
- the pre-production re-audit (audited commit `a04526f`; reports `00`–`06` in
  `docs/audits/pre-production-rerun/`), 55 findings. Every one is accounted for in
  "Re-audit closure" at the end of this file.

The work, all merged to `main` unless said otherwise:

- `fix/production-runtime` (Stage 1, merged as `f89e35c`) — recorded below under "Stage 1".
- `fix/audit-remediation` — Batches 1–4 of `05-remediation-plan.md`.
- `fix/product-decisions` — the owner's decisions D1–D17.
- `fix/final-release-blockers` — the re-audit's P1s and the first P2s.
- `fix/backlog-remediation` (not merged) — the remaining re-audit findings.

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
| SEC-012 | P2 | Partly fixed | Deleting an account closes its unused appeal (system audit row `appeal_waived`), so the case becomes final and is redacted at the end of the retention window (seven days at the time; 30 days since decision D5) | `services/deletion-sweep.test.ts`. Absent-but-living senders: Decision D5 |
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

## Decisions (resolved on `fix/product-decisions`)

The owner's product decisions replaced the open items below. Each row names what was built and
the tests that pin it. Paths are relative to `apps/api/src` unless they start with `apps/`,
`packages/` or `docs/`.

| # | Decision | Status | Implementation | Tests |
| --- | --- | --- | --- | --- |
| D1 | Decisions are final except through the sender's one appeal. One administrator, no second approval, no admin revoke, reopen or reverse. Reasons required for upholding and rejecting (reports and appeals); the consequence is shown before confirming. | **Resolved** | `http/routes/admin.ts` `requireReason`; no revoke route exists; `apps/web/src/screens/AdminScreen.tsx` (finality sentence, consequence, mandatory reason in every dialog) | `http/moderation-decisions.test.ts` (reasons, no revoke/reopen routes) |
| D2 | Three decisions: reject; uphold ordinary; confirm critical child safety (immediate permanent ban). Critical needs a written reason and a strong confirmation, is audited (admin, time, classification, reason, action), withdraws the letter and allows one appeal. Escalating a waived or lapsed ordinary violation opens one new appeal. AI never decides; a possible child-safety flag marks the case urgent and puts it first, without ever holding it back. | **Resolved** | `services/admin.ts` `decideCaseCritical` (reopen + `appeal_reopened` audit), `listCases` ordering; `services/ai-review.ts` `childSafety`, `markUrgentChildSafety`; `config.ts` refuses `MIB_AI_AUTO_DECIDE=true`; migration 0015 (`ai_child_safety`, `urgent_at`, `appeal_window_starts_at`, `appeal_reopened_at`) | `http/moderation-decisions.test.ts`, `services/moderation.test.ts` (AI never decides; urgent flag), `services/authority.test.ts`, `apps/web/src/components/dialogs.test.tsx` (reopened appeal) |
| D3 | Keep the explicit `email_taken` message ("This email is already registered. Sign in or reset your password.") as an **accepted tradeoff**: it tells whoever types an address that it has an account. Registration stays rate-limited per address and per network; forgot-password never enumerates. | **Resolved (accepted risk)** | `packages/shared/src/auth.ts` `EMAIL_TAKEN_MESSAGE`; `services/auth.ts`; `apps/web/src/screens/LoginScreen.tsx` | `http/recovery.test.ts` (exact message), `http/smtp-reset.test.ts` (non-enumeration) |
| D4 | Moderation audit tamper evidence. Decided: `moderation_audit` stays append-only through every application route, and production must also export every moderation event to an external append-only or immutable logging destination, chosen with the hosting and logging provider. No custom cryptographic scheme inside SQLite. | **Resolved as a production deployment dependency** | `docs/DEPLOYMENT.md` §2b and checklist item 10; `docs/ARCHITECTURE.md` (Audit). The local SQLite table is **not** tamper-evident by itself | — |
| D5 | Evidence (copied letter, reporter explanations, AI translation and notes) is kept 30 days from the human decision — the same window as the appeal, on server time. A timely appeal keeps it until the appeal is decided; it is redactable at the later of the two. Never kept longer because a notice was not opened. Legal and child-safety holds extend it and record who, when and why. Metadata, audit and violations stay. | **Resolved** | `services/retention.ts` `finalityOf` (anchor = later of decision and reopened window), redaction also clears AI translation and notes; `services/moderation.ts` `appealDeadline`, `submitAppeal` 409 `appeal_expired`; `MIB_RETENTION_DAYS` | `services/retention.test.ts`, `http/moderation-decisions.test.ts` (window, expiry, last-day appeal), `http/appeals.test.ts` |
| D6 | Shore capacity is 100 bottles per recipient: travelling plus delivered-unread. Atomic reservation; a full shore refuses without creating a journey, the draft is kept, the message is privacy-safe. One notice per full episode. Each slot is released exactly once at open or any terminal state. No hidden queue. | **Resolved** | `services/release.ts` `heldForRecipient`, `noteShoreFullness`; `services/journey.ts` `releaseCapacityOnce` (clears `users.shore_full_since`); `MIB_SHORE_CAPACITY` (default 100). The legacy per-shore `shores.capacity` column no longer enforces anything | `http/shore-capacity.test.ts` (110 concurrent releases → exactly 100 accepted), `services/release.test.ts`, `services/journey.test.ts`, `apps/web/src/screens/WriteScreen.test.tsx` |
| D7 | One authoritative map clock per account (final): the latest valid device IANA zone the server accepted, else the harbour's zone, else UTC, used for both the map's day/night and storm eligibility on every device. Daytime maps have no storm; each night entered rolls a deterministic 25% storm, persisted, at most one roll per rolling 24 hours; the storm lies wholly inside the night and its midpoint takes one independent decision per eligible bottle. A zone change moves only future state, never rerolls inside 24 hours, never changes release, route, duration, arrival, past decisions, notifications, deadlines or rate limits; a pre-midpoint storm turned to day is cancelled and stays consumed. | **Resolved (risk policy v4)** — the earlier conflict with policy v3 is gone: v3's per-bottle storms are replaced, not patched | `packages/shared/src/weather.ts` (v4 section), `services/weather.ts`, `services/risk.ts`, `GET /api/ocean/weather`, `apps/web/src/state/weather.tsx`; migrations `0016_account_storms`, `0017_account_zone_backfill` | `services/account-storms.test.ts` (19), `services/risk.test.ts`, `packages/shared/src/risk.test.ts`, `services/recovery-paths.test.ts` (date line), `db/migration.test.ts` (backfill), `apps/web/src/state/weather.test.tsx`, `apps/web/src/lib/oceanWeather.test.ts` |
| D8 | Settings → Blocked users → Unblock, behind a confirmation. Allows future contact and public-ocean encounters; restores no letter and no friendship; reveals nothing. A finder can block the anonymous writer during the reading; that entry is named and undone by the bottle, never by the writer's name. | **Resolved** | `services/friends.ts` `listBlocked`, `unblockUser`, `blockFoundWriter`, `unblockFoundWriter`; `blocks.found_bottle_id` (migration 0015); `apps/web/src/components/BlockedUsersDialog.tsx`, `LetterModal.tsx` | `http/unblock.test.ts` (both directions, finder block), `apps/web/src/screens/screens.test.tsx` |
| D9 | Reject — not strip — the direction controls U+202A–U+202E and U+2066–U+2069, with a clear message. Zero-width joiners, LRM/RLM/ALM and ZWNJ stay allowed, so Hebrew, Arabic, Persian, emoji and punctuation are unaffected. Client and server both check; the server decides. Moderation still reveals controls in stored letters. | **Resolved** | `packages/shared/src/letter.ts` `DIRECTION_CONTROLS`, `validateLetterText`; `services/release.ts` `letter_direction_controls` | `packages/shared/src/letter.test.ts` (mixed scripts, spoofing samples), `http/letter-controls.test.ts`, `apps/web/src/screens/WriteScreen.test.tsx` |
| D10 | Historical deletion backfill on the real database | **Open (owner-operated)** | Tool ready, dry run by default; since `fix/backlog-remediation` it applies every current deletion rule (ARCH-R-006). Not run by development work. Not needed if production starts from a fresh database | `services/deletion-sweep.test.ts` |
| D11 | User-visible notifications are never deleted automatically (type, entity, time, read state are kept; marking read clears only the badge); history is paginated. Operational data (delivery attempts, retries, worker state, provider errors) may be pruned after 90 days. Cleanup never deletes letters or journeys. | **Resolved** | `services/notifications.ts` `notificationPage`; `http/routes/notifications.ts` (`?before=&limit=`); `services/housekeeping.ts` `OPERATIONAL_LOG_KEEP_MS`; `apps/web/src/screens/NotificationsScreen.tsx` "Load older" | `http/notification-history.test.ts`, `services/housekeeping.test.ts` |
| D12 | Finder: one reading, once (amended 2026-09-26: the 15-minute resume was removed); never in Received, archive or history; no friendship or access; report and block available while the reading is open; finishing is explicit and confirmed. | **Resolved** | `services/outcomes.ts` `openPublicBottle` (serves once; a second open is `409 reading_closed`); finder block above; `apps/web/src/components/LetterModal.tsx`, `apps/web/src/state/letterReader.ts` | `services/finder.test.ts`, `services/risk.test.ts`, `http/routes-coverage.test.ts`, `apps/web/src/components/LetterModal.test.tsx` |
| D13 | Keep the multi-reporter merge as deliberate, forward-compatible behaviour: several reports make one case and at most one violation. | **Resolved** | `services/moderation.ts` (one open case per bottle) | `http/moderation-decisions.test.ts` (merge) |
| D14 | Suspended and banned accounts are hidden from friend lists, recipient choice and search (friendships kept), send and receive nothing; inbound bottles are cancelled once with capacity released, the sender sees only "Delivery unavailable", the suspended user gets no arrival notice. A locked standing shell (reason, end time, countdown, ban warning) allows only standing, a timely appeal, Support, deletion and sign-out; suspension ends automatically. A ban has the same shell without a countdown or an ordinary inbox. | **Resolved** | `services/restriction.ts`; `services/journey.ts` `commitArrival`; `services/friends.ts`; `http/routes/notifications.ts` `requireGoodStanding`; `apps/web/src/screens/StandingScreen.tsx`, `App.tsx` | `http/suspension.test.ts`, `services/recovery-paths.test.ts`, `apps/web/src/screens/screens.test.tsx` (countdown, expiry recheck, ban) |
| D15 | (a) Banned inbox: closed (see D14). (b) The reporter is not identified to the sender except where law requires; for a letter reported by its only recipient the sender can still infer who that was, which no wording or code can prevent. | **(a) Resolved; (b) documented** | Privacy/Terms wording unchanged in substance | — |
| D16 | Operations: host and domain, production secrets, the Gmail App Password, backup schedule and log retention, GitHub branch protection, store packaging | **Open (owner)** | See `docs/DEPLOYMENT.md` | — |
| D17 | Journey pace: keep the current constants; same-harbour delivery stays immediate; device time has no effect. | **Resolved (no retune)** | `domain/` constants unchanged | `domain/journey-pace.test.ts` |

Risk policy v4 also corrected one Privacy Policy sentence and the browser-storage line before
version 1.1 was ever released or accepted anywhere (it exists only on this branch), so 1.1 was
corrected in place rather than superseded.

Found and fixed while running the suite under load: a slow older password-reset email, delivered
after a newer one, withdrew the newer link (`services/auth.ts`, regression test in
`http/smtp-reset.test.ts`).

Legal documents moved to version 1.1 as a material change, so every account accepts again
through the existing re-acceptance gate (`http/policies.test.ts` pins a 1.0 acceptance being
asked again). See `docs/LEGAL_DOCUMENTS.md`.

## Final release blockers (`fix/final-release-blockers`)

From the pre-production re-audit (`docs/audits/pre-production-rerun/`). Only these five were in
scope; the audit's other findings are in "Re-audit closure" below.

| ID | Sev | Status | Fix | Regression tests |
| --- | --- | --- | --- | --- |
| SEC-R-001 | P1 | Fixed | `POST /api/account/delete` counts attempts per signed-in account (5 / 15 min) and per client address (10 / 15 min, trusted-proxy rules) *before* the password is checked, and answers 429. Each budget belongs to one caller, so exhausting it blocks no one else; the answer never depends on whether the password was right. `http/routes/account.ts` | `http/account-delete-limit.test.ts` (verification only inside the budget; independent budgets; forged left-most `X-Forwarded-For`; a 150-request flood gives no 503 and leaves sign-in, registration, reset and another deletion working), `apps/web/src/components/dialogs.test.tsx` |
| ARCH-R-002 | P1 | Fixed | When a decision leaves an account suspended or banned (upheld report, critical child-safety decision, appeal decision), `applyStandingEffects` settles what had already happened (due storm midpoints, then due arrivals), then cancels every bottle still travelling from it (slot released once, neutral "delivery unavailable", one sender notice, nothing to the recipient) and withdraws its unopened adrift listings. Delivered or opened letters, and adrift letters a finder opened, are untouched; nothing is restored when the restriction ends. `services/restriction.ts` `endOutboundJourneys` | `services/restricted-sender.test.ts` (warning, suspension, third-violation ban, critical ban, idempotency under retries, expiry, accepted appeal, late-worker arrival and storm races) |
| FE-R-001 | P2 | Fixed | A panel over a letter (report, block, finish) shrinks and scrolls inside the reader with its action row pinned; the footer is left out while it is open; short-landscape padding respects safe areas; the viewport resizes for the on-screen keyboard. `apps/web/src/components/LetterModal.tsx`, `ReportSheet.tsx`, `styles.css`, `index.html` | `apps/web/src/components/LetterModal.test.tsx`; browser check at 667×375, 740×360, 844×390, 390×844, 1280×800 |
| FE-R-002 | P2 | Fixed, then superseded | Backdrop, Escape and Close never end a finder's reading without an explicit, confirmed "Finish reading". The resume banner and the 15-minute window it relied on were removed on 2026-09-26 (D12 amended). `apps/web/src/components/LetterModal.tsx`, `apps/web/src/state/letterReader.ts` | `apps/web/src/components/LetterModal.test.tsx` |
| FE-R-003 | P2 | Fixed | The map's day, night and storm run on the server's clock: the latest `serverTime`, advanced with `performance.now()` and replaced by every answer (polls, return to the foreground). `apps/web/src/state/weather.tsx`, `lib/serverClock.ts` | `apps/web/src/state/weather-clock.test.tsx`; browser check (device clock ±12 h, changed while open, foreground resync) |

### Accepted risk: SEC-R-002 (ban evasion by deleting the account)

**Accepted by the owner for the current scale; not a release blocker; not implemented.** A
permanently banned person can delete their account and register a new one with the same username
and email.

- The permanent sanction applies to the banned account.
- Ban evasion remains prohibited by the Community Rules.
- SeaYou does not retain deleted identifiers (no email or username tombstone, no keyed-hash
  denylist) solely to prevent re-registration; deletion stays deletion.
- This may be reconsidered if real abuse occurs.

Nothing else about bans or deletion was weakened. Letters a banned account still had travelling
end at the ban (ARCH-R-002).

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
| **QA-001** — no CI | P1 | **Partly fixed.** `.github/workflows/ci.yml` runs format, lint, typecheck, the test suite, both production builds, a fresh migration with the compiled migrator, and the production-artefact smoke on every pull request and push to `main`. **Still open:** branch protection must be enabled in GitHub for CI to block merges (owner). *(Since then `apps/web` runs its own suite without `--passWithNoTests`, and CI also runs a browser and accessibility smoke.)* |

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

## Re-audit closure (`fix/backlog-remediation`)

Every finding of the pre-production re-audit (`docs/audits/pre-production-rerun/05-findings-matrix.md`,
55 after merging duplicates), with its state on `fix/backlog-remediation`. Each finding was
re-checked against the current code before it was changed. Commits are on that branch unless a
branch is named. **Fixed** means the code change and a test that fails without it are in place;
**Fixed (code)** means the code is done and an operator step named in the row is still required
in production; **Partly fixed** means part of the finding needs an owner decision, named in the
row; nothing is marked closed on documentation alone.

Commits: `0b61805` process lock · `c05f4e7` moderation · `b4da47e` configuration, sign-in, SMTP
· `a38854e` journeys and worker · `631f846` frontend · `ab0325a` browser smoke · `65d34f3` test
determinism · documentation in the commit that adds this section.

| ID | Sev | State | What changed | Test | Commit |
| --- | --- | --- | --- | --- | --- |
| SEC-R-001 | P1 | Fixed | Deletion budgets per account and address | `http/account-delete-limit.test.ts` | `fix/final-release-blockers` |
| SEC-R-002 | P1 | Accepted risk | Not implemented, by owner decision (above) | — | — |
| ARCH-R-002 | P1 | Fixed | Restricted senders' journeys end | `services/restricted-sender.test.ts` | `fix/final-release-blockers` |
| FE-R-001 | P2 | Fixed | Report panel scrolls in landscape | `apps/web/src/components/LetterModal.test.tsx` | `fix/final-release-blockers` |
| FE-R-002 | P2 | Fixed, superseded | Explicit finish; resume removed (D12 amended) | `LetterModal.test.tsx` | `fix/final-release-blockers` |
| FE-R-003 | P2 | Fixed | Map phase on server time | `apps/web/src/state/weather-clock.test.tsx` | `fix/final-release-blockers` |
| FE-R-004 | P2 | Fixed (block); cool-down not built | Block from an incoming request; the requester cannot ask again. A cool-down after Deny is a policy choice for the owner | `apps/web/src/screens/screens.test.tsx` | `631f846` |
| FE-R-005 | P2 | Partly fixed | The console says when automated review is off instead of "waiting for model". **Owner decision:** a reporter-chosen child-safety reason that marks a case urgent changes the urgency policy (D2) and was not added | `http/moderation-hardening.test.ts` | `c05f4e7` |
| FE-R-006 | P2 | Fixed | Heading focus on in-place view changes (write steps, preview, case and appeal views) | `apps/web/src/components/hardening.test.tsx` | `631f846` |
| FE-R-007 | P2 | Fixed | Load failure shows the error and Try again (Blocked users, Friends, admin queues) | `apps/web/src/components/hardening.test.tsx` | `c05f4e7`, `631f846` |
| FE-R-008 | P2 | Fixed | "Has a shore"; preview refusal is a status | — (wording) | `631f846` |
| FE-R-009 | P2 | Fixed | Slid-off entries kept between pages; "Unread" announced | `hardening.test.tsx` | `631f846` |
| ARCH-R-001 | P2 | Fixed (code) | Production refuses a database whose development accounts open with the published password. **Operator:** start from a fresh database (`docs/DEPLOYMENT.md` §1a) | `http/dev-mode.test.ts` | `b4da47e` |
| ARCH-R-003 | P2 | Fixed (code) | OS-held lock on `<db>.process-lock`, released on death, honoured across containers. **Operator:** one replica, local volume | `lib/process-lock.test.ts` (real second process, SIGKILL) | `0b61805` |
| ARCH-R-004 | P2 | Fixed (code) | `MIB_HOST`, loopback by default in production. **Operator:** do not publish the port when using `0.0.0.0` in a container | `config.test.ts`; artefact smoke | `b4da47e` |
| ARCH-R-005 | P2 | Fixed | Deletion, recipient restriction and harbour change settle due storms first; cancellation only before the midpoint | `services/settle-before-ending.test.ts` (fails on the old code) | `a38854e` |
| ARCH-R-006 | P2 | Fixed (tool) | Backfill runs the full, idempotent deletion pass. **Owner:** whether to run it (D10) | `services/deletion-sweep.test.ts` | `a38854e` |
| ARCH-R-008 | P2 | Fixed | Worker reads only due arrivals (≤ 1000 per tick) and accounts whose roll can be due | `services/journey-worker.test.ts` | `a38854e` |
| SEC-R-003 | P2 | Fixed | Party administrators: reporters, explanations and appeal text hidden; holds refused; evidence reads audited | `http/moderation-hardening.test.ts` | `c05f4e7` |
| SEC-R-004 | P2 | Partly fixed | Grant tool and start-up log report the administrator count and warn below two. **Owner decision:** two administrators, or an escalation path | `tools/grant-role.test.ts` | `c05f4e7`, `b4da47e` |
| SEC-R-005 | P2 | Fixed | A repeated critical confirmation changes nothing | `http/moderation-hardening.test.ts` | `c05f4e7` |
| SEC-R-007 | P2 | Partly fixed | Rate limits key IPv6 clients by /64. **Owner decision:** the sign-in lockout policy (account ceiling, progressive delay or other) | `http/client-address.test.ts` | `b4da47e` |
| QA-R-001 | P2 | Partly fixed | CI runs on pull requests and pushes. **Owner:** branch protection; no pull request has run it yet | — | — |
| QA-R-002 | P2 | Fixed | Playwright + axe smoke of the built app under the production CSP, in CI | `apps/e2e/tests/` | `ab0325a` |
| QA-R-003 | P2 | Fixed | Error boundary unit test and a contained chunk failure in the browser | `hardening.test.tsx`, `apps/e2e/tests/smoke.spec.ts` | `631f846`, `ab0325a` |
| FE-R-010 | P3 | Fixed | Blocked users closes on account change | — (one-line reset) | `631f846` |
| FE-R-011 | P3 | Fixed | Sign out and Delete account on the decision notice | `hardening.test.tsx` | `631f846` |
| FE-R-012 | P3 | Fixed | Radios directly in the radiogroup; focus to Anchor after a phone pick | browser smoke (axe `listitem` would fail) | `631f846` |
| FE-R-013 | P3 | Fixed | Empty side pane collapses (measured: map 295 → 595 px at 667×375) | `apps/e2e/tests/layout.spec.ts` | `ab0325a` |
| FE-R-014 | P3 | Fixed | No pointer copy without WebGL; sunk list entries count as seen; no WebGL attempt | — (WebGL-less browser not automated) | `631f846` |
| FE-R-015 | P3 | Fixed | Day or night instead of "dusk"; empty-state text in the secondary colour (contrast not re-measured over the 3D scene) | — | `631f846` |
| FE-R-016 | P3 | Fixed | Weather poll paused while hidden | — (same pattern as `useAsync`) | `631f846` |
| FE-R-017 | P3 | Fixed | `aria-describedby`; reference-counted inert | `hardening.test.tsx` | `631f846` |
| FE-R-018 | P3 | Fixed | Invalid token reads as an invalid link | `hardening.test.tsx` | `631f846` |
| FE-R-019 | P3 | Fixed | Storm label removed | — | `fix/manual-review-round-2` |
| ARCH-R-007 | P3 | Fixed | CI pins every released migration's content and order. The owner's database was found at 15 applied migrations by the re-audit, so it never ran the edited 0015 | `db/migration-immutability.test.ts` | `a38854e` |
| ARCH-R-009 | P3 | Fixed | Per-item fault isolation; health reports degraded or failing worker | `services/journey-worker.test.ts` | `a38854e` |
| ARCH-R-010 | P3 | Partly fixed | Harbour changes that move the map clock spend the zone budget. The budget is still in memory (resets on restart), as all rate limits are | `http/limits.test.ts` | `a38854e` |
| ARCH-R-011 | P3 | Fixed | Every numeric setting range-checked | `config.test.ts` | `b4da47e` |
| ARCH-R-012 | P3 | Fixed | Tools no longer need `MIB_APP_URL`; CI runs the migrator without it | `config.test.ts`; CI | `b4da47e` |
| ARCH-R-013 | P3 | Fixed | No notification for a deleted account | `services/notifications.test.ts` | `a38854e` |
| SEC-R-010 | P3 | Fixed | Malformed JSON → 400, nothing logged | `http/hardening.test.ts` | `b4da47e` |
| SEC-R-011 | P3 | Fixed (code) | STARTTLS required without implicit TLS; port/TLS mismatch refused. **Operator:** Gmail on 465 and one real reset e-mail | `http/smtp-reset.test.ts`, `config.test.ts` | `b4da47e` |
| SEC-R-012 | P3 | Fixed | A finder who reported can still block the writer; offered in the report sheet | `http/moderation-hardening.test.ts` | `c05f4e7` |
| SEC-R-013 | P3 | Fixed | Finder-reported notices say a finder read it | `http/moderation-hardening.test.ts` | `c05f4e7` |
| SEC-R-014 | P3 | Fixed | Reset e-mails budgeted per (address, requester) and per address overall | `http/recovery.test.ts` | `b4da47e` |
| SEC-R-015 | P3 | Fixed (code) | `MIB_AI_ENABLED` must be set in production; plain-http endpoint only on this machine. **Owner decision:** review on or off | `config.test.ts`; artefact smoke | `b4da47e` |
| SEC-R-016 | P3 | Fixed | Role changes in the audit trail | `tools/grant-role.test.ts` | `c05f4e7` |
| SEC-R-018 | P3 | Fixed | Cursor paging for cases and appeals | `http/moderation-hardening.test.ts` | `c05f4e7` |
| QA-R-005 | P3 | Fixed | Stale-claim release tested through the review tick | `services/deletion-sweep.test.ts` | `65d34f3` |
| QA-R-006 | P3 | Fixed | Same-millisecond paging, startup 401, suspension −1 ms, backfill counters | several | `65d34f3`, `a38854e` |
| QA-R-007 | P3 | Fixed | Structural instead of timed assertions; checked-in vitest config | `lib/password.test.ts`, `http/recovery-delivery.test.ts`, `services/recovery-paths.test.ts` | `65d34f3` |
| QA-R-008 | P3 | Fixed | Ids derived from the test name | `test/deterministic-ids.test.ts` | `65d34f3` |
| QA-R-009 | P3 | Fixed | This file, `ARCHITECTURE.md`, `DEPLOYMENT.md`, the spec's §22 note, the audit reports on the branch | — | documentation commit |
| QA-R-011 | P3 | Fixed | Populated upgrade from the 0014 era | `db/migration.test.ts` | `a38854e` |

Found while doing this work, outside the matrix:

- The production CSP reported zod 4's eval probe as a violation on every page load; the web app
  now sets zod's jitless mode (`ab0325a`).
- Hold audit rows and comments still described a seven-day evidence window; they now say the
  ordinary retention window (30 days, D5).
- The deletion counters for an old-style deletion now count real changes, so a second backfill
  reports zero.
