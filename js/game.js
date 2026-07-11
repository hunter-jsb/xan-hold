(function(){
// game.js — the idle hold engine. A chosen hold's geography (from world.js)
// sets its resource richness, danger, and starting buildings; from there
// it's a self-contained ticker with population/labor, a food economy,
// dragon raids, offline catch-up, and localStorage saves. No server, and
// nothing writes back to the sim.

const CFG = {
  tickMs: 250,            // sim resolution
  foodPerPop: 0.02,       // food/s eaten per head
  popGrowth: 0.015,       // head/s per surplus unit, gated by housing + food
  costScale: 1.16,        // per-level upgrade cost multiplier
  raidIntervalS: 135,     // mean seconds between raid checks
  maxOfflineH: 12,        // cap offline catch-up
  baseCaps: { food: 500, timber: 400, stone: 300, ore: 250, salt: 200, coin: 1e9 },
  // Market base coin-price per unit; buying a good you lack is dear,
  // selling one you're rich in is how a hold earns coin.
  basePrice: { food: 0.5, timber: 0.6, stone: 1.1, ore: 1.6, salt: 1.8 },
  tradeLot: 10,
};

// Building catalogue. `rich` is the local-richness key that scales output;
// `gate` is the minimum richness for it to be offered at all. Support
// buildings (housing/storage/defense) produce nothing.
const BUILDINGS = [
  { id: 'farm', name: 'Farmstead', kind: 'prod', res: 'food', base: 0.9, rich: 'food', gate: 0.12,
    cost: { timber: 12, coin: 6 }, desc: 'Grain and pasture on the hold’s good ground.' },
  { id: 'wharf', name: 'Fishing Wharf', kind: 'prod', res: 'food', base: 0.8, rich: 'water', gate: 0.10,
    cost: { timber: 15, stone: 4 }, desc: 'Weirs and boats on river, lake, or shore.' },
  { id: 'sawmill', name: 'Sawmill', kind: 'prod', res: 'timber', base: 0.7, rich: 'timber', gate: 0.10,
    cost: { timber: 8, coin: 8 }, desc: 'Fells and cuts the surrounding forest.' },
  { id: 'quarry', name: 'Quarry', kind: 'prod', res: 'stone', base: 0.6, rich: 'stone', gate: 0.10,
    cost: { timber: 14, coin: 8 }, desc: 'Cuts building stone from crag and foothill.' },
  { id: 'mine', name: 'Deep Mine', kind: 'prod', res: 'ore', base: 0.5, rich: 'ore', gate: 0.12,
    cost: { timber: 20, stone: 12 }, desc: 'Drives shafts after ore in the rock.' },
  { id: 'saltern', name: 'Saltern', kind: 'prod', res: 'salt', base: 0.55, rich: 'salt', gate: 0.10,
    cost: { timber: 16, stone: 10 }, desc: 'Pans and mines the salt — salt is wealth.' },
  { id: 'market', name: 'Market', kind: 'prod', res: 'coin', base: 0.5, rich: 'coin', gate: 0.04,
    cost: { timber: 18, stone: 8 }, desc: 'Caravans and stalls turn goods to coin.' },
  { id: 'longhouse', name: 'Longhouse', kind: 'housing', pop: 6,
    cost: { timber: 20, stone: 6 }, desc: 'Roofs more folk — raises the hold’s people cap.' },
  { id: 'granary', name: 'Storehouse', kind: 'storage', capMul: 0.6,
    cost: { timber: 16, stone: 10 }, desc: 'Granaries and sheds — deeper stores of every good.' },
  { id: 'palisade', name: 'Palisade & Watch', kind: 'defense', def: 1,
    cost: { timber: 24, stone: 20 }, desc: 'Wall and watchtower — blunts the wilds’ raids.' },
  { id: 'reliquary', name: 'Reliquary', kind: 'faith',
    cost: { timber: 22, stone: 14 }, desc: 'A shrine over a shard of the Fallen — widens the god’s voice (one more speaker, longer word).' },
];
const BY_ID = Object.fromEntries(BUILDINGS.map((b) => [b.id, b]));

// STORE — localStorage when it's reachable, else an in-memory fallback.
// A sandboxed file: origin (e.g. a flatpak browser's document portal) can
// throw on localStorage access; there the hold still plays, just unsaved.
const STORE = (() => {
  try {
    const k = '__xh__'; localStorage.setItem(k, '1'); localStorage.removeItem(k);
    return { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v), del: (k) => localStorage.removeItem(k) };
  } catch (_) {
    const m = new Map();
    return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), del: (k) => m.delete(k) };
  }
})();

// waterRich folds river/lake/sea into one "fishing" richness the wharf reads.
function waterRich(h) {
  const n = h.n;
  return Math.max(0, Math.min(1, n.riverMax * 0.09 + n.lake * 0.12 + n.sea * 0.05));
}

// ancestryMul / tierMul — per-resource output multipliers baked from lore.
function bonuses(h) {
  const mul = { food: 1, timber: 1, stone: 1, ore: 1, salt: 1, coin: 1 };
  let foodEat = 1, defBonus = 0, popCapBonus = 0;
  switch (h.ancestry) {
    case 'Northern': mul.timber *= 1.15; mul.ore *= 1.1; foodEat *= 0.8; break;
    case 'Coastal': mul.coin *= 1.2; mul.food *= 1.12; break;
    case 'cradle': mul.food *= 1.15; break;
  }
  switch (h.tierName) {
    case 'saltern': mul.salt *= 1.5; break;
    case 'capital': mul.coin *= 1.3; popCapBonus += 8; break;
    case 'march': mul.ore *= 1.15; mul.stone *= 1.15; defBonus += 1; break;
    case 'headwater': mul.food *= 1.1; break;
    case 'seat': mul.food *= 1.08; mul.coin *= 1.08; break;
  }
  return { mul, foodEat, defBonus, popCapBonus };
}

class Game {
  constructor(hold, saved) {
    this.h = hold;
    this.water = waterRich(hold);
    this.bon = bonuses(hold);
    if (saved) {
      Object.assign(this, saved);
      this.h = hold; this.water = waterRich(hold); this.bon = bonuses(hold);
    } else {
      this.res = { food: 60, timber: 40, stone: 18, ore: 5, salt: 3, coin: 25 };
      // A hold starts leaning into its richest good.
      const top = Object.entries(hold.rich).sort((a, b) => b[1] - a[1])[0][0];
      this.res[top] = (this.res[top] || 0) + 20;
      this.pop = 8;
      this.lvl = { farm: 1 };
      if (hold.tierName === 'saltern') this.lvl.saltern = 1;
      if (this.water > 0.12) this.lvl.wharf = 1;
      this.founded = Date.now();
      this.log = [];
      this.raidClock = CFG.raidIntervalS;
      this.pushLog(`${hold.name} is yours to steward — a ${hold.tierName} of ${hold.realm}, in the ${hold.region}. The folk look to you.`, 'note');
    }
    this.lastTick = this.lastTick || Date.now();
    // Farm fields: each is an individual plot with a size (grown by expansion)
    // and a crop. Seeded from the farm level so old saves migrate cleanly.
    this.farmPlots = this.farmPlots || [];
    if (this.farmPlots.length === 0 && this.level('farm') > 0) {
      const crops = ['greens', 'grain', 'roots'];
      for (let i = 0; i < this.level('farm'); i++) this.farmPlots.push({ size: 1, crop: crops[i % 3] });
    }
  }

  // newFarm builds a fresh field (its own plot), optionally of a chosen crop —
  // the alternative to expanding an existing one.
  newFarm(crop) {
    if (!this.build('farm')) return false; // pays build cost, raises farm level
    const crops = ['greens', 'grain', 'roots'];
    this.farmPlots.push({ size: 1, crop: crop || crops[this.farmPlots.length % 3] });
    return true;
  }

  // expandFarm grows the smallest not-yet-maxed field in place — cheaper than a
  // new farm but its yield still rises. Returns the plot index, or -1.
  expandFarm() {
    const MAX = 3;
    let cand = null;
    for (const p of this.farmPlots) if (p.size < MAX && (!cand || p.size < cand.size)) cand = p;
    if (!cand) return -1;
    const cost = this.expandCost(cand);
    if (!Object.entries(cost).every(([k, v]) => this.res[k] >= v)) return -1;
    for (const [k, v] of Object.entries(cost)) this.res[k] -= v;
    cand.size += 1;
    this.lvl.farm = this.level('farm') + 1; // a bigger field feeds more
    return this.farmPlots.indexOf(cand);
  }
  expandCost(plot) { return { timber: Math.ceil(8 * plot.size), coin: Math.ceil(5 * plot.size) }; }

  // richOf resolves a building's richness key (water is derived).
  richOf(b) { return b.rich === 'water' ? this.water : (this.h.rich[b.rich] || 0); }

  available() {
    return BUILDINGS.filter((b) => {
      if (b.kind !== 'prod') return true;
      // Offered if the land supports it, or you already have one.
      return this.richOf(b) >= b.gate || this.lvl[b.id];
    });
  }

  level(id) { return this.lvl[id] || 0; }

  costOf(id) {
    const b = BY_ID[id];
    const l = this.level(id);
    const out = {};
    for (const [k, v] of Object.entries(b.cost)) out[k] = Math.ceil(v * Math.pow(CFG.costScale, l));
    return out;
  }

  canAfford(id) {
    const c = this.costOf(id);
    return Object.entries(c).every(([k, v]) => this.res[k] >= v);
  }

  build(id) {
    if (!this.canAfford(id)) return false;
    const c = this.costOf(id);
    for (const [k, v] of Object.entries(c)) this.res[k] -= v;
    this.lvl[id] = this.level(id) + 1;
    return true;
  }

  // ---- derived rates -------------------------------------------------
  jobs() {
    let j = 0;
    for (const b of BUILDINGS) if (b.kind === 'prod') j += this.level(b.id);
    return j;
  }

  efficiency() {
    const j = this.jobs();
    return j === 0 ? 1 : Math.max(0, Math.min(1, this.pop / j));
  }

  popCap() {
    let cap = 8 + this.bon.popCapBonus;
    cap += this.level('longhouse') * BY_ID.longhouse.pop;
    return cap;
  }

  defense() { return this.level('palisade') * BY_ID.palisade.def + this.bon.defBonus; }

  caps() {
    const s = 1 + this.level('granary') * BY_ID.granary.capMul;
    const out = {};
    for (const k of Object.keys(CFG.baseCaps)) out[k] = CFG.baseCaps[k] * (k === 'coin' ? 1 : s);
    return out;
  }

  // production per second, per resource, at current efficiency & pop.
  rates() {
    const eff = this.efficiency();
    const out = { food: 0, timber: 0, stone: 0, ore: 0, salt: 0, coin: 0 };
    for (const b of BUILDINGS) {
      if (b.kind !== 'prod') continue;
      const lv = this.level(b.id);
      if (!lv) continue;
      const r = this.richOf(b);
      out[b.res] += b.base * lv * (0.35 + 0.65 * r) * eff * this.bon.mul[b.res];
    }
    return out;
  }

  foodEatPerS() { return this.pop * CFG.foodPerPop * this.bon.foodEat; }

  // ---- trade ---------------------------------------------------------
  // A Market turns the hold's surplus into coin and coin into the goods
  // its land can't yield — the loop that keeps a stone-poor forest hall
  // or an ore-rich frontier alive.
  tradeUnlocked() { return this.level('market') > 0; }
  localRich(res) { return res === 'coin' ? 0 : (this.h.rich[res] || 0); }
  buyPrice(res) { return Math.max(1, Math.ceil(CFG.basePrice[res] * (1.6 - 0.9 * this.localRich(res)))); }
  sellPrice(res) { return Math.max(1, Math.floor(CFG.basePrice[res] * (0.5 + 0.05 * this.level('market')) * (1.2 - 0.5 * this.localRich(res)))); }

  buy(res, qty = CFG.tradeLot) {
    if (!this.tradeUnlocked()) return false;
    const cost = this.buyPrice(res) * qty;
    if (this.res.coin < cost) return false;
    this.res.coin -= cost;
    this.res[res] = Math.min(this.caps()[res], this.res[res] + qty);
    return true;
  }
  sell(res, qty = CFG.tradeLot) {
    if (!this.tradeUnlocked() || this.res[res] < qty) return false;
    this.res[res] -= qty;
    this.res.coin += this.sellPrice(res) * qty;
    return true;
  }

  // ---- the tick ------------------------------------------------------
  // step advances `dt` seconds of sim: production, food/pop, storage caps.
  step(dt, offline = false) {
    const rate = this.rates();
    const caps = this.caps();
    for (const k of Object.keys(rate)) {
      this.res[k] = Math.min(caps[k], (this.res[k] || 0) + rate[k] * dt);
    }
    // Food is eaten; surplus feeds growth, deficit eats the store then folk.
    const eat = this.foodEatPerS() * dt;
    this.res.food -= eat;
    const netFood = rate.food * dt - eat;
    if (this.res.food < 0) {
      // Starvation: clear the debt in people.
      this.res.food = 0;
      this.pop = Math.max(3, this.pop - 0.05 * this.pop * dt);
    } else if (this.pop < this.popCap()) {
      const surplus = Math.max(0, netFood);
      this.pop = Math.min(this.popCap(), this.pop + CFG.popGrowth * (0.5 + surplus) * dt);
    }
    this.stepRaids(dt, offline);
  }

  // stepRaids counts down a raid clock; on a strike, danger (mitigated by
  // defense) is drawn from the stores, occasionally from the people.
  // Offline, raiders strike less often — the frontier is quieter when
  // there's no steward's banner to press.
  stepRaids(dt, offline = false) {
    if (this.h.danger <= 0.01) return;
    this.raidClock -= dt;
    if (this.raidClock > 0) return;
    this.raidClock += CFG.raidIntervalS * (offline ? 4 : 1) * (0.7 + Math.random() * 0.6);
    if (Math.random() > this.h.danger * 0.6) return; // a quiet season
    const mit = Math.max(0.2, 1 - this.defense() * 0.2);
    const bite = this.h.danger * mit;
    const taken = {};
    // A raid falls on one or two kinds of stores, not everything at once.
    for (const k of ['food', 'salt', 'ore', 'coin']) {
      if (Math.random() > 0.5) continue;
      const loss = Math.floor(this.res[k] * bite * (0.1 + Math.random() * 0.14));
      if (loss > 0) { this.res[k] -= loss; taken[k] = loss; }
    }
    let deaths = 0;
    if (bite > 0.55 && this.pop > 5 && Math.random() < 0.5) { deaths = Math.ceil(this.pop * bite * 0.06); this.pop -= deaths; }
    this.raidTally = (this.raidTally || 0) + 1;
    // Offline raids are folded into one summary line by catchUp, so we
    // don't flood the chronicle with a season's worth of skirmishes.
    if (!offline) this.logRaid(taken, deaths, mit);
  }

  logRaid(taken, deaths, mit) {
    const parts = Object.entries(taken).map(([k, v]) => `${v} ${k}`);
    let msg = 'Raiders came down from the wilds';
    if (parts.length) msg += `, carrying off ${parts.join(', ')}`;
    if (deaths) msg += `; ${deaths} of the folk fell`;
    if (!parts.length && !deaths) msg = 'Raiders tested the watch and were driven off';
    if (mit < 0.5) msg += '. The wall held much back.';
    this.pushLog(msg, 'raid');
  }

  pushLog(text, kind = 'note') {
    this.log.unshift({ text, kind, t: Date.now() });
    if (this.log.length > 40) this.log.pop();
  }

  // ---- offline catch-up ---------------------------------------------
  // catchUp folds elapsed real time into the sim in coarse steps and
  // returns a summary for the "while you were away" panel.
  catchUp() {
    const now = Date.now();
    let elapsed = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (elapsed < 2) return null;
    const capped = Math.min(elapsed, CFG.maxOfflineH * 3600);
    const before = { ...this.res, pop: this.pop };
    const raidsBefore = this.raidTally || 0;
    let t = capped;
    const dt = 5; // coarse offline step
    while (t > 0) { this.step(Math.min(dt, t), true); t -= dt; }
    const gained = {};
    for (const k of Object.keys(this.res)) {
      const d = Math.round(this.res[k] - before[k]);
      if (Math.abs(d) >= 1) gained[k] = d;
    }
    const raids = (this.raidTally || 0) - raidsBefore;
    if (raids > 0) this.pushLog(`In your absence, raiders came down from the wilds ${raids} time${raids > 1 ? 's' : ''}; the watch held what it could.`, 'raid');
    return { seconds: capped, truncated: elapsed > capped, gained, popDelta: Math.round(this.pop - before.pop), raids };
  }

  // ---- persistence ---------------------------------------------------
  serialize() {
    return { res: this.res, pop: this.pop, lvl: this.lvl, farmPlots: this.farmPlots, founded: this.founded, log: this.log, raidClock: this.raidClock, lastTick: this.lastTick };
  }
  save() { STORE.set('xanhold:' + this.h.id, JSON.stringify(this.serialize())); }
  static load(hold) {
    const raw = STORE.get('xanhold:' + hold.id);
    return new Game(hold, raw ? JSON.parse(raw) : null);
  }
  static hasSave(id) { return STORE.get('xanhold:' + id) != null; }
  static abandon(id) { STORE.del('xanhold:' + id); }
}

window.XANGAME = { Game, BUILDINGS, BY_ID, CFG };
})();
