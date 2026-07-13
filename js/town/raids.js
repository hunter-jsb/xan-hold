// raids.js — live raid waves. When game.js decides a raid (stepRaids sets
// S.game.raidWave), town.js spawns a wave here: raiders path to the core, and
// findPath routes them around the walls and THROUGH the gates — so a gated wall
// funnels them to a chokepoint the muster can hold. Soldiers intercept and cut
// them down; any raider that reaches the stores loots (S.game.applyRaidLoss) and
// flees. So walls + muster + pathing decide the damage, not a die roll.
import { Container, AnimatedSprite } from 'pixi.js';
import { TILE } from './atlas.js';
import { S } from './state.js';
import { CENTER_TX, CENTER_TY, TOWN_W, TOWN_H, ROLE } from './constants.js';
import { goTo } from './pathfind.js';
import { pushChronicle } from './hud.js';

const RAIDER_TINT = 0x9a2a2a;     // dark blood-red — reads as an enemy against the folk
const ENGAGE = 12;                // px reach at which a soldier and raider clash
const CORE_PX = () => ({ x: CENTER_TX * TILE, y: CENTER_TY * TILE });

export function raidActive() { return !!(S.raiders && S.raiders.length); }

// nearestRaider — the closest living raider to (px,py), for soldier targeting.
export function nearestRaider(px, py) {
  let best = null, bd = Infinity;
  for (const r of (S.raiders || [])) {
    if (r.dead) continue;
    const d = (r.x - px) ** 2 + (r.y - py) ** 2;
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}

// spawnRaidWave sends `n` raiders in from the map edges, each pathing to the core.
export function spawnRaidWave(n, bite) {
  if (!S.raiders) S.raiders = [];
  S.raidBite = bite || 0.3;
  S.raidStats = { killed: 0, breached: 0, taken: {} }; // tallied over the wave, chronicled ONCE at the end
  for (const _ of Array(n)) S.raiders.push(makeRaider());
  S.alarm = 1.5;
  pushChronicle(`⚔ A raiding band descends on ${S.hold.name}!`, 'raid');
}

function edgePoint() {
  switch (Math.floor(Math.random() * 4)) {
    case 0: return { x: Math.random() * TOWN_W, y: 0 };
    case 1: return { x: Math.random() * TOWN_W, y: TOWN_H - 1 };
    case 2: return { x: 0, y: Math.random() * TOWN_H };
    default: return { x: TOWN_W - 1, y: Math.random() * TOWN_H };
  }
}

function makeRaider() {
  const e = edgePoint(), c = new Container();
  const a = new AnimatedSprite(S.atlas.walk.down);
  a.anchor.set(0.5, 1); a.animationSpeed = 0.16; a.tint = RAIDER_TINT; a.play();
  c.addChild(a); c.anim = a;
  c.x = e.x * TILE; c.y = e.y * TILE; c.zIndex = c.y;
  c.hp = 2.5 + Math.random(); c.dead = false; c.dir = 'down'; c.spawnedAt = Date.now();
  S.entities.addChild(c);
  const core = CORE_PX(); goTo(c, core.x, core.y);   // around walls, through gates
  return c;
}

function killRaider(r) { r.dead = true; S.entities.removeChild(r); r.destroy({ children: true }); }

// moveRaider walks a raider along its cached path toward the core, re-pathing
// (throttled by goTo's idle on a sealed route) when it has none.
function moveRaider(r, dt) {
  if (!r.path || !r.path.length) {
    r.idle = (r.idle || 0) - dt;
    if (r.idle <= 0) { const core = CORE_PX(); goTo(r, core.x, core.y); }
    return;
  }
  const wp = r.path[0], dx = wp.x - r.x, dy = wp.y - r.y, d = Math.hypot(dx, dy), sp = 20 * dt;
  if (d < sp) { r.x = wp.x; r.y = wp.y; r.path.shift(); }
  else { r.x += (dx / d) * sp; r.y += (dy / d) * sp; }
  r.zIndex = r.y;
  const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  if (dir !== r.dir) { r.dir = dir; r.anim.textures = S.atlas.walk[dir]; r.anim.play(); }
}

// stepRaid advances the wave each frame: soldiers within reach cut a raider
// down (it halts to fight — so the clash concentrates wherever the walls
// channel them); an unengaged raider presses on and, on reaching the stores,
// loots a share and flees. A raider that can't break in retreats after a while.
export function stepRaid(dt) {
  if (!S.raiders || !S.raiders.length) return;
  const soldiers = S.villagers.filter((v) => v.role === ROLE.SOLDIER);
  const core = CORE_PX();
  const st = S.raidStats || (S.raidStats = { killed: 0, breached: 0, taken: {} });
  for (const r of S.raiders) {
    if (r.dead) continue;
    if (Date.now() - r.spawnedAt > 45000) { killRaider(r); continue; }  // couldn't break in — retreat
    const fighting = soldiers.some((s) => Math.hypot(s.x - r.x, s.y - r.y) < ENGAGE);
    if (fighting) {
      r.hp -= 1.6 * dt;
      if (r.hp <= 0) { killRaider(r); st.killed++; }
      continue;                                                          // halted while it fights
    }
    moveRaider(r, dt);
    if (Math.hypot(r.x - core.x, r.y - core.y) < 3.5 * TILE) {           // reached the stores — loot + flee
      const { taken } = S.game.applyRaidLoss((S.raidBite || 0.3) * 0.5);
      st.breached++;
      for (const [k, v] of Object.entries(taken)) st.taken[k] = (st.taken[k] || 0) + v;
      killRaider(r);
    }
  }
  S.raiders = S.raiders.filter((r) => !r.dead);
  // The whole clash is chronicled as ONE line when the wave ends — not a line
  // per kill/breach every frame (that flooded the panel).
  if (!S.raiders.length && S.raidWasActive) {
    const parts = Object.entries(st.taken).map(([k, v]) => `${v} ${k}`);
    let msg = st.breached ? `The raid broke through — carried off ${parts.join(', ') || 'little'}` : 'The raid was thrown back from the walls';
    if (st.killed) msg += `; ${st.killed} raider${st.killed === 1 ? '' : 's'} cut down`;
    pushChronicle(msg + '.', st.breached ? 'raid' : 'note');
  }
  S.raidWasActive = S.raiders.length > 0;
}
