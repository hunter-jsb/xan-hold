// coords.js — the coordinate kernel. TILES are the gameplay grid; pixel is a
// derived view (tilePx); plot is the coarse placement grid (being retired).
import { TILE } from './atlas.js';
import { PLOT, TOWN_W, TOWN_H } from './constants.js';

export const tilePx = (t) => t * TILE;                        // tile -> pixel
export const pxToTile = (x) => Math.floor(x / TILE);          // pixel -> tile
export const plotToTile = (p) => p * PLOT;                    // plot -> tile (its top-left)
export const pxToPlot = (x) => Math.floor(x / (PLOT * TILE)); // pixel -> plot
export const plotCenterPx = (px, py) => ({ x: (px * PLOT + PLOT / 2) * TILE, y: (py * PLOT + PLOT / 2) * TILE });

// "x,y" tile key for the wall/water/farm tile sets, and clamps that keep any
// authored coordinate on the board.
export const wallKey = (x, y) => `${x},${y}`;
export const clampX = (x) => Math.max(0, Math.min(TOWN_W - 1, Math.round(x)));
export const clampY = (y) => Math.max(0, Math.min(TOWN_H - 1, Math.round(y)));

// 4-cardinal neighbour offsets, for grid BFS / tile scans.
export const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// A tiny deterministic PRNG (LCG) — same seed, same town, every load.
export function rng(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
