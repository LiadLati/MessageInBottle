# SeaYou — pre-deployment readiness audit: executive summary

## Verdict

# NO-GO

**SeaYou cannot be deployed today, and should not be deployed as configured.**

Two P0 findings drive this, and neither is about the product's logic:

1. **There is no deployable artefact.** `pnpm build` in `apps/api` is `tsc --noEmit` — it type-checks and
   emits nothing. The only way to start the server is `tsx src/server.ts`, and `tsx` is a
   **devDependency**, so `pnpm install --prod` produces a tree that cannot run. Nothing in the repository
   serves the built web bundle, no host, process manager, TLS terminator, reverse proxy or backup
   procedure is defined, and the SQLite database defaults to a path _inside the application directory_ —
   which a redeploy replaces. (**ARCH-006**)
2. **The shipped default configuration is an open mailbox.** `MIB_DEV_MODE` defaults to **`true`**
   (`apps/api/src/config.ts:101`). An operator who sets every other variable but forgets this one gets
   seeded accounts with the password published in `README.md:51`, and an **unauthenticated**
   `GET /api/dev/outbox` that lists every captured password-reset link. The security agent chained
   forgot-password → read the outbox with no credentials → reset → sign in, and took over an arbitrary
   account end to end. (**DEPLOY-001**)

The achievable next state is **`GO AFTER P0/P1 FIXES`**, and after that a **controlled pilot** — not a
public launch. The domain logic underneath is in unusually good shape (see "What is genuinely solid"),
and the remediation plan in `05-remediation-plan.md` reaches a deployable state in four batches.

**This audit makes no claim of legal certification and no claim of perfect security.** It is an
evidence-based engineering review by four specialists at one commit, not a penetration test, a legal
opinion, a privacy-compliance certification, or an accessibility conformance statement.

## Audited commit and environment

|                      |                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit               | `5ba32c2` (merge commit on `main`; `7e429a9` confirmed contained)                                                                                              |
| Branch               | `audit/pre-deployment-readiness`, cut from `origin/main`                                                                                                       |
| Runtime              | Node 22.22.2, pnpm 10.33.0, Linux container                                                                                                                    |
| Database             | `better-sqlite3` / SQLite. All mutation ran against **temporary** databases via explicit `MIB_DATABASE_PATH`                                                   |
| Development database | `apps/api/data/mib.sqlite`, sha256 `687030b50a8dbd895b59a0c3cb1834f5759b60f9b3ddf5a9cdccfe5c0a047a49` — **verified byte-identical before and after the audit** |
| Browser              | Playwright/Chromium (frontend agent only), API on 3011, web on 5181, temporary database                                                                        |
| Not available        | SMTP transport, a running AI model, a second machine, any production or external service                                                                       |

### Gates run once at `5ba32c2` and shared with all four agents

| Gate                  | Command                                              | Result                                                                                                        |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Format                | `pnpm format:check`                                  | **PASS** (5.5s)                                                                                               |
| Lint                  | `pnpm lint`                                          | **PASS**, 0 errors, 0 warnings (28.7s)                                                                        |
| Types                 | `pnpm typecheck`                                     | **PASS**, 3 packages                                                                                          |
| Tests                 | `pnpm test`                                          | **PASS — 336 tests** (api 242, shared 49, web 45), 85.6s wall                                                 |
| Build                 | `pnpm build`                                         | **PASS** — but see ARCH-006: the API "build" emits nothing                                                    |
| Fresh migration       | `MIB_DATABASE_PATH=$TMP/… npx tsx src/db/migrate.ts` | **PASS**, 1.21s, 15 migrations, 27 tables                                                                     |
| Production-mode smoke | `MIB_DEV_MODE=false …` + ~35 requests                | **PASS** — dev routes 404, seeded sign-in 401, core flow works                                                |
| Dependency audit      | `pnpm audit --prod`                                  | **No production vulnerabilities.** Three dev-only moderate advisories (`esbuild` via `drizzle-kit`, `vitest`) |

No automatic dependency fix command was run. No application source was modified. No migration was added.
No role was granted or revoked. No database was reset, reseeded or deleted. Nothing was deployed.

## What was and was not tested

**Tested.** The full API source and its 24 test files; the full `apps/web` source (~10.2k lines) at code
level; all four published legal documents against implemented behaviour; the 25-route × 6-actor endpoint
authorization matrix, probed live; role separation on every admin and dev route including those the test
suite omits; account deletion end to end; the moderation ladder from report to permanent ban, with
appeals, waivers, holds and seven-day retention; the public ocean projection and the finder's one-time
reading; migration from a fresh database and from historical shapes; the production-mode boot; shore
capacity under concurrency; ~35 UI flows in a real browser across 13 viewports with rendered-pixel
contrast measurement; the built production bundle for trackers, cookies, IndexedDB, source maps and
external URLs; every blob in all 38 commits scanned for committed secrets.

**Not tested, and why.**

- **Real deployment.** No host, container image or CI existed to test (ARCH-006, QA-001). Everything about
  production behaviour is inferred from configuration and code.
- **Mail delivery.** No SMTP transport was available. SEC-017's timing oracle is reasoned, not measured;
  ARCH-008/QA-004 was reproduced with an injected failing mailer.
- **The AI reviewer against a real model.** No model was running. SEC-013 demonstrates the prompt-injection
  _construction_; whether a given model obeys the injected instruction needs a run of the repository's own
  `ai:eval` harness with adversarial samples.
- **Multi-process behaviour.** Single machine. ARCH-004's duplicate-worker and shared-rate-limit
  consequences are reasoned from code, not observed (QA-022 is explicitly `needs verification`).
- **Load at scale.** The concurrency probes reached 5 simultaneous requests. QA-006's 2.4-releases-per-second
  ceiling is extrapolated from a clean linear trend, not a measured saturation point.
- **Automated accessibility tooling.** No axe or equivalent is in the repository and none was installed;
  the accessibility findings come from code reading plus manual keyboard and screen-reader-semantics review
  in the browser.
- **Assistive technology.** No screen reader was driven. A11Y findings describe the semantics presented, not
  observed AT behaviour.
- **External or production services.** None were contacted, by rule.
- **Legal sufficiency.** The audit compares published text to implemented behaviour. It does not assess
  whether the documents satisfy any jurisdiction's requirements.

## Totals

100 distinct findings after deduplication (108 raised, 8 merged where two or three agents found the same
defect independently).

| Severity | Count  |                                                                                                           |
| -------- | ------ | --------------------------------------------------------------------------------------------------------- |
| **P0**   | **2**  | Prevents deployment or exposes sensitive data by default                                                  |
| **P1**   | **15** | Major flow failure, serious reliability or security weakness, likely data loss or inconsistency           |
| **P2**   | **49** | Contained bugs, accessibility failures, operational weaknesses, missing negative handling, important debt |
| **P3**   | **34** | Polish, minor debt, documentation                                                                         |

By confidence:

| Confidence                                                                                             | Count                          |
| ------------------------------------------------------------------------------------------------------ | ------------------------------ |
| **confirmed** (reproduced, measured, or read directly from the code with the exact evidence cited)     | **96**                         |
| **high-confidence risk** (reasoned from code; the mechanism is certain, the trigger was not available) | **1** (SEC-017)                |
| **needs verification** (behaviour unknown _because_ it is untested)                                    | **3** (QA-022, QA-023, QA-024) |

By agent, after deduplication: frontend/UX 23 + 13 accessibility (0 P0, 2 P1); architecture 26 (2 P0, 6 P1);
security/privacy 17 (0 additional P0 — its P0 is DEPLOY-001, 2 P1); QA/release 21 (0 additional P0, 5 P1).

By category: code defect 58 · deployment-configuration requirement 11 · documentation mismatch 12 ·
product decision 9 · UI backlog / accessibility 20 (some findings carry two categories; the per-report
tables are authoritative).

## The ten most important findings

| #   | ID                                           | Sev | Finding                                                                                                                                                                                                                                                                                                                                                | Report      |
| --- | -------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| 1   | **DEPLOY-001** (ARCH-001 = SEC-001 = QA-002) | P0  | `MIB_DEV_MODE` defaults to `true`; an unset variable ships seeded accounts with a published password and an **unauthenticated** `/api/dev/outbox` listing live password-reset links. **Full anonymous account takeover, exploited end to end.** Also makes `pnpm db:reset` willing to wipe a production database.                                      | 03 §SEC-001 |
| 2   | **ARCH-006**                                 | P0  | No deployable artefact (`build` = `tsc --noEmit`, `tsx` is a devDependency), no host, no reverse proxy or TLS, no backup, and the database defaults to a path inside the application directory that a redeploy replaces.                                                                                                                               | 02          |
| 3   | **ARCH-002** (= SEC-002)                     | P1  | Account deletion sweeps three bottle states that **no code path ever assigns**. A deleted person's adrift letters stay listed in the public ocean for up to 72 hours and were read by a stranger after deletion — falsifying the live `/legal/delete-account` page and Privacy Policy §8.                                                              | 02, 03      |
| 4   | **SEC-012**                                  | P1  | A deleted sender's moderation case never reaches finality (`retention.ts:102` → `notice_unresolved` forever), so the **copied letter is retained indefinitely** — contradicting Privacy Policy §3 and §8 and Child Safety Standards §6, which all say evidence is kept past seven days only under a documented hold.                                   | 03          |
| 5   | **SEC-010**                                  | P1  | No separation of duties: an administrator can report a letter and uphold their own report (exploited). And **no correction path exists anywhere** — no revoke route, `decideCase` refuses the opposite outcome, and the subject can permanently waive their single appeal. Because upheld violations never expire, an honest misclick is unreversible. | 03          |
| 6   | **ARCH-014** (= QA-005)                      | P1  | A recipient who deletes their account mid-journey still receives the letter: the bottle is delivered, a notification is written to the deleted account, and the shore slot is held **forever** (no sweeper). Five such deletions permanently close a shore.                                                                                            | 02, 04      |
| 7   | **ARCH-008** (= QA-004)                      | P1  | A failing mail transport makes password recovery return 500 for known addresses and 202 for unknown ones — an enumeration oracle that defeats the property the code explicitly claims — _after_ it has already invalidated the user's previous reset link.                                                                                             | 02, 04      |
| 8   | **ARCH-003**                                 | P1  | A crash mid-AI-review leaves a case claimed forever, which permanently blocks seven-day evidence retention for that case. Same published-policy consequence as SEC-012, different trigger.                                                                                                                                                             | 02          |
| 9   | **ARCH-004**                                 | P1  | The system is single-process by construction — in-process interval workers and an in-memory rate limiter — but nothing says so and nothing enforces it. A second instance double-runs journey, AI and retention ticks and doubles every rate limit.                                                                                                    | 02          |
| 10  | **QA-001**                                   | P1  | There is no CI. Nothing runs the 336 tests, lint, typecheck, format or build on a push or a merge, so every quality signal in this audit — including the P0 fixes it recommends — is unenforced.                                                                                                                                                       | 04          |

Close behind, and in the first two remediation batches: **ARCH-005** (shore capacity is a shared global
resource), **FE-001** (no React error boundary anywhere — a failed lazy chunk blanks the app),
**FE-002** (a revoked session leaves a dead shell), **QA-006** (every release rebuilds a 173k-element graph
inside its write transaction: ~2.4 releases/second service-wide), **QA-008** (source-grep tests certify
privacy promises they cannot enforce — the mechanism by which FE-010/SEC-015 shipped undetected),
**SEC-009** (a banned administrator keeps full moderation authority).

## Published documents vs implemented behaviour

The brief required that no published statement describe unimplemented behaviour. Four published claims are
currently false, and one is unsupported:

| Document                                                | Claim                                                                               | Status                                                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `/legal/delete-account` + Privacy Policy §8             | Letters you wrote are removed from future reading and their text is cleared         | **False** — ARCH-002/SEC-002                                                                                                                 |
| Privacy Policy §3 + §8, Child Safety Standards §6       | Evidence is kept past seven days only under a documented legal or child-safety hold | **False for deleted senders** — SEC-012; **false for stuck AI claims** — ARCH-003                                                            |
| Privacy Policy §5                                       | The device time zone "is removed when you sign out"                                 | **False** — FE-010/SEC-015                                                                                                                   |
| Privacy Policy §10                                      | "A production deployment is configured to require HTTPS"                            | **Unsupported** — nothing in the repository implements, enforces or documents it (SEC-014)                                                   |
| Terms §8, Community Rules §7, Child Safety Standards §5 | "Every case is decided by a person"                                                 | **True as shipped** (`MIB_AI_AUTO_DECIDE` defaults false) but **unguarded** — enabling one flag silently falsifies three documents (SEC-020) |

Everything else checked — and a great deal was checked — matched. The Privacy Policy's browser-storage
section, its security-records list, its rate-limiting description, the reporter-anonymity guarantee, the
finder's one-time reading, blocking symmetry, session expiry and revocation, and the account-deletion
enumeration are all **accurate against the built bundle and the live API**.

## What is genuinely solid

Stated plainly, because a list of 100 findings distorts the picture and because remediation budget should
not be spent here.

- **The domain logic is unusually well covered and correct.** Release idempotency, shore capacity under
  concurrency (verified live: exactly 5 of 5 at capacity 5, 6th → 422, no over-commit), the arrival/loss
  race in _both_ orders, the adrift/sunk split, the public projection with a closed key-set assertion, the
  finder's one-time reading with a 15-minute resume, the 80% risk cutoff and five-decision cap over 800,000
  deterministic samples — these are pinned by tests that would genuinely fail if the behaviour broke.
- **The approved moderation rules are implemented as approved.** Upheld violations never expire; the appeal
  is offered once and closed only by appealing or explicitly confirming "Skip appeal"; closing or reloading
  resolves nothing (tested across a 30-day gap and a re-login); evidence is redacted seven days after
  finality; legal and child-safety holds work; the AI only ever recommends.
- **Role separation is correct in both directions.** Admin and developer are disjoint, verified live on
  every route including the nine the test suite omits. No request body, header or query can set a role;
  a `__proto__` payload changes nothing.
- **Authentication hygiene is careful.** Per-password random salts, `timingSafeEqual`, a dummy-hash path so
  unknown usernames cost the same 44 ms, hashed-only session and reset tokens, single-use resets that
  supersede all others, a self-describing hash string so scrypt parameters can be raised without a
  migration.
- **No injection surface found.** No reflected or stored XSS (probed), no SQL injection (Drizzle
  parameterises throughout), no path traversal, no SSRF, no open redirect, no email header injection, no
  command injection. CORS is correct. CSRF is genuinely not applicable — the bearer token lives in
  `sessionStorage`, so no ambient credential rides a cross-site request.
- **No committed secrets, ever.** All 792 blobs across all 38 commits scanned; every hit is a fixture, a
  placeholder or a React `autoComplete` attribute. No `.env` and no database file is tracked.
- **The production bundle is clean.** No trackers, no analytics, no cookies, no IndexedDB, no service
  worker, no third-party script, no CDN, no source maps.
- **Migration compatibility is excellent.** `compat.test.ts` reconstructs the historical migration file in
  both LF and CRLF renderings, derives both drizzle hashes from the file itself, refuses a wrong-schema
  table, is idempotent, and boots the API afterwards.
- **The legal documents are tested against behaviour.** 42 tests across four files assert that published
  copy matches implementation. That is why this audit could compare policy to behaviour at all, and it is
  the reason the four false claims above are the _only_ four found.

The pattern across the two P0s and most P1s is consistent: **the product's thinking is sound and its
plumbing to the outside world is not finished.** Almost every P0/P1 is about a boundary — the environment,
the deployment, deletion, retention finality, the mail transport — rather than about the rules themselves.

## Explicit unknowns

These are stated so they are not mistaken for clean bills of health:

1. **Real-world deployment behaviour is unknown.** Nothing here was run on a host, behind a proxy, with TLS,
   under a process manager, or with a backup. ARCH-006 is not just a finding; it means the entire production
   environment is unexercised.
2. **Whether the AI reviewer is manipulable by a crafted letter is unknown.** The prompt-injection
   construction is confirmed (SEC-013); the model's response to it was not testable.
3. **Behaviour under real load is unknown.** The 2.4-releases/second ceiling and the ~23-sign-ins/second CPU
   saturation point (SEC-006) are extrapolations from small, clean measurements.
4. **Multi-instance behaviour is unknown and unguarded** (ARCH-004, QA-022). If anyone ever runs two
   processes against one database, the failure modes are not characterised.
5. **Assistive-technology behaviour is unknown.** Accessibility findings describe the semantics the DOM
   presents; no screen reader was driven, and no automated accessibility tooling was run.
6. **Whether multi-reporter moderation cases are reachable at all is unknown** (QA-019) — the merge branch,
   `reportCount`, and a retention behaviour may describe a state the model cannot reach.
7. **Partial or interrupted migrations are uncharacterised** (QA-021). `assertSchemaComplete` runs only
   _after_ a successful migration.
8. **Legal sufficiency of the published documents is out of scope.** This audit verified that they describe
   what the code does. It did not and cannot assess whether they meet any jurisdiction's requirements.
9. **`docs/Message_in_a_Bottle_Product_Specification_v0.2.md` does not exist at this commit**, yet shipped
   code and test names cite it (QA-025). Per the brief it was treated as historical and not as an acceptance
   specification; `docs/SeaYou_Product_Specification.md` was used instead, and its §18 still carries retired
   v0.2 language — reported as documentation debt, not as acceptance criteria.

## Where to start

`05-remediation-plan.md` orders the work into four batches. **Batch 1** — the recommended first
implementation batch, not implemented here — closes both P0s and the two published-policy falsehoods with
the highest data-exposure consequence, plus the CI that keeps them closed. It is small, it needs no schema
change, and it is the difference between "cannot deploy" and "can run a controlled pilot".

## Report index

| File                             | Contents                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-frontend-ux.md`              | FE-001…FE-023, A11Y-001…A11Y-013; browser evidence across 13 viewports; rendered-pixel contrast; deployment blockers and UI backlog                     |
| `02-architecture-reliability.md` | ARCH-001…ARCH-028; deployment dependency map; 16 deployment requirements; failure-mode analysis; documentation debt                                     |
| `03-security-privacy.md`         | SEC-001…SEC-020; threat model; 25×6 endpoint authorization matrix; policy-vs-implementation table; secrets and supply chain; controls verified adequate |
| `04-qa-release-readiness.md`     | QA-001…QA-026; test inventory; requirement→coverage map; controlled execution results; target test pyramid and a ≤4-minute release smoke suite          |
| `05-remediation-plan.md`         | Four dependency-ordered batches with finding IDs, rationale, expected files, migration/data risk, verification, and the product decisions required      |
