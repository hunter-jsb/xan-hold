// walls.js — planned palisade walls + gates as tile sets (S.walls/S.gates),
// grown by wall orders, rendered from the fence atlas. Walls block pathing,
// gates pass. Public seam: loadWalls/layWallSegment/layGate/renderWalls.
import { Sprite } from 'pixi.js';
import { TILE } from './atlas.js';
import { S } from './state.js';
import { TOWN_W, TOWN_H } from './constants.js';
import { wallKey, clampX, clampY } from './coords.js';

// ---- walls ------------------------------------------------------------
// Real, planned construction: S.walls/S.gates are sets of grid tiles, grown
// piecemeal by wall ORDERS (see the 'wall' case in advanceOrder) that lay a
// straight segment and/or carve a gate. Nothing here computes a bounding box
// or resizes a ring — segments only ever ACCUMULATE. Wall tiles are
// impassable, gate tiles are passable (see findPath), and both render from
// the same fence atlas the old auto-ring used. (wallKey/clampX/clampY → coords.js)

// Wall/gate tiles are grown by orders over real time, unlike the old ring
// (which was rederived every tick purely from the town's plot bounds + a
// level number) — so unlike that ring, they need their OWN save, a sibling
// of the economy's `xanhold:<id>` key (same "xanhold:" prefix, so `R` /
// resetWorld's wipe already covers it for free).
// TIER_KIND — a section wall's tier (its "level") to the tile kind it lays:
// 1 fence, 2 wood, 3 stone. Higher tiers are real fortification (fort spans).
export const TIER_KIND = [null, 'fence', 'wood', 'stone'];

export function wallsSaveKey() { return 'xanhold:' + S.hold.id + ':walls'; }
export function saveWalls() {
  try {
    localStorage.setItem(wallsSaveKey(), JSON.stringify({
      walls: [...S.walls], gates: [...S.gates], edges: [...S.wallEdgesBuilt],
      kind: [...S.wallKind], towers: [...S.towers], tier: S.sectionTier, box: S.sectionBox,
    }));
  } catch { /* private/sandboxed storage — walls just won't survive a reload */ }
}
export function loadWalls() {
  try {
    const raw = localStorage.getItem(wallsSaveKey());
    if (!raw) return;
    const d = JSON.parse(raw);
    S.walls = new Set(d.walls || []); S.gates = new Set(d.gates || []);
    // Edges are now keyed `${section}:${side}`; a pre-sections save has bare
    // side names — those were all the core.
    S.wallEdgesBuilt = new Set((d.edges || []).map((e) => e.includes(':') ? e : `core:${e}`));
    S.wallKind = new Map(d.kind || []); S.towers = new Set(d.towers || []); // pre-rework saves lack these → all fence, no towers
    S.sectionTier = d.tier || {};
    S.sectionBox = d.box || {};
    // Derive the core's tier + box from its existing tiles if the save predates
    // sections, so an upgrade re-lays the ring where it actually stands.
    if (S.walls.size) {
      if (S.sectionTier.core == null) {
        const kinds = new Set([...S.wallKind.values()]);
        S.sectionTier.core = kinds.has('stone') ? 3 : kinds.has('wood') ? 2 : 1;
      }
      if (!S.sectionBox.core) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const k of S.walls) { const [tx, ty] = k.split(',').map(Number); x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty); }
        S.sectionBox.core = { x0, y0, x1, y1 };
      }
    }
  } catch { /* corrupt or sandboxed — start with a clean slate */ }
}

// buildingAtTile — is tile (tx,ty) under an already-placed building's
// footprint (S.hittable)? Buildings don't block pathing (only S.walls/
// S.water do — see findPath), so this exists purely so a wall segment
// doesn't draw a fence tile straight through one (a self-sited mine/wharf
// can legitimately end up near the core boundary — see coreRadius).
export function buildingAtTile(tx, ty) {
  for (const h of S.hittable) if (tx >= h.x0 && tx < h.x1 && ty >= h.y0 && ty < h.y1) return true;
  return false;
}

// wallBlocked — a tile a palisade must never be drawn on: a building footprint
// (incl. farm fields, which live in S.hittable), open water, or a resource node
// (an ore vein or the stone boulder). layWallSegment SKIPS these, so a planned
// segment BUILDS AROUND them — the fence meets the field/vein/shore and picks
// back up on the far side — instead of a fence cutting straight through a farm
// or a rock (which also z-fought them). Ore nodes carry their base at
// (n.x=gx·TILE+TILE/2, n.y=gy·TILE+TILE), so their tile is (⌊n.x/TILE⌋,
// ⌊n.y/TILE⌋−1); an unclaimed vein still stands (a claimed one became a mine,
// already caught by buildingAtTile).
export function wallBlocked(tx, ty) {
  if (buildingAtTile(tx, ty)) return true;              // buildings + farm fields (S.hittable)
  const k = wallKey(tx, ty);
  if (S.water.has(k) || S.farmTiles.has(k)) return true; // shoreline + tilled farmland
  for (const n of S.oreNodes) {
    if (n.claimedByMine) continue;
    if (Math.floor(n.x / TILE) === tx && Math.floor(n.y / TILE) - 1 === ty) return true;
  }
  return false;
}

// layWallSegment adds every tile on the straight line from `from` to `to`
// (inclusive) to S.walls, carving a gate at `gate` if given (that one tile
// becomes passable + drawn as an opening instead of fence). Only ever lays
// straight (axis-aligned) runs — a diagonal from an LLM-authored order is
// snapped to its dominant axis so the tile-by-tile walk below terminates.
// Skips any tile wallBlocked flags (a building, farm field, ore/stone vein, or
// water) — the fence meets that obstacle and resumes past it instead of cutting
// through its sprite, so a segment builds AROUND the town's fixed features.
export function layWallSegment(from, to, gate, kind = 'fence') {
  from = { x: clampX(from.x), y: clampY(from.y) };
  to = { x: clampX(to.x), y: clampY(to.y) };
  if (from.x !== to.x && from.y !== to.y) {
    to = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
  }
  const dx = Math.sign(to.x - from.x), dy = Math.sign(to.y - from.y);
  const g = gate ? { x: clampX(gate.x), y: clampY(gate.y) } : null;
  let x = from.x, y = from.y, guard = 0;
  while (guard++ <= TOWN_W + TOWN_H) {
    const k = wallKey(x, y);
    // A farm / vein / boulder / shore / building on the line stays untouched —
    // the fence builds AROUND it (that tile is left open, a natural gap where
    // the obstacle is) instead of drawing straight through it.
    if (wallBlocked(x, y)) { /* skip — build around it */ }
    else if (g && g.x === x && g.y === y) { S.walls.delete(k); S.gates.add(k); S.wallKind.delete(k); }
    else { S.gates.delete(k); S.walls.add(k); S.wallKind.set(k, kind); } // fence | wood | stone — sets the tile's fortification tier
    if (x === to.x && y === to.y) break;
    x += dx; y += dy;
  }
  S.wallsVersion++; saveWalls();
}

// layGate carves (or moves) a single gate tile on its own — used both by
// layWallSegment's inline gate and a standalone "open a gate here" order
// with no segment attached (widening an existing wall's access).
export function layGate(pt) {
  const key = wallKey(clampX(pt.x), clampY(pt.y));
  S.walls.delete(key); S.gates.add(key); S.wallKind.delete(key);
  S.wallsVersion++; saveWalls();
}

// ---- towers + fortifications (walls rework) ----------------------------
// Fences (default kind) just delineate a district/farm edge. WOOD/STONE walls
// are real fortification: a straight run of them between two towers is a "fort
// span", and each span the hold holds is worth +2 troop capacity (see troopCap).
export function placeTower(tx, ty) {
  S.towers.add(wallKey(clampX(tx), clampY(ty)));
  S.wallsVersion++; saveWalls();
}

// layFortWall raises a tower at each end and a wood/stone wall between them.
export function layFortWall(a, b, kind = 'wood') {
  placeTower(a.x, a.y); placeTower(b.x, b.y);
  layWallSegment(a, b, null, kind);
}

// fortSpans — how many tower→tower wood/stone runs the hold holds. Scans only
// +x/+y from each tower so each span is counted once; a run of fort wall that
// reaches another tower is a span.
export function fortSpans() {
  const isFort = (x, y) => { const k = wallKey(x, y); const t = S.wallKind.get(k); return S.walls.has(k) && (t === 'wood' || t === 'stone'); };
  const isGate = (x, y) => S.gates.has(wallKey(x, y));
  let spans = 0;
  for (const key of S.towers) {
    const [tx, ty] = key.split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      let x = tx + dx, y = ty + dy, fort = 0;
      // a gate on the wall doesn't sever the span — troops just pass through it
      while (isFort(x, y) || isGate(x, y)) { if (isFort(x, y)) fort++; x += dx; y += dy; }
      if (fort > 0 && S.towers.has(wallKey(x, y))) spans++;
    }
  }
  return spans;
}

// fortStrength — the troop capacity fort spans grant, weighted by TIER: a wood
// span is worth 2, a stone span 3 (stone holds more). Same tower→tower scan as
// fortSpans, but reads whether any tile in the run is stone.
export function fortStrength() {
  const kindAt = (x, y) => S.wallKind.get(wallKey(x, y));
  const isFort = (x, y) => { const k = wallKey(x, y); const t = kindAt(x, y); return S.walls.has(k) && (t === 'wood' || t === 'stone'); };
  const isGate = (x, y) => S.gates.has(wallKey(x, y));
  let strength = 0;
  for (const key of S.towers) {
    const [tx, ty] = key.split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      let x = tx + dx, y = ty + dy, fort = 0, stone = false;
      while (isFort(x, y) || isGate(x, y)) { if (isFort(x, y)) { fort++; if (kindAt(x, y) === 'stone') stone = true; } x += dx; y += dy; }
      if (fort > 0 && S.towers.has(wallKey(x, y))) strength += stone ? 3 : 2;
    }
  }
  return strength;
}

// troopCap — how many soldiers the hold can field: a base watch, the garrison a
// barracks houses, the keep's muster, and the fort walls' strength (tier-weighted).
export function troopCap() {
  const barracks = S.game ? S.game.level('barracks') : 0;
  const keep = S.game ? Math.max(0, S.game.level('keep') - 1) : 0; // a grander keep musters more
  return 2 + barracks * 4 + fortStrength() + keep;
}

// wallPieceFor picks the fence sprite + rotation for a wall tile from its
// neighbor connectivity (n/s/e/w booleans — a gate neighbor counts as
// "connected" so the fence line reads continuous right up to the opening).
// Only h/v/tl/tr/post pieces exist in the atlas, so a bottom-side corner is
// a TOP corner rotated 180°: tl (connects E+S) flipped connects W+N; tr
// (connects W+S) flipped connects E+N.
export function wallPieceFor(n, s, e, w) {
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
export function renderWalls() {
  // One-time heal for holds saved BEFORE wallBlocked existed: scrub any wall
  // tile now sitting on a farm/vein/shore (obstacles are all placed by first
  // render — see boot). New segments already build around them at lay time.
  if (!S.wallsPruned && S.booted) {
    S.wallsPruned = true;
    let pruned = 0;
    for (const key of [...S.walls]) {
      const [tx, ty] = key.split(',').map(Number);
      if (wallBlocked(tx, ty)) { S.walls.delete(key); pruned++; }
    }
    if (pruned) { S.wallsVersion++; saveWalls(); }
  }
  if (S.wallsRendered === S.wallsVersion) return;
  S.wallsRendered = S.wallsVersion;
  for (const s of S.wallSprites) { S.entities.removeChild(s); s.destroy(); }
  S.wallSprites = [];
  const connected = (x, y) => S.walls.has(wallKey(x, y)) || S.gates.has(wallKey(x, y));
  const add = (tex, tx, ty, rot, tint) => {
    const s = new Sprite(tex); s.anchor.set(0.5, 0.5);
    s.x = tx * TILE + TILE / 2; s.y = ty * TILE + TILE / 2; s.rotation = rot;
    if (tint != null) s.tint = tint;
    s.zIndex = (ty + 1) * TILE;
    S.entities.addChild(s); S.wallSprites.push(s);
  };
  for (const key of S.walls) {
    const [tx, ty] = key.split(',').map(Number);
    const { tex, rot } = wallPieceFor(connected(tx, ty - 1), connected(tx, ty + 1), connected(tx + 1, ty), connected(tx - 1, ty));
    add(tex, tx, ty, rot, WALL_TINT[S.wallKind.get(key)]); // fence → no tint; wood/stone tinted sturdier (real art TBD)
  }
  // A gate is a tinted post (gold, matching the trader/coin pip elsewhere) —
  // visibly a structure, but distinct from a plain wall post, and it's NOT
  // in S.walls so findPath's passability check lets folk straight through.
  for (const key of S.gates) {
    const [tx, ty] = key.split(',').map(Number);
    add(S.atlas.fence.post, tx, ty, 0, 0xf2c14e);
  }
  // Watchtowers — whole-image sprites, base-anchored so they y-sort with folk.
  for (const s of S.towerSprites) { S.entities.removeChild(s); s.destroy(); }
  S.towerSprites = [];
  const towerTex = S.atlas.images && S.atlas.images.tower;
  if (towerTex) for (const key of S.towers) {
    const [tx, ty] = key.split(',').map(Number);
    const s = new Sprite(towerTex); s.anchor.set(0.5, 1);
    s.scale.set(2.0 * TILE / towerTex.width);   // ~2 tiles wide (was 2.6 — a touch smaller)
    s.x = tx * TILE + TILE / 2; s.y = (ty + 1) * TILE; s.zIndex = (ty + 1) * TILE;
    S.entities.addChild(s); S.towerSprites.push(s);
  }
}

// wood = timber-brown, stone = grey; fence stays the atlas's natural colour.
const WALL_TINT = { wood: 0x9c6b3a, stone: 0x9aa0a8 };
