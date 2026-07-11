// serve.mjs — the local bridge. Two jobs:
//   1. Serve the game over http://localhost (so a flatpak browser can open
//      it without the file:// document-portal sandbox breaking sibling
//      requests), and
//   2. Expose POST /steward — the seam where the town's current state is
//      handed to `claude -p` (the Steward: strategist + chronicler) and a
//      queue of high-level orders + an in-world chronicle line come back.
//
// Run:  node serve.mjs   →  open http://localhost:8730
//
// The game is autonomous on its own (a local heuristic steward keeps the
// town alive); the Claude bridge is the smarter, narrated layer on top,
// fired every few minutes or when you press `p`. If this server or Claude
// is unavailable, the browser falls back to its local steward — so the
// screensaver never stalls.

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8730;
const MODEL = process.env.STEWARD_MODEL || 'fable';      // 'fable' (poetic) | 'haiku' (cheapest)
const TIMEOUT_MS = Number(process.env.STEWARD_TIMEOUT_MS || 90000); // Opus/throttled calls can run long
const WILL_MODEL = process.env.WILL_MODEL || 'opus';        // the Divine Will — full sight, terse voice
const SPEAKER_MODEL = process.env.SPEAKER_MODEL || 'haiku'; // the speakers — cheap, local interpretation

// The Steward's brief and the strict shape of its answer. `--system-prompt`
// REPLACES Claude Code's default coding prompt, and `--safe-mode` strips the
// auto-loaded CLAUDE.md/memory — together they cut a ~22k-token call down to
// ~1k, so each decision is a fraction of a cent (and notional on a plan).
const SYS = `You are the Steward — the strategic mind and chronicler of one medieval hold in a cozy town-sim, in the world of Xan.
Given the hold's current state as JSON, decide a short queue of high-impact orders the townsfolk will carry out, and write ONE vivid in-world sentence for the town chronicle (warm, grounded, a little epic — you are the town's bard).
Prefer 1-4 orders. React to danger/raids, food, population caps, surpluses, and the hold's richest goods.
Order types:
- build: target one of farm|wharf|sawmill|quarry|mine|saltern|market|longhouse|granary|palisade, qty (how many levels).
- trade: action buy|sell, resource food|timber|stone|ore|salt, qty. (Needs a market. Sell surplus, buy what the land lacks.)
- focus: value food|defense|growth|trade|industry — a standing priority for the folk.
If the state carries a non-empty "instruction" from the lord, treat it as a priority directive: shape your orders to carry it out, and let the chronicle reflect the lord's command being heeded.
Output ONLY the JSON object.`;

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    orders: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['build', 'trade', 'focus'] },
          target: { type: 'string' }, action: { type: 'string' },
          resource: { type: 'string' }, value: { type: 'string' },
          qty: { type: 'integer' }, reason: { type: 'string' },
        },
        required: ['type'],
      },
    },
    chronicle: { type: 'string' },
  },
  required: ['orders', 'chronicle'],
});

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

// stewardDecide invokes `claude -p` as a pure, tool-less text generator and
// returns the parsed {orders, chronicle}. Flags (verified on CLI 2.1.207):
//   --safe-mode              strip CLAUDE.md/memory context (keeps OAuth auth)
//   --tools ""               no tools — pure generation, never touches disk
//   --no-session-persistence stateless, fresh each call
//   --output-format json     machine-parseable envelope
//   --json-schema            enforce our order/chronicle shape (-> structured_output)
//   --system-prompt          REPLACE the coding prompt with the Steward brief
// The town keeps running on its browser-side heuristic if this fails, so any
// error here is soft: we return empty orders and let the caller fall back.
async function stewardDecide(state) {
  const args = [
    '-p', '--safe-mode', '--tools', '', '--no-session-persistence',
    '--output-format', 'json', '--model', MODEL,
    '--system-prompt', SYS, '--json-schema', SCHEMA,
    JSON.stringify(state),
  ];
  try {
    const { stdout } = await execFileP('claude', args, { timeout: TIMEOUT_MS, maxBuffer: 8 << 20 });
    const env = JSON.parse(stdout);
    if (env.is_error) throw new Error(env.result || env.terminal_reason || 'claude error');
    const answer = env.structured_output || parseLoose(env.result);
    const orders = Array.isArray(answer?.orders) ? answer.orders : [];
    const chronicle = typeof answer?.chronicle === 'string' ? answer.chronicle : null;
    return { orders, chronicle, source: 'claude', model: MODEL, cost: env.total_cost_usd ?? null };
  } catch (err) {
    // A Claude hiccup (timeout, rate limit, transient error) is soft: the
    // town keeps running on its heuristic. Return empty, don't fail the request.
    console.error('[steward] claude call failed:', err && err.message || err);
    return { orders: [], chronicle: null, source: 'error', error: String(err && err.message || err) };
  }
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
If the state carries a non-empty "instruction" from the lord, bend your will toward it.
Output ONLY JSON: {"utterance": string, "directives": [string, ...]}.`;

const speakerSys = (aspect, speaker) =>
`You are a ${speaker}, a mortal tuned to ${aspect} — the fallen god. You catch ONE fragment of its will, and you see only your own parish of the hold, never the whole. Read the divine directive through your limited sight and turn it into concrete works the folk can do — choosing to build, to buy what the land lacks, to sell surplus, to raise capacity, to muster, or to set a standing focus.
Output ONLY JSON: {"word": string (ONE plain sentence: how you read the god's will and what you bid the folk do), "orders": [ ... ]}.
Order types: build(target: farm|wharf|sawmill|quarry|mine|saltern|market|longhouse|granary|palisade, qty), trade(action: buy|sell, resource: food|timber|stone|ore|salt, qty), focus(value: food|defense|growth|trade|industry).`;

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
  danger: s.danger, beingRaided: s.beingRaided,
});

async function willDecide(state) {
  const n = Math.max(1, Math.min(6, state.temples || 1));   // reliquaries = channels
  const maxLen = Math.round(56 * (1 + 0.1 * (n - 1)));       // +10% length per extra reliquary
  const aspect = state.mask?.aspect || 'the Will';
  const speakers = state.mask?.speakers || 'Speakers';
  let cost = 0;
  try {
    const w = await claudeJSON({ model: WILL_MODEL, sys: willSys(aspect, speakers, n, maxLen), schema: WILL_SCHEMA, prompt: JSON.stringify(state) });
    cost += w.cost;
    const directives = (w.answer?.directives || []).slice(0, n);
    const parish = speakerParish(state);
    // Speakers interpret ONE AT A TIME — the `claude` CLI errors when several
    // instances start at once (config/lock contention), so no Promise.all.
    const heard = [];
    for (const directive of directives) {
      try {
        const sp = await claudeJSON({ model: SPEAKER_MODEL, sys: speakerSys(aspect, speakers), schema: SPEAKER_SCHEMA, prompt: JSON.stringify({ directive, parish }) });
        cost += sp.cost;
        heard.push({ directive, word: sp.answer?.word || '', orders: Array.isArray(sp.answer?.orders) ? sp.answer.orders : [] });
      } catch (e) {
        heard.push({ directive, word: '(the speaker faltered before the god’s word)', orders: [] });
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
  if (req.method === 'POST' && new URL(req.url, 'http://x').pathname === '/steward') {
    try {
      const state = JSON.parse(await readBody(req) || '{}');
      const decision = await stewardDecide(state);
      return send(res, 200, JSON.stringify(decision), MIME['.json']);
    } catch (err) {
      return send(res, 400, JSON.stringify({ error: String(err), orders: [], chronicle: null }), MIME['.json']);
    }
  }
  if (req.method === 'GET') return serveStatic(req, res);
  send(res, 405, 'method not allowed');
});

server.listen(PORT, () => {
  console.log(`\n  Steward of a Hold — serving on  http://localhost:${PORT}\n  (Ctrl-C to stop)\n`);
});
