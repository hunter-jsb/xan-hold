// pathfind.js — tile-grid BFS around walls/water, through gates. goTo caches the
// route on the villager; stepVillager just walks it.
import { TILE } from './atlas.js';
import { S } from './state.js';
import { TOWN_W, TOWN_H } from './constants.js';
import { wallKey, DIRS4 } from './coords.js';

// ---- pathing (route around walls, through gates) ---------------------
// findPath runs a tile-grid BFS from a pixel position to a destination pixel
// position, avoiding S.walls and S.water tiles (see placeWater) and passing
// freely through S.gates tiles. The town is ~96x72 = ~7k cells — cheap to
// search on a target PICK (not every frame). Returns a list of pixel
// waypoints to walk in order (the last one is the exact destination, not
// just a tile center), or null if no route exists at all (fully walled/
// watered off with no gate) so the caller can degrade gracefully instead of
// freezing or clipping through the wall.
export function findPath(px, py, tx, ty) {
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
export function goTo(v, x, y) {
  v.tx = x; v.ty = y;
  const path = findPath(v.x, v.y, x, y);
  if (!path) { v.moving = false; v.path = null; v.idle = 1 + Math.random() * 3; return; }
  v.path = path; v.moving = true;
}
