// atlas.js — load the cozy CC0 pixel assets (Kenney Tiny Town tiles +
// sodri's 4-direction walk cycle) and slice them into named PixiJS
// textures, plus the "recipes" that compose modular tiles into whole
// buildings. Everything is 16px on a square grid; nothing loads off-network.
import { Assets, Texture, Rectangle } from 'pixi.js';

export const TILE = 16;
const ATLAS_COLS = 12;

// tile index -> its (col,row) in the packed atlas (12 cols).
const at = (base, idx) => new Texture({
  source: base.source,
  frame: new Rectangle((idx % ATLAS_COLS) * TILE, ((idx / ATLAS_COLS) | 0) * TILE, TILE, TILE),
});

// Building recipes: each is a list of {i: atlasIndex, x, y} tile placements
// in grid cells, top-left origin. The town anchors them at their base.
const RECIPES = {
  // Every building is composed only of COMPLETE, fully-outlined tiles — the
  // window-roofs (51/55) and solid-door walls (85/87/90), never the tiling
  // "fill" tiles (roof-middles, castle-wall interiors) whose outline runs on
  // just some edges and betrays the tileset.

  // The keep — a battlemented gatehouse (top + gated base), fully bordered.
  townhall: { w: 3, h: 2, tiles: [
    { i: 96, x: 0, y: 0 }, { i: 97, x: 1, y: 0 }, { i: 98, x: 2, y: 0 },
    { i: 120, x: 0, y: 1 }, { i: 124, x: 1, y: 1 }, { i: 122, x: 2, y: 1 },
  ] },
  // Cottages — a PEAKED (gable) roof over a solid-door wall. The gable's
  // overhang bridges to the wall so it reads as one cottage, not a roof-tile
  // stacked on a wall-tile (a flat roof directly on a wall shows the seam).
  cottageRed: { w: 1, h: 2, tiles: [{ i: 67, x: 0, y: 0 }, { i: 85, x: 0, y: 1 }] },
  cottageGrey: { w: 1, h: 2, tiles: [{ i: 63, x: 0, y: 0 }, { i: 90, x: 0, y: 1 }] },
  cottageWarm: { w: 1, h: 2, tiles: [{ i: 67, x: 0, y: 0 }, { i: 87, x: 0, y: 1 }] },
  // A mine — a stone front with a dark TUNNEL mouth (not a solid door).
  mineHut: { w: 1, h: 2, tiles: [{ i: 63, x: 0, y: 0 }, { i: 78, x: 0, y: 1 }] },
  // A farm is a tilled field — grass-edged (9-slice corners) so it blends
  // into the ground as a plowed patch, not a hard borderless tan square.
  farm: { w: 2, h: 2, tiles: [
    { i: 12, x: 0, y: 0 }, { i: 14, x: 1, y: 0 },
    { i: 36, x: 0, y: 1 }, { i: 38, x: 1, y: 1 },
    { i: 116, x: 1, y: 1 },
  ] },
  // The market is a cozy pixel-art merchant shop with striped awning — a 2-wide,
  // 1-deep footprint; the tall sprite rises above it (scale = w*TILE/imgWidth).
  market: { w: 2, h: 1, image: 'market' },
  // The reliquary is a whole-image sprite (a church), not tiles. w drives its
  // on-screen size (scale = w*TILE / image width) — 2 = about half of 4.
  reliquary: { w: 2, h: 3, image: 'church' },
  // The barracks is an animated sprite — 4 frames, martial aesthetics.
  barracks: { w: 3, h: 3, anim: 'barracks' },
};

// A trade prop set beside a cottage so its craft reads at a glance.
const PROP = { sawmill: 106, quarry: 115, mine: 115, saltern: 130, granary: 130, wharf: 131 };
// Which cottage palette a building uses when it's a house-with-prop.
const HOUSE_OF = {
  sawmill: 'cottageRed', quarry: 'mineHut', mine: 'mineHut',
  saltern: 'cottageWarm', granary: 'cottageRed', wharf: 'cottageGrey', longhouse: 'cottageWarm',
};

// Ground tiles by biome flavor.
const GROUND = { grass: [0, 1, 2], dirt: [25], path: [39, 40, 41], cobble: [43] };

// Trees compose as top-over-bottom stacks for a full canopy; small trees and
// bushes add variety. The tall stacks are weighted (repeated) so a forest
// reads lush, with a second, narrower silhouette (the 3x3 mosaic's CENTER
// column, which composites clean on its own — the outer columns don't;
// see CLUSTERS) mixed in at lower weight for canopy variety.
const TREES = {
  green: [{ t: 4, b: 16 }, { t: 4, b: 16 }, { t: 7, b: 31 }, { b: 28 }, { b: 5 }],
  autumn: [{ t: 3, b: 15 }, { t: 3, b: 15 }, { t: 10, b: 34 }, { b: 27 }, { b: 5 }],
};

// Big 3x3 forest masses for dense grove cores — placed ONLY as complete blocks
// (fragments render as cut stumps). Rows: [tops, mids, bottoms]. The centre
// column (7/19/31, 10/22/34) is the exception — it composites clean alone,
// which is where TREES' second tall shape above comes from.
const CLUSTERS = {
  green: [[6, 7, 8], [18, 19, 20], [30, 31, 32]],
  autumn: [[9, 10, 11], [21, 22, 23], [33, 34, 35]],
};

// Forest-floor clutter — purely decorative (no collision, never fellable),
// scattered thin through the wood so the ground under the canopy doesn't
// read as bare grass.
const CLUTTER = { bramble: 17, mushroom: 29 };

// Fence pieces for a palisade border.
const FENCE = { h: 45, v: 47, tl: 44, tr: 46, post: 59 };

export async function loadAtlas() {
  const packed = await Assets.load('/assets/tiles/tiny-town_atlas_packed.png');
  packed.source.scaleMode = 'nearest';

  const tex = (idx) => at(packed, idx);
  const ground = Object.fromEntries(Object.entries(GROUND).map(([k, v]) => [k, v.map(tex)]));
  const fence = Object.fromEntries(Object.entries(FENCE).map(([k, v]) => [k, tex(v)]));
  const clutter = Object.fromEntries(Object.entries(CLUTTER).map(([k, v]) => [k, tex(v)]));

  // Villager walk cycles — one sheet per direction, N frames wide.
  const dirs = ['down', 'up', 'left', 'right'];
  const walk = {};
  for (const d of dirs) {
    const sheet = await Assets.load(`/assets/characters/sodri/walk_${d}.png`);
    sheet.source.scaleMode = 'nearest';
    const n = 6, fw = sheet.width / n, fh = sheet.height;
    walk[d] = Array.from({ length: n }, (_, i) =>
      new Texture({ source: sheet.source, frame: new Rectangle(i * fw, 0, fw, fh) }));
  }

  // Building animations — barracks: 4 frames, pixel-perfect sprite.
  const barracksSheet = await Assets.load('/assets/buildings/barracks.png');
  barracksSheet.source.scaleMode = 'nearest';
  const n = 4, fw = barracksSheet.width / n, fh = barracksSheet.height;
  const barracksFrames = Array.from({ length: n }, (_, i) =>
    new Texture({ source: barracksSheet.source, frame: new Rectangle(i * fw, 0, fw, fh) }));

  // Resource-node sprites (Qoupy's ROGNs — NON-COMMERCIAL, credit required;
  // see assets/mining/CREDITS.md). 16px ore veins + a boulder centerpiece.
  // Loaded keyed by KIND name (oreTexByKind) so placeOreNodes (town.js) can
  // pick a texture by kind directly instead of a positional array. Covers
  // the full tier spread the Qoupy free set gives us: common-rock variety
  // (stone/smallRocks/mediumRock — same visual "stone" family, different
  // look), base metals (coal/tin/copper), a harder metal (iron), gems
  // (jade/amethyst), precious (gold), and rare/special (bloodstone/
  // forgeStone). keepStoneNode is left unloaded here — it reads as an
  // architectural outcrop prop, not a minable vein.
  const ORE_FILES = {
    stone: 'stoneNode', smallRocks: 'smallRocks', mediumRock: 'mediumRockNode',
    coal: 'coalNode', tin: 'tinNode', copper: 'copperNode', iron: 'ironNode',
    jade: 'jadeNode', amethyst: 'amethystNode', gold: 'goldNode',
    bloodstone: 'bloodstoneNode', forgeStone: 'forgeStoneNode',
  };
  const oreTexByKind = {};
  for (const [kind, file] of Object.entries(ORE_FILES)) {
    const t = await Assets.load(`/assets/mining/nodes/${file}.png`);
    t.source.scaleMode = 'nearest';
    oreTexByKind[kind] = t;
  }
  const oreTex = Object.values(oreTexByKind); // kept for anything wanting "all ore textures" as a flat list
  const boulderTex = await Assets.load('/assets/mining/nodes/boulderNode.png');
  boulderTex.source.scaleMode = 'nearest';

  // Whole-image buildings (the church reliquary) — linear scale for a clean
  // downscale from its high-res art to a few tiles wide.
  const churchTex = await Assets.load('/assets/buildings/church.png');
  churchTex.source.scaleMode = 'linear';
  // The merchant shop — pixel art, so nearest-neighbor scale.
  const marketTex = await Assets.load('/assets/buildings/market.png');
  marketTex.source.scaleMode = 'nearest';
  // Watchtower — the anchor a wood/stone wall spans between (walls rework).
  const towerTex = await Assets.load('/assets/buildings/tower.png');
  towerTex.source.scaleMode = 'linear';
  const images = { church: churchTex, market: marketTex, tower: towerTex };

  // Crop tiles for farm fields (ArMM overworld, CC0). Tilled-dirt based, so
  // they sit inside a Kenney grass-edged border and never touch grass directly
  // (ArMM's saturated green would clash at the seam).
  const armm = await Assets.load('/assets/tiles/armm1998_overworld_atlas.png');
  armm.source.scaleMode = 'nearest';
  const armmTile = (col, row) => new Texture({ source: armm.source, frame: new Rectangle(col * TILE, row * TILE, TILE, TILE) });
  const crops = { greens: armmTile(0, 34), grain: armmTile(1, 34), roots: armmTile(0, 35) };
  // Kenney 9-slice grass-edged dirt for the field border, keyed by edge:
  // farmDirt[`${edgeY},${edgeX}`] where edge is -1/0/1 (top/mid/bottom, left/mid/right).
  const farmDirt = {
    '-1,-1': tex(12), '-1,0': tex(13), '-1,1': tex(14),
    '0,-1': tex(24), '0,0': tex(25), '0,1': tex(26),
    '1,-1': tex(36), '1,0': tex(37), '1,1': tex(38),
  };
  // Generated INNER (concave) corners — Tiny Town's grass-dirt 9-slice has none,
  // so we composited a dirt tile + a grass nub per diagonal (build script in the
  // repo). Keyed `in:${dy},${dx}` = grass tucked into that corner, so the
  // farmland autotile turns a concave junction cleanly instead of glitching.
  const innerSheet = await Assets.load('/assets/tiles/farm-inner-corners.png');
  innerSheet.source.scaleMode = 'nearest';
  ['-1,-1', '-1,1', '1,-1', '1,1'].forEach((k, i) => {
    farmDirt[`in:${k}`] = new Texture({ source: innerSheet.source, frame: new Rectangle(i * TILE, 0, TILE, TILE) });
  });

  // Water (ArMM overworld, CC0) — a calm ripple fill for lakes/coast, a
  // diagonal-streak flow fill for rivers, and one foam shore-edge tile.
  // town.js rotates that one edge tile per side (N/S/E/W) instead of needing
  // 4 baked directions — the same trick wallPieceFor uses for fence corners.
  const water = {
    fill: [armmTile(3, 3), armmTile(4, 3), armmTile(5, 3)],
    flow: [armmTile(18, 6), armmTile(19, 6), armmTile(20, 6)],
    edge: armmTile(19, 8),
  };

  return { tex, ground, trees: TREES, clusters: CLUSTERS, clutter, fence, walk, oreTex, oreTexByKind, boulderTex, images, crops, farmDirt, cropOrder: ['greens', 'grain', 'roots'], anims: { barracks: barracksFrames }, RECIPES, PROP, HOUSE_OF, water };
}
