# 00 — Executive summary: pre-production re-audit

**Audited commit:** `main` at `a04526f`. This is the merge `3a4ea92` of `fix/product-decisions` (`4355b5a`, containing all of `fix/audit-remediation` through `f722dc1`), plus two CI-only commits:

- `0444d7d` gives the CI migrator a placeholder `MIB_APP_URL=https://ci.invalid`;
- `a04526f` defines `ARTEFACT_DIR` at runtime, because the workflow had been rejected by GitHub before any job ran.

**Baseline:** `audit/pre-deployment-readiness` (`9b70f90`, audit of `5ba32c2`): 100 findings, 2 P0, 15 P1, verdict NO-GO.

**Method:** four independent agents, each in its own git worktree at `a04526f`, on its own ports and temporary SQLite databases:

1. frontend/UX/accessibility;
2. architecture/backend/data;
3. security/privacy/abuse;
4. QA/reliability/release.

They inspected, ran and probed; none edited the application. The security agent's first run was cut off before it wrote its report. A second reviewer wrote report 03 from the first run's saved probe scripts and outputs and re-verified every claim against the code. The lead then verified every P1, and each P2 that sets a condition, and deduplicated the findings (`05-findings-matrix.md`).

**Safety:** the real development database (`apps/api/data/mib.sqlite`, sha256 `687030b5…`) is byte-identical before and after. No fixes, migrations, deployments or external messages were made during the audit.

---

## Lead verdict: **NO-GO** for public release at `a04526f`

The verdict becomes **CONDITIONAL GO (controlled pilot)** once the three P1 code blockers below are fixed with regression tests and the required production-configuration items in `06` are in place.

| Severity | Deduplicated count |
| -------- | ------------------ |
| P0       | **0**              |
| P1       | **3**              |
| P2       | **22**             |
| P3       | **30**             |

### Agent verdicts (their own scopes)

| Agent                         | Verdict                                       | Raw counts (P0/P1/P2/P3) |
| ----------------------------- | --------------------------------------------- | ------------------------ |
| 1 Frontend, UX, accessibility | CONDITIONAL GO                                | 0 / 0 / 9 / 10           |
| 2 Architecture, backend, data | CONDITIONAL GO (after ARCH-R-001, ARCH-R-002) | 0 / 2 / 6 / 6            |
| 3 Security, privacy, abuse    | **NO-GO** (until SEC-R-001, SEC-R-002)        | 0 / 2 / 7 / 9            |
| 4 QA, reliability, release    | CONDITIONAL GO (controlled pilot only)        | 0 / 0 / 4 / 7            |

Agent 2's CONDITIONAL GO is conditional on fixing its own P1s. The three distinct P1s are all confirmed by the lead, and none is covered by an accepted product decision. So the combined verdict is NO-GO.

### Code blockers (P1)

1. **SEC-R-001** — `POST /api/account/delete` checks a password with no rate limit. One signed-in account can saturate the bounded password-hashing queue, so every other user's sign-in, registration and reset returns 503. It can also guess its own password without limit.
2. **SEC-R-002** — A **permanent** ban, including a critical child-safety ban, is undone by deleting the account and registering again with the same username and email. Deletion also removes the victim's block of the abuser. The published Terms promise a permanent ban.
3. **ARCH-R-002** — Letters already at sea from a sender who is then suspended or banned, including for child safety, are still delivered and can be opened. Only the recipient's standing is checked at arrival.

All three are small, local changes, each with an obvious regression test.

---

## Comparison with the original audit (`5ba32c2`)

### Earlier P0 and P1 findings (17)

| Old ID                                 | Sev | Now                                                                                  | Evidence                                                                                                                                                                   |
| -------------------------------------- | --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEPLOY-001 (= ARCH-001/SEC-001/QA-002) | P0  | **Resolved**                                                                         | Three mutations caught (config and dev-mode tests); the smoke test shows `/api/dev/*` 404 and seed sign-in 401. Residual risk from a dev-seeded database: ARCH-R-001 (P2). |
| ARCH-006                               | P0  | **Resolved (engineering)**                                                           | The artefact builds, installs production-only and runs; CI run #9 is green. Hosting, TLS, SMTP and backup schedule are production dependencies (D16).                      |
| ARCH-002 (= SEC-002)                   | P1  | **Resolved**                                                                         | `deletion-sweep.test.ts`; mutation caught.                                                                                                                                 |
| SEC-012                                | P1  | **Resolved** (under D5)                                                              | Mutation caught.                                                                                                                                                           |
| SEC-010                                | P1  | **Resolved** for separation of duties. No correction path, per accepted decision D1. | Mutation caught. Remainders: SEC-R-003, SEC-R-004 (P2).                                                                                                                    |
| ARCH-014 (= QA-005)                    | P1  | **Resolved**                                                                         | Mutation caught.                                                                                                                                                           |
| ARCH-008 (= QA-004)                    | P1  | **Resolved**                                                                         | Mutation caught, by a wall-clock assertion (QA-R-007).                                                                                                                     |
| ARCH-003                               | P1  | **Resolved in code**; its wiring has no test                                         | QA-R-005 (P3).                                                                                                                                                             |
| ARCH-004                               | P1  | **Partially resolved**                                                               | Works within one PID namespace; bypassed across containers (ARCH-R-003, P2). Mitigated by the one-replica runbook.                                                         |
| QA-001                                 | P1  | **Partially resolved**                                                               | CI exists and was first green at run #9 on `a04526f`. Runs #1–#8 never created a job. Branch protection and a green PR run are pending (QA-R-001, P2).                     |
| QA-003                                 | P1  | **Partially resolved**                                                               | Component tests exist; there is no browser, e2e or a11y automation (QA-R-002, P2).                                                                                         |
| FE-001                                 | P1  | **Resolved** (re-checked in the browser by Agent 1)                                  | No regression test (QA-R-003, P2).                                                                                                                                         |
| FE-002                                 | P1  | **Resolved**                                                                         | Mid-session path tested; startup path not tested (QA-R-006).                                                                                                               |
| QA-006                                 | P1  | **Resolved**                                                                         | Mutation caught.                                                                                                                                                           |
| QA-007 (= ARCH-021)                    | P1  | **Resolved**                                                                         | Mutation caught.                                                                                                                                                           |
| QA-008                                 | P1  | **Resolved**                                                                         | Mutation caught.                                                                                                                                                           |
| ARCH-005                               | P1  | **Resolved** (D6; 110 concurrent → exactly 100 accepted)                             | Mutation caught.                                                                                                                                                           |

**Are all earlier P0/P1 findings closed?**

- **No P0 or P1 has regressed, and none is open at P0/P1 severity.**
- **Fully closed:** 14 of 17.
- **Partially closed (3):** ARCH-004, QA-001 and QA-003. Their remaining parts are tracked at P2 (ARCH-R-003, QA-R-001, QA-R-002), each with a production or process mitigation.
- **Mutation checks:** Agent 4 ran them on all 17. Two fixes are not caught by any test: FE-001 and the ARCH-003 wiring.

### Overall movement

| Category                                        | Count                                                                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolved (earlier P0/P1)                        | 14                                                                                                                                           |
| Partially resolved (earlier P0/P1)              | 3                                                                                                                                            |
| Regressed                                       | 1: FE-R-010 (P3, the FE-012 reset list missing a newer flag). No P0/P1/P2 regression.                                                        |
| Still open (earlier P2/P3 remainders re-raised) | 13: FE-R-007, FE-R-016, ARCH-R-003, ARCH-R-004, ARCH-R-008, SEC-R-003, SEC-R-007, QA-R-001, QA-R-002, QA-R-003, QA-R-005, QA-R-009, QA-R-011 |
| Newly discovered                                | 41, including all three P1s                                                                                                                  |

The rest of the original report's 83 P2/P3 findings were not re-raised by any agent. That is weak evidence of closure, not proof, because this re-audit did not re-check every earlier P2/P3 one by one. Report 01 §"Earlier FE P0/P1 findings", report 02 §4 and report 03 §5 record the specific earlier findings each agent re-verified.

### Risk policy v4 (the final map-clock and storm behaviour)

Agent 2 verified:

- incremental and catch-up processing are identical over three randomised 40-day runs with 215–252 zone changes each;
- rolls are never less than 24 hours apart;
- no storm decision falls in daytime;
- zone changes never reroll;
- retries never duplicate a row, and a failure part-way through a 300-bottle storm is atomic.

One gap remains: **ARCH-R-005 (P2)**. If a recipient's deletion (or a standing change) ends a journey after a storm midpoint the worker has not yet processed, the outcome depends on worker latency. The lead reproduced this. The harbour-change variant did not reproduce on the lead's re-run.

Agent 1 found that the web client computes day, night and storm activity from the **device** clock rather than the server's (FE-R-003, P2). On a skewed device this contradicts the "one authoritative map clock" decision.

---

## Ready to begin production configuration?

**Yes.** None of the three code blockers depends on production configuration, so configuration can proceed in parallel. The engineering side of ARCH-006 is done:

- the artefact builds, installs and runs;
- migrations are fresh-install and upgrade safe, verified from `5ba32c2`, pre-0015 and stepwise through 0015–0017;
- backup and restore work;
- CI is green.

Required production items are listed in `06-production-readiness-checklist.md`:

- host and domain;
- TLS;
- SMTP secret and TLS mode;
- backup schedule with an off-host copy;
- an external append-only moderation-audit destination;
- one replica with recreate deploys;
- the API port reachable only through the proxy;
- a fresh production database;
- a decision on AI review;
- at least two administrators;
- branch protection.

## Before public store submission

1. Fix SEC-R-001, SEC-R-002 and ARCH-R-002 with regression tests, and get CI green on a pull request with branch protection on.
2. Close or explicitly accept, with dates, the P2s marked "recommended before release": FE-R-001 (report form in landscape) and FE-R-002 (accidental end of a one-time reading). Accept or schedule the remaining P2s.
3. Complete every "required before production deployment" item in `06`, including the external immutable audit export. The deployment documentation already marks it as blocking launch.
4. Run a browser, accessibility and built-bundle smoke test behind the real proxy and CSP (QA-R-002).
5. Complete the store and legal tasks in `06`: store listings, privacy labels, age rating, contact details, and a legal review of the v1.1 documents against the implemented ban and deletion behaviour.

The local SQLite moderation audit table is correctly **not** presented as tamper-evident, and no application route alters audit rows. The external immutable destination is a documented production dependency, not a code defect.
