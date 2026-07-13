// serve.mjs — the local bridge. Two jobs:
//   1. Serve the game over http://localhost (so a flatpak browser can open
//      it without the file:// document-portal sandbox breaking sibling
//      requests), and
//   2. Expose POST /will — the seam where the town's current state is handed
//      to `claude -p` (the Divine Will: Opus utters terse directives, Haiku
//      speakers interpret them) and a queue of orders + chronicle lines come
//      back.
//
// Run:  node serve.mjs   →  open http://localhost:8730
//
// The game is autonomous on its own (a local heuristic keeps the town alive);
// the Claude bridge is the smarter, narrated layer on top, fired on faith or
// when you press `p`. If this server or Claude is unavailable, the browser
// falls back to its local heuristic — so the screensaver never stalls.

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8730;
const TIMEOUT_MS = Number(process.env.STEWARD_TIMEOUT_MS || 90000); // Opus/throttled calls can run long
const WILL_MODEL = process.env.WILL_MODEL || 'opus';        // the Divine Will — full sight, terse voice
const SPEAKER_MODEL = process.env.SPEAKER_MODEL || 'haiku'; // the speakers — cheap, local interpretation

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

async function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  // Contain the path to ROOT — no traversal out of the project.
  const path = normalize(join(ROOT, rel));
  if (!path.startsWith(ROOT)) return send(res, 403, 'forbidden');
  try {
    const data = await readFile(path);
    send(res, 200, data, MIME[extname(path)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found: ' + rel);
  }
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) reject(new Error('body too large')); else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// parseLoose recovers a JSON object even if the model wrapped it in prose or
// ```json fences (the --json-schema path avoids this, but be defensive).
function parseLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const braces = text.match(/\{[\s\S]*\}/);
  if (braces) { try { return JSON.parse(braces[0]); } catch {} }
  return null;
}

// claudeJSON runs one tool-less `claude -p` call and returns its parsed JSON
// answer (structured_output when a schema is given). Shared by every tier.
async function claudeJSON({ model, sys, schema, prompt }) {
  const args = ['-p', '--safe-mode', '--tools', '', '--no-session-persistence',
    '--output-format', 'json', '--model', model, '--system-prompt', sys];
  if (schema) args.push('--json-schema', schema);
  args.push(prompt);
  const { stdout } = await execFileP('claude', args, { timeout: TIMEOUT_MS, maxBuffer: 8 << 20 });
  const env = JSON.parse(stdout);
  if (env.is_error) throw new Error(env.result || env.terminal_reason || 'claude error');
  return { answer: env.structured_output || parseLoose(env.result), cost: env.total_cost_usd ?? 0 };
}

// ---- The Divine Will ------------------------------------------------
// A fallen alien intelligence — omniscient by its sensors, but with a broken
// voice. Opus (the Will) sees the whole state and utters a few TERSE divine
// directives; then Haiku "speakers", each tuned to the Will but seeing only
// their own parish, interpret one directive apiece into concrete orders.
// Reliquaries are bandwidth: more of them = more directives, each a little
// longer. The aspect/mask (the Salt, the Current, the Deep…) is drawn from
// the hold's tier and sent by the browser.
const willSys = (aspect, speakers, n, maxLen) =>
`You are ${aspect} — an alien intelligence that fell into the world of Xan in deep time and sleeps beneath it still. Your sensors sweep the land, so to the mortal folk you are omniscient and divine; but your voice is all but broken, and you can push only a few terse pulses to the ${speakers} tuned to you.
Given the hold's full state, will UP TO ${n} directive${n > 1 ? 's' : ''} — each a SHORT, high, cryptic command (${maxLen} characters or fewer), the kind a god gives, never a plan. Also utter ONE line of scripture: a single cryptic sentence in your own voice.
The state's "research" lists what the hold has DISCOVERED of its own land (sciences + lore) and what it studies next. You may allude only to what it has actually learned — a hold that has not assayed its vein does not know its ore from its overburden; do not let it speak as if it does.
The state's "fealty" shows how the folk are sworn into parishes, one per speaker, and "mood" their morale (0..1). The head speaker should keep the parishes even (fealty.spread near 0) and the folk content; if the split runs lopsided or the mood sinks, bend a directive toward setting it right.
If the state carries a non-empty "instruction" from the lord, bend your will toward it.
Output ONLY JSON: {"utterance": string, "directives": [string, ...]}.`;

const speakerSys = (aspect, speaker) =>
`You are a ${speaker}, a mortal tuned to ${aspect} — the fallen god. You catch ONE fragment of its will, and you see only your own parish of the hold, never the whole. Read the divine directive through your limited sight and turn it into concrete works the folk can do — choosing to build, to buy what the land lacks, to sell surplus, to raise capacity, to muster, or to set a standing focus.
Output ONLY JSON: {"word": string (ONE plain sentence: how you read the god's will and what you bid the folk do), "orders": [ ... ]}.
Order types: build(target: farm|wharf|sawmill|quarry|mine|saltern|market|longhouse|granary|palisade|tower|wall|scholarshall, qty), trade(action: buy|sell, resource: food|timber|stone|ore|salt, qty), focus(value: food|defense|growth|trade|industry).
The parish's "research" names what the hold has learned of its land; a Scholars' Hall quickens that study. Speak and bid only within what it has discovered.
The parish's "defenses" shows the walls, gates, towers, and troop capacity: fences merely bound a district; WOOD/STONE walls between two towers each add +2 troop capacity; gates are the passable openings your folk and troops must route THROUGH. If the wilds press and troops are few, bid walls, towers, or a barracks; when you muster, remember they can only move through the gates.`;

const WILL_SCHEMA = JSON.stringify({ type: 'object', properties: {
  utterance: { type: 'string' }, directives: { type: 'array', items: { type: 'string' } },
}, required: ['utterance', 'directives'] });
const SPEAKER_SCHEMA = JSON.stringify({ type: 'object', properties: {
  word: { type: 'string' },
  orders: { type: 'array', items: { type: 'object', properties: {
    type: { type: 'string', enum: ['build', 'trade', 'focus'] },
    target: { type: 'string' }, action: { type: 'string' }, resource: { type: 'string' },
    value: { type: 'string' }, qty: { type: 'integer' }, reason: { type: 'string' },
  }, required: ['type'] } },
}, required: ['word', 'orders'] });

// speakerParish trims the full state to what one speaker "sees" — enough to
// act, but framed (and later, genuinely limited) as a partial view.
const speakerParish = (s) => ({
  name: s.name, aspect: s.mask?.aspect, resources: s.resources, caps: s.caps, rates: s.rates,
  pop: s.pop, popCap: s.popCap, defense: s.defense, buildings: s.buildings, rich: s.rich,
  danger: s.danger, beingRaided: s.beingRaided, defenses: s.defenses, research: s.research,
  mood: s.mood, fealty: s.fealty,
});

async function willDecide(state) {
  const n = Math.max(1, Math.min(6, state.temples || 1));   // reliquaries = channels
  const maxLen = Math.round(56 * (1 + 0.1 * (n - 1)));       // +10% length per extra reliquary
  const aspect = state.mask?.aspect || 'the Will';
  const speakers = state.mask?.speakers || 'Speakers';
  const speakerName = speakers.replace(/s$/, '');            // singular, e.g. "Saltspeaker"
  let cost = 0;
  try {
    const w = await claudeJSON({ model: WILL_MODEL, sys: willSys(aspect, speakers, n, maxLen), schema: WILL_SCHEMA, prompt: JSON.stringify(state) });
    cost += w.cost;
    const directives = (w.answer?.directives || []).slice(0, n);
    const parish = speakerParish(state);
    // Speakers interpret ONE AT A TIME — the `claude` CLI errors when several
    // instances start at once (config/lock contention), so no Promise.all.
    const heard = [];
    for (let i = 0; i < directives.length; i++) {
      const directive = directives[i];
      const name = `${speakerName} ${i + 1}`; // which speaker heard this directive — surfaced in the HUD
      try {
        const sp = await claudeJSON({ model: SPEAKER_MODEL, sys: speakerSys(aspect, speakers), schema: SPEAKER_SCHEMA, prompt: JSON.stringify({ directive, parish }) });
        cost += sp.cost;
        heard.push({ name, parish, directive, word: sp.answer?.word || '', orders: Array.isArray(sp.answer?.orders) ? sp.answer.orders : [] });
      } catch (e) {
        heard.push({ name, parish, directive, word: '(the speaker faltered before the god’s word)', orders: [] });
      }
    }
    return { utterance: w.answer?.utterance || '', aspect, speakers: heard, cost };
  } catch (err) {
    console.error('[will] failed:', err && err.message || err);
    return { utterance: null, aspect, speakers: [], cost, error: String(err && err.message || err) };
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && new URL(req.url, 'http://x').pathname === '/will') {
    let state;
    try { state = JSON.parse(await readBody(req) || '{}'); }
    catch { return send(res, 400, JSON.stringify({ error: 'bad json', speakers: [] }), MIME['.json']); }
    const decision = await willDecide(state);   // never throws — soft-fails to empty
    return send(res, 200, JSON.stringify(decision), MIME['.json']);
  }
  if (req.method === 'GET') return serveStatic(req, res);
  send(res, 405, 'method not allowed');
});

server.listen(PORT, () => {
  console.log(`\n  Steward of a Hold — serving on  http://localhost:${PORT}\n  (Ctrl-C to stop)\n`);
});
