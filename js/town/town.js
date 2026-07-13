// town.js — the living town. PixiJS renders a ¾ top-down cozy pixel hold
// that grows from the deterministic economy (window.XANGAME) whose seed is
// one settlement from the world-sim (window.XAN). It runs itself: a local
// heuristic keeps building, and when faith crests (or on `p`) the Divine Will
// at /will returns terse directives its speakers turn into orders + an
// in-world chronicle. Nothing here writes back to the sim.
import { Application, Container, Graphics, Sprite, Texture, AnimatedSprite } from 'pixi.js';
import { loadAtlas, TILE } from './atlas.js';
import { goTo } from './pathfind.js';
import { TOWN_W, TOWN_H, CENTER_TX, CENTER_TY, DAY_MS, STEWARD_MS, LOCAL_MS, ROLE_LABEL, HIGHLIGHT_COLOR, BUILD_NAME } from './constants.js';
import { S, heldKeys } from './state.js';
import { loadWalls } from './walls.js';
import { buildPlots, paintGround, placeOreNodes, placeWater } from './terrain.js';
import { placeTownhall, reconcileBuildings, districtOf, coreBounds } from './buildings.js';
import { stepVillager, reconcileVillagers } from './villagers.js';
import { initHUD, updateHUD, renderOrders, pushChronicle, renderArchiveDetail } from './hud.js';
import { executeOrders, localSteward } from './orders.js';
import { callWill, initStewardAsk, showStewardAsk } from './will.js';
import { spawnRaidWave, stepRaid } from './raids.js';

const { allHolds } = window.XAN;
const { Game, BY_ID, CFG } = window.XANGAME;

// holdMask — the god wears the face of the land: the hold's lord-archetype
// (tier), falling back to its dominant resource, sets the aspect + speakers.
function holdMask(h) {
  const byTier = {
    saltern: { aspect: 'the Salt', speakers: 'Saltspeakers' },
    seat: { aspect: 'the Current', speakers: 'Currentspeakers' },
    headwater: { aspect: 'the Wellspring', speakers: 'Springspeakers' },
    march: { aspect: 'the Deep', speakers: 'Deepspeakers' },
  };
  if (byTier[h.tierName]) return byTier[h.tierName];
  const top = Object.entries(h.rich).sort((a, b) => b[1] - a[1])[0][0];
  const byRes = {
    timber: { aspect: 'the Green', speakers: 'Greenspeakers' },
    ore: { aspect: 'the Vein', speakers: 'Veinspeakers' },
    stone: { aspect: 'the Deep', speakers: 'Deepspeakers' },
    food: { aspect: 'the Current', speakers: 'Currentspeakers' },
    salt: { aspect: 'the Salt', speakers: 'Saltspeakers' },
    coin: { aspect: 'the Road', speakers: 'Roadspeakers' },
  };
  return byRes[top] || { aspect: 'the Will', speakers: 'Speakers' };
}

// ---- boot -----------------------------------------------------------
const mark = (m) => { console.log('boot:', m); };  // boot progress (the Will panel isn't up yet)
// resetWorld wipes every hold's saved progress (localStorage), so the
// world starts fresh. Triggered by ?reset in the URL or the R key.
function resetWorld() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('xanhold:')) localStorage.removeItem(k);
  } catch { /* private/sandboxed storage — nothing to clear */ }
}

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has('reset')) {
    resetWorld();
    params.delete('reset'); // strip it so a refresh doesn't wipe new progress
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : ''));
  }
  mark('pick hold');
  S.hold = pickHold();
  S.mask = holdMask(S.hold);                         // the god's local face
  ROLE_LABEL.speaker = S.mask.speakers.replace(/s$/, ''); // e.g. "Deepspeaker" in the Folk legend
  loadWalls();                                        // restore this hold's grown wall/gate tiles (see saveWalls)
  const founding = !Game.hasSave(S.hold.id);          // a never-played hold — its speaker will decree a calling
  S.game = Game.load(S.hold);
  const away = S.game.catchUp();
  if (founding) S.focus = pickFoundingFocus(S.hold);  // set the opening's aim BEFORE the first localSteward runs
  window.__S = S; // debug: live-state inspection while diagnosing the steward/economy (temporary)

  mark('init pixi');
  S.app = new Application();
  await S.app.init({
    resizeTo: window, antialias: false, roundPixels: true,
    preference: 'webgl', backgroundColor: bgForHold(S.hold),
  });
  document.getElementById('stage').appendChild(S.app.canvas);
  S.app.ticker.maxFPS = 30;

  mark('load atlas');
  S.atlas = await loadAtlas();
  mark('build town');

  S.world = new Container();
  S.ground = new Container();
  S.entities = new Container(); S.entities.sortableChildren = true;
  S.world.addChild(S.ground, S.entities);
  S.app.stage.addChild(S.world);

  buildPlots();
  paintGround();
  placeOreNodes();
  placeWater();
  placeTownhall();
  reconcileBuildings();  // existing buildings appear without a poof
  S.booted = true;       // from here on, finished construction gets an effect
  S.night = makeOverlay(0x0a1230);
  S.seasonFx = makeOverlay(0xffffff); S.seasonFx.alpha = 0; // recoloured per season each frame
  S.alarmFx = makeOverlay(0xff2a1a); S.alarmFx.alpha = 0;
  S.app.stage.addChild(S.seasonFx, S.night, S.alarmFx);
  initWeather();   // seasonal snow/leaves/petals over the scene

  layoutWorld();
  window.addEventListener('resize', layoutWorld);
  initHUD(away);
  if (founding && S.focus) pushChronicle(`The ${S.mask.speakers.replace(/s$/, '')} calls ${S.hold.name} to ${S.focus}.`, 'note');
  initStewardAsk(); // the god-ask input (will bridge) — wired here, not from initHUD, to keep hud.js free of will.js
  wireKeys();
  initZoom();
  initPan();

  S.app.ticker.add(onFrame);
  setInterval(townTick, 1000);
  setInterval(localSteward, LOCAL_MS);
  setInterval(() => callWill('the turning of the season'), STEWARD_MS);
  setInterval(stepMood, 3000);  // villagers voice the hold's mood/health now and then
  setInterval(dumpState, 2500); // debug: keep debug-dump.json fresh for GPU-less inspection (temporary)
  // No decree on boot — the town runs on its local heuristic and only spends
  // a Claude call every STEWARD_MS or when you press P, so reloads are free.
}

// Pick the hold: an explicit ?hold= from the map wins, else the last one
// played, else a RANDOM viable seat — so a fresh start isn't always the same
// capital. Each seat's geography drives a genuinely different economy.
function pickHold() {
  const holds = allHolds();
  const want = new URLSearchParams(location.search).get('hold');
  if (want) { const h = holds.find((x) => x.id === want); if (h) return h; }
  const saved = holds.find((h) => Game.hasSave(h.id));
  if (saved) return saved;
  // Prefer seats that can actually feed themselves (good ground or water), so a
  // random found isn't a barren rock; fall back to any seat.
  const viable = holds.filter((h) => (h.rich.food || 0) >= 0.08 || (h.n && ((h.n.riverMax || 0) > 0.08 || (h.n.lake || 0) > 0.08 || (h.n.sea || 0) > 0.05)));
  const pool = viable.length ? viable : holds;
  return pool[Math.floor(Math.random() * pool.length)];
}

// pickFoundingFocus — the founding speaker's calling for a NEW hold, weighted by
// the land + a roll, so each fresh settlement opens toward a different aim
// (food/defense/growth/trade/industry) instead of the same deterministic build.
function pickFoundingFocus(h) {
  const r = h.rich || {}, w = { growth: 1, food: 1, trade: 1, industry: 1, defense: 1 };
  if ((h.danger || 0) > 0.4) w.defense += 2;
  if ((r.food || 0) < 0.25) w.food += 1.5;
  if ((r.coin || 0) > 0.5) w.trade += 1.5;
  if ((r.ore || 0) + (r.stone || 0) > 0.6) w.industry += 1.5;
  if ((r.food || 0) > 0.5 && (h.danger || 0) < 0.3) w.growth += 1.5;
  const entries = Object.entries(w), tot = entries.reduce((a, [, v]) => a + v, 0);
  let x = Math.random() * tot;
  for (const [k, v] of entries) if ((x -= v) <= 0) return k;
  return 'growth';
}

function bgForHold(h) {
  if (/tundra|glacier/.test(h.region)) return 0x2a3238;
  if (/coast|lake/.test(h.region)) return 0x1c3040;
  return 0x141a12;
}



// ---- day/night + season + frame ------------------------------------
// A full-screen multiply tint. A white-texture Sprite (not a Graphics) so its
// tint can be re-set every frame — the night warms through dusk, and the
// season wash recolours by season.
function makeOverlay(color) {
  const s = new Sprite(Texture.WHITE);
  s.tint = color;
  s.width = window.innerWidth; s.height = window.innerHeight;
  s.blendMode = 'multiply';
  return s;
}

// lerpColor blends two 0xRRGGBB colors per channel (t in 0..1).
function lerpColor(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}
// A faint multiply cast per season — winter cool, autumn amber, etc.
const SEASON_TINT = { Spring: 0xdaf0d2, Summer: 0xfff0d2, Autumn: 0xf2d8b4, Winter: 0xcdd8f2 };

// ---- seasonal weather (screen-space drifting particles) --------------
// Snow in winter, tumbling leaves in autumn, petals in spring, near-none in
// summer — purely atmospheric, a pool of flecks recycled as they fall past the
// bottom, so seasons READ on screen, not just in the HUD.
const WEATHER = {
  Winter: { n: 120, tint: 0xffffff, vy: 18, sway: 12, size: 3, alpha: 0.95 },
  Autumn: { n: 60, tint: 0xd8863a, vy: 34, sway: 34, size: 3, alpha: 0.9 },
  Spring: { n: 55, tint: 0xffd0e8, vy: 14, sway: 26, size: 3, alpha: 0.85 },
  Summer: { n: 16, tint: 0xfff0c0, vy: 11, sway: 8, size: 2, alpha: 0.5 },
};
const WEATHER_MAX = 120;
function initWeather() {
  S.weatherFx = new Container();
  S.app.stage.addChild(S.weatherFx);         // above the world + night overlay; the HUD is separate DOM
  S.weatherFx.parts = [];
  for (let i = 0; i < WEATHER_MAX; i++) {
    const p = new Sprite(Texture.WHITE); p.anchor.set(0.5);
    p.x = Math.random() * window.innerWidth; p.y = Math.random() * window.innerHeight;
    p.spd = 0.6 + Math.random() * 0.8; p.phase = Math.random() * Math.PI * 2;
    S.weatherFx.addChild(p); S.weatherFx.parts.push(p);
  }
}
function stepWeather(dt) {
  if (!S.weatherFx) return;
  const cfg = WEATHER[S.game.seasonName()] || WEATHER.Summer;
  const parts = S.weatherFx.parts, W = window.innerWidth, H = window.innerHeight;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i >= cfg.n) { p.visible = false; continue; }
    p.visible = true; p.tint = cfg.tint; p.alpha = cfg.alpha; p.width = p.height = cfg.size;
    p.phase += dt;
    p.y += cfg.vy * p.spd * dt;
    p.x += Math.sin(p.phase) * cfg.sway * dt;
    if (p.y > H + 4) { p.y = -4; p.x = Math.random() * W; }
    if (p.x < -4) p.x = W + 4; else if (p.x > W + 4) p.x = -4;
  }
}

// ---- villager mood emotes -------------------------------------------
// A little colour-coded bubble floats up from a villager's head to voice the
// hold's state — yellow content, blue glum, orange hungry, green sick — so
// morale/hunger/sickness (F5) read on screen, not just in the HUD.
function villagerEmote(v, color) {
  const g = new Graphics().circle(0, 0, 3.4).fill(color).stroke({ width: 0.8, color: 0x14140f, alpha: 0.6 });
  const dot = new Graphics().circle(-1, -1, 1).fill({ color: 0xffffff, alpha: 0.7 }); // a highlight so it reads as a bubble
  g.addChild(dot);
  g.x = v.x; g.y = v.y - 30; g.zIndex = 1e7;
  S.entities.addChild(g);
  const t0 = performance.now();
  const tick = () => {
    const k = (performance.now() - t0) / 1100;
    if (k >= 1 || !v.parent) { S.entities.removeChild(g); g.destroy(); return; }
    g.x = v.x; g.y = v.y - 30 - k * 10; g.alpha = 1 - k * k;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
// discoveryBurst — a eureka of gold + insight-blue sparks rises from the
// Scholars' Hall (or the keep) when a new discovery lands, so research reads as
// a MOMENT on screen, not only a chronicle line.
function discoveryBurst() {
  const hall = [...S.placed.entries()].find(([k]) => k.startsWith('scholarshall#'));
  const c = hall && hall[1] && hall[1].container;
  const px = c ? c.x + TILE : CENTER_TX * TILE, py = c ? c.y : CENTER_TY * TILE;
  for (let i = 0; i < 16; i++) {
    const col = i % 2 ? 0xf2d24e : 0x8fd0ff;
    const g = new Graphics().circle(0, 0, 1.4 + Math.random()).fill(col);
    g.x = px + (Math.random() - 0.5) * 20; g.y = py - Math.random() * 8; g.zIndex = 1e7;
    S.entities.addChild(g);
    const vx = (Math.random() - 0.5) * 28, vy = -22 - Math.random() * 22, t0 = performance.now();
    const tick = () => {
      const k = (performance.now() - t0) / 1050;
      if (k >= 1) { S.entities.removeChild(g); g.destroy(); return; }
      g.x += vx * 0.016; g.y += vy * 0.016; g.alpha = 1 - k;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

// ---- trade caravans -------------------------------------------------
// When the hold trades, a caravan (a gold trader hauling a crate) trundles
// between a market and a map edge — routed through the gates by findPath — so
// the economy's trade reads on screen. Spawned (throttled) off game.tradeTally.
function spawnCaravan() {
  const market = [...S.placed.entries()].find(([k]) => k.startsWith('market#'));
  const mc = market && market[1].container;
  const mx = mc ? mc.x + TILE : CENTER_TX * TILE, my = mc ? mc.y + TILE : CENTER_TY * TILE;
  const edge = [[Math.random() * TOWN_W, 0], [Math.random() * TOWN_W, TOWN_H - 1], [0, Math.random() * TOWN_H], [TOWN_W - 1, Math.random() * TOWN_H]][Math.floor(Math.random() * 4)];
  const ex = edge[0] * TILE, ey = edge[1] * TILE, out = Math.random() < 0.5; // departing or arriving
  const c = new Container();
  const a = new AnimatedSprite(S.atlas.walk.down); a.anchor.set(0.5, 1); a.animationSpeed = 0.12; a.tint = 0xf2c14e; a.play();
  const crate = new Sprite(S.atlas.tex(106)); crate.anchor.set(0.5, 1); crate.scale.set(0.7); crate.x = 3; crate.y = -18;
  c.addChild(a, crate); c.anim = a;
  c.x = out ? mx : ex; c.y = out ? my : ey; c.zIndex = c.y; c.dir = 'down';
  S.entities.addChild(c);
  goTo(c, out ? ex : mx, out ? ey : my);
  if (!S.caravans) S.caravans = [];
  S.caravans.push(c);
}
function killCaravan(c) { c.dead = true; S.entities.removeChild(c); c.destroy({ children: true }); }
function stepCaravan(dt) {
  if (!S.caravans || !S.caravans.length) return;
  for (const c of S.caravans) {
    if (c.dead) continue;
    if (!c.path || !c.path.length) { killCaravan(c); continue; } // arrived (or no route) → gone
    const wp = c.path[0], dx = wp.x - c.x, dy = wp.y - c.y, d = Math.hypot(dx, dy), sp = 22 * dt;
    if (d < sp) { c.x = wp.x; c.y = wp.y; c.path.shift(); } else { c.x += (dx / d) * sp; c.y += (dy / d) * sp; }
    c.zIndex = c.y;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    if (dir !== c.dir) { c.dir = dir; c.anim.textures = S.atlas.walk[dir]; c.anim.play(); }
  }
  S.caravans = S.caravans.filter((c) => !c.dead);
}

// divinePulse — golden rings ripple out from the reliquaries (or the keep if
// none) when the Will speaks, so a decree is a divine MOMENT on screen.
function divinePulse() {
  const spots = [];
  for (const [k, rec] of S.placed) if (k.startsWith('reliquary#') && rec.container) spots.push({ x: rec.container.x + TILE, y: rec.container.y + TILE });
  if (!spots.length) spots.push({ x: CENTER_TX * TILE, y: CENTER_TY * TILE });
  for (const s of spots) {
    const ring = new Graphics(); ring.x = s.x; ring.y = s.y; ring.zIndex = 2e7;
    S.entities.addChild(ring);
    const t0 = performance.now();
    const tick = () => {
      const k = (performance.now() - t0) / 1300;
      if (k >= 1) { S.entities.removeChild(ring); ring.destroy(); return; }
      ring.clear().circle(0, 0, 4 + k * 44).stroke({ width: 2.2 * (1 - k), color: 0xffe27a, alpha: 0.75 * (1 - k) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

// drawFealty — a faint gold thread from each pop to its speaker (v.liege), so
// the fealty parishes (F9) read as a subtle web. Redrawn each frame (folk move).
function drawFealty() {
  if (!S.fealtyGfx) { S.fealtyGfx = new Graphics(); S.ground.addChild(S.fealtyGfx); }
  const g = S.fealtyGfx; g.clear();
  let any = false;
  for (const v of S.villagers) {
    const lg = v.liege;
    if (!lg || !lg.parent) continue;
    g.moveTo(v.x, v.y - 6).lineTo(lg.x, lg.y - 6); any = true;
  }
  if (any) g.stroke({ width: 0.7, color: 0xffdf6a, alpha: 0.28 }); // speaker-gold, faint
}

// stepMood — now and then, a couple of folk express the hold's mood/health.
function stepMood() {
  const g = S.game; let color = null;
  if (g.starving) color = 0xd94f3f;                                       // hungry — red (reads against the ground)
  else if ((g.plagueTally || 0) > (S.lastMoodPlague || 0)) color = 0x6fbf4a; // a fresh sickness — green
  else if ((g.happiness ?? 0.6) < 0.35) color = 0x6f86e0;                 // glum — blue
  else if ((g.happiness ?? 0.6) > 0.8 && Math.random() < 0.6) color = 0xf2d24e; // content — yellow
  S.lastMoodPlague = g.plagueTally || 0;
  if (!color || !S.villagers.length) return;
  const pool = S.villagers.slice().sort(() => Math.random() - 0.5).slice(0, 2 + (Math.random() * 2 | 0));
  for (const v of pool) villagerEmote(v, color);
}

function onFrame(ticker) {
  const dt = Math.min(0.1, ticker.deltaMS / 1000);
  for (const v of S.villagers) stepVillager(v, dt);
  stepRaid(dt);   // advance any live raid wave (move raiders, resolve the clash)
  stepWeather(dt); // drift the seasonal snow/leaves/petals
  stepCaravan(dt); // trundle any trade caravans between market + edge
  drawFealty();    // the faint parish threads from folk to their speaker
  // hover highlight rings: perma (v.home) vs temp (v.haulTarget) assignees of
  // S.hoverBuilding — only exist while hovering (see setHoverBuilding).
  if (S.hoverBuilding) refreshHighlights(Date.now());
  if (S.highlightRings.size) {
    const pulse = 0.55 + 0.35 * Math.sin(performance.now() / 260); // temp's "in transit" breathe
    for (const [v, rec] of S.highlightRings) {
      rec.gfx.x = v.x; rec.gfx.y = v.y; rec.gfx.zIndex = v.y - 0.5; // just under the villager's feet
      if (rec.kind === 'temp') rec.gfx.alpha = pulse;
    }
  }
  // camera: WASD nudges it; otherwise a slow auto-tour that resumes ~12s
  // after you stop steering (drag is handled in initPan).
  if (heldKeys.size) {
    const sp = 16 * dt;
    if (heldKeys.has('w')) S.cam.y -= sp;
    if (heldKeys.has('s')) S.cam.y += sp;
    if (heldKeys.has('a')) S.cam.x -= sp;
    if (heldKeys.has('d')) S.cam.x += sp;
    clampCam(); manualCam();
  }
  if (S.camAuto) {
    // Tour a fixed radius around the town centre (map middle), not the whole
    // wilderness — the amplitude is in tiles so it stays near the settlement.
    const ct = Date.now() / 1000;
    const tx = CENTER_TX + Math.sin(ct * 0.024) * 14;
    const ty = CENTER_TY + Math.cos(ct * 0.017) * 10;
    S.cam.x += (tx - S.cam.x) * 0.04;
    S.cam.y += (ty - S.cam.y) * 0.04;
  } else if (Date.now() - S.lastInput > 12000) {
    S.camAuto = true; // resume the tour after you stop panning
  }
  S.world.x = Math.round(window.innerWidth / 2 - S.cam.x * TILE * S.scale);
  S.world.y = Math.round(window.innerHeight / 2 - S.cam.y * TILE * S.scale);
  // day/night + season
  const phase = (Date.now() % DAY_MS) / DAY_MS;                 // 0..1
  const daylight = 0.5 + 0.5 * Math.sin((phase - 0.25) * 2 * Math.PI); // noon=1, midnight=0
  S.night.alpha = 0.62 * (1 - daylight);                       // deeper, clearer nights
  const duskAmt = Math.max(0, 1 - Math.abs(daylight - 0.5) / 0.25); // the sun sits low near daylight 0.5 (dawn + dusk)
  S.night.tint = lerpColor(0x0a1230, 0x241010, duskAmt);       // cold-blue night → warm ember at the golden hour
  S.night.width = window.innerWidth; S.night.height = window.innerHeight;
  // a faint seasonal cast over the whole scene
  S.seasonFx.tint = SEASON_TINT[S.game.seasonName()];
  S.seasonFx.alpha = 0.12;
  S.seasonFx.width = window.innerWidth; S.seasonFx.height = window.innerHeight;
  // raid alarm pulse
  if (S.alarm > 0) { S.alarm -= dt; S.alarmFx.alpha = 0.18 * Math.max(0, Math.sin(S.alarm * 10)); S.alarmFx.width = window.innerWidth; S.alarmFx.height = window.innerHeight; }
  else S.alarmFx.alpha = 0;
}

function layoutWorld() {
  // Set a comfortable starting zoom once; keep the player's zoom across resizes.
  if (S.scale == null) S.scale = Math.max(3, Math.round(Math.min(window.innerWidth, window.innerHeight) / 300));
  S.world.scale.set(S.scale);
  if (S.app) S.app.renderer.resize(window.innerWidth, window.innerHeight);
}

// setZoom keeps the scale an integer (1..8) so pixels stay crisp at every level.
function setZoom(s) {
  S.scale = Math.max(1, Math.min(8, Math.round(s)));
  S.world.scale.set(S.scale);
}
function initZoom() {
  addEventListener('wheel', (e) => {
    if (e.target.closest('.popout-bg')) return; // let the popout scroll its own body instead of zooming the map
    e.preventDefault(); setZoom(S.scale + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
}

// Manual camera: left-drag or WASD. Both flag manual mode so the auto-tour
// yields, and the camera is clamped to the map.
function manualCam() { S.camAuto = false; S.lastInput = Date.now(); }
function clampCam() {
  S.cam.x = Math.max(0, Math.min(TOWN_W, S.cam.x));
  S.cam.y = Math.max(0, Math.min(TOWN_H, S.cam.y));
}
// buildingAt maps a screen point back to the building under it (or null).
function buildingAt(cx, cy) {
  const wx = (cx - S.world.x) / S.scale / TILE;   // S.scale is the numeric zoom (S.world.scale is a Point)
  const wy = (cy - S.world.y) / S.scale / TILE;
  let hit = null;
  for (const h of S.hittable) {
    if (wx >= h.x0 - 0.2 && wx < h.x1 + 0.2 && wy >= h.y0 - 0.2 && wy < h.y1 + 0.4) hit = h; // later = drawn on top
  }
  return hit;
}
// hoverIdentify shows a small label for the building under the cursor, and
// (via setHoverBuilding) drives the assigned-villager highlight rings.
function hoverIdentify(e) {
  const h = buildingAt(e.clientX, e.clientY);
  if (h !== S.hoverBuilding) setHoverBuilding(h);
  const tip = document.getElementById('btip');
  if (!tip) return;
  if (!h) { tip.style.display = 'none'; return; }
  let text = h.label || BUILD_NAME[h.type] || h.type;
  if (h.type) {
    const hash = h.key ? h.key.indexOf('#') : -1;
    const idx = hash >= 0 ? Number(h.key.slice(hash + 1)) : null;   // this building's own level, not the hold's total
    const lv = idx != null ? S.game.instanceLevel(h.type, idx) : S.game.level(h.type);
    if (lv) text += ' · lvl ' + lv;
  }
  if (h.type && BY_ID[h.type] && BY_ID[h.type].kind === 'storage') { const fill = storageFill(h.type); if (fill) text += ' · ' + fill; }
  const dist = districtOf(h); if (dist) text += ' · ' + DISTRICT_NAME[dist];
  tip.textContent = text;
  tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px';
  tip.style.display = 'block';
}

// storageFill summarizes a storage building's overall fill for #btip: the
// sum of stored goods over the sum of caps, across every resource that
// building type contributes to (per capBreakdown, so it agrees with caps()).
// '' if it caps nothing (shouldn't happen, but keeps the tooltip clean).
function storageFill(id) {
  const g = S.game;
  let cur = 0, cap = 0;
  for (const k of Object.keys(CFG.baseCaps)) {
    if (k === 'coin') continue; // uncapped — not part of a storehouse's remit
    const { contributors, total } = g.capBreakdown(k);
    if (!contributors.some((c) => c.id === id)) continue;
    cur += g.res[k]; cap += total;
  }
  return cap > 0 ? `stores ${Math.floor(cur)} / ${Math.floor(cap)}` : '';
}

// ---- hover highlight (perma vs temp assignees) -----------------------
// makeHighlightRing draws the small ground ring under a highlighted
// villager's feet — perma is a steady solid-gold ring, temp a lighter cyan
// one whose alpha gets pulsed each frame in onFrame.
function makeHighlightRing(kind) {
  const g = kind === 'perma'
    ? new Graphics().ellipse(0, 0, 8, 3.5).fill({ color: HIGHLIGHT_COLOR.perma, alpha: 0.32 }).stroke({ width: 1.4, color: 0xffe27a, alpha: 0.95 })
    : new Graphics().ellipse(0, 0, 7, 3).fill({ color: HIGHLIGHT_COLOR.temp, alpha: 0.55 }).stroke({ width: 1, color: 0xbdf3ff, alpha: 0.9 });
  S.entities.addChild(g);
  return g;
}

// clearHighlightRings tears down every ring — the only cleanup path, so
// highlights never outlive a hover (called on every hover change/clear).
function clearHighlightRings() {
  for (const rec of S.highlightRings.values()) { S.entities.removeChild(rec.gfx); rec.gfx.destroy(); }
  S.highlightRings.clear();
}

// refreshHighlights (re)builds the ring set for S.hoverBuilding's assigned
// villagers. Throttled to ~200ms — temp (hauling) assignees turn over as
// workers come and go, so this is re-run periodically, not every frame.
function refreshHighlights(now) {
  if (now - S.highlightAt < 200) return;
  S.highlightAt = now;
  const hb = S.hoverBuilding, want = new Map();
  if (hb) for (const v of S.villagers) {
    if (v.home === hb) want.set(v, 'perma');
    else if (v.haulTarget === hb) want.set(v, 'temp');
  }
  for (const [v, rec] of S.highlightRings) {          // drop stale/changed-kind rings
    if (want.get(v) !== rec.kind) { S.entities.removeChild(rec.gfx); rec.gfx.destroy(); S.highlightRings.delete(v); }
  }
  for (const [v, kind] of want) {                      // add newly-assigned villagers
    if (!S.highlightRings.has(v)) S.highlightRings.set(v, { kind, gfx: makeHighlightRing(kind) });
  }
}

// setHoverBuilding swaps the hovered building: redraws its subtle outline, the
// boundary of the DISTRICT it sits in (core / farmland), and tears down old
// rings immediately (refreshHighlights repopulates them next frame —
// S.highlightAt is reset so the throttle doesn't delay it).
function setHoverBuilding(h) {
  if (S.hoverGfx) { S.ground.removeChild(S.hoverGfx); S.hoverGfx.destroy(); S.hoverGfx = null; }
  if (S.districtGfx) { S.ground.removeChild(S.districtGfx); S.districtGfx.destroy(); S.districtGfx = null; }
  S.hoverBuilding = h;
  clearHighlightRings();
  S.highlightAt = 0;
  if (h) {
    drawDistrictBorder(districtOf(h));   // under the footprint, so the building's own outline reads on top
    const x0 = h.x0 * TILE, y0 = h.y0 * TILE, w = (h.x1 - h.x0) * TILE, ht = (h.y1 - h.y0) * TILE;
    S.hoverGfx = new Graphics().rect(x0, y0, w, ht).stroke({ width: 2, color: 0xfff3c0, alpha: 0.55 });
    S.ground.addChild(S.hoverGfx);
  }
}

// A district's name (tooltip) + border colour (the hover outline).
const DISTRICT_NAME = { core: 'Keep district', farmland: 'Farmland', works: 'Outlands' };
const DISTRICT_COLOR = { core: 0xffcf5a, farmland: 0x8fd24a };

// drawDistrictBorder outlines the hovered building's district on the ground
// layer: the core as its bounding box (what the walls enclose), farmland as
// the true perimeter of the tilled tiles. The outlands works aren't a bounded
// district, so they draw no border (just the building's own footprint).
function drawDistrictBorder(district) {
  const col = DISTRICT_COLOR[district];
  if (!col) return;
  let g = null;
  if (district === 'core') {
    const b = coreBounds();
    if (!b) return;
    g = new Graphics()
      .rect(b.x0 * TILE, b.y0 * TILE, (b.x1 - b.x0) * TILE, (b.y1 - b.y0) * TILE)
      .fill({ color: col, alpha: 0.05 }).stroke({ width: 2, color: col, alpha: 0.6 });
  } else if (district === 'farmland') {
    g = new Graphics();
    for (const key of S.farmTiles.keys()) { const [tx, ty] = key.split(',').map(Number); g.rect(tx * TILE, ty * TILE, TILE, TILE); }
    g.fill({ color: col, alpha: 0.05 });
    for (const key of S.farmTiles.keys()) {
      const [tx, ty] = key.split(',').map(Number); const x = tx * TILE, y = ty * TILE;
      if (!S.farmTiles.has(`${tx},${ty - 1}`)) g.moveTo(x, y).lineTo(x + TILE, y);
      if (!S.farmTiles.has(`${tx},${ty + 1}`)) g.moveTo(x, y + TILE).lineTo(x + TILE, y + TILE);
      if (!S.farmTiles.has(`${tx - 1},${ty}`)) g.moveTo(x, y).lineTo(x, y + TILE);
      if (!S.farmTiles.has(`${tx + 1},${ty}`)) g.moveTo(x + TILE, y).lineTo(x + TILE, y + TILE);
    }
    g.stroke({ width: 2, color: col, alpha: 0.65 });
  }
  if (g) { S.districtGfx = g; S.ground.addChild(g); }
}

function initPan() {
  const el = S.app.canvas;
  el.style.cursor = 'grab';
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId);
    el.style.cursor = 'grabbing'; manualCam();
  });
  el.addEventListener('pointermove', (e) => {
    if (drag) {
      S.cam.x -= (e.clientX - drag.x) / (TILE * S.scale);
      S.cam.y -= (e.clientY - drag.y) / (TILE * S.scale);
      drag = { x: e.clientX, y: e.clientY };
      clampCam(); manualCam();
      return;
    }
    hoverIdentify(e);
  });
  const end = () => { drag = null; el.style.cursor = 'grab'; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', () => { const t = document.getElementById('btip'); if (t) t.style.display = 'none'; setHoverBuilding(null); });
  addEventListener('keydown', (e) => { if (e.target && e.target.tagName === 'INPUT') return; const k = e.key.toLowerCase(); if (k === 'w' || k === 'a' || k === 's' || k === 'd') heldKeys.add(k); });
  addEventListener('keyup', (e) => heldKeys.delete(e.key.toLowerCase()));
  addEventListener('blur', () => heldKeys.clear()); // don't let a key stick when focus leaves
}

// ---- the sim/steward loop ------------------------------------------

// townTick: advance the economy a real second, execute orders, keep the
// visible town in step with it, and reflect raids.
function townTick() {
  const now = Date.now();
  const dt = Math.min(2, (now - S.game.lastTick) / 1000);
  S.game.step(dt); S.game.lastTick = now; S.game.save();

  // Faith crossing its threshold is the Will's primary invocation trigger now
  // (STEWARD_MS's ambient timer is just a slow backstop) — the god speaks
  // when the hold's speakers have raised enough of it, not on a fixed clock.
  if (S.game.faithReady) {
    S.game.faithReady = false;
    callWill(`${S.mask.aspect} is invoked`);
  }

  executeOrders(dt);
  reconcileBuildings();
  reconcileVillagers();

  // A raid was decided since last look: keep isRaided() true briefly (the muster
  // boost) and spawn the LIVE wave (raids.js) for the folk to fight — raids.js
  // chronicles the clash itself. Offline raids stayed abstract (no wave).
  const rt = S.game.raidTally || 0;
  if (S.game.raidWave) { spawnRaidWave(S.game.raidWave.n, S.game.raidWave.bite); S.game.raidWave = null; }
  setTimeout(() => { S.lastRaidTally = rt; }, 2500);
  // a batch of stores turned since last look → chronicle it (mirrors raids)
  const st = S.game.spoilTally || 0;
  if (st > (S.lastSpoilTally || 0)) {
    const last = S.game.log.find((l) => l.kind === 'spoil');
    if (last) pushChronicle('🥀 ' + last.text, 'note');
  }
  S.lastSpoilTally = st;
  // a new discovery since last look → chronicle it (mirrors raids/spoilage),
  // and refresh the Archive if the lord has it open (like the Will popout).
  const disc = S.game.discoveryTally || 0;
  if (disc > (S.lastDiscoveryTally || 0)) {
    const last = S.game.log.find((l) => l.kind === 'discovery');
    if (last) pushChronicle('📖 ' + last.text, 'discovery');
    if (S.ui.archivePopout && S.ui.archivePopout.isOpen()) S.ui.archivePopout.setContent(renderArchiveDetail());
    discoveryBurst();   // a visible eureka at the Scholars' Hall
  }
  S.lastDiscoveryTally = disc;
  // a sickness (or a hunger line) since last look → chronicle it (both log as 'plague')
  const pl = (S.game.plagueTally || 0) + (S.game.starveTally || 0);
  if (pl > (S.lastPlagueTally || 0)) {
    const last = S.game.log.find((l) => l.kind === 'plague');
    if (last) pushChronicle('🤢 ' + last.text, 'raid');
  }
  S.lastPlagueTally = pl;
  // the Will spoke since last look → a divine pulse from the shrines
  if (S.willHistory.length > (S.lastWillCount || 0)) divinePulse();
  S.lastWillCount = S.willHistory.length;
  // the hold traded since last look → send a caravan now and then (throttled)
  const tt = S.game.tradeTally || 0;
  if (tt > (S.lastTradeTally || 0) && Date.now() - (S.lastCaravan || 0) > 11000) { spawnCaravan(); S.lastCaravan = Date.now(); }
  S.lastTradeTally = tt;
  renderOrders();
  updateHUD(); // folds the Folk legend + defense into the Pop chip now
}



// dumpState POSTs a FULL live diagnostic snapshot to the local server
// (→ debug-dump.json) so state can be inspected without a GPU. Runs on a timer
// (boot) so the file is always fresh; 'i' forces one now. (temporary)
function dumpState() {
  const g = S.game, B = window.XANGAME.BUILDINGS;
  const R = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
  const R2 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +Number(v).toFixed(2)]));
  const perB = (fn) => Object.fromEntries(B.map((b) => [b.id, fn(b)]).filter(([, v]) => v));
  const roleCounts = {};
  for (const v of S.villagers) roleCounts[v.role] = (roleCounts[v.role] || 0) + 1;
  const snap = {
    at: new Date().toISOString(),
    hold: { name: S.hold.name, tier: S.hold.tierName, realm: S.hold.realm, danger: S.hold.danger, rich: R2(S.hold.rich) },
    time: { season: g.seasonName(), dayPart: g.dayPartName(), warmthNow: +g.warmthNow().toFixed(2) },
    pop: +g.pop.toFixed(1), popCap: g.popCap(), efficiency: +g.efficiency().toFixed(2), jobs: g.jobs(),
    villagers: S.villagers.length, roleCounts,
    happiness: +(g.happiness ?? 0).toFixed(2), moraleShock: +(g.moraleShock || 0).toFixed(2), starving: !!g.starving,
    res: R(g.res), caps: R(g.caps()), rates: R2(g.rates()),
    food: { total: Math.round(g.foodTotal()), cap: Math.round(g.foodCapTotal()), eatPerS: +g.foodEatPerS().toFixed(2), onGround: +g.foodOnGround().toFixed(2) },
    levels: perB((b) => g.level(b.id)), counts: perB((b) => g.count(b.id)), instances: g.instances,
    defense: g.defense(),
    faith: { now: Math.round(g.faith), threshold: g.faithThreshold(), speakers: g.speakers() },
    research: { insight: Math.round(g.research.insight), researchers: g.researchers(), done: g.research.done, next: (g.researchNext() || {}).name || null },
    focus: S.focus, fealty: S.parishSizes,
    orders: S.orderLog.map((o) => ({ type: o.type, target: o.target, section: o.section, upgrade: o.upgrade, status: o.status, progress: +(o.progress || 0).toFixed(2), qtyLeft: o.qtyLeft, waited: +(o.waited || 0).toFixed(1) })),
    walls: { tiles: S.walls.size, gates: S.gates.size, towers: S.towers.size, sectionTier: S.sectionTier, edges: [...S.wallEdgesBuilt] },
    town: { placed: [...S.placed.keys()], sites: S.sites.length, siteKeys: [...S.siteKeys], usedPlots: S.usedPlots.size, farmTiles: S.farmTiles.size, raiders: (S.raiders || []).length },
    lastWill: S.lastWill ? { utterance: S.lastWill.utterance, speakers: (S.lastWill.speakers || []).map((sp) => ({ name: sp.name, directive: sp.directive, orders: (sp.orders || []).map((o) => `${o.type}:${o.target || o.value || o.resource || ''}`) })) } : null,
    chronicle: (S.chronicle || []).slice(0, 12).map((c) => c.text),
    perf: {
      fps: Math.round((S.app && S.app.ticker && S.app.ticker.FPS) || 0),
      entities: (S.entities && S.entities.children.length) || 0,   // everything the per-frame z-sort touches
      villagers: S.villagers.length, wallSprites: (S.wallSprites || []).length, towerSprites: (S.towerSprites || []).length,
      woodNodes: (S.woodNodes || []).length, oreNodes: (S.oreNodes || []).length,
      farmTiles: S.farmTiles.size, sites: S.sites.length, raiders: (S.raiders || []).length,
      scale: S.scale,
    },
  };
  fetch('/debug', { method: 'POST', body: JSON.stringify(snap, null, 2) }).catch(() => {});
}

// ---- input ----------------------------------------------------------
function wireKeys() {
  addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return; // let the Steward-ask input type freely
    const k = e.key.toLowerCase();
    if (k === 'p') showStewardAsk();
    else if (k === 'h') { S.hudOn = !S.hudOn; document.getElementById('hud').style.display = S.hudOn ? '' : 'none'; }
    else if (k === 'm') location.href = '/index.html';
    else if (k === 'i') dumpState();   // debug: POST a live-state snapshot for inspection (temporary)
    else if (k === '=' || k === '+') setZoom(S.scale + 1);
    else if (k === '-' || k === '_') setZoom(S.scale - 1);
    else if (k === 'r') {
      // Navigate with ?reset=1 so the wipe happens at boot, BEFORE the game
      // (and its autosave) exists — reset+reload had a race where the 1s
      // autosave re-wrote the save before the reload took hold.
      if (confirm('Reset the world? Every hold starts over.')) {
        const p = new URLSearchParams(location.search); p.set('reset', '1');
        location.search = '?' + p.toString();
      }
    }
  });
}

boot().catch((e) => {
  document.getElementById('stage').innerHTML =
    `<pre style="color:#e5736b;padding:20px">town failed to boot:\n${e && e.stack || e}</pre>`;
  console.error(e);
});
