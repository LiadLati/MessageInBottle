# Weather & time-of-day — integration plan

Two approved packages are integrated here, in order:

- **v1.1 “weather & time-of-day handoff”** (16 Sep 2026) — daylight palette, day↔night tween, the
  My Shore storm, the clock policy and the deterministic schedule. Its *geographic Ocean storm
  layers* were superseded by v2.0 and are no longer in the code.
- **v2.0 “Bottle at Sea”** (17 Sep 2026) — weather **per bottle**, a storm glyph on the marker,
  the card's `View at sea` action and a dedicated three.js sea viewer. See [v2.0](#v20--bottle-at-sea).

The running application is authoritative for structure, behaviour, accessibility, privacy and
journey rules. The ZIP is authoritative only for the approved visual direction and its assets.
This document records what was reused, what was adapted, and what was rejected, before the code.

## Reused as shipped

| From the ZIP | Where it lands |
| --- | --- |
| Daylight map palette (`sea #15607E`, `land #DCD9C8`, coast/border `#8A9A90`, shelf `#2E86A4` / `#59AEC2`) | `OceanMap` style, day variant |
| Night map palette | unchanged — already the shipped style |
| Shelf-depth technique (two widening, blurred `line` layers on the land geometry) | `shelf-outer`, `shelf-inner` layers |
| ~~Storm layer set (`storm-dark`, `storm-cells`, `storm-cells-top`, `storm-edge`, `bottle-halo`)~~ | **Removed by v2.0.** No weather geometry and no halo is drawn on the map at all. |
| Route colours constant across day, night and storm | unchanged |
| Transition mechanics: 600 ms per-layer `setPaintProperty` day↔night | `OceanMap` tween (the calm↔storm group fade went with the storm layers) |
| Shore storm parameter set (exposure, sun, hemisphere, fog, water, waves, foam, sand tints, clouds, rain, spray) | `ShoreScene` weather parameter sets |
| “Allocate nothing at switch time” rule — rain, spray and all 11 cloud sprites exist from load | `ShoreScene` builds both sets once and drives opacity |
| Reduced-motion variants (180 ms cross-fade, cells held at 14 %, static rain at 22 %, single shore frame) | both surfaces |
| `assets/textures/sky-storm-equirect-1024x512.png`, `cloud-storm-sprite-256.png`, `spray-sheet-sprite-256.png` | `apps/web/public/textures/` |
| `assets/icons/icon-storm.svg` | already byte-identical to the `storm` entry in the icon set |
| Style policy: borders visible, **no text layer may exist** | already asserted by `assertMapStylePolicy`; test extended to the day style |

## Adapted

| From the ZIP | Why it changes |
| --- | --- |
| `map/storm-region.geojson`, `map/storm-cells.geojson` — a fixed storm at `[-44, 39.4]` | Sample data; first replaced by route-anchored regions, then by v2.0's per-bottle glyph. No storm geometry exists on the map any more. |
| `map/map-style.daylight.json` / `.night.json` — complete styles over a demo vector tile source | We keep our own bundled, credential-free Natural Earth sources. Only the **palette and the shelf layers** are taken; the style is still built by `buildStyle()`. Swapping styles would violate the “never `setStyle`” rule anyway. |
| Weather advisory card (geometry, glass, amber border, `WEATHER · SIMULATED` eyebrow) | Kept visually; the copy is rewritten (see *Rejected*). Placement follows our existing sheet stack rather than a fixed `bottom: 294`. |
| `▲ STORM NEAR` status chip | Superseded by v2.0's `▲ IN A STORM`, driven by the bottle's own schedule. |
| “Water: Rough” stat | Adopted in v2.0 (`Rough` / `Calm`, `—` once landed). |
| Shore sub-line “Storm · high water · 2 places free” | Wording reused, the numbers come from the real shore record. |
| `prototype/shore3d.js` weather branches | Read as an executable spec; ported into the existing `ShoreScene` as parameter sets. The prototype allocates rain/spray only when `storm` — we allocate always, as `IMPLEMENTATION.md` itself requires for switching. |

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

## v2.0 — Bottle at Sea

Source package: **“Message in a Bottle — Bottle at Sea handoff (v2.0)”**, approved 17 Sep 2026. It
replaces the geographic Ocean storm presentation of v1.1 and adds a dedicated sea viewer. The
running application stays authoritative for behaviour, accessibility, privacy and journey rules;
the package is authoritative for the approved visual direction.

### Reused as shipped

| From the ZIP | Where it lands |
| --- | --- |
| Per-bottle weather model: a storm belongs to a bottle, never to a region; two bottles on one route may differ | `lib/oceanWeather.ts` (`bottleWeatherAt`, `oceanWeatherMap`) over the unchanged v1.1 schedule, which was already keyed on the bottle id |
| Marker stack 40 × 58: storm glyph 24 × 17 `#E7CFA1` above the bottle, glyph drift ±3 px / 5 s (the package's selection ring is not drawn — see *Rejected*) | `OceanMap` marker element + `.map-marker` styles; `public/markers/storm-cloud-glyph.svg` (metadata stripped) |
| Card action row 52 px: `View at sea` primary (`#F2F6F5→#C7D9D6`, ink `#0A2230`), `Passport` outlined | `JourneyCard` `.action-row` |
| `▲ IN A STORM` chip (`rgba(199,162,74,.18)` / `.60` border / `#F0DDAE` text), “Water: Rough”, note “This bottle is in weather. Your other bottles are unaffected.” | `JourneyCard`, route list rows |
| Hint pill “Tap a bottle to follow its journey” (`rgba(6,20,30,.58)`, blur 16) | Ocean screen, clean state only |
| Sea screen chrome: `Back to map` pill 44 px, info card radius 22 at bottom 26, top/bottom scrims (calm and storm variants), **no navigation** | `SeaViewer` + `.sea-viewer` styles |
| Transitions: card in 220 ms, sea in 340 ms / out 260 ms opacity; reduced motion 120 ms opacity only, static glyph | CSS animations |
| Sea scene: camera fov 34 riding the swell (`swellY` smoothing 0.12), bottle roll/yaw frequencies, storm t0 6.2 / calm 2, exposure 0.92 / 1.02, subject key `#E6F3F6` 1.3 / 2.6 and rim `#CFE6EA` 2.4 / 5.0, whitecaps 5 / 14, contact wash, distant lightning (sprite + lamp, 9 s sin² envelope, peak 0.30 / 0.50, off under reduced motion), rain and spray volumes | `ShoreScene` `mode="sea"` |
| Performance rules: DPR cap 2, ≤ 32 sprites, ≤ 5 lights, textures/materials disposed and the GL context released on unmount, visibility pausing, lazy-loaded chunk | `ShoreScene`, `components/lazy.tsx` |

### Adapted

| From the ZIP | Why it changes |
| --- | --- |
| Sea screen as a route of its own | Implemented as a modal layer over the **still-mounted, paused** map (like the letter modal: `inert` siblings, focus trap, Escape). Camera, zoom and the selected card are untouched by construction, and no second map is ever created. On desktop it covers the map pane only, so the rail and the journey list stay in place. |
| Wave amplitude 1.7 / 1.9 and a 700 m water plane | Those numbers belong to the prototype's own wave function. With ours, a camera one metre above the water needs a denser 320 m plane (110–150 segments by viewport) with 3–20 m wavelengths and amplitude 0.30 / 0.52, or the sea reads as a tilting slab. The bottle is scaled 2.4 (not 1.7) for the same reason. |
| Fog `#466A76` 40→240 / `#4D5F66` 30→190 | Distances kept; at night the colour is pulled 62 % toward `#152B35`, otherwise the pale haze shows the plane's far edge as a band against the dark sky. |
| Day / night on the sea | One dusk sky for both; night dims the sun (×0.45), the hemisphere (×0.75) and exposure (×0.8). The key and rim lights keep the glass legible after dark. |
| Live journey info on the sea card | Recipient, chip, elapsed time and water state come from the same `SentBottleSummaryDto` as the map card. Letter text is never loaded there. |
| “Bottle changes state while open” | The viewer keeps rendering (calm water) and the card says “Arrived at …”. Once landed, the map card no longer offers `View at sea`. |

### Rejected

| From the ZIP | Reason |
| --- | --- |
| Geographic storm regions, ellipses, fog patches and any map-wide rain | Replaced outright. `lib/stormGeometry.ts` and the `storm-*` layers/sources are deleted. |
| Demo bottles, demo routes, hardcoded journey statistics, static map images, CDN dependencies | Real data only; the app bundles its own dependencies. |
| `bottleHalo` layer, and the desktop list-pane redesign in the reference frames | No circle, ring or halo is drawn around a bottle marker: selection reads as a size change and the keyboard focus ring is the only ring. The reference frames pre-date the shipped route list. |
| “Raised Write pill” navigation note | Stale: navigation is equal-height and contained, as fixed earlier. |
| Any wording that weather delays, endangers or protects a bottle | Weather is cosmetic (spec §9.1). The card and the sea screen say so; no odds or protection rules are shown. |

### Regression tests

`apps/web/src/lib/oceanWeather.test.ts` covers: day → always calm; landed → always calm; two bottles
on one route can differ; no reroll for the same instant; the development force switches. The
Playwright run (`sea-flow.mjs`, 390 × 844 and 1280 × 800) covers the marker click → info card only,
`View at sea` on the right bottle and weather, Back to map restoring camera/zoom/selection, no storm
layer or source left on the map, no glyph in daytime even when forced, stability across a reload,
the dialog's focus handling, WebGL canvas count before/after, no journey field changed by viewing,
and a bottle landing while the viewer is open.

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
| Animated map rain | none by design in v2.0 — the marker glyph carries the storm |
| Bottle marker sprite sheet / animated glyph asset | the existing SVG marker and an SVG glyph with a CSS drift |
| Water normal map for the open sea | sum-of-sines displacement on a dense mesh, as on the shore |
| Rain-ripple, splash and lightning artwork | the included spray/cloud sprites; lightning is one soft sprite plus a lamp |
| Low-end poster for the sea screen | the sky poster already used behind the scene while it loads |
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
8. v2.0: per-bottle weather, marker glyph, card actions, sea viewer, tests, docs, browser verification.
