# Research — design doc

Steward of a Hold already has one rule that this subsystem must inherit without
exception: **the sim is a read-only data quarry.** `js/world.js` never invents a
rock type, a salt band, a realm's age, or a lair's distance — it decodes fields
that already exist in `data/world.js` (`window.WORLD`, one dump of
`xan-world-sim`, seed 42, kya 0 / era "now" / year 0). Research is the same
discipline pointed at flavor and bonuses instead of at `hold.rich`: every
discovery below is a named decoding of a field the dump already carries, gated
on that field's real value for a real seed-42 hold, never a made-up fact.

All citations below (rock ids, ages, salt scores, feature distances, realm
ages, allegiance) were read directly out of `data/world.js` via
`window.XAN.allHolds()` (i.e. through the *existing* `js/world.js` adapter),
and the enum names were read out of the sim's own Go source at
`~/Desktop/code/xan-world-sim`.

---

## 1. What's discoverable

### 1.1 The gap: what `js/world.js` already surfaces vs. what it leaves on the table

`scanNeighborhood()` (`js/world.js:45`) already reads, per cell in a radius-4
box around the seat: `region`, `temp`, `salt`, `salinity`, `river`, road,
and tallies `rock` (by id, into `n.rock = {id: count}`). `deriveHold()`
(`js/world.js:117`) turns that into `hold.rich`, `hold.danger`, `hold.warmth`/
`hold.tempBand`, `hold.nearby` (features within Manhattan dist 8), and a prose
`hold.blurb`. **`rockAge` is read into the scene dump but is never tallied or
read anywhere in `js/world.js` or `js/game.js` today** — no rock's age, no
geologic-era label, exists in the game yet. Likewise `seat.allegiance` and
`realm.age` are shown once in the founding-screen dossier (`js/app.js:74`) and
then never touched again — no bonus, no lore, reads them after founding.
Research's job is to mine exactly these unused fields (plus re-decode the ones
already read, but as *named knowledge* instead of *raw richness*) and turn
each into a flavor line + a small, legible economy hook.

### 1.2 Field → knowledge mapping

| Raw field(s) | Real-world meaning (from sim source) | Knowledge it yields |
|---|---|---|
| `rock[cell]` (mode over `hold.n.rock`) | Topmost lithology. `internal/world/geology.go`: `RockBasement=1` "basement shield" (old craton), `RockOrogen=2` "orogenic rock" (folded mountain rock), `RockSediment=3` "marine sediment" (old seabed), `RockAlluvium=4` "alluvium" (river silt), `RockTill=5` "glacial till", `RockLoess=6` "loess" (glacial dust), `RockLava=7` "volcanic rock" | Names the hold's bedrock — a Geology discovery, gates Metallurgy |
| `rockAge[cell]` | ka since that surface was laid (`scene.go`: `"ka since the surface was laid"`). Sim constants to band it against: `meltKya=20` (civ.go — the Melt), `KyaOldWorld=205` (era.go — the LGM) | Ages the ground: "young, post-Melt alluvium" vs. "laid down at the depth of the Old Ice" |
| `salt[cell]`, `salinity[cell]` (already in `hold.rich.salt`) | `internal/world/salt.go`'s `SaltField`/`SoilSalinity`. `SaltStanding()`: `>=0.45` "salt-rich" (`saltLordMin`), `>=0.12` "salt-fed" (`saltFedMin`), else "salt-starved" | Halurgy — names the hold's salt command in the sim's *own* dossier words |
| `drainage[cell]`, `river[cell]`/`n.riverMax` | Upstream flow accumulation / Strahler order | Hydrology — "a headwater draining N cells" vs. dry ground |
| `elev`, `temp`/`hold.tempBand` | Bedrock elevation (m); soil/air °C at this kya | Climatology — cellars/preservation lore |
| `features` within N tiles (`hold.nearby`) | `internal/world/lairs.go`, `scene.go`: kinds `pass`, `lake`, `den` (dragon), `nest` (drake), `rookery` (wyvern), `volcano`, `tell` (none in this dump) | Lore landmarks — dragon-lair charting, volcano lore, named lakes/passes |
| `owner`/`realm.id`, `seat.allegiance`, `realm.age`, `realm.isCrown` | Territory claim; how firmly the crown holds the cell (0..1); consecutive sealed ages a realm's line has held its seat (`fate.go`) | History — the realm's age and the hold's real loyalty to its crown |
| `seat.ancestryLabel` | `internal/world/ancestry.go`: `AncestryNorthern` "Northern stock — plateau-born", `AncestryCoastal` "Coastal stock — of the receded shore", `AncestryHybrid` labeled `"cradle"` "hybrid stock — the cradle line" | Ancestry legend — already partly used in `holdBlurb`, made an unlockable discovery with its own bonus |
| world `kya`/`climate.glacialIndex` | `internal/world/civ.go`: `CivStageAt(kya)` → `StageIceDwellers`/`StageAgraria`/`StageTwoPeoples`/`StageCrowns`, `.Label()` "the mountain ice-dwellers" / "the first fields" / "the two peoples" / "the river-crowns", `.RealmWord()` "kinhold"/"steading"/"chiefdom"/"league" | The realm's age gets a historical-stage word, not just a number |

### 1.3 Seed-42 grounding (so discoveries stay honest)

Read via `node -e "…require('./data/world.js'); require('./js/world.js'); window.XAN.allHolds()…"`:

- **World state**: `seed 42, kya 0, era "now", year 0, glacialIndex 0`. `CivStageAt(0)` = `StageCrowns` ("the river-crowns", `RealmWord` "league") — every realm here is a post-Melt river-crown, not a kinhold or chiefdom.
- **Rock census** (6000 land cells): glacial till 41.9% (2514), basement shield 28.4% (1703), loess 13.0% (778), marine sediment 8.7% (521), alluvium 4.7% (283), volcanic rock 2.1% (125), orogenic rock 1.3% (76). Till dominates even though `glacialIndex=0` (warm "now") — it's a *deposit*, not current ice; its `rockAge` at the seats we sampled runs 45–235 ka, i.e. laid down across past glaciations, some right at the LGM band (205 ka).
- **Ancestry**: only two labels appear among the 40 seats — `Northern` (frontier marches/headwaters on the plateau) and `cradle` (everything else). **Zero `Coastal` seats** — because `RegionAgraria`/`RegionAgrariaUpland` (the terrain `ancestryOfRegion()` maps to Coastal) cover **0 of 6000 cells** in this map. That's not a gap in the adapter; it's the truth of this geography, and the doc's Ancestry discovery is scoped to reflect only Northern/cradle actually occurring.
- **Realms**: all 8 realms show `age: 1` in this dump (a freshly-sealed "now" snapshot has no deep dynastic record yet) — the Realm's Age discovery is written generically (it *would* read higher in a longer scrub) but its seed-42 flavor line is honestly "a young crown, one age old."
- **Salt**: only 3 of 40 seats clear `saltFedMin` (0.12) at all: **Tuthales** (tier `saltern`, `rich.salt=1.0`, rock mode marine-sediment+loess), **Nadrutres** (tier `reach`, `rich.salt=1.0`, rockAge 220), **Pokhahor** (tier `reach`, `rich.salt=1.0`, rockAge 125). All three read "salt-rich" by the sim's own `SaltStanding` cutoff.
- **Ore**: `rich.ore >= 0.5` at 7 seats, all frontier: **Sokaprus** .98, **Holas** .92, **Pedropon** .92, **Krosihis** .91, **Tronor** .79, **Krodris** .64, **Rikyr** .60 — every one a `march`/`headwater`/`outhold` on the cold northern plateau.
- **Lairs close enough to matter**: **Holas** has dragon den *Brodruhus* at Manhattan distance **1** (`nearby: den:Brodruhus@1`) and volcano *Lihalas* @3; **Tronor** has volcano *Lihalas* @1; **Lopros** has pass *Skipres* @1 and den *Mirutron* @3. These are the concrete "a dragon dens within sight of the walls" cases the Lore discoveries are built for.
- **Hydrology**: seat-cell `drainage` varies from 1 (most frontier/outhold seats) to **915** (Kropan, the capital) and **1357** (Hothehos) — the capital and its river-seats sit on the map's largest catchments, which is exactly why they're the capital.

---

## 2. Discovery catalogue (14: 7 Sciences + 7 Lore)

Every discovery's `apply` mutates the *already-existing* `S.game.bon` object
(`{mul:{food,timber,stone,ore,salt,coin}, foodEat, defBonus, popCapBonus}`,
built once by `bonuses(hold)` in `js/game.js:150`) or, for the two entries that
touch a rate rather than a multiplier, the shared `CFG` constants object
(`js/game.js:8`) — both are plain objects already exported on
`window.XANGAME`, so applying a discovery is external mutation, not a
`game.js` rewrite. See §5 for exactly where this is called from.

### Sciences

| # | Name | Trigger (real data) | Flavor (seed-42 example) | Unlocks |
|---|---|---|---|---|
| S1 | **Bedrock Survey** (Geology) | Always — dominant id in `hold.n.rock` | "Holas stands on ice-ground and old craton, with a thread of fire-rock through it" (Holas: till 32, basement 28, lava 10) | Per dominant rock: alluvium → `mul.food *= 1.08`; loess → `mul.food *= 1.06, mul.timber *= 1.04`; till → `mul.stone *= 1.08`; basement → `mul.ore *= 1.08, mul.stone *= 1.06`; orogen → `mul.ore *= 1.12`; sediment → `mul.salt *= 1.08`; lava (aged) → `mul.food *= 1.06, mul.ore *= 1.06` |
| S2 | **The Ground's Age** (Chronostratigraphy) — *requires S1* | Always — `rockAge` at the seat cell, banded against `meltKya=20` and `KyaOldWorld=205` | Nadrutres (rockAge 220), Tuthales (225), Hadrihan (235) date within a few ka of "205kya" — the sim's own LGM label | `<20` → `mul.food *= 1.04` (young alluvium); `20–100` → `mul.stone *= 1.04`; `100–205` → `mul.ore *= 1.06`; `>=205` → `mul.ore *= 1.08` + a distinct "laid down at the Old Ice" chronicle line |
| S3 | **Charting the Waters** (Hydrology) | `n.riverMax >= 3` or seat `drainage >= 100` | Kropan (drainage 915), Hothehos (1357), Ripar (526), Rikyr (231) qualify; Lopros/Sokaprus/Pedropon (drainage 0–5) don't | `mul.food *= 1.08` (irrigation) |
| S4 | **The Good Ground** (Husbandry/Agronomy) | `hold.rich.food >= 0.5` | Nearly every cradle forest seat (food rich 0.5–1.0); frontier marches (food 0.19–0.65) mostly miss it | `mul.food *= 1.06` (rotation/terracing) |
| S5 | **Salt Assay** (Halurgy) | `hold.rich.salt >= 0.12` (sim's own `saltFedMin`) | Tuthales/Nadrutres/Pokhahor read "salt-rich" (`>=0.45`, sim's `saltLordMin`) verbatim | `CFG.saltPreserveMax = min(0.95, +0.05)`; if salt-rich also `mul.salt *= 1.15` |
| S6 | **Reading the Sky** (Climatology) | Always — `hold.tempBand` | Lopros/Sokaprus (−2.4/−2.5 °C, frigid) vs. Nadrutres/Pokhahor (12–14 °C, warm) | frigid/cold → `CFG.foodSpoilMax *= 0.9` (cold cellars); warm/sweltering → `CFG.saltPreserveMax += 0.05` |
| S7 | **Assay the Vein** (Metallurgy) — *requires S1 + S2* | `hold.rich.ore >= 0.5` | Sokaprus .98, Holas .92, Pedropon .92, Krosihis .91, Tronor .79, Krodris .64, Rikyr .60 | `mul.ore *= 1.15`, `defBonus += 1` (tempered tools) |

### Lore

| # | Name | Trigger (real data) | Flavor (seed-42 example) | Unlocks |
|---|---|---|---|---|
| L1 | **Whose the Land** (Ancestry) | Always — `seat.ancestryLabel` | Holas/Krosihis/Lopros etc. are `Northern` ("mammoth-blood of the frozen north"); Kropan/Tuthales/most river seats are `cradle`. This seed has **no Coastal seats** (0 of 6000 cells are Agraria shelf) — the discovery only ever surfaces the two labels this map actually has | `popCapBonus += 1` (ancestral pride draws settlers) |
| L2 | **The Realm's Age** | Always — `realm.age` + `CivStageAt(kya)` | All 8 realms read `age:1` here — "Kropan's crown sits its first sealed age, a young line among the river-crowns" | `mul.coin *= (1 + 0.05 * realm.age)` — +5% today, scales if a longer scrub ever raises `age` |
| L3 | **The Crown's Reach** (Allegiance) | Always — `seat.allegiance` | Kropan (capital) allegiance 1.0; Nadrutres/Pokhahor .22–.23 ("a frontier grudge against a distant crown"); Sokaprus/Tronor ~.5–.6 | `>=0.8` → `mul.coin *= 1.1`; `0.4–0.8` → `defBonus += 1`; `<0.4` → `mul.salt *= 1.1, mul.timber *= 1.05` |
| L4 | **Lakes Named** — *requires L2* | `hold.nearby` has a `lake` within 8 | Kropan (Tamosus@8), Tesan (Tamosus@4), Krosan (Hekemos@4), Krodris (Notritron@4), Ripar (Notros@6) | `popCapBonus += 1` (freshwater supports more folk) |
| L5 | **The Old Road Over** — *requires L2* | `hold.nearby` has a `pass` within 8 | Lopros (Skipres@1), Ripar (Krutrus@1), Holas (Skopabros@4, Khilosis@5) | `mul.coin *= 1.12` (a waymarked trade route) |
| L6 | **The Old Fire** — *requires S1* | `hold.nearby` has a `volcano` within 8 | Tronor (Lihalas@1!), Holas (Lihalas@3), Krosihis (Khapos@2), Pedropon (Brapredror@2), Sokaprus (Brapredror@3) | `mul.food *= 1.06, mul.ore *= 1.04` (weathered volcanic soil; matches `SoilFertility(RockLava, aged)=0.8` in `geology.go`) |
| L7 | **Dragon Lairs Marked** — *requires L2* | `hold.nearby` has a `den`/`nest`/`rookery` within 8 | Holas — den *Brodruhus* at distance **1**, danger 0.8; Lopros — den *Mirutron*@3, danger 1.0 | `defBonus += 1` (charted bearings let the watch stand smarter — directly softens `stepRaids`' `mit = 1 - defense*0.2`) |

Only 14 (not more) because that's what seed 42's 40 seats actually support
without inventing a fact: no `tell`/ruin feature exists in this dump (0 of 51
features), so a "Fallen Hold" discovery is deliberately **not** in the
catalogue yet — the schema below is written so it slots in the moment a longer
deep-time scrub seals an age and produces one.

---

## 3. Progression model

**Recommendation: an Insight meter + auto-unlock queue, run exactly like
Faith/the Divine Will — not a building-and-click tech tree.**

Concretely:

- A new `BUILDINGS` entry, **Scholars' Hall** (`kind: 'research'`), the
  research-side twin of the Reliquary. Buildable/placeable through the
  *existing* machinery (cost, plot, Pixi recipe) exactly like every other
  building — no new UI paradigm.
- A one-line accessor mirroring `speakers()`:
  `researchers() { return 1 + this.level('scholarshall') * 2; }`
- **Insight** accrues every tick — `researchers() * INSIGHT_PER_SCHOLAR * dt`
  — a non-tradeable meter with no `res[]` entry and no cap, exactly like
  `faith`. It is *not* spent on the player's command; it just climbs.
- A small, fixed **discovery catalogue** (the 14 above) with per-entry
  `requires` (which prior discoveries must already be done) and `gate` (the
  data test — e.g. `rich.ore >= 0.5`). Because the underlying world data never
  changes for a founded hold, the *eligible set* is computed once at load and
  is stable — no re-rolling, no missable data.
- Each eligible-not-yet-done discovery has a fixed **insight cost** (Tier 1
  cheap, Tier 2 moderate, Tier 3 pricier — see the light dependency graph
  below). When accrued insight crosses the cheapest eligible discovery's cost,
  that discovery unlocks automatically, its bonus applies, and it's chronicled
  — **the exact shape of "faith crosses `faithThreshold()` → the Will
  speaks."** No discovery picker UI, no priority queue to manage: research
  reads as a slow, steady, legible drip, the way an idle game should.

**Why not a villager role / assignment system:** faith's speaker role exists
because faith visibly needs *bodies at the reliquary* to read as alive in the
town view. Insight can ship without that — a passive per-level accrual off
Scholars' Hall reads fine on the HUD meter alone, and it keeps the initial
footprint tiny (one building, one accessor, no new `ROLE`, no
`villagers.js`/`atlas.js` sprite work). Adding `ROLE.SCHOLAR` +
`roleWeights().scholar = level('scholarshall')` later, mirroring `speaker`
exactly, is a clean, isolated follow-up once the meter itself is validated —
not a blocker for v1.

**Light dependency tree** (3 tiers, so "small" per the brief, not a full DAG):

```
Tier 1 (always eligible, cheap — "surveys")
  S1 Bedrock Survey   S6 Reading the Sky   L1 Whose the Land
  L2 The Realm's Age  L3 The Crown's Reach

Tier 2 (requires one Tier-1 done + a data gate, moderate cost)
  S2 Ground's Age      (needs S1)
  S3 Charting the Waters   (gate: river/drainage)
  S4 The Good Ground       (gate: food-rich)
  S5 Salt Assay            (gate: salt-fed)
  L4 Lakes Named           (needs L2; gate: nearby lake)

Tier 3 (requires prior Tier-2/1 done + a rarer gate, pricier — "capstones")
  S7 Assay the Vein   (needs S1+S2; gate: ore-rich)
  L5 The Old Road Over (needs L2; gate: nearby pass)
  L6 The Old Fire       (needs S1; gate: nearby volcano)
  L7 Dragon Lairs Marked (needs L2; gate: nearby lair)
```

A hold whose data can't clear a gate (e.g. a landlocked cradle seat with no
ore, no salt, no lairs nearby) simply has fewer Tier-2/3 discoveries eligible
— it still gets all five Tier-1 surveys, so no hold ever sees an empty meter,
but its ceiling is honestly lower, same as its `rich{}` ceiling already is.

---

## 4. Narration

The Divine Will pipeline (`serve.mjs`) already has the right shape for this:
Opus (`willSys`) sees the whole state and utters cryptic directives; Haiku
speakers (`speakerSys`) each see a trimmed `parish` and turn one directive into
orders. Both prompts get one more sentence apiece:

> "If the state's `research.discovered` list is non-empty, your voice may
> allude to what the hold itself has learned of its land — never to anything
> outside that list. A hold that hasn't Assayed the Vein doesn't know its ore
> from its overburden; don't let it speak like it does."

This is the same "never invent a fact" discipline the whole game is built on,
now extended to the LLM layer: the model is explicitly told its narration is
bounded by the same read-only data the player's HUD is bounded by.

`stewardState()`/`speakerParish()` (`js/town/will.js`) gain one field:

```js
research: {
  insight: Math.round(g.researchInsight || 0),
  nextCost: nextDiscoveryCost(),           // null if fully discovered
  discovered: doneList.map(d => d.name),   // e.g. ["Bedrock Survey", "Salt Assay"]
},
```

so both the Will and its speakers can reference discoveries in their
directives/words ("the Vein remembers what was assayed"), and so a Steward-ask
free-text instruction like "focus on our salt" can be answered by a speaker
who actually knows whether Salt Assay has fired yet.

On unlock, `pushChronicle()` (already used for raids/spoilage,
`js/town/hud.js:325`) gets one more call site:

```js
pushChronicle(`📖 Discovered: ${d.name} — ${d.flavor(hold)}.`, 'discovery');
```

`renderWillPanel()`/`renderWillDetail()` already render `S.chronicle` generically
by `c.kind` (`<div class="cl ${c.kind}">`), so a `'discovery'` kind needs no
new markup — optionally a `.cl.discovery { color: var(--gold); }` rule in
`town.css` alongside the existing `.cl.raid`/`.cl.note`, purely cosmetic.

---

## 5. Implementation plan (minimal, additive)

### New file: `js/town/research.js` (ES module)

- `export const DISCOVERIES` — the 14-entry catalogue, each
  `{ id, cat: 'science'|'lore', name, tier, requires: [ids], gate: (hold) => bool, cost, flavor: (hold) => string, apply: (bon, hold) => void }`
  — same shape-of-array convention as `BUILDINGS`/`CROPS` in `game.js`, kept in
  the town layer (not `game.js`) because it's presentation/lore content, the
  same split `will.js` already draws between `game.js`'s mechanics and its own
  narrative state.
- `export function eligible(hold, done)` — `DISCOVERIES.filter(d => !done.includes(d.id) && d.requires.every(r => done.includes(r)) && d.gate(hold))`.
  Pure function of already-loaded `hold` data — safe to compute once and cache.
- `export function stepResearch(dt)` — reads `S.game.researchers()`, accrues
  `RS.insight`, and if `RS.insight >= cheapest eligible discovery's cost`,
  calls `unlock(d)`. Called from `townTick()` in `town.js` right next to the
  existing `if (S.game.faithReady) { … callWill(…) }` block — same cadence,
  same place.
- `function unlock(d)` — pushes `d.id` into `RS.done`, calls
  `d.apply(S.game.bon, S.hold)` (mutating the *already-existing* object — see
  below), calls `pushChronicle(...)`, and persists via `saveResearch()`.
- `export function applyAllDiscoveries()` — replays every `RS.done` entry's
  `apply()` against a freshly-built `S.game.bon` — called once right after
  `S.game = Game.load(S.hold)` in `town.js`'s `boot()`, so bonuses survive a
  reload (mirrors how `bonuses(hold)` itself is recomputed fresh on load, not
  serialized).
- `export function initResearchPanel()` / `renderResearchPanel()` — a new
  `makePanel({ region: 'tr', title: 'Study' })` call. `region-tr` is a flex
  column (`town.css:86`) that already stacks the "Works Bidden" panel — a
  second panel in the same region just stacks below it, **zero HTML/CSS
  changes required**. Shows the insight meter (`insight/nextCost`, same visual
  language as the Faith chip) and a short list of `RS.done` names.
- **Persistence**: its own localStorage key, `xanhold:research:<hold.id>`,
  loaded/saved by `loadResearch(id)`/`saveResearch(id)` (a small try/catch
  guard mirroring `game.js`'s `STORE`, since `research.js` is an ES module and
  `game.js`'s `STORE` isn't exported). **Migration is trivial by
  construction**: this is a brand-new key, so `loadResearch()` returning `null`
  simply seeds `{ insight: 0, done: [] }` — the same "missing key ⇒ default
  state" contract `Game.load()` already uses for `raw == null`. No existing
  save is touched or reshaped.

### `js/game.js` (two additive lines — no existing line changed)

```js
// in BUILDINGS:
{ id: 'scholarshall', name: "Scholars' Hall", kind: 'research',
  cost: { timber: 20, stone: 12, coin: 10 },
  desc: "Archives the land's own record — the hold's study of itself." },

// in class Game:
researchers() { return 1 + this.level('scholarshall') * 2; }
```

Everything else — the insight meter, the catalogue, the gating, the bonus
application, the persistence, the chronicle line — lives in `research.js`.
`bon`/`CFG` are already plain exported objects (`window.XANGAME.CFG`,
`this.bon` on every `Game` instance); `research.js` mutating
`S.game.bon.mul.ore *= 1.15` or `CFG.saltPreserveMax += 0.05` after the fact is
external composition, not a `game.js` rewrite — the same trick the file
already relies on internally (`this.bon` is computed once in the constructor
and read everywhere else).

### `js/town/buildings.js` (one-word addition)

Add `'scholarshall'` to the existing `CORE_TYPES` Set (`buildings.js:70`) so it
sites inside the walls like the Reliquary/Longhouse/Market. Reuse an existing
`HOUSE_OF`/`RECIPES` entry for its sprite (no new art needed for v1 — e.g. the
same whole-image pattern the Reliquary uses).

### `js/town/constants.js`

Add `scholarshall: "Scholars' Hall"` to `BUILD_NAME` (one line, `constants.js:69`).

### `js/town/will.js`

Add a `research` field to `stewardState()` and `speakerParish()` (see §4) —
two small object-literal additions, no control flow changed.

### `js/town/town.js`

Three call sites in `boot()`/`townTick()`:
- after `S.game = Game.load(S.hold)`: `loadResearch(S.hold.id); applyAllDiscoveries();`
- in `initHUD`-adjacent boot code: `initResearchPanel();`
- in `townTick()`, next to the faith check: `stepResearch(dt); renderResearchPanel();`

### `serve.mjs`

One sentence appended to both `willSys(...)` and `speakerSys(...)` template
strings (see §4's quoted addition), and `scholarshall` added to the
build-target enum text already hardcoded into `speakerSys` (`target: farm|
wharf|sawmill|quarry|mine|saltern|market|longhouse|granary|palisade|tower|
wall` → append `|scholarshall`), so speakers can actually bid the hold build
one.

### `town.css` (optional, cosmetic)

`.cl.discovery { color: var(--gold); }` alongside the existing `.cl.raid`/
`.cl.note` rules (`town.css:116-118`) — the chronicle already falls back to
the base `.cl` style without it (exactly like the un-styled `.cl.spoil` kind
today), so this is a nice-to-have, not a blocker.

### Biggest integration risk

**`S.game.bon` is built once in the `Game` constructor and never
recomputed** — every research bonus is applied by mutating that same object
*after* construction. If any future `game.js` change starts rebuilding `bon`
mid-game (e.g. a hot-reload of ancestry/tier logic, or a "re-derive on
festival" feature) without `research.js`'s `applyAllDiscoveries()` being
re-run immediately after, every discovered bonus silently vanishes with no
error and no save corruption — the hold just quietly stops benefiting from
research it still shows as "discovered" in the HUD. The fix is cheap
(`applyAllDiscoveries()` is idempotent and safe to call after *any* `bon`
rebuild) but it's easy to forget precisely because nothing breaks loudly when
it's missed.
