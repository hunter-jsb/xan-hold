(function(){
// map.js — paints the generated continent onto a canvas for the founding
// screen and lets the player pick a seat to settle. Pure read of the
// snapshot; terrain colors echo the sim's own palette in spirit.

const { W, GW, GH, idx, REG } = window.XAN;

// Terrain color per region id — a legible, muted continent.
function terrainColor(reg, elev, temp) {
  switch (reg) {
    case REG.BRINE: case REG.EASTSEA: return '#1c3a52';
    case REG.DROWNED: return '#274b63';
    case REG.LAKE: return '#2f6a8f';
    case REG.GLACIER: return '#dbe7ef';
    case REG.TUNDRA: return '#8a9a86';
    case REG.MARSH: return '#4a5f43';
    case REG.FOREST: return '#2f5233';
    case REG.CRADLE: case REG.DOAB: return '#6f7d3e';
    case REG.AGRARIA: case REG.AGRUPLAND: return '#8a8a4a';
    case REG.FOOTHILL: return '#7a6a4d';
    case REG.CLIFF: return '#6b5d4a';
    case REG.MOUNTAIN: return '#8d8578';
    case REG.PLATEAU: return '#9a8f6d';
    case REG.VOLCANO: return '#5a2b28';
    case REG.LAVA: return '#7a3320';
    case REG.PASS: return '#7d7358';
    case REG.DEN: case REG.NEST: case REG.ROOKERY: return '#5a2f3a';
    default: return reg ? '#555' : '#0d1014';
  }
}

// paintTerrain renders the base map into an offscreen buffer at grid scale
// then draws it up to the display canvas at an integer pixel scale.
function makeTerrainBitmap() {
  const buf = document.createElement('canvas');
  buf.width = GW; buf.height = GH;
  const bx = buf.getContext('2d');
  const img = bx.createImageData(GW, GH);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const i = idx(x, y);
      const reg = W.region[i];
      const c = hexToRgb(terrainColor(reg, W.elev[i], W.temp[i]));
      // Fake relief: nudge brightness by elevation so ranges read.
      const e = reg && reg !== REG.BRINE ? Math.max(-0.25, Math.min(0.25, (W.elev[i] || 0) / 4000)) : 0;
      const o = i * 4;
      img.data[o] = clamp8(c.r * (1 + e));
      img.data[o + 1] = clamp8(c.g * (1 + e));
      img.data[o + 2] = clamp8(c.b * (1 + e));
      img.data[o + 3] = 255;
    }
  }
  bx.putImageData(img, 0, 0);
  return buf;
}

let terrainBmp = null;

// drawMap paints the continent + every seat, highlighting the hovered one.
// Returns the transform so hit-testing can map clicks back to grid cells.
function drawMap(canvas, holds, hoverId, chosenId) {
  if (!terrainBmp) terrainBmp = makeTerrainBitmap();
  const ctx = canvas.getContext('2d');
  const scale = Math.max(1, Math.floor(Math.min(canvas.width / GW, canvas.height / GH)));
  const ox = Math.floor((canvas.width - GW * scale) / 2);
  const oy = Math.floor((canvas.height - GH * scale) / 2);

  ctx.fillStyle = '#0d1014';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(terrainBmp, ox, oy, GW * scale, GH * scale);

  for (const h of holds) {
    const px = ox + (h.x + 0.5) * scale;
    const py = oy + (h.y + 0.5) * scale;
    const hovered = h.id === hoverId;
    const chosen = h.id === chosenId;
    const r = chosen ? 7 : hovered ? 6 : 4;
    // danger tints the dot toward red.
    const g = Math.round(200 - h.danger * 150);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = chosen ? '#ffd479' : `rgb(240,${g},${Math.round(g * 0.7)})`;
    ctx.globalAlpha = hovered || chosen ? 1 : 0.9;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (hovered || chosen) {
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 3;
      const label = `${h.name}`;
      ctx.strokeText(label, px + 9, py + 4);
      ctx.fillText(label, px + 9, py + 4);
    }
  }
  return { scale, ox, oy };
}

// hitTest returns the nearest hold within grab radius of a canvas point.
function hitTest(holds, xf, mx, my, grab = 10) {
  let best = null, bestD = grab * grab;
  for (const h of holds) {
    const px = xf.ox + (h.x + 0.5) * xf.scale;
    const py = xf.oy + (h.y + 0.5) * xf.scale;
    const d = (px - mx) ** 2 + (py - my) ** 2;
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
function clamp8(v) { return Math.max(0, Math.min(255, Math.round(v))); }

window.XANMAP = { drawMap, hitTest };
})();
