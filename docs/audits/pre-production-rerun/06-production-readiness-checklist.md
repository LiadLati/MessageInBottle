# 06 — Production readiness checklist

For `main` at `a04526f`. IDs refer to `05-findings-matrix.md`. This checklist creates no new requirement beyond the findings and `docs/DEPLOYMENT.md`. It orders them.

## A. Required before production deployment

### A1. Code blockers (fix, with a regression test that fails without the fix)

- [ ] **SEC-R-001**: rate-limit password checks on `POST /api/account/delete` through the shared limiter. Test that a flood from one session leaves bystander sign-ins working.
- [ ] **SEC-R-002**: a permanent ban survives deleting the account. Registration is refused for the banned identity, and the victim's blocks are kept.
- [ ] **ARCH-R-002**: letters from a suspended or banned sender are not delivered or opened after the restriction, at minimum after a critical child-safety ban.
- [ ] A pull request with these fixes runs green in CI, and branch protection on `main` requires the CI job (**QA-R-001**).

### A2. Production configuration (owner or operator)

- [ ] Host, domain and TLS, with the reverse proxy per `docs/deploy/Caddyfile`. `MIB_APP_URL` is the public `https://` origin.
- [ ] **The API port is reachable only from the proxy** (firewall, or not published). There is no bind setting yet (**ARCH-R-004**). `MIB_TRUST_PROXY` and `MIB_TRUSTED_PROXY_HOPS` must match the real proxy chain.
- [ ] **Exactly one API replica, with a stop-then-start (recreate) deploy**, never rolling. The lock does not protect across containers (**ARCH-R-003**). Document the stale-lock procedure for restarts after an unclean stop.
- [ ] **A fresh production database created by the artefact's migrator** (`node dist/migrate.js`), never a copied development database (**ARCH-R-001**). Check that no seed usernames exist before opening to users.
- [ ] `MIB_DATABASE_PATH` is an absolute path on persistent storage outside the application directory.
- [ ] SMTP credentials are stored as a secret. Use implicit TLS (`MIB_SMTP_SECURE=true`, port 465) or a server that always offers STARTTLS (**SEC-R-011**). Send one real reset email end to end.
- [ ] Backup schedule with an off-host copy. Complete one restore drill; the tooling works, as Agent 2 showed a live backup restoring and booting.
- [ ] **An external append-only or immutable destination for moderation audit exports**, per `docs/DEPLOYMENT.md` §2b. The deployment documentation says launch is blocked on this. The local SQLite table is not tamper-evident, and the documentation correctly says so.
- [ ] A decision on AI review:
  - either off (`MIB_AI_ENABLED=false`), with the owner accepting that child-safety urgency then depends only on human triage (**FE-R-005**, **SEC-R-015**);
  - or pointed at an operator-run model over https or loopback.
- [ ] At least **two administrators**, or a documented owner escalation path, so that a case involving the only administrator can be decided (**SEC-R-004**).
- [ ] Log retention, with no request bodies logged.
- [ ] The operator tool commands in `docs/DEPLOYMENT.md` are run with `MIB_APP_URL` set (**ARCH-R-012**).
- [ ] Before running `deletion:backfill --apply` on any real data (decision D10), decide on **ARCH-R-006**: the backfill does not apply today's deletion rules to accounts deleted by older code. Always dry-run first.

### A3. Release verification

- [ ] Run the full gates on the release commit: format, lint, typecheck, tests, build, production-only artefact, compiled migrator (fresh run plus a second idempotent run), and the artefact smoke test.
- [ ] Run a browser smoke of the built web bundle behind the real proxy and CSP, at 390×844 and 1280×800, including a forced lazy-chunk failure to show the error boundary (**QA-R-002**, **QA-R-003**).

## B. Required before public store submission

- [ ] Every item in section A.
- [ ] **FE-R-001** fixed: the report form must be submittable in phone landscape, because reporting is a safety function.
- [ ] **FE-R-002** fixed, or explicitly accepted: an accidental tap must not end a one-time reading.
- [ ] Every other P2 either fixed or accepted in writing with a target date. The P2s are:
  - FE-R-003 to FE-R-009;
  - ARCH-R-005, ARCH-R-006, ARCH-R-008;
  - SEC-R-003, SEC-R-005, SEC-R-007;
  - QA-R-002, QA-R-003.
- [ ] Automated browser and accessibility smoke in CI: Playwright and axe against the built bundle (**QA-R-002**).
- [ ] Legal review of the v1.1 documents against the implemented behaviour, in particular:
  - the permanent ban and deletion (SEC-R-002);
  - restricted senders' letters (ARCH-R-002);
  - the AI-off child-safety triage (FE-R-005);
  - the audit export.
- [ ] Store listing tasks: app packaging, privacy and data-safety labels matching the Privacy Policy, age rating and child-safety declarations, a support contact and URL (`/support`), and a public deletion URL (`/legal/delete-account`).
- [ ] Documentation reconciled (**QA-R-009**): `docs/REMEDIATION.md` and `docs/ARCHITECTURE.md`.

## C. Recommended after launch

- The remaining P3s in `05` (30 items), in particular:
  - ARCH-R-009 (fault isolation in the journey tick, and readiness reporting);
  - ARCH-R-010 (harbour changes and the zone budget);
  - ARCH-R-011 (range-checking configuration);
  - ARCH-R-013 (notifications for deleted accounts);
  - SEC-R-010 (malformed JSON returns 500);
  - SEC-R-014 (reset-budget exhaustion);
  - SEC-R-016 (role-grant history);
  - SEC-R-018 (admin queue paging).
- Replace the PID lock with an OS or SQLite lease lock (ARCH-R-003) and add an `MIB_HOST` bind setting (ARCH-R-004).
- Batch the journey tick before the number of active senders reaches the thousands (ARCH-R-008).
- Remove wall-clock and random-id dependence from tests (QA-R-007, QA-R-008), test the ARCH-003 wiring and the FE-002 startup path (QA-R-005, QA-R-006), and add a populated upgrade test from the 0014 schema (QA-R-011).
- Add a CI check that applied migrations are never edited (ARCH-R-007).
- The dev-only advisories in `pnpm audit` (esbuild via drizzle-kit, vitest, @vitest/mocker). The production dependency tree currently has no known vulnerabilities.
