# Deployment contract

What a SeaYou deployment must provide. It is provider-neutral: any Linux host, VM or container
platform that can run one Node 22 process with a persistent disk satisfies it. **Choosing the
provider and the domain are open decisions** (see the end of this file). Password-reset mail goes
through Gmail from `seayou.support@gmail.com` (section 2a).

## 1. The artefact

```bash
pnpm install --frozen-lockfile
pnpm build                                              # API → apps/api/dist, web → apps/web/dist
pnpm --filter @mib/api deploy --prod --legacy /srv/seayou-api
cp -r apps/web/dist /srv/seayou-web
```

`/srv/seayou-api` holds the compiled API, its migrations and production dependencies — no
TypeScript runtime, no source, no `.env`, no database. `/srv/seayou-web` is static files.
CI proves the artefact on every pull request (`apps/api/scripts/smoke-artefact.mjs`).

## 2. Required environment

| Variable | Requirement |
| --- | --- |
| `MIB_DATABASE_PATH` | **Required, absolute**, on persistent storage outside `/srv/seayou-api` (a redeploy replaces that directory). The server refuses to start otherwise. |
| `MIB_APP_URL` | **Required, `https://`** — the public origin. Reset links are built from it. The server refuses `http://` in production. |
| `MIB_DEV_MODE` | Unset or `false`. `true` is refused by the compiled server. |
| `MIB_TRUST_PROXY` | `true` behind the reverse proxy below; then bind the API to `127.0.0.1` so nothing can reach it except through the proxy. |
| `MIB_TRUSTED_PROXY_HOPS` | Number of proxies that append to `X-Forwarded-For` (default `1`). The client address is read that many entries from the right. |
| `MIB_MAIL_PROVIDER`, `MIB_SMTP_*`, `MIB_MAIL_FROM` | `smtp` through Gmail (section 2a), or accept that password recovery sends nothing (`disabled`, the default). |
| `MIB_SUPPORT_EMAIL` | The published support address (it appears in the Privacy Policy and Child Safety Standards). |
| `MIB_AI_ENABLED` | `false` unless an Ollama-compatible model runs on infrastructure the operator controls. The model only recommends; `MIB_AI_AUTO_DECIDE=true` stops the server (the setting was removed). |
| `MIB_RISK_POLICY_VERSION` | Leave unset (`4`, the approved policy: one map clock per account, storms follow the map). `0` disables automatic outcomes for new journeys. |
| `MIB_SHORE_CAPACITY` | Optional. Bottles one account's shore holds at once (default `100`, product decision 8). |
| `MIB_RETENTION_DAYS` | Optional. Leave unset: evidence is redacted 30 days after the decision (or once a timely appeal is decided), matching the published Privacy Policy. |
| `MIB_LOG_REQUESTS` | Request lines include ids in paths; decide a log retention period (below). |

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
   and its link opens `MIB_APP_URL`. Links expire after 30 minutes and work once; using one
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
**stop-then-start** (recreate) deploy, never a rolling one. The server takes an exclusive lock
file beside the database (`<database>.lock`) and refuses to start a second process on the same
file. Run CLI tools (`grant-*.js`, `retention.js`, `backup.js`) against the live file only when
needed; they are safe alongside the server (SQLite locking plus `busy_timeout`) but add write
load.

## 4. Reverse proxy, TLS and the web app

One origin serves everything:

- `https://<domain>/` → the static web app (`/srv/seayou-web`), falling back to `index.html`;
- `/api/*`, `/legal`, `/legal/*`, `/support` → the API on `127.0.0.1:3001`.

The proxy terminates TLS, redirects `http://` to `https://`, appends the client address to
`X-Forwarded-For`, and limits request bodies (the API also refuses bodies over 64 KB itself).
The API sets its own security headers (CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`,
and HSTS when `MIB_APP_URL` is https). The static web app needs its own headers from the proxy.
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

Schedule it (for example daily), copy the files off the host, and keep them for a period you
decide. **Restore:** stop the API; move the current database and its `-wal`/`-shm` files aside;
copy the backup to `MIB_DATABASE_PATH`; start the API. The drill is automated in
`apps/api/src/tools/backup.test.ts` (backup taken with writes still in the WAL, restored to a new
path, the application signs a user in from it). Practise it on the real host before launch.

Migrations are forward-only. Rolling the application back to an earlier version against a
database a newer version has migrated is unsupported; the recovery path is a restore.

## 6. Accounts that must exist before launch

There is no bootstrap path and no default administrator. Before the first report can be decided,
grant at least one administrator on the host:

```bash
MIB_DATABASE_PATH=… node dist/grant-admin.js --email you@example.com            # look up
MIB_DATABASE_PATH=… node dist/grant-admin.js --email you@example.com --confirm usr_…
```

## 7. Operations

- Health: `GET /api/health` answers 200 only while the database answers, 503 otherwise.
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
   backup) on the real database — owner-operated, never run by development work.
8. Enabling GitHub branch protection so CI blocks merges.
9. Store packaging and the Play Console Data Safety form (`docs/LEGAL_DOCUMENTS.md`).
10. The external append-only or immutable log for moderation events (section 2b), chosen with
    the hosting and logging provider. This is a production deployment dependency, not an open
    product decision; the local table is not tamper-evident by itself.
11. Risk policy v4 activates at the first boot of this version (`risk_policy_activations`). No
    transition tool exists or is needed: migrations `0016`/`0017` are additive, and journeys at
    sea from earlier policies keep every recorded decision and are decided by account storms
    from that boot on.
