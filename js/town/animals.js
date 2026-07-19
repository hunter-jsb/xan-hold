// animals.js — wild animals wander in from the map edges, amble the land, and
// either move on or make a home here. Ambient life for now: no biting, no
// pens — that comes later. Species are weighted by the hold's REAL geography
// (a forest seat hosts deer and boar, a scorched plateau gets snakes, the far
// north polar bears), and they path with findPath like everyone else — so
// walls and gates are already real to them, before any crop-raiding exists.
import { Sprite } from 'pixi.js';
import { TILE } from './atlas.js';
import { S } from './state.js';
import { TOWN_W, TOWN_H } from './constants.js';
import { goTo, walkPath } from './pathfind.js';
import { pushChronicle } from './hud.js';

const forestish = (h) => /forest|wood|cradle|grove/.test(h.region || '');
const hillish = (h) => /hill|mount|plateau|highland|crag/.test(h.region || '');

// Which beast the land calls: weight 0 = never here. `tex` picks the palette
// (polar bears in the frozen north, sun-tan snakes in the hottest wastes).
const SPECIES = {
  deer: { speed: 26, weight: (h) => (forestish(h) ? 2.6 : 0.7) * (h.warmth < 0.85 ? 1 : 0.3) },
  fawn: { speed: 24, weight: () => 0 },   // never rolls on its own — arrives at a deer's side
  rabbit: { speed: 30, weight: (h) => (h.warmth > 0.15 && h.warmth < 0.8 ? 1.6 : 0.3) },
  goat: { speed: 20, weight: (h) => (hillish(h) ? 1.4 : 0.15) },
  raccoon: { speed: 22, weight: () => 0.4 },
  boar: {
    speed: 16, weight: (h) => (forestish(h) ? 1.4 : hillish(h) ? 0.5 : 0.25),
    arrive: '🐗 A wild boar comes rooting out of the brush.',
  },
  bear: {
    speed: 14, weight: (h) => ((forestish(h) || hillish(h)) ? 0.55 : 0.1) * (h.warmth < 0.6 ? 1 : 0.4),
    tex: (h) => (h.warmth < 0.18 ? 'bear_polar' : hillish(h) ? 'bear_black' : 'bear'),
    arrive: '🐻 A bear has come down from the wilds.',
    settle: '🐻 The bear has denned nearby.',
  },
  snake: {
    speed: 10, weight: (h) => (h.warmth > 0.55 ? 1.3 : 0.1),
    tex: (h) => (h.warmth > 0.75 ? 'snake_tan' : 'snake'),
  },
};

// How many wild things this land carries at once — wilder country, more life.
const herdCap = () => 3 + (forestish(S.hold) ? 3 : 1);

const openTile = (tx, ty) => tx >= 0 && ty >= 0 && tx < TOWN_W && ty < TOWN_H && !S.water.has(`${tx},${ty}`);

function edgePoint() {
  for (let i = 0; i < 8; i++) {          // few tries to miss the water
    const r = Math.random(), side = Math.floor(Math.random() * 4);
    const p = [
      { x: Math.floor(r * TOWN_W), y: 0 }, { x: Math.floor(r * TOWN_W), y: TOWN_H - 1 },
      { x: 0, y: Math.floor(r * TOWN_H) }, { x: TOWN_W - 1, y: Math.floor(r * TOWN_H) },
    ][side];
    if (openTile(p.x, p.y)) return p;
  }
  return { x: 0, y: 0 };
}

// A wander target: near the anchor for a settled beast, anywhere open otherwise.
function roamPoint(a) {
  for (let i = 0; i < 8; i++) {
    const tx = a.home ? a.home.tx + Math.floor(Math.random() * 9) - 4 : Math.floor(Math.random() * TOWN_W);
    const ty = a.home ? a.home.ty + Math.floor(Math.random() * 9) - 4 : Math.floor(Math.random() * TOWN_H);
    if (openTile(tx, ty)) return { tx, ty };
  }
  return null;
}

function pickSpecies() {
  const pool = Object.entries(SPECIES).map(([k, sp]) => [k, sp.weight(S.hold)]).filter(([, w]) => w > 0.05);
  let x = Math.random() * pool.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of pool) if ((x -= w) <= 0) return k;
  return pool.length ? pool[0][0] : 'rabbit';
}

function makeAnimal(kind, tx, ty, settled) {
  const sp = SPECIES[kind];
  const s = new Sprite(S.atlas.animals[(sp.tex && sp.tex(S.hold)) || kind]);
  s.anchor.set(0.5, 1);
  s.x = tx * TILE + TILE / 2; s.y = (ty + 1) * TILE; s.zIndex = s.y;
  s.kind = kind; s.dead = false; s.bobT = Math.random() * 9;
  s.state = settled ? 'settled' : 'roam';
  s.home = settled ? { tx, ty } : null;
  s.decideAt = Date.now() + (40 + Math.random() * 110) * 1000;
  s.idle = Math.random() * 3;
  S.entities.addChild(s);
  S.animals.push(s);
  return s;
}

// spawnAnimal — a resident starts already at home somewhere open; a visitor
// walks in from an edge. Deer sometimes bring a fawn that keeps to their side.
function spawnAnimal(resident) {
  const kind = pickSpecies(), sp = SPECIES[kind];
  let a;
  if (resident) {
    const p = roamPoint({ home: null });
    if (!p) return;
    a = makeAnimal(kind, p.tx, p.ty, true);
  } else {
    const e = edgePoint();
    a = makeAnimal(kind, e.x, e.y, false);
    if (sp.arrive) pushChronicle(sp.arrive, 'note');
  }
  if (kind === 'deer' && Math.random() < 0.4) {
    const f = makeAnimal('fawn', Math.round(a.x / TILE), Math.round(a.y / TILE) - 1, a.state === 'settled');
    f.leader = a;
  }
  return a;
}

function despawn(a) {
  a.dead = true;
  S.entities.removeChild(a); a.destroy();
}

// The beast makes up its mind: strange land is judged by how well it suits the
// species (the same geography weight) — good country, it settles; poor country,
// it moves on. A settled one occasionally uproots and leaves anyway.
function decide(a) {
  a.decideAt = Date.now() + (50 + Math.random() * 120) * 1000;
  const sp = SPECIES[a.kind];
  if (a.state === 'roam') {
    if (Math.random() < Math.min(0.65, sp.weight(S.hold) * 0.3)) {
      a.state = 'settled';
      a.home = { tx: Math.round(a.x / TILE), ty: Math.round(a.y / TILE) - 1 };
      if (sp.settle) pushChronicle(sp.settle, 'note');
    } else {
      a.state = 'leaving';
      const e = edgePoint(); goTo(a, e.x * TILE + TILE / 2, e.y * TILE + TILE / 2);
    }
  } else if (a.state === 'settled' && Math.random() < 0.15) {
    a.state = 'leaving'; a.home = null;
    const e = edgePoint(); goTo(a, e.x * TILE + TILE / 2, e.y * TILE + TILE / 2);
  }
}

export function initAnimals() {
  S.animals = [];
  S.animalClock = 25 + Math.random() * 50;
  // The land had its beasts long before the folk came.
  const n = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) spawnAnimal(true);
}

export function stepAnimals(dt) {
  if (!S.animals) return;
  S.animalClock -= dt;
  if (S.animalClock <= 0) {
    S.animalClock = 50 + Math.random() * 100;
    if (S.animals.length < herdCap()) spawnAnimal(false);
  }
  let cull = false;
  for (const a of S.animals) {
    if (a.dead) { cull = true; continue; }
    // Ambient life must NEVER freeze the world: this runs in the render
    // ticker, where one uncaught throw kills every frame after it. A beast
    // that errors is culled, the rest carry on. (Same creed as executeOrders.)
    try { stepAnimal(a, dt); } catch (e) { console.error('[animals] culled', a.kind, e); despawn(a); cull = true; }
  }
  if (cull) S.animals = S.animals.filter((x) => !x.dead);
}

function stepAnimal(a, dt) {
  const wasX = a.x;
  if (walkPath(a, SPECIES[a.kind].speed, dt)) {
    if (a.x > wasX + 0.01) a.scale.x = 1;        // art faces right
    else if (a.x < wasX - 0.01) a.scale.x = -1;
    a.bobT += dt; a.rotation = Math.sin(a.bobT * 9) * 0.05;  // a little gait
    return;
  }
  a.rotation = 0;
  if (a.state === 'leaving') { despawn(a); return; }
  if (a.leader && (a.leader.dead || a.leader.state === 'leaving')) {  // a fawn follows its deer out
    a.state = 'leaving'; a.leader = null;
    const e = edgePoint(); goTo(a, e.x * TILE + TILE / 2, e.y * TILE + TILE / 2);
    return;
  }
  a.idle -= dt;
  if (a.idle > 0) return;
  a.idle = 2 + Math.random() * 5;                 // graze a moment between ambles
  if (Date.now() > a.decideAt) decide(a);
  if (a.state !== 'leaving') {
    const anchor = a.leader && a.leader.home ? { home: a.leader.home } : a;
    const p = roamPoint(a.state === 'settled' || a.leader ? anchor : { home: null });
    if (p) goTo(a, p.tx * TILE + TILE / 2, (p.ty + 1) * TILE);
  }
}
