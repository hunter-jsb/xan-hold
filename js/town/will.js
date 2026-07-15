// will.js — the Divine Will bridge: POST /will (Opus utters as the hold's aspect,
// Haiku speakers interpret into orders), normalize those into the queue, and the
// "ask the god" input. Refreshes the panels through hud after each invocation.
import { S, isRaided } from './state.js';
import { ORDER } from './constants.js';
import { fortSpans, troopCap } from './walls.js';
import { pushOrder } from './orders.js';
import { renderOrders, renderWillPanel, renderWillDetail, setStewardLine, pushChronicle } from './hud.js';
import { researchState } from './research.js';

const { BUILDINGS } = window.XANGAME;

// callWill invokes the Divine Will: Opus utters terse directives as the hold's
// aspect (the Salt/Current/Deep…), and its speakers (Haiku) each interpret one
// into concrete orders. The utterance + each speaker's word land in the log.
export async function callWill(occasion, instruction) {
  if (S.stewardBusy) return;
  S.stewardBusy = true;
  const aspect = S.mask.aspect;
  setStewardLine(instruction ? `${aspect} weighs your word…` : `${aspect} stirs…`);
  try {
    const res = await fetch('/will', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(willState(occasion, instruction)),
    });
    const d = await res.json();
    let bidden = 0;
    const heard = [];
    for (const sp of (d.speakers || [])) {
      const orders = Array.isArray(sp.orders) ? sp.orders.map(normalizeOrder) : [];
      if (orders.length) { orders.forEach(pushOrder); bidden += orders.length; }
      heard.push({ name: sp.name, parish: sp.parish, directive: sp.directive, word: sp.word || '', orders });
    }
    // stash this invocation so the left Speakers panel can show the full
    // directive → speaker → orders distribution, persisting between calls.
    S.lastWill = { utterance: d.utterance || null, aspect: d.aspect || aspect, speakers: heard };
    S.willHistory.unshift({ ...S.lastWill, at: Date.now() });
    if (S.willHistory.length > 12) S.willHistory.length = 12;
    renderWillPanel();
    // the popout rebuilds on open, but if it's already open, don't make the
    // lord wait for a close/reopen to see the newest doings land on top.
    if (S.ui.willPopout && S.ui.willPopout.isOpen()) S.ui.willPopout.setContent(renderWillDetail());
    if (d.speakers && d.speakers.length) {
      setStewardLine(`${aspect} spoke through ${d.speakers.length} — ${bidden} work${bidden === 1 ? '' : 's'} bidden.`);
      renderOrders();
    } else setStewardLine(`${aspect} keeps its silence.`);
  } catch (e) {
    setStewardLine('(the Will is distant — the folk act alone)');
  } finally {
    setTimeout(() => S.stewardBusy = false, 500);
  }
}

// willState is the town's state plus the mask (aspect/speakers) and bandwidth
// (temples = 1 + reliquaries) the Will pipeline needs.
export function willState(occasion, instruction) {
  const s = stewardState(occasion, instruction);
  s.mask = S.mask;
  s.temples = 1 + S.game.level('reliquary');
  return s;
}

export function normalizeOrder(o) {
  // A speaker's wall-wishes all route to the WALL system, not the building-site
  // path: `build palisade`/`build wall` lay the next segment; `build tower`
  // upgrades a section's ring (which raises corner towers). 'tower'/'wall' are
  // NOT in the building catalogue — left unrouted they jammed the whole queue.
  const wallish = o.type === ORDER.BUILD && (o.target === 'palisade' || o.target === 'wall' || o.target === 'tower');
  const type = wallish ? ORDER.WALL : o.type;
  // A speaker trading 'food' means the pooled idea, not a real good — route it
  // to the hold's deepest (sell) / staple (buy) category so the trade lands.
  let resource = o.resource;
  if (resource === 'food') {
    const cats = window.XANGAME.FOOD_CATS;
    resource = o.action === 'sell' ? cats.reduce((a, c) => (S.game.res[c] || 0) > (S.game.res[a] || 0) ? c : a, cats[0]) : 'grain';
  }
  return {
    type, target: wallish ? 'palisade' : o.target, upgrade: o.target === 'tower' || undefined,
    action: o.action, resource, value: o.value || o.target, qty: o.qty || 1,
    from: o.from, to: o.to, gate: o.gate,     // a 'wall' order: segment endpoints/gate (planned on demand if absent)
  };
}

// The Steward-ask box: P opens it so you can instruct the Steward in your own
// words, or just press Enter for a free-hand (regular) decree.
export function showStewardAsk() {
  const box = document.getElementById('stewardask'), input = document.getElementById('stewardinput');
  if (!box || !input) { callWill('the Will is summoned'); return; }
  box.style.display = 'flex'; input.value = '';
  setTimeout(() => input.focus(), 0); // defer so the triggering 'p' keydown doesn't type into it
}
export function initStewardAsk() {
  const box = document.getElementById('stewardask'), input = document.getElementById('stewardinput');
  if (!input) return;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value.trim();
      box.style.display = 'none'; input.blur();
      callWill(v ? 'the lord instructs the Will' : 'the Will is summoned', v || null);
    } else if (e.key === 'Escape') {
      e.preventDefault(); box.style.display = 'none'; input.blur();
    }
  });
}

// defenseState — the fortification/pathing picture the Will's speakers see, so
// they can route troops through gates and know where walls/towers stand.
function defenseState() {
  const byKind = { fence: 0, wood: 0, stone: 0 };
  for (const k of S.walls) byKind[S.wallKind.get(k) || 'fence']++;
  const pts = (set) => [...set].map((k) => { const [x, y] = k.split(',').map(Number); return { x, y }; });
  return {
    wallTiles: S.walls.size, byKind,
    gates: pts(S.gates),   // passable openings — troops must route THROUGH these
    towers: pts(S.towers),
    fortSpans: fortSpans(), troopCap: troopCap(),
  };
}

// fealtyState — the command structure the Will audits: the folk are split into
// parishes, one per speaker, kept balanced by the head speaker. spread = the gap
// between the largest and smallest parish (0 = perfectly even; a good job).
function fealtyState() {
  const sizes = S.parishSizes || [];
  if (!sizes.length) return { speakers: 0, parishes: [], spread: 0 };
  return { speakers: sizes.length, parishes: sizes, spread: Math.max(...sizes) - Math.min(...sizes) };
}

export function stewardState(occasion, instruction) {
  const g = S.game, h = S.hold;
  const rate = g.rates();
  return {
    occasion, instruction: instruction || '',
    name: h.name, tier: h.tierName, ancestry: h.ancestry, realm: h.realm, region: h.region,
    danger: h.danger, beingRaided: isRaided(), currentFocus: S.focus,
    mood: +(g.happiness ?? 0.6).toFixed(2),   // folk morale (0..1) — hunger/plague/raids drag it down
    fealty: fealtyState(),                     // the parishes under each speaker — audit the head's split
    resources: Object.fromEntries(Object.entries(g.res).map(([k, v]) => [k, Math.round(v)])),
    caps: g.caps(), rates: Object.fromEntries(Object.entries(rate).map(([k, v]) => [k, +v.toFixed(2)])),
    pop: Math.floor(g.pop), popCap: g.popCap(), defense: g.defense(), efficiency: +g.efficiency().toFixed(2),
    buildings: Object.fromEntries(BUILDINGS.map((b) => [b.id, g.level(b.id)]).filter(([, v]) => v)),
    rich: Object.fromEntries(Object.entries(h.rich).map(([k, v]) => [k, +v.toFixed(2)])),
    climate: { band: h.tempBand, warmth: +(h.warmth || 0).toFixed(2) },
    crops: g.farmPlots.reduce((m, p) => { m[p.crop] = (m[p.crop] || 0) + 1; return m; }, {}),
    research: researchState(),  // what the hold has learned of its own land — bound the god's voice to it
    defenses: defenseState(),
    recentChronicle: S.chronicle.slice(0, 3).map((c) => c.text),
  };
}


