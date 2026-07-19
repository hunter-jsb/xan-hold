// verify.mjs — the browser-linker mirror for xan-hold's ES modules. No GPU in
// the dev sandbox, so this is the closest thing to "does it boot". Three passes:
//   1. syntax   — copy each town/*.js to a .mjs and `node --check` (ESM parse)
//   2. resolve  — every `import {X} from './Y.js'` : X must be EXPORTED by Y
//   3. refs     — a symbol OWNED by another module, used here, must be imported
// Run:  node test/verify.mjs   (cwd = repo root)
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import os from 'os';

const ROOT = process.cwd();
const DIR = 'js/town';
const files = fs.readdirSync(path.join(ROOT, DIR)).filter((f) => f.endsWith('.js'));
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*/g, '')
  .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');

let problems = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xhverify-'));

// ---- pass 1: syntax ----------------------------------------------------
for (const f of files) {
  const p = path.join(tmp, '_c.mjs');
  fs.writeFileSync(p, fs.readFileSync(path.join(ROOT, DIR, f)));
  try { execFileSync('node', ['--check', p], { stdio: 'pipe' }); }
  catch (e) { console.log(`  SYNTAX FAIL: ${DIR}/${f}\n${e.stderr}`); problems++; }
}
for (const f of ['js/game.js', 'js/world.js', 'js/app.js']) {   // classic CommonJS scripts (town/*.js incl. atlas/ui checked as .mjs above)
  try { execFileSync('node', ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { console.log(`  SYNTAX FAIL: ${f}\n${e.stderr}`); problems++; }
}

// ---- parse exports + imports per module --------------------------------
const exportsOf = {}, importsOf = {}, ownerOf = new Map(), localOf = {}, codeOf = {};
for (const f of files) {
  const raw = fs.readFileSync(path.join(ROOT, DIR, f), 'utf8');
  const src = strip(raw);
  codeOf[f] = src;
  const exp = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/g)) exp.add(m[1]);
  // const/let/var can declare several comma-separated names on one line
  // (`export const TOWN_W = 96, TOWN_H = 72;`) — grab every `NAME =` in the decl.
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([^;\n]+)/g)) for (const d of m[1].matchAll(/([A-Za-z0-9_$]+)\s*=/g)) exp.add(d[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(',').forEach((n) => { const a = n.trim().split(/\s+as\s+/).pop().trim(); if (a) exp.add(a); });
  exportsOf[f] = exp;
  const top = new Set();
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) top.add(m[1]);
  for (const n of top) if (!ownerOf.has(n)) ownerOf.set(n, f);
  const loc = new Set(top);
  for (const m of src.matchAll(/(?:const|let|var|function)\s+([A-Za-z0-9_$]+)/g)) loc.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s*[{\[]([^}\]]+)[}\]]\s*=/g)) m[1].split(',').forEach((x) => { const n = x.trim().split(':').pop().trim().replace(/^\.\.\./, ''); if (/^[A-Za-z_$]/.test(n)) loc.add(n); });
  localOf[f] = loc;
  const imp = [];
  for (const m of raw.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = m[2];
    m[1].split(',').forEach((n) => { const t = n.trim(); if (t) imp.push({ name: t.split(/\s+as\s+/)[0].trim(), local: t.split(/\s+as\s+/).pop().trim(), target }); });
  }
  importsOf[f] = imp;
}

// ---- pass 2: source-resolution (the blank-page class) ------------------
for (const f of files) {
  for (const { name, target } of importsOf[f]) {
    if (!target.startsWith('.')) continue;               // external (pixi.js) — skip
    const tf = path.basename(target);
    if (!exportsOf[tf]) { console.log(`  IMPORT-TARGET MISSING: ${DIR}/${f} imports from ${target} (not a town module)`); problems++; continue; }
    if (!exportsOf[tf].has(name)) { console.log(`  UNEXPORTED: ${DIR}/${f} imports {${name}} from ${target}, but ${tf} does not export it`); problems++; }
  }
}

// ---- pass 3: used-but-not-imported (bare cross-module ref) -------------
for (const f of files) {
  const imported = new Set(importsOf[f].map((i) => i.local));
  const used = new Set([...codeOf[f].matchAll(/(?<!\.)\b([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g)].map((m) => m[1]));
  for (const [name, home] of ownerOf) {
    if (home === f) continue;
    if (used.has(name) && !imported.has(name) && !localOf[f].has(name)) { console.log(`  UNRESOLVED-REF: ${DIR}/${f} uses [${name}] owned by ${home} — not imported`); problems++; }
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(problems ? `\n  ✗ ${problems} problem(s)` : `\n  ✓ clean — syntax + imports resolve + no bare cross-module refs`);
process.exit(problems ? 1 : 0);
