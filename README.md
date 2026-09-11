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

Open http://localhost:5173 on a phone-sized viewport (the layout also supports desktop, where the
navigation becomes a left rail and world screens split into map/scene + side pane). Development
sign-in accepts any username; seeded accounts are `ada`, `bo`, `cy` (all mutual friends, each
with a shore) and `dee` (no shore, pending request to ada). Use two browser profiles or a private
window to play both sides. The map and the 3D shore need WebGL.

Walkthrough of the vertical slice:

1. Sign in as `ada` → Write → choose Bo → write up to 1,000 characters on the parchment, pick a
   visual font → Seal the letter → the preview shows the planned sea route on the world map; toggle
   Readable Print (text never changes), acknowledge the public-exposure notice → Seal and throw.
2. The nine-beat release sequence plays in the 3D scene (tap anywhere to skip). The release
   request runs independently; the map appears only once the server has committed the bottle.
3. Ocean shows the bottle on the private world map: dashed planned route, solid completed trail,
   server-simulated position (interpolated between 15 s syncs) and elapsed time.
4. Sign in as `bo` → My Shore is an empty 3D coast; there is no incoming notification.
5. As `ada`, open the **Dev clock** pill (top centre) and press "Land bottle to Bo now" (or
   advance the clock in steps). The server moves its simulated clock forward and runs the worker.
6. As `bo`, the bottle rests on the sand and an arrival card appears. "Pick it up" opens the aged
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

- `MIB_DEV_MODE` (default `true`): enables username-only sign-in, seeded users, the persisted
  development clock and the `/api/dev/*` routes. Must be `false` for any shared deployment.
- `MIB_MS_PER_CHART_UNIT` / `MIB_MIN_JOURNEY_MS`: the provisional travel model (spec decision D01 is
  still open). Defaults give roughly 1–4 days per crossing.
- `MIB_DEFAULT_SHORE_CAPACITY`: destination slots per shore (spec D06 is open).

### Map provider

No map credentials are required. By default the world map renders land geometry from a bundled,
public-domain Natural Earth 50m land file (`apps/web/public/map/land-50m.geojson`) on a MapLibre
GL style that contains only a sea background, a land fill and a coastline — no labels, borders,
flags, roads or user location, and it works offline. To use a licensed vector-tile source instead,
set in `apps/web/.env` (see `.env.example`):

- `VITE_MIB_MAP_TILES_URL` — a TileJSON URL for a vector source
- `VITE_MIB_MAP_SOURCE_LAYER` — the name of that source's land/coastline layer
- `VITE_MIB_MAP_ATTRIBUTION` — the provider's attribution text (shown per their terms)

Only that one layer is ever drawn; `assertNeutralStyle` refuses any style containing symbol
(label) layers or administrative/boundary/place source layers before the map is created.

## API overview

All routes are under `/api`, JSON, bearer-token authenticated except sign-in.

| Method | Path                          | Purpose                                                       |
| ------ | ----------------------------- | ------------------------------------------------------------- |
| POST   | `/auth/dev-login`             | Development sign-in by username → opaque token                |
| GET    | `/auth/me`                    | Current user                                                  |
| GET    | `/chart`                      | Neutral sea chart: shores, waypoints, islands, passages       |
| PUT    | `/chart/my-shore`             | Manual shore selection                                        |
| GET    | `/friends`                    | Approved friends, incoming/outgoing requests                  |
| POST   | `/friends/requests`           | Send request by exact username                                |
| POST   | `/friends/requests/:id/accept`| Mutual approval                                               |
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

Non-participants get `404` for any bottle, never `403`, so IDs disclose nothing.
