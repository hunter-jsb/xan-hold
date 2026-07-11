// build.mjs — bundle the modular game into ONE self-contained xan-hold.html.
// A flatpak browser opening a file:// page gets only that single file via the
// document portal, so sibling <script src>/<link> requests 404. Inlining
// everything (style + data + all JS) makes double-click "just work".
import { readFileSync, writeFileSync } from 'fs';

const root = new URL('.', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');

let html = read('index.html');

// Inline the stylesheet.
html = html.replace(/<link rel="stylesheet" href="style\.css">/,
  `<style>\n${read('style.css')}\n</style>`);

// Inline each referenced script in place (keeps load order == index.html).
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) =>
  `<script>\n${read(src)}\n</script>`);

writeFileSync(root + 'xan-hold.html', html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`built xan-hold.html (${kb} KB, self-contained — double-click to play)`);
