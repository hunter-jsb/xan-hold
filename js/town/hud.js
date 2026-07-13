// hud.js — the DOM interface: resource/category chips + hover tips, the works
// panel, the Will panel + its story popout, and the chronicle. Pure display off
// S + game data; calls nothing from orders/will (they call in to refresh).
import { S } from './state.js';
import { ORDER, TRADE_ACT, BUILD_NAME, ROLE, ROLE_LABEL, ROLE_PIP } from './constants.js';
import { makePanel, makePopout } from './ui.js';
import { troopCap } from './walls.js';

const { BUILDINGS, BY_ID, CFG, FOOD, FOOD_CATS, CROP_BY_ID } = window.XANGAME;

// ---- HUD ------------------------------------------------------------
// icon: HUD glyphs are real pixel-art PNGs (Raven Fantasy Icons — see
// assets/icons/CREDITS.md), dropped in as <img> since the HUD is a DOM
// overlay, not canvas. cls lets callers ask for a size variant (e.g. 'sm').
const icon = (name, cls = '') => `<img class="ricon${cls ? ' ' + cls : ''}" src="/assets/icons/${name}.png" alt="">`;
const RES_ICON = {
  food: icon('food'), timber: icon('timber'), stone: icon('stone'), ore: icon('ore'),
  salt: icon('salt'), coin: icon('coin'), faith: icon('faith'),
  // Food categories have no PNG yet — an emoji reads them apart in the chip's
  // expanded rows and the hover tip (the collapsed chip still shows the food icon).
  grain: '🌾', roots: '🥕', greens: '🥬', fruit: '🍎', fish: '🐟',
};
// CAT_ICON: resource-key → icon name for the category-chips HUD (grouping
// resources under food/mats/ore/trade/money/pop/faith chips).
const CAT_ICON = { food: 'food', mats: 'mats', ore: 'ore', trade: 'trade', money: 'coin', pop: 'pop', faith: 'faith' };
// CATEGORIES: chip key → member resource keys. One data map drives the whole
// #resstrip — adding a resource to an existing category, or a new category,
// is a one-liner here (pop + faith are special-cased in updateHUD instead,
// since they aren't plain .res entries).
const CATEGORIES = {
  food:  ['grain', 'roots', 'greens', 'fruit', 'fish'], // typed foods, summed in the chip head
  mats:  ['timber', 'stone'],
  ore:   ['ore'],                // + future coal/copper/iron/gold ("Metals")
  trade: ['salt'],               // strategic goods (+ future)
  money: ['coin'],
  // Reserved for later — leave as commented stubs so adding them is trivial:
  //   crafted:  ['steel','cloth'],
  //   luxuries: ['wine','amber','furs'],
  //   lore:     ['lore'],
};
export function initHUD(away) {
  document.getElementById('hname').textContent = S.hold.name;
  document.getElementById('hsub').textContent =
    ` · ${S.hold.tierName} of ${S.hold.realm} · ${S.hold.ancestry} · ${S.hold.region}`;
  if (away && away.raids) pushChronicle(`While you were away, raiders came ${away.raids}×.`, 'raid');
  pushChronicle(`${S.hold.name} wakes to another day.`, 'note');
  S.ui.orders = makePanel({ region: 'tr', title: 'Works Bidden' });
  renderOrders();
  S.ui.speakers = makePanel({ region: 'l', title: S.mask.aspect || 'the Will' });
  // the compact panel stays the quick glance; clicking it opens the full,
  // scrollable "story so far" (renderWillDetail) in a popout.
  S.ui.speakers.el.classList.add('clickable');
  S.ui.speakers.el.addEventListener('click', openWillDetail);
  S.ui.willPopout = makePopout({ title: willPopoutTitle() });
  renderWillPanel();
  updateHUD();
  initResTip();
  initChipToggle();
}

// resRow renders one member resource as an icon + current/max + net-rate —
// the same markup the old flat strip used (class="res" data-res="k"), so
// initResTip's hover breakdown keeps working unchanged on these rows. Coin
// has no cap (see capBreakdown) so it skips the "/max" — storage transparency
// applies to storable goods, not the ever-open coin chest.
export function resRow(g, rate, k) {
  let net = rate[k];
  if (FOOD[k]) net -= (g.eatByCat && g.eatByCat[k] || 0) + (g.spoilByCat && g.spoilByCat[k] || 0);
  const cls = net > 0.01 ? 'up' : net < -0.01 ? 'down' : '';
  const cap = k === 'coin' ? '' : `<small class="cap">/${Math.floor(g.caps()[k])}</small>`;
  return `<span class="res" data-res="${k}"><b>${RES_ICON[k]}${Math.floor(g.res[k])}</b>${cap}<i class="${cls}">${net >= 0 ? '+' : ''}${net.toFixed(1)}</i></span>`;
}

// chip renders one collapsible category chip: a collapsed head (icon + the
// sum of its members, floored) and a hover/pin-revealed expand panel listing
// each member's own icon/count/rate.
export function chip(cat, headHTML, expandHTML) {
  const pinned = S.ui.pinned.has(cat) ? ' pinned' : '';
  return `<div class="chip${pinned}" data-cat="${cat}">
    <div class="chip-head"><b>${headHTML}</b></div>
    <div class="chip-expand">${expandHTML}</div>
  </div>`;
}

export function updateHUD() {
  const g = S.game, rate = g.rates();
  const catChips = Object.entries(CATEGORIES).map(([cat, members]) => {
    const total = members.reduce((a, m) => a + Math.floor(g.res[m]), 0);
    return chip(cat, `${icon(CAT_ICON[cat])}${total}`, members.map((m) => resRow(g, rate, m)).join(''));
  }).join('');

  // Pop: population as a resource. Expand folds in the Folk legend (per-role
  // counts, formerly its own bottom-right panel — retired so it doesn't
  // double-render) plus a derived defense footer (the old standalone defense
  // chip lives here now, since defense is a property of your folk, not a
  // tradeable good).
  const counts = {};
  for (const v of S.villagers) counts[v.role] = (counts[v.role] || 0) + 1;
  const folk = Object.entries(ROLE_LABEL).map(([r, label]) => {
    const hex = '#' + ROLE_PIP[r].toString(16).padStart(6, '0');
    return `<div class="lg"><span class="dot" style="background:${hex}"></span>${label}<b>${counts[r] || 0}</b></div>`;
  }).join('');
  // Housing: what raises the people cap (base hearth + tier, then longhouses),
  // so the folk cap is legible right under the Pop count.
  const hb = g.popCapBreakdown();
  const hbDetail = hb.contributors.map((c) => `${c.name} ×${c.count} +${c.add}`).join(' · ');
  const houseFoot = `<div class="chip-foot"><span>${icon('pop', 'sm')} housing cap</span><b>${hb.total}</b></div>`
    + `<div class="chip-cap">base ${hb.base}${hb.contributors.length ? ' · ' + hbDetail : ''} → ${hb.total}</div>`;
  const defFoot = `<div class="chip-foot"><span>${icon('defense', 'sm')} defense</span><b>${g.defense()}</b></div>`;
  // Troop capacity (barracks + tower-linked fort walls) vs soldiers mustered.
  const troopFoot = `<div class="chip-foot"><span>${icon('defense', 'sm')} troops</span><b>${counts[ROLE.SOLDIER] || 0}/${troopCap()}</b></div>`;
  // Food the folk eat each second (pop × appetite) — drawn perishable-first from
  // the larder, so it's easy to miss on the per-food rows; surface the total here.
  const foodFoot = `<div class="chip-foot"><span>${icon('food', 'sm')} folk eat</span><b class="down">−${g.foodEatPerS().toFixed(1)}/s</b></div>`;
  const popChip = chip('pop', `${icon(CAT_ICON.pop)}${Math.floor(g.pop)}/${g.popCap()}`, folk + foodFoot + houseFoot + defFoot + troopFoot);

  // Faith: a meter toward the Will's next invocation, not a tradeable good —
  // its own chip (not under Pop) because the speaker COUNT that fills it is
  // shown here, while the speaker ROLE is separately listed under Pop; a
  // speaker is both a person and the source of faith.
  const faithLines = resourceBreakdown('faith');
  const faithRows = faithLines.map((l) =>
    `<div class="chip-row"><span>${l.label}</span><b class="${l.val >= 0 ? 'up' : 'down'}">${l.val >= 0 ? '+' : ''}${l.val.toFixed(1)}</b></div>`
  ).join('');
  const faithFoot = `<div class="chip-foot"><span>threshold</span><b>${Math.floor(g.faith)}/${g.faithThreshold()}</b></div>`;
  const faithChip = chip('faith', `${icon(CAT_ICON.faith)}${Math.floor(g.faith)}/${g.faithThreshold()}`, faithRows + faithFoot);

  document.getElementById('resstrip').innerHTML = catChips + popChip + faithChip;
}

// initChipToggle: clicking a chip's collapsed head pins it open (toggle);
// hover-preview (CSS-only, see .chip:hover in town.css) keeps working
// regardless of pin state. #resstrip's innerHTML is fully rebuilt every
// tick, so pinned state lives in S.ui.pinned, not on the DOM nodes.
export function initChipToggle() {
  const bar = document.getElementById('resstrip');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const head = e.target.closest && e.target.closest('.chip-head');
    if (!head) return;
    const cat = head.closest('.chip').dataset.cat;
    if (S.ui.pinned.has(cat)) S.ui.pinned.delete(cat); else S.ui.pinned.add(cat);
    updateHUD();
  });
}

// resourceBreakdown lists what each work adds/eats for one resource per second.
export function resourceBreakdown(k) {
  const g = S.game, eff = g.efficiency(), lines = [];
  if (k === 'faith') {
    // Faith has one source: the hold's speakers (one base, +1/reliquary).
    const n = g.speakers();
    lines.push({ label: `${n} speaker${n === 1 ? '' : 's'} → faith`, val: n * CFG.faithPerSpeaker });
    return lines;
  }
  // Food categories: grown by specific crops (or fished), eaten perishable-first,
  // spoiled per-category — none of it is a plain building→res line, so list the
  // crops feeding this category (or the wharf), then the eat + spoilage draws.
  if (FOOD[k]) {
    const rt = g.rates();
    if (k === 'fish') {
      const wl = g.level('wharf');
      if (wl && rt.fish > 0.001) lines.push({ label: `Fishing Wharf ×${wl}`, val: rt.fish });
    } else if (rt[k] > 0.001) {
      const crops = [...new Set(g.farmPlots.filter((p) => { const c = CROP_BY_ID[p.crop]; return c && c.cat === k; }).map((p) => CROP_BY_ID[p.crop].name))];
      lines.push({ label: crops.length ? crops.join(', ') : 'farmsteads', val: rt[k] });
    }
    const eat = g.eatByCat && g.eatByCat[k] || 0; if (eat > 0.001) lines.push({ label: 'folk eat', val: -eat });
    const sp = g.spoilByCat && g.spoilByCat[k] || 0; if (sp > 0.001) lines.push({ label: `spoilage (${S.hold.tempBand})`, val: -sp });
    return lines;
  }
  for (const b of BUILDINGS) {
    if (b.kind !== 'prod' || b.res !== k) continue;
    const lv = g.level(b.id); if (!lv) continue;
    const out = b.base * lv * (0.35 + 0.65 * g.richOf(b)) * eff * g.bon.mul[k];
    if (out > 0.001) lines.push({ label: `${BUILD_NAME[b.id] || b.id} ×${lv}`, val: out });
  }
  // Salt spent preserving food shows as a draw on the salt breakdown, so the
  // spoilage loop is legible from both sides.
  if (k === 'salt' && (g.spoilSaltLast || 0) > 0.001) lines.push({ label: 'preserving food', val: -g.spoilSaltLast });
  return lines;
}

// storeTip renders a resource's storage line(s) for #restip: current/max,
// plus which storage building(s) contribute to that max and how much — the
// same capBreakdown() that backs caps(), so these numbers can't disagree.
// Coin has no cap; a resource with no storage contributors yet just reads
// "base N → N" (capBreakdown returns an empty contributors list for it).
export function storeTip(k) {
  const g = S.game;
  if (k === 'coin') return `<div class="bl cap"><span>stores</span><b>uncapped</b></div>`;
  const { base, contributors, total } = g.capBreakdown(k);
  const parts = contributors.map((c) => `${c.name} ×${c.count} +${Math.round(c.add)}`);
  const breakdown = [`base ${Math.round(base)}`, ...parts].join(' · ') + ` → ${Math.round(total)}`;
  return `<div class="bl cap"><span>stores</span><b>${Math.floor(g.res[k])} / ${Math.round(total)}</b></div>`
       + `<div class="dim cap-detail">${breakdown}</div>`;
}

// initResTip shows an income/consumption breakdown, plus a storage-capacity
// breakdown, when a resource is hovered.
export function initResTip() {
  const bar = document.getElementById('resstrip'), tip = document.getElementById('restip');
  if (!bar || !tip) return;
  bar.addEventListener('mousemove', (e) => {
    const el = e.target.closest && e.target.closest('.res');
    if (!el || !el.dataset.res) { tip.style.display = 'none'; return; }
    const k = el.dataset.res, lines = resourceBreakdown(k);
    const net = lines.reduce((a, l) => a + l.val, 0);
    const rows = lines.length
      ? lines.map((l) => `<div class="bl"><span>${l.label}</span><b class="${l.val >= 0 ? 'up' : 'down'}">${l.val >= 0 ? '+' : ''}${l.val.toFixed(2)}</b></div>`).join('')
      : '<div class="dim">no works yet</div>';
    // Faith's footer shows progress toward the invocation threshold instead
    // of a net rate — that's the number that actually matters here. Faith
    // also has no store (not a res[] entry), so it skips the storage line.
    const footer = k === 'faith'
      ? `<div class="bl net"><span>threshold</span><b>${Math.floor(S.game.faith)} / ${S.game.faithThreshold()}</b></div>`
      : `<div class="bl net"><span>net</span><b class="${net >= 0 ? 'up' : 'down'}">${net >= 0 ? '+' : ''}${net.toFixed(2)}/s</b></div>`;
    const storage = k === 'faith' ? '' : storeTip(k);
    tip.innerHTML = `<div class="ttl">${RES_ICON[k]} ${k}</div>${rows}${footer}${storage}`;
    tip.style.display = 'block'; tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px';
  });
  bar.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

// ---- order log --------------------------------------------------------
// (the Folk legend used to be its own bottom-right panel here; it's now
// rendered inline inside the Pop chip's expand — see updateHUD.)

export function orderText(o) {
  if (o.type === ORDER.BUILD) return `build ${o.target}${o.qty > 1 ? ' ×' + o.qty : ''}`;
  if (o.type === ORDER.EXPAND) return 'expand a field';
  if (o.type === ORDER.WALL) return o.from && o.to ? `raise a wall${o.gate ? ' + gate' : ''}` : 'open a gate';
  if (o.type === ORDER.TRADE) return `${o.action} ${o.qty || ''} ${o.resource}`.replace(/\s+/g, ' ').trim();
  if (o.type === ORDER.FOCUS) return `focus ${o.value || o.target}`;
  return o.type;
}
const orderIcon = (o) => o.type === ORDER.BUILD ? '🔨' : o.type === ORDER.WALL ? '🧱' : o.type === ORDER.EXPAND ? '🌱' : o.type === ORDER.TRADE ? (o.action === TRADE_ACT.SELL ? '💰' : '🛒') : '🎯';

export function orderEntryHTML(o) {
  const t = `${orderIcon(o)} ${orderText(o)}`;
  const tip = (o.reason || '').replace(/"/g, '');
  if (o.status === 'done') return `<div class="ord done" title="${tip}">✓ ${t}</div>`;
  if (o.status === 'skipped') return `<div class="ord skipped" title="${tip}">✕ ${t} <small>(couldn’t)</small></div>`;
  if (o.status === 'active') {
    const pct = Math.min(100, Math.round(o.progress * 100));
    const left = o.qtyLeft > 1 ? ` <small>(${o.qtyLeft} left)</small>` : '';
    return `<div class="ord active" title="${tip}">${t}${left}<div class="pbar"><i style="width:${pct}%"></i></div></div>`;
  }
  return `<div class="ord pending" title="${tip}">· ${t}</div>`;
}

export function renderOrders() {
  if (!S.ui.orders) return;
  const rows = S.orderLog.length
    ? S.orderLog.slice(-8).map(orderEntryHTML).join('')
    : '<div class="dim">— the folk work freely —</div>';
  S.ui.orders.set(rows);
}

// renderWillPanel draws the whole left column as ONE divine surface: the panel
// is titled by the aspect (the Salt/Current/Deep…), shows the Will's utterance,
// a COMPACT row per speaker (name · directive + order chips — the chips carry
// the interpretation, so no separate gloss line), then a slim log of town
// events. Utterance + speaker words live ONLY here now (not echoed elsewhere).
export function renderWillPanel() {
  if (!S.ui.speakers) return;
  S.ui.speakers.setTitle(S.mask.aspect || 'the Will');
  const lw = S.lastWill;
  const utt = lw && lw.utterance
    ? `<div class="sp-utt">${icon('faith', 'sm')} ${lw.utterance}</div>` : '';
  const speakers = (lw && lw.speakers && lw.speakers.length)
    ? lw.speakers.map((sp) => `
      <div class="sp-block">
        <div class="sp-head"><span class="sp-name">${sp.name || 'a speaker'}</span> <span class="sp-directive">· “${sp.directive || ''}”</span></div>
        <div class="sp-orders">${sp.orders.length
          ? sp.orders.map((o) => `<span class="ordchip">${orderIcon(o)} ${orderText(o)}</span>`).join('')
          : '<span class="dim">no work bidden</span>'}</div>
      </div>`).join('')
    : '<div class="dim">The speakers await a word.</div>';
  const events = (S.chronicle || []).slice(0, 4).map((c) => `<div class="cl ${c.kind}">${c.text}</div>`).join('');
  const log = events ? `<div class="will-log">${events}</div>` : '';
  const status = S.willStatus ? `<div class="will-status">${S.willStatus}</div>` : '';
  S.ui.speakers.set(utt + speakers + log + status);
}

const willPopoutTitle = () => `${S.mask.aspect || 'the Will'} — the god's doings`;

// openWillDetail — the left panel's click target. Rebuilds the popout's
// content fresh every time it opens (per the "live-ish" contract: a stale
// render would show doings that no longer match S.willHistory/chronicle).
export function openWillDetail() {
  if (!S.ui.willPopout) return;
  S.ui.willPopout.setTitle(willPopoutTitle());
  S.ui.willPopout.open(renderWillDetail());
}

// renderWillDetail — the popout's full accounting: every kept invocation
// (S.willHistory, newest first), each with the FULL speaker breakdown the
// compact panel trims (parish, the heard directive, the interpretation
// 'word', and every order chip — not just a few), then the WHOLE running
// chronicle (not the compact panel's last-4 slice). Long enough to scroll.
export function renderWillDetail() {
  const hist = S.willHistory.length ? S.willHistory
    : (S.lastWill ? [{ ...S.lastWill, at: Date.now() }] : []);
  const invs = hist.length ? hist.map((inv) => `
    <div class="wd-inv">
      <div class="wd-time dim">${new Date(inv.at).toLocaleTimeString()}</div>
      ${inv.utterance ? `<div class="sp-utt">${icon('faith', 'sm')} ${inv.utterance}</div>` : ''}
      ${(inv.speakers && inv.speakers.length) ? inv.speakers.map((sp) => `
        <div class="sp-block">
          <div class="sp-head"><span class="sp-name">${sp.name || 'a speaker'}</span> <span class="dim">· ${sp.parish || 'no parish'}</span></div>
          <div class="sp-directive">heard: “${sp.directive || ''}”</div>
          ${sp.word ? `<div class="wd-word">${sp.word}</div>` : ''}
          <div class="sp-orders">${sp.orders.length
            ? sp.orders.map((o) => `<span class="ordchip">${orderIcon(o)} ${orderText(o)}</span>`).join('')
            : '<span class="dim">no work bidden</span>'}</div>
        </div>`).join('') : '<div class="dim">The speakers kept silence.</div>'}
    </div>`).join('') : '<div class="dim">The Will has not yet spoken.</div>';
  const chron = S.chronicle.length
    ? S.chronicle.map((c) => `<div class="cl ${c.kind}">${c.text}</div>`).join('')
    : '<div class="dim">Nothing chronicled yet.</div>';
  return `${invs}<div class="wd-chron-t">The Chronicle</div><div class="will-log">${chron}</div>`;
}

export function pushChronicle(text, kind) {
  S.chronicle.unshift({ text, kind });
  if (S.chronicle.length > 30) S.chronicle.pop();
  renderWillPanel();   // the event log lives inside the unified Will panel now
}
export function setStewardLine(t) { S.willStatus = t; renderWillPanel(); }
