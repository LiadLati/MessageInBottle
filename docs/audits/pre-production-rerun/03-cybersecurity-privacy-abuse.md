# 03 — Cybersecurity, privacy and abuse resistance (pre-production re-audit)

**Audited commit:** `a04526f` (merged `main`), read-only worktree `rerun/wt-3`. All file references
are relative to the repository root, with line numbers from this checkout.

**Baseline:** `origin/audit/pre-deployment-readiness` → `docs/audits/pre-deployment-readiness/`
`03-security-privacy.md`, `00-executive-summary.md`, `05-remediation-plan.md`. Claimed statuses:
`docs/REMEDIATION.md`, each checked against the code. Accepted decisions (D1–D17 in
`docs/REMEDIATION.md` §Decisions): `docs/SeaYou_Product_Specification.md`, `docs/DEPLOYMENT.md`,
`docs/ARCHITECTURE.md`, and the legal texts in `packages/shared/src/policies.ts`.

This is a defensive report. It describes each weakness, its evidence and its fix. It deliberately
leaves out step-by-step attack procedures and exploit code. No credential, session token, reset
link, letter text or personal email address appears here.

---

## 1. Scope and method

- **Code review, done for this report.** I read the whole HTTP layer (`apps/api/src/http/**`:
  app wiring, all 13 routers, the middleware, client-address and security headers), the services
  for auth, deletion, admin, moderation, AI review, audit, retention, friends and restriction,
  `lib/{password,rate-limit,mail,process-lock,env,ids}.ts`, `config.ts`, `server.ts`,
  `db/seed.ts`, the shared zod schemas and the four legal texts. I also read the web client's
  reset-token handling, session storage and HTML sinks, and the reference `docs/deploy/Caddyfile`.
- **Live probes, run by the first reviewer.** That reviewer ran the probes against temporary
  local instances only (127.0.0.1:3221, throwaway SQLite files, a local fake SMTP sink and a local
  model stub), mostly against the compiled production artefact. Scripts and outputs are in
  `rerun/a3/` (`p01…p13*.mjs`, `out-p*.txt`, `prod*.log`, `dev*.log`,
  `smtp-capture.redacted.jsonl`, `ai-requests.jsonl`, `worker2.*`). **I re-checked every probe
  result used below against the code path that produces it.**
  - The outputs were unambiguous, so I did not re-run any probe.
  - I did one extra read-only check of the scratch probe databases (`a3/db/dev1.sqlite`,
    `dev2.sqlite`). It confirmed that the development-seeded accounts are present in the database
    the production artefact was started on (SEC-R-009).
- **Other inputs.**
  - Dependency audit (reported by the first reviewer, not re-run): `pnpm audit --prod` found no
    known vulnerabilities. A full audit shows 3 moderate advisories, all dev-only (esbuild via
    drizzle-kit, vitest, @vitest/mocker), none shipped in the artefact.
  - An incomplete earlier draft of this file (it stopped inside the first finding) was used only
    as a list of leads. Every claim in it was re-verified or dropped, and this report replaces it.
- **Out of scope / not done.**
  - No external network target.
  - The real development checkout and its database were not opened.
  - No change to the worktree.
  - No real SMTP provider and no real model were used.

---

## 2. Summary

| Severity | Count |
| -------- | ----- |
| P0       | 0     |
| P1       | 2     |
| P2       | 7     |
| P3       | 9     |

| ID        | Sev | Title                                                                                                                                                                                                                                           | Status                                                  | Confidence                 |
| --------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------- |
| SEC-R-001 | P1  | `POST /api/account/delete` has no rate limit. One signed-in account can exhaust the global password-hashing queue (site-wide sign-in, registration and reset outage) and guess its own password without limit.                                  | newly discovered (introduced alongside the SEC-006 fix) | confirmed                  |
| SEC-R-002 | P1  | A permanent ban, including a confirmed critical child-safety ban, is shed by self-deleting and re-registering the same username and email. The victim's block disappears with it.                                                               | newly discovered                                        | confirmed                  |
| SEC-R-003 | P2  | Recusal covers decisions only. An administrator who is a party to a case can read the reporters' identities and explanations (including an anonymous finder's) and can place or release the evidence hold on it. Evidence reads are not logged. | unresolved previous finding (SEC-010 remainder)         | confirmed                  |
| SEC-R-004 | P2  | With a single administrator (allowed by D1 and DEPLOYMENT §6), any case where that administrator is sender, recipient or reporter can never be decided. The administrator is immune and the evidence is kept indefinitely.                      | newly discovered                                        | confirmed                  |
| SEC-R-005 | P2  | Critical child-safety escalation is not idempotent. Each replay writes new audit rows, restarts the appeal window, clears the notice state and moves the retention anchor.                                                                      | newly discovered                                        | confirmed                  |
| SEC-R-006 | P2  | The API listens on all interfaces and has no bind-address setting, while the deployment contract requires `127.0.0.1` together with `MIB_TRUST_PROXY=true`. If it is directly reachable, the client chooses its rate-limit address.             | production-configuration dependency (with code gap)     | confirmed                  |
| SEC-R-007 | P2  | Address-keyed sign-in budgets can still lock a named account out, including a banned user's only route to appeal, from about ten addresses (IPv6 keyed per /128). A correct password is also refused.                                           | unresolved previous finding (SEC-008 remainder)         | confirmed                  |
| SEC-R-008 | P2  | The single-process lock is PID-based and PID-namespace-local. A second container on the same volume takes it over (always, when both run as PID 1).                                                                                             | newly discovered (ARCH-004 fix incomplete)              | confirmed                  |
| SEC-R-009 | P2  | The production artefact starts on a development-seeded database without warning. The four seeded accounts then sign in with the password published in the README.                                                                               | production-configuration dependency (with doc mismatch) | confirmed                  |
| SEC-R-010 | P3  | Malformed JSON returns 500 `internal` and logs a full stack trace per request, before any rate limit.                                                                                                                                           | newly discovered                                        | confirmed                  |
| SEC-R-011 | P3  | SMTP will authenticate and send reset links in cleartext if the server offers no STARTTLS (`MIB_SMTP_SECURE` defaults to `false`, no `requireTLS`, nothing enforced in production).                                                             | production-configuration dependency                     | confirmed                  |
| SEC-R-012 | P3  | A finder who reports an adrift letter (hide is the default) can no longer block its anonymous writer, contrary to D8/D12.                                                                                                                       | newly discovered                                        | confirmed                  |
| SEC-R-013 | P3  | When a public-ocean finder reports a letter, the sender's notice names the intended recipient, who never read it, pointing the sender at an innocent person.                                                                                    | newly discovered                                        | confirmed                  |
| SEC-R-014 | P3  | A third party can repeatedly spend a victim's password-reset budget (3 per email per hour).                                                                                                                                                     | newly discovered                                        | confirmed                  |
| SEC-R-015 | P3  | `MIB_AI_ENABLED` defaults to `true` and any `http://` endpoint is accepted. Both depart from the deployment contract and the Privacy Policy's "infrastructure the operator controls".                                                           | production-configuration dependency                     | confirmed                  |
| SEC-R-016 | P3  | Role grants keep only the latest grant on the users row. There is no history of who held admin or when it was revoked.                                                                                                                          | newly discovered (SEC-011 forensics remainder)          | confirmed                  |
| SEC-R-017 | P3  | There is no child-safety report reason. Without a running model, a child-safety report is never marked urgent.                                                                                                                                  | newly discovered                                        | confirmed                  |
| SEC-R-018 | P3  | Admin case and appeal lists are capped at 200 with no paging, so a report flood from sock-puppet accounts can push older pending cases out of view.                                                                                             | newly discovered                                        | theoretical (code reading) |

**Verdict for this scope: NO-GO** (criteria in §6). Every previous SEC P0/P1 is closed with
evidence (§5). The blockers are the two new P1s. Both are small fixes.

---

## 3. Coverage

"Result" states what holds today. Findings are cross-referenced; "no issue" means verified adequate.

| Area                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Authentication (sign-in, register, session resolution)  | No issue. The same 401 is returned for an unknown user, a wrong password or a non-active account. A dummy hash equalises timing (p05: 199.9 ms vs 198.8 ms median).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `apps/api/src/services/auth.ts:133-171`; `out-p05.txt`                                                              |
| Password hashing                                        | No issue in the hashing itself: scrypt N=2^16, r=8, p=1, 16-byte salt, constant-time compare, re-hash on sign-in (SEC-007 closed), async (SEC-006 closed). **But** the global queue (2 active, 64 waiting, then 503) can be saturated through an unlimited route: see SEC-R-001.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `apps/api/src/lib/password.ts:16-19,88-140`                                                                         |
| Reset-token lifecycle                                   | No issue. 256-bit token, only its SHA-256 stored, 30 min TTL, single use (a guarded update makes concurrent use 204/400), a newer token supersedes older ones only once delivered, the reset revokes every session, tokens die with account deletion, the token is stripped from the URL, `Referrer-Policy: no-referrer`. Residual (theoretical, negligible): `invalidatedAt` is re-checked outside the consuming transaction, so a narrow race between two valid tokens delivered to the same mailbox exists.                                                                                                                                                                                                                                                                                                                                                                              | `apps/api/src/services/auth.ts:196-312`; `apps/api/src/lib/ids.ts`; `apps/web/src/App.tsx:37-43`; `out-p06.txt`     |
| Session hashing and revocation                          | No issue. Sessions are stored as SHA-256 of a 256-bit token, 30-day TTL on real time, deleted on logout, reset and deletion. Role and status are re-read from the users row on every request. Tokens live in `sessionStorage`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `apps/api/src/services/auth.ts:54-69,161-178`; `apps/web/src/state/session.tsx:64-72`; `out-p06.txt`, `out-p12.txt` |
| Account and address rate limits                         | Present on sign-in, register, forgot, reset, report, appeal, time-zone and the public delete form. **Missing on `/api/account/delete`** (SEC-R-001). Lockout (SEC-R-007) and reset-budget exhaustion (SEC-R-014) remain. Limits are in-memory, per process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `apps/api/src/http/routes/auth.ts:33-63`; `legal.ts:27,76-79`; `moderation.ts:22-23`; `app.ts:32-34,82`             |
| Proxy trust / client address (`MIB_TRUSTED_PROXY_HOPS`) | Correct. The address is read right-most minus hops, and the socket peer is used when the header is shorter than the hop count (SEC-005 closed; p04: rotating left entries share one bucket). Safe only if the API is unreachable except through the proxy: see SEC-R-006.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `apps/api/src/http/client-address.ts:20-35`; `out-p04.txt`                                                          |
| Registration enumeration                                | `email_taken` is disclosed: **accepted product decision D3** (rate-limited per address). Forgot-password does not enumerate: 202 either way, not awaited (p05 medians 2.8 vs 1.7 ms with mail disabled).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `apps/api/src/http/routes/auth.ts:74-80,98-106`; `out-p05.txt`                                                      |
| Validation and request-size limits                      | zod on every body, with errors reduced to path/code/message. 64 KB body limit returns 413 (seen in `prod1.log`), and the proxy also caps at 64 KB. Usernames are `[a-z0-9_]`. Direction controls in letters are rejected (D9, p10 `422`). Malformed JSON gives a 500 (SEC-R-010).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `apps/api/src/http/app.ts:44-51`; `http/validate.ts`; `packages/shared/src/api.ts:9-14`; `out-p10.txt`              |
| Security headers                                        | No issue. API: CSP (`default-src 'none'`), XFO DENY, nosniff, no-referrer, COOP, Permissions-Policy, `Cache-Control: no-store` on `/api/*`, HSTS when the app URL is https. The web app's headers come from the Caddyfile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `apps/api/src/http/security-headers.ts`; `docs/deploy/Caddyfile`                                                    |
| HTTPS enforcement                                       | Production refuses a non-https `MIB_APP_URL`. TLS and the http→https redirect happen at the proxy. The API port itself is plain HTTP on all interfaces (SEC-R-006). SMTP TLS is not enforced (SEC-R-011).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `apps/api/src/config.ts:187-190`; `docs/DEPLOYMENT.md:101`                                                          |
| CORS / origin                                           | No issue. A single configured origin, no credentials. Auth is a bearer header (no cookies), so CSRF does not apply. The public delete form needs the password and has `form-action 'self'` and `frame-ancestors 'none'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `apps/api/src/http/app.ts:52`; `config.ts:210`                                                                      |
| Authorization on every admin/developer endpoint         | No issue. **Admin** (`/api/admin`, all behind `requireAuth` + `requireAdmin` + `requireGoodStanding`, `routes/admin.ts:44`): `GET /reports`, `GET /reports/:id`, `POST /reports/:id/accept`, `POST /reports/:id/reject`, `POST /reports/:id/critical`, `POST /reports/:id/hold`, `POST /reports/:id/hold/release`, `GET /audit`, `GET /appeals`, `GET /appeals/:id`, `POST /appeals/:id/accept`, `POST /appeals/:id/reject`. **Developer** (`/api/dev`, mounted only when dev mode is on, `app.ts:100`; `requireAuth` + `requireDeveloper` (role and dev mode) + `requireGoodStanding`, `routes/dev.ts:34`): `GET /outbox`, `GET /status`, `POST /advance`, `POST /arrive` (own bottle), `POST /lose` (own bottle), `POST /tick`, `POST /forget-policy-acceptances` (self). p02/p09: anonymous 401, member 403, admin→dev 403, developer→admin 403; in production `/api/dev/*` returns 404. | `apps/api/src/http/middleware/admin.ts:8-33`; `out-p02.txt`, `out-p09.txt`                                          |
| Suspended or banned administrator                       | No issue. A banned admin gets 403 on `/api/admin/*` and can still read standing (SEC-009 closed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `out-p02.txt` ("banned admin GET /api/admin/reports 403")                                                           |
| Moderation self-conflict prevention                     | Decisions: a party admin gets 403 `recused` on accept, reject, critical and appeal decisions. **Reads and holds are not covered** (SEC-R-003). There is a single-admin deadlock (SEC-R-004).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `apps/api/src/services/admin.ts:182-199,268,441,555`; `out-p02.txt`                                                 |
| Replayed moderation decisions                           | Accept and reject are idempotent (a replay gives 200 `changed:false`; the opposite outcome gives 409). The evidence digest is required (400 without it, 409 `stale_case` on mismatch). **The critical path is not idempotent** (SEC-R-005).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `apps/api/src/services/admin.ts:269-291`; `packages/shared/src/api.ts:732-735`; `out-p02.txt`                       |
| Audit-trail integrity                                   | Every standing-changing action writes its audit row in the same transaction. No application route updates or deletes audit rows: the only writer is an `insert` at `services/audit.ts:43`, and `GET /api/admin/audit` is read-only. The local SQLite table is **not** presented as tamper-evident (`services/audit.ts:12-13`, `docs/ARCHITECTURE.md:399-405`, `docs/DEPLOYMENT.md:72-82`). External immutable export is a **documented production dependency** (D4; DEPLOYMENT §2b says launch is blocked until it exists). No defect. Note: no export hook exists yet, so this needs integration work. Gaps in completeness: evidence reads (SEC-R-003) and role grants (SEC-R-016) are not audited.                                                                                                                                                                                       | as cited                                                                                                            |
| Report and appeal privacy                               | Sender-facing DTOs carry no reporter, report id or explanation (`ViolationNoticeSchema`, p02/p09 "sender view mentions finder? false"). Appeals are visible only to admins. Exceptions are SEC-R-003 (party admin) and SEC-R-013 (misattribution).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `apps/api/src/services/moderation.ts:309-330`; `out-p09.txt`                                                        |
| Reporter identity leakage                               | Not disclosed to an ordinary sender. When the only recipient reports, the sender can infer who it was: **accepted D15(b)** (p02 "standing mentions reporter username? true" is the recipient's name in "Your letter to …"). It **is** disclosed to a sender who is an administrator (SEC-R-003).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `out-p02.txt`, `out-p09.txt`                                                                                        |
| Anonymous finder blocking                               | Works during an open reading (D8), but not after reporting with the default hide (SEC-R-012). Block list entries are keyed by bottle and do not reveal the writer (p09 "reveals writer username? false").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `apps/api/src/services/friends.ts:196-222`; `out-p09.txt`                                                           |
| Child Safety escalation                                 | Human-only, with a mandatory reason, the literal classification and the digest. It bans immediately, withdraws the letter and keeps one appeal (D2). Defects: replay (SEC-R-005), no child-safety report reason (SEC-R-017), ban evasion (SEC-R-002).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `apps/api/src/services/admin.ts:541-691`                                                                            |
| AI prompt-injection handling                            | Adequate. The letter and explanations are passed as JSON strings (SEC-013 closed). The reply must match a strict schema, and a clear verdict that states any uncertainty is downgraded. p10: a letter carrying injected instructions produced only a recommendation, with standing unchanged, no violation and no decision. Oversized or garbage output was refused and re-queued.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `apps/api/src/services/ai-review.ts:60-80,120-144`; `out-p10.txt`                                                   |
| AI data exposure                                        | Only the evidence text, report reasons and explanations are sent: no user ids or usernames (p10 "any user id / username in any prompt? false"; `ai-requests.jsonl`). Defaults: SEC-R-015.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `apps/api/src/services/ai-review.ts:236-240`                                                                        |
| AI recommendation-only enforcement                      | No issue. `MIB_AI_AUTO_DECIDE=true` refuses boot. There is no code path from the worker to `decideCase` or `decideCaseCritical`. The model's only effect is `urgentAt` plus an audit row. (The stale header comment at `ai-review.ts:16-18` still mentions auto-decide; cosmetic.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `apps/api/src/config.ts:194-198`; `ai-review.ts:306-342`; `out-p10.txt`                                             |
| Evidence access and retention                           | Evidence is admin-only. Redaction happens 30 days after the decision, or after a timely appeal (D5), and clears the letter copy, explanations and AI text. A deleted sender's unused appeal is closed, so the case reaches finality (SEC-012 closed; p12 redacted with `MIB_RETENTION_DAYS=0`). Stale AI claims are released at boot and on each tick (ARCH-003). Undecidable cases are kept indefinitely (SEC-R-004). Reads are not logged (SEC-R-003).                                                                                                                                                                                                                                                                                                                                                                                                                                    | `apps/api/src/services/retention.ts:79-104,160-220`; `server.ts:40`; `out-p12.txt`                                  |
| Legal and immediate-safety holds                        | Documented: reason, note, who and when, audited on placement and release, and they survive account deletion (`deletion.ts:191-215`). A party admin can place or release them (SEC-R-003).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `apps/api/src/services/admin.ts:698-768`; `out-p02.txt`                                                             |
| Account deletion                                        | Correct and transactional. Sessions and resets are removed, identifiers cleared, letters cleared (except held evidence), adrift listings withdrawn (SEC-002 closed), inbound journeys ended, unused appeals closed. p12: deleted sender listed 0, stranger 409, finder reading ended, text cleared, sessions and resets 0, old token 401. The public form is rate-limited. Missing: the in-app route's limit (SEC-R-001) and ban persistence (SEC-R-002).                                                                                                                                                                                                                                                                                                                                                                                                                                   | `apps/api/src/services/deletion.ts:127-416`; `out-p12.txt`                                                          |
| Logs and secret handling                                | No secrets in the repo (`.env*`, `*.sqlite` git-ignored). Config errors never echo values. Request logs hold paths and ids only. The four probe server logs contain no probe password, 64-hex token, reset link or probe email. The reset-mail failure log records only the transport's error message; a provider rejection message can include the recipient address (theoretical, minor). Stack-trace noise: SEC-R-010.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `.gitignore`; `apps/api/src/config.ts:28-32`; `services/auth.ts:262-265`; `a3/prod*.log`                            |
| SMTP configuration                                      | The adapter is sound (lazy nodemailer, host required). TLS is not enforced: SEC-R-011. The documented Gmail setup uses 465 with `secure=true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `apps/api/src/lib/mail.ts:36-70`; `docs/DEPLOYMENT.md:51-60`; `smtp-capture.redacted.jsonl`                         |
| Dependency vulnerabilities                              | No issue. The production tree is clean; 3 moderate advisories are dev-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | first reviewer's `pnpm audit`                                                                                       |
| Dev routes and production defaults                      | Dev mode defaults to off and is refused in production. The outbox provider is refused outside dev mode. The seed refuses in a production build, and `db:reset` refuses outside dev mode. Production requires an absolute database path. Residual: SEC-R-009 (dev database reuse), SEC-R-015 (AI default), SEC-R-006 (bind).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `apps/api/src/config.ts:168-190,238-239`; `db/seed.ts:161,239`; `db/reset.ts:10`                                    |

**Abuse scenarios**

| Scenario                                     | Result                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reset-flow takeover                          | Blocked. Tokens are single-use, short-lived and hashed. Older tokens die once a newer one is delivered, and a reset revokes all sessions (`out-p06.txt`).                                                                                                                       |
| Unauthenticated reset-link access            | Blocked. The outbox is dev-only and behind the developer role (p09: 401/403), and absent in production (404).                                                                                                                                                                   |
| Developer/admin privilege confusion          | Blocked. The roles are disjoint (developer→admin 403, admin→dev 403), and the developer role is inert without dev mode.                                                                                                                                                         |
| UI-bypass API calls                          | Blocked. Ownership is checked server-side (p11: stranger report or read 404, sender cannot report own letter). Decisions need a reason and a digest, critical needs the literal classification, and appeal/waive/acknowledge check the owner (`services/moderation.ts` guards). |
| Time-zone manipulation for extra storm rolls | Blocked. Invalid zones are refused before budget is spent. Flipping zones gave exactly one roll in 24 h, and 8 concurrent changes gave 4×200 + 4×429 and one roll (`out-p07.txt`; D7).                                                                                          |
| Replayed moderation decisions                | Accept and reject are safe. Critical is not: SEC-R-005.                                                                                                                                                                                                                         |
| Duplicate risk-worker execution              | Data held: 79 bottles, no duplicated events or notifications. The process lock can be bypassed and the second writer causes `SQLITE_BUSY` 500s: SEC-R-008 (`out-p08.txt`).                                                                                                      |
| Forged proxy headers                         | Blocked behind a correctly configured proxy (left entries ignored). Effective if the API port is reachable directly: SEC-R-006 (`out-p04.txt`).                                                                                                                                 |
| Oversized or malformed bodies                | Oversized → 413. Malformed → 500 plus a stack trace: SEC-R-010.                                                                                                                                                                                                                 |
| Bidi/invisible control characters            | Letters: direction controls are rejected by client and server (D9, p10 `422 release_rejected`), and admin evidence reveals them. Usernames are ASCII. Report explanations and appeal text are free text shown only to admins (minor, no finding).                               |
| Report-budget abuse                          | Durable per-account budgets (10 per hour, 40 per day), a per-address budget of 40 per hour, duplicates are free, and only readers can report (`out-p11.txt`). A report changes nothing for the sender until a person decides. Residual: queue burying, SEC-R-018.               |
| Reporter-identity disclosure                 | Ordinary senders: no disclosure (apart from the accepted D15(b) inference). Admin-senders: SEC-R-003. Misattribution: SEC-R-013.                                                                                                                                                |
| Attempts to make AI decide or sanction       | Blocked. Config refuses auto-decide and no code path exists. Injection produced a recommendation only (`out-p10.txt`).                                                                                                                                                          |

---

## 4. Findings

### SEC-R-001 — P1 — `POST /api/account/delete` has no rate limit: one account can take down all password operations and guess its own password without limit

- **Status:** newly discovered. It comes from the SEC-006 fix (a bounded global scrypt queue)
  combined with a route that has no limiter. **Confirmed.**
- **Evidence**
  - `apps/api/src/http/app.ts:32-34` says one limiter serves "every route that checks a password",
    but `accountRoutes()` is mounted without it (`app.ts:82`).
  - `apps/api/src/http/routes/account.ts:13-19` guards the route with `requireAuth` only, then runs
    a full scrypt verification (`services/deletion.ts:66-74`).
  - `apps/api/src/lib/password.ts:88-106`: one process-wide queue of 2 active and 64 waiting jobs;
    past that, every hash anywhere fails with 503 `busy` (`app.ts:110-116`).
  - `out-p03.txt`: 60 sequential wrong passwords returned 401 ×60, with no 429.
  - `out-p03b.txt`: one account and one session sustaining concurrent requests returned
    `{"401":97,"503":1983}`, and **10 of 10 bystander sign-ins returned 503** during the flood.
- **Reasoning:** the route is the only password-checking endpoint with no per-account,
  per-session or per-address budget, so one cheap account can keep the shared queue full.
- **Impact**
  - Availability: sign-in, registration, password reset, both deletion paths and re-authentication
    fail for every user while the flood runs. That includes suspended and banned users, whose
    remaining rights are to sign in and appeal. It needs no second address and survives a
    correctly configured proxy.
  - Confidentiality: anyone holding a stolen session token can guess that account's password at
    hashing speed with no lockout. A correct guess also deletes the account.
- **Recommended fix**
  - Pass the shared limiter into `accountRoutes`.
  - Charge the same per-account budget as sign-in (`chargeSignIn` keyed on the user's username
    and client address), plus a per-session budget of a few attempts per 15 minutes.
  - Refuse over-budget requests before hashing.
  - Consider reserving queue capacity for `/api/auth/login` so that no single route can starve it.
- **Regression test:** in `http/limits.test.ts`, make N+1 wrong-password calls to
  `/api/account/delete` with one session and expect 429 before any hash is computed. With the
  queue saturated from one session, a sign-in from another address must not return 503.
- **Related old ID:** SEC-006, ARCH-009.

### SEC-R-002 — P1 — A permanent ban (including a critical child-safety ban) is undone by self-deletion and re-registration with the same identity

- **Status:** newly discovered. **Confirmed.**
- **Evidence**
  - `apps/api/src/services/deletion.ts:253-271`: deletion replaces the username with a random
    value and nulls the email, so both become free for reuse.
  - `deletion.ts:223-226`: blocks are deleted in both directions, including blocks other people
    placed on the account.
  - Nothing links the new account to the violations of the old one: standing is derived per user
    id (`services/moderation.ts:261-275`), and registration checks only uniqueness
    (`http/routes/auth.ts:74-80`).
  - Deletion is deliberately allowed while banned (`routes/account.ts:8-10`).
  - `out-p13.txt`: after a confirmed critical child-safety ban and a block by the victim, the
    banned account deleted itself. The same username and email re-registered (201) in good
    standing, the victim's block list was empty, and the new account's friend request to the same
    victim was accepted (204).
  - `out-p12.txt`: a re-registered account also started at "good 0".
- **Reasoning:** the ban lives only on the old user id. Deletion both frees that id's identifiers
  and removes the only record (the block) that tied the victim to it.
- **Impact**
  - The Terms, Community Rules and Child Safety Standards promise a "permanent ban" and an
    "immediate permanent ban" for child-safety violations
    (`packages/shared/src/policies.ts:310-312,440,638`). Self-service defeats that in seconds,
    under the same recognisable username, and removes the victim's protection.
  - Creating a new account with a fresh email is inherently possible on any email-based service;
    this finding is the _same-identity_ reset, together with the loss of the block.
  - The Terms already reserve "limited records … for documented security and abuse prevention"
    (`policies.ts:334`), but none are kept.
- **Recommended fix**
  - When an account with a ban (or any critical violation) in force is deleted, keep a salted hash
    of its normalized email and its normalized username in a small denylist table. Refuse
    re-registration with either while the ban would still be in force.
  - Keep `blocks` rows where the deleted account is the _blocked_ party, keyed to those hashes, or
    carry them to a re-registration match.
  - Record the retention in Privacy Policy §8, which the Terms wording already permits.
- **Regression test:** ban (critical) → delete → re-register with the same email must return 409
  (and the same with the same username). The victim's block must survive the deletion.
- **Related old ID:** none (new). Touches D14 and D2.

### SEC-R-003 — P2 — A party administrator is recused from deciding, but can still read reporter identities and control the evidence hold on their own case

- **Status:** unresolved previous finding (SEC-010 remainder; REMEDIATION marks SEC-010 "Partly
  fixed"). **Confirmed.**
- **Evidence**
  - `apps/api/src/services/admin.ts:231-245` (`getCase`) and `128-136` return every reporter
    (`person(...)`) and explanation to any admin. Party status only sets a `recused` flag (`:176`).
  - `placeHold` and `releaseHold` (`admin.ts:698-768`) have no `assertNotParty`.
  - No read of a case or appeal writes an audit row.
  - `out-p02.txt`: a party admin read its own case with reporters and explanation visible, then
    released the hold another admin had placed (200) and re-placed it (200).
  - `out-p09.txt`: an admin who _sent_ an adrift letter saw the anonymous finder's username and
    explanation.
- **Reasoning:** recusal is enforced at the decision functions only; the read path and the hold
  functions never check whether the viewer is a party.
- **Impact**
  - Breaks "Whoever reported a letter is not identified to its sender"
    (`policies.ts:422,487`) and public-finder anonymity for any sender who holds the admin role,
    which creates a retaliation risk (worst for child-safety reports).
  - A party admin can shorten the retention of evidence against themselves by releasing a hold
    (bounded by the 30-day rule, but that defeats a legal hold).
  - Nothing records who read the evidence.
- **Recommended fix**
  - For a party viewer, `getCase`, `listAppeals` and `getAppeal` return a redacted detail (no
    reporters, explanations or letter text; the appeal view currently passes `viewerId = null`,
    `admin.ts:390`).
  - Apply `assertNotParty` to `placeHold` and `releaseHold`.
  - Write an `evidence_viewed` audit row per case-detail read (actor, case, time).
- **Regression test:** in `http/moderation-integrity.test.ts`, a party admin's GET of a case omits
  reporters, explanations and text, and hold/release returns 403 `recused`. A non-party admin's
  read writes one audit row.
- **Related old ID:** SEC-010, SEC-011.

### SEC-R-004 — P2 — With one administrator, the administrator's own cases can never be decided

- **Status:** newly discovered. It is a consequence of recusal combined with D1 ("One
  administrator") and `docs/DEPLOYMENT.md:130-131` ("grant at least one administrator").
  **Confirmed** (code, plus the observed 403 `recused` in `out-p02.txt`).
- **Evidence**
  - `apps/api/src/services/admin.ts:192-199` is applied to every decision path. No
    owner/CLI decision path and no escalation exist.
  - Pending cases are held indefinitely (`services/retention.ts:84`, `case_pending`).
- **Reasoning:** if the only admin is a party, the recusal guard refuses the one person who could
  decide, and nothing else can.
- **Impact:** in a single-admin deployment:
  - letters the administrator sends are un-sanctionable, so the admin is immune to moderation;
  - reports the administrator files, or letters sent to them, can never be decided;
  - the evidence copy and the reporters' explanations are kept indefinitely, contrary to the
    30-day rule (D5, Privacy §3).
- **Recommended fix** (pick one and document it):
  - require at least two administrators in DEPLOYMENT §6 and have startup warn when fewer than two
    exist; or
  - add an audited host-side CLI decision for recused cases, run by the owner, which records that
    the owner decided a case they were party to.
  - Either way, surface undecidable (all-admins-recused) cases in the retention plan.
- **Regression test:** with one admin who is the sender, the case appears as
  "no eligible reviewer" in the plan. The chosen escalation path decides it and writes an audit
  row.
- **Related old ID:** SEC-010 (side effect of its fix).

### SEC-R-005 — P2 — Critical child-safety escalation is not idempotent

- **Status:** newly discovered. **Confirmed.**
- **Evidence**
  - `apps/api/src/services/admin.ts:613-659`: `escalated = c.status === 'accepted'` is also true
    on every _repeat_ of a critical decision. With no appeal filed, `reopen` is true each time. It
    resets `appealWaivedAt`, `appealWindowStartsAt=now`, `acknowledgedAt` and
    `noticePresentedAt`, and writes `appeal_reopened` plus `critical_child_safety` again.
  - The digest guard does not stop a replay, because the evidence is unchanged.
  - `out-p02.txt`: three identical critical requests returned 200 three times. The audit showed
    `critical_child_safety, appeal_reopened` ×3, and `retention.finalAt` moved each time.
- **Reasoning:** the escalation branch treats "already critical" the same as "ordinary, being
  escalated".
- **Impact**
  - Duplicate audit entries for one decision (a double submit or a network retry is enough).
  - Each replay restarts the sender's 30-day appeal window and clears the "presented" and
    "acknowledged" state.
  - Evidence retention is extended each time without a documented hold.
  - A mis-click on "confirm" cannot be distinguished from a deliberate re-escalation.
- **Recommended fix:** if the violation is already `severity='critical'`, return the current case
  unchanged (`changed:false`), with no writes. Reopen the appeal only on the ordinary→critical
  transition.
- **Regression test:** critical twice → exactly one `critical_child_safety` row, at most one
  `appeal_reopened`, and `appealWindowStartsAt` and `finalAt` unchanged by the second call.
- **Related old ID:** none (D2 feature).

### SEC-R-006 — P2 — The API binds to all interfaces and has no bind setting, while trusting `X-Forwarded-For`

- **Status:** production-configuration dependency, with a code gap. **Confirmed.**
- **Evidence**
  - `apps/api/src/server.ts:108`: `serve({ fetch, port })` has no hostname, so
    `@hono/node-server` calls `listen(port, undefined)` and binds all interfaces. No `MIB_HOST`
    or `MIB_BIND` exists.
  - `docs/DEPLOYMENT.md:28` requires "bind the API to `127.0.0.1`" whenever
    `MIB_TRUST_PROXY=true`.
  - `apps/api/src/http/client-address.ts:28-33`.
  - `out-p04.txt`: with direct access, rotating the right-most XFF entry made 22 of 22 failed
    sign-ins return 401 with no 429 (compare the fixed address, which hit 429 after 10).
- **Reasoning:** the right-most XFF entry is trustworthy only when the proxy wrote it. If clients
  can reach the port directly, they write it themselves.
- **Impact:** if the host's firewall or container network exposes port 3001, every address-keyed
  budget (sign-in, register, forgot, reset, report, appeal, delete form) can be bypassed with a
  forged header. TLS and the proxy's own body cap are bypassed too.
- **Recommended fix**
  - Add `MIB_HOST` (default `127.0.0.1` in production) and pass it as `hostname`.
  - Log a warning at boot when `trustProxy` is true and the bind address is not loopback.
  - Add a checklist item to DEPLOYMENT.
- **Regression test:** config test that production defaults to a loopback bind. Artefact smoke
  test that the API is not reachable on a non-loopback interface.
- **Related old ID:** SEC-005, ARCH-018.

### SEC-R-007 — P2 — A named account can still be locked out of sign-in from a handful of addresses

- **Status:** unresolved previous finding (SEC-008 remainder; REMEDIATION marks SEC-008
  "Fixed"). **Confirmed.**
- **Evidence**
  - `apps/api/src/http/routes/auth.ts:39-54,85-95`: the budgets are 10 per (account, address) and
    100 per account per 15 minutes. Both are charged _before_ the password check, so a correct
    password is refused once the account budget is spent. Only a success clears them.
  - Addresses are raw strings (`client-address.ts`), so each IPv6 /128 is its own bucket.
  - `out-p04.txt`: 105 wrong sign-ins from 105 addresses, then the victim's correct password from
    a fresh address returned **429** (retry 881 s).
- **Reasoning:** the per-account ceiling is shared across all addresses and charged regardless of
  outcome, so enough distinct addresses exhaust it.
- **Impact**
  - An attacker with about ten addresses (trivially many under one IPv6 /64) keeps any named
    account locked, renewing every 15 minutes.
  - That includes banned or suspended users, whose only rights are to sign in and appeal. An
    existing session still works; a user without one is shut out.
  - The public delete form shares the budget.
- **Recommended fix**
  - Key addresses by IPv6 /64 (IPv4 /32).
  - Do not let failures from _other_ addresses block an address that has never failed for that
    account. For example, apply the per-account ceiling only to addresses with prior failures, or
    replace the hard lock with a progressive delay.
  - Consider exempting sign-ins from a recent known-good address.
- **Regression test:** 100 failures spread over 10 addresses, then the correct password from an
  11th address returns 200. Two /128s inside one /64 share a bucket.
- **Related old ID:** SEC-008, SEC-005.

### SEC-R-008 — P2 — The single-process lock does not stop a second container on the same database

- **Status:** newly discovered (the ARCH-004 fix is incomplete). **Confirmed.**
- **Evidence**
  - `apps/api/src/lib/process-lock.ts:40-47`: the holder is judged by PID liveness in the _local_
    PID namespace, and `holder !== pid` treats a lock carrying the new process's own PID as stale.
    Two containers that each run Node as PID 1 therefore always take over each other's lock.
  - `out-p08.txt`: a process in a separate PID namespace acquired a lock held by a live API.
  - With a second journey worker on the same file: releases returned `{"201":39,"500":1}` (the
    server log shows `SqliteError: database is locked`), and the worker had 4 tick errors. Data
    integrity held (no duplicated events or notifications).
- **Reasoning:** a PID written to a file is meaningless across PID namespaces, and PID 1 is the
  normal PID of a container's main process.
- **Impact**
  - A rolling deploy or `replicas: 2` (both forbidden by DEPLOYMENT §3, but that is exactly what
    the lock exists to catch) runs every worker twice, splits all in-memory rate limits between
    processes (weakening SEC-R-001 and SEC-R-007 defences), and produces `SQLITE_BUSY` 500s.
  - Outcomes themselves stayed idempotent.
- **Recommended fix**
  - Use an OS advisory lock on the database directory (for example an exclusive `flock`, or a
    SQLite `BEGIN EXCLUSIVE` lease row with a heartbeat) instead of a PID file.
  - At minimum, record hostname and boot id with the PID, and never treat `holder === pid` as
    stale.
- **Regression test:** a second process in another PID namespace (or a simulated equal PID with a
  different host id) fails to acquire the lock.
- **Related old ID:** ARCH-004.

### SEC-R-009 — P2 — The production artefact accepts a development-seeded database

- **Status:** production-configuration dependency, with a documentation mismatch. **Confirmed.**
- **Evidence**
  - `apps/api/src/db/seed.ts:161,239` stops production from _creating_ seeded accounts, but
    nothing detects existing ones.
  - `README.md:58-60` states "a production database never contains them", and publishes their
    password.
  - `a3/dev2.log`: the compiled artefact (dev mode off; no source-mode banner) on a copy of a
    dev-mode database returned 200 for four sign-ins.
  - A read-only check of `a3/db/dev2.sqlite` shows `ada`, `bo`, `cy` and `dee` active, with
    password hashes.
  - D10 and DEPLOYMENT decision 7 expect to run the deletion backfill "on the real database",
    which implies an existing database may be carried into production.
- **Reasoning:** the only guard is at seeding time; a database seeded earlier in dev mode passes
  straight through.
- **Impact:** if a database created in dev mode (`pnpm db:reset` seeds these users) is promoted,
  anyone on the internet can sign in to four accounts with the published password. Any role
  granted to them in development (README line 62 suggests granting one) comes along too.
- **Recommended fix**
  - At production boot, detect seeded accounts (seed usernames without an email, or a hash that
    verifies against `DEV_SEED_PASSWORD`, checked once).
  - Either refuse to start with a clear remedy, or disable those accounts and log a warning.
  - Correct the README sentence.
- **Regression test:** start the artefact on a seeded database → ConfigError (or the accounts are
  disabled) and seeded sign-in returns 401.
- **Related old ID:** SEC-001 (residual).

### SEC-R-010 — P3 — Malformed JSON answers 500 and logs a stack trace

- **Status:** newly discovered. **Confirmed.**
- **Evidence:** `apps/api/src/http/app.ts:103-125`. `onError` handles `AppError`, the busy error
  and zod errors, but not Hono's `HTTPException` (status 400, "Malformed JSON in request body"),
  which falls through to `console.error` and a 500. `a3/prod1.log` shows 4 such traces on
  `/api/auth/login`, each answered 500.
- **Reasoning:** the handler never checks for `HTTPException`, so a client-side 400 is reported as
  a server error.
- **Impact:** log flooding and false 500 alerting from any client. The body is not echoed (no data
  leak), and the 64 KB cap still applies.
- **Recommended fix:** in `onError`, return `err.getResponse()` or a JSON 400 `invalid_json` for
  `HTTPException`, without logging.
- **Regression test:** a malformed body on any JSON route → 400 `invalid_json`, and nothing
  written to stderr.
- **Related old ID:** ARCH-027 (body handling).

### SEC-R-011 — P3 — SMTP does not require TLS

- **Status:** production-configuration dependency. **Confirmed** (against a local sink that
  offered no STARTTLS).
- **Evidence:** `apps/api/src/config.ts:246` (`MIB_SMTP_SECURE` defaults to `false`);
  `lib/mail.ts:55-62` (no `requireTLS`); `smtp-capture.redacted.jsonl` shows
  `AUTH PLAIN (cleartext)` and the reset mail sent over plaintext.
- **Reasoning:** with `secure=false` and no `requireTLS`, nodemailer uses STARTTLS only if the
  server offers it.
- **Impact:** a misconfigured port, or an on-path attacker who strips STARTTLS, exposes the SMTP
  credential and live reset links. The documented Gmail setup (465, `secure=true`) is safe.
- **Recommended fix:** in production, set `requireTLS: true` whenever `secure` is false, and
  refuse `smtp` with neither.
- **Regression test:** the fake SMTP server without STARTTLS causes a send failure (the link is
  withdrawn), and a config test covers the production refusal.
- **Related old ID:** SEC-017 (mail path).

### SEC-R-012 — P3 — A finder cannot block the anonymous writer after reporting

- **Status:** newly discovered. **Confirmed.**
- **Evidence**
  - `packages/shared/src/api.ts:518` (`hide` defaults to `true`; `ReportSheet.tsx:29` also
    defaults to hide).
  - `services/moderation.ts:192,197-209` closes the finder's reading on hide.
  - `services/friends.ts:204-211` requires an open reading, otherwise 404.
  - `out-p09.txt`: after reporting, "finder blocks anonymous writer" returned 404
    `reading not found`.
- **Reasoning:** the hide-on-report closes exactly the reading that blocking depends on.
- **Impact:** contradicts D8/D12 ("report and block available during the session"). A finder who
  reports first loses the only way to avoid that writer in the public ocean.
- **Recommended fix:** allow `blockFoundWriter` for any finder who held a reading of that bottle,
  or who has a report on it, regardless of `closedAt` and session expiry.
- **Regression test:** open → report (hide) → block returns 204 and the block list shows a
  bottle-keyed entry.
- **Related old ID:** none (D8, D12).

### SEC-R-013 — P3 — The sender's notice for a finder-reported letter names the intended recipient

- **Status:** newly discovered. **Confirmed.**
- **Evidence:** `apps/api/src/services/moderation.ts:328` (`recipientDisplayName`) and `:588`
  ("Your letter to {recipient} was reported…") are used for every context. `out-p09.txt`: a
  public-context uphold produced a sender notice naming the intended recipient, who never read the
  letter.
- **Reasoning:** the notice wording does not distinguish shore reports from public-ocean reports.
- **Impact:** the wording implies that the named person reported it, steering any retaliation at
  someone uninvolved. D15(b) accepts the inference only when the recipient really is the reporter.
- **Recommended fix:** for `context = 'public'`, say "Your letter that drifted into the public
  ocean was reported…" and omit the name, in both the notice DTO and the notification text.
- **Regression test:** public-context uphold → the sender's notice and notification contain no
  recipient name.
- **Related old ID:** none (D15).

### SEC-R-014 — P3 — Anyone can exhaust a victim's password-reset budget

- **Status:** newly discovered. **Confirmed.**
- **Evidence:** `apps/api/src/http/routes/auth.ts:61,98-106` (3 per normalized email per hour, no
  owner exemption). `out-p05.txt`: a third party sent 3 × 202, then the victim's own request
  returned **429**.
- **Reasoning:** the per-email budget is spent by whoever asks, not only by the owner of the
  address.
- **Impact:** an attacker who knows the address can keep a user unable to recover their account,
  repeatedly, one request every 20 minutes. It enumerates nothing.
- **Recommended fix:** always answer 202, and apply the per-email cap to _sending mail_ rather
  than to the request, so a capped address is silently not mailed. Consider allowing one extra
  send after a quiet period, or a per-(email, address) cap.
- **Regression test:** after 3 third-party requests, the owner's request returns 202 and the mail
  count follows the documented rule.
- **Related old ID:** SEC-017 (neighbour).

### SEC-R-015 — P3 — Unsafe AI defaults relative to the deployment contract

- **Status:** production-configuration dependency. **Confirmed.**
- **Evidence:** `apps/api/src/config.ts:225-226` (`MIB_AI_ENABLED` defaults to `true`; any
  endpoint, including `http://` to a remote host). `docs/DEPLOYMENT.md:32` requires `false` unless
  the operator runs the model. The Privacy Policy says the model runs on "infrastructure the
  operator controls".
- **Reasoning:** the documented safe value is not the default, and nothing checks the endpoint's
  scheme or host.
- **Impact:** a forgotten variable sends reported letters and reporters' explanations to whatever
  answers at the endpoint. Pointed at a remote `http://` host, that traffic is cleartext. It
  contains no user ids (`out-p10.txt`).
- **Recommended fix:**
  - default `MIB_AI_ENABLED` to `false` in production;
  - require `https://` for a non-loopback endpoint;
  - log the endpoint host at boot (already partly done).
- **Regression test:** config tests for the production default, and refusal of a remote `http://`
  endpoint.
- **Related old ID:** none.

### SEC-R-016 — P3 — No history of role grants and revocations

- **Status:** newly discovered (SEC-011 forensics remainder). **Confirmed.**
- **Evidence:** `apps/api/src/tools/grant-role.ts:70-71,129-130` overwrite
  `users.role/roleGrantedAt/roleGrantedBy`. No history table and no audit row exist. Deletion
  nulls them (`deletion.ts:264-266`).
- **Reasoning:** each grant overwrites the last, so earlier holders leave no trace.
- **Impact:** after a compromise it is impossible to establish who held admin and when. Audit rows
  keep `actorUserId`, but not whether that actor was authorized at the time.
- **Recommended fix:** add an append-only `role_changes` table written by `grant-role`, and include
  it in the external audit export (D4).
- **Regression test:** grant → revoke → grant writes three rows, and they are readable via export.
- **Related old ID:** SEC-011.

### SEC-R-017 — P3 — No child-safety report reason; urgency depends entirely on the model

- **Status:** newly discovered. **Confirmed.**
- **Evidence:** `packages/shared/src/api.ts:500-508` (reasons: harassment, hate, sexual, violence,
  self_harm, spam, other). `urgentAt` is set only by `markUrgentChildSafety` from the model
  (`services/ai-review.ts:309,315-342`). DEPLOYMENT recommends `MIB_AI_ENABLED=false` unless a
  model is run.
- **Reasoning:** the only path to "urgent" goes through the model, and there is no reason a
  reporter can pick to trigger it.
- **Impact:** in the recommended AI-off deployment, a child-safety report sits in the ordinary
  queue ordered by recency, contrary to the Child Safety Standards' priority handling.
- **Recommended fix:** add a `child_safety` reason that sets `urgentAt` at report time (audited as
  `urgent_child_safety_review`, actor `system`, source `reporter`), and show it first in the UI.
- **Regression test:** a report with reason `child_safety` sets `urgentAt` with AI disabled, and
  `listCases` returns it first.
- **Related old ID:** none (D2).

### SEC-R-018 — P3 — The admin queue is capped at 200 with no paging (queue burying)

- **Status:** newly discovered. **Theoretical** (code reading; not probed).
- **Evidence:** `apps/api/src/services/admin.ts:219-229` (`limit(200)`, urgent first, then the
  most recent activity) and `:403-415` (appeals, the same).
- **Reasoning:** reports are bounded per account (10/h, 40/day) but not globally. Sock-puppet
  accounts that befriend one another can manufacture pending cases on their own letters.
- **Impact:** past 200 pending cases, older genuine cases, including non-urgent child-safety ones
  when AI is off (SEC-R-017), drop out of the admin list until the flood is worked through.
- **Recommended fix:** paginate by cursor, and order the pending queue oldest-first within
  urgency.
- **Regression test:** 250 pending cases → all reachable through pages, with the oldest pending
  case on page 1 of the pending view.
- **Related old ID:** none.

---

## 5. Previous SEC P0/P1 findings: closure verification

| Old ID                                                                                                   | Old sev             | Claimed              | Verified                                                                                                                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-001 (= DEPLOYMENT-001/ARCH-001/QA-002): dev mode by default; unauthenticated outbox; seeded accounts | P0                  | Fixed                | **Closed.** Residual database-reuse risk tracked as SEC-R-009.                                                                          | Dev mode defaults to `false` and is refused in production (`apps/api/src/config.ts:168-174`). Outbox refused without dev mode (`config.ts:238-239`). Dev router mounted only in dev mode (`http/app.ts:100`), behind `requireAuth` + `requireDeveloper` (`routes/dev.ts:34`, `middleware/admin.ts:21-26`). Seed refuses in a production build (`db/seed.ts:161`) and runs only in dev mode (`:239`); `db/reset.ts:10` refuses. Probes: `out-p02.txt` (production `/api/dev/*` 404); `out-p09.txt` (dev: anonymous 401, member/admin 403, developer 200); `a3/prod*.log` (`devMode=false, mail=disabled`). |
| SEC-002 (= ARCH-002): a deleted sender's adrift letters stay readable                                    | P1                  | Fixed                | **Closed**                                                                                                                              | `apps/api/src/services/deletion.ts:304-357` withdraws adrift listings, closes readings and clears lost-letter text; `:191-215` clears all authored text except under a hold. `out-p12.txt`: listed 0, stranger open 409, finder resume null, letter text 0.                                                                                                                                                                                                                                                                                                                                               |
| SEC-010: no separation of duties; no correction path                                                     | P1                  | Partly fixed plus D1 | **Closed for the P1** (self-dealing on decisions is blocked; "no correction" is accepted D1). Remainders: SEC-R-003 and SEC-R-004 (P2). | Recusal on case, appeal and critical (`services/admin.ts:192-199,268,441,555`). Digest required (`packages/shared/src/api.ts:732-735`). Reasons required (`routes/admin.ts:33-37`). `out-p02.txt`: party 403 `recused` ×2; no digest 400; wrong digest 409; no reason 400.                                                                                                                                                                                                                                                                                                                                |
| SEC-012: a deleted sender's evidence kept forever                                                        | P1                  | Partly fixed plus D5 | **Closed**                                                                                                                              | `services/deletion.ts:371-408` closes the unused appeal (audit `appeal_waived`, system). `services/retention.ts:79-104` anchors on the decision, not the notice (D5). `out-p12.txt`: case redacted by the retention tick; audit `case_decided`, `appeal_waived (system, account deleted)`, `evidence_redacted`.                                                                                                                                                                                                                                                                                           |
| SEC-017 / ARCH-008: forgot-password timing and 500 oracle                                                | P1 (in remediation) | Fixed                | **Closed**                                                                                                                              | `services/auth.ts:196-268`: the response does not await mail, and a failed send withdraws only the new link. `routes/auth.ts:98-106` returns 202 regardless. `out-p05.txt` (2.8 vs 1.7 ms median); `out-p06.txt` (supersede-on-delivery, single use, sessions revoked).                                                                                                                                                                                                                                                                                                                                   |
| ARCH-003 (the same policy consequence as SEC-012)                                                        | P1                  | Fixed                | **Closed**                                                                                                                              | `services/ai-review.ts:156-176,187`; `server.ts:40` releases stale claims at boot and on each tick.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Previous SEC P2/P3 items, briefly:

- **Closed:** SEC-003, SEC-005, SEC-006, SEC-007, SEC-009, SEC-013, SEC-014, SEC-015, SEC-016,
  SEC-019 and SEC-020.
- **SEC-004** is accepted (D3). **SEC-018** is resolved (D9).
- **SEC-008** remains partly open: SEC-R-007.
- **SEC-011:** the audit is readable (`GET /api/admin/audit`); tamper evidence is a D4 production
  dependency; the forensics remainder is SEC-R-016.

---

## 6. Verdict for this scope: **NO-GO**

**Criteria**

- **GO** requires no open P0 or P1 in this scope, and every production-configuration dependency
  below confirmed in the target environment.
- **CONDITIONAL GO** allows open P2/P3 items that have owners and dates, provided every
  dependency below is in place before traffic.

Today there are **2 open P1s**, so the verdict is **NO-GO**.

**To reach CONDITIONAL GO**

1. Fix **SEC-R-001**: rate-limit `/api/account/delete` and protect sign-in from queue starvation.
2. Fix **SEC-R-002**: preserve bans, and the blocks against a banned account, across self-deletion
   and re-registration.

**Launch conditions**

These are production-configuration dependencies. They must be confirmed on the host even after
the P1s are fixed:

- **D4 external immutable audit export** in place. DEPLOYMENT §2b already blocks launch on it, and
  no export hook exists in code yet.
- API reachable only through the proxy (firewall or container network until SEC-R-006 adds a bind
  setting), with `MIB_TRUST_PROXY=true` and the correct `MIB_TRUSTED_PROXY_HOPS`.
- A fresh production database, not a dev-seeded one (SEC-R-009). Confirm that no `ada`, `bo`,
  `cy` or `dee` accounts exist.
- `MIB_SMTP_SECURE=true` on port 465, as documented (SEC-R-011).
- `MIB_AI_ENABLED=false` unless an operator-controlled model is running (SEC-R-015).
- At least two administrators, or an owner escalation path (SEC-R-004).
- Exactly one API container, recreate strategy (SEC-R-008).

**Strongly recommended before public launch:** SEC-R-003, SEC-R-005 and SEC-R-007, which are P2
integrity and privacy defects with small fixes.
