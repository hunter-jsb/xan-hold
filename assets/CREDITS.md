# Asset Credits — "Steward of a Hold"

All assets below are **CC0 (Creative Commons Zero, public domain)**. No attribution is
legally required for any of them; credit is given here voluntarily and as provenance.

Style target: ¾ top-down oblique, cozy 16-bit JRPG / Stardew-like, on a **square 16×16
tile grid** (not isometric). Everything here is authored on a 16 px grid so the packs
mix on the same tilemap.

## Family strategy

Kenney's **Tiny Town** is the primary, cosiest town family (the star of a town-builder:
buildings, grass, dirt, paths, trees). Kenney does **not** ship animated top-down
characters, and Tiny Town is thin on water/shore, sand, snow and a dedicated mine.
Those two gaps are filled by a second, fully CC0, same-16px-grid family —
**ArMM1998 "Zelda-like tilesets and sprites"** — which supplies the **4-direction
walk-cycle villager** and **water-with-shores + cave/mine entrances**. `sodri`'s CC0
walk cycle is included as a clean, evenly-sliced alternate character base.

> If perfect one-family cohesion matters more than Kenney's chunkier buildings, ArMM1998
> alone covers the entire world (terrain + buildings + animated characters) in a single
> style — see `tiles/armm1998_overworld_atlas.png` + `characters/armm1998/character.png`.

---

## 1. Kenney — "Tiny Town" (v1.1)  — PRIMARY town tiles + buildings

- **Author / distributor:** Kenney (https://kenney.nl)
- **Source page:** https://kenney.nl/assets/tiny-town
- **Direct download used:** https://kenney.nl/media/pages/assets/tiny-town/a415fbeb49-1735736916/kenney_tiny-town.zip
- **License (quoted verbatim from the pack's `License.txt`):**
  > License: (Creative Commons Zero, CC0)
  > http://creativecommons.org/publicdomain/zero/1.0/
  > This content is free to use in personal, educational and commercial projects.
  > Support us by crediting Kenney or www.kenney.nl (this is not mandatory)
- **Layout:** 16×16 px tiles, 1 px spacing between tiles. Atlas = **12 columns × 11 rows
  = 132 tiles**. Individual tiles also provided (`tile_0000`–`tile_0131`, row-major).
- **Used for:** grass, dirt, dirt-path, cobblestone, trees/forest (terrain); cottages
  (grey + red-roof + timber walls, doors, windows, gables), stone keep/town-hall with
  gate arch, wooden palisade + posts, market cart, signs, crates/barrels, tools, chest,
  water trough (buildings/props).

## 2. ArMM1998 — "Zelda-like tilesets and sprites"  — animated characters + water/mine terrain

- **Author:** ArMM1998
- **Source page:** https://opengameart.org/content/zelda-like-tilesets-and-sprites
- **Direct download used:** https://opengameart.org/sites/default/files/gfx_3.zip
- **License (verified on source page):** **CC0** — "CC0 1.0 Universal (CC0 1.0) Public
  Domain Dedication" (https://creativecommons.org/publicdomain/zero/1.0/). No attribution
  required.
- **Layout:** 16×16 px tiles. `Overworld.png` = 640×576 (40×36 tile atlas) with grass,
  dirt, **water + animated shorelines**, cobble, trees, log cabins, stone walls with
  **gate/cave/mine arches**, fountains/wells, striped **market stall**, fences, crops.
  `character.png` = 272×256 — a single villager base (~16 px wide × ~20–24 px tall frames,
  hand-packed) containing a **4-direction walk cycle** plus a **4-direction sword-attack**
  set. See `characters/armm1998/character_indexed.png` for the sliced grid.
- **Used for:** the animated villager (palette-swap for farmer/miner/soldier/trader) and
  the supplemental water/shore + mine-entrance terrain (`tiles/armm1998_overworld_atlas.png`).

## 3. sodri — "Character 4 directional walking"  — alternate clean walk-cycle base

- **Author:** sodri
- **Source page:** https://opengameart.org/content/character-4-directional-walking
- **Direct download used:** https://opengameart.org/sites/default/files/walking.7z
- **License (verified on source page):** **CC0**. Author's note (verbatim): "you can give
  credits to me or you can claim them. this character is made for the good people of earth
  and it belongs to them, if you are not from this planet you must give attribution to me".
- **Layout (rows = directions, cols = frames):** 4 separate PNG strips, **6 frames each**.
  `walk_down.png` / `walk_up.png` = 84×22 (6 × 14 px). `walk_left.png` / `walk_right.png`
  = 78×22 (6 × 13 px).

## 4. Clint Bellanger — "Tiny Creatures" (v1.0)  — THE animal family (neutral + hostile)

- **Author:** Clint Bellanger (clintbellanger.net)
- **Source page:** https://opengameart.org/content/tiny-creatures
- **Direct download used:** https://opengameart.org/sites/default/files/tiny-creatures.zip
- **License (quoted verbatim from the pack's `License.txt`):**
  > License: (Creative Commons Zero, CC0) http://creativecommons.org/publicdomain/zero/1.0/
  > This content is free to use in personal, educational and commercial projects.
  > Support my work by crediting Clint Bellanger (this is not mandatory)
- **Provenance note:** the pack is explicitly "an expansion of Kenney's Tiny Dungeon and
  Tiny Town … made with Kenney's permission" — literally the same family as our primary
  town tiles, which is why it slots in without a style seam.
- **Layout:** 16×16 px tiles, 1 px spacing, atlas = **10 cols × 18 rows = 180 tiles**
  (`tile_0001`–`tile_0180`, 1-indexed, row-major). Every creature is a **single static
  pose facing right** — the author's own note says to horizontal-flip for left-facing.
  No walk cycles; movement reads via flipping + a bob (same trick as the caravan crate).
- **Used for:** the map animals. Neutral/tameable — sheep (0154), goat (0153), chicken
  (0151), cow (0152), deer (0163), fawn (0162), rabbit (0178). Hostile — boar (0161),
  bears ×3 palettes (0164 brown / 0166 black / 0165 polar), snakes ×2 (0041 green /
  0042 tan). Plus the raccoon (0179) — kin to the one already sitting on the ArMM
  market-stall counter. The rest of the sheet (fantasy monsters) is unused for now.

## 5. Kenney — "Tiny Farm" (v1.0)  — pen/livestock props + alternate farm animals

- **Author / distributor:** Kenney (https://kenney.nl)
- **Source page:** https://kenney.nl/assets/tiny-farm
- **Direct download used:** https://kenney.nl/media/pages/assets/tiny-farm/dfded1ae3e-1782913588/kenney_tiny-farm.zip
- **License (quoted verbatim from the pack's `License.txt`):**
  > License: (Creative Commons Zero, CC0)
  > http://creativecommons.org/publicdomain/zero/1.0/
  > This content is free to use in personal, educational and commercial projects.
  > Support us by crediting Kenney or www.kenney.nl (this is not mandatory)
- **Layout:** 16×16 px tiles, 1 px spacing, atlas = **12 cols × 11 rows = 132 tiles**
  (`tile_0000`–`tile_0131`, 0-indexed, row-major — same convention as Tiny Town).
- **Used for:** kept mainly for the PEN/TAMING dressing to come — barn walls/roof, silo,
  troughs, feed baskets, milk jug, farm fences — plus its own static sheep (0120),
  goat (0121), chicken (0122) as same-hand alternates to the Tiny Creatures trio.

---

## On-disk inventory (all paths under `assets/`)

```
tiles/
  tiny-town_atlas.png            203×186  Kenney master atlas (16px tiles, 1px gaps, 12×11)
  tiny-town_atlas_packed.png     192×176  Kenney packed atlas (16px tiles, no gaps, 12×11)
  tiny-town_atlas_indexed.png             labeled tile-index map (0–131) for the atlas
  tiny-town_sample.png           918×515  Kenney showcase render (has embedded CC0 banner)
  armm1998_overworld_atlas.png   640×576  ArMM1998 CC0 world: water+shore, mine arches, etc.
  terrain/grass/   3 tiles   (tile_0000–0002)   16×16
  terrain/dirt/    9 tiles   (tile_0012–0038)   16×16   grass-bordered dirt, 9-slice edges
  terrain/path/    7 tiles   (tile_0039–0045)   16×16   dirt path + cobblestone
  terrain/trees/  27 tiles   (tile_0003–0035)   16×16   green + autumn trees, bush, mushrooms
buildings/
  tiny-town_atlas.png / tiny-town_atlas_indexed.png   (same Kenney atlas, buildings live here)
  houses/  32 tiles  (tile_0048–0091)  16×16  roofs (grey+red), walls, doors, windows, gables, arches
  keep/    18 tiles  (tile_0096–0123)  16×16  crenellated stone keep/town-hall walls + gate
  fences/  16 tiles  (tile_0056–0095)  16×16  wooden palisade posts/rails + market cart
  props/   18 tiles  (tile_0103–0131)  16×16  tools, chest, anvil, coins, beehive, water trough, static guard
characters/
  armm1998/character.png          272×256  animated villager (4-dir walk + 4-dir attack)
  armm1998/character_indexed.png           16px-grid slice map of the above
  sodri/walk_down.png   84×22   6 frames × 14px   (facing down)
  sodri/walk_up.png     84×22   6 frames × 14px   (facing up)
  sodri/walk_left.png   78×22   6 frames × 13px   (facing left)
  sodri/walk_right.png  78×22   6 frames × 13px   (facing right)
animals/
  sheep/goat/chicken/cow/deer/fawn/rabbit .png   16×16  neutral roster (Tiny Creatures)
  boar/bear/bear_black/bear_polar/snake/snake_tan/raccoon .png  16×16  hostile roster (Tiny Creatures)
  tiny-creatures_atlas.png   160×288  full 180-tile packed atlas (future picks: monsters etc.)
  tiny-farm_atlas.png        192×176  Kenney Tiny Farm packed atlas (pen props + alt animals)
  LICENSE-tiny-creatures.txt / LICENSE-tiny-farm.txt   the packs' own CC0 license files
_src/    original archives + Kenney License.txt (provenance)
```

## Coverage vs. request / known gaps

- Covered: grass, dirt/path, stone/cobble, trees/forest, water+shore (ArMM), cottages,
  wheat/crops, market stall, palisade+gate, storehouse (crates/barrels), keep/town-hall,
  mine/cave entrance (ArMM arches), animated 4-direction villager.
- **Sand** and **snow/tundra** ground tiles are not present in either CC0 family here.
  Cleanest CC0 fill: Kenney "Tiny Ski" (snow) and Kenney's beach/desert tiles — both CC0
  from kenney.nl — added on the same 16px grid if needed.
- Sawmill/quarry/mine as dedicated building sprites don't exist as single icons; compose
  them from Kenney log/crate/tool tiles + the ArMM cave-arch, or use Kenney "Tiny Dungeon"
  (CC0) props.
- **No CC0 wolf exists** (exhaustive 2026-07 sweep): every top-down pixel wolf on OGA is
  CC-BY/CC-BY-SA/GPL (LPC lineage) or side-view. Tiny Creatures' wolf-headed figures are
  bipedal monster-people, not animals. Options if a wolf is ever wanted: commission/draw
  one over the Tiny Creatures boar/bear proportions, or accept an attribution license.
  Until then the hostile roster is boar/bear/snake.
