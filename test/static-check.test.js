'use strict';
// Odak Studio - statik tutarlilik kontrolu (Electron/FFmpeg calistirmaz)
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

let problems = 0;
const fail = (msg) => { problems += 1; console.log('FAIL  ' + msg); };
const ok = (msg) => console.log('ok    ' + msg);

// 1) HTML: id tekilligi + script dosyalari
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const dupes = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
if (dupes.length) fail('tekrarlanan id: ' + dupes.join(', '));
else ok(`id tekilligi (${ids.length} id)`);

const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
for (const s of scripts) {
  const p = path.join(root, 'src', s);
  if (!fs.existsSync(p)) fail('eksik script: ' + s);
}
ok('script dosyalari: ' + scripts.join(', '));

// 2) CSS: parantez dengesi + degisken tanimlari
const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
let bal = 0;
for (const ch of css) {
  if (ch === '{') bal += 1;
  else if (ch === '}') bal -= 1;
  if (bal < 0) break;
}
if (bal !== 0) fail('CSS parantez dengesi bozuk: ' + bal);
else ok('CSS parantez dengesi');

const defined = new Set([...css.matchAll(/--([A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]));
const usedVars = [...new Set([...css.matchAll(/var\(--([A-Za-z0-9-]+)/g)].map((m) => m[1]))];
const missingVars = usedVars.filter((v) => !defined.has(v));
if (missingVars.length) fail('tanimsiz CSS degiskeni: ' + missingVars.join(', '));
else ok(`CSS degiskenleri (${defined.size} tanim, ${usedVars.length} kullanim)`);

// 3) SVG use href -> symbol id
const symbolIds = new Set([...html.matchAll(/<(?:symbol|g)[^>]*\sid="([^"]+)"/g)].map((m) => m[1]));
const uses = [...new Set([...html.matchAll(/<use\s+href="#([^"]+)"/g)].map((m) => m[1]))];
const missingUse = uses.filter((u) => !symbolIds.has(u));
if (missingUse.length) fail('eksik SVG sembolu: ' + missingUse.join(', '));
else ok(`SVG sembolleri (${uses.length} kullanim)`);

// 4) Renderer getElementById -> HTML id
const idSet = new Set(ids);
const rendererFiles = ['ui.js', 'crop.js', 'video.js', 'photo.js', 'gif.js', 'batch.js', 'app.js'];
let idRefs = 0;
for (const f of rendererFiles) {
  const src = fs.readFileSync(path.join(root, 'src', f), 'utf8');
  const refs = [...src.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  idRefs += refs.length;
  const missing = refs.filter((r) => !idSet.has(r));
  if (missing.length) fail(`${f} icin HTML'de olmayan id: ${missing.join(', ')}`);
}
ok(`getElementById referanslari (${idRefs} adet)`);

// 5) "Birlikte ac" kurulum betigi, uygulamanin actigi uzantilarla ayni olmali
{
  const shared = require(path.join(root, 'src/shared.js'));
  const unsupported = new Set(['bmp', 'jxl', 'heic', 'heif']);
  const expected = [...shared.VIDEO_EXTENSIONS, ...shared.IMAGE_EXTENSIONS].filter((e) => !unsupported.has(e)).sort();
  const nsh = fs.readFileSync(path.join(root, 'installer/open-with.nsh'), 'utf8');
  const listed = [...nsh.matchAll(/insertmacro \$\{MACRO\} "\.([a-z0-9]+)"/g)].map((m) => m[1]).sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) fail(`open-with.nsh uzantilari farkli: ${listed.join(',')} != ${expected.join(',')}`);
  if (require(path.join(root, 'package.json')).build.nsis.include !== 'installer/open-with.nsh') fail('nsis.include ayarli degil');
  ok(`Birlikte ac uzantilari (${listed.length})`);
}

// 6) UTF-8 gecerliligi
const files = [
  'package.json', 'README.md', '.gitignore', 'scripts/prepare-ffmpeg.js', 'scripts/publish-release.js',
  'installer/open-with.nsh', 'electron/main.js', 'electron/logger.js', 'electron/media.js', 'electron/photos.js', 'electron/gif.js', 'electron/util.js', 'electron/preload.js',
  'src/index.html', 'src/styles.css', 'src/ui.js', 'src/crop.js', 'src/text-layers.js', 'src/video.js', 'src/photo.js', 'src/gif.js',
  'src/i18n.js', 'src/shared.js', 'src/batch-plan.js', 'src/batch.js', 'src/app.js',
  'test/i18n.test.js',
  'test/gif-plan.test.js', 'test/batch-plan.test.js', 'test/video-transport.test.js',
];
for (const f of files) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { fail('eksik dosya: ' + f); continue; }
  const buf = fs.readFileSync(p);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (text.includes('\uFFFD')) fail('gecersiz karakter: ' + f);
  } catch {
    fail('gecersiz UTF-8: ' + f);
  }
}
ok(`UTF-8 dogrulamasi (${files.length} dosya)`);

console.log(problems === 0 ? 'STATIC-CHECK-OK' : `STATIC-CHECK-FAIL (${problems})`);
process.exitCode = problems === 0 ? 0 : 1;
