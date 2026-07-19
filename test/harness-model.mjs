// harness-model.mjs — headless proof of the engine model: per-instance levels
// (F2), the keep (F3), seasons (F4), morale/disease/starvation (F5). Loads
// js/game.js in a shimmed window and asserts the invariants, since the dev
// sandbox can't render. Run: node test/harness-model.mjs (repo root).
import fs from 'fs';
global.window = {};
eval(fs.readFileSync('js/game.js', 'utf8'));
const { Game, FOOD_CATS } = window.XANGAME;

const hold = {
  id: 'test', name: 'Testhold', realm: 'Realm', region: 'plains', tierName: 'seat', ancestry: 'cradle',
  rich: { food: 0.5, timber: 0.6, stone: 0.3, ore: 0.4, salt: 0.1, coin: 0.2 },
  warmth: 0.5, danger: 0, n: { riverMax: 0.2, lake: 0.1, sea: 0 },
};

let pass = 0, fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); (ok ? pass++ : fail++); if (!ok) console.log(`  ✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const ok = (name, cond) => { (cond ? pass++ : fail++); if (!cond) console.log(`  ✗ ${name}`); };

// ---- F2: build appends, upgrade deepens, level = sum -------------------
const g = new Game(hold, null);
g.res.timber = 1e4; g.res.coin = 1e4; g.res.stone = 1e4; g.res.ore = 1e4;
eq('fresh: no sawmill', g.count('sawmill'), 0);
g.build('sawmill');
eq('build#1 count', g.count('sawmill'), 1);
eq('build#1 level', g.level('sawmill'), 1);
g.build('sawmill');
eq('build#2 count', g.count('sawmill'), 2);
eq('build#2 level(sum)', g.level('sawmill'), 2);
g.upgrade('sawmill', 0);
eq('upgrade inst0 level', g.instanceLevel('sawmill', 0), 2);
eq('upgrade count unchanged', g.count('sawmill'), 2);
eq('upgrade total level', g.level('sawmill'), 3);
g.upgrade('sawmill', 0);
g.upgradeAny('sawmill');
eq('upgradeAny picks lowest', g.instances.sawmill, [3, 2]);
g.instances.sawmill = [6, 6];
ok('canUpgradeAny false at max', g.canUpgradeAny('sawmill') === false);
ok('upgradeAny false at max', g.upgradeAny('sawmill') === false);

// rates() invariant: [3] vs [1,1,1] give identical output
const a = new Game(hold, null); a.instances = { ...a.instances, sawmill: [3] };
const b = new Game(hold, null); b.instances = { ...b.instances, sawmill: [1, 1, 1] };
a.pop = b.pop = 8;
eq('rates invariant to split (timber)', Math.round(a.rates().timber * 1e6), Math.round(b.rates().timber * 1e6));
eq('level equal despite split', a.level('sawmill'), b.level('sawmill'));

// migration from an old pooled-lvl save
const saved = {
  res: { grain: 50, roots: 5, greens: 3, fruit: 0, fish: 0, timber: 40, stone: 20, ore: 5, salt: 3, coin: 25 },
  pop: 12, lvl: { sawmill: 3, longhouse: 2, mine: 2, farm: 2, market: 1, palisade: 3 },
  farmPlots: [], faith: 0, founded: Date.now(), log: [], raidClock: 100, lastTick: Date.now(),
};
const m = new Game(hold, saved);
ok('migrate: lvl deleted', m.lvl === undefined);
ok('migrate: has instances', !!m.instances);
eq('migrate sawmill total', m.level('sawmill'), 3);
eq('migrate sawmill count (round 3/1.5=2)', m.count('sawmill'), 2);
eq('migrate sawmill split', m.instances.sawmill, [2, 1]);
eq('migrate longhouse total', m.level('longhouse'), 2);
eq('migrate longhouse count', m.count('longhouse'), 2);
eq('migrate mine total', m.level('mine'), 2);
eq('migrate mine count (1:1)', m.count('mine'), 2);
eq('migrate market total', m.level('market'), 1);
eq('migrate palisade total (defense preserved)', m.level('palisade'), 3);
eq('migrate farm -> farmPlots', m.count('farm'), 2);
eq('migrate farm level = field count', m.level('farm'), 2);
ok('migrate: no farm key in instances', m.instances.farm === undefined);
ok('migrate: farm instanceLevel = size', m.instanceLevel('farm', 0) === m.farmPlots[0].size);
eq('defense reads palisade total', m.defense(), 3 * window.XANGAME.BY_ID.palisade.def + m.bon.defBonus);
ok('jobs counts prod totals', m.jobs() === m.level('sawmill') + m.level('mine') + m.level('market') + m.level('farm'));
const ser = m.serialize();
ok('serialize has instances', !!ser.instances);
ok('serialize has no lvl', ser.lvl === undefined);
const m2 = new Game(hold, JSON.parse(JSON.stringify(ser)));
eq('reload sawmill total', m2.level('sawmill'), 3);
eq('reload farm count', m2.count('farm'), 2);

// ---- F3: the keep as an upgradeable building ----------------------------
const k = new Game(hold, null);
k.res.timber = 1e4; k.res.stone = 1e4; k.res.coin = 1e4;
ok('keep exists at level 1', k.level('keep') === 1);
eq('keep defense 0 at L1 (no balance shift)', k.keepDef(), 0);
eq('keep pop 0 at L1 (no balance shift)', k.keepPop(), 0);
const pc0 = k.popCap(), def0 = k.defense();
k.upgrade('keep', 0);
ok('keep -> level 2', k.level('keep') === 2);
eq('keep defense +2 at L2', k.keepDef(), 2);
eq('keep pop +4 at L2', k.keepPop(), 4);
ok('popCap grew +4', k.popCap() === pc0 + 4);
ok('defense grew +2', k.defense() === def0 + 2);
const cnt = k.count('keep'); k.res.timber = 1e4; k.res.stone = 1e4; k.res.coin = 1e4;
k.build('keep');
ok('build(keep) adds no 2nd keep', k.count('keep') === cnt);
ok('build(keep) deepened instead', k.level('keep') === 3);
k.instances.keep = [4];
ok('keep caps at instanceMax 4', k.canUpgrade('keep', 0) === false);
ok('migrated save has a keep (L1)', m.level('keep') === 1);
ok('migrate defense still = palisade-only (keep L1 adds 0)', m.defense() === 3 * window.XANGAME.BY_ID.palisade.def + m.bon.defBonus);

// ---- F4: seasons + day/night warmth --------------------------------------
const s = new Game(hold, null);
ok('seasonName is one of four', ['Spring', 'Summer', 'Autumn', 'Winter'].includes(s.seasonName()));
ok('dayPartName is valid', ['Day', 'Night', 'Dawn', 'Dusk'].includes(s.dayPartName()));
eq('warmthNow(offline) = baseline', s.warmthNow(true), Math.max(0, Math.min(1, hold.warmth)));
ok('seasonWarmthDelta within amp', Math.abs(s.seasonWarmthDelta()) <= window.XANGAME.CFG.seasonWarmthAmp + 1e-9);
ok('warmthNow in [0,1]', s.warmthNow() >= 0 && s.warmthNow() <= 1);
ok('rates(offline) grain finite', Number.isFinite(s.rates(true).grain));
const cold = new Game({ ...hold, warmth: 0.2 }, null);
ok('warmthNow shifts by the season delta', Math.abs((cold.warmthNow() - 0.2) - cold.seasonWarmthDelta()) < 1e-9);

// ---- F5: morale, disease, starvation --------------------------------------
const sv = new Game(hold, null);
ok('happiness starts content', sv.happiness > 0.3 && sv.happiness <= 1);
ok('happinessTarget in [0,1]', sv.happinessTarget() >= 0 && sv.happinessTarget() <= 1);
const st5 = new Game({ ...hold, warmth: 0.9 }, null);
for (const c of FOOD_CATS) st5.res[c] = 0;
st5.pop = 20;
for (let i = 0; i < 300; i++) st5.step(2);
ok('starvation shrinks pop', st5.pop < 20);
ok('starving flag set on empty larder', st5.starving === true);
ok('happiness stays in [0,1] while starving', st5.happiness >= 0 && st5.happiness <= 1);
ok('pop floored at >= 3', st5.pop >= 3);
const fed = new Game(hold, null);
for (const c of FOOD_CATS) fed.res[c] = 200;
let fedOk = true;
for (let i = 0; i < 400; i++) { fed.step(2); if (!Number.isFinite(fed.happiness) || !Number.isFinite(fed.pop) || fed.pop < 3) fedOk = false; }
ok('fed hold: finite morale + pop>=3 over 400 ticks', fedOk);
ok('fed hold not flagged starving', fed.starving === false);

// ---- peddler bootstrap: a broke, timber-poor march can fund itself --------
const march = { id: 'sok', name: 'Sokaprus', realm: 'K', region: 'plateau', tierName: 'march', ancestry: 'Northern',
  rich: { food: 0.21, timber: 0.09, stone: 1, ore: 0.98, salt: 0.01, coin: 0.28 }, warmth: 0.3, danger: 0, n: { riverMax: 0, lake: 0, sea: 0 } };
const bk = new Game(march, null);
bk.res = { grain: 28, roots: 8, greens: 150, fruit: 0, fish: 0, timber: 4, stone: 38, ore: 5, salt: 0, coin: 4 };
ok('no market yet', bk.tradeUnlocked() === false);
ok('peddler SELL works without a market', bk.sell('greens', 20) === true);
ok('peddler sale earned coin', bk.res.coin > 4);
const coinBefore = bk.res.coin;
bk.res.coin = 100;
ok('peddler BUY works without a market', bk.buy('timber', 10) === true);
ok('peddler buy delivered timber', bk.res.timber >= 14);
ok('peddler buy price is dear (paid > base)', 100 - bk.res.coin >= 10);
bk.res.coin = coinBefore;
const pFair = new Game(march, null); pFair.instances.market = [1];
ok('market sell price >= peddler sell price', pFair.sellPrice('greens') >= bk.sellPrice('greens'));
ok('market buy price <= peddler buy price', pFair.buyPrice('timber') <= bk.buyPrice('timber'));

console.log(fail ? `\n  ✗ ${fail} failed, ${pass} passed` : `\n  ✓ all ${pass} model assertions pass`);
process.exit(fail ? 1 : 0);
