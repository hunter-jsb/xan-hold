(function(){
// game.js — the idle hold engine. A chosen hold's geography (from world.js)
// sets its resource richness, danger, and starting buildings; from there
// it's a self-contained ticker with population/labor, a food economy,
// dragon raids, offline catch-up, and localStorage saves. No server, and
// nothing writes back to the sim.

const CFG = {
  tickMs: 250,            // sim resolution
  foodPerPop: 0.02,       // food/s eaten per head
  popGrowth: 0.008,       // head/s per surplus unit — needs a real food surplus AND housing headroom
  costScale: 1.16,        // per-level upgrade cost multiplier
  raidIntervalS: 135,     // mean seconds between raid checks
  diseaseIntervalS: 180,  // mean seconds between sickness checks
  happyEase: 0.06,        // how fast morale eases toward its target (per second)
  maxOfflineH: 12,        // cap offline catch-up
  faithPerSpeaker: 0.4,   // faith/s each speaker (1 base + 1/reliquary) wells up
  faithBase: 60,          // faithThreshold() floor (at 1 speaker)
  faithPerSpeakerThresh: 40, // faithThreshold() rise per speaker
  insightPerScholar: 0.1, // insight/s each scholar (1 base + 2/Scholars' Hall level) accrues toward a discovery
  dayMs: 240000,          // a full day/night in real ms — SHARED with town.js (daylight drives food spoilage + the night overlay)
  seasonDays: 2,          // real days per season (a year = 4× this) — season shifts warmth
  seasonWarmthAmp: 0.18,  // ± warmth swing between mid-summer and mid-winter
  // Food spoilage: stored food turns, faster when warm (main), in daylight, and
  // piled on the ground (unsheltered by storehouses). Salt preserves most of it.
  foodSpoilMax: 0.0004,   // full-severity fraction of the food pile lost per second
  saltPreserveMax: 0.85,  // salt can prevent at most this fraction of a spoil (can't perfectly keep)
  saltPerFood: 0.2,       // salt spent to preserve one unit of food
  // Food is five categories now (see FOOD); each stores on its own. Staples keep
  // deeper stores than perishables. Timber/stone/ore/salt unchanged.
  baseCaps: { grain: 260, roots: 220, greens: 150, fruit: 150, fish: 130, timber: 400, stone: 300, ore: 250, salt: 200, coin: 5000 },
  // Market base coin-price per unit; buying a good you lack is dear,
  // selling one you're rich in is how a hold earns coin. Fruit is the dearest
  // food (wine/olives read as a luxury); fish/greens cheap and perishable.
  basePrice: { grain: 0.5, roots: 0.5, greens: 0.45, fruit: 0.75, fish: 0.55, timber: 0.6, stone: 1.1, ore: 1.6, salt: 1.8 },
  tradeLot: 10,
};
const YEAR_MS = CFG.dayMs * CFG.seasonDays * 4; // four seasons make a year

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
  { id: 'barracks', name: 'Barracks', kind: 'defense', def: 2,
    cost: { timber: 20, stone: 16, ore: 6 }, desc: 'Garrison and drill-yard — houses soldiers and strengthens the hold’s martial readiness.' },
  { id: 'keep', name: 'The Keep', kind: 'civic',
    cost: { timber: 30, stone: 30, coin: 20 }, desc: 'The lord’s hall and stronghold — expanding it quarters more folk and stiffens the hold’s defense and muster.' },
  { id: 'scholarshall', name: 'Scholars’ Hall', kind: 'research',
    cost: { timber: 20, stone: 12, coin: 10 }, desc: 'Archives the land’s own record — quickens the hold’s study of its rock, salt, waters, and lineage (see Research).' },
];
const BY_ID = Object.fromEntries(BUILDINGS.map((b) => [b.id, b]));

// ---- food: categories + specific crops ---------------------------------
// Food is no longer one pooled good. Farms grow a SPECIFIC crop (climate-gated,
// see CROPS/cropSuit), but every crop STORES, TRADES, SPOILS, and FEEDS as one
// of these five CATEGORIES — so the economy stays ~5 food goods while the field
// itself is as varied as the land. `spoil` is the category's perishability
// (multiplies the temp/sun/ground rate in stepSpoilage): staples keep, fresh
// things turn. (Storage caps + market prices live in CFG.baseCaps/basePrice
// alongside the other goods, keyed by these same category names.)
const FOOD = {
  grain:  { name: 'Grain',  spoil: 0.6 },
  roots:  { name: 'Roots',  spoil: 0.7 },
  greens: { name: 'Greens', spoil: 1.15 },
  fruit:  { name: 'Fruit',  spoil: 1.3 },
  fish:   { name: 'Fish',   spoil: 1.7 },
};
const FOOD_CATS = Object.keys(FOOD); // ['grain','roots','greens','fruit','fish']
// The order the folk eat in — most-perishable first, so the larder burns fish
// and greens before they rot and keeps grain as the reserve.
const EAT_ORDER = FOOD_CATS.slice().sort((a, b) => FOOD[b].spoil - FOOD[a].spoil);

// CROPS — the specific things a farm can grow. Each thrives at a `peak` warmth
// (0..1, hold.warmth) and falls off over `band`; `water` is how much river/
// lake/coast it wants (rice, melons); `cat` is the food category it fills;
// `yield` scales its output. A hold is only OFFERED crops its climate + water
// actually support (cropSuit ≥ a floor), so a frigid march and a warm reach
// farm nothing alike. Fish isn't grown — it comes off the wharf.
const CROPS = [
  { id: 'barley',   name: 'Barley',   cat: 'grain',  peak: 0.15, band: 0.55, water: 0,    yield: 1.0 },
  { id: 'rye',      name: 'Rye',      cat: 'grain',  peak: 0.20, band: 0.55, water: 0,    yield: 0.9 },
  { id: 'oats',     name: 'Oats',     cat: 'grain',  peak: 0.28, band: 0.5,  water: 0.15, yield: 0.95 },
  { id: 'wheat',    name: 'Wheat',    cat: 'grain',  peak: 0.5,  band: 0.42, water: 0.1,  yield: 1.1 },
  { id: 'spelt',    name: 'Spelt',    cat: 'grain',  peak: 0.45, band: 0.45, water: 0,    yield: 0.95 },
  { id: 'millet',   name: 'Millet',   cat: 'grain',  peak: 0.7,  band: 0.42, water: 0,    yield: 1.0 },
  { id: 'sorghum',  name: 'Sorghum',  cat: 'grain',  peak: 0.82, band: 0.4,  water: 0,    yield: 0.95 },
  { id: 'rice',     name: 'Rice',     cat: 'grain',  peak: 0.85, band: 0.35, water: 0.6,  yield: 1.25 },
  { id: 'turnips',  name: 'Turnips',  cat: 'roots',  peak: 0.15, band: 0.55, water: 0,    yield: 1.0 },
  { id: 'beets',    name: 'Beets',    cat: 'roots',  peak: 0.25, band: 0.5,  water: 0,    yield: 0.95 },
  { id: 'parsnips', name: 'Parsnips', cat: 'roots',  peak: 0.4,  band: 0.45, water: 0,    yield: 0.95 },
  { id: 'carrots',  name: 'Carrots',  cat: 'roots',  peak: 0.48, band: 0.45, water: 0.1,  yield: 1.0 },
  { id: 'yams',     name: 'Yams',     cat: 'roots',  peak: 0.75, band: 0.4,  water: 0.2,  yield: 1.05 },
  { id: 'kale',     name: 'Kale',     cat: 'greens', peak: 0.15, band: 0.5,  water: 0,    yield: 0.9 },
  { id: 'cabbage',  name: 'Cabbage',  cat: 'greens', peak: 0.22, band: 0.48, water: 0.1,  yield: 1.0 },
  { id: 'peas',     name: 'Peas',     cat: 'greens', peak: 0.45, band: 0.42, water: 0.1,  yield: 0.95 },
  { id: 'beans',    name: 'Beans',    cat: 'greens', peak: 0.5,  band: 0.42, water: 0,    yield: 1.0 },
  { id: 'onions',   name: 'Onions',   cat: 'greens', peak: 0.5,  band: 0.45, water: 0,    yield: 0.9 },
  { id: 'squash',   name: 'Squash',   cat: 'greens', peak: 0.72, band: 0.4,  water: 0.15, yield: 1.05 },
  { id: 'apples',   name: 'Apples',   cat: 'fruit',  peak: 0.45, band: 0.4,  water: 0.1,  yield: 1.0 },
  { id: 'pears',    name: 'Pears',    cat: 'fruit',  peak: 0.5,  band: 0.4,  water: 0.1,  yield: 0.95 },
  { id: 'grapes',   name: 'Grapes',   cat: 'fruit',  peak: 0.68, band: 0.36, water: 0,    yield: 1.05 },
  { id: 'olives',   name: 'Olives',   cat: 'fruit',  peak: 0.76, band: 0.35, water: 0,    yield: 1.0 },
  { id: 'melons',   name: 'Melons',   cat: 'fruit',  peak: 0.85, band: 0.35, water: 0.25, yield: 1.1 },
  { id: 'dates',    name: 'Dates',    cat: 'fruit',  peak: 0.92, band: 0.35, water: 0.15, yield: 1.05 },
];
const CROP_BY_ID = Object.fromEntries(CROPS.map((c) => [c.id, c]));

// cropSuit: how well a crop grows here, 0..1 — a climate bell around its `peak`
// warmth, times a water factor when the crop is thirsty (never fully zero on
// water alone, so a dry rice paddy just yields poorly rather than not at all).
function cropSuit(crop, warmth, water) {
  const climate = Math.max(0, 1 - Math.abs(warmth - crop.peak) / crop.band);
  if (climate <= 0) return 0;
  const wf = crop.water > 0 ? Math.max(0.15, Math.min(1, water / crop.water)) : 1;
  return climate * wf;
}

// ---- research: discovering the real simulated world --------------------
// Every discovery is a NAMED decoding of a field the world dump (window.WORLD,
// via window.XAN) already carries at the hold's seat — rock/rockAge/salt/
// drainage/nearby features/realm history — never an invented fact. Names mirror
// the sim's own enums (geology.go's Rock*, salt.go's SaltStanding, civ.go).
// Effects are DATA read LIVE (researchMul/Def/Pop/…), so nothing mutates `bon`.
const ROCK_NAME = { 1: 'basement shield', 2: 'orogenic rock', 3: 'marine sediment', 4: 'alluvium', 5: 'glacial till', 6: 'loess', 7: 'volcanic rock' };
// Per-dominant-rock output lean (from geology.go's SoilFertility + lithology).
const ROCK_BONUS = { 1: { ore: 1.08, stone: 1.06 }, 2: { ore: 1.12 }, 3: { salt: 1.08 }, 4: { food: 1.08 }, 5: { stone: 1.08 }, 6: { food: 1.06, timber: 1.04 }, 7: { food: 1.06, ore: 1.06 } };

// domRockId — the hold's dominant bedrock id (mode of the neighborhood tally).
function domRockId(h) {
  let best = 0, bc = -1;
  for (const [id, c] of Object.entries((h.n && h.n.rock) || {})) if (c > bc) { bc = c; best = +id; }
  return best;
}
// researchSeatData reads the sim's world story around a seat that deriveHold
// doesn't surface — the seat-cell geology (rockAge/drainage), the realm's age
// and crown, the nearest rival realm + neighboring hall, and the deep-time
// climate — straight from window.WORLD. Constant per hold (never serialized).
function researchSeatData(h) {
  let rockAge = 0, drainage = 0, realmAge = 1, crownName = '', rival = null, neighbor = null;
  let era = 'now', kya = 0, glacialIndex = 0;
  const X = window.XAN;
  if (X) {
    const W = X.W, i = X.idx(h.x, h.y);
    rockAge = W.rockAge[i] || 0; drainage = W.drainage[i] || 0;
    era = W.era; kya = W.kya; glacialIndex = (W.climate && W.climate.glacialIndex) || 0;
    const rm = W.realms.find((r) => r.name === h.realm);
    if (rm) realmAge = rm.age || 1;
    const crown = W.realms.find((r) => r.isCrown);
    crownName = crown ? crown.name : '';
    // nearest OTHER realm's leading seat — a rival power at the border.
    rival = W.realms.filter((r) => r.name !== h.realm)
      .map((r) => ({ name: r.name, dist: Math.abs(r.seatX - h.x) + Math.abs(r.seatY - h.y), crown: r.isCrown }))
      .sort((a, b) => a.dist - b.dist)[0] || null;
    // nearest neighboring hall (not this seat) — its loyalty + war-pressure name it ally or threat.
    const nm = {}; for (const r of W.realms) nm[r.id] = r.name;
    neighbor = W.seats.filter((s) => !(s.x === h.x && s.y === h.y))
      .map((s) => ({ name: s.name, dist: Math.abs(s.x - h.x) + Math.abs(s.y - h.y), allegiance: s.allegiance, pressure: s.pressure, realm: nm[s.realm] || 'the free holds' }))
      .sort((a, b) => a.dist - b.dist)[0] || null;
  }
  return { rockAge, drainage, realmAge, rock: domRockId(h), elev: Math.round(h.elev || 0), crownName, isCrown: !!h.realmCrown, rival, neighbor, era, kya, glacialIndex };
}
// nearest named feature of a kind within the hold's charted radius (hold.nearby).
function nearFeat(h, ...kinds) { return (h.nearby || []).find((f) => kinds.includes(f.kind)) || null; }
// all charted features of the given kinds (for a census, not just the nearest).
function nearFeats(h, ...kinds) { return (h.nearby || []).filter((f) => kinds.includes(f.kind)); }
// rockAgeBand — the geologic depth of the surface, against the sim's own marks
// (meltKya≈20, LGM≈205ka from era.go).
function rockAgeBand(ka) { return ka < 20 ? 'post-Melt' : ka < 100 ? 'Holocene' : ka < 205 ? 'glacial' : 'Old Ice'; }

// The catalogue: 7 Sciences (the ground) + 14 Lore (the world's history —
// bloodline, crown, rivals, neighbors, deep-time ice, the wyrms). `gate(h, sd)`
// is the data test (only discoverable where the seed-42 world supports it);
// `flavor` cites the real value; `eff` (object or (h,sd)=>object) is applied
// live. `requires` gates a small tree; `cost` is insight (tier 1≈40 / 2≈90 / 3≈160).
const RESEARCH = [
  // --- Sciences ---
  { id: 'bedrock', cat: 'science', name: 'Bedrock Survey', tier: 1, cost: 40, requires: [],
    gate: () => true,
    flavor: (h) => `the ground is chiefly ${ROCK_NAME[domRockId(h)] || 'unknown rock'}`,
    eff: (h) => ({ mul: ROCK_BONUS[domRockId(h)] || {} }) },
  { id: 'groundage', cat: 'science', name: 'The Ground’s Age', tier: 2, cost: 90, requires: ['bedrock'],
    gate: () => true,
    flavor: (h, sd) => `the surface was laid down ${sd.rockAge}ka past — ${rockAgeBand(sd.rockAge)} ground`,
    eff: (h, sd) => (sd.rockAge < 20 ? { mul: { food: 1.04 } } : sd.rockAge < 100 ? { mul: { stone: 1.04 } } : sd.rockAge < 205 ? { mul: { ore: 1.06 } } : { mul: { ore: 1.08 } }) },
  { id: 'hydrology', cat: 'science', name: 'Charting the Waters', tier: 2, cost: 90, requires: [],
    gate: (h, sd) => (h.n && h.n.riverMax >= 3) || sd.drainage >= 100,
    flavor: (h, sd) => `a catchment of ${sd.drainage} draining cells feeds the ground`,
    eff: { mul: { food: 1.08 } } },
  { id: 'husbandry', cat: 'science', name: 'The Good Ground', tier: 2, cost: 90, requires: [],
    gate: (h) => (h.rich.food || 0) >= 0.5,
    flavor: () => 'the fields answer to rotation and careful tillage',
    eff: { mul: { food: 1.06 } } },
  { id: 'saltassay', cat: 'science', name: 'Salt Assay', tier: 2, cost: 90, requires: [],
    gate: (h) => (h.rich.salt || 0) >= 0.12,
    flavor: (h) => `salt stands ${(h.rich.salt || 0) >= 0.45 ? 'salt-rich' : 'salt-fed'} here`,
    eff: (h) => ((h.rich.salt || 0) >= 0.45 ? { preserveAdd: 0.05, mul: { salt: 1.15 } } : { preserveAdd: 0.05 }) },
  { id: 'climatology', cat: 'science', name: 'Reading the Sky', tier: 1, cost: 40, requires: [],
    gate: () => true,
    flavor: (h) => `the air runs ${h.tempBand}`,
    eff: (h) => (h.tempBand === 'frigid' || h.tempBand === 'cold' ? { spoilMul: 0.9 } : h.tempBand === 'warm' || h.tempBand === 'sweltering' ? { preserveAdd: 0.05 } : {}) },
  { id: 'metallurgy', cat: 'science', name: 'Assay the Vein', tier: 3, cost: 160, requires: ['bedrock', 'groundage'],
    gate: (h) => (h.rich.ore || 0) >= 0.5,
    flavor: (h) => `the rock is ore-rich (${Math.round((h.rich.ore || 0) * 100)}%) — worth the shaft`,
    eff: { mul: { ore: 1.15 }, def: 1 } },
  // --- Lore ---
  { id: 'ancestry', cat: 'lore', name: 'Whose the Land', tier: 1, cost: 40, requires: [],
    gate: () => true,
    flavor: (h) => `${h.ancestry === 'Northern' ? 'the mammoth-blood of the frozen north — kin who held the high refugia through the ice' : h.ancestry === 'Coastal' ? 'shore-folk of the receded coast — the first fielders of the drawn-down shelf' : 'the hybrid river-stock of the cradle, come south after the Melt'} settled it`,
    eff: { pop: 1 } },
  { id: 'migration', cat: 'lore', name: 'The Peoples’ Road', tier: 2, cost: 90, requires: ['ancestry'],
    gate: () => true,
    flavor: (h) => (h.ancestry === 'Northern' ? 'its folk trace to the mountain refugia — miners and hunters of the high cold ground' : h.ancestry === 'Coastal' ? 'its folk trace to the drawn-down shelf — the elder shore-farmers' : 'its folk followed the new rivers into the cradle, the youngest of the three peoples'),
    eff: (h) => (h.ancestry === 'Northern' ? { mul: { ore: 1.05 } } : h.ancestry === 'Coastal' ? { mul: { coin: 1.05 } } : { mul: { food: 1.05 } }) },
  { id: 'realmage', cat: 'lore', name: 'The Realm’s Age', tier: 1, cost: 40, requires: [],
    gate: () => true,
    flavor: (h, sd) => `${h.realm}${sd.isCrown ? ', the crown,' : ''} has stood ${sd.realmAge} sealed age${sd.realmAge === 1 ? '' : 's'}`,
    eff: (h, sd) => ({ mul: { coin: 1 + 0.05 * sd.realmAge } }) },
  { id: 'crownstate', cat: 'lore', name: 'Crown or Peer', tier: 1, cost: 40, requires: [],
    gate: () => true,
    flavor: (h, sd) => (sd.isCrown ? `${h.realm} is the crown of the river-realms — the downstream heartland power` : `${h.realm} is a peer-realm; ${sd.crownName || 'the crown'} wears the crown`),
    eff: (h, sd) => (sd.isCrown ? { mul: { coin: 1.1 } } : { def: 1 }) },
  { id: 'rivals', cat: 'lore', name: 'The Rival Realms', tier: 2, cost: 90, requires: ['realmage'],
    gate: (h, sd) => !!sd.rival && sd.rival.dist <= 40,
    flavor: (h, sd) => `the seat of ${sd.rival.name} lies ${sd.rival.dist} off — ${sd.rival.crown ? 'the crown itself' : 'a rival power'} across the marches`,
    eff: { mul: { coin: 1.06 } } },
  { id: 'neighbors', cat: 'lore', name: 'The Bordering Halls', tier: 2, cost: 90, requires: ['realmage'],
    gate: (h, sd) => !!sd.neighbor && sd.neighbor.dist <= 12,
    flavor: (h, sd) => `the hall ${sd.neighbor.name} stands ${sd.neighbor.dist} off, sworn to ${sd.neighbor.realm} (loyalty ${(sd.neighbor.allegiance || 0).toFixed(2)})`,
    eff: { pop: 1 } },
  { id: 'warpressure', cat: 'lore', name: 'The Contested Frontier', tier: 2, cost: 90, requires: [],
    gate: (h) => (h.pressure || 0) >= 5,
    flavor: (h) => `war-pressure bears on it at ${h.pressure} — the wilds and rival banners both press here`,
    eff: { def: 1 } },
  { id: 'deeptime', cat: 'lore', name: 'The Long Ice', tier: 1, cost: 40, requires: [],
    gate: () => true,
    flavor: (h, sd) => `the world stands at ${sd.era} (${sd.kya}ka), glacial index ${sd.glacialIndex.toFixed(2)} — ${sd.glacialIndex < 0.2 ? 'the warm present, long after the Melt' : sd.glacialIndex > 0.6 ? 'deep in the Old Ice' : 'a cooling age'}`,
    eff: (h, sd) => (sd.glacialIndex >= 0.5 ? { spoilMul: 0.92 } : { mul: { food: 1.05 } }) },
  { id: 'allegiance', cat: 'lore', name: 'The Crown’s Reach', tier: 1, cost: 40, requires: [],
    gate: () => true,
    flavor: (h) => `its loyalty to ${h.realm} reads ${(h.allegiance || 0).toFixed(2)}`,
    eff: (h) => ((h.allegiance || 0) >= 0.8 ? { mul: { coin: 1.1 } } : (h.allegiance || 0) >= 0.4 ? { def: 1 } : { mul: { salt: 1.1, timber: 1.05 } }) },
  { id: 'lakes', cat: 'lore', name: 'Lakes Named', tier: 2, cost: 90, requires: ['realmage'],
    gate: (h) => !!nearFeat(h, 'lake'),
    flavor: (h) => `the lake ${nearFeat(h, 'lake').name} lies close`,
    eff: { pop: 1 } },
  { id: 'oldroad', cat: 'lore', name: 'The Old Road Over', tier: 3, cost: 160, requires: ['realmage'],
    gate: (h) => !!nearFeat(h, 'pass'),
    flavor: (h) => `the pass ${nearFeat(h, 'pass').name} crosses the ridge nearby`,
    eff: { mul: { coin: 1.12 } } },
  { id: 'oldfire', cat: 'lore', name: 'The Old Fire', tier: 3, cost: 160, requires: ['bedrock'],
    gate: (h) => !!nearFeat(h, 'volcano'),
    flavor: (h) => `the vent ${nearFeat(h, 'volcano').name} weathered rich soil nearby`,
    eff: { mul: { food: 1.06, ore: 1.04 } } },
  { id: 'dragonlairs', cat: 'lore', name: 'Dragon Lairs Marked', tier: 3, cost: 160, requires: ['realmage'],
    gate: (h) => !!nearFeat(h, 'den', 'nest', 'rookery'),
    flavor: (h) => { const f = nearFeat(h, 'den', 'nest', 'rookery'); const w = { den: 'dragon den', nest: 'drake nest', rookery: 'wyvern rookery' }[f.kind]; return `the ${w} ${f.name} is charted ${f.dist} off — the watch keeps its bearing`; },
    eff: { def: 1 } },
  { id: 'wyrmcensus', cat: 'lore', name: 'The Wyrm Census', tier: 3, cost: 160, requires: ['dragonlairs'],
    gate: (h) => nearFeats(h, 'den', 'nest', 'rookery').length >= 2,
    flavor: (h) => { const l = nearFeats(h, 'den', 'nest', 'rookery'); const d = l.filter((f) => f.kind === 'den').length, n = l.filter((f) => f.kind === 'nest').length, r = l.filter((f) => f.kind === 'rookery').length; return `${l.length} lairs within reach (${d} dragon, ${n} drake, ${r} wyvern) — this is dragon-haunted country`; },
    eff: { mul: { ore: 1.05 } } }, // the wyrm-hills are mineral country — a boon mastered, not another wall
];
const RESEARCH_BY_ID = Object.fromEntries(RESEARCH.map((d) => [d.id, d]));

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
      this.res = { grain: 42, roots: 12, greens: 6, fruit: 0, fish: 0, timber: 40, stone: 18, ore: 5, salt: 3, coin: 25 };
      // A hold starts leaning into its richest good (food richness → its staple grain).
      const top = Object.entries(hold.rich).sort((a, b) => b[1] - a[1])[0][0];
      const topKey = top === 'food' ? 'grain' : top;
      this.res[topKey] = (this.res[topKey] || 0) + 20;
      this.pop = 8;
      // Per-building levels: instances[id] = [lvlA, lvlB…], one level per
      // physical building. No starting farm — localSteward breaks first ground.
      this.instances = {};
      if (hold.tierName === 'saltern') this.instances.saltern = [1];
      if (this.water > 0.12) this.instances.wharf = [1];
      this.founded = Date.now();
      this.log = [];
      this.raidClock = CFG.raidIntervalS;
      this.pushLog(`${hold.name} is yours to steward — a ${hold.tierName} of ${hold.realm}, in the ${hold.region}. The folk look to you.`, 'note');
    }
    this.lastTick = this.lastTick || Date.now();
    // Faith: the hold's devotion toward the fallen god, accumulated in step()
    // and spent when it crosses faithThreshold(). Not a tradeable resource —
    // no res[] entry, no cap — so pre-faith saves just start at 0.
    this.faith = this.faith || 0;
    this.faithReady = false; // set true by stepFaith() when faith crosses threshold
    // Research: insight accrued from scholars + the discoveries already made
    // (ids into RESEARCH). Pre-research saves start empty. seatData/discoveryTally
    // are derived/transient — recomputed on load, never serialized.
    this.research = this.research || { insight: 0, done: [] };
    if (!Array.isArray(this.research.done)) this.research.done = [];
    this.research.insight = this.research.insight || 0;
    this.seatData = researchSeatData(this.h);
    this.discoveryTally = 0; // town.js mirrors new discoveries to the chronicle, like raids/spoilage
    // Morale + health: happiness (0..1) eases toward happinessTarget() and gates
    // growth/emigration; sickness strikes on a clock like raids. Pre-F5 saves
    // default to a content, healthy hold.
    this.happiness = this.happiness ?? 0.6;
    this.moraleShock = this.moraleShock || 0;
    this.diseaseClock = this.diseaseClock ?? CFG.diseaseIntervalS;
    this.plagueTally = this.plagueTally || 0;
    // Farm fields: each is an individual plot with a size (grown by expansion)
    // and a crop. Seeded from the farm level so old saves migrate cleanly.
    this.farmPlots = this.farmPlots || [];
    this.migrateInstances(); // old pooled lvl → per-building instances (+ seed fields from an old lvl.farm)
    this.migrateFood(); // split a pre-crop save's pooled food + retag old plot crops
    if (!this.instances.keep) this.instances.keep = [1]; // the keep always stands (level 1 from founding)
    // Spoilage read-outs (transient, for the HUD) — recomputed each tick by
    // stepSpoilage. spoilTally counts notable turns (town.js mirrors it to the
    // on-screen chronicle, like raids); _spoilAccrue banks small losses toward
    // the next log line.
    this.spoilLast = 0; this.spoilSaltLast = 0;
    this.spoilTally = 0; this._spoilAccrue = 0;
  }

  // ---- crops + food totals -------------------------------------------
  // pickCrop chooses what a new field grows: a weighted-random draw over the
  // crops this hold's climate + water actually suit (cropSuit ≥ 0.2), weighted
  // BY suitability so its fields read as a varied-but-climate-true spread rather
  // than a monoculture of the single best crop. `preferCat` biases toward one
  // food category (used when migrating an old save's category-named plot).
  pickCrop(preferCat) {
    const w = this.h.warmth, water = this.water;
    let pool = CROPS.map((c) => ({ c, s: cropSuit(c, w, water) })).filter((x) => x.s >= 0.2 && (!preferCat || x.c.cat === preferCat));
    if (!pool.length) pool = CROPS.map((c) => ({ c, s: Math.max(0.02, cropSuit(c, w, water)) })).filter((x) => !preferCat || x.c.cat === preferCat);
    if (!pool.length) pool = CROPS.map((c) => ({ c, s: Math.max(0.02, cropSuit(c, w, water)) }));
    const tot = pool.reduce((a, x) => a + x.s, 0) || 1;
    let r = Math.random() * tot;
    for (const x of pool) { if ((r -= x.s) <= 0) return x.c.id; }
    return pool[0].c.id;
  }
  // viableCrops: every crop the land supports well enough to be worth planting.
  viableCrops() {
    const w = this.h.warmth, water = this.water;
    return CROPS.filter((c) => cropSuit(c, w, water) >= 0.2);
  }
  foodTotal() { let s = 0; for (const c of FOOD_CATS) s += (this.res[c] || 0); return s; }
  foodCapTotal() { const caps = this.caps(); let s = 0; for (const c of FOOD_CATS) s += (caps[c] || 0); return s; }
  foodRateTotal(rate) { let s = 0; for (const c of FOOD_CATS) s += (rate[c] || 0); return s; }
  // migrateFood normalizes an old save: a single pooled res.food → the five
  // categories (staples-heavy), and any plot still tagged with an old CATEGORY
  // name (greens/grain/roots) → a specific crop of that category, climate-suited.
  migrateFood() {
    if (this.res.food != null && this.res.grain == null) {
      const f = this.res.food; delete this.res.food;
      this.res.grain = (this.res.grain || 0) + f * 0.5; this.res.roots = f * 0.2;
      this.res.greens = f * 0.15; this.res.fish = f * 0.15;
    }
    for (const c of FOOD_CATS) if (this.res[c] == null) this.res[c] = 0;
    for (const p of (this.farmPlots || [])) {
      if (!CROP_BY_ID[p.crop]) p.crop = this.pickCrop(p.crop === 'greens' || p.crop === 'roots' ? p.crop : 'grain');
    }
  }

  // migrateInstances upgrades a pre-per-instance save: the old pooled `lvl`
  // (one number per type = count AND output) becomes `instances` (a level per
  // physical building). The pooled level is split across the SAME number of
  // sprites the old model drew, so both total output and building count carry
  // over. An old lvl.farm seeds that many fields (farms live in farmPlots —
  // a field's size IS its level).
  migrateInstances() {
    if (this.instances && !this.lvl) return;       // already new-model (fresh game or new save)
    const old = this.lvl || {};
    this.instances = this.instances || {};
    const CAP = 8;                                  // MAX_PER_TYPE (town.js) — the drawn-instance ceiling
    const oldCount = (id, lv) => {
      if (id === 'mine') return Math.min(CAP, lv);  // 1:1 with ore veins
      const b = BY_ID[id], div = b && b.kind === 'prod' ? 1.5 : 1;
      return Math.min(CAP, Math.max(1, Math.round(lv / div)));
    };
    for (const [id, lv] of Object.entries(old)) {
      if (id === 'farm' || lv <= 0 || this.instances[id]) continue;
      const cnt = oldCount(id, lv), arr = [];
      for (let k = 0; k < cnt; k++) arr.push(Math.floor(lv / cnt) + (k < lv % cnt ? 1 : 0));
      this.instances[id] = arr.filter((x) => x > 0);
    }
    if ((old.farm || 0) > 0 && this.farmPlots.length === 0) {
      for (let i = 0; i < old.farm; i++) this.farmPlots.push({ size: 1, crop: this.pickCrop() });
    }
    delete this.lvl;
  }

  // newFarm builds a fresh field (its own plot), optionally of a chosen crop —
  // the alternative to expanding an existing one. Default crop is climate-picked.
  newFarm(crop) {
    if (!this.build('farm')) return false; // pays build cost, raises farm level
    this.farmPlots.push({ size: 1, crop: crop || this.pickCrop() });
    return true;
  }

  // expandFarm grows the smallest not-yet-maxed field in place — cheaper than a
  // new farm but its yield still rises. Returns the plot index, or -1.
  // Does NOT touch lvl.farm: that's a worksite count (jobs()/roleWeights read
  // it as "how many farmer jobs exist"), and a field getting bigger in place
  // isn't a new worksite — only newFarm() (a real new field) should raise it.
  expandFarm() {
    const MAX = 3;
    let cand = null;
    for (const p of this.farmPlots) if (p.size < MAX && (!cand || p.size < cand.size)) cand = p;
    if (!cand) return -1;
    const cost = this.expandCost(cand);
    if (!Object.entries(cost).every(([k, v]) => this.res[k] >= v)) return -1;
    for (const [k, v] of Object.entries(cost)) this.res[k] -= v;
    cand.size += 1;
    return this.farmPlots.indexOf(cand);
  }
  expandCost(plot) { return { timber: Math.ceil(8 * plot.size), coin: Math.ceil(5 * plot.size) }; }

  // richOf resolves a building's richness key (water is derived).
  richOf(b) { return b.rich === 'water' ? this.water : (this.h.rich[b.rich] || 0); }

  available() {
    return BUILDINGS.filter((b) => {
      if (b.kind !== 'prod') return true;
      // Offered if the land supports it, or you already have one.
      return this.richOf(b) >= b.gate || this.count(b.id) > 0;
    });
  }

  // level(id) is the hold's TOTAL level in a building type — the sum of its
  // per-building instance levels (farms: the field count). Everything
  // downstream (rates, caps, defense, popCap, jobs) reads this total, so the
  // per-instance split is invisible to them. count(id) = physical buildings;
  // instanceLevel(id, idx) = one building's level (a field's size).
  level(id) {
    if (id === 'farm') return (this.farmPlots || []).length;
    const a = this.instances[id]; let s = 0;
    if (a) for (const l of a) s += l;
    return s;
  }
  count(id) {
    if (id === 'farm') return (this.farmPlots || []).length;
    return (this.instances[id] || []).length;
  }
  instanceLevel(id, idx) {
    if (id === 'farm') { const p = (this.farmPlots || [])[idx]; return p ? p.size : 0; }
    return (this.instances[id] || [])[idx] || 0;
  }

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

  // build(id) raises a WHOLE new building (a level-1 instance). Farms are the
  // exception: the caller (newFarm/startFarmSite) pushes the field into
  // farmPlots — build just pays and confirms.
  build(id) {
    if (!this.canAfford(id)) return false;
    const c = this.costOf(id);
    for (const [k, v] of Object.entries(c)) this.res[k] -= v;
    if (id === 'farm') return true;
    if (id === 'keep') { this.instances.keep[0] += 1; return true; } // never a 2nd keep — deepen the one that stands
    (this.instances[id] || (this.instances[id] = [])).push(1);
    return true;
  }

  // ---- per-building upgrades -----------------------------------------
  // Each physical building has its own level; upgrading DEEPENS one instance
  // (more output/capacity from the same footprint), as distinct from build()
  // raising a new one. Farms upgrade by field SIZE (expandFarm) — the same
  // idea that predates this system.
  instanceMax(id) { return id === 'farm' ? 3 : id === 'keep' ? 4 : 6; }
  upgradeCost(id, idx) {
    const b = BY_ID[id], L = this.instanceLevel(id, idx), out = {};
    for (const [k, v] of Object.entries(b.cost)) out[k] = Math.ceil(v * 0.8 * Math.pow(CFG.costScale, L));
    return out;
  }
  canUpgrade(id, idx) {
    if (this.instanceLevel(id, idx) >= this.instanceMax(id)) return false;
    return Object.entries(this.upgradeCost(id, idx)).every(([k, v]) => (this.res[k] || 0) >= v);
  }
  canUpgradeAny(id) {
    const arr = this.instances[id] || [];
    for (let i = 0; i < arr.length; i++) if (this.canUpgrade(id, i)) return true;
    return false;
  }
  // canDeepen — is any instance STRUCTURALLY upgradable (below its max),
  // ignoring cost? The order gates use this to decide "satisfiable at all"
  // (money is handled by autoFund downstream), not "affordable this instant".
  canDeepen(id) {
    const max = this.instanceMax(id);
    return (this.instances[id] || []).some((l) => l < max);
  }
  upgrade(id, idx) {
    if (id === 'farm') return this.expandFarm() >= 0; // fields deepen by size (idx ignored — smallest grows)
    if (!this.canUpgrade(id, idx)) return false;
    for (const [k, v] of Object.entries(this.upgradeCost(id, idx))) this.res[k] -= v;
    this.instances[id][idx] += 1;
    return true;
  }
  // upgradeAny deepens the lowest still-growable instance — the steward's
  // "raise a level here" when build() would only sprawl another sprite.
  upgradeAny(id) {
    if (id === 'farm') return this.expandFarm() >= 0;
    const arr = this.instances[id] || [];
    let idx = -1, lo = Infinity;
    for (let i = 0; i < arr.length; i++) if (arr[i] < this.instanceMax(id) && this.canUpgrade(id, i) && arr[i] < lo) { lo = arr[i]; idx = i; }
    return idx >= 0 ? this.upgrade(id, idx) : false;
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
    cap += this.keepPop();
    cap += this.researchPop();
    return cap;
  }

  // popCapBreakdown — the people-cap math behind popCap(), split per housing
  // source so the Pop panel can show what raises the cap (base + longhouses).
  popCapBreakdown() {
    const base = 8 + this.bon.popCapBonus;   // hearth + tier (a capital seats more)
    const contributors = [];
    const lh = this.level('longhouse');
    if (lh > 0) contributors.push({ id: 'longhouse', name: BY_ID.longhouse.name, count: lh, add: lh * BY_ID.longhouse.pop });
    const kp = this.keepPop();
    if (kp > 0) contributors.push({ id: 'keep', name: 'The Keep', count: this.level('keep'), add: kp });
    const rp = this.researchPop();
    if (rp > 0) contributors.push({ id: 'research', name: 'Discoveries', count: this.doneDiscoveries().filter((d) => this.effOf(d).pop).length, add: rp });
    return { base, contributors, total: this.popCap() };
  }

  defense() { return this.level('palisade') * BY_ID.palisade.def + this.level('barracks') * BY_ID.barracks.def + this.bon.defBonus + this.keepDef() + this.researchDef(); }

  // keepDef/keepPop — the keep's functional worth, all ABOVE its founding
  // level 1 (so a level-1 keep leaves the old balance exactly): each level
  // raised adds +2 defense and +4 people cap (and +1 troop cap, see troopCap).
  keepDef() { return Math.max(0, this.level('keep') - 1) * 2; }
  keepPop() { return Math.max(0, this.level('keep') - 1) * 4; }

  // speakers — how many voices the hold's shrines give the fallen god: one
  // always present, plus one more per reliquary raised.
  speakers() { return 1 + this.level('reliquary'); }

  // faithThreshold — the bar faith must clear to invoke the Will. It climbs
  // with speakers, so a more devout hold needs a fuller welling of faith —
  // but its speakers also fill it faster, so more reliquaries still means
  // the god is heard from more often, not less.
  faithThreshold() { return CFG.faithBase + this.speakers() * CFG.faithPerSpeakerThresh; }

  // ---- research ------------------------------------------------------
  // scholars — voices studying the land: one always (the lord's own study),
  // +2 per Scholars' Hall level. Insight accrues from them (stepResearch).
  researchers() { return 1 + this.level('scholarshall') * 2; }
  doneDiscoveries() { return this.research.done.map((id) => RESEARCH_BY_ID[id]).filter(Boolean); }
  effOf(d) { return typeof d.eff === 'function' ? d.eff(this.h, this.seatData) : (d.eff || {}); }
  // Live bonus reads — the sum/product of every made discovery's effect, read
  // fresh each call (never baked into `bon`, so a bon rebuild can't drop them).
  researchMul(res) { let m = 1; for (const d of this.doneDiscoveries()) { const e = this.effOf(d); if (e.mul && e.mul[res]) m *= e.mul[res]; } return m; }
  researchDef() { let s = 0; for (const d of this.doneDiscoveries()) s += this.effOf(d).def || 0; return s; }
  researchPop() { let s = 0; for (const d of this.doneDiscoveries()) s += this.effOf(d).pop || 0; return s; }
  researchFoodEatMul() { let m = 1; for (const d of this.doneDiscoveries()) { const f = this.effOf(d).foodEat; if (f) m *= f; } return m; }
  researchSpoilMul() { let m = 1; for (const d of this.doneDiscoveries()) { const f = this.effOf(d).spoilMul; if (f) m *= f; } return m; }
  researchPreserveAdd() { let s = 0; for (const d of this.doneDiscoveries()) s += this.effOf(d).preserveAdd || 0; return s; }

  // researchEligible — the discoveries this hold can make next: not yet done,
  // prerequisites met, and the seed-42 ground actually supports them (gate).
  researchEligible() {
    const done = this.research.done;
    return RESEARCH.filter((d) => !done.includes(d.id) && d.requires.every((r) => done.includes(r)) && d.gate(this.h, this.seatData));
  }
  researchNext() { const e = this.researchEligible(); return e.length ? e.sort((a, b) => a.cost - b.cost || a.tier - b.tier)[0] : null; }
  // stepResearch accrues insight and auto-makes the cheapest eligible discovery
  // when it's covered — the same shape as faith crossing its threshold. Insight
  // freezes when nothing is left to learn here (all reachable gates exhausted).
  stepResearch(dt) {
    if (!this.researchNext()) return;              // nothing eligible — don't pile up insight
    this.research.insight += this.researchers() * CFG.insightPerScholar * dt;
    let guard = 0;
    while (guard++ < RESEARCH.length) {
      const next = this.researchNext();
      if (!next || this.research.insight < next.cost) break;
      this.research.insight -= next.cost;
      this.researchUnlock(next);
    }
  }
  researchUnlock(d) {
    this.research.done.push(d.id);
    this.discoveryTally = (this.discoveryTally || 0) + 1;
    this.pushLog(`Discovered: ${d.name} — ${d.flavor(this.h, this.seatData)}.`, 'discovery');
  }

  // capBreakdown(k) — the cap math behind caps(), broken out per contributing
  // storage building so hovers can show *why* a resource caps where it does.
  // A storage building's `capRes` (if set) lists which resource keys it
  // caps; omitted means "every non-coin good" (the granary's case today) —
  // so a future building that only caps e.g. food just adds `capRes:['food']`.
  // caps() is built from this same computation, so the two can never drift.
  capBreakdown(k) {
    const base = CFG.baseCaps[k];
    if (k === 'coin') return { base, contributors: [], total: base }; // coin: effectively uncapped
    const contributors = [];
    let add = 0;
    for (const b of BUILDINGS) {
      if (b.kind !== 'storage') continue;
      if (b.capRes && !b.capRes.includes(k)) continue;
      const lv = this.level(b.id);
      if (!lv) continue;
      const thisAdd = base * lv * b.capMul;
      add += thisAdd;
      contributors.push({ id: b.id, name: b.name, count: lv, add: thisAdd });
    }
    return { base, contributors, total: base + add };
  }

  caps() {
    const out = {};
    for (const k of Object.keys(CFG.baseCaps)) out[k] = this.capBreakdown(k).total;
    return out;
  }

  // production per second, per resource, at current efficiency & pop. Food is
  // five categories: FARMS grow per-plot (each plot's crop → its category,
  // scaled by how well the climate suits that crop AND the soil's fertility),
  // and WHARVES land fish. Everything else is the flat level×richness output.
  rates(offline = false) {
    const eff = this.efficiency();
    const out = { grain: 0, roots: 0, greens: 0, fruit: 0, fish: 0, timber: 0, stone: 0, ore: 0, salt: 0, coin: 0 };
    const fMul = this.bon.mul.food * this.researchMul('food'), fertile = 0.35 + 0.65 * (this.h.rich.food || 0);
    const warmth = this.warmthNow(offline);          // crops grow to the season's warmth, not just the baseline
    for (const p of this.farmPlots) {
      const crop = CROP_BY_ID[p.crop];
      if (!crop) continue;
      const suit = cropSuit(crop, warmth, this.water);
      out[crop.cat] += BY_ID.farm.base * (p.size || 1) * crop.yield * suit * fertile * eff * fMul;
    }
    const wl = this.level('wharf');
    if (wl) out.fish += BY_ID.wharf.base * wl * (0.35 + 0.65 * this.water) * eff * fMul;
    for (const b of BUILDINGS) {
      if (b.kind !== 'prod' || b.id === 'farm' || b.id === 'wharf') continue;
      const lv = this.level(b.id);
      if (!lv) continue;
      out[b.res] += b.base * lv * (0.35 + 0.65 * this.richOf(b)) * eff * this.bon.mul[b.res] * this.researchMul(b.res);
    }
    return out;
  }

  foodEatPerS() { return this.pop * CFG.foodPerPop * this.bon.foodEat * this.researchFoodEatMul(); }

  // ---- food spoilage -------------------------------------------------
  // daylight: the same 0..1 curve town.js paints the night overlay from (noon=1,
  // midnight=0), computed from the shared day clock so the "food spoils in the
  // sun" factor tracks exactly what's on screen. Offline there's no single
  // moment to read, so we use the daily average (0.5) — catch-up spans whole
  // days anyway.
  dayFrac() { return (Date.now() % CFG.dayMs) / CFG.dayMs; }
  daylight(offline = false) { return offline ? 0.5 : 0.5 + 0.5 * Math.sin((this.dayFrac() - 0.25) * 2 * Math.PI); }
  // dayPartName — the readable phase of the day (for the HUD sky chip).
  dayPartName() {
    const l = this.daylight();
    if (l > 0.75) return 'Day';
    if (l < 0.25) return 'Night';
    return this.dayFrac() < 0.5 ? 'Dawn' : 'Dusk'; // rising vs falling half of the light curve
  }

  // ---- seasons -------------------------------------------------------
  // The year turns through four seasons (CFG.seasonDays each), shifting the
  // hold's warmth — summer hotter, winter colder. That flows into crop growth
  // (rates) and food spoilage (stepSpoilage): a warm reach bakes in summer, a
  // frigid march freezes its fields in winter.
  seasonFrac() { return (Date.now() % YEAR_MS) / YEAR_MS; }   // 0 = spring's start … 1
  seasonName() { return ['Spring', 'Summer', 'Autumn', 'Winter'][Math.floor(this.seasonFrac() * 4) % 4]; }
  seasonWarmthDelta() { return CFG.seasonWarmthAmp * Math.sin(this.seasonFrac() * 2 * Math.PI); }
  // warmthNow — the hold's warmth AS FELT NOW (baseline climate + season).
  // Offline catch-up spans whole seasons, so it uses the baseline (no delta),
  // mirroring daylight(offline)'s daily-average trick.
  warmthNow(offline = false) {
    const w = Math.max(0, Math.min(1, this.h.warmth || 0));
    return offline ? w : Math.max(0, Math.min(1, w + this.seasonWarmthDelta()));
  }

  // foodOnGround: the fraction of ALL stored food that no storehouse can shelter
  // — food beyond the sheds' added capacity (summed across the five categories)
  // is piled in the open (full ground penalty). With no storehouse all of it is
  // on the ground (1.0); enough sheds to cover the pile drops it toward 0.
  foodOnGround() {
    const food = this.foodTotal();
    if (food <= 0) return 0;
    let shelter = 0;
    for (const c of FOOD_CATS) { const cb = this.capBreakdown(c); shelter += cb.total - cb.base; }
    return Math.max(0, food - shelter) / food;
  }

  // stepSpoilage turns some of the stored food each tick, PER CATEGORY, and
  // returns the total lost. The temp/sun/ground severity is SHARED (TEMP gates:
  // frigid 0.2 → hot 1.0; SUN + GROUND are exposure on top, sheltered-night ×0.5
  // → open-noon ×1.0), and each category multiplies it by its OWN perishability
  // (FOOD[c].spoil — grain keeps, fish rots). Times each pile, so hoarding the
  // perishables hurts most. Salt then preserves the same fraction of every
  // category's loss, bounded by the salt on hand; a hold with no salt eats it
  // all. Frozen + night + sheltered ≈ nothing; warm + noon + fish on the ground
  // turns fastest.
  stepSpoilage(dt, offline = false) {
    this.spoilLast = 0; this.spoilSaltLast = 0; this.spoilByCat = {};
    const total = this.foodTotal();
    if (total <= 0) return 0;
    const warmth = this.warmthNow(offline);          // baseline climate + the season's swing
    const sun = this.daylight(offline), ground = this.foodOnGround();
    const gate = 0.2 + 0.8 * warmth;                 // climate susceptibility (frigid → hot)
    const exposure = 0.5 + 0.3 * sun + 0.2 * ground; // sheltered-night 0.5 → open-noon 1.0
    const sev = Math.min(1, gate * exposure);        // shared across categories
    const spoilMax = CFG.foodSpoilMax * this.researchSpoilMul(); // cold-cellar discoveries slow the turn
    const gross = {}; let grossTot = 0;
    for (const c of FOOD_CATS) {
      const f = this.res[c] || 0; if (f <= 0) continue;
      const g = f * spoilMax * sev * FOOD[c].spoil * dt;
      if (g > 0) { gross[c] = g; grossTot += g; }
    }
    if (grossTot <= 0) return 0;
    // salt preserves the SAME fraction of every category's loss (cap + stock bound);
    // salt-craft discoveries lift the ceiling a little (researchPreserveAdd).
    const preserveCap = Math.min(0.98, CFG.saltPreserveMax + this.researchPreserveAdd());
    const preserveFrac = Math.min(preserveCap, ((this.res.salt || 0) / CFG.saltPerFood) / grossTot);
    const saltSpent = grossTot * preserveFrac * CFG.saltPerFood;
    if (saltSpent > 0) this.res.salt = Math.max(0, this.res.salt - saltSpent);
    let spoiledTot = 0;
    for (const c of FOOD_CATS) {
      const g = gross[c]; if (!g) { this.spoilByCat[c] = 0; continue; }
      const sp = g * (1 - preserveFrac);
      this.res[c] = Math.max(0, this.res[c] - sp);
      this.spoilByCat[c] = sp / dt; spoiledTot += sp;
    }
    this.spoilLast = spoiledTot / dt;
    this.spoilSaltLast = saltSpent / dt;
    // Chronicle a real batch turning (live only — offline is summarized by
    // catchUp). Bank small losses until they're worth a line, naming the biggest
    // factor and the food that turned most.
    if (!offline && spoiledTot > 0) {
      this._spoilAccrue = (this._spoilAccrue || 0) + spoiledTot;
      if (this._spoilAccrue >= 20) {
        const reason = warmth >= sun && warmth >= ground ? 'the heat' : sun >= ground ? 'the sun' : 'the bare ground';
        const worst = FOOD_CATS.reduce((a, c) => (this.spoilByCat[c] || 0) > (this.spoilByCat[a] || 0) ? c : a, FOOD_CATS[0]);
        this.pushLog(`${FOOD[worst].name} turned in ${reason} — ${Math.round(this._spoilAccrue)} food lost.`, 'spoil');
        this.spoilTally += 1; this._spoilAccrue = 0;
      }
    }
    return spoiledTot;
  }

  // ---- trade ---------------------------------------------------------
  // A Market turns the hold's surplus into coin and coin into the goods
  // its land can't yield — the loop that keeps a stone-poor forest hall
  // or an ore-rich frontier alive.
  tradeUnlocked() { return this.level('market') > 0; }
  localRich(res) { return res === 'coin' ? 0 : (FOOD[res] ? (this.h.rich.food || 0) : (this.h.rich[res] || 0)); }
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
    const rate = this.rates(offline);
    const caps = this.caps();
    for (const k of Object.keys(rate)) {
      this.res[k] = Math.min(caps[k], (this.res[k] || 0) + rate[k] * dt);
    }
    // Stored food turns (temp/sun/ground, salt preserves) before the folk eat.
    const spoiled = this.stepSpoilage(dt, offline);
    // The folk eat PERISHABLE-FIRST (burn fish/greens before they rot; grain is
    // the reserve). Hunger left after the whole larder is drained = starvation.
    const eatNeed = this.foodEatPerS() * dt;
    let hunger = eatNeed;
    this.eatByCat = {};
    for (const c of EAT_ORDER) {
      if (hunger <= 0) break;
      const take = Math.min(this.res[c] || 0, hunger);
      if (take > 0) { this.res[c] -= take; hunger -= take; this.eatByCat[c] = take / dt; }
    }
    // Growth needs a real food surplus: total production this tick, less what
    // was actually eaten and what spoiled (no free floor; capped so a food-rich
    // hold can't breed explosively; housing/popCap is the ceiling).
    const netFood = this.foodRateTotal(rate) * dt - (eatNeed - hunger) - spoiled;
    if (hunger > 1e-9) {
      this.pop = Math.max(3, this.pop - 0.05 * this.pop * dt); // the larder ran dry
      this.starving = true;
      this.moraleShock = Math.min(0.5, (this.moraleShock || 0) + 0.08 * dt);
      this._starveAccrue = (this._starveAccrue || 0) + dt;
      if (!offline && this._starveAccrue > 8) { this.pushLog('The larder runs empty — the folk go hungry.', 'plague'); this._starveAccrue = 0; this.starveTally = (this.starveTally || 0) + 1; }
    } else {
      this.starving = false;
      if (this.pop < this.popCap()) {
        const surplus = Math.min(3, Math.max(0, netFood));
        // Content folk multiply; the miserable don't — growth scales with morale.
        this.pop = Math.min(this.popCap(), this.pop + CFG.popGrowth * surplus * dt * this.happiness);
      }
      // Real misery drives folk away — they leave for kinder holds.
      if (this.happiness < 0.25 && this.pop > 4) this.pop = Math.max(3, this.pop - 0.02 * this.pop * ((0.25 - this.happiness) / 0.25) * dt);
    }
    this.stepRaids(dt, offline);
    this.stepDisease(dt, offline);
    this.stepMorale(dt);
    this.stepFaith(dt);
    this.stepResearch(dt);
  }

  // stepFaith accumulates faith from the hold's speakers; crossing the
  // threshold marks faithReady so town.js can invoke the Will, carrying any
  // overflow into the next cycle rather than losing it.
  stepFaith(dt) {
    this.faith = (this.faith || 0) + this.speakers() * CFG.faithPerSpeaker * dt;
    const thresh = this.faithThreshold();
    while (this.faith >= thresh) {
      this.faith -= thresh;
      this.faithReady = true;
    }
  }

  // ---- morale + health -----------------------------------------------
  // happinessTarget — the morale the hold trends toward: a full, varied larder
  // and a safe, faithful, well-kept hold raise it; hunger, plague, raids, and
  // crowding (via moraleShock + the danger/crowd terms) pull it down.
  happinessTarget() {
    let t = 0.45;
    const need = this.foodEatPerS();
    t += 0.2 * (need > 0 ? Math.min(1, this.foodTotal() / (need * 240)) : 1);   // ~a day's larder = full marks
    t += 0.03 * FOOD_CATS.filter((c) => (this.res[c] || 0) > 1).length;         // a varied board, up to +0.15
    t += 0.08 * Math.min(1, this.defense() / 6) - 0.15 * (this.h.danger || 0);  // safe vs. beset
    t += 0.02 * this.speakers() + 0.03 * Math.max(0, this.level('keep') - 1);   // faith + a proud keep
    t -= 0.25 * Math.max(0, this.pop / this.popCap() - 0.85) / 0.15;            // cramped near the cap
    t -= (this.moraleShock || 0);                                              // recent hunger/plague/raid
    return Math.max(0, Math.min(1, t));
  }
  stepMorale(dt) {
    this.moraleShock = Math.max(0, (this.moraleShock || 0) - 0.05 * dt);        // shocks fade
    const h = this.happiness ?? 0.6;
    this.happiness = Math.max(0, Math.min(1, h + (this.happinessTarget() - h) * Math.min(1, CFG.happyEase * dt)));
  }

  // stepDisease — sickness strikes on a clock (like raids). Risk climbs with
  // crowding, heat, recent spoilage (rot breeds sickness), and low morale; an
  // outbreak takes some of the folk and dents morale. Salt on hand (keeping/
  // sanitation) lowers the odds. Offline it's rarer, folded into catch-up.
  stepDisease(dt, offline = false) {
    this.diseaseClock = (this.diseaseClock ?? CFG.diseaseIntervalS) - dt;
    if (this.diseaseClock > 0) return;
    this.diseaseClock += CFG.diseaseIntervalS * (offline ? 3 : 1) * (0.6 + Math.random() * 0.8);
    const crowd = Math.max(0, this.pop / this.popCap() - 0.6);
    const heat = this.warmthNow(offline);
    const rot = Math.min(1, (this.spoilLast || 0) * 1.5);
    const salted = Math.min(0.2, (this.res.salt || 0) / 400);
    const risk = 0.1 + 0.35 * crowd + 0.22 * heat + 0.2 * rot + 0.15 * (1 - (this.happiness ?? 0.6)) - salted;
    if (Math.random() > Math.max(0.03, risk)) return;                          // a healthy season
    const deaths = Math.min(Math.max(0, Math.floor(this.pop - 3)), Math.ceil(this.pop * (0.03 + Math.random() * 0.06 * (0.6 + heat))));
    if (deaths > 0) this.pop -= deaths;
    this.moraleShock = Math.min(0.6, (this.moraleShock || 0) + 0.15);
    this.plagueTally = (this.plagueTally || 0) + 1;
    if (!offline) this.pushLog(deaths > 0 ? `A sickness passed through the hold — ${deaths} of the folk were lost.` : 'A sickness passed through the hold, but the folk pulled through.', 'plague');
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
    this.raidTally = (this.raidTally || 0) + 1;
    this.moraleShock = Math.min(0.6, (this.moraleShock || 0) + (bite > 0.55 ? 0.15 : 0.06)); // a raid shakes the folk
    if (offline) { this.applyRaidLoss(bite); return; } // no town to storm offline — one abstract loss (catchUp collates)
    // Live: send a WAVE at the town (raids.js). What they carry off depends on
    // how many the muster cuts down before they reach the stores — so walls,
    // soldiers, and pathing decide the damage, not a die roll here.
    this.raidWave = { n: Math.max(1, Math.round(this.h.danger * 6)), bite, mit };
  }

  // applyRaidLoss draws a raid's bite from the stores (one or two kinds) and, on
  // a hard bite, some of the folk — returning what was carried off. Used at full
  // strength offline, and by the live wave per reaching-raider (raids.js).
  applyRaidLoss(bite) {
    const taken = {};
    const foodTarget = FOOD_CATS.reduce((a, c) => (this.res[c] || 0) > (this.res[a] || 0) ? c : a, FOOD_CATS[0]);
    for (const k of [foodTarget, 'salt', 'ore', 'coin']) {
      if (Math.random() > 0.5) continue;
      const loss = Math.floor((this.res[k] || 0) * bite * (0.1 + Math.random() * 0.14));
      if (loss > 0) { this.res[k] -= loss; taken[k] = loss; }
    }
    let deaths = 0;
    if (bite > 0.55 && this.pop > 5 && Math.random() < 0.5) { deaths = Math.ceil(this.pop * bite * 0.06); this.pop -= deaths; }
    return { taken, deaths };
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
    return { res: this.res, pop: this.pop, instances: this.instances, farmPlots: this.farmPlots, faith: this.faith, research: this.research, happiness: this.happiness, moraleShock: this.moraleShock, diseaseClock: this.diseaseClock, founded: this.founded, log: this.log, raidClock: this.raidClock, lastTick: this.lastTick };
  }
  save() { STORE.set('xanhold:' + this.h.id, JSON.stringify(this.serialize())); }
  static load(hold) {
    const raw = STORE.get('xanhold:' + hold.id);
    return new Game(hold, raw ? JSON.parse(raw) : null);
  }
  static hasSave(id) { return STORE.get('xanhold:' + id) != null; }
  static abandon(id) { STORE.del('xanhold:' + id); }
}

window.XANGAME = { Game, BUILDINGS, BY_ID, CFG, FOOD, FOOD_CATS, CROPS, CROP_BY_ID, cropSuit, RESEARCH, RESEARCH_BY_ID };
})();
