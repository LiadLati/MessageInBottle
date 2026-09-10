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
apps/web          Vite + React mobile-first client (placeholder visuals until design phase).
docs/             Product specification and architecture notes.
```

See `docs/ARCHITECTURE.md` for the technology decisions and the data model.

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

Open http://localhost:5173 on a phone-sized viewport. Development sign-in accepts any username;
seeded accounts are `ada`, `bo`, `cy` (all mutual friends, each with a shore) and `dee` (no shore,
pending request to ada). Use two browser profiles or a private window to play both sides.

Walkthrough of the vertical slice:

1. Sign in as `ada` → Write → choose Bo → write up to 1,000 characters, pick a font, toggle
   Readable Print (text never changes) → Preview route → acknowledge the public-exposure notice →
   Release.
2. Ocean shows the bottle on the private chart with its dashed route, completed trail, simulated
   position and live elapsed time. It polls the server every 15 s.
3. Sign in as `bo` → My Shore is empty; there is no incoming notification.
4. As `ada`, open the **Dev clock** panel and press "Land bottle to Bo now" (or advance the clock in
   steps). The server moves its simulated clock forward and runs the journey worker.
5. As `bo`, My Shore now lists the sealed bottle and a notification. Open it to read the aged letter;
   Readable Print is available. Opening completes the journey — there is no keep/re-release choice.
6. As `ada`, the passport shows Arrived, Opened, the frozen total duration and the event history.

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
