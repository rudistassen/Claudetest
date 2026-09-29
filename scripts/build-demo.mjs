// Builds dist/cafe-ops-demo.html: the whole app (front end + server routes + SQLite) in one self-contained page.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  entryPoints: [path.join(root, 'demo/main.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  legalComments: 'none',
  alias: {
    'node:sqlite': path.join(root, 'demo/shim-sqlite.js'),
    'node:crypto': path.join(root, 'demo/shim-crypto.js'),
  },
  external: ['fs', 'path', 'crypto', 'node:fs', 'node:path'],
  define: { 'process.env': '{}' },
  logLevel: 'warning',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(root, 'public/css/styles.css'), 'utf8');
// The logo band from index.html, with each logo inlined so the demo stays one file.
const band = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
  .match(/<header class="brand-band"[\s\S]*?<\/header>/)[0]
  .replace(/src="\/img\/([\w-]+\.png)"/g, (_, f) => `src="data:image/png;base64,${fs.readFileSync(path.join(root, 'public/img', f)).toString('base64')}"`);

const favicon = `data:image/svg+xml;base64,${fs.readFileSync(path.join(root, 'public/img/brewview.svg')).toString('base64')}`;
const html = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BrewView</title>
<link rel="icon" href="${favicon}" type="image/svg+xml">
<meta name="theme-color" content="#ffffff">
<style>
${css}
</style>
${band}
<div id="app"><div class="loading">Loading BrewView demo…</div></div>
<div id="modal-root"></div>
<div id="toasts" aria-live="polite"></div>
<script>window.CAFE_OPS_DEMO = true; document.body.classList.add('demo');</script>
<script>${js}</script>
`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist/cafe-ops-demo.html');
fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(root, out)} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
