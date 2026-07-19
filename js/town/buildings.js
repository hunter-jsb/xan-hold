// buildings.js — placement + reconciliation: recipes/containers, the core &
// outer districts + siting geometry, plot allocation, reconcileBuildings, and
// the farmland district's autotiled render.
import { Sprite, Container, AnimatedSprite, Graphics } from 'pixi.js';
import { TILE } from './atlas.js';
import { S } from './state.js';
import { PLOT, PLOTS_X, PLOTS_Y, CENTER_TX, CENTER_TY, CENTER_PX, CENTER_PY, MAX_PER_TYPE, SITE_ALPHA } from './constants.js';
import { pxToTile } from './coords.js';
import { constructionPoof, riseIn, fadeIn, nextWharfSite, nearestNode } from './terrain.js';
import { renderWalls, applyWallJob, saveWalls, WALL_TINT } from './walls.js';

const { BUILDINGS, BY_ID, CROP_BY_ID } = window.XANGAME;

// ---- buildings ------------------------------------------------------
export function makeBuildingContainer(recipe, propIdx) {
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

export function recipeFor(type) {
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
export const CORE_TYPES = new Set(['longhouse', 'granary', 'reliquary', 'market', 'barracks', 'scholarshall']);
const OUTER_TYPES = new Set(['farm', 'wharf', 'mine', 'sawmill', 'quarry', 'saltern']);
const CORE_R0 = 2, CORE_GROW_EVERY = 3, CORE_R_MAX = 6; // plot-units (×PLOT tiles) — see coreRadius

// coreRadius — the core zone's radius in plot-units from town centre,
// growing as CORE_TYPES buildings actually go up (so the walls in
// planDefensiveSegment have room to enclose them as the town grows), but
// never past maxSafeCoreRadius — THIS hold's actual clearance to its ore
// field/shoreline (see placeOreNodes/placeWater), not a fixed guess. That
// keeps the wall from ever being drawn across the vein field or the shore,
// whatever CORE_R_MAX allows for a hold with more open ground.
export function coreRadius() {
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
export function maxSafeCoreRadius() {
  const ccx = CENTER_PX, ccy = CENTER_PY;
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
export function plotInCore(px, py) {
  const ccx = CENTER_PX, ccy = CENTER_PY;
  return Math.max(Math.abs(px - ccx), Math.abs(py - ccy)) <= coreRadius();
}

// insideCore/isInsideWalls — tile-space test for "protected inside the
// walls". MVP: plotInCore's square zone (coreRadius, in plot-units) rather
// than a true flood-fill enclosure — cheap, robust, and it's exactly what
// planDefensiveSegment's wall box actually encloses (modulo its own +2 tile
// clearance margin).
export function insideCore(tx, ty) { return plotInCore(tx / PLOT, ty / PLOT); }
export function isInsideWalls(tx, ty) { return insideCore(tx, ty); }

// districtOf — which district a hovered building sits in (for the hover
// border): the walled core (dwellings/stores/command + the keep, which has no
// type), the farmland, or the scattered outlands works. null = uncategorized.
export function districtOf(h) {
  if (!h) return null;
  if (h.type === 'farm') return 'farmland';
  if (!h.type || h.type === 'keep' || CORE_TYPES.has(h.type)) return 'core';
  if (OUTER_TYPES.has(h.type)) return 'works';
  return null;
}

// coreBounds — the core district's tile bounding box: the zone plotInCore
// encloses (what the walls trace). null before any plot exists.
export function coreBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of S.plots) {
    if (!plotInCore(p.px, p.py)) continue;
    x0 = Math.min(x0, p.tx); y0 = Math.min(y0, p.ty);
    x1 = Math.max(x1, p.tx + PLOT); y1 = Math.max(y1, p.ty + PLOT);
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

// nextCorePlot sites a CORE building (dwellings/stores/faith/command)
// inside the walled core zone, nearest the centre first (S.plots is already
// distance-sorted) — never on an ore/water-reserved cell.
export function nextCorePlot() {
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
export function nextOuterPlot(biasX, biasY) {
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
export function outerBias(type) {
  if (type === 'sawmill') {
    const n = nearestNode(CENTER_TX * TILE, CENTER_TY * TILE, 'wood');
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
export function farmlandAnchor() {
  if (S.farmAnchor) return S.farmAnchor;
  const r = Math.random; // NOT seeded — the farmland lands somewhere new each run, not the same spot every time
  const ccx = CENTER_PX, ccy = CENTER_PY;
  const baseR = coreRadius() + 1; // hug just outside the core (near the folk), not flung out
  let best = null, bestScore = -1;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + r() * 0.5;
    const dist = baseR + r() * 2;
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
export function nextFarmPlot() {
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
export function wantsNewFarmField() {
  const fields = S.game.farmPlots || [];
  return !fields.length || fields.every((p) => p.size >= 3);
}

// farmFieldAvailable — true if a new farm field still makes sense: below the
// same per-type cap mine (mineNodeAvailable) and wharf (wharfSiteAvailable)
// already respect. Unlike a vein or a shoreline, open plots never run out on
// their own, so without this cap a food-rich hold just keeps chasing its own
// richness lean and sprawling fresh fields forever.
export function farmFieldAvailable() {
  return (S.game.farmPlots || []).length < MAX_PER_TYPE;
}

// nextMineNode claims the next available ore vein for a new Deep Mine,
// clearing its vein sprite (the mine now stands there, in the wilds, not the
// town grid) and nudging off any miner already headed to or working that
// exact vein. Returns null once every vein in the field already has a mine.
export function nextMineNode() {
  const node = S.oreNodes.find((n) => !n.claimedByMine);
  if (!node) return null;
  node.claimedByMine = true;
  if (node.sprite) { S.entities.removeChild(node.sprite); node.sprite.destroy(); node.sprite = null; }
  for (const v of S.villagers) {
    if (v.targetNode === node) { v.targetNode = null; v.moving = false; v.idle = 0; } // re-picks next step (like the workNode case)
    else if (v.workNode === node) { v.working = false; v.workNode = null; v.idle = 0; }
  }
  return node;
}

// mineNodeAvailable — true if a `build mine` order is satisfiable: an
// unclaimed ore vein for a NEW mine, else an existing shaft that can be
// deepened (a per-instance upgrade). False = no vein and nothing to deepen.
export function mineNodeAvailable() {
  if (S.oreNodes.some((n) => !n.claimedByMine)) return true;
  return S.game.canDeepen('mine');
}

// keepRecipe composes the keep at a given level: a battlemented gatehouse that
// grows TALLER each level (extra wall courses between battlements and gate), so
// upgrading physically expands the stronghold. Level 1 is byte-identical to the
// old fixed keep, so existing holds see no change until the keep is raised.
export function keepRecipe(level) {
  const courses = Math.max(0, level - 1);
  const tiles = [{ i: 96, x: 0, y: 0 }, { i: 97, x: 1, y: 0 }, { i: 98, x: 2, y: 0 }]; // battlements
  let y = 1;
  for (let c = 0; c < courses; c++) { tiles.push({ i: 108, x: 0, y }, { i: 109, x: 1, y }, { i: 110, x: 2, y }); y++; } // wall courses
  tiles.push({ i: 120, x: 0, y }, { i: 124, x: 1, y }, { i: 122, x: 2, y }); // gated base
  return { w: 3, h: y + 1, tiles };
}

export function placeTownhall() {
  S.keepLevel = -1;   // force the first renderKeep to draw
  renderKeep();
}

// renderKeep (re)draws the keep to match its current level — a taller, grander
// gatehouse each level. Only redraws when the level changed (cheap). The base
// row stays pinned on CENTER (everything agrees on it); the keep rises upward
// as it grows, so its centre plot never moves.
export function renderKeep() {
  const level = S.game.level('keep');
  if (S.keepLevel === level) return;
  S.keepLevel = level;
  if (S.keepContainer) { S.entities.removeChild(S.keepContainer); S.keepContainer.destroy({ children: true }); }
  const recipe = keepRecipe(level);
  const c = makeBuildingContainer(recipe, null);
  c.x = (CENTER_TX - Math.floor(recipe.w / 2)) * TILE;
  c.y = (CENTER_TY - recipe.h) * TILE;          // base row on CENTER_TY, keep rising above
  c.zIndex = c.y + recipe.h * TILE;
  S.entities.addChild(c);
  S.keepContainer = c;
  if (!S.keepPlaced) {
    // Reserve the keep's growth column ONCE, up to a MAX-level keep's height, so
    // no building ever lands where a taller keep will rise. Centre plot = key.
    S.keepPlaced = true;
    const maxH = keepRecipe(S.game.instanceMax('keep')).h;
    const tx0 = pxToTile(c.x), tx1 = tx0 + recipe.w - 1;
    const yTop = Math.floor((CENTER_TY - maxH) / PLOT), yBot = Math.floor(CENTER_TY / PLOT);
    for (let py = yTop; py <= yBot; py++)
      for (let px = Math.floor(tx0 / PLOT); px <= Math.floor(tx1 / PLOT); px++) S.usedPlots.add(`${px},${py}`);
    S.keepKey = `${Math.floor(CENTER_TX / PLOT)},${Math.floor(CENTER_TY / PLOT)}`;
  }
  S.hittable = S.hittable.filter((h) => h.type !== 'keep');
  S.hittable.push({ type: 'keep', key: 'keep#0', x0: c.x / TILE, y0: c.y / TILE, x1: c.x / TILE + recipe.w, y1: c.y / TILE + recipe.h, label: S.hold.name + ' — the keep' });
}

// Desired count of each building type = its physical-building count now that
// levels are per-instance (build() raises a new one, upgrade() deepens one, so
// count no longer needs to be inferred from a pooled level).
export function desiredCounts() {
  const d = {};
  for (const b of BUILDINGS) {
    if (b.id === 'palisade' || b.id === 'farm' || b.id === 'keep') continue; // palisade = wall; farm = farmPlots; keep = renderKeep
    const n = S.game.count(b.id);
    if (n > 0) d[b.id] = n;
  }
  return d;
}

// placedCountOf — how many `${type}#k` instances already hold a S.placed
// key, finished or still a construction site (S.siteKeys reserves theirs the
// moment they start — see startSite). Keys are always assigned contiguously
// from 0 (see reconcileBuildings/startSite), so this doubles as "the next
// free index" for a new instance of `type`.
export function placedCountOf(type) {
  let n = 0;
  const prefix = type + '#';
  for (const k of S.placed.keys()) if (k.startsWith(prefix)) n++;
  return n;
}

// allocatePlot picks WHERE a new instance of `type` belongs — the exact
// per-district routing reconcileBuildings has always used (core/outer/mine/
// wharf) — pulled out so a construction SITE (startSite) can call the same
// routing without duplicating it. Returns {plot,cx,cy} in pixels, or null if
// there's nowhere free for it right now.
export function allocatePlot(type, recipe) {
  if (type === 'mine') {
    // A mine isn't a town plot — it's raised directly on an ore vein out
    // in the field, claiming that node's spot (see placeOreNodes).
    const node = nextMineNode();
    if (!node) return null; // the ore field is fully claimed — this mine waits
    const plot = { tx: Math.round(node.x / TILE - recipe.w / 2), ty: Math.round(node.y / TILE - recipe.h), node };
    return { plot, cx: plot.tx * TILE, cy: plot.ty * TILE };
  }
  if (type === 'wharf') {
    // Same idea, on the waterfront: claim the next free shore tile
    // placeWater() found, instead of a town plot (see nextWharfSite).
    const site = nextWharfSite();
    if (!site) return null; // no shoreline left (or none at all) — this wharf waits
    const plot = { tx: Math.round(site.x / TILE - recipe.w / 2), ty: Math.round(site.y / TILE - recipe.h), site };
    return { plot, cx: plot.tx * TILE, cy: plot.ty * TILE };
  }
  if (OUTER_TYPES.has(type)) {
    // sawmill/quarry/saltern: an outer-ring plot, biased toward their
    // terrain when one's modeled (see outerBias).
    const bias = outerBias(type);
    const plot = nextOuterPlot(bias && bias.x, bias && bias.y);
    if (!plot) return null;
    return { plot, cx: plot.tx * TILE + Math.floor((PLOT - recipe.w) / 2) * TILE, cy: (plot.ty + PLOT - recipe.h) * TILE };
  }
  // CORE_TYPES: dwellings/stores/faith/command — a plot inside the walled
  // core zone (see nextCorePlot/coreRadius).
  const plot = nextCorePlot();
  if (!plot) return null;
  return { plot, cx: plot.tx * TILE + Math.floor((PLOT - recipe.w) / 2) * TILE, cy: (plot.ty + PLOT - recipe.h) * TILE };
}

// ---- relocation (redistricting) ---------------------------------------
// RELOCATABLE — building types a MOVE order may actually relocate: the
// walled-core dwellings/stores/faith/command, plus the non-self-siting outer
// works. Farms (a district render) and the keep (fixed at centre) are
// excluded, same as mines/wharfs (self-sited on a vein/shore, not a plot).
const RELOCATABLE = new Set([...CORE_TYPES, 'sawmill', 'quarry', 'saltern']);

// plotBuildPos — a plot's actual build position in pixels for `recipe`, the
// same formula allocatePlot uses for CORE_TYPES and OUTER_TYPES alike.
function plotBuildPos(plot, recipe) {
  return { cx: plot.tx * TILE + Math.floor((PLOT - recipe.w) / 2) * TILE, cy: (plot.ty + PLOT - recipe.h) * TILE };
}

// destBlocked — is `plot`'s footprint (for `recipe`) crossed by a wall/gate
// tile? nextCorePlot/nextOuterPlot already dodge used/ore/water plots, but
// not the finer-grained wall tile set — a relocation dest needs this too.
function destBlocked(plot, recipe) {
  const { cx, cy } = plotBuildPos(plot, recipe);
  const tx0 = cx / TILE, ty0 = cy / TILE;
  for (let y = 0; y < recipe.h; y++) for (let x = 0; x < recipe.w; x++) {
    if (S.walls.has(`${tx0 + x},${ty0 + y}`) || S.gates.has(`${tx0 + x},${ty0 + y}`)) return true;
  }
  return false;
}

// pickRelocateDest finds a wall-clear dest for relocateBuilding: retries the
// same allocator the build path uses (nextCorePlot/nextOuterPlot) past any
// candidate a wall/gate crosses. Rejected candidates are released back to
// S.usedPlots; the winner (if any) stays claimed for relocateBuilding to use.
export function pickRelocateDest(type, recipe) {
  const isOuter = OUTER_TYPES.has(type);
  const tried = [];
  let dest = null;
  for (let i = 0; i < 24; i++) {
    const bias = isOuter ? outerBias(type) : null;
    const plot = isOuter ? nextOuterPlot(bias && bias.x, bias && bias.y) : nextCorePlot();
    if (!plot) break;
    tried.push(plot);
    if (!destBlocked(plot, recipe)) { dest = plot; break; }
  }
  for (const p of tried) if (p !== dest) S.usedPlots.delete(`${p.px},${p.py}`);
  return dest;
}

// relocateBuilding moves already-placed building `key` onto plot `dest`
// (from pickRelocateDest): repositions its sprite, swaps its S.placed plot
// record, patches its S.hittable box in place, and frees the old plot /
// claims the new one. False (no-op) if `key` isn't a relocatable, finished
// building, or `dest` isn't usable.
export function relocateBuilding(key, dest) {
  const type = key.slice(0, key.indexOf('#'));
  if (!RELOCATABLE.has(type) || S.siteKeys.has(key)) return false; // not a plot building, or still under construction
  const rec = S.placed.get(key);
  if (!rec || !rec.container || !dest) return false;
  const { recipe } = recipeFor(type);
  if (destBlocked(dest, recipe)) return false; // pickRelocateDest should've screened this — stay safe if called directly
  const { cx, cy } = plotBuildPos(dest, recipe);
  const old = rec.plot;
  if (old && old.px != null) S.usedPlots.delete(`${old.px},${old.py}`);
  S.usedPlots.add(`${dest.px},${dest.py}`);
  rec.container.x = cx; rec.container.y = cy; rec.container.zIndex = cy + recipe.h * TILE;
  rec.plot = dest;
  const hit = S.hittable.find((h) => h.key === key);
  if (hit) { hit.x0 = cx / TILE; hit.y0 = cy / TILE; hit.x1 = cx / TILE + recipe.w; hit.y1 = cy / TILE + recipe.h; }
  constructionPoof(cx + recipe.w * TILE / 2, cy + recipe.h * TILE);
  return true;
}

// Reconcile placed structures toward the desired counts (grow the town).
// This still exists for boot/catch-up: a hold's starting levels (a farm-tier
// wharf/saltern, or an old save) need to appear instantly, with no order or
// site behind them. Going forward, an actual `build` ORDER reserves its key
// via startSite before this ever sees it (S.placed.has(key) is already true),
// so this loop no longer duplicates a site in progress.
export function reconcileBuildings() {
  const want = desiredCounts();
  for (const [type, n] of Object.entries(want)) {
    for (let k = 0; k < n; k++) {
      const key = `${type}#${k}`;
      if (S.placed.has(key)) continue;
      const { recipe, prop } = recipeFor(type);
      const alloc = allocatePlot(type, recipe);
      if (!alloc) { if (type === 'mine' || type === 'wharf') break; else return; }
      const { plot, cx, cy } = alloc;
      const c = makeBuildingContainer(recipe, prop);
      c.x = cx; c.y = cy;
      if (type === 'farm') {
        // A field is flat ground — put it on the ground layer so the folk
        // walk over it, not behind it. Fade in instead of "rising".
        c.alpha = 0; S.ground.addChild(c); fadeIn(c);
      } else {
        c.zIndex = c.y + recipe.h * TILE;
        c.alpha = 0; c.pivot.set(0, -4); // a little "rise" as it's built
        S.entities.addChild(c);
        riseIn(c);
      }
      S.placed.set(key, { container: c, plot });
      S.hittable.push({ key, x0: c.x / TILE, y0: c.y / TILE, x1: c.x / TILE + recipe.w, y1: c.y / TILE + recipe.h, type });
      if (S.booted) constructionPoof(c.x + recipe.w * TILE / 2, c.y + recipe.h * TILE);
    }
  }
  updateLevelBadges();
  renderKeep();         // a keep upgrade re-renders it taller
  reconcileFarms();
  renderWalls();
}

// updateLevelBadges keeps a small gold pip-stack above each building whose
// instance level has risen — the visible tell for the per-building upgrade
// system (an upgrade deepens a building without adding a sprite). Farms show
// their level as field AREA, so they're skipped.
function updateLevelBadges() {
  for (const [key, rec] of S.placed) {
    if (key.startsWith('farm#') || !rec.container) continue;
    const hash = key.indexOf('#');
    const type = key.slice(0, hash), idx = Number(key.slice(hash + 1));
    const lv = S.game.instanceLevel(type, idx);
    if (rec.badgeLvl === lv) continue;
    rec.badgeLvl = lv;
    drawLevelBadge(rec, lv);
  }
}

// drawLevelBadge draws lv-1 tiny gold pips near a building's top (level 1 = none).
function drawLevelBadge(rec, lv) {
  if (rec.badge) { rec.container.removeChild(rec.badge); rec.badge.destroy({ children: true }); rec.badge = null; }
  if (lv <= 1) return;
  const g = new Container();
  for (let i = 0; i < lv - 1; i++) g.addChild(new Graphics().rect(i * 3, 0, 2, 3).fill(0xffd23a).stroke({ width: 0.4, color: 0x5a3d0e }));
  g.x = 1; g.y = -5;              // just above the footprint's top-left corner
  rec.container.addChild(g); rec.badge = g;
}

// Farms are individual fields (game.farmPlots), each with a size and crop.
// They render from farmPlots — a new farm adds a field, expansion regrows one
// bigger with fuller crops — separate from the level-driven building counts.
// Only S.placed's bookkeeping (plot/size/crop per field) happens here; the
// actual pixels are the WHOLE farmland district, redrawn by renderFarmDistrict
// below so adjacent fields' borders autotile against each other instead of
// each field drawing its own independent 9-slice (the old doubled-seam bug).
export function reconcileFarms() {
  const plots = S.game.farmPlots || [];
  let changed = false;
  for (let i = 0; i < plots.length; i++) {
    const fp = plots[i], key = `farm#${i}`;
    const ex = S.placed.get(key);
    if (ex && ex.size === fp.size) continue;    // already drawn at this size
    const plot = ex ? ex.plot : nextFarmPlot();  // new fields cluster into the farmland district — see nextFarmPlot
    if (!plot) break; // out of room this tick — render whatever DID change below; the rest retries next tick
    if (ex && S.booted) { // an existing field grew in place — poof, no fade (see renderFarmDistrict)
      const n = 2 + fp.size;
      constructionPoof((plot.tx + n / 2) * TILE, (plot.ty + n) * TILE);
    }
    S.placed.set(key, { plot, size: fp.size, crop: fp.crop });
    changed = true;
  }
  if (changed) renderFarmDistrict();
}

// renderFarmDistrict redraws the farmland district as ONE autotiled region:
// the union of every placed field's tiles (farmUnionTiles), each tile's
// texture picked from farmTileTex against its neighbors IN THE UNION, not
// from its own field alone — a farm tile touching another farm tile gets no
// grass on that side, so two adjacent fields share one border/corner instead
// of each drawing its own (the T/cross junctions the district needs). A lone
// field has no farm neighbors anywhere, so every one of its border tiles
// still opens onto grass exactly as before — this reduces to the old
// per-field 9-slice with nothing next to it.
// Rebuilt from scratch on every change (cheap — a handful of fields, a few
// tiles each), but existing tile sprites are reused in place (retextured, not
// destroyed) so a shared border flipping from grass-edge to interior doesn't
// refade — only genuinely NEW ground (a brand new field, or growth into
// fresh tiles) fades in.
export function renderFarmDistrict() {
  if (!S.farmDistrict) { S.farmDistrict = new Container(); S.ground.addChild(S.farmDistrict); }
  // Autotile the whole farmland as ONE union: adjacent fields merge into a
  // single tilled shape with grass only on the outer perimeter — clean T/cross
  // junctions, no doubled seams. Concave corners at size-steps now resolve too,
  // thanks to the generated inner-corner tiles (farmTileTex / `in:` in atlas).
  const tiles = farmUnionTiles();               // "tx,ty" -> { crop }
  for (const [k, sp] of S.farmTiles) {
    if (tiles.has(k)) continue;
    S.farmDistrict.removeChild(sp); sp.destroy(); S.farmTiles.delete(k);
  }
  for (const [k, { crop }] of tiles) {
    const [tx, ty] = k.split(',').map(Number);
    const tex = farmTileTex(tiles, tx, ty, crop);
    let sp = S.farmTiles.get(k);
    if (sp) { sp.texture = tex; continue; }
    sp = new Sprite(tex); sp.x = tx * TILE; sp.y = ty * TILE; sp.alpha = 0;
    S.farmDistrict.addChild(sp); S.farmTiles.set(k, sp); fadeIn(sp);
  }
  // S.hittable's farm entries are rebuilt fresh every render (cheap, and a
  // handful of fields) rather than patched — keeps each field's own hover
  // box ("Farm · lvl N") and click region correct with no container to key
  // off of (there's no more one-container-per-field).
  S.hittable = S.hittable.filter((h) => h.type !== 'farm');
  for (const [key, rec] of S.placed) {
    if (!key.startsWith('farm#')) continue;
    const n = 2 + rec.size;
    const cr = CROP_BY_ID[rec.crop];
    const label = cr ? `${cr.name} field` : 'Farm';
    S.hittable.push({ key, x0: rec.plot.tx, y0: rec.plot.ty, x1: rec.plot.tx + n, y1: rec.plot.ty + n, type: 'farm', label });
  }
}

// farmUnionTiles is the union of every placed field's footprint, in world
// tile coords: "tx,ty" -> { crop } (which field's crop fills that cell —
// matters only for the rare 1-tile overlap between differently-sized fields
// sharing the same PLOT grid, where the later field in S.placed wins).
export function farmUnionTiles() {
  const tiles = new Map();
  for (const [key, rec] of S.placed) {
    if (!key.startsWith('farm#')) continue;
    const n = 2 + rec.size; // size1→3x3, size2→4x4, size3→5x5
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      tiles.set(`${rec.plot.tx + x},${rec.plot.ty + y}`, { crop: rec.crop });
    }
  }
  return tiles;
}

// farmTileTex autotiles a single farm tile against the WHOLE district union:
// a farm neighbor on a side means no grass faces that way (interior/crop
// keeps going), so two adjacent fields share one border instead of each
// drawing its own — outer corners fall out of two open sides at once, same
// as the old per-field 9-slice. Where fields of different sizes step against
// each other you get a CONCAVE (inner-corner) junction instead: all 4
// cardinal sides closed (farm) but a diagonal neighbor open (grass). Tiny
// Town's grass-dirt set is a plain 9-slice — 4 outer corners + 4 edges + a
// centre — with no inner-corner tile to reach for (checked the whole atlas:
// nothing else in it draws a concave grass/dirt cut either). Approximated as
// plain interior: the grass at that notch is already the ordinary ground
// tile just outside the union (see paintGround), so this tile — bordered by
// farm on every cardinal side — is correctly interior too, just with a
// squared-off corner where a rounded cut isn't available.
// cropTexKey maps a SPECIFIC crop id (barley, grapes…) to one of the three
// crop tile textures we have, by its food category — grain/roots keep their own
// look, greens+fruit share the leafy tile until a fruit tile exists.
const CAT_TEX = { grain: 'grain', roots: 'roots', greens: 'greens', fruit: 'greens' };
export function cropTexKey(crop) {
  const c = CROP_BY_ID[crop];
  return (c && CAT_TEX[c.cat]) || 'greens';
}
export function farmTileTex(tiles, tx, ty, crop) {
  const has = (x, y) => tiles.has(`${x},${y}`);
  const openN = !has(tx, ty - 1), openS = !has(tx, ty + 1), openE = !has(tx + 1, ty), openW = !has(tx - 1, ty);
  let ex = 0, ey = 0;
  if (openN && openW) { ex = -1; ey = -1; }
  else if (openN && openE) { ex = 1; ey = -1; }
  else if (openS && openW) { ex = -1; ey = 1; }
  else if (openS && openE) { ex = 1; ey = 1; }
  else if (openN) ey = -1;
  else if (openS) ey = 1;
  else if (openW) ex = -1;
  else if (openE) ex = 1;
  if (ex === 0 && ey === 0) {
    // Interior — but a CONCAVE junction (both cardinals of a corner are farm
    // while the diagonal is open) needs a grass nub tucked into that corner
    // (generated inner-corner tile), else the border breaks at the step.
    for (const [dy, dx] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      if (!has(tx + dx, ty + dy) && has(tx + dx, ty) && has(tx, ty + dy)) return S.atlas.farmDirt[`in:${dy},${dx}`];
    }
    return S.atlas.crops[cropTexKey(crop)] || S.atlas.crops.greens;
  }
  return S.atlas.farmDirt[`${ey},${ex}`];
}

// ---- construction sites (builders) ----------------------------------
// A `build` order (see advanceBuildOrder) no longer finishes instantly: it
// allocates a plot (allocatePlot, same routing reconcileBuildings uses),
// pays the cost up front, and raises a low-alpha site that idle BUILDER
// villagers walk to and work — like a woodcutter's tree or a miner's vein,
// but shared (any number of builders may work the same site at once) and
// continuous (progress rises every frame a builder's on it, not a one-shot
// timer — see stepVillager's workSite branch). S.sites holds every site not
// yet finished; S.siteKeys is the S.placed keys they're reserving meanwhile.

// makeScaffold lays a bare-earth foundation patch (on the ground layer, so
// it never fights the rising building's own z-order) under a fresh site —
// a "something's being built here" tell independent of the sprite's own low
// alpha, which can be hard to read against grass this faint.
export function makeScaffold(recipe, cx, cy) {
  const g = new Container();
  const dirt = S.atlas.ground.dirt;
  for (let ty = 0; ty < recipe.h; ty++) for (let tx = 0; tx < recipe.w; tx++) {
    const s = new Sprite(dirt[(tx + ty) % dirt.length]);
    s.x = cx + tx * TILE; s.y = cy + ty * TILE;
    g.addChild(s);
  }
  S.ground.addChild(g);
  return g;
}

// startSite performs REAL construction for a non-farm `build` order (cost
// already confirmed affordable): allocate a plot, pay + append a new level-1
// instance (S.game.build), and raise a low-alpha site over a scaffold for
// builders to work. Returns a site record; or 'instant' when there's no room
// for a new sprite (the drawn-instance cap, or a mine whose veins/plots are
// full) and it deepens an existing building's LEVEL instead; or null when
// there's nothing to build OR deepen right now (the caller waits + retries).
export function startSite(type) {
  if (type === 'farm') return startFarmSite(); // a field, not a recipe/plot building — its own site path
  if (type === 'keep') return S.game.upgradeAny('keep') ? 'instant' : null; // central + singular — a build order just deepens it
  if (S.game.count(type) >= MAX_PER_TYPE) return S.game.upgradeAny(type) ? 'instant' : null;
  const { recipe, prop } = recipeFor(type);
  const alloc = allocatePlot(type, recipe);
  if (!alloc) return S.game.count(type) > 0 && S.game.upgradeAny(type) ? 'instant' : null; // no room/vein — deepen instead
  S.game.build(type);                          // pays + appends a new level-1 instance
  const { plot, cx, cy } = alloc;
  const key = `${type}#${placedCountOf(type)}`; // keys are contiguous from 0 — this IS the next free slot
  const c = makeBuildingContainer(recipe, prop);
  c.x = cx; c.y = cy; c.zIndex = c.y + recipe.h * TILE; c.alpha = SITE_ALPHA;
  S.entities.addChild(c);
  const site = {
    key, type, recipe, container: c,
    x: cx + recipe.w * TILE / 2, y: cy + recipe.h * TILE, // the footprint's base point — sparks, poof, and where builders stand
    scaffold: makeScaffold(recipe, cx, cy),
    progress: 0, builders: new Set(), done: false,
  };
  S.placed.set(key, { container: c, plot }); // reserved now — reconcileBuildings won't touch this key again
  S.siteKeys.add(key);
  S.sites.push(site);
  return site;
}

// finalizeSite completes a site: full alpha, registered in S.hittable
// exactly as reconcileBuildings does for an instant build, the scaffold
// cleared, a construction poof, and every builder on it released (idle →
// pickTarget next frame). Guarded against double-finalize — two builders
// can both cross progress 1.0 in the same frame (see stepVillager).
// startFarmSite breaks ground on a NEW farm field: reserve a plot in the
// farmland district + pay now, and raise a bare-earth scaffold that builders
// must till (its alpha climbs with progress) before the field itself appears
// in finalizeSite's farm branch. A field is game.farmPlots, not a recipe/plot
// building, so it gets its own site path rather than startSite's machinery.
export function startFarmSite() {
  const plot = nextFarmPlot();
  if (!plot) return null;                        // district momentarily full — wait, retry next tick
  if (!S.game.build('farm')) { S.usedPlots.delete(`${plot.px},${plot.py}`); return null; } // pay + raise level (afford already checked)
  const n = 3;                                   // a fresh field is size 1 → 3x3
  const cx = plot.tx * TILE, cy = plot.ty * TILE;
  const scaffold = makeScaffold({ w: n, h: n }, cx, cy);
  scaffold.alpha = SITE_ALPHA;                   // fades in as builders till (workSite sets container.alpha = progress)
  const site = {
    key: `farm-site-${S.farmSiteSeq = (S.farmSiteSeq || 0) + 1}`,
    type: 'farm', plot, container: scaffold,
    x: cx + n * TILE / 2, y: cy + n * TILE,       // where builders stand / the poof fires
    progress: 0, builders: new Set(), done: false,
  };
  S.sites.push(site);
  return site;
}

// ---- masonry: the wall plan, built one tile at a time -----------------
// stepMasonry (called each townTick) keeps exactly ONE wall tile under
// construction: when no wall site is open and the plan has jobs, the next
// job becomes a real 1-tile site a builder must walk to and work. Walls rise
// tile by tile around the ring — visibly slow, visibly hand-built.
const WALL_RATE = { fence: 1 / 4, wood: 1 / 6, stone: 1 / 9 }; // solo seconds per tile; towers slower still

export function stepMasonry() {
  if (S.sites.some((s) => s.type === 'wall' && !s.done)) return;
  const job = S.wallPlan.shift();
  if (!job) return;
  startWallSite(job);
  S.wallsVersion++; saveWalls(); // its survey stake becomes a site; plan shrank
}

// startWallSite raises the 1-tile site: a ghost post whose alpha climbs with
// progress (the shared workSite branch does that), over a bare-earth patch.
// Builders stand on a free NEIGHBOR tile, not the wall line itself — so the
// tile landing under their feet never walls them in.
export function startWallSite(job) {
  const post = new Sprite(S.atlas.fence.post);
  post.anchor.set(0.5, 0.5);
  post.x = job.x * TILE + TILE / 2; post.y = job.y * TILE + TILE / 2;
  post.zIndex = (job.y + 1) * TILE; post.alpha = SITE_ALPHA;
  if (job.gate) post.tint = 0xf2c14e; else if (WALL_TINT[job.kind]) post.tint = WALL_TINT[job.kind];
  S.entities.addChild(post);
  const free = (x, y) => !S.walls.has(`${x},${y}`) && !S.water.has(`${x},${y}`);
  const stand = [[0, 1], [0, -1], [1, 0], [-1, 0]].find(([dx, dy]) => free(job.x + dx, job.y + dy)) || [0, 1];
  const site = {
    key: `wall-${job.x},${job.y}`, type: 'wall', job, container: post,
    x: (job.x + stand[0]) * TILE + TILE / 2, y: (job.y + stand[1] + 1) * TILE,
    scaffold: makeScaffold({ w: 1, h: 1 }, job.x * TILE, job.y * TILE),
    rate: job.tower ? 1 / 12 : (WALL_RATE[job.kind] || WALL_RATE.fence),
    progress: 0, builders: new Set(), done: false,
  };
  S.sites.push(site);
  return site;
}

export function finalizeSite(site) {
  if (site.done) return;
  site.done = true;
  if (site.type === 'wall') {                    // one more tile of the plan stands
    applyWallJob(site.job);                      // lands it in S.walls/S.gates/S.towers (+ version/save)
    if (site.container) { S.entities.removeChild(site.container); site.container.destroy(); }
    if (site.scaffold) { S.ground.removeChild(site.scaffold); site.scaffold.destroy({ children: true }); }
    constructionPoof(site.x, site.y);
    const wi = S.sites.indexOf(site); if (wi >= 0) S.sites.splice(wi, 1);
    for (const v of site.builders) { v.workSite = null; v.working = false; v.idle = 0; }
    site.builders.clear();
    return;
  }
  if (site.type === 'farm') {                    // a tilled field, not a building
    const plots = S.game.farmPlots, idx = plots.length, crop = S.game.pickCrop(); // a climate-suited crop for this hold
    plots.push({ size: 1, crop });
    S.placed.set(`farm#${idx}`, { plot: site.plot, size: 1, crop }); // reserved plot → reconcileFarms draws it HERE
    renderFarmDistrict();
    if (site.container) { S.ground.removeChild(site.container); site.container.destroy({ children: true }); }
    constructionPoof(site.x, site.y);
    const fi = S.sites.indexOf(site); if (fi >= 0) S.sites.splice(fi, 1);
    for (const v of site.builders) { v.workSite = null; v.working = false; v.idle = 0; }
    site.builders.clear();
    return;
  }
  const c = site.container, r = site.recipe;
  c.alpha = 1;
  S.hittable.push({ key: site.key, x0: c.x / TILE, y0: c.y / TILE, x1: c.x / TILE + r.w, y1: c.y / TILE + r.h, type: site.type });
  S.siteKeys.delete(site.key);
  const i = S.sites.indexOf(site);
  if (i >= 0) S.sites.splice(i, 1);
  if (site.scaffold) { S.ground.removeChild(site.scaffold); site.scaffold.destroy({ children: true }); }
  constructionPoof(site.x, site.y);
  for (const v of site.builders) { v.workSite = null; v.working = false; v.idle = 0; } // off to the next site, or wander
  site.builders.clear();
}

// nearestSite — an idle builder's pick: sites with NO builders yet come
// first (spreading hands across every site rather than piling onto one), the
// nearest such site if there's a choice; once every site already has a
// builder, sharing is fine — fall back to the nearest site overall rather
// than leaving a builder idle.
export function nearestSite(px, py) {
  let bestEmpty = null, bdEmpty = Infinity, bestAny = null, bdAny = Infinity;
  for (const s of S.sites) {
    if (s.done) continue;
    const d = (s.x - px) ** 2 + (s.y - py) ** 2;
    if (d < bdAny) { bdAny = d; bestAny = s; }
    if (s.builders.size === 0 && d < bdEmpty) { bdEmpty = d; bestEmpty = s; }
  }
  return bestEmpty || bestAny;
}
