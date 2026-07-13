// state.js — the shared mutable `S` (imported everywhere) + the held-keys set.
// Pixi layers hang off S so boot can fill them and every module reaches them.
import { CENTER_TX, CENTER_TY } from './constants.js';

export const S = {
  // Pixi layers (set in boot): world=camera, ground=flat tiles, entities=y-sorted sprites, night/alarmFx=tint overlays.
  app: null, world: null, ground: null, entities: null, night: null, alarmFx: null,

  hold: null, game: null, atlas: null,
  placed: new Map(),   // typeKey -> {container} — reserved the moment a site starts, not just when it finishes
  sites: [],           // construction sites in progress: {key,type,recipe,container,x,y,scaffold,progress,builders,done} — see startSite/finalizeSite
  siteKeys: new Set(), // S.placed keys an unfinished site still holds (blocks reconcileBuildings' own placement, and excludes them as e.g. a spawn home)
  villagers: [], plots: [], usedPlots: new Set(),
  oreFieldPlots: new Set(), // plot cells the ore field occupies — the plot allocators only (nextCorePlot/nextOuterPlot/nextFarmPlot), not the wall/wander, which read usedPlots
  waterPlots: new Set(), // plot cells water (or a claimed wharf shore tile) occupies — the plot allocators only, mirrors oreFieldPlots
  oreFieldCenter: null, // {x,y} px — set by placeOreNodes; read by outerBias (quarry) + farmlandAnchor
  farmAnchor: null, // {px,py} plot coords — the farmland district's centre, set once by farmlandAnchor
  farmDistrict: null, // the ONE Container every farm tile sprite lives in — see renderFarmDistrict
  farmTiles: new Map(), // "tx,ty" -> Sprite, so a re-render retextures in place instead of rebuilding
  orderLog: [], focus: null, chronicle: [],
  stewardBusy: false, lastRaidTally: 0, alarm: 0,
  raiders: [], // live raid-wave enemies (raids.js) — path to the core, fought by soldiers
  parishSizes: [], // folk per speaker (villagers.js assignFealty) — the head speaker's split
  hudOn: true, ui: { pinned: new Set() }, // ui.pinned: category keys clicked open (see chip() in updateHUD)
  cam: { x: CENTER_TX, y: CENTER_TY }, camAuto: true, lastInput: 0,
  hittable: [], // building bounds for hover-identify
  // Real, planned walls: a set of wall tiles (impassable) and gate tiles
  // (passable openings), keyed "x,y" — grown by wall ORDERS (see the 'wall'
  // case in advanceOrder), never an auto-fitted bounding-box ring.
  walls: new Set(), gates: new Set(),
  wallKind: new Map(),  // "x,y" -> 'fence'|'wood'|'stone' (walls rework); a missing tile = legacy fence
  towers: new Set(),    // "x,y" tiles holding a watchtower — the anchors wood/stone walls span between
  towerSprites: [],
  wallSprites: [], wallsVersion: 0, wallsRendered: -1, wallsPruned: false, // wallsPruned: one-time scrub of pre-wallBlocked saves (see renderWalls)
  wallEdgesBuilt: new Set(), // which section sides are planned, keyed `${section}:${side}` (see planSectionWall)
  sectionTier: {},           // section -> wall tier: 1 fence, 2 wood, 3 stone (a walled section's "level")
  sectionBox: {},            // section -> {x0,y0,x1,y1} its ring was laid at (locked once, so upgrades re-lay in place)
  oreNodes: [], woodNodes: [], // resource nodes the folk walk out to work
  // Impassable water (see findPath, which blocks S.water exactly like S.walls)
  // and its shoreline: land tiles touching water, nearest-town first, that
  // nextWharfSite claims for new Fishing Wharfs. See placeWater.
  water: new Set(), shoreSites: [],
  mask: { aspect: 'the Will', speakers: 'Speakers' }, // the god's local face, set from tier at boot
  lastWill: null, // last invocation: {utterance, aspect, speakers:[{name,parish,directive,word,orders}]} — powers the left Speakers panel
  willHistory: [], // rolling log of invocations (newest first, cap 12): powers the click-through popout's "story so far"
  // Hover-highlight state (seed of the jobs system's assignment viz — see
  // resolveHome/startHaul for v.home/v.haulTarget): the hittable currently
  // hovered, its outline, and the ring per assigned villager it's showing.
  hoverBuilding: null, hoverGfx: null, highlightRings: new Map(), highlightAt: 0,
};

export const heldKeys = new Set(); // WASD currently pressed

// isRaided — is a raid in progress since the HUD last looked? (soldier behaviour,
// steward defense priority, alarm flash all read this.)
export function isRaided() { return (S.game.raidTally || 0) > S.lastRaidTally; }
