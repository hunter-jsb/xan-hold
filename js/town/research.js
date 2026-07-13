// research.js — the town-side face of the hold's study of its own land. The
// mechanics (accrual, gating, live bonuses, persistence) live in game.js; here
// we only READ that state to feed the HUD (discoveredList/nextDiscovery) and the
// Divine Will's context (researchState), so the god can speak of what the hold
// has actually learned — never of what it hasn't.
import { S } from './state.js';

const { RESEARCH } = window.XANGAME;

// unlockText — a readable summary of a resolved effect object (what a discovery
// granted), formatted from the same numbers the live-read bonuses use.
export function unlockText(e) {
  const parts = [];
  if (e.mul) for (const [k, v] of Object.entries(e.mul)) parts.push(`${v >= 1 ? '+' : '−'}${Math.round(Math.abs(v - 1) * 100)}% ${k}`);
  if (e.def) parts.push(`+${e.def} defense`);
  if (e.pop) parts.push(`+${e.pop} folk cap`);
  if (e.foodEat && e.foodEat !== 1) parts.push(`${e.foodEat < 1 ? '−' : '+'}${Math.round(Math.abs(e.foodEat - 1) * 100)}% appetite`);
  if (e.spoilMul && e.spoilMul !== 1) parts.push(`${e.spoilMul < 1 ? '−' : '+'}${Math.round(Math.abs(e.spoilMul - 1) * 100)}% spoilage`);
  if (e.preserveAdd) parts.push(`+${Math.round(e.preserveAdd * 100)}% food preserved`);
  return parts.length ? parts.join(', ') : 'lore only — no boon';
}

// discoveredList — every discovery the hold has made, with its cited flavor and
// what it unlocked, newest first. Each: {id, name, cat, flavor, unlock}.
export function discoveredList() {
  const g = S.game;
  return g.research.done.slice().reverse().map((id) => {
    const d = window.XANGAME.RESEARCH_BY_ID[id];
    return d && { id: d.id, name: d.name, cat: d.cat, flavor: d.flavor(g.h, g.seatData), unlock: unlockText(g.effOf(d)) };
  }).filter(Boolean);
}

// nextDiscovery — what the hold is working toward now, or null if it has
// learned all its ground can teach. {name, cat, cost, insight}.
export function nextDiscovery() {
  const g = S.game, d = g.researchNext();
  return d ? { name: d.name, cat: d.cat, cost: d.cost, insight: g.research.insight } : null;
}

// researchState — the compact "what the god knows" summary for the Will/speaker
// context (see will.js). Only made discoveries; the sciences and lore apart.
export function researchState() {
  const g = S.game, done = g.doneDiscoveries();
  return {
    insight: Math.round(g.research.insight),
    scholars: g.researchers(),
    next: g.researchNext() ? g.researchNext().name : null,
    sciences: done.filter((d) => d.cat === 'science').map((d) => d.name),
    lore: done.filter((d) => d.cat === 'lore').map((d) => d.name),
  };
}

// how many discoveries exist at all — the HUD's "N/total" denominator.
export const RESEARCH_TOTAL = RESEARCH.length;
