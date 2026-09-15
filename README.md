# Message in a Bottle

Slow correspondence between friends: write a letter, seal it in a bottle, release it into a fictional
sea, and follow its simulated journey to your friend's virtual shore. The recipient only learns about
the bottle once the server has committed its arrival.

Product source of truth: `docs/Message_in_a_Bottle_Product_Specification_v0.2.md`
(v0.2, stage 3 "Directed delivery slice" is what this repository currently implements).

## Layout

```
packages/shared   Domain contracts shared by API and web: zod DTOs, bottle state model,
                  letter validation (grapheme counting), visual font catalog.
apps/api          Hono HTTP API + journey worker on SQLite (Drizzle ORM). Owns every rule.
apps/web          Vite + React client on the approved "cinematic" design: a real world map
                  (MapLibre GL, land-only style), a real-time 3D shore and release sequence
                  (three.js), glass UI overlays, parchment only inside letters.
docs/             Product specification and architecture notes.
```

See `docs/ARCHITECTURE.md` for the technology decisions, the data model and the design
integration notes.

## Requirements

- Node.js 22+
- pnpm 10 (`corepack enable` or `npm i -g pnpm`)

No external services, accounts, or paid providers are used. The database is a local SQLite file.

## Run it

```bash
pnpm install
cp .env.example .env        # optional; defaults are fine for development
pnpm db:reset               # create ./apps/api/data/mib.sqlite, apply migrations, seed chart + users
pnpm dev                    # API on http://localhost:3001, web on http://localhost:5173
```

**After pulling changes, run `pnpm install` again** before `pnpm dev`: new dependencies and
migrations arrive with the code, and the API applies pending migrations to the existing database
on start (it is never reset). `pnpm dev` runs two processes; the web half keeps working even if
the API half fails, so read the API's output when something is wrong.

Open http://localhost:5173 on a phone-sized viewport (the layout also supports desktop, where the
navigation becomes a left rail and world screens split into map/scene + side pane). Create an
account with a username and a password (8+ characters), or sign in as one of the seeded
development accounts `ada`, `bo`, `cy` (all mutual friends, each with a shore) and `dee` (no
shore, pending request to ada). **Development only:** the seed gives those four accounts the
password `dev-password-2026`; they are created solely by the dev-mode seed (`MIB_DEV_MODE=true`),
never by the API, so a production database never contains them. Use two browser profiles or a
private window to play both sides. The map and the 3D shore need WebGL.

Walkthrough of the vertical slice:

1. Sign in as `ada` (password `dev-password-2026`) → Write → choose Bo → write up to 1,000 characters on the parchment, pick a
   visual font → Seal the letter → the preview shows the planned sea route on the world map; toggle
   Readable Print (text never changes), acknowledge the public-exposure notice → Seal and throw.
2. The nine-beat release sequence plays in the 3D scene (tap anywhere to skip). The release
   request runs independently; the map appears only once the server has committed the bottle.
3. Ocean shows the bottle on the private world map: dashed planned route, solid completed trail,
   server-simulated position (interpolated between 15 s syncs) and elapsed time.
4. Sign in as `bo` → My Shore is an empty 3D coast; there is no incoming notification.
5. As `ada`, open the **Dev clock** pill (top centre) and press "Land bottle to Bo now" (or
   advance the clock in steps). The server moves its simulated clock forward and runs the worker.
6. As `bo` (same development password), the bottle rests on the sand and an arrival card appears. "Pick it up" opens the aged
   letter on full-screen parchment with Readable Print. Opening completes the journey.
7. As `ada`, the passport shows Arrived, Opened, the frozen total duration and the event history.

### Scripts

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `pnpm dev`          | Run API and web dev servers together                                |
| `pnpm dev:api`      | API only (`tsx watch`)                                              |
| `pnpm dev:web`      | Web only (Vite, proxies `/api` to the API)                          |
| `pnpm db:migrate`   | Apply SQL migrations in `apps/api/drizzle`                          |
| `pnpm db:seed`      | Seed the sea chart and development users (idempotent)               |
| `pnpm db:reset`     | Delete the dev database, migrate and seed (dev mode only)           |
| `pnpm typecheck`    | `tsc --noEmit` for every package                                    |
| `pnpm lint`         | ESLint (type-aware) across the monorepo                             |
| `pnpm format:check` | Prettier check                                                      |
| `pnpm test`         | Vitest in every package                                             |
| `pnpm build`        | Typecheck API/shared and produce the production web bundle          |

Schema changes: edit `apps/api/src/db/schema.ts`, then `pnpm --filter @mib/api db:generate`.

### Environment

All variables are optional and documented in `.env.example`. The important ones:

- `MIB_DEV_MODE` (default `true`): enables the seeded development accounts, the persisted
  development clock and the `/api/dev/*` routes. Must be `false` for any shared deployment.
- `MIB_SESSION_TTL_MS` (default 30 days): lifetime of a sign-in token.
  The in-app dev clock bar is additionally compiled out of production bundles: it renders only
  in `vite` development builds (`import.meta.env.DEV`) and only while the API reports dev mode.
  `pnpm --filter @mib/web preview` serves the production bundle against the local API.
- `MIB_MS_PER_CHART_UNIT` / `MIB_MIN_JOURNEY_MS`: the provisional travel model (spec decision D01 is
  still open). Defaults give roughly 1–4 days per crossing.
- `MIB_DEFAULT_SHORE_CAPACITY`: destination slots per shore (spec D06 is open).

### Map provider

No map credentials are required. By default the world map renders land geometry from a bundled,
public-domain Natural Earth 50m land file (`apps/web/public/map/land-50m.geojson`) and thin
country border lines from `apps/web/public/map/borders-50m.geojson` on a MapLibre GL style that
contains only a sea background, a land fill, a coastline and those border lines — no name
labels, flags, roads or user location, and it works offline. To use a licensed vector-tile
source for the land layer instead, set in `apps/web/.env` (see `.env.example`):

- `VITE_MIB_MAP_TILES_URL` — a TileJSON URL for a vector source
- `VITE_MIB_MAP_SOURCE_LAYER` — the name of that source's land/coastline layer
- `VITE_MIB_MAP_ATTRIBUTION` — the provider's attribution text (shown per their terms)

### Geographic datasets and the sea-route graph

All geography is bundled and generated offline; nothing is fetched at runtime.

| Data | Source | Version | Licence |
| --- | --- | --- | --- |
| Land polygons, coastline, borders, country attribution | [Natural Earth](https://www.naturalearthdata.com/) Admin 0 / Land, 1:50m, via the [`world-atlas`](https://github.com/topojson/world-atlas) npm package | Natural Earth 4.1.0 · world-atlas 2.0.2 | Natural Earth: public domain · world-atlas: ISC |
| Shore catalogue | Hand-written `apps/api/src/db/geo/shores.ts` (~390 real harbours), verified against the dataset | — | project code |
| Sea-route graph v2 | Generated `apps/api/src/db/geo/data/sea-graph.v2.json` | — | project data |

`pnpm --filter @mib/api exec tsx src/tools/geo/build-world.ts` regenerates the border lines, the
sea graph, `apps/api/src/db/geo/data/coverage.json` and the human-readable
[shore coverage report](docs/SHORE_COVERAGE.md), and fails if any shore is inland, attributed to
the wrong geometry, or if a coastal geometry has neither a shore nor a documented exclusion.

Chart seeding is additive: the API adds the catalogue and graph version 2 beside the original
chart at boot and never modifies existing shores, graph versions or released bottles' route
snapshots (`pnpm --filter @mib/api db:seed` does the same on demand; `db:reset` is destructive
and only for throw-away development databases).

Only that one layer is ever drawn; `assertNeutralStyle` refuses any style containing symbol
(label) layers or administrative/boundary/place source layers before the map is created.

### Email delivery (password recovery)

`MIB_MAIL_PROVIDER` decides what happens to the reset message, and **the development default
delivers nothing**:

| Provider   | What happens                                                                   |
| ---------- | ------------------------------------------------------------------------------ |
| `outbox`   | Default in dev mode. Captured in memory; read it in the app's dev bar under "Dev outbox", on the Forgot-password screen, or at `GET /api/dev/outbox`. Refused outside dev mode. |
| `smtp`     | Sent through your own SMTP provider using `MIB_SMTP_*`.                          |
| `disabled` | Default outside dev mode. Silently dropped.                                      |

The endpoint answers identically in every case, so the response never reveals whether an address
is registered. To actually receive mail, put these in `apps/api/.env` (loaded on start; real
environment variables take precedence, and the file is git-ignored):

```
MIB_MAIL_PROVIDER=smtp
MIB_MAIL_FROM="Message in a Bottle <no-reply@your-domain>"
MIB_SMTP_HOST=smtp.your-provider.example
MIB_SMTP_PORT=587
MIB_SMTP_SECURE=false        # true for port 465
MIB_SMTP_USER=your-username
MIB_SMTP_PASS=your-password
MIB_APP_URL=http://localhost:5173   # base of the link in the message
```

You supply the provider and credentials; none are bundled. Restart the API afterwards — its
startup line reports the active provider, and warns when mail is captured or disabled.

### If the app says it cannot reach the server

Sign-in (and every other action) reports `Cannot reach the Message in a Bottle server` when the
API is not answering. The web dev server proxies `/api` to `http://localhost:3001`, and when
nothing is listening there it replies `500` with an empty body — the app now names that case
instead of blaming the request. Check, in order:

1. The API half of `pnpm dev`. On a startup failure it prints a framed message naming the cause
   and the fix; the most common one after pulling is a missing dependency, cured by `pnpm install`.
2. `curl http://localhost:3001/api/health` — a healthy API answers `{"ok":true,...}`.
3. Nothing else already occupying port 3001 (the API reports `EADDRINUSE` if so; start it with a
   different `MIB_PORT`, and point the web app at it with `MIB_API_URL`).

## API overview

All routes are under `/api`, JSON, bearer-token authenticated except sign-in.

| Method | Path                          | Purpose                                                       |
| ------ | ----------------------------- | ------------------------------------------------------------- |
| POST   | `/auth/register`              | Create an account (username + password) → opaque token        |
| POST   | `/auth/login`                 | Sign in with username + password → opaque token               |
| POST   | `/auth/logout`                | Revoke the current token                                      |
| POST   | `/auth/password/forgot`       | Request a reset link by e-mail (same answer for any address)  |
| POST   | `/auth/password/reset`        | Set a new password with a single-use token (revokes sessions) |
| GET    | `/auth/me`                    | Current user                                                  |
| GET    | `/chart`                      | Neutral sea chart: shores, waypoints, islands, passages       |
| PUT    | `/chart/my-shore`             | Manual shore selection                                        |
| GET    | `/friends`                    | Approved friends, incoming/outgoing requests                  |
| POST   | `/friends/requests`           | Send request by exact username                                |
| POST   | `/friends/requests/:id/accept`| Mutual approval                                               |
| POST   | `/friends/requests/:id/deny`  | Decline a pending request (atomic, idempotent)                |
| POST   | `/friends/blocks`             | Block a user (enforced at release and before arrival)         |
| POST   | `/bottles/preview`            | Eligibility + planned route for a recipient                   |
| POST   | `/bottles/release`            | Atomic release; idempotent via `idempotencyKey`               |
| GET    | `/bottles/sent`               | Sender's private journeys with simulated positions            |
| GET    | `/bottles/sent/:id`           | Private bottle passport (sender only)                         |
| GET    | `/shore`                      | Recipient's shore: delivered/opened bottles only              |
| POST   | `/shore/bottles/:id/open`     | Open a delivered bottle (completes the journey)               |
| GET    | `/shore/bottles/:id/letter`   | Re-read an opened letter                                      |
| GET    | `/notifications`              | In-app events (arrival notices are created only on commit)    |
| GET    | `/dev/status`, POST `/dev/advance`, `/dev/arrive`, `/dev/tick` | Dev-mode clock and worker controls |
| GET    | `/dev/outbox`                 | Dev-mode captured e-mails (password-reset links)              |

Non-participants get `404` for any bottle, never `403`, so IDs disclose nothing.

### Accounts

Usernames are stored in one normalized form (trimmed, lower-case) under a unique index, so
`Ada` and `ada` are the same account; the display name keeps the typed casing. Passwords are
stored only as salted scrypt hashes (`scrypt$N,r,p$salt$key`, per-password random salt) and are
never returned or logged; validation errors echo field paths, not values. A failed sign-in is
always "incorrect username or password", whether or not the username exists, and is verified
against a dummy hash for unknown users so timing does not differ. Sign-in is limited per account
and per client address, registration per client address (HTTP 429 with `retryAfterSeconds`).
Tokens are opaque, stored hashed with a TTL, and sign-out revokes only the current token. The
migrations `0002_auth_credentials` and `0003_email_and_password_resets` are additive:
pre-existing rows keep a null password (cannot sign in until one is set) and a null e-mail
(cannot use password recovery until one is added).

New accounts register with an e-mail address, stored normalized and unique. Password recovery:
`/auth/password/forgot` always answers the same way; when the address is known, a random token is
mailed and only its SHA-256 is stored, valid for 30 minutes, single-use, superseding earlier
tokens. A successful reset revokes every session of the account. Mail goes through a
provider-neutral adapter (`MIB_MAIL_PROVIDER`: `smtp`, `disabled`, or the development-only
`outbox`, which the dev bar and `GET /api/dev/outbox` expose so the flow can be tested locally).
Reset tokens are never logged.
