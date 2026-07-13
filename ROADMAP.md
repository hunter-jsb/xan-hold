# Steward of a Hold — autonomous roadmap

Driven autonomously (2026-07-12) while Hunter is away. Method per feature:
**research → fan out to a cheap subagent → review → verify → commit → next.**
Verifier: `node scratchpad/verify.mjs` (syntax + import-resolution + cross-module
refs — the closest thing to "does it boot" without a GPU). Each feature is its
own commit so anything can be rolled back.

## The asks (Hunter's list) → work items
- highlight district borders on building hover ...... **F1**
- expand the keep (physical + functional) as an upgrade ... **F3**
- a system for upgrading levels ..................... **F2**
- level-per-building (not all bldgs one pooled level) ... **F2**
- walls keep evolving with the above ............... folded into **F2/F7**
- use people for raids; pathing affects the clash ... **F8**
- building relocation as a build action (re-district, farm/keep expand, wall-aware) ... **F11**
- seasons + clearer day/night cycle ................ **F4**
- clean up speaker UI; filterable log popout ....... **F10**
- starvation, disease, unhappiness ................. **F5**
- speaker fealty (each pop serves one speaker; head speaker distributes workers; Will audits) ... **F9**
- walls around different sections; different wall levels ... **F7**
- **research** — discover real sciences/lore from the xan-world-sim dump ... **F6**

## Sequence (dependency-ordered)
| # | feature | touches | status |
|---|---------|---------|--------|
| F1 | district-border highlight on hover | town.js | ✅ |
| F2 | per-instance building levels + upgrade action | game.js, buildings.js, town.js, hud.js | ✅ |
| F3 | keep as an upgradeable building (physical + functional) | game.js, buildings.js, town.js | ✅ |
| F4 | seasons + clearer day/night | game.js, terrain.js, town.js, hud.js | ✅ |
| F5 | starvation, disease, unhappiness | game.js, hud.js | ✅ |
| F6 | research — discover geology/salt/lore from world.js | new research.js, game.js, hud.js, serve.mjs | ✅ |
| F7 | sectioned walls + wall levels | walls.js, orders.js, state.js | ✅ |
| F8 | people fight raids; pathing affects clash | villagers.js, game.js, town.js, raids.js, state.js | ✅ |
| F9 | speaker fealty (pop→speaker, head-speaker worker distro) | villagers.js, orders.js, will.js, serve.mjs | ☐ |
| F10 | speaker UI cleanup + filterable log popout | hud.js, ui.js, town.css | ✅ |
| F11 | building relocation as a build action (wall-aware) | buildings.js, orders.js, constants.js, hud.js | ✅ |

## World-sim data available for F6 (Research) — `data/world.js` window.WORLD
120×50 grids (row-major, idx = y*120+x): `region elev temp drainage rock rockAge
salt salinity river owner`. Plus `climate{glacialIndex,latTop,latBottom}`,
`seats[40]{x,y,tier,name,realm,allegiance,pressure,ancestry,ancestryLabel}`,
`realms[8]{id,name,isCrown,seatX,seatY,age,ancestry,ancestryLabel}`,
`features[51]{kind,name,x,y}`. The hold sits at its seat's (x,y) → research reads
the REAL local rock/rockAge (geology), salt/salinity (deposits), drainage/river,
elevation, nearby named features, and realm history. Nothing is invented.

## Log
- 2026-07-13: **F11 done** (delegated to a Sonnet subagent, reviewed by me).
  Building relocation as a MOVE order: relocateBuilding(key, dest) repositions a
  placed building, swaps its plot record, patches its hittable box (by key),
  frees the old plot + claims the new. Only RELOCATABLE types (core buildings +
  sawmill/quarry/saltern; farms/keep/mine/wharf excluded). pickRelocateDest reuses
  the build allocators + screens each candidate's footprint against S.walls/gates
  (wall-aware), releasing rejected claims. The steward redistricts: it moves a
  CORE building stranded outside a shrunken core zone back inside (can't thrash).
  Free (labor, not construction); shown as 🚚 in the log. Verifier clean.
- 2026-07-13: **F8 done** — raids are now FOUGHT by the folk, and pathing decides
  the clash. game.js stepRaids splits: offline stays one abstract loss
  (applyRaidLoss, extracted); a LIVE raid sets S.game.raidWave, and town.js
  spawns real raider entities (new js/town/raids.js). Raiders findPath to the
  core — routed around walls and THROUGH the gates — so a gated wall funnels
  them to a chokepoint. Soldiers (villagers.js pickTarget → nearest raider)
  intercept and cut them down (hp); any raider that breaks through loots a share
  (applyRaidLoss) and flees; unbroken raiders retreat after 45s. So walls +
  muster + pathing set the damage, not a die roll. logRaid retired (raids.js
  chronicles live; catchUp still summarizes offline). Verifier + harnesses clean.
  EYEBALL: the raider sprites, the clash at the gates, retreat.
- 2026-07-13: **F10 done** (delegated to a Sonnet subagent, reviewed by me). The
  Will story-popout now surfaces the FULL authoritative log (S.game.log, every
  kind) with a row of filter chips — All / Raids / Spoilage / Discoveries /
  Sickness / Notes — that narrow it in place (state in S.ui.logFilter, one
  delegated listener on the popout body, re-render via setContent). The compact
  left Will panel was tidied (per-speaker blocks, a "Recent" label). ui.js
  makePopout now exposes its body node; town.css got the filter-chip + .cl.spoil/
  .cl.plague styles. Ran concurrently with F7 on disjoint files. Verifier clean.
- 2026-07-13: **F7 done** — walls now ring named SECTIONS (core / farmland /
  town), not just the core, and each walled section has a TIER = its level:
  fence(1) → wood(2) → stone(3). planSectionWall cycles a section's four sides
  (keyed `${section}:${side}`, box locked in S.sectionBox); upgradeSectionWall
  re-lays the whole ring a tier sturdier with a tower at each corner (each side
  becomes a fort span). troopCap now weights spans by tier (wood 2, stone 3, via
  fortStrength). The steward rings the core, then the farmland, then upgrades
  sections as it prospers. planFortSpan retired (superseded). Old wall saves
  migrate (bare edges → core:*, core tier/box derived from existing tiles).
  Verifier clean; engine harnesses unaffected. EYEBALL: sectioned rings +
  tier tints/towers are render-only.
- 2026-07-13: **F5 done** — starvation, disease, unhappiness. A `happiness`
  stat (0..1) eases toward happinessTarget() (raised by a full/varied larder,
  safety, faith, a proud keep; lowered by hunger, crowding, and moraleShock from
  raids/plague) and GATES pop growth + drives emigration below 0.25. Disease
  strikes on a clock like raids — risk from crowding/heat/recent-spoilage/low-
  morale, salt lowers it — taking folk + denting morale. Starvation now sets a
  flag, hits morale, and chronicles. HUD Pop chip gains a "mood" footer; plague/
  hunger mirror to the chronicle. Persisted + migrated. Harness now 62 assertions
  (starvation shrinks pop, morale bounded, fed holds stay healthy).
- 2026-07-13: **F6 done** (delegated to the Sonnet research subagent, reviewed +
  verified by me). Research discovers the REAL simulated world: 14 discoveries
  (7 sciences + 7 lore) each gated on the hold's actual seed-42 seat data
  (rock/rockAge/drainage/salt/nearby features/realm age), unlocking live-read
  economy bonuses. Insight accrues from a Scholars' Hall (mirrors faith→Will).
  Bonuses are LIVE reads (never mutate `bon`), neutral at zero discoveries.
  Reviewed: verifier clean; 54 model invariants intact; smoke harness 7,200
  ticks no NaN/crash; confirmed window.XAN.idx/W + deriveHold x/y/nearby/
  allegiance/elev all exist (no browser blank-screen). EYEBALL: the "Study" HUD
  chip + the Scholars' Hall sprite are render-only.
- 2026-07-13: **F4 done** — a year now turns through four seasons (CFG.seasonDays,
  ~8 min each). `warmthNow(offline)` = baseline climate + a seasonal ±0.18 swing,
  threaded into stepSpoilage AND rates() (crops), so summer grows fast but spoils
  fast, winter preserves but slows growth. Day/night is clearer: deeper nights,
  a warm-ember tint through the golden hour (dawn+dusk), and a faint per-season
  colour wash. Overlays became white-Sprite tints (reliable per-frame tint;
  Texture.WHITE confirmed in vendored pixi). HUD gains a "sky" chip (day-part +
  season + warmth). Harness now 54 assertions. EYEBALL: night depth, the
  golden-hour warmth, and the season wash are render-only — confirm they read.
- 2026-07-13: **F3 done** — the keep is now a real upgradeable building (`keep`
  in BUILDINGS, kind civic, instances.keep=[L], max level 4, always present).
  PHYSICAL: `keepRecipe(level)` grows it taller each level (extra wall courses);
  level 1 is byte-identical to the old keep. FUNCTIONAL (all above level 1, so no
  balance shift for existing holds): +4 popCap, +2 defense, +1 troop cap per
  level. Steward upgrades it when the hold prospers. build(keep)/startSite(keep)
  guarded so there's never a 2nd keep. Harness extended (47 assertions).
  EYEBALL: the keep should visibly grow taller when upgraded; wall-course tiles
  108–110 are the documented keep art but only your render confirms they seat.
- 2026-07-13: **F2 done** — buildings now have PER-INSTANCE levels. `game.js`
  `lvl` (pooled count+output) → `instances[id]=[lvlA,…]`; `level(id)`=sum (all
  downstream unchanged), `count(id)`=sprites, new `upgrade`/`upgradeAny`/
  `canUpgrade`/`canDeepen`/`instanceLevel`. `build` appends a level-1 instance;
  the steward deepens-before-sprawl via generalized `EXPAND` orders. Old saves
  migrate (pooled level split across the sprite count it used to draw). Tooltip
  shows the building's OWN level; a small gold pip-stack marks upgraded
  buildings. Proven headless: scratchpad/harness-f2.mjs (34 assertions).
  Research subagent's F6 design doc landed at scratchpad/research-design.md.

- 2026-07-12: baseline checkpointed (the full town.js modularization + walls
  rework 2 + 5-food-category system + spoilage, all previously uncommitted).
  Verifier rebuilt at scratchpad/verify.mjs, clean.
- 2026-07-12: **F1 done** — hovering a building now outlines its district on the
  ground (core = the walled bounding box, farmland = the true tilled perimeter;
  outlands works stay just a footprint) + tooltip tags the district. buildings.js
  gains districtOf()/coreBounds(); town.js gains drawDistrictBorder().
