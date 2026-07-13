// fx.js — the town's one particle/effect system. Every burst, spark, emote,
// poof, and pulse routes through emit() into a single pool stepped once per
// frame (stepFx, called from onFrame) — instead of each effect running its own
// requestAnimationFrame loop.
import { Graphics } from 'pixi.js';
import { S } from './state.js';

const parts = [];
const rand = (m) => (Math.random() - 0.5) * 2 * m;

// emit spawns o.n particles at (o.x,o.y). Motion: vx = ±hspread, vy = -rise ±
// vspread, plus gravity. Look: a filled dot (default), a square (chips), or a
// growing ring (pulses); tinted o.color (or an array of colours, cycled) and
// fading over o.life seconds. `spread` jitters the start point; `grow` the size.
export function emit(o) {
  const n = o.n || 1;
  for (let i = 0; i < n; i++) {
    const g = new Graphics(); g.zIndex = 2e7; S.entities.addChild(g);
    const p = {
      gfx: g, x: (o.x || 0) + rand(o.spread || 0), y: (o.y || 0) + rand(o.spread || 0),
      vx: rand(o.hspread || 0), vy: -(o.rise || 0) + rand(o.vspread || 0),
      grav: o.gravity || 0, life: o.life || 1, age: 0, size: o.size || 2, grow: o.grow || 0,
      ring: !!o.ring, sq: !!o.square, a0: o.alpha ?? 1,
      color: Array.isArray(o.color) ? o.color[i % o.color.length] : (o.color ?? 0xffffff),
    };
    parts.push(p); draw(p);
  }
}

function draw(p) {
  const t = p.age / p.life, a = p.a0 * (1 - t), r = p.size + p.grow * p.age;
  p.gfx.clear();
  if (p.ring) p.gfx.circle(0, 0, r).stroke({ width: Math.max(0.4, 2.2 * (1 - t)), color: p.color, alpha: a });
  else if (p.sq) p.gfx.rect(-r, -r, r * 2, r * 2).fill({ color: p.color, alpha: a });
  else p.gfx.circle(0, 0, r).fill({ color: p.color, alpha: a });
  p.gfx.x = p.x; p.gfx.y = p.y;
}

// stepFx advances the whole pool one frame — the single loop that replaces every
// per-particle rAF. Dead particles are destroyed and dropped.
export function stepFx(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]; p.age += dt;
    if (p.age >= p.life) { S.entities.removeChild(p.gfx); p.gfx.destroy(); parts.splice(i, 1); continue; }
    p.vy += p.grav * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    draw(p);
  }
}
