# Deployment contract

What a SeaYou deployment must provide. It is provider-neutral: any Linux host, VM or container
platform that can run one Node 22 process with a persistent disk satisfies it. **Choosing the
provider, the domain and the mail service are open decisions** (see the end of this file).

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
| `MIB_MAIL_PROVIDER`, `MIB_SMTP_*`, `MIB_MAIL_FROM` | `smtp` with real credentials, or accept that password recovery sends nothing (`disabled`, the default). |
| `MIB_SUPPORT_EMAIL` | The published support address (it appears in the Privacy Policy and Child Safety Standards). |
| `MIB_AI_ENABLED` | `false` unless an Ollama-compatible model runs on infrastructure the operator controls. `MIB_AI_AUTO_DECIDE` must stay `false` (the server refuses `true` while the published documents say a person decides every case). |
| `MIB_LOG_REQUESTS` | Request lines include ids in paths; decide a log retention period (below). |

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
3. SMTP provider and sender address, or launching without password recovery.
4. Backup schedule, off-host destination and retention period.
5. Log destination and retention period.
6. Who holds shell access to grant roles on the live host.
