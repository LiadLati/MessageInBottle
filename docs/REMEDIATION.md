# Remediation status

Tracks fixes for findings from the pre-deployment readiness audit (branch
`audit/pre-deployment-readiness`, audited commit `5ba32c2`). The audit's verdict was **NO-GO**.
This file records what each remediation stage changed. **It does not claim the audit is
resolved:** most findings remain open, and the audit reports remain the reference.

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
  Remove the timeout once QA-006 is fixed.

Everything else in the audit is unchanged by this stage.
