// villagers.js — the folk: role weighting + assignment, spawn/despawn, targeting,
// hauling, tree-felling, the per-frame step, and population sync.
import { Sprite, AnimatedSprite, Graphics, Container } from 'pixi.js';
import { TILE } from './atlas.js';
import { S, isRaided } from './state.js';
import { PLOT, CENTER_TX, CENTER_TY, BUILD_RATE, ROLE, ROLE_TINT, ROLE_PIP, DIR } from './constants.js';
import { plotCenterPx } from './coords.js';
import { goTo } from './pathfind.js';
import { nearestNode, STONE_KIND } from './terrain.js';
import { nearestSite, finalizeSite } from './buildings.js';
import { troopCap } from './walls.js';
import { raidActive, nearestRaider } from './raids.js';
import { emit } from './fx.js';

// ---- villagers ------------------------------------------------------
export function roleWeights() {
  const g = S.game, w = { villager: 1 };
  w.farmer = g.level('farm') + g.level('wharf');
  w.woodcutter = g.level('sawmill');
  w.miner = g.level('mine') + g.level('quarry');
  w.trader = g.level('market');
  // A baseline so building never fully stalls for want of hands; more sites
  // awaiting builders pulls a bigger share of the folk onto the work.
  w.builder = 1 + S.sites.length * 4;
  w.soldier = troopCap() + (isRaided() ? 3 : 0); // the folk muster up to the hold's troop capacity (barracks + fort spans)
  w.speaker = 1 + g.level('reliquary') * 2; // always at least one; reliquaries raise more
  return Object.entries(w).filter(([, v]) => v > 0);
}

export function pickRole() {
  const ws = roleWeights();
  const total = ws.reduce((a, [, v]) => a + v, 0);
  let r = Math.random() * total;
  for (const [role, v] of ws) { if ((r -= v) <= 0) return role; }
  return ROLE.VILLAGER;
}

// setRole re-trains a standing villager into another trade — the town's needs
// shift as it grows (a mine opens, sites pile up), but folk only ever CHOSE a
// role at spawn (pickRole), so without this a hold at its pop cap could hold no
// builders at all and its build queue would freeze forever. Drops the old
// job's claim/site seat, restyles the sprite (tint + role pip), and sends the
// villager off to work its new trade at once.
export function setRole(v, role) {
  if (v.role === role) return;
  releaseClaim(v);
  v.role = role;
  v.workNode = null; v.targetNode = null; v.workSite = null; v.targetSite = null;
  v.working = false; v.haulTarget = null; v.idle = 0;
  if (v.anim) v.anim.tint = ROLE_TINT[role] || 0xffffff;
  if (v.pip) { v.removeChild(v.pip); v.pip.destroy(); v.pip = null; }
  const pipCol = ROLE_PIP[role];
  if (pipCol != null) {
    v.pip = new Graphics().circle(0, -25, 2.4).fill(pipCol).stroke({ width: 1, color: 0x14140f, alpha: 0.7 });
    v.addChild(v.pip);
  }
  resolveHome(v);
  pickTarget(v);
}

// rebalanceRoles nudges the STANDING workforce toward what the hold needs right
// now (roleWeights) — one re-training every few seconds, from the most
// over-staffed trade to the most short-staffed. This is what keeps a capped-pop
// hold from stalling: when build sites appear, roleWeights spikes `builder`, so
// the shortfall is builders and an idle villager gets conscripted. Gentle
// (one at a time, throttled, prefers folk not mid-task) so the streets don't
// churn with folk swapping hats every frame.
export function rebalanceRoles() {
  const now = Date.now();
  if (now - (S.lastRebalance || 0) < 2500) return;
  S.lastRebalance = now;
  const n = S.villagers.length;
  if (n < 2) return;
  const ws = roleWeights();
  const total = ws.reduce((a, [, v]) => a + v, 0);
  if (total <= 0) return;
  const want = {}; for (const [role, w] of ws) want[role] = (w / total) * n;
  const have = {}; for (const v of S.villagers) have[v.role] = (have[v.role] || 0) + 1;
  // most short-staffed role (biggest want-minus-have), needing ~a full head
  let needRole = null, needGap = 0.85;
  for (const [role, w] of Object.entries(want)) {
    const gap = w - (have[role] || 0);
    if (gap > needGap) { needGap = gap; needRole = role; }
  }
  if (!needRole) return;
  // most over-staffed role (biggest have-minus-want) to draw a hand from
  let giveRole = null, giveGap = 0.5;
  for (const [role, cnt] of Object.entries(have)) {
    const gap = cnt - (want[role] || 0);
    if (gap > giveGap) { giveGap = gap; giveRole = role; }
  }
  if (!giveRole || giveRole === needRole) return;
  const cand = S.villagers.find((v) => v.role === giveRole && !v.working && !v.haulTarget)
    || S.villagers.find((v) => v.role === giveRole);
  if (cand) setRole(cand, needRole);
}

export function spawnVillager() {
  const v = new Container();
  const role = pickRole();
  const anim = new AnimatedSprite(S.atlas.walk.down);
  anim.anchor.set(0.5, 1); anim.animationSpeed = 0.14;
  anim.tint = ROLE_TINT[role] || 0xffffff;
  anim.play();
  v.anim = anim; v.addChild(anim);
  v.pip = null;
  const pipCol = ROLE_PIP[role];
  if (pipCol != null) {
    v.pip = new Graphics().circle(0, -25, 2.4).fill(pipCol).stroke({ width: 1, color: 0x14140f, alpha: 0.7 });
    v.addChild(v.pip);
  }
  v.role = role; v.dir = DIR.DOWN; v.moving = false; v.idle = 0;
  v.home = null; v.haulTarget = null; v.liege = null; // assignment model seed (see resolveHome + assignFealty)
  const start = homeSpawnPoint();
  v.x = start.x; v.y = start.y; v.zIndex = v.y;
  resolveHome(v);
  pickTarget(v);
  S.entities.addChild(v);
  S.villagers.push(v);
}

export function despawnVillager() {
  const v = S.villagers.pop();
  if (!v) return;
  releaseClaim(v);
  v.haulTarget = null; v.home = null;
  const rec = S.highlightRings.get(v); // don't leak a ring for a villager that's gone
  if (rec) { S.entities.removeChild(rec.gfx); rec.gfx.destroy(); S.highlightRings.delete(v); }
  S.entities.removeChild(v); v.destroy({ children: true });
}

export function randomTownPoint() {
  // Wander among built plots, but never stand on the keep's doorway.
  const used = [...S.usedPlots].filter((k) => k !== S.keepKey).map((k) => k.split(',').map(Number));
  const p = used.length ? used[(Math.random() * used.length) | 0] : [S.plots[1].px, S.plots[1].py];
  return { x: (p[0] * PLOT + 1 + Math.random() * 2) * TILE, y: (p[1] * PLOT + 1 + Math.random() * 2) * TILE };
}

// homeSpawnPoint — new folk emerge from a Longhouse (their home), jittered a
// little; fall back to the keep's centre if none is built yet.
export function homeSpawnPoint() {
  const homes = [];
  // A longhouse still under construction (S.siteKeys) isn't home yet — folk
  // shouldn't spawn out of an empty foundation.
  for (const [k, rec] of S.placed) if (k.startsWith('longhouse#') && !S.siteKeys.has(k) && rec.plot && rec.plot.px != null) homes.push(rec.plot);
  if (!homes.length) return { x: CENTER_TX * TILE, y: CENTER_TY * TILE };
  const p = homes[(Math.random() * homes.length) | 0];
  const c = plotCenterPx(p.px, p.py);
  return { x: c.x + (Math.random() - 0.5) * TILE * 2, y: c.y + (Math.random() - 0.5) * TILE * 2 };
}

// A worker holds a claim on the single exhaustible node (a tree) it's walking
// to or toiling — release it so no other woodcutter targets the same trunk.
// A builder's claim on a construction site works the same way, except it's
// not exclusive (site.builders is a Set — see nearestSite/finalizeSite).
export function releaseClaim(v) {
  const n = v.workNode || v.targetNode;
  if (n && n.claimedBy === v) n.claimedBy = null;
  const s = v.workSite || v.targetSite;
  if (s && s.builders) s.builders.delete(v);
}


export function pickTarget(v) {
  if (v.role === ROLE.SOLDIER && raidActive()) {
    // Intercept the nearest raider — the folk FIGHT the wave (see raids.js),
    // meeting them wherever the walls funnel them (toward the gates).
    const r = nearestRaider(v.x, v.y);
    if (r) { goTo(v, r.x, r.y); return; }
  }
  if (v.role === ROLE.SOLDIER && isRaided()) {
    // Alarm up but no wave yet — muster at the wall ring near the town centre.
    const a = Math.random() * Math.PI * 2;
    goTo(v, (CENTER_TX + Math.cos(a) * 13) * TILE, (CENTER_TY + Math.sin(a) * 11) * TILE);
    return;
  }
  // Builders make the same kind of work trip as a miner/woodcutter, just to
  // a construction site instead of a resource node (see nearestSite) — and
  // unlike a tree/vein, several builders may share one (site.builders is a
  // Set, not a single claimedBy).
  if (v.role === ROLE.BUILDER) {
    releaseClaim(v);
    const site = nearestSite(v.x, v.y);
    if (site) { v.targetSite = site; site.builders.add(v); goTo(v, site.x, site.y); }
    else { v.targetSite = null; const t = randomTownPoint(); goTo(v, t.x, t.y); }
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

// workEffect — sparks fly when a node is being worked (mining/chopping).
export function workEffect(node) {
  emit({ x: node.x, y: node.y - 8, n: 5, color: 0xfff2c0, spread: 5, hspread: 11, rise: 14, vspread: 10, life: 0.48, size: 1.4 });
}

// nearestBuilding returns the pixel centre AND S.hittable entry (`ref`) of the
// closest placed building of `type` (sawmill, mine, reliquary…), or null.
// `ref` is what an assignment (v.home / v.haulTarget) points at.
export function nearestBuilding(type, px, py) {
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
export function resolveHome(v) {
  if (v.role !== ROLE.SPEAKER) { v.home = null; return; }
  if (v.home) return; // already linked
  const h = nearestBuilding('reliquary', v.x, v.y);
  v.home = h ? h.ref : null; // no reliquary yet — retried next reconcile
}

// fellTree clears a felled wood node: destroy its tree sprites, drop it from
// the node list, and throw a burst of wood-chips. Guarded against double-fell.
export function fellTree(node) {
  if (!node || node.felled) return;
  node.felled = true;
  for (const s of (node.sprites || [])) { S.entities.removeChild(s); s.destroy(); }
  const i = S.woodNodes.indexOf(node);
  if (i >= 0) S.woodNodes.splice(i, 1);
  chipBurst(node.x, node.y);
}

export function chipBurst(x, y) {
  emit({ x, y: y - 8, n: 6, color: 0x8a5a2b, square: true, spread: 5, hspread: 10, rise: 12, vspread: 9, gravity: 40, life: 0.54, size: 1 });
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
    // metal/gem chunk (coal/tin/copper/iron/jade/amethyst/gold/bloodstone/
    // forgeStone), which keeps the old, larger size.
    scale: (node) => STONE_KIND.has(node.kind) ? 0.38 : 0.55,
    dx: 3, dy: -18, workMin: 3, workRange: 3,
  },
};

// startHaul attaches the carried-commodity sprite and sends the worker home
// to the nearest matching building; deliverCommodity drops it there.
export function startHaul(v, cfg, node) {
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

export function deliverCommodity(v) {
  if (v.carrySprite) { v.removeChild(v.carrySprite); v.carrySprite.destroy(); v.carrySprite = null; }
  v.hauling = false;
  v.haulTarget = null; // delivered — the temp assignment ends
}


export function stepVillager(v, dt) {
  if (!v.moving) {
    if (v.workSite) {                  // a builder toiling a site — continuous progress, not a fixed timer
      const site = v.workSite;
      if (site.done) { v.workSite = null; v.working = false; pickTarget(v); return; } // someone else finished it first
      site.progress = Math.min(1, site.progress + BUILD_RATE * dt); // more builders on it → more calls like this one each frame → faster
      site.container.alpha = site.progress;
      v.idle -= dt;
      if (v.idle <= 0) { workEffect(site); v.idle = 0.6 + Math.random() * 0.8; } // periodic sparks, purely cosmetic
      if (site.progress >= 1) finalizeSite(site);
      return;
    }
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
  const worker = !!CARRY[v.role] || v.role === ROLE.BUILDER;
  const speed = (v.role === ROLE.SOLDIER && isRaided() ? 34 : worker ? 24 : 18) * dt;
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
    } else if (v.targetSite) {         // reached the construction site — start toiling (or it's already done)
      const site = v.targetSite; v.targetSite = null;
      if (site.done) { v.idle = 0; }
      else { v.working = true; v.workSite = site; v.idle = 0.6 + Math.random() * 0.8; }
    } else {                           // arrived home / at the mill, or just wandering
      if (v.hauling) deliverCommodity(v);
      v.idle = 0.8 + Math.random() * 2.5;
    }
    return;
  }
  v.x += (dx / dist) * speed; v.y += (dy / dist) * speed;
  const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? DIR.RIGHT : DIR.LEFT) : (dy > 0 ? DIR.DOWN : DIR.UP);
  if (dir !== v.dir) { v.dir = dir; v.anim.textures = S.atlas.walk[dir]; v.anim.play(); }
  v.zIndex = v.y;
}


export function reconcileVillagers() {
  const want = Math.min(70, Math.max(3, Math.floor(S.game.pop)));
  while (S.villagers.length < want) spawnVillager();
  while (S.villagers.length > want) despawnVillager();
  for (const v of S.villagers) resolveHome(v); // re-link speakers as roles/buildings change
  rebalanceRoles(); // re-train standing folk toward current need (esp. builders for new sites)
  assignFealty();   // each pop swears to one speaker; the head keeps parishes balanced
}

// ---- speaker fealty --------------------------------------------------
// Each pop swears to ONE speaker (v.liege) — the mortal who relays the god's
// will to them. The HEAD speaker (the first) keeps the parishes balanced, so
// the workforce splits roughly evenly among the speakers; the Will audits the
// split (see will.js). S.parishSizes carries the sizes for the HUD + the Will.
export function speakerVillagers() { return S.villagers.filter((v) => v.role === ROLE.SPEAKER); }

export function assignFealty() {
  const speakers = speakerVillagers();
  if (!speakers.length) { for (const v of S.villagers) v.liege = null; S.parishSizes = []; return; }
  const flock = S.villagers.filter((v) => v.role !== ROLE.SPEAKER);
  const parish = new Map(speakers.map((s) => [s, 0]));
  const cap = Math.ceil(flock.length / speakers.length);   // the head speaker's even-split mandate
  const need = [];
  for (const v of flock) {                                  // keep a standing oath if the parish has room
    if (v.liege && parish.has(v.liege) && parish.get(v.liege) < cap) parish.set(v.liege, parish.get(v.liege) + 1);
    else need.push(v);
  }
  for (const v of need) {                                   // reassign the rest to the smallest parish
    let best = speakers[0], bd = Infinity;
    for (const s of speakers) { const n = parish.get(s); if (n < bd) { bd = n; best = s; } }
    v.liege = best; parish.set(best, parish.get(best) + 1);
  }
  S.parishSizes = speakers.map((s) => parish.get(s));       // head-speaker's distribution — audited by the Will
}
