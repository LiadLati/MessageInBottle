# Deployment contract

What a SeaYou deployment must provide. It is provider-neutral: any Linux host, VM or container
platform that can run one Node 22 process with a persistent disk satisfies it. **Choosing the
provider and the domain are open decisions** (see the end of this file). Password-reset mail goes
through Gmail from `seayou.support@gmail.com` (section 2a).

**Scope.** The client is the Android app (`docs/ANDROID.md`); this file covers the server it
talks to. No web app is served.

## 1. The artefact

```bash
pnpm install --frozen-lockfile
pnpm build                                              # API → apps/api/dist
pnpm --filter @mib/api deploy --prod --legacy /srv/seayou-api
```

`/srv/seayou-api` holds the compiled API, its migrations and production dependencies — no
TypeScript runtime, no source, no `.env`, no database. **No web app is deployed**: SeaYou's
interface is bundled inside the Android app (`docs/ANDROID.md`), which calls this server over
HTTPS. The server itself publishes only the API and the public pages (`/support`, `/legal`,
`/legal/delete-account`, `/reset-password`).
CI proves the artefact on every pull request (`apps/api/scripts/smoke-artefact.mjs`), and runs
the built interface (the one the Android app bundles) against it in a browser, with Playwright
and axe (`apps/e2e`).

### 1a. A fresh database

Production starts from an empty database created by the compiled migrator, never from a copy of
a development database:

```bash
MIB_DATABASE_PATH=/var/lib/seayou/seayou.sqlite node /srv/seayou-api/dist/migrate.js
```

The server refuses to start in production on a database whose development accounts (`ada`,
`bo`, `cy`, `dee`) still sign in with the published development password, and says so; nothing
is changed. Migrations are append-only: CI pins the content of every released migration.

## 2. Required environment

| Variable | Requirement |
| --- | --- |
| `MIB_DATABASE_PATH` | **Required, absolute**, on persistent storage outside `/srv/seayou-api` (a redeploy replaces that directory). The server refuses to start otherwise. |
| `MIB_APP_URL` | **Required, `https://`** — the public origin of this server. Password-reset e-mails link to `MIB_APP_URL/reset-password`. The server refuses `http://` in production. The Android app is built with the same origin (`VITE_MIB_API_ORIGIN`). |
| `MIB_CORS_ORIGIN` | Leave unset: in production it defaults to `https://localhost`, the origin the Android app's WebView serves the interface from. Only https origins are accepted; `*` is refused. |
| `MIB_DEV_MODE` | Unset or `false`. `true` is refused by the compiled server. |
| `MIB_TRUST_PROXY` | `true` behind the reverse proxy below; the API must then be reachable only through the proxy (see `MIB_HOST`). |
| `MIB_HOST` | The interface the API listens on. Production default `127.0.0.1` (proxy on the same host). A container deployment whose proxy reaches the API over a container network sets `0.0.0.0` and must **not** publish the API port. |
| `MIB_TRUSTED_PROXY_HOPS` | Number of proxies that append to `X-Forwarded-For` (default `1`). The client address is read that many entries from the right. |
| `MIB_MAIL_PROVIDER`, `MIB_SMTP_*`, `MIB_MAIL_FROM` | `smtp` through Gmail (section 2a), or accept that password recovery sends nothing (`disabled`, the default). Port 465 requires `MIB_SMTP_SECURE=true` and 587 `false`; without implicit TLS the server requires STARTTLS and sends nothing to a server that does not offer it (`MIB_SMTP_REQUIRE_TLS=false` is development-only). |
| `MIB_SUPPORT_EMAIL` | The published support address (it appears in the Privacy Policy and Child Safety Standards). |
| `MIB_AI_ENABLED` | **Required in production, `true` or `false`**: the server refuses to start with it unset. `true` sends the text of reported letters to the model at `MIB_AI_ENDPOINT` for a recommendation; `false` leaves every report to an administrator, and the console says automated review is off. Whether to run a model, and where, is an owner decision. The model only recommends; `MIB_AI_AUTO_DECIDE=true` stops the server (the setting was removed). |
| `MIB_AI_ENDPOINT` | With review on: `https://…`, or `http://` only on this machine (`localhost`, `127.0.0.1`, `::1`). Anything else is refused. |
| `MIB_RISK_POLICY_VERSION` | Leave unset (`4`, the approved policy: one map clock per account, storms follow the map). `0` disables automatic outcomes for new journeys. |
| `MIB_SHORE_CAPACITY` | Optional. Bottles one account's shore holds at once (default `100`, product decision 8). |
| `MIB_RETENTION_DAYS` | Optional. Leave unset: evidence is redacted 30 days after the decision (or once a timely appeal is decided), matching the published Privacy Policy. |
| `MIB_LOG_REQUESTS` | Request lines include ids in paths; decide a log retention period (below). |

Every numeric setting (`MIB_PORT`, the tick intervals, capacities, timeouts, the session
lifetime, `MIB_SMTP_PORT`) must be a whole number within its stated range, or the server refuses
to start and names the range.

## 2a. Password-reset email through Gmail

Reset links are sent from `seayou.support@gmail.com` over SMTP with a Gmail **App Password**.
The App Password is a credential: it lives only in the host's secret store (or a git-ignored
`.env` on the host). Never put it in code, tests, fixtures, logs, `.env.example` or Git.

1. Sign in to the `seayou.support@gmail.com` Google Account → **Security** → turn on
   **2-Step Verification** (App Passwords do not exist without it).
2. **Security** → **2-Step Verification** → **App passwords** (or visit
   `https://myaccount.google.com/apppasswords`). Create one named, for example, `SeaYou API`.
   Google shows 16 characters once; copy them straight into the secret store, without spaces.
3. Set the environment for the API process:

   ```bash
   MIB_MAIL_PROVIDER=smtp
   MIB_SMTP_HOST=smtp.gmail.com
   MIB_SMTP_PORT=465
   MIB_SMTP_SECURE=true
   MIB_SMTP_USER=seayou.support@gmail.com
   MIB_SMTP_PASS=<the App Password, from the secret store>
   MIB_MAIL_FROM="SeaYou <seayou.support@gmail.com>"
   MIB_APP_URL=https://<your domain>
   ```

4. Restart the API, request a reset for an account you control, and check the message arrives
   and its link opens `MIB_APP_URL/reset-password`. Links expire after 30 minutes and work once; using one
   revokes every session and every other reset link.
5. To rotate: create a new App Password, update the secret, restart, then revoke the old one in
   the Google Account. Revoke it immediately if it may have leaked.

Automated tests never contact Gmail: `apps/api/src/http/smtp-reset.test.ts` runs the real SMTP
adapter against an in-process fake server. The development outbox (`MIB_MAIL_PROVIDER=outbox`)
exists only with `MIB_DEV_MODE=true` and only for a signed-in developer.

## 2b. Moderation audit: external append-only export (required)

`moderation_audit` is append-only through every application route, but it is a table in the same
SQLite file as the rest of the data, so on its own it is **not tamper-evident**: anyone with write
access to the database file could change it. Approved production decision: every moderation
event must also be exported to an external append-only or immutable logging destination (for
example a write-once log service or an object store with retention lock) that the application
host cannot rewrite. The concrete integration is chosen together with the hosting and logging
provider; until it is in place, production launch is blocked on it. The export must carry no
letter content, report text or reset material — only what the audit row holds (action, case,
violation, appeal, subject and actor ids, role, reason, detail, time).

## 3. Exactly one API process

The journey, AI-review and retention workers run inside the API process, and rate limits are
kept in its memory. Run **one** process per database file: `replicas: 1`, and a
**stop-then-start** (recreate) deploy, never a rolling one. The server holds an exclusive
operating-system lock on `<database>.process-lock` for as long as it runs and refuses to start a
second process on the same file, including from another container that mounts the same volume.
The lock is released when the process exits or is killed. Like SQLite itself it needs working
file locks: keep the database on a local volume, never on a network file system. (Earlier
versions wrote a PID to `<database>.lock`; that file is ignored and can be deleted.) Run CLI tools (`grant-*.js`, `retention.js`, `backup.js`) against the live file only when
needed; they are safe alongside the server (SQLite locking plus `busy_timeout`) but add write
load.

## 4. Reverse proxy and TLS

One origin, the API's:

- `/api/*`, `/legal`, `/legal/*`, `/support`, `/reset-password` → the API on `127.0.0.1:3001`;
- `/` → a redirect to `/support`; every other path → 404. There is no web app to serve.

The proxy terminates TLS, redirects `http://` to `https://`, appends the client address to
`X-Forwarded-For`, and limits request bodies (the API also refuses bodies over 64 KB itself).
The API sets its own security headers (CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`,
and HSTS when `MIB_APP_URL` is https).
`docs/deploy/Caddyfile` is a complete reference configuration; any proxy that does the same is
fine.

## 5. Backups and restore

A plain file copy of a live database is **not** a backup: recent writes live in the `-wal`
file. Use the online backup tool, which is safe while the API runs and verifies what it wrote:

```bash
cd /srv/seayou-api
MIB_DATABASE_PATH=/var/lib/seayou/seayou.sqlite node dist/backup.js --to /var/backups/seayou/$(date +%F-%H%M).sqlite
node dist/backup.js --verify /var/backups/seayou/<file>.sqlite       # integrity, migrations, row counts
```

The operator tools (`migrate.js`, `backup.js`, `grant-*.js`, `retention.js`, `audit-export.js`,
`deletion-backfill.js`) need `MIB_DATABASE_PATH` only; they build no links, so they do not need
`MIB_APP_URL`. A scheduled job can run them with just that variable.

Schedule it (for example daily), copy the files off the host, and keep them for a period you
decide. **Restore:** stop the API; move the current database and its `-wal`/`-shm` files aside;
copy the backup to `MIB_DATABASE_PATH`; start the API. The drill is automated in
`apps/api/src/tools/backup.test.ts` (backup taken with writes still in the WAL, restored to a new
path, the application signs a user in from it). Practise it on the real host before launch.

Migrations are forward-only. Rolling the application back to an earlier version against a
database a newer version has migrated is unsupported; the recovery path is a restore.

## 6. Accounts that must exist before launch

There is no bootstrap path and no default administrator. Before the first report can be decided,
grant administrators on the host:

```bash
MIB_DATABASE_PATH=… node dist/grant-admin.js --email you@example.com            # look up
MIB_DATABASE_PATH=… node dist/grant-admin.js --email you@example.com --confirm usr_…
```

An administrator may not decide, hold or read the reporters of a case they are part of (as
sender, recipient or reporter). With a single administrator, such a case can be decided by
nobody, so plan for **at least two**, or accept that gap in writing. The grant tool and the
server's start-up log both say how many active administrators there are and warn below two.
Every grant and revocation is recorded in the moderation audit trail (`role_changed`).

## 7. Operations

- Health: `GET /api/health` answers 200 only while the database answers, 503 otherwise. It also
  answers 503 (`journey_worker_failing`) after three journey-worker ticks in a row failed, and
  reports `"worker": "degraded"` when the last tick had to skip a bottle, account or storm (the
  log has the ids; each is retried on the next tick).
- Stop: `SIGTERM` stops accepting requests, stops the workers and closes the database.
- Memory: ~110 MB for the route graph plus Node's baseline; more if a model runs on the same host.
- Logs: request logs contain bottle and violation ids; there are no structured logs, metrics or
  error reporting yet. Decide where logs go and how long they are kept.

## Decisions this contract leaves to the operator

1. Hosting provider and region.
2. The public domain (sets `MIB_APP_URL`).
3. Creating the Gmail App Password and storing it as a production secret (section 2a), with the
   other production secrets.
4. Backup schedule, off-host destination and retention period.
5. Log destination and retention period.
6. Who holds shell access to grant roles on the live host.
7. Running the historical deletion backfill (`deletion:backfill`, dry run first, after a
   backup) on the real database — owner-operated, never run by development work. It applies
   every current deletion rule to accounts deleted under older code. It is only relevant if an
   existing database is carried into production; a fresh production database (section 1a) has
   nothing to backfill.
8. Enabling GitHub branch protection so CI blocks merges.
9. The Android release, its signing key and the Play Console listing and Data Safety form
   (`docs/ANDROID.md`, `docs/LEGAL_DOCUMENTS.md`).
10. The external append-only or immutable log for moderation events (section 2b), chosen with
    the hosting and logging provider. This is a production deployment dependency, not an open
    product decision; the local table is not tamper-evident by itself.
11. Risk policy v4 activates at the first boot of this version (`risk_policy_activations`). No
    transition tool exists or is needed: migrations `0016`/`0017` are additive, and journeys at
    sea from earlier policies keep every recorded decision and are decided by account storms
    from that boot on.
