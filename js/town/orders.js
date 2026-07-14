// orders.js — the works queue + the local steward. Orders are pushed (by the
// steward or the Will's speakers) and advanced a few in parallel until their
// effect lands (a site raised, a wall laid, a trade made, a focus set).
import { S, isRaided } from './state.js';
import { ORDER, WORK_S, MAX_ACTIVE, MAX_PER_TYPE, FOCUS, TRADE_ACT, CENTER_TX, CENTER_TY, PLOT, TOWN_W, TOWN_H } from './constants.js';
import { startSite, startFarmSite, nextFarmPlot, wantsNewFarmField, farmFieldAvailable, mineNodeAvailable, coreRadius, plotInCore, CORE_TYPES, recipeFor, pickRelocateDest, relocateBuilding } from './buildings.js';
import { wharfSiteAvailable } from './terrain.js';
import { layWallSegment, layGate, placeTower, TIER_KIND } from './walls.js';

const { BUILDINGS, BY_ID } = window.XANGAME;

// pushOrder appends a decree to the log as pending work.
export function pushOrder(o) {
  S.orderLog.push({
    type: o.type, target: o.target, action: o.action, resource: o.resource,
    value: o.value, qty: o.qty || 1, reason: o.reason,
    from: o.from, to: o.to, gate: o.gate,     // 'wall' orders: a segment (from/to) and/or a gate point
    section: o.section, upgrade: o.upgrade,   // 'wall' orders: which section, and whether it's a tier upgrade
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
  // One bad order (an LLM-authored target, a future bug) must never freeze the
  // whole pipeline — it gets skipped, everything else keeps advancing.
  for (const a of S.orderLog) {
    if (a.status !== 'active') continue;
    try { advanceOrder(a, dt); }
    catch (e) { a.status = 'skipped'; a.doneAt = Date.now(); console.error('[orders] order failed, skipped:', a.type, a.target, e); }
  }
  // A target whose order just FAILED goes on cooldown, so localSteward doesn't
  // re-queue the same unsatisfiable work forever (the market skip-loop: core
  // full + existing instances maxed → skipped → re-wanted → skipped …).
  for (const a of S.orderLog) {
    if (a.status === 'skipped' && !a.cooled) { a.cooled = true; (S.skipCool || (S.skipCool = {}))[a.target || a.type] = Date.now() + 60000; }
  }
  trimOrderLog();
}

// onSkipCooldown — was this target's last order recently skipped? (see above)
export function onSkipCooldown(id) { return !!(S.skipCool && S.skipCool[id] > Date.now()); }

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
  if (!BY_ID[a.target]) { a.status = 'skipped'; a.doneAt = Date.now(); return; } // unknown target (LLM-authored) — never let it jam the queue
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
    // Walls cost + raise defense via the palisade level (game.js unchanged); the
    // RESULT is real tiles. A wall order either UPGRADES a section's ring a tier,
    // or lays the next planned segment/gate at the section's current tier kind.
    if (a.upgrade) {
      if (S.game.build('palisade')) { upgradeSectionWall(a.section || 'core'); a.qtyLeft = 0; }
      else { autoFund('palisade'); a.progress = 1; a.waited += dt; if (a.waited > 16) { a.status = 'skipped'; a.doneAt = Date.now(); } return; }
    } else {
      if (!((a.from && a.to) || a.gate)) {  // no geometry (e.g. the Will's `build palisade`) — plan the core's next side
        const seg = planDefensiveSegment();
        if (seg) { a.from = seg.from; a.to = seg.to; a.gate = seg.gate; a.section = 'core'; }
      }
      if (!((a.from && a.to) || a.gate)) {  // fully walled already — just deepen the level and finish
        S.game.build('palisade'); a.qtyLeft = 0;
      } else if (S.game.build('palisade')) {
        const kind = TIER_KIND[S.sectionTier[a.section || 'core'] || 1];
        if (a.from && a.to) layWallSegment(a.from, a.to, a.gate, kind);
        else if (a.gate) layGate(a.gate);
        a.qtyLeft -= 1; a.waited = 0;
      } else {
        autoFund('palisade'); a.progress = 1; a.waited += dt;
        if (a.waited > 16) { a.status = 'skipped'; a.doneAt = Date.now(); }
        return;
      }
    }
  } else if (a.type === ORDER.MOVE) {
    // Redistricting: relocate an already-placed building onto a wall-clear
    // dest from the same allocator the build path uses (see
    // pickRelocateDest/relocateBuilding). No cost — just labor.
    const type = a.target.slice(0, a.target.indexOf('#'));
    const { recipe } = recipeFor(type);
    const dest = pickRelocateDest(type, recipe);
    if (dest && relocateBuilding(a.target, dest)) { a.qtyLeft = 0; }
    else {
      if (dest) S.usedPlots.delete(`${dest.px},${dest.py}`); // picked but unused — release the claim
      a.status = 'skipped'; a.doneAt = Date.now(); return;
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

// autoFund tries to make an order affordable: sell a surplus for coin (via the
// market, or peddlers at poor rates without one), and BUY the material the land
// can't make (e.g. timber for a bare-plateau march) — the anti-deadlock seam.
export function autoFund(id) {
  const g = S.game, need = g.costOf(id);
  // Sell the most SPARABLE pile: skip coin + this order's own materials; food
  // only ever down to a living reserve (~5 min of eating); materials only from
  // a real pile. Fullest-against-cap wins ties (spoiling stores go first).
  const sellSurplus = () => {
    const caps = g.caps(), FOODK = window.XANGAME.FOOD_CATS;
    const foodSpare = g.foodTotal() - Math.max(30, g.foodEatPerS() * 300);
    let best = null, bs = 0;
    for (const k of Object.keys(caps)) {
      if (k === 'coin' || need[k]) continue;
      let avail = g.res[k] || 0;
      if (FOODK.includes(k)) avail = Math.max(0, Math.min(avail, foodSpare));
      else if (avail < 20) avail = 0;                    // don't strip a lean material stock
      if (avail <= 0) continue;
      const score = avail / (caps[k] || 1) + avail / 200; // ratio first, big piles break ties
      if (score > bs) { bs = score; best = k; }
    }
    if (best) g.sell(best, Math.max(1, Math.min(20, Math.floor((g.res[best] || 0) / 2))));
  };
  for (const [res, n] of Object.entries(need)) {
    if (g.res[res] >= n) continue;
    if (res === 'coin') { sellSurplus(); continue; }
    const short = Math.ceil(n - g.res[res]);
    if (g.res.coin >= g.buyPrice(res) * short) g.buy(res, short);
    else sellSurplus();
  }
}

// ---- walls by section + tier ------------------------------------------
// Walls now ring named SECTIONS, not just the core, and each walled section
// carries a TIER — fence(1) → wood(2) → stone(3), its "level". planSectionWall
// lays the next un-walled side of a section; upgradeSectionWall raises the whole
// ring a tier (with corner towers, so its sides become fort spans → troop cap).
// Section edges are tracked as `${section}:${side}` in S.wallEdgesBuilt, and a
// section's box is locked on first plan (S.sectionBox) so an upgrade re-lays it
// exactly in place even if coreRadius has since grown.

// sectionBounds — the tile box a section's wall would enclose (fresh geometry;
// planSectionWall locks it into S.sectionBox). null if nothing to ring yet.
export function sectionBounds(section) {
  const box = (x0, y0, x1, y1) => ({
    x0: Math.max(0, Math.round(x0)), y0: Math.max(0, Math.round(y0)),
    x1: Math.min(TOWN_W - 1, Math.round(x1)), y1: Math.min(TOWN_H - 1, Math.round(y1)),
  });
  if (section === 'core') {
    if (!S.usedPlots.size) return null;
    const rad = coreRadius() * PLOT + 2;               // core zone + clearance past its buildings
    return box(CENTER_TX - rad, CENTER_TY - rad, CENTER_TX + rad, CENTER_TY + rad);
  }
  if (section === 'farmland') {
    if (!S.farmTiles.size) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of S.farmTiles.keys()) { const [tx, ty] = k.split(',').map(Number); x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty); }
    return box(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
  }
  if (section === 'town') {
    if (!S.hittable.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of S.hittable) { x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
    return box(x0 - 2, y0 - 2, x1 + 2, y1 + 2);
  }
  return null;
}

// sectionSides — the four wall runs (from/to + a mid gate) around a box.
function sectionSides(b) {
  const midX = Math.round((b.x0 + b.x1) / 2), midY = Math.round((b.y0 + b.y1) / 2);
  return {
    north: { from: { x: b.x0, y: b.y0 }, to: { x: b.x1, y: b.y0 }, gate: { x: midX, y: b.y0 } },
    south: { from: { x: b.x0, y: b.y1 }, to: { x: b.x1, y: b.y1 }, gate: { x: midX, y: b.y1 } },
    west: { from: { x: b.x0, y: b.y0 }, to: { x: b.x0, y: b.y1 }, gate: { x: b.x0, y: midY } },
    east: { from: { x: b.x1, y: b.y0 }, to: { x: b.x1, y: b.y1 }, gate: { x: b.x1, y: midY } },
  };
}

// sectionEdgesBuilt — how many of a section's four sides are planned so far.
export function sectionEdgesBuilt(section) {
  let n = 0; for (const k of S.wallEdgesBuilt) if (k.startsWith(section + ':')) n++;
  return n;
}

// planSectionWall — the next un-walled side of a section as a WALL-order payload
// (from/to/gate + section), cycling the four sides; null once the ring is closed.
export function planSectionWall(section) {
  let b = S.sectionBox[section];
  if (!b) { b = sectionBounds(section); if (!b || b.x1 <= b.x0 || b.y1 <= b.y0) return null; S.sectionBox[section] = b; }
  for (const [name, seg] of Object.entries(sectionSides(b))) {
    const key = `${section}:${name}`;
    if (S.wallEdgesBuilt.has(key)) continue;
    S.wallEdgesBuilt.add(key);
    if (!S.sectionTier[section]) S.sectionTier[section] = 1; // fence
    return { ...seg, section };
  }
  return null;
}

// planDefensiveSegment — the core's next side (the WALL handler's no-geometry
// fallback). The core is simply the first section a hold rings.
export function planDefensiveSegment() {
  if (!S.usedPlots.size) return null;
  return planSectionWall('core');
}

// upgradeSectionWall raises a walled section a tier (fence→wood→stone), re-laying
// its ring at the sturdier kind with a tower at each corner (so each side becomes
// a fort span → troop capacity). False if the section is unwalled or already stone.
export function upgradeSectionWall(section) {
  const tier = S.sectionTier[section] || 0;
  if (tier < 1 || tier >= 3) return false;
  const b = S.sectionBox[section] || sectionBounds(section);
  if (!b) return false;
  const kind = TIER_KIND[tier + 1];
  placeTower(b.x0, b.y0); placeTower(b.x1, b.y0); placeTower(b.x0, b.y1); placeTower(b.x1, b.y1);
  for (const seg of Object.values(sectionSides(b))) layWallSegment(seg.from, seg.to, seg.gate, kind);
  S.sectionTier[section] = tier + 1;
  return true;
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
  // Only grow the fields when food is actually WANTED (focus, or the larder is
  // running down) — a food-rich hold with full stores shouldn't farm forever
  // and crowd out everything else (housing, defense, trade).
  const wantFood = S.focus === FOCUS.FOOD || g.foodTotal() < g.foodCapTotal() * 0.5;
  if (wantFood && !wantsNewFarmField() && !onSkipCooldown('farm')) {
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
  // Walls, by SECTION and by TIER. First ring the core; once it's closed, ring
  // the farmland; and as the hold prospers, UPGRADE a section's ring a tier
  // (fence→wood→stone + corner towers → troop capacity).
  const coreEdges = sectionEdgesBuilt('core');
  const wantWall = (isRaided() && g.defense() < 3) || S.focus === FOCUS.DEFENSE
    || (g.pop > 6 && coreEdges < 4 && Math.random() < 0.2);
  if (wantWall && g.canAfford('palisade')) {
    const seg = planSectionWall('core');
    if (seg) { pushOrder({ type: ORDER.WALL, target: 'palisade', section: 'core', from: seg.from, to: seg.to, gate: seg.gate, qty: 1 }); return; }
  }
  // Ring the farmland once the core is closed and the fields have grown.
  if (coreEdges >= 4 && S.farmTiles.size > 8 && g.pop > 9 && g.canAfford('palisade')
      && sectionEdgesBuilt('farmland') < 4 && Math.random() < 0.15) {
    const seg = planSectionWall('farmland');
    if (seg) { pushOrder({ type: ORDER.WALL, target: 'palisade', section: 'farmland', from: seg.from, to: seg.to, gate: seg.gate, qty: 1 }); return; }
  }
  // Upgrade a fully-ringed section a tier as materials allow (core before
  // farmland). Gated on a CLOSED ring (all four sides) so an upgrade re-lays a
  // complete perimeter, not a half-built one.
  if (g.pop > 10 && (g.res.stone > 30 || g.res.timber > 40) && Math.random() < 0.15) {
    for (const section of ['core', 'farmland']) {
      const tier = S.sectionTier[section] || 0;
      if (tier >= 1 && tier < 3 && sectionEdgesBuilt(section) >= 4 && g.canAfford('palisade')) { pushOrder({ type: ORDER.WALL, target: 'palisade', section, upgrade: true, qty: 1 }); return; }
    }
  }
  // Deepen before sprawl: sometimes raise a standing building's level (the
  // per-building upgrade) instead of adding another sprite — richer output from
  // the same footprint. Farms deepen via the EXPAND path above.
  if (g.pop > 8 && Math.random() < 0.22) {
    // Deepen PRODUCERS of real goods — not markets: a market's output is coin,
    // and deepening markets just balloons an already-uncapped pile (see the F2
    // sum-scaling). One or two markets is plenty; coin's job is to buy scarcity.
    const byRes = { timber: ['sawmill'], stone: ['quarry'], ore: ['mine'], salt: ['saltern'] };
    const order = [];
    for (const [res] of Object.entries(h.rich).sort((a, b) => b[1] - a[1])) for (const id of (byRes[res] || [])) order.push(id);
    order.push('wharf', 'longhouse', 'granary');
    for (const id of order) if (g.count(id) > 0 && g.canUpgradeAny(id) && !onSkipCooldown(id)) { pushOrder({ type: ORDER.EXPAND, target: id, qty: 1 }); return; }
  }
  // Expand the keep as the hold prospers — a grander stronghold quarters more
  // folk and stiffens its defense + muster (a per-instance upgrade of the keep).
  if (g.pop > 12 && g.canUpgradeAny('keep') && !onSkipCooldown('keep') && Math.random() < 0.12) {
    pushOrder({ type: ORDER.EXPAND, target: 'keep', qty: 1 }); return;
  }
  // Redistricting: a CORE building stranded outside the current core zone
  // (coreRadius can shrink as a later wharf claims water plots closer to
  // town — see maxSafeCoreRadius) — move it back onto a free core plot.
  // Only fires when a genuinely-stranded building exists, so it never thrashes.
  if (g.pop > 6 && Math.random() < 0.08) {
    for (const [key, rec] of S.placed) {
      const type = key.slice(0, key.indexOf('#'));
      if (!CORE_TYPES.has(type) || S.siteKeys.has(key)) continue;
      if (!rec.plot || rec.plot.px == null || plotInCore(rec.plot.px, rec.plot.py)) continue;
      pushOrder({ type: ORDER.MOVE, target: key }); return;
    }
  }
  // Keep scarce building materials flowing BEFORE the build list: the hold buys
  // the stone/timber it's short on — especially what it can't produce (a
  // stone-poor hold mines no stone, so every longhouse/granary/wall's stone must
  // be bought) — with surplus coin. This is what keeps a hold from stalling for
  // want of materials, and drains idle coin so it doesn't pile up uncapped.
  for (const mat of ['stone', 'timber']) {   // peddlers serve even a marketless hold (dearly)
    const makesIt = mat === 'timber' ? g.level('sawmill') : g.level('quarry');
    const floor = makesIt ? 15 : 40; // a material it produces only needs a top-up; one it can't, a real stock
    if ((g.res[mat] || 0) < floor && g.res.coin >= g.buyPrice(mat) * 10) {
      pushOrder({ type: ORDER.TRADE, action: TRADE_ACT.BUY, resource: mat, qty: 10 }); return;
    }
  }
  const want = [];
  // ESSENTIALS outrank everything — even the founding focus: a timber source,
  // a food source, a market (trade at fair prices), and housing when capped.
  // (A defense-focused march once built barracks forever while homeless.)
  const ess = [];   // essentials in a jittered order, so the opening varies run-to-run
  if (!g.level('sawmill') && (h.rich.timber || 0) >= 0.10) ess.push('sawmill');
  if (!g.level('farm') && !g.level('wharf')) ess.push('farm');
  if (Math.random() < 0.5) ess.reverse();
  for (const e of ess) want.push(e);
  if (!g.tradeUnlocked()) want.push('market');                    // one market unlocks fair prices
  if (g.pop >= g.popCap() - 1) want.push('longhouse');
  // Then the hold's FOCUS (the founding decree, or a speaker's standing focus)
  // biases what comes next; a focus that IS a building id bids it outright.
  const FOCUS_BUILDS = { growth: ['longhouse', 'granary'], trade: ['saltern', 'market'], industry: ['sawmill', 'quarry', 'mine'], food: ['farm', 'wharf'], defense: ['barracks'] };
  if (FOCUS_BUILDS[S.focus]) for (const id of FOCUS_BUILDS[S.focus]) want.push(id);
  else if (S.focus && BUILDINGS.some((b) => b.id === S.focus)) want.push(S.focus);
  if (g.foodTotal() >= g.foodCapTotal() * 0.92) want.push('granary');
  if (g.level('reliquary') < 4 && g.pop > 12 && Math.random() < 0.12) want.push('reliquary');
  if (g.count('scholarshall') < 1 && g.pop > 10 && Math.random() < 0.1) want.push('scholarshall');
  // Then the hold's richest producers — but hold MARKETS back until the basics
  // (a timber source AND a food source) stand, and cap them, so a coin-rich
  // hold doesn't sprawl markets while starving for materials. Jitter keeps runs
  // from being identical.
  const basics = g.level('sawmill') && (g.level('farm') || g.level('wharf'));
  const prodByRes = { food: ['farm', 'wharf'], timber: ['sawmill'], stone: ['quarry'], ore: ['mine'], salt: ['saltern'], coin: (basics && g.count('market') < 3) ? ['market'] : [] };
  const leaning = Object.entries(h.rich).map(([res, v]) => [res, v + Math.random() * 0.18]).sort((a, b) => b[1] - a[1]);
  for (const [res] of leaning)
    for (const id of (prodByRes[res] || [])) want.push(id);
  want.push('longhouse');
  let firstWanted = null;
  for (const id of want) {
    const b = S.game && BUILDINGS.find((x) => x.id === id);
    if (!b || onSkipCooldown(id)) continue;   // benched — its last order just failed
    if (b.kind === 'prod' && S.game.richOf(b) < b.gate && !S.game.level(id)) continue;
    firstWanted = firstWanted || id;
    if (S.game.canAfford(id)) { pushOrder({ type: ORDER.BUILD, target: id, qty: 1 }); return; }
  }
  // Nothing affordable — push the TOP want anyway and let the order pipeline
  // fund it (autoFund sells surplus / peddles), so a broke hold still grinds
  // toward its next building instead of sitting silent until rich.
  if (firstWanted) pushOrder({ type: ORDER.BUILD, target: firstWanted, qty: 1 });
}
