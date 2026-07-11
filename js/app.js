(function(){
// app.js — the founding screen: the map picker (map.js) + a seat dossier,
// wired to the idle engine (game.js). Founding or returning to a hold opens
// the living town view (town.html); this screen is only the picker.

const { allHolds } = window.XAN;
const { drawMap, hitTest } = window.XANMAP;
const { Game } = window.XANGAME;

const HOLDS = allHolds();
const RES_META = {
  food: ['🌾', 'Food'], timber: ['🪵', 'Timber'], stone: ['🪨', 'Stone'],
  ore: ['⛏️', 'Ore'], salt: ['🧂', 'Salt'], coin: ['🪙', 'Coin'],
};
const $ = (s) => document.querySelector(s);

let hover = null, chosen = null, xf = null;

// ---- founding screen ------------------------------------------------
function showFounding() {
  $('#founding').style.display = 'flex';
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

// ---- entering a hold ------------------------------------------------
// Founding or returning to a hold opens the living town view — the primary
// experience. This screen is only the map picker.
function enterHold(h) {
  location.href = '/town.html?hold=' + encodeURIComponent(h.id);
}

// ---- boot -----------------------------------------------------------
$('#toMap').onclick = () => showFounding();
$('#worldMeta').textContent = `world seed ${window.WORLD.seed} · ${window.WORLD.era} · ${HOLDS.length} seats`;
showFounding();
})();
