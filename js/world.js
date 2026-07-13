(function(){
// world.js — read-only adapter over the snapshot dumped from xan-world-sim.
// The sim is a data quarry: we never write back to it. Everything here
// decodes the flat scene.Snapshot (row-major grids + seat/realm/feature
// lists) into the vocabulary the hold game speaks — local resources,
// danger, and lore — for one chosen seat.

const W = window.WORLD;
const GW = W.w, GH = W.h;
const idx = (x, y) => y * GW + x;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < GW && y < GH;

// Go marshals []uint8 (the road grid) as a base64 string. Decode once.
const ROAD = (() => {
  if (typeof W.road !== 'string') return W.road || [];
  const bin = atob(W.road);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
})();

// Region ids (mirror internal/world/world.go). Only the ones we read.
const REG = {
  PLATEAU: 1, MOUNTAIN: 2, CRADLE: 3, BRINE: 4, EASTSEA: 5, DROWNED: 7,
  DOAB: 8, CLIFF: 9, FOOTHILL: 10, GLACIER: 11, AGRARIA: 12, AGRUPLAND: 13,
  LAKE: 14, FOREST: 15, TUNDRA: 16, MARSH: 17, PASS: 23, DEN: 24, NEST: 25,
  ROOKERY: 26, VOLCANO: 29, LAVA: 30,
};
const REG_NAME = {
  1: 'plateau', 2: 'mountain', 3: 'cradle', 4: 'the Brine', 5: 'the East Sea',
  7: 'drowned coast', 8: 'doab', 9: 'cliff', 10: 'foothill', 11: 'glacier',
  12: 'Agraria shelf', 13: 'upland', 14: 'lake', 15: 'forest', 16: 'tundra',
  17: 'marsh', 23: 'pass', 24: 'dragon den', 25: 'drake nest',
  26: 'wyvern rookery', 29: 'volcano', 30: 'lava field',
};

// Seat tiers (mirror the RegionSeat.. block).
const TIER = { 18: 'seat', 19: 'march', 20: 'headwater', 21: 'outhold', 22: 'reach', 27: 'capital', 31: 'saltern' };

const regionAt = (x, y) => (inBounds(x, y) ? W.region[idx(x, y)] : 0);
const isSea = (r) => r === REG.BRINE || r === REG.EASTSEA || r === REG.DROWNED;

// scanNeighborhood walks the cells within `r` of a seat and tallies the
// raw signal the economy is derived from.
function scanNeighborhood(sx, sy, r) {
  const t = {
    cells: 0, forest: 0, mountain: 0, foothill: 0, cliff: 0, plateau: 0,
    cradle: 0, agraria: 0, tundra: 0, marsh: 0, lake: 0, sea: 0, glacier: 0,
    salt: 0, salinity: 0, riverMax: 0, road: 0, fertility: 0,
    dens: 0, nests: 0, rookeries: 0, volcanoes: 0, passes: 0,
    temp: 0, tempW: 0, // running weighted sum of °C + its weight — meaned below
    rock: {},
  };
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = sx + dx, y = sy + dy;
      if (!inBounds(x, y)) continue;
      const i = idx(x, y);
      const reg = W.region[i];
      if (!reg) continue;
      t.cells++;
      // Inverse-distance weight so the immediate hinterland counts most.
      const d = Math.max(1, Math.abs(dx) + Math.abs(dy));
      const wgt = 1 / d;
      t.salt += (W.salt[i] || 0) * wgt;
      t.salinity += (W.salinity[i] || 0) * wgt;
      t.temp += (W.temp[i] || 0) * wgt; t.tempW += wgt; // the sim's per-cell °C — the temp LAYER, read here
      t.riverMax = Math.max(t.riverMax, W.river[i] || 0);
      t.road += ROAD[i] ? wgt : 0;
      t.rock[W.rock[i]] = (t.rock[W.rock[i]] || 0) + 1;
      switch (reg) {
        case REG.FOREST: t.forest += wgt; t.fertility += 0.7 * wgt; break;
        case REG.MOUNTAIN: t.mountain += wgt; break;
        case REG.FOOTHILL: t.foothill += wgt; t.fertility += 0.2 * wgt; break;
        case REG.CLIFF: t.cliff += wgt; break;
        case REG.PLATEAU: t.plateau += wgt; t.fertility += 0.1 * wgt; break;
        case REG.CRADLE: case REG.DOAB: t.cradle += wgt; t.fertility += 1.0 * wgt; break;
        case REG.AGRARIA: case REG.AGRUPLAND: t.agraria += wgt; t.fertility += 0.8 * wgt; break;
        case REG.TUNDRA: t.tundra += wgt; t.fertility += 0.05 * wgt; break;
        case REG.MARSH: t.marsh += wgt; t.fertility += 0.3 * wgt; break;
        case REG.LAKE: t.lake += wgt; break;
        case REG.GLACIER: t.glacier += wgt; break;
        case REG.DEN: t.dens++; break;
        case REG.NEST: t.nests++; break;
        case REG.ROOKERY: t.rookeries++; break;
        case REG.VOLCANO: t.volcanoes++; break;
        case REG.PASS: t.passes++; break;
        default: if (isSea(reg)) t.sea += wgt;
      }
    }
  }
  // River adds fertility (alluvium) and a little sea proxy for fishing.
  if (t.riverMax > 0) t.fertility += Math.min(2, t.riverMax * 0.25);
  // Mean climate over the hinterland (inverse-distance weighted, seat cell
  // heaviest), °C — smoother than one lone cell. Falls back to the seat cell.
  t.temp = t.tempW > 0 ? t.temp / t.tempW : (W.temp[idx(sx, sy)] || 0);
  return t;
}

// tempBandOf names a hold's climate from its mean °C — the lore word behind
// `warmth`, and (soon) how fast its food turns. The continent's seats span
// ~0–15°C, so the bands below spread the real range, not a global scale.
function tempBandOf(c) {
  if (c < 2) return 'frigid';
  if (c < 7) return 'cold';
  if (c < 12) return 'temperate';
  if (c < 16) return 'warm';
  return 'sweltering';
}

// The six things a hold can gather. Each maps to a local signal.
const RESOURCES = ['food', 'timber', 'stone', 'ore', 'salt', 'coin'];

// deriveHold turns a raw seat into a fully-specified playable hold:
// its local resource richness (0..~1 each), danger, ancestry/tier flavor,
// and the buildings its geography unlocks.
function deriveHold(seat) {
  const n = scanNeighborhood(+seat.x, +seat.y, 4);
  const cell = idx(+seat.x, +seat.y);

  // Richness 0..1 per resource, calibrated against the continent's own
  // distribution so a march reads ore/stone, a river-seat food, a
  // saltern salt — not everything at once. (Forests and roads are common
  // here, so their divisors are large; salt is rare, so it's cheap.)
  const rich = {
    food: clamp01(n.fertility / 18 + Math.min(0.22, n.riverMax * 0.02) + n.lake * 0.03),
    timber: clamp01(n.forest / 22),
    stone: clamp01((n.mountain + n.foothill + n.cliff) / 8),
    ore: clamp01((n.mountain + n.volcanoes * 3) / 6),
    salt: clamp01(n.salt / 4 + n.salinity / 12 + (seat.tier === 31 ? 0.45 : 0)),
    coin: clamp01(Math.max(0, n.road - 2) / 6 + n.sea * 0.04 + n.passes * 0.06
      + (seat.tier === 27 ? 0.35 : 0) + (seat.tier === 18 ? 0.1 : 0)),
  };
  const setting = dominantSetting(n);

  // Climate, from the sim's temp layer (soil/air °C at this kya, meaned over
  // the hinterland). `warmth` 0..1 is the gameplay-facing signal — 0°C-and-
  // below reads frozen (stores keep), ~20°C reads hot (stores turn fast) — so
  // the engine can scale food spoilage by it without touching raw °C.
  const warmth = clamp01(n.temp / 20);
  const tempBand = tempBandOf(n.temp);

  const danger = clamp01((n.dens * 0.28 + n.nests * 0.18 + n.rookeries * 0.12 + n.volcanoes * 0.06)
    + (seat.pressure || 0) / 40);

  const realm = W.realms.find((r) => r.id === seat.realm) || null;
  const tierName = TIER[seat.tier] || 'hold';

  return {
    id: `${seat.x},${seat.y}`,
    x: +seat.x, y: +seat.y,
    name: seat.name,
    tier: seat.tier, tierName,
    ancestry: seat.ancestryLabel,
    allegiance: seat.allegiance,
    pressure: seat.pressure,
    realm: realm ? realm.name : 'the free holds',
    realmCrown: realm ? realm.isCrown : false,
    region: setting,
    elev: Math.round(W.elev[cell] || 0),
    temp: Math.round(n.temp * 10) / 10, // regional mean °C (see scanNeighborhood)
    warmth, tempBand,
    rich, danger, n,
    nearby: nearbyFeatures(+seat.x, +seat.y),
    blurb: holdBlurb(seat, tierName, rich, danger, n),
  };
}

// nearbyFeatures lists named POIs close enough to color a hold's story.
function nearbyFeatures(sx, sy) {
  const out = [];
  for (const f of W.features) {
    const d = Math.abs(+f.x - sx) + Math.abs(+f.y - sy);
    if (d <= 8) out.push({ kind: f.kind, name: f.name, dist: d });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, 5);
}

// dominantSetting names the terrain a hold sits in from its weighted tally.
function dominantSetting(n) {
  const cand = [['forest', n.forest], ['mountain', n.mountain], ['foothill country', n.foothill],
    ['cliffs', n.cliff], ['high plateau', n.plateau], ['cradle lowland', n.cradle],
    ['Agraria shelf', n.agraria], ['tundra', n.tundra], ['marsh', n.marsh],
    ['lakeshore', n.lake], ['coast', n.sea]];
  cand.sort((a, b) => b[1] - a[1]);
  return cand[0][1] > 0.5 ? cand[0][0] : 'wildland';
}

function holdBlurb(seat, tierName, rich, danger, n) {
  const top = Object.entries(rich).sort((a, b) => b[1] - a[1])[0][0];
  const anc = { Northern: 'mammoth-blood of the frozen north', Coastal: 'shore-farmers of the receded coast', cradle: 'the hybrid river-stock of the cradle' }[seat.ancestryLabel] || 'settled folk';
  const tierLore = {
    march: 'a wall-hold on the mountain’s edge — the frontier against the wilds',
    headwater: 'a sacred source at a river’s head, old and contested',
    seat: 'a river-seat on a navigable stretch',
    outhold: 'a lean frontier outhold',
    reach: 'a far reach of its realm',
    capital: 'the crown seat of its realm',
    saltern: 'a salt-works hall — salt is power',
  }[tierName] || 'a settled hold';
  const richWord = { food: 'good ground and water', timber: 'deep forest', stone: 'stone and crag', ore: 'ore in the rock', salt: 'salt in the earth', coin: 'roads and trade' }[top];
  const dangerWord = danger > 0.55 ? ' Dragons roost close — it will bleed.' : danger > 0.25 ? ' The wilds press at it.' : ' The country around is quiet.';
  const climateWord = { frigid: ' The air runs frigid; little keeps but little spoils.', cold: ' The air runs cold, and stores keep well.', temperate: '', warm: ' The air runs warm — stores must be salted or turn.', sweltering: ' The heat is heavy; food turns fast without salt.' }[tempBandOf(n.temp)];
  return `${seat.name} is ${tierLore}, held by ${anc}. Its wealth is ${richWord}.${dangerWord}${climateWord}`;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// allHolds derives every seat once, sorted capital-first then by name.
function allHolds() {
  const holds = W.seats.map(deriveHold);
  const rank = { 27: 0, 31: 1, 19: 2, 20: 3, 18: 4, 21: 5, 22: 6 };
  holds.sort((a, b) => (rank[a.tier] - rank[b.tier]) || a.name.localeCompare(b.name));
  return holds;
}

window.XAN = { W, GW, GH, idx, inBounds, ROAD, REG, REG_NAME, TIER, regionAt, isSea, deriveHold, allHolds, RESOURCES };
})();
