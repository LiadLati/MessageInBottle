# SeaYou

Slow correspondence between friends: write a letter, seal it in a bottle, release it into a fictional
sea, and follow its simulated journey to your friend's virtual shore. The recipient only learns about
the bottle once the server has committed its arrival.

Product source of truth: `docs/SeaYou_Product_Specification.md`. Its §11 "As built" and §18
describe what this repository implements; the earlier v0.2 draft is historical and not in the
repository.

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

- Node.js 22+ (CI runs Node 22)
- pnpm 10.33.0, pinned by `packageManager` in `package.json` (`corepack enable` picks it up,
  or `npm i -g pnpm@10`)

No external services, accounts, or paid providers are used. The database is a local SQLite file.

## Run it

```bash
pnpm install
cp .env.example .env        # then set MIB_DEV_MODE=true in it for local development
pnpm db:reset               # create ./apps/api/data/mib.sqlite, apply migrations, seed chart + users
pnpm dev                    # API on http://localhost:3001, web on http://localhost:5173
```

**Development mode is off unless you turn it on.** Without `MIB_DEV_MODE=true` (in `.env`, in
`apps/api/.env`, or in the shell) the API starts in safe mode: no seeded accounts, no dev clock,
no dev bar and no `/api/dev/*` routes, and `db:reset` refuses to run. The API's startup output
says so. The value must be exactly `true` or `false`; anything else stops the API with an
explanation instead of being guessed.

**After pulling changes, run `pnpm install` again** before `pnpm dev`: new dependencies and
migrations arrive with the code, and the API applies pending migrations to the existing database
on start (it is never reset). `pnpm dev` runs two processes; the web half keeps working even if
the API half fails, so read the API's output when something is wrong.

Open http://localhost:5173 on a phone-sized viewport (the layout also supports desktop, where the
navigation becomes a left rail and world screens split into map/scene + side pane). Create an
account with a username and a password (8+ characters), or sign in as one of the seeded
development accounts `ada`, `bo`, `cy` (all mutual friends, each with a shore) and `dee` (no
shore, pending request to ada). **Development only:** the seed gives those four accounts the
password `dev-password-2026`; they are created only when `MIB_DEV_MODE=true` is set explicitly,
which a production server refuses, so a production database never contains them. The DEV bar
(dev clock and development outbox) appears only for an account holding the `developer` role;
grant it to one of the seeded accounts with `developer:grant` (see "Reporting, moderation,
appeals and admins"). Use two browser profiles or a
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
   The clock is one shared clock for every account. "Return to real time" in the same bar
   (developers only, after a confirmation) puts it back to the real time; nothing that already
   happened is reversed.
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
| `pnpm db:seed`      | Seed the sea chart, plus development users in dev mode (idempotent) |
| `pnpm db:reset`     | Delete the dev database, migrate and seed (dev mode only)           |
| `pnpm typecheck`    | `tsc --noEmit` for every package                                    |
| `pnpm lint`         | ESLint (type-aware) across the monorepo                             |
| `pnpm format:check` | Prettier check                                                      |
| `pnpm test`         | Vitest in every package                                             |
| `pnpm build`        | Typecheck, build the API into `apps/api/dist`, bundle the web app   |
| `pnpm start`        | Run the compiled API (`node apps/api/dist/server.js`), production   |
| `pnpm smoke:artefact` | Start the compiled API on a temporary database and check it       |

Operator tools (`pnpm --filter @mib/api <script>`, or `node dist/<tool>.js` in the artefact; all
read `MIB_DATABASE_PATH`):

| Script              | What it does                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `db:backup`         | Online, verified backup (`--to <file>`); `--verify <file>` checks integrity, migrations, rows      |
| `deletion:backfill` | Reports what today's deletion rules would change for accounts deleted earlier; `--apply` writes |
| `audit:export`      | Exports the moderation audit trail about one account as JSON (`--user usr_…`)                    |
| `retention:plan`    | Shows what evidence retention would redact                                                       |
| `admin:grant` / `developer:grant` | Grant a role by stable user id, with a confirmation step                           |

Schema changes: edit `apps/api/src/db/schema.ts`, then `pnpm --filter @mib/api db:generate`.

### Production build and start

The API ships as compiled JavaScript and runs on plain Node — no `tsx`, no TypeScript at run
time. `pnpm build` bundles it with esbuild into `apps/api/dist` (the shared package is bundled
in; npm dependencies stay external; no source maps, so no source is shipped) and copies the one
data file it reads at start, `dist/data/sea-graph.v2.json`. The migrations are read from
`apps/api/drizzle`.

A self-contained, production-only copy of the API (compiled output, migrations and production
dependencies — nothing else) is produced with `pnpm deploy`:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @mib/api deploy --prod --legacy /srv/seayou-api    # any empty directory

cd /srv/seayou-api
MIB_DATABASE_PATH=/var/lib/seayou/seayou.sqlite node dist/migrate.js   # optional: the server also migrates on start
MIB_DATABASE_PATH=/var/lib/seayou/seayou.sqlite node dist/server.js
```

The compiled artefact is production by construction:

- `MIB_DEV_MODE=true` is refused at startup (so is any value other than `true`/`false`);
- `MIB_DATABASE_PATH` is required and must be absolute — the default path is inside the
  application directory, which a redeploy replaces;
- the development outbox mail provider is refused; mail is `disabled` unless SMTP is configured;
- no development accounts are ever created, and the seed and reset scripts are not included;
- `/api/dev/*` does not exist (404);
- `SIGTERM`/`SIGINT` stop it cleanly (requests stop, workers stop, SQLite is closed).

Role provisioning is included: `node dist/grant-admin.js -- …` and `node dist/grant-developer.js
-- …` take the same arguments as `admin:grant` / `developer:grant`. The web app is a static
bundle in `apps/web/dist`. Hosting, TLS, the reverse proxy, persistent storage, backups and SMTP
are deliberately not decided here (see `docs/REMEDIATION.md`).

`pnpm smoke:artefact` starts the compiled API on a temporary database and checks all of the above;
`node apps/api/scripts/smoke-artefact.mjs --artefact <dir> --prod-only` does the same against a
`pnpm deploy` output and additionally proves that no TypeScript runtime is installed there. CI
(`.github/workflows/ci.yml`) runs it on every pull request.

### Environment

All variables are optional and documented in `.env.example`. The important ones:

- `MIB_DEV_MODE` (default `false`; exactly `true` or `false`): `true` enables the seeded
  development accounts, the persisted development clock and the `/api/dev/*` routes (every one
  of which, the mail outbox included, requires a signed-in `developer` account). It is refused
  in production: the compiled API, or anything run with `NODE_ENV=production`, will not start
  with it.
- `MIB_APP_URL`: the public origin; reset links are built from it. Production requires
  `https://`, and HSTS is sent when it is https.
- `MIB_TRUST_PROXY` / `MIB_TRUSTED_PROXY_HOPS` (default `1`): behind a reverse proxy, the client
  address is read that many entries from the **right** of `X-Forwarded-For`. See
  `docs/DEPLOYMENT.md` for the whole deployment contract (one API process, which the server
  enforces with a `<database>.lock` file; backups; headers).
- `MIB_SESSION_TTL_MS` (default 30 days): lifetime of a sign-in token.
  The in-app dev clock bar is additionally compiled out of production bundles: it renders only
  in `vite` development builds (`import.meta.env.DEV`) and only while the API reports dev mode.
  `pnpm --filter @mib/web preview` serves the production bundle against the local API.
- `MIB_MS_PER_CHART_UNIT` / `MIB_MIN_JOURNEY_MS`: the provisional travel model (spec decision D01 is
  still open). Defaults give roughly 1–4 days per crossing.
- `MIB_SHORE_CAPACITY`: bottles one account's shore holds at once — travelling plus
  delivered-unread (default 100). `MIB_DEFAULT_SHORE_CAPACITY` only seeds a legacy column.
- `MIB_RISK_POLICY_VERSION` (default `4`): the automatic storm-outcome policy new journeys are
  released under (spec §9.3). `4` is the approved policy — one map clock per account, storms
  that follow the map; `0` releases new journeys with no automatic risk at all. The value is
  stamped on each bottle at release; journeys released before automatic outcomes existed carry
  no version and are never put at risk. There is no server-side zone setting: each account's
  zone comes from its own devices (`PUT /api/auth/time-zone`).

### Map provider

No map credentials are required. By default the world map renders land geometry from a bundled,
public-domain Natural Earth 50m land file (`apps/web/public/map/land-50m.geojson`) and thin
country border lines from `apps/web/public/map/borders-50m.geojson` on a MapLibre GL style that
contains only a sea background, a land fill, a coastline and those border lines — no name
labels, flags, roads or user location, and it works offline. To use a licensed vector-tile
source for the land layer instead, set in `apps/web/.env` (see `.env.example`):

- `VITE_MIB_MAP_TILES_URL` — a TileJSON URL for a vector source
- `VITE_MIB_MAP_SOURCE_LAYER` — the name of that source's land/coastline layer
- `VITE_MIB_MAP_ATTRIBUTION` — the provider's attribution text, shown in a compact attribution
  control on the map whenever a provider is configured

Any key in that URL is **public**: Vite inlines `VITE_*` values into the JavaScript every visitor
downloads. Use a key restricted to your domain by the provider, or proxy the tiles.

### Time of day and simulated weather

**One clock per account** (risk policy v4, spec §9.3). The device reports its IANA time zone —
never GPS or coordinates — after sign-in, on start, on return to the foreground and when it
changes. The server validates it, and the latest one it accepts becomes the account's
authoritative map clock on every device (before any, the harbour's zone; else UTC). The Ocean
map's day and night palette, the sea view's lighting and My Shore all follow that clock, read from
`GET /api/ocean/weather`, so a phone and a desktop of the same account always agree. The time of
day is the server's too: each answer's `serverTime`, advanced on the device with a monotonic
clock, so a device clock that is wrong or changed cannot move the map.

**Storms follow the map.** A daytime map has no storm. When the map enters a night, the account
rolls once: a deterministic 25 % chance that the night holds one storm of 40–100 minutes,
wholly inside that night. The roll is persisted and never repeated — the account gets at most one
roll in any 24 hours, so changing time zone, crossing midnight, reopening SeaYou or restarting
the server cannot produce another. The storm is drawn once over the map, only at night; every
bottle at sea is in it and shows an `In a storm` chip, and at the storm's midpoint each bottle gets
its own independent risk decision (1 % loss for an eligible decision; at most five risky storms
per journey; none at or after 80 % of the way; arrival wins). If a time-zone change turns the map
to day before the midpoint, the storm disappears, its decision is cancelled and the roll stays
used. A change never alters a journey's duration or arrival, a decision already made, or any
deadline or rate limit.

| Setting | Default | Where |
| --- | --- | --- |
| Daylight window | 07:00–19:00 local | `DAYLIGHT_DEFAULTS` |
| Zone | the account's authoritative IANA zone | `services/weather.ts`, `state/weather.tsx` |
| Storm chance | 25 % per night entered, at most one roll per 24 hours | `RISK_POLICY` |
| Storm duration | 40–100 min, inside one night | `RISK_POLICY` |
| Policy version | 4 | `RISK_POLICY_VERSION` |

In development the dev-clock offset moves weather along with journeys; sessions are unaffected
because authentication runs on real time. A development build's dev bar carries **Sky**,
**Ocean storm** and **Shore storm** preview switches: they change only what is drawn — no request
is made, nothing is rolled and no bottle is touched.

### Notifications

The envelope beside the `+` control in the Ocean header counts unread notifications and opens a
full-screen inbox (newest first, each row an icon, one sentence and its time; rows do nothing
when tapped). Four events are recorded, one row per account per bottle, never duplicated by
worker retries: a bottle you sent reached its destination, was lost at sea and drifted into the
public ocean, or sank at sea; and a new bottle arrived at your shore. Opening the inbox marks
everything read, and that is remembered across reloads and sessions. Reading a notice about a
sunk bottle does not count as seeing its marker on the map.

The badge on **My Shore** means only that a bottle is waiting there for you to open; it clears
when you open it, not when you read the inbox, and nothing you sent can light it.

### Lost bottles and the public ocean

The Ocean has a compact **Private / Public** switch. Private is your own journeys; Public shows
every bottle that is *adrift* — swept off course in a storm — at the position where the sea ended
its delivery. Your own adrift bottle carries a small golden pennant that only you can see; its
card says **Your bottle · Adrift in the public ocean**. Nobody is told whose the others are: the
public API returns only `id`, `reason`, `lostAt`, `position` and `mine` — never the letter, the
sender, the intended recipient, the destination or the route.

Tapping somebody else's adrift bottle opens its public card, which says plainly that **opening
this bottle will remove it from the public map** before you act. **Open bottle** is one
server-owned action: it gives you the letter, takes the bottle off the map for everyone, and
keeps it in your **Letters → Received** as *Found adrift* — with no sender, no origin shore and
no destination, because the public ocean attributes nothing. If someone opened it first you are
told it is no longer adrift and shown nothing of it. The sender has their own **Read your
letter** action on their own bottle: a pure read, as often as they like, that never claims it or
takes it off the map. Nobody can rescue, re-release or re-send a found bottle in this version.

A **sunk** bottle stays on your private map at its sinking position with a red X above it and no
route. It remains there until you have actually seen it (the marker was inside your viewport
while the page was active — no tap needed) *and* then left the map for another screen; after
that it is hidden from later visits, on every device, and a refresh never hides an unseen one.
Both outcomes stay under **Letters → Lost** with the outcome time, the intended recipient and the
Passport; an adrift entry offers **Show on public map**.

The map always names your own harbour with an anchor label, and the destination harbour of the
bottle you have selected.

Outcomes are server-owned and written once: retrying, refreshing, viewing a bottle or opening the
sea viewer can never move or reroll them, and a journey cannot both arrive and be lost. Automatic
outcomes come only from the account's storms (above); in development the dev bar also offers
*Adrift* / *Sink* controls per at-sea bottle (`POST /api/dev/lose`).

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
| `outbox`   | Default in dev mode. Captured in memory; a signed-in `developer` account reads it in the dev bar under "Dev outbox" or at `GET /api/dev/outbox`. It is never shown to a signed-out visitor. Refused outside dev mode. |
| `smtp`     | Sent through your own SMTP provider using `MIB_SMTP_*`.                          |
| `disabled` | Default outside dev mode. Silently dropped.                                      |

The endpoint answers identically in every case, so the response never reveals whether an address
is registered. To actually receive mail, put these in `apps/api/.env` (loaded on start; real
environment variables take precedence, and the file is git-ignored):

```
MIB_MAIL_PROVIDER=smtp
MIB_MAIL_FROM="SeaYou <seayou.support@gmail.com>"
MIB_SMTP_HOST=smtp.gmail.com
MIB_SMTP_PORT=465
MIB_SMTP_SECURE=true
MIB_SMTP_USER=seayou.support@gmail.com
MIB_SMTP_PASS=<Gmail App Password — from your secret store, never committed>
MIB_APP_URL=http://localhost:5173   # base of the link in the message
```

SeaYou sends from `seayou.support@gmail.com` with a Gmail App Password; creating one (2-Step
Verification first) and rotating it are in `docs/DEPLOYMENT.md`, section 2a. No credential is
bundled, and none may be written into code, tests, logs, `.env.example` or Git. Reset links
expire after 30 minutes and work once; using one revokes every session and every other link.
Automated tests use an in-process fake SMTP server (`apps/api/src/http/smtp-reset.test.ts`) and
never contact Gmail.

Registration says "This email is already registered. Sign in or reset your password." when an
address has an account — an accepted tradeoff (`docs/REMEDIATION.md` D3), kept rate-limited.
The forgot-password request never reveals whether an account exists. Restart the API afterwards — its
startup line reports the active provider, and warns when mail is captured or disabled.

### Reporting, moderation, appeals and admins

Readers can report a letter from inside the reader — the recipient of a letter on their shore,
and a finder during their one-time reading of a public bottle. A report picks a reason, may add
an explanation, and by default hides the letter for the reporter at once. Reports about the same
letter form **one case** with the letter frozen as protected evidence; a case yields at most one
violation. The writer is never told who reported them.

**How often you can report.** Reporting is bounded so that it cannot be scripted, with budgets
wide enough that working through a real harassment campaign never hits them: 10 reports an hour
and 40 a day per account, in sliding windows counted from the stored reports themselves, so a new
session, a new device or an API restart does not hand anyone a fresh budget. Re-reporting a letter
you already reported writes nothing and costs nothing. A spent budget answers `429` with the wait
in seconds. Reading your standing, acknowledging a warning and appealing are never rate-limited —
a suspended account must always be able to reach its only remaining actions.

**Local AI review.** Each case is queued for a locally running model (Ollama; see
`MIB_AI_*` in `.env.example`). The model reads only the reported text and returns a validated
`accept` / `reject` / `uncertain` with a short reason, a translation for non-English letters and,
when unsure, why. It has no database or admin powers: the backend validates its output and makes
every change. By default its verdict is a recommendation shown to admins. If Ollama or the
computer is offline, reports wait in the queue and are retried with a growing delay.

`pnpm --filter @mib/api ai:eval` runs 30 representative letters past your model: Hebrew (threats,
unwanted sexual pressure, doxxing, affectionate vulgar slang, quoted abuse, a crisis message,
Hebrew written in Latin letters), Arabic, Russian, Spanish, French, Hebrew/English and
Russian/Hebrew code-switching, and the adversarial cases that produce the dangerous mistakes —
text that tries to dictate the verdict, and an innocent letter carrying a frightening accusation.
Run it with `-- --repeat 3`: a model that answers the same letter differently between passes is
not fit to decide anything. A clean run is the floor, not the bar — read the reasoning, add
letters from your own users. The model only ever recommends: every case is decided by a person,
and `MIB_AI_AUTO_DECIDE=true` stops the API. A possible child-safety issue it flags marks the
case urgent and lists it first; the case is visible to administrators before the model answers.

Setting up Ollama on your machine:

```bash
# https://ollama.com/download, then:
ollama pull qwen2.5:7b          # or any model you prefer; set MIB_AI_MODEL to match
ollama serve                    # listens on http://127.0.0.1:11434 by default
pnpm --filter @mib/api ai:eval -- --repeat 3   # judge the model before trusting it
```

**Evidence retention.** A case keeps a copy of the reported letter so that administrators, and
any later appeal, judge the same text. It is redacted **30 days after the administrator's
decision** — the length of the appeal window — or once an appeal filed within that window is
decided, whichever is later. This runs by default; it is the published policy, not a plan.

Undecided reports keep their evidence. An unopened decision notice does not: the appeal closes
30 days after the decision whether or not it was read, and the notice then says the appeal
period has expired. Evidence is kept longer only under a documented legal or child-safety hold,
which records who placed it, when and why; releasing it returns the case to the ordinary
calculation.

Redaction clears the letter copy, the reporters' explanations and the AI translation and notes. The case, its decision, its
reasoning, who decided it, the violation and the whole audit trail all survive — upheld
violations never expire, so what justifies one has to outlive the letter that proved it.

```bash
pnpm --filter @mib/api retention:plan            # dry run: what is redactable, and why not
pnpm --filter @mib/api retention:plan -- --apply # carry it out now
```

**Roles.** An account holds exactly one role, and the two privileged ones are deliberately
disjoint:

| Role | Can | Cannot |
| --- | --- | --- |
| `admin` | Review reports and appeals, read the AI recommendation, accept or reject, apply documented moderation actions | Use the DEV simulation controls |
| `developer` | Use the DEV simulation panel (arrival, storm, adrift loss, sinking), outside production only | Review or decide any real report or appeal |

A developer gets 403 from `/api/admin/*`, and an administrator gets 403 from `/api/dev/*`. DEV
controls need the role **and** a development environment, so a role granted for staging cannot
reach production. Registration never sets a role, and no header, query or request body is ever
read for one — these two commands are the whole surface:

```bash
pnpm --filter @mib/api admin:grant     -- --email you@example.com               # prints the account's id
pnpm --filter @mib/api admin:grant     -- --email you@example.com --confirm usr_…
pnpm --filter @mib/api admin:grant     -- --revoke usr_…
pnpm --filter @mib/api developer:grant -- --username someone --confirm usr_…    # same four forms
```

Granting one role replaces the other, and the command says so before it does it. No account is
seeded with a role: a fresh development database has none until you grant them.

**Violations and account notices.** Only an upheld report creates a violation: the letter is
withdrawn from every in-app read (the sender's passport included; the case keeps the evidence),
and the journey's timing, outcome and public listing stay as they were. One upheld violation is
a warning, two a seven-day suspension, three a permanent ban.

**Upheld violations never expire.** Serving a suspension does not remove one from the count:
when the seven days are up the account works again, but it is still two violations in and one
from a ban. The only thing that removes a violation is an accepted appeal. Rejected and
undecided reports count for nothing, and several reports about one letter make one case and at
most one violation.

**The decision notice, and the single appeal.** When a report against an account is upheld, the
sender is shown the decision — and that is when the appeal is offered:

- **Appeal decision** opens the appeal.
- **Continue without appealing** asks a second time, saying plainly: *If you continue, you will
  permanently lose the option to appeal this decision.* — **Go back** or **Skip appeal**.

Only confirming **Skip appeal** gives the appeal up, and it is permanent. Closing the tab,
reloading, or losing the connection resolves nothing: the notice is server state, and it comes
back on the next visit until the person answers. Presenting the notice, waiving and appealing
are all server-authoritative, transactional, idempotent and written to the moderation audit
trail. Each violation may be appealed once, within 30 days of the decision (server time); a
rejected appeal is final, and an accepted one revokes the violation, restores the letter and
recalculates standing immediately. No administrator can revoke, reopen or reverse a decision:
the appeal is the only way to change one. Every decision — reject, uphold, critical, and both
appeal outcomes — needs a written reason, and the console states the consequence before it asks
for confirmation.

A suspended or banned account sees a locked standing screen — the reason, the end time and a
countdown for a suspension, the warning that another violation bans permanently — and can only
read its standing, appeal in time, reach Help & Support, delete the account and sign out. It
sends and receives no bottles, disappears from friend lists (friendships are kept), and bottles
on their way to it are cancelled, their senders told only "Delivery unavailable". A suspension
ends by itself at its end time.

**Critical child safety.** An administrator can classify a confirmed case as a critical
child-safety violation, which bans permanently and immediately instead of walking the ladder.
It requires the admin role, a mandatory written reason and a strong confirmation, and records
the administrator, the timestamp, the classification, the reason and the action. The review
model can never apply it. The single appeal still applies, and escalating an ordinary violation
that was never appealed opens one new 30-day appeal.

### If the app says it cannot reach the server

Sign-in (and every other action) reports `Cannot reach the SeaYou server` when the
API is not answering. The web dev server proxies `/api` to `http://localhost:3001`, and when
nothing is listening there it replies `500` with an empty body — the app now names that case
instead of blaming the request. Check, in order:

1. The API half of `pnpm dev`. On a startup failure it prints a framed message naming the cause
   and the fix; the most common one after pulling is a missing dependency, cured by `pnpm install`.
2. `curl http://localhost:3001/api/health` — a healthy API answers `{"ok":true,...}`.
3. Nothing else already occupying port 3001 (the API reports `EADDRINUSE` if so; start it with a
   different `MIB_PORT`, and point the web app at it with `MIB_API_URL`).

### Terms of Use, Community Rules, Privacy Policy and account deletion

The documents are published at version `1.1`, in English, and are readable before there is an
account: linked from the sign-in screen and from the registration form, and served as plain
public HTML at `/legal/terms`, `/legal/community-rules`, `/legal/privacy`,
`/legal/child-safety` and `/legal/delete-account` (indexed at `/legal`). Those URLs need no
sign-in and no JavaScript, which is what a store listing requires.

Creating an account needs two separate, initially unchecked decisions — agreeing to the Terms
and Community Rules, and confirming the Privacy Policy has been read — and the server refuses
anything less, recording each document's version and the moment of acceptance per account. When
a version changes, every account is asked again before ordinary use; authentication, the
documents, account standing, appeals, signing out and deleting the account stay reachable
meanwhile.

The App has **no age gate**: no date of birth, no age checkbox, no verification and no claim
that users are adults. Safety rules about minors bind everyone regardless.

**Deleting an account** works from the account sheet in the App and from the public page, both
asking for the password again and an explicit confirmation, and both running the same
transactional operation: sessions end at once, the profile and identifiers go, friendships and
blocks go, letters still at sea are cancelled and cleared, letters already received stay with
their recipient, and moderation evidence is kept only where an open report, a pending appeal or
an active restriction still needs it. **Support** is a published address, `Sea You Support` at `seayou.support@gmail.com`, served as a
public page at `/support` beside the legal pages: no sign-in, no JavaScript, five headings that
open a message with the subject already set, the address shown as selectable text, and a plain
warning never to send a password, a verification code, payment details or an identity document.
It is a `mailto:` link only — no form, no inbox integration, no ticket store — and the address is
configurable with `MIB_SUPPORT_EMAIL`. **Help & Support** in the account sheet opens it, and so do
links on the sign-in screen, the policy-acceptance screen, the account-standing screen and the
deletion dialog, so it stays reachable while signed out, gated, suspended, appealing or deleting.

`docs/LEGAL_DOCUMENTS.md` has the detail and the remaining Play Console tasks.

## API overview

Outcome-related endpoints (all require a session): `GET /api/ocean/public` (each entry carries
its `expiresAt`), `POST /api/ocean/public/:id/open` (the finder's single atomic action; the
response is `Cache-Control: no-store`), `GET /api/ocean/reading` (the finder's still-open
one-time reading, if any, for recovery after a refresh), `POST /api/ocean/public/:id/close`
(ends that reading for good), `GET /api/bottles/sent/:id/letter` (the sender's own read), `PUT /api/auth/time-zone` (the
device's IANA zone, which fixes the nights the account's storms and risk are counted in),
`POST /api/moderation/reports` (report the letter in front of you), `GET /api/moderation/standing`,
`POST /api/moderation/violations/:id/acknowledge`, `POST /api/moderation/appeals`, and for admins
`GET /api/admin/reports?status=`, `GET /api/admin/reports/:id`, `POST /api/admin/reports/:id/accept|reject`,
`GET /api/admin/appeals?status=`, `POST /api/admin/appeals/:id/accept|reject`,
`POST /api/bottles/sent/:id/seen`, `POST /api/bottles/sent/:id/acknowledge`, and in development
`POST /api/dev/lose { bottleId, reason: 'adrift' | 'sunk' }`.

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
| GET    | `/notifications`              | Inbox events with a `kind`, newest first; `POST /notifications/read-all` marks them read |
| GET    | `/dev/status`, POST `/dev/advance`, `/dev/arrive`, `/dev/tick` | Dev-mode clock and worker controls |
| GET    | `/dev/outbox`                 | Dev-mode captured e-mails; developer role only                |

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
`outbox`, which the dev bar and `GET /api/dev/outbox` expose to a signed-in developer account so
the flow can be tested locally).
Reset tokens are never logged.
