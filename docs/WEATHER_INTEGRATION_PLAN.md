# Weather & time-of-day — integration plan

Source package: **“Message in a Bottle — weather & time-of-day handoff (v1.1)”**, approved 16 Sep 2026,
a delta on the v1.0 cinematic handoff that is already integrated.

The running application is authoritative for structure, behaviour, accessibility, privacy and
journey rules. The ZIP is authoritative only for the approved visual direction and its assets.
This document records what was reused, what was adapted, and what was rejected, before the code.

## Reused as shipped

| From the ZIP | Where it lands |
| --- | --- |
| Daylight map palette (`sea #15607E`, `land #DCD9C8`, coast/border `#8A9A90`, shelf `#2E86A4` / `#59AEC2`) | `OceanMap` style, day variant |
| Night map palette | unchanged — already the shipped style |
| Shelf-depth technique (two widening, blurred `line` layers on the land geometry) | `shelf-outer`, `shelf-inner` layers |
| Storm layer set and paint values (`storm-dark`, `storm-cells`, `storm-cells-top`, `storm-edge`, `bottle-halo`) | `OceanMap` weather layers |
| Layer order: weather **below** `planned` / `trail` / anchors / marker | enforced by `addWeatherLayers` (beneath `planned`) |
| Route colours constant across day, night and storm | unchanged |
| Transition mechanics: 600 ms per-layer `setPaintProperty` day↔night, 900 ms group fade calm↔storm, cells 0.6→1.0, drift 3–6 px/s, breathe 10→18 % over 6 s | `OceanMap` tweens |
| Shore storm parameter set (exposure, sun, hemisphere, fog, water, waves, foam, sand tints, clouds, rain, spray) | `ShoreScene` weather parameter sets |
| “Allocate nothing at switch time” rule — rain, spray and all 11 cloud sprites exist from load | `ShoreScene` builds both sets once and drives opacity |
| Reduced-motion variants (180 ms cross-fade, cells held at 14 %, static rain at 22 %, single shore frame) | both surfaces |
| `assets/textures/sky-storm-equirect-1024x512.png`, `cloud-storm-sprite-256.png`, `spray-sheet-sprite-256.png` | `apps/web/public/textures/` |
| `assets/icons/icon-storm.svg` | already byte-identical to the `storm` entry in the icon set |
| Style policy: borders visible, **no text layer may exist** | already asserted by `assertMapStylePolicy`; test extended to the day style |

## Adapted

| From the ZIP | Why it changes |
| --- | --- |
| `map/storm-region.geojson`, `map/storm-cells.geojson` — a fixed storm at `[-44, 39.4]` | Sample data. Storms are generated **along the signed-in sender's own at-sea routes** from a deterministic schedule, never over a fixed or arbitrary region. |
| `map/map-style.daylight.json` / `.night.json` — complete styles over a demo vector tile source | We keep our own bundled, credential-free Natural Earth sources. Only the **palette and the shelf layers** are taken; the style is still built by `buildStyle()`. Swapping styles would violate the “never `setStyle`” rule anyway. |
| Weather advisory card (geometry, glass, amber border, `WEATHER · SIMULATED` eyebrow) | Kept visually; the copy is rewritten (see *Rejected*). Placement follows our existing sheet stack rather than a fixed `bottom: 294`. |
| `▲ STORM NEAR` status chip | Applied to the bottle whose own route is under a storm, driven by the live schedule — not a static string. |
| “Water: Rough” stat | Our journey card has no “Water” stat row; the storm state is carried by the chip and the advisory instead of inventing a statistic. |
| Shore sub-line “Storm · high water · 2 places free” | Wording reused, the numbers come from the real shore record. |
| `prototype/shore3d.js` weather branches | Read as an executable spec; ported into the existing `ShoreScene` as parameter sets. The prototype allocates rain/spray only when `storm` — we allocate always, as `IMPLEMENTATION.md` itself requires for switching. |
| `bottleHalo` layer | Added under the existing DOM marker. |

## Rejected

| From the ZIP | Reason |
| --- | --- |
| “Navigation … Write as the raised pill” (`DESIGN_HANDOFF.md`) | Contradicts a shipped fix: navigation items are equal height, contained in the bar, and only the current page is highlighted. The v1.1 package explicitly says navigation is unchanged from v1.0, so this line is a stale restatement. |
| “Rough water tonight. **Anything at sea will take longer to arrive.**” (`Weather Concepts.dc.html`) | False. Simulated weather is cosmetic; it never changes a route, a duration or an arrival. Replaced with honest copy. |
| Journey sheet shown by default in the reference screens | Ocean opens as a clean map; a journey is opened only by an explicit tap. |
| Demo tile source, `sea-route.demo.geojson`, demo bottle positions, hardcoded journey statistics | Real data only. |
| “Lost bottles” / public-map controls visible in the prototype chrome | Public discovery is not implemented; no dead controls. |
| `preserveDrawingBuffer: true` | Capture-only; costs memory in production (the ZIP says the same). |
| Server-owned storm records (“storm geometry, cell seeds and bearing come from the server's weather record”) | Correct destination, but it would need a migration and a hazard model that is not approved yet. A **deterministic, versioned client schedule** gives the same property (every client agrees) with no schema change. The schedule module is written so it can move behind an endpoint unchanged. |
| Sinking / drift / public-claim probabilities implied by “Bottles can be blown off course” | Out of scope by instruction: this change delivers presentation and scheduling only. |

## Clock and timezone policy

One policy, used for **both** weather scheduling and weather display:

- **Instant**: the journey clock — real `Date.now()` in production; in development the same value shifted by the persisted dev-clock offset, so time travel moves weather with journeys.
- **Zone**: the browser's own IANA zone, `Intl.DateTimeFormat().resolvedOptions().timeZone`. No GPS, no coordinates, no server-side location.
- **Day/night**: local hour in that zone. Default day `07:00–19:00`, night `19:00–07:00`; both ends configurable, and a window that wraps midnight is supported.
- **Authentication is never on this clock.** Sessions, session expiry, password-reset tokens and rate limiting run on real wall-clock time (`ctx.realClock`), so advancing the development clock can land a journey but can never sign a user out.

## Weather scheduling defaults

Deterministic and versioned: `scheduleVersion = 1`. Nothing is random at render time, so a refresh,
a different selection, or a server restart reproduces the same weather.

| Setting | Default | Meaning |
| --- | --- | --- |
| `windowMs` | 3 h | Scheduling slot. One storm at most per bottle per slot. |
| `chance` | 0.45 | Probability a given slot carries a storm, per bottle. |
| `minDurationMs` / `maxDurationMs` | 40 min / 100 min | Storm length inside its slot. |
| `shore.windowMs` | 4 h | Independent slot for My Shore. |
| `shore.chance` | 0.35 | Probability of a shore storm in a slot. |
| `shore.minDurationMs` / `maxDurationMs` | 50 min / 150 min | Shore storm length. |

Ocean storms additionally require **night**, at least one **at-sea bottle of the signed-in sender**,
and are anchored to a point sampled **on that bottle's own route** (fraction 0.15–0.85), so the
region always intersects the maritime path. My Shore's schedule is keyed on the user, never on a
bottle, so the two surfaces are independent by construction.

## Missing assets and fallbacks

Taken from `ASSET_INVENTORY.md`; none of these are in the ZIP.

| Missing | Fallback in this implementation |
| --- | --- |
| HDRI skies | the included procedural equirect PNGs (correct in value and hue) |
| Sand / rock PBR maps | roughness constants from the token set |
| Water normal / flow map | sum-of-sines vertex displacement, as shipped |
| Splash crown & spray VFX sheets | the included spray sprite |
| Rain impact ripples on wet sand | none — the wet-sand tint carries the read |
| Animated map rain | the amber storm edge and the advisory card carry it |
| Bottle marker sprite sheet | the existing SVG marker |
| Modelled meshes with UVs/LODs | the procedural geometry already in `ShoreScene` |
| Static storm poster for the sub-30 fps path | the sky gradient poster already used as the scene's loading background |

## Order of work

1. Split the API clock: journey clock vs real clock for auth. Tests.
2. Shared day/night + weather schedule module. Tests.
3. Ocean map: day palette, shelf layers, day↔night tween, storm layers and loop.
4. Ocean screen: phase wiring, advisory, storm chip.
5. Shore scene: weather parameter sets; shore advisory.
6. Development-only weather preview controls.
7. Documentation, gates, browser verification.
