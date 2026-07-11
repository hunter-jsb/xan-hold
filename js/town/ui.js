// ui.js — a tiny panel system for the town HUD. A panel is a consistent
// styled card that stacks inside a positioned region (top-right,
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
