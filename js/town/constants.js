// constants.js — shared config + the named enums (ROLE, ORDER, DIR, FOCUS,
// TRADE_ACT) that replace the old magic string literals.
const { CFG } = window.XANGAME;

// ---- grid ------------------------------------------------------------
export const PLOT = 4;                 // a building plot is 4x4 tiles (roomy — no crowding)
export const TOWN_W = 96, TOWN_H = 72; // a big wilderness map the camera drifts across
export const PLOTS_X = Math.floor(TOWN_W / PLOT), PLOTS_Y = Math.floor(TOWN_H / PLOT);
// ONE gameplay grid: TILES. The keep is placed dead on CENTER, so walls, camera,
// ore field, water, and the core zone can never disagree about where town is.
export const CENTER_TX = TOWN_W / 2, CENTER_TY = TOWN_H / 2;         // town centre, in tiles
export const CENTER_PX = (PLOTS_X - 1) / 2, CENTER_PY = (PLOTS_Y - 1) / 2; // …and in plot units

// ---- timing / limits -------------------------------------------------
export const DAY_MS = CFG.dayMs;       // full day/night in real ms — shared with game.js (spoilage reads the same clock)
export const STEWARD_MS = Number(localStorage.getItem('xh_stewardMs') || 1800000); // ambient decree backstop (30 min); faith is the primary trigger
export const LOCAL_MS = 6000;          // heuristic steward cadence
export const MAX_PER_TYPE = 8;         // how many of one building we draw
export const MAX_ACTIVE = 3;           // orders advanced in parallel (several work crews)
export const BUILD_RATE = 1 / 15;      // one builder's share of a site's progress per second (~15s solo)
export const SITE_ALPHA = 0.15;        // a fresh site's starting alpha, before any progress

// ---- villager roles --------------------------------------------------
export const ROLE = {
  VILLAGER: 'villager', FARMER: 'farmer', WOODCUTTER: 'woodcutter', MINER: 'miner',
  SOLDIER: 'soldier', TRADER: 'trader', SPEAKER: 'speaker', BUILDER: 'builder',
};
export const ROLE_TINT = {
  [ROLE.VILLAGER]: 0xffffff, [ROLE.FARMER]: 0xcfe8a0, [ROLE.WOODCUTTER]: 0xbfe0b8,
  [ROLE.MINER]: 0xcfcfe0, [ROLE.SOLDIER]: 0x9fb8ea, [ROLE.TRADER]: 0xffdf9a,
  [ROLE.SPEAKER]: 0xf3e4c0, [ROLE.BUILDER]: 0xe0b98a,
};
// A saturated pip above the head — the readable role signal (a multiply tint on
// a brown sprite can't say "blue soldier" clearly; a pip can).
export const ROLE_PIP = {
  [ROLE.VILLAGER]: 0xe6dcc4, [ROLE.FARMER]: 0x74c53a, [ROLE.WOODCUTTER]: 0x2f8f4e,
  [ROLE.MINER]: 0xc9ced6, [ROLE.SOLDIER]: 0x4f86e0, [ROLE.TRADER]: 0xf2c14e,
  [ROLE.SPEAKER]: 0xffdf6a, [ROLE.BUILDER]: 0xd97b3f,
};
// Speaker's label is overwritten with the hold's aspect at boot (Saltspeaker…).
export const ROLE_LABEL = {
  [ROLE.VILLAGER]: 'Villager', [ROLE.FARMER]: 'Farmer', [ROLE.WOODCUTTER]: 'Woodcutter',
  [ROLE.MINER]: 'Miner', [ROLE.SOLDIER]: 'Soldier', [ROLE.TRADER]: 'Trader',
  [ROLE.SPEAKER]: 'Speaker', [ROLE.BUILDER]: 'Builder',
};

// ---- orders ----------------------------------------------------------
export const ORDER = { BUILD: 'build', WALL: 'wall', TRADE: 'trade', FOCUS: 'focus', EXPAND: 'expand' };
export const TRADE_ACT = { BUY: 'buy', SELL: 'sell' };
// Seconds of work one unit of each order takes — decrees are carried out over
// time, not the instant they land. ORDER.BUILD no longer reads its entry (a real
// building takes as long as its construction SITE); kept for farm/palisade.
export const WORK_S = { [ORDER.BUILD]: 5, [ORDER.TRADE]: 2.5, [ORDER.FOCUS]: 1, [ORDER.EXPAND]: 5, [ORDER.WALL]: 5 };

// ---- focuses (a speaker/steward priority that isn't a building id) ---
export const FOCUS = { FOOD: 'food', DEFENSE: 'defense' };

// ---- walk directions -------------------------------------------------
export const DIR = { DOWN: 'down', UP: 'up', LEFT: 'left', RIGHT: 'right' };
export const DIRS = [DIR.DOWN, DIR.UP, DIR.LEFT, DIR.RIGHT];

// ---- hover-highlight tints ------------------------------------------
export const HIGHLIGHT_COLOR = { perma: 0xffd23a, temp: 0x38d6ff }; // gold = home, cyan = in transit

// ---- display names ---------------------------------------------------
export const BUILD_NAME = {
  farm: 'Farm', wharf: 'Fishing Wharf', sawmill: 'Sawmill', quarry: 'Quarry',
  mine: 'Mine', saltern: 'Saltern', market: 'Market', longhouse: 'Longhouse',
  granary: 'Storehouse', reliquary: 'Reliquary',
};
