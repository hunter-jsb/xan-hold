// harness-run.mjs — a stepping smoke test: march the engine through thousands
// of ticks across day AND season boundaries and assert nothing goes NaN,
// negative, or throws. The static verifier proves the modules LINK; this proves
// game.js RUNS. Run: node test/harness-run.mjs (repo root).
import fs from 'fs';
global.window = {};
eval(fs.readFileSync('js/game.js', 'utf8'));
const { Game, FOOD_CATS } = window.XANGAME;

// Control the clock so a short run still crosses days + seasons.
const realNow = Date.now.bind(Date);
let NOW = realNow();
Date.now = () => NOW;

const holds = [
  { name: 'Warm reach', warmth: 0.85, danger: 0.5, tierName: 'saltern', ancestry: 'Coastal', rich: { food: 0.6, timber: 0.2, stone: 0.3, ore: 0.2, salt: 0.8, coin: 0.4 }, n: { riverMax: 0.3, lake: 0.2, sea: 0.4 } },
  { name: 'Frigid march', warmth: 0.08, danger: 0.9, tierName: 'march', ancestry: 'Northern', rich: { food: 0.3, timber: 0.7, stone: 0.6, ore: 0.6, salt: 0.1, coin: 0.2 }, n: { riverMax: 0.1, lake: 0.05, sea: 0 } },
  { name: 'Mild seat', warmth: 0.5, danger: 0.0, tierName: 'seat', ancestry: 'cradle', rich: { food: 0.5, timber: 0.4, stone: 0.4, ore: 0.3, salt: 0.2, coin: 0.5 }, n: { riverMax: 0.2, lake: 0.1, sea: 0.1 } },
];

let fail = 0, checks = 0;
const bad = (msg) => { fail++; if (fail <= 20) console.log('  ✗ ' + msg); };
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

for (const base of holds) {
  const hold = { id: base.name, realm: 'R', region: 'reg', ...base };
  const g = new Game(hold, null);
  g.res.timber = 500; g.res.stone = 400; g.res.coin = 500;
  for (const id of ['sawmill', 'quarry', 'mine', 'saltern', 'market', 'longhouse', 'granary', 'barracks', 'reliquary']) { g.build(id); g.build(id); }
  g.newFarm(); g.newFarm(); g.upgrade('keep', 0);

  const dt = 2;
  for (let i = 0; i < 2400; i++) {   // ~1.3 in-game years at dt=2
    NOW += dt * 1000;
    g.step(dt);
    checks++;
    for (const k of Object.keys(g.res)) if (!finite(g.res[k]) || g.res[k] < -1e-6) { bad(`${hold.name} res.${k}=${g.res[k]} @step ${i}`); break; }
    if (!finite(g.pop) || g.pop < 0) bad(`${hold.name} pop=${g.pop} @step ${i}`);
    if (!finite(g.warmthNow())) bad(`${hold.name} warmthNow NaN @step ${i}`);
    const r = g.rates(); for (const k of Object.keys(r)) if (!finite(r[k])) { bad(`${hold.name} rate.${k} NaN @step ${i}`); break; }
    if (i % 500 === 0) { const c = g.caps(); for (const k of FOOD_CATS) if (!finite(c[k]) || c[k] <= 0) bad(`${hold.name} cap.${k}=${c[k]} @step ${i}`); }
  }
  NOW += 6 * 3600 * 1000;
  g.catchUp();
  for (const k of Object.keys(g.res)) if (!finite(g.res[k]) || g.res[k] < -1e-6) bad(`${hold.name} post-catchUp res.${k}=${g.res[k]}`);
  if (!finite(g.pop) || g.pop < 0) bad(`${hold.name} post-catchUp pop=${g.pop}`);
  const g2 = new Game(hold, JSON.parse(JSON.stringify(g.serialize())));
  g2.step(2); if (!finite(g2.pop)) bad(`${hold.name} reload step pop NaN`);
}

Date.now = realNow;
console.log(fail ? `\n  ✗ ${fail} runtime problem(s) across ${checks} ticks` : `\n  ✓ engine ran ${checks} ticks across seasons — no NaN/negative/crash`);
process.exit(fail ? 1 : 0);
