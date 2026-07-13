// ui.js — a tiny panel + popout system for the town HUD. A panel is a
// consistent styled card that stacks inside a positioned region (top-right,
// bottom-right, …), so every new HUD piece — orders, legend, and whatever
// we add next — shares one look and layout. Expand by calling makePanel.
export function makePanel({ region, title }) {
  const host = document.getElementById('region-' + region);
  const el = document.createElement('div');
  el.className = 'panel';
  const t = document.createElement('div'); t.className = 'panel-t'; t.textContent = title;
  const b = document.createElement('div'); b.className = 'panel-b';
  el.append(t, b);
  host.appendChild(el);
  return {
    el,
    set: (html) => { b.innerHTML = html; },
    setTitle: (s) => { t.textContent = s; },
    show: (v) => { el.style.display = v ? '' : 'none'; },
  };
}

// makePopout — a reusable "click for the full story" layer: a dimmed
// full-screen backdrop behind a centred, title-barred card with a scrolling
// body. Generic (title + arbitrary HTML) so any HUD panel can grow a detail
// view without inventing its own backdrop/Esc/scroll plumbing — modeled on
// #stewardask for the backdrop/pointer-events pattern, but self-contained:
// it builds its own DOM and appends to <body>, so callers need no markup.
// Only one popout is expected on screen at a time (not enforced here).
export function makePopout({ title }) {
  const bg = document.createElement('div'); bg.className = 'popout-bg';
  const card = document.createElement('div'); card.className = 'popout';
  const bar = document.createElement('div'); bar.className = 'popout-bar';
  const t = document.createElement('div'); t.className = 'popout-t'; t.textContent = title || '';
  const x = document.createElement('button'); x.className = 'popout-x'; x.type = 'button';
  x.textContent = '✕'; x.setAttribute('aria-label', 'close');
  bar.append(t, x);
  const b = document.createElement('div'); b.className = 'popout-b';
  card.append(bar, b);
  bg.appendChild(card);
  bg.style.display = 'none'; // closed until open() — don't rely on CSS load order
  document.body.appendChild(bg);

  const close = () => { bg.style.display = 'none'; };
  const isOpen = () => bg.style.display !== 'none';
  x.addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); }); // backdrop only, not the card
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });

  return {
    open: (html) => { if (html != null) b.innerHTML = html; bg.style.display = 'flex'; },
    close,
    setTitle: (s) => { t.textContent = s; },
    setContent: (html) => { b.innerHTML = html; },
    isOpen,
    body: b, // exposes the scrolling body node so callers can delegate clicks (e.g. filter chips)
  };
}
