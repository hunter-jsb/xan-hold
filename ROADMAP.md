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
| F2 | per-instance building levels + upgrade action | game.js, buildings.js, town.js, hud.js | ☐ |
| F3 | keep as an upgradeable building (physical + functional) | game.js, buildings.js, town.js | ☐ |
| F4 | seasons + clearer day/night | game.js, terrain.js, town.js, hud.js | ☐ |
| F5 | starvation, disease, unhappiness | game.js, hud.js | ☐ |
| F6 | research — discover geology/salt/lore from world.js | new research.js, game.js, world.js, hud.js, serve.mjs | ☐ |
| F7 | sectioned walls + wall levels | walls.js, orders.js, state.js | ☐ |
| F8 | people fight raids; pathing affects clash | villagers.js, game.js, walls.js | ☐ |
| F9 | speaker fealty (pop→speaker, head-speaker worker distro) | villagers.js, orders.js, will.js, serve.mjs | ☐ |
| F10 | speaker UI cleanup + filterable log popout | hud.js, ui.js, town.css | ☐ |
| F11 | building relocation as a build action (wall-aware) | buildings.js, orders.js, town.js | ☐ |

## World-sim data available for F6 (Research) — `data/world.js` window.WORLD
120×50 grids (row-major, idx = y*120+x): `region elev temp drainage rock rockAge
salt salinity river owner`. Plus `climate{glacialIndex,latTop,latBottom}`,
`seats[40]{x,y,tier,name,realm,allegiance,pressure,ancestry,ancestryLabel}`,
`realms[8]{id,name,isCrown,seatX,seatY,age,ancestry,ancestryLabel}`,
`features[51]{kind,name,x,y}`. The hold sits at its seat's (x,y) → research reads
the REAL local rock/rockAge (geology), salt/salinity (deposits), drainage/river,
elevation, nearby named features, and realm history. Nothing is invented.

## Log
- 2026-07-12: baseline checkpointed (the full town.js modularization + walls
  rework 2 + 5-food-category system + spoilage, all previously uncommitted).
  Verifier rebuilt at scratchpad/verify.mjs, clean.
- 2026-07-12: **F1 done** — hovering a building now outlines its district on the
  ground (core = the walled bounding box, farmland = the true tilled perimeter;
  outlands works stay just a footprint) + tooltip tags the district. buildings.js
  gains districtOf()/coreBounds(); town.js gains drawDistrictBorder().
