// orders.js — the works queue + the local steward. Orders are pushed (by the
// steward or the Will's speakers) and advanced a few in parallel until their
// effect lands (a site raised, a wall laid, a trade made, a focus set).
import { S, isRaided } from './state.js';
import { ORDER, WORK_S, MAX_ACTIVE, MAX_PER_TYPE, FOCUS, TRADE_ACT, CENTER_TX, CENTER_TY, PLOT, TOWN_W, TOWN_H } from './constants.js';
import { startSite, startFarmSite, nextFarmPlot, wantsNewFarmField, farmFieldAvailable, mineNodeAvailable, coreRadius } from './buildings.js';
import { wharfSiteAvailable } from './terrain.js';
import { layWallSegment, layGate, placeTower } from './walls.js';

const { BUILDINGS, BY_ID } = window.XANGAME;

// pushOrder appends a decree to the log as pending work.
export function pushOrder(o) {
  S.orderLog.push({
    type: o.type, target: o.target, action: o.action, resource: o.resource,
    value: o.value, qty: o.qty || 1, reason: o.reason,
    from: o.from, to: o.to, gate: o.gate,     // 'wall' orders: a segment (from/to) and/or a gate point
    qtyLeft: o.qty || 1, status: 'pending', progress: 0, waited: 0,
  });
}

// The town has several work crews, so up to MAX_ACTIVE orders advance in
// PARALLEL — one order stuck waiting on materials no longer freezes the
// whole town. A unit's effect lands only when its work bar fills, so orders
// are visibly carried out over time; finished orders stay in the log. (MAX_ACTIVE → constants.js)
export function executeOrders(dt) {
  let active = S.orderLog.filter((o) => o.status === 'active').length;
  for (const o of S.orderLog) {                 // staff idle crews from the pending queue
    if (active >= MAX_ACTIVE) break;
    if (o.status === 'pending') { o.status = 'active'; o.progress = 0; active++; }
  }
  for (const a of S.orderLog) if (a.status === 'active') advanceOrder(a, dt);
  trimOrderLog();
}

// advanceBuildOrder drives a real (non-farm) `build` order through the
// construction-site pipeline: mine/wharf's placement gate is checked once,
// outright (a vein/shoreline that's genuinely exhausted never resolves, so
// this fails the order rather than idling forever, same as before sites
// existed); otherwise it waits on affordability (autoFund, the same 16s
// grace every other order type gets) before calling startSite, which pays
// and sites it (or reports a plain level-deepen, or that there's nowhere to
// put a NEW instance yet — that last case just waits, no timeout, since a
// full core/outer district resolves on its own as the town grows). Once
// sited, the order's progress bar mirrors the site's real construction
// (a.progress = a.site.progress) until the site finishes.
export function advanceBuildOrder(a, dt) {
  if (a.site) {
    a.progress = a.site.progress;
    if (a.site.done) {
      a.site = null; a.qtyLeft -= 1; a.waited = 0;
      if (a.qtyLeft <= 0) { a.status = 'done'; a.doneAt = Date.now(); a.progress = 1; }
      else a.progress = 0; // more of this type ordered (qty>1) — the next tick breaks ground on another
    }
    return;
  }
  if (a.target === 'mine' && !mineNodeAvailable()) { a.status = 'skipped'; a.doneAt = Date.now(); return; }
  if (a.target === 'wharf' && !wharfSiteAvailable()) { a.status = 'skipped'; a.doneAt = Date.now(); return; }
  if (a.target === 'farm' && !farmFieldAvailable()) { a.status = 'skipped'; a.doneAt = Date.now(); return; }
  if (!S.game.canAfford(a.target)) {
    autoFund(a.target); a.waited += dt;
    if (a.waited > 16) { a.status = 'skipped'; a.doneAt = Date.now(); }
    return;
  }
  a.waited = 0; // affordable — any further wait from here is about siting, not money
  const result = startSite(a.target);
  if (!result) {
    // Nowhere to place a NEW instance right now — the core/outer district is
    // full. Give room a chance to open (a finishing site frees a plot), but
    // NEVER wait forever: after a grace, deepen the building's LEVEL instead so
    // the order completes and the queue moves on (a longhouse still lifts the
    // pop cap this way — the very thing an over-the-visible-cap build already
    // does at MAX_PER_TYPE). Without this, a saturated core froze the whole
    // town, since localSteward won't act while any order is still pending.
    a.siteWait = (a.siteWait || 0) + dt;
    if (a.siteWait >= 18) {
      a.siteWait = 0;
      if (S.game.upgradeAny(a.target)) {   // no room for a new sprite — deepen an existing one so the order lands
        a.qtyLeft -= 1;
        if (a.qtyLeft <= 0) { a.status = 'done'; a.doneAt = Date.now(); a.progress = 1; }
        else a.progress = 0;
      } else { a.status = 'skipped'; a.doneAt = Date.now(); } // nowhere to build and nothing to deepen — drop it
    }
    return;
  }
  a.siteWait = 0;
  if (result === 'instant') {          // a deeper level of a building already standing — nothing to construct
    a.qtyLeft -= 1;
    if (a.qtyLeft <= 0) { a.status = 'done'; a.doneAt = Date.now(); a.progress = 1; }
    else a.progress = 0;
    return;
  }
  a.site = result; a.progress = 0;     // a real new instance — track its construction from here
}

export function advanceOrder(a, dt) {
  // A real building's `build` order runs through the construction-site
  // pipeline instead of the fixed work-bar timer below — its progress IS a
  // site's real progress (see advanceBuildOrder), which is why it's split
  // out before the generic `a.progress += dt/WORK_S` gate even runs. A new
  // FARM now breaks ground as a construction site too (startSite → startFarmSite):
  // builders must reach and till it before the field appears. Only `expand`
  // stays instant for now.
  if (a.type === ORDER.BUILD) { advanceBuildOrder(a, dt); return; }
  a.progress += dt / (WORK_S[a.type] || 3);
  if (a.progress < 1) return;
  if (a.type === ORDER.FOCUS) { S.focus = a.value || a.target || null; a.qtyLeft = 0; }
  else if (a.type === ORDER.TRADE) {
    const q = a.qty || 20;
    if (a.action === TRADE_ACT.SELL) S.game.sell(a.resource, q); else S.game.buy(a.resource, q);
    a.qtyLeft = 0;
  } else if (a.type === ORDER.BUILD) {
    // Only 'farm' reaches here now (see the dispatch above) — its own field,
    // built instantly as before; a real building goes through advanceBuildOrder.
    const ok = S.game.newFarm(a.crop);
    if (ok) { a.qtyLeft -= 1; a.waited = 0; }
    else {                       // can't afford — try to fund it; give up after a while
      autoFund('farm'); a.progress = 1; a.waited += dt;
      if (a.waited > 16) { a.status = 'skipped'; a.doneAt = Date.now(); }
      return;                    // (other crews keep working in parallel)
    }
  } else if (a.type === ORDER.EXPAND) {
    // Deepen a building's level: a field grows by SIZE (expandFarm), any other
    // building by a per-instance upgrade (upgradeAny).
    const tgt = a.target || 'farm';
    const ok = tgt === 'farm' ? (S.game.expandFarm() >= 0) : S.game.upgradeAny(tgt);
    if (ok) { a.qtyLeft -= 1; a.waited = 0; }
    else {
      autoFund(tgt); a.progress = 1; a.waited += dt;
      if (a.waited > 16) { a.status = 'skipped'; a.doneAt = Date.now(); }
      return;
    }
  } else if (a.type === ORDER.WALL) {
    // Walls cost the same materials + raise defense the old palisade LEVEL
    // did (S.game.build/canAfford still gate it — game.js is unchanged) —
    // only the RESULT differs: real tiles (a segment and/or a gate) land on
    // the grid instead of an auto-ring being redrawn.
    if (!((a.from && a.to) || a.gate)) {  // no geometry (e.g. the Will's `build palisade`) — plan the next segment ourselves
      const seg = planDefensiveSegment();
      if (seg) { a.from = seg.from; a.to = seg.to; a.gate = seg.gate; }
    }
    if (!((a.from && a.to) || a.gate)) {  // the core is fully walled already — just deepen the level and finish
      S.game.build('palisade'); a.qtyLeft = 0;
    } else if (S.game.build('palisade')) {
      if (a.from && a.to) layWallSegment(a.from, a.to, a.gate);
      else if (a.gate) layGate(a.gate);
      a.qtyLeft -= 1; a.waited = 0;
    } else {
      autoFund('palisade'); a.progress = 1; a.waited += dt;
      if (a.waited > 16) { a.status = 'skipped'; a.doneAt = Date.now(); }
      return;
    }
  }
  if (a.qtyLeft <= 0) { a.status = 'done'; a.doneAt = Date.now(); }
  else a.progress = 0;           // begin the next unit
}

// trimOrderLog keeps finished entries around to read, but not forever.
export function trimOrderLog() {
  const finished = S.orderLog.filter((o) => o.status === 'done' || o.status === 'skipped');
  while (finished.length > 6) {
    const rm = finished.shift();
    S.orderLog.splice(S.orderLog.indexOf(rm), 1);
  }
}

// autoFund tries to make an order affordable via the market: sell a surplus
// for coin, and BUY the material the land can't make (e.g. stone for a
// forest hold's longhouse) — the reason orders used to get stuck.
export function autoFund(id) {
  if (!S.game.tradeUnlocked()) return;
  const sellSurplus = () => {
    for (const k of ['grain', 'timber', 'salt', 'ore', 'stone']) {
      if (S.game.res[k] > 60) { S.game.sell(k, 20); return; }
    }
  };
  for (const [res, need] of Object.entries(S.game.costOf(id))) {
    if (S.game.res[res] >= need) continue;
    if (res === 'coin') { sellSurplus(); continue; }
    const short = Math.ceil(need - S.game.res[res]);
    if (S.game.res.coin >= S.game.buyPrice(res) * short) S.game.buy(res, short);
    else sellSurplus();
  }
}

// planDefensiveSegment — the local heuristic's autonomous wall planner: picks
// the next un-walled side of the CORE zone (a straight north/south/east/west
// run just outside coreRadius, see insideCore) and a gate at its middle so
// the folk can still reach the farmland/mines/wharfs beyond it. This wraps
// the protected core — dwellings/stores/faith — NOT the town's whole built
// footprint (which would swallow the outer resource works too). Cycles
// through all four sides once each (S.wallEdgesBuilt); once all four are
// planned locally, further walls are the Will's speakers to extend/gate.
export function planDefensiveSegment() {
  if (!S.usedPlots.size) return null; // nothing built yet — nowhere to wall
  const ccx = CENTER_TX, ccy = CENTER_TY;
  const rad = coreRadius() * PLOT + 2; // the core zone, +2 tiles clearance past its buildings
  const x0 = Math.max(0, Math.round(ccx - rad)), y0 = Math.max(0, Math.round(ccy - rad));
  const x1 = Math.min(TOWN_W - 1, Math.round(ccx + rad)), y1 = Math.min(TOWN_H - 1, Math.round(ccy + rad));
  const midX = Math.round((x0 + x1) / 2), midY = Math.round((y0 + y1) / 2);
  const sides = {
    north: { from: { x: x0, y: y0 }, to: { x: x1, y: y0 }, gate: { x: midX, y: y0 } },
    south: { from: { x: x0, y: y1 }, to: { x: x1, y: y1 }, gate: { x: midX, y: y1 } },
    west: { from: { x: x0, y: y0 }, to: { x: x0, y: y1 }, gate: { x: x0, y: midY } },
    east: { from: { x: x1, y: y0 }, to: { x: x1, y: y1 }, gate: { x: x1, y: midY } },
  };
  for (const [name, seg] of Object.entries(sides)) {
    if (S.wallEdgesBuilt.has(name)) continue;
    S.wallEdgesBuilt.add(name);
    return seg;
  }
  return null;                    // all four sides already planned locally
}

// planFortSpan upgrades one un-fortified core side to a real fort span: a tower
// at each corner + a wood/stone wall between (keeping the side's gate), worth +2
// troop capacity. Prefers stone when the hold holds more of it than timber.
export function planFortSpan() {
  if (!S.usedPlots.size) return false;
  const rad = coreRadius() * PLOT + 2;
  const x0 = Math.max(0, Math.round(CENTER_TX - rad)), y0 = Math.max(0, Math.round(CENTER_TY - rad));
  const x1 = Math.min(TOWN_W - 1, Math.round(CENTER_TX + rad)), y1 = Math.min(TOWN_H - 1, Math.round(CENTER_TY + rad));
  const midX = Math.round((x0 + x1) / 2), midY = Math.round((y0 + y1) / 2);
  const sides = {
    north: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: midX, y: y0 }],
    south: [{ x: x0, y: y1 }, { x: x1, y: y1 }, { x: midX, y: y1 }],
    west: [{ x: x0, y: y0 }, { x: x0, y: y1 }, { x: x0, y: midY }],
    east: [{ x: x1, y: y0 }, { x: x1, y: y1 }, { x: x1, y: midY }],
  };
  S.fortEdges = S.fortEdges || new Set(); // not persisted — re-laying a wood side is idempotent
  const kind = (S.game.res.stone || 0) > (S.game.res.timber || 0) ? 'stone' : 'wood';
  for (const [name, [a, b, gate]] of Object.entries(sides)) {
    if (S.fortEdges.has(name)) continue;
    S.fortEdges.add(name);
    placeTower(a.x, a.y); placeTower(b.x, b.y);
    layWallSegment(a, b, gate, kind);
    return true;
  }
  return false;
}

// localSteward: the town's own hands. When no orders are queued it picks a
// sensible next build so the hold keeps growing even with no Claude.
export function localSteward() {
  if (S.orderLog.some((o) => o.status === 'pending' || o.status === 'active')) return;
  const g = S.game, h = S.hold;
  // The hold spawns with no farm — break ground on the first food source at
  // once (unless a wharf already feeds the folk), wherever the farmland district
  // anchors THIS run, so the folk have food and a reason to grow.
  if (!g.level('farm') && !g.level('wharf') && g.canAfford('farm')) {
    pushOrder({ type: ORDER.BUILD, target: 'farm' }); return;
  }
  // Farmland is a DISTRICT that fills before it sprawls: while any existing
  // field still has room to grow, expand it rather than breaking ground on a
  // new one (see wantsNewFarmField/nextFarmPlot) — replaces the old
  // scarce-food coin-flip that scattered size-1 fields across the map.
  const wantFood = S.focus === FOCUS.FOOD || g.foodTotal() < g.foodCapTotal() * 0.35;
  if ((wantFood || (h.rich.food || 0) >= 0.12) && !wantsNewFarmField()) {
    pushOrder({ type: ORDER.EXPAND, target: 'farm', qty: 1 }); return;
  }
  // Walls: the same trigger the old auto-ring had (raided + under-defended,
  // or an explicit defense focus), but now it PLANS geometry — a straight
  // segment with a gate — instead of magically redrawing a ring. Segments
  // accumulate (see wallEdgesBuilt in planDefensiveSegment), so the town's
  // wall visibly grows piecemeal even with no Will involved.
  // Wall the core proactively as the hold grows (not only under raid): once
  // there are folk to protect, ring the core one side at a time until all four
  // are up — so a wall actually appears even when the Will is quiet.
  const wantWall = (isRaided() && g.defense() < 3) || S.focus === FOCUS.DEFENSE
    || (g.pop > 6 && S.wallEdgesBuilt.size < 4 && Math.random() < 0.2);
  if (wantWall && g.canAfford('palisade')) {
    const seg = planDefensiveSegment();
    if (seg) { pushOrder({ type: ORDER.WALL, target: 'palisade', from: seg.from, to: seg.to, gate: seg.gate, qty: 1 }); return; }
  }
  // Fortify: once the fence ring is mostly up and the folk are many, upgrade a
  // core side to a tower-linked wood/stone wall — real defense + troop capacity.
  if (g.pop > 10 && S.wallEdgesBuilt.size >= 2 && (S.fortEdges ? S.fortEdges.size : 0) < 4
      && (g.res.stone > 24 || g.res.timber > 34) && Math.random() < 0.15) {
    if (planFortSpan()) return;
  }
  // Deepen before sprawl: sometimes raise a standing building's level (the
  // per-building upgrade) instead of adding another sprite — richer output from
  // the same footprint. Farms deepen via the EXPAND path above.
  if (g.pop > 8 && Math.random() < 0.22) {
    const byRes = { timber: ['sawmill'], stone: ['quarry'], ore: ['mine'], salt: ['saltern'], coin: ['market'] };
    const order = [];
    for (const [res] of Object.entries(h.rich).sort((a, b) => b[1] - a[1])) for (const id of (byRes[res] || [])) order.push(id);
    order.push('wharf', 'longhouse', 'granary');
    for (const id of order) if (g.count(id) > 0 && g.canUpgradeAny(id)) { pushOrder({ type: ORDER.EXPAND, target: id, qty: 1 }); return; }
  }
  // Expand the keep as the hold prospers — a grander stronghold quarters more
  // folk and stiffens its defense + muster (a per-instance upgrade of the keep).
  if (g.pop > 12 && g.canUpgradeAny('keep') && Math.random() < 0.12) {
    pushOrder({ type: ORDER.EXPAND, target: 'keep', qty: 1 }); return;
  }
  const want = [];
  // A speaker's focus can bid a specific building outright — the placement
  // layer (nextCorePlot/nextOuterPlot/nextFarmPlot) still decides WHICH
  // district it lands in by type, so this only biases priority, not routing.
  if (S.focus && S.focus !== FOCUS.FOOD && S.focus !== FOCUS.DEFENSE && BUILDINGS.some((b) => b.id === S.focus)) want.push(S.focus);
  if (g.pop >= g.popCap() - 0.5) want.push('longhouse');
  if (!g.tradeUnlocked()) want.push('market');
  if (g.foodTotal() >= g.foodCapTotal() * 0.92) want.push('granary');
  if (S.focus === FOCUS.FOOD) want.push('farm');
  // Raise the faith now and then — reliquaries widen the Will's voice.
  if (g.level('reliquary') < 4 && g.pop > 12 && Math.random() < 0.12) want.push('reliquary');
  // Found a Scholars' Hall once the hold is established — it quickens research.
  if (g.count('scholarshall') < 1 && g.pop > 10 && Math.random() < 0.1) want.push('scholarshall');
  // then the hold's richest producers — richness sets the lean, but a random
  // jitter keeps the build ORDER from being identical every run (the town
  // shouldn't develop the exact same way every playthrough).
  const prodByRes = { food: ['farm', 'wharf'], timber: ['sawmill'], stone: ['quarry'], ore: ['mine'], salt: ['saltern'], coin: ['market'] };
  const leaning = Object.entries(h.rich).map(([res, v]) => [res, v + Math.random() * 0.18]).sort((a, b) => b[1] - a[1]);
  for (const [res] of leaning)
    for (const id of (prodByRes[res] || [])) want.push(id);
  want.push('longhouse');
  for (const id of want) {
    const b = S.game && BUILDINGS.find((x) => x.id === id);
    if (!b) continue;
    if (b.kind === 'prod' && S.game.richOf(b) < b.gate && !S.game.level(id)) continue;
    if (S.game.canAfford(id)) { pushOrder({ type: ORDER.BUILD, target: id, qty: 1 }); return; }
  }
}
