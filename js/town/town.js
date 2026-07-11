// town.js — the living town. PixiJS renders a ¾ top-down cozy pixel hold
// that grows from the deterministic economy (window.XANGAME) whose seed is
// one settlement from the world-sim (window.XAN). It runs itself: a local
// heuristic keeps building, and when faith crests (or on `p`) the Divine Will
// at /will returns terse directives its speakers turn into orders + an
// in-world chronicle. Nothing here writes back to the sim.
import { Application, Container, Sprite, AnimatedSprite, Texture, Graphics } from 'pixi.js';
import { loadAtlas, TILE } from './atlas.js';
import { makePanel } from './ui.js';

const { allHolds } = window.XAN;
const { Game, BUILDINGS, BY_ID, CFG } = window.XANGAME;

// ---- config ---------------------------------------------------------
const PLOT = 4;                 // a building plot is 4x4 tiles (roomy — no crowding)
const TOWN_W = 96, TOWN_H = 72; // a big wilderness map the camera drifts across
const PLOTS_X = Math.floor(TOWN_W / PLOT), PLOTS_Y = Math.floor(TOWN_H / PLOT);
const DAY_MS = 240000;          // a full day/night in real ms
const STEWARD_MS = Number(localStorage.getItem('xh_stewardMs') || 1800000); // ambient decree cadence — faith is the primary trigger now; this is just a slow backstop (30 min)
const LOCAL_MS = 6000;          // heuristic steward cadence
const MAX_PER_TYPE = 8;         // how many of one building we draw
const ROLE_TINT = {
  villager: 0xffffff, farmer: 0xcfe8a0, woodcutter: 0xbfe0b8,
  miner: 0xcfcfe0, soldier: 0x9fb8ea, trader: 0xffdf9a, speaker: 0xf3e4c0,
};
// A saturated pip above the head — the readable role signal (a multiply
// tint on a brown sprite can't say "blue soldier" clearly; a pip can).
const ROLE_PIP = {
  villager: 0xe6dcc4, farmer: 0x74c53a, woodcutter: 0x2f8f4e,
  miner: 0xc9ced6, soldier: 0x4f86e0, trader: 0xf2c14e, speaker: 0xffdf6a,
};
// Speaker's label is set to the hold's aspect at boot (Saltspeaker, Deepspeaker…).
const ROLE_LABEL = { villager: 'Villager', farmer: 'Farmer', woodcutter: 'Woodcutter', miner: 'Miner', soldier: 'Soldier', trader: 'Trader', speaker: 'Speaker' };
// Seconds of work a single unit of each order takes — so decrees are
// carried out over time (a build you can watch), not the instant they land.
const WORK_S = { build: 5, trade: 2.5, focus: 1, expand: 5, wall: 5 };

// ---- state ----------------------------------------------------------
const S = {
  hold: null, game: null, atlas: null,
  placed: new Map(),   // typeKey -> {container}
  villagers: [], plots: [], usedPlots: new Set(),
  oreFieldPlots: new Set(), // plot cells the ore field occupies — the plot allocators only (nextCorePlot/nextOuterPlot/nextFarmPlot), not the wall/wander, which read usedPlots
  waterPlots: new Set(), // plot cells water (or a claimed wharf shore tile) occupies — the plot allocators only, mirrors oreFieldPlots
  oreFieldCenter: null, // {x,y} px — set by placeOreNodes; read by outerBias (quarry) + farmlandAnchor
  farmAnchor: null, // {px,py} plot coords — the farmland district's centre, set once by farmlandAnchor
  orderLog: [], focus: null, chronicle: [],
  stewardBusy: false, lastRaidTally: 0, alarm: 0,
  hudOn: true, ui: { pinned: new Set() }, // ui.pinned: category keys clicked open (see chip() in updateHUD)
  cam: { x: TOWN_W / 2, y: TOWN_H / 2 }, camAuto: true, lastInput: 0,
  hittable: [], // building bounds for hover-identify
  // Real, planned walls: a set of wall tiles (impassable) and gate tiles
  // (passable openings), keyed "x,y" — grown by wall ORDERS (see the 'wall'
  // case in advanceOrder), never an auto-fitted bounding-box ring. See the
  // "---- walls ----" section below.
  walls: new Set(), gates: new Set(),
  wallSprites: [], wallsVersion: 0, wallsRendered: -1,
  wallEdgesBuilt: new Set(), // which sides of the settlement localSteward has already planned (see planDefensiveSegment)
  oreNodes: [], woodNodes: [], // resource nodes the folk walk out to work
  // Impassable water (see findPath, which blocks S.water exactly like
  // S.walls) and its shoreline: land tiles touching water, nearest-town
  // first, that nextWharfSite claims for new Fishing Wharfs. See placeWater.
  water: new Set(), shoreSites: [],
  mask: { aspect: 'the Will', speakers: 'Speakers' }, // the god's local face, set from tier at boot
  lastWill: null, // last invocation: {utterance, aspect, speakers:[{name,parish,directive,word,orders}]} — powers the left Speakers panel
  // Hover-highlight state (seed of the jobs system's assignment viz — see
  // resolveHome/startHaul for v.home/v.haulTarget): the hittable currently
  // hovered, its outline, and the ring per assigned villager it's showing.
  hoverBuilding: null, hoverGfx: null, highlightRings: new Map(), highlightAt: 0,
};
const heldKeys = new Set(); // WASD currently pressed
const BUILD_NAME = {
  farm: 'Farm', wharf: 'Fishing Wharf', sawmill: 'Sawmill', quarry: 'Quarry',
  mine: 'Mine', saltern: 'Saltern', market: 'Market', longhouse: 'Longhouse', granary: 'Storehouse',
  reliquary: 'Reliquary',
};

// holdMask — the god wears the face of the land: the hold's lord-archetype
// (tier), falling back to its dominant resource, sets the aspect + speakers.
function holdMask(h) {
  const byTier = {
    saltern: { aspect: 'the Salt', speakers: 'Saltspeakers' },
    seat: { aspect: 'the Current', speakers: 'Currentspeakers' },
    headwater: { aspect: 'the Wellspring', speakers: 'Springspeakers' },
    march: { aspect: 'the Deep', speakers: 'Deepspeakers' },
  };
  if (byTier[h.tierName]) return byTier[h.tierName];
  const top = Object.entries(h.rich).sort((a, b) => b[1] - a[1])[0][0];
  const byRes = {
    timber: { aspect: 'the Green', speakers: 'Greenspeakers' },
    ore: { aspect: 'the Vein', speakers: 'Veinspeakers' },
    stone: { aspect: 'the Deep', speakers: 'Deepspeakers' },
    food: { aspect: 'the Current', speakers: 'Currentspeakers' },
    salt: { aspect: 'the Salt', speakers: 'Saltspeakers' },
    coin: { aspect: 'the Road', speakers: 'Roadspeakers' },
  };
  return byRes[top] || { aspect: 'the Will', speakers: 'Speakers' };
}

let app, world, ground, entities, night, alarmFx;

// deterministic RNG so a hold always lays out the same.
function rng(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

// ---- boot -----------------------------------------------------------
const mark = (m) => { console.log('boot:', m); };  // boot progress (the Will panel isn't up yet)
// resetWorld wipes every hold's saved progress (localStorage), so the
// world starts fresh. Triggered by ?reset in the URL or the R key.
function resetWorld() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('xanhold:')) localStorage.removeItem(k);
  } catch { /* private/sandboxed storage — nothing to clear */ }
}

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has('reset')) {
    resetWorld();
    params.delete('reset'); // strip it so a refresh doesn't wipe new progress
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : ''));
  }
  mark('pick hold');
  S.hold = pickHold();
  S.mask = holdMask(S.hold);                         // the god's local face
  ROLE_LABEL.speaker = S.mask.speakers.replace(/s$/, ''); // e.g. "Deepspeaker" in the Folk legend
  loadWalls();                                        // restore this hold's grown wall/gate tiles (see saveWalls)
  S.game = Game.load(S.hold);
  const away = S.game.catchUp();

  mark('init pixi');
  app = new Application();
  await app.init({
    resizeTo: window, antialias: false, roundPixels: true,
    preference: 'webgl', backgroundColor: bgForHold(S.hold),
  });
  document.getElementById('stage').appendChild(app.canvas);
  app.ticker.maxFPS = 30;

  mark('load atlas');
  S.atlas = await loadAtlas();
  mark('build town');

  world = new Container();
  ground = new Container();
  entities = new Container(); entities.sortableChildren = true;
  world.addChild(ground, entities);
  app.stage.addChild(world);

  buildPlots();
  paintGround();
  placeOreNodes();
  placeWater();
  placeTownhall();
  reconcileBuildings();  // existing buildings appear without a poof
  S.booted = true;       // from here on, finished construction gets an effect
  night = makeOverlay(0x0a1230);
  alarmFx = makeOverlay(0xff2a1a); alarmFx.alpha = 0;
  app.stage.addChild(night, alarmFx);

  layoutWorld();
  window.addEventListener('resize', layoutWorld);
  initHUD(away);
  wireKeys();
  initZoom();
  initPan();

  app.ticker.add(onFrame);
  setInterval(townTick, 1000);
  setInterval(localSteward, LOCAL_MS);
  setInterval(() => callWill('the turning of the season'), STEWARD_MS);
  // No decree on boot — the town runs on its local heuristic and only spends
  // a Claude call every STEWARD_MS or when you press P, so reloads are free.
}

// Pick the hold: an explicit ?hold= from the map wins, else the last one
// played, else the realm capital, else the first.
function pickHold() {
  const holds = allHolds();
  const want = new URLSearchParams(location.search).get('hold');
  if (want) { const h = holds.find((x) => x.id === want); if (h) return h; }
  const saved = holds.find((h) => Game.hasSave(h.id));
  if (saved) return saved;
  return holds.find((h) => h.tier === 27) || holds[0];
}

function bgForHold(h) {
  if (/tundra|glacier/.test(h.region)) return 0x2a3238;
  if (/coast|lake/.test(h.region)) return 0x1c3040;
  return 0x141a12;
}

// ---- ground + plots -------------------------------------------------
function buildPlots() {
  const cx = (PLOTS_X - 1) / 2, cy = (PLOTS_Y - 1) / 2;
  const list = [];
  for (let py = 0; py < PLOTS_Y; py++)
    for (let px = 0; px < PLOTS_X; px++)
      list.push({ px, py, tx: px * PLOT, ty: py * PLOT, d: Math.hypot(px - cx, py - cy) });
  list.sort((a, b) => a.d - b.d);
  S.plots = list;
}

function paintGround() {
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
      ground.addChild(t);
    }
  }
  // --- clumped groves: trees gather into dense stands with clearings between,
  // rather than an even static. Grove count/size follow the hold's timber
  // richness (from the world-sim). Never build over the town's plots.
  const near = new Set(S.plots.slice(0, 22).map((p) => `${p.px},${p.py}`));
  const clusterRows = (S.hold.temp < 9) ? S.atlas.clusters.autumn : S.atlas.clusters.green;
  const timber = S.hold.rich.timber; // 0..1
  const onBuild = (tx, ty) => tx < 0 || ty < 0 || tx >= TOWN_W || ty >= TOWN_H || near.has(`${Math.floor(tx / PLOT)},${Math.floor(ty / PLOT)}`);
  const nearTown = (tx, ty) => Math.abs(tx - TOWN_W / 2) < 26 && Math.abs(ty - TOWN_H / 2) < 22;
  // EVERY tree is tracked by its base tile (S.allTrees) so a feature painted
  // later — the river, the ore field — can drown any that stand on it, even the
  // far DECORATIVE trees that never become fellable wood nodes. Near-town trees
  // are additionally registered as wood nodes so a woodcutter can fell them.
  S.allTrees = [];
  const regWood = (tx, ty, sprites) => {
    S.allTrees.push({ tx, ty, sprites });
    if (nearTown(tx, ty)) S.woodNodes.push({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE, sprites });
  };
  const tree = (tx, ty, rec) => placeTree(tx * TILE + TILE / 2, ty * TILE + TILE, rec);
  const tall = () => treePool[(r() * 3) | 0];          // weighted 2-tile stacks
  const small = () => treePool[3 + ((r() * 2) | 0)];   // single tree or bush
  const clusterFits = (gx, gy) => {
    for (let cc = -1; cc <= 1; cc++) for (let rr = -2; rr <= 0; rr++) if (onBuild(gx + cc, gy + rr)) return true;
    return false;
  };

  const nGroves = Math.round(7 + timber * 20);
  for (let i = 0; i < nGroves; i++) {
    const gx = 2 + Math.floor(r() * (TOWN_W - 4));
    const gy = 2 + Math.floor(r() * (TOWN_H - 4));
    const rad = 3 + r() * (3 + timber * 3);
    if (r() < 0.6 && !clusterFits(gx, gy)) { const cs = placeCluster(gx, gy, clusterRows); regWood(gx, gy, cs); }
    const ir = Math.ceil(rad);
    for (let dy = -ir; dy <= ir; dy++) for (let dx = -ir; dx <= ir; dx++) {
      const tx = gx + dx, ty = gy + dy;
      if (onBuild(tx, ty)) continue;
      const dist = Math.hypot(dx, dy);
      if (dist > rad) continue;
      if (r() < (1 - dist / rad) ** 2 * 0.8) { const ts = tree(tx, ty, dist < rad * 0.55 ? tall() : small()); regWood(tx, ty, ts); }
    }
  }
  // a few lone trees/bushes in the open country between groves
  for (let ty = 0; ty < TOWN_H; ty++) for (let tx = 0; tx < TOWN_W; tx++) {
    if (onBuild(tx, ty)) continue;
    if (r() < 0.008 + timber * 0.012) { const ts = tree(tx, ty, r() < 0.5 ? small() : tall()); regWood(tx, ty, ts); }
  }
  // Remember the forest's near-town size + palette so felled trees can regrow.
  S.woodCap = S.woodNodes.length;
  S.treePool = treePool;
  scheduleRegrow();
}

// placeCluster lays a full 3x3 forest mass (base-anchored, y-sorted as one)
// centered on column gx with its bottom row at gy.
function placeCluster(gx, gy, rows) {
  const baseZ = (gy + 1) * TILE;
  const sprites = [];
  for (let rr = 0; rr < 3; rr++) {                 // 0 tops, 1 mids, 2 bottoms
    const tileY = gy - 2 + rr;
    for (let cc = 0; cc < 3; cc++) {
      const s = new Sprite(S.atlas.tex(rows[rr][cc]));
      s.anchor.set(0.5, 1);
      s.x = (gx - 1 + cc) * TILE + TILE / 2;
      s.y = (tileY + 1) * TILE;
      s.zIndex = baseZ;
      entities.addChild(s); sprites.push(s);
    }
  }
  return sprites;
}

// placeTree stacks a tree's canopy over its trunk, both anchored at the
// base so the whole tree y-sorts as one against villagers and buildings.
// Returns the sprites so a wood node can fell (remove) them when chopped.
function placeTree(cx, baseY, rec) {
  const sprites = [];
  const b = new Sprite(S.atlas.tex(rec.b));
  b.anchor.set(0.5, 1); b.x = cx; b.y = baseY; b.zIndex = baseY;
  entities.addChild(b); sprites.push(b);
  if (rec.t != null) {
    const t = new Sprite(S.atlas.tex(rec.t));
    t.anchor.set(0.5, 1); t.x = cx; t.y = baseY - TILE; t.zIndex = baseY;
    entities.addChild(t); sprites.push(t);
  }
  return sprites;
}

// ---- buildings ------------------------------------------------------
function makeBuildingContainer(recipe, propIdx) {
  const c = new Container();
  if (recipe.image) {
    // A whole-image building (the church reliquary) — one sprite scaled so its
    // width spans recipe.w tiles, anchored at its base.
    const s = new Sprite(S.atlas.images[recipe.image]);
    s.anchor.set(0.5, 1);
    s.scale.set((recipe.w * TILE) / s.texture.width);
    s.x = recipe.w * TILE / 2; s.y = recipe.h * TILE;
    c.addChild(s); c.baseH = recipe.h;
    return c;
  }
  if (recipe.anim) {
    // An animated building — frames play in a loop at a gentle pace, scaled
    // to fit recipe.w tiles wide, anchored at its base like image buildings.
    const frames = S.atlas.anims[recipe.anim];
    const s = new AnimatedSprite(frames);
    s.anchor.set(0.5, 1);
    s.animationSpeed = 0.08;
    s.play();
    s.scale.set((recipe.w * TILE) / frames[0].width);
    s.x = recipe.w * TILE / 2; s.y = recipe.h * TILE;
    c.addChild(s); c.baseH = recipe.h;
    return c;
  }
  for (const t of recipe.tiles) {
    const s = new Sprite(S.atlas.tex(t.i));
    s.x = t.x * TILE; s.y = t.y * TILE; c.addChild(s);
  }
  if (propIdx != null) {
    // The trade tool sits beside the house at ground level (a log by the
    // sawmill, a water trough by the wharf) — the look you preferred.
    const p = new Sprite(S.atlas.tex(propIdx));
    p.x = recipe.w * TILE; p.y = (recipe.h - 1) * TILE;
    c.addChild(p);
  }
  c.baseH = recipe.h;
  return c;
}

function recipeFor(type) {
  const { RECIPES, PROP, HOUSE_OF } = S.atlas;
  if (type === 'farm') return { recipe: RECIPES.farm, prop: null };
  if (type === 'market') return { recipe: RECIPES.market, prop: null };
  if (type === 'reliquary') return { recipe: RECIPES.reliquary, prop: null };
  const house = HOUSE_OF[type] || 'cottageRed';
  return { recipe: RECIPES[house], prop: PROP[type] ?? null };
}

// ---- districts ----------------------------------------------------------
// CORE (dwellings/stores/faith/command) stays inside the walls; OUTER
// (resource works) sits outside. Mines/wharfs already self-site on their
// vein/shore (nextMineNode/nextWharfSite below) — this covers everything
// else: the CORE-plot allocator (nextCorePlot), the OUTER-ring allocator for
// terrain-biased non-self-siting works (nextOuterPlot; sawmill/quarry/
// saltern), and the farmland district that clusters fields instead of
// scattering them (nextFarmPlot/farmlandAnchor — the sprawl fix).
const CORE_TYPES = new Set(['longhouse', 'granary', 'reliquary', 'market', 'barracks']);
const OUTER_TYPES = new Set(['farm', 'wharf', 'mine', 'sawmill', 'quarry', 'saltern']);
const CORE_R0 = 2, CORE_GROW_EVERY = 3, CORE_R_MAX = 6; // plot-units (×PLOT tiles) — see coreRadius

// coreRadius — the core zone's radius in plot-units from town centre,
// growing as CORE_TYPES buildings actually go up (so the walls in
// planDefensiveSegment have room to enclose them as the town grows), but
// never past maxSafeCoreRadius — THIS hold's actual clearance to its ore
// field/shoreline (see placeOreNodes/placeWater), not a fixed guess. That
// keeps the wall from ever being drawn across the vein field or the shore,
// whatever CORE_R_MAX allows for a hold with more open ground.
function coreRadius() {
  let n = 0;
  for (const key of S.placed.keys()) if (CORE_TYPES.has(key.slice(0, key.indexOf('#')))) n++;
  return Math.min(CORE_R_MAX, CORE_R0 + Math.floor(n / CORE_GROW_EVERY), maxSafeCoreRadius());
}

// maxSafeCoreRadius — the farthest the core zone can grow before its own
// wall box would reach the ore field, the shoreline, OR a self-sited
// building already claimed just past it (a wharf's shore tile joins
// S.waterPlots the moment nextWharfSite claims it — see below — same for a
// mine's vein and S.oreFieldPlots at boot). Chebyshev distance (matches the
// wall's own square shape — see plotInCore). NOT cached: those sets grow as
// the town does, and a stale radius is exactly how the wall ends up drawn
// across a wharf that got sited after the radius was first read.
function maxSafeCoreRadius() {
  const ccx = (PLOTS_X - 1) / 2, ccy = (PLOTS_Y - 1) / 2;
  let min = Infinity;
  for (const key of [...S.oreFieldPlots, ...S.waterPlots]) {
    const [px, py] = key.split(',').map(Number);
    min = Math.min(min, Math.max(Math.abs(px - ccx), Math.abs(py - ccy)));
  }
  return min === Infinity ? CORE_R_MAX : Math.max(CORE_R0, min - 1);
}

// plotInCore — is plot (px,py) inside the core zone? Chebyshev (square)
// distance, NOT Euclidean: the wall is an axis-aligned box (straight N/S/E/W
// segments), and a circular test's corners would fall short of it by up to
// radius×(√2−1) tiles — exactly the gap that once let an "outside core"
// OUTER building (a wharf, near a box corner) land under the wall anyway.
// Matching the test to the wall's real shape closes that gap.
function plotInCore(px, py) {
  const ccx = (PLOTS_X - 1) / 2, ccy = (PLOTS_Y - 1) / 2;
  return Math.max(Math.abs(px - ccx), Math.abs(py - ccy)) <= coreRadius();
}

// insideCore/isInsideWalls — tile-space test for "protected inside the
// walls". MVP: plotInCore's square zone (coreRadius, in plot-units) rather
// than a true flood-fill enclosure — cheap, robust, and it's exactly what
// planDefensiveSegment's wall box actually encloses (modulo its own +2 tile
// clearance margin).
function insideCore(tx, ty) { return plotInCore(tx / PLOT, ty / PLOT); }
function isInsideWalls(tx, ty) { return insideCore(tx, ty); }

// nextCorePlot sites a CORE building (dwellings/stores/faith/command)
// inside the walled core zone, nearest the centre first (S.plots is already
// distance-sorted) — never on an ore/water-reserved cell.
function nextCorePlot() {
  for (const p of S.plots) {
    if (!plotInCore(p.px, p.py)) continue; // outside the core zone — not for CORE_TYPES
    const key = `${p.px},${p.py}`;
    if (S.usedPlots.has(key) || S.oreFieldPlots.has(key) || S.waterPlots.has(key)) continue;
    S.usedPlots.add(key); return p;
  }
  return null; // core zone is full — waits for coreRadius to grow (more CORE_TYPES built)
}

// nextOuterPlot sites an OUTER building that doesn't self-site on terrain
// (sawmill/quarry/saltern — mines/wharfs claim a vein/shore tile directly,
// see nextMineNode/nextWharfSite): a plot outside the core zone, biased
// toward (biasX,biasY) in pixels when given (the woodline for a sawmill,
// the ore field for a quarry — see outerBias), else the nearest free outer
// plot to town.
function nextOuterPlot(biasX, biasY) {
  const free = (p) => {
    const key = `${p.px},${p.py}`;
    return !plotInCore(p.px, p.py) && !S.usedPlots.has(key) && !S.oreFieldPlots.has(key) && !S.waterPlots.has(key);
  };
  if (biasX == null) {
    for (const p of S.plots) if (free(p)) { S.usedPlots.add(`${p.px},${p.py}`); return p; }
    return null;
  }
  let best = null, bd = Infinity;
  for (const p of S.plots) {
    if (!free(p)) continue;
    // p.tx/p.ty are tile-index (see buildPlots); biasX/biasY are pixels
    // (see outerBias) — convert to the same units before comparing.
    const dd = (p.tx * TILE - biasX) ** 2 + (p.ty * TILE - biasY) ** 2;
    if (dd < bd) { bd = dd; best = p; }
  }
  if (best) S.usedPlots.add(`${best.px},${best.py}`);
  return best;
}

// outerBias — the terrain a given OUTER building type wants to sit near,
// for nextOuterPlot. null = no preference (nearest free outer plot).
function outerBias(type) {
  if (type === 'sawmill') {
    const n = nearestNode(TOWN_W / 2 * TILE, TOWN_H / 2 * TILE, 'wood');
    return n ? { x: n.x, y: n.y } : null;
  }
  if (type === 'quarry' && S.oreFieldCenter) return S.oreFieldCenter;
  return null; // saltern etc — no terrain bias modeled yet
}

// ---- farmland district (the sprawl fix) ----------------------------------
// farmlandAnchor picks the farmland district's centre once (deterministic
// per hold), just past the core zone and — best-effort, scored over a
// handful of candidate directions — clear of the ore field/water. New
// fields cluster near it via nextFarmPlot; once fields exist, THEY become
// the pull (adjacency wins), so the district reads as one grown zone
// instead of plots scattered wherever the old flat allocator found room.
function farmlandAnchor() {
  if (S.farmAnchor) return S.farmAnchor;
  const r = rng((S.hold.x * 104729) ^ (S.hold.y * 65537) ^ 0xfa4b1a);
  const ccx = (PLOTS_X - 1) / 2, ccy = (PLOTS_Y - 1) / 2;
  const baseR = coreRadius() + 3;
  let best = null, bestScore = -1;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + r() * 0.3;
    const dist = baseR + 2 + r() * 2;
    const px = Math.round(ccx + Math.cos(a) * dist), py = Math.round(ccy + Math.sin(a) * dist * 0.8);
    if (px < 1 || py < 1 || px >= PLOTS_X - 1 || py >= PLOTS_Y - 1) continue;
    // Score: how much open (non-reserved) ground surrounds this candidate —
    // fewer ore/water plots nearby wins, so the district doesn't land on top
    // of the vein field or the shoreline.
    let free = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const key = `${px + dx},${py + dy}`;
      if (!S.oreFieldPlots.has(key) && !S.waterPlots.has(key)) free++;
    }
    if (free > bestScore) { bestScore = free; best = { px, py }; }
  }
  S.farmAnchor = best || { px: Math.round(ccx), py: Math.round(ccy + baseR) };
  return S.farmAnchor;
}

// nextFarmPlot sites a new farm field IN the farmland district: adjacent to
// an already-placed field where possible (the district grows as one
// contiguous cluster, not scattered plots), else nearest free plot to the
// district's anchor. This, plus wantsNewFarmField's fill-before-sprawl rule
// in localSteward, is the fix for the old single-plot farm sprawl.
function nextFarmPlot() {
  const anchor = farmlandAnchor();
  const free = (p) => {
    const key = `${p.px},${p.py}`;
    return !plotInCore(p.px, p.py) && !S.usedPlots.has(key) && !S.oreFieldPlots.has(key) && !S.waterPlots.has(key);
  };
  const existing = [...S.placed.entries()].filter(([k]) => k.startsWith('farm#')).map(([, v]) => v.plot);
  if (existing.length) {
    let best = null, bd = Infinity;
    for (const p of S.plots) {
      if (!free(p)) continue;
      for (const ex of existing) {
        const dd = Math.hypot(p.px - ex.px, p.py - ex.py);
        if (dd <= 1.5 && dd < bd) { bd = dd; best = p; } // adjacent (incl. diagonal) to a placed field
      }
    }
    if (best) { S.usedPlots.add(`${best.px},${best.py}`); return best; }
  }
  let best = null, bd = Infinity;
  for (const p of S.plots) {
    if (!free(p)) continue;
    const dd = (p.px - anchor.px) ** 2 + (p.py - anchor.py) ** 2;
    if (dd < bd) { bd = dd; best = p; }
  }
  if (best) S.usedPlots.add(`${best.px},${best.py}`);
  return best;
}

// wantsNewFarmField — true only once every existing field is already maxed
// (or none exist yet): the district FILLS before it SPRAWLS. Read by
// localSteward instead of the old scarce-food coin-flip.
function wantsNewFarmField() {
  const fields = S.game.farmPlots || [];
  return !fields.length || fields.every((p) => p.size >= 3);
}

// nextMineNode claims the next available ore vein for a new Deep Mine,
// clearing its vein sprite (the mine now stands there, in the wilds, not the
// town grid) and nudging off any miner already headed to or working that
// exact vein. Returns null once every vein in the field already has a mine.
function nextMineNode() {
  const node = S.oreNodes.find((n) => !n.claimedByMine);
  if (!node) return null;
  node.claimedByMine = true;
  if (node.sprite) { entities.removeChild(node.sprite); node.sprite.destroy(); node.sprite = null; }
  for (const v of S.villagers) {
    if (v.targetNode === node) { v.targetNode = null; pickTarget(v); }
    else if (v.workNode === node) { v.working = false; v.workNode = null; v.idle = 0; }
  }
  return node;
}

// mineNodeAvailable — true if a `build mine` order could actually be placed
// right now: either the ore field still has an unclaimed vein, or the town
// is already past the drawn-instance cap (MAX_PER_TYPE), in which case a
// further level just deepens existing mines rather than raising a new one.
function mineNodeAvailable() {
  if (S.game.level('mine') >= MAX_PER_TYPE) return true;
  return S.oreNodes.some((n) => !n.claimedByMine);
}

function placeTownhall() {
  const center = S.plots[0];
  S.keepKey = `${center.px},${center.py}`;
  S.usedPlots.add(S.keepKey);
  const recipe = S.atlas.RECIPES.townhall;
  const c = makeBuildingContainer(recipe, null);
  c.x = center.tx * TILE + Math.floor((PLOT - recipe.w) / 2) * TILE;
  c.y = (center.ty + PLOT - recipe.h) * TILE;
  c.zIndex = c.y + recipe.h * TILE;
  entities.addChild(c);
  S.hittable.push({ x0: c.x / TILE, y0: c.y / TILE, x1: c.x / TILE + recipe.w, y1: c.y / TILE + recipe.h, label: S.hold.name + ' — the keep' });
}

// Desired count of each building type from the economy's levels.
function desiredCounts() {
  const d = {};
  for (const b of BUILDINGS) {
    if (b.id === 'palisade' || b.id === 'farm') continue; // palisade = wall; farm = drawn from farmPlots
    const lv = S.game.level(b.id);
    if (lv <= 0) continue;
    // A mine hut is pinned 1:1 to a real ore node (see nextMineNode) — its
    // count can't be a coarser proxy for level like the other producers.
    d[b.id] = b.id === 'mine'
      ? Math.min(MAX_PER_TYPE, lv)
      : Math.min(MAX_PER_TYPE, Math.max(1, Math.round(lv / (b.kind === 'prod' ? 1.5 : 1))));
  }
  return d;
}

// Reconcile placed structures toward the desired counts (grow the town).
function reconcileBuildings() {
  const want = desiredCounts();
  for (const [type, n] of Object.entries(want)) {
    for (let k = 0; k < n; k++) {
      const key = `${type}#${k}`;
      if (S.placed.has(key)) continue;
      const { recipe, prop } = recipeFor(type);
      let plot, cx, cy;
      if (type === 'mine') {
        // A mine isn't a town plot — it's raised directly on an ore vein out
        // in the field, claiming that node's spot (see placeOreNodes).
        const node = nextMineNode();
        if (!node) break; // the ore field is fully claimed — this mine waits
        plot = { tx: Math.round(node.x / TILE - recipe.w / 2), ty: Math.round(node.y / TILE - recipe.h), node };
        cx = plot.tx * TILE; cy = plot.ty * TILE;
      } else if (type === 'wharf') {
        // Same idea, on the waterfront: claim the next free shore tile
        // placeWater() found, instead of a town plot (see nextWharfSite).
        const site = nextWharfSite();
        if (!site) break; // no shoreline left (or none at all) — this wharf waits
        plot = { tx: Math.round(site.x / TILE - recipe.w / 2), ty: Math.round(site.y / TILE - recipe.h), site };
        cx = plot.tx * TILE; cy = plot.ty * TILE;
      } else if (OUTER_TYPES.has(type)) {
        // sawmill/quarry/saltern: an outer-ring plot, biased toward their
        // terrain when one's modeled (see outerBias).
        const bias = outerBias(type);
        plot = nextOuterPlot(bias && bias.x, bias && bias.y);
        if (!plot) return;
        cx = plot.tx * TILE + Math.floor((PLOT - recipe.w) / 2) * TILE;
        cy = (plot.ty + PLOT - recipe.h) * TILE;
      } else {
        // CORE_TYPES: dwellings/stores/faith/command — a plot inside the
        // walled core zone (see nextCorePlot/coreRadius).
        plot = nextCorePlot();
        if (!plot) return;
        cx = plot.tx * TILE + Math.floor((PLOT - recipe.w) / 2) * TILE;
        cy = (plot.ty + PLOT - recipe.h) * TILE;
      }
      const c = makeBuildingContainer(recipe, prop);
      c.x = cx; c.y = cy;
      if (type === 'farm') {
        // A field is flat ground — put it on the ground layer so the folk
        // walk over it, not behind it. Fade in instead of "rising".
        c.alpha = 0; ground.addChild(c); fadeIn(c);
      } else {
        c.zIndex = c.y + recipe.h * TILE;
        c.alpha = 0; c.pivot.set(0, -4); // a little "rise" as it's built
        entities.addChild(c);
        riseIn(c);
      }
      S.placed.set(key, { container: c, plot });
      S.hittable.push({ x0: c.x / TILE, y0: c.y / TILE, x1: c.x / TILE + recipe.w, y1: c.y / TILE + recipe.h, type });
      if (S.booted) constructionPoof(c.x + recipe.w * TILE / 2, c.y + recipe.h * TILE);
    }
  }
  reconcileFarms();
  renderWalls();
}

// Farms are individual fields (game.farmPlots), each with a size and crop.
// They render from farmPlots — a new farm adds a field, expansion regrows one
// bigger with fuller crops — separate from the level-driven building counts.
function reconcileFarms() {
  const plots = S.game.farmPlots || [];
  for (let i = 0; i < plots.length; i++) {
    const fp = plots[i], key = `farm#${i}`;
    const ex = S.placed.get(key);
    if (ex && ex.size === fp.size) continue;   // already drawn at this size
    const plot = ex ? ex.plot : nextFarmPlot(); // new fields cluster into the farmland district — see nextFarmPlot
    if (!plot) return;
    if (ex) { ground.removeChild(ex.container); ex.container.destroy({ children: true }); S.hittable = S.hittable.filter((h) => h.key !== key); }
    const c = makeFarmField(fp);
    c.x = plot.tx * TILE; c.y = plot.ty * TILE;
    ground.addChild(c);
    if (!ex) { c.alpha = 0; fadeIn(c); }
    else if (S.booted) constructionPoof(c.x + c._n * TILE / 2, c.y + c._n * TILE); // a poof as it grows
    S.placed.set(key, { container: c, plot, size: fp.size });
    S.hittable.push({ key, x0: c.x / TILE, y0: c.y / TILE, x1: c.x / TILE + c._n, y1: c.y / TILE + c._n, type: 'farm' });
  }
}

// makeFarmField — a grass-edged tilled field (Kenney 9-slice border) whose
// interior fills with the plot's crop; footprint grows with size.
function makeFarmField(fp) {
  const n = 2 + fp.size; // size1→3x3, size2→4x4, size3→5x5
  const c = new Container();
  const cropTex = S.atlas.crops[fp.crop] || S.atlas.crops.greens;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const ex = x === 0 ? -1 : x === n - 1 ? 1 : 0;
    const ey = y === 0 ? -1 : y === n - 1 ? 1 : 0;
    const tex = (ex === 0 && ey === 0) ? cropTex : S.atlas.farmDirt[`${ey},${ex}`];
    const s = new Sprite(tex); s.x = x * TILE; s.y = y * TILE; c.addChild(s);
  }
  c._n = n;
  return c;
}

// placeOreNodes drops an ore field into the wilderness — a rocky patch with
// scattered veins that miners walk out to work. Seeded, so it's stable.
function placeOreNodes() {
  const r = rng((S.hold.x * 2654435761) ^ (S.hold.y * 40503) ^ 0x5eed);
  const a = r() * Math.PI * 2;
  const fx = Math.round(TOWN_W / 2 + Math.cos(a) * 12);   // just outside the town, in view
  const fy = Math.round(TOWN_H / 2 + Math.sin(a) * 11);
  S.oreFieldCenter = { x: fx * TILE, y: fy * TILE }; // outerBias's quarry pull, and farmlandAnchor's clearance scoring
  // Anchored in the world-sim: WHICH ores the ground yields and HOW big the
  // field is follow the hold's real ore/stone richness (from its neighborhood
  // scan). Every hold has a stone outcrop; richer rock adds coal→copper→iron→gold
  // — and each kind's WEIGHT (not just its presence) rises with oreR, so a rich
  // vein doesn't just unlock metal, it makes metal common. Low-ore holds stay
  // stone-dominated; stone's own weight tapers as oreR climbs.
  const oreR = S.hold.rich.ore, stoneR = S.hold.rich.stone;
  const [stoneTex, coalTex, copperTex, ironTex, goldTex] = S.atlas.oreTex;
  const pool = [['stone', stoneTex, 9 - oreR * 4]];
  if (oreR >= 0.15) pool.push(['coal', coalTex, 2 + oreR * 6], ['copper', copperTex, 1.5 + oreR * 5]);
  if (oreR >= 0.35) pool.push(['iron', ironTex, 1 + oreR * 5]);
  if (oreR >= 0.60) pool.push(['gold', goldTex, 0.5 + oreR * 4]);
  const totalW = pool.reduce((sum, p) => sum + p[2], 0);
  const pickKind = () => { let x = r() * totalW; for (const p of pool) { if ((x -= p[2]) <= 0) return p; } return pool[0]; };
  const count = 5 + Math.round((oreR + stoneR) * 8); // richer rock → a bigger field
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
    for (const s of (wn.sprites || [])) { entities.removeChild(s); s.destroy(); }
    S.woodNodes.splice(i, 1); cleared++;
  }
  if (S.woodCap) S.woodCap -= cleared;
  // a bare-earth patch under the field for a quarry look
  for (let dy = -3; dy <= 3; dy++) for (let dx = -4; dx <= 4; dx++) {
    if (r() < 0.55) { const t = new Sprite(S.atlas.ground.dirt[0]); t.x = (fx + dx) * TILE; t.y = (fy + dy) * TILE; ground.addChild(t); }
  }
  const addNode = (kind, tex, gx, gy) => {
    const s = new Sprite(tex); s.anchor.set(0.5, 1);
    s.x = gx * TILE + TILE / 2; s.y = gy * TILE + TILE; s.zIndex = s.y;
    entities.addChild(s);
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
    const [kind, tex] = pickKind();
    addNode(kind, tex, gx, gy);
  }
}

// ---- water --------------------------------------------------------------
// placeWater lays impassable water from the hold's own worldgen node
// (S.hold.n: riverMax/lake/sea — see world.js scanNeighborhood). Exactly one
// feature is drawn, whichever of river/lake/coast the numbers favor, scored
// with the same weights waterRich() (game.js) uses to gate the Fishing
// Wharf — so the shape on screen always agrees with whether a wharf is even
// offered. Every covered tile lands in S.water, which findPath blocks
// exactly like S.walls, and the shoreline (land touching water) is banked in
// S.shoreSites for nextWharfSite to claim.
function placeWater() {
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
function riverTiles(r, river) {
  const width = Math.max(2, Math.min(8, Math.round(2 + river * 0.5)));
  const side = r() < 0.5 ? -1 : 1;
  const baseX = TOWN_W / 2 + side * (20 + r() * 10);
  const amp = 3 + r() * 3, freq = 0.05 + r() * 0.04, phase = r() * Math.PI * 2;
  const tiles = [];
  for (let ty = 0; ty < TOWN_H; ty++) {
    const cx = Math.round(baseX + Math.sin(ty * freq + phase) * amp);
    for (let dx = 0; dx < width; dx++) tiles.push([cx - Math.floor(width / 2) + dx, ty]);
  }
  return tiles;
}

// lakeTiles — a wobbly rounded blob off to one side; radius rises with lake.
function lakeTiles(r, lake) {
  const rad = Math.max(3, Math.min(13, 3 + lake * 7));
  const angle = r() * Math.PI * 2, dist = 22 + r() * 10;
  const cx = Math.round(TOWN_W / 2 + Math.cos(angle) * dist);
  const cy = Math.round(TOWN_H / 2 + Math.sin(angle) * dist * 0.75); // the map's flatter than it's wide
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
function coastTiles(r, sea) {
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
function paintWaterTiles(kind, r) {
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
    ground.addChild(s);
  }
}

// clearTreesUnderWater — the forest was painted before this (see boot order);
// drown any tree that landed on a tile water now claims (mirrors
// placeOreNodes' own clearing of its footprint) and shrink the regrowth cap.
function clearTreesUnderWater() {
  let cleared = 0;
  for (let i = (S.allTrees || []).length - 1; i >= 0; i--) {
    const t = S.allTrees[i];
    if (!S.water.has(`${t.tx},${t.ty}`)) continue;
    for (const s of (t.sprites || [])) { entities.removeChild(s); s.destroy(); }
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
function buildShoreSites() {
  const sites = [], seen = new Set();
  for (const key of S.water) {
    const [tx, ty] = key.split(',').map(Number);
    for (const [dx, dy] of DIRS4) {
      const lx = tx + dx, ly = ty + dy;
      if (lx < 0 || ly < 0 || lx >= TOWN_W || ly >= TOWN_H) continue;
      const lk = `${lx},${ly}`;
      if (S.water.has(lk) || seen.has(lk) || S.water.has(`${lx},${ly - 1}`)) continue; // needs 2 tiles of land, stacked
      seen.add(lk);
      sites.push({ tx: lx, ty: ly, x: lx * TILE + TILE / 2, y: ly * TILE + TILE, d: Math.hypot(lx - TOWN_W / 2, ly - TOWN_H / 2), claimed: false });
    }
  }
  sites.sort((a, b) => a.d - b.d);
  S.shoreSites = sites;
}

// nextWharfSite claims the next free shoreline tile (nearest town first) for
// a new Fishing Wharf, reserving its plot cell so the town's own growth never
// paves over it (mirrors nextMineNode's claim of an ore vein).
function nextWharfSite() {
  const site = S.shoreSites.find((s) => !s.claimed);
  if (!site) return null;
  site.claimed = true;
  S.waterPlots.add(`${Math.floor(site.tx / PLOT)},${Math.floor(site.ty / PLOT)}`);
  return site;
}

// wharfSiteAvailable — true if a `build wharf` order could actually be sited
// right now: either the shoreline still has an unclaimed tile, or the town
// is already past the drawn-instance cap (mirrors mineNodeAvailable).
function wharfSiteAvailable() {
  if (S.game.level('wharf') >= MAX_PER_TYPE) return true;
  return S.shoreSites.some((s) => !s.claimed);
}

// constructionPoof — a little burst of dust when a building is finished.
function constructionPoof(px, py) {
  for (let i = 0; i < 7; i++) {
    const p = new Graphics().circle(0, 0, 1.5 + Math.random() * 2).fill(0xefe6d2);
    p.x = px + (Math.random() - 0.5) * 14; p.y = py - Math.random() * 3;
    p.zIndex = 1e7; entities.addChild(p);
    const vx = (Math.random() - 0.5) * 16, vy = -10 - Math.random() * 12, t0 = performance.now();
    const tick = () => {
      const k = (performance.now() - t0) / 620;
      if (k >= 1) { entities.removeChild(p); p.destroy(); return; }
      p.x += vx * 0.016; p.y += vy * 0.016; p.alpha = 1 - k; p.scale.set(1 + k);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

function riseIn(c) {
  const t0 = performance.now();
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / 400);
    c.alpha = k; c.pivot.set(0, -4 * (1 - k));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// fadeIn — a flat overlay (a field) appearing, with no vertical "rise".
function fadeIn(c) {
  const t0 = performance.now();
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / 500);
    c.alpha = k;
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---- walls ------------------------------------------------------------
// Real, planned construction: S.walls/S.gates are sets of grid tiles, grown
// piecemeal by wall ORDERS (see the 'wall' case in advanceOrder) that lay a
// straight segment and/or carve a gate. Nothing here computes a bounding box
// or resizes a ring — segments only ever ACCUMULATE. Wall tiles are
// impassable, gate tiles are passable (see findPath), and both render from
// the same fence atlas the old auto-ring used.
const wallKey = (x, y) => `${x},${y}`;
const clampX = (x) => Math.max(0, Math.min(TOWN_W - 1, Math.round(x)));
const clampY = (y) => Math.max(0, Math.min(TOWN_H - 1, Math.round(y)));

// Wall/gate tiles are grown by orders over real time, unlike the old ring
// (which was rederived every tick purely from the town's plot bounds + a
// level number) — so unlike that ring, they need their OWN save, a sibling
// of the economy's `xanhold:<id>` key (same "xanhold:" prefix, so `R` /
// resetWorld's wipe already covers it for free).
function wallsSaveKey() { return 'xanhold:' + S.hold.id + ':walls'; }
function saveWalls() {
  try {
    localStorage.setItem(wallsSaveKey(), JSON.stringify({
      walls: [...S.walls], gates: [...S.gates], edges: [...S.wallEdgesBuilt],
    }));
  } catch { /* private/sandboxed storage — walls just won't survive a reload */ }
}
function loadWalls() {
  try {
    const raw = localStorage.getItem(wallsSaveKey());
    if (!raw) return;
    const d = JSON.parse(raw);
    S.walls = new Set(d.walls || []); S.gates = new Set(d.gates || []); S.wallEdgesBuilt = new Set(d.edges || []);
  } catch { /* corrupt or sandboxed — start with a clean slate */ }
}

// buildingAtTile — is tile (tx,ty) under an already-placed building's
// footprint (S.hittable)? Buildings don't block pathing (only S.walls/
// S.water do — see findPath), so this exists purely so a wall segment
// doesn't draw a fence tile straight through one (a self-sited mine/wharf
// can legitimately end up near the core boundary — see coreRadius).
function buildingAtTile(tx, ty) {
  for (const h of S.hittable) if (tx >= h.x0 && tx < h.x1 && ty >= h.y0 && ty < h.y1) return true;
  return false;
}

// layWallSegment adds every tile on the straight line from `from` to `to`
// (inclusive) to S.walls, carving a gate at `gate` if given (that one tile
// becomes passable + drawn as an opening instead of fence). Only ever lays
// straight (axis-aligned) runs — a diagonal from an LLM-authored order is
// snapped to its dominant axis so the tile-by-tile walk below terminates.
// Skips any tile a building already occupies (buildingAtTile) — the fence
// meets the building instead of cutting through its sprite.
function layWallSegment(from, to, gate) {
  from = { x: clampX(from.x), y: clampY(from.y) };
  to = { x: clampX(to.x), y: clampY(to.y) };
  if (from.x !== to.x && from.y !== to.y) {
    to = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
  }
  const dx = Math.sign(to.x - from.x), dy = Math.sign(to.y - from.y);
  const g = gate ? { x: clampX(gate.x), y: clampY(gate.y) } : null;
  let x = from.x, y = from.y, guard = 0;
  while (guard++ <= TOWN_W + TOWN_H) {
    if (g && g.x === x && g.y === y) { S.walls.delete(wallKey(x, y)); S.gates.add(wallKey(x, y)); }
    else if (!buildingAtTile(x, y)) { S.gates.delete(wallKey(x, y)); S.walls.add(wallKey(x, y)); }
    if (x === to.x && y === to.y) break;
    x += dx; y += dy;
  }
  S.wallsVersion++; saveWalls();
}

// layGate carves (or moves) a single gate tile on its own — used both by
// layWallSegment's inline gate and a standalone "open a gate here" order
// with no segment attached (widening an existing wall's access).
function layGate(pt) {
  const key = wallKey(clampX(pt.x), clampY(pt.y));
  S.walls.delete(key); S.gates.add(key);
  S.wallsVersion++; saveWalls();
}

// wallPieceFor picks the fence sprite + rotation for a wall tile from its
// neighbor connectivity (n/s/e/w booleans — a gate neighbor counts as
// "connected" so the fence line reads continuous right up to the opening).
// Only h/v/tl/tr/post pieces exist in the atlas, so a bottom-side corner is
// a TOP corner rotated 180°: tl (connects E+S) flipped connects W+N; tr
// (connects W+S) flipped connects E+N.
function wallPieceFor(n, s, e, w) {
  const f = S.atlas.fence;
  const deg = (n ? 1 : 0) + (s ? 1 : 0) + (e ? 1 : 0) + (w ? 1 : 0);
  if (deg >= 3) return { tex: f.post, rot: 0 };        // a junction — no atlas tile for it; a post reads fine as a strongpoint
  if (e && s) return { tex: f.tl, rot: 0 };
  if (w && s) return { tex: f.tr, rot: 0 };
  if (w && n) return { tex: f.tl, rot: Math.PI };
  if (e && n) return { tex: f.tr, rot: Math.PI };
  if (e || w) return { tex: f.h, rot: 0 };
  if (n || s) return { tex: f.v, rot: 0 };
  return { tex: f.post, rot: 0 };                      // isolated tile — a lone post
}

// renderWalls (re)draws every wall/gate sprite from S.walls/S.gates — only
// when the tile set actually changed (S.wallsVersion), not every tick, and
// never by resizing one big ring: it just re-lays whatever tiles exist now.
function renderWalls() {
  if (S.wallsRendered === S.wallsVersion) return;
  S.wallsRendered = S.wallsVersion;
  for (const s of S.wallSprites) { entities.removeChild(s); s.destroy(); }
  S.wallSprites = [];
  const connected = (x, y) => S.walls.has(wallKey(x, y)) || S.gates.has(wallKey(x, y));
  const add = (tex, tx, ty, rot, tint) => {
    const s = new Sprite(tex); s.anchor.set(0.5, 0.5);
    s.x = tx * TILE + TILE / 2; s.y = ty * TILE + TILE / 2; s.rotation = rot;
    if (tint != null) s.tint = tint;
    s.zIndex = (ty + 1) * TILE;
    entities.addChild(s); S.wallSprites.push(s);
  };
  for (const key of S.walls) {
    const [tx, ty] = key.split(',').map(Number);
    const { tex, rot } = wallPieceFor(connected(tx, ty - 1), connected(tx, ty + 1), connected(tx + 1, ty), connected(tx - 1, ty));
    add(tex, tx, ty, rot);
  }
  // A gate is a tinted post (gold, matching the trader/coin pip elsewhere) —
  // visibly a structure, but distinct from a plain wall post, and it's NOT
  // in S.walls so findPath's passability check lets folk straight through.
  for (const key of S.gates) {
    const [tx, ty] = key.split(',').map(Number);
    add(S.atlas.fence.post, tx, ty, 0, 0xf2c14e);
  }
}

// ---- villagers ------------------------------------------------------
function roleWeights() {
  const g = S.game, w = { villager: 1 };
  w.farmer = g.level('farm') + g.level('wharf');
  w.woodcutter = g.level('sawmill');
  w.miner = g.level('mine') + g.level('quarry');
  w.trader = g.level('market');
  w.soldier = g.defense() * 2 + (isRaided() ? 3 : 0);
  w.speaker = 1 + g.level('reliquary') * 2; // always at least one; reliquaries raise more
  return Object.entries(w).filter(([, v]) => v > 0);
}

function pickRole() {
  const ws = roleWeights();
  const total = ws.reduce((a, [, v]) => a + v, 0);
  let r = Math.random() * total;
  for (const [role, v] of ws) { if ((r -= v) <= 0) return role; }
  return 'villager';
}

function spawnVillager() {
  const v = new Container();
  const role = pickRole();
  const anim = new AnimatedSprite(S.atlas.walk.down);
  anim.anchor.set(0.5, 1); anim.animationSpeed = 0.14;
  anim.tint = ROLE_TINT[role] || 0xffffff;
  anim.play();
  v.anim = anim; v.addChild(anim);
  const pipCol = ROLE_PIP[role];
  if (pipCol != null) {
    const pip = new Graphics().circle(0, -25, 2.4).fill(pipCol).stroke({ width: 1, color: 0x14140f, alpha: 0.7 });
    v.addChild(pip);
  }
  v.role = role; v.dir = 'down'; v.moving = false; v.idle = 0;
  v.home = null; v.haulTarget = null; // assignment model seed (see resolveHome above)
  const start = randomTownPoint();
  v.x = start.x; v.y = start.y; v.zIndex = v.y;
  resolveHome(v);
  pickTarget(v);
  entities.addChild(v);
  S.villagers.push(v);
}

function despawnVillager() {
  const v = S.villagers.pop();
  if (!v) return;
  releaseClaim(v);
  v.haulTarget = null; v.home = null;
  const rec = S.highlightRings.get(v); // don't leak a ring for a villager that's gone
  if (rec) { entities.removeChild(rec.gfx); rec.gfx.destroy(); S.highlightRings.delete(v); }
  entities.removeChild(v); v.destroy({ children: true });
}

function randomTownPoint() {
  // Wander among built plots, but never stand on the keep's doorway.
  const used = [...S.usedPlots].filter((k) => k !== S.keepKey).map((k) => k.split(',').map(Number));
  const p = used.length ? used[(Math.random() * used.length) | 0] : [S.plots[1].px, S.plots[1].py];
  return { x: (p[0] * PLOT + 1 + Math.random() * 2) * TILE, y: (p[1] * PLOT + 1 + Math.random() * 2) * TILE };
}

// A worker holds a claim on the single exhaustible node (a tree) it's walking
// to or toiling — release it so no other woodcutter targets the same trunk.
function releaseClaim(v) {
  const n = v.workNode || v.targetNode;
  if (n && n.claimedBy === v) n.claimedBy = null;
}

// ---- pathing (route around walls, through gates) ---------------------
// findPath runs a tile-grid BFS from a pixel position to a destination pixel
// position, avoiding S.walls and S.water tiles (see placeWater) and passing
// freely through S.gates tiles. The town is ~96x72 = ~7k cells — cheap to
// search on a target PICK (not every frame). Returns a list of pixel
// waypoints to walk in order (the last one is the exact destination, not
// just a tile center), or null if no route exists at all (fully walled/
// watered off with no gate) so the caller can degrade gracefully instead of
// freezing or clipping through the wall.
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function findPath(px, py, tx, ty) {
  const sx = Math.floor(px / TILE), sy = Math.floor(py / TILE);
  const gx = Math.floor(tx / TILE), gy = Math.floor(ty / TILE);
  if (sx === gx && sy === gy) return [{ x: tx, y: ty }];
  const goalK = wallKey(gx, gy);
  if (S.walls.has(goalK) || S.water.has(goalK)) return null; // destination tile is itself a wall or water
  const startK = wallKey(sx, sy);
  const cameFrom = new Map([[startK, null]]);
  const queue = [[sx, sy]]; let qi = 0;
  while (qi < queue.length) {
    const [cx, cy] = queue[qi++];
    if (wallKey(cx, cy) === goalK) break;        // shortest path found — stop expanding
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= TOWN_W || ny >= TOWN_H) continue;
      const k = wallKey(nx, ny);
      if (cameFrom.has(k) || S.walls.has(k) || S.water.has(k)) continue;
      cameFrom.set(k, wallKey(cx, cy));
      queue.push([nx, ny]);
    }
  }
  if (!cameFrom.has(goalK)) return null;         // sealed off — no gate reaches it
  const tiles = []; let k = goalK;
  while (k) { const [x, y] = k.split(',').map(Number); tiles.push([x, y]); k = cameFrom.get(k); }
  tiles.reverse(); tiles.shift();                // drop the start tile — already standing there
  const waypoints = tiles.map(([x, y]) => ({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 }));
  if (waypoints.length) waypoints[waypoints.length - 1] = { x: tx, y: ty }; // land exactly on the real target
  else waypoints.push({ x: tx, y: ty });
  return waypoints;
}

// goTo sets a villager's destination and plans its route around walls once,
// here, at target-pick time — stepVillager just walks the cached waypoint
// list, never repathing per frame. No route exists → the villager idles a
// few seconds (not zero — so a sealed-off target doesn't spin retrying the
// BFS every frame) and lets the next pickTarget try again.
function goTo(v, x, y) {
  v.tx = x; v.ty = y;
  const path = findPath(v.x, v.y, x, y);
  if (!path) { v.moving = false; v.path = null; v.idle = 1 + Math.random() * 3; return; }
  v.path = path; v.moving = true;
}

function pickTarget(v) {
  if (v.role === 'soldier' && isRaided()) {
    // rush the settlement's wall (near the town centre), not the far map edge
    const a = Math.random() * Math.PI * 2;
    goTo(v, (TOWN_W / 2 + Math.cos(a) * 13) * TILE, (TOWN_H / 2 + Math.sin(a) * 11) * TILE);
    return;
  }
  // Miners and woodcutters make work trips: out to a node, then home to
  // haul (see CARRY) — always seek the nearest node next, whether they just
  // spawned or just dropped a load off.
  const cfg = CARRY[v.role];
  if (cfg) {
    releaseClaim(v);                       // drop any node we were holding
    const node = nearestNode(v.x, v.y, cfg.nodeType);
    if (node) {
      v.targetNode = node;
      // Exhaustible nodes (trees) are one-worker: claim it so the next idle
      // woodcutter skips it and the phantom-chop double-log can't happen.
      if (cfg.exhaustible) node.claimedBy = v;
      goTo(v, node.x, node.y);
    } else {
      v.targetNode = null;
      const t = randomTownPoint(); goTo(v, t.x, t.y);
    }
    return;
  }
  const t = randomTownPoint(); goTo(v, t.x, t.y);
}

function nearestNode(px, py, type) {
  // A claimed ore node has a mine standing on it now — not a vein to work;
  // a claimed wood node already has a woodcutter felling it.
  const list = type === 'ore'
    ? S.oreNodes.filter((n) => !n.claimedByMine)
    : S.woodNodes.filter((n) => !n.claimedBy);
  let best = null, bd = Infinity;
  for (const n of list) { const d = (n.x - px) ** 2 + (n.y - py) ** 2; if (d < bd) { bd = d; best = n; } }
  return best;
}

// workEffect — sparks fly when a node is being worked (mining/chopping).
function workEffect(node) {
  for (let i = 0; i < 5; i++) {
    const p = new Graphics().circle(0, 0, 1 + Math.random() * 1.4).fill(0xfff2c0);
    p.x = node.x + (Math.random() - 0.5) * 10; p.y = node.y - 6 - Math.random() * 4; p.zIndex = 1e7;
    entities.addChild(p);
    const vx = (Math.random() - 0.5) * 22, vy = -14 - Math.random() * 10, t0 = performance.now();
    const tick = () => {
      const k = (performance.now() - t0) / 480;
      if (k >= 1) { entities.removeChild(p); p.destroy(); return; }
      p.x += vx * 0.016; p.y += vy * 0.016; p.alpha = 1 - k;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

// nearestBuilding returns the pixel centre AND S.hittable entry (`ref`) of the
// closest placed building of `type` (sawmill, mine, reliquary…), or null.
// `ref` is what an assignment (v.home / v.haulTarget) points at.
function nearestBuilding(type, px, py) {
  let best = null, bd = Infinity;
  for (const h of S.hittable) {
    if (h.type !== type) continue;
    const cx = ((h.x0 + h.x1) / 2) * TILE, cy = ((h.y0 + h.y1) / 2) * TILE;
    const d = (cx - px) ** 2 + (cy - py) ** 2;
    if (d < bd) { bd = d; best = { x: cx, y: cy, ref: h }; }
  }
  return best;
}

// ---- assignment model (seed of the jobs system) ----------------------
// Two assignment kinds exist today: v.home is PERMANENT (a speaker linked to
// its reliquary) and v.haulTarget is TEMPORARY (a hauler's current delivery
// building) — both plain references into S.hittable. Build/upgrade/repair
// jobs will slot in alongside these as the jobs system grows.
//
// resolveHome links a speaker to the nearest reliquary. Called at spawn and
// again each reconcileVillagers() pass (cheap — early-returns once linked),
// so a speaker picks one up lazily the moment a reliquary is first built.
function resolveHome(v) {
  if (v.role !== 'speaker') { v.home = null; return; }
  if (v.home) return; // already linked
  const h = nearestBuilding('reliquary', v.x, v.y);
  v.home = h ? h.ref : null; // no reliquary yet — retried next reconcile
}

// fellTree clears a felled wood node: destroy its tree sprites, drop it from
// the node list, and throw a burst of wood-chips. Guarded against double-fell.
function fellTree(node) {
  if (!node || node.felled) return;
  node.felled = true;
  for (const s of (node.sprites || [])) { entities.removeChild(s); s.destroy(); }
  const i = S.woodNodes.indexOf(node);
  if (i >= 0) S.woodNodes.splice(i, 1);
  chipBurst(node.x, node.y);
}

function chipBurst(x, y) {
  for (let i = 0; i < 6; i++) {
    const p = new Graphics().rect(-1, -1, 2, 2).fill(0x8a5a2b);
    p.x = x + (Math.random() - 0.5) * 10; p.y = y - 6 - Math.random() * 4; p.zIndex = 1e7;
    entities.addChild(p);
    const vx = (Math.random() - 0.5) * 20, vy = -12 - Math.random() * 9, t0 = performance.now();
    const tick = () => {
      const k = (performance.now() - t0) / 540;
      if (k >= 1) { entities.removeChild(p); p.destroy(); return; }
      p.x += vx * 0.016; p.y += vy * 0.016 + k * 4; p.alpha = 1 - k;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

// CARRY — the shared "carry a commodity from a work node to its home
// building" mechanism: a woodcutter fells a tree and hauls a log to the
// nearest sawmill; a miner works a vein and hauls an ore chunk to the
// nearest mine. Both roles run through startHaul/deliverCommodity below —
// the one mechanism unifying wood and ore, so a new commodity is just a
// new entry here.
const CARRY = {
  woodcutter: {
    nodeType: 'wood', building: 'sawmill', exhaustible: true,
    tex: () => S.atlas.tex(106), // Kenney log tile
    scale: 0.7, dx: 3, dy: -19, workMin: 2.5, workRange: 2,
  },
  miner: {
    nodeType: 'ore', building: 'mine', exhaustible: false,
    tex: (node) => node.tex, // the vein's own ore texture — small, matches what was mined
    // plain rock is the common, low-value haul — carry it smaller than a real
    // metal chunk (coal/copper/iron/gold), which keeps the old, larger size.
    scale: (node) => node.kind === 'stone' ? 0.38 : 0.55,
    dx: 3, dy: -18, workMin: 3, workRange: 3,
  },
};

// startHaul attaches the carried-commodity sprite and sends the worker home
// to the nearest matching building; deliverCommodity drops it there.
function startHaul(v, cfg, node) {
  const s = new Sprite(cfg.tex(node));
  const scale = typeof cfg.scale === 'function' ? cfg.scale(node) : cfg.scale;
  s.anchor.set(0.5, 1); s.scale.set(scale); s.x = cfg.dx; s.y = cfg.dy;
  v.addChild(s); v.carrySprite = s; v.hauling = true;
  const home = nearestBuilding(cfg.building, v.x, v.y);
  v.haulTarget = home ? home.ref : null; // TEMP assignment — cleared on deliver/despawn
  v.targetNode = null;
  const t = home || randomTownPoint();
  goTo(v, t.x, t.y);
}

function deliverCommodity(v) {
  if (v.carrySprite) { v.removeChild(v.carrySprite); v.carrySprite.destroy(); v.carrySprite = null; }
  v.hauling = false;
  v.haulTarget = null; // delivered — the temp assignment ends
}

// The forest recovers: every so often a fresh sapling (and its wood node)
// grows back on open near-town ground, up to the original forest size.
function regrowOne() {
  if (!S.treePool || S.woodNodes.length >= (S.woodCap || 0)) return;
  for (let t = 0; t < 12; t++) {
    const tx = Math.floor(TOWN_W / 2 + (Math.random() - 0.5) * 46);
    const ty = Math.floor(TOWN_H / 2 + (Math.random() - 0.5) * 38);
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
function scheduleRegrow() {
  setTimeout(() => { regrowOne(); scheduleRegrow(); }, 9000 + Math.random() * 6000);
}

function stepVillager(v, dt) {
  if (!v.moving) {
    v.idle -= dt;
    if (v.idle <= 0) {
      if (v.working) {                 // finished toiling the node — haul the goods home
        v.working = false;
        const node = v.workNode, cfg = CARRY[v.role]; v.workNode = null;
        if (cfg.exhaustible) fellTree(node);   // wood: the tree is gone; ore veins don't deplete
        startHaul(v, cfg, node);
        return;
      }
      pickTarget(v);
    }
    return;
  }
  if (!v.path || !v.path.length) { v.moving = false; return; } // safety net — shouldn't happen
  if (!v.anim.playing) v.anim.play();
  const wp = v.path[0];                // walk toward the next cached waypoint, not straight at v.tx/v.ty
  const dx = wp.x - v.x, dy = wp.y - v.y;
  const dist = Math.hypot(dx, dy);
  const worker = !!CARRY[v.role];
  const speed = (v.role === 'soldier' && isRaided() ? 34 : worker ? 24 : 18) * dt;
  if (dist < speed) {
    v.x = wp.x; v.y = wp.y; v.zIndex = v.y;
    v.path.shift();
    if (v.path.length) return;         // more waypoints ahead (bending around a wall) — continue next frame
    v.moving = false; v.anim.gotoAndStop(0);
    if (v.targetNode) {                // reached the work node — toil a while, sparks flying
      v.working = true; v.workNode = v.targetNode; v.targetNode = null;
      const cfg = CARRY[v.role];
      v.idle = cfg.workMin + Math.random() * cfg.workRange;
      workEffect(v.workNode);
    } else {                           // arrived home / at the mill, or just wandering
      if (v.hauling) deliverCommodity(v);
      v.idle = 0.8 + Math.random() * 2.5;
    }
    return;
  }
  v.x += (dx / dist) * speed; v.y += (dy / dist) * speed;
  const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  if (dir !== v.dir) { v.dir = dir; v.anim.textures = S.atlas.walk[dir]; v.anim.play(); }
  v.zIndex = v.y;
}

// ---- day/night + frame ---------------------------------------------
function makeOverlay(color) {
  const g = new Graphics().rect(0, 0, 1, 1).fill(color);
  g.width = window.innerWidth; g.height = window.innerHeight;
  g.blendMode = 'multiply';
  return g;
}

function onFrame(ticker) {
  const dt = Math.min(0.1, ticker.deltaMS / 1000);
  for (const v of S.villagers) stepVillager(v, dt);
  // hover highlight rings: perma (v.home) vs temp (v.haulTarget) assignees of
  // S.hoverBuilding — only exist while hovering (see setHoverBuilding).
  if (S.hoverBuilding) refreshHighlights(Date.now());
  if (S.highlightRings.size) {
    const pulse = 0.55 + 0.35 * Math.sin(performance.now() / 260); // temp's "in transit" breathe
    for (const [v, rec] of S.highlightRings) {
      rec.gfx.x = v.x; rec.gfx.y = v.y; rec.gfx.zIndex = v.y - 0.5; // just under the villager's feet
      if (rec.kind === 'temp') rec.gfx.alpha = pulse;
    }
  }
  // camera: WASD nudges it; otherwise a slow auto-tour that resumes ~12s
  // after you stop steering (drag is handled in initPan).
  if (heldKeys.size) {
    const sp = 16 * dt;
    if (heldKeys.has('w')) S.cam.y -= sp;
    if (heldKeys.has('s')) S.cam.y += sp;
    if (heldKeys.has('a')) S.cam.x -= sp;
    if (heldKeys.has('d')) S.cam.x += sp;
    clampCam(); manualCam();
  }
  if (S.camAuto) {
    // Tour a fixed radius around the town centre (map middle), not the whole
    // wilderness — the amplitude is in tiles so it stays near the settlement.
    const ct = Date.now() / 1000;
    const tx = TOWN_W / 2 + Math.sin(ct * 0.024) * 14;
    const ty = TOWN_H / 2 + Math.cos(ct * 0.017) * 10;
    S.cam.x += (tx - S.cam.x) * 0.04;
    S.cam.y += (ty - S.cam.y) * 0.04;
  } else if (Date.now() - S.lastInput > 12000) {
    S.camAuto = true; // resume the tour after you stop panning
  }
  world.x = Math.round(window.innerWidth / 2 - S.cam.x * TILE * S.scale);
  world.y = Math.round(window.innerHeight / 2 - S.cam.y * TILE * S.scale);
  // day/night
  const phase = (Date.now() % DAY_MS) / DAY_MS;                 // 0..1
  const daylight = 0.5 + 0.5 * Math.sin((phase - 0.25) * 2 * Math.PI); // noon=1, midnight=0
  night.alpha = 0.55 * (1 - daylight);
  night.width = window.innerWidth; night.height = window.innerHeight;
  // raid alarm pulse
  if (S.alarm > 0) { S.alarm -= dt; alarmFx.alpha = 0.18 * Math.max(0, Math.sin(S.alarm * 10)); alarmFx.width = window.innerWidth; alarmFx.height = window.innerHeight; }
  else alarmFx.alpha = 0;
}

function layoutWorld() {
  // Set a comfortable starting zoom once; keep the player's zoom across resizes.
  if (S.scale == null) S.scale = Math.max(3, Math.round(Math.min(window.innerWidth, window.innerHeight) / 300));
  world.scale.set(S.scale);
  if (app) app.renderer.resize(window.innerWidth, window.innerHeight);
}

// setZoom keeps the scale an integer (1..8) so pixels stay crisp at every level.
function setZoom(s) {
  S.scale = Math.max(1, Math.min(8, Math.round(s)));
  world.scale.set(S.scale);
}
function initZoom() {
  addEventListener('wheel', (e) => { e.preventDefault(); setZoom(S.scale + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
}

// Manual camera: left-drag or WASD. Both flag manual mode so the auto-tour
// yields, and the camera is clamped to the map.
function manualCam() { S.camAuto = false; S.lastInput = Date.now(); }
function clampCam() {
  S.cam.x = Math.max(0, Math.min(TOWN_W, S.cam.x));
  S.cam.y = Math.max(0, Math.min(TOWN_H, S.cam.y));
}
// buildingAt maps a screen point back to the building under it (or null).
function buildingAt(cx, cy) {
  const wx = (cx - world.x) / S.scale / TILE;   // S.scale is the numeric zoom (world.scale is a Point)
  const wy = (cy - world.y) / S.scale / TILE;
  let hit = null;
  for (const h of S.hittable) {
    if (wx >= h.x0 - 0.2 && wx < h.x1 + 0.2 && wy >= h.y0 - 0.2 && wy < h.y1 + 0.4) hit = h; // later = drawn on top
  }
  return hit;
}
// hoverIdentify shows a small label for the building under the cursor, and
// (via setHoverBuilding) drives the assigned-villager highlight rings.
function hoverIdentify(e) {
  const h = buildingAt(e.clientX, e.clientY);
  if (h !== S.hoverBuilding) setHoverBuilding(h);
  const tip = document.getElementById('btip');
  if (!tip) return;
  if (!h) { tip.style.display = 'none'; return; }
  let text = h.label || BUILD_NAME[h.type] || h.type;
  if (h.type) { const lv = S.game.level(h.type); if (lv) text += ' · lvl ' + lv; }
  if (h.type && BY_ID[h.type] && BY_ID[h.type].kind === 'storage') { const fill = storageFill(h.type); if (fill) text += ' · ' + fill; }
  tip.textContent = text;
  tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px';
  tip.style.display = 'block';
}

// storageFill summarizes a storage building's overall fill for #btip: the
// sum of stored goods over the sum of caps, across every resource that
// building type contributes to (per capBreakdown, so it agrees with caps()).
// '' if it caps nothing (shouldn't happen, but keeps the tooltip clean).
function storageFill(id) {
  const g = S.game;
  let cur = 0, cap = 0;
  for (const k of Object.keys(CFG.baseCaps)) {
    if (k === 'coin') continue; // uncapped — not part of a storehouse's remit
    const { contributors, total } = g.capBreakdown(k);
    if (!contributors.some((c) => c.id === id)) continue;
    cur += g.res[k]; cap += total;
  }
  return cap > 0 ? `stores ${Math.floor(cur)} / ${Math.floor(cap)}` : '';
}

// ---- hover highlight (perma vs temp assignees) -----------------------
const HIGHLIGHT_COLOR = { perma: 0xffd23a, temp: 0x38d6ff }; // gold = home, cyan = in transit
// makeHighlightRing draws the small ground ring under a highlighted
// villager's feet — perma is a steady solid-gold ring, temp a lighter cyan
// one whose alpha gets pulsed each frame in onFrame.
function makeHighlightRing(kind) {
  const g = kind === 'perma'
    ? new Graphics().ellipse(0, 0, 8, 3.5).fill({ color: HIGHLIGHT_COLOR.perma, alpha: 0.32 }).stroke({ width: 1.4, color: 0xffe27a, alpha: 0.95 })
    : new Graphics().ellipse(0, 0, 7, 3).fill({ color: HIGHLIGHT_COLOR.temp, alpha: 0.55 }).stroke({ width: 1, color: 0xbdf3ff, alpha: 0.9 });
  entities.addChild(g);
  return g;
}

// clearHighlightRings tears down every ring — the only cleanup path, so
// highlights never outlive a hover (called on every hover change/clear).
function clearHighlightRings() {
  for (const rec of S.highlightRings.values()) { entities.removeChild(rec.gfx); rec.gfx.destroy(); }
  S.highlightRings.clear();
}

// refreshHighlights (re)builds the ring set for S.hoverBuilding's assigned
// villagers. Throttled to ~200ms — temp (hauling) assignees turn over as
// workers come and go, so this is re-run periodically, not every frame.
function refreshHighlights(now) {
  if (now - S.highlightAt < 200) return;
  S.highlightAt = now;
  const hb = S.hoverBuilding, want = new Map();
  if (hb) for (const v of S.villagers) {
    if (v.home === hb) want.set(v, 'perma');
    else if (v.haulTarget === hb) want.set(v, 'temp');
  }
  for (const [v, rec] of S.highlightRings) {          // drop stale/changed-kind rings
    if (want.get(v) !== rec.kind) { entities.removeChild(rec.gfx); rec.gfx.destroy(); S.highlightRings.delete(v); }
  }
  for (const [v, kind] of want) {                      // add newly-assigned villagers
    if (!S.highlightRings.has(v)) S.highlightRings.set(v, { kind, gfx: makeHighlightRing(kind) });
  }
}

// setHoverBuilding swaps the hovered building: redraws its subtle outline and
// tears down old rings immediately (refreshHighlights repopulates them next
// frame — S.highlightAt is reset so the throttle doesn't delay it).
function setHoverBuilding(h) {
  if (S.hoverGfx) { ground.removeChild(S.hoverGfx); S.hoverGfx.destroy(); S.hoverGfx = null; }
  S.hoverBuilding = h;
  clearHighlightRings();
  S.highlightAt = 0;
  if (h) {
    const x0 = h.x0 * TILE, y0 = h.y0 * TILE, w = (h.x1 - h.x0) * TILE, ht = (h.y1 - h.y0) * TILE;
    S.hoverGfx = new Graphics().rect(x0, y0, w, ht).stroke({ width: 2, color: 0xfff3c0, alpha: 0.55 });
    ground.addChild(S.hoverGfx);
  }
}

function initPan() {
  const el = app.canvas;
  el.style.cursor = 'grab';
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId);
    el.style.cursor = 'grabbing'; manualCam();
  });
  el.addEventListener('pointermove', (e) => {
    if (drag) {
      S.cam.x -= (e.clientX - drag.x) / (TILE * S.scale);
      S.cam.y -= (e.clientY - drag.y) / (TILE * S.scale);
      drag = { x: e.clientX, y: e.clientY };
      clampCam(); manualCam();
      return;
    }
    hoverIdentify(e);
  });
  const end = () => { drag = null; el.style.cursor = 'grab'; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', () => { const t = document.getElementById('btip'); if (t) t.style.display = 'none'; setHoverBuilding(null); });
  addEventListener('keydown', (e) => { if (e.target && e.target.tagName === 'INPUT') return; const k = e.key.toLowerCase(); if (k === 'w' || k === 'a' || k === 's' || k === 'd') heldKeys.add(k); });
  addEventListener('keyup', (e) => heldKeys.delete(e.key.toLowerCase()));
  addEventListener('blur', () => heldKeys.clear()); // don't let a key stick when focus leaves
}

// ---- the sim/steward loop ------------------------------------------
function isRaided() { return (S.game.raidTally || 0) > S.lastRaidTally; }

// townTick: advance the economy a real second, execute orders, keep the
// visible town in step with it, and reflect raids.
function townTick() {
  const now = Date.now();
  const dt = Math.min(2, (now - S.game.lastTick) / 1000);
  S.game.step(dt); S.game.lastTick = now; S.game.save();

  // Faith crossing its threshold is the Will's primary invocation trigger now
  // (STEWARD_MS's ambient timer is just a slow backstop) — the god speaks
  // when the hold's speakers have raised enough of it, not on a fixed clock.
  if (S.game.faithReady) {
    S.game.faithReady = false;
    callWill(`${S.mask.aspect} is invoked`);
  }

  executeOrders(dt);
  reconcileBuildings();
  reconcileVillagers();

  // new raid since last look → sound the alarm + chronicle it
  const rt = S.game.raidTally || 0;
  if (rt > S.lastRaidTally) {
    S.alarm = 1.2;
    const last = S.game.log.find((l) => l.kind === 'raid');
    if (last) pushChronicle('⚔ ' + last.text, 'raid');
  }
  setTimeout(() => { S.lastRaidTally = rt; }, 2500);
  renderOrders();
  updateHUD(); // folds the Folk legend + defense into the Pop chip now
}

function reconcileVillagers() {
  const want = Math.min(70, Math.max(3, Math.floor(S.game.pop)));
  while (S.villagers.length < want) spawnVillager();
  while (S.villagers.length > want) despawnVillager();
  for (const v of S.villagers) resolveHome(v); // re-link speakers as roles/buildings change
}

// pushOrder appends a decree to the log as pending work.
function pushOrder(o) {
  S.orderLog.push({
    type: o.type, target: o.target, action: o.action, resource: o.resource,
    value: o.value, qty: o.qty || 1, reason: o.reason,
    from: o.from, to: o.to, gate: o.gate,     // 'wall' orders: a segment (from/to) and/or a gate point
    qtyLeft: o.qty || 1, status: 'pending', progress: 0, waited: 0,
  });
}

// The town has several work crews, so up to MAX_ACTIVE orders advance in
// PARALLEL — one order stuck waiting on materials no longer freezes the
// whole town. A unit's effect lands only when its work bar fills, so orders
// are visibly carried out over time; finished orders stay in the log.
const MAX_ACTIVE = 3;

function executeOrders(dt) {
  let active = S.orderLog.filter((o) => o.status === 'active').length;
  for (const o of S.orderLog) {                 // staff idle crews from the pending queue
    if (active >= MAX_ACTIVE) break;
    if (o.status === 'pending') { o.status = 'active'; o.progress = 0; active++; }
  }
  for (const a of S.orderLog) if (a.status === 'active') advanceOrder(a, dt);
  trimOrderLog();
}

function advanceOrder(a, dt) {
  a.progress += dt / (WORK_S[a.type] || 3);
  if (a.progress < 1) return;
  if (a.type === 'focus') { S.focus = a.value || a.target || null; a.qtyLeft = 0; }
  else if (a.type === 'trade') {
    const q = a.qty || 20;
    if (a.action === 'sell') S.game.sell(a.resource, q); else S.game.buy(a.resource, q);
    a.qtyLeft = 0;
  } else if (a.type === 'build') {
    // A mine can only rise on an ore vein — if the field has none free (and
    // the town isn't already past its drawn-instance cap), the order can't
    // be fulfilled; fail it outright rather than spend resources on a mine
    // with nowhere to stand. This is the town-side "correct placement"
    // resolution for any `build mine` order, however it was raised.
    if (a.target === 'mine' && !mineNodeAvailable()) { a.status = 'skipped'; a.doneAt = Date.now(); return; }
    // Same idea for a wharf — no shoreline left to build it on (see placeWater).
    if (a.target === 'wharf' && !wharfSiteAvailable()) { a.status = 'skipped'; a.doneAt = Date.now(); return; }
    // A new farm is its own field (with a crop); other builds raise a level.
    const ok = a.target === 'farm' ? S.game.newFarm(a.crop) : S.game.build(a.target);
    if (ok) { a.qtyLeft -= 1; a.waited = 0; }
    else {                       // can't afford — try to fund it; give up after a while
      autoFund(a.target); a.progress = 1; a.waited += dt;
      if (a.waited > 16) { a.status = 'skipped'; a.doneAt = Date.now(); }
      return;                    // (other crews keep working in parallel)
    }
  } else if (a.type === 'expand') {
    if (S.game.expandFarm() >= 0) { a.qtyLeft -= 1; a.waited = 0; }
    else {
      autoFund('farm'); a.progress = 1; a.waited += dt;
      if (a.waited > 16) { a.status = 'skipped'; a.doneAt = Date.now(); }
      return;
    }
  } else if (a.type === 'wall') {
    // Walls cost the same materials + raise defense the old palisade LEVEL
    // did (S.game.build/canAfford still gate it — game.js is unchanged) —
    // only the RESULT differs: real tiles (a segment and/or a gate) land on
    // the grid instead of an auto-ring being redrawn.
    if (!((a.from && a.to) || a.gate)) { a.status = 'skipped'; a.doneAt = Date.now(); return; } // malformed order — no geometry to build
    if (S.game.build('palisade')) {
      if (a.from && a.to) layWallSegment(a.from, a.to, a.gate);
      else if (a.gate) layGate(a.gate);
      a.qtyLeft -= 1; a.waited = 0;
    } else {
      autoFund('palisade'); a.progress = 1; a.waited += dt;
      if (a.waited > 16) { a.status = 'skipped'; a.doneAt = Date.now(); }
      return;
    }
  }
  if (a.qtyLeft <= 0) { a.status = 'done'; a.doneAt = Date.now(); }
  else a.progress = 0;           // begin the next unit
}

// trimOrderLog keeps finished entries around to read, but not forever.
function trimOrderLog() {
  const finished = S.orderLog.filter((o) => o.status === 'done' || o.status === 'skipped');
  while (finished.length > 6) {
    const rm = finished.shift();
    S.orderLog.splice(S.orderLog.indexOf(rm), 1);
  }
}

// autoFund tries to make an order affordable via the market: sell a surplus
// for coin, and BUY the material the land can't make (e.g. stone for a
// forest hold's longhouse) — the reason orders used to get stuck.
function autoFund(id) {
  if (!S.game.tradeUnlocked()) return;
  const sellSurplus = () => {
    for (const k of ['food', 'timber', 'salt', 'ore', 'stone']) {
      if (S.game.res[k] > 60) { S.game.sell(k, 20); return; }
    }
  };
  for (const [res, need] of Object.entries(S.game.costOf(id))) {
    if (S.game.res[res] >= need) continue;
    if (res === 'coin') { sellSurplus(); continue; }
    const short = Math.ceil(need - S.game.res[res]);
    if (S.game.res.coin >= S.game.buyPrice(res) * short) S.game.buy(res, short);
    else sellSurplus();
  }
}

// planDefensiveSegment — the local heuristic's autonomous wall planner: picks
// the next un-walled side of the CORE zone (a straight north/south/east/west
// run just outside coreRadius, see insideCore) and a gate at its middle so
// the folk can still reach the farmland/mines/wharfs beyond it. This wraps
// the protected core — dwellings/stores/faith — NOT the town's whole built
// footprint (which would swallow the outer resource works too). Cycles
// through all four sides once each (S.wallEdgesBuilt); once all four are
// planned locally, further walls are the Will's speakers to extend/gate.
function planDefensiveSegment() {
  if (!S.usedPlots.size) return null; // nothing built yet — nowhere to wall
  const ccx = TOWN_W / 2, ccy = TOWN_H / 2;
  const rad = coreRadius() * PLOT + 2; // the core zone, +2 tiles clearance past its buildings
  const x0 = Math.max(0, Math.round(ccx - rad)), y0 = Math.max(0, Math.round(ccy - rad));
  const x1 = Math.min(TOWN_W - 1, Math.round(ccx + rad)), y1 = Math.min(TOWN_H - 1, Math.round(ccy + rad));
  const midX = Math.round((x0 + x1) / 2), midY = Math.round((y0 + y1) / 2);
  const sides = {
    north: { from: { x: x0, y: y0 }, to: { x: x1, y: y0 }, gate: { x: midX, y: y0 } },
    south: { from: { x: x0, y: y1 }, to: { x: x1, y: y1 }, gate: { x: midX, y: y1 } },
    west: { from: { x: x0, y: y0 }, to: { x: x0, y: y1 }, gate: { x: x0, y: midY } },
    east: { from: { x: x1, y: y0 }, to: { x: x1, y: y1 }, gate: { x: x1, y: midY } },
  };
  for (const [name, seg] of Object.entries(sides)) {
    if (S.wallEdgesBuilt.has(name)) continue;
    S.wallEdgesBuilt.add(name);
    return seg;
  }
  return null;                    // all four sides already planned locally
}

// localSteward: the town's own hands. When no orders are queued it picks a
// sensible next build so the hold keeps growing even with no Claude.
function localSteward() {
  if (S.orderLog.some((o) => o.status === 'pending' || o.status === 'active')) return;
  const g = S.game, h = S.hold;
  // Farmland is a DISTRICT that fills before it sprawls: while any existing
  // field still has room to grow, expand it rather than breaking ground on a
  // new one (see wantsNewFarmField/nextFarmPlot) — replaces the old
  // scarce-food coin-flip that scattered size-1 fields across the map.
  const wantFood = S.focus === 'food' || g.res.food < g.caps().food * 0.35;
  if ((wantFood || (h.rich.food || 0) >= 0.12) && !wantsNewFarmField()) {
    pushOrder({ type: 'expand', target: 'farm', qty: 1 }); return;
  }
  // Walls: the same trigger the old auto-ring had (raided + under-defended,
  // or an explicit defense focus), but now it PLANS geometry — a straight
  // segment with a gate — instead of magically redrawing a ring. Segments
  // accumulate (see wallEdgesBuilt in planDefensiveSegment), so the town's
  // wall visibly grows piecemeal even with no Will involved.
  const wantWall = (isRaided() && g.defense() < 3) || S.focus === 'defense';
  if (wantWall && g.canAfford('palisade')) {
    const seg = planDefensiveSegment();
    if (seg) { pushOrder({ type: 'wall', target: 'palisade', from: seg.from, to: seg.to, gate: seg.gate, qty: 1 }); return; }
  }
  const want = [];
  // A speaker's focus can bid a specific building outright — the placement
  // layer (nextCorePlot/nextOuterPlot/nextFarmPlot) still decides WHICH
  // district it lands in by type, so this only biases priority, not routing.
  if (S.focus && S.focus !== 'food' && S.focus !== 'defense' && BUILDINGS.some((b) => b.id === S.focus)) want.push(S.focus);
  if (g.pop >= g.popCap() - 0.5) want.push('longhouse');
  if (!g.tradeUnlocked()) want.push('market');
  if (g.res.food >= g.caps().food * 0.92) want.push('granary');
  if (S.focus === 'food') want.push('farm');
  // Raise the faith now and then — reliquaries widen the Will's voice.
  if (g.level('reliquary') < 4 && g.pop > 12 && Math.random() < 0.12) want.push('reliquary');
  // then the hold's richest producers
  const prodByRes = { food: ['farm', 'wharf'], timber: ['sawmill'], stone: ['quarry'], ore: ['mine'], salt: ['saltern'], coin: ['market'] };
  for (const [res] of Object.entries(h.rich).sort((a, b) => b[1] - a[1]))
    for (const id of (prodByRes[res] || [])) want.push(id);
  want.push('longhouse');
  for (const id of want) {
    const b = S.game && BUILDINGS.find((x) => x.id === id);
    if (!b) continue;
    if (b.kind === 'prod' && S.game.richOf(b) < b.gate && !S.game.level(id)) continue;
    if (S.game.canAfford(id)) { pushOrder({ type: 'build', target: id, qty: 1 }); return; }
  }
}

// callWill invokes the Divine Will: Opus utters terse directives as the hold's
// aspect (the Salt/Current/Deep…), and its speakers (Haiku) each interpret one
// into concrete orders. The utterance + each speaker's word land in the log.
async function callWill(occasion, instruction) {
  if (S.stewardBusy) return;
  S.stewardBusy = true;
  const aspect = S.mask.aspect;
  setStewardLine(instruction ? `${aspect} weighs your word…` : `${aspect} stirs…`);
  try {
    const res = await fetch('/will', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(willState(occasion, instruction)),
    });
    const d = await res.json();
    let bidden = 0;
    const heard = [];
    for (const sp of (d.speakers || [])) {
      const orders = Array.isArray(sp.orders) ? sp.orders.map(normalizeOrder) : [];
      if (orders.length) { orders.forEach(pushOrder); bidden += orders.length; }
      heard.push({ name: sp.name, parish: sp.parish, directive: sp.directive, word: sp.word || '', orders });
    }
    // stash this invocation so the left Speakers panel can show the full
    // directive → speaker → orders distribution, persisting between calls.
    S.lastWill = { utterance: d.utterance || null, aspect: d.aspect || aspect, speakers: heard };
    renderWillPanel();
    if (d.speakers && d.speakers.length) {
      setStewardLine(`${aspect} spoke through ${d.speakers.length} — ${bidden} work${bidden === 1 ? '' : 's'} bidden.`);
      renderOrders();
    } else setStewardLine(`${aspect} keeps its silence.`);
  } catch (e) {
    setStewardLine('(the Will is distant — the folk act alone)');
  } finally {
    setTimeout(() => S.stewardBusy = false, 500);
  }
}

// willState is the town's state plus the mask (aspect/speakers) and bandwidth
// (temples = 1 + reliquaries) the Will pipeline needs.
function willState(occasion, instruction) {
  const s = stewardState(occasion, instruction);
  s.mask = S.mask;
  s.temples = 1 + S.game.level('reliquary');
  return s;
}

function normalizeOrder(o) {
  return {
    type: o.type, target: o.target, action: o.action, resource: o.resource, value: o.value || o.target, qty: o.qty || 1,
    from: o.from, to: o.to, gate: o.gate,     // a speaker's 'wall' order: {x,y} segment endpoints and/or a gate point
  };
}

// The Steward-ask box: P opens it so you can instruct the Steward in your own
// words, or just press Enter for a free-hand (regular) decree.
function showStewardAsk() {
  const box = document.getElementById('stewardask'), input = document.getElementById('stewardinput');
  if (!box || !input) { callWill('the Will is summoned'); return; }
  box.style.display = 'flex'; input.value = '';
  setTimeout(() => input.focus(), 0); // defer so the triggering 'p' keydown doesn't type into it
}
function initStewardAsk() {
  const box = document.getElementById('stewardask'), input = document.getElementById('stewardinput');
  if (!input) return;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value.trim();
      box.style.display = 'none'; input.blur();
      callWill(v ? 'the lord instructs the Will' : 'the Will is summoned', v || null);
    } else if (e.key === 'Escape') {
      e.preventDefault(); box.style.display = 'none'; input.blur();
    }
  });
}

function stewardState(occasion, instruction) {
  const g = S.game, h = S.hold;
  const rate = g.rates();
  return {
    occasion, instruction: instruction || '',
    name: h.name, tier: h.tierName, ancestry: h.ancestry, realm: h.realm, region: h.region,
    danger: h.danger, beingRaided: isRaided(), currentFocus: S.focus,
    resources: Object.fromEntries(Object.entries(g.res).map(([k, v]) => [k, Math.round(v)])),
    caps: g.caps(), rates: Object.fromEntries(Object.entries(rate).map(([k, v]) => [k, +v.toFixed(2)])),
    pop: Math.floor(g.pop), popCap: g.popCap(), defense: g.defense(), efficiency: +g.efficiency().toFixed(2),
    buildings: Object.fromEntries(BUILDINGS.map((b) => [b.id, g.level(b.id)]).filter(([, v]) => v)),
    rich: Object.fromEntries(Object.entries(h.rich).map(([k, v]) => [k, +v.toFixed(2)])),
    recentChronicle: S.chronicle.slice(0, 3).map((c) => c.text),
  };
}

// ---- HUD ------------------------------------------------------------
// icon: HUD glyphs are real pixel-art PNGs (Raven Fantasy Icons — see
// assets/icons/CREDITS.md), dropped in as <img> since the HUD is a DOM
// overlay, not canvas. cls lets callers ask for a size variant (e.g. 'sm').
const icon = (name, cls = '') => `<img class="ricon${cls ? ' ' + cls : ''}" src="/assets/icons/${name}.png" alt="">`;
const RES_ICON = {
  food: icon('food'), timber: icon('timber'), stone: icon('stone'), ore: icon('ore'),
  salt: icon('salt'), coin: icon('coin'), faith: icon('faith'),
};
// CAT_ICON: resource-key → icon name for the category-chips HUD (grouping
// resources under food/mats/ore/trade/money/pop/faith chips).
const CAT_ICON = { food: 'food', mats: 'mats', ore: 'ore', trade: 'trade', money: 'coin', pop: 'pop', faith: 'faith' };
// CATEGORIES: chip key → member resource keys. One data map drives the whole
// #resstrip — adding a resource to an existing category, or a new category,
// is a one-liner here (pop + faith are special-cased in updateHUD instead,
// since they aren't plain .res entries).
const CATEGORIES = {
  food:  ['food'],              // + future grain/fish/meat
  mats:  ['timber', 'stone'],
  ore:   ['ore'],                // + future coal/copper/iron/gold ("Metals")
  trade: ['salt'],               // strategic goods (+ future)
  money: ['coin'],
  // Reserved for later — leave as commented stubs so adding them is trivial:
  //   crafted:  ['steel','cloth'],
  //   luxuries: ['wine','amber','furs'],
  //   lore:     ['lore'],
};
function initHUD(away) {
  document.getElementById('hname').textContent = S.hold.name;
  document.getElementById('hsub').textContent =
    ` · ${S.hold.tierName} of ${S.hold.realm} · ${S.hold.ancestry} · ${S.hold.region}`;
  if (away && away.raids) pushChronicle(`While you were away, raiders came ${away.raids}×.`, 'raid');
  pushChronicle(`${S.hold.name} wakes to another day.`, 'note');
  S.ui.orders = makePanel({ region: 'tr', title: 'Works Bidden' });
  renderOrders();
  S.ui.speakers = makePanel({ region: 'l', title: S.mask.aspect || 'the Will' });
  renderWillPanel();
  updateHUD();
  initResTip();
  initChipToggle();
  initStewardAsk();
}

// resRow renders one member resource as an icon + current/max + net-rate —
// the same markup the old flat strip used (class="res" data-res="k"), so
// initResTip's hover breakdown keeps working unchanged on these rows. Coin
// has no cap (see capBreakdown) so it skips the "/max" — storage transparency
// applies to storable goods, not the ever-open coin chest.
function resRow(g, rate, k) {
  let net = rate[k]; if (k === 'food') net -= g.foodEatPerS();
  const cls = net > 0.01 ? 'up' : net < -0.01 ? 'down' : '';
  const cap = k === 'coin' ? '' : `<small class="cap">/${Math.floor(g.caps()[k])}</small>`;
  return `<span class="res" data-res="${k}"><b>${RES_ICON[k]}${Math.floor(g.res[k])}</b>${cap}<i class="${cls}">${net >= 0 ? '+' : ''}${net.toFixed(1)}</i></span>`;
}

// chip renders one collapsible category chip: a collapsed head (icon + the
// sum of its members, floored) and a hover/pin-revealed expand panel listing
// each member's own icon/count/rate.
function chip(cat, headHTML, expandHTML) {
  const pinned = S.ui.pinned.has(cat) ? ' pinned' : '';
  return `<div class="chip${pinned}" data-cat="${cat}">
    <div class="chip-head"><b>${headHTML}</b></div>
    <div class="chip-expand">${expandHTML}</div>
  </div>`;
}

function updateHUD() {
  const g = S.game, rate = g.rates();
  const catChips = Object.entries(CATEGORIES).map(([cat, members]) => {
    const total = members.reduce((a, m) => a + Math.floor(g.res[m]), 0);
    return chip(cat, `${icon(CAT_ICON[cat])}${total}`, members.map((m) => resRow(g, rate, m)).join(''));
  }).join('');

  // Pop: population as a resource. Expand folds in the Folk legend (per-role
  // counts, formerly its own bottom-right panel — retired so it doesn't
  // double-render) plus a derived defense footer (the old standalone defense
  // chip lives here now, since defense is a property of your folk, not a
  // tradeable good).
  const counts = {};
  for (const v of S.villagers) counts[v.role] = (counts[v.role] || 0) + 1;
  const folk = Object.entries(ROLE_LABEL).map(([r, label]) => {
    const hex = '#' + ROLE_PIP[r].toString(16).padStart(6, '0');
    return `<div class="lg"><span class="dot" style="background:${hex}"></span>${label}<b>${counts[r] || 0}</b></div>`;
  }).join('');
  // Housing: what raises the people cap (base hearth + tier, then longhouses),
  // so the folk cap is legible right under the Pop count.
  const hb = g.popCapBreakdown();
  const hbDetail = hb.contributors.map((c) => `${c.name} ×${c.count} +${c.add}`).join(' · ');
  const houseFoot = `<div class="chip-foot"><span>${icon('pop', 'sm')} housing cap</span><b>${hb.total}</b></div>`
    + `<div class="chip-cap">base ${hb.base}${hb.contributors.length ? ' · ' + hbDetail : ''} → ${hb.total}</div>`;
  const defFoot = `<div class="chip-foot"><span>${icon('defense', 'sm')} defense</span><b>${g.defense()}</b></div>`;
  const popChip = chip('pop', `${icon(CAT_ICON.pop)}${Math.floor(g.pop)}/${g.popCap()}`, folk + houseFoot + defFoot);

  // Faith: a meter toward the Will's next invocation, not a tradeable good —
  // its own chip (not under Pop) because the speaker COUNT that fills it is
  // shown here, while the speaker ROLE is separately listed under Pop; a
  // speaker is both a person and the source of faith.
  const faithLines = resourceBreakdown('faith');
  const faithRows = faithLines.map((l) =>
    `<div class="chip-row"><span>${l.label}</span><b class="${l.val >= 0 ? 'up' : 'down'}">${l.val >= 0 ? '+' : ''}${l.val.toFixed(1)}</b></div>`
  ).join('');
  const faithFoot = `<div class="chip-foot"><span>threshold</span><b>${Math.floor(g.faith)}/${g.faithThreshold()}</b></div>`;
  const faithChip = chip('faith', `${icon(CAT_ICON.faith)}${Math.floor(g.faith)}/${g.faithThreshold()}`, faithRows + faithFoot);

  document.getElementById('resstrip').innerHTML = catChips + popChip + faithChip;
}

// initChipToggle: clicking a chip's collapsed head pins it open (toggle);
// hover-preview (CSS-only, see .chip:hover in town.css) keeps working
// regardless of pin state. #resstrip's innerHTML is fully rebuilt every
// tick, so pinned state lives in S.ui.pinned, not on the DOM nodes.
function initChipToggle() {
  const bar = document.getElementById('resstrip');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const head = e.target.closest && e.target.closest('.chip-head');
    if (!head) return;
    const cat = head.closest('.chip').dataset.cat;
    if (S.ui.pinned.has(cat)) S.ui.pinned.delete(cat); else S.ui.pinned.add(cat);
    updateHUD();
  });
}

// resourceBreakdown lists what each work adds/eats for one resource per second.
function resourceBreakdown(k) {
  const g = S.game, eff = g.efficiency(), lines = [];
  if (k === 'faith') {
    // Faith has one source: the hold's speakers (one base, +1/reliquary).
    const n = g.speakers();
    lines.push({ label: `${n} speaker${n === 1 ? '' : 's'} → faith`, val: n * CFG.faithPerSpeaker });
    return lines;
  }
  for (const b of BUILDINGS) {
    if (b.kind !== 'prod' || b.res !== k) continue;
    const lv = g.level(b.id); if (!lv) continue;
    const out = b.base * lv * (0.35 + 0.65 * g.richOf(b)) * eff * g.bon.mul[k];
    if (out > 0.001) lines.push({ label: `${BUILD_NAME[b.id] || b.id} ×${lv}`, val: out });
  }
  if (k === 'food') { const eat = g.foodEatPerS(); if (eat > 0.001) lines.push({ label: `${Math.floor(g.pop)} folk eat`, val: -eat }); }
  return lines;
}

// storeTip renders a resource's storage line(s) for #restip: current/max,
// plus which storage building(s) contribute to that max and how much — the
// same capBreakdown() that backs caps(), so these numbers can't disagree.
// Coin has no cap; a resource with no storage contributors yet just reads
// "base N → N" (capBreakdown returns an empty contributors list for it).
function storeTip(k) {
  const g = S.game;
  if (k === 'coin') return `<div class="bl cap"><span>stores</span><b>uncapped</b></div>`;
  const { base, contributors, total } = g.capBreakdown(k);
  const parts = contributors.map((c) => `${c.name} ×${c.count} +${Math.round(c.add)}`);
  const breakdown = [`base ${Math.round(base)}`, ...parts].join(' · ') + ` → ${Math.round(total)}`;
  return `<div class="bl cap"><span>stores</span><b>${Math.floor(g.res[k])} / ${Math.round(total)}</b></div>`
       + `<div class="dim cap-detail">${breakdown}</div>`;
}

// initResTip shows an income/consumption breakdown, plus a storage-capacity
// breakdown, when a resource is hovered.
function initResTip() {
  const bar = document.getElementById('resstrip'), tip = document.getElementById('restip');
  if (!bar || !tip) return;
  bar.addEventListener('mousemove', (e) => {
    const el = e.target.closest && e.target.closest('.res');
    if (!el || !el.dataset.res) { tip.style.display = 'none'; return; }
    const k = el.dataset.res, lines = resourceBreakdown(k);
    const net = lines.reduce((a, l) => a + l.val, 0);
    const rows = lines.length
      ? lines.map((l) => `<div class="bl"><span>${l.label}</span><b class="${l.val >= 0 ? 'up' : 'down'}">${l.val >= 0 ? '+' : ''}${l.val.toFixed(2)}</b></div>`).join('')
      : '<div class="dim">no works yet</div>';
    // Faith's footer shows progress toward the invocation threshold instead
    // of a net rate — that's the number that actually matters here. Faith
    // also has no store (not a res[] entry), so it skips the storage line.
    const footer = k === 'faith'
      ? `<div class="bl net"><span>threshold</span><b>${Math.floor(S.game.faith)} / ${S.game.faithThreshold()}</b></div>`
      : `<div class="bl net"><span>net</span><b class="${net >= 0 ? 'up' : 'down'}">${net >= 0 ? '+' : ''}${net.toFixed(2)}/s</b></div>`;
    const storage = k === 'faith' ? '' : storeTip(k);
    tip.innerHTML = `<div class="ttl">${RES_ICON[k]} ${k}</div>${rows}${footer}${storage}`;
    tip.style.display = 'block'; tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px';
  });
  bar.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

// ---- order log --------------------------------------------------------
// (the Folk legend used to be its own bottom-right panel here; it's now
// rendered inline inside the Pop chip's expand — see updateHUD.)

function orderText(o) {
  if (o.type === 'build') return `build ${o.target}${o.qty > 1 ? ' ×' + o.qty : ''}`;
  if (o.type === 'expand') return 'expand a field';
  if (o.type === 'wall') return o.from && o.to ? `raise a wall${o.gate ? ' + gate' : ''}` : 'open a gate';
  if (o.type === 'trade') return `${o.action} ${o.qty || ''} ${o.resource}`.replace(/\s+/g, ' ').trim();
  if (o.type === 'focus') return `focus ${o.value || o.target}`;
  return o.type;
}
const orderIcon = (o) => o.type === 'build' ? '🔨' : o.type === 'wall' ? '🧱' : o.type === 'expand' ? '🌱' : o.type === 'trade' ? (o.action === 'sell' ? '💰' : '🛒') : '🎯';

function orderEntryHTML(o) {
  const t = `${orderIcon(o)} ${orderText(o)}`;
  const tip = (o.reason || '').replace(/"/g, '');
  if (o.status === 'done') return `<div class="ord done" title="${tip}">✓ ${t}</div>`;
  if (o.status === 'skipped') return `<div class="ord skipped" title="${tip}">✕ ${t} <small>(couldn’t)</small></div>`;
  if (o.status === 'active') {
    const pct = Math.min(100, Math.round(o.progress * 100));
    const left = o.qtyLeft > 1 ? ` <small>(${o.qtyLeft} left)</small>` : '';
    return `<div class="ord active" title="${tip}">${t}${left}<div class="pbar"><i style="width:${pct}%"></i></div></div>`;
  }
  return `<div class="ord pending" title="${tip}">· ${t}</div>`;
}

function renderOrders() {
  if (!S.ui.orders) return;
  const rows = S.orderLog.length
    ? S.orderLog.slice(-8).map(orderEntryHTML).join('')
    : '<div class="dim">— the folk work freely —</div>';
  S.ui.orders.set(rows);
}

// renderWillPanel draws the whole left column as ONE divine surface: the panel
// is titled by the aspect (the Salt/Current/Deep…), shows the Will's utterance,
// a COMPACT row per speaker (name · directive + order chips — the chips carry
// the interpretation, so no separate gloss line), then a slim log of town
// events. Utterance + speaker words live ONLY here now (not echoed elsewhere).
function renderWillPanel() {
  if (!S.ui.speakers) return;
  S.ui.speakers.setTitle(S.mask.aspect || 'the Will');
  const lw = S.lastWill;
  const utt = lw && lw.utterance
    ? `<div class="sp-utt">${icon('faith', 'sm')} ${lw.utterance}</div>` : '';
  const speakers = (lw && lw.speakers && lw.speakers.length)
    ? lw.speakers.map((sp) => `
      <div class="sp-block">
        <div class="sp-head"><span class="sp-name">${sp.name || 'a speaker'}</span> <span class="sp-directive">· “${sp.directive || ''}”</span></div>
        <div class="sp-orders">${sp.orders.length
          ? sp.orders.map((o) => `<span class="ordchip">${orderIcon(o)} ${orderText(o)}</span>`).join('')
          : '<span class="dim">no work bidden</span>'}</div>
      </div>`).join('')
    : '<div class="dim">The speakers await a word.</div>';
  const events = (S.chronicle || []).slice(0, 4).map((c) => `<div class="cl ${c.kind}">${c.text}</div>`).join('');
  const log = events ? `<div class="will-log">${events}</div>` : '';
  const status = S.willStatus ? `<div class="will-status">${S.willStatus}</div>` : '';
  S.ui.speakers.set(utt + speakers + log + status);
}

function pushChronicle(text, kind) {
  S.chronicle.unshift({ text, kind });
  if (S.chronicle.length > 30) S.chronicle.pop();
  renderWillPanel();   // the event log lives inside the unified Will panel now
}
function setStewardLine(t) { S.willStatus = t; renderWillPanel(); }

// ---- input ----------------------------------------------------------
function wireKeys() {
  addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return; // let the Steward-ask input type freely
    const k = e.key.toLowerCase();
    if (k === 'p') showStewardAsk();
    else if (k === 'h') { S.hudOn = !S.hudOn; document.getElementById('hud').style.display = S.hudOn ? '' : 'none'; }
    else if (k === 'm') location.href = '/index.html';
    else if (k === '=' || k === '+') setZoom(S.scale + 1);
    else if (k === '-' || k === '_') setZoom(S.scale - 1);
    else if (k === 'r') {
      // Navigate with ?reset=1 so the wipe happens at boot, BEFORE the game
      // (and its autosave) exists — reset+reload had a race where the 1s
      // autosave re-wrote the save before the reload took hold.
      if (confirm('Reset the world? Every hold starts over.')) {
        const p = new URLSearchParams(location.search); p.set('reset', '1');
        location.search = '?' + p.toString();
      }
    }
  });
}

boot().catch((e) => {
  document.getElementById('stage').innerHTML =
    `<pre style="color:#e5736b;padding:20px">town failed to boot:\n${e && e.stack || e}</pre>`;
  console.error(e);
});
