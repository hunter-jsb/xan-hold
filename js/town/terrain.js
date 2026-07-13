// terrain.js — the world's ground: plot grid, ground + forest painting, forest
// regrowth, the ore field, water features, and build/appear sprite effects.
import { Sprite, Graphics } from 'pixi.js';
import { TILE } from './atlas.js';
import { S } from './state.js';
import { PLOT, PLOTS_X, PLOTS_Y, TOWN_W, TOWN_H, CENTER_TX, CENTER_TY, CENTER_PX, CENTER_PY } from './constants.js';
import { rng, DIRS4 } from './coords.js';

export function buildPlots() {
  const cx = CENTER_PX, cy = CENTER_PY;
  const list = [];
  for (let py = 0; py < PLOTS_Y; py++)
    for (let px = 0; px < PLOTS_X; px++)
      list.push({ px, py, tx: px * PLOT, ty: py * PLOT, d: Math.hypot(px - cx, py - cy) });
  list.sort((a, b) => a.d - b.d);
  S.plots = list;
}

export function paintGround() {
  const r = rng((S.hold.x * 73856093) ^ (S.hold.y * 19349663));
  const g = S.atlas.ground;
  const isCold = /tundra|glacier/.test(S.hold.region);
  const isRocky = /plateau|mountain|foothill|cliff/.test(S.hold.region);
  const treePool = (S.hold.temp < 9) ? S.atlas.trees.autumn : S.atlas.trees.green;
  for (let ty = 0; ty < TOWN_H; ty++) {
    for (let tx = 0; tx < TOWN_W; tx++) {
      let pool = g.grass;
      if (isRocky && r() < 0.28) pool = g.dirt;
      const t = new Sprite(pool[(r() * pool.length) | 0]);
      t.x = tx * TILE; t.y = ty * TILE;
      if (isCold) t.tint = 0xd8e2e8;
      S.ground.addChild(t);
    }
  }
  // --- clumped groves: trees gather into dense stands with clearings between,
  // rather than an even static. Grove count/size follow the hold's timber
  // richness (from the world-sim). Never build over the town's plots.
  const near = new Set(S.plots.slice(0, 22).map((p) => `${p.px},${p.py}`));
  const timber = S.hold.rich.timber; // 0..1
  const onBuild = (tx, ty) => tx < 0 || ty < 0 || tx >= TOWN_W || ty >= TOWN_H || near.has(`${Math.floor(tx / PLOT)},${Math.floor(ty / PLOT)}`);
  const nearTown = (tx, ty) => Math.abs(tx - CENTER_TX) < 26 && Math.abs(ty - CENTER_TY) < 22;
  // EVERY tree is tracked by its base tile (S.allTrees) so a feature painted
  // later — the river, the ore field — can drown any that stand on it, even the
  // far DECORATIVE trees that never become fellable wood nodes. Near-town trees
  // are additionally registered as wood nodes so a woodcutter can fell them.
  S.allTrees = [];
  // occupied — one trunk per base tile, shared across the WHOLE forest pass
  // (grove cores, radial scatter, lone trees). Two placeTree stacks landing on
  // the same tile used to double-thick the trunk (half the visual noise); this
  // guard keeps every base tile singly claimed, however it got proposed.
  const occupied = new Set();
  const regWood = (tx, ty, sprites) => {
    occupied.add(`${tx},${ty}`);
    S.allTrees.push({ tx, ty, sprites });
    if (nearTown(tx, ty)) S.woodNodes.push({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE, sprites });
  };
  const tree = (tx, ty, rec) => placeTree(tx * TILE + TILE / 2, ty * TILE + TILE, rec);
  const tall = () => treePool[(r() * 3) | 0];          // weighted 2-tile stacks
  const small = () => treePool[3 + ((r() * 2) | 0)];   // single tree or bush

  const nGroves = Math.round(7 + timber * 20);
  for (let i = 0; i < nGroves; i++) {
    const gx = 2 + Math.floor(r() * (TOWN_W - 4));
    const gy = 2 + Math.floor(r() * (TOWN_H - 4));
    const rad = 3 + r() * (3 + timber * 3);
    // Dense grove CORE: a tight grid of individual tall-tree stacks at the
    // grove centre stands in for the old 3x3 mosaic cluster — many overlapping
    // canopies read as one lush mass, but each is its own self-contained
    // placeTree unit (sorts by its own base row) rather than a multi-tile
    // mosaic that other z-sorted entities could slice into mid-row.
    if (r() < 0.6) {
      for (let cc = -1; cc <= 1; cc++) for (let rr = -2; rr <= 0; rr++) {
        const tx = gx + cc, ty = gy + rr;
        if (onBuild(tx, ty) || occupied.has(`${tx},${ty}`)) continue;
        if (r() < 0.85) { const ts = tree(tx, ty, tall()); regWood(tx, ty, ts); } // 85% fill — the 15% gaps are the clearing
      }
    }
    const ir = Math.ceil(rad);
    for (let dy = -ir; dy <= ir; dy++) for (let dx = -ir; dx <= ir; dx++) {
      const tx = gx + dx, ty = gy + dy;
      if (onBuild(tx, ty) || occupied.has(`${tx},${ty}`)) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > rad) continue;
      if (r() < (1 - dist / rad) ** 2 * 0.8) { const ts = tree(tx, ty, dist < rad * 0.55 ? tall() : small()); regWood(tx, ty, ts); }
    }
  }
  // a few lone trees/bushes in the open country between groves
  for (let ty = 0; ty < TOWN_H; ty++) for (let tx = 0; tx < TOWN_W; tx++) {
    if (onBuild(tx, ty) || occupied.has(`${tx},${ty}`)) continue;
    if (r() < 0.008 + timber * 0.012) { const ts = tree(tx, ty, r() < 0.5 ? small() : tall()); regWood(tx, ty, ts); }
  }
  // forest-floor clutter (mushrooms, bramble) — a light dusting under the
  // canopy, purely decorative: no collision, no wood node, never registered
  // in occupied/S.allTrees, so it never blocks a trunk or needs clearing.
  const clutterPool = [S.atlas.clutter.mushroom, S.atlas.clutter.bramble];
  for (let ty = 0; ty < TOWN_H; ty++) for (let tx = 0; tx < TOWN_W; tx++) {
    if (onBuild(tx, ty) || occupied.has(`${tx},${ty}`)) continue;
    if (r() < 0.004 + timber * 0.006) {
      const c = new Sprite(clutterPool[(r() * clutterPool.length) | 0]);
      c.x = tx * TILE; c.y = ty * TILE;
      S.ground.addChild(c);
    }
  }
  // Remember the forest's near-town size + palette so felled trees can regrow.
  S.woodCap = S.woodNodes.length;
  S.treePool = treePool;
  scheduleRegrow();
}


// placeTree stacks a tree's canopy over its trunk, both anchored at the
// base so the whole tree y-sorts as one against villagers and buildings.
// Returns the sprites so a wood node can fell (remove) them when chopped.
export function placeTree(cx, baseY, rec) {
  const sprites = [];
  const b = new Sprite(S.atlas.tex(rec.b));
  b.anchor.set(0.5, 1); b.x = cx; b.y = baseY; b.zIndex = baseY;
  S.entities.addChild(b); sprites.push(b);
  if (rec.t != null) {
    const t = new Sprite(S.atlas.tex(rec.t));
    t.anchor.set(0.5, 1); t.x = cx; t.y = baseY - TILE; t.zIndex = baseY;
    S.entities.addChild(t); sprites.push(t);
  }
  return sprites;
}

// The forest recovers: every so often a fresh sapling (and its wood node)
// grows back on open near-town ground, up to the original forest size.
export function regrowOne() {
  if (!S.treePool || S.woodNodes.length >= (S.woodCap || 0)) return;
  for (let t = 0; t < 12; t++) {
    const tx = Math.floor(CENTER_TX + (Math.random() - 0.5) * 46);
    const ty = Math.floor(CENTER_TY + (Math.random() - 0.5) * 38);
    if (tx < 1 || ty < 1 || tx >= TOWN_W - 1 || ty >= TOWN_H - 1) continue;
    if (S.usedPlots.has(`${Math.floor(tx / PLOT)},${Math.floor(ty / PLOT)}`)) continue;
    if (S.water.has(`${tx},${ty}`) || S.walls.has(`${tx},${ty}`)) continue; // no saplings in the river or on the wall
    const px = tx * TILE + TILE / 2, py = ty * TILE + TILE;
    if (S.woodNodes.some((n) => Math.abs(n.x - px) < TILE * 2 && Math.abs(n.y - py) < TILE * 2)) continue;
    const rec = S.treePool[(Math.random() * S.treePool.length) | 0];
    const sprites = placeTree(px, py, rec);
    for (const s of sprites) s.alpha = 0;
    const t0 = performance.now();
    const grow = () => { const k = Math.min(1, (performance.now() - t0) / 500); for (const s of sprites) s.alpha = k; if (k < 1) requestAnimationFrame(grow); };
    requestAnimationFrame(grow);
    S.woodNodes.push({ x: px, y: py, sprites });
    return;
  }
}
export function scheduleRegrow() {
  setTimeout(() => { regrowOne(); scheduleRegrow(); }, 9000 + Math.random() * 6000);
}

// ---- ore field, water, and build/appear effects --------------------
const ORE_KINDS = [
  { kind: 'stone', tex: 'stone', gate: 0, w: (o) => 9 - o * 4 },
  { kind: 'smallRocks', tex: 'smallRocks', gate: 0, w: (o) => 1.2 + (1 - o) * 1.3 },
  { kind: 'mediumRock', tex: 'mediumRock', gate: 0, w: (o) => 0.6 + (1 - o) * 0.8 },
  { kind: 'coal', tex: 'coal', gate: 0.04, w: (o) => 1.5 + o * 4 },
  { kind: 'tin', tex: 'tin', gate: 0.08, w: (o) => 1.2 + o * 4 },
  { kind: 'copper', tex: 'copper', gate: 0.12, w: (o) => 1.3 + o * 4.5 },
  { kind: 'iron', tex: 'iron', gate: 0.28, w: (o) => 1 + o * 5 },
  { kind: 'jade', tex: 'jade', gate: 0.32, w: (o) => 0.8 + o * 3.5 },
  { kind: 'amethyst', tex: 'amethyst', gate: 0.40, w: (o) => 0.7 + o * 3.5 },
  { kind: 'gold', tex: 'gold', gate: 0.55, w: (o) => 0.5 + o * 4 },
  { kind: 'bloodstone', tex: 'bloodstone', gate: 0.72, w: (o) => 0.4 + o * 3 },
  { kind: 'forgeStone', tex: 'forgeStone', gate: 0.80, w: (o) => 0.35 + o * 3 },
];
// "small carry" family (see CARRY.miner.scale below) — plain-rock reskins
// still haul like stone, not like a metal/gem chunk.
export const STONE_KIND = new Set(['stone', 'smallRocks', 'mediumRock']);

// placeOreNodes drops an ore field into the wilderness — a rocky patch with
// scattered veins that miners walk out to work. The field's LOCATION is
// still hold-seeded (a geographic feature — the same hold's outcrop sits in
// the same place every time you found it), but its COMPOSITION is NOT: which
// kinds show up and in what mix rolls fresh via Math.random each playthrough
// (mirrors farmlandAnchor's un-seeded siting), while staying grounded in the
// hold's real richness — see ORE_KINDS above.
export function placeOreNodes() {
  const r = rng((S.hold.x * 2654435761) ^ (S.hold.y * 40503) ^ 0x5eed);
  const a = r() * Math.PI * 2;
  const fx = Math.round(CENTER_TX + Math.cos(a) * 12);   // just outside the town, in view
  const fy = Math.round(CENTER_TY + Math.sin(a) * 11);
  S.oreFieldCenter = { x: fx * TILE, y: fy * TILE }; // outerBias's quarry pull, and farmlandAnchor's clearance scoring
  const oreR = S.hold.rich.ore, stoneR = S.hold.rich.stone;
  const count = 5 + Math.round((oreR + stoneR) * 8); // richer rock → a bigger field
  // Every kind the richness has unlocked gets guaranteed at least one node
  // before the rest fill in by weight (Math.random-driven, NOT the hold's
  // seeded `r`) — so an ore-bearing hold always reads as several distinct
  // kinds, never a single flat texture. A poor hold still gets rock-family
  // variety (smallRocks/mediumRock) and maybe a speck of coal; a rich one
  // gets guaranteed metals/gems too, topped up toward the rarer/higher tiers.
  const pool = ORE_KINDS.filter((k) => oreR >= k.gate).map((k) => ({ kind: k.kind, tex: S.atlas.oreTexByKind[k.tex], w: k.w(oreR) }));
  const totalW = pool.reduce((sum, p) => sum + p.w, 0);
  const pickKind = () => { let x = Math.random() * totalW; for (const p of pool) { if ((x -= p.w) <= 0) return p; } return pool[0]; };
  const guaranteed = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.min(pool.length, count));
  const queue = [...guaranteed];
  while (queue.length < count) queue.push(pickKind());
  queue.sort(() => Math.random() - 0.5); // don't cluster the guaranteed picks at the front of the field
  // buildPlots() tiles the WHOLE map (sorted by distance from centre), and the
  // field sits only ~12 tiles out — squarely in the plots a growing town would
  // claim next. Reserve the field's footprint (a separate set from usedPlots,
  // which also drives villager wander points — this is for the plot
  // allocators only) so a farm/sawmill/etc. never lands on a vein or a mine
  // raised on one.
  for (let ty = fy - 5; ty <= fy + 5; ty++) for (let tx = fx - 5; tx <= fx + 5; tx++) {
    S.oreFieldPlots.add(`${Math.floor(tx / PLOT)},${Math.floor(ty / PLOT)}`);
  }
  // The forest was painted before this field existed (see boot order) — clear
  // any trees it scattered into the footprint so a vein/mine never pokes out
  // from under a canopy. Shrink the regrowth cap to match, so the clearing
  // mostly sticks (see regrowOne).
  const fieldPx = fx * TILE, fieldPy = fy * TILE, clearR = 5.5 * TILE;
  let cleared = 0;
  for (let i = S.woodNodes.length - 1; i >= 0; i--) {
    const wn = S.woodNodes[i];
    if (Math.abs(wn.x - fieldPx) > clearR || Math.abs(wn.y - fieldPy) > clearR) continue;
    for (const s of (wn.sprites || [])) { S.entities.removeChild(s); s.destroy(); }
    S.woodNodes.splice(i, 1); cleared++;
  }
  if (S.woodCap) S.woodCap -= cleared;
  // a bare-earth patch under the field for a quarry look
  for (let dy = -3; dy <= 3; dy++) for (let dx = -4; dx <= 4; dx++) {
    if (r() < 0.55) { const t = new Sprite(S.atlas.ground.dirt[0]); t.x = (fx + dx) * TILE; t.y = (fy + dy) * TILE; S.ground.addChild(t); }
  }
  const addNode = (kind, tex, gx, gy) => {
    const s = new Sprite(tex); s.anchor.set(0.5, 1);
    s.x = gx * TILE + TILE / 2; s.y = gy * TILE + TILE; s.zIndex = s.y;
    S.entities.addChild(s);
    // `tex`/`kind` are kept separately from `sprite` so a claimed node (its
    // sprite destroyed — a mine now stands there) still has a stable texture
    // and kind for any miner already carrying ore from it home (see CARRY).
    S.oreNodes.push({ x: s.x, y: s.y, sprite: s, tex, kind, claimedByMine: false });
  };
  addNode('stone', S.atlas.boulderTex, fx, fy); // a boulder centerpiece — rock, not ore
  const used = new Set([`${fx},${fy}`]);
  for (let i = 0; i < count; i++) {
    let gx, gy, key, t = 0;
    do { gx = fx + Math.round((r() - 0.5) * 7); gy = fy + Math.round((r() - 0.5) * 5); key = `${gx},${gy}`; } while (used.has(key) && ++t < 12);
    used.add(key);
    const { kind, tex } = queue[i];
    addNode(kind, tex, gx, gy);
  }
}

// ---- water --------------------------------------------------------------
// placeWater lays impassable water from the hold's own worldgen node
// (S.hold.n: riverMax/lake/sea — see S.world.js scanNeighborhood). Exactly one
// feature is drawn, whichever of river/lake/coast the numbers favor, scored
// with the same weights waterRich() (game.js) uses to gate the Fishing
// Wharf — so the shape on screen always agrees with whether a wharf is even
// offered. Every covered tile lands in S.water, which findPath blocks
// exactly like S.walls, and the shoreline (land touching water) is banked in
// S.shoreSites for nextWharfSite to claim.
export function placeWater() {
  const n = S.hold.n || {};
  const river = n.riverMax || 0, lake = n.lake || 0, sea = n.sea || 0;
  const scores = { river: river * 0.09, lake: lake * 0.12, coast: sea * 0.05 };
  const [kind, score] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (score < 0.02) return; // negligible water here — no feature, no shore, no wharf (matches the wharf's own gate)

  const r = rng((S.hold.x * 6542989) ^ (S.hold.y * 96557) ^ 0xdeadbeef);
  const tiles = kind === 'river' ? riverTiles(r, river) : kind === 'lake' ? lakeTiles(r, lake) : coastTiles(r, sea);

  // Never over the town's core (mirrors paintGround's own no-build `near`
  // set) or the ore field's footprint — a hold can have both out in the wilds.
  const core = new Set(S.plots.slice(0, 22).map((p) => `${p.px},${p.py}`));
  for (const [tx, ty] of tiles) {
    if (tx < 0 || ty < 0 || tx >= TOWN_W || ty >= TOWN_H) continue;
    const pk = `${Math.floor(tx / PLOT)},${Math.floor(ty / PLOT)}`;
    if (core.has(pk) || S.oreFieldPlots.has(pk)) continue;
    S.water.add(`${tx},${ty}`);
    S.waterPlots.add(pk);
  }
  if (!S.water.size) return; // the whole shape landed in reserved ground — give up quietly

  paintWaterTiles(kind, r);
  clearTreesUnderWater();
  buildShoreSites();
}

// riverTiles — a wavy vertical band offset well clear of the town centre;
// width (and wobble) rise with riverMax (a Kropan-scale river runs wide).
export function riverTiles(r, river) {
  const width = Math.max(2, Math.min(8, Math.round(2 + river * 0.5)));
  const side = r() < 0.5 ? -1 : 1;
  const baseX = CENTER_TX + side * (20 + r() * 10);
  const amp = 3 + r() * 3, freq = 0.05 + r() * 0.04, phase = r() * Math.PI * 2;
  const tiles = [];
  for (let ty = 0; ty < TOWN_H; ty++) {
    const cx = Math.round(baseX + Math.sin(ty * freq + phase) * amp);
    for (let dx = 0; dx < width; dx++) tiles.push([cx - Math.floor(width / 2) + dx, ty]);
  }
  return tiles;
}

// lakeTiles — a wobbly rounded blob off to one side; radius rises with lake.
export function lakeTiles(r, lake) {
  const rad = Math.max(3, Math.min(13, 3 + lake * 7));
  const angle = r() * Math.PI * 2, dist = 22 + r() * 10;
  const cx = Math.round(CENTER_TX + Math.cos(angle) * dist);
  const cy = Math.round(CENTER_TY + Math.sin(angle) * dist * 0.75); // the map's flatter than it's wide
  const bumps = 10, wob = Array.from({ length: bumps }, () => 0.75 + r() * 0.5);
  const wobbleAt = (a) => {
    const f = ((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * bumps;
    const i0 = Math.floor(f) % bumps, i1 = (i0 + 1) % bumps, t = f - Math.floor(f);
    return wob[i0] * (1 - t) + wob[i1] * t;
  };
  const tiles = [];
  const ir = Math.ceil(rad) + 2;
  for (let dy = -ir; dy <= ir; dy++) for (let dx = -ir; dx <= ir; dx++) {
    if (Math.hypot(dx, dy) <= rad * wobbleAt(Math.atan2(dy, dx))) tiles.push([cx + dx, cy + dy]);
  }
  return tiles;
}

// coastTiles — one map edge filled to a wavy depth; thickness rises with sea.
export function coastTiles(r, sea) {
  const depth = Math.max(6, Math.min(16, Math.round(8 + sea * 40)));
  const edge = ['n', 's', 'e', 'w'][Math.floor(r() * 4)];
  const bumps = 12, wob = Array.from({ length: bumps }, () => -3 + r() * 6);
  const wobbleAt = (i, span) => {
    const f = (i / span) * bumps;
    const i0 = Math.floor(f) % bumps, i1 = (i0 + 1) % bumps, t = f - Math.floor(f);
    return wob[i0] * (1 - t) + wob[i1] * t;
  };
  const tiles = [];
  const horiz = edge === 'n' || edge === 's';
  const span = horiz ? TOWN_W : TOWN_H;
  for (let i = 0; i < span; i++) {
    const d = Math.max(1, Math.round(depth + wobbleAt(i, span)));
    for (let k = 0; k < d; k++) {
      if (horiz) tiles.push([i, edge === 'n' ? k : TOWN_H - 1 - k]);
      else tiles.push([edge === 'w' ? k : TOWN_W - 1 - k, i]);
    }
  }
  return tiles;
}

// paintWaterTiles draws every S.water tile: a plain fill/flow variant for
// interior water, or the single foam edge tile rotated toward whichever
// cardinal side actually touches land — one atlas slice covers all 4 shore
// orientations (the same trick wallPieceFor uses for fence corners).
export function paintWaterTiles(kind, r) {
  const isWater = (x, y) => S.water.has(`${x},${y}`);
  const pool = kind === 'river' ? S.atlas.water.flow : S.atlas.water.fill;
  for (const key of S.water) {
    const [tx, ty] = key.split(',').map(Number);
    let rot = null;
    if (!isWater(tx, ty + 1)) rot = 0;                  // land south — foam faces down, the tile's native orientation
    else if (!isWater(tx, ty - 1)) rot = Math.PI;       // land north
    else if (!isWater(tx - 1, ty)) rot = Math.PI / 2;   // land west
    else if (!isWater(tx + 1, ty)) rot = -Math.PI / 2;  // land east
    const s = new Sprite(rot != null ? S.atlas.water.edge : pool[(r() * pool.length) | 0]);
    if (rot != null) { s.anchor.set(0.5); s.x = tx * TILE + TILE / 2; s.y = ty * TILE + TILE / 2; s.rotation = rot; }
    else { s.x = tx * TILE; s.y = ty * TILE; }
    S.ground.addChild(s);
  }
}

// clearTreesUnderWater — the forest was painted before this (see boot order);
// drown any tree that landed on a tile water now claims (mirrors
// placeOreNodes' own clearing of its footprint) and shrink the regrowth cap.
export function clearTreesUnderWater() {
  let cleared = 0;
  for (let i = (S.allTrees || []).length - 1; i >= 0; i--) {
    const t = S.allTrees[i];
    if (!S.water.has(`${t.tx},${t.ty}`)) continue;
    for (const s of (t.sprites || [])) { S.entities.removeChild(s); s.destroy(); }
    S.allTrees.splice(i, 1);
    const wi = S.woodNodes.findIndex((w) => w.sprites === t.sprites); // drop its wood node too, if fellable
    if (wi >= 0) { S.woodNodes.splice(wi, 1); cleared++; }
  }
  if (S.woodCap) S.woodCap -= cleared;
}

// buildShoreSites banks every land tile touching water — with a second clear
// land tile above it too, room for a 2-tall wharf — as a wharf candidate,
// nearest-to-town first, so nextWharfSite always sites toward the bank a
// villager would actually walk to from the town.
export function buildShoreSites() {
  const sites = [], seen = new Set();
  for (const key of S.water) {
    const [tx, ty] = key.split(',').map(Number);
    for (const [dx, dy] of DIRS4) {
      const lx = tx + dx, ly = ty + dy;
      if (lx < 0 || ly < 0 || lx >= TOWN_W || ly >= TOWN_H) continue;
      const lk = `${lx},${ly}`;
      if (S.water.has(lk) || seen.has(lk) || S.water.has(`${lx},${ly - 1}`)) continue; // needs 2 tiles of land, stacked
      seen.add(lk);
      sites.push({ tx: lx, ty: ly, x: lx * TILE + TILE / 2, y: ly * TILE + TILE, d: Math.hypot(lx - CENTER_TX, ly - CENTER_TY), claimed: false });
    }
  }
  sites.sort((a, b) => a.d - b.d);
  S.shoreSites = sites;
}

// nextWharfSite claims the next free shoreline tile (nearest town first) for
// a new Fishing Wharf, reserving its plot cell so the town's own growth never
// paves over it (mirrors nextMineNode's claim of an ore vein).
export function nextWharfSite() {
  const site = S.shoreSites.find((s) => !s.claimed);
  if (!site) return null;
  site.claimed = true;
  S.waterPlots.add(`${Math.floor(site.tx / PLOT)},${Math.floor(site.ty / PLOT)}`);
  return site;
}

// wharfSiteAvailable — true if a `build wharf` order is satisfiable: an
// unclaimed shore tile for a NEW wharf, else an existing wharf that can be
// deepened (mirrors mineNodeAvailable).
export function wharfSiteAvailable() {
  if (S.shoreSites.some((s) => !s.claimed)) return true;
  return S.game.canDeepen('wharf');
}

// constructionPoof — a little burst of dust when a building is finished.
export function constructionPoof(px, py) {
  for (let i = 0; i < 7; i++) {
    const p = new Graphics().circle(0, 0, 1.5 + Math.random() * 2).fill(0xefe6d2);
    p.x = px + (Math.random() - 0.5) * 14; p.y = py - Math.random() * 3;
    p.zIndex = 1e7; S.entities.addChild(p);
    const vx = (Math.random() - 0.5) * 16, vy = -10 - Math.random() * 12, t0 = performance.now();
    const tick = () => {
      const k = (performance.now() - t0) / 620;
      if (k >= 1) { S.entities.removeChild(p); p.destroy(); return; }
      p.x += vx * 0.016; p.y += vy * 0.016; p.alpha = 1 - k; p.scale.set(1 + k);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

export function riseIn(c) {
  const t0 = performance.now();
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / 400);
    c.alpha = k; c.pivot.set(0, -4 * (1 - k));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// fadeIn — a flat overlay (a field) appearing, with no vertical "rise".
export function fadeIn(c) {
  const t0 = performance.now();
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / 500);
    c.alpha = k;
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// nearestNode — the nearest UNCLAIMED resource node of a kind (ore/wood) to a
// point. Ore/wood nodes are terrain data (placeOreNodes / paintGround), so the
// query lives here; villager targeting and building siting both call it.
export function nearestNode(px, py, type) {
  const list = type === 'ore'
    ? S.oreNodes.filter((n) => !n.claimedByMine)
    : S.woodNodes.filter((n) => !n.claimedBy);
  let best = null, bd = Infinity;
  for (const n of list) { const d = (n.x - px) ** 2 + (n.y - py) ** 2; if (d < bd) { bd = d; best = n; } }
  return best;
}
