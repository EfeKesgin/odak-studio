'use strict';
// FFmpeg ve FFprobe'u kurulum paketine girecek "bin/" klasörüne kopyalar.
//
// Kaynak sırası:
//   1) Komut satırı: node scripts/prepare-ffmpeg.js <ffmpeg klasörü>
//   2) ODAK_FFMPEG_DIR ortam değişkeni
//   3) PATH üzerindeki ffmpeg.exe
// Klasör, ffmpeg.exe'nin bulunduğu "bin" klasörü ya da onun üst klasörü
// olabilir. GPL gereği FFmpeg'in lisansı ve kaynak bilgisini taşıyan
// LICENSE/README dosyaları da (varsa) yanına kopyalanır.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'bin');
const BINARIES = ['ffmpeg.exe', 'ffprobe.exe'];

function fail(message) {
  console.error(`FFmpeg hazırlanamadı: ${message}`);
  process.exit(1);
}

function binDirFrom(candidate) {
  if (!candidate) return null;
  const dir = path.resolve(candidate);
  if (fs.existsSync(path.join(dir, 'ffmpeg.exe'))) return dir;
  if (fs.existsSync(path.join(dir, 'bin', 'ffmpeg.exe'))) return path.join(dir, 'bin');
  return null;
}

function findOnPath() {
  try {
    const output = execFileSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
    const first = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first ? path.dirname(first) : null;
  } catch {
    return null;
  }
}

function sameFile(source, target) {
  try {
    const a = fs.statSync(source);
    const b = fs.statSync(target);
    return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000;
  } catch {
    return false;
  }
}

function copy(source, target) {
  if (sameFile(source, target)) {
    console.log(`değişmedi  ${path.basename(target)}`);
    return;
  }
  fs.copyFileSync(source, target);
  const stat = fs.statSync(source);
  fs.utimesSync(target, stat.atime, stat.mtime);
  console.log(`kopyalandı ${path.basename(target)} (${(stat.size / 1024 / 1024).toFixed(0)} MB)`);
}

const requested = process.argv[2] || process.env.ODAK_FFMPEG_DIR;
const sourceBin = requested ? binDirFrom(requested) : findOnPath();
if (!sourceBin) {
  fail(requested
    ? `${requested} içinde ffmpeg.exe bulunamadı.`
    : 'PATH üzerinde ffmpeg bulunamadı. Klasörü argüman ya da ODAK_FFMPEG_DIR ile verin.');
}
if (path.resolve(sourceBin) === path.resolve(TARGET)) {
  fail('Kaynak ve hedef aynı klasör (bin/). Başka bir FFmpeg klasörü verin.');
}
for (const name of BINARIES) {
  if (!fs.existsSync(path.join(sourceBin, name))) fail(`${sourceBin} içinde ${name} yok.`);
}

fs.mkdirSync(TARGET, { recursive: true });
for (const name of BINARIES) copy(path.join(sourceBin, name), path.join(TARGET, name));

// Lisans ve kaynak bilgisi (gyan.dev derlemelerinde üst klasördedir).
const docs = { LICENSE: 'FFMPEG-LICENSE.txt', 'LICENSE.txt': 'FFMPEG-LICENSE.txt', 'README.txt': 'FFMPEG-README.txt' };
let licenseFound = false;
for (const dir of [sourceBin, path.dirname(sourceBin)]) {
  for (const [name, targetName] of Object.entries(docs)) {
    const source = path.join(dir, name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    copy(source, path.join(TARGET, targetName));
    if (targetName === 'FFMPEG-LICENSE.txt') licenseFound = true;
  }
}
if (!licenseFound) {
  console.warn('Uyarı: FFmpeg lisans dosyası bulunamadı. Dağıtımdan önce bin/FFMPEG-LICENSE.txt ekleyin.');
}

const version = execFileSync(path.join(TARGET, 'ffmpeg.exe'), ['-version'], { encoding: 'utf8', windowsHide: true });
const firstLine = version.split(/\r?\n/)[0];
console.log(firstLine);
if (/--enable-gpl/.test(version) && !/--enable-nonfree/.test(version)) {
  console.log('Lisans: GPL derleme, uygulamanın GPL-3.0 lisansıyla uyumlu.');
} else if (/--enable-nonfree/.test(version)) {
  fail('Bu FFmpeg "nonfree" bileşen içeriyor ve yeniden dağıtılamaz.');
}
