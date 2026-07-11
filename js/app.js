(function(){
// app.js — screens, DOM binding, and the render/tick loop that ties the
// map picker (map.js) to the idle engine (game.js).

const { allHolds } = window.XAN;
const { drawMap, hitTest } = window.XANMAP;
const { Game, BUILDINGS, BY_ID } = window.XANGAME;

const HOLDS = allHolds();
const RES_META = {
  food: ['🌾', 'Food'], timber: ['🪵', 'Timber'], stone: ['🪨', 'Stone'],
  ore: ['⛏️', 'Ore'], salt: ['🧂', 'Salt'], coin: ['🪙', 'Coin'],
};
const $ = (s) => document.querySelector(s);

let game = null, hover = null, chosen = null, xf = null, raf = null;

// ---- founding screen ------------------------------------------------
function showFounding() {
  stopLoop();
  $('#founding').style.display = 'flex';
  $('#hold').style.display = 'none';
  const canvas = $('#map');
  fitCanvas(canvas);
  renderMap();
  renderRoster();
  if (!canvas._wired) wireMap(canvas);
}

function fitCanvas(canvas) {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.floor(r.width);
  canvas.height = Math.floor(r.height);
}

function renderMap() {
  const canvas = $('#map');
  xf = drawMap(canvas, HOLDS, hover && hover.id, chosen && chosen.id);
}

function wireMap(canvas) {
  canvas._wired = true;
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const h = hitTest(HOLDS, xf, e.clientX - r.left, e.clientY - r.top);
    if ((h && h.id) !== (hover && hover.id)) { hover = h; renderMap(); }
    canvas.style.cursor = h ? 'pointer' : 'default';
  });
  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect();
    const h = hitTest(HOLDS, xf, e.clientX - r.left, e.clientY - r.top);
    if (h) { chosen = h; renderMap(); renderDossier(h); }
  });
  addEventListener('resize', () => { if ($('#founding').style.display !== 'none') { fitCanvas(canvas); renderMap(); } });
}

function renderDossier(h) {
  const saved = Game.hasSave(h.id);
  const stars = (v) => '▰'.repeat(Math.round(v * 5)) + '▱'.repeat(5 - Math.round(v * 5));
  const richRows = window.XAN.RESOURCES.map((k) => {
    const v = k === 'food' ? h.rich.food : h.rich[k];
    return `<div class="richrow"><span>${RES_META[k][0]} ${RES_META[k][1]}</span><b class="bar">${stars(v)}</b></div>`;
  }).join('');
  const feats = h.nearby.length
    ? h.nearby.map((f) => `<span class="chip ${f.kind}">${f.name} <em>${f.kind}</em></span>`).join('')
    : '<span class="dim">no named landmarks close by</span>';
  $('#dossier').innerHTML = `
    <div class="dhead">
      <h2>${h.name}</h2>
      <div class="tier">${h.tierName} · ${h.ancestry} · ${h.region}</div>
    </div>
    <p class="blurb">${h.blurb}</p>
    <div class="statline">
      <span>Realm: <b>${h.realm}${h.realmCrown ? ' 👑' : ''}</b></span>
      <span>Allegiance: <b>${(h.allegiance).toFixed(2)}</b></span>
      <span>Elev: <b>${h.elev}m</b></span>
      <span>Temp: <b>${h.temp}°C</b></span>
      <span>Danger: <b class="${h.danger > 0.5 ? 'bad' : h.danger > 0.25 ? 'warn' : 'good'}">${stars(h.danger)}</b></span>
    </div>
    <div class="rich">${richRows}</div>
    <div class="feats">${feats}</div>
    <button id="foundBtn" class="primary">${saved ? 'Return to ' + h.name : 'Found your hold at ' + h.name}</button>
    ${saved ? `<button id="razeBtn" class="ghost">abandon this hold</button>` : ''}
  `;
  $('#foundBtn').onclick = () => enterHold(h);
  if (saved) $('#razeBtn').onclick = () => { if (confirm(`Abandon ${h.name}? Its saved progress is lost.`)) { Game.abandon(h.id); renderDossier(h); renderRoster(); } };
}

function renderRoster() {
  const saves = HOLDS.filter((h) => Game.hasSave(h.id));
  const el = $('#roster');
  if (!saves.length) { el.innerHTML = '<div class="dim">No holds founded yet — pick a seat on the map.</div>'; return; }
  el.innerHTML = '<div class="rlabel">Your holds</div>' + saves.map((h) =>
    `<button class="rosterItem" data-id="${h.id}">${h.name} <em>${h.tierName}</em></button>`).join('');
  el.querySelectorAll('.rosterItem').forEach((b) => b.onclick = () => {
    const h = HOLDS.find((x) => x.id === b.dataset.id); chosen = h; renderMap(); renderDossier(h); enterHold(h);
  });
}

// ---- hold screen ----------------------------------------------------
// Founding or returning to a hold opens the living town view (the primary
// experience); the map is the picker. The old in-page stats dashboard
// below is kept only as a fallback and is no longer part of the flow.
function enterHold(h) {
  location.href = '/town.html?hold=' + encodeURIComponent(h.id);
}
function enterHoldDashboard(h) {
  game = Game.load(h);
  const away = game.catchUp();
  $('#founding').style.display = 'none';
  $('#hold').style.display = 'grid';
  buildHoldChrome(h);
  if (away && (Object.keys(away.gained).length || away.raids)) showAway(away);
  renderHold();
  startLoop();
  game.save();
}

function buildHoldChrome(h) {
  $('#holdName').textContent = h.name;
  $('#holdSub').textContent = `${h.tierName} of ${h.realm}${h.realmCrown ? ' 👑' : ''} · ${h.ancestry} · ${h.region}`;
}

function showAway(a) {
  const g = Object.entries(a.gained).filter(([k]) => RES_META[k])
    .map(([k, v]) => `<span>${RES_META[k][0]} ${v > 0 ? '+' : ''}${v}</span>`).join('');
  const mins = Math.round(a.seconds / 60);
  const time = mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
  $('#away').innerHTML = `
    <div class="awaybox">
      <h3>While you were away · ${time}${a.truncated ? ' (capped)' : ''}</h3>
      <div class="awaygains">${g || '<span class="dim">the stores held steady</span>'}</div>
      ${a.popDelta ? `<div>${a.popDelta > 0 ? '👥 the folk grew by ' + a.popDelta : '⚰️ the folk fell by ' + (-a.popDelta)}</div>` : ''}
      ${a.raids ? `<div class="bad">⚔️ raiders struck ${a.raids} time${a.raids > 1 ? 's' : ''}</div>` : ''}
      <button onclick="document.getElementById('away').innerHTML=''" class="primary">Take up the stewardship</button>
    </div>`;
}

function renderHold() {
  if (!game) return;
  renderResources();
  renderPeople();
  renderBuildings();
  renderMarket();
  renderLog();
}

function renderMarket() {
  const panel = $('#marketPanel');
  if (!game.tradeUnlocked()) {
    panel.style.display = 'block';
    $('#market').innerHTML = '<div class="dim">Build a <b>Market</b> to open trade — sell what your land yields, buy what it lacks.</div>';
    return;
  }
  panel.style.display = 'block';
  const rows = ['food', 'timber', 'stone', 'ore', 'salt'].map((k) => {
    const buy = game.buyPrice(k), sell = game.sellPrice(k);
    const canBuy = game.res.coin >= buy * window.XANGAME.CFG.tradeLot;
    const canSell = game.res[k] >= window.XANGAME.CFG.tradeLot;
    return `<div class="trow">
      <span class="tname">${RES_META[k][0]} ${RES_META[k][1]}</span>
      <button class="tbtn ${canBuy ? '' : 'no'}" data-act="buy" data-res="${k}">buy 10 · 🪙${buy * 10}</button>
      <button class="tbtn sell ${canSell ? '' : 'no'}" data-act="sell" data-res="${k}">sell 10 · 🪙${sell * 10}</button>
    </div>`;
  }).join('');
  $('#market').innerHTML = rows;
  $('#market').querySelectorAll('.tbtn').forEach((b) => b.onclick = () => {
    const ok = b.dataset.act === 'buy' ? game.buy(b.dataset.res) : game.sell(b.dataset.res);
    if (ok) { renderResources(); renderMarket(); game.save(); }
  });
}

function renderResources() {
  const rate = game.rates();
  const caps = game.caps();
  const eatFood = game.foodEatPerS();
  $('#resbar').innerHTML = window.XAN.RESOURCES.map((k) => {
    let net = rate[k];
    if (k === 'food') net -= eatFood;
    const cls = net > 0.001 ? 'up' : net < -0.001 ? 'down' : 'flat';
    const capTxt = k === 'coin' ? '' : `<span class="cap">/ ${Math.floor(caps[k])}</span>`;
    return `<div class="res">
      <div class="ricon">${RES_META[k][0]}</div>
      <div class="rbody"><div class="rval">${Math.floor(game.res[k])}${capTxt}</div>
      <div class="rrate ${cls}">${net >= 0 ? '+' : ''}${net.toFixed(2)}/s</div></div>
    </div>`;
  }).join('');
}

function renderPeople() {
  const eff = Math.round(game.efficiency() * 100);
  $('#people').innerHTML = `
    <span>👥 <b>${Math.floor(game.pop)}</b> / ${Math.floor(game.popCap())} folk</span>
    <span>🛠️ ${game.jobs()} jobs · <b class="${eff < 100 ? 'warn' : 'good'}">${eff}%</b> staffed</span>
    <span>🛡️ defense <b>${game.defense()}</b></span>`;
}

function renderBuildings() {
  const avail = game.available();
  $('#buildings').innerHTML = avail.map((b) => {
    const lv = game.level(b.id);
    const cost = game.costOf(b.id);
    const afford = game.canAfford(b.id);
    const costTxt = Object.entries(cost).map(([k, v]) =>
      `<span class="c ${game.res[k] >= v ? '' : 'short'}">${RES_META[k][0]}${v}</span>`).join(' ');
    const detail = buildingDetail(b, lv);
    return `<div class="bld ${lv ? 'owned' : ''}">
      <div class="bhead"><span class="bname">${b.name}</span><span class="blv">${lv ? 'lv ' + lv : ''}</span></div>
      <div class="bdesc">${b.desc}</div>
      <div class="bdetail">${detail}</div>
      <button class="bbuy ${afford ? '' : 'no'}" data-id="${b.id}">${lv ? 'Upgrade' : 'Build'} · ${costTxt}</button>
    </div>`;
  }).join('');
  $('#buildings').querySelectorAll('.bbuy').forEach((btn) => btn.onclick = () => {
    if (game.build(btn.dataset.id)) { renderHold(); game.save(); }
  });
}

function buildingDetail(b, lv) {
  if (b.kind === 'prod') {
    const r = game.richOf(b);
    const per = b.base * (0.35 + 0.65 * r) * game.bon.mul[b.res];
    return `${RES_META[b.res][0]} ~${per.toFixed(2)}/s per level · land ${'▰'.repeat(Math.round(r * 5))}${'▱'.repeat(5 - Math.round(r * 5))}`;
  }
  if (b.kind === 'housing') return `👥 +${b.pop} people cap per level`;
  if (b.kind === 'storage') return `📦 +${Math.round(b.capMul * 100)}% storage per level`;
  if (b.kind === 'defense') return `🛡️ +${b.def} defense per level (blunts raids)`;
  return '';
}

function renderLog() {
  const el = $('#log');
  if (!game.log.length) { el.innerHTML = '<div class="dim">The hold’s chronicle is empty. It begins now.</div>'; return; }
  el.innerHTML = game.log.map((l) => `<div class="logline ${l.kind}">${l.text}</div>`).join('');
}

// ---- loop -----------------------------------------------------------
let lastRender = 0, lastSave = 0;
function startLoop() {
  stopLoop();
  const loop = (ts) => {
    raf = requestAnimationFrame(loop);
    const now = Date.now();
    const dt = Math.min(1, (now - game.lastTick) / 1000);
    if (dt > 0.2) { game.step(dt); game.lastTick = now; }
    if (ts - lastRender > 200) { renderHold(); lastRender = ts; }
    if (now - lastSave > 4000) { game.save(); lastSave = now; }
  };
  raf = requestAnimationFrame(loop);
}
function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = null; }

// ---- boot -----------------------------------------------------------
$('#toMap').onclick = () => { if (game) game.save(); showFounding(); };
addEventListener('beforeunload', () => { if (game) game.save(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && game) game.save(); });

$('#worldMeta').textContent = `world seed ${window.WORLD.seed} · ${window.WORLD.era} · ${HOLDS.length} seats`;
showFounding();
})();
