// town.js — the living town. PixiJS renders a ¾ top-down cozy pixel hold
// that grows from the deterministic economy (window.XANGAME) whose seed is
// one settlement from the world-sim (window.XAN). It runs itself: a local
// heuristic steward keeps building, and every few minutes (or on `p`) the
// Claude Steward at /steward returns strategic orders + an in-world
// chronicle. Nothing here writes back to the sim.
import { Application, Container, Sprite, AnimatedSprite, Texture, Graphics } from 'pixi.js';
import { loadAtlas, TILE } from './atlas.js';
import { makePanel } from './ui.js';

const { allHolds } = window.XAN;
const { Game, BUILDINGS, CFG } = window.XANGAME;

// ---- config ---------------------------------------------------------
const PLOT = 4;                 // a building plot is 4x4 tiles (roomy — no crowding)
const TOWN_W = 96, TOWN_H = 72; // a big wilderness map the camera drifts across
const PLOTS_X = Math.floor(TOWN_W / PLOT), PLOTS_Y = Math.floor(TOWN_H / PLOT);
const DAY_MS = 240000;          // a full day/night in real ms
const STEWARD_MS = Number(localStorage.getItem('xh_stewardMs') || 480000); // ambient decree cadence (8 min)
const LOCAL_MS = 6000;          // heuristic steward cadence
const MAX_PER_TYPE = 8;         // how many of one building we draw
const ROLE_TINT = {
  villager: 0xffffff, farmer: 0xcfe8a0, woodcutter: 0xbfe0b8,
  miner: 0xcfcfe0, soldier: 0x9fb8ea, trader: 0xffdf9a,
};
// A saturated pip above the head — the readable role signal (a multiply
// tint on a brown sprite can't say "blue soldier" clearly; a pip can).
const ROLE_PIP = {
  villager: 0xe6dcc4, farmer: 0x74c53a, woodcutter: 0x2f8f4e,
  miner: 0xc9ced6, soldier: 0x4f86e0, trader: 0xf2c14e,
};
const ROLE_LABEL = { villager: 'Villager', farmer: 'Farmer', woodcutter: 'Woodcutter', miner: 'Miner', soldier: 'Soldier', trader: 'Trader' };
// Seconds of work a single unit of each order takes — so decrees are
// carried out over time (a build you can watch), not the instant they land.
const WORK_S = { build: 5, trade: 2.5, focus: 1, expand: 5 };

// ---- state ----------------------------------------------------------
const S = {
  hold: null, game: null, atlas: null,
  placed: new Map(),   // typeKey -> {container}
  villagers: [], plots: [], usedPlots: new Set(),
  orderLog: [], focus: null, chronicle: [],
  stewardBusy: false, lastRaidTally: 0, alarm: 0,
  hudOn: true, ui: {},
  cam: { x: TOWN_W / 2, y: TOWN_H / 2 }, camAuto: true, lastInput: 0,
  hittable: [], // building bounds for hover-identify
  palisadeSprites: [], palisadeSig: null,
  oreNodes: [], woodNodes: [], // resource nodes the folk walk out to work
};
const heldKeys = new Set(); // WASD currently pressed
const BUILD_NAME = {
  farm: 'Farm', wharf: 'Fishing Wharf', sawmill: 'Sawmill', quarry: 'Quarry',
  mine: 'Mine', saltern: 'Saltern', market: 'Market', longhouse: 'Longhouse', granary: 'Storehouse',
};

let app, world, ground, entities, night, alarmFx;

// deterministic RNG so a hold always lays out the same.
function rng(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

// ---- boot -----------------------------------------------------------
const mark = (m) => { const e = document.getElementById('stewardline'); if (e) e.textContent = 'boot: ' + m; };
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
  setInterval(() => callSteward('the turning of the season'), STEWARD_MS);
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
  // A wood node remembers its tree sprites so a woodcutter can fell them.
  const regWood = (tx, ty, sprites) => { if (nearTown(tx, ty)) S.woodNodes.push({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE, sprites }); };
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
  const house = HOUSE_OF[type] || 'cottageRed';
  return { recipe: RECIPES[house], prop: PROP[type] ?? null };
}

function nextFreePlot() {
  for (const p of S.plots) {
    const key = `${p.px},${p.py}`;
    if (!S.usedPlots.has(key)) { S.usedPlots.add(key); return p; }
  }
  return null;
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
    if (lv > 0) d[b.id] = Math.min(MAX_PER_TYPE, Math.max(1, Math.round(lv / (b.kind === 'prod' ? 1.5 : 1))));
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
      const plot = nextFreePlot();
      if (!plot) return;
      const { recipe, prop } = recipeFor(type);
      const c = makeBuildingContainer(recipe, prop);
      c.x = plot.tx * TILE + Math.floor((PLOT - recipe.w) / 2) * TILE;
      c.y = (plot.ty + PLOT - recipe.h) * TILE;
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
  updatePalisade();
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
    const plot = ex ? ex.plot : nextFreePlot();
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
  // Anchored in the world-sim: WHICH ores the ground yields and HOW big the
  // field is follow the hold's real ore/stone richness (from its neighborhood
  // scan). Every hold has a stone outcrop; richer rock adds coal→copper→iron→gold.
  const oreR = S.hold.rich.ore, stoneR = S.hold.rich.stone;
  const [stone, coal, copper, iron, gold] = S.atlas.oreTex;
  const pool = [stone];
  if (oreR >= 0.15) pool.push(coal, copper);
  if (oreR >= 0.35) pool.push(iron);
  if (oreR >= 0.60) pool.push(gold);
  const count = 5 + Math.round((oreR + stoneR) * 8); // richer rock → a bigger field
  // a bare-earth patch under the field for a quarry look
  for (let dy = -3; dy <= 3; dy++) for (let dx = -4; dx <= 4; dx++) {
    if (r() < 0.55) { const t = new Sprite(S.atlas.ground.dirt[0]); t.x = (fx + dx) * TILE; t.y = (fy + dy) * TILE; ground.addChild(t); }
  }
  const addNode = (tex, gx, gy) => {
    const s = new Sprite(tex); s.anchor.set(0.5, 1);
    s.x = gx * TILE + TILE / 2; s.y = gy * TILE + TILE; s.zIndex = s.y;
    entities.addChild(s); S.oreNodes.push({ x: s.x, y: s.y, sprite: s });
  };
  addNode(S.atlas.boulderTex, fx, fy); // a boulder centerpiece
  const used = new Set([`${fx},${fy}`]);
  for (let i = 0; i < count; i++) {
    let gx, gy, key, t = 0;
    do { gx = fx + Math.round((r() - 0.5) * 7); gy = fy + Math.round((r() - 0.5) * 5); key = `${gx},${gy}`; } while (used.has(key) && ++t < 12);
    used.add(key);
    addNode(pool[(r() * pool.length) | 0], gx, gy);
  }
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

// updatePalisade fences the BUILT settlement (the bounding box of its plots
// with a 1-tile margin) — not the whole map — and redraws it larger as the
// town expands, so the wall reflects the town's actual footprint.
function updatePalisade() {
  if (!S.game.level('palisade')) return;
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const key of S.usedPlots) {
    const [px, py] = key.split(',').map(Number);
    minX = Math.min(minX, px * PLOT); minY = Math.min(minY, py * PLOT);
    maxX = Math.max(maxX, (px + 1) * PLOT - 1); maxY = Math.max(maxY, (py + 1) * PLOT - 1);
  }
  if (minX > maxX) return;
  const x0 = Math.max(0, minX - 1), y0 = Math.max(0, minY - 1);
  const x1 = Math.min(TOWN_W - 1, maxX + 1), y1 = Math.min(TOWN_H - 1, maxY + 1);
  const sig = `${x0},${y0},${x1},${y1}`;
  if (sig === S.palisadeSig) return;         // footprint unchanged — keep the wall
  S.palisadeSig = sig;
  for (const s of S.palisadeSprites) { entities.removeChild(s); s.destroy(); }
  S.palisadeSprites = [];
  const f = S.atlas.fence;
  const add = (tex, tx, ty) => {
    const s = new Sprite(tex); s.x = tx * TILE; s.y = ty * TILE; s.zIndex = s.y + TILE;
    entities.addChild(s); S.palisadeSprites.push(s);
  };
  for (let tx = x0; tx <= x1; tx++) { add(f.h, tx, y0); add(f.h, tx, y1); }
  for (let ty = y0 + 1; ty < y1; ty++) { add(f.v, x0, ty); add(f.v, x1, ty); }
  add(f.tl, x0, y0); add(f.tr, x1, y0);      // corner posts
}

// ---- villagers ------------------------------------------------------
function roleWeights() {
  const g = S.game, w = { villager: 1 };
  w.farmer = g.level('farm') + g.level('wharf');
  w.woodcutter = g.level('sawmill');
  w.miner = g.level('mine') + g.level('quarry');
  w.trader = g.level('market');
  w.soldier = g.defense() * 2 + (isRaided() ? 3 : 0);
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
  const start = randomTownPoint();
  v.x = start.x; v.y = start.y; v.zIndex = v.y;
  pickTarget(v);
  entities.addChild(v);
  S.villagers.push(v);
}

function despawnVillager() {
  const v = S.villagers.pop();
  if (v) { entities.removeChild(v); v.destroy({ children: true }); }
}

function randomTownPoint() {
  // Wander among built plots, but never stand on the keep's doorway.
  const used = [...S.usedPlots].filter((k) => k !== S.keepKey).map((k) => k.split(',').map(Number));
  const p = used.length ? used[(Math.random() * used.length) | 0] : [S.plots[1].px, S.plots[1].py];
  return { x: (p[0] * PLOT + 1 + Math.random() * 2) * TILE, y: (p[1] * PLOT + 1 + Math.random() * 2) * TILE };
}

function pickTarget(v) {
  if (v.role === 'soldier' && isRaided()) {
    // rush the settlement's wall (near the town centre), not the far map edge
    const a = Math.random() * Math.PI * 2;
    v.tx = (TOWN_W / 2 + Math.cos(a) * 13) * TILE;
    v.ty = (TOWN_H / 2 + Math.sin(a) * 11) * TILE;
    v.moving = true; return;
  }
  // Miners and woodcutters make work trips: out to a node, then home again.
  const nodeType = v.role === 'miner' ? 'ore' : v.role === 'woodcutter' ? 'wood' : null;
  if (nodeType) {
    if (v.headingHome) {
      const t = randomTownPoint(); v.tx = t.x; v.ty = t.y; v.headingHome = false; v.targetNode = null;
    } else {
      const node = nearestNode(v.x, v.y, nodeType);
      if (node) { v.tx = node.x; v.ty = node.y; v.targetNode = node; }
      else { const t = randomTownPoint(); v.tx = t.x; v.ty = t.y; }
    }
    v.moving = true; return;
  }
  const t = randomTownPoint(); v.tx = t.x; v.ty = t.y; v.moving = true;
}

function nearestNode(px, py, type) {
  const list = type === 'ore' ? S.oreNodes : S.woodNodes;
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

// nearestSawmill returns the pixel centre of the closest sawmill, or null.
function nearestSawmill(px, py) {
  let best = null, bd = Infinity;
  for (const h of S.hittable) {
    if (h.type !== 'sawmill') continue;
    const cx = ((h.x0 + h.x1) / 2) * TILE, cy = ((h.y0 + h.y1) / 2) * TILE;
    const d = (cx - px) ** 2 + (cy - py) ** 2;
    if (d < bd) { bd = d; best = { x: cx, y: cy }; }
  }
  return best;
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

// startHaul gives a woodcutter a log to carry back to the nearest sawmill.
function startHaul(v) {
  const log = new Sprite(S.atlas.tex(106)); // Kenney log tile
  log.anchor.set(0.5, 1); log.scale.set(0.7); log.x = 3; log.y = -19;
  v.addChild(log); v.logSprite = log; v.hauling = true;
  const mill = nearestSawmill(v.x, v.y);
  const t = mill || randomTownPoint();
  v.tx = t.x; v.ty = t.y; v.targetNode = null; v.headingHome = false; v.moving = true;
}

function deliverLog(v) {
  if (v.logSprite) { v.removeChild(v.logSprite); v.logSprite.destroy(); v.logSprite = null; }
  v.hauling = false;
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
      if (v.chopping) { v.chopping = false; fellTree(v.chopNode); v.chopNode = null; startHaul(v); return; }
      pickTarget(v);
    }
    return;
  }
  if (!v.anim.playing) v.anim.play();
  const dx = v.tx - v.x, dy = v.ty - v.y;
  const dist = Math.hypot(dx, dy);
  const worker = v.role === 'miner' || v.role === 'woodcutter';
  const speed = (v.role === 'soldier' && isRaided() ? 34 : worker ? 24 : 18) * dt;
  if (dist < speed) {
    v.x = v.tx; v.y = v.ty; v.moving = false; v.anim.gotoAndStop(0); v.zIndex = v.y;
    if (v.targetNode && v.role === 'woodcutter') {  // reached a tree — chop it down, then haul
      v.chopping = true; v.chopNode = v.targetNode; v.targetNode = null;
      v.idle = 2.5 + Math.random() * 2;
      workEffect(v.chopNode);
    } else if (v.targetNode) {          // miner at an ore vein — toil a while, sparks flying
      v.headingHome = true; v.idle = 3 + Math.random() * 3;
      workEffect(v.targetNode); v.targetNode = null;
    } else {                           // arrived home / at the mill
      if (v.hauling) deliverLog(v);
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
// hoverIdentify shows a small label for the building under the cursor.
function hoverIdentify(e) {
  const tip = document.getElementById('btip');
  if (!tip) return;
  const h = buildingAt(e.clientX, e.clientY);
  if (!h) { tip.style.display = 'none'; return; }
  let text = h.label || BUILD_NAME[h.type] || h.type;
  if (h.type) { const lv = S.game.level(h.type); if (lv) text += ' · lvl ' + lv; }
  tip.textContent = text;
  tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px';
  tip.style.display = 'block';
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
  el.addEventListener('pointerleave', () => { const t = document.getElementById('btip'); if (t) t.style.display = 'none'; });
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
  renderLegend();
  updateHUD();
}

function reconcileVillagers() {
  const want = Math.min(70, Math.max(3, Math.floor(S.game.pop)));
  while (S.villagers.length < want) spawnVillager();
  while (S.villagers.length > want) despawnVillager();
}

// pushOrder appends a decree to the log as pending work.
function pushOrder(o) {
  S.orderLog.push({
    type: o.type, target: o.target, action: o.action, resource: o.resource,
    value: o.value, qty: o.qty || 1, reason: o.reason,
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

// localSteward: the town's own hands. When no orders are queued it picks a
// sensible next build so the hold keeps growing even with no Claude.
function localSteward() {
  if (S.orderLog.some((o) => o.status === 'pending' || o.status === 'active')) return;
  const g = S.game, h = S.hold;
  // Sometimes grow an existing field rather than raise a new farm, so both the
  // expand and build paths show up on their own (the Will steers this later).
  const wantFood = S.focus === 'food' || g.res.food < g.caps().food * 0.35;
  if (wantFood && (g.farmPlots || []).some((p) => p.size < 3) && Math.random() < 0.5) {
    pushOrder({ type: 'expand', target: 'farm', qty: 1 }); return;
  }
  const want = [];
  if (g.pop >= g.popCap() - 0.5) want.push('longhouse');
  if (isRaided() && g.defense() < 3) want.push('palisade');
  if (!g.tradeUnlocked()) want.push('market');
  if (g.res.food >= g.caps().food * 0.92) want.push('granary');
  if (S.focus === 'defense') want.push('palisade');
  if (S.focus === 'food') want.push('farm');
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

// callSteward: ask Claude for orders + a chronicle line. Soft-fails to the
// local steward if the server/Claude is unavailable.
async function callSteward(occasion, instruction) {
  if (S.stewardBusy) return;
  S.stewardBusy = true;
  setStewardLine(instruction ? 'The Steward weighs your word…' : 'The Steward deliberates…');
  try {
    const res = await fetch('/steward', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stewardState(occasion, instruction)),
    });
    const d = await res.json();
    if (d.chronicle) pushChronicle('“' + d.chronicle + '”', 'steward');
    if (Array.isArray(d.orders) && d.orders.length) {
      d.orders.map(normalizeOrder).forEach(pushOrder);
      setStewardLine(`The Steward decrees ${d.orders.length} order${d.orders.length > 1 ? 's' : ''}.`);
      renderOrders();
    } else setStewardLine('The Steward keeps its counsel.');
  } catch (e) {
    setStewardLine('(no Steward — the folk act on their own)');
  } finally {
    setTimeout(() => S.stewardBusy = false, 500);
  }
}

function normalizeOrder(o) {
  return { type: o.type, target: o.target, action: o.action, resource: o.resource, value: o.value || o.target, qty: o.qty || 1 };
}

// The Steward-ask box: P opens it so you can instruct the Steward in your own
// words, or just press Enter for a free-hand (regular) decree.
function showStewardAsk() {
  const box = document.getElementById('stewardask'), input = document.getElementById('stewardinput');
  if (!box || !input) { callSteward('the steward is summoned'); return; }
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
      callSteward(v ? 'the lord instructs the Steward' : 'the steward is summoned', v || null);
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
const RES_ICON = { food: '🌾', timber: '🪵', stone: '🪨', ore: '⛏️', salt: '🧂', coin: '🪙' };
function initHUD(away) {
  document.getElementById('hname').textContent = S.hold.name;
  document.getElementById('hsub').textContent =
    ` · ${S.hold.tierName} of ${S.hold.realm} · ${S.hold.ancestry} · ${S.hold.region}`;
  if (away && away.raids) pushChronicle(`While you were away, raiders came ${away.raids}×.`, 'raid');
  pushChronicle(`${S.hold.name} wakes to another day.`, 'note');
  S.ui.orders = makePanel({ region: 'tr', title: 'Steward’s Log' });
  S.ui.legend = makePanel({ region: 'br', title: 'Folk' });
  renderLegend();
  renderOrders();
  updateHUD();
  initResTip();
  initStewardAsk();
}

function updateHUD() {
  const g = S.game, rate = g.rates();
  const strip = window.XAN.RESOURCES.map((k) => {
    let net = rate[k]; if (k === 'food') net -= g.foodEatPerS();
    const cls = net > 0.01 ? 'up' : net < -0.01 ? 'down' : '';
    return `<span class="res" data-res="${k}"><b>${RES_ICON[k]}${Math.floor(g.res[k])}</b><i class="${cls}">${net >= 0 ? '+' : ''}${net.toFixed(1)}</i></span>`;
  }).join('');
  document.getElementById('resstrip').innerHTML =
    strip + `<span class="res"><b>👥${Math.floor(g.pop)}/${g.popCap()}</b></span><span class="res"><b>🛡️${g.defense()}</b></span>`;
}

// resourceBreakdown lists what each work adds/eats for one resource per second.
function resourceBreakdown(k) {
  const g = S.game, eff = g.efficiency(), lines = [];
  for (const b of BUILDINGS) {
    if (b.kind !== 'prod' || b.res !== k) continue;
    const lv = g.level(b.id); if (!lv) continue;
    const out = b.base * lv * (0.35 + 0.65 * g.richOf(b)) * eff * g.bon.mul[k];
    if (out > 0.001) lines.push({ label: `${BUILD_NAME[b.id] || b.id} ×${lv}`, val: out });
  }
  if (k === 'food') { const eat = g.foodEatPerS(); if (eat > 0.001) lines.push({ label: `${Math.floor(g.pop)} folk eat`, val: -eat }); }
  return lines;
}

// initResTip shows an income/consumption breakdown when a resource is hovered.
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
    tip.innerHTML = `<div class="ttl">${RES_ICON[k]} ${k}</div>${rows}<div class="bl net"><span>net</span><b class="${net >= 0 ? 'up' : 'down'}">${net >= 0 ? '+' : ''}${net.toFixed(2)}/s</b></div>`;
    tip.style.display = 'block'; tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px';
  });
  bar.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

// ---- legend + order log --------------------------------------------
function renderLegend() {
  if (!S.ui.legend) return;
  const counts = {};
  for (const v of S.villagers) counts[v.role] = (counts[v.role] || 0) + 1;
  S.ui.legend.set(Object.entries(ROLE_LABEL).map(([r, label]) => {
    const hex = '#' + ROLE_PIP[r].toString(16).padStart(6, '0');
    return `<div class="lg"><span class="dot" style="background:${hex}"></span>${label}<b>${counts[r] || 0}</b></div>`;
  }).join(''));
}

function orderText(o) {
  if (o.type === 'build') return `build ${o.target}${o.qty > 1 ? ' ×' + o.qty : ''}`;
  if (o.type === 'expand') return 'expand a field';
  if (o.type === 'trade') return `${o.action} ${o.qty || ''} ${o.resource}`.replace(/\s+/g, ' ').trim();
  if (o.type === 'focus') return `focus ${o.value || o.target}`;
  return o.type;
}
const orderIcon = (o) => o.type === 'build' ? '🔨' : o.type === 'expand' ? '🌱' : o.type === 'trade' ? (o.action === 'sell' ? '💰' : '🛒') : '🎯';

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

function pushChronicle(text, kind) {
  S.chronicle.unshift({ text, kind });
  if (S.chronicle.length > 30) S.chronicle.pop();
  const el = document.getElementById('chronicle');
  el.innerHTML = S.chronicle.slice(0, 6).map((c) => `<div class="cl ${c.kind}">${c.text}</div>`).join('');
}
function setStewardLine(t) { document.getElementById('stewardline').textContent = t; }

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
